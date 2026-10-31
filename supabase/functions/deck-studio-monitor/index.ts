import { createClient } from 'npm:@supabase/supabase-js@2.118.0';

// UptimeRobot's free URL monitor uses a separate credential with no file access.
const MONITOR_TOKEN_HASH = '37a4680b622f1b2447c909a0772b485b21d2e966bfb0dadb978c7804d6fc7bb8';
Deno.serve(async (req: Request) => {
  if (!['GET', 'HEAD'].includes(req.method)) return new Response(null, { status: 405 });
  const token = new URL(req.url).searchParams.get('token') || '';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (hash !== MONITOR_TOKEN_HASH) return new Response(null, { status: 401 });
  let ok = false;
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
    const client = createClient(Deno.env.get('SUPABASE_URL')!, keys.default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await client.rpc('deck_studio_storage_inventory', { page_size: 1 });
    if (error) throw error;
    const { data, error: bucketError } = await client.storage.getBucket('deck-studio');
    if (bucketError || !data) throw bucketError;
    ok = true;
  } catch {
    // Only availability is returned; no file names, credentials, or errors are exposed.
  }
  return new Response(req.method === 'HEAD' ? null : JSON.stringify({ ok }), {
    status: ok ? 200 : 503,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
});
