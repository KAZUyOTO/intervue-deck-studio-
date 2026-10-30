import { AwsClient } from 'aws4fetch';

/**
 * Cloudflare R2 through its S3-compatible API.
 * Needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET and R2_PUBLIC_URL
 * (the bucket's public r2.dev address or a custom domain, used for browser downloads).
 */
export type R2Item = { pathname: string; size: number; uploadedAt: string };

export const r2Configured = () =>
  ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_URL'].every((k) => Boolean(process.env[k]?.trim()));

let client: AwsClient | null = null;
const aws = () =>
  (client ??= new AwsClient({
    accessKeyId: process.env.R2_ACCESS_KEY_ID!.trim(),
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!.trim(),
    service: 's3',
    region: 'auto',
  }));

// R2_ENDPOINT is only for local testing against an S3 stand-in.
const endpoint = () =>
  `${(process.env.R2_ENDPOINT?.trim() || `https://${process.env.R2_ACCOUNT_ID!.trim()}.r2.cloudflarestorage.com`).replace(/\/+$/, '')}/${encodeURIComponent(process.env.R2_BUCKET!.trim())}`;
const keyPath = (pathname: string) => pathname.split('/').map(encodeURIComponent).join('/');

/** Address browsers load the file from (public bucket URL, no API call needed). */
export const r2PublicUrl = (pathname: string) => `${process.env.R2_PUBLIC_URL!.trim().replace(/\/+$/, '')}/${keyPath(pathname)}`;

async function call(url: string, init: RequestInit = {}) {
  const res = await aws().fetch(url, init);
  return res;
}

export async function r2Put(pathname: string, body: Buffer | string, contentType: string) {
  const res = await call(`${endpoint()}/${keyPath(pathname)}`, {
    method: 'PUT',
    body: typeof body === 'string' ? body : new Uint8Array(body),
    headers: { 'content-type': contentType, 'cache-control': 'public, max-age=31536000, immutable' },
  });
  if (!res.ok) throw new Error(`Storage upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return r2PublicUrl(pathname);
}

export async function r2Get(pathname: string): Promise<{ body: ArrayBuffer; contentType: string } | null> {
  const res = await call(`${endpoint()}/${keyPath(pathname)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Storage read failed (${res.status})`);
  return { body: await res.arrayBuffer(), contentType: res.headers.get('content-type') || 'application/octet-stream' };
}

export async function r2Exists(pathname: string) {
  const res = await call(`${endpoint()}/${keyPath(pathname)}`, { method: 'HEAD' });
  return res.ok;
}

export async function r2Delete(pathname: string) {
  const res = await call(`${endpoint()}/${keyPath(pathname)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error(`Storage delete failed (${res.status})`);
}

const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1] ?? '';
const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export async function r2List(prefix: string): Promise<R2Item[]> {
  const out: R2Item[] = [];
  let token = '';
  do {
    const q = new URLSearchParams({ 'list-type': '2', prefix, 'max-keys': '1000' });
    if (token) q.set('continuation-token', token);
    const res = await call(`${endpoint()}?${q}`);
    if (!res.ok) throw new Error(`Storage list failed (${res.status})`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      out.push({
        pathname: unxml(tag(m[1], 'Key')),
        size: Number(tag(m[1], 'Size')) || 0,
        uploadedAt: new Date(tag(m[1], 'LastModified') || Date.now()).toISOString(),
      });
    }
    token = tag(xml, 'IsTruncated') === 'true' ? unxml(tag(xml, 'NextContinuationToken')) : '';
  } while (token);
  return out;
}
