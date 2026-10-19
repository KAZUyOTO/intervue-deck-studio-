import { promises as fs } from 'fs';
import path from 'path';
import { put, list as blobList, head, del } from '@vercel/blob';

/**
 * One tiny storage API with two backends:
 * - Vercel Blob when BLOB_READ_WRITE_TOKEN is set (production)
 * - a local .data folder otherwise (local dev)
 */

export type StoredItem = { pathname: string; size: number; uploadedAt: string };

const useBlob = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN);
const access = () => (process.env.BLOB_ACCESS === 'private' ? 'private' : 'public') as 'public';
const LOCAL_ROOT = path.join(process.cwd(), '.data');

function safeLocal(pathname: string) {
  const full = path.join(LOCAL_ROOT, pathname);
  if (!full.startsWith(LOCAL_ROOT + path.sep)) throw new Error('Bad path');
  return full;
}

export function storageReady(): { ok: boolean; reason?: string } {
  if (useBlob()) return { ok: true };
  if (process.env.VERCEL) {
    return { ok: false, reason: 'Connect a Vercel Blob store to this project to save files.' };
  }
  return { ok: true };
}

/** Saves a file and returns the URL the browser should load it from. */
export async function putFile(pathname: string, body: Buffer | string, contentType: string): Promise<string> {
  if (useBlob()) {
    const res = await put(pathname, body, {
      access: access(),
      contentType,
      addRandomSuffix: false,
      allowOverwrite: true,
    });
    return res.url;
  }
  const full = safeLocal(pathname);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, body);
  return fileUrl(pathname);
}

export async function exists(pathname: string): Promise<boolean> {
  if (useBlob()) {
    try {
      await head(pathname);
      return true;
    } catch {
      return false;
    }
  }
  try {
    await fs.access(safeLocal(pathname));
    return true;
  } catch {
    return false;
  }
}

/** Deletes a stored file (no error if it's already gone). */
export async function deleteFile(pathname: string): Promise<void> {
  if (useBlob()) {
    await del(pathname);
    return;
  }
  await fs.rm(safeLocal(pathname), { force: true });
}

/** Public URL of a stored file in Blob storage (null when running on local files). */
export async function publicUrl(pathname: string): Promise<string | null> {
  if (!useBlob()) return null;
  try {
    return (await head(pathname)).url;
  } catch {
    return null;
  }
}

export async function getFile(pathname: string): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  if (useBlob()) {
    try {
      const meta = await head(pathname);
      const res = await fetch(meta.url, {
        headers: { authorization: `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}` },
      });
      if (!res.ok) return null;
      return { body: await res.arrayBuffer(), contentType: meta.contentType || guessType(pathname) };
    } catch {
      return null;
    }
  }
  try {
    const buf = await fs.readFile(safeLocal(pathname));
    return {
      body: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
      contentType: guessType(pathname),
    };
  } catch {
    return null;
  }
}

export async function listFiles(prefix: string): Promise<StoredItem[]> {
  if (useBlob()) {
    const out: StoredItem[] = [];
    let cursor: string | undefined;
    do {
      const page = await blobList({ prefix, cursor, limit: 1000 });
      for (const b of page.blobs) {
        out.push({ pathname: b.pathname, size: b.size, uploadedAt: new Date(b.uploadedAt).toISOString() });
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return out;
  }
  const dir = safeLocal(prefix.endsWith('/') ? prefix + 'x' : prefix).replace(/[\\/]x$/, '');
  const out: StoredItem[] = [];
  async function walk(d: string) {
    let entries: import('fs').Dirent[] = [];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else {
        const st = await fs.stat(full);
        out.push({
          pathname: path.relative(LOCAL_ROOT, full).split(path.sep).join('/'),
          size: st.size,
          uploadedAt: st.mtime.toISOString(),
        });
      }
    }
  }
  await walk(dir);
  return out.filter((f) => f.pathname.startsWith(prefix));
}

export function guessType(p: string) {
  const ext = p.split('.').pop()?.toLowerCase();
  return (
    {
      svg: 'image/svg+xml',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      json: 'application/json',
    } as Record<string, string>
  )[ext || ''] || 'application/octet-stream';
}

/** Same-origin URL the browser uses for any stored file. */
export const fileUrl = (pathname: string) => `/api/files/${pathname.split('/').map(encodeURIComponent).join('/')}`;
