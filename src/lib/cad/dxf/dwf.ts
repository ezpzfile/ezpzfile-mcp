// DWF engine: DWFx (OPC/XPS package, Autodesk Design Web Format on XPS) to RvtSheet2D, one sheet per FixedPage.
// Classic DWF 6 (zip with W2D streams) is recognised; its W2D vector streams use opcodes beyond the public
// WHIP! description, so it is reported as 'unsupported-version' (or returned as thumbnail-only sheets on request).
// Own implementation from the XPS 1.0 / ECMA-388 specification (FixedDocumentSequence, FixedPage, Path, Glyphs,
// Canvas, brushes, abbreviated geometry syntax) and the OPC part / relationship model (ECMA-376 Part 2).

import { arcSegs, clipItems, cubicPoints, itemsBounds, ringsToPolygons, saneItem, scaleItems, type Rect } from './geom.ts';
import { decodeW2d } from './w2d.ts';
import { CadError, type CadInfo, type CadResult, type LayerInfo, type Progress, type RvtSheet2D, type SheetItem } from './types.ts';
import { type XEl, allEls, firstEl, parseXml } from './xml.ts';
import { Zip, normName } from './zip.ts';

export interface DwfOptions {
  /** classic DWF (W2D): 'error' (default) throws unsupported-version, 'thumbnail' returns the embedded page previews,
   *  'experimental' tries the partial W2D decoder (WHIP! public opcodes only) and adds the preview underneath */
  classicDwf?: 'error' | 'thumbnail' | 'experimental';
  maxItems?: number;
}

const MM = 25.4 / 96;

export function sniffDwf(b: Uint8Array): boolean {
  if (b.length < 16) return false;
  // classic DWF: "(DWF V" header
  if (b[0] === 0x28 && b[1] === 0x44 && b[2] === 0x57 && b[3] === 0x46 && b[4] === 0x20 && b[5] === 0x56) return true;
  // DWFx: zip whose names include the DWF document sequence or dwf/ parts
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4) {
    const n = Math.min(b.length, 1 << 16);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]);
    if (s.includes('DWFDocumentSequence') || s.includes('dwf/documents/') || s.includes('com.autodesk.dwf')) return true;
    // the central directory at the end lists every part name
    let t = '';
    const st = Math.max(0, b.length - (1 << 16));
    for (let i = st; i < b.length; i++) t += String.fromCharCode(b[i]);
    return t.includes('DWFDocumentSequence') || t.includes('dwf/documents/');
  }
  return false;
}

export async function readDwf(bytes: Uint8Array, onProgress?: Progress, options: DwfOptions = {}): Promise<CadResult> {
  const t0 = Date.now();
  if (!sniffDwf(bytes)) throw new CadError('not-format', 'not a DWF / DWFx file');
  if (bytes[0] === 0x28) return readClassic(bytes, onProgress, options, t0);
  const zip = new Zip(bytes);
  return readDwfx(zip, onProgress, options, t0);
}

// ================================================================== DWFx

type Mat = [number, number, number, number, number, number]; // x' = a x + c y + e, y' = b x + d y + f
const I: Mat = [1, 0, 0, 1, 0, 0];
function mul(p: Mat, c: Mat): Mat {
  // apply c first, then p
  return [p[0] * c[0] + p[2] * c[1], p[1] * c[0] + p[3] * c[1], p[0] * c[2] + p[2] * c[3], p[1] * c[2] + p[3] * c[3], p[0] * c[4] + p[2] * c[5] + p[4], p[1] * c[4] + p[3] * c[5] + p[5]];
}
function parseMat(s: string | undefined): Mat | null {
  if (!s) return null;
  const v = s.split(/[\s,]+/).filter(Boolean).map(Number);
  if (v.length !== 6 || v.some((x) => !Number.isFinite(x))) return null;
  return v as Mat;
}

function resolvePart(base: string, target: string): string {
  if (target.startsWith('/')) return target;
  const dir = base.slice(0, base.lastIndexOf('/') + 1);
  const parts = (dir + target).split('/');
  const out: string[] = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p !== '.' && p !== '') out.push(p); }
  return '/' + out.join('/');
}

async function rels(zip: Zip, part: string): Promise<Array<{ type: string; target: string }>> {
  const dir = part.slice(0, part.lastIndexOf('/') + 1);
  const name = part.slice(part.lastIndexOf('/') + 1);
  const txt = await zip.text(`${dir}_rels/${name}.rels`);
  if (!txt) return [];
  return allEls(parseXml(txt), 'Relationship').map((r) => ({ type: r.attrs.Type ?? '', target: resolvePart(part, r.attrs.Target ?? '') }));
}

interface Brush { kind: 'solid' | 'image' | 'none'; color: string; opacity: number; image?: { part: string; viewbox?: number[]; viewport?: number[] } }

function parseColor(s: string | undefined): { color: string; opacity: number } | null {
  if (!s) return null;
  s = s.trim();
  if (s.startsWith('#')) {
    const h = s.slice(1);
    if (h.length === 8) return { color: '#' + h.slice(2).toLowerCase(), opacity: parseInt(h.slice(0, 2), 16) / 255 };
    if (h.length === 6) return { color: '#' + h.toLowerCase(), opacity: 1 };
    return null;
  }
  if (s.startsWith('sc#')) {
    const v = s.slice(3).split(',').map(Number);
    const [a, r, g, b] = v.length === 4 ? v : [1, ...v];
    const c = (x: number) => { const l = Math.max(0, Math.min(1, x)); const srgb = l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055; return Math.round(srgb * 255).toString(16).padStart(2, '0'); };
    return { color: '#' + c(r) + c(g) + c(b), opacity: a };
  }
  if (s.startsWith('ContextColor')) {
    // ContextColor profile a,c1,c2,...: no colour management here, approximate grey
    return { color: '#808080', opacity: 1 };
  }
  return null;
}

class XpsPage {
  items: SheetItem[] = [];
  warnings = new Set<string>();
  res = new Map<string, XEl>();
  partName: string;
  zip: Zip;
  H: number; // page height in XPS units
  images: Array<{ part: string; rect: Rect }> = [];
  constructor(zip: Zip, partName: string, H: number) { this.zip = zip; this.partName = partName; this.H = H; }

  /** XPS page coords -> sheet mm (y up) */
  root(): Mat { return [MM, 0, 0, -MM, 0, this.H * MM]; }

  async loadResources(el: XEl) {
    for (const rd of el.children) {
      if (rd.local !== 'ResourceDictionary') continue;
      if (rd.attrs.Source) {
        const part = resolvePart(this.partName, rd.attrs.Source);
        const txt = await this.zip.text(part);
        if (txt) for (const c of parseXml(txt).children[0]?.children ?? []) { const k = c.attrs['x:Key']; if (k) this.res.set(k, c); }
        else this.warnings.add(`resource dictionary ${rd.attrs.Source} missing`);
      }
      for (const c of rd.children) { const k = c.attrs['x:Key']; if (k) this.res.set(k, c); }
    }
  }
  lookup(v: string | undefined): XEl | null {
    if (!v) return null;
    const m = v.match(/^\{StaticResource\s+([^}]+)\}$/);
    if (!m) return null;
    return this.res.get(m[1].trim()) ?? null;
  }

  brush(attr: string | undefined, child: XEl | undefined): Brush | null {
    if (attr) {
      const r = this.lookup(attr);
      if (r) return this.brushEl(r);
      const c = parseColor(attr);
      if (c) return { kind: 'solid', color: c.color, opacity: c.opacity };
      return null;
    }
    if (child && child.children[0]) return this.brushEl(child.children[0]);
    return null;
  }
  brushEl(b: XEl): Brush | null {
    const op = b.attrs.Opacity !== undefined ? +b.attrs.Opacity : 1;
    if (b.local === 'SolidColorBrush') {
      const c = parseColor(b.attrs.Color);
      return c ? { kind: 'solid', color: c.color, opacity: c.opacity * op } : null;
    }
    if (b.local === 'ImageBrush') {
      const src = b.attrs.ImageSource ?? '';
      return { kind: 'image', color: '#000000', opacity: op, image: { part: resolvePart(this.partName, src.replace(/^\{ColorConvertedBitmap\s+([^\s}]+).*$/, '$1')), viewbox: b.attrs.Viewbox?.split(/[\s,]+/).map(Number), viewport: b.attrs.Viewport?.split(/[\s,]+/).map(Number) } };
    }
    if (b.local === 'LinearGradientBrush' || b.local === 'RadialGradientBrush') {
      const stops = allEls(b, 'GradientStop').map((s) => parseColor(s.attrs.Color)).filter(Boolean) as Array<{ color: string; opacity: number }>;
      if (!stops.length) return null;
      this.warnings.add('gradient brushes drawn with their first colour');
      return { kind: 'solid', color: stops[0].color, opacity: stops[0].opacity * op };
    }
    if (b.local === 'VisualBrush') { this.warnings.add('visual brushes not drawn'); return null; }
    return null;
  }

  transformOf(el: XEl, childName: string): Mat {
    const m = parseMat(el.attrs.RenderTransform) ?? (() => {
      const r = this.lookup(el.attrs.RenderTransform);
      if (r) return parseMat(r.attrs.Matrix);
      return null;
    })();
    if (m) return m;
    const c = el.children.find((x) => x.local === childName);
    const mt = c ? firstEl(c, 'MatrixTransform') : undefined;
    return parseMat(mt?.attrs.Matrix) ?? I;
  }

  // -------------------------------------------------------------- geometry

  /** subpaths in local coordinates: { pts, closed, filled } */
  geometry(el: XEl): Array<{ pts: number[]; closed: boolean; filled: boolean; stroked: boolean }> | null {
    const data = el.attrs.Data;
    if (data !== undefined) {
      const r = this.lookup(data);
      if (r) return this.geomEl(r);
      return parseAbbrev(data);
    }
    const pd = el.children.find((c) => c.local === 'Path.Data');
    if (pd && pd.children[0]) return this.geomEl(pd.children[0]);
    return null;
  }
  geomEl(g: XEl): Array<{ pts: number[]; closed: boolean; filled: boolean; stroked: boolean }> | null {
    if (g.local !== 'PathGeometry') return null;
    let figs: Array<{ pts: number[]; closed: boolean; filled: boolean; stroked: boolean }> = [];
    if (g.attrs.Figures) figs = parseAbbrev(g.attrs.Figures);
    for (const f of g.children) {
      if (f.local !== 'PathFigure') continue;
      const sp = (f.attrs.StartPoint ?? '0,0').split(/[\s,]+/).map(Number);
      const pts: number[] = [sp[0], sp[1]];
      for (const s of f.children) {
        const P = (k: string) => (s.attrs[k] ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
        switch (s.local) {
          case 'PolyLineSegment': pts.push(...P('Points')); break;
          case 'LineSegment': pts.push(...P('Point')); break;
          case 'PolyBezierSegment': { const q = P('Points'); for (let i = 0; i + 5 < q.length; i += 6) cubicPoints(pts[pts.length - 2], pts[pts.length - 1], q[i], q[i + 1], q[i + 2], q[i + 3], q[i + 4], q[i + 5], 0.25, pts); break; }
          case 'BezierSegment': { const a = P('Point1'), b = P('Point2'), c = P('Point3'); cubicPoints(pts[pts.length - 2], pts[pts.length - 1], a[0], a[1], b[0], b[1], c[0], c[1], 0.25, pts); break; }
          case 'PolyQuadraticBezierSegment': { const q = P('Points'); for (let i = 0; i + 3 < q.length; i += 4) quad(pts, q[i], q[i + 1], q[i + 2], q[i + 3]); break; }
          case 'QuadraticBezierSegment': { const a = P('Point1'), b = P('Point2'); quad(pts, a[0], a[1], b[0], b[1]); break; }
          case 'ArcSegment': {
            const pt = P('Point'), sz = P('Size');
            arcTo(pts, sz[0], sz[1], +(s.attrs.RotationAngle ?? 0), s.attrs.IsLargeArc === 'true', s.attrs.SweepDirection === 'Clockwise', pt[0], pt[1]);
            break;
          }
        }
      }
      figs.push({ pts, closed: f.attrs.IsClosed === 'true', filled: f.attrs.IsFilled !== 'false', stroked: true });
    }
    const tm = parseMat(g.attrs.Transform);
    if (tm) for (const f of figs) applyMat(tm, f.pts);
    return figs;
  }

  // -------------------------------------------------------------- walk

  async walk(el: XEl, m: Mat, opacity: number, out: SheetItem[]) {
    for (const c of el.children) {
      if (c.local === 'Canvas') {
        const cm = mul(m, this.transformOf(c, 'Canvas.RenderTransform'));
        const res = c.children.find((x) => x.local === 'Canvas.Resources');
        if (res) await this.loadResources(res);
        const op = opacity * (c.attrs.Opacity !== undefined ? +c.attrs.Opacity : 1);
        const clip = c.attrs.Clip ? this.clipRect(c.attrs.Clip, cm) : null;
        if (clip) {
          const sub: SheetItem[] = [];
          await this.walk(c, cm, op, sub);
          for (const it of clipItems(sub, clip, 0.05)) out.push(it);
        } else await this.walk(c, cm, op, out);
      } else if (c.local === 'Path') this.path(c, m, opacity, out);
      else if (c.local === 'Glyphs') this.glyphs(c, m, opacity, out);
      else if (c.local === 'FixedPage.Resources' || c.local === 'Canvas.Resources') await this.loadResources(c);
    }
  }

  clipRect(clip: string, m: Mat): Rect | null {
    const r = this.lookup(clip);
    const g = r ? this.geomEl(r) : parseAbbrev(clip);
    if (!g || g.length !== 1) return null;
    const p = g[0].pts.slice();
    applyMat(m, p);
    let n = p.length / 2;
    if (n >= 5 && p[0] === p[p.length - 2] && p[1] === p[p.length - 1]) n--;
    if (n !== 4) return null;
    // axis aligned?
    const xs = new Set<number>(), ys = new Set<number>();
    for (let i = 0; i < 4; i++) { xs.add(+p[i * 2].toFixed(3)); ys.add(+p[i * 2 + 1].toFixed(3)); }
    if (xs.size !== 2 || ys.size !== 2) return null;
    const [x0, x1] = [...xs].sort((a, b) => a - b), [y0, y1] = [...ys].sort((a, b) => a - b);
    return [x0, y0, x1, y1];
  }

  path(el: XEl, parent: Mat, opacity: number, out: SheetItem[]) {
    const m = mul(parent, this.transformOf(el, 'Path.RenderTransform'));
    const figs = this.geometry(el);
    if (!figs || !figs.length) return;
    const op = opacity * (el.attrs.Opacity !== undefined ? +el.attrs.Opacity : 1);
    const fill = this.brush(el.attrs.Fill, el.children.find((c) => c.local === 'Path.Fill'));
    const stroke = this.brush(el.attrs.Stroke, el.children.find((c) => c.local === 'Path.Stroke'));
    const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
    const tfigs = figs.map((f) => { const p = f.pts.slice(); applyMat(m, p); return { ...f, pts: p }; });
    if (fill && fill.kind === 'image' && fill.image) {
      const bb = boundsOf(tfigs.map((f) => f.pts));
      if (bb) this.imageItem(fill.image.part, bb, out);
    } else if (fill && fill.kind === 'solid' && fill.opacity * op > 0.004) {
      const rings = tfigs.filter((f) => f.filled && f.pts.length >= 6).map((f) => f.pts);
      for (const poly of ringsToPolygons(rings)) {
        const it: SheetItem = { kind: 'fill', pts: poly, color: fill.color };
        const o = fill.opacity * op;
        if (o < 0.999) it.opacity = +o.toFixed(3);
        out.push(it);
      }
    }
    if (stroke && stroke.kind === 'solid' && stroke.opacity * op > 0.004) {
      const th = el.attrs.StrokeThickness !== undefined ? +el.attrs.StrokeThickness : 1;
      const w = +(th * scale).toPrecision(4);
      let dash: number[] | undefined;
      if (el.attrs.StrokeDashArray) {
        const d = el.attrs.StrokeDashArray.split(/[\s,]+/).filter(Boolean).map((x) => +x * th * scale);
        if (d.length >= 2 && d.every((x) => x >= 0) && d.some((x) => x > 0)) dash = d.map((x) => +x.toPrecision(4));
      }
      for (const f of tfigs) {
        if (f.pts.length < 4 && !(f.pts.length === 2)) continue;
        const pts = f.closed ? [...f.pts, f.pts[0], f.pts[1]] : f.pts;
        const it: SheetItem = { kind: 'line', pts: pts.length === 2 ? [pts[0], pts[1], pts[0], pts[1]] : pts, color: stroke.color, w };
        if (dash) it.dash = dash;
        out.push(it);
      }
    }
  }

  imageItem(part: string, bb: Rect, out: SheetItem[]) {
    const lower = part.toLowerCase();
    const mime = lower.endsWith('.png') ? 'image/png' : lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'image/jpeg' : null;
    if (!mime) { this.warnings.add(`image ${part.slice(part.lastIndexOf('/') + 1)} (${lower.slice(lower.lastIndexOf('.') + 1)}) not supported by browsers, skipped`); return; }
    const it: SheetItem = { kind: 'image', x: bb[0], y: bb[1], w: bb[2] - bb[0], h: bb[3] - bb[1], png: new Uint8Array(0) };
    if (mime !== 'image/png') it.mime = mime;
    (it as { _part?: string })._part = part;
    out.push(it);
  }

  glyphs(el: XEl, parent: Mat, opacity: number, out: SheetItem[]) {
    let s = el.attrs.UnicodeString ?? '';
    if (s.startsWith('{}')) s = s.slice(2);
    if (!s.trim()) {
      if (!s && el.attrs.Indices) this.warnings.add('glyph runs without Unicode text skipped (font glyph indices only)');
      return;
    }
    const m = mul(parent, this.transformOf(el, 'Glyphs.RenderTransform'));
    const fill = this.brush(el.attrs.Fill, el.children.find((c) => c.local === 'Glyphs.Fill'));
    const em = +(el.attrs.FontRenderingEmSize ?? 12);
    const x = +(el.attrs.OriginX ?? 0), y = +(el.attrs.OriginY ?? 0);
    const px = m[0] * x + m[2] * y + m[4], py = m[1] * x + m[3] * y + m[5];
    // direction: local +x; up: local -y (XPS is y down)
    const dx = m[0], dy = m[1];
    const ux = -m[2], uy = -m[3];
    const size = Math.hypot(ux, uy) * em;
    if (!(size > 0)) return;
    const rot = Math.atan2(dy, dx);
    const it: SheetItem = { kind: 'text', x: px, y: py, text: s.replace(/\s+$/, ''), size: +size.toPrecision(5), color: fill?.color ?? '#000000' };
    if (Math.abs(rot) > 1e-6) it.rot = rot;
    if (el.attrs.BidiLevel && +el.attrs.BidiLevel % 2 === 1) it.align = 'right';
    if (!it.text) return;
    void opacity;
    out.push(it);
  }
}

function quad(pts: number[], x1: number, y1: number, x2: number, y2: number) {
  const x0 = pts[pts.length - 2], y0 = pts[pts.length - 1];
  cubicPoints(x0, y0, x0 + (2 / 3) * (x1 - x0), y0 + (2 / 3) * (y1 - y0), x2 + (2 / 3) * (x1 - x2), y2 + (2 / 3) * (y1 - y2), x2, y2, 0.25, pts);
}

/** elliptical arc (SVG/XPS endpoint parametrisation) appended as points */
function arcTo(pts: number[], rx: number, ry: number, rotDeg: number, large: boolean, clockwise: boolean, x: number, y: number) {
  const x0 = pts[pts.length - 2], y0 = pts[pts.length - 1];
  if (!(rx > 0) || !(ry > 0) || (x0 === x && y0 === y)) { pts.push(x, y); return; }
  const phi = (rotDeg * Math.PI) / 180, cp = Math.cos(phi), sp = Math.sin(phi);
  const dx = (x0 - x) / 2, dy = (y0 - y) / 2;
  const x1 = cp * dx + sp * dy, y1 = -sp * dx + cp * dy;
  let lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) { lam = Math.sqrt(lam); rx *= lam; ry *= lam; }
  // in XPS (y down) "Clockwise" corresponds to the SVG sweep flag 1
  const sweep = clockwise;
  let k = Math.sqrt(Math.max(0, (rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1) / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));
  if (large === sweep) k = -k;
  const cxp = (k * rx * y1) / ry, cyp = (-k * ry * x1) / rx;
  const cx = cp * cxp - sp * cyp + (x0 + x) / 2, cy = sp * cxp + cp * cyp + (y0 + y) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry);
  let dt = ang((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry);
  if (!sweep && dt > 0) dt -= Math.PI * 2;
  else if (sweep && dt < 0) dt += Math.PI * 2;
  const n = arcSegs(dt, Math.max(rx, ry), 0.25);
  for (let i = 1; i <= n; i++) {
    const t = t1 + (dt * i) / n;
    if (i === n) { pts.push(x, y); break; }
    const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
    pts.push(cp * ex - sp * ey + cx, sp * ex + cp * ey + cy);
  }
}

function applyMat(m: Mat, p: number[]) {
  for (let i = 0; i + 1 < p.length; i += 2) {
    const x = p[i], y = p[i + 1];
    p[i] = m[0] * x + m[2] * y + m[4];
    p[i + 1] = m[1] * x + m[3] * y + m[5];
  }
}
function boundsOf(rings: number[][]): Rect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rings) for (let i = 0; i + 1 < r.length; i += 2) { x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]); y0 = Math.min(y0, r[i + 1]); y1 = Math.max(y1, r[i + 1]); }
  return isFinite(x0) ? [x0, y0, x1, y1] : null;
}

/** XPS abbreviated geometry syntax ("M 0,0 L 10,0 ...") to subpaths */
export function parseAbbrev(s: string): Array<{ pts: number[]; closed: boolean; filled: boolean; stroked: boolean }> {
  const out: Array<{ pts: number[]; closed: boolean; filled: boolean; stroked: boolean }> = [];
  const re = /([A-Za-z])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
  const tok: Array<string | number> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) tok.push(m[1] !== undefined ? m[1] : parseFloat(m[2]));
  let i = 0;
  let cmd = '';
  let cur: number[] | null = null;
  let x = 0, y = 0, sx = 0, sy = 0;
  let lastC: [number, number] | null = null;
  const num = () => { const v = tok[i]; if (typeof v === 'number') { i++; return v; } return NaN; };
  const start = (nx: number, ny: number) => { cur = [nx, ny]; out.push({ pts: cur, closed: false, filled: true, stroked: true }); x = sx = nx; y = sy = ny; };
  while (i < tok.length) {
    if (typeof tok[i] === 'string') { cmd = tok[i] as string; i++; if (cmd === 'Z' || cmd === 'z') { if (out.length) out[out.length - 1].closed = true; x = sx; y = sy; cur = null; lastC = null; continue; } if (cmd === 'F') { num(); continue; } }
    else if (!cmd) { i++; continue; }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const before = i;
    switch (C) {
      case 'M': { const a = num(), b = num(); if (isNaN(b)) break; start(rel ? x + a : a, rel ? y + b : b); cmd = rel ? 'l' : 'L'; lastC = null; break; }
      case 'L': { const a = num(), b = num(); if (isNaN(b)) break; if (!cur) start(x, y); x = rel ? x + a : a; y = rel ? y + b : b; cur!.push(x, y); lastC = null; break; }
      case 'H': { const a = num(); if (isNaN(a)) break; if (!cur) start(x, y); x = rel ? x + a : a; cur!.push(x, y); lastC = null; break; }
      case 'V': { const a = num(); if (isNaN(a)) break; if (!cur) start(x, y); y = rel ? y + a : a; cur!.push(x, y); lastC = null; break; }
      case 'C': {
        const v = [num(), num(), num(), num(), num(), num()];
        if (v.some(isNaN)) break;
        if (!cur) start(x, y);
        const [x1, y1, x2, y2, x3, y3] = rel ? [x + v[0], y + v[1], x + v[2], y + v[3], x + v[4], y + v[5]] : v;
        cubicPoints(x, y, x1, y1, x2, y2, x3, y3, 0.25, cur!);
        lastC = [x2, y2]; x = x3; y = y3; break;
      }
      case 'S': {
        const v = [num(), num(), num(), num()];
        if (v.some(isNaN)) break;
        if (!cur) start(x, y);
        const [x2, y2, x3, y3] = rel ? [x + v[0], y + v[1], x + v[2], y + v[3]] : v;
        const x1 = lastC ? 2 * x - lastC[0] : x, y1 = lastC ? 2 * y - lastC[1] : y;
        cubicPoints(x, y, x1, y1, x2, y2, x3, y3, 0.25, cur!);
        lastC = [x2, y2]; x = x3; y = y3; break;
      }
      case 'Q': {
        const v = [num(), num(), num(), num()];
        if (v.some(isNaN)) break;
        if (!cur) start(x, y);
        const [x1, y1, x2, y2] = rel ? [x + v[0], y + v[1], x + v[2], y + v[3]] : v;
        quad(cur!, x1, y1, x2, y2);
        x = x2; y = y2; lastC = null; break;
      }
      case 'A': {
        const v = [num(), num(), num(), num(), num(), num(), num()];
        if (v.some(isNaN)) break;
        if (!cur) start(x, y);
        const ex = rel ? x + v[5] : v[5], ey = rel ? y + v[6] : v[6];
        arcTo(cur!, v[0], v[1], v[2], v[3] !== 0, v[4] !== 0, ex, ey);
        x = ex; y = ey; lastC = null; break;
      }
      default: i++;
    }
    if (i === before) i++; // never stall
  }
  return out;
}

async function readDwfx(zip: Zip, onProgress: Progress | undefined, options: DwfOptions, t0: number): Promise<CadResult> {
  const warnings: string[] = [];
  // package root relationships -> FixedDocumentSequence
  const rootRels = await rels(zip, '/');
  let fdseq = rootRels.find((r) => /fixedrepresentation$/i.test(r.type))?.target;
  if (!fdseq) fdseq = zip.list.find((e) => e.key.endsWith('.fdseq'))?.name;
  const has3d = zip.list.some((e) => e.key.endsWith('.w3d') || e.key.includes('com.autodesk.dwf.emodel'));
  if (!fdseq) {
    if (has3d) throw new CadError('unsupported-version', 'DWFx holds only 3D model sections (W3D / HOOPS stream), which are not supported');
    throw new CadError('corrupt', 'DWFx: no FixedDocumentSequence');
  }
  if (!fdseq.startsWith('/')) fdseq = '/' + fdseq;
  const seqTxt = await zip.text(fdseq);
  if (!seqTxt) throw new CadError('corrupt', 'DWFx: FixedDocumentSequence part missing');
  const docs = allEls(parseXml(seqTxt), 'DocumentReference').map((d) => resolvePart(fdseq!, d.attrs.Source ?? ''));
  const pages: Array<{ part: string; w: number; h: number }> = [];
  for (const d of docs) {
    const t = await zip.text(d);
    if (!t) { warnings.push(`document ${d} missing`); continue; }
    for (const pc of allEls(parseXml(t), 'PageContent')) pages.push({ part: resolvePart(d, pc.attrs.Source ?? ''), w: +(pc.attrs.Width ?? 0), h: +(pc.attrs.Height ?? 0) });
  }
  if (!pages.length) throw new CadError(has3d ? 'unsupported-version' : 'corrupt', has3d ? 'DWFx holds only 3D model sections (W3D / HOOPS stream), which are not supported' : 'DWFx: no pages');
  const sheets: RvtSheet2D[] = [];
  let n = 0;
  for (const pg of pages) {
    onProgress?.('page', n / pages.length);
    let txt: string | null = null;
    try { txt = await zip.text(pg.part); } catch (e) { warnings.push(`page ${pg.part} unreadable: ${(e as Error).message}`); continue; }
    if (!txt) { warnings.push(`page ${pg.part} missing`); continue; }
    const doc = parseXml(txt);
    const fp = doc.children.find((c) => c.local === 'FixedPage');
    if (!fp) { warnings.push(`page ${pg.part} has no FixedPage`); continue; }
    const W = +(fp.attrs.Width ?? pg.w) || pg.w, H = +(fp.attrs.Height ?? pg.h) || pg.h;
    const page = new XpsPage(zip, pg.part, H);
    const res = fp.children.find((c) => c.local === 'FixedPage.Resources');
    if (res) await page.loadResources(res);
    const items: SheetItem[] = [];
    try { await page.walk(fp, page.root(), 1, items); }
    catch (e) { page.warnings.add(`page drawing stopped: ${(e as Error).message}`); }
    // load images referenced by image brushes
    for (const it of items) {
      const part = (it as { _part?: string })._part;
      if (it.kind === 'image' && part) {
        let b: Uint8Array | null = null;
        try { b = await zip.read(part); } catch { b = null; }
        if (b) it.png = b; else page.warnings.add(`image ${part} missing`);
        delete (it as { _part?: string })._part;
      }
    }
    const kept = items.filter((it) => (it.kind !== 'image' || it.png.length > 0) && saneItem(it));
    // page name from the DWF section descriptor (ePlot:Page name), else "Page n"
    let name = `Page ${n + 1}`;
    const secDir = pg.part.slice(0, pg.part.lastIndexOf('/') + 1);
    const desc = await zip.text(secDir + 'descriptor.xml');
    if (desc) {
      const pe = parseXml(desc).children[0];
      if (pe?.attrs.name) name = pe.attrs.name;
    }
    n++;
    sheets.push({
      id: n, number: String(n), name, size: { w: +(W * MM).toFixed(3), h: +(H * MM).toFixed(3) }, items: kept, viewports: [],
      completeness: page.warnings.size ? 'partial' : 'full', warnings: [...page.warnings],
    });
  }
  if (has3d) warnings.push('3D model sections (W3D / HOOPS stream format) are not supported and were skipped');
  for (const s of sheets) s.warnings.push(...warnings);
  const info: CadInfo = {
    format: 'DWFx', version: 'XPS/OPC', pages: sheets.length, items: sheets.reduce((a, s) => a + s.items.length, 0),
    has3dSections: has3d ? 1 : 0, ms: Date.now() - t0,
  };
  onProgress?.('done', 1);
  return { kind: '2d', sheets, layers: [] as LayerInfo[], info };
}

// ================================================================== classic DWF

async function readClassic(bytes: Uint8Array, onProgress: Progress | undefined, options: DwfOptions, t0: number): Promise<CadResult> {
  let hdr = '';
  for (let i = 0; i < 12; i++) hdr += String.fromCharCode(bytes[i]);
  const ver = hdr.slice(6, 11);
  const major = parseInt(ver, 10);
  const mode = options.classicDwf ?? 'error';
  const reason = 'classic DWF ' + ver + ': its W2D vector streams use opcodes that are not in the public WHIP! description, so they are not decoded';
  if (mode === 'error') throw new CadError('unsupported-version', reason);
  const sheets: RvtSheet2D[] = [];
  const info: CadInfo = { format: 'DWF (classic)', version: hdr.trim(), ms: 0 };
  if (major >= 6) {
    const zip = new Zip(bytes);
    const manifest = await zip.text('manifest.xml');
    const secs = manifest ? allEls(parseXml(manifest), 'Section').filter((s) => /ePlot$/i.test(s.attrs.type ?? '')) : [];
    let id = 0;
    for (const s of secs) {
      const name = s.attrs.title ?? s.attrs.name ?? `Sheet ${id + 1}`;
      const descName = allEls(s, 'Resource').find((r) => r.attrs.role === 'descriptor')?.attrs.href ?? (s.attrs.name ? `${s.attrs.name}/descriptor.xml` : undefined);
      const descTxt = descName ? await zip.text(descName) : null;
      const desc = descTxt ? parseXml(descTxt).children[0] : null;
      const paper = desc ? firstEl(desc, 'Paper') : undefined;
      const pu = paper?.attrs.units === 'in' ? 25.4 : 1;
      const W = +(paper?.attrs.width ?? 420) * pu, H = +(paper?.attrs.height ?? 297) * pu;
      const items: SheetItem[] = [];
      const warns: string[] = [reason];
      // thumbnail / preview image as a page backdrop
      const res = desc ? allEls(desc, 'Resource').concat(allEls(desc, 'ImageResource')) : [];
      const img = res.find((r) => r.attrs.role === 'preview') ?? res.find((r) => r.attrs.role === 'thumbnail');
      if (img?.attrs.href) {
        const b = await zip.read(img.attrs.href);
        if (b) {
          // keep the preview's aspect ratio, centred on the page
          let iw = W, ih = H;
          if (b[0] === 0x89 && b[1] === 0x50 && b.length > 24) {
            const pw = (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19], ph = (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23];
            if (pw > 0 && ph > 0) { const k = Math.min(W / pw, H / ph); iw = pw * k; ih = ph * k; }
          }
          items.push({ kind: 'image', x: (W - iw) / 2, y: (H - ih) / 2, w: iw, h: ih, png: b, ...(img.attrs.mime === 'image/png' ? {} : { mime: img.attrs.mime }) });
        }
      }
      if (mode === 'experimental' && desc) {
        const gr = allEls(desc, 'GraphicResource').find((r) => r.attrs.role === '2d streaming graphics');
        if (gr?.attrs.href) {
          const w2d = await zip.read(gr.attrs.href);
          if (w2d) {
            const r = decodeW2d(w2d, options.maxItems);
            const tm = (gr.attrs.transform ?? '').split(/\s+/).map(Number);
            const sx = (tm[0] || 1) * pu, tx = (tm[12] || 0) * pu, ty = (tm[13] || 0) * pu;
            scaleItems(r.items, sx, tx, ty);
            items.push(...r.items);
            warns.push(...r.warnings);
          }
        }
      }
      sheets.push({ id: ++id, number: String(id), name, size: { w: W, h: H }, items, viewports: [], completeness: 'outline', warnings: warns });
    }
  } else {
    // pre-6 single stream DWF: try the public opcode set directly
    const r = decodeW2d(bytes, options.maxItems);
    const bb = itemsBounds(r.items) ?? [0, 0, 1, 1];
    const s = 420 / Math.max(1, bb[2] - bb[0]);
    scaleItems(r.items, s, -bb[0] * s, -bb[1] * s);
    sheets.push({ id: 1, number: '1', name: 'Sheet 1', size: { w: (bb[2] - bb[0]) * s, h: (bb[3] - bb[1]) * s }, items: r.items, viewports: [], completeness: r.complete ? 'full' : 'partial', warnings: r.warnings });
  }
  info.pages = sheets.length;
  info.ms = Date.now() - t0;
  onProgress?.('done', 1);
  return { kind: '2d', sheets, layers: [], info };
}

void normName;
