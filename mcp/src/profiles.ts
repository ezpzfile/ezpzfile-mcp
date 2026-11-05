/**
 * Format profiles, served as MCP resources at ezpzfile://formats/<format>.
 *
 * A profile says what this server can do with a format and by which rules, so an
 * agent can plan a chain of calls without trying things to see what breaks. Every
 * entry describes what the code here does. Where we do not know (a limit the
 * engine does not publish, a property we never measured), the value is the string
 * "unknown". Do not fill those in by guessing.
 */

export interface FormatProfile {
  format: string
  extensions: string[]
  engine: string
  /** How the tools address the document's parts */
  structure: string[]
  /** What each tool can do with it */
  read: string[]
  edit: { op: string; does: string }[]
  convertTo: string[]
  create: string
  render: string
  /** Rules an edit must keep. Breaking one returns error code RULE */
  rules: string[]
  units: Record<string, string>
  /** What the tools check when they reopen what they wrote */
  validation: string[]
  limits: Record<string, string | number>
  notes?: string[]
}

const UNKNOWN = 'unknown'

const HWP_STRUCTURE = [
  'sections[] > blocks[]. A block is a paragraph, a table or a text box, in reading order.',
  'Paragraph address: {section, paragraph} counted from 0 in the body (as doc_inspect lists them).',
  'Table address: {table} = the table number in reading order counted from 0 over the whole document, nested tables included (doc_inspect lists each with its section, paragraph, rows, cols and depth).',
  'Cell address: {table, row, col} counted from 0. A merged cell is addressed by its top-left cell; the cells it covers do not exist on their own.',
  'Text boxes, headers, footers and footnotes are read but not addressed by doc_edit.',
]

const HWP_EDIT = [
  { op: 'replace_text', does: 'Replace every occurrence of `find` with `replace`, in the body and in table cells. Formatting of the first replaced character is kept.' },
  { op: 'set_cell', does: 'Replace the whole text of one table cell, {table, row, col, text}. Newlines in text become paragraphs in the cell.' },
  { op: 'insert_paragraph', does: 'Insert a paragraph of `text` after body paragraph {section, paragraph}. It takes that paragraph\'s formatting.' },
  { op: 'delete_paragraph', does: 'Delete body paragraph {section, paragraph}. A paragraph that holds a table or picture is refused (RULE).' },
  { op: 'set_field', does: 'Fill a click-here field (누름틀) by its name, {name, text}.' },
  { op: 'append_row', does: 'Copy row `row` (default the last) of {table} and put the copy under it; `cells` gives its texts left to right. Refused when that row has merged cells (RULE, which names a row without).' },
]

const PROFILES: Record<string, FormatProfile> = {
  hwp: {
    format: 'hwp',
    extensions: ['hwp'],
    engine: 'rhwp 0.8.4 (MIT), the same build the ezpzfile.com HWP editor runs. Reads HWP 5.x and HWP 3.0.',
    structure: HWP_STRUCTURE,
    read: [
      'doc_read text: body text; documents with tables or text boxes are read by cell address',
      'doc_read markdown: plain tables as markdown tables, merged or nested tables as HTML <table> with rowspan/colspan (four levels), text boxes in place',
      'doc_read json: the structure above',
      'doc_inspect: pages, sections, paragraphs, tables with their addresses, fields, fonts, encryption',
    ],
    edit: HWP_EDIT,
    convertTo: ['pdf', 'docx', 'hwpx', 'hwp', 'png (doc_render)'],
    create: 'doc_create fills {{name}} placeholders in an .hwp or .hwpx template. A placeholder must sit inside one paragraph or one cell.',
    render: 'doc_render draws pages to PNG through the same path as the PDF conversion (vector text, bundled Korean fonts, then fonts on this machine).',
    rules: [
      'Edits never write over the source; the output goes to `out` or next to it with an -edited suffix.',
      'A cell address must exist. Writing to a cell covered by a merged cell is refused: write to its top-left cell.',
      'Fonts, sizes, colours, page setup and pictures are not changed by any op.',
      'A password protected document is saved with the same password.',
      'Ops apply in order; each op sees the document as the ops before it left it. With dry_run nothing is written.',
    ],
    units: {
      addresses: 'counted from 0',
      pages: 'counted from 1 (doc_render, doc_convert)',
      internal: 'HWPUNIT, 1/7200 inch (not exposed by the tools)',
    },
    validation: [
      'Every written file is reopened: page count, table count and the text of edited cells and paragraphs are compared with what was asked.',
      'doc_check: opens, pages, empty pages, characters no font can draw, {{placeholders}} left, fields left empty.',
    ],
    limits: { maxBytes: UNKNOWN, maxPages: UNKNOWN, tableDepth: 4, note: 'the HWP engine publishes no limits; a damaged file can stop it, and the next call starts a fresh engine' },
  },
  hwpx: {
    format: 'hwpx',
    extensions: ['hwpx'],
    engine: 'rhwp 0.8.4 (MIT)',
    structure: HWP_STRUCTURE,
    read: ['Same as hwp.'],
    edit: HWP_EDIT,
    convertTo: ['pdf', 'docx', 'hwp', 'hwpx', 'png (doc_render)'],
    create: 'doc_create fills {{name}} placeholders in an .hwpx template.',
    render: 'Same as hwp.',
    rules: ['Same as hwp.'],
    units: { addresses: 'counted from 0', pages: 'counted from 1' },
    validation: ['Same as hwp.'],
    limits: { maxBytes: UNKNOWN, maxPages: UNKNOWN, tableDepth: 4 },
  },
  docx: {
    format: 'docx',
    extensions: ['docx'],
    engine: 'mammoth (BSD-2) for reading; edits work on word/document.xml directly',
    structure: [
      'body > blocks[]: paragraphs and tables in reading order (headers, footers, footnotes and text boxes are not addressed).',
      'Paragraph address: {paragraph} = the body paragraph number counted from 0, paragraphs inside tables not counted.',
      'Table address: {table} counted from 0 in reading order, nested tables included. Cell {table, row, col} counted from 0 over the grid; a merged cell is addressed by its top-left cell.',
    ],
    read: ['doc_read text or markdown (headings, lists, tables as markdown tables)', 'doc_inspect: paragraphs, tables with rows and cols, styles in use, fields left'],
    edit: [
      { op: 'replace_text', does: 'Replace `find` with `replace` in the body, tables included, also when Word split the words over several runs. The first run\'s formatting is kept.' },
      { op: 'set_cell', does: 'Replace the text of a cell {table, row, col, text}.' },
      { op: 'insert_paragraph', does: 'Insert a paragraph after body paragraph {paragraph}, copying its paragraph and first run formatting.' },
      { op: 'delete_paragraph', does: 'Delete body paragraph {paragraph}. The last paragraph of the document cannot be deleted (RULE).' },
      { op: 'append_row', does: 'Copy row `row` (default the last) of {table} under it and put `cells` in it. Refused when that row has merged cells (RULE).' },
    ],
    convertTo: [],
    create: 'doc_create fills {{name}} placeholders in a .docx template, also when Word split them over runs.',
    render: 'unsupported: there is no DOCX layout engine in this server.',
    rules: [
      'Edits never write over the source.',
      'Tracked changes, comments, content controls and fields are kept as they are and not edited.',
      'Ops apply in order. With dry_run nothing is written.',
    ],
    units: { addresses: 'counted from 0' },
    validation: ['Written files are reopened with mammoth and the edited text is looked for; the table count is compared.'],
    limits: { maxBytes: UNKNOWN },
  },
  pdf: {
    format: 'pdf',
    extensions: ['pdf'],
    engine: 'pdf.js (Apache-2.0) to read and draw, pdf-lib (MIT) to write, qpdf (Apache-2.0, wasm) to compress, protect and unlock',
    structure: ['pages[] counted from 1. Each page has a size in points, a text layer (or none: a scan) and drawn content.'],
    read: ['doc_read text (text layer only, no OCR)', 'pdf_info: pages, sizes, encryption, metadata', 'doc_inspect: also text per page, fonts, which pages are scans'],
    edit: [
      { op: 'replace_text (pdf_edit)', does: 'Change text where the page draws it; font and background stay. A phrase drawn in two pieces is left alone and counted.' },
      { op: 'redact (pdf_edit)', does: 'Remove what is under boxes, or under every occurrence of `find`. Pages with a redaction are redrawn as pictures, so the text, pictures and annotations under the box are gone from the file, not covered. Verified by reading the text layer back.' },
      { op: 'merge, extract, delete, rotate, reorder, split, compress, protect, unlock (pdf_edit)', does: 'Page operations.' },
    ],
    convertTo: ['jpg', 'png', 'docx', 'xlsx', 'hwp', 'hwpx'],
    create: 'not a template format: build an HWP or DOCX with doc_create and convert it.',
    render: 'doc_render or doc_convert to png/jpg, at a chosen dpi.',
    rules: [
      'A redacted page loses its text layer and becomes a picture at 216 dpi (it can no longer be searched or copied). Other pages are kept as they are.',
      'replace_text cannot add a character the embedded font lacks except by drawing that line with a bundled font.',
      'Page numbers that do not exist are refused (BAD_ARGUMENT), never dropped.',
    ],
    units: {
      pages: 'counted from 1',
      boxes: 'points (1/72 inch), origin at the top-left of the page as it is displayed (rotation applied), x to the right, y down',
    },
    validation: ['Every written PDF is reopened: page count; replace_text and redact count what is left of the old text.'],
    limits: { maxBytes: UNKNOWN, maxRenderSide: '7000 px for redacted pages' },
  },
  jtd: {
    format: 'jtd',
    extensions: ['jtd', 'jtt'],
    engine: 'ezpzfile-jtd 0.3.3 (MIT), our own clean-room engine',
    structure: ['Text of the document in reading order; sheets for multi-sheet files.'],
    read: ['doc_read text or markdown'],
    edit: [],
    convertTo: ['docx', 'pdf', 'png (doc_render)'],
    create: 'unsupported',
    render: 'doc_render through the PDF conversion.',
    rules: ['Read and convert only. Edit the DOCX made from it.'],
    units: { pages: 'counted from 1' },
    validation: ['DOCX output is reopened and its characters counted; PDF output is reopened and its pages counted.'],
    limits: { maxBytes: '256 MB', maxTextUnits: 8_000_000, maxSheets: 64, maxPages: 2000, maxExpand: 4, maxStyleEntries: 2_000_000, onLimit: 'error TOO_LARGE ("too large or damaged")' },
  },
  xdw: {
    format: 'xdw',
    extensions: ['xdw', 'xbd'],
    engine: 'ezpzfile-xdw 0.3.0 (MIT), our own clean-room engine',
    structure: ['pages[] counted from 1; a binder (.xbd) holds several documents.'],
    read: ['doc_read text (text an opaque annotation covers is left out)'],
    edit: [],
    convertTo: ['pdf', 'png (doc_render)'],
    create: 'unsupported',
    render: 'doc_render through the PDF conversion.',
    rules: ['Read and convert only.', 'Signed documents are read; the signature is not checked.'],
    units: { pages: 'counted from 1', internal: '1/100 mm' },
    validation: ['PDF output is reopened and its pages counted against the document.'],
    limits: { maxBytes: '768 MB', maxExpand: '256 MB', maxRatio: 1000, maxPages: 20000, maxImagePixels: 100_000_000, maxRecords: 1_000_000, maxPoints: 5_000_000, onLimit: 'error TOO_LARGE ("too large or damaged")' },
  },
  xlsx: {
    format: 'xlsx',
    extensions: ['xlsx', 'xls', 'xlsm', 'ods', 'csv', 'tsv'],
    engine: 'SheetJS community edition (Apache-2.0)',
    structure: ['sheets[] > rows > cells (values, not formulas or formatting).'],
    read: ['doc_convert to csv or json', 'doc_inspect: sheets with their used ranges'],
    edit: [],
    convertTo: ['csv', 'json'],
    create: 'unsupported',
    render: 'unsupported',
    rules: ['Values only: formulas are read as their cached results; formatting is not carried over.'],
    units: { sheets: 'by name or counted from 0' },
    validation: ['Row and column counts are reported.'],
    limits: { maxBytes: UNKNOWN },
  },
  eml: {
    format: 'eml',
    extensions: ['eml'],
    engine: 'postal-mime (MIT)',
    structure: ['headers, text body, attachments (names and sizes).'],
    read: ['doc_read'],
    edit: [],
    convertTo: [],
    create: 'unsupported',
    render: 'unsupported',
    rules: ['Read only.'],
    units: {},
    validation: [],
    limits: { maxBytes: UNKNOWN },
  },
  image: {
    format: 'image',
    extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'tif', 'tiff', 'avif', 'heic', 'heif', 'bmp'],
    engine: 'sharp (Apache-2.0); HEIC through libheif (LGPL-3.0, shipped as separate files)',
    structure: ['width, height, channels, metadata (EXIF, GPS).'],
    read: ['doc_read metadata', 'doc_inspect'],
    edit: [{ op: 'resize, compress, convert, strip_metadata, remove_background (image_edit)', does: 'One step per call.' }],
    convertTo: ['pdf (several images become one PDF)', 'jpg', 'png', 'webp', 'avif'],
    create: 'qr_make makes QR codes',
    render: 'not needed',
    rules: ['HEIC is read, never written.'],
    units: { size: 'pixels' },
    validation: ['The real width, height and byte size of the output are returned.'],
    limits: { maxPixels: '268 million (sharp default)' },
  },
}

const ALIASES: Record<string, string> = { jtt: 'jtd', xbd: 'xdw', xls: 'xlsx', xlsm: 'xlsx', ods: 'xlsx', csv: 'xlsx', tsv: 'xlsx', jpg: 'image', jpeg: 'image', png: 'image', webp: 'image', gif: 'image', tif: 'image', tiff: 'image', avif: 'image', heic: 'image', heif: 'image', bmp: 'image' }

export function profileFor(extension: string): FormatProfile | null {
  const key = ALIASES[extension] ?? extension
  return PROFILES[key] ?? null
}

export const profileUri = (extension: string) => {
  const p = profileFor(extension)
  return p ? `ezpzfile://formats/${p.format}` : null
}

export function allProfiles(): FormatProfile[] {
  return Object.values(PROFILES)
}

/** The support matrix the README shows, built from the same data. */
export function supportMatrix(): string {
  const yes = (b: boolean) => (b ? 'yes' : '-')
  const rows = allProfiles().map((p) => {
    const edits = p.edit.length ? p.edit.map((e) => e.op.split(' ')[0]).join(', ') : '-'
    return `| ${p.extensions.join(', ')} | yes | ${edits} | ${p.convertTo.length ? p.convertTo.map((c) => c.split(' ')[0]).join(', ') : '-'} | ${yes(!/^unsupported|^not /.test(p.render))} | ${yes(!/^unsupported|^not a/.test(p.create))} |`
  })
  return ['| Format | Read | Edit (doc_edit / pdf_edit) | Convert to | Render | Template |', '| --- | --- | --- | --- | --- | --- |', ...rows].join('\n')
}

type Server = {
  registerResource: (
    name: string,
    uri: string,
    meta: { title?: string; description?: string; mimeType?: string },
    read: (uri: URL) => { contents: { uri: string; mimeType: string; text: string }[] },
  ) => unknown
}

export function registerProfiles(server: Server): void {
  server.registerResource(
    'formats',
    'ezpzfile://formats',
    { title: 'Format profiles', description: 'Which formats this server reads, edits, converts and renders, and by which rules', mimeType: 'application/json' },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(allProfiles().map((p) => ({ format: p.format, uri: `ezpzfile://formats/${p.format}`, extensions: p.extensions })), null, 1),
        },
      ],
    }),
  )
  for (const p of allProfiles()) {
    server.registerResource(
      `format-${p.format}`,
      `ezpzfile://formats/${p.format}`,
      { title: `${p.format.toUpperCase()} profile`, description: `Structure, edit ops, rules, units, validation and limits for ${p.extensions.join(', ')}`, mimeType: 'application/json' },
      (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(p, null, 1) }] }),
    )
  }
}
