// PCB fabrication data engine: entry points. See README.md.
//   readPcb(files, onProgress?, options?)  Gerber RS-274X / X2 / X3, Excellon / XNC drill, ODB++, IPC-2581,
//                                          single files or a zip / tgz with a whole set
//   sniffPcb(name, bytes)                  what a single file is, from its bytes
//   comparePcb(filesA, filesB, ...)        layer by layer overlay of two revisions (compare.ts)
import { build2D } from './build2d.ts';
import { build3D } from './build3d.ts';
import { fromFileFunction, fromFileName, type LayerClass } from './classify.ts';
import { expand, latin1, utf8, type InFile } from './container.ts';
import { readExcellon, sniffExcellon } from './excellon.ts';
import { emptyBB, bbUnion, setArcTolerance } from './geom.ts';
import { readGerber, sniffGerber } from './gerber.ts';
import { readIpc2581, sniffIpc2581 } from './ipc2581.ts';
import { measure } from './measure.ts';
import type { PcbDoc, PLayer, PObj } from './model.ts';
import { readOdb, isOdbTree } from './odb.ts';
import { findOutline } from './outline.ts';
import { CadError, type CadInfo, type LayerInfo, type Progress, type RvtGeometry, type RvtSheet2D } from './types.ts';

export type PcbFileKind = 'gerber' | 'excellon' | 'odb' | 'ipc2581' | 'gerber-job' | 'archive' | null;

export interface PcbOptions {
  /** build the 3D board too (default true; skipped without a closed outline) */
  threeD?: boolean;
  /** arc / circle chord tolerance in mm (default 0.002) */
  arcTolerance?: number;
  /** time budget for cutting clear (negative) objects per layer, ms (default 60000) */
  clearBudgetMs?: number;
  /** skip the raster based minimum spacing estimate (default false) */
  noSpacing?: boolean;
}

export interface PcbResult {
  kind: '2d';
  sheets: RvtSheet2D[];
  layers: LayerInfo[];
  info: CadInfo;
  /** optional extra: the board in 3D (metres, z up) when an outline was found */
  geometry?: RvtGeometry;
  warnings: string[];
}

/** sniff one file by its bytes (name only helps to tell archives apart) */
export function sniffPcb(name: string, bytes: Uint8Array): PcbFileKind {
  const b = bytes;
  if (b.length < 4) return null;
  if ((b[0] === 0x50 && b[1] === 0x4b) || (b[0] === 0x1f && b[1] === 0x8b)) return 'archive';
  if (b.length >= 262 && String.fromCharCode(...b.subarray(257, 262)) === 'ustar') return 'archive';
  if (sniffIpc2581(b)) return 'ipc2581';
  if (sniffGerber(b)) return 'gerber';
  if (sniffExcellon(b)) return 'excellon';
  const head = latin1(b.subarray(0, 2048));
  if (/^\s*\{/.test(head) && /"Header"\s*:/.test(head) && /"GenerationSoftware"|"FilesAttributes"|"GeneralSpecs"/.test(head)) return 'gerber-job';
  if (/^\s*(STEP|LAYER)\s*\{/m.test(head) && /\bNAME\s*=/.test(head) && /CONTEXT\s*=/.test(head)) return 'odb';
  void name;
  return null;
}

const baseName = (p: string) => p.replace(/\\/g, '/').split('/').pop() ?? p;

export async function loadPcbDoc(files: InFile[], onProgress?: Progress, opts: PcbOptions = {}): Promise<PcbDoc> {
  if (!files.length) throw new CadError('not-format', 'No files');
  // big data sets: a slightly coarser arc tolerance keeps memory in check (still under 5 um)
  const totalIn = files.reduce((a, f) => a + f.bytes.length, 0);
  setArcTolerance(opts.arcTolerance ?? (totalIn > 12e6 ? 0.004 : 0.002));
  onProgress?.('unpack', 0);
  const flat = await expand(files, onProgress);
  // ODB++ tree?
  if (isOdbTree(flat)) { onProgress?.('odb', 0.1); return readOdb(flat, onProgress); }
  const ipc = flat.find((f) => sniffIpc2581(f.bytes));
  if (ipc) { onProgress?.('ipc2581', 0.1); return readIpc2581(ipc, onProgress); }
  const doc: PcbDoc = { layers: [], comps: [], nets: new Set(), warnings: [], source: 'Gerber', info: {} };
  // Gerber job file: board thickness and file functions
  const jobFn = new Map<string, string>();
  for (const f of flat) {
    if (sniffPcb(f.name, f.bytes) !== 'gerber-job') continue;
    try {
      const j = JSON.parse(utf8(f.bytes));
      const t = j?.GeneralSpecs?.BoardThickness;
      if (typeof t === 'number' && t > 0.05 && t < 20) doc.thickness = t;
      for (const a of j?.FilesAttributes ?? []) if (a?.Path && a?.FileFunction) jobFn.set(baseName(String(a.Path)).toLowerCase(), String(a.FileFunction));
    } catch { doc.warnings.push(`${baseName(f.name)}: Gerber job file is not valid JSON`); }
  }
  const names = new Set<string>();
  let k = 0;
  for (const f of flat) {
    k++;
    onProgress?.('read', (k / flat.length) * 0.6);
    const fname = baseName(f.name);
    const what = sniffPcb(f.name, f.bytes);
    if (what !== 'gerber' && what !== 'excellon') continue;
    const byName = fromFileName(f.name);
    if (byName?.skip && what !== 'gerber') continue;
    const text = latin1(f.bytes);
    let L: PLayer;
    try {
    if (what === 'gerber') {
      const g = readGerber(text, fname);
      const fn = g.attrs.FileFunction || jobFn.get(fname.toLowerCase());
      let cls: LayerClass | null = fn ? fromFileFunction(fn) : null;
      if (!cls) cls = byName && !byName.skip ? byName : null;
      if (!cls) cls = { kind: 'other', side: null, order: 0, label: fname };
      L = { name: '', file: fname, format: 'gerber', kind: cls.kind, side: cls.side, order: cls.order, fn: fn || undefined, objs: g.objs, warnings: g.warnings, stats: { ...g.stats, units: g.units }, generator: g.attrs.GenerationSoftware };
      if (cls.kind === 'drill') L.plated = cls.plated;
      // negative copper planes (X2 .FilePolarity,Negative, or %IPNEG)
      const negAttr = /^Negative/i.test(g.attrs.FilePolarity ?? '') || (!g.attrs.FilePolarity && g.attrs.FilmMode === 'Negative');
      if (g.invert || (negAttr && cls.kind === 'copper')) L.invert = true;
      for (const n of g.nets) doc.nets.add(n);
      for (const c of g.comps) doc.comps.push({ refdes: c.refdes, x: c.x, y: c.y, rot: c.rot, side: cls.side === 'bottom' ? 'bottom' : 'top' });
      L.name = cls.label;
    } else {
      const d = readExcellon(text);
      const fn = d.attrs.FileFunction;
      let cls: LayerClass | null = fn ? fromFileFunction(fn) : null;
      if (!cls && byName && byName.kind === 'drill') cls = byName;
      if (!cls) cls = { kind: 'drill', side: 'both', order: 0, label: 'Holes' };
      if (cls.kind !== 'drill' && cls.kind !== 'outline') cls = { kind: 'drill', side: 'both', order: 0, label: 'Holes' };
      // a routed board edge (Altium BoardEdgeRout) is the outline
      if (/board[-_ ]?edge[-_ ]?rout/i.test(fname) && !d.stats.holes) cls = { kind: 'outline', side: 'both', order: 0, label: 'Board outline (rout)' };
      L = { name: cls.label, file: fname, format: 'excellon', kind: cls.kind, side: 'both', order: 0, fn: fn || undefined, objs: d.objs, warnings: d.warnings, stats: { ...d.stats, units: d.units, guessed: d.guessed ? 1 : 0 } };
      L.plated = cls.plated ?? (d.plated === 'plated' ? true : d.plated === 'nonplated' ? false : undefined);
      if (cls.label === 'Holes' && L.plated !== undefined) L.name = L.plated ? 'Plated holes' : 'Non-plated holes';
    }
    } catch (e) { if ((e as CadError).code === 'too-large') throw e; doc.warnings.push(`${fname}: could not be read (${(e as Error).message})`); continue; }
    doc.layers.push(L);
  }
  if (!doc.layers.length) throw new CadError('not-format', 'No Gerber, drill, ODB++ or IPC-2581 data found');
  // unique display names: "Top copper", "Top copper (2)" ...
  for (const L of doc.layers) {
    let nm = L.name;
    if (names.has(nm)) nm = `${L.name} · ${L.file}`;
    let i = 2;
    while (names.has(nm)) nm = `${L.name} (${i++})`;
    names.add(nm);
    L.name = nm;
  }
  fixBottomOrder(doc.layers);
  fixGuessedDrills(doc);
  const gens = [...new Set(doc.layers.map((l) => l.generator).filter(Boolean))];
  if (gens.length) doc.info.generator = gens.join('; ');
  return doc;
}

/** bottom copper gets the highest copper number */
function fixBottomOrder(layers: PLayer[]) {
  const cu = layers.filter((l) => l.kind === 'copper');
  const max = Math.max(0, ...cu.filter((l) => l.order && l.order < 99).map((l) => l.order));
  for (const l of cu) if (l.side === 'bottom' && (l.order === 99 || !l.order)) l.order = Math.max(max + 1, 2);
  // plain L1..Ln names: the highest is the bottom
  const plain = cu.filter((l) => /^Copper L\d+$/.test(l.name.replace(/ ·.*$/, '')));
  if (plain.length >= 2 && !cu.some((l) => l.side === 'bottom')) {
    const top = plain.reduce((a, b) => (b.order > a.order ? b : a));
    top.side = 'bottom';
    top.name = top.name.replace(/^Copper L(\d+)/, 'Bottom copper L$1');
  }
}

/** header-less drill files: choose the coordinate scale that puts the holes on the copper */
function fixGuessedDrills(doc: PcbDoc) {
  const cu = emptyBB();
  for (const L of doc.layers) if (L.kind === 'copper' || L.kind === 'outline') for (const o of L.objs) bbUnion(cu, o.bb);
  if (!Number.isFinite(cu[0])) return;
  for (const L of doc.layers) {
    if (L.format !== 'excellon' || !L.stats.guessed || !L.objs.length) continue;
    const pts: number[] = [];
    for (const o of L.objs) pts.push((o.bb[0] + o.bb[2]) / 2, (o.bb[1] + o.bb[3]) / 2);
    let best = 1, bestScore = -1;
    for (const s of [1, 10, 0.1, 100, 0.01, 1 / 25.4, 10 / 25.4, 0.1 / 25.4, 25.4, 2.54, 0.254]) {
      let inside = 0;
      for (let i = 0; i < pts.length; i += 2) { const x = pts[i] * s, y = pts[i + 1] * s; if (x >= cu[0] && x <= cu[2] && y >= cu[1] && y <= cu[3]) inside++; }
      const sc = inside / (pts.length / 2) - Math.abs(Math.log10(s)) * 1e-3;
      if (sc > bestScore) { bestScore = sc; best = s; }
    }
    if (best !== 1 && bestScore > 0.5) {
      for (const o of L.objs) scaleObjAbout(o, best);
      L.warnings.push(`Drill coordinates had no format: scaled by ${+best.toFixed(4)} to fit the copper layers`);
    }
  }
}

function scaleObjAbout(o: PObj, s: number) {
  // positions scale, hole diameters stay (they come from the tool table)
  const cx = (o.bb[0] + o.bb[2]) / 2, cy = (o.bb[1] + o.bb[3]) / 2;
  const nx = cx * s, ny = cy * s;
  if (o.t === 'hole') {
    const dx = nx - cx, dy = ny - cy;
    o.parts = o.parts.map((p) => p.map((r) => { const q = new Float64Array(r.length); for (let i = 0; i < r.length; i += 2) { q[i] = r[i] + dx; q[i + 1] = r[i + 1] + dy; } return q; }));
    o.bb = [o.bb[0] + dx, o.bb[1] + dy, o.bb[2] + dx, o.bb[3] + dy];
    return;
  }
  if (o.path) {
    const p = o.path;
    for (let i = 0; i < p.length; i++) p[i] *= s;
  }
  o.parts = o.parts.map((p) => p.map((r) => { const q = new Float64Array(r.length); for (let i = 0; i < r.length; i++) q[i] = r[i] * s; return q; }));
  o.bb = [o.bb[0] * s, o.bb[1] * s, o.bb[2] * s, o.bb[3] * s];
}

export async function readPcb(files: InFile[], onProgress?: Progress, opts: PcbOptions = {}): Promise<PcbResult> {
  try { return await readPcbInner(files, onProgress, opts); }
  catch (e) { if (e instanceof CadError || (e as CadError).code) throw e; throw new CadError('corrupt', `PCB data could not be read: ${(e as Error).message}`); }
}

async function readPcbInner(files: InFile[], onProgress?: Progress, opts: PcbOptions = {}): Promise<PcbResult> {
  const t0 = Date.now();
  const doc = await loadPcbDoc(files, onProgress, opts);
  onProgress?.('outline', 0.62);
  const outline = findOutline(doc.layers, doc.profile);
  onProgress?.('2d', 0.65);
  const title = files.length === 1 ? baseName(files[0].name).replace(/\.(zip|tgz|tar\.gz|tar)$/i, '') : 'PCB';
  const b2 = build2D(doc.layers, outline, title, { clearBudgetMs: opts.clearBudgetMs });
  const warnings = [...doc.warnings];
  for (const L of doc.layers) for (const w of L.warnings) warnings.push(`${L.file}: ${w}`);
  warnings.push(...b2.warnings);
  b2.sheet.warnings = warnings.slice(0, 200);
  onProgress?.('measure', 0.8);
  const info = measure(doc, outline, opts.noSpacing === true);
  info.format = doc.source;
  info.layers = doc.layers.length;
  info.layerList = doc.layers.map((l) => l.name).join(', ');
  if (!outline) warnings.push('No closed board outline found: no board shape and no 3D view');
  let geometry: RvtGeometry | undefined;
  if (opts.threeD !== false && outline) {
    onProgress?.('3d', 0.88);
    try { geometry = build3D(doc, outline); } catch (e) { warnings.push(`3D view failed: ${(e as Error).message}`); }
  }
  info.ms = Date.now() - t0;
  onProgress?.('done', 1);
  const res: PcbResult = { kind: '2d', sheets: [b2.sheet], layers: b2.layers, info, warnings };
  if (geometry) res.geometry = geometry;
  return res;
}

export type { InFile };
