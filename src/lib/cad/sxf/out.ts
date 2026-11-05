// Output builder shared by the SFC and the AP202 readers (own code).
// Works in "local" coordinates of a figure plus a 2D affine transform T to sheet mm.
// Line widths, dash pitches, arrow and marker sizes are paper sizes (mm) and are not scaled by T,
// as the SXF reference book says for line types, arrows and point markers.

import type { SheetItem } from './types.ts';
import { arcSegs, ringsToPolygons, saneItem } from './geom.ts';
import { arrowShape, markerShape, type SymPrim } from './tables.ts';

/** x' = a x + c y + e ; y' = b x + d y + f */
export type T2 = [number, number, number, number, number, number];

export const I2: T2 = [1, 0, 0, 1, 0, 0];
export function tMul(p: T2, q: T2): T2 {
  return [
    p[0] * q[0] + p[2] * q[1], p[1] * q[0] + p[3] * q[1],
    p[0] * q[2] + p[2] * q[3], p[1] * q[2] + p[3] * q[3],
    p[0] * q[4] + p[2] * q[5] + p[4], p[1] * q[4] + p[3] * q[5] + p[5],
  ];
}
export function tPlace(x: number, y: number, angDeg: number, sx: number, sy: number): T2 {
  const a = (angDeg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [c * sx, s * sx, -s * sy, c * sy, x, y];
}
export function tInv(t: T2): T2 | null {
  const det = t[0] * t[3] - t[1] * t[2];
  if (!(Math.abs(det) > 1e-300)) return null;
  const a = t[3] / det, b = -t[1] / det, c = -t[2] / det, d = t[0] / det;
  return [a, b, c, d, -(a * t[4] + c * t[5]), -(b * t[4] + d * t[5])];
}
export const ap = (t: T2, x: number, y: number): [number, number] => [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]];
export const lin = (t: T2, x: number, y: number): [number, number] => [t[0] * x + t[2] * y, t[1] * x + t[3] * y];
export function tScale(t: T2): number { return Math.sqrt(Math.abs(t[0] * t[3] - t[1] * t[2])); }
/** similarity check: returns uniform scale, rotation and mirror flag, or null */
export function tSim(t: T2): { s: number; rot: number; mirror: boolean } | null {
  const sx = Math.hypot(t[0], t[1]), sy = Math.hypot(t[2], t[3]);
  if (!(sx > 0) || !(sy > 0)) return null;
  if (Math.abs(t[0] * t[2] + t[1] * t[3]) > 1e-9 * sx * sy) return null;
  if (Math.abs(sx - sy) > 1e-9 * Math.max(sx, sy)) return null;
  const det = t[0] * t[3] - t[1] * t[2];
  return { s: sx, rot: Math.atan2(t[1], t[0]), mirror: det < 0 };
}

export interface Style { color: string; w?: number; dash?: number[]; layer: string }

export class Out {
  items: SheetItem[] = [];
  warnings = new Set<string>();
  layerUse = new Map<string, { n: number; colors: Map<string, number> }>();
  budget: number;
  hatchBudget = 400000;
  dropped = 0;
  tol = 0.05; // chord tolerance in sheet mm

  constructor(budget = 3e6) { this.budget = budget; }

  warn(s: string) { if (this.warnings.size < 60) this.warnings.add(s); }

  push(it: SheetItem, layer: string) {
    if (!saneItem(it)) { this.dropped++; return; }
    if (this.items.length >= this.budget) { this.warn('item budget reached, the drawing is cut'); return; }
    it.layer = layer;
    this.items.push(it);
    let u = this.layerUse.get(layer);
    if (!u) { u = { n: 0, colors: new Map() }; this.layerUse.set(layer, u); }
    u.n++;
    const c = (it as { color?: string }).color;
    if (c) u.colors.set(c, (u.colors.get(c) ?? 0) + 1);
  }

  /** polyline in local coordinates */
  poly(t: T2, pts: number[], st: Style, closed = false) {
    if (pts.length < 4) return;
    const o: number[] = new Array(pts.length + (closed ? 2 : 0));
    for (let i = 0; i < pts.length; i += 2) { const [x, y] = ap(t, pts[i], pts[i + 1]); o[i] = x; o[i + 1] = y; }
    if (closed) { o[pts.length] = o[0]; o[pts.length + 1] = o[1]; }
    const it: SheetItem = { kind: 'line', pts: o, color: st.color };
    if (st.w) it.w = st.w;
    if (st.dash && st.dash.length) it.dash = st.dash;
    this.push(it, st.layer);
  }

  /** points of a local ellipse arc (centre, radii, rotation deg, start / sweep radians) */
  ellipsePts(t: T2, cx: number, cy: number, rx: number, ry: number, rotDeg: number, a0: number, sweep: number, out: number[] = []): number[] {
    const sc = tScale(t) * Math.max(Math.abs(rx), Math.abs(ry));
    const n = Math.min(4096, arcSegs(Math.abs(sweep), sc, this.tol));
    const r = (rotDeg * Math.PI) / 180, cr = Math.cos(r), sr = Math.sin(r);
    for (let i = 0; i <= n; i++) {
      const a = a0 + (sweep * i) / n;
      const ex = rx * Math.cos(a), ey = ry * Math.sin(a);
      out.push(cx + ex * cr - ey * sr, cy + ex * sr + ey * cr);
    }
    return out;
  }

  /** circular arc from a0 by sweep (radians, sign = direction) in local coordinates */
  arc(t: T2, cx: number, cy: number, r: number, a0: number, sweep: number, st: Style) {
    if (!(r > 0) || !Number.isFinite(sweep)) return;
    if (Math.abs(sweep) > Math.PI * 2) sweep = Math.sign(sweep) * Math.PI * 2;
    const sim = tSim(t);
    if (sim && !(st.dash && st.dash.length)) {
      const [x, y] = ap(t, cx, cy);
      let s0 = a0, s1 = a0 + sweep;
      if (sim.mirror) { s0 = -s0; s1 = -s1; }
      s0 += sim.rot; s1 += sim.rot;
      if (s1 < s0) [s0, s1] = [s1, s0];
      const full = Math.abs(sweep) >= Math.PI * 2 - 1e-9;
      const it: SheetItem = full
        ? { kind: 'arc', cx: x, cy: y, r: r * sim.s, a0: 0, a1: Math.PI * 2, color: st.color }
        : { kind: 'arc', cx: x, cy: y, r: r * sim.s, a0: s0, a1: s1, color: st.color };
      if (st.w) it.w = st.w;
      this.push(it, st.layer);
      return;
    }
    this.poly(t, this.ellipsePts(t, cx, cy, r, r, 0, a0, sweep), st);
  }

  /** filled polygons with holes (local rings) */
  fill(t: T2, rings: number[][], color: string, layer: string, opacity?: number) {
    const tr: number[][] = [];
    for (const r of rings) {
      if (r.length < 6) continue;
      const o = new Array(r.length);
      for (let i = 0; i < r.length; i += 2) { const [x, y] = ap(t, r[i], r[i + 1]); o[i] = x; o[i + 1] = y; }
      tr.push(o);
    }
    if (!tr.length) return;
    const polys = tr.length === 1 ? tr : ringsToPolygons(tr);
    for (const p of polys) {
      const it: SheetItem = { kind: 'fill', pts: p, color };
      if (opacity !== undefined && opacity < 1) it.opacity = opacity;
      this.push(it, layer);
    }
  }

  /** text with SXF style anchor (b_pnt 1..9) and direction (1 horizontal, 2 vertical) in local coordinates */
  text(t: T2, s: string, x: number, y: number, h: number, w: number, spc: number, angDeg: number, bpnt: number, direct: number, color: string, layer: string, font?: string) {
    s = s.replace(/[\r\n]+/g, ' ');
    if (!s.trim()) return;
    if (!(h > 0)) h = w > 0 ? w : 2.5;
    const a = (angDeg * Math.PI) / 180;
    const ux = Math.cos(a), uy = Math.sin(a);
    const [tux, tuy] = lin(t, ux, uy);
    const [tvx, tvy] = lin(t, -uy, ux);
    const lu = Math.hypot(tux, tuy), lv = Math.hypot(tvx, tvy);
    if (!(lu > 0) || !(lv > 0)) return;
    const rot = Math.atan2(tuy, tux);
    const H = h * lv, W = (w > 0 ? w : 0) * lu;
    const [px, py] = ap(t, x, y);
    const b = bpnt >= 1 && bpnt <= 9 ? bpnt : 1;
    const col = (b - 1) % 3, row = Math.floor((b - 1) / 3);
    const ex = tux / lu, ey = tuy / lu; // reading direction on the sheet
    const nx = -ey, ny = ex; // up on the sheet (text up)
    if (direct === 2 && [...s].length > 1) {
      // vertical writing: characters top to bottom, the box is W wide (column) and H high (whole column)
      const chars = [...s];
      const n = chars.length;
      const cs = Math.max(0.1, Math.min(W > 0 ? W : H / n, H / n));
      const step = n > 1 ? Math.max(cs, (H - cs) / (n - 1)) : 0;
      // top-left corner of the box from the anchor
      const left = -col * (W > 0 ? W : cs) / 2, top = H - (row * H) / 2;
      for (let k = 0; k < n; k++) {
        const lx = left + (W > 0 ? W : cs) / 2, ly = top - cs - k * step;
        const it: SheetItem = { kind: 'text', x: px + ex * lx + nx * ly, y: py + ey * lx + ny * ly, text: chars[k], size: +cs.toPrecision(5), align: 'center', color };
        if (Math.abs(rot) > 1e-9) it.rot = rot;
        if (font) it.font = font;
        this.push(it, layer);
      }
      return;
    }
    const dy = -(row * H) / 2;
    // SXF gives the full string width; CAD programs squeeze the glyphs to fit it. The sheet contract has no
    // width, so a string that would be clearly wider than its box is drawn smaller (MS Gothic: full 1, half 0.5 em).
    let size = H;
    if (W > 0) {
      let em = 0;
      for (const ch of s) { const c = ch.codePointAt(0)!; em += c >= 0x2e80 && !(c >= 0xff61 && c <= 0xff9f) ? 1 : 0.5; }
      const est = em * H;
      if (est > W * 1.15) size = Math.max(H * 0.5, (H * W) / est);
    }
    const it: SheetItem = { kind: 'text', x: px + nx * dy, y: py + ny * dy, text: s, size: +size.toPrecision(5), color };
    if (col === 1) it.align = 'center'; else if (col === 2) it.align = 'right';
    if (Math.abs(rot) > 1e-9) it.rot = rot;
    if (font) it.font = font;
    this.push(it, layer);
    void spc;
  }

  /** paper sized symbol at sheet point (px,py), local x along (dx,dy) on the sheet */
  symbol(prims: SymPrim[], px: number, py: number, dx: number, dy: number, color: string, layer: string, w?: number) {
    const l = Math.hypot(dx, dy);
    const ex = l > 0 ? dx / l : 1, ey = l > 0 ? dy / l : 0;
    const m: T2 = [ex, ey, -ey, ex, px, py];
    for (const p of prims) {
      if (p.kind === 'line' && p.pts) this.poly(m, p.pts, { color, w, layer });
      else if (p.kind === 'fill' && p.pts) this.fill(m, [p.pts], color, layer);
      else if (p.kind === 'circle') this.arc(m, p.cx!, p.cy!, p.r!, 0, Math.PI * 2, { color, w, layer });
      else if (p.kind === 'disc') {
        const pts = this.ellipsePts(m, p.cx!, p.cy!, p.r!, p.r!, 0, 0, Math.PI * 2);
        pts.length -= 2;
        this.fill(m, [pts], color, layer);
      }
    }
  }

  arrow(code: number, scale: number, px: number, py: number, dx: number, dy: number, color: string, layer: string) {
    if (!(code > 0)) return;
    const s = scale > 0 && scale < 1000 ? scale : 1;
    const prims = arrowShape(code, s);
    if (!prims.length) { this.warn(`unknown arrow code ${code}`); return; }
    this.symbol(prims, px, py, dx, dy, color, layer);
  }

  marker(code: number, scale: number, px: number, py: number, angRad: number, color: string, layer: string) {
    const s = scale > 0 && scale < 1000 ? scale : 1;
    this.symbol(markerShape(code, s), px, py, Math.cos(angRad), Math.sin(angRad), color, layer);
  }
}
