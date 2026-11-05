// FBX reader (binary 7.x incl. 7500+ 64-bit offsets, ASCII 7.x, best effort for ASCII/binary 6.x).
// Clean-room: no official specification of the file layout exists. The layout was worked out by analysing the
// sample files byte by byte (see NOTEBOOK.md). The meaning of object properties (Lcl Translation, PreRotation,
// RotationOrder, UnitScaleFactor, UpAxis ...) follows Autodesk's public FBX SDK API reference documentation
// (class FbxNode / FbxAxisSystem / FbxSystemUnit pages). No third-party code was used.

import {
  GeomBuilder, MeshError, invert, mul, rotX, rotY, rotZ, scaling, translation, latin1,
  DEFAULT_GREY, type Mat4, type MeshResult, type Progress,
} from './common.ts';

// ------------------------------------------------------------------ generic node tree
interface ArrRef { arr: true; type: string; count: number; enc: number; data: Uint8Array }
type PV = number | bigint | string | boolean | ArrRef | number[] | Uint8Array;
interface FNode { name: string; props: PV[]; kids: FNode[] }

const BIN_MAGIC = 'Kaydara FBX Binary  ';

export function sniffFbx(bytes: Uint8Array): boolean {
  if (bytes.length >= 27 && latin1(bytes, 0, 20) === BIN_MAGIC) return true;
  const head = latin1(bytes, 0, Math.min(bytes.length, 4096));
  if (/^\s*;\s*FBX\s+\d/.test(head)) return true;
  return /FBXHeaderExtension\s*:\s*\{/.test(head) && /FBXVersion\s*:\s*\d+/.test(head);
}

function isArr(v: PV | undefined): v is ArrRef { return typeof v === 'object' && v !== null && (v as ArrRef).arr === true; }

// ------------------------------------------------------------------ binary parser
function parseBinary(b: Uint8Array, warn: (m: string) => void): { root: FNode; version: number } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const version = dv.getUint32(23, true);
  const big = version >= 7500;
  const hdr = big ? 25 : 13;
  const rd = (o: number) => (big ? Number(dv.getBigUint64(o, true)) : dv.getUint32(o, true));
  const td = new TextDecoder('utf-8');
  let depthGuard = 0;
  const node = (o: number, lim: number): { n: FNode | null; end: number } => {
    if (o + hdr > lim) throw new MeshError('corrupt', 'Node header runs past the end of the file');
    const end = rd(o), np = rd(o + (big ? 8 : 4)), pl = rd(o + (big ? 16 : 8));
    const nl = b[o + hdr - 1];
    if (end === 0) return { n: null, end: o + hdr };
    if (end > lim || end < o + hdr) throw new MeshError('corrupt', `Node at ${o} ends outside its parent`);
    const name = latin1(b, o + hdr, o + hdr + nl);
    let p = o + hdr + nl;
    const pend = p + pl;
    const props: PV[] = [];
    for (let i = 0; i < np && p < pend; i++) {
      const t = String.fromCharCode(b[p++]);
      switch (t) {
        case 'Y': props.push(dv.getInt16(p, true)); p += 2; break;
        case 'C': props.push(b[p] !== 0); p += 1; break;
        case 'I': props.push(dv.getInt32(p, true)); p += 4; break;
        case 'F': props.push(dv.getFloat32(p, true)); p += 4; break;
        case 'D': props.push(dv.getFloat64(p, true)); p += 8; break;
        case 'L': { const v = dv.getBigInt64(p, true); props.push(v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : v); p += 8; break; }
        case 'f': case 'd': case 'l': case 'i': case 'b': {
          const count = dv.getUint32(p, true), enc = dv.getUint32(p + 4, true), cl = dv.getUint32(p + 8, true);
          p += 12;
          if (p + cl > pend) throw new MeshError('corrupt', `Array property of ${name} runs past its node`);
          props.push({ arr: true, type: t, count, enc, data: b.subarray(p, p + cl) });
          p += cl; break;
        }
        case 'S': { const n = dv.getUint32(p, true); p += 4; props.push(td.decode(b.subarray(p, p + n))); p += n; break; }
        case 'R': { const n = dv.getUint32(p, true); p += 4; props.push(b.subarray(p, p + n)); p += n; break; }
        default: warn(`Unknown property type "${t}" in node ${name}`); p = pend; i = np;
      }
    }
    const kids: FNode[] = [];
    let q = pend;
    if (++depthGuard > 100000000) throw new MeshError('corrupt', 'Node tree too large');
    while (q < end) {
      const r = node(q, end);
      if (!r.n) { q = r.end; break; }
      kids.push(r.n); q = r.end;
    }
    return { n: { name, props, kids }, end };
  };
  const root: FNode = { name: '', props: [], kids: [] };
  let o = 27;
  while (o + hdr <= b.length) {
    let r;
    try { r = node(o, b.length); } catch (e) { if (root.kids.length) { warn(`File structure damaged after ${root.kids.length} top level sections: ${(e as Error).message}`); break; } throw e; }
    if (!r.n) break;
    root.kids.push(r.n); o = r.end;
  }
  return { root, version };
}

// ------------------------------------------------------------------ ASCII parser
function parseAscii(text: string): FNode {
  let i = 0;
  const n = text.length;
  const root: FNode = { name: '', props: [], kids: [] };
  const stack: FNode[] = [root];
  const skipWs = () => {
    for (;;) {
      while (i < n) { const c = text.charCodeAt(i); if (c === 32 || c === 9 || c === 10 || c === 13) i++; else break; }
      if (i < n && text.charCodeAt(i) === 59 /* ; comment */) { const e = text.indexOf('\n', i); i = e < 0 ? n : e + 1; continue; }
      break;
    }
  };
  // read one bare token (identifier, number, *N)
  const bare = (): string => {
    const s = i;
    while (i < n) { const c = text.charCodeAt(i); if (c === 44 || c === 123 || c === 125 || c === 58 || c === 32 || c === 9 || c === 10 || c === 13 || c === 34 || c === 59) break; i++; }
    return text.slice(s, i);
  };
  let cur: FNode | null = null; // node collecting values
  while (i < n) {
    skipWs();
    if (i >= n) break;
    const c = text.charCodeAt(i);
    if (c === 125 /* } */) { i++; if (stack.length > 1) stack.pop(); cur = null; continue; }
    if (c === 123 /* { */) { i++; if (cur) stack.push(cur); cur = null; continue; }
    if (c === 44 /* , */) { i++; continue; }
    if (c === 34 /* " */) {
      const e = text.indexOf('"', i + 1);
      const s = text.slice(i + 1, e < 0 ? n : e);
      i = e < 0 ? n : e + 1;
      if (cur) cur.props.push(s);
      continue;
    }
    const tok = bare();
    if (!tok) { i++; continue; }
    skipWsInline();
    if (i < n && text.charCodeAt(i) === 58 /* : */) {
      i++;
      const nd: FNode = { name: tok, props: [], kids: [] };
      stack[stack.length - 1].kids.push(nd);
      cur = nd;
      if (tok === 'a' || /^(Vertices|PolygonVertexIndex|Normals|NormalsIndex|Materials|UV|UVIndex|Edges|Smoothing|KeyTime|KeyValueFloat|Colors|ColorIndex|Indexes|Weights|Transform|TransformLink|Matrix)$/.test(tok)) {
        // fast path for long numeric lists
        const arr: number[] = [];
        for (;;) {
          skipWs();
          if (i >= n) break;
          const ch = text.charCodeAt(i);
          if (ch === 44) { i++; continue; }
          if ((ch >= 48 && ch <= 57) || ch === 45 || ch === 43 || ch === 46) {
            const s = i; while (i < n) { const d = text.charCodeAt(i); if ((d >= 48 && d <= 57) || d === 45 || d === 43 || d === 46 || d === 101 || d === 69) i++; else break; }
            arr.push(+text.slice(s, i));
            continue;
          }
          break;
        }
        if (arr.length || tok === 'a') { nd.props.push(arr); }
      }
      continue;
    }
    if (!cur) continue;
    if (tok[0] === '*') { cur.props.push('*' + tok.slice(1)); continue; }
    const num = Number(tok);
    if (tok !== '' && !isNaN(num)) {
      if (/^-?\d{16,}$/.test(tok)) cur.props.push(BigInt(tok)); else cur.props.push(num);
    } else cur.props.push(tok);
  }
  return root;

  function skipWsInline() { while (i < n) { const c = text.charCodeAt(i); if (c === 32 || c === 9) i++; else break; } }
}

// ------------------------------------------------------------------ helpers
const kid = (nd: FNode | undefined, name: string) => nd?.kids.find((k) => k.name === name);
const kids = (nd: FNode | undefined, name: string) => nd?.kids.filter((k) => k.name === name) ?? [];
const idOf = (v: PV | undefined): string => (typeof v === 'bigint' ? v.toString() : String(v));
function str(nd: FNode | undefined, name: string): string | null { const k = kid(nd, name); const v = k?.props[0]; return typeof v === 'string' ? v : null; }

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
/** decode an array property (binary ArrRef or ASCII number list) into numbers */
async function numArr(nd: FNode | undefined): Promise<Float64Array | Int32Array | null> {
  if (!nd) return null;
  let v = nd.props.find((p) => isArr(p) || Array.isArray(p));
  if (v === undefined) { const a = kid(nd, 'a'); v = a?.props.find((p) => Array.isArray(p)); }
  if (v === undefined) {
    // FBX 6 ASCII style plain lists end up as several numeric props
    const nums = nd.props.filter((p) => typeof p === 'number') as number[];
    return nums.length ? Float64Array.from(nums) : null;
  }
  if (Array.isArray(v)) return Float64Array.from(v as number[]);
  const r = v as ArrRef;
  let raw = r.data;
  if (r.enc === 1) raw = await inflate(r.data);
  else if (r.enc !== 0) throw new MeshError('corrupt', `Unknown array encoding ${r.enc}`);
  const size = { f: 4, d: 8, l: 8, i: 4, b: 1 }[r.type] ?? 1;
  const cnt = Math.min(r.count, Math.floor(raw.length / size));
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (r.type === 'i' || r.type === 'b') {
    const out = new Int32Array(cnt);
    if (r.type === 'i') for (let k = 0; k < cnt; k++) out[k] = dv.getInt32(k * 4, true);
    else for (let k = 0; k < cnt; k++) out[k] = raw[k];
    return out;
  }
  const out = new Float64Array(cnt);
  if (r.type === 'd') for (let k = 0; k < cnt; k++) out[k] = dv.getFloat64(k * 8, true);
  else if (r.type === 'f') for (let k = 0; k < cnt; k++) out[k] = dv.getFloat32(k * 4, true);
  else for (let k = 0; k < cnt; k++) out[k] = Number(dv.getBigInt64(k * 8, true));
  return out;
}

/** properties: Properties70 (P: name, type, label, flags, values...) and Properties60 (Property: name, type, flags, values...) */
type Props = Map<string, PV[]>;
function readProps(nd: FNode | undefined, base?: Props): Props {
  const m: Props = new Map(base ?? []);
  if (!nd) return m;
  const p70 = kid(nd, 'Properties70');
  if (p70) for (const p of p70.kids) if (p.name === 'P' && typeof p.props[0] === 'string') m.set(p.props[0], p.props.slice(4));
  const p60 = kid(nd, 'Properties60');
  if (p60) for (const p of p60.kids) if (p.name === 'Property' && typeof p.props[0] === 'string') m.set(p.props[0], p.props.slice(3));
  return m;
}
const vec3 = (m: Props, k: string, d: [number, number, number]): [number, number, number] => {
  const v = m.get(k);
  if (!v || v.length < 3) return d;
  const a = v.slice(0, 3).map(Number);
  return a.every(isFinite) ? (a as [number, number, number]) : d;
};
const num = (m: Props, k: string, d: number): number => { const v = m.get(k); const x = v ? Number(v[0]) : NaN; return isFinite(x) ? x : d; };

function eulerMatrix(r: [number, number, number], order: number): Mat4 {
  const X = rotX(r[0]), Y = rotY(r[1]), Z = rotZ(r[2]);
  // order eEulerXYZ means X applied first: M = Z * Y * X (column vectors)
  switch (order) {
    case 1: return mul(Y, mul(Z, X));   // XZY
    case 2: return mul(X, mul(Z, Y));   // YZX
    case 3: return mul(Z, mul(X, Y));   // YXZ
    case 4: return mul(Y, mul(X, Z));   // ZXY
    case 5: return mul(X, mul(Y, Z));   // ZYX
    default: return mul(Z, mul(Y, X));  // XYZ (also spheric)
  }
}

/** local transform following the FbxNode transform chain:
 *  T * Roff * Rp * Rpre * R * Rpost^-1 * Rp^-1 * Soff * Sp * S * Sp^-1 */
function localMatrix(p: Props): Mat4 {
  const T = vec3(p, 'Lcl Translation', [0, 0, 0]), R = vec3(p, 'Lcl Rotation', [0, 0, 0]), S = vec3(p, 'Lcl Scaling', [1, 1, 1]);
  const Roff = vec3(p, 'RotationOffset', [0, 0, 0]), Rp = vec3(p, 'RotationPivot', [0, 0, 0]);
  const Soff = vec3(p, 'ScalingOffset', [0, 0, 0]), Sp = vec3(p, 'ScalingPivot', [0, 0, 0]);
  const pre = vec3(p, 'PreRotation', [0, 0, 0]), post = vec3(p, 'PostRotation', [0, 0, 0]);
  const order = num(p, 'RotationOrder', 0);
  let m = translation(T[0], T[1], T[2]);
  m = mul(m, translation(Roff[0], Roff[1], Roff[2]));
  m = mul(m, translation(Rp[0], Rp[1], Rp[2]));
  if (pre.some((v) => v)) m = mul(m, eulerMatrix(pre, 0));
  m = mul(m, eulerMatrix(R, order));
  if (post.some((v) => v)) m = mul(m, invert(eulerMatrix(post, 0)));
  m = mul(m, translation(-Rp[0], -Rp[1], -Rp[2]));
  m = mul(m, translation(Soff[0], Soff[1], Soff[2]));
  m = mul(m, translation(Sp[0], Sp[1], Sp[2]));
  m = mul(m, scaling(S[0], S[1], S[2]));
  m = mul(m, translation(-Sp[0], -Sp[1], -Sp[2]));
  return m;
}
function geometricMatrix(p: Props): Mat4 | null {
  const T = vec3(p, 'GeometricTranslation', [0, 0, 0]), R = vec3(p, 'GeometricRotation', [0, 0, 0]), S = vec3(p, 'GeometricScaling', [1, 1, 1]);
  if (!T.some((v) => v) && !R.some((v) => v) && S.every((v) => v === 1)) return null;
  return mul(translation(T[0], T[1], T[2]), mul(eulerMatrix(R, 0), scaling(S[0], S[1], S[2])));
}

const splitName = (s: string, binary: boolean): string => {
  if (binary) { const k = s.indexOf('\u0000\u0001'); return k >= 0 ? s.slice(0, k) : s; }
  const k = s.indexOf('::'); return k >= 0 ? s.slice(k + 2) : s;
};

// ------------------------------------------------------------------ reader
export async function readFbx(bytes: Uint8Array, onProgress?: Progress): Promise<MeshResult> {
  const t0 = Date.now();
  if (!sniffFbx(bytes)) throw new MeshError('not-format', 'Not an FBX file');
  const gb = new GeomBuilder();
  const binary = latin1(bytes, 0, 20) === BIN_MAGIC;
  let root: FNode, version: number;
  if (binary) {
    ({ root, version } = parseBinary(bytes, (m) => gb.warn(m)));
  } else {
    const text = new TextDecoder('utf-8').decode(bytes);
    root = parseAscii(text);
    const hv = kid(kid(root, 'FBXHeaderExtension'), 'FBXVersion')?.props[0];
    version = typeof hv === 'number' ? hv : Number(/FBX\s+(\d)\.(\d)/.exec(text.slice(0, 200))?.slice(1).join('') ?? 0) * 100;
  }
  onProgress?.('parsed', 0.3);
  const hdr = kid(root, 'FBXHeaderExtension');
  const enc = kid(hdr, 'EncryptionType')?.props[0];
  if (typeof enc === 'number' && enc !== 0) throw new MeshError('encrypted', 'FBX file is encrypted');
  if (version < 6000 && version !== 0) throw new MeshError('unsupported-version', `FBX version ${version} is not supported`);
  const legacy = version < 7000;
  if (legacy) gb.warn(`FBX ${(version / 1000).toFixed(1)} (pre 2011 layout): read on a best effort basis`);
  if (version > 7700) gb.warn(`FBX version ${version} is newer than the samples we tested (7300 to 7700)`);

  // ---- global settings
  const gs = readProps(kid(root, 'GlobalSettings'));
  const upAxis = num(gs, 'UpAxis', 1), upSign = num(gs, 'UpAxisSign', 1);
  const coordAxis = num(gs, 'CoordAxis', 0), coordSign = num(gs, 'CoordAxisSign', 1);
  const unit = num(gs, 'UnitScaleFactor', 1); // centimetres per file unit
  const ex = [0, 0, 0], ez = [0, 0, 0];
  ex[coordAxis] = coordSign < 0 ? -1 : 1; ez[upAxis] = upSign < 0 ? -1 : 1;
  if (coordAxis === upAxis) { ex[0] = 1; ex[1] = 0; ex[2] = 0; ez[0] = 0; ez[1] = 1; ez[2] = 0; gb.warn('Invalid axis system in GlobalSettings: Y-up assumed'); }
  const ey = [ez[1] * ex[2] - ez[2] * ex[1], ez[2] * ex[0] - ez[0] * ex[2], ez[0] * ex[1] - ez[1] * ex[0]];
  const axis = new Float64Array(16);
  for (let c = 0; c < 3; c++) { axis[c * 4] = ex[c]; axis[c * 4 + 1] = ey[c]; axis[c * 4 + 2] = ez[c]; }
  axis[15] = 1;
  const rootM = mul(scaling(unit / 100, unit / 100, unit / 100), axis);

  // ---- property templates
  const templates = new Map<string, Props>();
  for (const ot of kids(kid(root, 'Definitions'), 'ObjectType')) {
    const pt = kid(ot, 'PropertyTemplate');
    if (pt && typeof ot.props[0] === 'string') templates.set(ot.props[0], readProps(pt));
  }

  // ---- objects
  interface Obj { id: string; cls: string; name: string; sub: string; node: FNode }
  const objs = new Map<string, Obj>();
  const objectsNode = kid(root, 'Objects');
  if (!objectsNode) throw new MeshError('corrupt', 'FBX file has no Objects section');
  for (const nd of objectsNode.kids) {
    let id: string, rawName: string, sub: string;
    if (legacy) { rawName = String(nd.props[0] ?? ''); id = rawName; sub = String(nd.props[1] ?? ''); }
    else { id = idOf(nd.props[0]); rawName = String(nd.props[1] ?? ''); sub = String(nd.props[2] ?? ''); }
    objs.set(id, { id, cls: nd.name, name: splitName(rawName, binary && !legacy), sub, node: nd });
  }
  // ---- connections: child -> parent(s), parent -> children (in file order)
  const parentsOf = new Map<string, string[]>();
  const childrenOf = new Map<string, Array<{ id: string; prop: string | null }>>();
  for (const c of kid(root, 'Connections')?.kids ?? []) {
    if (c.name !== 'C' && c.name !== 'Connect') continue;
    const type = String(c.props[0]);
    const child = idOf(c.props[1]), parent = idOf(c.props[2]);
    const prop = type === 'OP' && typeof c.props[3] === 'string' ? (c.props[3] as string) : null;
    (childrenOf.get(parent) ?? childrenOf.set(parent, []).get(parent)!).push({ id: child, prop });
    if (type === 'OO') (parentsOf.get(child) ?? parentsOf.set(child, []).get(child)!).push(parent);
  }

  // ---- materials
  const matInfo = (o: Obj) => {
    const p = readProps(o.node, templates.get('Material'));
    let col = vec3(p, 'DiffuseColor', vec3(p, 'Diffuse', [0.8, 0.8, 0.8]));
    if (!p.has('DiffuseColor') && !p.has('Diffuse')) col = DEFAULT_GREY;
    let opacity = num(p, 'Opacity', 1);
    const tf = num(p, 'TransparencyFactor', 0);
    if (!p.has('Opacity') && tf > 0 && tf < 1) opacity = 1 - tf;
    let textureName: string | undefined;
    for (const ch of childrenOf.get(o.id) ?? []) {
      const t = objs.get(ch.id);
      if (t?.cls === 'Texture' && (ch.prop === null || /diffuse|base/i.test(ch.prop))) {
        textureName = str(t.node, 'RelativeFilename') ?? str(t.node, 'FileName') ?? t.name; break;
      }
    }
    return { name: o.name || 'material', color: col.map((v) => Math.min(1, Math.max(0, v))) as [number, number, number], opacity: opacity < 1 ? Math.max(0.05, opacity) : undefined, textureName, schema: `FBX ${str(o.node, 'ShadingModel') ?? 'material'}` };
  };
  const bucketCache = new Map<string, number>();
  const bucketFor = (mid: string | null): number => {
    const key = mid ?? '';
    const c = bucketCache.get(key); if (c !== undefined) return c;
    const o = mid ? objs.get(mid) : undefined;
    const b = o ? gb.bucket('m' + mid, matInfo(o)) : gb.bucket('', { name: 'default', color: DEFAULT_GREY, schema: 'FBX default' });
    bucketCache.set(key, b);
    return b;
  };

  // ---- model world transforms
  const modelTemplate = templates.get('Model');
  const worldCache = new Map<string, Mat4>();
  const modelProps = new Map<string, Props>();
  const propsOf = (id: string): Props => {
    let p = modelProps.get(id);
    if (!p) { p = readProps(objs.get(id)!.node, modelTemplate); modelProps.set(id, p); }
    return p;
  };
  const parentModel = (id: string): string | null => {
    for (const p of parentsOf.get(id) ?? []) if (objs.get(p)?.cls === 'Model') return p;
    return null;
  };
  const world = (id: string, guard = 0): Mat4 => {
    const c = worldCache.get(id); if (c) return c;
    const par = guard < 200 ? parentModel(id) : null;
    const m = mul(par ? world(par, guard + 1) : rootM, localMatrix(propsOf(id)));
    worldCache.set(id, m);
    return m;
  };
  const pathOf = (id: string): string[] => {
    const out: string[] = []; let cur: string | null = id; let g = 0;
    while (cur && g++ < 200) { out.unshift(objs.get(cur)?.name || '?'); cur = parentModel(cur); }
    return out;
  };

  // ---- geometries
  const models = [...objs.values()].filter((o) => o.cls === 'Model');
  let meshModels = 0, hidden = 0, nonMesh = 0, polys = 0, ngons = 0;
  const geoStats = { shapes: 0, lines: 0, nurbs: 0 };
  let done = 0;
  for (const mo of models) {
    done++;
    if (onProgress && done % 8 === 0) onProgress('models', 0.3 + 0.65 * (done / models.length));
    // geometry: connected Geometry object (7.x) or the model node itself (6.x)
    let geoNode: FNode | null = null, geoName: string | null = null;
    const ch = childrenOf.get(mo.id) ?? [];
    for (const c of ch) {
      const o = objs.get(c.id);
      if (o?.cls === 'Geometry') {
        if (o.sub === 'Mesh' || kid(o.node, 'Vertices')) { geoNode = o.node; geoName = o.name; break; }
        if (o.sub === 'Shape') geoStats.shapes++; else if (o.sub === 'Line') geoStats.lines++; else if (/Nurbs/i.test(o.sub)) geoStats.nurbs++;
      }
    }
    if (!geoNode && legacy && kid(mo.node, 'Vertices')) geoNode = mo.node;
    if (!geoNode) { if (mo.sub && mo.sub !== 'Null' && mo.sub !== 'Root' && mo.sub !== 'LimbNode' && mo.sub !== 'Mesh') nonMesh++; continue; }
    const mp = propsOf(mo.id);
    if (mp.has('Visibility') && num(mp, 'Visibility', 1) === 0) { hidden++; continue; }
    const mats: string[] = ch.filter((c) => objs.get(c.id)?.cls === 'Material').map((c) => c.id);
    const W = world(mo.id);
    const G = geometricMatrix(mp);
    const M = G ? mul(W, G) : W;
    const path = pathOf(mo.id);
    const el = gb.element({ name: mo.name || 'mesh', className: 'FbxModel', categoryName: path.length > 1 ? path[0] : 'FBX', typeName: geoName || null, familyName: path.join(' / ') });
    meshModels++;
    try {
      const st = await addGeometry(geoNode, M, el, mats);
      polys += st.polys; ngons += st.ngons;
    } catch (e) {
      if (e instanceof MeshError && e.code === 'corrupt') gb.warn(`Mesh "${mo.name}" skipped: ${e.message}`);
      else if (e instanceof TypeError || e instanceof RangeError) gb.warn(`Mesh "${mo.name}" skipped: ${e.message}`);
      else throw e;
    }
  }

  async function addGeometry(g: FNode, M: Mat4, el: number, mats: string[]) {
    const V = await numArr(kid(g, 'Vertices'));
    const PVI = await numArr(kid(g, 'PolygonVertexIndex'));
    if (!V || !PVI) return { polys: 0, ngons: 0 };
    const nv = Math.floor(V.length / 3);
    // normals layer 0
    const ln = kid(g, 'LayerElementNormal');
    let N: Float64Array | Int32Array | null = null, NI: Float64Array | Int32Array | null = null, nMap = '', nRef = '';
    if (ln) {
      N = await numArr(kid(ln, 'Normals'));
      nMap = str(ln, 'MappingInformationType') ?? ''; nRef = str(ln, 'ReferenceInformationType') ?? '';
      if (nRef === 'IndexToDirect' || nRef === 'Index') NI = await numArr(kid(ln, 'NormalsIndex'));
    }
    // material layer 0
    const lm = kid(g, 'LayerElementMaterial');
    let MI: Float64Array | Int32Array | null = null, mMap = 'AllSame';
    if (lm) { MI = await numArr(kid(lm, 'Materials')); mMap = str(lm, 'MappingInformationType') ?? 'AllSame'; }
    // per material accumulators
    const acc = new Map<number, { pos: number[]; nrm: number[] | null; idx: number[] }>();
    const accFor = (mi: number) => {
      let a = acc.get(mi);
      if (!a) acc.set(mi, (a = { pos: [], nrm: N ? [] : null, idx: [] }));
      return a;
    };
    let polyStart = 0, poly = 0, ngon = 0, badPoly = 0;
    const getN = (pv: number, vi: number, pi: number, out: number[]): boolean => {
      if (!N) return false;
      let k: number;
      if (nMap === 'ByPolygonVertex') k = pv;
      else if (nMap === 'ByVertice' || nMap === 'ByVertex') k = vi;
      else if (nMap === 'ByPolygon') k = pi;
      else if (nMap === 'AllSame') k = 0;
      else k = pv;
      if (NI) { if (k >= NI.length) return false; k = NI[k]; }
      if (k < 0 || k * 3 + 2 >= N.length) return false;
      out[0] = N[k * 3]; out[1] = N[k * 3 + 1]; out[2] = N[k * 3 + 2];
      return true;
    };
    const nb = [0, 0, 0];
    let normalsOk = !!N;
    for (let k = 0; k < PVI.length; k++) {
      const raw = PVI[k];
      if (raw >= 0 && k !== PVI.length - 1) continue;
      // polygon from polyStart..k (last index is stored as -(i+1))
      const cnt = k - polyStart + 1;
      const mi = !MI || MI.length === 0 ? 0 : mMap === 'AllSame' ? MI[0] : (MI[poly] ?? 0);
      if (cnt >= 3) {
        const a = accFor(mi);
        const base = a.pos.length / 3;
        let ok = true;
        for (let j = 0; j < cnt; j++) {
          let vi = PVI[polyStart + j]; if (vi < 0) vi = -vi - 1;
          if (vi >= nv) { ok = false; break; }
        }
        if (ok) {
          for (let j = 0; j < cnt; j++) {
            const pv = polyStart + j;
            let vi = PVI[pv]; if (vi < 0) vi = -vi - 1;
            a.pos.push(V[vi * 3], V[vi * 3 + 1], V[vi * 3 + 2]);
            if (a.nrm) { if (getN(pv, vi, poly, nb)) a.nrm.push(nb[0], nb[1], nb[2]); else { normalsOk = false; a.nrm.push(0, 0, 1); } }
          }
          for (let j = 1; j + 1 < cnt; j++) a.idx.push(base, base + j, base + j + 1);
          if (cnt > 4) ngon++;
        } else badPoly++;
      } else badPoly++;
      poly++;
      polyStart = k + 1;
    }
    if (badPoly) gb.warn(`${badPoly} degenerate or invalid polygons skipped`, 'fbx-badpoly');
    for (const [mi, a] of acc) {
      const mid = mats[mi] ?? (mats.length ? mats[0] : null);
      gb.addMesh(el, bucketFor(mid ?? null), a.pos, normalsOk ? a.nrm : null, a.idx, M);
    }
    return { polys: poly, ngons: ngon };
  }

  if (geoStats.shapes) gb.warn(`${geoStats.shapes} blend shapes ignored (base shape shown)`);
  if (geoStats.lines) gb.warn(`${geoStats.lines} line geometries not shown`);
  if (geoStats.nurbs) gb.warn(`${geoStats.nurbs} NURBS geometries not supported`);
  if (hidden) gb.warn(`${hidden} hidden models (Visibility 0) not shown`);
  if (objs.size && !meshModels) gb.warn('No mesh models found in this FBX file');
  const deformers = [...objs.values()].filter((o) => o.cls === 'Deformer').length;
  if (deformers) gb.warn('Skinned meshes are shown in their bind pose; animation is ignored');

  const geometry = gb.finish({});
  geometry.stats.ms = Date.now() - t0;
  const creator = str(hdr, 'Creator') ?? str(root, 'Creator') ?? '';
  const appName = (() => { const si = kid(hdr, 'SceneInfo'); const p = readProps(si); const v = p.get('LastSaved|ApplicationName') ?? p.get('Original|ApplicationName'); return v && typeof v[0] === 'string' ? v[0] : ''; })();
  const axisName = ['X', 'Y', 'Z'][upAxis] ?? '?';
  const info: Record<string, string | number> = {
    format: binary ? 'FBX binary' : 'FBX ASCII', version, creator, application: appName,
    unitScaleFactor: unit, units: unit === 100 ? 'm' : unit === 1 ? 'cm' : unit === 0.1 ? 'mm' : unit === 2.54 ? 'in' : `${unit} cm`,
    upAxis: `${upSign < 0 ? '-' : '+'}${axisName} (converted to Z-up)`,
    models: models.length, meshModels, polygons: polys, ngons, materials: [...objs.values()].filter((o) => o.cls === 'Material').length,
    triangles: geometry.stats.triangles,
  };
  if (nonMesh) info.otherNodes = nonMesh;
  return { kind: '3d', geometry, info };
}
