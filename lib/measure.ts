'use client';
import type { LogoSlot, Slide, TextLayer, TextStyle } from './types';

/**
 * Figma Slides decks: the API can't list layers, so the sync stores an SVG export with
 * live <text>. Here we lay that SVG out in a hidden, real-size element (with the deck's
 * fonts loaded) and read back where every text layer and logo spot actually sits.
 */

const SLOT = /^(logo-slot|logo:|logo change)/i;
const LOCKED = /^(lock|_)/i;
const MIN_EDITABLE_PX = 14; // smaller text is UI detail inside product screenshots

const slotKey = (name: string) => {
  const i = name.indexOf(':');
  return i === -1 ? 'client' : name.slice(i + 1).trim().toLowerCase() || 'client';
};

const tokensOf = (text: string) => [...new Set([...text.matchAll(/\{([A-Za-z][\w-]*)\}/g)].map((m) => m[1].toLowerCase()))];

const loadedFonts = new Set<string>();

/** Pulls the deck's fonts from Google Fonts when they're published there (Inter, Plus Jakarta Sans, Sora…). */
export async function loadDeckFonts(pairs: { family: string; weight: number; italic: boolean }[]) {
  const jobs: Promise<unknown>[] = [];
  for (const { family, weight, italic } of pairs) {
    const key = `${family}|${weight}|${italic}`;
    if (loadedFonts.has(key)) continue;
    loadedFonts.add(key);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:${italic ? 'ital,' : ''}wght@${italic ? '1,' : ''}${weight}&display=block`;
    document.head.appendChild(link);
    jobs.push(
      new Promise<void>((resolve) => {
        link.onload = () => resolve();
        link.onerror = () => resolve();
      }).then(() => document.fonts.load(`${italic ? 'italic ' : ''}${weight} 32px "${family}"`).catch(() => null)),
    );
  }
  await Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, 6000))]);
}

function weightOf(v: string | null) {
  if (!v) return 400;
  if (v === 'bold') return 700;
  if (v === 'normal') return 400;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 400;
}

/** Walks up to find an attribute set on the text or the nearest ancestor (Figma puts styles on <text>, sometimes <tspan>). */
function attr(el: Element, name: string): string | null {
  return el.getAttribute(name) ?? el.closest(`[${name}]`)?.getAttribute(name) ?? null;
}

function colorOf(el: Element) {
  const fill = el.getAttribute('fill') || attr(el, 'fill') || 'black';
  const op = Number(el.getAttribute('opacity') ?? 1) * Number(el.getAttribute('fill-opacity') ?? 1);
  if (op >= 0.999) return fill;
  // let the canvas parse the colour, then apply opacity
  const c = document.createElement('canvas').getContext('2d')!;
  c.fillStyle = fill;
  const hex = c.fillStyle as string; // #rrggbb or rgba()
  if (hex.startsWith('#')) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${op.toFixed(3)})`;
  }
  return hex;
}

function rotatedOrScaled(el: Element, stopAt: Element) {
  for (let n: Element | null = el; n && n !== stopAt; n = n.parentElement) {
    const t = n.getAttribute('transform') || '';
    if (/rotate|matrix|scale|skew/.test(t)) return true;
  }
  return false;
}

type Measured = { texts: TextLayer[]; slots: LogoSlot[] };
const cache = new Map<string, Promise<Measured>>();

export function measureSlide(slide: Slide): Promise<Measured> {
  if (!slide.metaSvg) return Promise.resolve({ texts: slide.texts, slots: slide.slots });
  if (!cache.has(slide.metaSvg)) {
    cache.set(
      slide.metaSvg,
      (async () => {
        const src = await fetch(slide.metaSvg!).then((r) => {
          if (!r.ok) throw new Error(`Slide “${slide.name}” failed to load`);
          return r.text();
        });
        const doc = new DOMParser().parseFromString(src, 'image/svg+xml');
        const svg = document.importNode(doc.documentElement, true) as unknown as SVGSVGElement;
        // images aren't needed for measuring and would slow layout down
        svg.querySelectorAll('image').forEach((n) => n.remove());

        const fonts = [...svg.querySelectorAll('text')].map((t) => ({
          family: (attr(t, 'font-family') || 'Inter').replace(/["']/g, ''),
          weight: weightOf(attr(t, 'font-weight')),
          italic: attr(t, 'font-style') === 'italic',
        }));
        await loadDeckFonts(fonts);

        const host = document.createElement('div');
        host.setAttribute('aria-hidden', 'true');
        host.style.cssText = `position:fixed;left:-100000px;top:0;width:${slide.width}px;height:${slide.height}px;overflow:hidden;visibility:hidden;pointer-events:none;`;
        svg.setAttribute('width', String(slide.width));
        svg.setAttribute('height', String(slide.height));
        svg.style.display = 'block';
        host.appendChild(svg);
        document.body.appendChild(host);

        try {
          const origin = svg.getBoundingClientRect();
          const rel = (r: DOMRect) => ({ x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height });
          const root = svg.querySelector(`[data-node-id="${CSS.escape(slide.id)}"]`) || svg;

          const slots: LogoSlot[] = [];
          const slotEls: Element[] = [];
          svg.querySelectorAll('[data-node-id]').forEach((el) => {
            const name = (el.getAttribute('id') || '').trim();
            if (!SLOT.test(name) || slotEls.some((s) => s.contains(el))) return;
            const box = rel(el.getBoundingClientRect());
            if (box.w < 2 || box.h < 2) return;
            slotEls.push(el);
            slots.push({ id: el.getAttribute('data-node-id')!, name, key: slotKey(name), box });
          });

          const texts: TextLayer[] = [];
          svg.querySelectorAll('text[data-node-id]').forEach((el) => {
            if (slotEls.some((s) => s.contains(el))) return;
            const t = el as SVGTextElement;
            const name = (t.getAttribute('id') || 'Text').trim();
            const size = parseFloat(attr(t, 'font-size') || '16');
            const ls = attr(t, 'letter-spacing') || '0';
            const letterSpacing = ls.endsWith('em') ? parseFloat(ls) * size : parseFloat(ls) || 0;
            const ctm = t.getScreenCTM();

            // group tspans into visual lines by baseline
            const lines: { y: number; text: string; box: { l: number; r: number; t: number; b: number }; fill: string; weight: string }[] = [];
            const spans = [...t.querySelectorAll('tspan')];
            for (const sp of spans.length ? spans : [t]) {
              const y = parseFloat(sp.getAttribute('y') || '0');
              const x = parseFloat(sp.getAttribute('x') || '0');
              const pt = svg.createSVGPoint();
              pt.x = x;
              pt.y = y;
              const p = ctm ? pt.matrixTransform(ctm) : pt;
              const baseline = p.y - origin.top;
              const r = sp.getBoundingClientRect();
              const text = sp.textContent || '';
              const line = lines.find((l) => Math.abs(l.y - baseline) < 0.5);
              const box = { l: r.left - origin.left, r: r.right - origin.left, t: r.top - origin.top, b: r.bottom - origin.top };
              const fill = sp.getAttribute('fill') || '';
              const weight = sp.getAttribute('font-weight') || '';
              if (line) {
                line.text += text;
                line.box = { l: Math.min(line.box.l, box.l), r: Math.max(line.box.r, box.r), t: Math.min(line.box.t, box.t), b: Math.max(line.box.b, box.b) };
                if (fill !== line.fill || weight !== line.weight) line.fill = '*mixed*';
              } else lines.push({ y: baseline, text, box, fill, weight });
            }
            lines.sort((a, b) => a.y - b.y);
            const content = lines.map((l) => l.text.replace(/\s+$/, '')).join('\n');
            if (!content.trim()) return;

            const lineH = lines.length > 1 ? (lines[lines.length - 1].y - lines[0].y) / (lines.length - 1) : size * 1.26;
            const lefts = lines.map((l) => l.box.l), rights = lines.map((l) => l.box.r);
            const spread = (a: number[]) => Math.max(...a) - Math.min(...a);
            let align: TextStyle['align'] = 'LEFT';
            if (lines.length > 1) {
              const centers = lines.map((l) => (l.box.l + l.box.r) / 2);
              const s = [spread(lefts), spread(rights), spread(centers)];
              const best = Math.min(...s);
              if (best === s[1] && s[1] + 1 < s[0]) align = 'RIGHT';
              else if (best === s[2] && s[2] + 1 < s[0]) align = 'CENTER';
            }
            const x = Math.min(...lefts), r = Math.max(...rights);
            const top = Math.min(lines[0].y - size * 0.95, ...lines.map((l) => l.box.t));
            const bottom = Math.max(...lines.map((l) => l.box.b), lines[lines.length - 1].y + size * 0.3);
            const h = Math.max(bottom - top, lines.length * lineH);

            const firstFill = spans[0]?.getAttribute('fill');
            const color = colorOf(firstFill ? spans[0] : t);
            const mixed = lines.some((l) => l.fill === '*mixed*') || new Set(spans.map((s) => s.getAttribute('fill') || '')).size > 1;
            const weight = weightOf(spans[0]?.getAttribute('font-weight') || attr(t, 'font-weight'));

            texts.push({
              id: t.getAttribute('data-node-id')!,
              name,
              characters: content,
              box: { x, y: top, w: Math.max(r - x, 1), h },
              firstBaseline: lines[0].y,
              style: {
                fontFamily: (attr(t, 'font-family') || 'Inter').replace(/["']/g, ''),
                fontWeight: weight,
                fontSize: size,
                italic: attr(t, 'font-style') === 'italic',
                align,
                valign: 'TOP',
                letterSpacing,
                lineHeightPx: lineH,
                textCase: 'ORIGINAL',
                color,
                autoResize: 'HEIGHT',
              },
              editable: !LOCKED.test(name) && size >= MIN_EDITABLE_PX && !rotatedOrScaled(t, root),
              mixed,
              tokens: tokensOf(content),
            });
          });

          return { texts, slots };
        } finally {
          host.remove();
        }
      })(),
    );
  }
  return cache.get(slide.metaSvg)!;
}

/** Fills in text layers and logo spots for every slide that only has a live-text export. */
export async function hydrateSlides(slides: Slide[]): Promise<Slide[]> {
  if (!slides.some((s) => s.metaSvg)) return slides;
  const out: Slide[] = [];
  for (const s of slides) {
    if (!s.metaSvg) {
      out.push(s);
      continue;
    }
    const m = await measureSlide(s);
    out.push({ ...s, texts: m.texts, slots: m.slots });
  }
  return out;
}
