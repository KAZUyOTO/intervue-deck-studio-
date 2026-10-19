import { NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { exists, fileUrl, listFiles, putFile, storageReady } from '@/lib/storage';
import type { LogoAsset } from '@/lib/types';

export const dynamic = 'force-dynamic';

const TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};
const MAX_BYTES = 4 * 1024 * 1024;

// logos/<hash>--<name>.<ext>
function toAsset(pathname: string, size: number, uploadedAt: string): LogoAsset {
  const file = pathname.slice('logos/'.length);
  const base = file.replace(/\.[a-z0-9]+$/i, '');
  const name = base.includes('--') ? base.slice(base.indexOf('--') + 2) : base;
  return { pathname, url: fileUrl(pathname), name: name.replace(/-/g, ' '), uploadedAt, size };
}

export async function GET() {
  const files = await listFiles('logos/');
  const logos = files
    .map((f) => toAsset(f.pathname, f.size, f.uploadedAt))
    .sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));
  return NextResponse.json({ logos, storage: storageReady() });
}

function sanitizeSvg(svg: string) {
  // Logos are drawn as images, but strip anything active anyway.
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '')
    .replace(/(href\s*=\s*["'])\s*javascript:[^"']*/gi, '$1#');
}

export async function POST(req: Request) {
  const ready = storageReady();
  if (!ready.ok) return NextResponse.json({ error: ready.reason }, { status: 503 });

  const form = await req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'No file.' }, { status: 400 });
  const ext = TYPES[file.type] || (file.name.toLowerCase().endsWith('.svg') ? 'svg' : undefined);
  if (!ext) return NextResponse.json({ error: 'Use a PNG, SVG, JPG or WebP logo.' }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'Logo must be under 4 MB.' }, { status: 400 });

  let body: Buffer = Buffer.from(await file.arrayBuffer());
  if (ext === 'svg') body = Buffer.from(sanitizeSvg(body.toString('utf8')));

  const rawName = String(form.get('name') || file.name).replace(/\.[a-z0-9]+$/i, '');
  const slug =
    rawName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'logo';
  const hash = createHash('sha1').update(body).digest('hex').slice(0, 10);

  // Same file uploaded twice → reuse the existing library entry.
  const existing = (await listFiles(`logos/${hash}--`))[0];
  if (existing) {
    return NextResponse.json({ logo: toAsset(existing.pathname, existing.size, existing.uploadedAt), duplicate: true });
  }
  const pathname = `logos/${hash}--${slug}.${ext}`;
  if (!(await exists(pathname))) {
    await putFile(pathname, body, ext === 'svg' ? 'image/svg+xml' : file.type);
  }
  return NextResponse.json({ logo: toAsset(pathname, body.length, new Date().toISOString()) });
}
