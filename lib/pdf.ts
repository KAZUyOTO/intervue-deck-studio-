'use client';
import { PDFDocument } from 'pdf-lib';
import type { Deck } from './types';
import { renderSlide, type DeckValues } from './render';

/** Hard ceiling for the exported file (decimal MB, as Mail / Gmail / Finder count it). */
export const MAX_PDF_BYTES = 3_000_000;

// Best quality first; each step trades a little sharpness for size.
const LADDER = [
  { width: 1920, q: 0.92 },
  { width: 1920, q: 0.85 },
  { width: 1920, q: 0.78 },
  { width: 1920, q: 0.7 },
  { width: 1920, q: 0.62 },
  { width: 1600, q: 0.62 },
  { width: 1440, q: 0.55 },
  { width: 1280, q: 0.5 },
  { width: 1080, q: 0.45 },
  { width: 960, q: 0.4 },
  { width: 800, q: 0.38 },
  { width: 640, q: 0.35 },
];
const BASE_WIDTH = 1920;
const PDF_OVERHEAD = 2_000; // per page, roughly

const toJpeg = (canvas: HTMLCanvasElement, q: number) =>
  new Promise<Uint8Array>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? b.arrayBuffer().then((a) => resolve(new Uint8Array(a))) : reject(new Error('Export failed'))),
      'image/jpeg',
      q,
    ),
  );

function downscale(src: HTMLCanvasElement, width: number) {
  if (src.width <= width) return src;
  const c = document.createElement('canvas');
  c.width = width;
  c.height = Math.round((src.height * width) / src.width);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

export async function exportPdf(
  deck: Deck,
  values: DeckValues,
  opts: { title: string; onProgress?: (msg: string, pct: number) => void },
): Promise<{ bytes: Uint8Array; quality: number; width: number; overLimit: boolean }> {
  const slides = deck.slides;

  // Render every slide once at full size; smaller sizes are downscaled from these.
  const base: HTMLCanvasElement[] = [];
  for (let i = 0; i < slides.length; i++) {
    opts.onProgress?.(`Rendering slide ${i + 1} of ${slides.length}`, (i / slides.length) * 0.6);
    const c = document.createElement('canvas');
    await renderSlide(c, slides[i], values, Math.min(BASE_WIDTH / slides[i].width, 2));
    base.push(c);
    await tick();
  }

  let chosen: { jpgs: Uint8Array[]; q: number; width: number } | null = null;
  const sized = new Map<number, HTMLCanvasElement[]>();
  for (let step = 0; step < LADDER.length; step++) {
    const { width, q } = LADDER[step];
    opts.onProgress?.(step === 0 ? 'Compressing' : 'Compressing harder to stay under 3 MB', 0.6 + (step / LADDER.length) * 0.35);
    if (!sized.has(width)) sized.set(width, base.map((c) => downscale(c, width)));
    const jpgs: Uint8Array[] = [];
    let total = slides.length * PDF_OVERHEAD;
    const last = step === LADDER.length - 1;
    for (const c of sized.get(width)!) {
      const j = await toJpeg(c, q);
      jpgs.push(j);
      total += j.length;
      if (total > MAX_PDF_BYTES && !last) break;
    }
    chosen = { jpgs, q, width };
    if (total <= MAX_PDF_BYTES || last) break;
  }

  const pdf = await PDFDocument.create();
  pdf.setTitle(opts.title);
  pdf.setCreator('Deck Studio');
  pdf.setProducer('Deck Studio');
  for (let i = 0; i < slides.length; i++) {
    const img = await pdf.embedJpg(chosen!.jpgs[i]);
    const page = pdf.addPage([slides[i].width, slides[i].height]);
    page.drawImage(img, { x: 0, y: 0, width: slides[i].width, height: slides[i].height });
  }
  const bytes = await pdf.save({ useObjectStreams: true });
  opts.onProgress?.('Done', 1);
  return { bytes, quality: chosen!.q, width: chosen!.width, overLimit: bytes.length > MAX_PDF_BYTES };
}

export function formatBytes(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1000))} KB`;
}
