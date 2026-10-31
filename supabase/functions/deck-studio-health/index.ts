import { createClient } from 'npm:@supabase/supabase-js@2.118.0';

// Platform JWT verification is enabled. This endpoint only returns availability.
Deno.serve(async (req: Request) => {
  if (req.method !== 'GET') return new Response(null, { status: 405 });
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}');
    const client = createClient(Deno.env.get('SUPABASE_URL')!, keys.default || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const { error } = await client.rpc('deck_studio_storage_inventory', { page_size: 1 });
    if (error) throw error;
    const { data, error: bucketError } = await client.storage.getBucket('deck-studio');
    if (bucketError || !data) throw bucketError;
    return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
  } catch {
    return Response.json({ ok: false }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
});
