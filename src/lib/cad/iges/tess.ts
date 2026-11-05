// Face tessellation in surface (u,v) space, copied from our own STEP engine (/tmp/cad/step/stp.ts,
// StepReader.planarFace .. folds) so the IGES reader uses the same tested code: loops mapped to (u,v)
// by the surface inverse, periodic unwrapping, pole handling, grid-cell clipping plus ear clipping,
// analytic normals, fold repair. Added for IGES: uvFace (loops given directly in (u,v)).

import * as G from './geom.ts';
import type { Surface } from './surf.ts';

const DEBUG = !!(globalThis as any).process?.env?.IGES_DEBUG;
const TWO_PI = Math.PI * 2;

export interface NMesh { pos: number[]; idx: number[]; nrm: number[] }
export const nmesh = (): NMesh => ({ pos: [], idx: [], nrm: [] });
export interface UVP { u: number; v: number; p: number[] | null }

export class FaceTess {
  tol = 1e-6;     // model units
  lenScale = 1;   // model unit in metres (tessellation density only)
  opt: { lod: 'fast' | 'full' } = { lod: 'full' };
  warnCounts = new Map<string, number>();
  selfIntersecting = 0;
  curFace = 0;
  warn(m: string) { this.warnCounts.set(m, (this.warnCounts.get(m) || 0) + 1); }
  segs(rModel: number, sweep: number): number {
    const rm = Math.abs(rModel) * this.lenScale;
    let base = rm < 0.002 ? 12 : rm < 0.01 ? 16 : rm < 0.05 ? 28 : rm < 0.2 ? 40 : rm < 1 ? 56 : 72;
    if (this.opt.lod === 'fast') base = Math.max(6, base >> 1);
    return Math.max(1, Math.ceil((base * Math.abs(sweep)) / TWO_PI - 1e-9));
  }
  segsFull(rModel: number) { return this.segs(rModel, TWO_PI); }
  planarFace(loops: { pts: number[][]; outer: boolean }[], m: NMesh, surf: Surface | null, same: boolean) {
    const L = loops.filter((l) => l.pts.length >= 3);
    if (!L.length) return;
    let oi = L.findIndex((l) => l.outer);
    const flat = (l: { pts: number[][] }) => { const o: number[] = []; for (const p of l.pts) o.push(p[0], p[1], p[2]); return o; };
    if (surf) {
      const uv = L.map((l) => { const o: number[] = []; for (const p of l.pts) { const r = surf.inv(p, null); o.push(r[0], r[1]); } return o; });
      // the outer boundary encloses all other loops, so it is the largest one (some writers flag a hole as FACE_OUTER_BOUND)
      if (L.length > 1) { let best = -1; uv.forEach((l, i) => { const ar = Math.abs(G.area2(l)); if (ar > best) { best = ar; oi = i; } }); }
      if (oi < 0) oi = 0;
      const holes = uv.filter((_, i) => i !== oi);
      const tri = G.triangulate(uv[oi], holes);
      // a self-intersecting loop (sliver face sampled coarser than its width) makes ear clipping cover
      // area outside the face: detect by area and fill with the even-odd rule instead
      const allUV = [uv[oi], ...holes].flat();
      let triArea = 0;
      for (let k = 0; k < tri.length; k += 3) { const a = tri[k], b = tri[k + 1], c = tri[k + 2]; triArea += Math.abs((allUV[2 * b] - allUV[2 * a]) * (allUV[2 * c + 1] - allUV[2 * a + 1]) - (allUV[2 * c] - allUV[2 * a]) * (allUV[2 * b + 1] - allUV[2 * a + 1])) / 2; }
      const expected = Math.abs(G.area2(uv[oi])) - holes.reduce((q, h) => q + Math.abs(G.area2(h)), 0);
      if (triArea > Math.abs(expected) * 1.02 + 1e-9 * Math.abs(G.area2(uv[oi]))) {
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
  curvedFace(s: Surface, loops: { pts: number[][]; outer: boolean }[], m: NMesh, same: boolean): boolean {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const l of loops) for (const p of l.pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); z0 = Math.min(z0, p[2]); z1 = Math.max(z1, p[2]); }
    // the boundary only has to be mapped to (u,v); points stay exact. Accept edges lying off the surface by up to 3% of the face size
    const maxRes = Math.max(this.tol * 1000, Math.hypot(x1 - x0, y1 - y0, z1 - z0) * 0.03);
    // IGES addition: on periodic surfaces split long straight boundary segments before mapping them to (u,v);
    // a line through the axis of a surface of revolution (a disc sector) is not straight in (u,v)
    if (s.perU || s.perV) {
      const maxSeg = Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 16;
      loops = loops.map((l) => {
        const P = l.pts, n = P.length, out: number[][] = [];
        for (let i = 0; i < n; i++) {
          const a = P[i], b = P[(i + 1) % n];
          out.push(a);
          if (i === n - 1 && n < 3) break;
          const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
          const k = maxSeg > 0 ? Math.min(64, Math.ceil(L / maxSeg)) : 1;
          for (let j = 1; j < k; j++) { const t = j / k; out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]); }
        }
        if (!s.perU) return { ...l, pts: out };
        // where consecutive points jump in u (passing next to the axis), bisect towards the axis so the
        // (u,v) loop runs down to it instead of cutting a small arc around it
        const per = s.perU, tolD = this.tol * 10;
        const uOf = (p: number[]) => s.inv(p, null)[0];
        const wrap = (d: number) => Math.abs(d - Math.round(d / per) * per);
        const out2: number[][] = [];
        const rec = (a: number[], b: number[], ua: number, ub: number, d: number) => {
          if (d >= 24 || wrap(ub - ua) <= per / 12 || Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) <= tolD) return;
          const mp = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
          const um = uOf(mp);
          rec(a, mp, ua, um, d + 1);
          out2.push(mp);
          rec(mp, b, um, ub, d + 1);
        };
        const U = out.map(uOf);
        for (let i = 0; i < out.length; i++) {
          out2.push(out[i]);
          if (i === out.length - 1 && out.length < 3) break;
          const j = (i + 1) % out.length;
          rec(out[i], out[j], U[i], U[j], 0);
        }
        return { ...l, pts: out2 };
      });
    }
    const uvLoops: { pts: UVP[]; outer: boolean; ku: number; kv: number }[] = [];
    for (const l of loops) {
      const out: UVP[] = [];
      let hint: number[] | null = null;
      const sing: boolean[] = [];
      for (const p of l.pts) {
        if (s.singular(p)) { out.push({ u: NaN, v: NaN, p }); sing.push(true); continue; }
        const r = s.inv(p, hint);
        if (!(r[2] <= maxRes) || !isFinite(r[0]) || !isFinite(r[1])) { if (DEBUG) console.error('FAIL inv', s.kind, '#' + this.curFace, r[2], maxRes); return false; }
        let u = r[0], v = r[1];
        if (hint) {
          if (s.perU) u += Math.round((hint[0] - u) / s.perU) * s.perU;
          if (s.perV) v += Math.round((hint[1] - v) / s.perV) * s.perV;
        }
        hint = [u, v];
        out.push({ u, v, p }); sing.push(false);
      }
      // poles: replace by two points at the pole parameter, using neighbours' u
      if (sing.some((x) => x)) {
        const fixed: UVP[] = [];
        const n = out.length;
        for (let i = 0; i < n; i++) {
          if (!sing[i]) { fixed.push(out[i]); continue; }
          let a = (i - 1 + n) % n, b = (i + 1) % n;
          while (sing[a] && a !== i) a = (a - 1 + n) % n;
          while (sing[b] && b !== i) b = (b + 1) % n;
          if (sing[a] || sing[b]) { if (DEBUG) console.error('FAIL sing', s.kind, '#' + this.curFace); return false; }
          const pv = s.poleV ? s.poleV(out[i].p!) : NaN;
          const vv = isFinite(pv) ? pv : (out[a].v + out[b].v) / 2;
          let ub = out[b].u;
          if (s.perU) ub += Math.round((out[a].u - ub) / s.perU) * s.perU;
          fixed.push({ u: out[a].u, v: vv, p: out[i].p }, { u: ub, v: vv, p: out[i].p });
        }
        // re-unwrap after insertion
        for (let i = 1; i < fixed.length; i++) if (s.perU) fixed[i].u += Math.round((fixed[i - 1].u - fixed[i].u) / s.perU) * s.perU;
        out.length = 0; out.push(...fixed);
      }
      if (out.length < 2) continue;
      const first = out[0], last = out[out.length - 1];
      // closing step: the first point seen again after the last one
      let cu = first.u, cv = first.v;
      if (s.perU) cu += Math.round((last.u - first.u) / s.perU) * s.perU;
      if (s.perV) cv += Math.round((last.v - first.v) / s.perV) * s.perV;
      const ku = s.perU ? Math.round((cu - first.u) / s.perU) : 0;
      const kv = s.perV ? Math.round((cv - first.v) / s.perV) : 0;
      // a wrapping loop keeps its closing point explicitly (it is a different (u,v) than the start)
      if (ku || kv) out.push({ u: cu, v: cv, p: first.p });
      uvLoops.push({ pts: out, outer: l.outer, ku, kv });
    }
    if (!uvLoops.length) return true;
    const keep = same !== s.flip;
    // build the domain
    const wrapU = uvLoops.filter((l) => l.ku !== 0), wrapV = uvLoops.filter((l) => l.kv !== 0 && l.ku === 0);
    let outer: UVP[] | null = null;
    let holes: UVP[][] = [];
    const rest = uvLoops.filter((l) => l.ku === 0 && l.kv === 0);
    const pairWrap = (W: typeof uvLoops, axis: 'u' | 'v'): UVP[] | null => {
      const per = axis === 'u' ? s.perU : s.perV;
      const k = (l: (typeof uvLoops)[0]) => (axis === 'u' ? l.ku : l.kv);
      if (W.length >= 2) {
        const A = W[0];
        let B = W[1];
        let bp = B.pts.slice(0, -1); // without its closing duplicate
        if (Math.sign(k(A)) === Math.sign(k(B))) bp.reverse();
        const aEnd = A.pts[A.pts.length - 1][axis];
        // rotate B to start near aEnd (mod per)
        let bi = 0, bd = Infinity;
        bp.forEach((q, i) => { const d = Math.abs((((q[axis] - aEnd) % per) + per * 1.5) % per - per / 2); if (d < bd) { bd = d; bi = i; } });
        bp = [...bp.slice(bi), ...bp.slice(0, bi)];
        // re-unwrap B continuously, then shift so it starts at aEnd
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
        // region side: left of the loop in (u,v) when keep, right otherwise
        const dir = Math.sign(k(A));
        const up = (dir > 0) === keep;
        let pv: number;
        if (s.kind === 'sphere' || s.kind.endsWith('sphere')) pv = up ? Math.PI / 2 : -Math.PI / 2;
        else pv = s.poleV(A.pts[0].p!);
        if (!isFinite(pv)) return null;
        const f = A.pts[0], l = A.pts[A.pts.length - 1];
        return [...A.pts, { u: l.u, v: pv, p: null }, { u: f.u, v: pv, p: null }];
      }
      return null;
    };
    if (wrapU.length) { outer = pairWrap(wrapU, 'u'); if (!outer) { if (DEBUG) console.error('FAIL wrapU', s.kind, '#' + this.curFace, wrapU.length, uvLoops.length); return false; } }
    else if (wrapV.length) { outer = pairWrap(wrapV, 'v'); if (!outer) { if (DEBUG) console.error('FAIL wrapV', s.kind, '#' + this.curFace, wrapV.length); return false; } }
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
    // shift holes into the outer's parameter range
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
    const t0i = m.idx.length;
    this.gridTess(s, outer, holes.filter((h) => h.length >= 3), nu, nv, m, keep);
    if (DEBUG) console.error('face', s.kind, '#' + this.curFace, 'loops', uvLoops.map((l) => `${l.pts.length}/${l.ku}/${l.kv}`).join(' '), 'u', (u1 - u0).toFixed(3), 'v', (v1 - v0).toFixed(3), 'nu', nu, 'nv', nv, 'tris', (m.idx.length - t0i) / 3);
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
      // degenerate (pole / collapsed row): take the normal slightly inside the patch
      const sv = v > 0 ? -1e-3 : 1e-3, su = u > 0 ? -1e-3 : 1e-3; // step towards the inside of the parameter range first
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
      this.snormal(s, q.u, q.v, keep !== s.flip ? true : false, nn, keep);
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
      // IGES addition: clipping the bridged ring (outer + holes) to a cell can leave coincident edges
      // along the cell side (a hole cut by the cell). Ear clipping may then cover part of the hole;
      // the signed area stays right, so compare and fall back to the even-odd fill of the cell polygon.
      if (c.length > 4) {
        let ta = 0;
        for (let k = 0; k < tri.length; k += 3) { const a = tri[k], b = tri[k + 1], d = tri[k + 2]; ta += Math.abs((fl[2 * b] - fl[2 * a]) * (fl[2 * d + 1] - fl[2 * a + 1]) - (fl[2 * d] - fl[2 * a]) * (fl[2 * b + 1] - fl[2 * a + 1])) / 2; }
        const sa = Math.abs(G.area2(fl));
        if (ta > sa * 1.001 + du * dv * 1e-9) {
          const eo = G.evenOddFill([fl]);
          const L3: UVP[] = [];
          for (let k = 0; k < eo.pts.length; k += 2) L3.push({ u: eo.pts[k], v: eo.pts[k + 1], p: null });
          L = L3; tri = eo.tri;
          this.cellEvenOdd++;
        }
      }
      // the (u,v) -> xyz map bends: a triangle that is fine in (u,v) can fold in 3D next to a curved
      // boundary. If it does, try a fan around the cell polygon's centroid and keep the better one.
      const f1 = this.folds(s, L, tri, keep);
      if (f1 > 0) {
        let cu = 0, cv = 0;
        for (const q of c) { cu += q.u; cv += q.v; }
        const cen: UVP = { u: cu / c.length, v: cv / c.length, p: null };
        const L2 = [...c, cen];
        const ccw = G.area2(fl) > 0;
        const t2: number[] = [];
        for (let i = 0; i < c.length; i++) { const j = (i + 1) % c.length; if (ccw) t2.push(i, j, c.length); else t2.push(j, i, c.length); }
        if (this.folds(s, L2, t2, keep) < f1 && inside(cen.u, cen.v)) { L = L2; tri = t2; }
      }
      emit(L, tri);
    }
  }
  /** number of triangles (CCW in (u,v)) whose 3D winding opposes the surface normal */
  folds(s: Surface, L: UVP[], tri: number[], keep: boolean): number {
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
    void keep;
    return k;
  }
  nA = [0, 0, 0]; nB = [0, 0, 0];
  cellEvenOdd = 0;

  /** face whose loops are already in the surface's (u,v) space (IGES parameter space curves). keep: normal = Su x Sv */
  uvFace(s: Surface, loops: UVP[][], m: NMesh, keep: boolean) {
    const L = loops.filter((l) => l.length >= 3);
    if (!L.length) return;
    let oi = 0, best = -1;
    L.forEach((l, i) => { const ar = Math.abs(G.area2(l.flatMap((q) => [q.u, q.v]))); if (ar > best) { best = ar; oi = i; } });
    const outer = L[oi];
    const holes = L.filter((_, i) => i !== oi);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const q of outer) { u0 = Math.min(u0, q.u); u1 = Math.max(u1, q.u); v0 = Math.min(v0, q.v); v1 = Math.max(v1, q.v); }
    let nu = Math.max(1, s.stepsU(u1 - u0)), nv = s.ruledV ? 1 : Math.max(1, s.stepsV(v1 - v0));
    // chord error check on a 9 x 9 sample of the face's parameter box (the normal turning estimate of
    // the whole surface can miss a strongly bent small face)
    const [cu, cv, diag] = this.chordSteps(s, u0, u1, v0, v1);
    const dev = diag * (this.opt.lod === 'fast' ? 1e-2 : 5e-3);
    if (dev > 0) {
      nu = Math.max(nu, Math.min(200, Math.ceil(Math.sqrt(cu / (8 * dev)))));
      if (!s.ruledV) nv = Math.max(nv, Math.min(200, Math.ceil(Math.sqrt(cv / (8 * dev)))));
    }
    if (nu * nv > 16384) { const k = Math.sqrt(16384 / (nu * nv)); nu = Math.max(1, Math.floor(nu * k)); nv = Math.max(1, Math.floor(nv * k)); }
    this.gridTess(s, outer, holes, nu, nv, m, keep);
  }
  /** max second difference along u and along v over the whole range (|S''| * range^2), and the box diagonal */
  chordSteps(s: Surface, u0: number, u1: number, v0: number, v1: number): [number, number, number] {
    const K = 8;
    const P: number[][] = [];
    for (let i = 0; i <= K; i++) for (let j = 0; j <= K; j++) { const o = [0, 0, 0]; s.eval(u0 + ((u1 - u0) * i) / K, v0 + ((v1 - v0) * j) / K, o); P.push(o); }
    const at = (i: number, j: number) => P[i * (K + 1) + j];
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of P) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); z0 = Math.min(z0, p[2]); z1 = Math.max(z1, p[2]); }
    let du = 0, dv = 0;
    for (let i = 1; i < K; i++) for (let j = 0; j <= K; j++) { const a = at(i - 1, j), b = at(i, j), c = at(i + 1, j); du = Math.max(du, Math.hypot(a[0] - 2 * b[0] + c[0], a[1] - 2 * b[1] + c[1], a[2] - 2 * b[2] + c[2])); }
    for (let i = 0; i <= K; i++) for (let j = 1; j < K; j++) { const a = at(i, j - 1), b = at(i, j), c = at(i, j + 1); dv = Math.max(dv, Math.hypot(a[0] - 2 * b[0] + c[0], a[1] - 2 * b[1] + c[1], a[2] - 2 * b[2] + c[2])); }
    // second difference with step range/K: |S''| = d / h^2, so |S''| * range^2 = d * K^2
    return [du * K * K, dv * K * K, Math.hypot(x1 - x0, y1 - y0, z1 - z0)];
  }
}
