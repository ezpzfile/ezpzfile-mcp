/**
 * Vector (AI, EPS, SVG …) and image (PSD …) documents through the design engines
 * (src/designEngine.ts), behind the same five verbs as the office documents:
 * inspect, edit by op list, render, fill templates, convert.
 *
 * Addresses are the engines' own object ids (numbers), as doc_inspect lists them.
 * Every op has a generic name (hide, show, delete, set_text, replace_text, move,
 * set_fill, rename, duplicate) and `command` runs any engine command directly
 * (ezpzfile://formats/ai and ezpzfile://formats/psd say where the catalogue is).
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { endPhotoSession, photo as photoRaw, toWasi, vec as vecRaw, vecCommand as vecCommandRaw } from './designEngine'

// paths cross into the WASI engines: Windows drives become /c/…; PhotoCraft wants them relative to its root
const P = (p: string) => toWasi(p)
const PR = (p: string) => toWasi(p).replace(/^\/+/, '')
const PATH_KEYS = new Set(['path', 'folder'])
const mapPaths = (o: Record<string, unknown>, f: (p: string) => string) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, PATH_KEYS.has(k) && typeof v === 'string' ? f(v) : v]))
const vec = (tool: string, args: Record<string, unknown> = {}) => vecRaw(tool, mapPaths(args, P))
const vecCommand = (c: string, params: Record<string, unknown> = {}) => vecCommandRaw(c, mapPaths(params, P))
const photo = (m: string, params: Record<string, unknown> = {}) => photoRaw(m, mapPaths(params, PR))
import { ToolError } from './result'

export const VECTOR_EXT = new Set(['ai', 'ait', 'eps', 'epsf', 'svg', 'svgz', 'vectorcraft', 'cdr', 'emf', 'wmf'])
export const PHOTO_EXT = new Set(['psd', 'psb', 'pcraft'])
export const designKind = (ext: string) => (VECTOR_EXT.has(ext) ? 'vector' : PHOTO_EXT.has(ext) ? 'photo' : null)

interface Node {
  id: number
  kind: string
  name?: string
  text?: string
  visible?: boolean
  locked?: boolean
  bounds?: { x: number; y: number; width: number; height: number } | null
  fill?: string
  opacity?: number
  children?: Node[]
}

export interface Item {
  id: number
  depth: number
  kind: string
  name: string
  text?: string
  visible: boolean
  bounds?: [number, number, number, number]
  fill?: string
  children?: number
}

const round = (b: Node['bounds']) => (b ? ([b.x, b.y, b.width, b.height].map((v) => Math.round(v * 10) / 10) as [number, number, number, number]) : undefined)

/** A flat list an agent can read: layers, named things, text, pictures, and the top levels. */
function flatten(nodes: Node[], full: boolean, max = 400): { items: Item[]; total: number; counts: Record<string, number> } {
  const items: Item[] = []
  const counts: Record<string, number> = {}
  let total = 0
  const walk = (n: Node, depth: number) => {
    total++
    counts[n.kind] = (counts[n.kind] ?? 0) + 1
    const named = n.name && !/^<.*>$/.test(n.name)
    const notable = full || depth <= 1 || named || n.text !== undefined || /image|type|text|smart|adjust/i.test(n.kind)
    if (notable && items.length < max) {
      items.push({
        id: n.id,
        depth,
        kind: n.kind,
        name: n.name ?? '',
        ...(n.text !== undefined ? { text: n.text } : {}),
        visible: n.visible !== false,
        ...(n.bounds ? { bounds: round(n.bounds) } : {}),
        ...(n.fill && n.fill !== 'None' ? { fill: n.fill } : {}),
        ...(n.children?.length ? { children: n.children.length } : {}),
      })
    }
    for (const c of n.children ?? []) walk(c, depth + 1)
  }
  for (const n of nodes) walk(n, 0)
  return { items, total, counts }
}

/* ---------------------------------------------------------------- vector */

async function vecOpen(file: string): Promise<{ warnings: string[] }> {
  const r = (await vec('open_file', { path: file })).json as { warnings?: string[] }
  return { warnings: r?.warnings ?? [] }
}

async function vecClose(): Promise<void> {
  try {
    await vecCommand('file.closeAll', {})
  } catch {
    /* nothing open */
  }
}

async function vecTree(): Promise<{ doc: { artboards?: unknown[]; colorMode?: string; units?: string }; layers: Node[] }> {
  const d = (await vec('inspect_document', {})).json as { layers: Node[]; artboards?: unknown[]; colorMode?: string; units?: string }
  return { doc: d, layers: d.layers ?? [] }
}

export async function inspectDesign(file: string, kind: 'vector' | 'photo', full = false) {
  if (kind === 'vector') {
    await vecClose()
    const { warnings } = await vecOpen(file)
    try {
      const { doc, layers } = await vecTree()
      let fonts: unknown = null
      try {
        fonts = await vecCommand('text.fonts', {})
      } catch {
        fonts = null
      }
      const flat = flatten(layers, full)
      return { engine: 'VectorCraft', artboards: doc.artboards, colorMode: doc.colorMode, units: doc.units, layers: layers.map((l) => ({ id: l.id, name: l.name, visible: l.visible !== false, objects: (l.children ?? []).length })), ...flat, fonts, warnings }
    } finally {
      await vecClose()
    }
  }
  const opened = (await photo('doc.open', { path: file })) as { index?: number }
  try {
    const d = (await photo('doc.inspect', {})) as Record<string, unknown>
    const layers = normalisePhotoLayers(d)
    // the text of type layers is not in the inspect JSON: ask each one
    const fillText = async (ns: Node[]) => {
      for (const n of ns) {
        if (/type|text/i.test(n.kind)) {
          try {
            const info = (await photo('engine.execute', { command: 'type.info', params: { layer: n.id } })) as { text?: string; result?: { text?: string } }
            const t = info?.text ?? info?.result?.text
            if (typeof t === 'string') n.text = t
          } catch {
            /* leave it out */
          }
        }
        if (n.children) await fillText(n.children)
      }
    }
    await fillText(layers)
    const flat = flatten(layers, full)
    return { engine: 'PhotoCraft', width: d.width, height: d.height, mode: d.mode ?? d.colorMode, depth: d.depth ?? d.bitDepth, layers: layers.map((l) => ({ id: l.id, name: l.name, visible: l.visible !== false })), ...flat, index: opened?.index }
  } finally {
    await photo('doc.close', {}).catch(() => undefined)
    endPhotoSession()
  }
}

/** PhotoCraft's inspect JSON → the same Node shape. */
function normalisePhotoLayers(d: Record<string, unknown>): Node[] {
  const raw = (d.layers ?? d.layerTree ?? (d.document as Record<string, unknown> | undefined)?.layers ?? []) as Record<string, unknown>[]
  const conv = (l: Record<string, unknown>): Node => {
    const b = (l.bounds ?? l.rect) as Record<string, number> | number[] | undefined
    const bounds = Array.isArray(b) ? { x: b[0]!, y: b[1]!, width: b[2]!, height: b[3]! } : b ? { x: b.x ?? b.left ?? 0, y: b.y ?? b.top ?? 0, width: b.width ?? (b.right ?? 0) - (b.left ?? 0), height: b.height ?? (b.bottom ?? 0) - (b.top ?? 0) } : null
    return {
      id: Number(l.id ?? l.layerId),
      kind: String(l.kind ?? l.type ?? 'Layer'),
      name: String(l.name ?? ''),
      ...(typeof l.text === 'string' ? { text: l.text } : {}),
      visible: l.visible !== false && l.hidden !== true,
      bounds,
      children: ((l.children ?? l.layers ?? []) as Record<string, unknown>[]).map(conv),
    }
  }
  return raw.map(conv)
}

export type DesignOp =
  | { op: 'hide' | 'show' | 'delete'; ids: number[] }
  | { op: 'set_text'; id: number; text: string }
  | { op: 'replace_text'; find: string; replace: string }
  | { op: 'move'; ids: number[]; dx: number; dy: number }
  | { op: 'set_fill'; ids: number[]; color: string }
  | { op: 'rename'; id: number; name: string }
  | { op: 'duplicate'; ids: number[] }
  | { op: 'command'; command: string; params?: Record<string, unknown> }

const ids = (o: { ids?: number[]; id?: number }) => o.ids ?? (o.id !== undefined ? [o.id] : [])

async function vecApply(op: DesignOp): Promise<{ detail: string; changed: number }> {
  switch (op.op) {
    case 'hide':
    case 'show':
      for (const id of op.ids) await vecCommand('object.setProps', { id, visible: op.op === 'show' })
      return { detail: `${op.op} ${op.ids.join(', ')}`, changed: op.ids.length }
    case 'delete':
      await vecCommand('edit.clear', { ids: op.ids })
      return { detail: `deleted ${op.ids.join(', ')}`, changed: op.ids.length }
    case 'set_text':
      await vecCommand('text.setText', { id: op.id, text: op.text })
      return { detail: `text of ${op.id} → "${op.text.slice(0, 40)}"`, changed: 1 }
    case 'replace_text': {
      const r = (await vecCommand('edit.findReplace', { find: op.find, replace: op.replace ?? '', matchCase: true })) as { count?: number }
      if (!r?.count) throw new ToolError('NOT_APPLIED', `"${op.find}" was not found in any text object (a match cannot span two style runs).`, [])
      return { detail: `${r.count} replaced`, changed: r.count }
    }
    case 'move':
      await vecCommand('select.set', { ids: op.ids })
      await vecCommand('object.move', { dx: op.dx, dy: op.dy })
      await vecCommand('select.none', {})
      return { detail: `moved ${op.ids.join(', ')} by ${op.dx}, ${op.dy}`, changed: op.ids.length }
    case 'set_fill':
      await vecCommand('select.set', { ids: op.ids })
      await vecCommand('paint.setFill', { color: op.color })
      await vecCommand('select.none', {})
      return { detail: `fill of ${op.ids.join(', ')} → ${op.color}`, changed: op.ids.length }
    case 'rename':
      await vecCommand('object.setProps', { id: op.id, name: op.name })
      return { detail: `${op.id} named "${op.name}"`, changed: 1 }
    case 'duplicate': {
      const r = (await vecCommand('layer.duplicate', { ids: op.ids })) as { ids?: number[] }
      return { detail: `duplicated ${op.ids.join(', ')}${r?.ids ? ` → ${r.ids.join(', ')}` : ''}`, changed: op.ids.length }
    }
    case 'command': {
      const r = await vecCommand(op.command, op.params ?? {})
      return { detail: `${op.command} → ${JSON.stringify(r).slice(0, 160)}`, changed: 1 }
    }
  }
}

const PHOTO_COMMAND: Record<string, (op: DesignOp) => { command: string; params: Record<string, unknown> }[]> = {
  hide: (op) => ids(op as never).map((layer) => ({ command: 'layer.setProps', params: { layer, visible: false } })),
  show: (op) => ids(op as never).map((layer) => ({ command: 'layer.setProps', params: { layer, visible: true } })),
  delete: (op) => ids(op as never).map((layer) => ({ command: 'layer.delete', params: { layer } })),
  rename: (op) => [{ command: 'layer.renameLayer', params: { layer: (op as { id: number }).id, name: (op as { name: string }).name } }],
  set_text: (op) => [{ command: 'type.edit', params: { layer: (op as { id: number }).id, text: (op as { text: string }).text } }],
  move: (op) => ids(op as never).map((layer) => ({ command: 'layer.translate', params: { layer, dx: Math.round((op as { dx: number }).dx), dy: Math.round((op as { dy: number }).dy) } })),
  duplicate: (op) => ids(op as never).map((layer) => ({ command: 'layer.duplicate', params: { layer } })),
  set_fill: (op) => ids(op as never).map((layer) => ({ command: 'type.setStyle', params: { layer, color: (op as { color: string }).color } })),
}

/** PSD text layers whose text holds `find`: rewrite each with type.edit (styles kept). */
async function photoReplace(find: string, replace: string): Promise<number> {
  const d = (await photo('doc.inspect', {})) as Record<string, unknown>
  const all = flatten(normalisePhotoLayers(d), true, 100000).items.filter((l) => /type|text/i.test(l.kind))
  let n = 0
  for (const l of all) {
    const info = (await photo('engine.execute', { command: 'type.info', params: { layer: l.id } })) as { text?: string; result?: { text?: string } }
    const text = info?.text ?? info?.result?.text
    if (!text || !text.includes(find)) continue
    n += text.split(find).length - 1
    await photo('engine.execute', { command: 'type.edit', params: { layer: l.id, text: text.split(find).join(replace) } })
  }
  return n
}

async function photoApply(op: DesignOp): Promise<{ detail: string; changed: number }> {
  if (op.op === 'command') {
    const r = await photo('engine.execute', { command: op.command, params: op.params ?? {} })
    return { detail: `${op.command} → ${JSON.stringify(r).slice(0, 160)}`, changed: 1 }
  }
  if (op.op === 'replace_text') {
    const n = await photoReplace(op.find, op.replace ?? '')
    if (!n) throw new ToolError('NOT_APPLIED', `"${op.find}" is in no text layer.`, [])
    return { detail: `${n} replaced`, changed: n }
  }
  const make = PHOTO_COMMAND[op.op]
  if (!make) throw new ToolError('UNSUPPORTED', `${op.op} is not available for PSD yet. Use op "command" with an engine command (engine.commands lists them).`, [])
  const steps = make(op)
  for (const s of steps) await photo('engine.execute', s)
  return { detail: `${op.op} ${'ids' in op ? (op.ids ?? []).join(', ') : ''}`.trim(), changed: steps.length }
}

/** Write the open document to `out`, by its extension. */
async function save(kind: 'vector' | 'photo', out: string): Promise<void> {
  mkdirSync(dirname(out), { recursive: true })
  const ext = extname(out).slice(1).toLowerCase()
  if (kind === 'vector') {
    const native = ['ai', 'vectorcraft', 'svg', 'svgz', 'pdf', 'template'].includes(ext)
    if (ext === 'ai' || ext === 'vectorcraft' || ext === 'template') await vecCommand('document.save', { path: out, format: ext })
    else await vecCommand('document.export', { path: out, format: native && ext === 'pdf' ? 'pdf' : ext })
    return
  }
  await photo('doc.save', { path: out })
}

export async function editDesign(file: string, kind: 'vector' | 'photo', ops: DesignOp[], out: string | null) {
  const results: { op: string; detail: string; changed: number }[] = []
  if (kind === 'vector') await vecClose()
  if (kind === 'vector') await vecOpen(file)
  else await photo('doc.open', { path: file })
  try {
    for (const [i, op] of ops.entries()) {
      try {
        results.push({ op: op.op, ...(kind === 'vector' ? await vecApply(op) : await photoApply(op)) })
      } catch (err) {
        const e = err as ToolError
        throw new ToolError(e.code ?? 'ENGINE', `op ${i} (${op.op}): ${e.message}`, e.needs ?? [], { op: i, applied: results })
      }
    }
    // what the document says now, to check against the ops
    const now = kind === 'vector' ? flatten((await vecTree()).layers, true, 100000).items : flatten(normalisePhotoLayers((await photo('doc.inspect', {})) as Record<string, unknown>), true, 100000).items
    const byId = new Map(now.map((n) => [n.id, n]))
    const checks = ops.map((op, i) => {
      if (op.op === 'hide' || op.op === 'show') {
        const bad = op.ids.filter((id) => byId.get(id)?.visible !== (op.op === 'show'))
        return { op: i, ok: bad.length === 0, ...(bad.length ? { why: `still ${op.op === 'hide' ? 'visible' : 'hidden'}: ${bad.join(', ')}` } : {}) }
      }
      if (op.op === 'delete') {
        const bad = op.ids.filter((id) => byId.has(id))
        return { op: i, ok: bad.length === 0, ...(bad.length ? { why: `still there: ${bad.join(', ')}` } : {}) }
      }
      if (op.op === 'set_text') return { op: i, ok: byId.get(op.id)?.text === op.text }
      if (op.op === 'replace_text') {
        const left = now.filter((n) => n.text?.includes(op.find) && !op.replace.includes(op.find)).length
        return { op: i, ok: left === 0 }
      }
      return { op: i, ok: true }
    })
    let written: { path: string; bytes: number } | null = null
    if (out) {
      await save(kind, out)
      if (!existsSync(out)) throw new ToolError('VERIFY_FAILED', `The engine reported success but ${out} was not written.`, [])
      written = { path: out, bytes: statSync(out).size }
    }
    return { results, verify: { checks, objects: now.length, allConfirmed: checks.every((c) => c.ok), written } }
  } finally {
    if (kind === 'vector') await vecClose()
    else await photo('doc.close', {}).catch(() => undefined)
    endPhotoSession()
  }
}

/** PNG of the whole artboard / canvas, or of single objects (each cropped to itself). */
export async function renderDesign(file: string, kind: 'vector' | 'photo', dir: string, opts: { ids?: number[]; maxSide?: number }) {
  mkdirSync(dir, { recursive: true })
  const files: { path: string; id?: number }[] = []
  if (kind === 'vector') {
    await vecClose()
    await vecOpen(file)
    try {
      if (opts.ids?.length) {
        for (const id of opts.ids) {
          await vecCommand('select.set', { ids: [id] })
          const p = join(dir, `object-${id}.png`)
          await vecCommand('document.exportSelection', { path: p, format: 'png', scale: 1 })
          files.push({ path: p, id })
        }
      } else {
        const p = join(dir, 'artboard.png')
        await vecCommand('document.export', { path: p, format: 'png' })
        files.push({ path: p })
      }
    } finally {
      await vecClose()
    }
    return files
  }
  await photo('doc.open', { path: file })
  try {
    if (opts.ids?.length) {
      // one layer at a time: hide the others, render, put visibility back by reopening
      const all = flatten(normalisePhotoLayers((await photo('doc.inspect', {})) as Record<string, unknown>), true, 100000).items
      for (const id of opts.ids) {
        for (const l of all) await photo('engine.execute', { command: 'layer.setProps', params: { layer: l.id, visible: l.id === id || isAncestor(all, l.id, id) || isAncestor(all, id, l.id) } })
        const p = join(dir, `layer-${id}.png`)
        await photo('doc.render', { path: p, maxSide: opts.maxSide ?? 1024 })
        files.push({ path: p, id })
      }
    } else {
      const p = join(dir, 'canvas.png')
      await photo('doc.render', { path: p, maxSide: opts.maxSide ?? 1600 })
      files.push({ path: p })
    }
  } finally {
    await photo('doc.close', {}).catch(() => undefined)
    endPhotoSession()
  }
  return files
}

/** Is `maybe` a group holding `id` (by the flat list's depth order)? */
function isAncestor(all: Item[], maybe: number, id: number): boolean {
  const i = all.findIndex((x) => x.id === maybe)
  const j = all.findIndex((x) => x.id === id)
  if (i < 0 || j < 0 || j < i) return false
  for (let k = i + 1; k <= j; k++) if (all[k]!.depth <= all[i]!.depth) return false
  return true
}

/** Fill one template copy: replace each find with its value, write `out`. */
export async function fillDesign(file: string, kind: 'vector' | 'photo', pairs: { find: string; value: string }[], out: string) {
  if (kind === 'vector') {
    await vecClose()
    await vecOpen(file)
  } else await photo('doc.open', { path: file })
  try {
    const filled: Record<string, number> = {}
    for (const p of pairs) {
      try {
        if (kind === 'vector') {
          const r = (await vecCommand('edit.findReplace', { find: p.find, replace: p.value, matchCase: true })) as { count?: number }
          filled[p.find] = r?.count ?? 0
        } else filled[p.find] = await photoReplace(p.find, p.value)
      } catch {
        filled[p.find] = 0
      }
    }
    await save(kind, out)
    return { filled }
  } finally {
    if (kind === 'vector') await vecClose()
    else await photo('doc.close', {}).catch(() => undefined)
    endPhotoSession()
  }
}

export function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 1))
}
