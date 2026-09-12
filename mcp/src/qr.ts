/**
 * QR codes. The matrix and the SVG come from the site code (src/lib/qrOps),
 * which is pure JavaScript. Only the PNG step differs: the browser paints a
 * canvas, here sharp rasterizes the same SVG. Rendering the SVG instead of
 * drawing squares keeps the two outputs identical by construction.
 */
import { getSharp } from './sharp'
import { buildMatrix, toSvg, type QrLevel } from '../../src/lib/qrOps'

export interface QrRequest {
  text: string
  level?: QrLevel
  size?: number
  margin?: number
  dark?: string
  light?: string
}

export interface QrResult {
  bytes: Uint8Array
  format: 'png' | 'svg'
  /** Modules per side, quiet zone excluded */
  modules: number
  /** Pixel size of the finished PNG, or viewBox units for SVG */
  size: number
  /** PNG only: pixels per module, after snapping to whole pixels */
  scale?: number
}

export async function makeQr(req: QrRequest, format: 'png' | 'svg'): Promise<QrResult> {
  const matrix = await buildMatrix(req.text, req.level ?? 'M')
  const margin = req.margin ?? 4
  const size = req.size ?? 512
  // Spread merging in toSvg treats an explicit undefined as a value, so only
  // pass the colors the caller actually set.
  const colors: { dark?: string; light?: string } = {}
  if (req.dark) colors.dark = req.dark
  if (req.light) colors.light = req.light
  const svg = toSvg(matrix, { size, margin, ...colors })

  if (format === 'svg') {
    return {
      bytes: new TextEncoder().encode(svg),
      format,
      modules: matrix.count,
      size: matrix.count + margin * 2,
    }
  }

  // Snap the raster to a whole number of pixels per module. A fractional
  // module width blurs the edges and some readers then fail on the code.
  //
  // Rounding used to decide the final size, so a request for 512 came back as
  // 528 and layouts that reserved a box for it broke. Round down instead and
  // pad the remainder onto the quiet zone: the caller gets exactly the size it
  // asked for, and every module still lands on whole pixels. A quiet zone that
  // is a few pixels wider is harmless, a blurred module is not.
  const total = matrix.count + margin * 2
  const scale = Math.max(1, Math.floor(size / total))
  const drawn = total * scale
  const sharp = await getSharp()
  let pipeline = sharp(Buffer.from(svg), { density: 72 }).resize(drawn, drawn, { kernel: 'nearest' })
  if (drawn < size) {
    const pad = size - drawn
    const top = Math.floor(pad / 2)
    const left = Math.floor(pad / 2)
    pipeline = pipeline.extend({
      top,
      left,
      bottom: pad - top,
      right: pad - left,
      background: req.light ?? '#ffffff',
    })
  }
  const png = await pipeline.png().toBuffer()
  // Only a size smaller than the code itself can miss the target.
  const px = Math.max(size, drawn)
  return { bytes: new Uint8Array(png), format, modules: matrix.count, size: px, scale }
}
