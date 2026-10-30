import { getFile, listFiles, putFile } from '@/lib/storage';
import { SAFE_SEGMENT, authorized, json, preflight } from '@/lib/publish';

export const dynamic = 'force-dynamic';

export const OPTIONS = preflight;

async function readDoc(pathname: string) {
  const f = await getFile(pathname);
  if (!f) return null;
  try {
    return JSON.parse(new TextDecoder().decode(f.body));
  } catch {
    return null;
  }
}

/** Every deck whose latest entry is a "removed" marker, with the last published version that can be brought back. */
async function removedDecks() {
  const files = (await listFiles('published/')).filter((f) => f.pathname.endsWith('.json'));
  const bySlug = new Map<string, string[]>();
  for (const f of files) {
    const slug = f.pathname.split('/')[1];
    if (slug) bySlug.set(slug, [...(bySlug.get(slug) || []), f.pathname]);
  }
  const out: { slug: string; name: string; slides: number; removedAt: string; publishedAt: string; version: string }[] = [];
  for (const [slug, paths] of bySlug) {
    paths.sort();
    const latest = await readDoc(paths[paths.length - 1]);
    if (!latest?.removed) continue;
    for (let i = paths.length - 2; i >= 0; i--) {
      const doc = await readDoc(paths[i]);
      if (doc?.deck && !doc.removed) {
        out.push({ slug, name: doc.deck.name, slides: doc.deck.slides?.length || 0, removedAt: latest.publishedAt || '', publishedAt: doc.publishedAt || '', version: paths[i] });
        break;
      }
    }
  }
  return { decks: out.sort((a, b) => (a.removedAt < b.removedAt ? 1 : -1)), files: files.length };
}

/** Decks that were removed from the library and can be restored (designer passcode). */
export async function GET(req: Request) {
  if (!authorized(req)) return json({ error: 'Wrong passcode.' }, 401);
  return json(await removedDecks());
}

/** Brings a removed deck back by re-saving its last published version as the newest entry. */
export async function POST(req: Request) {
  if (!authorized(req)) return json({ error: 'Wrong passcode.' }, 401);
  const body = await req.json().catch(() => null);
  const slugs: string[] = Array.isArray(body?.slugs) ? body.slugs : typeof body?.slug === 'string' ? [body.slug] : [];
  if (!slugs.length || !slugs.every((s) => SAFE_SEGMENT.test(s))) return json({ error: 'Nothing to restore.' }, 400);
  const { decks } = await removedDecks();
  const restored: string[] = [];
  for (const slug of slugs) {
    const entry = decks.find((d) => d.slug === slug);
    if (!entry) continue;
    const doc = await readDoc(entry.version);
    if (!doc?.deck) continue;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await putFile(`published/${slug}/${stamp}.json`, JSON.stringify({ ...doc, restoredFrom: entry.version }), 'application/json');
    restored.push(entry.name);
  }
  return json({ ok: true, restored });
}
