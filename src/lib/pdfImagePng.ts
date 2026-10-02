/**
 * pdfjs 가 넘겨준 그림을 PNG 로 굽는다. pdfLayout 이 쪽에 찍힌 그림을 꺼낼 때 쓴다.
 *
 * pdfjs 는 이미 디코딩한 화소를 준다. 원본이 JPEG 였더라도 그 바이트를 그대로
 * 꺼낼 길이 없으므로, 다시 인코딩하는 것은 피할 수 없다. 그렇다면 손실이 없는
 * PNG 로 한 번만 굽는 편이 낫다. 두 번 구운 JPEG 는 도장 가장자리가 지저분해진다.
 *
 * 따로 떼어 둔 까닭: 굽는 일은 캔버스가 하는데 Node 에는 캔버스가 없다. MCP 서버는
 * 같은 PDF 되살리기 코드를 Node 에서 돌리면서 이 파일만 sharp 로 굽는 판으로 바꿔
 * 끼운다(mcp/build.mjs, mcp/src/shims/pdfImagePng.ts). 화소를 RGBA 로 펴는 부분은
 * 양쪽이 같이 쓴다.
 */

/** pdfjs 가 넘겨주는 그림 객체. 판에 따라 담기는 자리가 다르다. */
export interface PdfImage {
  width: number
  height: number
  bitmap?: ImageBitmap
  data?: Uint8Array | Uint8ClampedArray
  kind?: number
}

/**
 * 그림의 화소를 RGBA 한 줄로 편다. 화소가 아니라 ImageBitmap 으로 온 그림은 null.
 * kind 1 = 1비트 흑백, 2 = RGB 24비트, 3 = RGBA 32비트.
 */
export function pdfImageRgba(image: PdfImage): Uint8ClampedArray<ArrayBuffer> | null {
  const { width, height, data: source } = image
  if (!width || !height || !source) return null
  const rgba = new Uint8ClampedArray(width * height * 4)
  if (image.kind === 3 || source.length === width * height * 4) {
    rgba.set(source.subarray(0, rgba.length))
  } else if (image.kind === 2 || source.length === width * height * 3) {
    for (let i = 0, j = 0; i < width * height; i += 1, j += 3) {
      rgba[i * 4] = source[j]!
      rgba[i * 4 + 1] = source[j + 1]!
      rgba[i * 4 + 2] = source[j + 2]!
      rgba[i * 4 + 3] = 255
    }
  } else {
    // 1비트 흑백. 한 바이트에 여덟 화소가 들어 있고 줄마다 바이트가 맞춰진다.
    const rowBytes = (width + 7) >> 3
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const byte = source[y * rowBytes + (x >> 3)] ?? 0
        const on = (byte >> (7 - (x & 7))) & 1
        const value = on ? 255 : 0
        const at = (y * width + x) * 4
        rgba[at] = value
        rgba[at + 1] = value
        rgba[at + 2] = value
        rgba[at + 3] = 255
      }
    }
  }
  return rgba
}

/** 그림 하나를 PNG 바이트로. 구울 수 없는 그림이면 null. */
export async function pdfImageToPng(image: PdfImage): Promise<Uint8Array | null> {
  const { width, height } = image
  if (!width || !height) return null

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  if (image.bitmap) {
    ctx.drawImage(image.bitmap, 0, 0)
  } else {
    const rgba = pdfImageRgba(image)
    if (!rgba) return null
    ctx.putImageData(new ImageData(rgba, width, height), 0, 0)
  }

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((made) => resolve(made), 'image/png'),
  )
  if (!blob) return null
  return new Uint8Array(await blob.arrayBuffer())
}
