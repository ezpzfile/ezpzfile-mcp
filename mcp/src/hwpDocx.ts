// HWP·HWPX → DOCX. hwpStructure.ts 로 읽은 구조를 그대로 Word 문서로 옮긴다.
// 표는 칸 주소대로(병합은 gridSpan·vMerge), 표 안의 표는 칸 안의 표로, 글상자는 테두리 두른 문단으로.
// 글꼴·크기·쪽 배치는 옮기지 않는다(글과 표의 짜임만). 되읽어 표 수를 대조한다.
import { strToU8, zipSync } from 'fflate'
import mammoth from 'mammoth'
import type { HwpBlock, HwpStructure, HwpTable } from './hwpStructure'

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function runs(text: string): string {
  const out: string[] = []
  const parts = text.split(/(\t|\n)/)
  for (const p of parts) {
    if (p === '\t') out.push('<w:r><w:tab/></w:r>')
    else if (p === '\n') out.push('<w:r><w:br/></w:r>')
    else if (p) out.push(`<w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r>`)
  }
  return out.join('')
}

const para = (text: string, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${runs(text)}</w:p>`

const BOX =
  '<w:pBdr><w:top w:val="single" w:sz="4" w:space="4" w:color="808080"/><w:left w:val="single" w:sz="4" w:space="4" w:color="808080"/>' +
  '<w:bottom w:val="single" w:sz="4" w:space="4" w:color="808080"/><w:right w:val="single" w:sz="4" w:space="4" w:color="808080"/></w:pBdr>'

function blocks(list: HwpBlock[], inBox = false): string {
  return list
    .map((b) => {
      if (b.kind === 'paragraph') return para(b.text, inBox ? BOX : '')
      if (b.kind === 'textbox') return blocks(b.blocks, true)
      return table(b)
    })
    .join('')
}

function table(t: HwpTable): string {
  const cols = Math.max(1, t.cols)
  const width = Math.floor(9000 / cols)
  const grid = `<w:tblGrid>${`<w:gridCol w:w="${width}"/>`.repeat(cols)}</w:tblGrid>`
  const border = (s: string) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`
  const tblPr = `<w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr>`
  const rows: string[] = []
  for (let r = 0; r < Math.max(1, t.rows); r += 1) {
    const tcs: string[] = []
    let c = 0
    while (c < cols) {
      const start = t.cells.find((x) => x.row === r && x.col === c)
      const over = start ?? t.cells.find((x) => x.row < r && x.row + x.rowSpan > r && x.col === c)
      if (!over) {
        // 칸 주소에 없는 자리(좌표가 어긋난 표): 빈 칸으로 채운다
        const inside = t.cells.find((x) => x.row <= r && x.row + x.rowSpan > r && x.col < c && x.col + x.colSpan > c)
        if (inside) {
          c += 1
          continue
        }
        tcs.push(`<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr><w:p/></w:tc>`)
        c += 1
        continue
      }
      const span = Math.max(1, Math.min(over.colSpan, cols - c))
      const pr = [`<w:tcW w:w="${width * span}" w:type="dxa"/>`]
      if (span > 1) pr.push(`<w:gridSpan w:val="${span}"/>`)
      if (over.rowSpan > 1) pr.push(start ? '<w:vMerge w:val="restart"/>' : '<w:vMerge/>')
      let body = start ? blocks(over.blocks) : ''
      // 칸은 문단으로 끝나야 한다
      if (!body.endsWith('</w:p>')) body += '<w:p/>'
      tcs.push(`<w:tc><w:tcPr>${pr.join('')}</w:tcPr>${body}</w:tc>`)
      c += span
    }
    rows.push(`<w:tr>${tcs.join('')}</w:tr>`)
  }
  // 표 바로 뒤에 표가 오면 Word 가 둘을 붙이므로 빈 문단을 둔다
  return `<w:tbl>${tblPr}${grid}${rows.join('')}</w:tbl><w:p/>`
}

function countTables(list: HwpBlock[]): number {
  let n = 0
  for (const b of list) {
    if (b.kind === 'table') n += 1 + b.cells.reduce((k, c) => k + countTables(c.blocks), 0)
    else if (b.kind === 'textbox') n += countTables(b.blocks)
  }
  return n
}

export async function hwpStructureToDocx(s: HwpStructure): Promise<{ docx: Uint8Array; stats: { tables: number; tablesBack: number; paragraphs: number } }> {
  const sections = s.sections.map((sec) => blocks(sec))
  let body = sections.join('<w:p><w:r><w:br w:type="page"/></w:r></w:p>')
  if (s.footnotes.length) {
    body += para('') + s.footnotes.map((f, i) => para(`[^${i + 1}] ${f}`)).join('')
  }
  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    body +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>' +
    '</w:body></w:document>'
  const styles =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr>' +
    '<w:rFonts w:ascii="Malgun Gothic" w:hAnsi="Malgun Gothic" w:eastAsia="맑은 고딕" w:cs="Malgun Gothic"/><w:sz w:val="20"/><w:lang w:eastAsia="ko-KR"/>' +
    '</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="60" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults></w:styles>'
  const files = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    'word/_rels/document.xml.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    ),
    'word/document.xml': strToU8(document),
    'word/styles.xml': strToU8(styles),
  }
  const docx = zipSync(files, { level: 6 })
  // 되읽어 표 수를 센다
  const html = (await mammoth.convertToHtml({ buffer: Buffer.from(docx) })).value
  const tablesBack = (html.match(/<table/g) ?? []).length
  return { docx, stats: { tables: s.sections.reduce((n, sec) => n + countTables(sec), 0), tablesBack, paragraphs: s.stats.paragraphs } }
}
