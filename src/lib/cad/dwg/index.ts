// DWG (AutoCAD drawing) reader: public entry points.
//   sniffDwg(bytes)  -> true when the bytes start with an AutoCAD DWG version id (AC10xx)
//   readDwg(bytes, onProgress) -> { kind: '2d', sheets, layers, info, coverage }
// Runs in a Web Worker (no DOM, no Node APIs).
import { DwgError } from './bits.ts';
import { openContainer, versionString, VERSIONS } from './container.ts';
import { buildDoc } from './doc.ts';
import { buildOldDoc, OLD_VERSIONS, OLD_NAMES } from './old.ts';
import { F_ENTITY, F_FAILED, F_GRAPHICS } from './doc.ts';
import type { Doc, EntBase } from './doc.ts';
import { Renderer, newCtx, itemBounds, mapItems, mapItemsInPlace, MAX_ITEMS, clipItems, unitToMm, makeLayers, scaleWidths, SUPPORTED, STRUCTURAL, UNIT_NAMES } from './render.ts';
import type { RvtSheet2D, SheetItem, SheetViewport, DwgResult, DwgCoverage } from './types.ts';

export { DwgError };
export type { DwgResult, RvtSheet2D, SheetItem };

const MAX_BYTES = 512 * 1024 * 1024;

// conservative test: may the item touch the rectangle?
function itemHits(it: SheetItem, x0: number, y0: number, x1: number, y1: number): boolean {
  if (it.kind === 'line' || it.kind === 'fill') {
    const p = it.pts;
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (let i = 0; i < p.length; i += 2) { const x = p[i], y = p[i + 1]; if (x < a) a = x; if (x > c) c = x; if (y < b) b = y; if (y > d) d = y; }
    return !(c < x0 || a > x1 || d < y0 || b > y1);
  }
  if (it.kind === 'arc') return !(it.cx + it.r < x0 || it.cx - it.r > x1 || it.cy + it.r < y0 || it.cy - it.r > y1);
  if (it.kind === 'text') return it.x >= x0 && it.x <= x1 && it.y >= y0 && it.y <= y1;
  return true;
}

export function sniffDwg(bytes: Uint8Array): boolean {
  if (!bytes || bytes.length < 6) return false;
  const v = versionString(bytes);
  return /^AC10[0-9]{2}$/.test(v) || /^AC1\.[0-9]/.test(v) || /^AC2\.[0-9]/.test(v) || v.startsWith('MC0.0');
}

const VERNAME: Record<string, string> = {
  AC1012: 'R13', AC1014: 'R14', AC1015: 'AutoCAD 2000', AC1018: 'AutoCAD 2004', AC1021: 'AutoCAD 2007',
  AC1024: 'AutoCAD 2010', AC1027: 'AutoCAD 2013', AC1032: 'AutoCAD 2018',
};

// version id of the file (e.g. 'AC1009'), for error reports
function versionTag(bytes: Uint8Array): string {
  const v = bytes && bytes.length >= 6 ? versionString(bytes) : '';
  return /^[\x20-\x7e]{6}$/.test(v) ? v : '';
}

export async function readDwg(bytes: Uint8Array, onProgress?: (stage: string, ratio: number) => void): Promise<DwgResult> {
  try { return readDwgInner(bytes, onProgress); }
  catch (e) {
    const err = e instanceof DwgError ? e : new DwgError('corrupt', 'cannot read drawing: ' + (e as Error).message);
    if (!err.versionTag) err.versionTag = versionTag(bytes);
    throw err;
  }
}

function readDwgInner(bytes: Uint8Array, onProgress?: (stage: string, ratio: number) => void): DwgResult {
  if (!sniffDwg(bytes)) throw new DwgError('not-format', 'not a DWG file');
  if (bytes.length > MAX_BYTES) throw new DwgError('too-large', 'file is larger than 512 MB');
  const vs = versionString(bytes);
  let doc: Doc;
  let maint: number | string = '', codepage: number | string = '';
  if (OLD_VERSIONS[vs]) {
    onProgress?.('objects', 0);
    try { doc = buildOldDoc(bytes, vs, onProgress); }
    catch (e) { if (e instanceof DwgError) throw e; throw new DwgError('corrupt', 'cannot decode objects: ' + (e as Error).message); }
  } else {
    if (!VERSIONS[vs]) throw new DwgError('unsupported-version', 'DWG version ' + vs + ' is not supported (AutoCAD 2.10 to 2018+ are)');
    onProgress?.('container', 0);
    let c;
    try { c = openContainer(bytes); }
    catch (e) { if (e instanceof DwgError) throw e; throw new DwgError('corrupt', 'cannot read file structure: ' + (e as Error).message); }
    // early memory estimate: the decompressed object data stays in memory while drawing, plus about 1 to 2 times
    // as much again for the object index and the drawn items
    if (c.objects.length > 600 * 1024 * 1024) {
      throw new DwgError('too-large', 'drawing data is ' + Math.round(c.objects.length / 1048576) + ' MB after decompression, too large to open in the browser');
    }
    maint = c.maint; codepage = c.codepage;
    onProgress?.('objects', 0);
    try { doc = buildDoc(c, onProgress); }
    catch (e) { if (e instanceof DwgError) throw e; throw new DwgError('corrupt', 'cannot decode objects: ' + (e as Error).message); }
  }
  onProgress?.('draw', 0);
  const sheets: RvtSheet2D[] = [];
  const unitMm = unitToMm(doc.hv.insunits);
  const R = new Renderer(doc);
  const warnings: string[] = [...doc.warnings];

  // ---------------- model space (drawn in drawing units; converted to sheet mm in place at the end)
  R.items = [];
  R.lws = [];
  if (doc.ms) R.drawBlock(doc.ms, newCtx(false));
  const modelItems = R.items;
  const modelLw = R.lws;
  R.lws = null;
  const mb = itemBounds(modelItems);
  let modelMap: ((x: number, y: number) => [number, number]) | null = null;
  const modelSheet: RvtSheet2D = { id: doc.ms || 1, number: 'Model', name: 'Model', size: { w: 297, h: 210 }, items: [], viewports: [], completeness: 'full', warnings: [] };
  sheets.push(modelSheet);
  if (mb) {
    const all = itemBounds(modelItems, true)!;
    if (all[2] - all[0] > (mb[2] - mb[0]) * 1.5 || all[3] - all[1] > (mb[3] - mb[1]) * 1.5) {
      warnings.push('some objects lie far outside the main drawing; the sheet is sized to the main drawing');
    }
    const [x0, y0, x1, y1] = mb;
    let w = Math.max(x1 - x0, 0), h = Math.max(y1 - y0, 0);
    // a drawing of a single point or a straight line still gets a visible sheet
    let minSize = Math.max(w, h) * 0.05;
    if (Math.max(w, h) < R.refSize * 0.01) minSize = R.refSize * 0.2;
    if (w < minSize) w = minSize;
    if (h < minSize) h = minSize;
    const pad = Math.max(w, h) * 0.02;
    const ox = (x0 + x1) / 2 - w / 2 - pad, oy = (y0 + y1) / 2 - h / 2 - pad;
    modelMap = (x, y) => [(x - ox) * unitMm, (y - oy) * unitMm];
    modelSheet.size = { w: (w + 2 * pad) * unitMm, h: (h + 2 * pad) * unitMm };
  } else modelSheet.warnings.push('model space is empty');

  // ---------------- layouts (paper space)
  const layouts = doc.layouts.filter((l) => l.block && l.block !== doc.ms && doc.blocks.has(l.block)).sort((a, b) => a.tab - b.tab);
  // R13/R14 have no LAYOUT objects: use *Paper_Space with the header paper limits
  if (!doc.layouts.length && doc.ps) {
    const hv = doc.hv;
    layouts.push({
      handle: doc.ps, name: 'Paper space', tab: 1, block: doc.ps, paperW: 0, paperH: 0, paperUnits: 1, plotRot: 0,
      limMin: hv.plimMin || [0, 0], limMax: hv.plimMax || [0, 0], extMin: [0, 0, 0], extMax: [0, 0, 0], margins: [0, 0, 0, 0],
      realUnits: 1, drawUnits: 1,
    });
  }
  let li = 0, vpCopies = 0, vpSkipped = 0;
  for (const lay of layouts) {
    onProgress?.('layouts', li++ / Math.max(1, layouts.length));
    if (R.stopped) break;
    if (!R.blockEntities(lay.block).length) continue;
    const sheetWarn: string[] = [];
    R.items = [];
    R.viewports = [];
    R.drawBlock(lay.block, newCtx(true));
    const paperItems = R.items;
    // viewports (collected while drawing the layout)
    const vps: EntBase[] = R.viewports.filter((e) => e.w > 0 && e.hgt > 0);
    vps.sort((a, b) => a.handle - b.handle);
    // paper units: plot settings when the layout was set up, else the drawing units
    // sample finding: plotted size of one paper space unit = paper unit (inch or mm) x real units / drawing units
    let pu = unitMm;
    const ratio = lay.drawUnits > 0 && lay.realUnits > 0 ? lay.realUnits / lay.drawUnits : 1;
    if (lay.paperW > 0) pu = (lay.paperUnits === 0 ? 25.4 : 1) * ratio;
    if (!(pu > 0) || !Number.isFinite(pu)) pu = 1;
    const outVp: SheetViewport[] = [];
    const vpItems: SheetItem[] = [];
    const boxes: [number, number, number, number][] = [];
    for (const vp of vps) {
      const bx0 = vp.c[0] - vp.w / 2, by0 = vp.c[1] - vp.hgt / 2, bx1 = vp.c[0] + vp.w / 2, by1 = vp.c[1] + vp.hgt / 2;
      // sample finding: the layout's own paper space viewport shows paper space itself: its view centre equals its centre
      const vc0 = vp.viewCenter || [NaN, NaN];
      const tgt = vp.target || [0, 0, 0];
      const tol = 1e-6 * (1 + Math.abs(vp.c[0]) + Math.abs(vp.c[1]) + vp.w);
      if (Math.abs(vc0[0] - vp.c[0]) < tol && Math.abs(vc0[1] - vp.c[1]) < tol && Math.abs(tgt[0]) < 1e-9 && Math.abs(tgt[1]) < 1e-9) continue;
      boxes.push([bx0, by0, bx1, by1]);
      const dir = vp.dir || [0, 0, 1];
      const dl = Math.hypot(dir[0], dir[1], dir[2]) || 1;
      const plan = Math.abs(dir[2] / dl) > 0.999 && dir[2] > 0;
      const vh = vp.viewHeight;
      const scale = vh > 0 ? vp.hgt / vh : 1;
      let drawn = 0;
      if (plan && vh > 0 && modelItems.length) {
        const tw = vp.twist || 0;
        const ct = Math.cos(-tw), st = Math.sin(-tw);
        const tx = vp.target ? vp.target[0] : 0, ty = vp.target ? vp.target[1] : 0;
        const vc = vp.viewCenter || [0, 0];
        const f = (x: number, y: number): [number, number] => {
          const dx = x - tx, dy = y - ty;
          const qx = ct * dx - st * dy, qy = st * dx + ct * dy;
          return [vp.c[0] + (qx - vc[0]) * scale, vp.c[1] + (qy - vc[1]) * scale];
        };
        const frozen = new Set<string>();
        for (const fh of vp.frozen || []) { const l = doc.layers.get(fh); if (l) frozen.add(l.name); }
        // model window of this viewport (axis aligned bounds) to skip items that cannot be visible
        const inv = (px: number, py: number): [number, number] => {
          const qx = (px - vp.c[0]) / scale + vc[0], qy = (py - vp.c[1]) / scale + vc[1];
          return [ct * qx + st * qy + tx, -st * qx + ct * qy + ty];
        };
        const cs = [inv(bx0, by0), inv(bx1, by0), inv(bx0, by1), inv(bx1, by1)];
        const wx0 = Math.min(...cs.map((q) => q[0])), wx1 = Math.max(...cs.map((q) => q[0]));
        const wy0 = Math.min(...cs.map((q) => q[1])), wy1 = Math.max(...cs.map((q) => q[1]));
        const visible: SheetItem[] = [], visLw: number[] = [];
        for (let k = 0; k < modelItems.length; k++) if (itemHits(modelItems[k], wx0, wy0, wx1, wy1)) { visible.push(modelItems[k]); visLw.push(modelLw[k] || 0); }
        // memory budget: viewports copy model items; past the budget their content is left out (boxes stay)
        if (R.total + vpCopies + visible.length > MAX_ITEMS) {
          vpSkipped++;
          visible.length = 0;
        }
        vpCopies += visible.length;
        const mapped = mapItems(visible, f, scale, -tw);
        // model line weights are plotted in paper mm; the final mapping multiplies widths by pu
        for (let k = 0; k < mapped.length; k++) {
          const lw = visLw[k];
          if (lw) { const a: any = mapped[k]; const v = lw / pu; a.w = a.w ? Math.max(a.w, v) : v; }
        }
        const clipped = clipItems(mapped, [bx0, by0, bx1, by1], frozen.size ? frozen : null);
        for (const it of clipped) vpItems.push(it);
        drawn = clipped.length;
      } else if (!plan) sheetWarn.push('a viewport with a non-plan view direction was not drawn');
      const mmPerModel = scale * pu / unitMm;
      const tw = vp.twist || 0;
      const vcx = vp.viewCenter ? vp.viewCenter[0] : 0, vcy = vp.viewCenter ? vp.viewCenter[1] : 0;
      const tg = vp.target || [0, 0, 0];
      const m = unitMm / 1000;
      outVp.push({
        viewId: vp.handle, viewName: 'Viewport',
        box: [bx0, by0, bx1, by1],
        scale: mmPerModel > 0 ? Math.round(1 / mmPerModel * 1000) / 1000 : 1,
        viewType: plan ? 'plan' : 'other', levelId: null, levelName: null, cutHeight: null, crop: null, detailNumber: null,
        // model (metres) -> sheet (mm); sheetPoint is still in paper units here and is converted below
        xform: plan && vh > 0 ? {
          origin: [tg[0] * m, tg[1] * m, tg[2] * m], right: [Math.cos(tw), Math.sin(tw), 0], up: [-Math.sin(tw), Math.cos(tw), 0],
          viewDir: [0, 0, -1], sheetPoint: [vp.c[0] - vcx * scale, vp.c[1] - vcy * scale], mmPerM: scale * pu / m,
        } : null,
        annotations: drawn,
      });
    }
    for (const v of outVp) v.viewName = 'Viewport ' + (outVp.indexOf(v) + 1);
    const all = [...vpItems, ...paperItems];
    // paper extents: layout limits when they hold the content, else the content extents
    let cb = itemBounds(paperItems, true);
    for (const b of boxes) cb = cb ? [Math.min(cb[0], b[0]), Math.min(cb[1], b[1]), Math.max(cb[2], b[2]), Math.max(cb[3], b[3])] : b;
    let px0 = lay.limMin ? lay.limMin[0] : 0, py0 = lay.limMin ? lay.limMin[1] : 0;
    let px1 = lay.limMax ? lay.limMax[0] : 0, py1 = lay.limMax ? lay.limMax[1] : 0;
    const limOk = px1 > px0 && py1 > py0 && px1 - px0 < 1e7;
    if (cb) {
      const mx = (px1 - px0) * 0.1, my = (py1 - py0) * 0.1;
      const inside = limOk && cb[0] >= px0 - mx && cb[1] >= py0 - my && cb[2] <= px1 + mx && cb[3] <= py1 + my;
      if (!inside) {
        const pad = Math.max(cb[2] - cb[0], cb[3] - cb[1]) * 0.02;
        px0 = cb[0] - pad; py0 = cb[1] - pad; px1 = cb[2] + pad; py1 = cb[3] + pad;
      }
    } else if (!limOk) { px0 = 0; py0 = 0; px1 = 297; py1 = 210; }
    for (const v of outVp) {
      v.box = [(v.box[0] - px0) * pu, (v.box[1] - py0) * pu, (v.box[2] - px0) * pu, (v.box[3] - py0) * pu];
      if (v.xform) v.xform.sheetPoint = [(v.xform.sheetPoint[0] - px0) * pu, (v.xform.sheetPoint[1] - py0) * pu];
    }
    if (!all.length && !outVp.length) continue;
    scaleWidths(paperItems, 1 / pu); // paper line weights are in mm; the final mapping multiplies by pu
    const items = mapItemsInPlace(all, (x, y) => [(x - px0) * pu, (y - py0) * pu], pu);
    sheets.push({
      id: lay.handle, number: lay.name, name: lay.name,
      size: { w: (px1 - px0) * pu, h: (py1 - py0) * pu },
      items, viewports: outVp, completeness: 'full', warnings: sheetWarn,
    });
  }
  // model sheet: convert the model items to sheet mm in place (no copy)
  doc.release();
  if (modelMap) modelSheet.items = mapItemsInPlace(modelItems, modelMap, unitMm);
  if (R.stopped) for (const s of sheets) s.completeness = 'partial';
  if (R.frozenSkipped) warnings.push(R.frozenSkipped + ' entities on frozen layers were not drawn');
  if (vpSkipped) {
    warnings.push(vpSkipped + ' layout viewports were left empty to stay within the memory budget (the Model sheet has the full drawing)');
    for (const s of sheets) if (s !== modelSheet) s.completeness = 'partial';
  }
  if (R.patternFallback) warnings.push(R.patternFallback + ' pattern hatches were drawn as light fills (pattern too dense or pattern budget used up)');
  for (const w of R.warnings) warnings.push(w);

  // ---------------- coverage
  const cov: DwgCoverage = { decoded: {}, skipped: {}, failed: doc.failed };
  // counted from the object index: entities of a supported type count as decoded unless their decoding failed
  // while drawing (entities in blocks that are never drawn are not decoded at all)
  const failedNow: Record<string, number> = { ...doc.skippedDecode };
  for (let i = 0; i < doc.objects; i++) {
    const fl = doc.flags[i];
    if (!(fl & F_ENTITY)) continue;
    const k = doc.typeName(i);
    if (STRUCTURAL.has(k) || k === 'ATTRIB') continue;
    if (fl & F_FAILED) continue;
    if (SUPPORTED.has(k)) cov.decoded[k] = (cov.decoded[k] || 0) + 1;
    else if (fl & F_GRAPHICS) cov.decoded[k + '(proxy graphics)'] = (cov.decoded[k + '(proxy graphics)'] || 0) + 1;
    else cov.skipped[k] = (cov.skipped[k] || 0) + 1;
  }
  for (const [k, v] of Object.entries(failedNow)) cov.skipped[k] = (cov.skipped[k] || 0) + v;
  const acis = (cov.skipped['3DSOLID'] || 0) + (cov.skipped['REGION'] || 0) + (cov.skipped['BODY'] || 0);
  if (acis) warnings.push(acis + ' ACIS solids/regions skipped (3D solids are not supported)');
  const sk = Object.entries(cov.skipped).filter(([k]) => !['3DSOLID', 'REGION', 'BODY'].includes(k));
  if (sk.length) warnings.push('skipped entity types: ' + sk.map(([k, v]) => k + ' ' + v).join(', '));
  for (const s of sheets) if (sk.length || acis) s.completeness = s.completeness === 'full' ? 'partial' : s.completeness;

  const info: Record<string, string | number> = {
    format: 'DWG', version: vs, versionTag: vs, release: VERNAME[vs] || OLD_NAMES[vs] || vs, maintenance: maint, codepage,
    objects: doc.objects, entities: doc.entities, layers: doc.layers.size, blocks: doc.blocks.size, layouts: layouts.length,
    insunits: doc.hv.insunits, units: UNIT_NAMES[doc.hv.insunits] || String(doc.hv.insunits), unitToMm: unitMm,
    items: sheets.reduce((a, s) => a + s.items.length, 0), failedObjects: doc.failed,
    warnings: warnings.length,
  };
  if (doc.hv.extMin && doc.hv.extMax) {
    info.extMin = doc.hv.extMin.map((v) => +v.toFixed(4)).join(',');
    info.extMax = doc.hv.extMax.map((v) => +v.toFixed(4)).join(',');
  }
  // sheet level warnings (model sheet carries the file level ones)
  sheets[0].warnings.push(...warnings);
  onProgress?.('done', 1);
  return { kind: '2d', sheets, layers: makeLayers(doc), info, coverage: cov };
}
