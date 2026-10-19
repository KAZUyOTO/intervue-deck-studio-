import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { load } from 'cheerio';
import ipaddr from 'ipaddr.js';
import sharp from 'sharp';
import { decodeIco } from 'icojs';
import { gunzip, inflate, brotliDecompress } from 'node:zlib';
import { promisify } from 'node:util';

const MAX_BYTES = 4 * 1024 * 1024;

export class LogoLookupError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'LogoLookupError';
    this.status = status;
    this.code = code;
  }
}

export function logoFailure(error: unknown) {
  if (error instanceof LogoLookupError) return { status: error.status, code: error.code, error: error.message };
  if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) {
    return { status: 504, code: 'WEBSITE_TIMEOUT', error: 'The website took too long to respond. Try again, or drop a logo image onto the slide.' };
  }
  return { status: 502, code: 'WEBSITE_UNAVAILABLE', error: 'The website could not be reached. Try again, or drop a logo image onto the slide.' };
}

export async function decodeBody(body: Buffer, encoding: string): Promise<Buffer> {
  const options = { maxOutputLength: MAX_BYTES };
  let decoded = body;
  if (encoding === 'gzip' || encoding === 'x-gzip') decoded = await promisify(gunzip)(body, options);
  else if (encoding === 'deflate') decoded = await promisify(inflate)(body, options);
  else if (encoding === 'br') decoded = await promisify(brotliDecompress)(body, options);
  else if (encoding && encoding !== 'identity') throw new Error('Unsupported response encoding.');
  if (decoded.length > MAX_BYTES) throw new LogoLookupError('Website or logo exceeds 4 MB.', 422, 'CONTENT_TOO_LARGE');
  return decoded;
}

export function websiteUrl(value: string, base?: URL): URL {
  let url: URL;
  try { url = new URL(base ? value : (/^https?:\/\//i.test(value) ? value : `https://${value}`), base); }
  catch { throw new LogoLookupError('Enter a valid public company website.', 400, 'INVALID_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new LogoLookupError('Use a public company website with HTTP or HTTPS and no custom port.', 400, 'INVALID_URL');
  }
  return url;
}

export function publicAddress(address: string): boolean {
  try {
    // Reject mapped IPv4, loopback, private, link-local and reserved ranges too.
    return ipaddr.parse(address).range() === 'unicast';
  } catch {
    return false;
  }
}

/** Validate every redirect and pin the connection to the validated DNS answer. */
async function download(url: URL, signal: AbortSignal, redirects = 0, allowNotFoundImage = false): Promise<{ body: Buffer; type: string; url: URL }> {
  signal.throwIfAborted();
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    lookup(hostname, { all: true }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
    throw new LogoLookupError('Only public company websites are supported.', 400, 'PRIVATE_URL');
  }
  const requestAddress = ({ address, family }: { address: string; family: number }) => new Promise<{ body: Buffer; type: string; location?: string; status: number }>((resolve, reject) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      signal,
      agent: false,
      family,
      // Keep the original hostname for HTTP Host and TLS certificate checks.
      lookup: (_host, _options, callback) => callback(null, address, family),
      headers: { 'user-agent': 'DeckStudio/1.0 (company logo lookup)', accept: 'text/html,image/*;q=0.9', 'accept-encoding': 'gzip, deflate, br' },
    }, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = res.headers.location;
        res.destroy();
        resolve({ body: Buffer.alloc(0), type: '', status, location });
        return;
      }
      if (status !== 200 && !(allowNotFoundImage && status === 404 && String(res.headers['content-type']).startsWith('image/'))) {
        res.destroy();
        reject(new LogoLookupError(
          status === 401 || status === 403 || status === 429
            ? 'The website blocked logo discovery. Drop a logo image onto the slide instead.'
            : `The website returned HTTP ${status}. Try again or drop a logo image onto the slide.`,
          502, status === 401 || status === 403 || status === 429 ? 'WEBSITE_BLOCKED' : 'WEBSITE_UNAVAILABLE',
        ));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) res.destroy(new Error('Website or logo exceeds 4 MB.'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        decodeBody(Buffer.concat(chunks), String(res.headers['content-encoding'] || '').toLowerCase())
          .then((body) => resolve({ body, type: String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase(), status }))
          .catch(reject);
      });
    });
    req.on('error', reject);
    req.end();
  });
  let result: Awaited<ReturnType<typeof requestAddress>> | undefined;
  let lastError: unknown;
  for (const address of addresses.slice(0, 3)) {
    try { result = await requestAddress(address); break; }
    catch (error) {
      if (error instanceof LogoLookupError || signal.aborted) throw error;
      lastError = error;
    }
  }
  if (!result) throw lastError;
  if ([301, 302, 303, 307, 308].includes(result.status)) {
    if (!result.location || redirects >= 3) throw new Error('The website redirected too many times.');
    return download(websiteUrl(result.location, url), signal, redirects + 1, allowNotFoundImage);
  }
  return { ...result, url };
}

type Candidate = { url: URL; source: string };

export function logoCandidates(html: string, page: URL): Candidate[] {
  const $ = load(html);
  let base = page;
  try { base = websiteUrl($('base[href]').first().attr('href') || page.href, page); } catch { /* use page URL */ }
  const candidates: Candidate[] = [];
  const priority = new Map<string, number>();
  const add = (value: unknown, source: string, score = 3) => {
    if (typeof value !== 'string' || !value.trim()) return;
    try {
      const url = /^data:image\//i.test(value) ? new URL(value) : websiteUrl(value.trim(), base);
      if (!candidates.some((c) => c.url.href === url.href)) candidates.push({ url, source });
      priority.set(url.href, Math.max(score, priority.get(url.href) || 0));
    } catch { /* ignore unsupported metadata URLs */ }
  };
  const visit = (node: unknown, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 12) return;
    if (Array.isArray(node)) { node.forEach((n) => visit(n, depth + 1)); return; }
    const obj = node as Record<string, unknown>;
    if (obj.logo) {
      const logos = Array.isArray(obj.logo) ? obj.logo : [obj.logo];
      for (const logo of logos) {
        if (typeof logo === 'string') add(logo, 'Website logo');
        else if (logo && typeof logo === 'object') {
          const image = logo as Record<string, unknown>;
          add(image.contentUrl || image.url, 'Website logo');
        }
      }
    }
    Object.values(obj).forEach((n) => visit(n, depth + 1));
  };
  try { visit(JSON.parse(html)); } catch { /* normal HTML rather than a JSON metadata endpoint */ }
  $('script[type="application/ld+json"]').each((_i, el) => {
    try { visit(JSON.parse($(el).text())); } catch { /* malformed JSON-LD */ }
  });
  $('meta[itemprop="logo"]').each((_i, el) => add($(el).attr('content'), 'Website logo'));
  const brand = page.hostname.replace(/^www\./, '').split('.')[0].toLowerCase();
  const images = $('img').toArray().map((el) => {
    const img = $(el);
    const alt = (img.attr('alt') || '').toLowerCase().trim();
    const srcset = img.attr('srcset') || img.attr('data-srcset') || img.closest('picture').find('source').first().attr('srcset') || '';
    const responsive = srcset.split(',').map((entry) => entry.trim().split(/\s+/)[0]).filter(Boolean).pop();
    const src = img.attr('data-src') || img.attr('data-lazy-src') || img.attr('data-original') || responsive || img.attr('src') || '';
    const label = `${alt} ${img.attr('id') || ''} ${img.attr('class') || ''} ${img.attr('itemprop') || ''}`;
    const isLogo = /logo/i.test(label) || /logo/i.test(src);
    const filename = src.split('/').pop()?.split('?')[0].toLowerCase() || '';
    const ownBrand = alt === brand || (isLogo && (alt.includes(brand) || filename.includes(brand)));
    const inBranding = img.closest('header, nav, [class*="navbar"], [class*="brand"], [id*="header"]').length > 0;
    const homeLink = img.closest('a').attr('href');
    const linksHome = homeLink === '/' || homeLink === page.origin || homeLink === `${page.origin}/`;
    return { src, score: ownBrand ? (inBranding || linksHome ? 5 : 4) : isLogo && (inBranding || linksHome) ? 1 : 0 };
  });
  images.filter((img) => img.score > 0).sort((a, b) => b.score - a.score)
    .forEach((img) => add(img.src, 'Website logo', img.score));
  $('svg').each((_i, el) => {
    const svg = $(el);
    const parent = svg.closest('a, [class*="logo"], [class*="brand"]');
    const label = `${svg.attr('class') || ''} ${svg.attr('id') || ''} ${svg.attr('aria-label') || ''} ${parent.attr('class') || ''}`;
    if (/logo|brand/i.test(label)) {
      svg.attr('xmlns', 'http://www.w3.org/2000/svg');
      add(`data:image/svg+xml;base64,${Buffer.from($.html(el)).toString('base64')}`, 'Website logo', 1);
    }
  });
  $('link[rel]').each((_i, el) => {
    if (/apple-touch-icon/i.test($(el).attr('rel') || '')) add($(el).attr('href'), 'Site icon', 0);
  });
  $('link[rel]').toArray().filter((el) => /(^|\s)icon(\s|$)/i.test($(el).attr('rel') || ''))
    .sort((a, b) => parseInt($(b).attr('sizes') || '0') - parseInt($(a).attr('sizes') || '0'))
    .forEach((el) => add($(el).attr('href'), 'Site icon', 0));
  return candidates.sort((a, b) => (priority.get(b.url.href) || 0) - (priority.get(a.url.href) || 0)).slice(0, 8);
}

export function imageType(body: Buffer): string | null {
  if (body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (body[0] === 255 && body[1] === 216 && body[2] === 255) return 'image/jpeg';
  if (body.toString('ascii', 0, 4) === 'RIFF' && body.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  const text = body.toString('utf8').trimStart().replace(/^(?:(?:<\?xml[^>]*>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)\s*)+/i, '');
  if (/^<svg(?:\s|>)/i.test(text)) return 'image/svg+xml';
  return null;
}

/** Normalize formats the canvas/PDF renderer cannot consume into a bounded static PNG. */
export async function normalizeLogo(body: Buffer): Promise<{ body: Buffer; type: string }> {
  if (!body.length || body.length > MAX_BYTES) throw new Error('Invalid image size.');
  if (body[0] === 0x1f && body[1] === 0x8b) body = await decodeBody(body, 'gzip');
  let input = body;
  if (body.length >= 6 && body.readUInt32LE(0) === 65536) {
    // Guard directory count before decoding potentially untrusted ICO entries.
    const count = body.readUInt16LE(4);
    if (!count || count > 64 || body.length < 6 + count * 16) throw new Error('Invalid icon directory.');
    for (let i = 0; i < count; i++) {
      const entry = 6 + i * 16;
      const length = body.readUInt32LE(entry + 8);
      const offset = body.readUInt32LE(entry + 12);
      if (offset < 6 + count * 16 || offset + length > body.length || length < 16) throw new Error('Invalid icon entry.');
      const entryBody = body.subarray(offset, offset + length);
      if (imageType(entryBody) === 'image/png') {
        const metadata = await sharp(entryBody, { limitInputPixels: 65_536 }).metadata();
        if (!metadata.width || !metadata.height || metadata.width > 256 || metadata.height > 256) throw new Error('Oversized icon frame.');
      } else if (entryBody.readUInt32LE(0) >= 40) {
        if (length < 40 || Math.abs(entryBody.readInt32LE(4)) > 256 || Math.abs(entryBody.readInt32LE(8)) > 512) throw new Error('Oversized icon bitmap.');
      } else throw new Error('Unsupported icon bitmap.');
    }
    const frames = await decodeIco(body, 'image/png');
    const largest = frames.sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (!largest) throw new Error('Empty icon.');
    input = Buffer.from(largest.buffer);
  }
  const image = sharp(input, { limitInputPixels: 16_000_000, animated: false }).timeout({ seconds: 3 });
  const meta = await image.metadata();
  if (!meta.width || !meta.height || meta.width * meta.height > 16_000_000) throw new Error('Image dimensions are too large.');
  const type = imageType(input);
  if (type && input === body && ['png', 'jpeg', 'webp', 'svg'].includes(meta.format || '')) {
    // Decode raster pixels too, so a header-only/truncated image is not saved.
    if (type !== 'image/svg+xml') await image.clone().stats();
    return { body: input, type };
  }
  const converted = await image.resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  if (converted.length > MAX_BYTES) throw new Error('Converted logo exceeds 4 MB.');
  return { body: converted, type: 'image/png' };
}

export function dataImage(url: URL): Buffer {
  const match = /^data:image\/[^;,]+(?:;charset=[^;,]+)?(;base64)?,([\s\S]*)$/i.exec(url.href);
  if (!match) throw new Error('Unsupported inline image.');
  const body = match[1] ? Buffer.from(match[2], 'base64') : Buffer.from(decodeURIComponent(match[2]));
  if (body.length > MAX_BYTES) throw new Error('Inline logo exceeds 4 MB.');
  return body;
}

/** Conventional site-owned icons still work on some sites that restrict HTML access. */
export function fallbackIcons(url: URL): Candidate[] {
  return ['/apple-touch-icon.png', '/favicon.svg', '/favicon.ico'].map((pathname) => ({ url: new URL(pathname, url.origin), source: 'Site icon' }));
}

async function cachedSiteIcon(url: URL, signal: AbortSignal, fetchSite: typeof download) {
  // Send only the public hostname, never paths, query strings or credentials.
  const cached = new URL('https://www.google.com/s2/favicons');
  cached.searchParams.set('domain', url.hostname);
  cached.searchParams.set('sz', '128');
  const fallback = new URL(cached);
  fallback.searchParams.set('domain', 'example.invalid');
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(6_000)]);
  const [image, placeholder] = await Promise.all([
    fetchSite(cached, deadline),
    // Google returns its generic image with HTTP 404 for unknown domains.
    fetchSite(fallback, deadline, 0, true),
  ]);
  await normalizeLogo(placeholder.body);
  if (image.body.equals(placeholder.body)) throw new Error('Only a generic site icon is available.');
  return { ...await normalizeLogo(image.body), name: url.hostname.replace(/^www\./, ''), source: 'Cached site icon (Google)' };
}

export async function findWebsiteLogo(value: string, fetchSite: typeof download = download) {
  const url = websiteUrl(value.trim());
  const signal = AbortSignal.timeout(25_000);
  const directSignal = AbortSignal.any([signal, AbortSignal.timeout(17_000)]);
  let page: Awaited<ReturnType<typeof download>> | undefined;
  let pageError: unknown;
  try { page = await fetchSite(url, AbortSignal.any([directSignal, AbortSignal.timeout(8_000)])); }
  catch (error) {
    if (error instanceof LogoLookupError && error.code === 'PRIVATE_URL') throw error;
    pageError = error;
  }
  if (page) {
    try {
      const logo = await normalizeLogo(page.body);
      return { ...logo, name: page.url.hostname.replace(/^www\./, ''), source: 'Image link' };
    } catch { /* not a direct image; inspect its markup */ }
  }
  const candidates = page ? logoCandidates(page.body.toString('utf8'), page.url) : [];
  // Web app manifests often expose a larger icon than the favicon.
  if (page) {
    const $ = load(page.body.toString('utf8'));
    const href = $('link[rel="manifest"]').first().attr('href');
    if (href) {
      try {
        const manifest = await fetchSite(websiteUrl(href, page.url), AbortSignal.any([directSignal, AbortSignal.timeout(3_000)]));
        const data = JSON.parse(manifest.body.toString('utf8'));
        const icons: { src?: string; sizes?: string }[] = Array.isArray(data.icons) ? data.icons.slice(0, 16) : [];
        icons.sort((a, b) => parseInt(b.sizes || '0') - parseInt(a.sizes || '0'));
        for (const icon of icons) if (icon.src) candidates.push({ url: websiteUrl(icon.src, manifest.url), source: 'Site icon' });
      } catch { /* a broken manifest should not block other candidates */ }
    }
  }
  candidates.push(...fallbackIcons(page?.url || url));
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.url.href) || directSignal.aborted) continue;
    seen.add(candidate.url.href);
    if (seen.size > 16) break;
    try {
      const body = candidate.url.protocol === 'data:' ? dataImage(candidate.url)
        : (await fetchSite(candidate.url, AbortSignal.any([directSignal, AbortSignal.timeout(4_000)]))).body;
      const logo = await normalizeLogo(body);
      return { ...logo, name: (page?.url || url).hostname.replace(/^www\./, ''), source: candidate.source };
    } catch { /* try the next valid candidate */ }
  }
  try { return await cachedSiteIcon(page?.url || url, signal, fetchSite); }
  catch { /* no cached brand icon, so preserve the meaningful original failure */ }
  if (pageError) throw pageError;
  if (signal.aborted) throw signal.reason;
  throw new LogoLookupError('No usable logo was exposed by this website. Drop a logo image onto the slide instead.', 422, 'NO_LOGO');
}
