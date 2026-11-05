// SXF feature model: definition tables, assemblies and drawing of the general features (own code).
// Sources: OCF SXF 技術者リファレンスブック 2017 第3章 (meaning of every parameter) and the OCF
// 共通ライブラリ機能仕様書 SFC編 (field order of every feature = the C structures in its chapter 10,
// code numbering rules of SXFread_table). See NOTEBOOK.md for what was learned from the samples.
//
// Record order in an SFC file is bottom up: the members of an assembly come first, then the assembly
// record (composite_curve_org_feature, sfig_org_feature, drawing_sheet_feature).

import type { LayerInfo, RvtSheet2D, SheetItem, SheetViewport } from './types.ts';
import { type SfcArg, type SfcRecord, argArr, argInt, argNum, argStr } from './sfc.ts';
import { I2, Out, type Style, type T2, ap, lin, tMul, tPlace, tScale } from './out.ts';
import { PAPER, PRE_COLOURS, PRE_LINETYPES, PRE_WIDTHS, preColourCode, preLinetypeCode, preWidthCode, rgbHex } from './tables.ts';
import { hatchLines } from './hatch.ts';
import { itemsBounds } from './geom.ts';

interface Feat { id: number; name: string; a: SfcArg[] }
interface CCurve { id: number; color: number; type: number; width: number; flag: number; members: Feat[]; used: boolean }
interface Sfig { name: string; flag: number; items: Feat[]; placed: number }

export interface SheetHead { name: string; type: number; orient: number; x: number; y: number }

export interface FeatureResult {
  sheet: RvtSheet2D;
  layers: LayerInfo[];
  info: Record<string, string | number>;
}

const CURVES = new Set(['polyline_feature', 'arc_feature', 'ellipse_arc_feature', 'spline_feature', 'line_feature', 'circle_feature', 'ellipse_feature', 'clothoid_feature']);

export interface FeatureOptions {
  /** draw white (colour 8) as black on the white sheet (default true) */
  whiteToBlack?: boolean;
  maxItems?: number;
}

export class FeatureModel {
  layers: Array<{ name: string; visible: boolean }> = [];
  colours = new Map<number, string>();
  linetypes = new Map<number, { name: string; dash: number[] }>();
  widths = new Map<number, number>();
  fonts: string[] = [];
  ccurves: CCurve[] = [];
  ccById = new Map<number, CCurve>();
  sfigs = new Map<string, Sfig>();
  sheet: SheetHead | null = null;
  sheetItems: Feat[] = [];
  attrs: Record<string, string | number> = {};
  counts = new Map<string, number>();
  unknown = new Map<string, number>();
  undefinedCodes = new Set<string>();
  private pending: Feat[] = [];
  private userColour = 17;
  private userLinetype = 17; // predefined area is 1..16 (MAXPRELINETYPE), seen in samples: first user type is 17
  private userWidth = 11;
  out: Out;
  opts: FeatureOptions;
  viewports: SheetViewport[] = [];

  constructor(opts: FeatureOptions = {}) {
    this.opts = opts;
    this.out = new Out(opts.maxItems ?? 3e6);
  }

  add(r: SfcRecord) {
    const f: Feat = { id: r.id, name: r.name, a: r.args };
    const a = r.args;
    this.counts.set(r.name, (this.counts.get(r.name) ?? 0) + 1);
    switch (r.name) {
      case 'layer_feature':
        this.layers.push({ name: argStr(a[0]) || `layer${this.layers.length + 1}`, visible: argInt(a[1], 1) !== 0 });
        return;
      case 'pre_defined_colour_feature': {
        const code = preColourCode(argStr(a[0]));
        if (code) this.colours.set(code, this.preColour(code));
        else this.out.warn(`unknown predefined colour name "${argStr(a[0])}"`);
        return;
      }
      case 'user_defined_colour_feature': {
        this.colours.set(this.userColour++, rgbHex(argNum(a[0]) || 0, argNum(a[1]) || 0, argNum(a[2]) || 0));
        return;
      }
      case 'pre_defined_font_feature': {
        const code = preLinetypeCode(argStr(a[0]));
        if (code) this.linetypes.set(code, { name: PRE_LINETYPES[code - 1][0], dash: PRE_LINETYPES[code - 1][1] });
        else this.out.warn(`unknown predefined line type "${argStr(a[0])}"`);
        return;
      }
      case 'user_defined_font_feature': {
        const seg = argInt(a[1], 0);
        let p = argArr(a[2]).filter((v) => Number.isFinite(v) && v >= 0);
        if (seg > 0 && p.length > seg) p = p.slice(0, seg);
        if (p.length % 2) p.push(p[p.length - 1] ?? 1);
        const sum = p.reduce((x, y) => x + y, 0);
        this.linetypes.set(this.userLinetype++, { name: argStr(a[0]), dash: sum > 0 && p.length >= 2 ? p : [] });
        return;
      }
      case 'width_feature': {
        const w = argNum(a[0]);
        const code = preWidthCode(w);
        if (code) this.widths.set(code, PRE_WIDTHS[code - 1]);
        else this.widths.set(this.userWidth++, w > 0 && w < 50 ? w : 0.25);
        return;
      }
      case 'text_font_feature':
        this.fonts.push(argStr(a[0]));
        return;
      case 'drawing_attribute_feature': {
        const keys = ['project', 'construction', 'contract', 'title', 'number', 'type', 'scale', 'year', 'month', 'day', 'contractor', 'owner'];
        keys.forEach((k, i) => { const v = argStr(a[i]); if (v && v !== '0' && v !== '$') this.attrs['attr_' + k] = v; });
        return;
      }
      case 'composite_curve_org_feature': {
        // members: the trailing curve features of the pending list. Known writers give members layer 0.
        const members: Feat[] = [];
        let k = this.pending.length - 1;
        while (k >= 0 && CURVES.has(this.pending[k].name) && argInt(this.pending[k].a[0], 0) === 0) k--;
        if (k < this.pending.length - 1) members.push(...this.pending.splice(k + 1));
        else {
          // fallback: every trailing curve
          while (k >= 0 && CURVES.has(this.pending[k].name)) k--;
          members.push(...this.pending.splice(k + 1));
        }
        const cc: CCurve = { id: r.id, color: argInt(a[0]), type: argInt(a[1]), width: argInt(a[2]), flag: argInt(a[3], 1), members, used: false };
        this.ccurves.push(cc);
        this.ccById.set(r.id, cc);
        if (!members.length) this.out.warn('composite curve without member curves');
        return;
      }
      case 'sfig_org_feature': {
        const name = argStr(a[0]);
        if (this.sfigs.has(name)) this.out.warn(`composite figure "${name}" defined twice, the last one is used`);
        this.sfigs.set(name, { name, flag: argInt(a[1], 4), items: this.pending, placed: 0 });
        this.pending = [];
        return;
      }
      case 'drawing_sheet_feature': {
        if (this.sheet) this.out.warn('more than one drawing sheet in the file, the first is used');
        else {
          this.sheet = { name: argStr(a[0]), type: argInt(a[1], 9), orient: argInt(a[2], 1), x: argNum(a[3]), y: argNum(a[4]) };
          this.sheetItems = this.pending;
          this.pending = [];
        }
        return;
      }
      default:
        this.pending.push(f);
    }
  }

  private preColour(code: number): string {
    const c = PRE_COLOURS[code - 1];
    if (code === 8 && this.opts.whiteToBlack !== false) return '#000000';
    return rgbHex(c[1], c[2], c[3]);
  }

  // ------------------------------------------------------------------ styles
  colour(code: number): string {
    const c = this.colours.get(code);
    if (c) return c;
    if (code >= 1 && code <= 16) { this.undefinedCodes.add('colour ' + code); return this.preColour(code); }
    if (code !== 0) this.undefinedCodes.add('colour ' + code);
    return '#000000';
  }
  dash(code: number): number[] | undefined {
    const t = this.linetypes.get(code);
    if (t) return t.dash.length ? t.dash : undefined;
    if (code >= 1 && code <= 15) { this.undefinedCodes.add('line type ' + code); const d = PRE_LINETYPES[code - 1][1]; return d.length ? d : undefined; }
    if (code !== 0) this.undefinedCodes.add('line type ' + code);
    return undefined;
  }
  width(code: number): number {
    const w = this.widths.get(code);
    if (w !== undefined) return w;
    if (code >= 1 && code <= 9) { this.undefinedCodes.add('width ' + code); return PRE_WIDTHS[code - 1]; }
    if (code !== 0) this.undefinedCodes.add('width ' + code);
    return 0.13;
  }
  font(code: number): string | undefined {
    const f = this.fonts[code - 1];
    return f ? f : undefined;
  }
  layerName(code: number): string {
    if (code >= 1 && code <= this.layers.length) return this.layers[code - 1].name;
    if (code === 0) return '0';
    this.undefinedCodes.add('layer ' + code);
    return `layer${code}`;
  }
  style(a: SfcArg[], ctx: Ctx): Style {
    return { layer: ctx.layer ?? this.layerName(argInt(a[0])), color: this.colour(argInt(a[1])), w: this.width(argInt(a[3])), dash: this.dash(argInt(a[2])) };
  }

  // ------------------------------------------------------------------ drawing
  render(): FeatureResult {
    const out = this.out;
    if (this.pending.length) {
      if (this.sheet) out.warn(`${this.pending.length} features after the drawing sheet record were added to the sheet`);
      this.sheetItems = this.sheetItems.concat(this.pending);
      this.pending = [];
    }
    const ctx: Ctx = { t: I2, layer: null, depth: 0, stack: [] };
    this.drawList(this.sheetItems, ctx);
    for (const [name, sf] of this.sfigs) if (!sf.placed) out.warn(`composite figure "${name}" is defined but never placed`);
    if (this.undefinedCodes.size) out.warn('codes used without a definition: ' + [...this.undefinedCodes].slice(0, 8).join(', '));
    if (out.dropped) out.warn(`${out.dropped} degenerate elements skipped`);

    // sheet size
    let w = 0, h = 0, paper = 'free';
    const sh = this.sheet;
    if (sh) {
      if (sh.type >= 0 && sh.type <= 4) {
        const p = PAPER[sh.type];
        paper = p[0];
        if (sh.orient === 0) { w = p[1]; h = p[2]; } else { w = p[2]; h = p[1]; }
        // trust explicit sizes when the writer filled them in and they agree with the orientation
        if (sh.x > 0 && sh.y > 0 && Math.abs(sh.x * sh.y - w * h) < 1) { w = sh.x; h = sh.y; }
      } else if (sh.x > 0 && sh.y > 0) { w = sh.x; h = sh.y; }
    }
    if (!(w > 0 && h > 0) || w > 100000 || h > 100000) {
      const bb = itemsBounds(out.items);
      if (bb) { w = Math.max(1, bb[2]); h = Math.max(1, bb[3]); }
      else { w = 420; h = 297; }
      out.warn('paper size missing, taken from the drawing extents');
    }
    const sheet: RvtSheet2D = {
      id: 1,
      number: sh?.name ?? '',
      name: sh?.name || 'SXF',
      size: { w: +w.toFixed(3), h: +h.toFixed(3) },
      items: out.items,
      viewports: this.viewports,
      completeness: 'full',
      warnings: [...out.warnings],
    };
    const layers: LayerInfo[] = [];
    const seen = new Set<string>();
    const pick = (name: string) => {
      const u = out.layerUse.get(name);
      let best = '#000000', bn = -1;
      if (u) for (const [c, n] of u.colors) if (n > bn) { bn = n; best = c; }
      return { color: best, items: u?.n ?? 0 };
    };
    for (const l of this.layers) {
      if (seen.has(l.name)) continue;
      seen.add(l.name);
      const p = pick(l.name);
      layers.push({ name: l.name, color: p.color, visible: l.visible, items: p.items });
    }
    for (const name of out.layerUse.keys()) {
      if (seen.has(name)) continue;
      seen.add(name);
      const p = pick(name);
      layers.push({ name, color: p.color, visible: true, items: p.items });
    }
    const info: Record<string, string | number> = {
      paper: sh ? `${paper} ${sh.orient === 0 ? 'portrait' : 'landscape'}` : 'unknown',
      sheetName: sh?.name ?? '',
      layers: this.layers.length,
      compositeFigures: this.sfigs.size,
      compositeCurves: this.ccurves.length,
      fonts: this.fonts.join(', '),
      ...this.attrs,
    };
    const fc: string[] = [];
    for (const [k, n] of [...this.counts].sort((x, y) => y[1] - x[1])) fc.push(`${k.replace(/_feature$/, '')} ${n}`);
    info.features = fc.join(', ');
    return { sheet, layers, info };
  }

  private drawList(list: Feat[], ctx: Ctx) {
    for (const f of list) {
      try { this.draw(f, ctx); } catch (e) { this.out.warn(`${f.name} #${f.id}: ${(e as Error).message}`); }
    }
  }

  private draw(f: Feat, ctx: Ctx) {
    const a = f.a, out = this.out, t = ctx.t;
    switch (f.name) {
      case 'point_marker_feature': {
        const layer = ctx.layer ?? this.layerName(argInt(a[0]));
        const [px, py] = ap(t, argNum(a[2]), argNum(a[3]));
        const [dx, dy] = lin(t, 1, 0);
        out.marker(argInt(a[4], 1), argNum(a[6]) || 1, px, py, Math.atan2(dy, dx) + (argNum(a[5]) || 0) * Math.PI / 180, this.colour(argInt(a[1])), layer);
        return;
      }
      case 'line_feature':
        out.poly(t, [argNum(a[4]), argNum(a[5]), argNum(a[6]), argNum(a[7])], this.style(a, ctx));
        return;
      case 'polyline_feature': {
        const pts = xy(a[5], a[6]);
        out.poly(t, pts, this.style(a, ctx));
        return;
      }
      case 'circle_feature':
        out.arc(t, argNum(a[4]), argNum(a[5]), argNum(a[6]), 0, Math.PI * 2, this.style(a, ctx));
        return;
      case 'arc_feature': {
        const [a0, sw] = arcSweep(argNum(a[8]), argNum(a[9]), argInt(a[7]));
        out.arc(t, argNum(a[4]), argNum(a[5]), argNum(a[6]), a0, sw, this.style(a, ctx));
        return;
      }
      case 'ellipse_feature': {
        const pts = out.ellipsePts(t, argNum(a[4]), argNum(a[5]), argNum(a[6]), argNum(a[7]), argNum(a[8]) || 0, 0, Math.PI * 2);
        out.poly(t, pts, this.style(a, ctx));
        return;
      }
      case 'ellipse_arc_feature': {
        const pts = ellipseArcPts(out, t, a);
        out.poly(t, pts, this.style(a, ctx));
        return;
      }
      case 'spline_feature': {
        out.poly(t, splinePts(out, t, argArr(a[6]), argArr(a[7])), this.style(a, ctx));
        return;
      }
      case 'clothoid_feature': {
        out.poly(t, clothoidPts(out, t, a), this.style(a, ctx));
        return;
      }
      case 'text_string_feature': {
        const layer = ctx.layer ?? this.layerName(argInt(a[0]));
        out.text(t, argStr(a[3]), argNum(a[4]), argNum(a[5]), argNum(a[6]), argNum(a[7]), argNum(a[8]), argNum(a[9]) || 0, argInt(a[11], 1), argInt(a[12], 1), this.colour(argInt(a[1])), layer, this.font(argInt(a[2])));
        if (Math.abs(argNum(a[10]) || 0) > 0.01) out.warn('slanted text is drawn upright');
        return;
      }
      case 'sfig_locate_feature':
        this.locate(f, ctx);
        return;
      case 'externally_defined_symbol_feature': {
        const layer = ctx.layer ?? this.layerName(argInt(a[0]));
        const [px, py] = ap(t, argNum(a[4]), argNum(a[5]));
        const [dx, dy] = lin(t, 1, 0);
        out.warn(`predefined symbol "${argStr(a[3])}" drawn as a marker`);
        out.marker(7, argNum(a[7]) || 1, px, py, Math.atan2(dy, dx) + (argNum(a[6]) || 0) * Math.PI / 180, argInt(a[1]) ? this.colour(argInt(a[2])) : '#000000', layer);
        return;
      }
      case 'linear_dim_feature': this.linearDim(a, ctx); return;
      case 'curve_dim_feature': this.angularDim(a, ctx); return;
      case 'angular_dim_feature': this.angularDim(a, ctx); return;
      case 'radius_dim_feature': this.radiusDim(a, ctx); return;
      case 'diameter_dim_feature': this.diameterDim(a, ctx); return;
      case 'label_feature': this.label(a, ctx, false); return;
      case 'balloon_feature': this.label(a, ctx, true); return;
      case 'fill_area_style_colour_feature': {
        const layer = ctx.layer ?? this.layerName(argInt(a[0]));
        const rings = this.rings(argInt(a[2]), argArr(a[4]), t, layer);
        if (rings.length) out.fill(t, rings, this.colour(argInt(a[1])), layer);
        return;
      }
      case 'fill_area_style_hatching_feature': this.hatching(a, ctx); return;
      case 'fill_area_style_tiles_feature': this.tiles(a, ctx); return;
      case 'externally_defined_hatch_feature': {
        const name = argStr(a[1]);
        const layer = ctx.layer ?? this.layerName(argInt(a[0]));
        this.rings(argInt(a[2]), argArr(a[4]), t, layer);
        if (name.toLowerCase() !== 'area_control') out.warn(`predefined hatch "${name}" drawn as outline only`);
        return;
      }
      default:
        this.unknown.set(f.name, (this.unknown.get(f.name) ?? 0) + 1);
        out.warn(`feature ${f.name} is not drawn`);
    }
  }

  private locate(f: Feat, ctx: Ctx) {
    const a = f.a;
    const name = argStr(a[1]);
    const sf = this.sfigs.get(name);
    if (!sf) { this.out.warn(`placement of unknown composite figure "${name}"`); return; }
    if (ctx.depth > 24 || ctx.stack.includes(name)) { this.out.warn(`composite figure "${name}" places itself (loop skipped)`); return; }
    sf.placed++;
    let x = argNum(a[2]) || 0, y = argNum(a[3]) || 0, ang = argNum(a[4]) || 0;
    let rx = argNum(a[5]), ry = argNum(a[6]);
    if (!Number.isFinite(rx) || rx === 0) rx = 1;
    if (!Number.isFinite(ry) || ry === 0) ry = 1;
    if (sf.flag === 3) { ang = 0; rx = 1; ry = 1; } // drawing group: scale and angle are not used (reference book 3.3.4)
    if (!Number.isFinite(x)) x = 0;
    if (!Number.isFinite(y)) y = 0;
    const lcode = argInt(a[0]);
    const layer = lcode ? this.layerName(lcode) : ctx.layer;
    const t = tMul(ctx.t, tPlace(x, y, ang, rx, ry));
    const n0 = this.out.items.length;
    this.drawList(sf.items, { t, layer, depth: ctx.depth + 1, stack: [...ctx.stack, name] });
    if ((sf.flag === 1 || sf.flag === 2) && this.out.items.length > n0) {
      const bb = itemsBounds(this.out.items.slice(n0));
      if (bb) {
        const sc = 1 / Math.sqrt(Math.abs(rx * ry));
        this.viewports.push({ viewId: this.viewports.length + 1, viewName: name, box: [+bb[0].toFixed(3), +bb[1].toFixed(3), +bb[2].toFixed(3), +bb[3].toFixed(3)], scale: +sc.toPrecision(6), viewType: 'drafting', levelId: null, levelName: null, cutHeight: null, crop: null, detailNumber: null, xform: null, annotations: this.out.items.length - n0 });
      }
    }
  }

  // ------------------------------------------------------------------ composite curves and hatches
  private ccPts(cc: CCurve, t: T2): number[] {
    const out: number[] = [];
    for (const m of cc.members) {
      const a = m.a;
      let p: number[] = [];
      switch (m.name) {
        case 'polyline_feature': p = xy(a[5], a[6]); break;
        case 'line_feature': p = [argNum(a[4]), argNum(a[5]), argNum(a[6]), argNum(a[7])]; break;
        case 'arc_feature': {
          const [a0, sw] = arcSweep(argNum(a[8]), argNum(a[9]), argInt(a[7]));
          p = this.out.ellipsePts(t, argNum(a[4]), argNum(a[5]), argNum(a[6]), argNum(a[6]), 0, a0, sw);
          break;
        }
        case 'circle_feature': p = this.out.ellipsePts(t, argNum(a[4]), argNum(a[5]), argNum(a[6]), argNum(a[6]), 0, 0, Math.PI * 2); break;
        case 'ellipse_feature': p = this.out.ellipsePts(t, argNum(a[4]), argNum(a[5]), argNum(a[6]), argNum(a[7]), argNum(a[8]) || 0, 0, Math.PI * 2); break;
        case 'ellipse_arc_feature': p = ellipseArcPts(this.out, t, a); break;
        case 'spline_feature': p = splinePts(this.out, t, argArr(a[6]), argArr(a[7])); break;
        case 'clothoid_feature': p = clothoidPts(this.out, t, a); break;
      }
      if (!p.length) continue;
      // join: drop a duplicated first point
      let s = 0;
      if (out.length >= 2 && Math.abs(out[out.length - 2] - p[0]) < 1e-9 && Math.abs(out[out.length - 1] - p[1]) < 1e-9) s = 2;
      for (let i = s; i < p.length; i++) out.push(p[i]);
    }
    if (out.length >= 4 && Math.abs(out[0] - out[out.length - 2]) < 1e-9 && Math.abs(out[1] - out[out.length - 1]) < 1e-9) out.length -= 2;
    for (const v of out) if (!Number.isFinite(v)) return [];
    return out;
  }

  /** boundary rings (local coordinates) for an outer composite curve number and hole numbers; draws visible outlines */
  private rings(outer: number, holes: number[], t: T2, layer: string): number[][] {
    const rings: number[][] = [];
    const ids = [outer, ...holes.map((v) => Math.round(v))];
    for (const k of ids) {
      // composite curve reference: 1-based number in definition order (seen in all samples); fall back to the record id
      const cc = this.ccurves[k - 1] ?? this.ccById.get(k);
      if (!cc) { this.out.warn(`hatch refers to missing composite curve ${k}`); continue; }
      const p = this.ccPts(cc, t);
      if (p.length >= 6) rings.push(p);
      if (cc.flag === 1 && p.length >= 4) {
        this.out.poly(t, p, { layer, color: this.colour(cc.color), w: this.width(cc.width), dash: this.dash(cc.type) }, true);
      }
      cc.used = true;
    }
    return rings;
  }

  private hatching(a: SfcArg[], ctx: Ctx) {
    const out = this.out, t = ctx.t;
    const layer = ctx.layer ?? this.layerName(argInt(a[0]));
    const n = Math.max(0, Math.min(4, argInt(a[1])));
    const v = argArr(a[2]);
    const outer = argInt(a[3]);
    const holes = argArr(a[5]);
    const rings = this.rings(outer, holes, t, layer);
    if (!rings.length) return;
    for (let k = 0; k < n && k * 7 + 6 < v.length; k++) {
      const [col, typ, wid, sx, sy, sp, angDeg] = v.slice(k * 7, k * 7 + 7);
      if (!(Math.abs(sp) > 0)) continue;
      const ang = (angDeg * Math.PI) / 180;
      const fam = [{ ang, bx: sx, by: sy, ox: -Math.sin(ang) * sp, oy: Math.cos(ang) * sp, dashes: [] as number[] }];
      const segs = hatchLines(rings, fam, 0, Math.min(out.hatchBudget, 200000));
      if (!segs) {
        out.warn('dense hatching drawn as a light fill');
        out.fill(t, rings, this.colour(Math.round(col)), layer, 0.25);
        continue;
      }
      out.hatchBudget -= segs.length / 4;
      const st: Style = { layer, color: this.colour(Math.round(col)), w: this.width(Math.round(wid)), dash: this.dash(Math.round(typ)) };
      for (let i = 0; i < segs.length; i += 4) out.poly(t, [segs[i], segs[i + 1], segs[i + 2], segs[i + 3]], st);
    }
  }

  private tiles(a: SfcArg[], ctx: Ctx) {
    // 馬踏み / 45度重ねあじろ patterns: the symbol shapes are not given in the public documents,
    // so the pattern is approximated by its repeat lattice (lines along both repeat vectors).
    const out = this.out, t = ctx.t;
    const layer = ctx.layer ?? this.layerName(argInt(a[0]));
    const rings = this.rings(argInt(a[12]), argArr(a[14]), t, layer);
    if (!rings.length) return;
    const bx = argNum(a[3]) || 0, by = argNum(a[4]) || 0;
    const l1 = argNum(a[5]), a1 = (argNum(a[6]) || 0) * Math.PI / 180, l2 = argNum(a[7]), a2 = (argNum(a[8]) || 0) * Math.PI / 180;
    const fam: Array<{ ang: number; bx: number; by: number; ox: number; oy: number; dashes: number[] }> = [];
    if (l1 > 0 && l2 > 0) {
      fam.push({ ang: a1, bx, by, ox: l2 * Math.cos(a2), oy: l2 * Math.sin(a2), dashes: [] });
      fam.push({ ang: a2, bx, by, ox: l1 * Math.cos(a1), oy: l1 * Math.sin(a1), dashes: [] });
    }
    out.warn(`pattern hatch "${argStr(a[1])}" approximated by its repeat grid`);
    const segs = fam.length ? hatchLines(rings, fam, 0, Math.min(out.hatchBudget, 200000)) : null;
    const color = this.colour(argInt(a[2]));
    if (!segs) { out.fill(t, rings, color, layer, 0.25); return; }
    out.hatchBudget -= segs.length / 4;
    for (let i = 0; i < segs.length; i += 4) out.poly(t, [segs[i], segs[i + 1], segs[i + 2], segs[i + 3]], { layer, color, w: 0.13 });
  }

  // ------------------------------------------------------------------ dimensions
  private dimText(a: SfcArg[], k: number, ctx: Ctx, layer: string, color: string) {
    // k = index of the "font" field; then str, x, y, h, w, spc, angle, slant, b_pnt, direct
    const s = argStr(a[k + 1]);
    if (!s) return;
    this.out.text(ctx.t, s, argNum(a[k + 2]), argNum(a[k + 3]), argNum(a[k + 4]), argNum(a[k + 5]), argNum(a[k + 6]), argNum(a[k + 7]) || 0, argInt(a[k + 9], 1), argInt(a[k + 10], 1), color, layer, this.font(argInt(a[k])));
  }
  private ext(a: SfcArg[], k: number, ctx: Ctx, st: Style) {
    // k = index of the flag; base x0,y0 then start x1,y1, end x2,y2
    if (argInt(a[k]) !== 1) return;
    this.out.poly(ctx.t, [argNum(a[k + 3]), argNum(a[k + 4]), argNum(a[k + 5]), argNum(a[k + 6])], st);
  }
  /** arrow at local point p, "outward" direction d (local); code2 1 = outward, 2 = inward, 0 = none */
  private arr(code1: number, code2: number, r: number, px: number, py: number, dx: number, dy: number, ctx: Ctx, st: Style) {
    if (!code1 || code2 === 0) return;
    const [sx, sy] = ap(ctx.t, px, py);
    let [ex, ey] = lin(ctx.t, dx, dy);
    if (code2 === 2) { ex = -ex; ey = -ey; }
    this.out.arrow(code1, r, sx, sy, ex, ey, st.color, st.layer);
  }
  private linearDim(a: SfcArg[], ctx: Ctx) {
    const st = this.style(a, ctx);
    const x1 = argNum(a[4]), y1 = argNum(a[5]), x2 = argNum(a[6]), y2 = argNum(a[7]);
    this.out.poly(ctx.t, [x1, y1, x2, y2], st);
    this.ext(a, 8, ctx, st);
    this.ext(a, 15, ctx, st);
    this.arr(argInt(a[22]), argInt(a[23]), argNum(a[26]), argNum(a[24]), argNum(a[25]), x1 - x2, y1 - y2, ctx, st);
    this.arr(argInt(a[27]), argInt(a[28]), argNum(a[31]), argNum(a[29]), argNum(a[30]), x2 - x1, y2 - y1, ctx, st);
    if (argInt(a[32], 1)) this.dimText(a, 33, ctx, st.layer, st.color);
  }
  private angularDim(a: SfcArg[], ctx: Ctx) {
    const st = this.style(a, ctx);
    const cx = argNum(a[4]), cy = argNum(a[5]), r = argNum(a[6]);
    const d0 = argNum(a[7]), d1 = argNum(a[8]);
    let a0 = (d0 * Math.PI) / 180, a1 = (d1 * Math.PI) / 180;
    let sw = a1 - a0;
    while (sw <= 0) sw += Math.PI * 2;
    if (Math.abs(d1 - d0) < 1e-9) sw = Math.PI * 2;
    this.out.arc(ctx.t, cx, cy, r, a0, sw, st);
    a1 = a0 + sw;
    this.ext(a, 9, ctx, st);
    this.ext(a, 16, ctx, st);
    // outward at the start = clockwise tangent, at the end = counter clockwise tangent
    this.arr(argInt(a[23]), argInt(a[24]), argNum(a[27]), argNum(a[25]), argNum(a[26]), Math.sin(a0), -Math.cos(a0), ctx, st);
    this.arr(argInt(a[28]), argInt(a[29]), argNum(a[32]), argNum(a[30]), argNum(a[31]), -Math.sin(a1), Math.cos(a1), ctx, st);
    void a0;
    if (argInt(a[33], 1)) this.dimText(a, 34, ctx, st.layer, st.color);
  }
  private radiusDim(a: SfcArg[], ctx: Ctx) {
    const st = this.style(a, ctx);
    const x1 = argNum(a[4]), y1 = argNum(a[5]), x2 = argNum(a[6]), y2 = argNum(a[7]);
    this.out.poly(ctx.t, [x1, y1, x2, y2], st);
    this.arr(argInt(a[8]), argInt(a[9]), argNum(a[12]), argNum(a[10]), argNum(a[11]), x2 - x1, y2 - y1, ctx, st);
    if (argInt(a[13], 1)) this.dimText(a, 14, ctx, st.layer, st.color);
  }
  private diameterDim(a: SfcArg[], ctx: Ctx) {
    const st = this.style(a, ctx);
    const x1 = argNum(a[4]), y1 = argNum(a[5]), x2 = argNum(a[6]), y2 = argNum(a[7]);
    this.out.poly(ctx.t, [x1, y1, x2, y2], st);
    this.arr(argInt(a[8]), argInt(a[9]), argNum(a[12]), argNum(a[10]), argNum(a[11]), x1 - x2, y1 - y2, ctx, st);
    this.arr(argInt(a[13]), argInt(a[14]), argNum(a[17]), argNum(a[15]), argNum(a[16]), x2 - x1, y2 - y1, ctx, st);
    if (argInt(a[18], 1)) this.dimText(a, 19, ctx, st.layer, st.color);
  }
  private label(a: SfcArg[], ctx: Ctx, balloon: boolean) {
    const st = this.style(a, ctx);
    const pts = xy(a[5], a[6]);
    this.out.poly(ctx.t, pts, st);
    let k = 7;
    if (balloon) {
      this.out.arc(ctx.t, argNum(a[7]), argNum(a[8]), argNum(a[9]), 0, Math.PI * 2, st);
      k = 10;
    }
    if (pts.length >= 4) this.arr(argInt(a[k]), 1, argNum(a[k + 1]), pts[0], pts[1], pts[0] - pts[2], pts[1] - pts[3], ctx, st);
    if (argInt(a[k + 2], 1)) this.dimText(a, k + 3, ctx, st.layer, st.color);
  }
}

interface Ctx { t: T2; layer: string | null; depth: number; stack: string[] }

function xy(ax: SfcArg | undefined, ay: SfcArg | undefined): number[] {
  const X = argArr(ax), Y = argArr(ay);
  const n = Math.min(X.length, Y.length);
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (Number.isFinite(X[i]) && Number.isFinite(Y[i])) out.push(X[i], Y[i]);
  return out;
}

/** start angle and signed sweep (radians) from SXF degrees and direction flag (0 ccw, 1 cw) */
export function arcSweep(d0: number, d1: number, dir: number): [number, number] {
  if (!Number.isFinite(d0)) d0 = 0;
  if (!Number.isFinite(d1)) d1 = 360;
  let sw = dir === 1 ? d0 - d1 : d1 - d0;
  sw = ((sw % 360) + 360) % 360;
  if (sw < 1e-9) sw = 360;
  const r = (sw * Math.PI) / 180;
  return [(d0 * Math.PI) / 180, dir === 1 ? -r : r];
}

function ellipseArcPts(out: Out, t: T2, a: SfcArg[]): number[] {
  // layer, color, type, width, cx, cy, rx, ry, direction, rotation, start, end
  const [a0, sw] = arcSweep(argNum(a[10]), argNum(a[11]), argInt(a[8]));
  return out.ellipsePts(t, argNum(a[4]), argNum(a[5]), argNum(a[6]), argNum(a[7]), argNum(a[9]) || 0, a0, sw);
}

/** cubic Bezier pieces sharing end points (3n+1 control points) */
function splinePts(out: Out, t: T2, X: number[], Y: number[]): number[] {
  const n = Math.min(X.length, Y.length);
  const res: number[] = [];
  if (n < 2) return res;
  if (n < 4 || (n - 1) % 3 !== 0) {
    out.warn('spline with a point count that is not 3n+1 drawn through its points');
    for (let i = 0; i < n; i++) res.push(X[i], Y[i]);
    return res;
  }
  const sc = tScale(t);
  res.push(X[0], Y[0]);
  for (let i = 0; i + 3 < n; i += 3) {
    const len = Math.hypot(X[i + 1] - X[i], Y[i + 1] - Y[i]) + Math.hypot(X[i + 2] - X[i + 1], Y[i + 2] - Y[i + 1]) + Math.hypot(X[i + 3] - X[i + 2], Y[i + 3] - Y[i + 2]);
    const segs = Math.max(4, Math.min(64, Math.ceil(Math.sqrt((len * sc) / 0.2))));
    for (let k = 1; k <= segs; k++) {
      const u = k / segs, v = 1 - u;
      const b0 = v * v * v, b1 = 3 * v * v * u, b2 = 3 * v * u * u, b3 = u * u * u;
      res.push(b0 * X[i] + b1 * X[i + 1] + b2 * X[i + 2] + b3 * X[i + 3], b0 * Y[i] + b1 * Y[i + 1] + b2 * Y[i + 2] + b3 * Y[i + 3]);
    }
  }
  return res;
}

/** clothoid: curvature grows linearly with the length from the base point (A^2 = R L) */
function clothoidPts(out: Out, t: T2, a: SfcArg[]): number[] {
  const bx = argNum(a[4]), by = argNum(a[5]), A = argNum(a[6]);
  const dir = argInt(a[7]);
  const ang = ((argNum(a[8]) || 0) * Math.PI) / 180;
  let s0 = argNum(a[9]), s1 = argNum(a[10]);
  const res: number[] = [];
  if (!(A > 0) || !Number.isFinite(s0) || !Number.isFinite(s1)) return res;
  const sg = dir === 1 ? -1 : 1;
  const L = Math.max(Math.abs(s0), Math.abs(s1));
  if (L / A > 50) { out.warn('clothoid too long, skipped'); return res; }
  const steps = Math.max(16, Math.min(2000, Math.ceil(Math.abs(s1 - s0) * tScale(t) / 0.5)));
  // integrate from 0 to s with Simpson steps, sampling between s0 and s1
  const pos = (s: number): [number, number] => {
    const m = 2 * Math.max(4, Math.ceil(Math.abs(s) / A * 20));
    const h = s / m;
    let x = 0, y = 0;
    for (let k = 0; k <= m; k++) {
      const u = k * h;
      const th = (u * u) / (2 * A * A);
      const w = k === 0 || k === m ? 1 : k % 2 ? 4 : 2;
      x += w * Math.cos(th); y += w * Math.sin(th);
    }
    return [(x * h) / 3, (sg * y * h) / 3];
  };
  const c = Math.cos(ang), s = Math.sin(ang);
  for (let k = 0; k <= steps; k++) {
    const u = s0 + ((s1 - s0) * k) / steps;
    const [x, y] = pos(u);
    res.push(bx + x * c - y * s, by + x * s + y * c);
  }
  void out;
  return res;
}

export type { SheetItem };
