// Turns the drawing database into RvtSheet2D sheets (mm, origin bottom-left, y up).
import type { Doc, EntBase, Layer } from './doc.ts';
import type { Color } from './objects.ts';
import type { SheetItem, RvtSheet2D, SheetViewport, DwgLayer } from './types.ts';
import { ACI, paperColor } from './aci.ts';
import { parseProxyGraphics } from './proxy.ts';
import type { M2 } from './geom.ts';
import {
  IDENT, mul, apx, apy, det, mscale, isSimilar, ocsMatrix, bulgePts, arcPts, bspline, catmull, polyArea, pointInPoly,
  clipPolyline, clipPolygon,
} from './geom.ts';

// memory budgets: one item costs roughly 250-400 bytes in the worker (and again when posted to the page)
export const MAX_ITEMS = 1_500_000;
const MAX_PATTERN_SEGS = 400_000;   // all pattern hatch lines together; beyond that hatches become light fills
const LW = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];
const UNIT_MM: Record<number, number> = {
  0: 1, 1: 25.4, 2: 304.8, 3: 1609344, 4: 1, 5: 10, 6: 1000, 7: 1e6, 8: 2.54e-5, 9: 0.0254, 10: 914.4,
  11: 1e-7, 12: 1e-6, 13: 1e-3, 14: 100, 15: 1e4, 16: 1e5, 17: 1e12, 18: 1.495978707e14, 19: 9.46073e18,
  20: 3.0857e19, 21: 304.8006096,
};
export const UNIT_NAMES: Record<number, string> = {
  0: 'unitless', 1: 'inch', 2: 'foot', 3: 'mile', 4: 'mm', 5: 'cm', 6: 'm', 7: 'km', 8: 'microinch', 9: 'mil', 10: 'yard',
  11: 'angstrom', 12: 'nm', 13: 'micron', 14: 'dm', 15: 'dam', 16: 'hm', 17: 'Gm', 18: 'AU', 19: 'light year', 20: 'parsec', 21: 'US survey foot',
};

interface Ctx {
  m: M2;
  color: string;          // resolved BYBLOCK colour
  layer: Layer | null;    // effective layer of the parent insert (for entities on layer 0)
  ltype: number;          // BYBLOCK linetype handle
  depth: number;
  inBlock: boolean;
  paper: boolean;         // paper space (line weights are drawn)
}

export const SUPPORTED = new Set(['LINE', 'POINT', 'CIRCLE', 'ARC', 'ELLIPSE', 'SOLID', 'TRACE', '3DFACE', 'TEXT', 'ATTRIB', 'ATTDEF',
  'INSERT', 'MINSERT', 'POLYLINE_2D', 'POLYLINE_3D', 'POLYLINE_PFACE', 'POLYLINE_MESH', 'LWPOLYLINE', 'SPLINE', 'MTEXT',
  'DIMENSION_ORDINATE', 'DIMENSION_LINEAR', 'DIMENSION_ALIGNED', 'DIMENSION_ANG3PT', 'DIMENSION_ANG2LN', 'DIMENSION_RADIUS',
  'DIMENSION_DIAMETER', 'ARC_DIMENSION', 'LARGE_RADIAL_DIMENSION', 'LEADER', 'MLEADER', 'MULTILEADER', 'HATCH', 'VIEWPORT']);
export const STRUCTURAL = new Set(['BLOCK', 'ENDBLK', 'SEQEND', 'VERTEX_2D', 'VERTEX_3D', 'VERTEX_MESH', 'VERTEX_PFACE', 'VERTEX_PFACE_FACE']);

export class Renderer {
  doc: Doc;
  items: SheetItem[] = [];
  total = 0;
  warnings = new Set<string>();
  refSize: number;
  stopped = false;
  layerByName = new Map<string, Layer>();
  layer0: Layer | null = null;
  constructor(doc: Doc) {
    this.doc = doc;
    for (const l of doc.layers.values()) { this.layerByName.set(l.name, l); if (l.name === '0') this.layer0 = l; }
    const hv = doc.hv;
    let ref = 0;
    if (hv.extMin && hv.extMax && hv.extMax[0] > hv.extMin[0] && hv.extMax[0] - hv.extMin[0] < 1e12) {
      ref = Math.max(hv.extMax[0] - hv.extMin[0], hv.extMax[1] - hv.extMin[1]);
    }
    this.refSize = ref > 0 ? ref : 100;
  }

  // ---------------------------------------------------------------- styling
  layerOf(e: EntBase, ctx: Ctx): Layer | null {
    const l = this.doc.layers.get(e.layer) || null;
    if (ctx.inBlock && ctx.layer && (!l || l.name === '0')) return ctx.layer;
    return l;
  }
  layerColor(l: Layer | null): string {
    if (!l) return '#000000';
    if (l.color.rgb !== null) return paperColor(l.color.rgb);
    return paperColor(ACI[Math.abs(l.color.index) & 255] ?? 0);
  }
  colorOf(c: Color, l: Layer | null, ctx: Ctx): string {
    if (c.book) { const rgb = this.doc.dbcolors.get(c.book); if (rgb !== undefined) return paperColor(rgb); }
    if (c.index === 256 && c.rgb === null) return this.layerColor(l);
    if (c.index === 0 && c.rgb === null) return ctx.color;
    if (c.rgb !== null) return paperColor(c.rgb);
    return paperColor(ACI[Math.abs(c.index) & 255] ?? 0);
  }
  dashOf(e: EntBase, l: Layer | null, ctx: Ctx, m: M2): number[] | undefined {
    let h = e.ltype;
    if (h === 0) h = l ? l.ltype : 0;
    else if (h === -1) h = ctx.ltype;
    if (h <= 0) return undefined;
    let lt = this.doc.ltypes.get(h);
    if (lt) {
      const n = lt.name.toUpperCase();
      if (n === 'BYLAYER') { lt = l ? this.doc.ltypes.get(l.ltype) : undefined; }
      else if (n === 'BYBLOCK') { lt = this.doc.ltypes.get(ctx.ltype); }
    }
    if (!lt || !lt.dashes || lt.dashes.length < 2) return undefined;
    const sc = (this.doc.hv.ltscale || 1) * (e.ltscale || 1) * mscale(m);
    const out: number[] = [];
    for (const d of lt.dashes) {
      const v = Math.abs(d) * sc;
      const on = d >= 0;
      const len = d === 0 ? Math.max(v, 0.0001 * this.refSize * mscale(m)) : v;
      if (out.length % 2 === 0) { if (on) out.push(len); else { out.push(0, len); } }
      else { if (on) out.push(0, len); else out.push(len); }
    }
    if (out.length % 2 === 1) out.push(0);
    const sum = out.reduce((a, b) => a + b, 0);
    if (!(sum > 0) || sum < this.refSize * mscale(m) * 1e-5) return undefined;
    return out;
  }
  // plotted line weight in mm (undefined = default)
  lwOf(e: EntBase, l: Layer | null): number | undefined {
    let i = e.lweight;
    if (i === 29 || i < 0) i = l ? l.lweight : 31;
    if (i === 30) i = 31;
    if (i >= 0 && i < LW.length) return Math.max(0.05, LW[i] / 100);
    return undefined;
  }
  widthOf(e: EntBase, l: Layer | null, ctx: Ctx): number | undefined {
    const w = this.lwOf(e, l);
    if (!ctx.paper) { this.curLw = w; return undefined; }
    this.curLw = undefined;
    return w;
  }
  curLw: number | undefined = undefined;
  lws: number[] | null = null;   // model line weights (mm) parallel to items, used for paper viewports

  push(it: SheetItem) {
    if (this.stopped) return;
    if (this.total >= MAX_ITEMS) { this.stopped = true; this.warnings.add('item limit reached: drawing truncated'); return; }
    this.items.push(it); this.total++;
    if (this.lws) this.lws.push((it.kind === 'line' || it.kind === 'arc') ? (this.curLw || 0) : 0);
  }
  line(pts: number[], m: M2, color: string, layer: string, dash?: number[], w?: number) {
    if (pts.length < 4) return;
    const q = new Array(pts.length);
    for (let i = 0; i < pts.length; i += 2) { q[i] = apx(m, pts[i], pts[i + 1]); q[i + 1] = apy(m, pts[i], pts[i + 1]); }
    for (const v of q) if (!Number.isFinite(v)) return;
    const it: any = { kind: 'line', pts: q, color, layer };
    if (dash) it.dash = dash;
    if (w) it.w = w;
    this.push(it);
  }
  fill(pts: number[], m: M2, color: string, layer: string, opacity?: number) {
    if (pts.length < 6) return;
    const q = new Array(pts.length);
    for (let i = 0; i < pts.length; i += 2) { q[i] = apx(m, pts[i], pts[i + 1]); q[i + 1] = apy(m, pts[i], pts[i + 1]); }
    for (const v of q) if (!Number.isFinite(v)) return;
    const it: any = { kind: 'fill', pts: q, color, layer };
    if (opacity !== undefined && opacity < 1) it.opacity = opacity;
    this.push(it);
  }
  arc(cx: number, cy: number, r: number, a0: number, a1: number, m: M2, color: string, layer: string, dash?: number[], w?: number) {
    if (!(r > 0) || !Number.isFinite(r)) return;
    const full = Math.abs(a1 - a0) >= Math.PI * 2 - 1e-9;
    if (!dash && isSimilar(m)) {
      const s = mscale(m);
      const th = Math.atan2(m[1], m[0]);
      let b0: number, b1: number;
      if (full) { b0 = 0; b1 = Math.PI * 2; }
      else if (det(m) > 0) { b0 = a0 + th; b1 = a1 + th; }
      else { b0 = th - a1; b1 = th - a0; }
      const it: any = { kind: 'arc', cx: apx(m, cx, cy), cy: apy(m, cx, cy), r: r * s, a0: b0, a1: b1, color, layer };
      if (w) it.w = w;
      if (!Number.isFinite(it.cx) || !Number.isFinite(it.cy)) return;
      this.push(it);
      return;
    }
    const pts: number[] = [];
    if (full) arcPts(cx, cy, r, 0, Math.PI * 2, pts); else arcPts(cx, cy, r, a0, a1, pts);
    this.line(pts, m, color, layer, dash, w);
  }
  text(x: number, y: number, str: string, height: number, rot: number, align: 'left' | 'center' | 'right', m: M2, color: string, layer: string, font?: string) {
    if (!str || !(height > 0)) return;
    const X = apx(m, x, y), Y = apy(m, x, y);
    if (!Number.isFinite(X) || !Number.isFinite(Y)) return;
    // rotation of the text direction through the matrix
    const dx = Math.cos(rot), dy = Math.sin(rot);
    const tx = m[0] * dx + m[2] * dy, ty = m[1] * dx + m[3] * dy;
    let r = Math.atan2(ty, tx);
    // text height along the text's up direction
    const ux = -dy, uy = dx;
    const hs = Math.hypot(m[0] * ux + m[2] * uy, m[1] * ux + m[3] * uy);
    let al = align;
    if (det(m) < 0) {
      // mirrored insert: AutoCAD keeps text readable (MIRRTEXT 0); flip direction instead
      r = r + Math.PI;
      al = align === 'left' ? 'right' : align === 'right' ? 'left' : align;
    }
    const it: any = { kind: 'text', x: X, y: Y, text: str, size: height * hs * TEXT_EM, color, layer };
    if (Math.abs(r) > 1e-9) it.rot = normAng(r);
    if (al !== 'left') it.align = al;
    if (font) it.font = font;
    this.push(it);
  }

  // ---------------------------------------------------------------- blocks
  // object indices of a block's entities, in draw order
  blockEntities(bh: number): number[] {
    const d = this.doc;
    const b = d.blocks.get(bh);
    // R2004+: the block record lists its entities (draw order); an empty list means an empty block
    if (b && b.entities && (b.entities.length || d.ver >= 18)) {
      const out: number[] = [];
      for (const h of b.entities) { const i = d.indexOf(h); if (i >= 0) out.push(i); }
      return out;
    }
    let out: number[] = [];
    if (bh === d.ms) out = d.spaceList[1].slice();
    else if (bh === d.ps) out = d.spaceList[0].slice();
    const ch = d.children.get(bh);
    if (ch) { out = out.length ? out.concat(ch) : ch.slice(); }
    if (out.length > 1) out.sort((x, y) => x - y);
    return out;
  }
  // decoded entities of blocks that are inserted (not model / paper space), kept within a budget
  blockCache = new Map<number, EntBase[]>();
  cacheBudget = 200000;
  seenBlocks = new Set<number>();
  viewports: EntBase[] = [];
  drawSafe(e: EntBase, ctx: Ctx) {
    try { this.drawEnt(e, ctx); } catch (err) { this.warnings.add('draw error on ' + e.kind + ': ' + (err as Error).message); }
  }
  drawBlock(bh: number, ctx: Ctx) {
    if (ctx.depth > 24) { this.warnings.add('block nesting deeper than 24 levels skipped'); return; }
    const d = this.doc;
    const isSpace = bh === d.ms || bh === d.ps || ctx.depth === 0;
    const cached = isSpace ? undefined : this.blockCache.get(bh);
    if (cached) {
      for (const e of cached) { if (this.stopped) return; this.drawSafe(e, ctx); }
      return;
    }
    const idx = this.blockEntities(bh);
    // cache a block only from its second use on (dimension blocks are used once)
    let keep: EntBase[] | null = null;
    if (!isSpace) {
      if (!this.seenBlocks.has(bh)) this.seenBlocks.add(bh);
      else if (this.cacheBudget >= idx.length) { keep = []; this.cacheBudget -= idx.length; }
    }
    let run: EntBase | null = null;
    const emit = (e: EntBase) => { if (keep) keep.push(e); this.drawSafe(e, ctx); };
    for (const i of idx) {
      if (this.stopped) return;
      const e = d.entAt(i);
      if (!e) continue;
      if (ctx.depth === 0 && ctx.paper && e.kind === 'VIEWPORT') this.viewports.push(e);
      const merged: EntBase | null = run ? this.mergeRun(run, e) : null;
      if (merged) { run = merged; continue; }
      if (run) { emit(run); run = null; }
      if (this.isRun(e)) run = e; else emit(e);
    }
    if (run) emit(run);
    if (keep && !this.stopped) this.blockCache.set(bh, keep);
  }

  // Drawings converted from PDF often store a word as several single line MTEXT runs split at every accented
  // letter ("Borr" + "o-acute"), each placed with the original font's advance. Drawn with another font the runs leave
  // gaps, so consecutive runs on one baseline with the same style are merged when they meet at a non-ASCII letter.
  isRun(e: EntBase): boolean {
    return e.kind === 'MTEXT' && !e.invisible && (e.attach === 1 || e.attach === 4 || e.attach === 7) && !/\\[PX]|\n/.test(e.text);
  }
  mergeRun(r0: EntBase, e: EntBase): EntBase | null {
    if (!this.isRun(e) || e.layer !== r0.layer || e.style !== r0.style || e.attach !== r0.attach ||
      Math.abs(e.height - r0.height) > 1e-6 * r0.height || e.color.index !== r0.color.index || e.color.rgb !== r0.color.rgb) return null;
    const ux: number = r0.xdir[0], uy: number = r0.xdir[1], ul = Math.hypot(ux, uy) || 1;
    const dx: number = e.ins[0] - r0.ins[0], dy: number = e.ins[1] - r0.ins[1];
    const along = (dx * ux + dy * uy) / ul, across = (-dx * uy + dy * ux) / ul;
    const exd = Math.hypot(e.xdir[0], e.xdir[1]) || 1;
    const sameDir = Math.abs((e.xdir[0] / exd) * (uy / ul) - (e.xdir[1] / exd) * (ux / ul)) < 1e-6;
    if (!sameDir || Math.abs(across) >= 0.05 * r0.height || !(along > 0)) return null;
    const a = parseMText(r0.text).text, b = parseMText(e.text).text;
    if (!a || !b) return null;
    const accent = /[^\x00-\x7f]$/.test(a) || /^[^\x00-\x7f]/.test(b);
    if (!accent) return null;
    // extents width may be missing (0): estimate it from the character count
    const w0 = r0.extW > 0 ? r0.extW : a.length * 0.75 * r0.height;
    const gap = along - w0;
    const tol = r0.extW > 0 ? 0.6 * r0.height : 0.6 * r0.height + 0.35 * w0;
    if (gap > -0.3 * r0.height - (r0.extW > 0 ? 0 : 0.4 * w0) && gap < tol) {
      const ew = e.extW > 0 ? e.extW : b.length * 0.75 * e.height;
      return { ...r0, text: r0.text + e.text, extW: along + ew, rectW: 0 } as EntBase;
    }
    return null;
  }

  // ---------------------------------------------------------------- entities
  drawEnt(e: EntBase, ctx: Ctx) {
    if (e.invisible) return;
    const k = e.kind;
    if (STRUCTURAL.has(k) || k === 'ATTRIB') return;
    this.curLw = undefined;
    const l = this.layerOf(e, ctx);
    // frozen layers are not drawn at all (an INSERT on a frozen layer hides the whole block)
    if (l && l.frozen) { this.frozenSkipped++; return; }
    const lname = l ? l.name : '0';
    const color = this.colorOf(e.color, l, ctx);
    const m = ctx.m;
    switch (k) {
      case 'LINE': {
        this.line([e.p0[0], e.p0[1], e.p1[0], e.p1[1]], m, color, lname, this.dashOf(e, l, ctx, m), this.widthOf(e, l, ctx));
        return;
      }
      case 'POINT': return this.point(e.p[0], e.p[1], m, color, lname);
      case 'CIRCLE': case 'ARC': {
        const om = mul(m, ocsMatrix(e.ext, e.c[2]));
        const a0 = k === 'CIRCLE' ? 0 : e.a0, a1 = k === 'CIRCLE' ? Math.PI * 2 : e.a1;
        this.arc(e.c[0], e.c[1], e.r, a0, a1, om, color, lname, this.dashOf(e, l, ctx, om), this.widthOf(e, l, ctx));
        return;
      }
      case 'ELLIPSE': {
        const n = e.ext, M = e.major;
        let mn = [n[1] * M[2] - n[2] * M[1], n[2] * M[0] - n[0] * M[2], n[0] * M[1] - n[1] * M[0]];
        const nl = Math.hypot(n[0], n[1], n[2]) || 1;
        mn = mn.map((v) => v / nl * e.ratio);
        let a0 = e.a0, a1 = e.a1;
        while (a1 <= a0) a1 += Math.PI * 2;
        if (a1 - a0 > Math.PI * 2) a1 = a0 + Math.PI * 2;
        const steps = Math.max(8, Math.min(720, Math.ceil((a1 - a0) / (Math.PI / 60))));
        const pts: number[] = [];
        for (let i = 0; i <= steps; i++) {
          const t = a0 + (a1 - a0) * i / steps;
          pts.push(e.c[0] + Math.cos(t) * M[0] + Math.sin(t) * mn[0], e.c[1] + Math.cos(t) * M[1] + Math.sin(t) * mn[1]);
        }
        this.line(pts, m, color, lname, this.dashOf(e, l, ctx, m), this.widthOf(e, l, ctx));
        return;
      }
      case 'SOLID': case 'TRACE': {
        const om = mul(m, ocsMatrix(e.ext, e.elev));
        const p = e.pts;
        const pts = [p[0][0], p[0][1], p[1][0], p[1][1], p[3][0], p[3][1], p[2][0], p[2][1]];
        this.fill(pts, om, color, lname);
        return;
      }
      case '3DFACE': {
        const p = e.pts;
        this.line([p[0][0], p[0][1], p[1][0], p[1][1], p[2][0], p[2][1], p[3][0], p[3][1], p[0][0], p[0][1]], m, color, lname, undefined, this.widthOf(e, l, ctx));
        return;
      }
      case 'TEXT': case 'ATTDEF': {
        if (k === 'ATTDEF') {
          // ATTDEF: shown with its tag outside blocks; inside an INSERT only constant attributes are visible
          if (ctx.inBlock) { if (!(e.flags & 2)) return; }
          if (e.flags & 1) return;
          return this.drawText(e, ctx, l, lname, color, ctx.inBlock ? e.text : e.tag);
        }
        return this.drawText(e, ctx, l, lname, color, e.text);
      }
      case 'MTEXT': {
        const om = m;
        const rot = Math.atan2(e.xdir[1], e.xdir[0]);
        this.drawMText(e.text, e.ins[0], e.ins[1], e.height, rot, e.attach, e.rectW, e.lsFactor || 1, om, color, lname, this.fontOf(e.style));
        return;
      }
      case 'INSERT': case 'MINSERT': return this.drawInsert(e, ctx, l, color);
      case 'LWPOLYLINE': {
        const om = mul(m, ocsMatrix(e.ext, e.elev));
        const n = e.pts.length / 2;
        if (n < 1) return;
        const pts: number[] = [e.pts[0], e.pts[1]];
        const segs = e.closed ? n : n - 1;
        for (let i = 0; i < segs; i++) {
          const j = (i + 1) % n;
          bulgePts(e.pts[i * 2], e.pts[i * 2 + 1], e.pts[j * 2], e.pts[j * 2 + 1], e.bulges[i] || 0, pts);
        }
        let w = this.widthOf(e, l, ctx);
        let gw = e.cw || 0;
        if (!gw && e.widths) { let s = 0; for (let i = 0; i < e.widths.length; i++) s += e.widths[i]; gw = s / e.widths.length; }
        if (gw > 0) w = Math.max(w || 0, gw * mscale(om));
        if (n === 1) return this.point(e.pts[0], e.pts[1], om, color, lname);
        this.lineW(pts, om, color, lname, this.dashOf(e, l, ctx, om), w, gw > 0);
        return;
      }
      case 'POLYLINE_2D': case 'POLYLINE_3D': {
        const verts = this.vertices(e);
        if (!verts.length) return;
        const is2d = k === 'POLYLINE_2D';
        const om = is2d ? mul(m, ocsMatrix(e.ext, e.elev)) : m;
        const vs = verts.filter((v) => !(v.flags & 16));
        if (!vs.length) return;
        const closed = (e.flags & 1) !== 0;
        const pts: number[] = [vs[0].p[0], vs[0].p[1]];
        const n = vs.length;
        for (let i = 0; i < (closed ? n : n - 1); i++) {
          const a = vs[i], b = vs[(i + 1) % n];
          bulgePts(a.p[0], a.p[1], b.p[0], b.p[1], is2d ? (a.bulge || 0) : 0, pts);
        }
        let w = this.widthOf(e, l, ctx);
        const gw = is2d ? Math.max(e.sw || 0, vs[0].sw || 0) : 0;
        if (gw > 0) w = Math.max(w || 0, gw * mscale(om));
        if (pts.length < 4) return this.point(pts[0], pts[1], om, color, lname);
        this.lineW(pts, om, color, lname, this.dashOf(e, l, ctx, om), w, gw > 0);
        return;
      }
      case 'POLYLINE_PFACE': {
        const verts = this.vertices(e);
        const pos = verts.filter((v) => v.kind === 'VERTEX_PFACE');
        const faces = verts.filter((v) => v.kind === 'VERTEX_PFACE_FACE');
        for (const f of faces) {
          const idx = f.idx.filter((i: number) => i !== 0);
          for (let i = 0; i < idx.length; i++) {
            const a = idx[i], b = idx[(i + 1) % idx.length];
            if (a < 0) continue;
            const pa = pos[Math.abs(a) - 1], pb = pos[Math.abs(b) - 1];
            if (pa && pb) this.line([pa.p[0], pa.p[1], pb.p[0], pb.p[1]], m, color, lname);
          }
        }
        return;
      }
      case 'POLYLINE_MESH': {
        const verts = this.vertices(e).filter((v) => v.kind === 'VERTEX_MESH');
        const M = e.m, N = e.n;
        if (M * N !== verts.length || M < 1 || N < 1) return;
        for (let i = 0; i < M; i++) {
          const pts: number[] = [];
          for (let j = 0; j < N; j++) pts.push(verts[i * N + j].p[0], verts[i * N + j].p[1]);
          if (e.flags & 32) pts.push(pts[0], pts[1]);
          this.line(pts, m, color, lname);
        }
        for (let j = 0; j < N; j++) {
          const pts: number[] = [];
          for (let i = 0; i < M; i++) pts.push(verts[i * N + j].p[0], verts[i * N + j].p[1]);
          if (e.flags & 1) pts.push(pts[0], pts[1]);
          this.line(pts, m, color, lname);
        }
        return;
      }
      case 'SPLINE': {
        const pts: number[] = [];
        if (e.ctrl && e.ctrl.length >= 6) bspline(e.degree, e.knots || [], e.ctrl, 3, e.weights, pts);
        else if (e.fit && e.fit.length >= 6) catmull(Array.from(e.fit), 3, pts);
        this.line(pts, m, color, lname, this.dashOf(e, l, ctx, m), this.widthOf(e, l, ctx));
        return;
      }
      case 'DIMENSION_ORDINATE': case 'DIMENSION_LINEAR': case 'DIMENSION_ALIGNED': case 'DIMENSION_ANG3PT':
      case 'DIMENSION_ANG2LN': case 'DIMENSION_RADIUS': case 'DIMENSION_DIAMETER': case 'ARC_DIMENSION': case 'LARGE_RADIAL_DIMENSION': {
        if (!e.block || !this.doc.blocks.has(e.block)) { this.warnings.add('dimension without block skipped'); return; }
        // pre-R13 files: the block is drawn shifted by the dimension's point 12 (sample finding)
        const dm = e.blockOffset ? mul(m, [1, 0, 0, 1, e.blockOffset[0], e.blockOffset[1]]) : m;
        const sub: Ctx = { ...ctx, m: dm, color, layer: l, inBlock: true, depth: ctx.depth + 1 };
        this.drawBlock(e.block, sub);
        return;
      }
      case 'LEADER': {
        if (!e.pts || e.pts.length < 2) return;
        const pts: number[] = [];
        for (const p of e.pts) pts.push(p[0], p[1]);
        let draw = pts;
        if (e.pathType === 1 && e.pts.length > 2) { draw = []; catmull(pts, 2, draw); }
        this.line(draw, m, color, lname, this.dashOf(e, l, ctx, m), this.widthOf(e, l, ctx));
        if (e.arrow) this.arrow(pts[2], pts[3], pts[0], pts[1], this.arrowSize(), m, color, lname);
        return;
      }
      case 'MLEADER': case 'MULTILEADER': {
        const as = this.arrowSize();
        for (const ln of e.lines || []) {
          if (ln.length < 2) continue;
          const pts: number[] = [];
          for (const p of ln) pts.push(p[0], p[1]);
          this.line(pts, m, color, lname);
          this.arrow(pts[2], pts[3], pts[0], pts[1], as, m, color, lname);
        }
        if (e.hasText && e.text) {
          const rot = e.textDir ? Math.atan2(e.textDir[1], e.textDir[0]) : 0;
          const tc = e.textColor && (e.textColor.index !== 256 || e.textColor.rgb !== null) ? this.colorOf(e.textColor, l, ctx) : color;
          this.drawMText(e.text, e.textLoc[0], e.textLoc[1], e.textHeight || this.doc.hv.dimtxt, rot, e.textAttach || 1, e.textW || 0, 1, m, tc, lname, this.fontOf(e.textStyle));
        } else if (e.hasBlock && e.contentBlock && this.doc.blocks.has(e.contentBlock)) {
          const b = this.doc.blocks.get(e.contentBlock)!;
          const s = e.blockScale || [1, 1, 1];
          const c = Math.cos(e.blockRot || 0), sn = Math.sin(e.blockRot || 0);
          let bm: M2 = [c * s[0], sn * s[0], -sn * s[1], c * s[1], e.blockLoc[0], e.blockLoc[1]];
          bm = mul(bm, [1, 0, 0, 1, -b.base[0], -b.base[1]]);
          this.drawBlock(e.contentBlock, { ...ctx, m: mul(m, bm), color, layer: l, inBlock: true, depth: ctx.depth + 1 });
        }
        return;
      }
      case 'HATCH': return this.drawHatch(e, ctx, l, lname, color);
      case 'VIEWPORT': return; // handled by the layout renderer
      default:
        if (e.graphics) return this.drawProxy(e, ctx, l, lname, color);
        return;
    }
  }

  drawProxy(e: EntBase, ctx: Ctx, l: Layer | null, lname: string, color: string) {
    let prims = this.proxyCache.get(e.handle);
    if (!prims) { prims = parseProxyGraphics(e.graphics, this.doc.ver, this.decoder); this.proxyCache.set(e.handle, prims); }
    const m = ctx.m;
    for (const p of prims) {
      let c = color;
      if (p.rgb !== null) c = paperColor(p.rgb);
      else if (p.aci > 0 && p.aci < 256) c = paperColor(ACI[p.aci]);
      else if (p.aci === 0) c = ctx.color;
      if (p.t === 'line') this.line(p.pts!, m, c, lname);
      // a WIPEOUT masks what lies below it: its filled area is paper white (sample finding: R13 proxies fill it)
      else if (p.t === 'fill') this.fill(p.pts!, m, e.kind === 'WIPEOUT' ? '#ffffff' : c, lname);
      else if (p.t === 'arc') this.arc(p.cx!, p.cy!, p.r!, p.a0!, p.a1!, m, c, lname);
      else if (p.t === 'text') this.text(p.x!, p.y!, cleanText(p.text || ''), p.h || this.doc.hv.textsize, p.rot || 0, 'left', m, c, lname);
    }
    void l;
  }
  proxyCache = new Map<number, ReturnType<typeof parseProxyGraphics>>();
  frozenSkipped = 0;
  patternSegs = 0;
  patternFallback = 0;
  get decoder(): TextDecoder { return this.doc.decoder; }

  arrowSize(): number { const hv = this.doc.hv; const s = (hv.dimasz || 2.5) * (hv.dimscale || 1); return s > 0 ? s : 2.5; }
  arrow(fx: number, fy: number, tx: number, ty: number, size: number, m: M2, color: string, layer: string) {
    const dx = tx - fx, dy = ty - fy, d = Math.hypot(dx, dy);
    if (!(d > 0) || !(size > 0)) return;
    const ux = dx / d, uy = dy / d;
    const bx = tx - ux * size, by = ty - uy * size, w = size / 6;
    this.fill([tx, ty, bx - uy * w, by + ux * w, bx + uy * w, by - ux * w], m, color, layer);
  }
  point(x: number, y: number, m: M2, color: string, layer: string) {
    const hv = this.doc.hv;
    const mode = hv.pdmode | 0;
    let size = hv.pdsize > 0 ? hv.pdsize : this.refSize * 0.005 * (hv.pdsize < 0 ? -hv.pdsize / 5 : 1);
    if (!(size > 0)) size = 1;
    const base = mode & 7, h = size / 2;
    if (base === 1 && !(mode & 96)) return;
    if (base === 0) {
      const r = Math.max(size * 0.05, this.refSize * 1e-4);
      this.fill([x - r, y - r, x + r, y - r, x + r, y + r, x - r, y + r], m, color, layer);
    } else if (base === 2) { this.line([x - h, y, x + h, y], m, color, layer); this.line([x, y - h, x, y + h], m, color, layer); }
    else if (base === 3) { this.line([x - h, y - h, x + h, y + h], m, color, layer); this.line([x - h, y + h, x + h, y - h], m, color, layer); }
    else if (base === 4) { this.line([x, y, x, y + h], m, color, layer); }
    if (mode & 32) this.arc(x, y, h, 0, Math.PI * 2, m, color, layer);
    if (mode & 64) this.line([x - h, y - h, x + h, y - h, x + h, y + h, x - h, y + h, x - h, y - h], m, color, layer);
  }
  // polyline with an optional geometric width: wide segments are drawn as stroke width
  lineW(pts: number[], m: M2, color: string, layer: string, dash: number[] | undefined, w: number | undefined, _geom: boolean) {
    this.line(pts, m, color, layer, dash, w);
  }
  vertices(e: EntBase): EntBase[] {
    // children of a polyline: vertex objects in handle order, decoded on demand
    const d = this.doc;
    const ch = d.children.get(e.handle) || [];
    const out: EntBase[] = [];
    for (const i of ch) {
      if (!d.typeName(i).startsWith('VERTEX')) continue;
      const v = d.entAt(i);
      if (v) out.push(v);
    }
    return out;
  }
  fontOf(styleHandle: number | undefined): string | undefined {
    if (!styleHandle) return undefined;
    const s = this.doc.styles.get(styleHandle);
    if (!s) return undefined;
    return fontName(s.font);
  }

  drawText(e: EntBase, ctx: Ctx, l: Layer | null, lname: string, color: string, str: string) {
    const om = mul(ctx.m, ocsMatrix(e.ext, e.elev || 0));
    let h = e.height;
    const st = this.doc.styles.get(e.style);
    if (!(h > 0) && st && st.fixedH > 0) h = st.fixedH;
    if (!(h > 0)) h = this.doc.hv.textsize || 2.5;
    let x = e.ins[0], y = e.ins[1], rot = e.rot || 0;
    let align: 'left' | 'center' | 'right' = 'left';
    const ha = e.halign | 0, va = e.valign | 0;
    if ((ha !== 0 || va !== 0) && e.align) {
      x = e.align[0]; y = e.align[1];
      if (ha === 3 || ha === 5) {
        x = (e.ins[0] + e.align[0]) / 2; y = (e.ins[1] + e.align[1]) / 2;
        rot = Math.atan2(e.align[1] - e.ins[1], e.align[0] - e.ins[0]);
        align = 'center';
      } else if (ha === 4) { align = 'center'; }
      else if (ha === 1) align = 'center';
      else if (ha === 2) align = 'right';
    }
    let dy = 0;
    if (ha === 4) dy = -h / 2;
    else if (va === 2) dy = -h / 2;
    else if (va === 3) dy = -h;
    else if (va === 1) dy = h * 0.25;
    if (dy) { x += -Math.sin(rot) * dy; y += Math.cos(rot) * dy; }
    const s = cleanText(str);
    void l;
    this.text(x, y, s, h, rot, align, om, color, lname, st ? fontName(st.font) : undefined);
  }

  drawMText(raw: string, x: number, y: number, h: number, rot: number, attach: number, width: number, lsf: number, m: M2, color: string, layer: string, font?: string) {
    if (!raw) return;
    if (!(h > 0)) h = this.doc.hv.textsize || 2.5;
    const parsed = parseMText(raw);
    const f = parsed.font || font;
    let lines: string[] = [];
    for (const para of parsed.text.split('\n')) {
      if (width > 0) lines.push(...wrap(para, width, h));
      else lines.push(para);
    }
    while (lines.length > 1 && lines[lines.length - 1].trim() === '') lines.pop();
    if (lines.length > 2000) lines = lines.slice(0, 2000);
    const lh = h * (5 / 3) * (lsf > 0 ? lsf : 1);
    const n = lines.length;
    const a = attach >= 1 && attach <= 9 ? attach : 1;
    const row = Math.floor((a - 1) / 3), col = (a - 1) % 3;
    const align: 'left' | 'center' | 'right' = col === 0 ? 'left' : col === 1 ? 'center' : 'right';
    const totalH = (n - 1) * lh + h;
    let first: number;
    if (row === 0) first = -h;
    else if (row === 1) first = totalH / 2 - h;
    else first = (n - 1) * lh;
    const c = Math.cos(rot), s = Math.sin(rot);
    for (let i = 0; i < n; i++) {
      const t = lines[i];
      if (!t.trim()) continue;
      const ly = first - i * lh;
      this.text(x - s * ly, y + c * ly, t, h, rot, align, m, color, layer, f);
    }
  }

  drawInsert(e: EntBase, ctx: Ctx, l: Layer | null, color: string) {
    const b = this.doc.blocks.get(e.block);
    const lname = l ? l.name : '0';
    const om = mul(ctx.m, ocsMatrix(e.ext, 0));
    if (b && !b.isXref) {
      const sc = e.scale || [1, 1, 1];
      const c = Math.cos(e.rot || 0), s = Math.sin(e.rot || 0);
      const cols = e.kind === 'MINSERT' ? Math.max(1, Math.min(e.cols || 1, 1000)) : 1;
      const rows = e.kind === 'MINSERT' ? Math.max(1, Math.min(e.rows || 1, 1000)) : 1;
      let lt = e.ltype;
      if (lt === 0) lt = l ? l.ltype : 0;
      else if (lt === -1) lt = ctx.ltype;
      for (let r = 0; r < rows && !this.stopped; r++) {
        for (let q = 0; q < cols && !this.stopped; q++) {
          const ox = q * (e.colSp || 0), oy = r * (e.rowSp || 0);
          // T(ins) R(rot) T(grid) S(scale) T(-base)
          let bm: M2 = [c, s, -s, c, e.ins[0], e.ins[1]];
          bm = mul(bm, [1, 0, 0, 1, ox, oy]);
          bm = mul(bm, [sc[0], 0, 0, sc[1], 0, 0]);
          bm = mul(bm, [1, 0, 0, 1, -b.base[0], -b.base[1]]);
          const sub: Ctx = { m: mul(om, bm), color, layer: l, ltype: lt, depth: ctx.depth + 1, inBlock: true, paper: ctx.paper };
          this.drawBlock(e.block, sub);
        }
      }
    } else if (b && b.isXref) this.warnings.add('external references (xref) are not loaded');
    // attributes: stored in the coordinate system of the insert's parent
    const d = this.doc;
    let atts: number[] = [];
    if (e.attribs && e.attribs.length) { for (const h of e.attribs) atts.push(d.indexOf(h)); }
    else if (e.hasAttribs) atts = d.children.get(e.handle) || [];
    for (const i of atts) {
      if (i < 0 || d.typeName(i) !== 'ATTRIB') continue;
      const a = d.entAt(i);
      if (!a || a.kind !== 'ATTRIB' || a.invisible || (a.flags & 1)) continue;
      const al = this.layerOf(a, ctx);
      const acol = this.colorOf(a.color, al, { ...ctx, color });
      if (a.mtext && a.mtext.text) {
        const mt = a.mtext;
        this.drawMText(mt.text, mt.ins[0], mt.ins[1], mt.height, Math.atan2(mt.xdir[1], mt.xdir[0]), mt.attach, mt.rectW, mt.lsFactor || 1, ctx.m, acol, al ? al.name : lname);
      } else this.drawText(a, ctx, al, al ? al.name : lname, acol, a.text);
    }
  }

  // ---------------------------------------------------------------- hatch
  hatchLoops(e: EntBase): number[][] {
    const loops: number[][] = [];
    for (const p of e.paths || []) {
      const pts: number[] = [];
      if (p.poly) {
        const n = p.poly.pts.length / 2;
        if (n < 2) continue;
        pts.push(p.poly.pts[0], p.poly.pts[1]);
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          if (j === 0 && !p.poly.closed && i === n - 1) { /* implicit close anyway for fills */ }
          bulgePts(p.poly.pts[i * 2], p.poly.pts[i * 2 + 1], p.poly.pts[j * 2], p.poly.pts[j * 2 + 1], p.poly.bul[i] || 0, pts);
        }
      } else {
        const parts: number[][] = [];
        for (const s of p.segs) {
          const seg: number[] = [];
          if (s.t === 1) seg.push(s.p0[0], s.p0[1], s.p1[0], s.p1[1]);
          else if (s.t === 2) {
            if (s.ccw) arcPts(s.c[0], s.c[1], s.r, s.a0, s.a1, seg);
            else { const tmp: number[] = []; arcPts(s.c[0], s.c[1], s.r, -s.a1, -s.a0, tmp); for (let i = tmp.length - 2; i >= 0; i -= 2) seg.push(tmp[i], tmp[i + 1]); }
          } else if (s.t === 3) {
            const mx = s.major[0], my = s.major[1], ratio = s.ratio;
            const nx = -my * ratio, ny = mx * ratio;
            let a0 = s.a0, a1 = s.a1;
            if (!s.ccw) { a0 = -s.a0; a1 = -s.a1; }
            let sweep = s.ccw ? a1 - a0 : a0 - a1;
            while (sweep <= 0) sweep += Math.PI * 2;
            const n = Math.max(8, Math.ceil(sweep / (Math.PI / 60)));
            for (let i = 0; i <= n; i++) {
              const t = s.ccw ? a0 + sweep * i / n : a0 - sweep * i / n;
              seg.push(s.c[0] + Math.cos(t) * mx + Math.sin(t) * nx, s.c[1] + Math.cos(t) * my + Math.sin(t) * ny);
            }
          } else if (s.t === 4) {
            if (s.ctrl && s.ctrl.length >= 6) bspline(s.deg, s.knots, s.ctrl, 3, s.weights, seg);
            else if (s.fit && s.fit.length >= 4) catmull(s.fit, 2, seg);
          }
          if (seg.length >= 4) parts.push(seg);
        }
        chainParts(parts, pts);
      }
      if (pts.length >= 6) loops.push(pts);
    }
    return loops;
  }

  drawHatch(e: EntBase, ctx: Ctx, l: Layer | null, lname: string, color: string) {
    const om = mul(ctx.m, ocsMatrix(e.ext, e.z || 0));
    const loops = this.hatchLoops(e);
    if (!loops.length) return;
    let fillColor = color;
    if (e.gradient && e.gradColors && e.gradColors.length) fillColor = paperColor(e.gradColors[0]);
    // group loops into outer boundaries with holes (even/odd nesting)
    const info = loops.map((p) => ({ p, a: Math.abs(polyArea(p)), depth: 0, parent: -1 }));
    const order = info.map((_, i) => i).sort((a, b) => info[b].a - info[a].a);
    for (let oi = 0; oi < order.length; oi++) {
      const i = order[oi];
      const me = info[i];
      for (let oj = oi - 1; oj >= 0; oj--) {
        const j = order[oj];
        if (pointInPoly(me.p[0], me.p[1], info[j].p)) { me.parent = j; me.depth = info[j].depth + 1; break; }
      }
    }
    const polys: number[][] = [];
    for (const i of order) {
      const me = info[i];
      if (me.depth % 2 === 1 && me.parent >= 0) continue;
      const ring = me.p.slice();
      for (const j of order) {
        const h = info[j];
        if (h.parent === i && h.depth % 2 === 1) {
          // keyhole: bridge from the ring start to the hole and back
          ring.push(ring[0], ring[1], ...h.p, h.p[0], h.p[1], ring[0], ring[1]);
        }
      }
      polys.push(ring);
    }
    if (e.solid || e.gradient) {
      for (const p of polys) this.fill(p, om, fillColor, lname);
      return;
    }
    // pattern hatch: generate pattern lines clipped by the boundary (even-odd)
    const ok = this.patternLines(e, loops, om, color, lname);
    if (!ok) for (const p of polys) this.fill(p, om, color, lname, 0.25);
    void l;
  }

  patternLines(e: EntBase, loops: number[][], om: M2, color: string, lname: string): boolean {
    if (!e.lines || !e.lines.length) return false;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of loops) for (let i = 0; i < p.length; i += 2) { x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]); y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]); }
    const diag = Math.hypot(x1 - x0, y1 - y0);
    if (!(diag > 0)) return false;
    // estimate the number of lines first
    let est = 0;
    for (const dl of e.lines) {
      const ux = Math.cos(dl.ang), uy = Math.sin(dl.ang);
      const step = Math.abs(-uy * dl.off[0] + ux * dl.off[1]);
      if (!(step > diag * 1e-4)) return false;
      est += diag / step;
    }
    if (est > 3000 || this.patternSegs > MAX_PATTERN_SEGS) { this.patternFallback++; return false; }
    const segs: number[][] = [];
    const edges: number[] = [];
    for (const p of loops) {
      const n = p.length / 2;
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; edges.push(p[i * 2], p[i * 2 + 1], p[j * 2], p[j * 2 + 1]); }
    }
    for (const dl of e.lines) {
      const ux = Math.cos(dl.ang), uy = Math.sin(dl.ang);
      const nx = -uy, ny = ux;
      const step = -uy * dl.off[0] + ux * dl.off[1];
      const shift = ux * dl.off[0] + uy * dl.off[1]; // dash phase shift per line
      const bn = nx * dl.base[0] + ny * dl.base[1];
      // range of normal offsets covered by the bbox
      const cs = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => nx * x + ny * y);
      const nmin = Math.min(...cs), nmax = Math.max(...cs);
      const kmin = Math.ceil((nmin - bn) / step), kmax = Math.floor((nmax - bn) / step);
      const k0 = Math.min(kmin, kmax), k1 = Math.max(kmin, kmax);
      let pat: number[] = dl.dashes || [];
      let plen = 0; for (const d of pat) plen += Math.abs(d);
      if (!(plen > diag * 1e-5)) pat = [];
      for (let k = k0; k <= k1; k++) {
        const ox = dl.base[0] + k * dl.off[0], oy = dl.base[1] + k * dl.off[1];
        // intersections of the line ox + t*u with edges
        const ts: number[] = [];
        for (let i = 0; i < edges.length; i += 4) {
          const ax = edges[i], ay = edges[i + 1], bx = edges[i + 2], by = edges[i + 3];
          const da = nx * (ax - ox) + ny * (ay - oy), db = nx * (bx - ox) + ny * (by - oy);
          if ((da > 0) === (db > 0)) continue;
          const t = da / (da - db);
          const px = ax + (bx - ax) * t, py = ay + (by - ay) * t;
          ts.push(ux * (px - ox) + uy * (py - oy));
        }
        if (ts.length < 2) continue;
        ts.sort((a, b) => a - b);
        for (let i = 0; i + 1 < ts.length; i += 2) {
          const ta = ts[i], tb = ts[i + 1];
          if (!pat.length) { segs.push([ox + ux * ta, oy + uy * ta, ox + ux * tb, oy + uy * tb]); continue; }
          // dashes: the pattern starts at the line origin, shifted by k * shift for line k
          const phase0 = k * shift;
          const rel = ((ta - phase0) % plen + plen) % plen;
          let idx = 0, acc = 0;
          while (idx < pat.length - 1 && acc + Math.abs(pat[idx]) <= rel) { acc += Math.abs(pat[idx]); idx++; }
          let remaining = Math.abs(pat[idx]) - (rel - acc);
          let t = ta;
          let guard = 0;
          while (t < tb && guard++ < 100000) {
            const d = pat[idx];
            const te = Math.min(tb, t + Math.max(0, remaining));
            if (d > 0 && te > t) segs.push([ox + ux * t, oy + uy * t, ox + ux * te, oy + uy * te]);
            else if (d === 0) segs.push([ox + ux * t, oy + uy * t, ox + ux * (t + diag * 5e-4), oy + uy * (t + diag * 5e-4)]);
            t = te;
            idx = (idx + 1) % pat.length;
            remaining = Math.abs(pat[idx]);
          }
          if (segs.length > 60000) return false;
        }
      }
    }
    this.patternSegs += segs.length;
    for (const s of segs) this.line(s, om, color, lname);
    return true;
  }
}

// join boundary edges into one loop: greedy nearest end matching (edges may be stored in any order or direction)
function chainParts(parts: number[][], out: number[]) {
  if (!parts.length) return;
  const used = new Uint8Array(parts.length);
  const first = parts[0];
  used[0] = 1;
  for (const v of first) out.push(v);
  const greedy = parts.length <= 3000;
  for (let k = 1; k < parts.length; k++) {
    const ex = out[out.length - 2], ey = out[out.length - 1];
    let best = -1, bestD = Infinity, rev = false;
    if (greedy) {
      for (let i = 0; i < parts.length; i++) {
        if (used[i]) continue;
        const s = parts[i];
        const d0 = Math.hypot(s[0] - ex, s[1] - ey), d1 = Math.hypot(s[s.length - 2] - ex, s[s.length - 1] - ey);
        if (d0 < bestD) { bestD = d0; best = i; rev = false; }
        if (d1 < bestD) { bestD = d1; best = i; rev = true; }
        if (bestD === 0) break;
      }
    } else {
      best = k; const s = parts[k];
      rev = Math.hypot(s[s.length - 2] - ex, s[s.length - 1] - ey) < Math.hypot(s[0] - ex, s[1] - ey);
    }
    if (best < 0) break;
    used[best] = 1;
    const s = parts[best];
    const seq: number[] = [];
    if (rev) { for (let i = s.length - 2; i >= 0; i -= 2) seq.push(s[i], s[i + 1]); } else seq.push(...s);
    const skip = Math.hypot(seq[0] - ex, seq[1] - ey) <= 1e-9 * (1 + Math.abs(ex) + Math.abs(ey)) ? 2 : 0;
    for (let i = skip; i < seq.length; i++) out.push(seq[i]);
  }
}

const TEXT_EM = 1.4; // CAD text height is close to the cap height; em size is about 1.4 times larger

function normAng(a: number): number {
  a = a % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function fontName(f: string | undefined): string | undefined {
  if (!f) return undefined;
  const base = f.replace(/^.*[\\/]/, '');
  if (/\.shx$/i.test(base) || !base) return undefined;
  const n = base.replace(/\.(ttf|ttc|otf)$/i, '');
  const known: Record<string, string> = { arial: 'Arial', arialn: 'Arial Narrow', times: 'Times New Roman', cour: 'Courier New', calibri: 'Calibri', verdana: 'Verdana', tahoma: 'Tahoma', isocpeur: 'ISOCPEUR', simsun: 'SimSun', 'malgun': 'Malgun Gothic' };
  return known[n.toLowerCase()] || n;
}

// TEXT control codes (%%c etc.)
export function cleanText(s: string): string {
  if (!s) return '';
  return s.replace(/%%(\d{3})/g, (_, d) => String.fromCharCode(+d))
    .replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±')
    .replace(/%%[uUoOkK]/g, '').replace(/%%%/g, '%')
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// MTEXT inline codes: returns plain text with \n for paragraph breaks and the first font found
export function parseMText(s: string): { text: string; font?: string } {
  let out = '';
  let font: string | undefined;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{' || ch === '}') continue;
    if (ch !== '\\') { out += ch; continue; }
    const c = s[i + 1];
    if (c === undefined) break;
    i++;
    switch (c) {
      case 'P': out += '\n'; break;
      case 'X': out += '\n'; break;
      case '~': out += ' '; break;
      case '\\': case '{': case '}': out += c; break;
      case 'U': {
        const m = /^\+([0-9A-Fa-f]{4})/.exec(s.slice(i + 1));
        if (m) { out += String.fromCharCode(parseInt(m[1], 16)); i += 5; } else out += 'U';
        break;
      }
      case 'M': { const m = /^\+([0-9A-Fa-f]{5})/.exec(s.slice(i + 1)); if (m) i += 6; break; }
      case 'L': case 'l': case 'O': case 'o': case 'K': case 'k': break;
      case 'S': {
        const end = s.indexOf(';', i + 1);
        if (end < 0) break;
        const body = s.slice(i + 1, end).replace(/\\(.)/g, '$1');
        const m = /^(.*?)[\^/#](.*)$/.exec(body);
        out += m ? (m[2].trim() ? m[1].trim() + '/' + m[2].trim() : m[1].trim()) : body;
        i = end;
        break;
      }
      case 'f': case 'F': {
        const end = s.indexOf(';', i + 1);
        if (end < 0) break;
        if (!font) { const nm = s.slice(i + 1, end).split('|')[0]; const f = fontName(nm); if (f) font = f; }
        i = end;
        break;
      }
      case 'A': case 'C': case 'c': case 'H': case 'h': case 'Q': case 'q': case 'T': case 't': case 'W': case 'w': case 'p': {
        const end = s.indexOf(';', i + 1);
        if (end >= 0) i = end;
        break;
      }
      case 'N': out += '\n'; break;
      default: out += c;
    }
  }
  return { text: cleanText(out), font };
}

function wrap(para: string, width: number, h: number): string[] {
  const cw = (c: string) => (c.charCodeAt(0) >= 0x2e80 ? 1.0 : 0.6) * h;
  let w = 0;
  for (const c of para) w += cw(c);
  if (w <= width * 1.05) return [para];
  const words = para.split(/(\s+)/);
  const lines: string[] = [];
  let cur = '', cwid = 0;
  for (const wd of words) {
    let ww = 0; for (const c of wd) ww += cw(c);
    if (cwid + ww > width * 1.05 && cur.trim()) { lines.push(cur.trimEnd()); cur = wd.trimStart(); cwid = 0; for (const c of cur) cwid += cw(c); }
    else { cur += wd; cwid += ww; }
  }
  if (cur.trim()) lines.push(cur);
  return lines;
}

// ---------------------------------------------------------------- sheets
export function itemBounds(items: SheetItem[], all = false): [number, number, number, number] | null {
  const xs: number[] = [], ys: number[] = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (!all && xs.length < 400000) { xs.push(x); ys.push(y); }
  };
  for (const it of items) {
    if (it.kind === 'line' || it.kind === 'fill') { const p = it.pts; for (let i = 0; i < p.length; i += 2) add(p[i], p[i + 1]); }
    else if (it.kind === 'arc') { add(it.cx - it.r, it.cy - it.r); add(it.cx + it.r, it.cy + it.r); }
    else if (it.kind === 'text') {
      // approximate text box: 0.55 em per character, cap height 0.7 em
      const w = Math.min(it.text.length, 200) * 0.62 * it.size, hgt = 0.7 * it.size;
      const c = Math.cos(it.rot || 0), sn = Math.sin(it.rot || 0);
      const off = it.align === 'center' ? -w / 2 : it.align === 'right' ? -w : 0;
      for (const [u, v] of [[off, 0], [off + w, 0], [off, hgt], [off + w, hgt]]) add(it.x + c * u - sn * v, it.y + sn * u + c * v);
    }
  }
  if (!(x1 >= x0)) return null;
  if (all || xs.length < 50) return [x0, y0, x1, y1];
  // robust extents: ignore far away stray objects
  const sx = Float64Array.from(xs).sort(), sy = Float64Array.from(ys).sort();
  const q = (a: Float64Array, f: number) => a[Math.min(a.length - 1, Math.max(0, Math.floor(a.length * f)))];
  const qx0 = q(sx, 0.002), qx1 = q(sx, 0.998), qy0 = q(sy, 0.002), qy1 = q(sy, 0.998);
  const w = Math.max(qx1 - qx0, qy1 - qy0, 1e-9);
  const fx0 = Math.max(x0, qx0 - w * 0.5), fx1 = Math.min(x1, qx1 + w * 0.5);
  const fy0 = Math.max(y0, qy0 - w * 0.5), fy1 = Math.min(y1, qy1 + w * 0.5);
  return [fx0, fy0, fx1, fy1];
}

export function mapItems(items: SheetItem[], f: (x: number, y: number) => [number, number], s: number, rot: number, mirror = false): SheetItem[] {
  const out: SheetItem[] = [];
  for (const it of items) {
    if (it.kind === 'line' || it.kind === 'fill') {
      const p = new Array(it.pts.length);
      for (let i = 0; i < p.length; i += 2) { const q = f(it.pts[i], it.pts[i + 1]); p[i] = q[0]; p[i + 1] = q[1]; }
      const n: any = { ...it, pts: p };
      if (it.kind === 'line' && it.dash) n.dash = it.dash.map((d) => d * s);
      if (it.kind === 'line' && it.w) n.w = it.w * s;
      out.push(n);
    } else if (it.kind === 'arc') {
      const c = f(it.cx, it.cy);
      let a0 = it.a0 + rot, a1 = it.a1 + rot;
      if (mirror) { const t = a0; a0 = -a1; a1 = -t; }
      const n: any = { ...it, cx: c[0], cy: c[1], r: it.r * s, a0, a1 };
      if (it.w) n.w = it.w * s;
      out.push(n);
    } else if (it.kind === 'text') {
      const c = f(it.x, it.y);
      const n: any = { ...it, x: c[0], y: c[1], size: it.size * s };
      if (rot) n.rot = normAng((it.rot || 0) + rot);
      out.push(n);
    } else out.push(it);
  }
  return out;
}

// same as mapItems but rewrites the items themselves (no copies)
export function mapItemsInPlace(items: SheetItem[], f: (x: number, y: number) => [number, number], s: number): SheetItem[] {
  for (const it of items) {
    if (it.kind === 'line' || it.kind === 'fill') {
      const p = it.pts;
      for (let i = 0; i < p.length; i += 2) { const q = f(p[i], p[i + 1]); p[i] = q[0]; p[i + 1] = q[1]; }
      if (it.kind === 'line') { if (it.dash) it.dash = it.dash.map((d) => d * s); if (it.w) it.w *= s; }
    } else if (it.kind === 'arc') {
      const c = f(it.cx, it.cy); it.cx = c[0]; it.cy = c[1]; it.r *= s; if (it.w) it.w *= s;
    } else if (it.kind === 'text') {
      const c = f(it.x, it.y); it.x = c[0]; it.y = c[1]; it.size *= s;
    }
  }
  return items;
}

export function scaleWidths(items: SheetItem[], s: number) {
  for (const it of items) if ((it.kind === 'line' || it.kind === 'arc') && it.w) it.w *= s;
}

export function clipItems(items: SheetItem[], box: [number, number, number, number], frozen: Set<string> | null): SheetItem[] {
  const [x0, y0, x1, y1] = box;
  const out: SheetItem[] = [];
  for (const it of items) {
    if (frozen && it.layer && frozen.has(it.layer)) continue;
    if (it.kind === 'line') {
      let ix0 = Infinity, iy0 = Infinity, ix1 = -Infinity, iy1 = -Infinity;
      const p = it.pts;
      for (let i = 0; i < p.length; i += 2) { if (p[i] < ix0) ix0 = p[i]; if (p[i] > ix1) ix1 = p[i]; if (p[i + 1] < iy0) iy0 = p[i + 1]; if (p[i + 1] > iy1) iy1 = p[i + 1]; }
      if (ix1 < x0 || ix0 > x1 || iy1 < y0 || iy0 > y1) continue;
      if (ix0 >= x0 && ix1 <= x1 && iy0 >= y0 && iy1 <= y1) { out.push(it); continue; }
      for (const part of clipPolyline(p, x0, y0, x1, y1)) if (part.length >= 4) out.push({ ...it, pts: part });
    } else if (it.kind === 'fill') {
      const p = clipPolygon(it.pts, x0, y0, x1, y1);
      if (p.length >= 6) out.push({ ...it, pts: p });
    } else if (it.kind === 'arc') {
      if (it.cx + it.r < x0 || it.cx - it.r > x1 || it.cy + it.r < y0 || it.cy - it.r > y1) continue;
      if (it.cx - it.r >= x0 && it.cx + it.r <= x1 && it.cy - it.r >= y0 && it.cy + it.r <= y1) { out.push(it); continue; }
      const pts: number[] = [];
      arcPts(it.cx, it.cy, it.r, it.a0, it.a1 - it.a0 >= Math.PI * 2 - 1e-9 ? it.a0 + Math.PI * 2 : it.a1, pts);
      for (const part of clipPolyline(pts, x0, y0, x1, y1)) if (part.length >= 4) {
        const n: any = { kind: 'line', pts: part, color: it.color, layer: it.layer };
        if (it.w) n.w = it.w;
        out.push(n);
      }
    } else if (it.kind === 'text') {
      if (it.x >= x0 && it.x <= x1 && it.y >= y0 && it.y <= y1) out.push(it);
    } else out.push(it);
  }
  return out;
}

export function unitToMm(insunits: number): number { return UNIT_MM[insunits] ?? 1; }

export function makeLayers(doc: Doc): DwgLayer[] {
  const r = new Renderer(doc);
  const out: DwgLayer[] = [];
  for (const l of doc.layers.values()) {
    out.push({ name: l.name, color: r.layerColor(l), visible: l.on && !l.frozen, frozen: l.frozen, locked: l.locked });
  }
  out.sort((a, b) => (a.name === '0' ? -1 : b.name === '0' ? 1 : a.name.localeCompare(b.name)));
  return out;
}

export function newCtx(paper: boolean): Ctx {
  return { m: IDENT, color: '#000000', layer: null, ltype: 0, depth: 0, inBlock: false, paper };
}
export type { Ctx };
export type { SheetViewport, RvtSheet2D };
