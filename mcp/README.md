# ezpzfile-mcp

File tools for AI agents. Look inside a document, change it by address, fill a template,
redact a PDF, convert, render pages and check the result, all with tools that reopen what
they wrote and report the numbers. Everything runs on your machine and nothing is uploaded.

Agents burn tokens re-solving the same small problem: write file-handling code, run it,
debug it, open the output to check it worked. This server gives them parts they can
compose instead. `doc_inspect` says what is in a file and how to address it, `doc_edit`
takes a list of operations, every result says what was confirmed after reopening, and
every error says what to supply next.

Formats with almost no open tooling are handled too: Korean HWP and HWPX without Hancom
Office (tables read and edited by cell address), Japanese Ichitaro (JTD) and DocuWorks
(XDW, XBD), and none of them need Windows.

```bash
claude mcp add ezpzfile -- npx -y ezpzfile-mcp
```

## Install

### Claude Code

```bash
claude mcp add ezpzfile -- npx -y ezpzfile-mcp
```

### Claude Desktop

`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`,
Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "ezpzfile": {
      "command": "npx",
      "args": ["-y", "ezpzfile-mcp"]
    }
  }
}
```

### Cursor

`~/.cursor/mcp.json`, or `.cursor/mcp.json` inside a project:

```json
{
  "mcpServers": {
    "ezpzfile": {
      "command": "npx",
      "args": ["-y", "ezpzfile-mcp"]
    }
  }
}
```

### VS Code

```bash
code --add-mcp '{"name":"ezpzfile","command":"npx","args":["-y","ezpzfile-mcp"]}'
```

Node 22.13 or newer. The first run downloads the package including the document engines
and fonts (about 26MB) plus native image and PDF libraries for your platform, after that
npx serves it from cache.

## Tools

Eleven tools for every format. Tool definitions sit in the model's context every session, so related jobs
share one tool and are told apart by `op`, `to` or `format`.

| Tool | What it does |
| --- | --- |
| `doc_inspect` | What a document holds and how to address it. AI/EPS/SVG and PSD: layers and objects with ids, text, bounds, visibility, fonts. CAD: layers, sheets, texts. HWP/HWPX/DOCX: paragraphs, tables with their number, rows, cols and merged cells, fields, `{{placeholders}}`. PDF: pages, sizes, text per page, scanned pages, fonts. Sheets and images too. Points to the format profile. |
| `doc_read` | Text of DOCX, PDF, HWP, HWPX, EML, JTD, XDW, XBD and CAD drawings (DWG, DXF, JWW …). `markdown` keeps headings, lists and tables; HWP tables come out by cell address, merged or nested ones as HTML tables. `json` gives HWP structure. `metadata` lists camera, GPS, author, dates. |
| `doc_edit` | Change a document by a list of ops. HWP, HWPX, DOCX: `replace_text`, `set_cell`, `insert_paragraph`, `delete_paragraph`, `set_field` (HWP), `append_row`. AI, EPS, SVG, PSD by object or layer id: `hide`, `show`, `delete`, `set_text`, `replace_text`, `move`, `set_fill`, `rename`, `duplicate`, and `command` for any of the design engines' 1,500 commands. Save as another format by the output's extension. `dry_run` checks without writing. |
| `doc_create` | Fill a template: HWP, HWPX, DOCX, PDF, SVG, AI, EPS or PSD. `{{name}}` placeholders, or the sample text the design already shows (`match`). One copy, or one file per row of a CSV/XLSX (`data`), named by a pattern. |
| `doc_render` | PNG of pages (PDF, HWP, HWPX, JTD, XDW), CAD sheets, an AI/SVG artboard or a PSD canvas, or of single objects and layers drawn alone (`ids`), to look at a layout, an edit, or find which layer is which. |
| `doc_check` | Before sending: opens, page count, `{{placeholders}}` or empty fields left, characters no font can draw, phrases that must not appear, pages without a text layer. |
| `doc_convert` | PDF to `jpg`, `png`, `docx`, `xlsx`, `hwp`, `hwpx`. HWP/HWPX to `pdf`, `docx`, `hwp`, `hwpx`. JTD to `docx`, `pdf`. XDW/XBD to `pdf`. CAD (DWG, DXF, JWW, IFC …) to `pdf` (vector), `png`, `svg`. Images to `pdf`. XLSX/CSV to `csv`, `json`. AI/EPS/SVG and PSD convert through `doc_edit` with an `out` of another extension. |
| `pdf_edit` | `merge`, `extract`, `delete`, `rotate`, `reorder`, `split`, `compress`, `protect`, `unlock`, `replace_text`, `redact`. |
| `pdf_info` | Page count, page sizes, encryption, metadata. |
| `image_edit` | Resize, compress, convert, strip EXIF and GPS, cut out the background. Reads HEIC. |
| `qr_make` | QR code as PNG or SVG. |

Every tool takes absolute paths, never writes over its input, and returns the path it wrote.

### Composing a job

The tools are meant to be chained. An agent filling in a Korean form:

```
doc_inspect  form.hwp                       → table 3: 5x4, 1 merged ... fields: 신청인, 일자
doc_edit     form.hwp ops=[set_field 신청인, set_cell {table:3,row:1,col:2}, append_row {table:3}]
             → each op confirmed after reopening
doc_convert  form-edited.hwp to=pdf
doc_check    form-edited.pdf forbid=["{{"]  → passed
```

A redaction:

```
pdf_edit  op=redact paths=[letter.pdf] find=["김하늘","010-1234-5678"]
          → 4 areas removed on pages 1, 2 · reopened: nothing left to extract on those pages
doc_check letter-redacted.pdf forbid=["김하늘"]
```

### Addresses and rules: format profiles

Each format has a profile at `ezpzfile://formats/<format>` (MCP resources: `hwp`, `hwpx`,
`docx`, `pdf`, `jtd`, `xdw`, `xlsx`, `eml`, `image`). It lists how parts are addressed
(tables and cells counted from 0, pages from 1, PDF boxes in points from the top-left),
which ops exist, the rules an edit must keep, what reopening checks, and the engine's
limits. Where we do not know a value, the profile says `unknown`.

### Errors

A failure is `{ code, message, needs }` in `structuredContent.error`, so an agent can act
on it without parsing English:

| Code | Means |
| --- | --- |
| `NOT_FOUND` | No such file |
| `PASSWORD_REQUIRED`, `PASSWORD_WRONG` | Call again with `password` |
| `UNREADABLE` | Damaged, or not the format its name says (the message says what it really is) |
| `TOO_LARGE` | A limit was hit: "too large or damaged" |
| `UNSUPPORTED` | That format or op is not handled; the message names the profile to read |
| `BAD_ARGUMENT` | Missing or out of range; `needs` lists the arguments |
| `RULE` | The edit would break a rule of the format. A cell under a merged cell names the anchor in `details.anchor`; a row with merged cells names a plain row in `details.row` |
| `NOT_APPLIED` | Nothing matched, nothing changed |
| `VERIFY_FAILED` | Written, but reopening did not confirm every op; `details.verify` says which |
| `ENGINE` | A document engine stopped; the next call starts a fresh one |

A failing op stops a `doc_edit` run before anything is written, and the error says which op
it was and what had applied.

### Verification is built in

Each tool reopens what it made and reports the numbers:

- `doc_edit` checks every op in the reopened file: replaced text gone, cell text as asked,
  new paragraphs and rows present, page and table counts.
- `doc_create` reports what each value filled, placeholders left and values with no place.
- `pdf_edit redact` reopens the PDF and counts characters left on redacted pages and the
  phrases left anywhere. `replace_text` counts how much of the old text is left.
- `doc_convert` compares page counts, lists characters no font could draw by code point,
  and counts tables after HWP to DOCX. Documents rebuilt from a PDF are read back too.
- `image_edit` returns the real width, height and byte size of the output.

```
/Users/me/form-edited.hwp
0. set_field: 신청인: "" → "김하늘"
1. set_cell: table 3 row 1 col 2: "" → "2026-11-05"
reopened: every op confirmed
```

### Support

| Format | Read | Inspect | Edit | Template | Render | Convert to |
| --- | --- | --- | --- | --- | --- | --- |
| HWP, HWPX | text, markdown, json | yes | `doc_edit` (6 ops) | yes | yes | pdf, docx, hwp, hwpx |
| DOCX | text, markdown | yes | `doc_edit` (5 ops) | yes | - | - |
| PDF | text (no OCR) | yes | `pdf_edit` (11 ops incl. redact) | - | yes | jpg, png, docx, xlsx, hwp, hwpx |
| JTD, JTT | text, markdown | - | - | - | yes | docx, pdf |
| XDW, XBD | text | - | - | - | yes | pdf |
| AI, EPS, SVG, EMF, CDR | - | layers, objects | `doc_edit` (9 ops + 700 commands) | yes | yes | ai, svg, pdf, eps, png, jpg, psd, dxf |
| PSD, PSB | - | layers | `doc_edit` (9 ops + 800 commands) | yes | yes | psd, png, jpg, webp, tif, pdf |
| DWG, DXF, JWW, SXF, IFC, STEP, SKP … | text | layers, sheets | - | - | yes | pdf, png, svg |
| XLSX, XLS, ODS, CSV, TSV | - | sheets | - | - | - | csv, json |
| EML | text | - | - | - | - | - |
| JPG, PNG, WebP, GIF, TIFF, AVIF, BMP, HEIC | metadata | size | `image_edit` | - | - | pdf, jpg, png, webp |

### MCP or a script

The same jobs done the way an agent does them without this server: writing a script with
the common Python libraries. Measured on the sample files from `test/make-samples.py`
(`node test/scenarios.mjs` runs the MCP side).

| Job | With ezpzfile-mcp | Script an agent writes |
| --- | --- | --- |
| Fill a DOCX quote template | 1 call, 0.1 s, nothing left | python-docx run-by-run replace (about 20 lines): `{{customer}}`, split over two runs by Word, stays unfilled, and the repeating item row needs code of its own |
| Redact a name and phone number in a PDF | 1 call, 2.5 s, text gone, checked | pypdf + reportlab black boxes (20 lines): looks redacted, but the name is still extractable twice |
| Read the tables of an HWP notice | 1 call, 60 tables, merged cells kept | pyhwp (AGPL) failed to build on Python 3.13 here |
| Change an HWP cell | 1 call, confirmed after reopening | we know of no open library that writes HWP tables |

The script side looks done in both DOCX and PDF cases: it runs without an error. Finding
out that it is not takes another read of the output, which is the step `doc_check` and the
verify numbers do for you.

### Design files: AI, EPS, SVG and PSD

The vector and PSD editors on ezpzfile.com run two open engines, VectorCraft and
PhotoCraft (MIT OR Apache-2.0). This server runs the same engines without a window, as
WebAssembly under Node's WASI, downloaded once from ezpzfile.com (about 13 MB and 6 MB)
and cached. Everything they do is reachable:

```
doc_inspect poster.psd            → #5 Pixel "Decor dots" [442, 50, 735, 707] …
doc_render  poster.psd ids=[5, 8] → each layer drawn alone, to see which one is the cloud
doc_edit    poster.psd ops=[hide [5]] out=poster.png
doc_edit    card.ai ops=[set_text {id: 239, text: "김하늘"}, set_fill {ids: [240], color: "#ffcc00"}] out=card.pdf
```

`command` runs any engine command: pathfinder, align, effects, `type.createOutlines`,
`text.replaceFont`, PDF export with bleed and crop marks, adjustments, filters, layer
styles. `ezpzfile://commands/vector/<word>` and `ezpzfile://commands/photo/<word>` list
the commands whose name holds the word, with their parameters.

Characters the document's fonts lack are drawn with fonts installed on the machine.

### Many files from one design

`doc_create` with `data` (a CSV or XLSX, first row = keys) makes one file per row. A design
usually has sample text instead of placeholders, so `match` says which sample stands for
which column:

```
doc_create template=card.ai data=people.csv out_dir=cards name_pattern="card-{{name}}"
           match={"홍길동": "name", "010-0000-0000": "phone", "hong@example.com": "email"}
→ 100 of 100 files made in cards (48 s)
```

It works the same for HWP, DOCX, PDF, SVG and PSD. In a PDF the new text keeps the
template's own font when this machine has it (`BAAAAA+NotoSansCJKkr-Bold` →
NotoSansCJKkr-Bold), cut down to the characters used; rows that fail are listed and the
rest are still made.

### CAD drawings

DWG (R12 to 2018+), DXF, Jw_cad, iCAD SX, SXF, Gerber/ODB++, IGES, Inventor, DWFx, IFC,
STEP, SketchUp and mesh files are read by the clean-room engines of the ezpzfile.com CAD
viewer. `doc_inspect` lists layers and sheets, `doc_read` every text, `doc_convert` makes
a vector PDF (text stays text) or a PNG/SVG of a sheet.

### Japanese documents

Ichitaro (`.jtd`) and DocuWorks (`.xdw`, `.xbd`) are read by our own open source engines,
[ezpzfile-jtd](https://github.com/ezpzfile/ezpzfile-jtd) and
[ezpzfile-xdw](https://github.com/ezpzfile/ezpzfile-xdw), the same ones behind the
editors at [ezpzfile.com/jtd-editor](https://ezpzfile.com/jtd-editor) and
[ezpzfile.com/xdw-editor](https://ezpzfile.com/xdw-editor). PDFs are made the way those
editors make them: each page is drawn as a picture with an invisible text layer on top,
so the PDF can still be searched. Fonts a document names are used when the machine has
them. Otherwise the bundled Noto Sans JP draws the text. A binder (`.xbd`) becomes one
PDF with its documents in order.

### Passwords

Pass `password` for encrypted PDF, HWP and HWPX files. `pdf_edit protect` sets an
AES-256 password, `unlock` removes one you know. Converting an encrypted HWP or HWPX
keeps the password on the output file.

## Examples

```
Read ~/Downloads/notice.hwp and summarize it.
Put the figures from table 9 of notice.hwp into a markdown table.
Fill quote-template.docx for 한빛상사 with these three items and check nothing is left.
In 신청서.hwp, set 신청인 to 김하늘 and add a row to the 경력 table.
Remove every phone number from minutes.pdf and prove it is gone.
Convert ~/Downloads/notice.hwp to PDF.
Turn ~/Downloads/quote.pdf into a Word file I can edit.
Replace "ACME Corp" with "Globex Inc" in contract.pdf.
Read 申請書.jtd and list the fields I need to fill in.
Convert the DocuWorks binder 会議資料.xbd to one PDF.
Does IMG_0412.jpg say where it was taken?
Turn these iPhone photos (HEIC) into JPEGs 1600px wide.
Merge chapter1.pdf and chapter2.pdf, then rotate page 3 by 90 degrees.
Split thesis.pdf at pages 12 and 40 into three files.
Render page 1 of brochure.pdf as a PNG at 200 dpi.
Turn sales.xlsx into JSON, sheet "2026".
Strip the EXIF data from every photo in ~/Pictures/trip.
Make a QR code for https://example.com as qr.svg.
```

## Background removal

`image_edit` with `op: "remove_background"` runs U²-Net on your machine and
writes a PNG with the subject on transparency, or on a colour if you pass
`background`.

The model (4.4MB) and the onnxruntime wasm (14MB) are downloaded the first time
you ask for a cut-out and cached under `~/.cache/ezpzfile-mcp` after that. They
are not in the package: most sessions never need them, and putting 18MB into
every `npx` would be a poor trade. The design engines for AI and PSD files are
fetched the same way, once, the first time such a file is opened. These downloads
are the only network use, and they send nothing: the engine travels to your file,
not the other way round.

Set `EZPZFILE_CACHE` to move the cache elsewhere.

## What it does not do

- HWP and DOCX edits change text and table content, not fonts, colours, page setup or
  pictures. CAD drawings are read and converted, not edited yet. 3D models are listed, not
  drawn. Text boxes, headers and footers are read but not edited. JTD and XDW are read
  and converted only.
- DOCX is not rendered or converted: there is no Word layout engine here.
- HWP opens back to Hangul 97 (HWP 3.0). Files locked by a company's document security
  (DRM) are encrypted and cannot be read, and `doc_read` says that this is what it
  found.
- Scanned PDFs have no text layer and there is no OCR. `doc_read` tells you which pages
  came back empty instead of guessing, and PDF to Word, Excel or HWP lists the pages it
  left out.
- Ichitaro and this engine break lines and pages each their own way, so a JTD can come
  out with a different page count. The result says when it does.
- HEIC photos are read but never written: they come out as JPEG, PNG or WebP. Their
  metadata cannot be read yet.
- Fonts are the ones bundled for CJK output, plus whatever the machine has installed. A
  document built on a font you do not have will be rendered with a substitute.
- Archives are out of scope. An agent already has `unzip` and `tar` in its shell, so a
  tool definition spent on them would cost context without buying anything. Use
  ezpzfile.com when an archive has file names that arrive garbled.

## Privacy

No telemetry. Files are read from and written to the paths you give, and nothing
leaves the machine. The only network requests this server makes are the one-time
downloads of the background-removal model and the design engines described above, and
they upload nothing. The same
engines run in the browser at [ezpzfile.com](https://ezpzfile.com) if you would rather
click than prompt.

## Build from source

```bash
cd mcp
npm install
npm run build   # bundles to dist/ and copies the engines and fonts into vendor/
node dist/index.js

python3 test/make-samples.py /path/to/samples   # makes the files the test expects
node test/protocol.mjs /path/to/samples          # spawns the server over stdio and calls every tool
node test/scenarios.mjs /path/to/samples         # eight jobs composed from several calls
```

## License

MIT. The bundled engines and fonts keep their own licences, which ship next to them in
`vendor/`: the HWP engine rhwp (MIT), the JTD and XDW engines (MIT),
libheif for HEIC (LGPL-3.0, kept as separate files so it can be replaced), and the Nanum
and Noto fonts (SIL Open Font License 1.1). The design engines downloaded on first use,
VectorCraft and PhotoCraft, are MIT OR Apache-2.0; their licences sit next to them at
ezpzfile.com/vendor/engines/, and the patches that build them for WASI are in
[engines/](../engines) of this repository.
