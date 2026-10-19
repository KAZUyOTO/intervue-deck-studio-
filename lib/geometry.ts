import type { Box } from './types';

/** At least half of the box lies on the slide (layers parked off-canvas aren't editable). */
export function onSlide(b: Box, w: number, h: number) {
  const ix = Math.max(0, Math.min(b.x + b.w, w) - Math.max(b.x, 0));
  const iy = Math.max(0, Math.min(b.y + b.h, h) - Math.max(b.y, 0));
  return b.w > 0 && b.h > 0 && ix * iy >= 0.5 * b.w * b.h;
}
