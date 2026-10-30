import type { Deck } from './types';

const byName = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const leadsWithNumber = (name: string) => /^\s*\d/.test(name);

/** Decks whose names start with a number first, in number order (5.1 before 15.1 before 16), then A to Z. */
export function sortDecks<T extends { name: string }>(decks: T[]): T[] {
  return [...decks].sort(
    (a, b) => Number(leadsWithNumber(b.name)) - Number(leadsWithNumber(a.name)) || byName.compare(a.name.trim(), b.name.trim()),
  );
}

const normalise = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

export type DeckMatch = { deck: Deck; inName: boolean; snippet?: string; slide?: number };

/**
 * Finds decks containing every word of the query, in the deck name or in any editable text on its slides.
 * Matches parts of words too, so "airt" finds "Airtel" and "5.1" finds "5.1 - Suite of Products".
 */
export function searchDecks(decks: Deck[], query: string): DeckMatch[] {
  const words = normalise(query).split(' ').filter(Boolean);
  if (!words.length) return decks.map((deck) => ({ deck, inName: true }));
  const out: DeckMatch[] = [];
  for (const deck of decks) {
    const name = normalise(deck.name);
    const texts = deck.slides.flatMap((s, i) => s.texts.map((t) => ({ slide: i + 1, raw: t.characters, text: normalise(t.characters) })));
    const all = [name, ...texts.map((t) => t.text)].join(' \n ');
    if (!words.every((w) => all.includes(w))) continue;
    if (words.every((w) => name.includes(w))) {
      out.push({ deck, inName: true });
      continue;
    }
    // show where the words appear on the slides
    const hit = texts.find((t) => words.some((w) => t.text.includes(w) && !name.includes(w))) || texts.find((t) => words.some((w) => t.text.includes(w)));
    out.push({ deck, inName: false, slide: hit?.slide, snippet: hit ? hit.raw.replace(/\s+/g, ' ').trim().slice(0, 90) : undefined });
  }
  // decks whose name matches come first, keeping the library order within each group
  return [...out.filter((m) => m.inName), ...out.filter((m) => !m.inName)];
}
