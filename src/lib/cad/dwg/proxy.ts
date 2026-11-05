// Proxy entity graphics (ODS chapter 29): the cached drawing of custom entities (Civil 3D, Architecture, ...).
// Output primitives are in WCS, projected to XY.
import { BitReader } from './bits.ts';
import { decodeLwData } from './entities.ts';
import { bulgePts } from './geom.ts';

export interface ProxyPrim {
  t: 'line' | 'fill' | 'arc' | 'text';
  pts?: number[]; cx?: number; cy?: number; r?: number; a0?: number; a1?: number;
  x?: number; y?: number; text?: string; h?: number; rot?: number;
  aci: number; rgb: number | null;
}

type M4 = number[]; // row major 4x4

function mul4(a: M4, b: M4): M4 {
  const o = new Array(16).fill(0);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += a[i * 4 + k] * b[k * 4 + j]; o[i * 4 + j] = s; }
  return o;
}

export function parseProxyGraphics(g: Uint8Array, ver: number, decoder: TextDecoder): ProxyPrim[] {
  const out: ProxyPrim[] = [];
  if (g.length < 8) return out;
  const dv = new DataView(g.buffer, g.byteOffset, g.length);
  const stack: M4[] = [];
  let M: M4 | null = null;
  let aci = 256, rgb: number | null = null, fillOn = false;
  const P = (o: number): [number, number] => {
    const x = dv.getFloat64(o, true), y = dv.getFloat64(o + 8, true), z = dv.getFloat64(o + 16, true);
    if (!M) return [x, y];
    return [M[0] * x + M[1] * y + M[2] * z + M[3], M[4] * x + M[5] * y + M[6] * z + M[7]];
  };
  const V = (o: number): [number, number] => {
    const x = dv.getFloat64(o, true), y = dv.getFloat64(o + 8, true), z = dv.getFloat64(o + 16, true);
    if (!M) return [x, y];
    return [M[0] * x + M[1] * y + M[2] * z, M[4] * x + M[5] * y + M[6] * z];
  };
  const scaleOf = () => (M ? Math.sqrt(Math.abs(M[0] * M[5] - M[1] * M[4])) || 1 : 1);
  const str8 = (o: number, end: number): [string, number] => {
    let e = o; while (e < end && g[e] !== 0) e++;
    const s = decoder.decode(g.subarray(o, e));
    return [s, Math.min(end, ((e + 1 + 3) & ~3))];
  };
  const str16 = (o: number, end: number): [string, number] => {
    let s = ''; let q = o;
    while (q + 1 < end) { const c = dv.getUint16(q, true); q += 2; if (!c) break; s += String.fromCharCode(c); }
    return [s, Math.min(end, (q + 3) & ~3)];
  };
  const push = (p: ProxyPrim) => { if (out.length < 200000) out.push(p); };
  let p = 8;
  for (let guard = 0; p + 8 <= g.length && guard < 1000000; guard++) {
    const size = dv.getUint32(p, true), type = dv.getUint32(p + 4, true);
    if (size < 8 || p + size > g.length) break;
    const d = p + 8, end = p + size;
    try {
      switch (type) {
        case 2: { // circle
          const c = P(d), r = dv.getFloat64(d + 24, true) * scaleOf();
          push({ t: 'arc', cx: c[0], cy: c[1], r, a0: 0, a1: Math.PI * 2, aci, rgb });
          break;
        }
        case 3: case 5: { // 3 point circle / arc
          const a = P(d), b = P(d + 24), c = P(d + 48);
          const ax = a[0], ay = a[1], bx = b[0], by = b[1], cx = c[0], cy = c[1];
          const den = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
          if (Math.abs(den) < 1e-18) { push({ t: 'line', pts: [ax, ay, bx, by, cx, cy], aci, rgb }); break; }
          const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / den;
          const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / den;
          const r = Math.hypot(ax - ux, ay - uy);
          if (type === 3) { push({ t: 'arc', cx: ux, cy: uy, r, a0: 0, a1: Math.PI * 2, aci, rgb }); break; }
          let a0 = Math.atan2(ay - uy, ax - ux), a1 = Math.atan2(cy - uy, cx - ux);
          const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
          if (cross < 0) { const t = a0; a0 = a1; a1 = t; }
          push({ t: 'arc', cx: ux, cy: uy, r, a0, a1, aci, rgb });
          break;
        }
        case 4: { // circular arc: centre, radius, normal, start vector, sweep
          const c = P(d), r = dv.getFloat64(d + 24, true) * scaleOf();
          const nz = dv.getFloat64(d + 48, true);
          const sv = V(d + 56);
          const sweep = dv.getFloat64(d + 80, true);
          let a0 = Math.atan2(sv[1], sv[0]);
          let a1 = a0 + sweep;
          if (nz < 0) { a1 = a0 - sweep; const t = a0; a0 = a1; a1 = t; }
          push({ t: 'arc', cx: c[0], cy: c[1], r, a0, a1, aci, rgb });
          break;
        }
        case 6: case 7: case 32: { // polyline, polygon, polyline with normal
          const n = dv.getUint32(d, true);
          if (n > 1000000 || d + 4 + n * 24 > end) break;
          const pts: number[] = [];
          for (let i = 0; i < n; i++) { const q = P(d + 4 + i * 24); pts.push(q[0], q[1]); }
          if (type === 7) {
            if (fillOn) push({ t: 'fill', pts, aci, rgb });
            else { pts.push(pts[0], pts[1]); push({ t: 'line', pts, aci, rgb }); }
          } else push({ t: 'line', pts, aci, rgb });
          break;
        }
        case 8: { // mesh: wire edges
          const rows = dv.getUint32(d, true), cols = dv.getUint32(d + 4, true);
          if (rows * cols > 1000000 || d + 8 + rows * cols * 24 > end) break;
          const v = (i: number, j: number) => P(d + 8 + (i * cols + j) * 24);
          for (let i = 0; i < rows; i++) { const pts: number[] = []; for (let j = 0; j < cols; j++) pts.push(...v(i, j)); push({ t: 'line', pts, aci, rgb }); }
          for (let j = 0; j < cols; j++) { const pts: number[] = []; for (let i = 0; i < rows; i++) pts.push(...v(i, j)); push({ t: 'line', pts, aci, rgb }); }
          break;
        }
        case 9: { // shell: faces as outlines (or fills)
          const nv = dv.getUint32(d, true);
          if (nv > 1000000 || d + 4 + nv * 24 + 4 > end) break;
          const verts: [number, number][] = [];
          for (let i = 0; i < nv; i++) verts.push(P(d + 4 + i * 24));
          let q = d + 4 + nv * 24;
          const nf = dv.getUint32(q, true); q += 4;
          let k = 0;
          while (k < nf && q + 4 <= end) {
            const cnt = Math.abs(dv.getInt32(q, true)); q += 4; k++;
            const pts: number[] = [];
            for (let i = 0; i < cnt && q + 4 <= end; i++) { const vi = dv.getInt32(q, true); q += 4; k++; const vv = verts[vi]; if (vv) pts.push(vv[0], vv[1]); }
            if (pts.length >= 6) {
              if (fillOn) push({ t: 'fill', pts, aci, rgb });
              else { pts.push(pts[0], pts[1]); push({ t: 'line', pts, aci, rgb }); }
            }
          }
          break;
        }
        case 10: case 36: { // text: point, normal, direction, height, width, oblique, string
          const s0 = P(d), dir = V(d + 48);
          const h = dv.getFloat64(d + 72, true) * scaleOf();
          const [txt] = type === 10 ? str8(d + 96, end) : str16(d + 96, end);
          push({ t: 'text', x: s0[0], y: s0[1], text: txt, h, rot: Math.atan2(dir[1], dir[0]), aci, rgb });
          break;
        }
        case 11: case 38: { // text 2
          const s0 = P(d), dir = V(d + 48);
          const [txt, q] = type === 11 ? str8(d + 72, end) : str16(d + 72, end);
          const h = q + 16 <= end ? dv.getFloat64(q + 8, true) * scaleOf() : 0;
          push({ t: 'text', x: s0[0], y: s0[1], text: txt, h, rot: Math.atan2(dir[1], dir[0]), aci, rgb });
          break;
        }
        case 14: aci = dv.getInt32(d, true); rgb = null; break;
        case 20: fillOn = dv.getUint32(d, true) === 1; break;
        case 22: rgb = (g[d] << 16) | (g[d + 1] << 8) | g[d + 2]; break;
        case 29: case 30: {
          const m: M4 = []; for (let i = 0; i < 16; i++) m.push(dv.getFloat64(d + i * 8, true));
          stack.push(M || [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
          M = M ? mul4(M, m) : m;
          break;
        }
        case 31: { M = stack.length ? stack.pop()! : null; if (M && M.every((v, i) => v === (i % 5 === 0 ? 1 : 0))) M = null; break; }
        case 33: { // embedded LWPOLYLINE
          const n = dv.getUint32(d, true);
          if (d + 4 + n > end) break;
          const r = new BitReader(g, (d + 4) * 8, (d + 4 + n) * 8, ver, decoder);
          const lw = decodeLwData(r, ver);
          const np = lw.pts.length / 2;
          if (np < 2) break;
          const raw: number[] = [lw.pts[0], lw.pts[1]];
          const segs = lw.closed ? np : np - 1;
          for (let i = 0; i < segs; i++) { const j = (i + 1) % np; bulgePts(lw.pts[i * 2], lw.pts[i * 2 + 1], lw.pts[j * 2], lw.pts[j * 2 + 1], lw.bulges[i] || 0, raw); }
          const pts: number[] = [];
          const z = lw.elev || 0;
          for (let i = 0; i < raw.length; i += 2) {
            if (!M) pts.push(raw[i], raw[i + 1]);
            else pts.push(M[0] * raw[i] + M[1] * raw[i + 1] + M[2] * z + M[3], M[4] * raw[i] + M[5] * raw[i + 1] + M[6] * z + M[7]);
          }
          push({ t: 'line', pts, aci, rgb });
          break;
        }
        default: break;
      }
    } catch { /* skip a broken chunk */ }
    p = end;
  }
  return out;
}
