// Inventor solid model (decoded "ASM BinaryFile" token stream) to tessellation input: faces with their surface
// and boundary loops as 3D polylines. Entity field layouts were worked out from the sample bytes (NOTEBOOK.md).
// Runs in a Web Worker: no DOM, no Node APIs.

import * as G from './geom.ts';
import * as S from './surf.ts';
import type { Surface, BCurve, BSurf } from './surf.ts';
import type { SabFile, SabRec, Tok } from './sab.ts';
import type { FaceLoop } from './facemesh.ts';

const PTR = 0x0c, INT = 0x04, DBL = 0x06, POS = 0x13, VEC = 0x14, YES = 0x0a, NO = 0x0b, NAME = 0x0d, OPEN = 0x0f, CLOSE = 0x10, ENUM = 0x15;

export interface AsmFace { surf: Surface | null; kind: string; sense: boolean; loops: FaceLoop[] }
export interface AsmBody { index: number; faces: AsmFace[]; edges: number[][]; xform: number[] | null }
export interface AsmResult { bodies: AsmBody[]; warnings: string[]; faces: number; facesUnsupported: number; surfaceKinds: Record<string, number> }

const TWO_PI = Math.PI * 2;

/** reader over a record's tokens */
class Cur {
  i: number;
  toks: Tok[];
  constructor(toks: Tok[], start = 0) { this.toks = toks; this.i = start; }
  peek(): Tok | undefined { return this.toks[this.i]; }
  take(t?: number): Tok | null {
    const k = this.toks[this.i];
    if (!k || (t !== undefined && k.t !== t)) return null;
    this.i++; return k;
  }
  num(): number { const k = this.take(); if (!k || (k.t !== DBL && k.t !== INT && k.t !== ENUM)) throw new Error('number expected'); return k.v as number; }
  dbl(): number { const k = this.take(DBL); if (!k) throw new Error('double expected'); return k.v as number; }
  int(): number { const k = this.toks[this.i]; if (!k || (k.t !== INT && k.t !== ENUM)) throw new Error('int expected'); this.i++; return k.v as number; }
  vec(): number[] { const k = this.toks[this.i]; if (!k || (k.t !== POS && k.t !== VEC)) throw new Error('vector expected'); this.i++; return k.v as number[]; }
  /** interval bound: flag YES + double, or flag NO */
  bound(): number | null { const k = this.take(); if (!k) return null; if (k.t === YES) { const d = this.toks[this.i]; if (d && d.t === DBL) { this.i++; return d.v as number; } } return null; }
}

/** bs3 curve after a "nubs" / "nurbs" name token at position i (degree, closure, knot count, knots with multiplicities, control points) */
function readBs3Curve(toks: Tok[], i: number): { c: BCurve; end: number } | null {
  const rational = toks[i].v === 'nurbs';
  const c = new Cur(toks, i + 1);
  try {
    const deg = c.int();
    // closure flag (enum, or a name in newer streams), then the knot count followed by the first knot value
    while (c.i < toks.length && !(toks[c.i].t === INT && toks[c.i + 1]?.t === DBL)) { c.i++; if (c.i > i + 6) return null; }
    const nk = c.int();
    if (deg < 1 || deg > 25 || nk < 2 || nk > 100000) return null;
    const U: number[] = [];
    for (let k = 0; k < nk; k++) { const v = c.dbl(); const m = c.int(); for (let r = 0; r < m; r++) U.push(v); }
    U.unshift(U[0]); U.push(U[U.length - 1]);
    const n = U.length - deg - 1;
    if (n < deg + 1) return null;
    const P: number[][] = [], W: number[] = [];
    for (let k = 0; k < n; k++) { P.push([c.dbl(), c.dbl(), c.dbl()]); if (rational) W.push(c.dbl()); }
    return { c: { p: deg, P, U, W: rational ? W : null, closed: false }, end: c.i };
  } catch { return null; }
}

/** bs3 surface: degrees, optional rational form name, 4 enums, knot counts, knots u, knots v, control points (u fastest) */
function readBs3Surf(toks: Tok[], i: number): BSurf | null {
  const rational = toks[i].v === 'nurbs';
  const c = new Cur(toks, i + 1);
  try {
    const du = c.int(), dvv = c.int();
    if (c.peek()?.t === NAME) c.i++; // rational form name in newer streams ("both", ...)
    c.int(); c.int(); c.int(); c.int();
    const nku = c.int(), nkv = c.int();
    if (du < 1 || dvv < 1 || du > 25 || dvv > 25 || nku < 2 || nkv < 2 || nku > 100000 || nkv > 100000) return null;
    const U: number[] = [], V: number[] = [];
    for (let k = 0; k < nku; k++) { const v = c.dbl(); const m = c.int(); for (let r = 0; r < m; r++) U.push(v); }
    for (let k = 0; k < nkv; k++) { const v = c.dbl(); const m = c.int(); for (let r = 0; r < m; r++) V.push(v); }
    U.unshift(U[0]); U.push(U[U.length - 1]); V.unshift(V[0]); V.push(V[V.length - 1]);
    const nu = U.length - du - 1, nv = V.length - dvv - 1;
    if (nu < du + 1 || nv < dvv + 1 || nu * nv > 4_000_000) return null;
    const P: number[][][] = [], W: number[][] = [];
    for (let a = 0; a < nu; a++) { P.push(new Array(nv)); W.push(new Array(nv).fill(1)); }
    // control points are stored with u varying fastest (checked against the face boundaries)
    for (let k = 0; k < nu * nv; k++) {
      const a = k % nu, b = Math.floor(k / nu);
      P[a][b] = [c.dbl(), c.dbl(), c.dbl()]; if (rational) W[a][b] = c.dbl();
    }
    return { pu: du, pv: dvv, P, U, V, W: rational ? W : null };
  } catch { return null; }
}

function isSurfBs3(toks: Tok[], i: number): boolean {
  const a = toks[i + 1], b = toks[i + 2];
  let k = i + 3;
  if (toks[k]?.t === NAME) k++;
  const c = toks[k];
  return !!a && !!b && !!c && a.t === INT && b.t === INT && (c.t === ENUM || c.t === INT) && toks[k + 1]?.t !== DBL;
}

export function buildAsm(f: SabFile, opts: { curveSegments?: number } = {}): AsmResult {
  const fine = opts.curveSegments ?? 48;
  const recs = f.recs;
  const warnings: string[] = [];
  const warned = new Set<string>();
  const warn = (m: string) => { if (!warned.has(m)) { warned.add(m); warnings.push(m); } };
  const R = (p: number | null | undefined): SabRec | null => (p !== null && p !== undefined && p >= 0 && p < recs.length ? recs[p] : null);
  const ptr = (r: SabRec, k: number): number => { const t = r.toks[k]; return t && t.t === PTR ? (t.v as number) : -1; };
  const flag = (r: SabRec, k: number): boolean | null => { const t = r.toks[k]; return t ? (t.t === YES ? true : t.t === NO ? false : null) : null; };
  const pointOf = (vi: number): number[] | null => {
    const v = R(vi); if (!v || !v.type.endsWith('vertex')) return null;
    const p = R(ptr(v, 5)); if (!p || p.type !== 'point') return null;
    const t = p.toks[3]; return t && t.t === POS ? (t.v as number[]) : null;
  };
  /** tokens of a sub-block, following "ref n" back references */
  const block = (r: SabRec, from: number): { toks: Tok[]; s: number; e: number } | null => {
    let i = from;
    while (i < r.toks.length && r.toks[i].t !== OPEN) i++;
    if (i >= r.toks.length) return null;
    let depth = 0, e = i;
    for (; e < r.toks.length; e++) { if (r.toks[e].t === OPEN) depth++; else if (r.toks[e].t === CLOSE && --depth === 0) break; }
    const nm = r.toks[i + 1];
    if (nm && nm.t === NAME && nm.v === 'ref') {
      const n = r.toks[i + 2]?.v as number;
      const sb = f.subs[n];
      if (!sb) return null;
      return { toks: recs[sb.rec].toks, s: sb.start, e: sb.end };
    }
    return { toks: r.toks, s: i, e: e + 1 };
  };
  // ---------------------------------------------------------------- surfaces
  const surfCache = new Map<number, Surface | null>();
  const surfKind = new Map<number, string>();
  const frame = (o: number[], z: number[], x: number[]) => {
    const zz = G.norm3(z);
    let xx = G.sub3(x, zz.map((c) => c * G.dot3(x, zz)));
    if (G.len3(xx) < 1e-12) xx = Math.abs(zz[0]) < 0.9 ? G.cross3([1, 0, 0], zz) : G.cross3([0, 1, 0], zz);
    xx = G.norm3(xx);
    return G.fromAxes(o, xx, G.cross3(zz, xx), zz);
  };
  const surface = (si: number): Surface | null => {
    if (surfCache.has(si)) return surfCache.get(si)!;
    const r = R(si);
    let s: Surface | null = null;
    let kind = r ? r.type : 'missing';
    try {
      if (r && r.type === 'plane-surface') {
        const c = new Cur(r.toks, 3); const o = c.vec(), n = c.vec(), u = c.vec();
        s = S.planeSurface(frame(o, n, u));
      } else if (r && r.type === 'cone-surface') {
        const c = new Cur(r.toks, 3); const o = c.vec(), ax = c.vec(), maj = c.vec(); const ratio = c.dbl(); c.bound(); c.bound();
        const sn = c.dbl(), cs = c.dbl();
        const rad = G.len3(maj);
        // elliptic section: scale the frame's second axis by the ratio (the surface helpers accept affine frames)
        const fr = frame(o, ax, maj);
        if (Math.abs(ratio - 1) > 1e-9) { fr[1] *= ratio; fr[5] *= ratio; fr[9] *= ratio; }
        if (Math.abs(sn) < 1e-12) { s = S.cylinderSurface(fr, rad, fine); kind = 'cylinder'; }
        else {
          // radius grows along the axis with slope sin/cos
          const semi = Math.atan2(Math.abs(sn), Math.abs(cs));
          s = S.coneSurface(fr, rad, (sn * cs) < 0 ? -semi : semi, fine); kind = 'cone';
        }
      } else if (r && r.type === 'sphere-surface') {
        const c = new Cur(r.toks, 3); const o = c.vec(); const rad = c.dbl(); const pole = c.vec(), u = c.vec();
        s = S.sphereSurface(frame(o, pole, u), Math.abs(rad), fine);
      } else if (r && r.type === 'torus-surface') {
        const c = new Cur(r.toks, 3); const o = c.vec(), ax = c.vec(); const big = c.dbl(), small = c.dbl(); const u = c.vec();
        s = S.torusSurface(frame(o, ax, u), big, Math.abs(small), fine, Math.max(12, fine >> 1));
      } else if (r && r.type === 'spline-surface') {
        const b = block(r, 3);
        if (b) {
          for (let i = b.s; i < b.e; i++) {
            const t = b.toks[i];
            if (t.t === NAME && (t.v === 'nubs' || t.v === 'nurbs') && isSurfBs3(b.toks, i)) {
              const bs = readBs3Surf(b.toks, i);
              if (bs) { s = S.bsplineSurface(bs, false, false); break; }
            }
          }
          if (!s) { const nm = b.toks[b.s + 1]; warn(`spline surface type ${nm && nm.t === NAME ? nm.v : '?'} without B-spline data: its faces are left open unless flat`); kind = 'spline (no data)'; }
        }
      } else if (r) warn(`surface type ${r.type} not supported`);
    } catch (e) { warn(`surface ${r?.type} not decoded (${(e as Error).message})`); s = null; }
    surfCache.set(si, s); surfKind.set(si, kind);
    return s;
  };
  // ---------------------------------------------------------------- curves
  const curveCache = new Map<number, BCurve | null>();
  const bs3Of = (ci: number): BCurve | null => {
    if (curveCache.has(ci)) return curveCache.get(ci)!;
    const r = R(ci);
    let res: BCurve | null = null;
    if (r) {
      const b = block(r, 3);
      if (b) for (let i = b.s; i < b.e; i++) {
        const t = b.toks[i];
        if (t.t === NAME && (t.v === 'nubs' || t.v === 'nurbs') && !isSurfBs3(b.toks, i)) {
          const x = readBs3Curve(b.toks, i);
          if (x && x.c.P[0].length === 3) { res = x.c; break; }
        }
      }
    }
    curveCache.set(ci, res);
    return res;
  };
  const edgeCache = new Map<number, number[][]>();
  /** polyline of an edge from its start vertex to its end vertex */
  const edgePts = (ei: number): number[][] => {
    const hit = edgeCache.get(ei);
    if (hit) return hit;
    const e = R(ei);
    let out: number[][] = [];
    if (e) {
      const p0 = pointOf(ptr(e, 3)), p1 = pointOf(ptr(e, 5));
      const t0 = e.toks[4]?.v as number, t1 = e.toks[6]?.v as number;
      const ci = ptr(e, 8);
      const cr = R(ci);
      const fwd = flag(e, 9) !== true;
      const closed = !!p0 && !!p1 && G.len3(G.sub3(p0, p1)) < 1e-9;
      if (cr && cr.type === 'ellipse-curve') {
        const c = new Cur(cr.toks, 3); const C = c.vec(), N = G.norm3(c.vec()), M = c.vec(); const ratio = c.dbl();
        const a = G.len3(M), X = G.norm3(M), Y = G.cross3(N, X), bb = a * ratio;
        const ang = (p: number[]) => { const w = G.sub3(p, C); return Math.atan2(G.dot3(w, Y) / bb, G.dot3(w, X) / a); };
        const at = (t: number) => [C[0] + X[0] * a * Math.cos(t) + Y[0] * bb * Math.sin(t), C[1] + X[1] * a * Math.cos(t) + Y[1] * bb * Math.sin(t), C[2] + X[2] * a * Math.cos(t) + Y[2] * bb * Math.sin(t)];
        let s0: number, sweep: number;
        const span = Number.isFinite(t1 - t0) ? Math.abs(t1 - t0) : TWO_PI;
        if (p0 && p1) {
          s0 = ang(p0);
          const a1 = ang(p1);
          if (closed) sweep = (fwd ? 1 : -1) * (span > 1e-9 ? span : TWO_PI);
          else {
            const dp = ((a1 - s0) % TWO_PI + TWO_PI) % TWO_PI; // positive way
            const cand = [dp, dp - TWO_PI];
            // the stored parameter span decides between the two ways round, the edge sense breaks ties
            cand.sort((x, y) => Math.abs(Math.abs(x) - span) - Math.abs(Math.abs(y) - span) || (fwd ? y - x : x - y));
            sweep = cand[0];
          }
        } else { s0 = Number.isFinite(t0) ? t0 : 0; sweep = (fwd ? 1 : -1) * span; }
        const n = Math.max(1, Math.min(512, Math.ceil(Math.abs(sweep) / (TWO_PI / fine))));
        for (let i = 0; i <= n; i++) out.push(at(s0 + (sweep * i) / n));
        if (p0) out[0] = p0;
        if (p1) out[out.length - 1] = p1;
      } else if (cr && cr.type === 'intcurve-curve') {
        const bc = bs3Of(ci);
        if (bc && p0 && p1) {
          const [r0, r1] = S.bcurveRange(bc);
          let u0 = S.bcurveProject(bc, p0), u1 = S.bcurveProject(bc, p1);
          if (closed) { u0 = fwd ? r0 : r1; u1 = fwd ? r1 : r0; }
          const n = Math.max(2, Math.min(800, Math.ceil(bc.P.length * 4 * Math.abs(u1 - u0) / Math.max(1e-12, r1 - r0))));
          const q = [0, 0, 0];
          for (let i = 0; i <= n; i++) { S.bcurveEval(bc, u0 + ((u1 - u0) * i) / n, q); out.push([q[0], q[1], q[2]]); }
          out[0] = p0; out[out.length - 1] = p1;
        } else {
          if (!bc) warn('intersection curve without B-spline data: drawn straight');
          if (p0 && p1) out = [p0, p1];
        }
      } else {
        if (cr && cr.type !== 'straight-curve') warn(`curve type ${cr.type} drawn straight`);
        if (p0 && p1) out = [p0, p1];
      }
    }
    edgeCache.set(ei, out);
    return out;
  };
  // ---------------------------------------------------------------- topology
  const bodies: AsmBody[] = [];
  let faces = 0, facesUnsupported = 0;
  const kinds: Record<string, number> = {};
  const seenFace = new Set<number>();
  recs.forEach((br, bi) => {
    if (br.type !== 'body') return;
    const body: AsmBody = { index: bi, faces: [], edges: [], xform: null };
    const tr = R(ptr(br, 5));
    if (tr && tr.type === 'transform') {
      const v = tr.toks.filter((t) => t.t === VEC || t.t === POS).map((t) => t.v as number[]);
      const sc = tr.toks.find((t) => t.t === DBL)?.v as number | undefined;
      if (v.length >= 4) body.xform = [...v[0], ...v[1], ...v[2], ...v[3], sc ?? 1];
    }
    const edgesUsed = new Set<number>();
    let li = ptr(br, 3), lg = 0;
    while (li >= 0 && lg++ < 100000) {
      const lump = R(li); if (!lump || lump.type !== 'lump') break;
      let si = ptr(lump, 4), sg = 0;
      while (si >= 0 && sg++ < 100000) {
        const sh = R(si); if (!sh || sh.type !== 'shell') break;
        let fi = ptr(sh, 5), fg = 0;
        while (fi >= 0 && fg++ < 1_000_000) {
          const fr = R(fi); if (!fr || !fr.type.endsWith('face')) break;
          if (seenFace.has(fi)) break;
          seenFace.add(fi);
          faces++;
          const sidx = ptr(fr, 7);
          const surf = surface(sidx);
          const k = surfKind.get(sidx) ?? '?';
          kinds[k] = (kinds[k] ?? 0) + 1;
          const loops: FaceLoop[] = [];
          let lpi = ptr(fr, 4), lpg = 0;
          while (lpi >= 0 && lpg++ < 100000) {
            const lp = R(lpi); if (!lp || !lp.type.endsWith('loop')) break;
            const c0 = ptr(lp, 4);
            const pts: number[][] = [];
            let ci = c0, cg = 0;
            while (ci >= 0 && cg++ < 1_000_000) {
              const ce = R(ci); if (!ce || !ce.type.endsWith('coedge')) break;
              const ei = ptr(ce, 6);
              let ep = edgePts(ei);
              if (flag(ce, 7) === true) ep = ep.slice().reverse();
              for (let i = 0; i < ep.length - 1; i++) pts.push(ep[i]);
              if (ep.length === 1) pts.push(ep[0]);
              edgesUsed.add(ei);
              ci = ptr(ce, 3);
              if (ci === c0) break;
            }
            if (pts.length) loops.push({ pts, outer: loops.length === 0 });
            lpi = ptr(lp, 3);
          }
          if (!surf && R(sidx)?.type !== 'spline-surface') facesUnsupported++;
          body.faces.push({ surf, kind: k, sense: flag(fr, 8) !== true, loops });
          fi = ptr(fr, 3);
        }
        si = ptr(sh, 3);
      }
      li = ptr(lump, 3);
    }
    for (const ei of edgesUsed) {
      const p = edgePts(ei);
      if (p.length < 2) continue;
      const flat: number[] = [];
      for (const q of p) flat.push(q[0], q[1], q[2]);
      body.edges.push(flat);
    }
    if (body.faces.length) bodies.push(body);
  });
  return { bodies, warnings, faces, facesUnsupported, surfaceKinds: kinds };
}
