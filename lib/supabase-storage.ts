/** Server-only connection to the bucket-scoped Supabase storage function. */
export const supabaseConfigured = () =>
  ['SUPABASE_URL', 'SUPABASE_STORAGE_BUCKET', 'SUPABASE_STORAGE_GATEWAY_TOKEN'].every((key) => Boolean(process.env[key]?.trim()));

const projectUrl = () => process.env.SUPABASE_URL!.trim().replace(/\/+$/, '');
const bucket = () => process.env.SUPABASE_STORAGE_BUCKET!.trim();
export const supabasePublicUrl = (pathname: string) =>
  `${projectUrl()}/storage/v1/object/public/${encodeURIComponent(bucket())}/${pathname.split('/').map(encodeURIComponent).join('/')}`;

async function request(action: string, pathname = '', init: RequestInit = {}) {
  const url = new URL(`${projectUrl()}/functions/v1/deck-studio-storage`);
  url.searchParams.set('action', action);
  url.searchParams.set('path', pathname);
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${process.env.SUPABASE_STORAGE_GATEWAY_TOKEN!.trim()}`);
  const response = await fetch(url, { ...init, headers, cache: 'no-store', signal: AbortSignal.timeout(60_000) });
  if (!response.ok && response.status !== 404) throw new Error(`Supabase storage ${action} failed (${response.status})`);
  return response;
}

export async function supabasePut(pathname: string, body: Buffer | string, contentType: string) {
  await request('file', pathname, { method: 'PUT', body: typeof body === 'string' ? body : new Uint8Array(body), headers: { 'content-type': contentType } }).then((r) => {
    if (!r.ok) throw new Error(`Supabase upload failed (${r.status})`);
  });
  return supabasePublicUrl(pathname);
}

export async function supabaseGet(pathname: string) {
  const response = await request('file', pathname);
  if (response.status === 404) return null;
  return { body: await response.arrayBuffer(), contentType: response.headers.get('content-type') || 'application/octet-stream' };
}

export async function supabaseExists(pathname: string) {
  return (await request('file', pathname, { method: 'HEAD' })).ok;
}

export async function supabaseDelete(pathname: string) {
  await request('file', pathname, { method: 'DELETE' });
}

export async function supabaseList(prefix: string): Promise<{ pathname: string; size: number; uploadedAt: string }[]> {
  const files: { pathname: string; size: number; uploadedAt: string }[] = [];
  let after = '';
  while (true) {
    const response = await request('list', prefix, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ after }) });
    if (!response.ok) throw new Error(`Supabase list failed (${response.status})`);
    const page = await response.json();
    files.push(...page);
    if (page.length < 1000) return files;
    after = page[page.length - 1].pathname;
  }
}

export async function supabaseHealth() {
  if (!supabaseConfigured()) throw new Error('Supabase storage is not configured');
  const response = await request('health');
  if (!response.ok) throw new Error('Supabase health check failed');
  return response.json();
}
