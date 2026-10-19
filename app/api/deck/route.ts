import { NextResponse } from 'next/server';
import demo from '@/lib/demo-manifest.json';
import { getFile, listFiles, storageReady } from '@/lib/storage';
import type { Deck, Manifest } from '@/lib/types';
import { onSlide } from '@/lib/geometry';

export const dynamic = 'force-dynamic';

async function readJson(pathname: string) {
  const f = await getFile(pathname);
  return f ? JSON.parse(new TextDecoder().decode(f.body)) : null;
}

/** Latest version of every deck published from the Figma plugin (published/<deck>/<time>.json). */
async function publishedDecks(): Promise<{ decks: Deck[]; latest: string }> {
  const files = (await listFiles('published/')).filter((f) => f.pathname.endsWith('.json'));
  const latest = new Map<string, string>();
  for (const f of files) {
    const [, slug, file] = f.pathname.split('/');
    if (!slug || !file) continue;
    const cur = latest.get(slug);
    if (!cur || cur < f.pathname) latest.set(slug, f.pathname);
  }
  const decks: Deck[] = [];
  let newest = '';
  for (const pathname of latest.values()) {
    const doc = await readJson(pathname).catch(() => null);
    if (!doc?.deck || doc.removed) continue;
    const deck: Deck = doc.deck;
    deck.updatedAt = doc.publishedAt;
    for (const s of deck.slides) {
      s.texts = s.texts.filter((t) => onSlide(t.box, s.width, s.height));
      s.slots = s.slots.filter((l) => onSlide(l.box, s.width, s.height));
    }
    decks.push(deck);
    if ((doc.publishedAt || '') > newest) newest = doc.publishedAt;
  }
  decks.sort((a, b) => ((b.updatedAt || '') < (a.updatedAt || '') ? -1 : 1));
  return { decks, latest: newest };
}

export async function GET() {
  let manifest = demo as Manifest;
  try {
    const pub = await publishedDecks();
    const synced = (await listFiles('manifests/')).filter((f) => f.pathname.endsWith('.json'));
    synced.sort((a, b) => (a.pathname < b.pathname ? 1 : -1));
    const api: Manifest | null = synced[0] ? await readJson(synced[0].pathname) : null;
    const decks = [...pub.decks, ...(api?.decks || [])];
    if (decks.length) {
      manifest = {
        version: 1,
        source: pub.decks.length ? 'published' : 'figma',
        syncedAt: [pub.latest, api?.syncedAt || ''].sort().pop() || new Date().toISOString(),
        decks,
      };
    }
  } catch (e) {
    console.error('Could not read decks, falling back to demo', e);
  }
  return NextResponse.json({
    manifest,
    figmaConfigured: Boolean(process.env.FIGMA_TOKEN && process.env.FIGMA_FILE_URL),
    adminKeyRequired: Boolean(process.env.ADMIN_KEY),
    storage: storageReady(),
  });
}
