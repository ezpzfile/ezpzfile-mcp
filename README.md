# ezpzfile-mcp

Source for the [`ezpzfile-mcp`](https://www.npmjs.com/package/ezpzfile-mcp)
npm package. The package itself lives in [`mcp/`](./mcp) and its documentation
is [`mcp/README.md`](./mcp/README.md).

```bash
claude mcp add ezpzfile -- npx -y ezpzfile-mcp
```

Everything runs on your machine. Files are never uploaded anywhere.

## Layout

| Path | What it is |
|---|---|
| `mcp/` | The package: server, tools, build |
| `src/lib/` | Code shared with [ezpzfile.com](https://ezpzfile.com) |
| `public/vendor/` | The HWP engine and the fonts embedded into generated PDFs |

## Build

```bash
cd mcp
npm install
npm run build      # writes mcp/dist/index.js and mcp/vendor/
node test/protocol.mjs /path/to/samples
```

Node 20 or newer. `sharp` and `@napi-rs/canvas` are native, so they are built
for your platform on install.

## A note on this repository

This is a read-only export. The working copy lives in a private monorepo
alongside the website, and this repository is regenerated from it on each
release. Please open issues rather than pull requests.

MIT licensed, see [LICENSE](./LICENSE).
