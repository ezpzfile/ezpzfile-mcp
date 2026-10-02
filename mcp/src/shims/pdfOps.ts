/**
 * Node version of src/lib/pdfOps.ts, used in place of it inside this bundle
 * (build.mjs, nodeShims).
 *
 * The site modules reused here (pdfLayout for PDF to Word, Excel and HWP,
 * pdfEditOps for text replacement) get pdfjs from getPdfjs() and its side files
 * from PDFJS_ASSETS. In the browser both are web addresses. Here they are the
 * pdfjs-dist package on disk. Everything else is re-exported unchanged.
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

export * from '../../../src/lib/pdfOps'

const require = createRequire(import.meta.url)
const root = dirname(require.resolve('pdfjs-dist/package.json'))

export const PDFJS_ASSETS = {
  standardFontDataUrl: join(root, 'standard_fonts') + '/',
  cMapUrl: join(root, 'cmaps') + '/',
  cMapPacked: true,
} as const

type Pdfjs = typeof import('pdfjs-dist')
type Source = Parameters<Pdfjs['getDocument']>[0]

let loading: Promise<Pdfjs> | null = null

/**
 * pdfjs with quiet defaults. Site code does not always pass `verbosity`, and
 * pdfjs prints its warnings with console.log. On a stdio server stdout is the
 * protocol, so every document opened through here starts at verbosity 0.
 */
export async function getPdfjs(): Promise<Pdfjs> {
  if (!loading) {
    loading = (import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as Promise<Pdfjs>).then((pdfjs) => {
      const quiet = (src: Source) =>
        src && typeof src === 'object' && !ArrayBuffer.isView(src) && !(src instanceof ArrayBuffer) && !(src instanceof URL)
          ? pdfjs.getDocument({ verbosity: 0, ...src })
          : pdfjs.getDocument(src)
      return { ...pdfjs, getDocument: quiet } as Pdfjs
    })
  }
  return loading
}
