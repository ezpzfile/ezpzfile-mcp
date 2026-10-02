/**
 * A canvas with Japanese fonts, for drawing JTD and XDW pages in Node.
 *
 * Both engines hand over pages as drawing lists and leave the drawing to the
 * caller, which on the website is the browser's canvas with the fonts of the
 * reader's system. Here it is @napi-rs/canvas (Skia), which also sees system
 * fonts: on a Mac or Windows machine Hiragino, Yu or MS fonts are used when the
 * document asks for them. Noto Sans JP ships in the package so that a machine
 * without any Japanese font (a Linux server, a container) still gets every
 * character. The Korean Noto is registered behind it for the odd Hangul.
 *
 * Registered once, on the first page drawn, never at startup: most sessions
 * never touch a Japanese document.
 */
import { fontFile } from './engine'

export const JP_FAMILY = 'EZPZ Noto Sans JP'
const KR_FAMILY = 'EZPZ Noto Sans KR'

/** Appended to every font stack: what is always there when nothing named is. */
export const FALLBACK_FAMILIES = `"${JP_FAMILY}","${KR_FAMILY}"`

type Canvas = typeof import('@napi-rs/canvas')
let loading: Promise<Canvas> | null = null

export function canvasWithFonts(): Promise<Canvas> {
  if (!loading) {
    loading = import('@napi-rs/canvas')
      .then((canvas) => {
        canvas.GlobalFonts.registerFromPath(fontFile('NotoSansJP-Regular.otf'), JP_FAMILY)
        canvas.GlobalFonts.registerFromPath(fontFile('NotoSansKR-Regular.otf'), KR_FAMILY)
        return canvas
      })
      .catch((err: unknown) => {
        loading = null
        const detail = err instanceof Error ? err.message : String(err)
        throw new Error(
          `The page renderer (@napi-rs/canvas) failed to load, so pages cannot be drawn in this install. Reading the text still works. Reinstalling usually fixes it. Original error: ${detail}`,
        )
      })
  }
  return loading
}
