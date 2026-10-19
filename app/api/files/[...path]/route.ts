import { getFile, publicUrl } from '@/lib/storage';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const pathname = path.map(decodeURIComponent).join('/');
  if (!/^(decks|logos|manifests)\//.test(pathname) || pathname.includes('..')) {
    return new Response('Not found', { status: 404 });
  }
  // In production the file comes straight from Blob storage: slides with photos can be
  // larger than a Vercel function is allowed to send back.
  const direct = await publicUrl(pathname);
  if (direct) {
    return new Response(null, {
      status: 307,
      headers: { location: direct, 'cache-control': 'public, max-age=31536000, immutable' },
    });
  }
  const file = await getFile(pathname);
  if (!file) return new Response('Not found', { status: 404 });
  return new Response(file.body, {
    headers: {
      'content-type': file.contentType,
      // every stored path is unique (content hash or sync id), so it never changes
      'cache-control': 'public, max-age=31536000, immutable',
      // uploaded SVGs must never run scripts when opened directly
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
      'x-content-type-options': 'nosniff',
    },
  });
}
