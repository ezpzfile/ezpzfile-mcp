// Board facts for the info panel (own code): size, holes, track width, an approximate minimum copper spacing
// (raster estimate), components and nets.
import { emptyBB, bbUnion } from './geom.ts';
import type { PcbDoc } from './model.ts';
import type { Outline } from './outline.ts';
import { makeGrid, minGapPx, rasterLayer } from './raster.ts';

const r3 = (v: number) => +v.toFixed(3);

export function measure(doc: PcbDoc, outline: Outline | null, noSpacing: boolean): Record<string, string | number> {
  const info: Record<string, string | number> = {};
  const cu = doc.layers.filter((l) => l.kind === 'copper');
  let bb = outline ? [...outline.bb] as [number, number, number, number] : null;
  if (!bb) { const b = emptyBB(); for (const L of cu.length ? cu : doc.layers) for (const o of L.objs) bbUnion(b, o.bb); if (Number.isFinite(b[0])) bb = b; }
  if (bb) { info.boardSize = `${r3(bb[2] - bb[0])} x ${r3(bb[3] - bb[1])} mm`; info.boardWidthMm = r3(bb[2] - bb[0]); info.boardHeightMm = r3(bb[3] - bb[1]); }
  if (outline) info.boardAreaMm2 = +outline.area.toFixed(1);
  info.copperLayers = cu.length;
  let holes = 0, slots = 0, pth = 0, npth = 0;
  const sizes = new Set<number>();
  let minHole = Infinity;
  for (const L of doc.layers) {
    if (L.kind !== 'drill') continue;
    for (const o of L.objs) {
      if (o.t === 'hole' || o.t === 'flash') { holes++; } else if (o.t === 'slot' || o.t === 'draw' || o.t === 'arc') slots++; else continue;
      const pl = o.fn ? !/^N/i.test(o.fn) && !/NonPlated/i.test(o.fn) : L.plated;
      if (pl === false) npth++; else if (pl === true) pth++;
      if (o.w && o.w > 0) { sizes.add(Math.round(o.w * 1000)); if (o.w < minHole) minHole = o.w; }
    }
  }
  info.holes = holes;
  if (slots) info.slots = slots;
  if (pth) info.platedHoles = pth;
  if (npth) info.nonPlatedHoles = npth;
  if (sizes.size) info.drillSizes = sizes.size;
  if (Number.isFinite(minHole)) info.minHole = `${r3(minHole)} mm`;
  let minTrack = Infinity;
  for (const L of cu) for (const o of L.objs) if ((o.t === 'draw' || o.t === 'arc') && o.dark && o.w && o.w > 0.001 && o.w < minTrack) minTrack = o.w;
  if (Number.isFinite(minTrack)) info.minTrack = `${r3(minTrack)} mm`;
  if (!noSpacing && cu.length) {
    // outer copper layers first; budget: up to 4 layers
    const pick = [...cu.filter((l) => l.side === 'top' || l.side === 'bottom'), ...cu.filter((l) => l.side === 'inner')].slice(0, 4);
    let best = Infinity;
    for (const L of pick) {
      const b = emptyBB(); for (const o of L.objs) bbUnion(b, o.bb);
      if (!Number.isFinite(b[0])) continue;
      const g = makeGrid(b, 3000, 0.01);
      const img = rasterLayer(L, g, outline);
      const px = minGapPx(img, g, Math.max(3, Math.ceil(0.05 / g.res)));
      if (Number.isFinite(px)) best = Math.min(best, px * g.res);
    }
    if (Number.isFinite(best)) info.minGap = `~${r3(best)} mm`;
  }
  if (doc.comps.length) info.components = doc.comps.length;
  if (doc.nets.size) info.nets = doc.nets.size;
  if (doc.thickness) info.thicknessMm = doc.thickness;
  for (const [k, v] of Object.entries(doc.info)) info[k] = v;
  return info;
}
