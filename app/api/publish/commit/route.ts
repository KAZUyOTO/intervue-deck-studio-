import { fileUrl, publicUrl, putFile } from '@/lib/storage';
import { SAFE_SEGMENT, authorized, json, preflight, pubPrefix } from '@/lib/publish';
import type { Box, Deck, LogoSlot, Slide, TextLayer } from '@/lib/types';
import { onSlide } from '@/lib/geometry';

export const dynamic = 'force-dynamic';

export const OPTIONS = preflight;

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown, d = '') => (typeof v === 'string' ? v.slice(0, 5000) : d);
const box = (b: any): Box => ({ x: num(b?.x), y: num(b?.y), w: num(b?.w), h: num(b?.h) });

/** Saves the deck the Figma plugin just uploaded. Re-publishing a deck name replaces it. */
export async function POST(req: Request) {
  if (!authorized(req)) return json({ error: 'Wrong passcode.' }, 401);
  const body = await req.json().catch(() => null);
  const slug = str(body?.slug);
  const publishId = str(body?.publishId);
  if (!SAFE_SEGMENT.test(slug) || !SAFE_SEGMENT.test(publishId) || !Array.isArray(body?.slides) || !body.slides.length) {
    return json({ error: 'Nothing to publish.' }, 400);
  }
  const prefix = pubPrefix(slug, publishId);
  // Slides load their images straight from storage. The storage address is the same for every
  // file of this publish, so look it up once from the first slide image.
  const firstBg = typeof body.slides[0]?.bg === 'string' ? body.slides[0].bg : '';
  const direct = firstBg.startsWith(prefix) ? await publicUrl(firstBg) : null;
  const base = direct && direct.endsWith(firstBg) ? direct.slice(0, -firstBg.length) : null;
  // only accept images this publish uploaded
  const own = (p: unknown) =>
    typeof p === 'string' && p.startsWith(prefix) && !p.includes('..') ? (base ? base + p : fileUrl(p)) : undefined;

  const slides: Slide[] = body.slides.map((s: any, i: number) => {
    const pieces: Record<string, string> = {};
    for (const [k, v] of Object.entries(s?.pieces || {})) {
      const u = own(v);
      if (u) pieces[String(k)] = u;
    }
    const width = num(s?.width, 1920), height = num(s?.height, 1080);
    const texts: TextLayer[] = (Array.isArray(s?.texts) ? s.texts : []).map((t: any) => ({
      id: str(t.id),
      name: str(t.name, 'Text'),
      characters: str(t.characters),
      box: box(t.box),
      style: {
        fontFamily: str(t.style?.fontFamily, 'Inter'),
        fontWeight: num(t.style?.fontWeight, 400),
        fontSize: num(t.style?.fontSize, 16),
        italic: Boolean(t.style?.italic),
        align: str(t.style?.align, 'LEFT') as any,
        valign: str(t.style?.valign, 'TOP') as any,
        letterSpacing: num(t.style?.letterSpacing),
        lineHeightPx: num(t.style?.lineHeightPx),
        textCase: str(t.style?.textCase, 'ORIGINAL'),
        color: str(t.style?.color, 'rgba(0,0,0,1)'),
        autoResize: str(t.style?.autoResize, 'NONE') as any,
      },
      editable: true,
      mixed: Boolean(t.mixed),
      tokens: (Array.isArray(t.tokens) ? t.tokens : []).map((x: unknown) => str(x)).filter(Boolean),
      alpha: num(t.alpha, 1),
    })).filter((t: TextLayer) => onSlide(t.box, width, height));
    const slots: LogoSlot[] = (Array.isArray(s?.slots) ? s.slots : []).map((l: any) => ({
      id: str(l.id),
      name: str(l.name),
      key: str(l.key, 'client'),
      box: box(l.box),
      alpha: num(l.alpha, 1),
    })).filter((l: LogoSlot) => onSlide(l.box, width, height));
    return {
      id: str(s?.id, String(i)),
      name: str(s?.name, `Slide ${i + 1}`),
      width,
      height,
      bg: own(s?.bg),
      thumb: own(s?.thumb),
      pieces,
      texts,
      slots,
    };
  });
  if (slides.some((s) => !s.bg)) return json({ error: 'A slide image is missing — publish again.' }, 400);

  const deck: Deck = { id: `pub:${slug}`, name: str(body?.name, 'Deck').slice(0, 120) || 'Deck', slides };
  await putFile(`published/${slug}/${publishId}.json`, JSON.stringify({ deck, publishedAt: new Date().toISOString() }), 'application/json');
  return json({ ok: true, slides: slides.length });
}
