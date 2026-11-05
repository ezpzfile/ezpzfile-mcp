// 2D sheet from the PCB model: one sheet, one layer entry per PCB layer, items in mm (y up). Clear polarity is
// applied exactly: dark objects are cut by later clear objects with the polygon difference in clip.ts, so what is
// drawn is the real copper (no white "paint over"). Own code.
import { Soup, subtract } from './clip.ts';
import { type BB, type Part, bbOverlap, emptyBB, bbUnion, rectRing } from './geom.ts';
import { ringsToFills } from './fills.ts';
import { layerColor } from './classify.ts';
import type { PLayer, PObj } from './model.ts';
import type { Outline } from './outline.ts';
import type { LayerInfo, RvtSheet2D, SheetItem } from './types.ts';

export interface Built2D { sheet: RvtSheet2D; layers: LayerInfo[]; warnings: string[] }

/** drawing order, bottom first */
export function stackRank(L: { kind: string; side: string | null; order: number }): number {
  const k = L.kind, s = L.side;
  if (k === 'board') return 0;
  if (s === 'bottom') {
    if (k === 'component') return 1;
    if (k === 'silk') return 2;
    if (k === 'paste') return 3;
    if (k === 'mask') return 4;
    if (k === 'copper') return 10;
  }
  if (k === 'copper' && s === 'inner') return 20 + Math.min(70, Math.max(0, 100 - (L.order || 50)) * 0.5);
  if (k === 'copper') return 100;
  if (k === 'mask') return 110;
  if (k === 'paste') return 115;
  if (k === 'silk') return 120;
  if (k === 'component') return 125;
  if (k === 'drawing' || k === 'other') return 130;
  if (k === 'outline') return 140;
  if (k === 'drill') return 150;
  if (k === 'diff') return 160;
  return 135;
}

export function defaultVisible(L: PLayer): boolean {
  if (L.kind === 'drawing' || L.kind === 'other' || L.kind === 'paste' || L.kind === 'component') return false;
  if (L.side === 'bottom' && (L.kind === 'silk' || L.kind === 'mask')) return false;
  if (L.kind === 'copper' && L.side === 'inner') return false;
  return true;
}

class PieceIndex {
  cell: number; map = new Map<number, number[]>();
  constructor(b: BB, n: number) { this.cell = Math.max((b[2] - b[0]) / 256, (b[3] - b[1]) / 256, 0.05); void n; }
  key(ix: number, iy: number) { return ix * 100003 + iy; }
  add(id: number, b: BB) {
    const c = this.cell;
    for (let ix = Math.floor(b[0] / c); ix <= Math.floor(b[2] / c); ix++) for (let iy = Math.floor(b[1] / c); iy <= Math.floor(b[3] / c); iy++) {
      const k = this.key(ix, iy);
      let l = this.map.get(k);
      if (!l) this.map.set(k, (l = []));
      l.push(id);
    }
  }
  query(b: BB, seen: Uint32Array, g: number): number[] {
    const c = this.cell, out: number[] = [];
    const nx = Math.floor(b[2] / c) - Math.floor(b[0] / c), ny = Math.floor(b[3] / c) - Math.floor(b[1] / c);
    if (nx * ny > 4e6) return out;
    for (let ix = Math.floor(b[0] / c); ix <= Math.floor(b[2] / c); ix++) for (let iy = Math.floor(b[1] / c); iy <= Math.floor(b[3] / c); iy++) {
      const l = this.map.get(this.key(ix, iy));
      if (!l) continue;
      for (const id of l) if (seen[id] !== g) { seen[id] = g; out.push(id); }
    }
    return out;
  }
}

/** final dark parts of a layer after applying clear objects (and inversion) */
export function resolvePolarity(L: PLayer, frame: BB | null, outline: Outline | null, warnings: string[], budgetMs = 60000): Part[][] {
  let objs: PObj[] = L.objs;
  if (L.invert) {
    // negative image: start dark (board area, else the image extent) and swap the polarities
    const b = emptyBB();
    for (const o of objs) bbUnion(b, o.bb);
    let base: Part;
    if (outline) base = [outline.outer, ...outline.holes];
    else {
      const f = frame && Number.isFinite(frame[0]) ? frame : b;
      if (!Number.isFinite(f[0])) return [];
      const m = 1;
      base = [rectRing((f[0] + f[2]) / 2, (f[1] + f[3]) / 2, f[2] - f[0] + 2 * m, f[3] - f[1] + 2 * m)];
    }
    const bb = emptyBB();
    for (const r of base) for (let i = 0; i < r.length; i += 2) { bb[0] = Math.min(bb[0], r[i]); bb[1] = Math.min(bb[1], r[i + 1]); bb[2] = Math.max(bb[2], r[i]); bb[3] = Math.max(bb[3], r[i + 1]); }
    objs = [{ dark: true, parts: [base], bb, t: 'region' }, ...objs.map((o) => ({ ...o, dark: !o.dark }))];
  }
  const anyClear = objs.some((o) => !o.dark);
  if (!anyClear) return objs.map((o) => o.parts);
  // pieces: one per dark object; a piece becomes a Soup the first time a clear object hits it
  const t0 = Date.now();
  const lb = emptyBB();
  for (const o of objs) bbUnion(lb, o.bb);
  const idx = new PieceIndex(lb, objs.length);
  const pieces: Array<{ parts: Part[]; soups: Soup[] | null; bb: BB; dead: boolean }> = [];
  let seen = new Uint32Array(1024);
  let gen = 0;
  let timedOut = false;
  for (const o of objs) {
    if (o.dark) {
      if (!o.parts.length) continue;
      const id = pieces.length;
      pieces.push({ parts: o.parts, soups: null, bb: [o.bb[0], o.bb[1], o.bb[2], o.bb[3]], dead: false });
      idx.add(id, o.bb);
      if (pieces.length > seen.length) { const s = new Uint32Array(seen.length * 2); s.set(seen); seen = s; }
      continue;
    }
    if (timedOut) continue;
    if (Date.now() - t0 > budgetMs) { timedOut = true; warnings.push(`${L.name}: too many clear (negative) objects; some clearances are not cut`); continue; }
    for (const cp of o.parts) {
      const cb = emptyBB();
      for (const r of cp) for (let i = 0; i < r.length; i += 2) { const x = r[i], y = r[i + 1]; if (x < cb[0]) cb[0] = x; if (x > cb[2]) cb[2] = x; if (y < cb[1]) cb[1] = y; if (y > cb[3]) cb[3] = y; }
      gen++;
      if (gen >= 0xffffffff) { seen.fill(0); gen = 1; }
      for (const id of idx.query(cb, seen, gen)) {
        const P = pieces[id];
        if (P.dead || !bbOverlap(P.bb, cb)) continue;
        if (!P.soups) P.soups = P.parts.map((p) => new Soup([p]));
        let alive = false;
        for (const S of P.soups) { if (S.live) subtract(S, cp, cb); if (S.live) alive = true; }
        if (!alive) P.dead = true;
      }
    }
  }
  const out: Part[][] = [];
  for (const P of pieces) {
    if (P.dead) continue;
    if (!P.soups) { out.push(P.parts); continue; }
    const parts: Part[] = [];
    for (const S of P.soups) { if (!S.live) continue; const rings = S.toRings(); if (rings.length) parts.push(rings); }
    if (parts.length) out.push(parts);
  }
  return out;
}

export function build2D(layers: PLayer[], outline: Outline | null, docName: string, opts: { clearBudgetMs?: number } = {}): Built2D {
  const warnings: string[] = [];
  const items: SheetItem[] = [];
  const infos: LayerInfo[] = [];
  const frame = emptyBB();
  for (const L of layers) if (L.kind === 'copper' || L.kind === 'outline') for (const o of L.objs) bbUnion(frame, o.bb);
  if (!Number.isFinite(frame[0])) for (const L of layers) for (const o of L.objs) bbUnion(frame, o.bb);
  if (outline) bbUnion(frame, outline.bb);
  const order = layers.map((L, i) => ({ L, i })).sort((a, b) => stackRank(a.L) - stackRank(b.L) || a.i - b.i);
  // board substrate under everything
  if (outline) {
    const { color } = layerColor('board', null, 0);
    for (const pts of ringsToFills([outline.outer, ...outline.holes])) items.push({ kind: 'fill', pts, color, layer: 'Board' });
    infos.push({ name: 'Board', color, visible: true, items: 1, kind: 'board', side: null });
  }
  for (const { L } of order) {
    const { color, opacity } = layerColor(L.kind, L.side, L.order);
    let n = 0;
    const drawParts = (parts: Part[]) => {
      for (const p of parts) {
        if (!p.length) continue;
        for (const pts of ringsToFills(p)) {
          const it: SheetItem = { kind: 'fill', pts, color, layer: L.name };
          if (opacity !== undefined) (it as { opacity?: number }).opacity = opacity;
          items.push(it);
          n++;
        }
      }
    };
    if (L.kind === 'outline') {
      // the profile is shown as its centre lines (filled outline regions would hide the board)
      for (const o of L.objs) {
        if (o.path && o.path.length >= 4) { items.push({ kind: 'line', pts: Array.from(o.path), w: 0.15, color, layer: L.name }); n++; continue; }
        for (const p of o.parts) for (const r of p) { const pts = Array.from(r); pts.push(r[0], r[1]); items.push({ kind: 'line', pts, w: 0.1, color, layer: L.name }); n++; }
      }
      const info: LayerInfo = { name: L.name, color, visible: true, items: n, kind: L.kind, side: L.side, file: L.file };
      if (L.fn) info.fn = L.fn;
      infos.push(info);
      continue;
    }
    const resolved = resolvePolarity(L, Number.isFinite(frame[0]) ? frame : null, L.kind === 'copper' ? outline : null, warnings, opts.clearBudgetMs);
    for (const parts of resolved) drawParts(parts);
    // zero-width outline draws still show as thin lines
    if (L.kind === 'drawing' || L.kind === 'component') {
      for (const o of L.objs) if (!o.parts.length && o.path && o.path.length >= 4) { items.push({ kind: 'line', pts: Array.from(o.path), w: 0, color, layer: L.name }); n++; }
    }
    const info: LayerInfo = { name: L.name, color, visible: defaultVisible(L), items: n, kind: L.kind, side: L.side, order: L.order || undefined, file: L.file };
    if (L.fn) info.fn = L.fn;
    if (opacity !== undefined) info.opacity = opacity;
    infos.push(info);
  }
  let W = 100, H = 100, ox = 0, oy = 0;
  if (Number.isFinite(frame[0])) {
    const m = Math.max(2, 0.03 * Math.max(frame[2] - frame[0], frame[3] - frame[1]));
    ox = frame[0] - m; oy = frame[1] - m;
    W = frame[2] - frame[0] + 2 * m; H = frame[3] - frame[1] + 2 * m;
  }
  // move to the sheet origin (bottom-left at 0,0)
  if (ox || oy) for (const it of items) shiftItem(it, -ox, -oy);
  const sheet: RvtSheet2D = {
    id: 1, number: 'PCB', name: docName || 'PCB', size: { w: W, h: H }, items, viewports: [], completeness: 'full', warnings: [], origin: [ox, oy],
  };
  return { sheet, layers: infos, warnings };
}

export function shiftItem(it: SheetItem, dx: number, dy: number) {
  if (it.kind === 'line' || it.kind === 'fill') { const p = it.pts; for (let i = 0; i < p.length; i += 2) { p[i] += dx; p[i + 1] += dy; } }
  else if (it.kind === 'arc') { it.cx += dx; it.cy += dy; }
  else if (it.kind === 'text' || it.kind === 'image') { it.x += dx; it.y += dy; }
}
