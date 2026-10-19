import { NextResponse } from 'next/server';
import { createHash } from 'crypto';
import { deleteFile, exists, fileUrl, listFiles, putFile, storageReady } from '@/lib/storage';
import type { LogoAsset } from '@/lib/types';
import { findWebsiteLogo, logoFailure } from '@/lib/website-logo';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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

/** Removes a logo from the shared library. Decks already exported keep it; drafts using it fall back to the empty spot. */
export async function DELETE(req: Request) {
  const pathname = new URL(req.url).searchParams.get('path') || '';
  if (!/^logos\/[a-f0-9]{10}--[a-z0-9-]+\.(png|jpg|webp|svg)$/.test(pathname)) {
    return NextResponse.json({ error: 'Unknown logo.' }, { status: 400 });
  }
  await deleteFile(pathname);
  return NextResponse.json({ ok: true });
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

  if (req.headers.get('content-type')?.includes('application/json')) {
    try {
      const input = await req.json();
      if (typeof input?.url !== 'string' || !input.url.trim() || input.url.length > 2048) {
        return NextResponse.json({ error: 'Enter a company website.' }, { status: 400 });
      }
      const found = await findWebsiteLogo(input.url);
      const result = await saveLogo(new File([new Uint8Array(found.body)], found.name, { type: found.type }), found.name);
      return NextResponse.json({ ...result, source: found.source });
    } catch (error) {
      console.warn('[logos] Website import failed:', error instanceof Error ? error.message : 'Unknown error');
      const failure = logoFailure(error);
      return NextResponse.json({ error: failure.error, code: failure.code }, { status: failure.status });
    }
  }

  const form = await req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'No file.' }, { status: 400 });
  const ext = TYPES[file.type] || (file.name.toLowerCase().endsWith('.svg') ? 'svg' : undefined);
  if (!ext) return NextResponse.json({ error: 'Use a PNG, SVG, JPG or WebP logo.' }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'Logo must be under 4 MB.' }, { status: 400 });

  return NextResponse.json(await saveLogo(file, String(form.get('name') || file.name)));
}

async function saveLogo(file: File, name: string) {
  const ext = TYPES[file.type] || 'svg';
  let body: Buffer = Buffer.from(await file.arrayBuffer());
  if (ext === 'svg') body = Buffer.from(sanitizeSvg(body.toString('utf8')));

  const rawName = name.replace(/\.[a-z0-9]+$/i, '');
  const slug =
    rawName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'logo';
  const hash = createHash('sha1').update(body).digest('hex').slice(0, 10);

  // Same file uploaded twice → reuse the existing library entry.
  const existing = (await listFiles('logos/')).find((item) => item.pathname.startsWith(`logos/${hash}--`));
  if (existing) {
    return { logo: toAsset(existing.pathname, existing.size, existing.uploadedAt), duplicate: true };
  }
  const pathname = `logos/${hash}--${slug}.${ext}`;
  if (!(await exists(pathname))) {
    await putFile(pathname, body, ext === 'svg' ? 'image/svg+xml' : file.type);
  }
  return { logo: toAsset(pathname, body.length, new Date().toISOString()) };
}
