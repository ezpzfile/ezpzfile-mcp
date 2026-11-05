// SXF (Japanese MLIT / OCF CAD data exchange standard) reader: entry points sniffSxf / readSxf.
// Own code, see NOTEBOOK.md for the sources. Formats:
//   .sfc  feature comment file (SXF Ver.2 / Ver.3 level 2), Shift_JIS
//   .p21  ISO 10303-21 file with FILE_SCHEMA(('ASSOCIATIVE_DRAUGHTING')) (AP202 subset). When it carries feature
//         comments too ("ambi_mode") the comments are read; a pure AP202 file is read by ap202.ts.
//   .sfz / .p2z  the same files compressed in a ZIP archive

import { CadError, type CadResult, type Progress } from './types.ts';
import { scanSfc } from './sfc.ts';
import { FeatureModel, type FeatureOptions } from './feature.ts';
import { Zip } from './zip.ts';
import { readAp202 } from './ap202.ts';
import { decodeStepString } from './step.ts';

export interface SxfOptions extends FeatureOptions {
  /** limit for the input size in bytes (default 400 MB) */
  maxBytes?: number;
}

const latin1 = new TextDecoder('latin1');

function isZip(b: Uint8Array) { return b.length > 30 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4; }

const SXF_EXT = /\.(sfc|p21|sfz|p2z)$/i;

interface Head { ok: boolean; schema: string; description: string; mode: string; level: string; fileName: string; system: string; preprocessor: string; time: string; dataPos: number }

/** Parse the STEP header (first 64 KB) without a full tokenizer */
function head(b: Uint8Array): Head {
  const h: Head = { ok: false, schema: '', description: '', mode: '', level: '', fileName: '', system: '', preprocessor: '', time: '', dataPos: -1 };
  let i = 0;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
  while (i < b.length && (b[i] === 32 || b[i] === 9 || b[i] === 10 || b[i] === 13)) i++;
  const lim = Math.min(b.length, i + 65536);
  const s = latin1.decode(b.subarray(i, lim));
  if (!s.startsWith('ISO-10303-21;')) return h;
  const dm = /\bDATA\s*(?:\([^)]*\))?\s*;/.exec(s);
  const hdr = dm ? s.slice(0, dm.index) : s;
  h.dataPos = dm ? i + dm.index + dm[0].length : -1;
  const sm = /FILE_SCHEMA\s*\(\s*\(\s*'([^']*)'/i.exec(hdr);
  h.schema = sm ? sm[1].trim().toUpperCase() : '';
  const dd = /FILE_DESCRIPTION\s*\(\s*\(\s*'([^']*)'/i.exec(hdr);
  h.description = dd ? dd[1] : '';
  const md = /SCADEC\s+(level\s*\d)\s+(\w+)/i.exec(h.description);
  if (md) { h.level = md[1].replace(/\s+/g, ''); h.mode = md[2]; }
  const fm = /FILE_NAME\s*\(([\s\S]*?)\)\s*;/i.exec(hdr);
  if (fm) {
    const parts: string[] = [];
    const re = /'((?:[^']|'')*)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(fm[1]))) parts.push(m[1]);
    const dec = (x: string | undefined) => {
      if (!x) return '';
      const bytes = new Uint8Array(x.length);
      for (let k = 0; k < x.length; k++) bytes[k] = x.charCodeAt(k) & 255;
      return decodeStepString(bytes, 0, bytes.length);
    };
    // name, time, (author), (organization), preprocessor, originating system, authorization
    h.fileName = dec(parts[0]); h.time = dec(parts[1]);
    h.preprocessor = dec(parts[parts.length - 3]); h.system = dec(parts[parts.length - 2]);
  }
  h.ok = true;
  return h;
}

/** true for SXF SFC / P21 files (and ZIP archives holding one). P21 is told apart from 3D STEP and IFC by FILE_SCHEMA. */
export function sniffSxf(bytes: Uint8Array): boolean {
  if (isZip(bytes)) {
    try { return new Zip(bytes).list.some((e) => SXF_EXT.test(e.name) && !e.name.endsWith('/')); } catch { return false; }
  }
  const h = head(bytes);
  if (!h.ok) return false;
  if (h.schema === 'ASSOCIATIVE_DRAUGHTING' || h.schema.startsWith('ASSOCIATIVE_DRAUGHTING')) return true;
  if (/SCADEC/i.test(h.description)) return true;
  // feature comments near the start of the data section
  if (h.dataPos > 0) {
    const s = latin1.decode(bytes.subarray(h.dataPos, Math.min(bytes.length, h.dataPos + 4096)));
    if (/\/\*\s*SXF\s*#\d+\s*=/.test(s)) return true;
  }
  return false;
}

export async function readSxf(bytes: Uint8Array, onProgress?: Progress, opts: SxfOptions = {}): Promise<CadResult> {
  try {
    return await readSxfInner(bytes, onProgress, opts);
  } catch (e) {
    if ((e as { code?: string }).code) throw e;
    throw new CadError('corrupt', `SXF file could not be read: ${(e as Error).message}`);
  }
}

async function readSxfInner(bytes: Uint8Array, onProgress: Progress | undefined, opts: SxfOptions): Promise<CadResult> {
  const t0 = Date.now();
  if (bytes.length > (opts.maxBytes ?? 400 * 1024 * 1024)) throw new CadError('too-large', 'SXF file is too large');
  let data = bytes;
  let container = '';
  if (isZip(bytes)) {
    onProgress?.('unzip', 0);
    const z = new Zip(bytes);
    const ent = z.list.filter((e) => SXF_EXT.test(e.name) && !/\.(sfz|p2z)$/i.test(e.name) && e.usize > 0);
    if (!ent.length) throw new CadError('not-format', 'ZIP archive holds no .sfc or .p21 file');
    ent.sort((a, b) => b.usize - a.usize);
    const d = await z.read(ent[0]);
    if (!d) throw new CadError('corrupt', 'ZIP entry could not be read');
    data = d;
    container = /\.sfc$/i.test(ent[0].name) ? 'SFZ (zip)' : 'P2Z (zip)';
    if (ent.length > 1) container += `, ${ent.length} drawings in the archive, the largest is shown`;
  }
  const h = head(data);
  if (!h.ok) throw new CadError('not-format', 'not an ISO 10303-21 / SXF file');
  if (!(h.schema.startsWith('ASSOCIATIVE_DRAUGHTING') || /SCADEC/i.test(h.description))) {
    // a plain STEP file with feature comments would still be accepted below; anything else is not SXF
    const s = latin1.decode(data.subarray(Math.max(0, h.dataPos), Math.min(data.length, Math.max(0, h.dataPos) + 65536)));
    if (!/\/\*\s*SXF/.test(s)) throw new CadError('not-format', `STEP schema ${h.schema || '?'} is not SXF (AP202)`);
  }
  onProgress?.('scan', 0.05);
  const scan = scanSfc(data, Math.max(0, h.dataPos));
  const baseInfo: Record<string, string | number> = {
    format: 'SXF',
    level: h.level,
    mode: h.mode,
    schema: h.schema,
    originatingSystem: h.system,
    preprocessor: h.preprocessor,
    fileName: h.fileName,
    timeStamp: h.time,
  };
  const ver = /\$\$(\d+(?:\.\d+)?)/.exec(h.preprocessor);
  baseInfo.sxfVersion = ver ? ver[1] : (h.preprocessor ? '2.0' : '');
  if (container) baseInfo.container = container;
  if (scan.records.length) {
    onProgress?.('features', 0.4);
    const m = new FeatureModel(opts);
    for (const r of scan.records) m.add(r);
    onProgress?.('draw', 0.6);
    const res = m.render();
    if (scan.bad) res.sheet.warnings.push(`${scan.bad} damaged feature comments skipped`);
    const physical = /ambi/i.test(h.mode) ? 'P21 + feature comments (ambi_mode)' : /feature/i.test(h.mode) ? 'SFC (feature comments)' : 'feature comments';
    const info = { ...baseInfo, physical, encoding: scan.encoding, records: scan.records.length, items: res.sheet.items.length, ...res.info, ms: Date.now() - t0 };
    onProgress?.('done', 1);
    return { kind: '2d', sheets: [res.sheet], layers: res.layers, info };
  }
  // no feature comments: AP202 entities
  onProgress?.('ap202', 0.1);
  const res = readAp202(data, opts, onProgress);
  const info = { ...baseInfo, physical: 'P21 (AP202 entities)', items: res.sheet.items.length, ...res.info, ms: Date.now() - t0 };
  onProgress?.('done', 1);
  return { kind: '2d', sheets: [res.sheet], layers: res.layers, info };
}
