# ezpzfile-mcp

File tools for AI agents. Read and convert documents, turn PDFs back into Word, Excel or
HWP, edit PDFs, resize and clean images, cut out backgrounds and make QR codes. Everything
runs on your machine and nothing is uploaded.

Agents burn tokens re-solving the same small problem: write file-handling code, run it,
debug it, open the output to check it worked. This server turns that loop into one
tool call.

Formats with almost no open tooling are handled too: Korean HWP and HWPX without Hancom
Office, Japanese Ichitaro (JTD) and DocuWorks (XDW, XBD) without Ichitaro or DocuWorks, and
none of them need Windows. That is the part nothing else does locally, but it is one
capability here, not the point.

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

Six tools, not twenty five. Tool definitions sit in the model's context every session,
so a long list would eat the tokens this server is meant to save. New capabilities
are added as another value of `op` or `to`, not as another tool.

| Tool | What it does |
| --- | --- |
| `doc_read` | Text of a DOCX, PDF, HWP, HWPX, EML, JTD, XDW or XBD file. `format: markdown` keeps DOCX and JTD headings, lists and tables. HWP and HWPX tables come out as tables, cell by cell; `format: json` gives their structure. `format: metadata` lists what a file records about itself instead: camera, GPS position, author, dates. |
| `doc_convert` | PDF pages to `jpg` or `png`. PDF to `docx`, `xlsx`, `hwp` or `hwpx`. Images, HEIC included, to `pdf`. XLSX/CSV to `csv` or `json`. HWP/HWPX to `pdf`, `docx`, `hwp`, `hwpx`. JTD to `docx` or `pdf`. XDW/XBD to `pdf`. |
| `pdf_edit` | `merge`, `extract`, `delete`, `rotate`, `reorder`, `split`, `compress`, `protect`, `unlock`, `replace_text`. |
| `pdf_info` | Page count, page sizes, encryption flag, document metadata. |
| `image_edit` | Resize, compress, convert, strip EXIF and GPS, or cut out the background. Reads HEIC photos from iPhones. |
| `qr_make` | QR code as PNG or SVG. |

Every tool takes absolute paths and returns the path it wrote.

### Verification is built in

Each tool reopens what it made and reports the numbers, so a silently broken file
shows up as a number instead of as a surprise later:

- `doc_convert` compares the page count of the output against the source and counts
  characters no font had a glyph for, listing them by code point. Characters missing
  from the bundled fonts are drawn with fonts installed on the machine when one has
  them (set `EZPZFILE_FONTS` to font file paths to add your own). Documents rebuilt from a PDF are
  reopened too: the Word file's text is read back, the Excel sheets are counted, the
  HWP paragraphs are compared.
- `pdf_edit replace_text` reopens the PDF and counts how much of the old text is left.
- `image_edit` returns the real width, height and byte size of the output.
- `pdf_edit compress` returns bytes before and after, and copies the file unchanged
  when qpdf could not make it smaller.

```
/Users/me/report.pdf
9 pages · no loss reported · reopened, page count matches
```

### Tables in HWP documents

Korean government and company documents keep most of their content in tables, often
with merged cells, tables inside tables and text boxes. `doc_read` reads them by cell
address instead of by where the text lands on the page:

- a plain table becomes a markdown table
- merged cells become an HTML table with `rowspan` and `colspan`
- a table inside a table stays inside its cell (four levels deep at most)
- a text box keeps its spaces and sits where it is anchored
- a one-cell box becomes a quote

The first line counts what it found, `[Tables: 60 (2 nested), merged cells: 101, text boxes: 2. …]`.
`format: json` returns sections, tables, cells with their row, column and spans, and
text boxes. `doc_convert` to `docx` writes the same structure into Word: merged cells
stay merged, nested tables stay nested. Fonts and page layout are not carried over.

### PDF back into documents

`doc_convert` from a PDF to `docx`, `xlsx`, `hwp` or `hwpx` rebuilds paragraphs, tables
and pictures from where the text sits on each page. A PDF does not record what was a
paragraph or a table, so this is a reconstruction: headings and tables are inferred, and
the result says how many of each it found. Pages without a text layer (scans) are listed
and left out. There is no OCR.

### Replacing text in a PDF

`pdf_edit` with `op: "replace_text"`, `find` and `replace` changes the text where the PDF
draws it. No white box is painted over the old words, so the page keeps its background
and fonts, and the new text can still be searched and copied. When the document's
embedded font lacks a character of the new text, a bundled font draws that one line. A
phrase the PDF draws in two pieces (often where the font changes) stays as it is, and
the result counts it.

```
/Users/me/contract-replaced.pdf
replaced 4 of 5 · on 2 pages (1, 4) · 1 left alone: split across separately drawn pieces of text · reopened, 1 left
```

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
every `npx` would be a poor trade. This is the only operation that touches the
network, and it sends nothing: the model travels to your photo, not the other
way round.

Set `EZPZFILE_CACHE` to move the cache elsewhere.

## What it does not do

- Editing HWP, JTD or XDW content is out of scope. This converts and reads, it does not
  author. The editors on ezpzfile.com do that in a browser.
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
leaves the machine. The one network request this server ever makes is the one-time
download for background removal described above, and it uploads nothing. The same
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
```

## License

MIT. The bundled engines and fonts keep their own licences, which ship next to them in
`vendor/`: the HWP engine rhwp (MIT), the JTD and XDW engines (MIT),
libheif for HEIC (LGPL-3.0, kept as separate files so it can be replaced), and the Nanum
and Noto fonts (SIL Open Font License 1.1).
