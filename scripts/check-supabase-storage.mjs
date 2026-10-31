import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { supabaseDelete, supabaseExists, supabaseGet, supabaseHealth, supabaseList, supabasePublicUrl, supabasePut } from '../lib/supabase-storage.ts';

const key = `logos/storage-check-${randomUUID()}.json`;
const body = JSON.stringify({ storageCheck: true });
try {
  assert.equal((await supabaseHealth()).ok, true);
  assert.equal(await supabaseExists(key), false);
  assert.equal(await supabasePut(key, body, 'application/json'), supabasePublicUrl(key));
  assert.equal(await supabaseExists(key), true);
  assert.equal(new TextDecoder().decode((await supabaseGet(key)).body), body);
  const listed = await supabaseList('logos/');
  assert.equal(listed.find((f) => f.pathname === key)?.size, Buffer.byteLength(body));
  const publicResponse = await fetch(supabasePublicUrl(key));
  assert.equal(publicResponse.status, 200);
  assert.deepEqual(await publicResponse.json(), JSON.parse(body));
  const unauthorized = await fetch(`${process.env.SUPABASE_URL}/functions/v1/deck-studio-storage?action=list`, { method: 'POST', body: '{}' });
  assert.equal(unauthorized.status, 401);
  console.log('Supabase upload, read, public download, listing, existence, and authentication checks passed.');
} finally {
  await supabaseDelete(key);
}
assert.equal(await supabaseExists(key), false);
assert.equal(await supabaseGet(key), null);
console.log('Supabase deletion and missing-file checks passed.');
