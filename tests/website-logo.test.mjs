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
