import type { Box, Deck, LogoSlot, Manifest, Slide, TextLayer, TextStyle } from './types';
import { fileUrl, putFile } from './storage';

/**
 * Figma → deck manifest.
 *
 * Conventions the designer follows in Figma:
 * - Pages whose name starts with "Deck" become decks (e.g. "Deck – Sales pitch").
 *   If no page is named that way, the first page is used.
 * - Every top-level frame on that page is a slide, ordered top-to-bottom, left-to-right.
 *   Frames inside a Section count too.
 * - A layer named `logo-slot` (or `logo-slot:partner`, `logo:partner`) is a drop zone for a logo.
 *   Slots with the same key share one logo across the deck. Default key: "client".
 * - Every text layer is editable unless its name starts with "lock" or "_".
 * - Write {client} (or any {word}) inside text and it becomes a fill-in field.
 */

const API = process.env.FIGMA_API_BASE || 'https://api.figma.com/v1';

type FNode = {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  children?: FNode[];
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number } | null;
  rotation?: number;
  characters?: string;
  style?: Record<string, any>;
  characterStyleOverrides?: number[];
  fills?: any[];
  opacity?: number;
};

export function parseFileKey(input: string) {
  const m = input.match(/figma\.com\/(?:design|file|proto|slides|deck)\/([A-Za-z0-9]+)(?:\/branch\/([A-Za-z0-9]+))?/);
  if (m) return m[2] || m[1];
  return input.trim();
}

async function figma<T>(path: string, token: string): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(API + path, { headers: { 'X-Figma-Token': token }, cache: 'no-store' });
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') || 5);
      if (wait > 60) throw new Error(rateLimitMessage(wait, res.headers.get('x-figma-plan-tier')));
      await new Promise((r) => setTimeout(r, Math.min(wait, 30) * 1000));
      continue;
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Figma API ${res.status}: ${text.slice(0, 300)}`);
    }
    return res.json() as Promise<T>;
  }
  throw new Error('Figma API rate limit — try again in a minute.');
}

function rateLimitMessage(retryAfter: number, tier: string | null) {
  if (retryAfter > 3600) {
    const days = Math.ceil(retryAfter / 86400);
    return `Figma has paused API access for this token for about ${days} day${days === 1 ? '' : 's'}` +
      (tier === 'starter' ? ' — the Starter plan allows only ~20 exports a month. A token from a Professional plan Dev/Full seat lifts this.' : '.');
  }
  return 'Figma is rate-limiting requests — try again in a minute.';
}

export function isLogoSlot(name: string) {
  return /^(logo-slot|logo:|logo change)/i.test(name.trim());
}
export function slotKey(name: string) {
  const n = name.trim();
  const i = n.indexOf(':');
  return i === -1 ? 'client' : n.slice(i + 1).trim().toLowerCase() || 'client';
}
export function isLocked(name: string) {
  return /^(lock|_)/i.test(name.trim());
}

function rgba(c: { r: number; g: number; b: number; a?: number }, alpha = 1) {
  const to = (v: number) => Math.round(v * 255);
  return `rgba(${to(c.r)}, ${to(c.g)}, ${to(c.b)}, ${+((c.a ?? 1) * alpha).toFixed(3)})`;
}

function toStyle(node: FNode): { style: TextStyle; solid: boolean } {
  const s = node.style || {};
  const fill = (node.fills || []).find((f) => f.visible !== false);
  const solid = !fill || fill.type === 'SOLID';
  const color = fill && fill.type === 'SOLID' ? rgba(fill.color, (fill.opacity ?? 1) * (node.opacity ?? 1)) : 'rgba(0,0,0,1)';
  const fontSize = s.fontSize || 16;
  return {
    solid,
    style: {
      fontFamily: s.fontFamily || 'Inter',
      fontWeight: s.fontWeight || 400,
      fontSize,
      italic: Boolean(s.italic),
      align: s.textAlignHorizontal || 'LEFT',
      valign: s.textAlignVertical || 'TOP',
      letterSpacing: s.letterSpacing || 0,
      lineHeightPx: s.lineHeightPx || fontSize * 1.2,
      textCase: s.textCase || 'ORIGINAL',
      color,
      autoResize: s.textAutoResize || 'NONE',
    },
  };
}

function rel(bb: NonNullable<FNode['absoluteBoundingBox']>, frame: NonNullable<FNode['absoluteBoundingBox']>): Box {
  return { x: bb.x - frame.x, y: bb.y - frame.y, w: bb.width, h: bb.height };
}

export function tokensOf(text: string) {
  return [...new Set([...text.matchAll(/\{([A-Za-z][\w-]*)\}/g)].map((m) => m[1].toLowerCase()))];
}

function collect(frame: FNode) {
  const fb = frame.absoluteBoundingBox!;
  const texts: TextLayer[] = [];
  const slots: LogoSlot[] = [];
  const walk = (n: FNode, lockedAncestor: boolean) => {
    if (n.visible === false) return;
    const bb = n.absoluteBoundingBox;
    if (isLogoSlot(n.name) && bb) {
      slots.push({ id: n.id, name: n.name, key: slotKey(n.name), box: rel(bb, fb) });
      return;
    }
    const locked = lockedAncestor || isLocked(n.name);
    if (n.type === 'TEXT' && bb) {
      const { style, solid } = toStyle(n);
      const rotated = Math.abs(n.rotation || 0) > 0.01;
      const characters = n.characters || '';
      texts.push({
        id: n.id,
        name: n.name,
        characters,
        box: rel(bb, fb),
        style,
        editable: !locked && !rotated && solid,
        mixed: (n.characterStyleOverrides || []).some((v) => v !== 0),
        tokens: tokensOf(characters),
      });
      return;
    }
    n.children?.forEach((c) => walk(c, locked));
  };
  frame.children?.forEach((c) => walk(c, false));
  return { texts, slots };
}

function framesOf(page: FNode): FNode[] {
  const out: FNode[] = [];
  for (const n of page.children || []) {
    if (n.visible === false) continue;
    if (n.type === 'SECTION') out.push(...framesOf(n));
    else if (['FRAME', 'COMPONENT', 'INSTANCE'].includes(n.type) && n.absoluteBoundingBox) out.push(n);
  }
  // reading order: rows (100px tolerance), then left to right
  return out.sort((a, b) => {
    const A = a.absoluteBoundingBox!, B = b.absoluteBoundingBox!;
    const dy = Math.round(A.y / 100) - Math.round(B.y / 100);
    return dy !== 0 ? dy : A.x - B.x;
  });
}

async function decksFromFile(token: string, fileKey: string, syncId: string): Promise<{ fileName: string; decks: Deck[] }> {
  const file = await figma<{ name: string; document: FNode }>(`/files/${fileKey}`, token);
  const pages = (file.document.children || []).filter((p) => p.type === 'CANVAS');
  let deckPages = pages.filter((p) => /^deck/i.test(p.name.trim()));
  // No "Deck" page: the file's first page is the deck, named after the file.
  const fallback = deckPages.length === 0;
  if (fallback) deckPages = pages.slice(0, 1);

  const decks: Deck[] = [];
  for (const page of deckPages) {
    const frames = framesOf(page);
    if (frames.length === 0) continue;

    // Export SVGs with node ids so the editor can swap individual layers.
    const urls: Record<string, string | null> = {};
    for (let i = 0; i < frames.length; i += 10) {
      const ids = frames.slice(i, i + 10).map((f) => f.id).join(',');
      const res = await figma<{ err: string | null; images: Record<string, string | null> }>(
        `/images/${fileKey}?ids=${encodeURIComponent(ids)}&format=svg&svg_include_node_id=true&svg_outline_text=true&svg_simplify_stroke=true`,
        token,
      );
      if (res.err) throw new Error(`Figma export failed: ${res.err}`);
      Object.assign(urls, res.images);
    }

    const slides: Slide[] = [];
    for (const frame of frames) {
      const url = urls[frame.id];
      if (!url) throw new Error(`Figma could not render slide "${frame.name}" in "${file.name}".`);
      const svgRes = await fetch(url);
      if (!svgRes.ok) throw new Error(`Downloading slide "${frame.name}" failed (${svgRes.status}).`);
      const svg = await svgRes.text();
      const pathname = `decks/${syncId}/${fileKey}/${frame.id.replace(/[^\w-]/g, '_')}.svg`;
      await putFile(pathname, svg, 'image/svg+xml');
      const { texts, slots } = collect(frame);
      const bb = frame.absoluteBoundingBox!;
      slides.push({
        id: frame.id,
        name: frame.name,
        width: Math.round(bb.width),
        height: Math.round(bb.height),
        svg: fileUrl(pathname),
        texts,
        slots,
      });
    }
    const name = fallback ? file.name : page.name.replace(/^deck\s*[-–—:]?\s*/i, '') || page.name;
    decks.push({ id: `${fileKey}:${page.id}`, name, slides });
  }
  return { fileName: file.name, decks };
}

/* ---------- Figma Slides files ---------- */

const svgExport = (live: boolean) =>
  `format=svg&svg_include_node_id=true&svg_include_id=true&svg_simplify_stroke=true&svg_outline_text=${live ? 'false' : 'true'}`;

async function exportSvgs(token: string, fileKey: string, ids: string[], live: boolean) {
  const urls: Record<string, string | null> = {};
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10).join(',');
    const res = await figma<{ err: string | null; images: Record<string, string | null> }>(
      `/images/${fileKey}?ids=${encodeURIComponent(chunk)}&${svgExport(live)}`,
      token,
    );
    if (res.err) throw new Error(`Figma export failed: ${res.err}`);
    Object.assign(urls, res.images);
  }
  return urls;
}

async function download(url: string | null | undefined, what: string) {
  if (!url) throw new Error(`Figma could not render ${what}.`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Downloading ${what} failed (${res.status}).`);
  return res.text();
}

type Tag = { start: number; end: number; name: string; attrs: string; close: boolean; self: boolean };

function* tags(svg: string): Generator<Tag> {
  const re = /<(\/?)([a-zA-Z][\w:-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg))) {
    yield { start: m.index, end: re.lastIndex, close: !!m[1], name: m[2], attrs: m[3], self: !!m[4] };
  }
}

type Range = { start: number; end: number; attrs: string };

/**
 * A Slides page export holds every slide (grid → row → slide groups) plus one shared <defs>.
 * Returns each slide's element range, its ancestors' attributes, and every top-level def by id.
 */
function scanPage(svg: string) {
  const stack: { name: string; start: number; attrs: string }[] = [];
  const slides: (Range & { ancestors: string[] })[] = [];
  const defs = new Map<string, Range>();
  let rootOpen = '';
  for (const t of tags(svg)) {
    if (t.close) {
      const open = stack.pop();
      if (!open) continue;
      const depth = stack.length; // depth of the element that just closed
      if (depth === 3 && open.name === 'g' && stack[1]?.name === 'g' && stack[2]?.name === 'g') {
        slides.push({ start: open.start, end: t.end, attrs: open.attrs, ancestors: [stack[1].attrs, stack[2].attrs] });
      }
      if (depth === 2 && stack[1]?.name === 'defs') {
        const id = open.attrs.match(/\bid="([^"]+)"/)?.[1];
        if (id) defs.set(id, { start: open.start, end: t.end, attrs: open.attrs });
      }
      continue;
    }
    if (t.self) {
      if (stack.length === 2 && stack[1].name === 'defs') {
        const id = t.attrs.match(/\bid="([^"]+)"/)?.[1];
        if (id) defs.set(id, { start: t.start, end: t.end, attrs: t.attrs });
      }
      continue;
    }
    if (stack.length === 0) rootOpen = svg.slice(t.start, t.end);
    stack.push({ name: t.name, start: t.start, attrs: t.attrs });
  }
  return { slides, defs, rootOpen };
}

const REF = /url\(#([^)]+)\)|href="#([^"]+)"/g;

/** Splits a Slides page export into one self-contained SVG per slide (only the defs each slide uses). */
export function splitPage(svg: string) {
  const { slides, defs } = scanPage(svg);
  return slides.map((sl) => {
    let body = svg.slice(sl.start, sl.end);
    const id = sl.attrs.match(/data-node-id="([^"]+)"/)?.[1] || '';
    const name = sl.attrs.match(/\bid="([^"]*)"/)?.[1] || '';
    // drop the presentation drop-shadow on the slide
    body = body.replace(/^(<g[^>]*?)\s+filter="url\(#[^)]*\)"/, '$1');

    const need = new Set<string>();
    const queue = [body];
    while (queue.length) {
      const chunk = queue.pop()!;
      for (const m of chunk.matchAll(REF)) {
        const ref = m[1] || m[2];
        if (need.has(ref) || !defs.has(ref)) continue;
        need.add(ref);
        const d = defs.get(ref)!;
        queue.push(svg.slice(d.start, d.end));
      }
    }
    const usedDefs = [...need].map((r) => defs.get(r)!).sort((a, b) => a.start - b.start).map((d) => svg.slice(d.start, d.end)).join('\n');

    const bg = body.match(/<rect width="([\d.]+)" height="([\d.]+)" transform="translate\(([-\d.]+) ([-\d.]+)\)"/);
    const [w, h, x, y] = bg ? bg.slice(1).map(Number) : [1920, 1080, 0, 0];
    // keep any transforms on the grid / row groups
    const wraps = sl.ancestors.map((a) => a.match(/transform="[^"]*"/)?.[0]).filter(Boolean) as string[];
    const inner = wraps.reduceRight((acc, tr) => `<g ${tr}>${acc}</g>`, body);
    const out =
      `<svg width="${w}" height="${h}" viewBox="${x} ${y} ${w} ${h}" fill="none" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">` +
      `${inner}<defs>${usedDefs}</defs></svg>`;
    return { id, name, svg: out, width: Math.round(w), height: Math.round(h) };
  });
}

async function decksFromSlidesFile(token: string, fileKey: string, syncId: string): Promise<{ fileName: string; decks: Deck[] }> {
  const meta = await figma<{ file?: { name?: string }; name?: string }>(`/files/${fileKey}/meta`, token).catch(() => null);
  const fileName = meta?.file?.name || meta?.name || 'Figma Slides deck';

  // Two export calls per sync (Figma's Starter plan allows ~20 a month):
  // the whole presentation with outlined text (what people see) and with live text (to measure layers).
  const PAGE = '0:1';
  const shownUrl = (await exportSvgs(token, fileKey, [PAGE], false))[PAGE];
  const liveUrl = (await exportSvgs(token, fileKey, [PAGE], true))[PAGE];
  const [shownPage, livePage] = await Promise.all([download(shownUrl, 'the presentation'), download(liveUrl, 'the presentation')]);

  const shown = splitPage(shownPage);
  const live = new Map(splitPage(livePage).map((s) => [s.id, s]));
  if (shown.length === 0) throw new Error(`No slides found in "${fileName}".`);

  const slides: Slide[] = [];
  for (let i = 0; i < shown.length; i++) {
    const s = shown[i];
    const label = /^\d+$/.test(s.name) || !s.name ? `Slide ${i + 1}` : s.name;
    const base = `decks/${syncId}/${fileKey}/${s.id.replace(/[^\w-]/g, '_')}`;
    await putFile(`${base}.svg`, s.svg, 'image/svg+xml');
    const l = live.get(s.id);
    if (l) await putFile(`${base}.live.svg`, l.svg, 'image/svg+xml');
    slides.push({
      id: s.id,
      name: label,
      width: s.width,
      height: s.height,
      svg: fileUrl(`${base}.svg`),
      metaSvg: l ? fileUrl(`${base}.live.svg`) : undefined,
      texts: [],
      slots: [],
    });
  }
  return { fileName, decks: [{ id: `${fileKey}:slides`, name: fileName, slides }] };
}

/** FIGMA_FILE_URL can hold one link, or several separated by commas or new lines. */
export function parseFileKeys(input: string) {
  const seen = new Set<string>();
  return input
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((u) => ({ key: parseFileKey(u), slides: /figma\.com\/(slides|deck)\//.test(u) }))
    .filter((f) => !seen.has(f.key) && seen.add(f.key));
}

export async function syncFromFigma(opts: { token: string; files: { key: string; slides: boolean }[] }): Promise<Manifest> {
  const { token, files } = opts;
  const syncId = new Date().toISOString().replace(/[:.]/g, '-');
  const decks: Deck[] = [];
  const names: string[] = [];
  for (const { key, slides } of files) {
    let res: { fileName: string; decks: Deck[] };
    try {
      res = slides ? await decksFromSlidesFile(token, key, syncId) : await decksFromFile(token, key, syncId);
    } catch (e: any) {
      if (slides) throw e;
      // Figma Slides files aren't readable through the file endpoint; use exports instead.
      if (!/file type not supported/i.test(String(e?.message))) throw e;
      res = await decksFromSlidesFile(token, key, syncId);
    }
    names.push(res.fileName);
    decks.push(...res.decks);
  }

  if (decks.length === 0) throw new Error('No frames found. Put each slide in a frame on a page named "Deck".');

  const manifest: Manifest = {
    version: 1,
    source: 'figma',
    syncedAt: new Date().toISOString(),
    fileName: names.join(', '),
    fileKey: files.map((f) => f.key).join(','),
    decks,
  };
  await putFile(`manifests/${syncId}.json`, JSON.stringify(manifest), 'application/json');
  return manifest;
}
