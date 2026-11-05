// Trimmed B-rep face tessellation: planar faces by ear clipping, curved faces mapped to surface (u,v)
// with seams and poles handled, then refined on a (u,v) grid.
// Adapted from our own STEP engine (/tmp/cad/step/stp.ts, planarFace / curvedFace / gridTess), same algorithm,
// made standalone so the iCAD engine can feed it with faces decoded from its embedded solid streams.
// Runs in a Web Worker: no DOM, no Node APIs.

import * as G from './geom.ts';
import type { Surface } from './surf.ts';

export interface NMesh { pos: number[]; idx: number[]; nrm: number[] }
export const nmesh = (): NMesh => ({ pos: [], idx: [], nrm: [] });
interface UVP { u: number; v: number; p: number[] | null }
export interface FaceLoop { pts: number[][]; outer: boolean }

export class FaceMesher {
  tol: number;
  warn: (m: string) => void;
  faceFallback = 0;
  selfIntersecting = 0;
  private nA = [0, 0, 0];
  private nB = [0, 0, 0];
  constructor(tol: number, warn: (m: string) => void) { this.tol = tol; this.warn = warn; }

  /** tessellate one face. same = face normal follows the surface normal */
  face(surf: Surface | null, loops: FaceLoop[], m: NMesh, same: boolean) {
    const real: FaceLoop[] = [];
    for (const l of loops) {
      const clean: number[][] = [];
      for (const p of l.pts) if (!clean.length || G.len3(G.sub3(clean[clean.length - 1], p)) > this.tol) clean.push(p);
      while (clean.length > 1 && G.len3(G.sub3(clean[0], clean[clean.length - 1])) <= this.tol) clean.pop();
      if (clean.length >= 2) real.push({ pts: clean, outer: l.outer });
    }
    if (!real.length) return;
    if (!surf || surf.kind === 'plane') this.planarFace(real, m, surf, same);
    else if (!this.curvedFace(surf, real, m, same)) { this.faceFallback++; this.planarFace(real, m, null, same); }
  }

  planarFace(loops: FaceLoop[], m: NMesh, surf: Surface | null, same: boolean) {
    const L = loops.filter((l) => l.pts.length >= 3);
    if (!L.length) return;
    let oi = L.findIndex((l) => l.outer);
    const flat = (l: { pts: number[][] }) => { const o: number[] = []; for (const p of l.pts) o.push(p[0], p[1], p[2]); return o; };
    if (surf) {
      const uv = L.map((l) => { const o: number[] = []; for (const p of l.pts) { const r = surf.inv(p, null); o.push(r[0], r[1]); } return o; });
      if (L.length > 1) { let best = -1; uv.forEach((l, i) => { const ar = Math.abs(G.area2(l)); if (ar > best) { best = ar; oi = i; } }); }
      if (oi < 0) oi = 0;
      const holes = uv.filter((_, i) => i !== oi);
      const tri = G.triangulate(uv[oi], holes);
      const allUV = [uv[oi], ...holes].flat();
      let triArea = 0;
      for (let k = 0; k < tri.length; k += 3) { const a = tri[k], b = tri[k + 1], c = tri[k + 2]; triArea += Math.abs((allUV[2 * b] - allUV[2 * a]) * (allUV[2 * c + 1] - allUV[2 * a + 1]) - (allUV[2 * c] - allUV[2 * a]) * (allUV[2 * b + 1] - allUV[2 * a + 1])) / 2; }
      const expected = Math.abs(G.area2(uv[oi])) - holes.reduce((q, h) => q + Math.abs(G.area2(h)), 0);
      if (triArea > Math.abs(expected) * 1.02 + 1e-9 * Math.abs(G.area2(uv[oi]))) {
        // self-intersecting boundary: even-odd fill instead
        const eo = G.evenOddFill(uv);
        const nn2 = [0, 0, 0], tp = [0, 0, 0];
        this.snormal(surf, 0, 0, same, nn2);
        const b0 = m.pos.length / 3;
        for (let i = 0; i < eo.pts.length; i += 2) { surf.eval(eo.pts[i], eo.pts[i + 1], tp); m.pos.push(tp[0], tp[1], tp[2]); m.nrm.push(nn2[0], nn2[1], nn2[2]); }
        for (let k = 0; k < eo.tri.length; k += 3) {
          if (same) m.idx.push(b0 + eo.tri[k], b0 + eo.tri[k + 1], b0 + eo.tri[k + 2]);
          else m.idx.push(b0 + eo.tri[k], b0 + eo.tri[k + 2], b0 + eo.tri[k + 1]);
        }
        this.selfIntersecting++;
        return;
      }
      const all = [L[oi], ...L.filter((_, i) => i !== oi)].flatMap((l) => l.pts);
      const base = m.pos.length / 3;
      const nn = [0, 0, 0];
      this.snormal(surf, 0, 0, same, nn);
      for (const p of all) { m.pos.push(p[0], p[1], p[2]); m.nrm.push(nn[0], nn[1], nn[2]); }
      for (let k = 0; k < tri.length; k += 3) {
        if (same) m.idx.push(base + tri[k], base + tri[k + 1], base + tri[k + 2]);
        else m.idx.push(base + tri[k], base + tri[k + 2], base + tri[k + 1]);
      }
      return;
    }
    if (L.length > 1 || oi < 0) { let best = -1; L.forEach((l, i) => { const n = G.len3(G.newell(flat(l))); if (n > best) { best = n; oi = i; } }); }
    const outer = flat(L[oi]), holes = L.filter((_, i) => i !== oi).map(flat);
    const tri = G.triangulate3D(outer, holes);
    const base = m.pos.length / 3;
    const nn = G.norm3(G.newell(outer));
    for (const v of outer) m.pos.push(v);
    for (const h of holes) for (const v of h) m.pos.push(v);
    for (let i = m.nrm.length; i < m.pos.length; i += 3) m.nrm.push(nn[0], nn[1], nn[2]);
    for (let k = 0; k < tri.length; k++) m.idx.push(base + tri[k]);
  }

  /** trimmed curved face: loops mapped to (u,v), seams and poles handled, refined on a grid */
  curvedFace(s: Surface, loops: FaceLoop[], m: NMesh, same: boolean): boolean {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const l of loops) for (const p of l.pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); z0 = Math.min(z0, p[2]); z1 = Math.max(z1, p[2]); }
    const maxRes = Math.max(this.tol * 1000, Math.hypot(x1 - x0, y1 - y0, z1 - z0) * 0.03);
    const uvLoops: { pts: UVP[]; outer: boolean; ku: number; kv: number }[] = [];
    for (const l of loops) {
      const out: UVP[] = [];
      let hint: number[] | null = null;
      const sing: boolean[] = [];
      for (const p of l.pts) {
        if (s.singular(p)) { out.push({ u: NaN, v: NaN, p }); sing.push(true); continue; }
        const r = s.inv(p, hint);
        if (!(r[2] <= maxRes) || !isFinite(r[0]) || !isFinite(r[1])) return false;
        let u = r[0], v = r[1];
        if (hint) {
          if (s.perU) u += Math.round((hint[0] - u) / s.perU) * s.perU;
          if (s.perV) v += Math.round((hint[1] - v) / s.perV) * s.perV;
        }
        hint = [u, v];
        out.push({ u, v, p }); sing.push(false);
      }
      if (sing.some((x) => x)) {
        const fixed: UVP[] = [];
        const n = out.length;
        for (let i = 0; i < n; i++) {
          if (!sing[i]) { fixed.push(out[i]); continue; }
          let a = (i - 1 + n) % n, b = (i + 1) % n;
          while (sing[a] && a !== i) a = (a - 1 + n) % n;
          while (sing[b] && b !== i) b = (b + 1) % n;
          if (sing[a] || sing[b]) return false;
          const pv = s.poleV ? s.poleV(out[i].p!) : NaN;
          const vv = isFinite(pv) ? pv : (out[a].v + out[b].v) / 2;
          let ub = out[b].u;
          if (s.perU) ub += Math.round((out[a].u - ub) / s.perU) * s.perU;
          fixed.push({ u: out[a].u, v: vv, p: out[i].p }, { u: ub, v: vv, p: out[i].p });
        }
        for (let i = 1; i < fixed.length; i++) if (s.perU) fixed[i].u += Math.round((fixed[i - 1].u - fixed[i].u) / s.perU) * s.perU;
        out.length = 0; out.push(...fixed);
      }
      if (out.length < 2) continue;
      const first = out[0], last = out[out.length - 1];
      let cu = first.u, cv = first.v;
      if (s.perU) cu += Math.round((last.u - first.u) / s.perU) * s.perU;
      if (s.perV) cv += Math.round((last.v - first.v) / s.perV) * s.perV;
      const ku = s.perU ? Math.round((cu - first.u) / s.perU) : 0;
      const kv = s.perV ? Math.round((cv - first.v) / s.perV) : 0;
      if (ku || kv) out.push({ u: cu, v: cv, p: first.p });
      uvLoops.push({ pts: out, outer: l.outer, ku, kv });
    }
    if (!uvLoops.length) return true;
    const keep = same !== s.flip;
    const wrapU = uvLoops.filter((l) => l.ku !== 0), wrapV = uvLoops.filter((l) => l.kv !== 0 && l.ku === 0);
    let outer: UVP[] | null = null;
    let holes: UVP[][] = [];
    const rest = uvLoops.filter((l) => l.ku === 0 && l.kv === 0);
    const pairWrap = (W: typeof uvLoops, axis: 'u' | 'v'): UVP[] | null => {
      const per = axis === 'u' ? s.perU : s.perV;
      const k = (l: (typeof uvLoops)[0]) => (axis === 'u' ? l.ku : l.kv);
      if (W.length >= 2) {
        const A = W[0];
        let bp = W[1].pts.slice(0, -1);
        if (Math.sign(k(A)) === Math.sign(k(W[1]))) bp.reverse();
        const aEnd = A.pts[A.pts.length - 1][axis];
        let bi = 0, bd = Infinity;
        bp.forEach((q, i) => { const d = Math.abs((((q[axis] - aEnd) % per) + per * 1.5) % per - per / 2); if (d < bd) { bd = d; bi = i; } });
        bp = [...bp.slice(bi), ...bp.slice(0, bi)];
        for (let i = 1; i < bp.length; i++) bp[i] = { ...bp[i], [axis]: bp[i][axis] + Math.round((bp[i - 1][axis] - bp[i][axis]) / per) * per };
        const sh = Math.round((aEnd - bp[0][axis]) / per) * per;
        bp = bp.map((q) => ({ ...q, [axis]: q[axis] + sh }));
        { const b0 = bp[0], bl = bp[bp.length - 1]; const kk = Math.round((bl[axis] - b0[axis]) / per); bp.push({ ...b0, [axis]: b0[axis] + kk * per }); }
        if (W.length > 2) this.warn('face with more than two periodic boundary loops: extra loops ignored');
        return [...A.pts, ...bp];
      }
      if (W.length === 1) {
        const A = W[0];
        if (axis !== 'u' || !s.poleV) return null;
        const dir = Math.sign(k(A));
        const up = (dir > 0) === keep;
        let pv: number;
        if (s.kind === 'sphere') pv = up ? Math.PI / 2 : -Math.PI / 2;
        else pv = s.poleV(A.pts[0].p!);
        if (!isFinite(pv)) return null;
        const f = A.pts[0], l = A.pts[A.pts.length - 1];
        return [...A.pts, { u: l.u, v: pv, p: null }, { u: f.u, v: pv, p: null }];
      }
      return null;
    };
    if (wrapU.length) { outer = pairWrap(wrapU, 'u'); if (!outer) return false; }
    else if (wrapV.length) { outer = pairWrap(wrapV, 'v'); if (!outer) return false; }
    else {
      let oi = rest.findIndex((l) => l.outer);
      if (oi < 0 || rest.length > 1) {
        let best = -1;
        rest.forEach((l, i) => { const ar = Math.abs(G.area2(l.pts.flatMap((q) => [q.u, q.v]))); if (ar > best) { best = ar; oi = i; } });
      }
      outer = rest[oi].pts;
      rest.splice(oi, 1);
    }
    holes = rest.map((l) => l.pts);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const q of outer) { u0 = Math.min(u0, q.u); u1 = Math.max(u1, q.u); v0 = Math.min(v0, q.v); v1 = Math.max(v1, q.v); }
    holes = holes.map((h) => {
      let cu = 0, cv = 0;
      for (const q of h) { cu += q.u; cv += q.v; }
      cu /= h.length; cv /= h.length;
      const su = s.perU ? Math.round(((u0 + u1) / 2 - cu) / s.perU) * s.perU : 0;
      const sv = s.perV ? Math.round(((v0 + v1) / 2 - cv) / s.perV) * s.perV : 0;
      return su || sv ? h.map((q) => ({ u: q.u + su, v: q.v + sv, p: q.p })) : h;
    });
    let nu = Math.max(1, s.stepsU(u1 - u0)), nv = s.ruledV ? 1 : Math.max(1, s.stepsV(v1 - v0));
    if (nu * nv > 16384) { const k = Math.sqrt(16384 / (nu * nv)); nu = Math.max(1, Math.floor(nu * k)); nv = Math.max(1, Math.floor(nv * k)); }
    this.gridTess(s, outer, holes.filter((h) => h.length >= 3), nu, nv, m, keep);
    return true;
  }

  /** surface normal at (u,v): Su x Sv of our mapping, oriented as the face (keep = same !== flip) */
  snormal(s: Surface, u: number, v: number, same: boolean, out: number[], keepArg?: boolean) {
    const keep = keepArg ?? (same !== s.flip);
    const A = this.nA, B = this.nB;
    const hu = 1e-6 * Math.max(1, Math.abs(u)), hv = 1e-6 * Math.max(1, Math.abs(v));
    s.eval(u + hu, v, A); s.eval(u - hu, v, B);
    const sx = A[0] - B[0], sy = A[1] - B[1], sz = A[2] - B[2];
    s.eval(u, v + hv, A); s.eval(u, v - hv, B);
    const tx = A[0] - B[0], ty = A[1] - B[1], tz = A[2] - B[2];
    let nx = sy * tz - sz * ty, ny = sz * tx - sx * tz, nz = sx * ty - sy * tx;
    let l = Math.hypot(nx, ny, nz);
    if (!(l > 1e-30 * (1 + Math.abs(A[0]) + Math.abs(A[1]) + Math.abs(A[2])) ** 2) || !(l > 0)) {
      const sv = v > 0 ? -1e-3 : 1e-3, su = u > 0 ? -1e-3 : 1e-3;
      for (const [ou, ov] of [[0, sv], [su, 0], [su, sv], [0, -sv], [-su, 0], [-su, -sv]]) {
        const uu = u + ou * Math.max(1, Math.abs(u)), vv = v + ov * Math.max(1, Math.abs(v));
        s.eval(uu + hu, vv, A); s.eval(uu - hu, vv, B);
        const ax = A[0] - B[0], ay = A[1] - B[1], az = A[2] - B[2];
        s.eval(uu, vv + hv, A); s.eval(uu, vv - hv, B);
        const bx = A[0] - B[0], by = A[1] - B[1], bz = A[2] - B[2];
        nx = ay * bz - az * by; ny = az * bx - ax * bz; nz = ax * by - ay * bx;
        l = Math.hypot(nx, ny, nz);
        if (l > 1e-30) break;
      }
      if (!(l > 0)) { nx = 0; ny = 0; nz = 1; l = 1; }
    }
    const sg = keep ? 1 / l : -1 / l;
    out[0] = nx * sg; out[1] = ny * sg; out[2] = nz * sg;
  }

  gridTess(s: Surface, outer: UVP[], holes: UVP[][], nu: number, nv: number, m: NMesh, keep: boolean) {
    const flat = (L: UVP[]) => { const o: number[] = []; for (const q of L) o.push(q.u, q.v); return o; };
    const all = [outer, ...holes].flat();
    const { pts, ring } = G.bridged(flat(outer), holes.map(flat));
    const tmp = [0, 0, 0], nn = [0, 0, 0];
    const vert = (q: UVP) => {
      const i = m.pos.length / 3;
      if (q.p) m.pos.push(q.p[0], q.p[1], q.p[2]);
      else { s.eval(q.u, q.v, tmp); m.pos.push(tmp[0], tmp[1], tmp[2]); }
      this.snormal(s, q.u, q.v, keep !== s.flip, nn, keep);
      m.nrm.push(nn[0], nn[1], nn[2]);
      return i;
    };
    const emit = (L: UVP[], tri: number[]) => {
      const ids = L.map(vert);
      for (let k = 0; k < tri.length; k += 3) {
        if (keep) m.idx.push(ids[tri[k]], ids[tri[k + 1]], ids[tri[k + 2]]);
        else m.idx.push(ids[tri[k]], ids[tri[k + 2]], ids[tri[k + 1]]);
      }
    };
    if (nu * nv <= 1) {
      const tri = G.earClipRing(pts, ring);
      const ids = all.map(vert);
      for (let k = 0; k < tri.length; k += 3) {
        if (keep) m.idx.push(ids[tri[k]], ids[tri[k + 1]], ids[tri[k + 2]]);
        else m.idx.push(ids[tri[k]], ids[tri[k + 2]], ids[tri[k + 1]]);
      }
      return;
    }
    const poly: UVP[] = ring.map((i) => all[i]);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const q of poly) { u0 = Math.min(u0, q.u); u1 = Math.max(u1, q.u); v0 = Math.min(v0, q.v); v1 = Math.max(v1, q.v); }
    const du = (u1 - u0) / nu || 1, dv = (v1 - v0) / nv || 1;
    const marked = new Uint8Array(nu * nv);
    const n = poly.length;
    const ci = (u: number) => Math.max(0, Math.min(nu - 1, Math.floor((u - u0) / du)));
    const cj = (v: number) => Math.max(0, Math.min(nv - 1, Math.floor((v - v0) / dv)));
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      const i0 = ci(Math.min(a.u, b.u)), i1 = ci(Math.max(a.u, b.u)), j0 = cj(Math.min(a.v, b.v)), j1 = cj(Math.max(a.v, b.v));
      for (let x = i0; x <= i1; x++) for (let y = j0; y <= j1; y++) marked[x * nv + y] = 1;
    }
    const inside = (u: number, v: number) => {
      let c = false;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const a = poly[i], b = poly[j];
        if ((a.v > v) !== (b.v > v) && u < ((b.u - a.u) * (v - a.v)) / (b.v - a.v) + a.u) c = !c;
      }
      return c;
    };
    const clip = (P: UVP[], axis: 'u' | 'v', val: number, keepGreater: boolean): UVP[] => {
      const out: UVP[] = [];
      const k = P.length;
      for (let i = 0; i < k; i++) {
        const a = P[i], b = P[(i + 1) % k];
        const ia = keepGreater ? a[axis] >= val : a[axis] <= val, ib = keepGreater ? b[axis] >= val : b[axis] <= val;
        if (ia) out.push(a);
        if (ia !== ib) {
          const t = (val - a[axis]) / (b[axis] - a[axis]);
          out.push({ u: a.u + (b.u - a.u) * t, v: a.v + (b.v - a.v) * t, p: null });
        }
      }
      return out;
    };
    for (let x = 0; x < nu; x++) for (let y = 0; y < nv; y++) {
      const ua = u0 + x * du, ub = x === nu - 1 ? u1 : ua + du, va = v0 + y * dv, vb = y === nv - 1 ? v1 : va + dv;
      if (!marked[x * nv + y]) {
        if (inside((ua + ub) / 2, (va + vb) / 2)) {
          emit([{ u: ua, v: va, p: null }, { u: ub, v: va, p: null }, { u: ub, v: vb, p: null }, { u: ua, v: vb, p: null }], [0, 1, 2, 0, 2, 3]);
        }
        continue;
      }
      let c = clip(poly, 'u', ua, true);
      if (c.length >= 3) c = clip(c, 'u', ub, false);
      if (c.length >= 3) c = clip(c, 'v', va, true);
      if (c.length >= 3) c = clip(c, 'v', vb, false);
      if (c.length < 3) continue;
      const fl = flat(c);
      if (Math.abs(G.area2(fl)) < du * dv * 1e-9) continue;
      let tri = G.triangulate(fl);
      let L = c;
      const f1 = this.folds(s, L, tri);
      if (f1 > 0) {
        let cu = 0, cv = 0;
        for (const q of c) { cu += q.u; cv += q.v; }
        const cen: UVP = { u: cu / c.length, v: cv / c.length, p: null };
        const L2 = [...c, cen];
        const ccw = G.area2(fl) > 0;
        const t2: number[] = [];
        for (let i = 0; i < c.length; i++) { const j = (i + 1) % c.length; if (ccw) t2.push(i, j, c.length); else t2.push(j, i, c.length); }
        if (this.folds(s, L2, t2) < f1 && inside(cen.u, cen.v)) { L = L2; tri = t2; }
      }
      emit(L, tri);
    }
  }

  /** number of triangles (CCW in (u,v)) whose 3D winding opposes the surface normal */
  folds(s: Surface, L: UVP[], tri: number[]): number {
    const P = L.map((q) => { if (q.p) return q.p; const o = [0, 0, 0]; s.eval(q.u, q.v, o); return o; });
    const n = [0, 0, 0];
    let k = 0;
    for (let i = 0; i < tri.length; i += 3) {
      const a = P[tri[i]], b = P[tri[i + 1]], c = P[tri[i + 2]];
      const g = G.cross3(G.sub3(b, a), G.sub3(c, a));
      if (G.dot3(g, g) === 0) continue;
      const q = L[tri[i]], r = L[tri[i + 1]], t = L[tri[i + 2]];
      this.snormal(s, (q.u + r.u + t.u) / 3, (q.v + r.v + t.v) / 3, true, n, true);
      if (G.dot3(g, n) < 0) k++;
    }
    return k;
  }
}
