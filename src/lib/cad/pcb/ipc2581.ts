// IPC-2581 (XML) reader, own code. The IPC-2581 standard itself is sold by IPC; only its public element names, as
// they appear in the free IPC-2581 Consortium test cases (www.ipc2581.com/a-test-cases), were used (NOTEBOOK.md).
// Read: layers (layerFunction, side, polarity), standard and user primitives (Circle, RectCenter, RectRound,
// RectCham, Oval, Diamond, Octagon, Donut, Thermal, Ellipse, Triangle, Contour with Cutout), Line / Arc /
// Polyline / Contour features with LineDesc, Pad, Hole, PadStack (LayerPad, LayerHole), Profile, Component and
// LogicalNet.
import { arcPts, arcStroke, circleRing, emptyBB, bbAddRing, obroundRing, partsBB, polygonRing, rectRing, roundRectRing, stadium, type Part, type Ring, type Xf, xfPart, xfPoint } from './geom.ts';
import { utf8, type InFile } from './container.ts';
import type { PcbDoc, PLayer, PObj } from './model.ts';
import { CadError, type PcbLayerKind, type PcbSide, type Progress } from './types.ts';
import { allEls, parseXml, type XEl } from './xml.ts';

export function sniffIpc2581(b: Uint8Array): boolean {
  const n = Math.min(b.length, 1024);
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]);
  return /<IPC-2581[\s>]/.test(s);
}

const unitOf = (u: string | undefined) => { const v = (u ?? '').toUpperCase(); return v.startsWith('MILLI') ? 1 : v.startsWith('MICRON') ? 0.001 : v === 'INCH' ? 25.4 : v === 'MIL' ? 0.0254 : 0; };
const kids = (e: XEl, local: string) => e.children.filter((c) => c.local === local);
const kid = (e: XEl, local: string) => e.children.find((c) => c.local === local);
const num = (e: XEl, a: string, d = 0) => { const v = parseFloat(e.attrs[a] ?? ''); return Number.isFinite(v) ? v : d; };
const yes = (e: XEl, a: string) => /^(true|yes|1)$/i.test(e.attrs[a] ?? '');

export async function readIpc2581(file: InFile, onProgress?: Progress): Promise<PcbDoc> {
  const xml = parseXml(utf8(file.bytes));
  const root = xml.children.find((c) => c.local === 'IPC-2581');
  if (!root) throw new CadError('not-format', 'Not an IPC-2581 file');
  onProgress?.('ipc2581 parsed', 0.2);
  const content = kid(root, 'Content');
  const ecad = kid(root, 'Ecad');
  if (!ecad) throw new CadError('corrupt', 'IPC-2581 file without Ecad data');
  const cadHeader = kid(ecad, 'CadHeader');
  const U = unitOf(cadHeader?.attrs.units) || 1;
  const doc: PcbDoc = { layers: [], comps: [], nets: new Set(), warnings: [], source: 'IPC-2581', info: {} };
  const rev = root.attrs.revision;
  if (rev) doc.info.revision = rev;
  const warned = new Set<string>();
  const warn = (m: string) => { if (!warned.has(m)) { warned.add(m); doc.warnings.push(m); } };
  // dictionaries
  const lineDescs = new Map<string, XEl>();
  const stdPrims = new Map<string, { el: XEl; u: number }>();
  const userPrims = new Map<string, { el: XEl; u: number }>();
  if (content) {
    for (const d of content.children) {
      const du = unitOf(d.attrs.units) || U;
      if (d.local === 'DictionaryLineDesc') for (const e of kids(d, 'EntryLineDesc')) { const ld = kid(e, 'LineDesc'); if (ld) lineDescs.set(e.attrs.id, ld); }
      if (d.local === 'DictionaryStandard') for (const e of kids(d, 'EntryStandard')) { const c = e.children[0]; if (c) stdPrims.set(e.attrs.id, { el: c, u: du }); }
      if (d.local === 'DictionaryUser') for (const e of kids(d, 'EntryUser')) { const c = e.children[0]; if (c) userPrims.set(e.attrs.id, { el: c, u: du }); }
    }
  }
  const primCache = new Map<string, Part[]>();
  const stdShape = (id: string): Part[] => {
    const k = 's:' + id;
    let p = primCache.get(k);
    if (p) return p;
    const e = stdPrims.get(id);
    p = e ? shapeOf(e.el, e.u) : (warn(`IPC-2581 primitive ${id} is not defined`), []);
    primCache.set(k, p);
    return p;
  };
  const userShape = (id: string): Part[] => {
    const k = 'u:' + id;
    let p = primCache.get(k);
    if (p) return p;
    primCache.set(k, []);
    const e = userPrims.get(id);
    p = [];
    if (e) for (const o of featureObjs(e.el, e.u, null)) for (const pp of o.parts) p.push(pp);
    primCache.set(k, p);
    return p;
  };

  /** standard primitive element to parts (local coordinates, mm) */
  function shapeOf(e: XEl, u: number): Part[] {
    const g = (a: string) => num(e, a) * u;
    switch (e.local) {
      case 'Circle': return g('diameter') > 0 ? [[circleRing(0, 0, g('diameter') / 2)]] : [];
      case 'RectCenter': return [[rectRing(0, 0, g('width'), g('height'))]];
      case 'RectCorner': { const x0 = g('lowerLeftX'), y0 = g('lowerLeftY'), x1 = g('upperRightX'), y1 = g('upperRightY'); return [[rectRing((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0)]]; }
      case 'RectRound': case 'RectCham': {
        const any = ['upperRight', 'upperLeft', 'lowerLeft', 'lowerRight'].some((c) => e.attrs[c] !== undefined);
        const m = any ? (yes(e, 'upperRight') ? 1 : 0) | (yes(e, 'upperLeft') ? 2 : 0) | (yes(e, 'lowerLeft') ? 4 : 0) | (yes(e, 'lowerRight') ? 8 : 0) : 15;
        return [[roundRectRing(0, 0, g('width'), g('height'), e.local === 'RectRound' ? g('radius') : g('chamfer'), e.local === 'RectCham', m)]];
      }
      case 'Oval': return [[obroundRing(0, 0, g('width'), g('height'))]];
      case 'Diamond': { const w = g('width') / 2, h = g('height') / 2; return [[Float64Array.of(w, 0, 0, h, -w, 0, 0, -h)]]; }
      case 'Octagon': return [[roundRectRing(0, 0, g('width'), g('height'), g('inset'), true)]];
      case 'Hexagon': return [[polygonRing(0, 0, g('length') || g('width'), 6, 0)]];
      case 'Triangle': { const b = g('base') / 2, h = g('height') / 2; return [[Float64Array.of(-b, -h, b, -h, 0, h)]]; }
      case 'Ellipse': { const r = circleRing(0, 0, 1); const w = g('width') / 2, h = g('height') / 2; for (let i = 0; i < r.length; i += 2) { r[i] *= w; r[i + 1] *= h; } return [[r]]; }
      case 'Donut': {
        const od = g('outerDiameter'), id = g('innerDiameter');
        if (/SQUARE/i.test(e.attrs.shape ?? '')) return [[rectRing(0, 0, od, od), rectRing(0, 0, id, id)]];
        return [[circleRing(0, 0, od / 2), ...(id > 0 ? [circleRing(0, 0, id / 2)] : [])]];
      }
      case 'Thermal': {
        const ro = g('outerDiameter') / 2, ri = g('innerDiameter') / 2, gap = g('gap'), ns = Math.max(1, num(e, 'spokeCount', 4)), a0 = (num(e, 'spokeStartAngle') * Math.PI) / 180;
        const parts: Part[] = [];
        const step = (Math.PI * 2) / ns;
        for (let k = 0; k < ns; k++) {
          const c0 = a0 + k * step;
          const go = Math.asin(Math.min(1, gap / 2 / ro)), gi = Math.asin(Math.min(1, gap / 2 / Math.max(ri, 1e-6)));
          if (step - 2 * go <= 0) continue;
          const pts: number[] = [];
          arcPts(0, 0, ro, ro, c0 + go, step - 2 * go, pts, true);
          const inner: number[] = [];
          if (step - 2 * gi > 0) arcPts(0, 0, ri, ri, c0 + gi, step - 2 * gi, inner, true);
          for (let q = inner.length - 2; q >= 0; q -= 2) pts.push(inner[q], inner[q + 1]);
          parts.push([Float64Array.from(pts)]);
        }
        return parts;
      }
      case 'Contour': return contourParts(e, u);
      case 'UserSpecial': { const out: Part[] = []; for (const o of featureObjs(e, u, null)) for (const p of o.parts) out.push(p); return out; }
      default: warn(`IPC-2581 primitive <${e.local}> is not supported`); return [];
    }
  }
  function polyPts(e: XEl, u: number): number[] {
    const pts: number[] = [];
    for (const c of e.children) {
      if (c.local === 'PolyBegin') pts.push(num(c, 'x') * u, num(c, 'y') * u);
      else if (c.local === 'PolyStepSegment') pts.push(num(c, 'x') * u, num(c, 'y') * u);
      else if (c.local === 'PolyStepCurve' && pts.length >= 2) {
        const xs = pts[pts.length - 2], ys = pts[pts.length - 1];
        const xe = num(c, 'x') * u, ye = num(c, 'y') * u, cx = num(c, 'centerX') * u, cy = num(c, 'centerY') * u;
        const cw = yes(c, 'clockwise');
        const r0 = Math.hypot(xs - cx, ys - cy), r1 = Math.hypot(xe - cx, ye - cy);
        const a0 = Math.atan2(ys - cy, xs - cx), a1 = Math.atan2(ye - cy, xe - cx);
        let sw = a1 - a0;
        const full = Math.hypot(xe - xs, ye - ys) < 1e-9;
        if (cw) { while (sw >= 0) sw -= Math.PI * 2; if (full) sw = -Math.PI * 2; } else { while (sw <= 0) sw += Math.PI * 2; if (full) sw = Math.PI * 2; }
        arcPts(cx, cy, r0, r1, a0, sw, pts, false);
        pts[pts.length - 2] = xe; pts[pts.length - 1] = ye;
      }
    }
    return pts;
  }
  function closeRing(pts: number[]): Ring | null {
    if (pts.length >= 4 && Math.abs(pts[pts.length - 2] - pts[0]) < 1e-9 && Math.abs(pts[pts.length - 1] - pts[1]) < 1e-9) pts.length -= 2;
    return pts.length >= 6 ? Float64Array.from(pts) : null;
  }
  function contourParts(e: XEl, u: number): Part[] {
    const rings: Ring[] = [];
    for (const c of e.children) if (c.local === 'Polygon' || c.local === 'Cutout') { const r = closeRing(polyPts(c, u)); if (r) rings.push(r); }
    return rings.length ? [rings] : [];
  }
  function lineWidth(e: XEl, u: number): number {
    const ld = kid(e, 'LineDesc') ?? (kid(e, 'LineDescRef') ? lineDescs.get(kid(e, 'LineDescRef')!.attrs.id) : undefined);
    if (!ld) return 0;
    return num(ld, 'lineWidth') * u;
  }
  function xformOf(container: XEl, u: number): Xf {
    const loc = kid(container, 'Location');
    const xf = kid(container, 'Xform');
    return {
      mx: xf ? yes(xf, 'mirror') : false, my: false,
      rot: xf ? num(xf, 'rotation') : 0, s: xf ? num(xf, 'scale', 1) || 1 : 1,
      tx: (loc ? num(loc, 'x') : 0) * u + (xf ? num(xf, 'xOffset') * u : 0), ty: (loc ? num(loc, 'y') : 0) * u + (xf ? num(xf, 'yOffset') * u : 0),
    };
  }
  /** geometry children of a Features / UserSpecial / Pad element */
  function featureObjs(e: XEl, u: number, net: string | null): PObj[] {
    const out: PObj[] = [];
    const xf = xformOf(e, u);
    const ident = !xf.mx && !xf.rot && xf.s === 1 && !xf.tx && !xf.ty;
    const put = (o: PObj) => {
      if (!ident) {
        o.parts = o.parts.map((p) => xfPart(p, xf));
        if (o.path) { const q = new Float64Array(o.path.length); for (let i = 0; i < q.length; i += 2) { const [a, b] = xfPoint(o.path[i], o.path[i + 1], xf); q[i] = a; q[i + 1] = b; } o.path = q; }
        if (o.w) o.w *= xf.s;
      }
      o.bb = o.parts.length ? partsBB(o.parts) : (() => { const b = emptyBB(); if (o.path) bbAddRing(b, o.path); return b; })();
      if (net) o.net = net;
      out.push(o);
    };
    for (const c of e.children) {
      switch (c.local) {
        case 'Line': {
          const x0 = num(c, 'startX') * u, y0 = num(c, 'startY') * u, x1 = num(c, 'endX') * u, y1 = num(c, 'endY') * u, w = lineWidth(c, u);
          put({ dark: true, parts: w > 0 ? [[stadium(x0, y0, x1, y1, w / 2)]] : [], bb: emptyBB(), t: 'draw', path: Float64Array.of(x0, y0, x1, y1), w });
          break;
        }
        case 'Arc': {
          const xs = num(c, 'startX') * u, ys = num(c, 'startY') * u, xe = num(c, 'endX') * u, ye = num(c, 'endY') * u, cx = num(c, 'centerX') * u, cy = num(c, 'centerY') * u;
          const cw = yes(c, 'clockwise'), w = lineWidth(c, u);
          const r0 = Math.hypot(xs - cx, ys - cy), r1 = Math.hypot(xe - cx, ye - cy);
          const a0 = Math.atan2(ys - cy, xs - cx), a1 = Math.atan2(ye - cy, xe - cx);
          let sw = a1 - a0;
          const full = Math.hypot(xe - xs, ye - ys) < 1e-9;
          if (cw) { while (sw >= 0) sw -= Math.PI * 2; if (full) sw = -Math.PI * 2; } else { while (sw <= 0) sw += Math.PI * 2; if (full) sw = Math.PI * 2; }
          const path: number[] = [];
          arcPts(cx, cy, r0, r1, a0, sw, path, true);
          put({ dark: true, parts: w > 0 ? [arcStroke(cx, cy, r0, r1, a0, sw, w / 2)] : [], bb: emptyBB(), t: 'arc', path: Float64Array.from(path), w });
          break;
        }
        case 'Polyline': {
          const pts = polyPts(c, u), w = lineWidth(c, u);
          const parts: Part[] = [];
          if (w > 0) for (let i = 0; i + 3 < pts.length; i += 2) parts.push([stadium(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], w / 2)]);
          put({ dark: true, parts, bb: emptyBB(), t: 'draw', path: Float64Array.from(pts), w });
          break;
        }
        case 'Contour': { const parts = contourParts(c, u); if (parts.length) put({ dark: true, parts, bb: emptyBB(), t: 'surface' }); break; }
        case 'StandardPrimitiveRef': { const parts = stdShape(c.attrs.id).map((p) => p.map((r) => r)); if (parts.length) put({ dark: true, parts, bb: emptyBB(), t: 'flash' }); break; }
        case 'UserPrimitiveRef': { const parts = userShape(c.attrs.id); if (parts.length) put({ dark: true, parts, bb: emptyBB(), t: 'flash' }); break; }
        case 'UserSpecial': for (const o of featureObjs(c, u, net)) put(o); break;
        case 'Circle': case 'RectCenter': case 'RectRound': case 'RectCham': case 'Oval': case 'Diamond': case 'Octagon': case 'Donut': case 'Thermal': case 'Ellipse': case 'Triangle': case 'Hexagon': case 'RectCorner': {
          const parts = shapeOf(c, u);
          if (parts.length) put({ dark: true, parts, bb: emptyBB(), t: 'flash' });
          break;
        }
      }
    }
    return out;
  }

  // layers
  const cad = kid(ecad, 'CadData');
  if (!cad) throw new CadError('corrupt', 'IPC-2581 file without CadData');
  const layerEls = allEls(cad, 'Layer').filter((l) => l.attrs.layerFunction !== undefined && l.attrs.name !== undefined);
  const cuNames = layerEls.filter((l) => /^(CONDUCTOR|SIGNAL|PLANE|MIXED|POWER_GROUND|CONDFOIL|CONDFILM)$/i.test(l.attrs.layerFunction ?? '')).map((l) => l.attrs.name);
  const layerMap = new Map<string, PLayer>();
  for (const le of layerEls) {
    const fnc = (le.attrs.layerFunction ?? '').toUpperCase();
    const sideAttr = (le.attrs.side ?? '').toUpperCase();
    let side: PcbSide = sideAttr === 'TOP' ? 'top' : sideAttr === 'BOTTOM' ? 'bottom' : sideAttr === 'INNER' ? 'inner' : sideAttr === 'BOTH' || sideAttr === 'ALL' ? 'both' : null;
    let kind: PcbLayerKind = 'other';
    let order = 0;
    const nm = le.attrs.name;
    if (cuNames.includes(nm)) { kind = 'copper'; order = cuNames.indexOf(nm) + 1; if (!side) side = order === 1 ? 'top' : order === cuNames.length ? 'bottom' : 'inner'; }
    else if (/SOLDERMASK/.test(fnc)) kind = 'mask';
    else if (/SILKSCREEN|LEGEND/.test(fnc)) kind = 'silk';
    else if (/PASTE/.test(fnc)) kind = 'paste';
    else if (/DRILL|ROUT/.test(fnc)) { kind = 'drill'; side = 'both'; }
    else if (/BOARD_?OUTLINE|PROFILE/.test(fnc)) { kind = 'outline'; side = 'both'; }
    else if (/COMPONENT/.test(fnc)) kind = 'component';
    else if (/DOCUMENT|GRAPHIC|ASSEMBLY|DRAWING/.test(fnc)) kind = 'drawing';
    const label = kind === 'copper' ? `${side === 'top' ? 'Top copper' : side === 'bottom' ? 'Bottom copper' : `Inner copper L${order}`} (${nm})`
      : kind === 'mask' ? `${side === 'bottom' ? 'Bottom' : 'Top'} solder mask (${nm})` : kind === 'silk' ? `${side === 'bottom' ? 'Bottom' : 'Top'} silkscreen (${nm})`
      : kind === 'paste' ? `${side === 'bottom' ? 'Bottom' : 'Top'} paste (${nm})` : kind === 'drill' ? `Holes (${nm})` : kind === 'outline' ? `Board outline (${nm})` : `${nm}`;
    const L: PLayer = { name: label, file: nm, format: 'ipc2581', kind, side, order, fn: fnc, objs: [], warnings: [], stats: {} };
    if (/NEGATIVE/i.test(le.attrs.polarity ?? '')) L.invert = true;
    layerMap.set(nm, L);
  }
  // stackup thickness
  for (const st of allEls(cad, 'Stackup')) {
    const t = num(st, 'overallThickness') * U;
    if (t > 0.05 && t < 20) doc.thickness = t;
    else {
      let s = 0;
      const walk = (e: XEl) => { for (const c of e.children) { if (c.local === 'StackupLayer') s += num(c, 'thickness') * U; walk(c); } };
      walk(st);
      if (s > 0.05 && s < 20) doc.thickness = +s.toFixed(3);
    }
  }
  const steps = allEls(cad, 'Step');
  if (!steps.length) throw new CadError('corrupt', 'IPC-2581 file without a Step');
  const step = steps[0];
  if (steps.length > 1) warn(`IPC-2581 file has ${steps.length} steps; showing "${step.attrs.name}"`);
  doc.info.step = step.attrs.name ?? '';
  const seenPad = new Set<string>();
  const holeKey = new Set<string>();
  let drillLayer: PLayer | undefined;
  const addHole = (L: PLayer, x: number, y: number, d: number, plating: string) => {
    const k = `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
    if (holeKey.has(k)) return;
    holeKey.add(k);
    const pl = !/NONPLATED|NON_PLATED|UNPLATED/i.test(plating);
    L.objs.push({ dark: true, parts: [[circleRing(x, y, d / 2)]], bb: [x - d / 2, y - d / 2, x + d / 2, y + d / 2], t: 'hole', w: d, fn: pl ? (/VIA/i.test(plating) ? 'Via' : 'PTH') : 'NPTH' });
  };
  const lfs = kids(step, 'LayerFeature');
  let li = 0;
  for (const lf of lfs) {
    li++;
    onProgress?.('ipc2581 layer', 0.2 + 0.4 * (li / lfs.length));
    const L = layerMap.get(lf.attrs.layerRef);
    if (!L) continue;
    for (const set of kids(lf, 'Set')) {
      const net = set.attrs.net ? set.attrs.net.replace(/^[^:]*:/, '') : null;
      const neg = /NEGATIVE/i.test(set.attrs.polarity ?? '');
      for (const c of set.children) {
        if (c.local === 'Features' || c.local === 'Pad') {
          const objs = featureObjs(c, U, net);
          if (c.local === 'Pad') {
            const loc = kid(c, 'Location');
            const ref = kid(c, 'StandardPrimitiveRef') ?? kid(c, 'UserPrimitiveRef');
            seenPad.add(`${L.file}|${loc ? num(loc, 'x') : 0}|${loc ? num(loc, 'y') : 0}|${ref?.attrs.id}`);
          }
          for (const o of objs) { if (neg) o.dark = false; L.objs.push(o); }
        } else if (c.local === 'Hole') {
          addHole(L, num(c, 'x') * U, num(c, 'y') * U, num(c, 'diameter') * U, c.attrs.platingStatus ?? '');
        }
      }
    }
    if (L.kind === 'drill') drillLayer = drillLayer ?? L;
  }
  // pad stacks (IPC-2581 rev B style: pads and holes live in PadStack)
  const stacks = kids(step, 'PadStack');
  for (const ps of stacks) {
    const net = ps.attrs.net ? ps.attrs.net.replace(/^[^:]*:/, '') : undefined;
    for (const c of ps.children) {
      if (c.local === 'LayerPad') {
        const L = layerMap.get(c.attrs.layerRef);
        if (!L) continue;
        const loc = kid(c, 'Location');
        const ref = kid(c, 'StandardPrimitiveRef') ?? kid(c, 'UserPrimitiveRef');
        const key = `${L.file}|${loc ? num(loc, 'x') : 0}|${loc ? num(loc, 'y') : 0}|${ref?.attrs.id}`;
        if (seenPad.has(key)) continue;
        seenPad.add(key);
        for (const o of featureObjs(c, U, net ?? null)) L.objs.push(o);
      } else if (c.local === 'LayerHole') {
        if (!drillLayer) {
          drillLayer = { name: 'Holes', file: 'PadStack holes', format: 'ipc2581', kind: 'drill', side: 'both', order: 0, objs: [], warnings: [], stats: {} };
          layerMap.set('#holes', drillLayer);
        }
        addHole(drillLayer, num(c, 'x') * U, num(c, 'y') * U, num(c, 'diameter') * U, c.attrs.platingStatus ?? '');
      }
    }
  }
  for (const L of layerMap.values()) if (L.objs.length) doc.layers.push(L);
  // profile
  const prof = kid(step, 'Profile');
  if (prof) {
    const rings: Ring[] = [];
    for (const c of prof.children) if (c.local === 'Polygon' || c.local === 'Cutout') { const r = closeRing(polyPts(c, U)); if (r) rings.push(r); }
    if (rings.length) doc.profile = [rings];
  }
  for (const c of kids(step, 'Component')) {
    const loc = kid(c, 'Location'), xf = kid(c, 'Xform');
    doc.comps.push({ refdes: (c.attrs.refDes ?? '').replace(/^[^:]*:/, ''), x: (loc ? num(loc, 'x') : 0) * U, y: (loc ? num(loc, 'y') : 0) * U, rot: xf ? num(xf, 'rotation') : 0, side: /B-|BOT/i.test(c.attrs.layerRef ?? '') ? 'bottom' : 'top', part: c.attrs.part, pkg: c.attrs.packageRef });
  }
  for (const n of kids(step, 'LogicalNet')) if (n.attrs.name) doc.nets.add(n.attrs.name.replace(/^[^:]*:/, ''));
  if (!doc.layers.length) throw new CadError('corrupt', 'IPC-2581 file without layer features');
  return doc;
}
