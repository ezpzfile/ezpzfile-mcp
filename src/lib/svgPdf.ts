/**
 * rhwp 가 그려 준 페이지 SVG 를 PDF 한 장으로 옮긴다.
 *
 * 래스터로 굽지 않는 이유: rhwp 의 SVG 는 글자마다 절대 좌표가 박혀 있어서,
 * 그대로 벡터로 옮기면 글자를 고르고 검색할 수 있는 PDF 가 나온다. 이미지로
 * 구우면 한 쪽에 수백 KB 씩 붙고 글자는 그림이 된다.
 *
 * 옮기는 요소: rect·line·path·polyline·polygon·circle·ellipse·image·text,
 * 그리고 g 의 transform 과 clip-path. rhwp 가 내는 어휘가 이만큼이다.
 * 모르는 요소는 세어서 호출부에 알린다. 조용히 빠뜨리지 않는다.
 */
import type PDFDocument from 'pdfkit'
import type { PdfGradient } from 'pdfkit'

/** 문서가 쓴 글자를 어느 글꼴로 그릴지 고른다. */
export interface FontChooser {
  /**
   * pdfkit 에 등록된 글꼴 이름과 실제로 그릴 글자. 글리프가 없는 글자를 비슷한
   * 글자로 바꿔 그리는 경우가 있어 글자도 함께 돌려준다. 어디에도 없으면 null.
   */
  pick(char: string, serif: boolean): { font: string; char: string } | null
}

export interface PaintReport {
  /** 글꼴에 글리프가 없어 그리지 못한 글자 수 */
  missingGlyphs: number
  /** 우리가 다루지 못해 건너뛴 그리기 요소 수 */
  skipped: number
}

/** SVG px(96dpi) → PDF pt(72dpi) */
export const PX_TO_PT = 72 / 96

/** 기울임을 흉내 낼 기울기. 12° 정도가 한글 글꼴에서 어색하지 않다. */
const ITALIC_SLANT = Math.tan((12 * Math.PI) / 180)

/** 굵게를 흉내 낼 외곽선 두께(글자 크기 대비). */
const FAUX_BOLD = 0.028

interface Style {
  fill: string | null
  stroke: string | null
  strokeWidth: number
  fillOpacity: number
  strokeOpacity: number
  fontFamily: string
  fontSize: number
  fontWeight: string
  fontStyle: string
  dash: string | null
  lineCap: string | null
  fillRule: string | null
}

const ROOT_STYLE: Style = {
  fill: '#000000',
  stroke: null,
  strokeWidth: 1,
  fillOpacity: 1,
  strokeOpacity: 1,
  fontFamily: 'sans-serif',
  fontSize: 12,
  fontWeight: 'normal',
  fontStyle: 'normal',
  dash: null,
  lineCap: null,
  fillRule: null,
}

function attr(el: Element, name: string): string | null {
  const value = el.getAttribute(name)
  return value === null || value === '' ? null : value
}

function num(el: Element, name: string, fallback = 0): number {
  const raw = attr(el, name)
  if (raw === null) return fallback
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

/** '#rgb' 과 '#rrggbbaa' 까지 받아 pdfkit 이 아는 '#rrggbb' 로 만든다. */
function parseColor(value: string | null): { color: string; alpha: number } | null {
  if (!value) return null
  const v = value.trim()
  if (v === 'none' || v === 'transparent') return null

  if (v.startsWith('#')) {
    const hex = v.slice(1)
    if (hex.length === 3) {
      return { color: `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`, alpha: 1 }
    }
    if (hex.length === 6) return { color: `#${hex}`, alpha: 1 }
    if (hex.length === 8) {
      return { color: `#${hex.slice(0, 6)}`, alpha: Number.parseInt(hex.slice(6), 16) / 255 }
    }
    return null
  }

  const rgb = /^rgba?\(([^)]+)\)$/i.exec(v)
  if (rgb) {
    const parts = rgb[1]!.split(/[,/\s]+/).filter(Boolean).map(Number)
    const [r, g, b, a] = parts
    if (![r, g, b].every((n) => Number.isFinite(n))) return null
    const hex = [r!, g!, b!]
      .map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0'))
      .join('')
    return { color: `#${hex}`, alpha: Number.isFinite(a) ? a! : 1 }
  }

  // 이름 있는 색은 pdfkit 이 자기 표에서 찾는다.
  return { color: v, alpha: 1 }
}

function inherit(el: Element, parent: Style): Style {
  const opacity = (name: string, base: number) => {
    const raw = attr(el, name)
    if (raw === null) return base
    const parsed = Number.parseFloat(raw)
    return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : base
  }

  // opacity 는 채움·선 양쪽에 곱해진다. 그룹에 걸린 값도 이렇게 내려온다.
  const group = opacity('opacity', 1)

  return {
    fill: attr(el, 'fill') ?? parent.fill,
    stroke: attr(el, 'stroke') ?? parent.stroke,
    strokeWidth: num(el, 'stroke-width', parent.strokeWidth),
    fillOpacity: opacity('fill-opacity', parent.fillOpacity) * group,
    strokeOpacity: opacity('stroke-opacity', parent.strokeOpacity) * group,
    fontFamily: attr(el, 'font-family') ?? parent.fontFamily,
    fontSize: num(el, 'font-size', parent.fontSize),
    fontWeight: attr(el, 'font-weight') ?? parent.fontWeight,
    fontStyle: attr(el, 'font-style') ?? parent.fontStyle,
    dash: attr(el, 'stroke-dasharray') ?? parent.dash,
    lineCap: attr(el, 'stroke-linecap') ?? parent.lineCap,
    fillRule: attr(el, 'fill-rule') ?? parent.fillRule,
  }
}

/**
 * rhwp 는 대체 글꼴 목록 맨 끝에 generic 이름을 붙인다. 바탕·명조 계열이면
 * 'serif', 고딕 계열이면 'sans-serif'. 그 한 글자를 보고 계열을 가른다.
 */
export function isSerifFamily(family: string): boolean {
  const last = family.split(',').pop()?.trim().replace(/['"]/g, '') ?? ''
  if (last === 'serif') return true
  if (last === 'sans-serif' || last === 'monospace') return false
  return /serif|명조|바탕|batang|myeongjo|gungsuh|times/i.test(family)
}

function isBold(weight: string): boolean {
  if (weight === 'bold' || weight === 'bolder') return true
  const parsed = Number.parseInt(weight, 10)
  return Number.isFinite(parsed) && parsed >= 600
}

/** 'translate(3 4) scale(2)' 같은 값을 하나의 행렬로 접는다. */
type Matrix = [number, number, number, number, number, number]

function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ]
}

function parseTransform(value: string): Matrix | null {
  let matrix: Matrix = [1, 0, 0, 1, 0, 0]
  let seen = false

  for (const part of value.matchAll(/([a-zA-Z]+)\s*\(([^)]*)\)/g)) {
    const name = part[1]!
    const args = part[2]!.split(/[\s,]+/).filter(Boolean).map(Number)
    if (args.some((n) => !Number.isFinite(n))) continue
    seen = true

    if (name === 'translate') {
      matrix = multiply(matrix, [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0])
    } else if (name === 'scale') {
      matrix = multiply(matrix, [args[0] ?? 1, 0, 0, args[1] ?? args[0] ?? 1, 0, 0])
    } else if (name === 'rotate') {
      const rad = ((args[0] ?? 0) * Math.PI) / 180
      const [cx, cy] = [args[1] ?? 0, args[2] ?? 0]
      const cos = Math.cos(rad)
      const sin = Math.sin(rad)
      matrix = multiply(matrix, [1, 0, 0, 1, cx, cy])
      matrix = multiply(matrix, [cos, sin, -sin, cos, 0, 0])
      matrix = multiply(matrix, [1, 0, 0, 1, -cx, -cy])
    } else if (name === 'matrix' && args.length === 6) {
      matrix = multiply(matrix, args as unknown as Matrix)
    } else if (name === 'skewX') {
      matrix = multiply(matrix, [1, 0, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 1, 0, 0])
    } else if (name === 'skewY') {
      matrix = multiply(matrix, [1, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0])
    }
  }

  return seen ? matrix : null
}

interface Context {
  doc: PDFDocument
  fonts: FontChooser
  report: PaintReport
  clips: Map<string, Element>
  /** defs 안의 linearGradient·radialGradient */
  gradients: Map<string, Element>
}

/** 그러데이션 좌표를 풀려면 칠할 도형의 네모(bounding box)가 필요하다. */
type Box = { x: number; y: number; width: number; height: number }

/** '50%' 는 도형 크기의 절반, 그냥 숫자는 그 자리의 좌표다. */
function alongBox(raw: string | null, start: number, span: number, fallback: number): number {
  if (raw === null) return start + span * fallback
  const trimmed = raw.trim()
  if (trimmed.endsWith('%')) {
    const ratio = Number.parseFloat(trimmed) / 100
    return start + span * (Number.isFinite(ratio) ? ratio : fallback)
  }
  const value = Number.parseFloat(trimmed)
  return Number.isFinite(value) ? value : start + span * fallback
}

function offsetOf(stop: Element): number {
  const raw = attr(stop, 'offset') ?? '0'
  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value)) return 0
  return raw.trim().endsWith('%') ? value / 100 : value
}

/**
 * fill="url(#grad1)" 을 pdfkit 그러데이션으로 바꾼다.
 *
 * rhwp 는 좌표를 백분율로 적는다(SVG 기본값인 objectBoundingBox). 도형의 네모를
 * 알아야 실제 좌표가 나오므로 도형마다 네모를 함께 넘겨받는다.
 */
function buildGradient(ctx: Context, id: string, box: Box): PdfGradient | null {
  const def = ctx.gradients.get(id)
  if (!def) return null

  const userSpace = attr(def, 'gradientUnits') === 'userSpaceOnUse'
  const originX = userSpace ? 0 : box.x
  const originY = userSpace ? 0 : box.y
  const spanX = userSpace ? 0 : box.width
  const spanY = userSpace ? 0 : box.height

  const { doc } = ctx
  let gradient: PdfGradient
  if (def.tagName === 'radialGradient') {
    const cx = alongBox(attr(def, 'cx'), originX, spanX, 0.5)
    const cy = alongBox(attr(def, 'cy'), originY, spanY, 0.5)
    const fx = alongBox(attr(def, 'fx'), originX, spanX, 0.5)
    const fy = alongBox(attr(def, 'fy'), originY, spanY, 0.5)
    // 반지름은 한 축만 쓸 수 없어 두 변의 평균으로 잡는다.
    const scale = userSpace ? 1 : Math.max(box.width, box.height)
    const r = alongBox(attr(def, 'r'), 0, scale, 0.5)
    if (!(r > 0)) return null
    gradient = doc.radialGradient(fx, fy, 0, cx, cy, r)
  } else {
    const x1 = alongBox(attr(def, 'x1'), originX, spanX, 0)
    const y1 = alongBox(attr(def, 'y1'), originY, spanY, 0)
    const x2 = alongBox(attr(def, 'x2'), originX, spanX, 1)
    const y2 = alongBox(attr(def, 'y2'), originY, spanY, 0)
    gradient = doc.linearGradient(x1, y1, x2, y2)
  }

  let stops = 0
  for (const stop of Array.from(def.children)) {
    if (stop.tagName !== 'stop') continue
    const color = parseColor(attr(stop, 'stop-color') ?? '#000000')
    if (!color) continue
    const opacity = Number.parseFloat(attr(stop, 'stop-opacity') ?? '1')
    gradient.stop(offsetOf(stop), color.color, Number.isFinite(opacity) ? opacity : 1)
    stops += 1
  }
  return stops > 0 ? gradient : null
}

/** 색이거나 그러데이션이거나. 둘 다 아니면 칠하지 않는다. */
function resolvePaint(
  ctx: Context,
  value: string | null,
  box: Box | null,
): { paint: string | PdfGradient; alpha: number } | null {
  const url = value === null ? null : /url\(#([^)]+)\)/.exec(value)
  if (url) {
    const gradient = box ? buildGradient(ctx, url[1]!, box) : null
    if (gradient) return { paint: gradient, alpha: 1 }
    // 무늬(pattern) 채우기 등 우리가 못 만드는 참조. 칠하지 않고 세어 둔다.
    ctx.report.skipped += 1
    return null
  }
  const color = parseColor(value)
  return color ? { paint: color.color, alpha: color.alpha } : null
}

/** 채움·선 색을 정하고 실제로 칠한다. 둘 다 없으면 애초에 경로를 만들지 않는다. */
function paintPath(ctx: Context, style: Style, box: Box | null, build: () => void): void {
  const fill = resolvePaint(ctx, style.fill, box)
  const stroke = resolvePaint(ctx, style.stroke, box)
  if (!fill && !stroke) return

  const { doc } = ctx
  doc.save()
  if (fill) doc.fillOpacity(style.fillOpacity * fill.alpha)
  if (stroke) {
    doc.strokeOpacity(style.strokeOpacity * stroke.alpha)
    doc.lineWidth(Math.max(style.strokeWidth, 0.1))
    if (style.lineCap === 'round' || style.lineCap === 'butt' || style.lineCap === 'square') {
      doc.lineCap(style.lineCap)
    }
    if (style.dash) {
      const gaps = style.dash.split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0)
      if (gaps.length > 0) doc.dash(gaps[0]!, { space: gaps[1] ?? gaps[0]! })
    }
  }

  build()

  const rule = style.fillRule === 'evenodd' ? 'even-odd' : undefined
  if (fill && stroke) doc.fillAndStroke(fill.paint, stroke.paint, rule)
  else if (fill) doc.fill(fill.paint, rule)
  else doc.stroke(stroke!.paint)
  doc.restore()
}

function drawText(ctx: Context, el: Element, style: Style): void {
  const text = el.textContent ?? ''
  if (text === '') return

  const { doc, fonts, report } = ctx
  const serif = isSerifFamily(style.fontFamily)
  const size = style.fontSize
  if (size <= 0) return

  // 한 글자씩 글꼴을 고른 뒤, 같은 글꼴이 이어지는 만큼 묶는다.
  const runs: { font: string; text: string }[] = []
  for (const ch of text) {
    const picked = fonts.pick(ch, serif)
    if (picked === null) {
      report.missingGlyphs += 1
      continue
    }
    const last = runs[runs.length - 1]
    if (last && last.font === picked.font) last.text += picked.char
    else runs.push({ font: picked.font, text: picked.char })
  }
  if (runs.length === 0) return

  const fill = parseColor(style.fill) ?? { color: '#000000', alpha: 1 }
  const bold = isBold(style.fontWeight)
  const italic = style.fontStyle === 'italic' || style.fontStyle === 'oblique'
  const x = num(el, 'x')
  const y = num(el, 'y')

  let natural = 0
  for (const run of runs) {
    doc.font(run.font).fontSize(size)
    natural += doc.widthOfString(run.text)
  }

  // textLength 는 rhwp 가 "이만큼 차지해야 한다"고 알려 주는 값이다. 우리 글꼴의
  // 폭이 다르면 가로로만 늘리거나 줄여 맞춘다. 그래야 뒤 글자와 겹치지 않는다.
  const wanted = attr(el, 'textLength') === null ? null : num(el, 'textLength')
  const scaleX = wanted !== null && natural > 0 ? wanted / natural : 1
  const slant = italic ? ITALIC_SLANT : 0
  const transformed = Math.abs(scaleX - 1) > 0.005 || slant !== 0

  doc.save()
  doc.fillOpacity(style.fillOpacity * fill.alpha)
  if (transformed) {
    // 가로 배율은 x 를, 기울임은 기준선 y 를 축으로 삼는다.
    doc.transform(scaleX, 0, -scaleX * slant, 1, scaleX * slant * y + x * (1 - scaleX), 0)
  }
  if (bold) doc.lineWidth(size * FAUX_BOLD).strokeColor(fill.color)

  let cursor = x
  for (const run of runs) {
    doc.font(run.font).fontSize(size).fillColor(fill.color)
    doc.text(run.text, cursor, y, {
      lineBreak: false,
      baseline: 'alphabetic',
      fill: true,
      stroke: bold,
    })
    cursor += doc.widthOfString(run.text)
  }
  doc.restore()
}

/**
 * data: URI 안의 SVG 를 꺼낸다. rhwp 는 수식 같은 벡터 조각을 이렇게 박아 넣는다.
 * pdfkit 의 image() 는 PNG·JPEG 만 읽으므로, 그림으로 굽는 대신 우리 그리기
 * 코드로 다시 펼친다. 그러면 그 안의 글자도 글자로 남는다.
 */
function decodeSvgHref(href: string): string | null {
  const match = /^data:image\/svg\+xml(;[^,]*)?,(.*)$/is.exec(href)
  if (!match) return null
  const body = match[2]!
  try {
    if ((match[1] ?? '').includes('base64')) {
      const binary = atob(body)
      const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0))
      return new TextDecoder().decode(bytes)
    }
    return decodeURIComponent(body)
  } catch {
    return null
  }
}

function drawNestedSvg(ctx: Context, el: Element, href: string, width: number, height: number): boolean {
  const source = decodeSvgHref(href)
  if (source === null) return false

  const inner = new DOMParser().parseFromString(source, 'image/svg+xml').documentElement
  if (inner.tagName !== 'svg') return false

  const viewBox = (inner.getAttribute('viewBox') ?? '')
    .split(/[\s,]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n))
  const [boxX, boxY, boxW, boxH] =
    viewBox.length === 4
      ? (viewBox as [number, number, number, number])
      : [0, 0, Number.parseFloat(inner.getAttribute('width') ?? '0'), Number.parseFloat(inner.getAttribute('height') ?? '0')]
  if (!(boxW > 0) || !(boxH > 0)) return false

  const uniform = (attr(el, 'preserveAspectRatio') ?? 'xMidYMid') !== 'none'
  const rawX = width / boxW
  const rawY = height / boxH
  const scaleX = uniform ? Math.min(rawX, rawY) : rawX
  const scaleY = uniform ? Math.min(rawX, rawY) : rawY
  // 비율을 지킬 때는 남는 자리를 가운데로 민다(xMidYMid meet).
  const padX = uniform ? (width - boxW * scaleX) / 2 : 0
  const padY = uniform ? (height - boxH * scaleY) / 2 : 0

  const { doc } = ctx
  doc.save()
  doc.transform(
    scaleX,
    0,
    0,
    scaleY,
    num(el, 'x') + padX - boxX * scaleX,
    num(el, 'y') + padY - boxY * scaleY,
  )
  // 안쪽 SVG 의 id 는 바깥 문서와 겹칠 수 있다. 참조표를 따로 만들어 섞이지 않게 한다.
  paintElement({ ...ctx, ...collectDefs(inner) }, inner, ROOT_STYLE)
  doc.restore()
  return true
}

function drawImage(ctx: Context, el: Element): void {
  const href = attr(el, 'href') ?? attr(el, 'xlink:href')
  const width = num(el, 'width')
  const height = num(el, 'height')
  if (!href || !href.startsWith('data:') || width <= 0 || height <= 0) {
    ctx.report.skipped += 1
    return
  }
  if (/^data:image\/svg\+xml/i.test(href)) {
    if (!drawNestedSvg(ctx, el, href, width, height)) ctx.report.skipped += 1
    return
  }
  try {
    ctx.doc.image(href, num(el, 'x'), num(el, 'y'), { width, height })
  } catch {
    // 못 읽는 그림 하나 때문에 문서 전체를 버리지 않는다.
    ctx.report.skipped += 1
  }
}

function boxOf(pts: [number, number][]): Box | null {
  if (pts.length === 0) return null
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

/**
 * path 의 네모를 좌표 숫자만 긁어 어림한다. 곡선의 제어점까지 포함하므로 실제
 * 그려지는 것보다 조금 넓을 수 있지만, 그러데이션 방향을 잡는 데는 충분하다.
 */
function pathBox(d: string): Box | null {
  const numbers = d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)?.map(Number) ?? []
  const pts: [number, number][] = []
  for (let i = 0; i + 1 < numbers.length; i += 2) pts.push([numbers[i]!, numbers[i + 1]!])
  return boxOf(pts)
}

function points(el: Element): [number, number][] {
  const raw = attr(el, 'points') ?? ''
  const nums = raw.split(/[\s,]+/).map(Number).filter((n) => Number.isFinite(n))
  const out: [number, number][] = []
  for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i]!, nums[i + 1]!])
  return out
}

function applyClip(ctx: Context, value: string): boolean {
  const id = /url\(#([^)]+)\)/.exec(value)?.[1]
  const clip = id ? ctx.clips.get(id) : undefined
  if (!clip) return false

  const { doc } = ctx
  let built = false
  for (const child of Array.from(clip.children)) {
    if (child.tagName === 'rect') {
      doc.rect(num(child, 'x'), num(child, 'y'), num(child, 'width'), num(child, 'height'))
      built = true
    } else if (child.tagName === 'path' && attr(child, 'd')) {
      doc.path(attr(child, 'd')!)
      built = true
    } else if (child.tagName === 'polygon') {
      const pts = points(child)
      if (pts.length > 1) {
        doc.moveTo(pts[0]![0], pts[0]![1])
        for (const [px, py] of pts.slice(1)) doc.lineTo(px, py)
        doc.closePath()
        built = true
      }
    }
  }
  if (built) doc.clip()
  return built
}

function paintElement(ctx: Context, el: Element, parent: Style): void {
  const tag = el.tagName
  if (tag === 'defs' || tag === 'clipPath' || tag === 'title' || tag === 'desc' || tag === 'metadata') {
    return
  }

  const style = inherit(el, parent)
  const { doc } = ctx

  const transform = attr(el, 'transform')
  const clipPath = attr(el, 'clip-path')
  const wrapped = transform !== null || clipPath !== null
  if (wrapped) {
    doc.save()
    if (transform) {
      const m = parseTransform(transform)
      if (m) doc.transform(m[0], m[1], m[2], m[3], m[4], m[5])
    }
    if (clipPath) applyClip(ctx, clipPath)
  }

  switch (tag) {
    case 'g':
    case 'svg':
    case 'a':
    case 'switch':
      for (const child of Array.from(el.children)) paintElement(ctx, child, style)
      break

    case 'rect': {
      const w = num(el, 'width')
      const h = num(el, 'height')
      if (w > 0 && h > 0) {
        const x = num(el, 'x')
        const y = num(el, 'y')
        const rx = num(el, 'rx', num(el, 'ry'))
        paintPath(ctx, style, { x, y, width: w, height: h }, () => {
          if (rx > 0) doc.roundedRect(x, y, w, h, rx)
          else doc.rect(x, y, w, h)
        })
      }
      break
    }

    case 'line':
      // 선은 채우지 않는다. stroke 가 없으면 아무것도 아니다.
      if (style.stroke) {
        paintPath(ctx, { ...style, fill: null }, null, () => {
          doc.moveTo(num(el, 'x1'), num(el, 'y1')).lineTo(num(el, 'x2'), num(el, 'y2'))
        })
      }
      break

    case 'path': {
      const d = attr(el, 'd')
      if (d) paintPath(ctx, style, pathBox(d), () => doc.path(d))
      break
    }

    case 'polyline':
    case 'polygon': {
      const pts = points(el)
      if (pts.length > 1) {
        const open = tag === 'polyline'
        paintPath(ctx, open ? { ...style, fill: attr(el, 'fill') } : style, boxOf(pts), () => {
          doc.moveTo(pts[0]![0], pts[0]![1])
          for (const [px, py] of pts.slice(1)) doc.lineTo(px, py)
          if (!open) doc.closePath()
        })
      }
      break
    }

    case 'circle': {
      const r = num(el, 'r')
      if (r > 0) {
        const cx = num(el, 'cx')
        const cy = num(el, 'cy')
        paintPath(ctx, style, { x: cx - r, y: cy - r, width: r * 2, height: r * 2 }, () =>
          doc.circle(cx, cy, r),
        )
      }
      break
    }

    case 'ellipse': {
      const rx = num(el, 'rx')
      const ry = num(el, 'ry')
      if (rx > 0 && ry > 0) {
        const cx = num(el, 'cx')
        const cy = num(el, 'cy')
        paintPath(ctx, style, { x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2 }, () =>
          doc.ellipse(cx, cy, rx, ry),
        )
      }
      break
    }

    case 'text':
      drawText(ctx, el, style)
      break

    case 'image':
      drawImage(ctx, el)
      break

    default:
      ctx.report.skipped += 1
      break
  }

  if (wrapped) doc.restore()
}

/** clip-path·그러데이션 참조표. SVG 문서마다 따로 만든다. */
function collectDefs(root: Element): { clips: Map<string, Element>; gradients: Map<string, Element> } {
  const clips = new Map<string, Element>()
  for (const clip of Array.from(root.querySelectorAll('clipPath'))) {
    const id = clip.getAttribute('id')
    if (id) clips.set(id, clip)
  }

  const gradients = new Map<string, Element>()
  for (const def of Array.from(root.querySelectorAll('linearGradient, radialGradient'))) {
    const id = def.getAttribute('id')
    if (id) gradients.set(id, def)
  }

  return { clips, gradients }
}

/**
 * 페이지 SVG 를 현재 페이지에 그린다. 페이지는 호출부가 이미 열어 두어야 하고,
 * 좌표계는 SVG 와 같은 px 로 맞춰 두어야 한다(PX_TO_PT 만큼 축소된 상태).
 */
export function paintSvg(
  doc: PDFDocument,
  svg: SVGSVGElement,
  fonts: FontChooser,
  report: PaintReport,
): void {
  paintElement({ doc, fonts, report, ...collectDefs(svg) }, svg, ROOT_STYLE)
}
