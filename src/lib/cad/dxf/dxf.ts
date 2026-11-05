// DXF engine: ASCII and binary DXF to RvtSheet2D (model space + one sheet per paper space layout),
// or RvtGeometry when the drawing is mostly 3D faces / meshes.
// Clean-room implementation from the Autodesk DXF Reference (help.autodesk.com / AutoCAD 2014 DXF Reference PDF).

import { aciHex, trueColorHex } from './aci.ts';
import {
  type M3, type Rect, arcSegs, bulgePoints, clipItems, itemsBounds, m3Apply, m3FromAxes, m3Identity, m3Mul, m3RotZ, m3Scale,
  m3Translate, ocsMatrix, ringsToPolygons, saneItem, scaleItems, similarity, cross, norm,
} from './geom.ts';
import { type BlockDef, type DxfDoc, type Ent, type LayoutDef, type Tokens, g, hdrNum, hdrStr, int, num, parseDoc, sniffDxf as sniffDxfBytes, splitEntities, str, tokenize } from './dxfparse.ts';
import { mtextHeightOverride, mtextLines, plainText, textWidth, wrapLine } from './dxftext.ts';
import { CadError, type CadInfo, type CadResult, type GeomBucket, type GeomElement, type LayerInfo, type Progress, type RvtGeometry, type RvtSheet2D, type SheetItem, type SheetViewport } from './types.ts';

export { sniffDxfBytes as sniffDxf };

export interface DxfOptions {
  /** max items per sheet before the drawing is cut (default 3,000,000) */
  maxItems?: number;
  /** 'auto' (default): 3D result when the drawing is mostly faces/meshes; '2d': always sheets */
  mode?: 'auto' | '2d';
  /** render the model inside paper space viewports (default true) */
  viewports?: boolean;
}

const VERSIONS: Record<string, string> = {
  AC1006: 'R10', AC1009: 'R11/R12', AC1012: 'R13', AC1014: 'R14', AC1015: 'AutoCAD 2000', AC1018: 'AutoCAD 2004',
  AC1021: 'AutoCAD 2007', AC1024: 'AutoCAD 2010', AC1027: 'AutoCAD 2013', AC1032: 'AutoCAD 2018',
};

// $INSUNITS to millimetres
const UNIT_MM: Record<number, number> = {
  1: 25.4, 2: 304.8, 3: 1609344, 4: 1, 5: 10, 6: 1000, 7: 1e6, 8: 2.54e-5, 9: 0.0254, 10: 914.4, 11: 1e-7, 12: 1e-6,
  13: 1e-3, 14: 100, 15: 1e4, 16: 1e5, 17: 1e12, 18: 1.495978707e14, 19: 9.4607e18, 20: 3.0857e19, 21: 304.8006096,
  22: 25.4000508, 23: 914.4018288, 24: 1609347.2187,
};
const UNIT_NAME: Record<number, string> = {
  0: 'unitless', 1: 'inches', 2: 'feet', 3: 'miles', 4: 'millimeters', 5: 'centimeters', 6: 'meters', 7: 'kilometers',
  8: 'microinches', 9: 'mils', 10: 'yards', 11: 'angstroms', 12: 'nanometers', 13: 'microns', 14: 'decimeters',
  15: 'decameters', 16: 'hectometers', 17: 'gigameters', 18: 'astronomical units', 19: 'light years', 20: 'parsecs',
  21: 'US survey feet', 22: 'US survey inch', 23: 'US survey yard', 24: 'US survey mile',
};

interface Style { color: string; w?: number; wu?: number; dash?: number[]; layer: string }
interface Ctx {
  m: M3;
  layer: string;      // inherited layer for entities on layer 0 inside blocks
  color: string;      // BYBLOCK colour
  lw: number | undefined; // BYBLOCK lineweight, mm
  ltype: string;      // BYBLOCK linetype
  depth: number;
  stack: string[];
  out: SheetItem[];
}
interface Common {
  layer: string; color: number; tc: number | null; lw: number; ltype: string; lts: number; invisible: boolean;
  space: number; handle: string; ext: [number, number, number];
}

// scratch for first-occurrence group values of the current entity
const RAW: Array<string | number | undefined> = new Array(1100);
const STAMP = new Int32Array(1100);
let stampNo = 0;

class Bucket3 {
  pos: number[] = []; nrm: number[] = []; idx: number[] = []; edges: number[] = [];
  ranges: Array<{ elementId: number; start: number; count: number }> = [];
  layer: string;
  color: [number, number, number];
  constructor(layer: string, color: [number, number, number]) { this.layer = layer; this.color = color; }
}

class Collector3D {
  buckets = new Map<string, Bucket3>();
  elements = new Map<number, GeomElement>();
  faces = 0;
  faceElems = new Set<number>();
  bucketFor(layer: string, color: string): Bucket3 {
    const key = layer + '\u0000' + color;
    let b = this.buckets.get(key);
    if (!b) {
      const r = parseInt(color.slice(1, 3), 16) / 255, gg = parseInt(color.slice(3, 5), 16) / 255, bl = parseInt(color.slice(5, 7), 16) / 255;
      // black (ACI 7 on a white sheet) reads badly in 3D: use a neutral grey
      const c: [number, number, number] = r + gg + bl < 0.05 ? [0.62, 0.64, 0.68] : [r, gg, bl];
      b = new Bucket3(layer, c);
      this.buckets.set(key, b);
    }
    return b;
  }
  element(id: number, cls: string, layer: string, name: string | null, typeName: string | null) {
    if (!this.elements.has(id)) {
      this.elements.set(id, { id, category: null, categoryName: layer, className: cls, name, typeName, familyName: null, levelId: null, levelName: null, bbox: null });
    }
  }
  /** polygon face (3 or 4 WCS points, flat array) */
  face(b: Bucket3, el: number, p: number[]) {
    const n = p.length / 3;
    if (n < 3) return;
    // normal (Newell)
    let nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      nx += (p[i * 3 + 1] - p[j * 3 + 1]) * (p[i * 3 + 2] + p[j * 3 + 2]);
      ny += (p[i * 3 + 2] - p[j * 3 + 2]) * (p[i * 3] + p[j * 3]);
      nz += (p[i * 3] - p[j * 3]) * (p[i * 3 + 1] + p[j * 3 + 1]);
    }
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-20) return;
    nx /= l; ny /= l; nz /= l;
    const base = b.pos.length / 3;
    for (let i = 0; i < n; i++) { b.pos.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]); b.nrm.push(nx, ny, nz); }
    const start = b.idx.length;
    for (let i = 1; i + 1 < n; i++) b.idx.push(base, base + i, base + i + 1);
    const cnt = b.idx.length - start;
    const last = b.ranges[b.ranges.length - 1];
    if (last && last.elementId === el && last.start + last.count === start) last.count += cnt;
    else b.ranges.push({ elementId: el, start, count: cnt });
    this.faces++;
    this.faceElems.add(el);
    this.growBox(el, p);
  }
  edge(b: Bucket3, el: number, p: number[]) {
    for (let i = 0; i + 5 < p.length; i += 3) b.edges.push(p[i], p[i + 1], p[i + 2], p[i + 3], p[i + 4], p[i + 5]);
    this.growBox(el, p);
  }
  growBox(el: number, p: number[]) {
    const e = this.elements.get(el);
    if (!e) return;
    if (!e.bbox) e.bbox = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    const bb = e.bbox;
    for (let i = 0; i + 2 < p.length; i += 3) for (let k = 0; k < 3; k++) {
      if (p[i + k] < bb.min[k]) bb.min[k] = p[i + k];
      if (p[i + k] > bb.max[k]) bb.max[k] = p[i + k];
    }
  }
}

class Renderer {
  doc: DxfDoc;
  t: Tokens;
  tol = 0;              // chord tolerance in target units
  ltscale: number;
  pdmode: number;
  pdsize: number;
  asz: number;
  textSize: number;
  extH = 0;
  unsupported = new Map<string, number>();
  warnings: string[] = [];
  maxItems: number;
  truncated = false;
  col3d: Collector3D | null = null;
  elementId = 0;
  hatchBudget = 600000;
  xlines: Array<{ x: number; y: number; dx: number; dy: number; ray: boolean; st: Style }> = [];
  frozenFilter: Set<string> | null = null;
  layerItems = new Map<string, number>();
  counts = new Map<string, number>();
  topLevel = true;

  constructor(doc: DxfDoc, maxItems: number) {
    this.doc = doc;
    this.t = doc.t;
    this.ltscale = hdrNum(doc, '$LTSCALE', 40, 1) || 1;
    this.pdmode = hdrNum(doc, '$PDMODE', 70, 0);
    this.pdsize = hdrNum(doc, '$PDSIZE', 40, 0);
    const dimscale = hdrNum(doc, '$DIMSCALE', 40, 1) || 1;
    this.asz = (hdrNum(doc, '$DIMASZ', 40, 2.5) || 2.5) * dimscale;
    this.textSize = hdrNum(doc, '$TEXTSIZE', 40, 2.5) || 2.5;
    this.maxItems = maxItems;
  }

  skip(type: string, why?: string) {
    const k = why ? `${type} (${why})` : type;
    this.unsupported.set(k, (this.unsupported.get(k) ?? 0) + 1);
  }

  // ------------------------------------------------------------ entity fields

  load(ent: Ent) {
    stampNo++;
    const t = this.t;
    let inGroup = false;
    for (let i = ent.s + 1; i < ent.e; i++) {
      const c = t.codes[i];
      if (c === 102) { const v = t.vals[i]; inGroup = typeof v === 'string' && v.trim().startsWith('{'); continue; }
      if (inGroup) continue;
      if (c >= 1000 || c < 0) break;
      if (STAMP[c] !== stampNo) { STAMP[c] = stampNo; RAW[c] = t.vals[i]; }
    }
  }
  has(c: number) { return STAMP[c] === stampNo; }
  n(c: number, def = 0): number { if (STAMP[c] !== stampNo) return def; const v = num(RAW[c]); return Number.isFinite(v) ? v : def; }
  s(c: number): string { return STAMP[c] === stampNo ? str(RAW[c]) : ''; }
  sraw(c: number): string { if (STAMP[c] !== stampNo) return ''; const v = RAW[c]; return typeof v === 'string' ? v.replace(/\r$/, '') : String(v); }

  common(): Common {
    return {
      layer: this.has(8) ? this.s(8) : '0',
      color: this.has(62) ? Math.trunc(this.n(62)) : 256,
      tc: this.has(420) ? Math.trunc(this.n(420)) : null,
      lw: this.has(370) ? Math.trunc(this.n(370)) : -1,
      ltype: this.has(6) ? this.s(6) : 'BYLAYER',
      lts: this.has(48) ? this.n(48, 1) || 1 : 1,
      invisible: this.has(60) && this.n(60) === 1,
      space: this.n(67, 0),
      handle: this.s(5),
      ext: [this.n(210, 0), this.n(220, 0), this.n(230, 1)],
    };
  }

  layerColor(name: string): string {
    const l = this.doc.layers.get(name);
    if (!l) return '#000000';
    return l.trueColor != null ? trueColorHex(l.trueColor) : aciHex(l.color);
  }

  style(c: Common, ctx: Ctx, m: M3): Style {
    const layer = c.layer === '0' && ctx.depth > 0 ? ctx.layer : c.layer;
    const L = this.doc.layers.get(layer);
    let color: string;
    if (c.tc != null && c.tc >= 0) color = trueColorHex(c.tc);
    else if (c.color === 0) color = ctx.color;
    else if (c.color === 256 || c.color < 0 || c.color > 256) color = this.layerColor(layer);
    else color = aciHex(c.color);
    let lw: number | undefined;
    const raw = c.lw === -1 ? (L ? L.lw : -3) : c.lw;
    if (raw === -2) lw = ctx.lw;
    else if (raw >= 0) lw = raw / 100;
    let lt = c.ltype.toUpperCase();
    if (lt === 'BYLAYER') lt = (L?.ltype ?? 'CONTINUOUS').toUpperCase();
    if (lt === 'BYBLOCK') lt = ctx.ltype.toUpperCase();
    const st: Style = { color, layer };
    if (lw !== undefined) st.w = lw;
    const d = this.dash(lt, c.lts, m);
    if (d) st.dash = d;
    return st;
  }

  dash(name: string, lts: number, m: M3): number[] | undefined {
    if (!name || name === 'CONTINUOUS' || name === 'BYLAYER' || name === 'BYBLOCK') return undefined;
    const def = this.doc.ltypes.get(name);
    if (!def || def.dashes.length < 2 || !(def.total > 0)) return undefined;
    const ms = Math.sqrt(Math.abs(m[0] * m[4] - m[1] * m[3])) || 1;
    const sc = this.ltscale * lts * ms * this.ltViewScale;
    const period = def.total * sc;
    if (!(period > this.tol * 4)) return undefined;
    const dot = Math.max(period * 0.01, this.tol * 0.5);
    const seq: number[] = [];
    let wantDash = true;
    const push = (len: number, isDash: boolean) => {
      if (seq.length && isDash !== wantDash) { seq[seq.length - 1] += len; return; }
      seq.push(len);
      wantDash = !isDash;
    };
    const els = def.dashes.map((d) => (d === 0 ? { l: dot, dash: true } : { l: Math.abs(d) * sc, dash: d > 0 }));
    // start with a dash
    let k = els.findIndex((e) => e.dash);
    if (k < 0) return undefined;
    for (let i = 0; i < els.length; i++) {
      const e = els[(k + i) % els.length];
      if (!seq.length && !e.dash) continue;
      if (seq.length === 0) { seq.push(e.l); wantDash = false; continue; }
      push(e.l, e.dash);
    }
    if (seq.length % 2 === 1) seq.push(0.0001 * period);
    return seq.map((v) => +v.toPrecision(6));
  }

  // ------------------------------------------------------------ output

  push(ctx: Ctx, it: SheetItem) {
    if (this.frozenFilter && it.layer && this.frozenFilter.has(it.layer)) return;
    if (ctx.out.length >= this.maxItems) { this.truncated = true; return; }
    if (!saneItem(it)) return;
    ctx.out.push(it);
    if (this.topLevel && it.layer) this.layerItems.set(it.layer, (this.layerItems.get(it.layer) ?? 0) + 1);
  }

  /** local points (x,y,z triples) -> projected line */
  line3(ctx: Ctx, m: M3, p: number[], st: Style, closed = false) {
    const n = p.length / 3;
    if (n < 2) return;
    const pts: number[] = new Array((n + (closed ? 1 : 0)) * 2);
    for (let i = 0; i < n; i++) {
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      pts[i * 2] = m[0] * x + m[3] * y + m[6] * z + m[9];
      pts[i * 2 + 1] = m[1] * x + m[4] * y + m[7] * z + m[10];
    }
    if (closed) { pts[n * 2] = pts[0]; pts[n * 2 + 1] = pts[1]; }
    for (let i = 0; i < pts.length; i++) if (!Number.isFinite(pts[i])) return;
    const it: SheetItem = { kind: 'line', pts, color: st.color, layer: st.layer };
    if (st.w !== undefined) it.w = st.w;
    if (st.wu !== undefined) (it as { wu?: number }).wu = st.wu;
    if (st.dash) it.dash = st.dash;
    this.push(ctx, it);
  }
  /** local 2D points at elevation z */
  line2(ctx: Ctx, m: M3, p: number[], z: number, st: Style, closed = false) {
    const n = p.length / 2;
    if (n < 2) return;
    const pts: number[] = new Array((n + (closed ? 1 : 0)) * 2);
    const zx = m[6] * z + m[9], zy = m[7] * z + m[10];
    for (let i = 0; i < n; i++) {
      const x = p[i * 2], y = p[i * 2 + 1];
      pts[i * 2] = m[0] * x + m[3] * y + zx;
      pts[i * 2 + 1] = m[1] * x + m[4] * y + zy;
    }
    if (closed) { pts[n * 2] = pts[0]; pts[n * 2 + 1] = pts[1]; }
    for (let i = 0; i < pts.length; i++) if (!Number.isFinite(pts[i])) return;
    const it: SheetItem = { kind: 'line', pts, color: st.color, layer: st.layer };
    if (st.w !== undefined) it.w = st.w;
    if (st.wu !== undefined) (it as { wu?: number }).wu = st.wu;
    if (st.dash) it.dash = st.dash;
    this.push(ctx, it);
  }
  fill2(ctx: Ctx, m: M3, rings: number[][], z: number, color: string, layer: string, opacity?: number) {
    const zx = m[6] * z + m[9], zy = m[7] * z + m[10];
    const tr = rings.map((p) => {
      const o: number[] = new Array(p.length);
      for (let i = 0; i < p.length; i += 2) { o[i] = m[0] * p[i] + m[3] * p[i + 1] + zx; o[i + 1] = m[1] * p[i] + m[4] * p[i + 1] + zy; }
      return o;
    }).filter((p) => p.every(Number.isFinite));
    for (const poly of ringsToPolygons(tr)) {
      const it: SheetItem = { kind: 'fill', pts: poly, color, layer };
      if (opacity !== undefined) it.opacity = opacity;
      this.push(ctx, it);
    }
  }
  /** circle / arc in local plane (angles radians, CCW) */
  arc(ctx: Ctx, m: M3, cx: number, cy: number, z: number, r: number, a0: number, a1: number, st: Style, full: boolean) {
    if (!(r > 0) || !Number.isFinite(r)) return;
    const sim = similarity(m);
    if (sim && !st.dash) {
      const [x, y] = m3Apply(m, cx, cy, z);
      let b0: number, b1: number;
      if (full) { b0 = 0; b1 = Math.PI * 2; }
      else if (sim.mirror) { b0 = sim.rot - a1; b1 = sim.rot - a0; }
      else { b0 = a0 + sim.rot; b1 = a1 + sim.rot; }
      const it: SheetItem = { kind: 'arc', cx: x, cy: y, r: r * sim.s, a0: b0, a1: b1, color: st.color, layer: st.layer };
      if (st.w !== undefined) it.w = st.w;
      this.push(ctx, it);
      return;
    }
    let sweep = full ? Math.PI * 2 : a1 - a0;
    if (!Number.isFinite(sweep) || Math.abs(sweep) > 1e6) sweep = Math.PI * 2;
    if (!full) { while (sweep <= 0) sweep += Math.PI * 2; }
    const ms = Math.sqrt(Math.abs(m[0] * m[4] - m[1] * m[3])) || 1;
    const nseg = arcSegs(sweep, r * ms, this.tol);
    const p: number[] = [];
    for (let i = 0; i <= nseg; i++) { const a = a0 + (sweep * i) / nseg; p.push(cx + r * Math.cos(a), cy + r * Math.sin(a)); }
    this.line2(ctx, m, p, z, st);
  }

  text(ctx: Ctx, m: M3, x: number, y: number, z: number, h: number, rot: number, s: string, st: Style, align: 'left' | 'center' | 'right', font?: string) {
    if (!s || !(h > 0)) return;
    const [px, py] = m3Apply(m, x, y, z);
    // direction and up vectors of the text in the target plane
    const dx = Math.cos(rot), dy = Math.sin(rot);
    const vx = m[0] * dx + m[3] * dy, vy = m[1] * dx + m[4] * dy;
    const ux = m[0] * -dy + m[3] * dx, uy = m[1] * -dy + m[4] * dx;
    const size = Math.hypot(ux, uy) * h;
    if (!(size > 0) || !Number.isFinite(px) || !Number.isFinite(py)) return;
    const mirror = vx * uy - vy * ux < 0;
    let r: number;
    let al = align;
    if (mirror) {
      // keep text readable: follow the up vector and flip the alignment side
      r = Math.atan2(uy, ux) - Math.PI / 2;
      al = align === 'left' ? 'right' : align === 'right' ? 'left' : 'center';
    } else r = Math.atan2(vy, vx);
    const it: SheetItem = { kind: 'text', x: px, y: py, text: s, size: size * 1.4, color: st.color, layer: st.layer };
    if (Math.abs(r) > 1e-9) it.rot = r;
    if (al !== 'left') it.align = al;
    if (font) it.font = font;
    this.push(ctx, it);
  }

  fontFor(styleName: string): { font?: string; height: number } {
    const sd = this.doc.styles.get((styleName || 'STANDARD').toUpperCase());
    if (!sd) return { height: 0 };
    let font: string | undefined = sd.family ?? undefined;
    if (!font && /\.(ttf|otf|ttc)$/i.test(sd.font)) font = sd.font.replace(/^.*[\\/]/, '').replace(/\.(ttf|otf|ttc)$/i, '');
    return { font, height: sd.height };
  }

  // ------------------------------------------------------------ dispatch

  countOn = true;
  ltViewScale = 1; // paper space linetype scaling inside viewports ($PSLTSCALE)
  entity(e: Ent, ctx: Ctx) {
    if (this.countOn) this.counts.set(e.type, (this.counts.get(e.type) ?? 0) + 1);
    try {
      switch (e.type) {
        case 'LINE': return this.eLine(e, ctx);
        case 'XLINE': case 'RAY': return this.eXline(e, ctx);
        case 'CIRCLE': return this.eCircle(e, ctx, false);
        case 'ARC': return this.eCircle(e, ctx, true);
        case 'ELLIPSE': return this.eEllipse(e, ctx);
        case 'LWPOLYLINE': return this.eLwpoly(e, ctx);
        case 'POLYLINE': return this.ePolyline(e, ctx);
        case 'SPLINE': case 'HELIX': return this.eSpline(e, ctx);
        case 'TEXT': return this.eText(e, ctx, false);
        case 'ATTDEF': return this.eAttdef(e, ctx);
        case 'MTEXT': return this.eMtext(e, ctx);
        case 'INSERT': return this.eInsert(e, ctx);
        case 'DIMENSION': case 'ARC_DIMENSION': case 'LARGE_RADIAL_DIMENSION': return this.eDimension(e, ctx);
        case 'ACAD_TABLE': return this.eTable(e, ctx);
        case 'HATCH': case 'MPOLYGON': return this.eHatch(e, ctx);
        case 'SOLID': case 'TRACE': return this.eSolid(e, ctx);
        case '3DFACE': return this.e3dface(e, ctx);
        case 'POINT': return this.ePoint(e, ctx);
        case 'LEADER': return this.eLeader(e, ctx);
        case 'MULTILEADER': case 'MLEADER': return this.eMleader(e, ctx);
        case 'MLINE': return this.eMline(e, ctx);
        case 'MESH': return this.eMesh(e, ctx);
        case 'WIPEOUT': return this.eWipeout(e, ctx);
        case 'IMAGE': return this.eImage(e, ctx);
        case 'VIEWPORT': case 'SEQEND': case 'ENDBLK': case 'ATTRIB': case 'VERTEX': return;
        case '3DSOLID': case 'REGION': case 'BODY': case 'SURFACE': case 'PLANESURFACE': case 'EXTRUDEDSURFACE': case 'LOFTEDSURFACE': case 'REVOLVEDSURFACE': case 'SWEPTSURFACE': case 'NURBSURFACE':
          return this.skip(e.type, 'ACIS solid data, not decoded');
        default: return this.skip(e.type);
      }
    } catch (err) {
      this.skip(e.type, 'error: ' + String((err as Error)?.message ?? err).slice(0, 60));
    }
  }

  begin(e: Ent, ctx: Ctx): { c: Common; m: M3 } | null {
    this.load(e);
    const c = this.common();
    if (c.invisible) return null;
    let m = ctx.m;
    if (c.ext[0] !== 0 || c.ext[1] !== 0 || c.ext[2] !== 1) {
      const o = ocsMatrix(c.ext[0], c.ext[1], c.ext[2]);
      if (o) m = m3Mul(ctx.m, o);
    }
    return { c, m };
  }

  eLine(e: Ent, ctx: Ctx) {
    this.load(e);
    const c = this.common();
    if (c.invisible) return;
    const p = [this.n(10), this.n(20), this.n(30), this.n(11), this.n(21), this.n(31)];
    // LINE points are in WCS; thickness / extrusion only matter for 3D
    const st = this.style(c, ctx, ctx.m);
    this.line3(ctx, ctx.m, p, st);
    if (this.col3d && (p[2] !== 0 || p[5] !== 0)) this.edge3(ctx, c, st, p);
  }

  eXline(e: Ent, ctx: Ctx) {
    this.load(e);
    const c = this.common();
    if (c.invisible) return;
    const st = this.style(c, ctx, ctx.m);
    const [x, y] = m3Apply(ctx.m, this.n(10), this.n(20), this.n(30));
    const [x2, y2] = m3Apply(ctx.m, this.n(10) + this.n(11), this.n(20) + this.n(21), this.n(30) + this.n(31));
    const dx = x2 - x, dy = y2 - y;
    if (Math.hypot(dx, dy) < 1e-12) return;
    this.xlines.push({ x, y, dx, dy, ray: e.type === 'RAY', st: { ...st } });
  }

  eCircle(e: Ent, ctx: Ctx, isArc: boolean) {
    const b = this.begin(e, ctx);
    if (!b) return;
    const st = this.style(b.c, ctx, b.m);
    const r = this.n(40);
    const D = Math.PI / 180;
    const a0 = isArc ? this.n(50) * D : 0, a1 = isArc ? this.n(51) * D : Math.PI * 2;
    this.arc(ctx, b.m, this.n(10), this.n(20), this.n(30), r, a0, a1, st, !isArc);
  }

  eEllipse(e: Ent, ctx: Ctx) {
    this.load(e);
    const c = this.common();
    if (c.invisible) return;
    const cx = this.n(10), cy = this.n(20), cz = this.n(30);
    const mx = this.n(11), my = this.n(21), mz = this.n(31);
    const ratio = this.n(40, 1);
    let t0 = this.n(41, 0), t1 = this.n(42, Math.PI * 2);
    const nrm = norm([c.ext[0], c.ext[1], c.ext[2]]);
    const minor = cross(nrm, [mx, my, mz]).map((v) => v * ratio);
    const st = this.style(c, ctx, ctx.m);
    let sweep = t1 - t0;
    if (!Number.isFinite(sweep) || Math.abs(sweep) > 1e6) sweep = Math.PI * 2;
    while (sweep <= 0) sweep += Math.PI * 2;
    if (Math.abs(sweep - Math.PI * 2) < 1e-9) sweep = Math.PI * 2;
    const maj = Math.hypot(mx, my, mz);
    const ms = Math.sqrt(Math.abs(ctx.m[0] * ctx.m[4] - ctx.m[1] * ctx.m[3])) || 1;
    const nseg = Math.min(720, arcSegs(sweep, maj * ms, this.tol) * (ratio < 0.3 ? 2 : 1));
    const p: number[] = [];
    for (let i = 0; i <= nseg; i++) {
      const t = t0 + (sweep * i) / nseg;
      const cs = Math.cos(t), sn = Math.sin(t);
      p.push(cx + mx * cs + minor[0] * sn, cy + my * cs + minor[1] * sn, cz + mz * cs + minor[2] * sn);
    }
    this.line3(ctx, ctx.m, p, st);
  }

  eLwpoly(e: Ent, ctx: Ctx) {
    const b = this.begin(e, ctx);
    if (!b) return;
    const t = this.t;
    const flags = this.n(70, 0);
    const elev = this.n(38, 0);
    const cw = this.n(43, 0);
    const xs: number[] = [], ys: number[] = [], bs: number[] = [], w0: number[] = [], w1: number[] = [];
    let inGroup = false;
    for (let i = e.s + 1; i < e.e; i++) {
      const code = t.codes[i];
      if (code === 102) { inGroup = str(t.vals[i]).startsWith('{'); continue; }
      if (inGroup) continue;
      if (code >= 1000) break;
      switch (code) {
        case 10: xs.push(num(t.vals[i])); ys.push(0); bs.push(0); w0.push(cw); w1.push(cw); break;
        case 20: if (ys.length) ys[ys.length - 1] = num(t.vals[i]); break;
        case 42: if (bs.length) bs[bs.length - 1] = num(t.vals[i]); break;
        case 40: if (w0.length) w0[w0.length - 1] = num(t.vals[i]); break;
        case 41: if (w1.length) w1[w1.length - 1] = num(t.vals[i]); break;
      }
    }
    this.polyOut(ctx, b.c, b.m, xs, ys, bs, w0, w1, (flags & 1) !== 1 ? false : true, elev, cw);
  }

  /** shared 2D polyline output with bulges and widths (OCS) */
  polyOut(ctx: Ctx, c: Common, m: M3, xs: number[], ys: number[], bs: number[], w0: number[], w1: number[], closed: boolean, elev: number, cw: number) {
    const n = xs.length;
    if (n === 0) return;
    const st = this.style(c, ctx, m);
    const ms = Math.sqrt(Math.abs(m[0] * m[4] - m[1] * m[3])) || 1;
    const localTol = this.tol / ms;
    const varying = w0.some((w, i) => w !== w1[i] || w !== w0[0]);
    if (n === 1) { this.line2(ctx, m, [xs[0], ys[0], xs[0], ys[0]], elev, st); return; }
    if (varying) {
      // filled segments for tapered widths (straight segments), arcs as average width strokes
      const segs = closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const j = (i + 1) % n;
        const a = w0[i], bw = w1[i];
        if (bs[i] === 0 && (a > 0 || bw > 0)) {
          const dx = xs[j] - xs[i], dy = ys[j] - ys[i];
          const l = Math.hypot(dx, dy) || 1;
          const nx = -dy / l, ny = dx / l;
          this.fill2(ctx, m, [[xs[i] + nx * a / 2, ys[i] + ny * a / 2, xs[j] + nx * bw / 2, ys[j] + ny * bw / 2, xs[j] - nx * bw / 2, ys[j] - ny * bw / 2, xs[i] - nx * a / 2, ys[i] - ny * a / 2]], elev, st.color, st.layer);
        } else {
          const p: number[] = [xs[i], ys[i]];
          bulgePoints(xs[i], ys[i], xs[j], ys[j], bs[i], localTol, p);
          const s2 = { ...st };
          const avg = (a + bw) / 2;
          if (avg > 0) s2.wu = avg * ms;
          this.line2(ctx, m, p, elev, s2);
        }
      }
      return;
    }
    const p: number[] = [xs[0], ys[0]];
    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      bulgePoints(xs[i], ys[i], xs[j], ys[j], bs[i], localTol, p);
    }
    const s2 = { ...st };
    const width = w0[0] || cw;
    if (width > 0) s2.wu = width * ms;
    this.line2(ctx, m, p, elev, s2);
  }

  ePolyline(e: Ent, ctx: Ctx) {
    const b = this.begin(e, ctx);
    if (!b) return;
    const flags = this.n(70, 0);
    const c = b.c;
    const elev = this.n(30, 0);
    const dw0 = this.n(40, 0), dw1 = this.n(41, 0);
    const mCount = this.n(71, 0), nCount = this.n(72, 0);
    const kids = e.kids ?? [];
    if (flags & 64) return this.polyface(e, ctx, c, kids);
    if (flags & 16) return this.polymesh(e, ctx, c, kids, flags, mCount, nCount);
    const is3d = (flags & 8) !== 0;
    const splineFit = (flags & 4) !== 0;
    const xs: number[] = [], ys: number[] = [], zs: number[] = [], bs: number[] = [], w0: number[] = [], w1: number[] = [];
    for (const k of kids) {
      this.load(k);
      const vf = this.n(70, 0);
      if (splineFit && (vf & 16)) continue; // spline frame control point
      xs.push(this.n(10)); ys.push(this.n(20)); zs.push(this.n(30));
      bs.push(is3d ? 0 : this.n(42, 0));
      w0.push(this.has(40) ? this.n(40) : dw0); w1.push(this.has(41) ? this.n(41) : dw1);
    }
    if (is3d) {
      const p: number[] = [];
      for (let i = 0; i < xs.length; i++) p.push(xs[i], ys[i], zs[i]);
      const st = this.style(c, ctx, ctx.m);
      this.line3(ctx, ctx.m, p, st, (flags & 1) !== 0);
      if (this.col3d) { if (flags & 1 && xs.length) p.push(xs[0], ys[0], zs[0]); this.edge3(ctx, c, st, p); }
      return;
    }
    this.polyOut(ctx, c, b.m, xs, ys, bs, w0, w1, (flags & 1) !== 0, elev, 0);
  }

  polyface(e: Ent, ctx: Ctx, c: Common, kids: Ent[]) {
    const verts: number[] = [];
    const faces: number[][] = [];
    for (const k of kids) {
      this.load(k);
      const vf = this.n(70, 0);
      if (vf & 64) verts.push(this.n(10), this.n(20), this.n(30));
      else if (vf & 128) {
        const f: number[] = [];
        for (const code of [71, 72, 73, 74]) { const v = Math.trunc(this.n(code, 0)); if (v !== 0) f.push(v); }
        if (f.length >= 3) faces.push(f);
      }
    }
    const st = this.style(c, ctx, ctx.m);
    const nv = verts.length / 3;
    const V = (i: number) => { const k = Math.abs(i) - 1; return k >= 0 && k < nv ? [verts[k * 3], verts[k * 3 + 1], verts[k * 3 + 2]] : null; };
    // visible edges (negative index = invisible edge starting at that vertex)
    const seen = new Set<string>();
    const edges: number[] = [];
    for (const f of faces) {
      for (let i = 0; i < f.length; i++) {
        const a = f[i], bb = f[(i + 1) % f.length];
        if (a < 0) continue;
        const key = Math.min(Math.abs(a), Math.abs(bb)) + ',' + Math.max(Math.abs(a), Math.abs(bb));
        if (seen.has(key)) continue;
        seen.add(key);
        const pa = V(a), pb = V(bb);
        if (pa && pb) edges.push(...pa, ...pb);
      }
    }
    this.segments3(ctx, edges, st);
    if (this.col3d) {
      const bk = this.bucket3(ctx, c, st);
      for (const f of faces) {
        const p: number[] = [];
        for (const i of f) { const v = V(i); if (v) p.push(...v); }
        this.col3d.face(bk, this.elementId, p);
      }
      this.col3d.edge(bk, this.elementId, edges);
    }
  }

  polymesh(e: Ent, ctx: Ctx, c: Common, kids: Ent[], flags: number, M: number, N: number) {
    const verts: number[] = [];
    for (const k of kids) { this.load(k); const vf = this.n(70, 0); if (vf & 16) continue; verts.push(this.n(10), this.n(20), this.n(30)); }
    const nv = verts.length / 3;
    if (M * N > nv) { M = Math.max(1, Math.floor(nv / Math.max(1, N))); }
    const st = this.style(c, ctx, ctx.m);
    const closeM = (flags & 1) !== 0, closeN = (flags & 32) !== 0;
    const P = (i: number, j: number) => { const k = (i % M) * N + (j % N); return [verts[k * 3], verts[k * 3 + 1], verts[k * 3 + 2]]; };
    const edges: number[] = [];
    const bk = this.col3d ? this.bucket3(ctx, c, st) : null;
    for (let i = 0; i < M; i++) for (let j = 0; j < N; j++) {
      const hasI = i + 1 < M || closeM, hasJ = j + 1 < N || closeN;
      if (hasJ) edges.push(...P(i, j), ...P(i, j + 1));
      if (hasI) edges.push(...P(i, j), ...P(i + 1, j));
      if (bk && hasI && hasJ) this.col3d!.face(bk, this.elementId, [...P(i, j), ...P(i, j + 1), ...P(i + 1, j + 1), ...P(i + 1, j)]);
    }
    this.segments3(ctx, edges, st);
    if (bk) this.col3d!.edge(bk, this.elementId, edges);
  }

  /** 3D segment pairs drawn as separate lines, joined when consecutive */
  segments3(ctx: Ctx, seg: number[], st: Style) {
    const m = ctx.m;
    let cur: number[] | null = null;
    let lx = NaN, ly = NaN, lz = NaN;
    const flush = () => { if (cur && cur.length >= 6) this.line3(ctx, m, cur, st); cur = null; };
    for (let i = 0; i + 5 < seg.length; i += 6) {
      if (cur && seg[i] === lx && seg[i + 1] === ly && seg[i + 2] === lz) cur.push(seg[i + 3], seg[i + 4], seg[i + 5]);
      else { flush(); cur = seg.slice(i, i + 6); }
      lx = seg[i + 3]; ly = seg[i + 4]; lz = seg[i + 5];
      if (cur!.length > 3000) { flush(); }
    }
    flush();
  }

  bucket3(ctx: Ctx, c: Common, st: Style) {
    const col = this.col3d!;
    col.element(this.elementId, this.curTopType, st.layer, this.curTopHandle || null, this.curTopBlock);
    return col.bucketFor(st.layer, st.color);
  }
  edge3(ctx: Ctx, c: Common, st: Style, p: number[]) {
    if (!this.col3d) return;
    const w = this.worldPts(ctx.m, p);
    this.col3d.edge(this.bucket3(ctx, c, st), this.elementId, w);
  }
  worldPts(m: M3, p: number[]): number[] {
    const o: number[] = new Array(p.length);
    for (let i = 0; i < p.length; i += 3) {
      const [x, y, z] = m3Apply(m, p[i], p[i + 1], p[i + 2]);
      o[i] = x; o[i + 1] = y; o[i + 2] = z;
    }
    return o;
  }
  curTopType = '';
  curTopHandle = '';
  curTopBlock: string | null = null;

  // ------------------------------------------------------------ splines

  eSpline(e: Ent, ctx: Ctx) {
    this.load(e);
    const c = this.common();
    if (c.invisible) return;
    const t = this.t;
    const deg = this.n(71, 3);
    const flags = this.n(70, 0);
    const knots: number[] = [], ctrl: number[] = [], w: number[] = [], fit: number[] = [];
    let inGroup = false;
    let last = 0;
    let sub = '';
    for (let i = e.s + 1; i < e.e; i++) {
      const code = t.codes[i];
      if (code === 102) { inGroup = str(t.vals[i]).startsWith('{'); continue; }
      if (inGroup) continue;
      if (code >= 1000) break;
      if (code === 100) { sub = str(t.vals[i]); continue; }
      if (sub === 'AcDbHelix') continue;
      const v = num(t.vals[i]);
      switch (code) {
        case 40: knots.push(v); break;
        case 41: w.push(v); break;
        case 10: ctrl.push(v, 0, 0); last = 10; break;
        case 20: if (last === 10) ctrl[ctrl.length - 2] = v; break;
        case 30: if (last === 10) ctrl[ctrl.length - 1] = v; break;
        case 11: fit.push(v, 0, 0); last = 11; break;
        case 21: if (last === 11) fit[fit.length - 2] = v; break;
        case 31: if (last === 11) fit[fit.length - 1] = v; break;
      }
    }
    const st = this.style(c, ctx, ctx.m);
    const ms = Math.sqrt(Math.abs(ctx.m[0] * ctx.m[4] - ctx.m[1] * ctx.m[3])) || 1;
    let pts: number[] | null = null;
    if (ctrl.length >= 6) pts = nurbs3(deg, knots, ctrl, w, this.tol / ms);
    if (!pts && fit.length >= 6) pts = catmull3(fit, (flags & 1) !== 0);
    if (!pts && ctrl.length >= 6) pts = ctrl;
    if (!pts) return;
    this.line3(ctx, ctx.m, pts, st);
  }

  // ------------------------------------------------------------ text

  eText(e: Ent, ctx: Ctx, isAttrib: boolean) {
    const b = this.begin(e, ctx);
    if (!b) return;
    if (isAttrib && (this.n(70, 0) & 1)) return; // invisible attribute
    const raw = this.sraw(1);
    const s = plainText(raw);
    const f = this.fontFor(this.s(7));
    const h = this.n(40, 0) || f.height || this.textSize;
    const rot = this.n(50, 0) * Math.PI / 180;
    const ha = this.n(72, 0);
    const va = isAttrib || e.type === 'ATTDEF' ? this.n(74, 0) : this.n(73, 0);
    const useAlign = (ha !== 0 || va !== 0) && this.has(11);
    let x = useAlign ? this.n(11) : this.n(10);
    let y = useAlign ? this.n(21) : this.n(20);
    const z = useAlign ? this.n(31) : this.n(30);
    let align: 'left' | 'center' | 'right' = 'left';
    let hh = h;
    if (ha === 1 || ha === 4) align = 'center';
    else if (ha === 2) align = 'right';
    else if ((ha === 3 || ha === 5) && this.has(11)) {
      // aligned / fit: centre between the two points along the baseline
      const x0 = this.n(10), y0 = this.n(20), x1 = this.n(11), y1 = this.n(21);
      x = (x0 + x1) / 2; y = (y0 + y1) / 2;
      align = 'center';
      const len = Math.hypot(x1 - x0, y1 - y0);
      if (ha === 3 && s.length) hh = Math.min(h || Infinity, len / Math.max(0.5, textWidth(s, 1)));
      const r2 = Math.atan2(y1 - y0, x1 - x0);
      return this.textAt(ctx, b, x, y, z, hh || h, r2, s, va, align, f.font);
    }
    if (ha === 4) return this.textAt(ctx, b, x, y, z, hh, rot, s, 2, align, f.font);
    this.textAt(ctx, b, x, y, z, hh, rot, s, va, align, f.font);
  }
  textAt(ctx: Ctx, b: { c: Common; m: M3 }, x: number, y: number, z: number, h: number, rot: number, s: string, va: number, align: 'left' | 'center' | 'right', font?: string) {
    // vertical alignment: shift along the local up vector to the baseline
    let dy = 0;
    if (va === 1) dy = h * 0.3; else if (va === 2) dy = -h / 2; else if (va === 3) dy = -h;
    const ux = -Math.sin(rot), uy = Math.cos(rot);
    const st = this.style(b.c, ctx, b.m);
    this.text(ctx, b.m, x + ux * dy, y + uy * dy, z, h, rot, s, st, align, font);
  }

  eAttdef(e: Ent, ctx: Ctx) {
    this.load(e);
    const flags = this.n(70, 0);
    // constant attribute definitions are shown in inserts; others only in the block editor
    if (ctx.depth > 0 && (flags & 2) && !(flags & 1)) this.eText(e, ctx, true);
  }

  eMtext(e: Ent, ctx: Ctx) {
    this.load(e);
    const c = this.common();
    if (c.invisible) return;
    const t = this.t;
    let raw = '';
    // contents: 3 chunks then 1
    let inGroup = false;
    let chunks = '';
    let last1 = '';
    for (let i = e.s + 1; i < e.e; i++) {
      const code = t.codes[i];
      if (code === 102) { inGroup = str(t.vals[i]).startsWith('{'); continue; }
      if (inGroup) continue;
      if (code >= 1000) break;
      if (code === 3) chunks += String(t.vals[i]).replace(/\r$/, '');
      else if (code === 1) { last1 = String(t.vals[i]).replace(/\r$/, ''); break; }
    }
    raw = chunks + last1;
    const f = this.fontFor(this.s(7));
    let h = this.n(40, 0) || f.height || this.textSize;
    h = mtextHeightOverride(raw, h);
    const width = this.n(41, 0);
    const att = this.n(71, 1) || 1;
    const spacing = (this.n(44, 1) || 1) * h * 5 / 3;
    const x = this.n(10), y = this.n(20), z = this.n(30);
    let dir: [number, number, number] | null = this.has(11) ? [this.n(11), this.n(21), this.n(31)] : null;
    const rot = this.n(50, 0);
    // MTEXT points and direction are WCS; build a local frame: origin at insertion, x = direction
    let m = ctx.m;
    const ext = c.ext;
    const o = ocsMatrix(ext[0], ext[1], ext[2]);
    let localRot = 0;
    if (dir && Math.hypot(dir[0], dir[1], dir[2]) > 1e-12) {
      // express the WCS direction in the OCS
      if (o) {
        const ax = [o[0], o[1], o[2]], ay = [o[3], o[4], o[5]];
        localRot = Math.atan2(dir[0] * ay[0] + dir[1] * ay[1] + dir[2] * ay[2], dir[0] * ax[0] + dir[1] * ax[1] + dir[2] * ax[2]);
      } else localRot = Math.atan2(dir[1], dir[0]);
    } else localRot = rot; // radians for MTEXT 50
    // insertion is WCS: convert to OCS coordinates
    let lx = x, ly = y, lz = z;
    if (o) {
      lx = x * o[0] + y * o[1] + z * o[2];
      ly = x * o[3] + y * o[4] + z * o[5];
      lz = x * o[6] + y * o[7] + z * o[8];
      m = m3Mul(ctx.m, o);
    }
    let lines = mtextLines(raw);
    if (width > 0) lines = lines.flatMap((l) => wrapLine(l, h, width));
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    if (!lines.length) return;
    const st = this.style(c, ctx, m);
    const col = (att - 1) % 3; // 0 left 1 centre 2 right
    const row = Math.floor((att - 1) / 3); // 0 top 1 middle 2 bottom
    const total = h + (lines.length - 1) * spacing;
    let firstBase: number;
    if (row === 0) firstBase = -h;
    else if (row === 1) firstBase = total / 2 - h;
    else firstBase = (lines.length - 1) * spacing;
    const align = col === 0 ? 'left' : col === 1 ? 'center' : 'right';
    const cs = Math.cos(localRot), sn = Math.sin(localRot);
    for (let i = 0; i < lines.length; i++) {
      const s = lines[i];
      if (!s.trim()) continue;
      const oy = firstBase - i * spacing;
      this.text(ctx, m, lx - sn * oy, ly + cs * oy, lz, h, localRot, s, st, align, f.font);
    }
  }

  // ------------------------------------------------------------ blocks

  blockCtx(ctx: Ctx, c: Common, m: M3, name: string): Ctx {
    const st = this.style(c, ctx, m);
    let lt = c.ltype.toUpperCase();
    if (lt === 'BYLAYER') lt = (this.doc.layers.get(st.layer)?.ltype ?? 'CONTINUOUS').toUpperCase();
    if (lt === 'BYBLOCK') lt = ctx.ltype;
    return { m, layer: st.layer, color: st.color, lw: st.w, ltype: lt, depth: ctx.depth + 1, stack: [...ctx.stack, name.toUpperCase()], out: ctx.out };
  }

  drawBlock(ctx: Ctx, blk: BlockDef, child: Ctx) {
    if (ctx.stack.includes(blk.name.toUpperCase())) { this.warnOnce(`recursive block reference "${blk.name}" skipped`); return; }
    if (ctx.depth > 40) { this.warnOnce('block nesting deeper than 40 levels cut'); return; }
    if ((blk.flags & 4) && blk.ents.length === 0) { this.skip('INSERT', 'external reference not embedded'); return; }
    const saveTop = this.topLevel;
    for (const e of blk.ents) this.entity(e, child);
    this.topLevel = saveTop;
  }

  eInsert(e: Ent, ctx: Ctx) {
    const b = this.begin(e, ctx);
    if (!b) return;
    const name = this.s(2);
    const blk = this.doc.blocks.get(name.toUpperCase());
    const ix = this.n(10), iy = this.n(20), iz = this.n(30);
    const sx = this.has(41) ? this.n(41, 1) : 1, sy = this.has(42) ? this.n(42, 1) : 1;
    const sz = this.has(43) ? this.n(43, 1) : 1;
    const rot = this.n(50, 0) * Math.PI / 180;
    const cols = Math.max(1, Math.trunc(this.n(70, 1)) || 1), rows = Math.max(1, Math.trunc(this.n(71, 1)) || 1);
    const csp = this.n(44, 0), rsp = this.n(45, 0);
    const c = b.c;
    const attribs = e.kids ?? [];
    if (!blk) { this.skip('INSERT', `block "${name}" missing`); }
    else {
      const base = blk.base;
      const total = cols * rows;
      if (total > 100000) this.warnOnce(`array insert of ${total} copies cut to 100000`);
      let k = 0;
      for (let r = 0; r < rows; r++) for (let cc = 0; cc < cols; cc++) {
        if (k++ >= 100000) break;
        let local = m3Translate(ix, iy, iz);
        local = m3Mul(local, m3RotZ(rot));
        if (cc || r) local = m3Mul(local, m3Translate(cc * csp, r * rsp, 0));
        local = m3Mul(local, m3Scale(sx || 1, sy || 1, sz || 1));
        local = m3Mul(local, m3Translate(-base[0], -base[1], -base[2]));
        const m = m3Mul(b.m, local);
        const child = this.blockCtx(ctx, c, m, blk.name);
        this.drawBlock(ctx, blk, child);
      }
    }
    if (attribs.length) {
      // attributes live in the insert's coordinate space (WCS/OCS), inheriting BYBLOCK properties of the insert
      const child = this.blockCtx(ctx, c, ctx.m, name);
      child.stack = ctx.stack;
      for (const a of attribs) { this.counts.set('ATTRIB', (this.counts.get('ATTRIB') ?? 0) + 1); this.attrib(a, child); }
    }
  }

  attrib(a: Ent, ctx: Ctx) {
    // ATTRIB with an embedded MTEXT (R2018 multiline attributes): read the TEXT part fields before 101
    this.eText(a, ctx, true);
  }

  eDimension(e: Ent, ctx: Ctx) {
    const b = this.begin(e, ctx);
    if (!b) return;
    const name = this.s(2);
    const blk = name ? this.doc.blocks.get(name.toUpperCase()) : undefined;
    if (blk && blk.ents.length) {
      // the dimension block is defined in WCS (base point usually 0,0,0) and inserted at the origin
      const m = m3Mul(ctx.m, m3Translate(-blk.base[0], -blk.base[1], -blk.base[2]));
      const child = this.blockCtx(ctx, b.c, m, blk.name);
      this.drawBlock(ctx, blk, child);
      return;
    }
    // fallback without a block: draw the measurement text at the text midpoint and a simple dimension line
    const st = this.style(b.c, ctx, ctx.m);
    const type = this.n(70, 0) & 7;
    let txt = plainText(mtextLines(this.sraw(1)).join(' '));
    const meas = this.n(42, NaN);
    if ((!txt || txt === '<>') && Number.isFinite(meas)) txt = type === 2 || type === 5 ? `${(meas * 180 / Math.PI).toFixed(1)}°` : String(+meas.toFixed(2));
    else if (txt.includes('<>') && Number.isFinite(meas)) txt = txt.replace('<>', String(+meas.toFixed(2)));
    if (type === 0 || type === 1) {
      const p13 = [this.n(13), this.n(23), this.n(33)], p14 = [this.n(14), this.n(24), this.n(34)], p10 = [this.n(10), this.n(20), this.n(30)];
      this.line3(ctx, ctx.m, [...p13, ...p10], st);
      this.line3(ctx, ctx.m, [...p14, p14[0] + p10[0] - p13[0], p14[1] + p10[1] - p13[1], p10[2]], st);
    }
    if (txt) this.text(ctx, ctx.m, this.n(11), this.n(21), this.n(31), this.asz, 0, txt, st, 'center');
    this.skip(e.type, 'no dimension block, simplified');
  }

  eTable(e: Ent, ctx: Ctx) {
    const b = this.begin(e, ctx);
    if (!b) return;
    const name = this.s(2);
    const blk = name ? this.doc.blocks.get(name.toUpperCase()) : undefined;
    if (!blk) { this.skip('ACAD_TABLE', 'no table block'); return; }
    // the anonymous table block is a block reference: insertion point 10, direction 11
    const ix = this.n(10), iy = this.n(20), iz = this.n(30);
    const rot = this.has(11) ? Math.atan2(this.n(21), this.n(11)) : 0;
    let m = m3Mul(b.m, m3Translate(ix, iy, iz));
    m = m3Mul(m, m3RotZ(rot));
    m = m3Mul(m, m3Translate(-blk.base[0], -blk.base[1], -blk.base[2]));
    this.drawBlock(ctx, blk, this.blockCtx(ctx, b.c, m, blk.name));
  }

  // ------------------------------------------------------------ fills

  eSolid(e: Ent, ctx: Ctx) {
    const b = this.begin(e, ctx);
    if (!b) return;
    const st = this.style(b.c, ctx, b.m);
    const z = this.n(30, 0);
    const p = [this.n(10), this.n(20), this.n(11), this.n(21), this.n(13, this.n(12)), this.n(23, this.n(22)), this.n(12), this.n(22)];
    // order 1,2,4,3
    const ring = [p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7]];
    const fillmode = hdrNum(this.doc, '$FILLMODE', 70, 1);
    if (fillmode === 0) this.line2(ctx, b.m, ring, z, st, true);
    else this.fill2(ctx, b.m, [dedupRing(ring)], z, st.color, st.layer);
    if (this.col3d) {
      const w = this.worldPts(b.m, [ring[0], ring[1], z, ring[2], ring[3], z, ring[4], ring[5], z, ring[6], ring[7], z]);
      this.col3d.face(this.bucket3(ctx, b.c, st), this.elementId, dedup3(w));
    }
  }

  e3dface(e: Ent, ctx: Ctx) {
    this.load(e);
    const c = this.common();
    if (c.invisible) return;
    const st = this.style(c, ctx, ctx.m);
    const p = [this.n(10), this.n(20), this.n(30), this.n(11), this.n(21), this.n(31), this.n(12), this.n(22), this.n(32), this.n(13, this.n(12)), this.n(23, this.n(22)), this.n(33, this.n(32))];
    const flags = this.n(70, 0);
    const seg: number[] = [];
    for (let i = 0; i < 4; i++) {
      if (flags & (1 << i)) continue;
      const j = (i + 1) % 4;
      if (p[i * 3] === p[j * 3] && p[i * 3 + 1] === p[j * 3 + 1] && p[i * 3 + 2] === p[j * 3 + 2]) continue;
      seg.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], p[j * 3], p[j * 3 + 1], p[j * 3 + 2]);
    }
    this.segments3(ctx, seg, st);
    if (this.col3d) {
      const bk = this.bucket3(ctx, c, st);
      this.col3d.face(bk, this.elementId, dedup3(this.worldPts(ctx.m, p)));
      this.col3d.edge(bk, this.elementId, this.worldPts(ctx.m, seg));
    }
  }

  eWipeout(e: Ent, ctx: Ctx) {
    const b = this.begin(e, ctx);
    if (!b) return;
    const ring = this.imageClip(e);
    if (!ring) return;
    const st = this.style(b.c, ctx, ctx.m);
    // wipeout masks what is below with the background colour (white sheet)
    this.fill2(ctx, ctx.m, [ring], 0, '#ffffff', st.layer);
  }
  eImage(e: Ent, ctx: Ctx) {
    const b = this.begin(e, ctx);
    if (!b) return;
    const ring = this.imageClip(e);
    if (!ring) return;
    const st = this.style(b.c, ctx, ctx.m);
    this.line2(ctx, ctx.m, ring, 0, { ...st, color: '#8a93a6' }, true);
    const file = this.doc.imageDefs.get(this.s(340).toUpperCase());
    this.skip('IMAGE', 'raster file is external' + (file ? '' : ''));
  }
  /** IMAGE / WIPEOUT outline in WCS (x,y) */
  imageClip(e: Ent): number[] | null {
    this.load(e);
    const t = this.t;
    const ox = this.n(10), oy = this.n(20);
    const ux = this.n(11), uy = this.n(21), vx = this.n(12), vy = this.n(22);
    const sx = this.n(13, 1), sy = this.n(23, 1);
    const clip: number[] = [];
    let inC = false;
    for (let i = e.s + 1; i < e.e; i++) {
      const c = t.codes[i];
      if (c === 91) inC = true;
      if (inC && c === 14) clip.push(num(t.vals[i]), 0);
      if (inC && c === 24) clip[clip.length - 1] = num(t.vals[i]);
    }
    // clip vertices are in pixel coordinates with origin at the image corner (-0.5 offset)
    let pix: number[];
    if (clip.length === 4) {
      pix = [clip[0], clip[1], clip[2], clip[1], clip[2], clip[3], clip[0], clip[3]];
    } else if (clip.length >= 6) pix = clip;
    else pix = [-0.5, -0.5, sx - 0.5, -0.5, sx - 0.5, sy - 0.5, -0.5, sy - 0.5];
    const out: number[] = [];
    for (let i = 0; i < pix.length; i += 2) {
      const px = pix[i] + 0.5, py = pix[i + 1] + 0.5;
      out.push(ox + ux * px + vx * py, oy + uy * px + vy * py);
    }
    // close duplicate last point
    if (out.length >= 4 && out[0] === out[out.length - 2] && out[1] === out[out.length - 1]) out.length -= 2;
    return out.length >= 6 ? out : null;
  }

  ePoint(e: Ent, ctx: Ctx) {
    this.load(e);
    const c = this.common();
    if (c.invisible) return;
    const st = this.style(c, ctx, ctx.m);
    const x = this.n(10), y = this.n(20), z = this.n(30);
    const mode = this.pdmode;
    if ((mode & 31) === 1 && !(mode & 96)) return;
    let size = this.pdsize > 0 ? this.pdsize : Math.abs(this.pdsize) > 0 ? this.extH * Math.abs(this.pdsize) / 100 : this.extH * 0.05;
    if (!(size > 0)) size = 1;
    const h = size / 2;
    const base = mode & 31;
    if (base === 0 && !(mode & 96)) { this.line3(ctx, ctx.m, [x, y, z, x, y, z], st); return; }
    if (base === 0) this.line3(ctx, ctx.m, [x, y, z, x, y, z], st);
    if (base === 2) { this.line3(ctx, ctx.m, [x - h, y, z, x + h, y, z], st); this.line3(ctx, ctx.m, [x, y - h, z, x, y + h, z], st); }
    if (base === 3) { this.line3(ctx, ctx.m, [x - h, y - h, z, x + h, y + h, z], st); this.line3(ctx, ctx.m, [x - h, y + h, z, x + h, y - h, z], st); }
    if (base === 4) this.line3(ctx, ctx.m, [x, y, z, x, y + h, z], st);
    if (mode & 32) this.arc(ctx, ctx.m, x, y, z, h, 0, Math.PI * 2, st, true);
    if (mode & 64) this.line3(ctx, ctx.m, [x - h, y - h, z, x + h, y - h, z, x + h, y + h, z, x - h, y + h, z], st, true);
  }

  arrow(ctx: Ctx, m: M3, tip: number[], from: number[], size: number, st: Style) {
    const dx = tip[0] - from[0], dy = tip[1] - from[1];
    const l = Math.hypot(dx, dy);
    if (!(l > 0) || !(size > 0)) return;
    const ux = dx / l, uy = dy / l;
    const bx = tip[0] - ux * size, by = tip[1] - uy * size;
    const hw = size / 6;
    this.fill2(ctx, m, [[tip[0], tip[1], bx - uy * hw, by + ux * hw, bx + uy * hw, by - ux * hw]], tip[2] ?? 0, st.color, st.layer);
  }

  dimAsz(name: string): number {
    const d = this.doc.dimstyles.get((name || 'STANDARD').toUpperCase());
    if (d && Number.isFinite(d.asz) && d.asz > 0) return d.asz * (Number.isFinite(d.scale) && d.scale > 0 ? d.scale : 1);
    return this.asz;
  }

  eLeader(e: Ent, ctx: Ctx) {
    this.load(e);
    const c = this.common();
    if (c.invisible) return;
    const t = this.t;
    const pts: number[] = [];
    let inGroup = false;
    let last = 0;
    for (let i = e.s + 1; i < e.e; i++) {
      const code = t.codes[i];
      if (code === 102) { inGroup = str(t.vals[i]).startsWith('{'); continue; }
      if (inGroup) continue;
      if (code >= 1000) break;
      if (code === 10) { pts.push(num(t.vals[i]), 0, 0); last = 10; }
      else if (code === 20 && last === 10) pts[pts.length - 2] = num(t.vals[i]);
      else if (code === 30 && last === 10) { pts[pts.length - 1] = num(t.vals[i]); last = 0; }
    }
    const st = this.style(c, ctx, ctx.m);
    if (pts.length < 6) return;
    const spline = this.n(72, 0) === 1;
    this.line3(ctx, ctx.m, spline ? catmull3(pts, false) : pts, st);
    if (this.n(71, 1) !== 0) {
      const size = this.dimAsz(this.s(3));
      const tip = m3Apply(ctx.m, pts[0], pts[1], pts[2]);
      const from = m3Apply(ctx.m, pts[3], pts[4], pts[5]);
      this.arrow({ ...ctx }, m3Identity(), [tip[0], tip[1], 0], [from[0], from[1]], size * (similarity(ctx.m)?.s ?? 1), st);
    }
  }

  eMleader(e: Ent, ctx: Ctx) {
    this.load(e);
    const c = this.common();
    if (c.invisible) return;
    const t = this.t;
    const st = this.style(c, ctx, ctx.m);
    // walk the context data: leaders, leader lines, text, block content
    let depth = 0;
    let section = '';
    const lines: number[][] = [];
    let curLine: number[] | null = null;
    let lastPt: number[] | null = null;
    let doglegDir: number[] | null = null;
    let doglegLen = 0;
    const leaders: Array<{ last: number[] | null; dir: number[] | null; len: number; lines: number[][] }> = [];
    let curLeader: (typeof leaders)[number] | null = null;
    let text = '', textH = 0, textRot = 0, textAtt = 1, textWidth = 0;
    let textLoc: number[] | null = null;
    let hasText = false;
    let arrowSize = 0;
    let blockHandle = '', blockPos: number[] | null = null, blockScale = [1, 1, 1], blockRot = 0, hasBlock = false;
    let landingGap = 0;
    let lastCode = 0;
    for (let i = e.s + 1; i < e.e; i++) {
      const code = t.codes[i];
      const v = t.vals[i];
      if (code >= 1000) break;
      if (code === 300 && str(v) === 'CONTEXT_DATA{') { depth = 1; section = 'ctx'; continue; }
      if (code === 302 && str(v) === 'LEADER{') { depth = 2; section = 'leader'; curLeader = { last: null, dir: null, len: 0, lines: [] }; leaders.push(curLeader); continue; }
      if (code === 304 && str(v) === 'LEADER_LINE{') { depth = 3; section = 'line'; curLine = []; curLeader?.lines.push(curLine); continue; }
      if (code === 305 || code === 303 || code === 301) {
        depth--; section = depth === 2 ? 'leader' : depth === 1 ? 'ctx' : '';
        continue;
      }
      if (section === 'line' && curLine) {
        if (code === 10) curLine.push(num(v), 0, 0);
        else if (code === 20) curLine[curLine.length - 2] = num(v);
        else if (code === 30) curLine[curLine.length - 1] = num(v);
      } else if (section === 'leader' && curLeader) {
        if (code === 10) { curLeader.last = [num(v), 0, 0]; lastCode = 10; }
        else if (code === 20 && lastCode === 10 && curLeader.last) curLeader.last[1] = num(v);
        else if (code === 30 && lastCode === 10 && curLeader.last) { curLeader.last[2] = num(v); lastCode = 0; }
        else if (code === 11) { curLeader.dir = [num(v), 0, 0]; lastCode = 11; }
        else if (code === 21 && lastCode === 11 && curLeader.dir) curLeader.dir[1] = num(v);
        else if (code === 31 && lastCode === 11 && curLeader.dir) { curLeader.dir[2] = num(v); lastCode = 0; }
        else if (code === 40) curLeader.len = num(v);
      } else if (section === 'ctx') {
        switch (code) {
          case 304: text = String(v).replace(/\r$/, ''); break;
          case 290: hasText = int(v) === 1; break;
          case 41: textH = num(v); break;
          case 140: arrowSize = num(v); break;
          case 145: landingGap = num(v); break;
          case 12: textLoc = [num(v), 0, 0]; lastCode = 12; break;
          case 22: if (lastCode === 12 && textLoc) textLoc[1] = num(v); break;
          case 32: if (lastCode === 12 && textLoc) textLoc[2] = num(v); break;
          case 42: textRot = num(v); break;
          case 43: textWidth = num(v); break;
          case 171: textAtt = int(v); break;
          case 296: hasBlock = int(v) === 1; break;
          case 341: blockHandle = str(v).toUpperCase(); break;
          case 15: blockPos = [num(v), 0, 0]; lastCode = 15; break;
          case 25: if (lastCode === 15 && blockPos) blockPos[1] = num(v); break;
          case 35: if (lastCode === 15 && blockPos) blockPos[2] = num(v); break;
          case 16: blockScale = [num(v), num(v), num(v)]; break;
          case 46: blockRot = num(v); break;
        }
      } else if (depth === 0) {
        if (code === 42 && !arrowSize) arrowSize = num(v);
      }
    }
    void lines; void curLine; void lastPt; void doglegDir; void doglegLen; void landingGap;
    const size = arrowSize || this.asz;
    for (const L of leaders) {
      for (const ln of L.lines) {
        const p = ln.slice();
        if (L.last) p.push(...L.last);
        if (p.length >= 6) {
          this.line3(ctx, ctx.m, p, st);
          const tip = m3Apply(ctx.m, p[0], p[1], p[2]);
          const from = m3Apply(ctx.m, p[3], p[4], p[5]);
          this.arrow(ctx, m3Identity(), [tip[0], tip[1], 0], [from[0], from[1]], size * (similarity(ctx.m)?.s ?? 1), st);
        }
      }
      if (L.last && L.dir && L.len > 0) {
        const d = norm(L.dir);
        this.line3(ctx, ctx.m, [...L.last, L.last[0] + d[0] * L.len, L.last[1] + d[1] * L.len, L.last[2] + d[2] * L.len], st);
      }
    }
    if (hasText && text && textLoc) {
      let ls = mtextLines(text);
      const h = textH || this.textSize;
      if (textWidth > 0) ls = ls.flatMap((l) => wrapLine(l, h, textWidth));
      const att = textAtt >= 1 && textAtt <= 9 ? textAtt : 1;
      const col = (att - 1) % 3, row = Math.floor((att - 1) / 3);
      const spacing = h * 5 / 3;
      const total = h + (ls.length - 1) * spacing;
      const firstBase = row === 0 ? -h : row === 1 ? total / 2 - h : (ls.length - 1) * spacing;
      const cs = Math.cos(textRot), sn = Math.sin(textRot);
      for (let i = 0; i < ls.length; i++) {
        if (!ls[i].trim()) continue;
        const oy = firstBase - i * spacing;
        this.text(ctx, ctx.m, textLoc[0] - sn * oy, textLoc[1] + cs * oy, textLoc[2], h, textRot, ls[i], st, col === 0 ? 'left' : col === 1 ? 'center' : 'right');
      }
    }
    if (hasBlock && blockHandle && blockPos) {
      const bname = this.doc.blockRecords.get(blockHandle);
      const blk = bname ? this.doc.blocks.get(bname.toUpperCase()) : undefined;
      if (blk) {
        let m = m3Mul(ctx.m, m3Translate(blockPos[0], blockPos[1], blockPos[2]));
        m = m3Mul(m, m3RotZ(blockRot));
        m = m3Mul(m, m3Scale(blockScale[0] || 1, blockScale[1] || 1, blockScale[2] || 1));
        m = m3Mul(m, m3Translate(-blk.base[0], -blk.base[1], -blk.base[2]));
        this.drawBlock(ctx, blk, this.blockCtx(ctx, c, m, blk.name));
      }
    }
  }

  eMline(e: Ent, ctx: Ctx) {
    this.load(e);
    const c = this.common();
    if (c.invisible) return;
    const t = this.t;
    const flags = this.n(71, 0);
    const scale = this.n(40, 1);
    const styleRef = this.s(340).toUpperCase();
    const style = this.doc.mlineStyles.get(styleRef) ?? this.doc.mlineStyles.get(this.s(2).toUpperCase());
    const nel = Math.max(1, Math.trunc(this.n(73, style?.elements.length ?? 2)));
    // per vertex: position, miter, element params
    const verts: Array<{ p: number[]; dir: number[]; miter: number[]; params: number[][] }> = [];
    let cur: (typeof verts)[number] | null = null;
    let last = 0;
    let pcount = 0;
    let curParams: number[] | null = null;
    for (let i = e.s + 1; i < e.e; i++) {
      const code = t.codes[i];
      if (code >= 1000) break;
      const v = num(t.vals[i]);
      switch (code) {
        case 11: cur = { p: [v, 0, 0], dir: [0, 0, 0], miter: [0, 0, 0], params: [] }; verts.push(cur); last = 11; break;
        case 21: if (cur && last === 11) cur.p[1] = v; break;
        case 31: if (cur && last === 11) cur.p[2] = v; break;
        case 12: if (cur) { cur.dir[0] = v; last = 12; } break;
        case 22: if (cur && last === 12) cur.dir[1] = v; break;
        case 32: if (cur && last === 12) cur.dir[2] = v; break;
        case 13: if (cur) { cur.miter[0] = v; last = 13; } break;
        case 23: if (cur && last === 13) cur.miter[1] = v; break;
        case 33: if (cur && last === 13) cur.miter[2] = v; break;
        case 74: if (cur) { pcount = v; curParams = []; cur.params.push(curParams); } break;
        case 41: if (curParams && pcount > 0) { curParams.push(v); } break;
      }
    }
    if (verts.length < 2) return;
    const st = this.style(c, ctx, ctx.m);
    const closed = (flags & 2) !== 0;
    for (let k = 0; k < nel; k++) {
      const p: number[] = [];
      for (const vt of verts) {
        const d = vt.params[k]?.[0] ?? (style?.elements[k]?.offset ?? 0) * scale;
        p.push(vt.p[0] + vt.miter[0] * d, vt.p[1] + vt.miter[1] * d, vt.p[2] + vt.miter[2] * d);
      }
      let s2 = st;
      const ec = style?.elements[k]?.color;
      if (ec !== undefined && ec !== 256 && ec !== 0) s2 = { ...st, color: aciHex(ec) };
      this.line3(ctx, ctx.m, p, s2, closed);
    }
    // end caps (straight)
    if (!closed && nel > 1) {
      for (const vt of [verts[0], verts[verts.length - 1]]) {
        const ds = vt.params.map((pp, k) => pp[0] ?? (style?.elements[k]?.offset ?? 0) * scale);
        const lo = Math.min(...ds), hi = Math.max(...ds);
        this.line3(ctx, ctx.m, [vt.p[0] + vt.miter[0] * lo, vt.p[1] + vt.miter[1] * lo, vt.p[2] + vt.miter[2] * lo, vt.p[0] + vt.miter[0] * hi, vt.p[1] + vt.miter[1] * hi, vt.p[2] + vt.miter[2] * hi], st);
      }
    }
  }

  eMesh(e: Ent, ctx: Ctx) {
    this.load(e);
    const c = this.common();
    if (c.invisible) return;
    const t = this.t;
    let state = 0;
    let nv = 0, nf = 0;
    const verts: number[] = [];
    const faceList: number[] = [];
    let last = 0;
    let sub = '';
    for (let i = e.s + 1; i < e.e; i++) {
      const code = t.codes[i];
      if (code >= 1000) break;
      if (code === 100) { sub = str(t.vals[i]); continue; }
      if (sub !== 'AcDbSubDMesh') continue;
      const v = num(t.vals[i]);
      if (state === 0 && code === 92) { nv = v; state = 1; continue; }
      if (state === 1) {
        if (code === 10) { verts.push(v, 0, 0); last = 10; continue; }
        if (code === 20 && last === 10) { verts[verts.length - 2] = v; continue; }
        if (code === 30 && last === 10) { verts[verts.length - 1] = v; continue; }
        if (code === 93) { nf = v; state = 2; continue; }
      }
      if (state === 2) {
        if (code === 90 && faceList.length < nf) { faceList.push(v); continue; }
        if (code !== 90 || faceList.length >= nf) { state = 3; }
      }
    }
    void nv;
    const st = this.style(c, ctx, ctx.m);
    const nvv = verts.length / 3;
    const faces: number[][] = [];
    for (let i = 0; i < faceList.length;) {
      const k = faceList[i];
      const f = faceList.slice(i + 1, i + 1 + k).filter((x) => x >= 0 && x < nvv);
      if (f.length >= 3) faces.push(f);
      i += k + 1;
      if (!(k > 0)) break;
    }
    const seen = new Set<string>();
    const edges: number[] = [];
    for (const f of faces) for (let i = 0; i < f.length; i++) {
      const a = f[i], b = f[(i + 1) % f.length];
      const key = a < b ? a + ',' + b : b + ',' + a;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push(verts[a * 3], verts[a * 3 + 1], verts[a * 3 + 2], verts[b * 3], verts[b * 3 + 1], verts[b * 3 + 2]);
    }
    this.segments3(ctx, edges, st);
    if (this.col3d) {
      const bk = this.bucket3(ctx, c, st);
      for (const f of faces) {
        const p: number[] = [];
        for (const i of f) p.push(verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]);
        this.col3d.face(bk, this.elementId, this.worldPts(ctx.m, p));
      }
      this.col3d.edge(bk, this.elementId, this.worldPts(ctx.m, edges));
    }
  }

  // ------------------------------------------------------------ hatch

  eHatch(e: Ent, ctx: Ctx) {
    const b = this.begin(e, ctx);
    if (!b) return;
    const t = this.t;
    const elev = this.n(30, 0);
    const st = this.style(b.c, ctx, b.m);
    const ms = Math.sqrt(Math.abs(b.m[0] * b.m[4] - b.m[1] * b.m[3])) || 1;
    const ltol = this.tol / ms;
    // sequential parse after the AcDbHatch subclass marker
    let i = e.s + 1;
    while (i < e.e && !(t.codes[i] === 100 && str(t.vals[i]) === 'AcDbHatch')) i++;
    if (i >= e.e) i = e.s + 1;
    const T = (k: number) => t.codes[k];
    const V = (k: number) => num(t.vals[k]);
    let solid = false, patName = '';
    let nPaths = 0;
    // header fields until 91
    for (; i < e.e; i++) {
      const c = T(i);
      if (c === 2) patName = str(t.vals[i]);
      else if (c === 70) solid = V(i) === 1;
      else if (c === 91) { nPaths = V(i); i++; break; }
    }
    const rings: number[][] = [];
    for (let pi = 0; pi < nPaths && i < e.e; pi++) {
      while (i < e.e && T(i) !== 92) i++;
      if (i >= e.e) break;
      const ptype = V(i++);
      const ring: number[] = [];
      if (ptype & 2) {
        let hasBulge = false, closed = true, nv = 0;
        if (T(i) === 72) hasBulge = V(i++) !== 0;
        if (T(i) === 73) closed = V(i++) !== 0;
        if (T(i) === 93) nv = V(i++);
        const xs: number[] = [], ys: number[] = [], bs: number[] = [];
        for (let k = 0; k < nv && i < e.e; k++) {
          if (T(i) !== 10) break;
          xs.push(V(i++));
          ys.push(T(i) === 20 ? V(i++) : 0);
          bs.push(T(i) === 42 ? V(i++) : 0);
        }
        void hasBulge; void closed;
        if (xs.length) {
          ring.push(xs[0], ys[0]);
          for (let k = 0; k < xs.length; k++) {
            const j = (k + 1) % xs.length;
            if (j === 0 && xs[0] === xs[k] && ys[0] === ys[k]) break;
            bulgePoints(xs[k], ys[k], xs[j], ys[j], bs[k], ltol, ring);
          }
        }
      } else {
        const ne = T(i) === 93 ? V(i++) : 0;
        for (let k = 0; k < ne && i < e.e; k++) {
          if (T(i) !== 72) break;
          const et = V(i++);
          const seg: number[] = [];
          if (et === 1) {
            const x0 = T(i) === 10 ? V(i++) : 0, y0 = T(i) === 20 ? V(i++) : 0;
            const x1 = T(i) === 11 ? V(i++) : 0, y1 = T(i) === 21 ? V(i++) : 0;
            seg.push(x0, y0, x1, y1);
          } else if (et === 2) {
            const cx = T(i) === 10 ? V(i++) : 0, cy = T(i) === 20 ? V(i++) : 0;
            const r = T(i) === 40 ? V(i++) : 0;
            let a0 = T(i) === 50 ? V(i++) : 0, a1 = T(i) === 51 ? V(i++) : 360;
            const ccw = T(i) === 73 ? V(i++) !== 0 : true;
            const D = Math.PI / 180;
            if (!ccw) { a0 = -a0; a1 = -a1; }
            let sweep = (a1 - a0) * D;
            if (!Number.isFinite(sweep) || Math.abs(sweep) > 1e6) sweep = Math.PI * 2;
            if (ccw) { while (sweep < 0) sweep += Math.PI * 2; } else { while (sweep > 0) sweep -= Math.PI * 2; }
            if (Math.abs(a1 - a0) >= 360 - 1e-9) sweep = ccw ? Math.PI * 2 : -Math.PI * 2;
            const n = arcSegs(sweep, r, ltol);
            for (let q = 0; q <= n; q++) { const a = a0 * D + (sweep * q) / n; seg.push(cx + r * Math.cos(a), cy + r * Math.sin(a)); }
          } else if (et === 3) {
            const cx = T(i) === 10 ? V(i++) : 0, cy = T(i) === 20 ? V(i++) : 0;
            const mx = T(i) === 11 ? V(i++) : 1, my = T(i) === 21 ? V(i++) : 0;
            const ratio = T(i) === 40 ? V(i++) : 1;
            let a0 = T(i) === 50 ? V(i++) : 0, a1 = T(i) === 51 ? V(i++) : 360;
            const ccw = T(i) === 73 ? V(i++) !== 0 : true;
            const D = Math.PI / 180;
            if (!ccw) { a0 = -a0; a1 = -a1; }
            let sweep = (a1 - a0) * D;
            if (!Number.isFinite(sweep) || Math.abs(sweep) > 1e6) sweep = Math.PI * 2;
            if (ccw) { while (sweep < 0) sweep += Math.PI * 2; } else { while (sweep > 0) sweep -= Math.PI * 2; }
            if (Math.abs(a1 - a0) >= 360 - 1e-9) sweep = ccw ? Math.PI * 2 : -Math.PI * 2;
            const nx = -my * ratio, ny = mx * ratio;
            const n = arcSegs(sweep, Math.hypot(mx, my), ltol);
            for (let q = 0; q <= n; q++) {
              const a = a0 * D + (sweep * q) / n;
              seg.push(cx + mx * Math.cos(a) + nx * Math.sin(a), cy + my * Math.cos(a) + ny * Math.sin(a));
            }
          } else if (et === 4) {
            const deg = T(i) === 94 ? V(i++) : 3;
            const rational = T(i) === 73 ? V(i++) !== 0 : false;
            if (T(i) === 74) i++;
            const nk = T(i) === 95 ? V(i++) : 0;
            const nc = T(i) === 96 ? V(i++) : 0;
            const knots: number[] = [];
            for (let q = 0; q < nk && T(i) === 40; q++) knots.push(V(i++));
            const ctrl: number[] = [], w: number[] = [];
            for (let q = 0; q < nc && T(i) === 10; q++) {
              ctrl.push(V(i++), T(i) === 20 ? V(i++) : 0, 0);
              if (T(i) === 42) w.push(V(i++)); else if (rational) w.push(1);
            }
            const fit: number[] = [];
            if (T(i) === 97) {
              const nfit = V(i++);
              for (let q = 0; q < nfit && T(i) === 11; q++) fit.push(V(i++), T(i) === 21 ? V(i++) : 0, 0);
              if (T(i) === 12) { i++; if (T(i) === 22) i++; }
              if (T(i) === 13) { i++; if (T(i) === 23) i++; }
            }
            const p3 = (ctrl.length >= 6 ? nurbs3(deg, knots, ctrl, w, ltol) : null) ?? (fit.length >= 6 ? catmull3(fit, false) : ctrl);
            for (let q = 0; q < p3.length; q += 3) seg.push(p3[q], p3[q + 1]);
          } else break;
          appendSeg(ring, seg);
        }
      }
      // source boundary objects
      if (T(i) === 97) { const ns = V(i++); for (let q = 0; q < ns && T(i) === 330; q++) i++; }
      if (ring.length >= 6) rings.push(ring);
    }
    // pattern data
    let style = 0;
    const fam: Array<{ ang: number; bx: number; by: number; ox: number; oy: number; dashes: number[] }> = [];
    let gradient = false;
    let gradColor: string | null = null;
    for (; i < e.e; i++) {
      const c = T(i);
      if (c >= 1000) break;
      if (c === 75) style = V(i);
      else if (c === 78) {
        const nl = V(i++);
        for (let k = 0; k < nl && i < e.e; k++) {
          if (T(i) !== 53) break;
          const f = { ang: V(i++) * Math.PI / 180, bx: 0, by: 0, ox: 0, oy: 0, dashes: [] as number[] };
          if (T(i) === 43) f.bx = V(i++);
          if (T(i) === 44) f.by = V(i++);
          if (T(i) === 45) f.ox = V(i++);
          if (T(i) === 46) f.oy = V(i++);
          const nd = T(i) === 79 ? V(i++) : 0;
          for (let q = 0; q < nd && T(i) === 49; q++) f.dashes.push(V(i++));
          fam.push(f);
        }
        i--;
      } else if (c === 450) gradient = V(i) === 1;
      else if (c === 421 && !gradColor) gradColor = trueColorHex(Math.trunc(V(i)));
    }
    void style;
    if (!rings.length) return;
    if (solid || gradient || patName.toUpperCase() === 'SOLID') {
      this.fill2(ctx, b.m, rings, elev, gradient && gradColor ? gradColor : st.color, st.layer, gradient ? 0.6 : undefined);
      return;
    }
    if (!fam.length) { this.fill2(ctx, b.m, rings, elev, st.color, st.layer, 0.15); return; }
    const segs = hatchLines(rings, fam, ltol, Math.min(this.hatchBudget, 200000));
    if (!segs) {
      this.fill2(ctx, b.m, rings, elev, st.color, st.layer, 0.18);
      this.warnOnce('dense hatch patterns drawn as light fills');
      return;
    }
    this.hatchBudget -= segs.length / 4;
    const s2: Style = { color: st.color, layer: st.layer };
    if (st.w !== undefined) s2.w = st.w;
    for (let k = 0; k < segs.length; k += 4) this.line2(ctx, b.m, [segs[k], segs[k + 1], segs[k + 2], segs[k + 3]], elev, s2);
  }

  warned = new Set<string>();
  warnOnce(w: string) { if (!this.warned.has(w)) { this.warned.add(w); this.warnings.push(w); } }
}

function dedupRing(r: number[]): number[] {
  const o: number[] = [];
  for (let i = 0; i < r.length; i += 2) {
    const n = o.length;
    if (n >= 2 && o[n - 2] === r[i] && o[n - 1] === r[i + 1]) continue;
    o.push(r[i], r[i + 1]);
  }
  if (o.length >= 4 && o[0] === o[o.length - 2] && o[1] === o[o.length - 1]) o.length -= 2;
  return o;
}
function dedup3(p: number[]): number[] {
  const o: number[] = [];
  for (let i = 0; i < p.length; i += 3) {
    const n = o.length;
    if (n >= 3 && o[n - 3] === p[i] && o[n - 2] === p[i + 1] && o[n - 1] === p[i + 2]) continue;
    o.push(p[i], p[i + 1], p[i + 2]);
  }
  if (o.length >= 6 && o[0] === o[o.length - 3] && o[1] === o[o.length - 2] && o[2] === o[o.length - 1]) o.length -= 3;
  return o;
}

/** append an edge to a boundary ring, reversing it when it is stored the other way round */
function appendSeg(ring: number[], seg: number[]) {
  if (seg.length < 4) return;
  if (ring.length === 0) { ring.push(...seg); return; }
  const ex = ring[ring.length - 2], ey = ring[ring.length - 1];
  const d0 = Math.hypot(seg[0] - ex, seg[1] - ey);
  const d1 = Math.hypot(seg[seg.length - 2] - ex, seg[seg.length - 1] - ey);
  let s = seg;
  if (d1 < d0 * 0.5) {
    s = [];
    for (let i = seg.length - 2; i >= 0; i -= 2) s.push(seg[i], seg[i + 1]);
  }
  const start = Math.hypot(s[0] - ex, s[1] - ey) < 1e-9 ? 2 : 0;
  for (let i = start; i < s.length; i++) ring.push(s[i]);
}

/** NURBS curve sampled to points (x,y,z), de Boor; returns null when the knot vector does not fit */
export function nurbs3(deg: number, knots: number[], ctrl: number[], w: number[], tol: number): number[] | null {
  const n = ctrl.length / 3;
  const p = Math.max(1, Math.trunc(deg));
  if (n < p + 1) return null;
  if (knots.length !== n + p + 1) return null;
  const rational = w.length === n && w.some((x) => x !== 1);
  const t0 = knots[p], t1 = knots[n];
  if (!(t1 > t0)) return null;
  // sample count from control polygon length
  let plen = 0;
  for (let i = 1; i < n; i++) plen += Math.hypot(ctrl[i * 3] - ctrl[i * 3 - 3], ctrl[i * 3 + 1] - ctrl[i * 3 - 2], ctrl[i * 3 + 2] - ctrl[i * 3 - 1]);
  let samples = tol > 0 ? Math.ceil(Math.sqrt(plen / tol) * 2) : n * 8;
  samples = Math.max(n * 4, Math.min(4000, samples));
  if (p === 1) samples = n - 1;
  const out: number[] = [];
  const d = new Float64Array((p + 1) * 4);
  for (let s = 0; s <= samples; s++) {
    let u = p === 1 ? knots[s + 1] : t0 + ((t1 - t0) * s) / samples;
    if (u >= t1) u = t1 - 1e-12 * (t1 - t0);
    if (p === 1 && s === samples) u = t1 - 1e-12 * (t1 - t0);
    // span
    let k = p;
    while (k < n - 1 && knots[k + 1] <= u) k++;
    for (let j = 0; j <= p; j++) {
      const ci = k - p + j;
      const ww = rational ? w[ci] : 1;
      d[j * 4] = ctrl[ci * 3] * ww; d[j * 4 + 1] = ctrl[ci * 3 + 1] * ww; d[j * 4 + 2] = ctrl[ci * 3 + 2] * ww; d[j * 4 + 3] = ww;
    }
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const i = k - p + j;
        const den = knots[i + p - r + 1] - knots[i];
        const a = den === 0 ? 0 : (u - knots[i]) / den;
        for (let q = 0; q < 4; q++) d[j * 4 + q] = (1 - a) * d[(j - 1) * 4 + q] + a * d[j * 4 + q];
      }
    }
    const W = d[p * 4 + 3] || 1;
    out.push(d[p * 4] / W, d[p * 4 + 1] / W, d[p * 4 + 2] / W);
  }
  if (p === 1) { out.length = 0; for (let i = 0; i < ctrl.length; i++) out.push(ctrl[i]); }
  return out;
}

/** Catmull-Rom curve through fit points (approximation of fit-point splines) */
export function catmull3(f: number[], closed: boolean): number[] {
  const n = f.length / 3;
  if (n < 3) return f.slice();
  const P = (i: number) => {
    if (closed) i = ((i % n) + n) % n;
    else i = Math.max(0, Math.min(n - 1, i));
    return [f[i * 3], f[i * 3 + 1], f[i * 3 + 2]];
  };
  const out: number[] = [];
  const segs = closed ? n : n - 1;
  const steps = 12;
  out.push(...P(0));
  for (let i = 0; i < segs; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    for (let s = 1; s <= steps; s++) {
      const t = s / steps, t2 = t * t, t3 = t2 * t;
      for (let k = 0; k < 3; k++) {
        out.push(0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3));
      }
    }
  }
  return out;
}

/** Pattern hatch lines clipped to boundary rings (even-odd), returns flat segments [x0,y0,x1,y1,...] or null when too dense */
export function hatchLines(rings: number[][], fam: Array<{ ang: number; bx: number; by: number; ox: number; oy: number; dashes: number[] }>, tol: number, budget: number): number[] | null {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  let nEdges = 0;
  for (const r of rings) {
    for (let i = 0; i < r.length; i += 2) { minx = Math.min(minx, r[i]); maxx = Math.max(maxx, r[i]); miny = Math.min(miny, r[i + 1]); maxy = Math.max(maxy, r[i + 1]); }
    nEdges += r.length / 2;
  }
  const out: number[] = [];
  const corners = [minx, miny, maxx, miny, maxx, maxy, minx, maxy];
  // estimate work first
  let rowsTotal = 0;
  const plans: Array<{ f: (typeof fam)[number]; dx: number; dy: number; nx: number; ny: number; dist: number; k0: number; k1: number }> = [];
  for (const f of fam) {
    const dx = Math.cos(f.ang), dy = Math.sin(f.ang);
    const nx = -dy, ny = dx;
    const dist = f.ox * nx + f.oy * ny;
    if (!(Math.abs(dist) > 1e-12)) continue;
    let vmin = Infinity, vmax = -Infinity;
    for (let i = 0; i < 8; i += 2) { const v = (corners[i] - f.bx) * nx + (corners[i + 1] - f.by) * ny; vmin = Math.min(vmin, v); vmax = Math.max(vmax, v); }
    let k0 = Math.floor(vmin / dist), k1 = Math.ceil(vmax / dist);
    if (k0 > k1) [k0, k1] = [k1, k0];
    rowsTotal += k1 - k0 + 1;
    plans.push({ f, dx, dy, nx, ny, dist, k0, k1 });
  }
  if (rowsTotal > 20000 || rowsTotal * nEdges > 3e7) return null;
  const ts: number[] = [];
  for (const P of plans) {
    const { f, dx, dy, nx, ny } = P;
    const period = f.dashes.reduce((a, b) => a + Math.abs(b), 0);
    for (let k = P.k0; k <= P.k1; k++) {
      const qx = f.bx + k * f.ox, qy = f.by + k * f.oy;
      ts.length = 0;
      for (const r of rings) {
        const n = r.length / 2;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          const ax = r[i * 2] - qx, ay = r[i * 2 + 1] - qy, bx = r[j * 2] - qx, by = r[j * 2 + 1] - qy;
          const va = ax * nx + ay * ny, vb = bx * nx + by * ny;
          if ((va > 0) === (vb > 0)) continue;
          const s = va / (va - vb);
          ts.push(ax * dx + ay * dy + s * ((bx - ax) * dx + (by - ay) * dy));
        }
      }
      if (ts.length < 2) continue;
      ts.sort((a, b) => a - b);
      for (let i = 0; i + 1 < ts.length; i += 2) {
        const ta = ts[i], tb = ts[i + 1];
        if (tb - ta < 1e-12) continue;
        if (!f.dashes.length || !(period > 0)) {
          out.push(qx + dx * ta, qy + dy * ta, qx + dx * tb, qy + dy * tb);
        } else {
          if ((tb - ta) / period > 5000) return null;
          let pos = Math.floor(ta / period) * period;
          while (pos < tb) {
            for (const dl of f.dashes) {
              const len = Math.abs(dl);
              const s0 = pos, s1 = pos + len;
              if (dl >= 0) {
                const a = Math.max(s0, ta), b = Math.min(dl === 0 ? s0 : s1, tb);
                if (dl === 0 ? s0 >= ta && s0 <= tb : b > a) out.push(qx + dx * a, qy + dy * a, qx + dx * (dl === 0 ? a : b), qy + dy * (dl === 0 ? a : b));
              }
              pos = s1;
              if (pos >= tb) break;
            }
            if (period <= 0) break;
          }
        }
        if (out.length / 4 > budget) return null;
      }
    }
  }
  void tol;
  return out;
}

// ================================================================== document level

function layoutPaperFactor(doc: DxfDoc): number {
  const u = hdrNum(doc, '$INSUNITS', 70, 0);
  if (u === 1 || u === 2) return 25.4;
  if (u === 0 && hdrNum(doc, '$MEASUREMENT', 70, 1) === 0) return 25.4;
  return 1;
}

function headerExtents(doc: DxfDoc): Rect | null {
  const x0 = hdrNum(doc, '$EXTMIN', 10, NaN), y0 = hdrNum(doc, '$EXTMIN', 20, NaN);
  const x1 = hdrNum(doc, '$EXTMAX', 10, NaN), y1 = hdrNum(doc, '$EXTMAX', 20, NaN);
  if (![x0, y0, x1, y1].every((v) => Number.isFinite(v) && Math.abs(v) < 1e19)) return null;
  if (!(x1 > x0 || y1 > y0)) return null;
  return [x0, y0, x1, y1];
}

/** extents from entity coordinates (codes 10/20) when the header has none */
function roughExtents(doc: DxfDoc): Rect | null {
  const t = doc.t;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of doc.entities) {
    for (let i = e.s + 1; i < e.e - 1; i++) {
      if (t.codes[i] === 10 && t.codes[i + 1] === 20) {
        const x = num(t.vals[i]), y = num(t.vals[i + 1]);
        if (Number.isFinite(x) && Number.isFinite(y) && Math.abs(x) < 1e15 && Math.abs(y) < 1e15) {
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
  }
  if (!isFinite(x0) || !(x1 > x0 || y1 > y0)) return null;
  return [x0, y0, x1, y1];
}

function viewportMatrix(r: Renderer, e: Ent): { m: M3; box: Rect; id: number; scale: number; frozen: string[]; on: boolean; plan: boolean } | null {
  r.load(e);
  const id = r.n(69, 0);
  const cx = r.n(10), cy = r.n(20), w = r.n(40), h = r.n(41);
  const status = r.n(68, 1);
  const flags = r.n(90, 0);
  const on = status !== 0 && !(flags & 0x20000);
  const vcx = r.n(12), vcy = r.n(22);
  const dir = [r.n(16, 0), r.n(26, 0), r.n(36, 1)];
  const tgt = [r.n(17, 0), r.n(27, 0), r.n(37, 0)];
  const vh = r.n(45, 0);
  const twist = r.n(51, 0) * Math.PI / 180;
  const t = r.t;
  const frozen: string[] = [];
  for (let i = e.s + 1; i < e.e; i++) if (t.codes[i] === 331) frozen.push(str(t.vals[i]).toUpperCase());
  if (!(w > 0) || !(h > 0) || !(vh > 0)) return null;
  const k = h / vh;
  const o = ocsMatrix(dir[0], dir[1], dir[2]);
  const ax = o ? [o[0], o[1], o[2]] : [1, 0, 0], ay = o ? [o[3], o[4], o[5]] : [0, 1, 0], az = o ? [o[6], o[7], o[8]] : [0, 0, 1];
  // world -> DCS (rows = axes)
  const toDcs = m3FromAxes([ax[0], ay[0], az[0]], [ax[1], ay[1], az[1]], [ax[2], ay[2], az[2]], [0, 0, 0]);
  let m = m3Translate(cx, cy, 0);
  m = m3Mul(m, m3Scale(k, k, k));
  m = m3Mul(m, m3Translate(-vcx, -vcy, 0));
  m = m3Mul(m, m3RotZ(-twist));
  m = m3Mul(m, toDcs);
  m = m3Mul(m, m3Translate(-tgt[0], -tgt[1], -tgt[2]));
  const plan = !o;
  return { m, box: [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], id, scale: 1 / k, frozen, on, plan };
}

export async function readDxf(bytes: Uint8Array, onProgress?: Progress, options: DxfOptions = {}): Promise<CadResult> {
  const t0 = Date.now();
  if (!sniffDxfBytes(bytes)) throw new CadError('not-format', 'not a DXF file');
  if (bytes.length > 1024 * 1024 * 1024) throw new CadError('too-large', 'DXF larger than 1 GB');
  onProgress?.('decode', 0);
  const tk = tokenize(bytes);
  onProgress?.('parse', 0.15);
  if (tk.tokens.n < 2) throw new CadError('corrupt', 'DXF: no group codes');
  const doc = parseDoc(tk.tokens, (r) => onProgress?.('parse', 0.15 + r * 0.2));
  const warnings: string[] = [...tk.warnings];
  const r = new Renderer(doc, options.maxItems ?? 3_000_000);
  let insunits = hdrNum(doc, '$INSUNITS', 70, 0);
  // unitless drawings saved with imperial measurement settings are inches
  if (insunits === 0 && doc.header.has('$MEASUREMENT') && hdrNum(doc, '$MEASUREMENT', 70, 1) === 0) insunits = 1;
  const unitMm = UNIT_MM[insunits] ?? 1;
  const ext = headerExtents(doc) ?? roughExtents(doc);
  r.extH = ext ? Math.max(ext[3] - ext[1], ext[2] - ext[0]) : 0;
  r.tol = ext ? Math.hypot(ext[2] - ext[0], ext[3] - ext[1]) / 6000 : 0;

  // ---- model space
  const modelEnts = doc.entities.filter((e) => {
    const v = g(doc.t, e, 67);
    return v === undefined || int(v) !== 1;
  });
  const paperEnts = doc.entities.filter((e) => { const v = g(doc.t, e, 67); return v !== undefined && int(v) === 1; });
  const want3d = options.mode !== '2d';
  if (want3d) r.col3d = new Collector3D();
  const modelItems: SheetItem[] = [];
  const rootCtx = (out: SheetItem[], m: M3): Ctx => ({ m, layer: '0', color: '#000000', lw: undefined, ltype: 'CONTINUOUS', depth: 0, stack: [], out });
  const modelCtx = rootCtx(modelItems, m3Identity());
  let k = 0;
  for (const e of modelEnts) {
    r.elementId++;
    r.curTopType = e.type;
    r.curTopHandle = str(g(doc.t, e, 5));
    r.curTopBlock = e.type === 'INSERT' ? str(g(doc.t, e, 2)) : null;
    r.topLevel = true;
    r.entity(e, modelCtx);
    if ((++k & 4095) === 0) onProgress?.('model', 0.35 + 0.4 * (k / modelEnts.length));
  }
  // infinite lines clipped to the drawing extents
  const addXlines = (items: SheetItem[]) => {
    if (!r.xlines.length) return;
    const bb = itemsBounds(items) ?? (ext ?? [0, 0, 100, 100]);
    const pad = Math.max(bb[2] - bb[0], bb[3] - bb[1]) * 0.1 || 10;
    const R: Rect = [bb[0] - pad, bb[1] - pad, bb[2] + pad, bb[3] + pad];
    const L = Math.hypot(R[2] - R[0], R[3] - R[1]) * 4;
    for (const xl of r.xlines) {
      const l = Math.hypot(xl.dx, xl.dy);
      const ux = xl.dx / l, uy = xl.dy / l;
      const a = xl.ray ? 0 : -L;
      const seg = [xl.x + ux * a, xl.y + uy * a, xl.x + ux * L, xl.y + uy * L];
      for (const c of clipItems([{ kind: 'line', pts: seg, color: xl.st.color, layer: xl.st.layer, ...(xl.st.dash ? { dash: xl.st.dash } : {}) }], R, 0)) items.push(c);
    }
    r.xlines = [];
  };
  addXlines(modelItems);
  const col3d = r.col3d;
  r.col3d = null;
  onProgress?.('layouts', 0.78);

  // ---- layouts / paper space
  const sheets: RvtSheet2D[] = [];
  const unsupportedWarn = () => [...r.unsupported].map(([k2, v]) => `${v} x ${k2} not drawn`);
  const modelBounds = itemsBounds(modelItems);
  const pf = layoutPaperFactor(doc);
  const layoutDefs: Array<{ name: string; ents: Ent[]; L: LayoutDef | null }> = [];
  const byRecord = new Map<string, LayoutDef>();
  for (const L of doc.layouts) if (L.blockRecord) byRecord.set(L.blockRecord, L);
  const psBlocks = [...doc.blocks.values()].filter((b) => /^\*paper_space/i.test(b.name));
  const activePs = psBlocks.find((b) => b.name.toUpperCase() === '*PAPER_SPACE');
  // active layout: entities of ENTITIES with 67=1
  {
    const L = activePs ? (byRecord.get(activePs.recordHandle) ?? doc.layouts.find((x) => x.name !== 'Model' && x.blockRecord === activePs.recordHandle) ?? null) : null;
    if (paperEnts.length) layoutDefs.push({ name: L?.name ?? 'Layout1', ents: paperEnts, L });
  }
  for (const b of psBlocks) {
    if (b === activePs) continue;
    if (!b.ents.length) continue;
    const L = byRecord.get(b.recordHandle) ?? null;
    layoutDefs.push({ name: L?.name ?? b.name.replace(/^\*/, ''), ents: b.ents, L });
  }
  layoutDefs.sort((a, b) => (a.L?.tab ?? 99) - (b.L?.tab ?? 99));
  const layerHandles = new Map<string, string>();
  for (const l of doc.layers.values()) if (l.handle) layerHandles.set(l.handle.toUpperCase(), l.name);
  const doViewports = options.viewports !== false;
  r.countOn = false;
  let sheetId = 1;
  for (const ld of layoutDefs) {
    const items: SheetItem[] = [];
    const vps: SheetViewport[] = [];
    const ctx = rootCtx(items, m3Identity());
    const tolSave = r.tol;
    const lim = ld.L && ld.L.limmax[0] > ld.L.limmin[0] && ld.L.limmax[1] > ld.L.limmin[1] ? ld.L : null;
    r.tol = lim ? Math.hypot(lim.limmax[0] - lim.limmin[0], lim.limmax[1] - lim.limmin[1]) / 6000 : 0.05 / pf;
    r.topLevel = false;
    for (const e of ld.ents) {
      if (e.type === 'VIEWPORT') {
        const vp = viewportMatrix(r, e);
        if (!vp || vp.id === 1 || !vp.on) continue;
        // viewport border
        r.load(e);
        const c = r.common();
        const st = r.style(c, ctx, ctx.m);
        const [x0, y0, x1, y1] = vp.box;
        let n = 0;
        if (doViewports && modelEnts.length) {
          const sub: SheetItem[] = [];
          const vctx = rootCtx(sub, vp.m);
          const tolM = r.tol;
          r.tol = tolM;
          r.ltViewScale = hdrNum(doc, '$PSLTSCALE', 70, 1) !== 0 ? vp.scale : 1;
          r.frozenFilter = vp.frozen.length ? new Set(vp.frozen.map((h) => layerHandles.get(h) ?? '').filter(Boolean)) : null;
          r.xlines = [];
          for (const me of modelEnts) r.entity(me, vctx);
          addXlines(sub);
          r.frozenFilter = null;
          r.ltViewScale = 1;
          const clipped = clipItems(sub, vp.box, r.tol);
          for (const it of clipped) items.push(it);
          n = clipped.length;
        }
        if (!(r.doc.layers.get(st.layer)?.plot === false)) items.push({ kind: 'line', pts: [x0, y0, x1, y0, x1, y1, x0, y1, x0, y0], color: st.color, layer: st.layer, w: 0.18 });
        vps.push({ viewId: vp.id, viewName: `Viewport ${vp.id}`, box: [x0, y0, x1, y1], scale: +vp.scale.toPrecision(6), viewType: vp.plan ? 'drafting' : 'other', levelId: null, levelName: null, cutHeight: null, crop: null, detailNumber: null, xform: null, annotations: n });
        continue;
      }
      r.entity(e, ctx);
    }
    addXlines(items);
    r.tol = tolSave;
    // layouts that only hold empty viewport frames are skipped (never set up in the authoring tool)
    if (items.length <= vps.length && vps.every((v) => !v.annotations)) continue;
    // paper extents: limits when valid, else content
    let x0: number, y0: number, w: number, h: number;
    const bb = itemsBounds(items)!;
    if (lim) {
      x0 = Math.min(lim.limmin[0], bb[0]); y0 = Math.min(lim.limmin[1], bb[1]);
      w = Math.max(lim.limmax[0], bb[2]) - x0; h = Math.max(lim.limmax[1], bb[3]) - y0;
    } else {
      const pad = Math.max(bb[2] - bb[0], bb[3] - bb[1]) * 0.02;
      x0 = bb[0] - pad; y0 = bb[1] - pad; w = bb[2] - bb[0] + 2 * pad; h = bb[3] - bb[1] + 2 * pad;
    }
    scaleItems(items, pf, -x0 * pf, -y0 * pf);
    for (const v of vps) v.box = [(v.box[0] - x0) * pf, (v.box[1] - y0) * pf, (v.box[2] - x0) * pf, (v.box[3] - y0) * pf];
    sheets.push({ id: sheetId++, number: '', name: ld.name, size: { w: w * pf, h: h * pf }, items, viewports: vps, completeness: 'full', warnings: [], origin: [x0, y0] });
  }

  // ---- model sheet (first)
  const modelSheet: RvtSheet2D = (() => {
    const bb = modelBounds ?? [0, 0, 1, 1];
    const pad = Math.max(bb[2] - bb[0], bb[3] - bb[1]) * 0.02 || 1;
    const x0 = bb[0] - pad, y0 = bb[1] - pad;
    // model space has no paper: draw default lines thin relative to the drawing (AutoCAD shows them one pixel wide)
    // and keep plotted lineweights from dominating small drawings
    const diag = Math.hypot(bb[2] - bb[0], bb[3] - bb[1]) * unitMm;
    const thin = +Math.min(0.18, diag / 4000).toPrecision(3), wmax = Math.max(thin, diag / 800);
    for (const it of modelItems) {
      if (it.kind !== 'line' && it.kind !== 'arc') continue;
      if (it.w === undefined) it.w = thin;
      else if (it.w > wmax && (it as { wu?: number }).wu === undefined) it.w = +wmax.toPrecision(3);
    }
    scaleItems(modelItems, unitMm, -x0 * unitMm, -y0 * unitMm);
    return {
      id: 0, number: '', name: 'Model', size: { w: (bb[2] - bb[0] + 2 * pad) * unitMm, h: (bb[3] - bb[1] + 2 * pad) * unitMm },
      items: modelItems, viewports: [], completeness: 'full', warnings: [], origin: [x0, y0],
    };
  })();
  const all = [modelSheet, ...sheets];
  if (!modelItems.length && sheets.length) all.shift();
  const uw = unsupportedWarn();
  if (r.truncated) r.warnOnce(`drawing cut at ${r.maxItems} items per sheet`);
  for (const s of all) {
    if (uw.length || r.truncated) s.completeness = 'partial';
    s.warnings.push(...r.warnings, ...uw);
  }
  warnings.push(...r.warnings, ...uw);

  // ---- layers
  const layers: LayerInfo[] = doc.layerOrder.map((name) => {
    const l = doc.layers.get(name)!;
    return { name, color: l.trueColor != null ? trueColorHex(l.trueColor) : aciHex(l.color), visible: !l.off && !l.frozen, frozen: l.frozen, items: r.layerItems.get(name) ?? 0 };
  });
  // layers used but not in the table
  for (const [name, n] of r.layerItems) if (!doc.layers.has(name)) layers.push({ name, color: '#000000', visible: true, items: n });

  const acadver = tk.acadver ?? hdrStr(doc, '$ACADVER') ?? '';
  const info: CadInfo = {
    format: tk.binary ? 'DXF (binary)' : 'DXF (ASCII)',
    version: acadver ? `${acadver}${VERSIONS[acadver] ? ' (' + VERSIONS[acadver] + ')' : ''}` : 'unknown (no $ACADVER)',
    encoding: tk.encoding,
    units: UNIT_NAME[insunits] ?? String(insunits),
    unitToMm: unitMm,
    entities: doc.entities.length,
    blocks: doc.blocks.size,
    layers: layers.length,
    layouts: sheets.length,
    items: all.reduce((a, s) => a + s.items.length, 0),
    ms: Date.now() - t0,
  };
  for (const [kk, v] of [...r.counts].sort((a, b) => b[1] - a[1]).slice(0, 12)) info['count.' + kk] = v;
  onProgress?.('done', 1);

  // ---- 3D decision
  if (col3d && col3d.faces > 0) {
    // mostly 3D: at least half of the top-level model entities produced faces
    const faceEnts = col3d.faceElems.size;
    if (faceEnts >= modelEnts.length * 0.5) {
      const geometry = buildGeometry(col3d, unitMm / 1000, Date.now() - t0, warnings);
      info.triangles = geometry.stats.triangles;
      return { kind: '3d', geometry, info, sheets: all, layers };
    }
  }
  return { kind: '2d', sheets: all, layers, info };
}

function buildGeometry(col: Collector3D, toM: number, ms: number, warnings: string[]): RvtGeometry {
  const buckets: GeomBucket[] = [];
  const edges: Array<{ category: number | null; categoryName?: string | null; positions: Float32Array }> = [];
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let tris = 0;
  for (const b of col.buckets.values()) {
    if (b.idx.length === 0 && b.edges.length === 0) continue;
    const pos = new Float32Array(b.pos.length);
    for (let i = 0; i < b.pos.length; i++) {
      const v = b.pos[i] * toM;
      pos[i] = v;
      const k = i % 3;
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
    if (b.idx.length) {
      buckets.push({ category: null, categoryName: b.layer, color: b.color, positions: pos, normals: new Float32Array(b.nrm), indices: new Uint32Array(b.idx), ranges: b.ranges });
      tris += b.idx.length / 3;
    }
    if (b.edges.length) {
      const ep = new Float32Array(b.edges.length);
      for (let i = 0; i < ep.length; i++) {
        const v = b.edges[i] * toM;
        ep[i] = v;
        const k = i % 3;
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
      edges.push({ category: null, categoryName: b.layer, positions: ep });
    }
  }
  const elements = [...col.elements.values()].map((e) => {
    if (e.bbox) {
      e.bbox = { min: [e.bbox.min[0] * toM, e.bbox.min[1] * toM, e.bbox.min[2] * toM], max: [e.bbox.max[0] * toM, e.bbox.max[1] * toM, e.bbox.max[2] * toM] };
    }
    return e;
  });
  if (!isFinite(min[0])) { min.fill(0); max.fill(0); }
  return {
    units: 'm', up: 'z', bbox: { min, max }, buckets, edges, elements,
    stats: { elements: elements.length, triangles: tris, skippedFaces: 0, ms }, warnings: [...warnings],
  };
}
