import { putFile } from '@/lib/storage';
import { SAFE_SEGMENT, authorized, json, preflight } from '@/lib/publish';

export const dynamic = 'force-dynamic';

export const OPTIONS = preflight;

/** Hides a published deck from the editor (publishing it again brings it back). */
export async function POST(req: Request) {
  if (!authorized(req)) return json({ error: 'Wrong passcode.' }, 401);
  const body = await req.json().catch(() => null);
  const id = typeof body?.deckId === 'string' ? body.deckId : '';
  const slug = id.startsWith('pub:') ? id.slice(4) : '';
  if (!SAFE_SEGMENT.test(slug)) return json({ error: 'Only decks published from the plugin can be removed.' }, 400);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await putFile(`published/${slug}/${stamp}.json`, JSON.stringify({ removed: true, publishedAt: new Date().toISOString() }), 'application/json');
  return json({ ok: true });
}
