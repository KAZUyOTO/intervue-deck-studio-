'use client';
import type { Box, Slide, TextLayer, TextStyle } from './types';

/** Everything a salesperson has changed on one deck. */
export type DeckValues = {
  vars: Record<string, string>; // {client} → "Acme"
  text: Record<string, string>; // text layer id → new text
  logos: Record<string, { url: string; name: string }>; // slot key → logo
  /** Logo size per slot key, 1 = fits the designer's box. */
  logoSize?: Record<string, number>;
  /** Which edge of the designer's box the logo stays pinned to. */
  logoAlign?: Record<string, LogoAlign>;
};

export type LogoAlign = 'left' | 'center' | 'right';

export const emptyValues = (): DeckValues => ({ vars: {}, text: {}, logos: {}, logoSize: {}, logoAlign: {} });

const MARGIN = 24;

export function rawText(t: TextLayer, v: DeckValues) {
  return v.text[t.id] ?? t.characters;
}

export function resolvedText(t: TextLayer, v: DeckValues) {
  return rawText(t, v).replace(/\{([A-Za-z][\w-]*)\}/g, (m, k: string) => {
    const val = v.vars[k.toLowerCase()];
    return val && val.trim() ? val : m;
  });
}

/** Layers the app draws itself (everything else stays exactly as exported from Figma). */
export function isOverridden(t: TextLayer, v: DeckValues) {
  if (!t.editable) return false;
  if (t.tokens.length) return true;
  const val = v.text[t.id];
  return val !== undefined && val !== t.characters;
}

function applyCase(s: string, c: TextStyle['textCase']) {
  if (c === 'UPPER') return s.toUpperCase();
  if (c === 'LOWER') return s.toLowerCase();
  if (c === 'TITLE') return s.replace(/\b\w/g, (m) => m.toUpperCase());
  return s;
}

export function fontString(st: TextStyle, size: number) {
  const fam = st.fontFamily.replace(/"/g, '');
  return `${st.italic ? 'italic ' : ''}${st.fontWeight} ${size}px "${fam}", system-ui, sans-serif`;
}

type Line = { text: string; width: number };

/** Line height ÷ font size. Figma's "Auto" line height (stored as 0) follows the font's own metrics. */
function lineRatio(ctx: CanvasRenderingContext2D, st: TextStyle) {
  if (st.lineHeightPx > 0) return st.lineHeightPx / st.fontSize;
  ctx.font = fontString(st, st.fontSize);
  const m = ctx.measureText('Hg');
  const h = (m.fontBoundingBoxAscent || 0) + (m.fontBoundingBoxDescent || 0);
  return h > 0 ? h / st.fontSize : 1.2;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number, allowWrap: boolean): Line[] {
  const out: Line[] = [];
  for (const para of text.split('\n')) {
    if (!allowWrap) {
      out.push({ text: para, width: ctx.measureText(para).width });
      continue;
    }
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const next = line + w;
      if (line.trim() && ctx.measureText(next.trimEnd()).width > maxW) {
        out.push({ text: line.trimEnd(), width: ctx.measureText(line.trimEnd()).width });
        line = w.trimStart();
      } else line = next;
    }
    out.push({ text: line.trimEnd(), width: ctx.measureText(line.trimEnd()).width });
  }
  return out;
}

function setSpacing(ctx: CanvasRenderingContext2D, px: number) {
  if ('letterSpacing' in ctx) (ctx as any).letterSpacing = `${px}px`;
}

/**
 * Lays text out the way Figma would for the layer's resize mode, shrinking the
 * font when a longer value would overflow its box or the slide.
 */
const GAP = 16;

export function layoutText(
  ctx: CanvasRenderingContext2D,
  text: string,
  st: TextStyle,
  box: Box,
  slideW: number,
  slideH: number,
  obstacles: Box[] = [],
) {
  const auto = st.autoResize;
  const growsSideways = auto === 'WIDTH_AND_HEIGHT';
  let maxW = box.w;
  if (growsSideways) {
    // Grow sideways until the slide edge or the next layer we know about (other text, logo spots).
    let left = MARGIN, right = slideW - MARGIN;
    for (const o of obstacles) {
      if (o.y >= box.y + box.h || o.y + o.h <= box.y) continue; // not on the same band
      if (o.x >= box.x + box.w - 2) right = Math.min(right, o.x - GAP);
      else if (o.x + o.w <= box.x + 2) left = Math.max(left, o.x + o.w + GAP);
    }
    if (st.align === 'CENTER') {
      const cx = box.x + box.w / 2;
      maxW = 2 * Math.min(cx - left, right - cx);
    } else if (st.align === 'RIGHT') maxW = box.x + box.w - left;
    else maxW = right - box.x;
    maxW = Math.max(maxW, box.w);
  }
  // Never grow taller than the box the designer drew: in a static slide the text below
  // doesn't move out of the way, so longer copy shrinks instead of overlapping it.
  const maxH = Math.min(box.h * 1.04 + 2, slideH - box.y);

  const ratio = lineRatio(ctx, st);
  let size = st.fontSize;
  let lines: Line[] = [];
  for (let i = 0; i < 60; i++) {
    ctx.font = fontString(st, size);
    setSpacing(ctx, st.letterSpacing * (size / st.fontSize));
    lines = wrap(ctx, text, maxW, !growsSideways);
    const widest = Math.max(0, ...lines.map((l) => l.width));
    const height = lines.length * size * ratio;
    if (widest <= maxW + 0.5 && height <= maxH + 1) break;
    if (size <= 6) break;
    size *= 0.95;
  }
  return { lines, size, lineH: size * ratio };
}

export function drawText(ctx: CanvasRenderingContext2D, t: TextLayer, value: string, slideW: number, slideH: number, obstacles: Box[] = []) {
  const st = t.style;
  const text = applyCase(value, st.textCase);
  const { lines, size, lineH } = layoutText(ctx, text, st, t.box, slideW, slideH, obstacles);
  ctx.font = fontString(st, size);
  setSpacing(ctx, st.letterSpacing * (size / st.fontSize));
  ctx.fillStyle = st.color;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const m = ctx.measureText('Hg');
  const asc = m.fontBoundingBoxAscent || size * 0.9;
  const desc = m.fontBoundingBoxDescent || size * 0.22;
  const total = lines.length * lineH;
  const fixed = st.autoResize === 'NONE' || st.autoResize === 'TRUNCATE';
  let top = t.box.y;
  if (fixed && st.valign === 'CENTER') top = t.box.y + (t.box.h - total) / 2;
  if (fixed && st.valign === 'BOTTOM') top = t.box.y + t.box.h - total;
  // Text that had to shrink sits centred in the space the original took, not hugging the top.
  const shrunk = size < st.fontSize - 0.01;
  const shift = shrunk ? Math.max(0, (t.box.h - total) / 2) : 0;
  // When Figma told us where the first baseline sits, keep it there (scaled if the text shrank).
  const base0 =
    t.firstBaseline !== undefined
      ? t.box.y + shift + (t.firstBaseline - t.box.y) * (size / st.fontSize)
      : (shrunk && !fixed ? t.box.y + shift : top) + (lineH - (asc + desc)) / 2 + asc;
  lines.forEach((l, i) => {
    const base = base0 + i * lineH;
    let x = t.box.x;
    if (st.align === 'CENTER') x = t.box.x + t.box.w / 2 - l.width / 2;
    else if (st.align === 'RIGHT') x = t.box.x + t.box.w - l.width;
    ctx.fillText(l.text, x, base);
  });
}

/* ---------- image loading with caches ---------- */

const svgSource = new Map<string, Promise<string>>();
const bgCache = new Map<string, Promise<HTMLImageElement>>();
const logoCache = new Map<string, Promise<HTMLImageElement>>();

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load image'));
    img.src = src;
  });
}

function getSvg(url: string) {
  if (!svgSource.has(url)) {
    svgSource.set(
      url,
      fetch(url).then((r) => {
        if (!r.ok) throw new Error(`Slide failed to load (${r.status})`);
        return r.text();
      }),
    );
  }
  return svgSource.get(url)!;
}

/** The slide SVG with the given layers removed (they get redrawn on top). */
export function background(slide: Slide, hide: string[]) {
  const key = slide.svg + '|' + [...hide].sort().join(',');
  if (!bgCache.has(key)) {
    bgCache.set(
      key,
      getSvg(slide.svg || '').then((src) => {
        let out = src;
        if (hide.length) {
          const doc = new DOMParser().parseFromString(src, 'image/svg+xml');
          for (const id of hide) {
            doc.querySelectorAll(`[data-node-id="${CSS.escape(id)}"]`).forEach((el) => el.remove());
          }
          out = new XMLSerializer().serializeToString(doc);
        }
        const url = URL.createObjectURL(new Blob([out], { type: 'image/svg+xml' }));
        return loadImage(url).catch(() => {
          bgCache.delete(key);
          throw new Error(`Slide “${slide.name}” couldn’t be drawn. Try syncing from Figma again.`);
        });
      }),
    );
  }
  return bgCache.get(key)!;
}

/** Slides load dozens of images; a single dropped request shouldn't leave a gap. */
async function fetchWithRetry(url: string, tries = 3): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      last = new Error(`Image failed to load (${res.status})`);
      if (res.status === 404) break;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  throw last instanceof Error ? last : new Error('Image failed to load');
}

export function logoImage(url: string) {
  if (!logoCache.has(url)) {
    logoCache.set(
      url,
      (async () => {
        const res = await fetchWithRetry(url);
        const type = res.headers.get('content-type') || '';
        if (type.includes('svg') || url.endsWith('.svg')) {
          // SVGs without width/height draw at 0×0 or 300×150 — give them their viewBox size.
          const doc = new DOMParser().parseFromString(await res.text(), 'image/svg+xml');
          const svg = doc.documentElement;
          const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
          const hasW = /^[\d.]+(px)?$/.test(svg.getAttribute('width') || '');
          const hasH = /^[\d.]+(px)?$/.test(svg.getAttribute('height') || '');
          if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
            const scale = 1000 / Math.max(vb[2], vb[3]);
            svg.setAttribute('width', String(vb[2] * scale));
            svg.setAttribute('height', String(vb[3] * scale));
          } else if (!hasW || !hasH) {
            svg.setAttribute('width', '1000');
            svg.setAttribute('height', '500');
          }
          const blob = new Blob([new XMLSerializer().serializeToString(doc)], { type: 'image/svg+xml' });
          return loadImage(URL.createObjectURL(blob));
        }
        return loadImage(URL.createObjectURL(await res.blob()));
      })().catch((e) => {
        logoCache.delete(url); // let the next render try again
        throw e;
      }),
    );
  }
  return logoCache.get(url)!;
}

const trimCache = new Map<string, Promise<CanvasImageSource & { width: number; height: number }>>();

/**
 * Uploaded logos often carry empty transparent margins, which makes them look small in the box.
 * This crops them to the visible part of the image.
 */
export function trimmedLogo(url: string) {
  if (!trimCache.has(url)) {
    trimCache.set(
      url,
      logoImage(url).then((img) => {
        const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        const scan = document.createElement('canvas');
        const k = Math.min(1, 1200 / Math.max(w, h)); // scan a reduced copy for speed
        scan.width = Math.max(1, Math.round(w * k));
        scan.height = Math.max(1, Math.round(h * k));
        const sctx = scan.getContext('2d', { willReadFrequently: true })!;
        sctx.drawImage(img, 0, 0, scan.width, scan.height);
        const ink = inkBox(sctx, scan.width, scan.height);
        if (!ink) return img as any;
        const pad = 1;
        const sx = Math.max(0, ink.x / k - pad), sy = Math.max(0, ink.y / k - pad);
        const sw = Math.min(w - sx, ink.w / k + pad * 2), sh = Math.min(h - sy, ink.h / k + pad * 2);
        if (sw >= w * 0.98 && sh >= h * 0.98) return img as any;
        const out = document.createElement('canvas');
        out.width = Math.round(sw);
        out.height = Math.round(sh);
        out.getContext('2d')!.drawImage(img, sx, sy, sw, sh, 0, 0, out.width, out.height);
        return out;
      }),
    );
  }
  return trimCache.get(url)!;
}

/** Bounding box of pixels that aren't transparent. */
function inkBox(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const d = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 24) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/* ---------- lining edited text up with Figma ---------- */

const calibration = new Map<string, Promise<{ dx: number; dy: number }>>();
const RES = 2; // layer images are exported at 2x

/**
 * Figma and the browser lay text out slightly differently. For each text layer we draw the
 * original wording ourselves, compare it with Figma's own image of that layer, and remember the
 * difference — edited text is then shifted by the same amount so it sits where the designer put it.
 */
function textOffset(t: TextLayer, piece: CanvasImageSource & { width: number; height: number }, slideW: number, slideH: number) {
  const key = `${t.id}|${t.characters}|${fontString(t.style, t.style.fontSize)}`;
  if (!calibration.has(key)) {
    calibration.set(
      key,
      (async () => {
        const zero = { dx: 0, dy: 0 };
        if (!fontAvailable(t.style.fontFamily)) {
          calibration.delete(key); // try again once the font has loaded
          return zero;
        }
        const pad = Math.ceil(Math.max(t.box.w, t.box.h) * 0.25) + 8;
        const W = Math.ceil((t.box.w + pad * 2) * RES), H = Math.ceil((t.box.h + pad * 2) * RES);
        const ours = document.createElement('canvas');
        ours.width = W;
        ours.height = H;
        const octx = ours.getContext('2d', { willReadFrequently: true })!;
        octx.setTransform(RES, 0, 0, RES, (pad - t.box.x) * RES, (pad - t.box.y) * RES);
        drawText(octx, { ...t, style: { ...t.style, color: '#000' } }, t.characters, slideW, slideH);
        const a = inkBox(octx, W, H);

        const theirs = document.createElement('canvas');
        theirs.width = W;
        theirs.height = H;
        const tctx = theirs.getContext('2d', { willReadFrequently: true })!;
        const pb = t.pieceBox ?? t.box;
        tctx.drawImage(piece, (pad + pb.x - t.box.x) * RES, (pad + pb.y - t.box.y) * RES, pb.w * RES, pb.h * RES);
        const b = inkBox(tctx, W, H);
        if (!a || !b) return zero;
        // only trust it when both renderings have the same footprint (same font, same wording)
        if (Math.abs(a.h - b.h) > Math.max(4, b.h * 0.15) || Math.abs(a.w - b.w) > Math.max(8, b.w * 0.12)) return zero;
        const align = t.style.align;
        const ax = align === 'CENTER' ? a.x + a.w / 2 : align === 'RIGHT' ? a.x + a.w : a.x;
        const bx = align === 'CENTER' ? b.x + b.w / 2 : align === 'RIGHT' ? b.x + b.w : b.x;
        const clamp = (v: number) => Math.max(-t.style.fontSize, Math.min(t.style.fontSize, v));
        return { dx: clamp((bx - ax) / RES), dy: clamp((b.y - a.y) / RES) };
      })(),
    );
  }
  return calibration.get(key)!;
}

/* ---------- slide renderer ---------- */

export function hiddenLayers(slide: Slide, v: DeckValues) {
  return [
    ...slide.texts.filter((t) => isOverridden(t, v)).map((t) => t.id),
    ...slide.slots.filter((s) => v.logos[s.key]).map((s) => s.id),
  ];
}

/**
 * Fits a logo into the designer's box. `size` grows or shrinks it from the pinned edge
 * (left / centre / right) so it never wanders away from where the designer placed it.
 */
function fitLogo(ctx: CanvasRenderingContext2D, img: CanvasImageSource & { width: number; height: number }, b: Box, size = 1, align: LogoAlign = 'center') {
  const iw = (img as HTMLImageElement).naturalWidth || img.width, ih = (img as HTMLImageElement).naturalHeight || img.height;
  if (!iw || !ih) return;
  const k = Math.min(b.w / iw, b.h / ih) * size;
  const dw = iw * k, dh = ih * k;
  const x = align === 'left' ? b.x : align === 'right' ? b.x + b.w - dw : b.x + (b.w - dw) / 2;
  ctx.drawImage(img, x, b.y + (b.h - dh) / 2, dw, dh);
}

const logoFor = (v: DeckValues, key: string) => ({ size: v.logoSize?.[key] ?? 1, align: v.logoAlign?.[key] ?? 'center' });

function prepareCanvas(canvas: HTMLCanvasElement, slide: Slide, scale: number) {
  const w = Math.round(slide.width * scale);
  const h = Math.round(slide.height * scale);
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}

/** Boxes of the other editable layers and logo spots on the slide. */
function neighbours(slide: Slide, id: string): Box[] {
  return [...slide.texts.filter((x) => x.id !== id).map((x) => x.box), ...slide.slots.map((x) => x.box)];
}

const optional = (url: string | undefined) => (url ? logoImage(url).catch(() => null) : Promise.resolve(null));

/** Decks published from the Figma plugin: background image + one image per editable layer. */
async function renderPublished(canvas: HTMLCanvasElement, slide: Slide, v: DeckValues, scale: number) {
  const pieces = slide.pieces || {};
  const [bg, slotImgs, textImgs] = await Promise.all([
    logoImage(slide.bg!).catch(() => {
      throw new Error(`Slide “${slide.name}” couldn’t be loaded. Publish the deck again from Figma.`);
    }),
    Promise.all(
      slide.slots.map((s) => {
        const logo = v.logos[s.key]?.url;
        return logo ? trimmedLogo(logo).catch(() => null) : optional(pieces[s.id]);
      }),
    ),
    Promise.all(slide.texts.map((t) => optional(pieces[t.id]))),
  ]);
  const fonts = slide.texts.filter((t) => isOverridden(t, v)).map((t) => fontString(t.style, t.style.fontSize));
  await Promise.all([...new Set(fonts)].map((f) => document.fonts.load(f).catch(() => null)));
  const offsets = await Promise.all(
    slide.texts.map((t, i) => (isOverridden(t, v) && textImgs[i] ? textOffset(t, textImgs[i]!, slide.width, slide.height) : null)),
  );

  const ctx = prepareCanvas(canvas, slide, scale);
  ctx.drawImage(bg, 0, 0, slide.width, slide.height);

  slide.slots.forEach((s, i) => {
    const img = slotImgs[i];
    if (!img) return;
    ctx.globalAlpha = s.alpha ?? 1;
    if (v.logos[s.key]) {
      const { size, align } = logoFor(v, s.key);
      fitLogo(ctx, img, s.box, size, align);
    } else {
      const pb = s.pieceBox ?? s.box;
      ctx.drawImage(img, pb.x, pb.y, pb.w, pb.h);
    }
    ctx.globalAlpha = 1;
  });

  slide.texts.forEach((t, i) => {
    if (isOverridden(t, v)) {
      const o = offsets[i];
      ctx.save();
      if (o) ctx.translate(o.dx, o.dy); // colour already carries the layer's opacity
      drawText(ctx, t, resolvedText(t, v), slide.width, slide.height, neighbours(slide, t.id));
      ctx.restore();
      return;
    }
    const img = textImgs[i];
    if (!img) {
      // the layer image didn't load: draw the text ourselves rather than leave a gap
      drawText(ctx, t, t.characters, slide.width, slide.height, neighbours(slide, t.id));
      return;
    }
    ctx.globalAlpha = t.alpha ?? 1;
    const pb = t.pieceBox ?? t.box; // older decks only have the text box
    ctx.drawImage(img, pb.x, pb.y, pb.w, pb.h);
    ctx.globalAlpha = 1;
  });
}

/** Draws a slide at `scale` (1 = Figma size) into the canvas, resizing it. */
export async function renderSlide(canvas: HTMLCanvasElement, slide: Slide, v: DeckValues, scale: number) {
  if (slide.bg) return renderPublished(canvas, slide, v, scale);
  const bg = await background(slide, hiddenLayers(slide, v));
  const logos = await Promise.all(
    slide.slots.map(async (s) => {
      const l = v.logos[s.key];
      if (!l) return null;
      try {
        return await trimmedLogo(l.url);
      } catch {
        return null;
      }
    }),
  );
  const fonts = slide.texts.filter((t) => isOverridden(t, v)).map((t) => fontString(t.style, t.style.fontSize));
  await Promise.all([...new Set(fonts)].map((f) => document.fonts.load(f).catch(() => null)));

  const ctx = prepareCanvas(canvas, slide, scale);
  ctx.drawImage(bg, 0, 0, slide.width, slide.height);

  slide.slots.forEach((s, i) => {
    const img = logos[i];
    if (!img) return;
    const { size, align } = logoFor(v, s.key);
    fitLogo(ctx, img, s.box, size, align);
  });

  for (const t of slide.texts) {
    if (!isOverridden(t, v)) continue;
    drawText(ctx, t, resolvedText(t, v), slide.width, slide.height, neighbours(slide, t.id));
  }
}

/** Fonts used by edited layers that the browser doesn't have. */
export function missingFonts(slides: Slide[]) {
  const fams = new Set<string>();
  for (const s of slides) for (const t of s.texts) if (t.editable) fams.add(t.style.fontFamily);
  return [...fams].filter((f) => !fontAvailable(f));
}

function fontAvailable(family: string) {
  // A font that isn't installed or loaded falls back to monospace here, so the widths match.
  const c = document.createElement('canvas').getContext('2d')!;
  const sample = 'mmmmmmmmmmlli1WQ@';
  c.font = '40px monospace';
  const mono = c.measureText(sample).width;
  c.font = `40px "${family}", monospace`;
  return Math.abs(c.measureText(sample).width - mono) > 0.5;
}
