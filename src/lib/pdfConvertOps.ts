/**
 * 되살린 PDF 를 워드와 엑셀 파일로 쓴다.
 *
 * DOCX 는 직접 짠다. 라이브러리를 들이는 대신 필요한 XML 만 쓰는 이유는, 우리가
 * 넣는 것이 문단과 표뿐이라 규격의 아주 작은 일부만 있으면 되고, 워드 파일
 * 하나 만들자고 번들에 수백 KB 를 더할 이유가 없어서다. 압축은 이미 쓰고 있는
 * fflate 가 한다.
 *
 * 스타일 파일을 넣지 않고 서식을 문단에 직접 건다. styles.xml 없이 pStyle 로
 * 제목을 가리키면 워드가 파일을 열기는 해도 그 이름의 스타일이 없어 본문과
 * 똑같이 보인다. 굵게와 크기를 직접 주면 어디서 열어도 제목처럼 보인다.
 *
 * 엑셀은 SheetJS 가 만든 zip 을 열어 그림 부품만 끼워 넣는다. 그 라이브러리는
 * 그림을 넣지 못하지만 XLSX 도 결국 XML 을 압축한 것이라, DOCX 와 같은 방식으로
 * 직접 쓸 수 있다. 그림은 표 아래에 모아 앉힌다. 칸 위에 떠 있으면 계산을
 * 방해하지만, 아무 말 없이 버리면 원본에 있던 것이 사라진다.
 *
 * 문서 정보(docProps)는 일부러 넣지 않는다. 우리가 만든 파일에 우리가 지어낸
 * 작성자를 적을 이유가 없다. 이 사이트에는 그 기록을 들춰 보는 도구가 따로
 * 있는데, 만드는 쪽에서 없는 이름을 새로 심으면 앞뒤가 맞지 않는다.
 */
import type { ImageBlock, LayoutBlock, PageLayout, PdfLayout } from './pdfLayout'

/* ------------------------------------------------------------------ 도구 */

/** XML 1.0 이 금지한 제어문자. 남겨 두면 워드가 파일을 아예 거부한다. */
const FORBIDDEN = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f]', 'g')

function esc(value: string): string {
  return value
    .replace(FORBIDDEN, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

/* ------------------------------------------------------------------ DOCX */

function runXml(text: string, heading: boolean): string {
  const props = heading ? '<w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr>' : ''
  return `<w:r>${props}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`
}

function paragraphXml(text: string, heading: boolean): string {
  const spacing = heading
    ? '<w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr>'
    : '<w:pPr><w:spacing w:after="120"/></w:pPr>'
  return `<w:p>${spacing}${runXml(text, heading)}</w:p>`
}

function tableXml(rows: string[][]): string {
  const columns = Math.max(...rows.map((r) => r.length), 1)
  // 표 전체를 본문 너비에 맞추고 열은 고르게 나눈다. 원본의 열 너비까지
  // 흉내 내면 글자가 잘리는 쪽이 더 많았다.
  const grid = Array.from({ length: columns }, () => '<w:gridCol w:w="1200"/>').join('')
  const border = (side: string) =>
    `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`
  const borders = `<w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map(border)
    .join('')}</w:tblBorders>`

  const body = rows
    .map((row) => {
      const cells = Array.from({ length: columns }, (_, i) => row[i] ?? '')
        .map(
          (cell) =>
            '<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>' +
            `<w:p><w:pPr><w:spacing w:after="0"/></w:pPr>${runXml(cell, false)}</w:p></w:tc>`,
        )
        .join('')
      return `<w:tr>${cells}</w:tr>`
    })
    .join('')

  // 표 바로 뒤에는 문단이 있어야 한다. 없으면 워드가 문서를 고치려 든다.
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>${borders}</w:tblPr>` +
    `<w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl><w:p/>`
  )
}


/* ----------------------------------------------------------- DOCX 그림 */

/** 1포인트는 12700 EMU. 오피스 도형은 전부 이 단위를 쓴다. */
const EMU_PER_POINT = 12700

/** A4 세로에서 여백 1인치를 뺀 본문 너비(pt). */
const TEXT_WIDTH_POINTS = 451

/** 본문보다 넓은 그림은 비율을 지킨 채 줄인다. 안 줄이면 오른쪽이 잘린다. */
function fitToText(block: ImageBlock): { width: number; height: number } {
  if (block.width <= TEXT_WIDTH_POINTS) return { width: block.width, height: block.height }
  const ratio = TEXT_WIDTH_POINTS / block.width
  return { width: TEXT_WIDTH_POINTS, height: block.height * ratio }
}

function drawingXml(block: ImageBlock, relationId: string, index: number): string {
  const { width, height } = fitToText(block)
  const cx = Math.max(1, Math.round(width * EMU_PER_POINT))
  const cy = Math.max(1, Math.round(height * EMU_PER_POINT))
  const name = `Picture ${index}`
  return (
    '<w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r><w:drawing>' +
    '<wp:inline distT="0" distB="0" distL="0" distR="0">' +
    `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:docPr id="${index}" name="${name}"/>` +
    '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    `<pic:pic><pic:nvPicPr><pic:cNvPr id="${index}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${relationId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>' +
    '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
  )
}

function blocksXml(blocks: LayoutBlock[], pictures: Map<ImageBlock, string>, counter: { n: number }): string {
  return blocks
    .map((block) => {
      if (block.kind === 'table') return tableXml(block.rows)
      if (block.kind === 'image') {
        const relationId = pictures.get(block)
        if (!relationId) return ''
        counter.n += 1
        return drawingXml(block, relationId, counter.n)
      }
      return paragraphXml(block.text, block.heading)
    })
    .join('')
}

const PAGE_BREAK = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'

/** A4 세로, 여백 1인치(1440 twip). */
const SECTION =
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
  '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>' +
  '</w:sectPr>'

export async function layoutToDocx(layout: PdfLayout): Promise<Blob> {
  const { zipSync } = await import('fflate')

  // 그림마다 관계 번호를 하나씩 준다. rId1 은 문서 자신이 쓰고 있다.
  const pictures = new Map<ImageBlock, string>()
  const media: Record<string, Uint8Array> = {}
  for (const page of layout.pages) {
    for (const block of page.blocks) {
      if (block.kind !== 'image') continue
      const index = pictures.size + 1
      pictures.set(block, `rId${index + 1}`)
      media[`word/media/image${index}.png`] = block.bytes
    }
  }

  const counter = { n: 0 }
  const body = layout.pages
    .map((page) => blocksXml(page.blocks, pictures, counter))
    .filter((xml) => xml.length > 0)
    .join(PAGE_BREAK)

  const document =
    XML_HEAD +
    '<w:document ' +
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    `<w:body>${body}${SECTION}</w:body></w:document>`

  const contentTypes =
    XML_HEAD +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    (pictures.size > 0 ? '<Default Extension="png" ContentType="image/png"/>' : '') +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>'

  const rels =
    XML_HEAD +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>'

  const pictureRels = [...pictures.values()]
    .map(
      (id, i) =>
        `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${i + 1}.png"/>`,
    )
    .join('')

  const documentRels =
    XML_HEAD +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    pictureRels +
    '</Relationships>'

  const encoder = new TextEncoder()
  const bytes = zipSync({
    '[Content_Types].xml': encoder.encode(contentTypes),
    '_rels/.rels': encoder.encode(rels),
    'word/document.xml': encoder.encode(document),
    'word/_rels/document.xml.rels': encoder.encode(documentRels),
    ...media,
  })

  return new Blob([bytes.slice().buffer as ArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })
}

/* ------------------------------------------------------------------ XLSX */

/** 쪽 하나를 표 한 장으로 편다. 표가 아닌 줄도 그대로 한 줄씩 담는다. */
function pageToRows(page: PageLayout): string[][] {
  const rows: string[][] = []
  for (const block of page.blocks) {
    if (block.kind === 'table') {
      rows.push(...block.rows)
      rows.push([])
    } else if (block.kind === 'paragraph') {
      rows.push([block.text])
    }
    // 그림은 칸이 아니라 시트 위에 떠 있는 물건이라 행으로 담지 않는다.
    // 표 아래에 따로 앉힌다(attachSheetImages 참고).
  }
  // 끝에 남은 빈 줄은 덜어 낸다.
  while (rows.length > 0 && rows[rows.length - 1]!.length === 0) rows.pop()
  return rows
}

export interface XlsxOptions {
  /** 시트 이름. 언어마다 달라야 해서 화면에서 넘긴다. */
  sheetName: (page: number) => string
}

/* ----------------------------------------------------------- XLSX 그림 */

/** 그림 사이에 두는 빈 줄 수. 붙여 놓으면 어디까지가 한 장인지 알기 어렵다. */
const IMAGE_ROW_GAP = 1

/** 엑셀 기본 행 높이는 20pt 쯤이다. 그림이 몇 줄을 차지하는지 셀 때 쓴다. */
const ROW_HEIGHT_POINTS = 20

interface SheetImages {
  /** 1부터 세는 시트 번호. SheetJS 가 붙이는 sheet1.xml 과 같은 번호다. */
  index: number
  /** 데이터가 끝난 다음 줄. 여기서부터 그림을 앉힌다. */
  startRow: number
  blocks: ImageBlock[]
}

function drawingXmlForSheet(sheet: SheetImages): string {
  let row = sheet.startRow
  const anchors = sheet.blocks
    .map((block, i) => {
      const { width, height } = fitToText(block)
      const cx = Math.max(1, Math.round(width * EMU_PER_POINT))
      const cy = Math.max(1, Math.round(height * EMU_PER_POINT))
      const at = row
      row += Math.ceil(height / ROW_HEIGHT_POINTS) + IMAGE_ROW_GAP
      const id = i + 1
      return (
        '<xdr:oneCellAnchor>' +
        `<xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${at}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
        `<xdr:ext cx="${cx}" cy="${cy}"/>` +
        `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${id}" name="Picture ${id}"/><xdr:cNvPicPr/></xdr:nvPicPr>` +
        `<xdr:blipFill><a:blip r:embed="rId${id}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
        `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>' +
        '<xdr:clientData/></xdr:oneCellAnchor>'
      )
    })
    .join('')

  return (
    XML_HEAD +
    '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    anchors +
    '</xdr:wsDr>'
  )
}

/**
 * SheetJS 가 만든 통합 문서에 그림 부품을 끼워 넣는다.
 *
 * 손대는 곳은 네 군데다. 시트 XML 에 `<drawing>` 한 줄, 시트의 관계 파일,
 * 그림 XML 과 그 관계 파일, 그리고 content-types 에 그림 부품 등록. png 확장자는
 * SheetJS 가 이미 등록해 두어서 더하지 않아도 된다.
 */
async function attachSheetImages(
  workbook: ArrayBuffer,
  sheets: SheetImages[],
): Promise<Uint8Array> {
  const { unzipSync, zipSync } = await import('fflate')
  const files = unzipSync(new Uint8Array(workbook))
  const encoder = new TextEncoder()
  const decoder = new TextDecoder('utf-8')

  let mediaCount = 0
  for (const sheet of sheets) {
    if (sheet.blocks.length === 0) continue

    const drawingName = `drawing${sheet.index}.xml`
    const sheetPath = `xl/worksheets/sheet${sheet.index}.xml`
    const source = files[sheetPath]
    if (!source) continue

    // 시트 본문에 그림을 가리키는 한 줄을 더한다. 규격상 맨 끝이라야 한다.
    const xml = decoder.decode(source)
    files[sheetPath] = encoder.encode(
      xml.replace('</worksheet>', '<drawing r:id="rId1"/></worksheet>'),
    )

    files[`xl/worksheets/_rels/sheet${sheet.index}.xml.rels`] = encoder.encode(
      XML_HEAD +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/${drawingName}"/>` +
        '</Relationships>',
    )

    files[`xl/drawings/${drawingName}`] = encoder.encode(drawingXmlForSheet(sheet))

    const imageRels = sheet.blocks
      .map((block, i) => {
        mediaCount += 1
        // fflate 는 ArrayBuffer 를 등에 진 배열만 받는다. 한 번 베껴 넘긴다.
        files[`xl/media/image${mediaCount}.png`] = new Uint8Array(block.bytes)
        return `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${mediaCount}.png"/>`
      })
      .join('')

    files[`xl/drawings/_rels/${drawingName}.rels`] = encoder.encode(
      XML_HEAD +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        imageRels +
        '</Relationships>',
    )
  }

  if (mediaCount > 0 && files['[Content_Types].xml']) {
    const overrides = sheets
      .filter((sheet) => sheet.blocks.length > 0)
      .map(
        (sheet) =>
          `<Override PartName="/xl/drawings/drawing${sheet.index}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`,
      )
      .join('')
    files['[Content_Types].xml'] = encoder.encode(
      decoder.decode(files['[Content_Types].xml']!).replace('</Types>', `${overrides}</Types>`),
    )
  }

  return zipSync(files)
}

export async function layoutToXlsx(layout: PdfLayout, options: XlsxOptions): Promise<Blob> {
  const XLSX = await import('xlsx')
  const book = XLSX.utils.book_new()

  const sheets: SheetImages[] = []
  let added = 0

  for (const page of layout.pages) {
    const rows = pageToRows(page)
    const images = page.blocks.filter((block): block is ImageBlock => block.kind === 'image')
    if (rows.length === 0 && images.length === 0) continue

    const sheet = XLSX.utils.aoa_to_sheet(rows.length > 0 ? rows : [[]])
    // 엑셀이 금지하는 글자와 31자 제한이 있다. 넘으면 파일이 열리지 않는다.
    const name = options
      .sheetName(page.page)
      .replace(/[[\]:*?/\\]/g, ' ')
      .slice(0, 31)
    XLSX.utils.book_append_sheet(book, sheet, name || String(page.page))
    added += 1

    if (images.length > 0) {
      // 표 아래 한 줄을 띄우고 앉힌다. 행 번호는 0부터 센다.
      sheets.push({ index: added, startRow: rows.length + 1, blocks: images })
    }
  }

  if (added === 0) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[]]), '1')

  const out = XLSX.write(book, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
  const bytes = sheets.some((sheet) => sheet.blocks.length > 0)
    ? await attachSheetImages(out, sheets)
    : new Uint8Array(out)

  return new Blob([bytes.slice().buffer as ArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}
