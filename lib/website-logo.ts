import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { load } from 'cheerio';
import ipaddr from 'ipaddr.js';

const MAX_BYTES = 4 * 1024 * 1024;

export function websiteUrl(value: string, base?: URL): URL {
  const url = new URL(base ? value : (/^https?:\/\//i.test(value) ? value : `https://${value}`), base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new Error('Use a public company website with HTTP or HTTPS and no custom port.');
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
async function download(url: URL, signal: AbortSignal, redirects = 0): Promise<{ body: Buffer; type: string; url: URL }> {
  signal.throwIfAborted();
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await lookup(hostname, { all: true });
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
    throw new Error('Only public company websites are supported.');
  }
  const { address, family } = addresses[0];
  const result = await new Promise<{ body: Buffer; type: string; location?: string; status: number }>((resolve, reject) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      signal,
      agent: false,
      family,
      // Keep the original hostname for HTTP Host and TLS certificate checks.
      lookup: (_host, _options, callback) => callback(null, address, family),
      headers: { 'user-agent': 'DeckStudio/1.0 (company logo lookup)', accept: 'text/html,image/*;q=0.9', 'accept-encoding': 'identity' },
    }, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = res.headers.location;
        res.destroy();
        resolve({ body: Buffer.alloc(0), type: '', status, location });
        return;
      }
      if (status !== 200) {
        res.destroy();
        reject(new Error('The website could not be read.'));
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
      res.on('end', () => resolve({ body: Buffer.concat(chunks), type: String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase(), status }));
    });
    req.on('error', reject);
    req.end();
  });
  if ([301, 302, 303, 307, 308].includes(result.status)) {
    if (!result.location || redirects >= 3) throw new Error('The website redirected too many times.');
    return download(websiteUrl(result.location, url), signal, redirects + 1);
  }
  return { ...result, url };
}

type Candidate = { url: URL; source: string };

export function logoCandidates(html: string, page: URL): Candidate[] {
  const $ = load(html);
  let base = page;
  try { base = websiteUrl($('base[href]').first().attr('href') || page.href, page); } catch { /* use page URL */ }
  const candidates: Candidate[] = [];
  const add = (value: unknown, source: string) => {
    if (typeof value !== 'string' || !value.trim()) return;
    try {
      const url = websiteUrl(value.trim(), base);
      if (!candidates.some((c) => c.url.href === url.href)) candidates.push({ url, source });
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
  $('script[type="application/ld+json"]').each((_i, el) => {
    try { visit(JSON.parse($(el).text())); } catch { /* malformed JSON-LD */ }
  });
  $('meta[itemprop="logo"]').each((_i, el) => add($(el).attr('content'), 'Website logo'));
  const brand = page.hostname.replace(/^www\./, '').split('.')[0].toLowerCase();
  const images = $('img').toArray().map((el) => {
    const img = $(el);
    const alt = (img.attr('alt') || '').toLowerCase().trim();
    const src = img.attr('src') || img.attr('data-src') || '';
    const label = `${alt} ${img.attr('id') || ''} ${img.attr('class') || ''} ${img.attr('itemprop') || ''}`;
    const isLogo = /logo/i.test(label) || /logo/i.test(src);
    const ownBrand = alt === brand || (isLogo && (alt.includes(brand) || src.toLowerCase().includes(brand)));
    const inBranding = img.closest('header, nav, [class*="navbar"], [class*="brand"], [id*="header"]').length > 0;
    const homeLink = img.closest('a').attr('href');
    const linksHome = homeLink === '/' || homeLink === page.origin || homeLink === `${page.origin}/`;
    return { src, score: ownBrand ? 2 : isLogo && (inBranding || linksHome) ? 1 : 0 };
  });
  images.filter((img) => img.score > 0).sort((a, b) => b.score - a.score)
    .forEach((img) => add(img.src, 'Website logo'));
  $('link[rel]').each((_i, el) => {
    if (/apple-touch-icon/i.test($(el).attr('rel') || '')) add($(el).attr('href'), 'Site icon');
  });
  $('link[rel]').each((_i, el) => {
    if (/(^|\s)icon(\s|$)/i.test($(el).attr('rel') || '')) add($(el).attr('href'), 'Site icon');
  });
  return candidates.slice(0, 8);
}

export function imageType(body: Buffer): string | null {
  if (body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (body[0] === 255 && body[1] === 216 && body[2] === 255) return 'image/jpeg';
  if (body.toString('ascii', 0, 4) === 'RIFF' && body.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  const text = body.toString('utf8').trimStart().replace(/^<\?xml[^>]*>\s*/i, '').replace(/^(?:<!--[\s\S]*?-->\s*)+/, '');
  if (/^<svg(?:\s|>)/i.test(text)) return 'image/svg+xml';
  return null;
}

export async function findWebsiteLogo(value: string) {
  const url = websiteUrl(value.trim());
  const signal = AbortSignal.timeout(18_000);
  const page = await download(url, signal);
  if (!['text/html', 'application/xhtml+xml'].includes(page.type)) throw new Error('Paste the company’s website, rather than a file link.');
  for (const candidate of logoCandidates(page.body.toString('utf8'), page.url)) {
    try {
      const image = await download(candidate.url, AbortSignal.any([signal, AbortSignal.timeout(5_000)]));
      const type = imageType(image.body);
      if (type) return { body: image.body, type, name: page.url.hostname.replace(/^www\./, ''), source: candidate.source };
    } catch { if (signal.aborted) break; }
  }
  throw new Error('No usable logo found. Try the company’s homepage or upload a PNG or SVG.');
}
