/**
 * HWP·HWPX 본문을 구조째 읽는다: 문단, 표(셀 주소·병합), 표 안의 표, 글상자.
 *
 * 예전에는 쪽을 그린 SVG 에서 글자를 줄로 다시 묶었다(text.ts). 표 칸의 경계가 없어서 칸 내용이
 * 한 줄로 섞이고, 글상자 글자는 글자마다 좌표로 찍혀 띄어쓰기가 사라졌다(2026-11 공고문 실측).
 * 여기서는 엔진이 HWPX(OWPML)로 내보낸 XML 을 읽는다. 표는 hp:tbl / hp:tr / hp:tc 와 각 칸의
 * hp:cellAddr(행·열)·hp:cellSpan(병합)을, 글상자는 도형의 hp:drawText 를, 글자는 hp:t 를 그대로 쓴다.
 * 순서는 본문 흐름(글상자는 놓인 문단 자리)이고, 칸 순서는 원본 셀 주소 기준이다.
 */
import { unzipSync, strFromU8 } from 'fflate'
import { DOMParser } from 'linkedom'

export interface HwpCell {
  row: number
  col: number
  rowSpan: number
  colSpan: number
  blocks: HwpBlock[]
}
export interface HwpTable {
  kind: 'table'
  id: string
  rows: number
  cols: number
  cells: HwpCell[]
  /** 표 안의 표면 1 이상 */
  depth: number
}
export interface HwpParagraph {
  kind: 'paragraph'
  text: string
}
export interface HwpTextBox {
  kind: 'textbox'
  shape: string
  blocks: HwpBlock[]
}
export type HwpBlock = HwpParagraph | HwpTable | HwpTextBox

export interface HwpStructure {
  sections: HwpBlock[][]
  footnotes: string[]
  stats: { tables: number; nestedTables: number; mergedCells: number; textBoxes: number; paragraphs: number }
}

/** 접두사 없는 이름(hp:tbl → tbl) */
const local = (el: Element) => (el.localName || el.tagName).replace(/^.*:/, '')
const kids = (el: Element) => Array.from(el.childNodes).filter((n): n is Element => n.nodeType === 1)
const num = (v: string | null, d = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

/** 글자를 담은 도형(글상자가 될 수 있는 것) */
const SHAPES = new Set(['rect', 'ellipse', 'arc', 'polygon', 'curve', 'line', 'connectLine', 'container', 'textart'])

export function parseHwpx(hwpx: Uint8Array, maxDepth = 4): HwpStructure {
  const files = unzipSync(hwpx, { filter: (f) => /^Contents\/section\d+\.xml$/.test(f.name) })
  const names = Object.keys(files).sort((a, b) => num(/(\d+)\.xml$/.exec(a)?.[1] ?? null) - num(/(\d+)\.xml$/.exec(b)?.[1] ?? null))
  const stats = { tables: 0, nestedTables: 0, mergedCells: 0, textBoxes: 0, paragraphs: 0 }
  const footnotes: string[] = []
  let tableNo = 0

  function paragraphs(list: Element[], depth: number): HwpBlock[] {
    const out: HwpBlock[] = []
    for (const el of list) {
      if (local(el) === 'p') out.push(...paragraph(el, depth))
    }
    return out
  }

  /** 한 문단: 글자 + 그 안에 놓인 표·글상자(놓인 자리 차례). 글자는 개체를 만나면 끊는다. */
  function paragraph(p: Element, depth: number): HwpBlock[] {
    const out: HwpBlock[] = []
    let text = ''
    const flush = () => {
      if (text.replace(/\s+/g, '') !== '') {
        out.push({ kind: 'paragraph', text: text.replace(/[ \t]+$/g, '') })
        stats.paragraphs++
      }
      text = ''
    }
    const walk = (el: Element) => {
      for (const c of kids(el)) {
        const n = local(c)
        if (n === 't') text += textOf(c)
        else if (n === 'tbl') {
          flush()
          out.push(table(c, depth))
        } else if (SHAPES.has(n)) {
          const box = textBox(c, depth)
          if (box) {
            flush()
            out.push(box)
          }
        } else if (n === 'footNote' || n === 'endNote') {
          const sub = kids(c).find((x) => local(x) === 'subList')
          if (sub) {
            const body = plain(paragraphs(kids(sub), depth))
            footnotes.push(body)
            text += `[^${footnotes.length}]`
          }
        } else if (n === 'ctrl' || n === 'run' || n === 'compose' || n === 'fieldBegin') walk(c)
        // secPr, linesegarray, header·footer(쪽마다 되풀이되는 머리말·꼬리말), 그림, 수식은 건너뛴다
      }
    }
    walk(p)
    flush()
    return out
  }

  /** hp:t 안: 글자와 탭·줄바꿈 표시 */
  function textOf(t: Element): string {
    let s = ''
    for (const n of Array.from(t.childNodes)) {
      if (n.nodeType === 3) s += n.textContent ?? ''
      else if (n.nodeType === 1) {
        const k = local(n as Element)
        if (k === 'tab') s += '\t'
        else if (k === 'lineBreak') s += '\n'
        else if (k === 'nbSpace' || k === 'fwSpace' || k === 'hyphen') s += k === 'hyphen' ? '-' : ' '
        else s += (n as Element).textContent ?? ''
      }
    }
    return s
  }

  function table(tbl: Element, depth: number): HwpTable {
    stats.tables++
    if (depth > 0) stats.nestedTables++
    tableNo++
    const t: HwpTable = {
      kind: 'table',
      id: `T${tableNo}`,
      rows: num(tbl.getAttribute('rowCnt')),
      cols: num(tbl.getAttribute('colCnt')),
      cells: [],
      depth,
    }
    for (const tr of kids(tbl).filter((x) => local(x) === 'tr')) {
      for (const tc of kids(tr).filter((x) => local(x) === 'tc')) {
        const addr = kids(tc).find((x) => local(x) === 'cellAddr')
        const span = kids(tc).find((x) => local(x) === 'cellSpan')
        const sub = kids(tc).find((x) => local(x) === 'subList')
        const cell: HwpCell = {
          row: num(addr?.getAttribute('rowAddr') ?? null),
          col: num(addr?.getAttribute('colAddr') ?? null),
          rowSpan: Math.max(1, num(span?.getAttribute('rowSpan') ?? null, 1)),
          colSpan: Math.max(1, num(span?.getAttribute('colSpan') ?? null, 1)),
          blocks: sub && depth < maxDepth ? paragraphs(kids(sub), depth + 1) : sub ? [{ kind: 'paragraph', text: plain(paragraphs(kids(sub), depth + 1)) }] : [],
        }
        if (cell.rowSpan > 1 || cell.colSpan > 1) stats.mergedCells++
        t.cells.push(cell)
      }
    }
    t.cells.sort((a, b) => a.row - b.row || a.col - b.col)
    if (!t.rows) t.rows = Math.max(0, ...t.cells.map((c) => c.row + c.rowSpan))
    if (!t.cols) t.cols = Math.max(0, ...t.cells.map((c) => c.col + c.colSpan))
    return t
  }

  function textBox(shape: Element, depth: number): HwpTextBox | null {
    // 묶은 도형(container)은 안쪽 도형마다
    if (local(shape) === 'container') {
      const inner = kids(shape).filter((x) => SHAPES.has(local(x))).map((x) => textBox(x, depth)).filter((x): x is HwpTextBox => !!x)
      if (!inner.length) return null
      return { kind: 'textbox', shape: 'group', blocks: inner }
    }
    const draw = kids(shape).find((x) => local(x) === 'drawText')
    const sub = draw && kids(draw).find((x) => local(x) === 'subList')
    if (!sub) return null
    const blocks = paragraphs(kids(sub), depth)
    if (!blocks.length) return null
    stats.textBoxes++
    return { kind: 'textbox', shape: local(shape), blocks }
  }

  const sections: HwpBlock[][] = []
  const parser = new DOMParser()
  for (const name of names) {
    const xml = strFromU8(files[name]!)
    const dom = parser.parseFromString(xml, 'text/xml')
    const root = dom.documentElement as unknown as Element
    sections.push(paragraphs(kids(root), 0))
  }
  return { sections, footnotes, stats }
}

/* ── 출력 ── */

/** 글자만(줄바꿈으로 이은 것). 깊이 제한을 넘은 표 등에 쓴다. */
export function plain(blocks: HwpBlock[]): string {
  const out: string[] = []
  for (const b of blocks) {
    if (b.kind === 'paragraph') out.push(b.text)
    else if (b.kind === 'textbox') out.push(plain(b.blocks))
    else for (const c of b.cells) out.push(plain(c.blocks))
  }
  return out.filter((s) => s !== '').join('\n')
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** 병합 없고 안에 표·글상자가 없는 표는 마크다운 표로 쓸 수 있다 */
function simple(t: HwpTable): boolean {
  return t.cells.every((c) => c.rowSpan === 1 && c.colSpan === 1 && c.blocks.every((b) => b.kind === 'paragraph'))
}

function cellLines(c: HwpCell): string[] {
  return c.blocks.map((b) => (b.kind === 'paragraph' ? b.text : plain([b]))).flatMap((s) => s.split('\n'))
}

function mdTable(t: HwpTable): string {
  const grid: string[][] = Array.from({ length: t.rows }, () => Array.from({ length: t.cols }, () => ''))
  for (const c of t.cells) {
    if (grid[c.row] && c.col < t.cols) grid[c.row]![c.col] = cellLines(c).map((s) => s.trim()).filter(Boolean).join('<br>').replace(/\|/g, '\\|').replace(/\t/g, ' ')
  }
  const line = (r: string[]) => `| ${r.join(' | ')} |`
  const head = grid[0] ?? []
  return [line(head), line(head.map(() => '---')), ...grid.slice(1).map(line)].join('\n')
}

function htmlTable(t: HwpTable, indent = ''): string {
  const out: string[] = [`${indent}<table>`]
  for (let r = 0; r < t.rows; r++) {
    const row = t.cells.filter((c) => c.row === r)
    if (!row.length) continue
    out.push(`${indent}  <tr>`)
    for (const c of row) {
      const attrs = (c.rowSpan > 1 ? ` rowspan="${c.rowSpan}"` : '') + (c.colSpan > 1 ? ` colspan="${c.colSpan}"` : '')
      const inner: string[] = []
      for (const b of c.blocks) {
        if (b.kind === 'paragraph') inner.push(esc(b.text.trim()).replace(/\n/g, '<br>'))
        else if (b.kind === 'table') inner.push('\n' + htmlTable(b, indent + '      ') + '\n' + indent + '    ')
        else inner.push(`[Text box] ${esc(plain(b.blocks)).replace(/\n/g, '<br>')}`)
      }
      out.push(`${indent}    <td${attrs}>${inner.filter(Boolean).join('<br>')}</td>`)
    }
    out.push(`${indent}  </tr>`)
  }
  out.push(`${indent}</table>`)
  return out.join('\n')
}

function textTable(t: HwpTable, indent = ''): string {
  const out: string[] = []
  for (let r = 0; r < t.rows; r++) {
    const row = t.cells.filter((c) => c.row === r)
    if (!row.length) continue
    out.push(indent + row.map((c) => cellLines(c).map((s) => s.trim()).filter(Boolean).join(' / ') + (c.rowSpan > 1 || c.colSpan > 1 ? ' (merged)' : '')).join(' | '))
    for (const c of row) for (const b of c.blocks) if (b.kind === 'table') out.push(textTable(b, indent + '    '))
  }
  return out.join('\n')
}

export function hwpToMarkdown(s: HwpStructure, format: 'markdown' | 'text'): string {
  const out: string[] = []
  const block = (b: HwpBlock, quote: string) => {
    if (b.kind === 'paragraph') out.push(b.text.split('\n').map((l) => quote + l).join('\n'))
    else if (b.kind === 'table') {
      // 칸 하나짜리 표(글을 테두리 상자에 넣은 것)는 표로 쓰지 않고 상자 안 글로
      if (b.rows === 1 && b.cols === 1 && b.cells.length === 1 && simple(b)) {
        const lines = cellLines(b.cells[0]!)
        out.push(lines.map((l) => (format === 'markdown' ? '> ' : '    ') + l).join('\n'))
      } else out.push(format === 'text' ? textTable(b) : simple(b) ? mdTable(b) : htmlTable(b))
    }
    else {
      out.push(`${quote}[Text box]`)
      for (const x of b.blocks) block(x, format === 'markdown' ? '> ' : '    ')
    }
  }
  s.sections.forEach((sec, i) => {
    if (i > 0) out.push('')
    for (const b of sec) block(b, '')
  })
  if (s.footnotes.length) {
    out.push('')
    s.footnotes.forEach((f, i) => out.push(`[^${i + 1}]: ${f.replace(/\n/g, ' ')}`))
  }
  return out.join('\n\n').replace(/\n{3,}/g, '\n\n')
}

export function structureSummary(s: HwpStructure, format: 'markdown' | 'text' | 'json'): string {
  const { tables, nestedTables, mergedCells, textBoxes } = s.stats
  const how =
    format === 'markdown'
      ? 'Tables without merged cells are Markdown tables; tables with merged cells or tables inside them are HTML <table> with rowspan/colspan, in reading order.'
      : format === 'text'
        ? 'Table rows are one line each, cells separated by " | ", merged cells marked "(merged)", inner tables indented under their row.'
        : 'JSON: sections > blocks (paragraph, table with cells {row, col, rowSpan, colSpan, blocks}, textbox).'
  return `[Tables: ${tables} (${nestedTables} nested), merged cells: ${mergedCells}, text boxes: ${textBoxes}. ${how}]`
}
