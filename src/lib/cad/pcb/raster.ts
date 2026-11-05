// Scanline rasteriser for PCB layers (own code): objects are painted in file order, dark sets and clear erases
// pixels, so the bitmap follows the Gerber image rules exactly (up to the pixel size). Used for the spacing
// estimate and for comparing two revisions.
import type { BB, Part } from './geom.ts';
import type { PLayer } from './model.ts';
import type { Outline } from './outline.ts';

export interface Grid { x0: number; y0: number; res: number; w: number; h: number }

export function makeGrid(bb: BB, maxPx = 4000, minRes = 0.005): Grid {
  const W = Math.max(bb[2] - bb[0], 1e-3), H = Math.max(bb[3] - bb[1], 1e-3);
  const res = Math.max(minRes, Math.max(W, H) / maxPx);
  const m = res * 2;
  return { x0: bb[0] - m, y0: bb[1] - m, res, w: Math.ceil((W + 2 * m) / res), h: Math.ceil((H + 2 * m) / res) };
}

/** paint one even-odd part; v = 1 sets, 0 clears. Pixel (i, j) covers x0 + i*res .. and is sampled at its centre */
export function paintPart(img: Uint8Array, g: Grid, p: Part, v: number) {
  let ymin = Infinity, ymax = -Infinity;
  for (const r of p) for (let i = 1; i < r.length; i += 2) { if (r[i] < ymin) ymin = r[i]; if (r[i] > ymax) ymax = r[i]; }
  let j0 = Math.max(0, Math.ceil((ymin - g.y0) / g.res - 0.5)), j1 = Math.min(g.h - 1, Math.floor((ymax - g.y0) / g.res - 0.5));
  if (j1 < j0) return;
  const xs: number[] = [];
  for (let j = j0; j <= j1; j++) {
    const y = g.y0 + (j + 0.5) * g.res;
    xs.length = 0;
    for (const r of p) {
      const n = r.length;
      for (let a = 0, b = n - 2; a < n; b = a, a += 2) {
        const ya = r[a + 1], yb = r[b + 1];
        if ((ya > y) !== (yb > y)) xs.push(r[a] + ((y - ya) * (r[b] - r[a])) / (yb - ya));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    const row = j * g.w;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - g.x0) / g.res - 0.5)), i1 = Math.min(g.w - 1, Math.floor((xs[k + 1] - g.x0) / g.res - 0.5));
      if (i1 >= i0) img.fill(v, row + i0, row + i1 + 1);
    }
  }
}

export function rasterLayer(L: PLayer, g: Grid, outline: Outline | null): Uint8Array {
  const img = new Uint8Array(g.w * g.h);
  let flip = false;
  if (L.invert) {
    if (outline) paintPart(img, g, [outline.outer, ...outline.holes], 1); else img.fill(1);
    flip = true;
  }
  for (const o of L.objs) {
    const v = (o.dark !== flip) ? 1 : 0;
    for (const p of o.parts) paintPart(img, g, p, v);
  }
  return img;
}

/** smallest gap (in pixels) between copper pixels along rows, columns and both diagonals; runs < minRun ignored */
export function minGapPx(img: Uint8Array, g: Grid, minRun = 2): number {
  let best = Infinity;
  const { w, h } = g;
  const scan = (start: number, step: number, n: number, unit: number) => {
    let last = -1, gapStart = -1;
    for (let k = 0; k < n; k++) {
      const v = img[start + k * step];
      if (v) {
        if (gapStart >= 0 && last >= 0) { const run = (k - gapStart) * unit; if (k - gapStart >= minRun && run < best) best = run; }
        gapStart = -1; last = k;
      } else if (gapStart < 0) gapStart = k;
    }
  };
  for (let j = 0; j < h; j++) scan(j * w, 1, w, 1);
  for (let i = 0; i < w; i++) scan(i, w, h, 1);
  // diagonals
  for (let s = -h + 1; s < w; s++) {
    const i0 = Math.max(0, s), j0 = i0 - s; const n = Math.min(w - i0, h - j0); if (n > 2) scan(j0 * w + i0, w + 1, n, Math.SQRT2);
  }
  for (let s = 0; s < w + h - 1; s++) {
    const i0 = Math.min(s, w - 1), j0 = s - i0; const n = Math.min(i0 + 1, h - j0); if (n > 2) scan(j0 * w + i0, w - 1, n, Math.SQRT2);
  }
  return best;
}
