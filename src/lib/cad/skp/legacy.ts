// SketchUp files up to 2020: one object stream after the header.
// The stream uses the MFC CArchive object tagging scheme (public Microsoft documentation, TN002 "Persistent Object
// Data Format"): 0xFFFF + schema + class name for a new class, 0x8000 | class index for a new object of a known class,
// a plain index for a reference to an earlier object, 0x7FFF + u32 for big indices. Every new class and every new
// object takes the next index. Strings are CString style: ff fe ff + length + UTF-16LE.
// The per-class field layouts below were learned from sample files only (see NOTEBOOK.md, "Legacy object stream").
//
// We do not decode the model header objects (thumbnail, options, camera, rendering options, styles ...). Parsing
// starts at the first new-class tag of CMaterial or CLayer; the absolute index base is calibrated from the first
// class reference whose class is known from context.

import { SkpError, LOOP_STATS } from './geom.ts';
import { emptyEntities, type SkpEntities, type SkpFace, type SkpModel } from './model.ts';

interface Cls { name: string; schema: number; rel: number }
interface Ref { ref: number }  // unresolved absolute index
type Obj = { cls: string; rel: number; [k: string]: unknown };

// debug tracing for development: set globalThis.__SKP_TRACE = true before importing
const TRACE = (globalThis as unknown as { __SKP_TRACE?: boolean }).__SKP_TRACE === true;

/** thrown when a trial parse has read far enough without an error */
const TRIAL_OK = new Error('trial ok');

class Arc {
  b: Uint8Array; dv: DataView; p: number;
  rel = 0;
  base = -1;
  objs: Array<Obj | Cls | null> = [];
  classByRel = new Map<number, Cls>();
  classByName = new Map<string, Cls>();
  preClasses = new Map<number, Cls>([[1, { name: 'CVersionMap', schema: 0, rel: -1 }]]);
  trace: string[] = [];
  entityV = 3;
  versions = new Map<string, number>();
  vmap(name: string, schema: number): number { return this.versions.get(name) ?? schema; }
  constructor(b: Uint8Array, p: number) { this.b = b; this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength); this.p = p; }

  trialEnd = Infinity;
  need(n: number) {
    if (this.p + n > this.b.length) throw new SkpError('corrupt', `unexpected end of file at ${this.p}`);
    if (this.p > this.trialEnd) throw TRIAL_OK;
  }
  u8() { this.need(1); return this.b[this.p++]; }
  u16() { this.need(2); const v = this.b[this.p] | (this.b[this.p + 1] << 8); this.p += 2; return v; }
  u32() { this.need(4); const v = this.dv.getUint32(this.p, true); this.p += 4; return v; }
  i32() { this.need(4); const v = this.dv.getInt32(this.p, true); this.p += 4; return v; }
  f64() { this.need(8); const v = this.dv.getFloat64(this.p, true); this.p += 8; return v; }
  skip(n: number) { this.need(n); this.p += n; }
  str(): string {
    const b = this.b, p = this.p;
    if (b[p] !== 0xff || b[p + 1] !== 0xfe || b[p + 2] !== 0xff) throw new SkpError('corrupt', `string expected at ${p} (${hex(b, p, 8)})`);
    let n = b[p + 3], q = p + 4;
    if (n === 0xff) { n = b[q] | (b[q + 1] << 8); q += 2; if (n === 0xffff) { n = this.dv.getUint32(q, true); q += 4; } }
    if (q + n * 2 > b.length) throw new SkpError('corrupt', `string overruns the file at ${p}`);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(b[q + i * 2] | (b[q + i * 2 + 1] << 8));
    this.p = q + n * 2;
    return s;
  }
  isStr(): boolean { const b = this.b, p = this.p; return b[p] === 0xff && b[p + 1] === 0xfe && b[p + 2] === 0xff; }

  snapshot() {
    return { p: this.p, rel: this.rel, base: this.base, n: this.objs.length, cr: new Map(this.classByRel), cn: new Map(this.classByName), pc: new Map(this.preClasses), t: this.trace.length };
  }
  restore(s: ReturnType<Arc['snapshot']>) {
    this.p = s.p; this.rel = s.rel; this.base = s.base; this.objs.length = s.n;
    this.classByRel = s.cr; this.classByName = s.cn; this.preClasses = s.pc; this.trace.length = s.t;
  }
  get(abs: number): Obj | Cls | Ref | null {
    if (!abs) return null;
    if (this.base < 0) return { ref: abs };
    const r = abs - this.base;
    if (r < 0 || r >= this.objs.length) return { ref: abs };
    return this.objs[r];
  }
  resolve<T>(v: unknown): T | null {
    if (v && typeof v === 'object' && 'ref' in (v as Ref)) {
      const g = this.get((v as Ref).ref);
      return g && !('ref' in g) ? (g as unknown as T) : null;
    }
    return (v as T) ?? null;
  }

  /** read one object tag; expect = class names allowed here (used to calibrate the index base) */
  obj(expect: string[] | null, reader: (a: Arc, o: Obj, schema: number) => void, learnAs?: string): Obj | Ref | null {
    const h = this.head(expect, learnAs);
    if (!h.isNew) return h.v;
    reader(this, h.o, h.schema);
    return h.o;
  }

  /** read an object tag; a new object is registered (so it can be referenced) but its fields are not read yet */
  head(expect: string[] | null, learnAs?: string): { isNew: true; o: Obj; schema: number } | { isNew: false; v: Obj | Ref | null } {
    const at = this.p;
    const w = this.u16();
    let tag: number;
    let cls: Cls | undefined;
    if (w === 0xffff) {
      const schema = this.u16(), n = this.u16();
      this.need(n);
      let name = '';
      for (let i = 0; i < n; i++) name += String.fromCharCode(this.b[this.p + i]);
      this.p += n;
      cls = { name, schema, rel: this.rel++ };
      this.objs[cls.rel] = cls;
      this.classByRel.set(cls.rel, cls);
      this.classByName.set(name, cls);
      if (expect && !expect.includes(name)) throw new SkpError('corrupt', `unexpected class ${name} at ${at} (wanted ${expect.join('/')})`);
    } else {
      if (w === 0x7fff) tag = this.u32(); else tag = w & 0x8000 ? (0x80000000 | (w & 0x7fff)) >>> 0 : w;
      if (tag & 0x80000000) {
        const abs = tag & 0x7fffffff;
        const pre = this.preClasses.get(abs);
        if (pre) { cls = pre; }
        else if ((this.base < 0 || abs < this.base) && expect) {
          const nm = learnAs ?? (expect.length === 1 ? expect[0] : null);
          if (nm && !this.classByName.has(nm)) {
            cls = { name: nm, schema: 0, rel: -abs };
            this.preClasses.set(abs, cls);
            this.classByName.set(nm, cls);
          }
        }
        if (cls) { /* known preamble class */ }
        else if (this.base < 0) {
          // calibrate: the class must be one of the expected classes that we have seen
          const cand = (expect ?? []).map((n) => this.classByName.get(n)).filter(Boolean) as Cls[];
          if (cand.length !== 1) throw new SkpError('corrupt', `cannot calibrate object indices at ${at}`);
          if (abs - cand[0].rel < 4 || abs >= 0x7f00) throw new SkpError('corrupt', `implausible class index ${abs} at ${at}`);
          this.base = abs - cand[0].rel;
        }
        if (!cls) cls = this.classByRel.get(abs - this.base);
        if (!cls) throw new SkpError('corrupt', `unknown class index ${abs} at ${at}`);
        if (expect && !expect.includes(cls.name)) throw new SkpError('corrupt', `unexpected class ${cls.name} at ${at} (wanted ${expect.join('/')})`);
      } else {
        if (tag === 0) return { isNew: false, v: null };
        const g = this.get(tag);
        if (g && 'ref' in g) return { isNew: false, v: g as Ref };
        if (g && 'schema' in g) throw new SkpError('corrupt', `object reference to a class at ${at}`);
        if (g && expect && !expect.includes((g as Obj).cls)) throw new SkpError('corrupt', `reference to ${(g as Obj).cls} at ${at} (wanted ${expect.join('/')})`);
        return { isNew: false, v: g as Obj | null };
      }
    }
    const o: Obj = { cls: cls.name, rel: this.rel++ };
    this.objs[o.rel] = o;
    if (TRACE) this.trace.push(`${at} new ${cls.name} rel=${o.rel}`);
    return { isNew: true, o, schema: cls.schema };
  }
}

function readUnknown(a: Arc, o: Obj) { throw new SkpError('corrupt', `no reader for ${o.cls} at ${a.p}`); }

function hex(b: Uint8Array, p: number, n: number): string { return Array.from(b.subarray(p, p + n), (x) => x.toString(16).padStart(2, '0')).join(' '); }

// ------------------------------------------------------------------ class readers

const ATTR = ['CAttributeContainer'];

/** u8 mask, then one byte for each set bit (bit i = byte i of a little-endian u32; missing bytes are zero) */
function readPackedU32(a: Arc): number {
  const m = a.u8();
  if (m > 15) throw new SkpError('corrupt', `bad packed integer mask ${m} at ${a.p - 1}`);
  let v = 0;
  for (let i = 0; i < 4; i++) if (m & (1 << i)) v += a.u8() * 2 ** (8 * i);
  return v;
}

function readEntityBase(a: Arc, o: Obj) {
  o.attr = a.obj(ATTR, readAttrContainer);
  if (a.entityV >= 5) o.pid = readPackedU32(a);
}

function readAttrContainer(a: Arc, o: Obj) {
  readEntityBase(a, o);
  // dictionaries (and other attached objects such as face texture coordinates) until a null object
  const items: unknown[] = [];
  for (let k = 0; k < 100000; k++) {
    const d = a.obj(['CAttributeNamed', 'CFaceTextureCoords'], (aa, oo) => oo.cls === 'CFaceTextureCoords' ? readFaceTexCoords(aa, oo) : readAttrNamed(aa, oo), 'CAttributeNamed');
    if (!d) break;
    items.push(d);
  }
  o.items = items;
}
function readAttrNamed(a: Arc, o: Obj) {
  readEntityBase(a, o);
  o.x1 = a.u32();
  o.name = a.str();
  const vals: Record<string, unknown> = {};
  for (;;) {
    const k = a.str();
    if (k === '') break;
    vals[k] = readVariant(a);
  }
  o.vals = vals;
  o.x2 = a.u32();
}
function readVariant(a: Arc): unknown {
  const t = a.u8();
  switch (t) {
    case 0: return null;
    case 1: return a.u8();            // byte
    case 2: return a.u16();           // short
    case 3: return a.i32();
    case 4: return a.i32();           // int
    case 5: return a.dv.getFloat32((a.p += 4) - 4, true);
    case 6: return a.f64();           // double
    case 7: return a.u8() !== 0;      // bool
    case 8: { const v: number[] = []; for (let i = 0; i < 3; i++) v.push(a.f64()); return v; } // point / vector
    case 9: { const v: number[] = []; for (let i = 0; i < 3; i++) v.push(a.f64()); return v; }
    case 10: return a.str();          // string
    case 11: { const n = a.u32(); if (n > 1e6) throw new SkpError('corrupt', `attribute array of ${n}`); const arr: unknown[] = []; for (let i = 0; i < n; i++) arr.push(readVariant(a)); return arr; } // array
    default: throw new SkpError('corrupt', `unknown attribute value type ${t} at ${a.p - 1}`);
  }
}

/** CDib: u32 format (4 seen), u32 byte length, image bytes (PNG / JPEG) */
function readDib(a: Arc, o: Obj) {
  o.fmt = a.u32();
  const n = a.u32();
  a.need(n);
  o.bytes = a.b.subarray(a.p, a.p + n);
  a.p += n;
  if (o.fmt === 1) o.quality = a.u32(); // JPEG: quality follows
}

/** CMaterial by value (also embedded in CLayer) */
function readMaterialBody(a: Arc, o: Obj, _schema: number) {
  readEntityBase(a, o);
  o.name = a.str();
  o.type = a.u8();
  if (o.type === 1 || o.type === 2) {
    // texture by value: entity base, image object, size (inches), file name, average colour
    const t: Obj = { cls: 'CTexture(embedded)', rel: -1 };
    readEntityBase(a, t);
    t.dib = a.obj(['CDib'], readDib);
    t.w = a.f64(); t.h = a.f64();
    t.file = a.str();
    t.avg = a.u32();
    o.texture = t;
  } else if (o.type !== 0) throw new SkpError('corrupt', `material type ${o.type} at ${a.p - 1}`);
  o.colorize = a.u8();
  const r = a.u8(), g = a.u8(), bl = a.u8(), al = a.u8();
  o.color = [r / 255, g / 255, bl / 255]; o.alpha8 = al;
  o.s1 = a.str();
  o.x1 = a.u32(); o.x2 = a.u32();
  o.trans = a.f64();
  o.useTrans = a.u8();
  if (TRACE) a.trace.push(`  material ${o.name} type ${o.type} end ${a.p}`);
}

function readLayer(a: Arc, o: Obj, schema: number) {
  readEntityBase(a, o);
  o.name = a.str();
  o.flag = a.u8();
  const m: Obj = { cls: 'CMaterial(embedded)', rel: -1 };
  readMaterialBody(a, m, 12);
  o.material = m;
  o.t1 = a.u32();
  if (a.vmap('CLayer', schema) >= 3) o.lineStyle = a.obj(['CCustomLineStyle'], readUnknown);
  if (TRACE) a.trace.push(`  layer ${o.name} end ${a.p}`);
}

// ------------------------------------------------------------------ geometry classes

const ENTITY_CLASSES = ['CEdge', 'CFace', 'CComponentInstance', 'CGroup', 'CConstructionLine', 'CConstructionPoint', 'CText',
  'CDimensionLinear', 'CDimensionRadial', 'CSectionPlane', 'CImage', 'CCurve', 'CArcCurve', 'CPolyline3d'];

function readDE(a: Arc, o: Obj) {
  readEntityBase(a, o);
  o.mat = a.obj(['CMaterial'], readMaterialBody);
  o.f = [a.u8(), a.u8(), a.u8(), a.u8(), a.u8(), a.u8()];
  o.layer = a.obj(['CLayer'], readLayer);
}

function readVertex(a: Arc, o: Obj) {
  readEntityBase(a, o);
  o.x = a.f64(); o.y = a.f64(); o.z = a.f64();
}

function readEdge(a: Arc, o: Obj) {
  readDE(a, o);
  o.v0 = a.obj(['CVertex'], readVertex);
  o.v1 = a.obj(['CVertex'], readVertex);
  o.curve = a.obj(['CCurve', 'CArcCurve'], readCurve);
  if (TRACE) a.trace.push(`  edge end ${a.p}`);
}

function readCurve(a: Arc, o: Obj) {
  readEntityBase(a, o);
  o.c0 = a.u8();
  o.n = a.u32();
  if (o.cls === 'CArcCurve') {
    const v: number[] = [];
    for (let i = 0; i < 14; i++) v.push(a.f64()); // center, normal, x axis, start angle, end angle, y axis
    o.arc = v;
  }
}

/** UV mapping of a textured face: front and back 3x4 projections (stored as an attribute of the face) */
function readFaceTexCoords(a: Arc, o: Obj) {
  readEntityBase(a, o);
  o.t0 = a.u32();
  const f: number[] = [], bk: number[] = [];
  for (let i = 0; i < 12; i++) f.push(a.f64());
  for (let i = 0; i < 12; i++) bk.push(a.f64());
  o.front = f; o.back = bk;
  for (const side of ['frontPts', 'backPts']) {
    const n = a.u32();
    if (n > 1_000_000) throw new SkpError('corrupt', `texture point count ${n} at ${a.p - 4}`);
    const pts: number[] = [];
    for (let i = 0; i < n * 4; i++) pts.push(a.f64());
    o[side] = pts;
  }
  o.t2 = a.u32(); o.t3 = a.u32();
}

/**
 * CEdgeUse: entity base, edge, reversed flag, loop, next edge use. The chain of new edge uses is read in a loop
 * (not recursively) so that faces with many thousands of edges do not overflow the stack.
 */
function readEdgeUseChain(a: Arc, first: Obj) {
  let o: Obj | null = first;
  for (let guard = 0; o && guard < 50_000_000; guard++) {
    readEntityBase(a, o);
    o.edge = a.obj(['CEdge'], readEdge);
    o.rev = a.u8();
    o.loop = a.obj(['CLoop'], readLoop);
    const h = a.head(['CEdgeUse']);
    if (h.isNew) { o.next = h.o; o = h.o; }
    else { o.next = h.v; o = null; }
  }
}
function readEdgeUse(a: Arc, o: Obj) { readEdgeUseChain(a, o); }

function readLoop(a: Arc, o: Obj) {
  readEntityBase(a, o);
  o.l1 = a.u8(); o.l2 = a.u8();
  o.first = a.obj(['CEdgeUse'], readEdgeUse);
}

function readFace(a: Arc, o: Obj) {
  readDE(a, o);
  o.plane = [a.f64(), a.f64(), a.f64(), a.f64()];
  const n = a.u32();
  if (n > 100000) throw new SkpError('corrupt', `face with ${n} loops at ${a.p}`);
  const loops: unknown[] = [];
  for (let i = 0; i < n; i++) loops.push(a.obj(['CLoop'], readLoop));
  o.loops = loops;
  o.back = a.obj(['CMaterial'], readMaterialBody);
  if (TRACE) a.trace.push(`  face end ${a.p}`);
}

/** CComponentInstance and CGroup: drawing element, definition, 3x3 axes + origin + scale, name, guid (2015+) */
function readInstance(a: Arc, o: Obj) {
  readDE(a, o);
  o.def = a.obj(['CComponentDefinition'], readDefinition);
  const xf: number[] = [];
  for (let i = 0; i < 13; i++) xf.push(a.f64());
  o.xf = xf;
  o.name = a.str();
  if ((a.versions.get('CComponentInstance') ?? 5) >= 5) { o.guid = hex(a.b, a.p, 16); a.skip(16); }
  if (TRACE) a.trace.push(`  instance ${o.cls} end ${a.p}`);
}

function readConstructionLine(a: Arc, o: Obj) {
  readDE(a, o);
  const v: number[] = [];
  for (let i = 0; i < 8; i++) v.push(a.f64()); // point, direction, start / end parameters
  o.v = v;
  o.c = a.u32();
}
function readConstructionPoint(a: Arc, o: Obj) {
  readDE(a, o);
  const v: number[] = [];
  for (let i = 0; i < 6; i++) v.push(a.f64());
  o.v = v;
  o.c = a.u8();
}
function readSectionPlane(a: Arc, o: Obj) {
  readDE(a, o);
  o.plane = [a.f64(), a.f64(), a.f64(), a.f64()];
  if ((a.versions.get('CSectionPlane') ?? 2) >= 3) o.name = a.str();
}
function readFont(a: Arc, o: Obj) {
  readEntityBase(a, o);
  o.face = a.str();
  o.f0 = a.u16(); o.size = a.u32(); o.f1 = a.u8(); o.height = a.f64();
}
/** CText (version 9): leader text or screen text. Only skipped over, text content is kept in o.text */
function readText(a: Arc, o: Obj) {
  readDE(a, o);
  o.font = a.obj(['CSkFont'], readFont);
  a.skip(16);
  o.t0 = a.u8(); a.skip(3);
  o.t1 = a.u32();
  const v: number[] = [];
  for (let i = 0; i < 4; i++) v.push(a.f64());
  o.t2 = a.u32();
  for (let i = 0; i < 6; i++) v.push(a.f64());
  o.v = v;
  o.t3 = a.u32(); o.t4 = a.u32(); o.t5 = a.u16(); o.t6 = a.u32(); o.t7 = a.u8();
  o.text = a.str();
  a.skip(5);
}

function anyRef(a: Arc) { return a.obj(null, readUnknown); }
/** CDimensionLinear (version 6): text, font, two anchors (point + attached entity + instance path), layout values */
function readDimLinear(a: Arc, o: Obj) {
  readDE(a, o);
  o.text = a.str();
  o.font = a.obj(['CSkFont'], readFont);
  o.d0 = a.u8(); o.d1 = a.u32();
  for (let k = 0; k < 2; k++) {
    a.u32(); a.u32();
    a.skip(24);
    anyRef(a); anyRef(a);
    const n = a.u32(); if (n > 1000) throw new SkpError('corrupt', `dimension path of ${n} at ${a.p - 4}`);
    for (let i = 0; i < n; i++) anyRef(a);
    const m = a.u32(); if (m > 1000) throw new SkpError('corrupt', `dimension list of ${m} at ${a.p - 4}`);
    for (let i = 0; i < m; i++) anyRef(a);
  }
  a.skip(24 + 8 + 16);
  o.d2 = a.u32();
  a.skip(16);
  o.d3 = a.u32();
}

function readEntityBody(a: Arc, o: Obj, schema: number) {
  switch (o.cls) {
    case 'CConstructionLine': return readConstructionLine(a, o);
    case 'CConstructionPoint': return readConstructionPoint(a, o);
    case 'CSectionPlane': return readSectionPlane(a, o);
    case 'CText': return readText(a, o);
    case 'CDimensionLinear': return readDimLinear(a, o);
    case 'CEdge': return readEdge(a, o);
    case 'CFace': return readFace(a, o);
    case 'CComponentInstance': case 'CGroup': case 'CImage': return readInstance(a, o);
    default: void schema; return readUnknown(a, o);
  }
}
function readEntityObj(a: Arc): Obj | Ref | null { return a.obj(ENTITY_CLASSES, readEntityBody); }

function readDefinition(a: Arc, o: Obj) {
  readDE(a, o);
  const q = seekCount(a, ['CLayer'], 24, readLayer);
  if (q < 0) throw new SkpError('corrupt', `definition layer table not found after ${a.p}: ${hex(a.b, a.p, 32)}`);
  o.pre = hex(a.b, a.p, q - a.p);
  a.p = q;
  const nl = a.u32();
  for (let i = 0; i < nl; i++) a.obj(['CLayer'], readLayer);
  let q2 = seekCount(a, ENTITY_CLASSES, 16, readEntityBody);
  if (q2 < 0) {
    // empty definition: current layer reference, u32, then a zero count
    const save = a.p;
    a.obj(['CLayer'], readLayer); a.skip(4);
    if (a.p + 4 <= a.b.length && a.dv.getUint32(a.p, true) === 0) q2 = a.p;
    else { a.p = save; throw new SkpError('corrupt', `definition entity list not found after ${a.p}: ${hex(a.b, a.p, 32)}`); }
  }
  o.pre2 = hex(a.b, a.p, q2 - a.p);
  a.p = q2;
  const ne = a.u32();
  const ents: unknown[] = [];
  for (let i = 0; i < ne; i++) ents.push(readEntityObj(a));
  o.ents = ents;
  if (TRACE) a.trace.push(`  definition: ${ne} entities, end ${a.p}`);
  const nr = a.u32();
  if (nr > 10_000_000) throw new SkpError('corrupt', `definition with ${nr} relationships at ${a.p - 4}`);
  for (let i = 0; i < nr; i++) a.obj(['CRelationship'], readRelationship);
  a.skip(2);
  o.guid = hex(a.b, a.p, 16); a.skip(16);
  o.name = a.str();
  o.desc = a.str();
  o.s3 = a.str();
  a.skip(a.entityV >= 5 ? 47 : 46);
  o.thumb = a.obj(['CThumbnail'], readThumbnail);
  if (TRACE) a.trace.push(`definition ${o.name} after thumbnail ${a.p}: ${hex(a.b, a.p, 32)}`);
}

function readRelationship(a: Arc, o: Obj) {
  readEntityBase(a, o);
  o.a = a.obj(null, readUnknown);
  o.b = a.obj(null, readUnknown);
}

function readCamera(a: Arc, o: Obj) {
  const v: number[] = [];
  for (let i = 0; i < 11; i++) v.push(a.f64());
  o.persp = a.u8();
  o.fov = a.f64(); o.aspect = a.f64();
  for (let i = 0; i < 4; i++) v.push(a.f64());
  o.c1 = a.u8(); o.c2 = a.u8();
  o.v = v;
}
function readThumbnail(a: Arc, o: Obj) {
  readEntityBase(a, o);
  o.camera = a.obj(['CCamera'], readCamera);
  o.s = a.str();
  o.x = a.u8();
  o.d = [a.f64(), a.f64(), a.f64(), a.f64()];
  o.image = a.obj(['CDib'], readDib);
}

/**
 * find a u32 count (> 0) within maxSkip bytes after the cursor that is directly followed by a readable object of one
 * of the classes (trial parse with full state restore). Returns the offset of the count, or -1.
 */
function seekCount(a: Arc, classes: string[], maxSkip: number, reader: (a: Arc, o: Obj, schema: number) => void, allowRef = false): number {
  const p0 = a.p;
  if (allowRef) { const q = seekCount(a, classes, maxSkip, reader, false); if (q >= 0) return q; }
  for (let k = 0; k <= maxSkip; k++) {
    const q = p0 + k;
    if (q + 6 > a.b.length) break;
    const n = a.dv.getUint32(q, true);
    if (n === 0 || n > 10_000_000) continue;
    const w = a.b[q + 4] | (a.b[q + 5] << 8);
    if (w === 0) continue;
    const isNew = w === 0x7fff ? (a.b[q + 9] & 0x80) !== 0 : (w & 0x8000) !== 0;
    if (!allowRef && !isNew) continue;
    const snap = a.snapshot();
    a.p = q + 4;
    let ok = false;
    const te = a.trialEnd;
    a.trialEnd = Math.min(te, q + 16384);
    try { const o = a.obj(classes, reader); ok = !!o && !('ref' in o); }
    catch (e) { ok = e === TRIAL_OK; if (!ok && TRACE) console.log(`  seek k=${k} failed: ${(e as Error).message}`); }
    a.trialEnd = te;
    a.restore(snap);
    if (ok) return q;
  }
  a.p = p0;
  return -1;
}

export function readVersionMap(b: Uint8Array, start: number): Map<string, number> {
  const m = new Map<string, number>();
  let i = -1;
  for (let k = start; k < Math.min(b.length - 11, start + 1024); k++) if (b[k] === 0x43 && b[k + 1] === 0x56 && b[k + 2] === 0x65 && b[k + 3] === 0x72 && b[k + 10] === 0x70) { i = k + 11; break; }
  if (i < 0) return m;
  const a = new Arc(b, i);
  for (let n = 0; n < 1000; n++) {
    const k = a.str(); const v = a.u32();
    m.set(k, v);
    if (k === 'End-Of-Version-Map') break;
  }
  m.set('__end', a.p);
  return m;
}

export async function readLegacy(bytes: Uint8Array, start: number, version: string, onProgress?: (stage: string, ratio: number) => void): Promise<SkpModel> {
  void onProgress;
  // anchor: first new-class tag of CMaterial or CLayer
  const find = (name: string) => {
    const pat = [0xff, 0xff];
    for (let i = start; i < bytes.length - 8; i++) {
      if (bytes[i] !== pat[0] || bytes[i + 1] !== pat[1]) continue;
      const n = bytes[i + 4] | (bytes[i + 5] << 8);
      if (n !== name.length) continue;
      let ok = true;
      for (let k = 0; k < n; k++) if (bytes[i + 6 + k] !== name.charCodeAt(k)) { ok = false; break; }
      if (ok) return i;
    }
    return -1;
  };
  const im = find('CMaterial'), il = find('CLayer');
  const anchor = im < 0 ? il : il < 0 ? im : Math.min(im, il);
  if (anchor < 0) throw new SkpError('unsupported-version', `SketchUp ${version}: no material or layer table found`);
  const vmap = readVersionMap(bytes, start);
  const a = new Arc(bytes, anchor);
  a.entityV = vmap.get('CEntity') ?? 3;
  a.versions = vmap;
  // the thumbnail is normally the second object: class CDib gets index 3
  const ve = vmap.get('__end') ?? start;
  for (let k = ve; k < ve + 40 && k < bytes.length - 10; k++) {
    if (bytes[k] === 0xff && bytes[k + 1] === 0xff && bytes[k + 4] === 4 && bytes[k + 5] === 0 && bytes[k + 6] === 0x43 && bytes[k + 7] === 0x44 && bytes[k + 8] === 0x69 && bytes[k + 9] === 0x62) {
      a.preClasses.set(3, { name: 'CDib', schema: 3, rel: -3 }); a.classByName.set('CDib', a.preClasses.get(3)!); break;
    }
  }
  const model: SkpModel = {
    version, container: 'legacy', defs: new Map(), root: emptyEntities(), materials: new Map(), layers: new Map(),
    defaultLayer: 0, textures: [], info: {}, warnings: [],
  };
  const defsParsed: Obj[] = [];
  let rootEnts: unknown[] | null = null;
  let failure: string | null = null;
  let stage = 'materials';
  try {
    let nm: number;
    if (anchor === il) {
      a.obj(['CLayer'], readLayer);
      // a few bytes, then the material count right before the first material tag
      const q = seekCount(a, ['CMaterial'], 12, readMaterialBody);
      if (q < 0) throw new SkpError('corrupt', `material table not found after ${a.p}`);
      a.p = q; nm = a.u32();
    } else { nm = a.dv.getUint32(anchor - 4, true); }
    for (let i = 0; i < nm; i++) a.obj(['CMaterial'], readMaterialBody);
    stage = 'layers';
    const q2 = seekCount(a, ['CLayer'], 16, readLayer, true);
    if (q2 < 0) throw new SkpError('corrupt', `layer table not found after ${a.p}`);
    a.p = q2;
    const nl = a.u32();
    for (let i = 0; i < nl; i++) a.obj(['CLayer'], readLayer);
    a.obj(['CLayer'], readLayer); // current layer (a reference)
    stage = 'definitions';
    const nd = a.u32();
    if (nd > 10_000_000) throw new SkpError('corrupt', `${nd} definitions`);
    for (let i = 0; i < nd; i++) {
      const d = a.obj(['CComponentDefinition'], readDefinition);
      if (d && !('ref' in d)) defsParsed.push(d);
      if ((i & 15) === 0) { onProgress?.('parse', 0.05 + 0.55 * (a.p / bytes.length)); await new Promise((r) => setTimeout(r, 0)); }
    }
    stage = 'model entities';
    const nr = a.u32();
    if (nr > 50_000_000) throw new SkpError('corrupt', `${nr} model entities`);
    const list: unknown[] = [];
    for (let i = 0; i < nr; i++) list.push(readEntityObj(a));
    rootEnts = list;
    if (TRACE) { const c = new Map<string, number>(); for (const it of list) { const o = a.resolve<Obj>(it); const k = o ? o.cls : 'null'; c.set(k, (c.get(k) ?? 0) + 1); } console.log('root entity classes', JSON.stringify([...c])); }
  } catch (e) {
    failure = `${stage}: ${(e as Error).message}`;
    if (TRACE) { console.log(a.trace.slice(-30).join('\n')); console.log('classes:', [...a.classByRel.values()].map((c) => `${c.name}@${c.rel + a.base}`).join(' ')); }
  } finally {
    if (TRACE) { console.log(`stopped at ${a.p} base=${a.base}`); console.log(hex(bytes, a.p, 96)); }
  }
  if (a.base < 0 && failure) throw new SkpError('unsupported-version', `SketchUp ${version}: the object stream could not be decoded (${failure})`);
  convertModel(a, model, defsParsed, rootEnts);
  if (failure) {
    if (rootEnts === null && defsParsed.length) model.warnings.push(`The file could only be read in part (${failure}). The ${model.defs.size} component definitions read so far are shown at their own origin; their placement is unknown.`);
    else model.warnings.push(`The file could only be read in part (${failure})`);
    model.info.partial = 1;
  }
  model.info.objects = a.rel;
  return model;
}

// ------------------------------------------------------------------ conversion to SkpModel

const MAGIC_MIME = (b: Uint8Array): string => b[0] === 0x89 && b[1] === 0x50 ? 'image/png' : b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : b[0] === 0x42 && b[1] === 0x4d ? 'image/bmp' : 'application/octet-stream';

function convertModel(a: Arc, model: SkpModel, defs: Obj[], root: unknown[] | null) {
  const R = <T = Obj>(v: unknown): T | null => a.resolve<T>(v);
  const idOf = (o: Obj) => o.rel + 1;
  const texIndex = new Map<unknown, number>();
  const material = (v: unknown): number => {
    const o = R(v);
    if (!o || o.cls !== 'CMaterial') return 0;
    const id = idOf(o);
    if (!model.materials.has(id)) {
      const useTrans = o.useTrans === 1, tr = o.trans as number;
      const m: { id: number; name: string; color: [number, number, number]; opacity: number; textureName?: string; textureIndex?: number } = {
        id, name: (o.name as string) || `Material ${id}`, color: (o.color as [number, number, number]) ?? [0.8, 0.8, 0.8],
        opacity: useTrans && isFinite(tr) && tr > 0 && tr < 1 ? Math.max(0.05, tr) : 1,
      };
      const t = o.texture as Obj | undefined;
      if (t) {
        const file = String(t.file ?? '');
        m.textureName = file.split(/[\\/]/).pop() || file;
        const dib = R(t.dib);
        if (dib && dib.bytes) {
          let ti = texIndex.get(dib);
          if (ti === undefined) {
            const bytes = (dib.bytes as Uint8Array).slice();
            ti = model.textures.length;
            model.textures.push({ name: m.textureName || `texture${ti}`, mime: MAGIC_MIME(bytes), bytes });
            texIndex.set(dib, ti);
          }
          m.textureIndex = ti;
        }
      }
      model.materials.set(id, m);
    }
    return id;
  };
  const layer = (v: unknown): number => {
    const o = R(v);
    if (!o || o.cls !== 'CLayer') return 0;
    const name = (o.name as string) || 'Layer0';
    // layers with the same name (every definition carries its own "Layer0") map to one tag
    for (const l of model.layers.values()) if (l.name === name) return l.id;
    const id = idOf(o);
    model.layers.set(id, { id, name, visible: !o.flag });
    if (TRACE) console.log(`layer ${name} flag=${o.flag} t1=${o.t1} mat=${(o.material as Obj)?.name}`);
    if (name === 'Layer0' && !model.defaultLayer) model.defaultLayer = id;
    return id;
  };
  const defIds = new Map<Obj, number>();
  const convertEntities = (list: unknown[]): SkpEntities => {
    const ents = emptyEntities();
    const vIndex = new Map<Obj, number>();
    const pos: number[] = [];
    const vid = (v: unknown): number => {
      const o = R(v);
      if (!o || o.cls !== 'CVertex') return -1;
      let i = vIndex.get(o);
      if (i === undefined) { i = pos.length / 3; vIndex.set(o, i); pos.push(o.x as number, o.y as number, o.z as number); }
      return i;
    };
    const edges: number[] = [], edgeLayers: number[] = [];
    let badLoops = 0;
    for (const it of list) {
      const o = R(it);
      if (!o) continue;
      const f = (o.f as number[] | undefined) ?? [0, 1, 1, 0, 0, 0];
      switch (o.cls) {
        case 'CEdge': {
          ents.counts.edges++;
          if (f[0]) { ents.counts.hiddenEdges++; break; }
          if (f[3] || f[4]) { ents.counts.softEdges++; break; }
          const i0 = vid(o.v0), i1 = vid(o.v1);
          if (i0 >= 0 && i1 >= 0) { edges.push(i0, i1); edgeLayers.push(layer(o.layer)); }
          break;
        }
        case 'CFace': {
          const face: SkpFace = { loops: [], normal: [0, 0, 1], mat: material(o.mat), back: material(o.back), layer: layer(o.layer), hidden: !!f[0] };
          const pl = o.plane as number[];
          if (pl) face.normal = [pl[0], pl[1], pl[2]];
          for (const lv of (o.loops as unknown[]) ?? []) {
            const loop = R(lv);
            if (!loop) continue;
            const ends: number[] = [];
            let eu = R(loop.first), guard = 0;
            while (eu && guard++ < 1_000_000) {
              const e = R(eu.edge);
              if (!e) { ends.length = 0; break; }
              ends.push(vid(e.v0), vid(e.v1));
              eu = R(eu.next);
            }
            const ch = chainPairs(ends);
            if (ch) face.loops.push(ch); else badLoops++;
          }
          if (face.loops.length) ents.faces.push(face);
          break;
        }
        case 'CComponentInstance': case 'CGroup': case 'CImage': {
          const d = R(o.def);
          const xfv = o.xf as number[];
          const xf = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
          // 3x3 part stored row by row, then origin, then w (same layout as the 2021+ format)
          for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) xf[c * 4 + r] = xfv[r * 3 + c];
          for (let k = 0; k < 3; k++) xf[12 + k] = xfv[9 + k];
          xf[15] = isFinite(xfv[12]) && xfv[12] !== 0 ? xfv[12] : 1;
          if (o.cls === 'CImage') ents.counts.images++;
          ents.instances.push({ id: idOf(o), def: d ? idOf(d) : 0, xf, name: (o.name as string) ?? '', mat: material(o.mat), layer: layer(o.layer), hidden: !!f[0], group: o.cls === 'CGroup' });
          if (d && !defIds.has(d)) pending.push(d);
          break;
        }
        case 'CConstructionLine': case 'CConstructionPoint': ents.counts.guides++; break;
        case 'CText': ents.counts.texts++; break;
        case 'CDimensionLinear': case 'CDimensionRadial': ents.counts.dims++; break;
      }
    }
    if (badLoops) model.warnings.push(`${badLoops} face loops could not be closed and were skipped`);
    ents.verts = new Float64Array(pos);
    ents.edges = new Int32Array(edges);
    ents.edgeLayers = new Int32Array(edgeLayers);
    return ents;
  };
  const pending: Obj[] = [...defs];
  while (pending.length) {
    const d = pending.shift()!;
    if (defIds.has(d)) continue;
    defIds.set(d, idOf(d));
    model.defs.set(idOf(d), { id: idOf(d), name: (d.name as string) ?? '', ents: convertEntities((d.ents as unknown[]) ?? []) });
  }
  if (root) {
    model.root = convertEntities(root);
    while (pending.length) {
      const d = pending.shift()!;
      if (defIds.has(d)) continue;
      defIds.set(d, idOf(d));
      model.defs.set(idOf(d), { id: idOf(d), name: (d.name as string) ?? '', ents: convertEntities((d.ents as unknown[]) ?? []) });
    }
  } else {
    // structure incomplete: place every definition that is not used by another one at the origin
    const used = new Set<number>();
    for (const d of model.defs.values()) for (const i of d.ents.instances) used.add(i.def);
    for (const d of model.defs.values()) {
      if (used.has(d.id)) continue;
      model.root.instances.push({ id: d.id, def: d.id, xf: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), name: d.name, mat: 0, layer: 0, hidden: false, group: false });
    }
  }
  for (const l of model.layers.values()) if (l.name === 'Layer0') { model.defaultLayer = l.id; break; }
  model.info.legacyDefinitions = defs.length;
}

/** order edge end points (pairs) into a closed vertex loop by connectivity */
function chainPairs(ends: number[]): Int32Array | null {
  const n = ends.length / 2;
  if (n < 2) return null;
  for (const v of ends) if (v < 0) return null;
  const out = new Int32Array(n);
  let a0 = ends[0], b0 = ends[1];
  const a1 = ends[2], b1 = ends[3];
  if (!(b0 === a1 || b0 === b1) && (a0 === a1 || a0 === b1)) { const t = a0; a0 = b0; b0 = t; }
  out[0] = a0;
  let cur = b0;
  for (let k = 1; k < n; k++) {
    const a = ends[k * 2], b = ends[k * 2 + 1];
    out[k] = cur;
    if (a === cur) cur = b; else if (b === cur) cur = a; else { cur = b; LOOP_STATS.broken++; }
  }
  if (cur !== out[0]) LOOP_STATS.open++;
  LOOP_STATS.loops++;
  return out;
}
