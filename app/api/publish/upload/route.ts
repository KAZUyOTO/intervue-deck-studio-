import { putFile, storageReady } from '@/lib/storage';
import { SAFE_SEGMENT, authorized, json, preflight, pubPrefix } from '@/lib/publish';

export const dynamic = 'force-dynamic';

const TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg' };

export const OPTIONS = preflight;

/** One exported image from the Figma plugin (a slide background or a single layer). */
export async function POST(req: Request) {
  if (!authorized(req)) return json({ error: 'Wrong passcode.' }, 401);
  const ready = storageReady();
  if (!ready.ok) return json({ error: ready.reason }, 503);

  const url = new URL(req.url);
  const deck = url.searchParams.get('deck') || '';
  const id = url.searchParams.get('id') || '';
  const name = url.searchParams.get('name') || '';
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (![deck, id, name].every((s) => SAFE_SEGMENT.test(s)) || !TYPES[ext]) {
    return json({ error: 'Bad upload name.' }, 400);
  }
  const body = Buffer.from(await req.arrayBuffer());
  if (!body.length) return json({ error: 'Empty file.' }, 400);
  const pathname = pubPrefix(deck, id) + name;
  await putFile(pathname, body, TYPES[ext]);
  return json({ path: pathname });
}
