/**
 * Image operations.
 *
 * The browser version (src/lib/imageOps.ts) draws on a canvas, which does not
 * exist in Node. sharp covers resize, quality and format in one dependency, so
 * the pixel work is rewritten here. The sizing rule is copied from the site's
 * targetSize() so both give the same dimensions for the same request.
 *
 * strip_metadata is the exception: it must not re-encode pixels, so it calls
 * the site's byte-level stripper unchanged (src/lib/metadataOps.ts) and needs
 * no image engine at all.
 *
 * sharp is fetched per call through getSharp() rather than imported here, so a
 * machine where the native build failed loses image work only.
 */
import type { Sharp } from 'sharp'
import { getSharp } from './sharp'
import { targetSize } from '../../src/lib/imageOps'
import { stripMetadata, sniffFormat } from '../../src/lib/metadataOps'

export type ImageFormat = 'jpeg' | 'png' | 'webp'

export interface ImageStats {
  width: number
  height: number
  bytes: number
  format: string
}

export async function probe(bytes: Uint8Array): Promise<ImageStats> {
  const sharp = await getSharp()
  const meta = await sharp(bytes).metadata()
  return {
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    bytes: bytes.length,
    format: meta.format ?? 'unknown',
  }
}

function encoder(pipeline: Sharp, format: ImageFormat, quality?: number): Sharp {
  switch (format) {
    case 'jpeg':
      // JPEG has no alpha. Flatten on white, otherwise transparent areas turn black.
      return pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: quality ?? 85 })
    case 'webp':
      return pipeline.webp({ quality: quality ?? 85 })
    default:
      // PNG "quality" maps to palette quantization, which is the only knob that shrinks it.
      return quality !== undefined && quality < 100
        ? pipeline.png({ palette: true, quality })
        : pipeline.png()
  }
}

/** Format of the input, or null when sharp cannot decode it. */
export async function detectFormat(bytes: Uint8Array): Promise<ImageFormat | null> {
  const sharp = await getSharp()
  const meta = await sharp(bytes).metadata()
  if (meta.format === 'jpeg') return 'jpeg'
  if (meta.format === 'png') return 'png'
  if (meta.format === 'webp') return 'webp'
  return null
}

export async function resize(
  bytes: Uint8Array,
  spec: { width?: number; height?: number },
  format: ImageFormat,
  quality?: number,
): Promise<Uint8Array> {
  const info = await probe(bytes)
  const size = spec.width && spec.height
    ? { width: spec.width, height: spec.height }
    : spec.width
      ? targetSize(info, { mode: 'width', value: spec.width, noUpscale: false })
      : spec.height
        ? targetSize(info, { mode: 'height', value: spec.height, noUpscale: false })
        : { width: info.width, height: info.height }
  const sharp = await getSharp()
  const out = await encoder(
    sharp(bytes).rotate().resize(size.width, size.height, { fit: 'fill' }),
    format,
    quality,
  ).toBuffer()
  return new Uint8Array(out)
}

/** Re-encode at the same pixel size. Returns the original when that would grow the file. */
export async function compress(
  bytes: Uint8Array,
  format: ImageFormat,
  quality: number,
): Promise<{ bytes: Uint8Array; usedOriginal: boolean }> {
  const sharp = await getSharp()
  const out = new Uint8Array(await encoder(sharp(bytes), format, quality).toBuffer())
  if (out.length >= bytes.length) return { bytes, usedOriginal: true }
  return { bytes: out, usedOriginal: false }
}

export async function convert(bytes: Uint8Array, format: ImageFormat, quality?: number): Promise<Uint8Array> {
  const sharp = await getSharp()
  return new Uint8Array(await encoder(sharp(bytes), format, quality).toBuffer())
}

export interface StripResult {
  bytes: Uint8Array
  format: string
  tags: string[]
  removed: number
}

export async function strip(bytes: Uint8Array, name: string): Promise<StripResult> {
  const format = sniffFormat(bytes)
  if (!format) throw new Error('Only JPEG, PNG, WebP and PDF carry metadata this tool can strip.')
  // Node 20+ has a global File, so the browser function works untouched.
  const { blob, report } = await stripMetadata(new File([bytes.slice().buffer as ArrayBuffer], name))
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    format,
    tags: report.tags,
    removed: report.bytes,
  }
}
