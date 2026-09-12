# ezpzfile-mcp

File tools for AI agents. Read and convert documents, edit PDFs, resize and clean
images and make QR codes. Everything runs on your machine and nothing
is uploaded.

Agents burn tokens re-solving the same small problem: write file-handling code, run it,
debug it, open the output to check it worked. This server turns that loop into one
tool call.

Korean HWP and HWPX are handled too, with no Hancom Office and no Windows. That is the
part nothing else does locally, but it is one capability here, not the point.

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

Node 20 or newer. The first run downloads the package including the document engine
and fonts (about 18MB) plus native image and PDF libraries for your platform, after that
npx serves it from cache.

## Tools

Six tools, not twenty five. Tool definitions sit in the model's context every session,
so a long list would eat the tokens this server is meant to save. New capabilities
are added as another value of `op` or `to`, not as another tool.

| Tool | What it does |
| --- | --- |
| `doc_read` | Text of an HWP, HWPX, DOCX, PDF or EML file. `format: markdown` keeps DOCX headings, lists and tables. |
| `doc_convert` | HWP/HWPX to `pdf`, `hwp`, `hwpx`. PDF pages to `jpg` or `png`. Images to `pdf`. XLSX/CSV to `csv` or `json`. |
| `pdf_edit` | `merge`, `extract`, `delete`, `rotate`, `reorder`, `split`, `compress`, `protect`, `unlock`. |
| `pdf_info` | Page count, page sizes, encryption flag, document metadata. |
| `image_edit` | `resize`, `compress`, `convert` (jpeg, png, webp), `strip_metadata` (EXIF, GPS, XMP, without re-encoding). |
| `qr_make` | QR code as PNG or SVG. |

Every tool takes absolute paths and returns the path it wrote.

### Verification is built in

Each tool reopens what it made and reports the numbers, so a silently broken file
shows up as a number instead of as a surprise later:

- `doc_convert` compares the page count of the output against the source and counts
  characters the bundled fonts had no glyph for.
- `image_edit` returns the real width, height and byte size of the output.
- `pdf_edit compress` returns bytes before and after, and copies the file unchanged
  when qpdf could not make it smaller.
  because their names tried to escape the target folder.

```
/Users/me/report.pdf
9 pages · no loss reported · reopened, page count matches
```

### Passwords

Pass `password` for encrypted HWP, HWPX and PDF files. `pdf_edit protect` sets an
AES-256 password, `unlock` removes one you know. Converting an encrypted HWP or HWPX
keeps the password on the output file.

## Examples

```
Read ~/Downloads/notice.hwp and summarize it.
Convert ~/Downloads/notice.hwp to PDF.
Merge chapter1.pdf and chapter2.pdf, then rotate page 3 by 90 degrees.
Split thesis.pdf at pages 12 and 40 into three files.
Render page 1 of brochure.pdf as a PNG at 200 dpi.
Turn sales.xlsx into JSON, sheet "2026".
Resize banner.png to 1200 wide as WebP.
Strip the EXIF data from every photo in ~/Pictures/trip.
Make a QR code for https://example.com as qr.svg.
```

## What it does not do

- HWP 3.0 and older binary formats are not readable.
- Editing HWP content is out of scope. This converts and reads, it does not author.
- Fonts are the ones bundled for CJK output. A document built on a font you do not
  have will be rendered with a substitute.
- Scanned PDFs have no text layer. `doc_read` tells you which pages came back empty
  instead of guessing.
- Background removal is not included yet. The browser version at ezpzfile.com does it
  with an ONNX model that has not been packaged for Node.
- Archives are out of scope. An agent already has `unzip` and `tar` in its shell, so a
  tool definition spent on them would cost context without buying anything. Use
  ezpzfile.com when an archive has file names that arrive garbled.

## Privacy

No network calls. No telemetry. Files are read from and written to the paths you
give, and nothing else leaves the machine. The same engine runs in the browser at
[ezpzfile.com](https://ezpzfile.com) if you would rather click than prompt.

## Build from source

```bash
cd mcp
npm install
npm run build   # bundles to dist/ and copies the engine and fonts into vendor/
node dist/index.js

node test/protocol.mjs /path/to/sample/files   # spawns the server over stdio and calls every tool
```

## License

MIT
