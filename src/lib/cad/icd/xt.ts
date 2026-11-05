// Reader for the solid streams embedded in iCAD SX 3D files.
// iCAD keeps one zlib-compressed stream per solid. Each inflated stream starts with the ASCII banner
// "PS ... TRANSMIT FILE created by modeller version ..." and a schema name "SCH_..."; it is a binary
// transmit file of a B-rep kernel (big-endian). Node layouts below were worked out from the sample bytes
// (see NOTEBOOK.md); the stream also embeds its own field descriptors for node types whose layout differs
// from its base schema, which we apply.
// Runs in a Web Worker: no DOM, no Node APIs.

import * as G from './geom.ts';
import * as S from './surf.ts';
import type { Surface } from './surf.ts';
import type { FaceLoop } from './facemesh.ts';

/** field codes: n = int32, p = node index (u16), d = float64, c = byte, v = 3 x float64 */
const BASE: Record<number, string> = {
  12: 'nppppppddpppc?ccppppppp', // body (23 base fields; this schema deletes field 13 and appends more)
  13: 'npppppppp',                // shell
  14: 'npdpppppcppppp',           // face: id attr tol next prev loop shell surface sense ...
  15: 'npppp',                    // loop: id attr fin face next
  16: 'npdppppppp',               // edge: id attr tol fin prev next curve nextOnCurve prevOnCurve owner
  17: 'pppppppppc',               // fin: attr loop forward backward vertex other edge curve nextAtVertex sense
  18: 'npppppdp',                 // vertex: id attr fin prev next point tol owner
  19: 'npppppc',                  // region
  29: 'nppppv',                   // point
  30: 'npppppcvv',                // line: pvec direction
  31: 'npppppcvvvd',              // circle: centre normal xAxis radius
  32: 'npppppcvvvdd',             // ellipse: centre normal xAxis major minor
  38: 'npppppcppppp',             // intersection curve: surface surface chart start end
  50: 'npppppcvvv',               // plane: pvec normal xAxis
  51: 'npppppcvvdv',              // cylinder: pvec axis radius xAxis
  52: 'npppppcvvdddv',            // cone: pvec axis radius sinHalf cosHalf xAxis
  53: 'npppppcvdvv',              // sphere: centre radius axis xAxis
  70: 'nppp?nn?p',                // list
  141: 'pppp',                    // shared-geometry link (surface owner)
  // variable length nodes: last code repeats `length` times
  40: 'ddnddddv',                 // chart: sampled points of an intersection curve
  41: 'cv',                       // limit: end points of an intersection curve
  74: 'npp',                      // pointer list block
  79: 'c',                        // character values
  80: 'ppn' + 'c'.repeat(24) + 'c', // attribute definition
  81: 'nppppppp',                 // attribute
  82: 'n',                        // integer values
  83: 'd',                        // real values
};
const VAR = new Set([40, 41, 74, 79, 80, 81, 82, 83]);
const TYPECH: Record<string, string> = { d: 'n', u: 'c', l: 'c', c: 'c', f: 'd', v: 'v' };

export type XtField = number | number[] | string;
export interface XtNode { t: number; f: XtField[] }

export class XtError extends Error { constructor(m: string) { super(m); this.name = 'XtError'; } }

export function parseXt(b: Uint8Array): { nodes: Map<number, XtNode>; schema: string; modeller: string } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const latin = (s: number, e: number) => { let r = ''; for (let i = s; i < e && i < b.length; i++) r += String.fromCharCode(b[i]); return r; };
  const head = latin(0, Math.min(b.length, 200));
  if (!head.startsWith('PS')) throw new XtError('solid stream without PS banner');
  const si = head.indexOf('SCH_');
  if (si < 4) throw new XtError('solid stream without schema name');
  const schemaLen = dv.getInt32(si - 4, false);
  if (schemaLen <= 0 || schemaLen > 100) throw new XtError('bad schema name length');
  const schema = latin(si, si + schemaLen);
  const mm = /version (\d+)/.exec(head);
  let o = si + schemaLen + 6;
  const lay = new Map<number, string[]>();
  const nodes = new Map<number, XtNode>();
  const need = (k: number) => { if (o + k > b.length) throw new XtError('solid stream truncated'); };
  const rd = (c: string): XtField => {
    switch (c) {
      case 'n': need(4); { const v = dv.getInt32(o, false); o += 4; return v; }
      case 'p': need(2); { const v = dv.getUint16(o, false); o += 2; return v; }
      case 'd': need(8); { const v = dv.getFloat64(o, false); o += 8; return v; }
      case 'c': need(1); return b[o++];
      case 'v': need(24); { const v = [dv.getFloat64(o, false), dv.getFloat64(o + 8, false), dv.getFloat64(o + 16, false)]; o += 24; return v; }
    }
    throw new XtError(`unknown field code ${c}`);
  };
  const delta = (base: string): string[] => {
    need(1);
    const cnt = b[o++];
    const out: string[] = [];
    let i = 0;
    for (let guard = 0; guard < 400; guard++) {
      need(1);
      const op = String.fromCharCode(b[o++]);
      if (op === 'Z') { if (out.length !== cnt) throw new XtError('field descriptor count mismatch'); return out; }
      if (op === 'C') { if (i >= base.length || base[i] === '?') throw new XtError('field descriptor copies an unknown field'); out.push(base[i++]); }
      else if (op === 'D') i++;
      else if (op === 'I' || op === 'A') {
        need(1); const nl = b[o++]; o += nl;
        need(4); const pc = dv.getUint16(o, false), n = dv.getUint16(o + 2, false); o += 4;
        if (pc) for (let k = 0; k < n; k++) out.push('p');
        else {
          need(1); const tl = b[o++]; need(tl); const tc = String.fromCharCode(b[o]); o += tl;
          const code = TYPECH[tc];
          if (!code) throw new XtError(`unknown field type ${tc}`);
          for (let k = 0; k < n; k++) out.push(code);
        }
      } else throw new XtError(`bad field descriptor at ${o - 1}`);
    }
    throw new XtError('field descriptor too long');
  };
  for (let guard = 0; guard < 5_000_000; guard++) {
    need(2);
    const t = dv.getUint16(o, false); o += 2;
    if (t === 1) break; // terminator
    if (!lay.has(t)) {
      need(1);
      const base = BASE[t];
      if (b[o] === 0xff) { o++; if (!base) throw new XtError(`unknown node type ${t}`); lay.set(t, base.split('')); }
      else lay.set(t, delta(base ?? ''));
    }
    const L = lay.get(t)!;
    if (VAR.has(t)) {
      need(6);
      const len = dv.getInt32(o, false); o += 4;
      const idx = dv.getUint16(o, false); o += 2;
      if (len < 0 || len > 10_000_000) throw new XtError('bad variable node length');
      const f: XtField[] = [];
      for (let k = 0; k < L.length - 1; k++) f.push(rd(L[k]));
      const last = L[L.length - 1];
      if (t === 79) { need(len); f.push(latin(o, o + len)); o += len; }
      else for (let k = 0; k < len; k++) f.push(rd(last));
      nodes.set(idx, { t, f });
      continue;
    }
    need(2);
    const idx = dv.getUint16(o, false); o += 2;
    const f: XtField[] = [];
    for (const c of L) f.push(rd(c));
    nodes.set(idx, { t, f });
  }
  return { nodes, schema, modeller: mm ? mm[1] : '' };
}

// ------------------------------------------------------------------ B-rep to tessellation input
const NUL = 1; // node index 1 is the null reference in this encoding

export interface XtFace { surf: Surface | null; kind: string; same: boolean; loops: FaceLoop[] }
export interface XtBody { faces: XtFace[]; edges: number[][]; warnings: string[]; faceCount: number; unsupported: number }

const num = (x: XtField) => x as number;
const vec = (x: XtField) => x as number[];

/** angular step for curve sampling (radians), chord limited */
function arcSegs(r: number, sweep: number, fine: number): number {
  const byAngle = Math.ceil(Math.abs(sweep) / ((2 * Math.PI) / fine));
  const chord = Math.max(r * 0.002, 2e-6);
  const byChord = Math.ceil(Math.abs(sweep) / (2 * Math.acos(Math.max(-1, Math.min(1, 1 - chord / Math.max(r, 1e-9))))));
  return Math.max(1, Math.min(512, Math.max(Math.min(byAngle, 256), Math.min(byChord, fine))));
}

export function bodyFaces(nodes: Map<number, XtNode>, fine = 64): XtBody {
  const warnings: string[] = [];
  const warned = new Set<string>();
  const warn = (m: string) => { if (!warned.has(m)) { warned.add(m); warnings.push(m); } };
  const get = (i: number, t?: number): XtNode | null => {
    if (i === NUL) return null;
    const n = nodes.get(i);
    if (!n) return null;
    if (t !== undefined && n.t !== t) return null;
    return n;
  };
  const vpt = (vi: number): number[] | null => {
    const v = get(vi, 18); if (!v) return null;
    const p = get(num(v.f[5]), 29); if (!p) return null;
    return vec(p.f[5]);
  };
  // surfaces
  const surfCache = new Map<number, Surface | null>();
  const surface = (si: number): Surface | null => {
    if (surfCache.has(si)) return surfCache.get(si)!;
    const s = get(si);
    let r: Surface | null = null;
    if (s) {
      const f = s.f;
      const frame = (o: number[], z: number[], x: number[]) => {
        const zz = G.norm3(z);
        let xx = G.sub3(x, zz.map((c) => c * G.dot3(x, zz)));
        xx = G.norm3(xx);
        return G.fromAxes(o, xx, G.cross3(zz, xx), zz);
      };
      if (s.t === 50) r = S.planeSurface(frame(vec(f[7]), vec(f[8]), vec(f[9])));
      else if (s.t === 51) r = S.cylinderSurface(frame(vec(f[7]), vec(f[8]), vec(f[10])), num(f[9]), fine);
      else if (s.t === 52) r = S.coneSurface(frame(vec(f[7]), vec(f[8]), vec(f[12])), num(f[9]), Math.atan2(num(f[10]), num(f[11])), fine);
      else if (s.t === 53) r = S.sphereSurface(frame(vec(f[7]), vec(f[9]), vec(f[10])), num(f[8]), fine);
      else warn(`surface type ${s.t} not supported`);
    }
    surfCache.set(si, r);
    return r;
  };
  // closest point on a surface node (for refining intersection curves)
  const project = (si: number, p: number[]): number[] => {
    const s = get(si); if (!s) return p;
    const f = s.f;
    if (s.t === 50) { const o = vec(f[7]), n = G.norm3(vec(f[8])); const d = G.dot3(G.sub3(p, o), n); return [p[0] - n[0] * d, p[1] - n[1] * d, p[2] - n[2] * d]; }
    if (s.t === 51 || s.t === 52) {
      const o = vec(f[7]), a = G.norm3(vec(f[8])), r0 = num(f[9]);
      const w = G.sub3(p, o); const h = G.dot3(w, a);
      const radial = G.sub3(w, a.map((c) => c * h)); const rl = G.len3(radial);
      if (rl < 1e-15) return p;
      const ru = radial.map((c) => c / rl);
      if (s.t === 51) return [o[0] + a[0] * h + ru[0] * r0, o[1] + a[1] * h + ru[1] * r0, o[2] + a[2] * h + ru[2] * r0];
      // cone: generator line through (h=0, r0) with slope tan(half)
      const tn = num(f[10]) / num(f[11]);
      const g = G.norm3([tn, 1]); // (dr, dh) along generator
      const qr = rl - r0, qh = h; const s2 = qr * g[0] + qh * g[1];
      const nr = r0 + g[0] * s2, nh = g[1] * s2;
      return [o[0] + a[0] * nh + ru[0] * nr, o[1] + a[1] * nh + ru[1] * nr, o[2] + a[2] * nh + ru[2] * nr];
    }
    if (s.t === 53) { const c = vec(f[7]), r0 = num(f[8]); const w = G.sub3(p, c); const l = G.len3(w); if (l < 1e-15) return p; return [c[0] + w[0] / l * r0, c[1] + w[1] / l * r0, c[2] + w[2] / l * r0]; }
    return p;
  };
  // curve sampling between two points along the fin direction
  const sampleCurve = (ci: number, a: number[] | null, b: number[] | null, forward: boolean): number[][] | null => {
    const c = get(ci); if (!c) return null;
    const f = c.f;
    const csense = num(f[6]) !== 45; // '-'
    const dir = forward === csense;
    if (c.t === 30) { if (!a || !b) return null; return [a, b]; }
    if (c.t === 31 || c.t === 32) {
      const C = vec(f[7]), N = G.norm3(vec(f[8]));
      let X = vec(f[9]); X = G.norm3(G.sub3(X, N.map((k) => k * G.dot3(X, N))));
      const Y = G.cross3(N, X);
      const ra = c.t === 31 ? num(f[10]) : num(f[10]), rb = c.t === 31 ? num(f[10]) : num(f[11]);
      const ang = (p: number[]) => { const w = G.sub3(p, C); return Math.atan2(G.dot3(w, Y) / rb, G.dot3(w, X) / ra); };
      let t0: number, sweep: number;
      if (!a || !b) { t0 = 0; sweep = dir ? 2 * Math.PI : -2 * Math.PI; }
      else {
        t0 = ang(a); const t1 = ang(b);
        let d = t1 - t0;
        if (dir) { while (d <= 1e-12) d += 2 * Math.PI; while (d > 2 * Math.PI + 1e-12) d -= 2 * Math.PI; }
        else { while (d >= -1e-12) d -= 2 * Math.PI; while (d < -2 * Math.PI - 1e-12) d += 2 * Math.PI; }
        if (G.len3(G.sub3(a, b)) < 1e-12) d = dir ? 2 * Math.PI : -2 * Math.PI;
        sweep = d;
      }
      const n = arcSegs(Math.max(ra, rb), sweep, fine);
      const out: number[][] = [];
      for (let i = 0; i <= n; i++) {
        const t = t0 + (sweep * i) / n;
        out.push([C[0] + X[0] * ra * Math.cos(t) + Y[0] * rb * Math.sin(t), C[1] + X[1] * ra * Math.cos(t) + Y[1] * rb * Math.sin(t), C[2] + X[2] * ra * Math.cos(t) + Y[2] * rb * Math.sin(t)]);
      }
      if (a) out[0] = a;
      if (b) out[out.length - 1] = b;
      return out;
    }
    if (c.t === 38) {
      const chart = get(num(f[9]), 40);
      if (!chart) { if (a && b) return [a, b]; return null; }
      let P = chart.f.slice(7).map((x) => vec(x).slice());
      if (P.length < 2) { if (a && b) return [a, b]; return null; }
      if (!dir) P.reverse();
      // trim to the part between a and b (nearest chart points)
      const near = (p: number[]) => { let bi = 0, bd = Infinity; P.forEach((q, i) => { const d = G.len3(G.sub3(q, p)); if (d < bd) { bd = d; bi = i; } }); return bi; };
      if (a && b) {
        const ia = near(a), ib = near(b);
        if (ia < ib) P = P.slice(ia, ib + 1);
        else if (ia > ib) P = P.slice(ib, ia + 1).reverse();
        P[0] = a; P[P.length - 1] = b;
        if (P.length < 2) P = [a, b];
      }
      // refine: subdivide and project onto both surfaces
      const s1 = num(f[7]), s2 = num(f[8]);
      const out: number[][] = [P[0]];
      for (let i = 1; i < P.length; i++) {
        const p0 = P[i - 1], p1 = P[i];
        const k = 12;
        for (let j = 1; j < k; j++) {
          let q = [p0[0] + (p1[0] - p0[0]) * j / k, p0[1] + (p1[1] - p0[1]) * j / k, p0[2] + (p1[2] - p0[2]) * j / k];
          for (let it = 0; it < 40; it++) {
            const q1 = project(s1, q), q2 = project(s2, q1);
            const moved = G.len3(G.sub3(q2, q));
            q = q2;
            if (moved < 1e-12) break;
          }
          out.push(q);
        }
        out.push(p1);
      }
      return out;
    }
    warn(`curve type ${c.t} not supported`);
    if (a && b) return [a, b];
    return null;
  };
  const faces: XtFace[] = [];
  const edges: number[][] = [];
  const edgePts = new Map<number, number[][]>();
  let faceCount = 0, unsupported = 0;
  for (const [fi, fn] of nodes) {
    if (fn.t !== 14) continue;
    faceCount++;
    const ff = fn.f;
    const si = num(ff[7]);
    const sn = get(si);
    const surf = surface(si);
    if (!surf && sn) { unsupported++; continue; }
    const same = num(ff[8]) !== 45;
    const loops: FaceLoop[] = [];
    let li = num(ff[5]);
    let guardL = 0;
    while (li !== NUL && guardL++ < 10000) {
      const L = get(li, 15); if (!L) break;
      const f0 = num(L.f[2]);
      const pts: number[][] = [];
      let fin = f0, guard = 0;
      let ok = true;
      do {
        const F = get(fin, 17); if (!F) { ok = false; break; }
        const bk = get(num(F.f[3]), 17);
        const endV = vpt(num(F.f[4]));
        const startV = bk ? vpt(num(bk.f[4])) : null;
        const ei = num(F.f[6]);
        const E = get(ei, 16);
        if (E) {
          const forward = num(F.f[9]) !== 45;
          const seg = sampleCurve(num(E.f[6]), startV, endV, forward);
          if (seg && seg.length) {
            for (let i = 0; i < seg.length - 1; i++) pts.push(seg[i]);
            if (!edgePts.has(ei)) edgePts.set(ei, forward ? seg : seg.slice().reverse());
          }
        } else if (endV) pts.push(endV); // vertex-only loop (pole / apex)
        fin = num(F.f[2]);
      } while (fin !== f0 && fin !== NUL && ++guard < 100000);
      if (ok && pts.length) loops.push({ pts, outer: loops.length === 0 });
      li = num(L.f[4]);
    }
    void fi;
    faces.push({ surf, kind: surf ? surf.kind : 'none', same, loops });
  }
  for (const seg of edgePts.values()) {
    const flat: number[] = [];
    for (const p of seg) flat.push(p[0], p[1], p[2]);
    edges.push(flat);
  }
  return { faces, edges, warnings, faceCount, unsupported };
}
