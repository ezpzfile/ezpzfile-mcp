// Pattern hatch lines clipped to boundary rings (even-odd). Own code, copied from the DXF engine (/tmp/cad/dxf/dxf.ts).

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
