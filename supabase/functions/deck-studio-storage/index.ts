import { createClient } from 'npm:@supabase/supabase-js@2.118.0';

// Only the credential hash is shipped in source. The token stays in Vercel's server settings.
const TOKEN_HASH = '534fe2d975dc92ab5661a6c499d860a03aa1a9ed7aa19ccb8411d111c52b476f';
const BUCKET = 'deck-studio';
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

Deno.serve(async (req: Request) => {
  const token = req.headers.get('authorization')?.replace(/^Bearer /, '') || '';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const actual = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (actual !== TOKEN_HASH) return json({ error: 'Unauthorized' }, 401);
  const url = new URL(req.url);
  const action = url.searchParams.get('action');
  const pathname = url.searchParams.get('path') || '';
  if (pathname.includes('..') || pathname.includes('\\') || (pathname && !/^(decks|logos|manifests|published)\//.test(pathname))) return json({ error: 'Invalid path' }, 400);
  const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
  const key = keys.default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, key!, { auth: { persistSession: false, autoRefreshToken: false } });
  const files = supabase.storage.from(BUCKET);
  try {
    if (action === 'bootstrap' && req.method === 'POST') {
      const { data: existing, error: lookupError } = await supabase.storage.getBucket(BUCKET);
      if (existing) return json({ ok: true, existing: true });
      if (lookupError && !['404', '400'].includes(String(lookupError.statusCode))) throw lookupError;
      const { error } = await supabase.storage.createBucket(BUCKET, { public: true, fileSizeLimit: 50 * 1024 * 1024 });
      if (error) throw error;
      return json({ ok: true });
    }
    if ((action === 'list' && req.method === 'POST') || (action === 'health' && req.method === 'GET')) {
      const input = action === 'list' ? await req.json() : {};
      const { data, error } = await supabase.rpc('deck_studio_storage_inventory', {
        prefix: pathname, after_path: typeof input.after === 'string' ? input.after : '', page_size: action === 'health' ? 1 : 1000,
      });
      if (error) throw error;
      if (action === 'health') {
        const { data: bucket, error: bucketError } = await supabase.storage.getBucket(BUCKET);
        if (bucketError || !bucket) throw bucketError || new Error('Missing bucket');
        return json({ ok: true });
      }
      return json(data);
    }
    if (action !== 'file' || !pathname || pathname.endsWith('/')) return json({ error: 'Not found' }, 404);
    if (req.method === 'PUT') {
      const body = await req.arrayBuffer();
      if (body.byteLength > 50 * 1024 * 1024) return json({ error: 'File too large' }, 413);
      const migratedAt = req.headers.get('x-migrated-uploaded-at');
      const { error } = await files.upload(pathname, body, {
        upsert: true, contentType: req.headers.get('content-type') || 'application/octet-stream',
        cacheControl: pathname.endsWith('.json') ? '60' : '31536000',
        ...(migratedAt ? { metadata: { migrated_uploaded_at: migratedAt } } : {}),
      });
      if (error) throw error;
      return json({ ok: true });
    }
    if (req.method === 'DELETE') {
      const { error } = await files.remove([pathname]);
      if (error) throw error;
      return json({ ok: true });
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const { data, error } = await files.download(pathname);
      if (error) {
        if (['404', '400'].includes(String(error.statusCode)) && /not found|does not exist/i.test(error.message)) return json({ error: 'Not found' }, 404);
        throw error;
      }
      return new Response(req.method === 'HEAD' ? null : data, { headers: { 'content-type': data.type, 'cache-control': 'no-store' } });
    }
    return json({ error: 'Method not allowed' }, 405);
  } catch (error) {
    console.error('Storage operation failed', action, error instanceof Error ? error.message : 'Unknown error');
    return json({ error: 'Storage operation failed' }, 502);
  }
});
