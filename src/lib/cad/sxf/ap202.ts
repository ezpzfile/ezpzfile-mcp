// SXF P21 files without feature comments: generic ISO 10303-202 (AP202 associative draughting) reader (own code).
//
// HONEST NOTE: the SXF mapping of features to AP202 entities ("SXF 表現仕様書") is not publicly available to us
// and no public pure-AP202 SXF sample was found (see NOTEBOOK.md). This reader therefore follows the generic
// meaning of the ISO 10303 integrated resources that AP202 uses (parts 42 geometry, 46 presentation, 101 draughting):
//   representations (name, items, context) and MAPPED_ITEM / REPRESENTATION_MAP for placed figures,
//   STYLED_ITEM and the ANNOTATION_*_OCCURRENCE subtypes with CURVE_STYLE / TEXT_STYLE / FILL_AREA_STYLE,
//   PRESENTATION_LAYER_ASSIGNMENT and INVISIBILITY for layers, PRESENTATION_SIZE / PLANAR_BOX for the paper,
//   DRAUGHTING_PRE_DEFINED_COLOUR / COLOUR_RGB, DRAUGHTING_PRE_DEFINED_CURVE_FONT / CURVE_STYLE_FONT,
//   LINE, CIRCLE, ELLIPSE, POLYLINE, TRIMMED_CURVE, COMPOSITE_CURVE, B_SPLINE_CURVE_WITH_KNOTS, BEZIER_CURVE,
//   TEXT_LITERAL (+ _WITH_EXTENT), ANNOTATION_FILL_AREA, DEFINED_SYMBOL with predefined terminator / marker symbols.
// The only SXF specific P21 fragment we have seen is the line feature example in NILIM TN 403 chapter 6
// (CARTESIAN_POINT, DIRECTION, VECTOR, LINE, TRIMMED_CURVE, CURVE_STYLE, PRESENTATION_STYLE_ASSIGNMENT and a
// complex ANNOTATION_CURVE_OCCURRENCE ... STYLED_ITEM instance); the reader handles exactly that form.

import type { LayerInfo, RvtSheet2D } from './types.ts';
import { CadError } from './types.ts';
import { StepFile, Ref, Enum, Typed, type Arg } from './step.ts';
import type { FeatureOptions, FeatureResult } from './feature.ts';
import { I2, Out, type Style, type T2, ap, lin, tInv, tMul, tScale } from './out.ts';
import { PRE_COLOURS, PRE_LINETYPES, rgbHex, preColourCode, preLinetypeCode } from './tables.ts';
import { hatchLines } from './hatch.ts';
import { itemsBounds } from './geom.ts';

const ARROWS = ['blanked arrow', 'blanked box', 'blanked dot', 'dimension origin', 'filled box', 'filled arrow', 'filled dot', 'integral symbol', 'open arrow', 'slash', 'unfilled arrow'];
const MARKERS = ['asterisk', 'circle', 'dot', 'plus', 'square', 'triangle', 'x'];

interface Sty { color?: string; w?: number; dash?: number[]; fill?: Arg[]; textH?: number; textW?: number; hatch?: Arg[] }

export function readAp202(bytes: Uint8Array, opts: FeatureOptions, onProgress?: (s: string, r: number) => void): FeatureResult {
  let f: StepFile;
  try { f = new StepFile(bytes, onProgress); } catch (e) {
    const c = (e as { code?: string }).code;
    throw new CadError(c === 'too-large' ? 'too-large' : c === 'not-format' ? 'not-format' : 'corrupt', (e as Error).message);
  }
  return new Ap202(f, opts).run();
}

class Ap202 {
  f: StepFile;
  out: Out;
  opts: FeatureOptions;
  layerOf = new Map<number, string>();
  layerNames: string[] = [];
  hiddenLayers = new Set<string>();
  invisible = new Set<number>();
  mapsOfRep = new Map<number, number[]>();
  drawn = 0;
  unknown = new Map<string, number>();
  styleCache = new Map<number, Sty>();

  constructor(f: StepFile, opts: FeatureOptions) {
    this.f = f; this.opts = opts;
    this.out = new Out(opts.maxItems ?? 3e6);
    for (const w of f.warnings) this.out.warn(w);
  }

  // ------------------------------------------------------------------ generic access
  /** attribute list of an entity, merged over all partials of a complex instance (partial order kept) */
  attrs(id: number): Arg[] {
    const cx = this.f.cx(id);
    if (!cx) return this.f.args(id) ?? [];
    const out: Arg[] = [];
    for (const v of cx.values()) out.push(...v);
    return out;
  }
  partial(id: number, name: string): Arg[] | null {
    const cx = this.f.cx(id);
    if (cx) return cx.get(name) ?? null;
    return this.f.typeOf(id) === name ? this.f.args(id) : null;
  }
  types(id: number): string[] {
    const t = this.f.typeOf(id);
    if (t) return [t];
    const cx = this.f.cx(id);
    return cx ? [...cx.keys()] : [];
  }
  is(id: number, ...names: string[]): boolean { const ts = this.types(id); return ts.some((t) => names.includes(t)); }
  has(id: number, re: RegExp): boolean { return this.types(id).some((t) => re.test(t)); }
  pt(v: Arg): [number, number] | null {
    if (!(v instanceof Ref)) return null;
    const a = this.attrs(v.id);
    for (const x of a) if (Array.isArray(x) && x.length >= 2 && typeof x[0] === 'number') return [x[0] as number, x[1] as number];
    return null;
  }
  dir(v: Arg): [number, number] | null {
    if (!(v instanceof Ref)) return null;
    if (this.is(v.id, 'VECTOR')) {
      const a = this.attrs(v.id);
      let d: [number, number] | null = null, m = 1;
      for (const x of a) { if (x instanceof Ref) d = this.dir(x); else if (typeof x === 'number') m = x; }
      return d ? [d[0] * m, d[1] * m] : null;
    }
    const p = this.pt(v);
    return p;
  }
  /** AXIS2_PLACEMENT_2D -> transform */
  placement(v: Arg): T2 {
    if (!(v instanceof Ref)) return I2;
    const a = this.attrs(v.id);
    let o: [number, number] = [0, 0], d: [number, number] = [1, 0];
    let first = true;
    for (const x of a) {
      if (!(x instanceof Ref)) continue;
      if (first) { o = this.pt(x) ?? o; first = false; } else { const q = this.dir(x); if (q) d = q; }
    }
    const l = Math.hypot(d[0], d[1]) || 1;
    const c = d[0] / l, s = d[1] / l;
    return [c, s, -s, c, o[0], o[1]];
  }
  /** mapping target: AXIS2_PLACEMENT_2D or CARTESIAN_TRANSFORMATION_OPERATOR_2D (axis1, axis2, origin, scale) */
  target(v: Arg): T2 {
    if (!(v instanceof Ref)) return I2;
    if (!this.has(v.id, /CARTESIAN_TRANSFORMATION_OPERATOR/)) return this.placement(v);
    const a = this.attrs(v.id);
    const dirs: Array<[number, number] | null> = [];
    let o: [number, number] = [0, 0];
    const sc: number[] = [];
    for (const x of a) {
      if (x instanceof Ref) {
        if (this.is(x.id, 'CARTESIAN_POINT')) o = this.pt(x) ?? o;
        else dirs.push(this.dir(x));
      } else if (x === null && dirs.length < 2) dirs.push(null);
      else if (typeof x === 'number') sc.push(x);
    }
    let d1 = dirs[0] ?? [1, 0];
    const l1 = Math.hypot(d1[0], d1[1]) || 1;
    d1 = [d1[0] / l1, d1[1] / l1];
    let d2 = dirs[1] ?? [-d1[1], d1[0]];
    const l2 = Math.hypot(d2[0], d2[1]) || 1;
    d2 = [d2[0] / l2, d2[1] / l2];
    const s1 = sc[0] && sc[0] > 0 ? sc[0] : 1, s2 = sc[1] && sc[1] > 0 ? sc[1] : s1;
    return [d1[0] * s1, d1[1] * s1, d2[0] * s2, d2[1] * s2, o[0], o[1]];
  }
  firstNum(v: Arg, depth = 0): number | null {
    if (typeof v === 'number') return v;
    if (v instanceof Typed) return this.firstNum(v.val, depth + 1);
    if (Array.isArray(v)) { for (const x of v) { const n = this.firstNum(x, depth + 1); if (n !== null) return n; } return null; }
    if (v instanceof Ref && depth < 4) { for (const x of this.attrs(v.id)) { const n = this.firstNum(x, depth + 1); if (n !== null) return n; } }
    return null;
  }
  firstStr(v: Arg): string { const a = v instanceof Ref ? this.attrs(v.id) : []; for (const x of a) if (typeof x === 'string' && x.trim()) return x; return ''; }

  // ------------------------------------------------------------------ styles
  colour(v: Arg): string | undefined {
    if (!(v instanceof Ref)) return undefined;
    if (this.has(v.id, /COLOUR_RGB/)) {
      const n = this.attrs(v.id).filter((x) => typeof x === 'number') as number[];
      if (n.length >= 3) { const k = n.every((x) => x <= 1) ? 255 : 1; return rgbHex(n[0] * k, n[1] * k, n[2] * k); }
    }
    const name = this.firstStr(v);
    const code = preColourCode(name);
    if (code) {
      if (code === 8 && this.opts.whiteToBlack !== false) return '#000000';
      const c = PRE_COLOURS[code - 1];
      return rgbHex(c[1], c[2], c[3]);
    }
    return undefined;
  }
  font(v: Arg): number[] | undefined {
    if (!(v instanceof Ref)) return undefined;
    if (this.has(v.id, /CURVE_STYLE_FONT$/)) {
      const a = this.attrs(v.id);
      const pat: number[] = [];
      for (const x of a) if (Array.isArray(x)) for (const p of x) if (p instanceof Ref) { const n = this.attrs(p.id).filter((q) => typeof q === 'number') as number[]; if (n.length >= 2) pat.push(n[0], n[1]); }
      return pat.length ? pat : undefined;
    }
    const code = preLinetypeCode(this.firstStr(v));
    if (code) { const d = PRE_LINETYPES[code - 1][1]; return d.length ? d : undefined; }
    return undefined;
  }
  style(styles: Arg): Sty {
    const st: Sty = {};
    const visit = (id: number, depth: number) => {
      if (depth > 6) return;
      const c = this.styleCache.get(id);
      if (c) { Object.assign(st, c); return; }
      const ts = this.types(id);
      const a = this.attrs(id);
      if (ts.includes('PRESENTATION_STYLE_ASSIGNMENT') || ts.includes('PRESENTATION_STYLE_BY_CONTEXT')) {
        for (const x of a) if (Array.isArray(x)) for (const y of x) if (y instanceof Ref) visit(y.id, depth + 1); else if (y instanceof Typed && y.val instanceof Ref) visit(y.val.id, depth + 1);
      } else if (ts.some((t) => /^CURVE_STYLE$/.test(t))) {
        // name, curve_font, curve_width, curve_colour
        const [, fnt, wid, col] = a;
        st.dash = this.font(fnt);
        const w = this.firstNum(wid as Arg);
        if (w !== null && w > 0 && w < 50) st.w = w;
        st.color = this.colour(col) ?? st.color;
      } else if (ts.some((t) => /^TEXT_STYLE/.test(t))) {
        for (const x of a) {
          if (x instanceof Ref) { const k = this.attrs(x.id); for (const y of k) { const cc = this.colour(y); if (cc) st.color = cc; } }
          if (Array.isArray(x)) for (const y of x) if (y instanceof Typed) {
            const n = this.firstNum(y.val);
            if (n !== null && /BOX_HEIGHT/.test(y.type)) st.textH = n;
            if (n !== null && /BOX_WIDTH/.test(y.type)) st.textW = n;
          }
        }
      } else if (ts.some((t) => /^FILL_AREA_STYLE$/.test(t))) {
        for (const x of a) if (Array.isArray(x)) st.fill = x;
      } else if (ts.some((t) => /^SYMBOL_STYLE|^POINT_STYLE/.test(t))) {
        for (const x of a) { const cc = this.colour(x); if (cc) st.color = cc; if (x instanceof Ref) for (const y of this.attrs(x.id)) { const c2 = this.colour(y); if (c2) st.color = c2; } }
      }
    };
    for (const x of Array.isArray(styles) ? styles : [styles]) if (x instanceof Ref) visit(x.id, 0);
    return st;
  }

  // ------------------------------------------------------------------ run
  run(): FeatureResult {
    const f = this.f;
    // layers
    for (const id of f.idsOfType('PRESENTATION_LAYER_ASSIGNMENT', 'PRESENTATION_LAYER_USAGE')) {
      const a = f.args(id) ?? [];
      const name = (typeof a[0] === 'string' && a[0]) || `layer${this.layerNames.length + 1}`;
      if (!this.layerNames.includes(name)) this.layerNames.push(name);
      for (const x of Array.isArray(a[2]) ? a[2] : []) if (x instanceof Ref) this.layerOf.set(x.id, name);
    }
    for (const id of f.idsOfType('INVISIBILITY')) {
      const a = f.args(id) ?? [];
      for (const x of Array.isArray(a[0]) ? a[0] : []) if (x instanceof Ref) {
        if (f.typeOf(x.id) === 'PRESENTATION_LAYER_ASSIGNMENT') { const n = f.args(x.id)?.[0]; if (typeof n === 'string') this.hiddenLayers.add(n); }
        else this.invisible.add(x.id);
      }
    }
    // representation maps: representation -> maps; and which representations are mapped
    const mapped = new Set<number>();
    for (const id of f.idsOfType('REPRESENTATION_MAP', 'SYMBOL_REPRESENTATION_MAP', 'DRAUGHTING_SYMBOL_REPRESENTATION_MAP')) {
      const a = f.args(id) ?? [];
      if (a[1] instanceof Ref) mapped.add(a[1].id);
    }
    // representations = instances whose type name contains REPRESENTATION / DRAWING_SHEET / PRESENTATION_VIEW / AREA
    const reps: number[] = [];
    for (let k = 0; k < f.ids.length; k++) {
      const id = f.ids[k];
      const ts = this.types(id);
      if (!ts.some((t) => /REPRESENTATION$|^DRAWING_SHEET_REVISION$|^PRESENTATION_VIEW$|^PRESENTATION_AREA$|^DRAWING_SHEET$|^PRESENTATION_REPRESENTATION/.test(t) && !/_MAP$|RELATIONSHIP|CONTEXT/.test(t))) continue;
      const a = this.partial(id, 'REPRESENTATION') ?? this.attrs(id);
      if (Array.isArray(a[1])) reps.push(id);
    }
    let roots = reps.filter((r) => !mapped.has(r));
    const sheets = roots.filter((r) => this.has(r, /DRAWING_SHEET/));
    if (sheets.length) roots = sheets;
    else {
      const areas = roots.filter((r) => this.has(r, /PRESENTATION_AREA/));
      if (areas.length) roots = areas;
    }
    if (roots.length > 1) {
      // keep roots that actually hold drawable items
      const big = roots.filter((r) => ((this.partial(r, 'REPRESENTATION') ?? this.attrs(r))[1] as Arg[]).length > 0);
      if (big.length) roots = big;
      if (roots.length > 1) this.out.warn(`${roots.length} top level representations drawn on one sheet`);
    }
    const seenStyled = new Set<number>();
    for (const r of roots) this.drawRep(r, I2, null, 0, seenStyled);
    if (!roots.length || !this.drawn) {
      // fallback: draw every styled annotation at its own coordinates
      for (const id of f.idsOfType('STYLED_ITEM', 'ANNOTATION_CURVE_OCCURRENCE', 'ANNOTATION_TEXT_OCCURRENCE', 'ANNOTATION_FILL_AREA_OCCURRENCE', 'ANNOTATION_SYMBOL_OCCURRENCE', 'ANNOTATION_OCCURRENCE', 'DRAUGHTING_ANNOTATION_OCCURRENCE', 'OVER_RIDING_STYLED_ITEM')) this.drawItem(id, I2, null, 0, seenStyled);
      for (let k = 0; k < f.ids.length; k++) { const id = f.ids[k]; if (!f.typeOf(id) && this.has(id, /STYLED_ITEM/)) this.drawItem(id, I2, null, 0, seenStyled); }
      if (this.drawn) this.out.warn('no drawing sheet representation found: annotations drawn at their own coordinates');
    }
    if (!this.drawn) throw new CadError('unsupported-version', 'P21 file has no SXF feature comments and no drawable AP202 annotation entities');
    for (const [k, n] of this.unknown) this.out.warn(`${n} ${k} not drawn`);
    this.out.warn('pure AP202 P21 reading is generic (no public SXF P21 mapping or sample was available); check the drawing');

    // paper
    let w = 0, h = 0;
    for (const id of f.idsOfType('PRESENTATION_SIZE')) {
      const a = f.args(id) ?? [];
      if (a[1] instanceof Ref) { const n = this.attrs(a[1].id).filter((x) => typeof x === 'number') as number[]; if (n.length >= 2 && n[0] * n[1] > w * h) { w = n[0]; h = n[1]; } }
    }
    if (!(w > 0 && h > 0)) {
      for (const id of f.idsOfType('PLANAR_BOX')) { const n = (f.args(id) ?? []).filter((x) => typeof x === 'number') as number[]; if (n.length >= 2 && n[0] * n[1] > w * h) { w = n[0]; h = n[1]; } }
    }
    if (!(w > 0 && h > 0)) {
      const bb = itemsBounds(this.out.items);
      w = bb ? Math.max(1, bb[2]) : 420; h = bb ? Math.max(1, bb[3]) : 297;
      this.out.warn('paper size missing, taken from the drawing extents');
    }
    const sheetName = roots.length ? ((this.partial(roots[0], 'REPRESENTATION') ?? this.attrs(roots[0]))[0] as string) || 'SXF' : 'SXF';
    const sheet: RvtSheet2D = { id: 1, number: sheetName, name: sheetName, size: { w, h }, items: this.out.items, viewports: [], completeness: 'partial', warnings: [...this.out.warnings] };
    const layers: LayerInfo[] = [];
    const names = [...this.layerNames, ...[...this.out.layerUse.keys()].filter((n) => !this.layerNames.includes(n))];
    for (const n of names) {
      const u = this.out.layerUse.get(n);
      let best = '#000000', bn = -1;
      if (u) for (const [c, k] of u.colors) if (k > bn) { bn = k; best = c; }
      layers.push({ name: n, color: best, visible: !this.hiddenLayers.has(n), items: u?.n ?? 0 });
    }
    return { sheet, layers, info: { paper: `${w}x${h}`, layers: this.layerNames.length, entities: f.ids.length } };
  }

  private drawRep(rep: number, t: T2, layer: string | null, depth: number, seen: Set<number>) {
    if (depth > 24) { this.out.warn('placed figures nested too deep'); return; }
    const a = this.partial(rep, 'REPRESENTATION') ?? this.attrs(rep);
    const items = Array.isArray(a[1]) ? a[1] : [];
    for (const x of items) if (x instanceof Ref) this.drawItem(x.id, t, layer, depth, depth === 0 ? seen : new Set());
  }

  private drawItem(id: number, t: T2, layer: string | null, depth: number, seen: Set<number>) {
    if (seen.has(id) || this.invisible.has(id)) return;
    seen.add(id);
    const ly = this.layerOf.get(id) ?? layer;
    const ts = this.types(id);
    try {
      if (ts.some((t2) => /STYLED_ITEM|_OCCURRENCE$/.test(t2))) { this.styled(id, t, ly, depth, seen); return; }
      if (ts.some((t2) => /MAPPED_ITEM$|^ANNOTATION_SYMBOL$|^ANNOTATION_TEXT$|^ANNOTATION_SUBFIGURE/.test(t2))) { this.mappedItem(id, t, ly, depth, seen); return; }
      if (ts.some((t2) => /CALLOUT$|^DRAUGHTING_ELEMENTS|^DIMENSION|^LEADER/.test(t2))) {
        for (const x of this.attrs(id)) if (Array.isArray(x)) for (const y of x) if (y instanceof Ref) this.drawItem(y.id, t, ly, depth, seen);
        return;
      }
      // bare geometry inside a representation: default style
      this.geom(id, t, {}, ly ?? '0', depth, seen);
    } catch (e) { this.out.warn(`#${id}: ${(e as Error).message}`); }
  }

  private mappedItem(id: number, t: T2, layer: string | null, depth: number, seen: Set<number>) {
    const a = this.partial(id, 'MAPPED_ITEM') ?? this.attrs(id);
    const refsA = a.filter((x) => x instanceof Ref) as Ref[];
    const src = refsA[0], tgt = refsA[1];
    if (!src) return;
    const m = this.f.args(src.id) ?? [];
    const origin = this.placement(m[0]);
    const inv = tInv(origin) ?? I2;
    const tt = tMul(t, tMul(this.target(tgt ?? null), inv));
    if (m[1] instanceof Ref) this.drawRep(m[1].id, tt, layer, depth + 1, seen);
  }

  private styled(id: number, t: T2, layer: string | null, depth: number, seen: Set<number>) {
    const a = this.attrs(id);
    let styles: Arg = null, item: Ref | null = null;
    for (let k = 0; k < a.length; k++) {
      const x = a[k];
      if (styles === null && Array.isArray(x) && x.some((y) => y instanceof Ref)) { styles = x; continue; }
      if (styles !== null && x instanceof Ref && !item) item = x;
    }
    if (!item) return;
    const st = this.style(styles);
    const ly = layer ?? this.layerOf.get(item.id) ?? '0';
    this.geom(item.id, t, st, ly, depth, seen);
  }

  private stl(st: Sty, layer: string): Style { return { layer, color: st.color ?? '#000000', w: st.w, dash: st.dash }; }

  /** draw a geometric / annotation item */
  private geom(id: number, t: T2, st: Sty, layer: string, depth: number, seen: Set<number>) {
    const out = this.out;
    const ts = this.types(id);
    const T = ts.join('+');
    this.drawn++;
    if (/MAPPED_ITEM|ANNOTATION_SYMBOL$|ANNOTATION_TEXT$/.test(T)) { this.mappedItem(id, t, layer, depth, seen); return; }
    if (/TEXT_LITERAL/.test(T)) { this.textLit(id, t, st, layer); return; }
    if (/COMPOSITE_TEXT/.test(T)) {
      for (const x of this.attrs(id)) if (Array.isArray(x)) for (const y of x) if (y instanceof Ref) this.geom(y.id, t, st, layer, depth, seen);
      return;
    }
    if (/ANNOTATION_FILL_AREA/.test(T)) { this.fillArea(id, t, st, layer); return; }
    if (/DEFINED_SYMBOL/.test(T)) { this.definedSymbol(id, t, st, layer); return; }
    if (/^CARTESIAN_POINT$/.test(T)) {
      const p = this.pt(new Ref(id));
      if (p) { const [x, y] = ap(t, p[0], p[1]); out.marker(4, 1, x, y, 0, st.color ?? '#000000', layer); }
      return;
    }
    if (/GEOMETRIC_SET|GEOMETRIC_CURVE_SET/.test(T)) {
      for (const x of this.attrs(id)) if (Array.isArray(x)) for (const y of x) if (y instanceof Ref) this.geom(y.id, t, st, layer, depth, seen);
      return;
    }
    const pts = this.curve(id, t, 0);
    if (pts) {
      if (pts.arc) out.arc(t, pts.arc[0], pts.arc[1], pts.arc[2], pts.arc[3], pts.arc[4], this.stl(st, layer));
      else out.poly(t, pts.pts, this.stl(st, layer));
      return;
    }
    this.drawn--;
    this.unknown.set(T || '?', (this.unknown.get(T || '?') ?? 0) + 1);
  }

  /** curve -> local points (or a circular arc when exact) */
  curve(id: number, t: T2, depth: number): { pts: number[]; arc?: [number, number, number, number, number] } | null {
    if (depth > 8) return null;
    const T = this.types(id).join('+');
    const a = this.attrs(id);
    const out = this.out;
    if (/^POLYLINE$/.test(T)) {
      const pts: number[] = [];
      for (const x of a) if (Array.isArray(x)) for (const r of x) { const p = this.pt(r); if (p) pts.push(p[0], p[1]); }
      return { pts };
    }
    if (/TRIMMED_CURVE/.test(T)) {
      const basis = a.find((x) => x instanceof Ref) as Ref | undefined;
      const lists = a.filter((x) => Array.isArray(x)) as Arg[][];
      const sense = a.find((x) => x instanceof Enum && (x.v === 'T' || x.v === 'F')) as Enum | undefined;
      const fwd = !sense || sense.v === 'T';
      if (!basis) return null;
      const bt = this.types(basis.id).join('+');
      const ba = this.attrs(basis.id);
      const trim = (l: Arg[] | undefined): { p?: [number, number]; u?: number } => {
        const r: { p?: [number, number]; u?: number } = {};
        for (const x of l ?? []) {
          if (x instanceof Ref) r.p = this.pt(x) ?? r.p;
          else if (x instanceof Typed) { const n = this.firstNum(x.val); if (n !== null) r.u = n; }
          else if (typeof x === 'number') r.u = x;
        }
        return r;
      };
      const t1 = trim(lists[0]), t2 = trim(lists[1]);
      if (/^LINE$/.test(bt)) {
        const p0 = this.pt(ba.find((x) => x instanceof Ref) ?? null) ?? [0, 0];
        const refsB = ba.filter((x) => x instanceof Ref) as Ref[];
        const v = this.dir(refsB[1] ?? null) ?? [1, 0];
        const at = (r: { p?: [number, number]; u?: number }) => r.p ?? (r.u !== undefined ? [p0[0] + v[0] * r.u, p0[1] + v[1] * r.u] as [number, number] : null);
        const q1 = at(t1), q2 = at(t2);
        if (!q1 || !q2) return null;
        return { pts: fwd ? [q1[0], q1[1], q2[0], q2[1]] : [q2[0], q2[1], q1[0], q1[1]] };
      }
      if (/CIRCLE|ELLIPSE/.test(bt)) {
        const pl = this.placement(ba.find((x) => x instanceof Ref) ?? null);
        const nums = ba.filter((x) => typeof x === 'number') as number[];
        const rx = nums[0] ?? 1, ry = /ELLIPSE/.test(bt) ? nums[1] ?? rx : rx;
        const inv = tInv(pl) ?? I2;
        const ang = (r: { p?: [number, number]; u?: number }) => {
          if (r.u !== undefined && !r.p) return (r.u * Math.PI) / 180; // AP202 plane angle unit: degrees assumed for SXF
          if (!r.p) return 0;
          const [lx, ly] = ap(inv, r.p[0], r.p[1]);
          return Math.atan2(ly / ry, lx / rx);
        };
        const u1 = ang(t1), u2 = ang(t2);
        let sw = fwd ? u2 - u1 : u1 - u2;
        while (sw <= 1e-12) sw += Math.PI * 2;
        const start = fwd ? u1 : u1;
        const sweep = fwd ? sw : -sw;
        const rot = (Math.atan2(pl[1], pl[0]) * 180) / Math.PI;
        if (Math.abs(rx - ry) < 1e-12) {
          return { pts: [], arc: [pl[4], pl[5], rx, start + Math.atan2(pl[1], pl[0]), sweep] };
        }
        return { pts: out.ellipsePts(t, pl[4], pl[5], rx, ry, rot, start, sweep) };
      }
      const inner = this.curve(basis.id, t, depth + 1);
      return inner;
    }
    if (/^CIRCLE$|^ELLIPSE$/.test(T)) {
      const pl = this.placement(a.find((x) => x instanceof Ref) ?? null);
      const nums = a.filter((x) => typeof x === 'number') as number[];
      const rx = nums[0] ?? 1, ry = T === 'ELLIPSE' ? nums[1] ?? rx : rx;
      if (rx === ry) return { pts: [], arc: [pl[4], pl[5], rx, 0, Math.PI * 2] };
      return { pts: out.ellipsePts(t, pl[4], pl[5], rx, ry, (Math.atan2(pl[1], pl[0]) * 180) / Math.PI, 0, Math.PI * 2) };
    }
    if (/^LINE$/.test(T)) return null;
    if (/COMPOSITE_CURVE/.test(T)) {
      const pts: number[] = [];
      for (const x of a) if (Array.isArray(x)) for (const s of x) if (s instanceof Ref) {
        const sa = this.attrs(s.id);
        const parent = sa.find((y) => y instanceof Ref) as Ref | undefined;
        const same = sa.find((y) => y instanceof Enum && (y.v === 'T' || y.v === 'F')) as Enum | undefined;
        if (!parent) continue;
        const c = this.curve(parent.id, t, depth + 1);
        if (!c) continue;
        let p = c.pts;
        if (c.arc) p = out.ellipsePts(t, c.arc[0], c.arc[1], c.arc[2], c.arc[2], 0, c.arc[3], c.arc[4]);
        if (same && same.v === 'F') { const r: number[] = []; for (let i = p.length - 2; i >= 0; i -= 2) r.push(p[i], p[i + 1]); p = r; }
        const s0 = pts.length >= 2 && p.length >= 2 && Math.abs(pts[pts.length - 2] - p[0]) < 1e-9 && Math.abs(pts[pts.length - 1] - p[1]) < 1e-9 ? 2 : 0;
        for (let i = s0; i < p.length; i++) pts.push(p[i]);
      }
      return { pts };
    }
    if (/B_SPLINE_CURVE|BEZIER_CURVE/.test(T)) return { pts: this.bspline(id, t) };
    return null;
  }

  private bspline(id: number, t: T2): number[] {
    const bs = this.partial(id, 'B_SPLINE_CURVE') ?? this.attrs(id);
    // name, degree, control points, form, closed, self intersect
    const deg = (bs.find((x) => typeof x === 'number') as number) ?? 3;
    const cpl = bs.find((x) => Array.isArray(x) && x.length && x[0] instanceof Ref) as Arg[] | undefined;
    if (!cpl) return [];
    const P: number[][] = [];
    for (const r of cpl) { const p = this.pt(r); if (p) P.push(p); }
    const n = P.length;
    if (n < 2) return [];
    let knots: number[] = [];
    const kw = this.partial(id, 'B_SPLINE_CURVE_WITH_KNOTS');
    if (kw) {
      const arrs = kw.filter((x) => Array.isArray(x)) as number[][];
      const mult = arrs[0] ?? [], ks = arrs[1] ?? [];
      for (let i = 0; i < ks.length; i++) for (let k = 0; k < (mult[i] ?? 1); k++) knots.push(ks[i]);
    }
    const p = Math.max(1, Math.min(deg, n - 1));
    if (knots.length !== n + p + 1) {
      // Bezier / uniform clamped
      knots = [];
      for (let i = 0; i <= p; i++) knots.push(0);
      const inner = n - p - 1;
      for (let i = 1; i <= inner; i++) knots.push(i / (inner + 1));
      for (let i = 0; i <= p; i++) knots.push(1);
    }
    const rw = this.partial(id, 'RATIONAL_B_SPLINE_CURVE');
    const W = rw ? ((rw.find((x) => Array.isArray(x)) as number[]) ?? []) : [];
    const u0 = knots[p], u1 = knots[n];
    const segs = Math.min(2000, Math.max(16, n * 12));
    const out: number[] = [];
    for (let s = 0; s <= segs; s++) {
      const u = u0 + ((u1 - u0) * s) / segs;
      // de Boor
      let k = p;
      while (k < n - 1 && u >= knots[k + 1]) k++;
      const d: number[][] = [];
      for (let j = 0; j <= p; j++) { const q = P[k - p + j]; const w = W[k - p + j] ?? 1; d.push([q[0] * w, q[1] * w, w]); }
      for (let r = 1; r <= p; r++) for (let j = p; j >= r; j--) {
        const i = k - p + j;
        const den = knots[i + p - r + 1] - knots[i];
        const al = den > 0 ? (u - knots[i]) / den : 0;
        for (let c = 0; c < 3; c++) d[j][c] = (1 - al) * d[j - 1][c] + al * d[j][c];
      }
      const w = d[p][2] || 1;
      out.push(d[p][0] / w, d[p][1] / w);
    }
    void t;
    return out;
  }

  private textLit(id: number, t: T2, st: Sty, layer: string) {
    const a = this.partial(id, 'TEXT_LITERAL') ?? this.attrs(id);
    // name, literal, placement, alignment, path, font
    const s = typeof a[1] === 'string' ? a[1] : '';
    const pl = this.placement(a[2] ?? null);
    const align = typeof a[3] === 'string' ? a[3].toLowerCase() : '';
    const path = a[4] instanceof Enum ? a[4].v : 'RIGHT';
    let h = st.textH ?? 0, w = st.textW ?? 0;
    const ext = this.partial(id, 'TEXT_LITERAL_WITH_EXTENT');
    if (ext) { const e = ext.find((x) => x instanceof Ref) as Ref | undefined; if (e) { const n = this.attrs(e.id).filter((x) => typeof x === 'number') as number[]; if (n.length >= 2) { w = w || n[0]; h = h || n[1]; } } }
    if (!(h > 0)) h = 2.5;
    const col = /center|centre/.test(align) ? 1 : /right|end/.test(align) ? 2 : 0;
    const row = /top/.test(align) ? 2 : /middle|half/.test(align) ? 1 : 0;
    const ang = (Math.atan2(pl[1], pl[0]) * 180) / Math.PI;
    this.out.text(t, s, pl[4], pl[5], h, w, 0, ang, row * 3 + col + 1, path === 'DOWN' ? 2 : 1, st.color ?? '#000000', layer, this.fontName(a[5]));
  }
  private fontName(v: Arg): string | undefined { const s = v instanceof Ref ? this.firstStr(v) : ''; return s || undefined; }

  private definedSymbol(id: number, t: T2, st: Sty, layer: string) {
    const a = this.attrs(id);
    const refsA = a.filter((x) => x instanceof Ref) as Ref[];
    const def = refsA[0], tgt = refsA[1];
    const name = def ? this.firstStr(def).toLowerCase() : '';
    let pl: T2 = I2, sx = 1;
    if (tgt) {
      const ta = this.attrs(tgt.id);
      pl = this.placement(ta.find((x) => x instanceof Ref) ?? null);
      const n = ta.filter((x) => typeof x === 'number') as number[];
      if (n[0] > 0) sx = n[0];
    }
    const [px, py] = ap(t, pl[4], pl[5]);
    const [dx, dy] = lin(t, pl[0], pl[1]);
    const color = st.color ?? '#000000';
    const ai = ARROWS.indexOf(name), mi = MARKERS.indexOf(name);
    if (ai >= 0) this.out.arrow(ai + 1, sx, px, py, dx, dy, color, layer);
    else if (mi >= 0) this.out.marker(mi + 1, sx, px, py, Math.atan2(dy, dx), color, layer);
    else { this.out.warn(`symbol "${name}" drawn as a marker`); this.out.marker(7, sx, px, py, 0, color, layer); }
  }

  private fillArea(id: number, t: T2, st: Sty, layer: string) {
    const a = this.attrs(id);
    const rings: number[][] = [];
    for (const x of a) if (Array.isArray(x)) for (const r of x) if (r instanceof Ref) {
      const c = this.curve(r.id, t, 0);
      if (!c) continue;
      let p = c.pts;
      if (c.arc) p = this.out.ellipsePts(t, c.arc[0], c.arc[1], c.arc[2], c.arc[2], 0, c.arc[3], c.arc[4]);
      if (p.length >= 6) rings.push(p);
    }
    if (!rings.length) return;
    let did = false;
    for (const fs of st.fill ?? []) {
      if (!(fs instanceof Ref)) continue;
      const ts = this.types(fs.id).join('+');
      const fa = this.attrs(fs.id);
      if (/FILL_AREA_STYLE_COLOUR/.test(ts)) {
        this.out.fill(t, rings, this.colour(fa.find((x) => x instanceof Ref) ?? null) ?? '#000000', layer);
        did = true;
      } else if (/FILL_AREA_STYLE_HATCHING/.test(ts)) {
        // name, hatch_line_appearance, start_of_next_hatch_line, point_of_reference, pattern_start, angle
        const refsA = fa.filter((x) => x instanceof Ref) as Ref[];
        const ls = this.style([refsA[0]]);
        let off: [number, number] = [0, 5];
        if (refsA[1]) { const v = this.attrs(refsA[1].id).find((x) => x instanceof Ref) ?? null; off = this.dir(v) ?? off; }
        const base = this.pt(refsA[2] ?? null) ?? [0, 0];
        const angRaw = this.firstNum(fa[fa.length - 1]) ?? 0;
        const ang = (angRaw * Math.PI) / 180;
        // offset is given in the hatch line frame (x along the line); turn it into sheet local axes
        const ox = off[0] * Math.cos(ang) - off[1] * Math.sin(ang), oy = off[0] * Math.sin(ang) + off[1] * Math.cos(ang);
        const segs = hatchLines(rings, [{ ang, bx: base[0], by: base[1], ox, oy, dashes: [] }], 0, Math.min(this.out.hatchBudget, 200000));
        const s2 = this.stl(ls, layer);
        if (!segs) { this.out.fill(t, rings, s2.color, layer, 0.25); did = true; continue; }
        this.out.hatchBudget -= segs.length / 4;
        for (let i = 0; i < segs.length; i += 4) this.out.poly(t, [segs[i], segs[i + 1], segs[i + 2], segs[i + 3]], s2);
        did = true;
      }
    }
    if (!did) for (const r of rings) this.out.poly(t, r, this.stl(st, layer), true);
    void tScale;
  }
}
