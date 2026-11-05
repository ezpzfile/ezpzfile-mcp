// iCAD SX native file (.icd) reader: 2D drawing views to RvtSheet2D, 3D solids to RvtGeometry.
// Clean-room: the container layout, record framing and entity fields were worked out from sample bytes only
// (see NOTEBOOK.md). No iCAD software, SDK or third-party .icd code or write-ups were used.
// Runs in a Web Worker: no DOM, no Node APIs, no dependencies.

import { inflate } from './inflate.ts';
import { parseXt, bodyFaces } from './xt.ts';
import { FaceMesher, nmesh } from './facemesh.ts';
import { GeomBuilder } from './out.ts';
import type { RvtGeometry, RvtSheet2D, SheetItem } from './types.ts';

export type IcdErrorCode = 'unsupported-version' | 'corrupt' | 'encrypted' | 'too-large' | 'not-format';
export class IcdError extends Error {
  code: IcdErrorCode;
  constructor(code: IcdErrorCode, message: string) { super(message); this.name = 'IcdError'; this.code = code; }
}
export interface LayerInfo { name: string; color: string; visible: boolean; items?: number }
export type IcdInfo = Record<string, string | number>;
export type IcdResult =
  | { kind: '3d'; geometry: RvtGeometry; info: IcdInfo; sheets?: RvtSheet2D[]; layers?: LayerInfo[] }
  | { kind: '2d'; sheets: RvtSheet2D[]; layers: LayerInfo[]; info: IcdInfo };
export interface ReadIcdOptions { maxTriangles?: number; edges?: boolean; curveSegments?: number }

const MAX_BYTES = 512 * 1024 * 1024;

// ------------------------------------------------------------------ header
interface Header { le: boolean; major: number; level: number; name: string; part: string; view: string; stamp: number }

function asciiAt(b: Uint8Array, o: number, s: string): boolean {
  if (o < 0 || o + s.length > b.length) return false;
  for (let i = 0; i < s.length; i++) if (b[o + i] !== s.charCodeAt(i)) return false;
  return true;
}

function endianOf(b: Uint8Array): boolean | null {
  if (b.length < 16) return null;
  if (b[4] === 0x40 && b[5] === 0 && b[6] === 0 && b[7] === 0) return true;
  if (b[4] === 0 && b[5] === 0 && b[6] === 0 && b[7] === 0x40) return false;
  return null;
}

/** "MOD0", a 0x40 header word in either byte order, and a version field 00 vv 00 ll */
export function sniffIcd(bytes: Uint8Array): boolean {
  if (!bytes || bytes.length < 64 || !asciiAt(bytes, 0, 'MOD0')) return false;
  if (endianOf(bytes) === null) return false;
  if (bytes[12] !== 0 || bytes[14] !== 0) return false;
  const major = bytes[13], level = bytes[15];
  return major >= 1 && major <= 30 && level <= 30;
}

let sjis: TextDecoder | null = null;
function decodeSjis(b: Uint8Array): string {
  try { if (!sjis) sjis = new TextDecoder('shift_jis'); return sjis.decode(b); }
  catch { let s = ''; for (const c of b) s += c < 0x80 ? String.fromCharCode(c) : '?'; return s; }
}

function readHeader(b: Uint8Array): Header {
  const le = endianOf(b)!;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let e = 16;
  while (e < Math.min(b.length, 16 + 64) && b[e] !== 0) e++;
  const name = decodeSjis(b.subarray(16, e)).replace(/[\s\u0000]+$/u, '').trim();
  const at = name.indexOf('@');
  return {
    le, major: b[13], level: b[15], name,
    part: at >= 0 ? name.slice(0, at) : name, view: at >= 0 ? name.slice(at + 1) : '',
    stamp: dv.getUint32(8, le),
  };
}

// ------------------------------------------------------------------ records
interface Rec { off: number; len: number; flag: number; sub: number; cls: number; typ: number; id: number }
interface Chunk { off: number; len: number; vis: boolean; kind: number; s4: number; s5: number }
interface ViewBlock { off: number; end: number; name: string; scale: string; recs: Rec[]; skipped: number }

function findAll(b: Uint8Array, tag: string, from = 0, to = b.length): number[] {
  const out: number[] = [];
  const c0 = tag.charCodeAt(0);
  for (let i = from; i + tag.length <= to; i++) if (b[i] === c0 && asciiAt(b, i, tag)) out.push(i);
  return out;
}

function viewBlocks(b: Uint8Array, le: boolean, warn: (m: string) => void): ViewBlock[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const starts = findAll(b, 'V/W0');
  const out: ViewBlock[] = [];
  for (const s of starts) {
    let end = -1;
    for (let i = s + 4; i + 4 <= b.length; i++) if (b[i] === 0x56 && asciiAt(b, i, 'V/W1')) { end = i; break; }
    if (end < 0) { warn('view block without end marker (truncated file?)'); end = b.length; }
    const ascii = (o: number, n: number) => { let r = ''; for (let i = o; i < o + n && i < b.length; i++) { const c = b[i]; r += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : ' '; } return r.trim(); };
    const name = s + 572 <= end ? ascii(s + 564, 8) : '';
    const scale = s + 660 <= end ? ascii(s + 652, 8) : '';
    const recs: Rec[] = [];
    let p = s + 800, skipped = 0;
    while (p + 24 <= end) {
      const len = dv.getUint32(p, le);
      const okHdr = (b[p + 4] === 1 || b[p + 4] === 2) && b[p + 5] === 0 && b[p + 6] === 0 && b[p + 7] === 0;
      if (!okHdr || len < 24 || p + len > end) { p += 4; skipped++; if (skipped > 100000) break; continue; }
      const id = dv.getUint32(p + 16, le) & 0x7fffffff;
      recs.push({ off: p, len, flag: b[p + 12], sub: b[p + 13], cls: b[p + 14], typ: b[p + 15], id });
      p += len;
    }
    out.push({ off: s, end, name, scale, recs, skipped });
  }
  return out;
}

function chunksOf(b: Uint8Array, dv: DataView, le: boolean, r: Rec): Chunk[] {
  const out: Chunk[] = [];
  let q = r.off + 24;
  const end = r.off + r.len;
  while (q + 8 <= end) {
    const len = dv.getUint16(q, le);
    if (len < 8 || q + len > end) break;
    out.push({ off: q, len, vis: b[q + 2] === 0x44, kind: b[q + 3], s4: b[q + 4], s5: b[q + 5] });
    q += len;
  }
  return out;
}

const is3dRecord = (r: Rec) => r.flag === 0xe1 || r.flag === 0xc1 || r.flag === 0x81 || r.flag === 0xc0;

// ------------------------------------------------------------------ 2D
// Style bytes per chunk: s4 (0x02 / 0x03 / 0x83) and s5 (high nibble colour number, low nibble line type).
// The palette and the dash patterns are our guesses (iCAD's own tables are not in the file).
const PALETTE: Record<number, string> = {
  1: '#000000', 2: '#d01010', 3: '#109010', 4: '#1040d0', 5: '#c08000', 6: '#a020a0', 7: '#008a8a', 8: '#606060',
  9: '#8a4a00', 10: '#4a8a00', 11: '#004a8a', 12: '#8a008a', 13: '#505050', 14: '#909090', 15: '#303030',
};
function styleLayer(s4: number, s5: number): string {
  const lt = s5 & 15;
  if (lt === 0x0b) return 'Centre lines';
  if (lt !== 1) return 'Hidden lines';
  if ((s4 & 15) === 3 || (s4 & 0x80)) return 'Thin lines';
  return 'Outlines';
}

interface Sheet2D { sheet: RvtSheet2D; counts: Record<string, number> }

function drawView(b: Uint8Array, dv: DataView, le: boolean, v: ViewBlock, id: number, title: string, warnings: string[]): Sheet2D | null {
  const items: SheetItem[] = [];
  const counts: Record<string, number> = { lines: 0, arcs: 0, circles: 0, texts: 0, arrows: 0, points: 0, dimensions: 0, skippedChunks: 0, hiddenChunks: 0 };
  const f64 = (o: number) => dv.getFloat64(o, le);
  const f32 = (o: number) => dv.getFloat32(o, le);
  const textH: number[] = [];
  type Raw = { it: SheetItem; style: 'thick' | 'thin'; lt: number };
  const raw: Raw[] = [];
  const fin = (...xs: number[]) => xs.every((x) => Number.isFinite(x) && Math.abs(x) < 1e9);
  for (const r of v.recs) {
    if (is3dRecord(r)) continue;
    const dim = r.cls === 0x0a || r.cls === 0x0b || r.cls === 0x0e;
    if (dim) counts.dimensions++;
    for (const c of chunksOf(b, dv, le, r)) {
      const p = c.off + 8;
      if (c.kind === 0xfd || c.kind === 0x4f) continue;
      if (!c.vis) { counts.hiddenChunks++; continue; }
      const color = PALETTE[c.s5 >> 4] ?? '#000000';
      const thin = (c.s4 & 15) === 3 || (c.s4 & 0x80) !== 0 || dim;
      const lt = c.s5 & 15;
      const layer = dim ? 'Dimensions' : styleLayer(c.s4, c.s5);
      if (c.kind === 0x02 && c.len >= 48) {
        const x = f64(p), y = f64(p + 8), dx = f64(p + 16), dy = f64(p + 24), l = f64(p + 32);
        if (!fin(x, y, dx, dy, l)) { counts.skippedChunks++; continue; }
        raw.push({ it: { kind: 'line', pts: [x, y, x + dx * l, y + dy * l], color, layer }, style: thin ? 'thin' : 'thick', lt });
        counts.lines++;
      } else if ((c.kind === 0x04 || c.kind === 0x05) && c.len >= 48) {
        const cx = f64(p), cy = f64(p + 8), rr = f64(p + 16), a = f64(p + 24), sw = f64(p + 32);
        if (!fin(cx, cy, rr, a, sw) || !(rr > 0)) { counts.skippedChunks++; continue; }
        const full = Math.abs(sw) >= Math.PI * 2 - 1e-9;
        const a0 = full ? 0 : sw >= 0 ? a : a + sw, a1 = full ? Math.PI * 2 : sw >= 0 ? a + sw : a;
        raw.push({ it: { kind: 'arc', cx, cy, r: rr, a0, a1, color, layer }, style: thin ? 'thin' : 'thick', lt });
        if (full) counts.circles++; else counts.arcs++;
      } else if (c.kind === 0x03 && c.len >= 56) {
        const x = f64(p), y = f64(p + 8), ax = f64(p + 16), ay = f64(p + 24), bx = f64(p + 32), by = f64(p + 40);
        if (!fin(x, y, ax, ay, bx, by)) { counts.skippedChunks++; continue; }
        const cr = ax * by - ay * bx, la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
        if (Math.abs(cr) <= 1e-6 * la * lb || la === 0 || lb === 0) {
          // three collinear points: a line from p to the farthest of the two
          const [ex, ey] = la >= lb ? [x + ax, y + ay] : [x + bx, y + by];
          raw.push({ it: { kind: 'line', pts: [x, y, ex, ey], color, layer }, style: 'thin', lt });
          counts.lines++;
        } else {
          raw.push({ it: { kind: 'fill', pts: [x, y, x + ax, y + ay, x + bx, y + by], color, layer }, style: 'thin', lt });
          counts.arrows++;
        }
      } else if (c.kind === 0x20 && c.len >= 56) {
        // +32: text angle as a binary angle, 2^31 = one full turn (checked against the dimension line directions)
        const x = f64(p), y = f64(p + 8), h = f32(p + 16), rot = (dv.getUint32(p + 32, le) / 2147483648) * Math.PI * 2;
        const n = dv.getUint32(p + 44, le);
        if (!fin(x, y, h) || n > 4096 || p + 48 + n * 2 > c.off + c.len) { counts.skippedChunks++; continue; }
        let s = '';
        // font byte 0x40 (V5 files): characters are 2-byte Shift_JIS codes; otherwise UCS-2 in file byte order
        if (b[p + 40] === 0x40) s = decodeSjis(b.subarray(p + 48, p + 48 + n * 2));
        else for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint16(p + 48 + 2 * i, le));
        s = s.normalize('NFKC').replace(/\u0000+$/u, '');
        if (!s.trim()) continue;
        const it: SheetItem = { kind: 'text', x, y, text: s, size: h > 0 ? h : 1, color, layer: dim ? 'Dimensions' : 'Text' };
        if (rot > 1e-9 && rot < Math.PI * 2 - 1e-9) it.rot = rot;
        raw.push({ it, style: 'thin', lt: 1 });
        textH.push(h);
        counts.texts++;
      } else if (c.kind === 0x01 && c.len >= 32) {
        counts.points++;
        if (r.cls === 0x01) {
          const x = f64(p), y = f64(p + 8);
          if (!fin(x, y)) continue;
          raw.push({ it: { kind: 'line', pts: [x, y, x, y], color, layer: 'Points' }, style: 'thin', lt: 1 });
        }
      } else counts.skippedChunks++;
    }
  }
  if (!raw.length) return null;
  // extents
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
  for (const { it } of raw) {
    if (it.kind === 'line' || it.kind === 'fill') for (let i = 0; i < it.pts.length; i += 2) add(it.pts[i], it.pts[i + 1]);
    else if (it.kind === 'arc') { add(it.cx - it.r, it.cy - it.r); add(it.cx + it.r, it.cy + it.r); }
    else if (it.kind === 'text') { add(it.x, it.y); add(it.x + it.size * it.text.length * 0.8, it.y + it.size); }
  }
  const ext = Math.max(x1 - x0, y1 - y0, 1e-6);
  textH.sort((a, b) => a - b);
  // annotation unit: the median text height (the drawings use their own annotation scale)
  const u = textH.length ? textH[textH.length >> 1] : ext / 60;
  const margin = Math.max(ext * 0.04, u * 2);
  const ox = x0 - margin, oy = y0 - margin;
  const dash = (lt: number): number[] | undefined => {
    if (lt === 1) return undefined;
    if (lt === 0x0b) return [2.4 * u, 0.4 * u, 0.4 * u, 0.4 * u];
    if (lt === 8) return [0.8 * u, 0.4 * u];
    return [1.2 * u, 0.4 * u];
  };
  for (const { it, style, lt } of raw) {
    if (it.kind === 'line' || it.kind === 'fill') {
      for (let i = 0; i < it.pts.length; i += 2) { it.pts[i] -= ox; it.pts[i + 1] -= oy; }
      if (it.kind === 'line') {
        it.w = style === 'thick' ? 0.14 * u : 0.07 * u;
        const d = dash(lt); if (d) it.dash = d;
        if (it.layer === 'Points') { const x = it.pts[0], y = it.pts[1], k = 0.25 * u; it.pts = [x - k, y, x + k, y]; items.push({ kind: 'line', pts: [x, y - k, x, y + k], w: it.w, color: it.color, layer: 'Points' }); }
      }
    } else if (it.kind === 'arc') { it.cx -= ox; it.cy -= oy; it.w = style === 'thick' ? 0.14 * u : 0.07 * u; }
    else if (it.kind === 'text') { it.x -= ox; it.y -= oy; }
    items.push(it);
  }
  const W = x1 - x0 + 2 * margin, H = y1 - y0 + 2 * margin;
  void warnings;
  return {
    sheet: {
      id, number: String(id), name: title, size: { w: W, h: H }, items,
      viewports: [{
        viewId: id, viewName: v.name || title, box: [margin, margin, W - margin, H - margin], scale: 1, viewType: 'drafting',
        levelId: null, levelName: null, cutHeight: null, crop: null, detailNumber: null, xform: null, annotations: counts.dimensions,
      }],
      completeness: counts.skippedChunks ? 'partial' : 'full', warnings: [], origin: [ox, oy],
    },
    counts,
  };
}

// ------------------------------------------------------------------ 3D
interface SolidRec { off: number; len: number; id: number; usize: number; flags: number; n: number; o: number[]; z: number[]; x: number[]; zoff: number }

function solidRecords(b: Uint8Array, le: boolean): SolidRec[] {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: SolidRec[] = [];
  const m0 = le ? 0x86 : 0x00, m1 = le ? 0x04 : 0x68, m2 = le ? 0x68 : 0x04, m3 = le ? 0x00 : 0x86;
  for (let i = 0; i + 104 <= b.length; i++) {
    if (b[i] !== m0 || b[i + 1] !== m1 || b[i + 2] !== m2 || b[i + 3] !== m3) continue;
    const len = dv.getUint32(i + 4, le), n = dv.getUint32(i + 28, le);
    if (len < 104 || i + len > b.length || n > 100000) continue;
    const zoff = i + 104 + 16 * n;
    if (zoff + 2 > i + len || b[zoff] !== 0x78) continue;
    const d = (k: number) => dv.getFloat64(i + 32 + 8 * k, le);
    out.push({
      off: i, len, id: dv.getUint32(i + 8, le) & 0x7fffffff, usize: dv.getUint32(i + 16, le), flags: dv.getUint32(i + 20, le), n,
      o: [d(0), d(1), d(2)], z: [d(3), d(4), d(5)], x: [d(6), d(7), d(8)], zoff,
    });
    i += len - 1;
  }
  return out;
}

const BODY_COLORS: [number, number, number][] = [[0.64, 0.66, 0.70], [0.78, 0.72, 0.56], [0.55, 0.62, 0.72], [0.70, 0.60, 0.62]];

function buildSolids(b: Uint8Array, le: boolean, part: string, opts: ReadIcdOptions, onProgress: ((s: string, r: number) => void) | undefined, info: IcdInfo): RvtGeometry | null {
  const recs = solidRecords(b, le);
  if (!recs.length) return null;
  const gb = new GeomBuilder(opts.maxTriangles ?? 20_000_000);
  let faces = 0, failed = 0, unsupported = 0, fallback = 0;
  const schemas = new Set<string>();
  recs.forEach((sr, k) => {
    onProgress?.('solids', k / recs.length);
    const label = `solid ${k + 1} (#${sr.id.toString(16)})`;
    let stream: Uint8Array;
    try {
      stream = inflate(b, sr.zoff, true, 64 * 1024 * 1024).out;
    } catch (e) { gb.warn(`${label}: compressed solid data unreadable (${(e as Error).message})`); failed++; return; }
    if (sr.usize && stream.length !== sr.usize) gb.warn(`${label}: inflated size ${stream.length} differs from the stored ${sr.usize}`);
    let parsed;
    try { parsed = parseXt(stream); }
    catch (e) { gb.warn(`${label}: solid data not decoded (${(e as Error).message})`); failed++; return; }
    schemas.add(parsed.schema);
    const body = bodyFaces(parsed.nodes, opts.curveSegments ?? 64);
    for (const w of body.warnings) gb.warn(`${label}: ${w}`);
    faces += body.faceCount; unsupported += body.unsupported;
    // body frame: local metres -> iCAD world mm -> output metres, Z up
    const Z = norm(sr.z);
    let X = sub(sr.x, scale(Z, dot(sr.x, Z)));
    if (len(X) < 1e-9) X = Math.abs(Z[0]) < 0.9 ? sub([1, 0, 0], scale(Z, Z[0])) : sub([0, 1, 0], scale(Z, Z[1]));
    X = norm(X);
    const Y = cross(Z, X);
    const O = sr.o;
    const toOut = (p: ArrayLike<number>, i: number, out: number[]) => {
      const lx = p[i] * 1000, ly = p[i + 1] * 1000, lz = p[i + 2] * 1000;
      const wx = O[0] + lx * X[0] + ly * Y[0] + lz * Z[0];
      const wy = O[1] + lx * X[1] + ly * Y[1] + lz * Z[1];
      const wz = O[2] + lx * X[2] + ly * Y[2] + lz * Z[2];
      out[0] = wx / 1000; out[1] = -wz / 1000; out[2] = wy / 1000;
    };
    const rotN = (n: ArrayLike<number>, i: number, out: number[]) => {
      const wx = n[i] * X[0] + n[i + 1] * Y[0] + n[i + 2] * Z[0];
      const wy = n[i] * X[1] + n[i + 1] * Y[1] + n[i + 2] * Z[1];
      const wz = n[i] * X[2] + n[i + 1] * Y[2] + n[i + 2] * Z[2];
      out[0] = wx; out[1] = -wz; out[2] = wy;
    };
    const fm = new FaceMesher(1e-9, (m) => gb.warn(`${label}: ${m}`));
    const m = nmesh();
    for (const f of body.faces) {
      try { fm.face(f.surf, f.loops, m, f.same); }
      catch (e) { gb.warn(`${label}: face not tessellated (${(e as Error).message})`); }
    }
    fallback += fm.faceFallback;
    const P = new Float64Array(m.pos.length), N = new Float64Array(m.nrm.length);
    const t = [0, 0, 0];
    for (let i = 0; i < m.pos.length; i += 3) { toOut(m.pos, i, t); P[i] = t[0]; P[i + 1] = t[1]; P[i + 2] = t[2]; rotN(m.nrm, i, t); N[i] = t[0]; N[i + 1] = t[1]; N[i + 2] = t[2]; }
    const el = gb.element({ name: `${part} ${label}`, className: 'Solid', categoryName: 'Solids', typeName: parsed.schema, familyName: part || null });
    const col = BODY_COLORS[k % BODY_COLORS.length];
    const bi = gb.bucket('Solids', { key: `body${k % BODY_COLORS.length}`, name: `iCAD solid colour ${k % BODY_COLORS.length + 1}`, color: col });
    gb.addMesh(el, bi, P, N, m.idx);
    if (opts.edges !== false) {
      for (const e of body.edges) {
        const pos: number[] = [], pairs: number[] = [];
        for (let i = 0; i < e.length; i += 3) { toOut(e, i, t); pos.push(t[0], t[1], t[2]); if (i) pairs.push(i / 3 - 1, i / 3); }
        gb.addSegments('Solids', el, pos, pairs, null);
      }
    }
  });
  if (fallback) gb.warn(`${fallback} curved faces filled flat (boundary did not map to the surface)`);
  if (unsupported) gb.warn(`${unsupported} faces on unsupported surface types skipped`);
  const g = gb.finish(1);
  g.stats.skippedFaces += unsupported;
  info.solids = recs.length;
  info.solidsDecoded = recs.length - failed;
  info.solidFaces = faces;
  if (schemas.size) info.solidSchema = [...schemas].join(', ');
  return g.stats.triangles ? g : (failed === recs.length ? null : g);
}

const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: number[], s: number) => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: number[]) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: number[]) => { const l = len(a); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1]; };

// ------------------------------------------------------------------ 3D primitive records (informational)
/** counts of the 3D feature records in the 3D view (primitive shapes, solid groups, 3D dimensions) */
function count3d(b: Uint8Array, v: ViewBlock): Record<string, number> {
  const c: Record<string, number> = {};
  for (const r of v.recs) {
    if (!is3dRecord(r)) continue;
    const k = r.flag === 0xe1 ? 'primitives' : r.flag === 0xc1 ? 'solidGroups' : r.flag === 0xc0 ? 'dimensions3d' : 'parameterTables';
    c[k] = (c[k] ?? 0) + 1;
  }
  void b;
  return c;
}

// ------------------------------------------------------------------ entry point
export async function readIcd(bytes: Uint8Array, onProgress?: (stage: string, ratio: number) => void, opts: ReadIcdOptions = {}): Promise<IcdResult> {
  const t0 = Date.now();
  if (!bytes || bytes.length < 64 || !asciiAt(bytes, 0, 'MOD0')) throw new IcdError('not-format', 'not an iCAD file (no MOD0 signature)');
  if (endianOf(bytes) === null) throw new IcdError('not-format', 'MOD0 signature without the iCAD header word');
  if (bytes.length > MAX_BYTES) throw new IcdError('too-large', `file larger than ${MAX_BYTES >> 20} MB`);
  if (bytes[12] !== 0 || bytes[14] !== 0 || bytes[13] < 1 || bytes[13] > 30) throw new IcdError('unsupported-version', `unknown version field ${Array.from(bytes.subarray(12, 16), (x) => x.toString(16).padStart(2, '0')).join(' ')}`);
  onProgress?.('header', 0);
  const h = readHeader(bytes);
  const warnings: string[] = [];
  const warn = (m: string) => { if (!warnings.includes(m)) warnings.push(m); };
  if (!findAll(bytes, 'MOD1', 0, Math.min(bytes.length, 4096)).length) warn('MOD1 marker not found where expected');
  const views = viewBlocks(bytes, h.le, warn);
  if (!views.length) throw new IcdError('corrupt', 'no view blocks (V/W0) found');
  onProgress?.('records', 0.2);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const info: IcdInfo = {
    format: 'iCAD SX', version: `V${h.major}L${h.level}`, byteOrder: h.le ? 'little-endian' : 'big-endian',
    name: h.name, part: h.part, view: h.view, views: views.length,
    records: views.reduce((s, v) => s + v.recs.length, 0),
  };
  const sheets: RvtSheet2D[] = [];
  const layerCount = new Map<string, number>();
  let has3dView = false;
  views.forEach((v, i) => {
    const is3d = v.recs.some(is3dRecord);
    if (is3d) { has3dView = true; for (const [k, n] of Object.entries(count3d(bytes, v))) info[k] = ((info[k] as number) ?? 0) + n; }
    if (v.skipped * 4 > (v.end - v.off) * 0.25) warn(`view ${i + 1}: ${v.skipped} words skipped between records (record framing partly not understood)`);
    const title = views.length > 1 ? `${h.name} (${v.name || 'view ' + (i + 1)})` : h.name;
    const s = drawView(bytes, dv, h.le, v, sheets.length + 1, title, warnings);
    if (!s) return;
    const visible = s.sheet.items.filter((it) => it.layer !== 'Points').length;
    if (!visible) return;
    if (is3d && visible < 3) return;
    sheets.push(s.sheet);
    for (const [k, n] of Object.entries(s.counts)) info[`2d.${k}`] = ((info[`2d.${k}`] as number) ?? 0) + n;
    for (const it of s.sheet.items) { const l = it.layer ?? ''; layerCount.set(l, (layerCount.get(l) ?? 0) + 1); }
  });
  onProgress?.('solids', 0.4);
  let geometry: RvtGeometry | null = null;
  if (has3dView || solidRecords(bytes, h.le).length) {
    try { geometry = buildSolids(bytes, h.le, h.part, opts, onProgress, info); }
    catch (e) { warn(`3D solids not built: ${(e as Error).message}`); }
  }
  const LCOL: Record<string, string> = { Outlines: '#000000', 'Thin lines': '#000000', 'Hidden lines': '#000000', 'Centre lines': '#1040d0', Dimensions: '#000000', Text: '#000000', Points: '#808080' };
  const layers: LayerInfo[] = [...layerCount.entries()].map(([name, n]) => ({ name, color: LCOL[name] ?? '#000000', visible: name !== 'Points', items: n }));
  info.sheets = sheets.length;
  info.ms = Date.now() - t0;
  onProgress?.('done', 1);
  if (geometry) {
    geometry.warnings.push(...warnings);
    geometry.stats.ms = Date.now() - t0;
    const res: IcdResult = { kind: '3d', geometry, info };
    if (sheets.length) { res.sheets = sheets; res.layers = layers; }
    return res;
  }
  if (!sheets.length) {
    if (has3dView) throw new IcdError('corrupt', '3D file whose solids could not be decoded');
    throw new IcdError('corrupt', 'no drawable entities found');
  }
  for (const s of sheets) s.warnings.push(...warnings);
  return { kind: '2d', sheets, layers, info };
}

// ------------------------------------------------------------------ diagnostics (tests and cross checks)
export interface IcdDim { cls: string; text: string; value: number | null; measured: number | null }
export interface IcdPrimitive { id: number; group: number; kind: number; origin: number[]; axis: number[]; ref: number[]; params: number[] }
/** dimension texts with the size measured from the dimension's own geometry, and the 3D primitive records */
export function icdDebug(bytes: Uint8Array): { dims: IcdDim[]; primitives: IcdPrimitive[] } {
  const le = endianOf(bytes);
  if (le === null) return { dims: [], primitives: [] };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dims: IcdDim[] = [], primitives: IcdPrimitive[] = [];
  const f64 = (o: number) => dv.getFloat64(o, le);
  for (const v of viewBlocks(bytes, le, () => {})) {
    let group = 0;
    for (const r of v.recs) {
      const ch = chunksOf(bytes, dv, le, r);
      if (r.flag === 0xe1) {
        for (const c of ch) if (c.vis && c.len >= 24 + 72) {
          const ref = dv.getUint32(c.off + 8, le) & 0x7fffffff;
          if (ref) group = ref;
          const n = (c.len - 24) / 8, d: number[] = [];
          for (let i = 0; i < n; i++) d.push(f64(c.off + 24 + 8 * i));
          primitives.push({ id: r.id, group, kind: c.kind, origin: d.slice(0, 3), axis: d.slice(3, 6), ref: d.slice(6, 9), params: d.slice(9) });
        }
        continue;
      }
      const cls = r.cls === 0x0b && r.typ === 0x19 ? 'linear' : r.cls === 0x0a ? 'radial' : r.cls === 0x0e ? 'angular' : r.cls === 0x0b ? 'arc' : '';
      if (!cls || is3dRecord(r)) continue;
      let text = '', dir: number[] | null = null, arcR: number | null = null, sweep: number | null = null, hsweep: number | null = null;
      const pts: number[][] = [];
      for (const c of ch) {
        const p = c.off + 8;
        if (c.kind === 0x20 && c.vis && !text) {
          const n = dv.getUint32(p + 44, le);
          if (bytes[p + 40] === 0x40) text = decodeSjis(bytes.subarray(p + 48, p + 48 + n * 2)).normalize('NFKC');
          else { for (let i = 0; i < n; i++) text += String.fromCharCode(dv.getUint16(p + 48 + 2 * i, le)); text = text.normalize('NFKC'); }
        } else if (c.kind === 0x02 && c.vis && !dir) dir = [f64(p + 16), f64(p + 24)];
        else if (c.kind === 0x01 && !c.vis) pts.push([f64(p), f64(p + 8)]);
        else if (c.kind === 0x05 && !c.vis && arcR === null) { arcR = f64(p + 16); hsweep = Math.abs(f64(p + 32)); }
        else if (c.kind === 0x05 && c.vis && sweep === null) sweep = Math.abs(f64(p + 32));
      }
      const m = /-?\d+(\.\d+)?/.exec(text);
      const value = m ? parseFloat(m[0]) : null;
      let measured: number | null = null;
      if (cls === 'linear' && dir && pts.length >= 2) {
        // the last two hidden points are the measured object points (the first two anchor the text)
        const a = pts[pts.length - 2], c = pts[pts.length - 1];
        measured = Math.abs((c[0] - a[0]) * dir[0] + (c[1] - a[1]) * dir[1]);
      } else if (cls === 'radial' || cls === 'arc') { if (arcR !== null) measured = /φ|Φ/u.test(text) ? 2 * arcR : arcR; }
      else if (cls === 'angular' && (hsweep ?? sweep) !== null) measured = ((hsweep ?? sweep)! * 180) / Math.PI;
      dims.push({ cls, text, value, measured });
    }
  }
  return { dims, primitives };
}
