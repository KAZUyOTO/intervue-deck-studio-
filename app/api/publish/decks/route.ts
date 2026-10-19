import { getFile, listFiles } from '@/lib/storage';
import { json, preflight } from '@/lib/publish';

export const dynamic = 'force-dynamic';

export const OPTIONS = preflight;

/** Decks in the library, for the Figma plugin's "deck name" suggestions. */
export async function GET() {
  const files = (await listFiles('published/')).filter((f) => f.pathname.endsWith('.json'));
  const latest = new Map<string, string>();
  for (const f of files) {
    const slug = f.pathname.split('/')[1];
    if (slug && (!latest.get(slug) || latest.get(slug)! < f.pathname)) latest.set(slug, f.pathname);
  }
  const decks: { slug: string; name: string }[] = [];
  for (const [slug, pathname] of latest) {
    const f = await getFile(pathname);
    const doc = f ? JSON.parse(new TextDecoder().decode(f.body)) : null;
    if (doc?.deck && !doc.removed) decks.push({ slug, name: doc.deck.name });
  }
  return json({ decks });
}
