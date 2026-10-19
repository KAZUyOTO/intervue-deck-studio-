import test from 'node:test';
import assert from 'node:assert/strict';
import { websiteUrl, publicAddress, logoCandidates, imageType, findWebsiteLogo } from '../lib/website-logo.ts';

test('accepts domains and relative metadata but rejects unsafe URL forms', () => {
  assert.equal(websiteUrl('example.com').href, 'https://example.com/');
  assert.equal(websiteUrl('/logo.svg', new URL('https://example.com/about')).href, 'https://example.com/logo.svg');
  for (const value of ['file:///etc/passwd', 'https://user:password@example.com', 'https://example.com:8080', 'data:image/svg+xml,hi']) {
    assert.throws(() => websiteUrl(value, new URL('https://example.com')));
  }
});

test('rejects private, mapped, special-use and internal IP ranges', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.1.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1']) {
    assert.equal(publicAddress(ip), false, ip);
  }
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.equal(publicAddress('2606:4700:4700::1111'), true);
});

test('prefers structured logos over page images and icons, resolving entities and base URLs', () => {
  const candidates = logoCandidates(`
    <base href="https://cdn.example.com/assets/">
    <link href="/icon.png" rel="apple-touch-icon">
    <meta property="og:image" content="/social-banner.jpg">
    <header><img alt="Company logo" src="fallback.svg?size=2&amp;color=blue"></header>
    <script type="application/ld+json">broken</script>
    <script type="application/ld+json">{"@graph":[{"@type":"Organization","logo":{"@type":"ImageObject","url":"brand.svg"}}]}</script>
  `, new URL('https://example.com/about'));
  assert.deepEqual(candidates.map((c) => c.url.href), [
    'https://cdn.example.com/assets/brand.svg',
    'https://cdn.example.com/assets/fallback.svg?size=2&color=blue',
    'https://cdn.example.com/icon.png',
  ]);
  assert.equal(candidates[2].source, 'Site icon');
});

test('deduplicates candidates, caps requests and ignores non-web metadata', () => {
  const html = '<img alt="example logo" src="javascript:alert(1)">' + Array.from({ length: 12 }, (_, i) => `<img alt="example logo" src="/${i}.png"><img alt="example logo" src="/${i}.png">`).join('');
  assert.equal(logoCandidates(html, new URL('https://example.com')).length, 8);
});

test('validates image signatures instead of trusting upstream content types', () => {
  assert.equal(imageType(Buffer.from('<html>not an image</html>')), null);
  assert.equal(imageType(Buffer.from('<?xml version="1.0"?>\n<!-- logo --><svg xmlns="http://www.w3.org/2000/svg"></svg>')), 'image/svg+xml');
  assert.equal(imageType(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'image/png');
});

test('blocks an actual loopback lookup before connecting', async () => {
  await assert.rejects(findWebsiteLogo('http://127.0.0.1'), /Only public/);
});

test('does not mistake customer logos or social banners for the company brand', () => {
  const candidates = logoCandidates(`
    <img alt="Customer logo" src="/customer-logo.webp">
    <img alt="example featured in news" src="/banner.webp">
    <img alt="example" src="/wordmark.svg">
    <header><img alt="Logo" src="/brand.svg"></header>
    <link rel="apple-touch-icon" href="/icon.png">
  `, new URL('https://example.com'));
  assert.deepEqual(candidates.map((c) => c.url.pathname), ['/wordmark.svg', '/brand.svg', '/icon.png']);
});

// Fixtures exercise the full lookup without relying on a site's firewall or uptime.
import { normalizeLogo, decodeBody, dataImage, logoFailure, LogoLookupError } from '../lib/website-logo.ts';
import sharp from 'sharp';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { encodeIco } from 'icojs';

const logoSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="purple"/></svg>');
const response = (url, body, type = 'text/html') => ({ url, body: Buffer.from(body), type });

test('TCS-style relative branding SVG wins over the Tata parent-company logo', async () => {
  const fetchSite = async (url) => url.pathname === '/'
    ? response(url, `<script type="application/ld+json">{"@type":"Organization","logo":"/content/dam/global-tcs/tata-logo.svg"}</script><header><img class="brand-logo-img" src="/content/dam/tcs-logo-1.svg" alt="Tata Consultancy Services homepage"><img src="/content/dam/global-tcs/tata-logo.svg" alt="tata.com logo"></header>`)
    : url.pathname === '/content/dam/tcs-logo-1.svg' ? response(url, logoSvg, 'image/svg+xml') : Promise.reject(new Error('Unexpected fetch'));
  const found = await findWebsiteLogo('https://www.tcs.com/', fetchSite);
  assert.equal(found.type, 'image/svg+xml');
  assert.deepEqual(found.body, logoSvg);
});

test('decodes gzip, deflate and Brotli without exceeding the decoded size limit', async () => {
  for (const [encoding, compressed] of [['gzip', gzipSync(logoSvg)], ['deflate', deflateSync(logoSvg)], ['br', brotliCompressSync(logoSvg)]]) {
    assert.deepEqual(await decodeBody(compressed, encoding), logoSvg);
  }
  await assert.rejects(decodeBody(gzipSync(Buffer.alloc(4 * 1024 * 1024 + 1)), 'gzip'));
});

test('accepts lazy-loaded and responsive logos, inline SVG and data images', async () => {
  const data = `data:image/svg+xml;base64,${logoSvg.toString('base64')}`;
  assert.deepEqual(dataImage(new URL(data)), logoSvg);
  const candidates = logoCandidates(`<header>
    <img alt="example logo" src="placeholder.gif" data-src="brand.svg">
    <picture><source srcset="small.avif 1x, large.avif 2x"><img alt="example logo"></picture>
    <img alt="example logo" src="${data}">
    <a class="brand" href="/"><svg class="logo" width="100" height="30"><path d="M0 0h100v30z"/></svg></a>
  </header>`, new URL('https://example.com'));
  assert.equal(candidates[0].url.pathname, '/brand.svg');
  assert.equal(candidates[1].url.pathname, '/large.avif');
  assert.ok(candidates.some((c) => c.url.protocol === 'data:'));
  const found = await findWebsiteLogo('example.com', async (url) => response(url, `<img alt="example logo" src="${data}">`));
  assert.equal(found.type, 'image/svg+xml');
});

test('converts GIF, AVIF, TIFF and ICO into renderable static PNGs', async () => {
  const original = sharp({ create: { width: 32, height: 32, channels: 4, background: '#5432ff' } });
  for (const format of ['gif', 'avif', 'tiff']) {
    const source = await original.clone().toFormat(format).toBuffer();
    const normalized = await normalizeLogo(source);
    assert.equal(normalized.type, 'image/png', format);
    assert.equal((await sharp(normalized.body).metadata()).width, 32);
  }
  const png = await original.clone().png().toBuffer();
  const ico = Buffer.from(await encodeIco([{ buffer: png }]));
  const normalized = await normalizeLogo(ico);
  assert.equal(normalized.type, 'image/png');
  assert.equal((await sharp(normalized.body).metadata()).width, 32);
  await assert.rejects(normalizeLogo(Buffer.from('<html>Access denied</html>')));
  await assert.rejects(normalizeLogo(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
});

test('reads SVG with a doctype and supports gzip SVG content', async () => {
  const source = Buffer.concat([Buffer.from('<?xml version="1.0"?>\n<!-- brand --><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n'), logoSvg]);
  assert.equal(imageType(source), 'image/svg+xml');
  assert.equal((await normalizeLogo(gzipSync(logoSvg))).type, 'image/svg+xml');
});

test('uses a site-owned icon when HTML access is blocked', async () => {
  const requested = [];
  const png = await sharp(logoSvg).png().toBuffer();
  const found = await findWebsiteLogo('example.com', async (url) => {
    requested.push(url.pathname);
    if (url.pathname === '/favicon.ico') return response(url, png, 'image/x-icon');
    throw new LogoLookupError('Website blocked access.', 502, 'WEBSITE_BLOCKED');
  });
  assert.equal(found.type, 'image/png');
  assert.equal(found.source, 'Site icon');
  assert.ok(requested.includes('/favicon.ico'));
});

test('finds manifest icons and accepts direct image URLs even with an incorrect content type', async () => {
  const png = await sharp(logoSvg).png().toBuffer();
  const found = await findWebsiteLogo('example.com', async (url) => {
    if (url.pathname === '/') return response(url, '<link rel="manifest" href="/app/site.webmanifest">');
    if (url.pathname.endsWith('.webmanifest')) return response(url, JSON.stringify({ icons: [{ src: 'logo.png', sizes: '512x512' }] }));
    if (url.pathname === '/app/logo.png') return response(url, png, 'application/octet-stream');
    throw new Error('Not found');
  });
  assert.equal(found.type, 'image/png');
  const direct = await findWebsiteLogo('example.com/brand.png', async (url) => response(url, png, 'application/octet-stream'));
  assert.equal(direct.source, 'Image link');
});

test('preserves meaningful failure types rather than reporting every error as 422', async () => {
  const blocked = new LogoLookupError('The website blocked access.', 502, 'WEBSITE_BLOCKED');
  await assert.rejects(findWebsiteLogo('example.com', async () => { throw blocked; }), (error) => logoFailure(error).status === 502);
  const failure = logoFailure(new DOMException('Timed out', 'TimeoutError'));
  assert.equal(failure.status, 504);
  assert.equal(failure.code, 'WEBSITE_TIMEOUT');
  assert.equal(logoFailure(new LogoLookupError('Invalid', 400, 'INVALID_URL')).status, 400);
  await assert.rejects(findWebsiteLogo('example.com', async (url) => response(url, '<html>No brand exposed</html>')), (error) => error.code === 'NO_LOGO' && error.status === 422);
});

test('uses a labelled cached favicon if the company blocks every origin request', async () => {
  const png = await sharp(logoSvg).png().toBuffer();
  const generic = await sharp({ create: { width: 16, height: 16, channels: 4, background: 'gray' } }).png().toBuffer();
  const found = await findWebsiteLogo('https://www.tcs.com/about?private=value', async (url) => {
    if (url.hostname !== 'www.google.com') throw new LogoLookupError('Blocked', 502, 'WEBSITE_BLOCKED');
    assert.equal(url.pathname, '/s2/favicons');
    assert.equal(url.searchParams.has('private'), false);
    const domain = url.searchParams.get('domain');
    assert.ok(['www.tcs.com', 'example.invalid'].includes(domain));
    return response(url, domain === 'example.invalid' ? generic : png, 'image/png');
  });
  assert.equal(found.source, 'Cached site icon (Google)');
  assert.equal(found.type, 'image/png');
});

test('does not save the cached provider’s generic placeholder as a company logo', async () => {
  const generic = await sharp(logoSvg).png().toBuffer();
  await assert.rejects(findWebsiteLogo('example.com', async (url) => {
    if (url.hostname === 'www.google.com') return response(url, generic, 'image/png');
    throw new LogoLookupError('Blocked', 502, 'WEBSITE_BLOCKED');
  }), (error) => error.code === 'WEBSITE_BLOCKED');
});
