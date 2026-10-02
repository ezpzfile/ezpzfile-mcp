/**
 * Node version of src/lib/pdfImagePng.ts, used in place of it inside this bundle
 * (build.mjs, nodeShims).
 *
 * pdfLayout bakes every picture it finds on a PDF page into PNG. The browser
 * does that on a canvas. Here sharp encodes the same RGBA pixels, which the
 * shared pdfImageRgba unpacks exactly as the site does.
 */
import { getSharp } from '../sharp'
import { pdfImageRgba, type PdfImage } from '../../../src/lib/pdfImagePng'

export { pdfImageRgba, type PdfImage }

export async function pdfImageToPng(image: PdfImage): Promise<Uint8Array | null> {
  const rgba = pdfImageRgba(image)
  if (!rgba) return null
  const sharp = await getSharp()
  const png = await sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), {
    raw: { width: image.width, height: image.height, channels: 4 },
  })
    .png()
    .toBuffer()
  return new Uint8Array(png)
}
