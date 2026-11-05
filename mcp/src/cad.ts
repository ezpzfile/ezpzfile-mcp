/**
 * CAD and BIM drawings (DWG, DXF, JWW, iCAD SX, SXF, Gerber/ODB++, IGES, Inventor,
 * DWFx, IFC, STEP, SKP, glTF, OBJ, STL, 3DS, FBX) through the same clean-room engines
 * as the CAD viewer on ezpzfile.com (src/lib/cad). Revit (.rvt) is the viewer's own
 * worker and is not here yet.
 *
 * 2D drawings come out as sheets of items (lines, arcs, fills, text, pictures) in mm with
 * the layer each sits on; 3D models as elements by category and level.
 */
import { DOMParser } from 'linkedom'
import PDFDocument from 'pdfkit'
import { openCad, CadOpenError, type CadOpened } from '../../src/lib/cad/dispatch'
import { prepare, toSvg } from '../../src/lib/cad/draw2d'
import { findFrames } from '../../src/lib/cad/frames'
import { PX_TO_PT, paintSvg, type FontChooser, type PaintReport } from '../../src/lib/svgPdf'
import { installDom, loadFont } from './engine'
import { ToolError } from './result'
import { getSharp } from './sharp'
import * as fontkit from 'fontkit'

export const CAD_EXT = new Set(['dwg', 'dxf', 'dxb', 'jww', 'jwc', 'icd', 'sfc', 'sfz', 'p21', 'p2z', 'gbr', 'ger', 'gtl', 'gbl', 'drl', 'iges', 'igs', 'ipt', 'iam', 'dwfx', 'ifc', 'ifczip', 'step', 'stp', 'stpz', 'skp', 'gltf', 'glb', 'obj', 'stl', '3ds', 'fbx'])

export async function openDrawing(bytes: Uint8Array, name: string): Promise<CadOpened> {
  try {
    return await openCad(bytes, () => {}, { name })
  } catch (err) {
    if (err instanceof CadOpenError) {
      const map: Record<string, [string, string]> = {
        'not-format': ['UNREADABLE', 'This is not a drawing any of the CAD engines reads.'],
        corrupt: ['UNREADABLE', 'The drawing is damaged or cut off.'],
        'unsupported-version': ['UNSUPPORTED', `This ${err.format?.toUpperCase() ?? 'CAD'} version is not supported${err.versionTag ? ` (${err.versionTag})` : ''}.`],
        encrypted: ['PASSWORD_REQUIRED', 'The drawing is encrypted.'],
        'too-large': ['TOO_LARGE', 'The drawing is too large or damaged.'],
        'dwf-classic': ['UNSUPPORTED', 'Classic DWF (not DWFx) is not supported.'],
        'missing-parts': ['BAD_ARGUMENT', `The assembly needs parts that were not given: ${(err.missing ?? []).join(', ')}.`],
      }
      const [code, msg] = map[err.code] ?? ['UNREADABLE', err.message]
      throw new ToolError(code as never, `${msg} ${err.message !== msg ? err.message : ''}`.trim(), [])
    }
    throw err
  }
}

export async function inspectDrawing(bytes: Uint8Array, name: string) {
  const d = await openDrawing(bytes, name)
  if (d.kind === '3d') {
    return {
      kind: '3d' as const,
      format: d.meta.label,
      info: d.meta.info,
      warnings: d.meta.warnings,
      elements: d.geometry.elements.length,
      triangles: d.geometry.stats?.triangles,
      categories: d.model.categoryCounts.slice(0, 40),
      levels: d.model.levels.map((l) => ({ name: l.name, elevationM: l.elevation_m })),
      tree: d.tree?.slice(0, 50),
    }
  }
  const sheets = d.sheets.map((s, i) => {
    const counts: Record<string, number> = {}
    for (const it of s.items) counts[it.kind] = (counts[it.kind] ?? 0) + 1
    const texts = s.items.filter((it): it is Extract<typeof it, { kind: 'text' }> => it.kind === 'text')
    let frames = 0
    try {
      frames = findFrames(s).length
    } catch {
      frames = 0
    }
    return { sheet: i, name: s.name || s.number, sizeMm: [Math.round(s.size.w), Math.round(s.size.h)], items: s.items.length, counts, texts: texts.slice(0, 60).map((t) => ({ text: t.text, layer: t.layer, x: Math.round(t.x), y: Math.round(t.y) })), titleBlocks: frames }
  })
  return { kind: '2d' as const, format: d.meta.label, info: d.meta.info, warnings: d.meta.warnings, layers: d.layers, sheets }
}

/** Every text of a 2D drawing, sheet by sheet, top to bottom and left to right. */
export async function drawingText(bytes: Uint8Array, name: string): Promise<{ text: string; sheets: number; texts: number }> {
  const d = await openDrawing(bytes, name)
  if (d.kind === '3d') return { text: '', sheets: 0, texts: 0 }
  let n = 0
  const parts = d.sheets.map((s) => {
    const texts = s.items.filter((it): it is Extract<typeof it, { kind: 'text' }> => it.kind === 'text').sort((a, b) => b.y - a.y || a.x - b.x)
    n += texts.length
    return `## ${s.name || s.number || 'Sheet'}\n${texts.map((t) => t.text).join('\n')}`
  })
  return { text: parts.join('\n\n'), sheets: d.sheets.length, texts: n }
}

function sheetSvg(d: Extract<CadOpened, { kind: '2d' }>, index: number, hideLayers: string[] = []): { svg: string; w: number; h: number } {
  const s = d.sheets[index]
  if (!s) throw new ToolError('BAD_ARGUMENT', `There is no sheet ${index}; the drawing has ${d.sheets.length}.`, [])
  const names = d.layers.map((l) => l.name)
  const p = prepare(s, names)
  const hidden = new Uint8Array(names.length)
  names.forEach((n, i) => {
    if (hideLayers.includes(n) || d.layers[i]!.visible === false) hidden[i] = 1
  })
  return { svg: toSvg(p, hidden), w: s.size.w, h: s.size.h }
}

/** PNG of a sheet, longest side `px` pixels. */
export async function drawingPng(bytes: Uint8Array, name: string, opts: { sheet?: number; px?: number; hideLayers?: string[] }): Promise<{ png: Uint8Array; width: number; height: number; sheets: number }> {
  const d = await openDrawing(bytes, name)
  if (d.kind === '3d') throw new ToolError('UNSUPPORTED', 'Drawing 3D models to a picture is not available yet; doc_inspect lists their elements.', [])
  const { svg, w, h } = sheetSvg(d, opts.sheet ?? 0, opts.hideLayers)
  const px = opts.px ?? 2000
  const scale = px / Math.max(w, h)
  const sharp = await getSharp()
  const out = await sharp(Buffer.from(svg), { density: Math.max(1, Math.min(2400, 25.4 * scale)), limitInputPixels: false }).resize({ width: Math.round(w * scale), height: Math.round(h * scale), fit: 'fill' }).flatten({ background: '#ffffff' }).png().toBuffer({ resolveWithObject: true })
  return { png: new Uint8Array(out.data), width: out.info.width, height: out.info.height, sheets: d.sheets.length }
}

export async function drawingSvg(bytes: Uint8Array, name: string, opts: { sheet?: number; hideLayers?: string[] }): Promise<string> {
  const d = await openDrawing(bytes, name)
  if (d.kind === '3d') throw new ToolError('UNSUPPORTED', '3D models have no sheet to draw.', [])
  return sheetSvg(d, opts.sheet ?? 0, opts.hideLayers).svg
}

/** Vector PDF, one page per sheet, text as text (bundled Korean/Japanese fonts). */
export async function drawingPdf(bytes: Uint8Array, name: string, opts: { hideLayers?: string[] }): Promise<{ pdf: Uint8Array; pages: number; missingGlyphs: number }> {
  const d = await openDrawing(bytes, name)
  if (d.kind === '3d') throw new ToolError('UNSUPPORTED', '3D models have no sheet to print.', [])
  installDom()
  const faces = [{ key: 'gothic', bytes: loadFont('gothic') }, { key: 'cjk', bytes: loadFont('cjk') }].map((f) => {
    const parsed = fontkit.create(f.bytes) as unknown as { hasGlyphForCodePoint(cp: number): boolean }
    return { ...f, has: (cp: number) => parsed.hasGlyphForCodePoint(cp) }
  })
  const pdf = new PDFDocument({ autoFirstPage: false, compress: true, font: null as never })
  const chunks: Uint8Array[] = []
  pdf.on('data', (c) => chunks.push(c))
  const done = new Promise<void>((r) => pdf.on('end', () => r()))
  for (const f of faces) pdf.registerFont(f.key, Buffer.from(f.bytes))
  const fonts: FontChooser = {
    pick(char) {
      const cp = char.codePointAt(0)!
      for (const f of faces) if (f.has(cp)) return { font: f.key, char }
      return null
    },
  }
  const report: PaintReport = { missingGlyphs: 0, skipped: 0 }
  const parser = new DOMParser()
  for (let i = 0; i < d.sheets.length; i++) {
    const { svg, w, h } = sheetSvg(d, i, opts.hideLayers)
    // the SVG is in mm; paint it at 1 unit = 1 px and scale px → pt so the page is w × h mm
    const el = parser.parseFromString(svg.replace(/width="[^"]*mm" height="[^"]*mm"/, `width="${w}" height="${h}"`), 'image/svg+xml').documentElement as unknown as SVGSVGElement
    // model space can be kilometres wide; a PDF page stops at 200 inches. Fit big sheets on A0.
    const k = Math.min(1, 1189 / Math.max(w, h))
    const mmToPt = (72 / 25.4) * k
    pdf.addPage({ size: [Math.max(1, w * mmToPt), Math.max(1, h * mmToPt)], margin: 0 })
    pdf.scale(mmToPt)
    paintSvg(pdf as never, el, fonts, report)
  }
  void PX_TO_PT
  pdf.end()
  await done
  return { pdf: new Uint8Array(Buffer.concat(chunks.map((c) => Buffer.from(c)))), pages: d.sheets.length, missingGlyphs: report.missingGlyphs }
}
