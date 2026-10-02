/**
 * Keep stdout for the protocol.
 *
 * Over stdio, every byte this process writes to stdout must be part of a
 * JSON-RPC message. Libraries do not know that: pdfjs prints warnings with
 * console.log, libheif logs a picture it cannot read the same way. One stray
 * line and the client drops the connection.
 *
 * Imported first by index.ts, so it runs before anything else can print.
 * MCP clients collect stderr as the server log.
 */
for (const name of ['log', 'info', 'debug'] as const) {
  console[name] = (...args: unknown[]) => console.error(...args)
}

export {}
