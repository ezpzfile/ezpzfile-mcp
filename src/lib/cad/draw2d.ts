/**
 * 2D CAD 도면(DWG·DXF·DWFx 시트)을 캔버스에 그린다. 화면 쪽(CadSheetView)이 쓰는 그리기 엔진이다.
 *
 * 항목이 수십만 개(런던 도면 37만 개)라 SVG 로는 끌 때마다 멈춘다. 그래서
 * - 항목마다 상자(bbox)를 재고, 격자(spatial index)에 넣어 둔다. 화면에 걸리는 칸의 항목만 그린다.
 * - 화면에서 0.5 px 보다 작은 항목과 2.5 px 보다 작은 글자는 건너뛰고, 선의 점은 0.7 px 안쪽이면 줄인다.
 *   단, 끝이 이어지는 작은 선들은 끝점을 따라가며 묶어 긋는다. 원·호를 짧은 선 수백 개로 쪼개 저장한
 *   도면(다른 변환기가 만든 DXF 등)은 조각 하나하나가 0.5 px 보다 작아, 전체 보기에서 원이 통째로 사라졌다(2026-11-05).
 * - 같은 색·굵기·점선이 이어지는 선은 한 경로로 묶어 한 번에 긋는다.
 * - 끌고 확대하는 동안은 마지막으로 그린 그림(캐시)을 옮기고 늘려 보여 주고, 멈추면 다시 그린다.
 *   그리는 데 오래 걸리면 여러 프레임에 나눠 그린다(renderSlice).
 *
 * 좌표: 시트 mm, 원점 왼쪽 아래, y 위쪽. 화면 px: X = tx + x * s, Y = ty - y * s.
 */
import { arcSweep } from '../rvt/arc.ts'
import type { RvtSheet2D, SheetItem } from '../rvt/types.ts'

/**
 * 글꼴 목록. 파일이 정한 글꼴(예: 'ＭＳ ゴシック')이 없으면 Arial, 그다음 일본어·한국어 시스템 글꼴로 내려간다.
 * 브라우저는 글자마다 목록을 차례로 보므로, 영문은 Arial 로, 일본어 글자는 일본어 글꼴로 그린다(Jw_cad, 일본 DXF).
 */
export const FONT_FALLBACK = 'Arial, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", YuGothic, Meiryo, "Noto Sans JP", "Noto Sans CJK JP", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif'

export interface View {
  s: number
  tx: number
  ty: number
}

export interface Prepared {
  sheet: RvtSheet2D
  n: number
  /** 항목 상자 x0, y0, x1, y1 */
  bb: Float32Array
  /** 레이어 번호(layerNames 의 자리), 없으면 -1 */
  layer: Int32Array
  layerNames: string[]
  ext: [number, number, number, number]
  gx: number
  gy: number
  cw: number
  ch: number
  nx: number
  ny: number
  cellStart: Int32Array
  cellList: Int32Array
  big: Int32Array
  texts: Int32Array
  stamp: Uint32Array
  gen: number
}

function itemBox(it: SheetItem): [number, number, number, number] {
  switch (it.kind) {
    case 'line':
    case 'fill': {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      const p = it.pts
      for (let i = 0; i + 1 < p.length; i += 2) {
        const x = p[i]!, y = p[i + 1]!
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
      return [x0, y0, x1, y1]
    }
    case 'arc':
      return [it.cx - it.r, it.cy - it.r, it.cx + it.r, it.cy + it.r]
    case 'text': {
      // 글자 폭은 모른다. 대충 글자 수 x 0.6 em 으로 잡고 돌림을 감싼다
      const w = Math.max(1, it.text.length) * it.size * 0.6
      const h = it.size
      const dx = it.align === 'center' ? -w / 2 : it.align === 'right' ? -w : 0
      const r = it.rot ?? 0
      const c = Math.cos(r), s = Math.sin(r)
      const xs: number[] = [], ys: number[] = []
      for (const [u, v] of [[dx, -h * 0.25], [dx + w, -h * 0.25], [dx, h], [dx + w, h]] as const) {
        xs.push(it.x + u * c - v * s)
        ys.push(it.y + u * s + v * c)
      }
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
    }
    case 'image':
      return [it.x, it.y, it.x + it.w, it.y + it.h]
  }
}

export function prepare(sheet: RvtSheet2D, layerNames: string[]): Prepared {
  const items = sheet.items
  const n = items.length
  const bb = new Float32Array(n * 4)
  const layer = new Int32Array(n).fill(-1)
  const li = new Map(layerNames.map((l, i) => [l, i]))
  let ex0 = Infinity, ey0 = Infinity, ex1 = -Infinity, ey1 = -Infinity
  const texts: number[] = []
  for (let i = 0; i < n; i++) {
    const it = items[i]!
    const b = itemBox(it)
    if (!Number.isFinite(b[0]) || !Number.isFinite(b[3])) {
      bb[i * 4] = bb[i * 4 + 1] = 1e30
      bb[i * 4 + 2] = bb[i * 4 + 3] = -1e30
      continue
    }
    bb[i * 4] = b[0]
    bb[i * 4 + 1] = b[1]
    bb[i * 4 + 2] = b[2]
    bb[i * 4 + 3] = b[3]
    if (b[0] < ex0) ex0 = b[0]
    if (b[1] < ey0) ey0 = b[1]
    if (b[2] > ex1) ex1 = b[2]
    if (b[3] > ey1) ey1 = b[3]
    if (it.layer != null) {
      let k = li.get(it.layer)
      if (k == null) {
        k = layerNames.length
        layerNames.push(it.layer)
        li.set(it.layer, k)
      }
      layer[i] = k
    }
    if (it.kind === 'text') texts.push(i)
  }
  if (!Number.isFinite(ex0)) {
    ex0 = 0
    ey0 = 0
    ex1 = sheet.size.w
    ey1 = sheet.size.h
  }
  ex0 = Math.min(ex0, 0)
  ey0 = Math.min(ey0, 0)
  ex1 = Math.max(ex1, sheet.size.w)
  ey1 = Math.max(ey1, sheet.size.h)
  // 칸 하나에 평균 8개쯤
  const side = Math.max(8, Math.min(512, Math.round(Math.sqrt(n / 8))))
  const W = Math.max(1e-6, ex1 - ex0)
  const H = Math.max(1e-6, ey1 - ey0)
  const nx = W >= H ? side : Math.max(1, Math.round((side * W) / H))
  const ny = W >= H ? Math.max(1, Math.round((side * H) / W)) : side
  const cw = W / nx
  const ch = H / ny
  const counts = new Int32Array(nx * ny + 1)
  const big: number[] = []
  const span = (i: number) => {
    const a = Math.max(0, Math.min(nx - 1, Math.floor((bb[i * 4]! - ex0) / cw)))
    const b = Math.max(0, Math.min(nx - 1, Math.floor((bb[i * 4 + 2]! - ex0) / cw)))
    const c = Math.max(0, Math.min(ny - 1, Math.floor((bb[i * 4 + 1]! - ey0) / ch)))
    const d = Math.max(0, Math.min(ny - 1, Math.floor((bb[i * 4 + 3]! - ey0) / ch)))
    return [a, b, c, d] as const
  }
  const isBig = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (bb[i * 4]! > bb[i * 4 + 2]!) continue
    const [a, b, c, d] = span(i)
    if ((b - a + 1) * (d - c + 1) > 64) {
      big.push(i)
      isBig[i] = 1
      continue
    }
    for (let y = c; y <= d; y++) for (let x = a; x <= b; x++) counts[y * nx + x + 1]!++
  }
  for (let k = 1; k <= nx * ny; k++) counts[k]! += counts[k - 1]!
  const cellStart = counts
  const fill = cellStart.slice(0, nx * ny)
  const cellList = new Int32Array(cellStart[nx * ny]!)
  for (let i = 0; i < n; i++) {
    if (isBig[i] || bb[i * 4]! > bb[i * 4 + 2]!) continue
    const [a, b, c, d] = span(i)
    for (let y = c; y <= d; y++) for (let x = a; x <= b; x++) cellList[fill[y * nx + x]!++] = i
  }
  return {
    sheet,
    n,
    bb,
    layer,
    layerNames,
    ext: [ex0, ey0, ex1, ey1],
    gx: ex0,
    gy: ey0,
    cw,
    ch,
    nx,
    ny,
    cellStart,
    cellList,
    big: Int32Array.from(big),
    texts: Int32Array.from(texts),
    stamp: new Uint32Array(n),
    gen: 0,
  }
}

/** 사각형(시트 mm)에 걸리는 항목 번호. 그리는 순서(원래 순서)대로 */
export function query(p: Prepared, x0: number, y0: number, x1: number, y1: number): Int32Array {
  const [ex0, ey0, ex1, ey1] = p.ext
  if (x0 <= ex0 && y0 <= ey0 && x1 >= ex1 && y1 >= ey1) {
    const all = new Int32Array(p.n)
    for (let i = 0; i < p.n; i++) all[i] = i
    return all
  }
  p.gen = (p.gen + 1) >>> 0
  if (p.gen === 0) {
    p.stamp.fill(0)
    p.gen = 1
  }
  const g = p.gen
  const out: number[] = []
  const a = Math.max(0, Math.floor((x0 - p.gx) / p.cw))
  const b = Math.min(p.nx - 1, Math.floor((x1 - p.gx) / p.cw))
  const c = Math.max(0, Math.floor((y0 - p.gy) / p.ch))
  const d = Math.min(p.ny - 1, Math.floor((y1 - p.gy) / p.ch))
  const bb = p.bb
  const hit = (i: number) => bb[i * 4]! <= x1 && bb[i * 4 + 2]! >= x0 && bb[i * 4 + 1]! <= y1 && bb[i * 4 + 3]! >= y0
  for (let y = c; y <= d; y++)
    for (let x = a; x <= b; x++) {
      const k = y * p.nx + x
      for (let j = p.cellStart[k]!; j < p.cellStart[k + 1]!; j++) {
        const i = p.cellList[j]!
        if (p.stamp[i] === g) continue
        p.stamp[i] = g
        if (hit(i)) out.push(i)
      }
    }
  for (const i of p.big) if (hit(i)) out.push(i)
  const arr = Int32Array.from(out)
  arr.sort()
  return arr
}

export interface DrawOpts {
  /** 레이어 번호마다 1 이면 숨김 */
  hidden: Uint8Array
  dark: boolean
  bg: string
  images: Map<number, ImageBitmap>
  /** 이 항목은 강조(찾기) */
  highlight?: number | null
  /** 화면 px 당 장치 px */
  dpr: number
  /** 레이어 번호마다 불투명도(0..1, PCB 층 투명도). 없으면 1 */
  alpha?: Float32Array
}

const DARK_INK = '#ffffff'

/** 배경에 맞춰 색을 바꾼다. 흰 종이용 검정(ACI 7)은 어두운 배경에서 흰색, 흰 덮개(와이프아웃)는 배경색 */
export function inkFor(color: string | undefined, dark: boolean, bg: string, fill = false) {
  const c = (color ?? '#000000').toLowerCase()
  if (!dark) return c === '#ffffff' && !fill ? '#000000' : c
  if (c === '#000000' || c === '#000' || c === 'black') return DARK_INK
  if ((c === '#ffffff' || c === '#fff' || c === 'white') && fill) return bg
  return c
}

/**
 * list[from..] 를 그린다. deadline(performance.now() 기준 ms)을 넘기면 멈추고 다음 자리를 돌려준다.
 * 끝까지 그렸으면 list.length.
 */
export function renderSlice(ctx: CanvasRenderingContext2D, p: Prepared, list: Int32Array, from: number, v: View, o: DrawOpts, deadline = Infinity): number {
  const items = p.sheet.items
  const s = v.s
  const tx = v.tx
  const ty = v.ty
  const minPx = 0.5
  const tol = 0.7
  let curKey = ''
  let segs = 0
  let open = false
  // 마지막으로 그은 선의 끝(화면 px)과, 경로에 실제로 넣은 마지막 점. 이어지는 작은 선을 잇는 데 쓴다.
  let endX = NaN
  let endY = NaN
  let penX = NaN
  let penY = NaN
  // 이어 그리는 작은 선들의 방향(단위 벡터). 원·호처럼 부드럽게 도는 줄만 잇는다.
  let dirX = 0
  let dirY = 0
  const flush = () => {
    if (open) {
      ctx.stroke()
      open = false
    }
    segs = 0
    endX = NaN
  }
  let la = 1
  const setStroke = (it: { color?: string; w?: number; dash?: number[] }) => {
    const col = inkFor(it.color, o.dark, o.bg)
    const lw = it.w ? Math.max(0.8, Math.min(it.w * s, 64)) : 1
    let dash = ''
    if (it.dash && it.dash.length) {
      let tot = 0
      for (const d of it.dash) tot += Math.abs(d)
      if (tot * s >= 3) dash = it.dash.map((d) => Math.max(0.5, Math.abs(d) * s).toFixed(1)).join(',')
    }
    const key = `${col}|${lw}|${dash}|${la}`
    if (key === curKey && open && segs < 4000) return
    flush()
    curKey = key
    ctx.globalAlpha = la
    ctx.strokeStyle = col
    ctx.lineWidth = lw
    ctx.setLineDash(dash ? dash.split(',').map(Number) : [])
    ctx.beginPath()
    open = true
  }
  const bb = p.bb
  let i = from
  for (; i < list.length; i++) {
    if ((i & 1023) === 0 && i > from && performance.now() > deadline) break
    const k = list[i]!
    const L = p.layer[k]!
    if (L >= 0 && o.hidden[L]) continue
    la = o.alpha && L >= 0 ? (o.alpha[L] ?? 1) : 1
    if (la <= 0) continue
    const bw = (bb[k * 4 + 2]! - bb[k * 4]!) * s
    const bh = (bb[k * 4 + 3]! - bb[k * 4 + 1]!) * s
    const it = items[k]!
    if (bw < minPx && bh < minPx && it.kind !== 'text') {
      // 작은 선: 끝점만 따라가며, 펜이 0.7 px 넘게 움직였을 때 긋는다. 앞 선에 이어지면 그 경로를 잇고,
      // 아니면 새로 출발점만 잡는다. 따로 떨어진 작은 선은 결국 아무것도 긋지 않는다(예전처럼 건너뜀).
      if (it.kind !== 'line' || it.pts.length < 4) continue
      const sx0 = tx + it.pts[0]! * s
      const sy0 = ty - it.pts[1]! * s
      const key = curKey
      const fromX = endX
      const fromY = endY
      setStroke(it)
      const n = it.pts.length
      const ddx = it.pts[n - 2]! - it.pts[0]!
      const ddy = it.pts[n - 1]! - it.pts[1]!
      const dl = Math.hypot(ddx, ddy) || 1
      const ux = ddx / dl
      const uy = ddy / dl
      // 원·호처럼 조금씩(30도 안쪽) 도는 줄만 잇는다. 곧게 이어진 조각(잘게 끊긴 해치 선 등)이나 크게 꺾이는
      // 무늬까지 이으면, 예전에 건너뛰던 촘촘한 부분이 덩어리처럼 칠해져 보인다(농가 주택 도면에서 확인).
      const turn = ux * dirX + uy * dirY
      const smooth = dirX === 0 && dirY === 0 ? true : turn >= 0.866 && turn < 0.99999
      const joined = smooth && curKey === key && !Number.isNaN(fromX) && Math.abs(sx0 - fromX) <= tol && Math.abs(sy0 - fromY) <= tol
      dirX = ux
      dirY = uy
      if (!joined) {
        ctx.moveTo(sx0, sy0)
        penX = sx0
        penY = sy0
      } else if (Number.isNaN(endX)) {
        // 경로가 길어 새로 시작했다: 이어 그릴 점에서 다시 출발
        ctx.moveTo(fromX, fromY)
        penX = fromX
        penY = fromY
      }
      endX = tx + it.pts[n - 2]! * s
      endY = ty - it.pts[n - 1]! * s
      if (Math.abs(endX - penX) >= tol || Math.abs(endY - penY) >= tol) {
        ctx.lineTo(endX, endY)
        penX = endX
        penY = endY
        segs++
      }
      continue
    }
    switch (it.kind) {
      case 'line': {
        const pts = it.pts
        if (pts.length < 4) break
        setStroke(it)
        let lx = tx + pts[0]! * s
        let ly = ty - pts[1]! * s
        ctx.moveTo(lx, ly)
        const last = pts.length - 2
        for (let j = 2; j < pts.length; j += 2) {
          const x = tx + pts[j]! * s
          const y = ty - pts[j + 1]! * s
          if (j !== last && Math.abs(x - lx) < tol && Math.abs(y - ly) < tol) continue
          ctx.lineTo(x, y)
          lx = x
          ly = y
        }
        segs += pts.length >> 1
        {
          const ex = pts[last]! - pts[last - 2]!
          const ey = pts[last + 1]! - pts[last - 1]!
          const el = Math.hypot(ex, ey) || 1
          dirX = ex / el
          dirY = ey / el
        }
        endX = tx + pts[last]! * s
        endY = ty - pts[last + 1]! * s
        penX = lx
        penY = ly
        break
      }
      case 'arc': {
        setStroke(it)
        const r = it.r * s
        const cx = tx + it.cx * s
        const cy = ty - it.cy * s
        const sweep = arcSweep(it.a0, it.a1, it.r, it.cx, it.cy)
        if (sweep == null) break
        const full = sweep >= Math.PI * 2 - 1e-6
        // y 를 뒤집으므로 각도도 뒤집고 시계 방향으로
        if (full) {
          ctx.moveTo(cx + r, cy)
          ctx.arc(cx, cy, r, 0, Math.PI * 2)
        } else {
          ctx.moveTo(cx + r * Math.cos(-it.a0), cy + r * Math.sin(-it.a0))
          ctx.arc(cx, cy, r, -it.a0, -(it.a0 + sweep), true)
        }
        segs += 8
        break
      }
      case 'fill': {
        const pts = it.pts
        if (pts.length < 6) break
        flush()
        ctx.fillStyle = inkFor(it.color, o.dark, o.bg, true)
        ctx.globalAlpha = (it.opacity ?? 1) * la
        ctx.beginPath()
        ctx.moveTo(tx + pts[0]! * s, ty - pts[1]! * s)
        for (let j = 2; j < pts.length; j += 2) ctx.lineTo(tx + pts[j]! * s, ty - pts[j + 1]! * s)
        ctx.closePath()
        ctx.fill('evenodd')
        ctx.globalAlpha = 1
        break
      }
      case 'text': {
        const px = it.size * s
        if (px < 2.5 || !it.text) break
        flush()
        ctx.save()
        ctx.globalAlpha = la
        ctx.translate(tx + it.x * s, ty - it.y * s)
        if (it.rot) ctx.rotate(-it.rot)
        ctx.fillStyle = k === o.highlight ? '#ff5a1f' : inkFor(it.color, o.dark, o.bg)
        ctx.font = `${px.toFixed(2)}px ${it.font ? `"${it.font.replace(/"/g, '')}", ` : ''}${FONT_FALLBACK}`
        ctx.textAlign = it.align === 'center' ? 'center' : it.align === 'right' ? 'right' : 'left'
        ctx.textBaseline = 'alphabetic'
        ctx.fillText(it.text, 0, 0)
        ctx.restore()
        break
      }
      case 'image': {
        const bmp = o.images.get(k)
        if (!bmp) break
        flush()
        ctx.globalAlpha = la
        ctx.drawImage(bmp, tx + it.x * s, ty - (it.y + it.h) * s, it.w * s, it.h * s)
        break
      }
    }
  }
  flush()
  ctx.globalAlpha = 1
  return i
}

/** 화면 점(px)에서 가장 가까운 끝점·꼭짓점·원 중심(r px 안쪽)과 그 점을 가진 항목 번호. 없으면 null */
export function snap(p: Prepared, v: View, sx: number, sy: number, hidden: Uint8Array, r = 10): [number, number, number] | null {
  const x = (sx - v.tx) / v.s
  const y = (v.ty - sy) / v.s
  const rr = r / v.s
  const list = query(p, x - rr, y - rr, x + rr, y + rr)
  let best: [number, number, number] | null = null
  let bd = rr * rr
  let cur = -1
  const test = (px: number, py: number) => {
    const d = (px - x) ** 2 + (py - y) ** 2
    if (d <= bd) {
      bd = d
      best = [px, py, cur]
    }
  }
  const items = p.sheet.items
  for (const k of list) {
    cur = k
    const L = p.layer[k]!
    if (L >= 0 && hidden[L]) continue
    const it = items[k]!
    if (it.kind === 'line' || it.kind === 'fill') {
      const pts = it.pts
      if (pts.length > 4000) {
        test(pts[0]!, pts[1]!)
        test(pts[pts.length - 2]!, pts[pts.length - 1]!)
      } else for (let j = 0; j + 1 < pts.length; j += 2) test(pts[j]!, pts[j + 1]!)
    } else if (it.kind === 'arc') {
      const sweep = arcSweep(it.a0, it.a1, it.r, it.cx, it.cy)
      if (sweep == null) continue
      test(it.cx, it.cy)
      if (sweep < Math.PI * 2 - 1e-6) {
        test(it.cx + it.r * Math.cos(it.a0), it.cy + it.r * Math.sin(it.a0))
        test(it.cx + it.r * Math.cos(it.a0 + sweep), it.cy + it.r * Math.sin(it.a0 + sweep))
      }
    }
  }
  return best
}

/** 화면 점(px)에서 r px 안쪽의 가장 가까운 보이는 선·호(없으면 상자에 든 항목). 없으면 -1 */
export function itemAt(p: Prepared, v: View, sx: number, sy: number, hidden: Uint8Array, r = 10): number {
  const x = (sx - v.tx) / v.s
  const y = (v.ty - sy) / v.s
  const rr = r / v.s
  const list = query(p, x - rr, y - rr, x + rr, y + rr)
  let best = -1
  let bd = rr
  const seg = (ax: number, ay: number, bx: number, by: number) => {
    const dx = bx - ax, dy = by - ay
    const L = dx * dx + dy * dy
    const t = L > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L)) : 0
    return Math.hypot(x - (ax + t * dx), y - (ay + t * dy))
  }
  const items = p.sheet.items
  for (const k of list) {
    const L = p.layer[k]!
    if (L >= 0 && hidden[L]) continue
    const it = items[k]!
    let d = Infinity
    if (it.kind === 'line') {
      const q = it.pts
      if (q.length <= 4000) for (let j = 0; j + 3 < q.length; j += 2) d = Math.min(d, seg(q[j]!, q[j + 1]!, q[j + 2]!, q[j + 3]!))
    } else if (it.kind === 'arc') {
      if (arcSweep(it.a0, it.a1, it.r, it.cx, it.cy) != null) d = Math.abs(Math.hypot(x - it.cx, y - it.cy) - it.r)
    } else {
      const b = p.bb
      if (x >= b[k * 4]! && x <= b[k * 4 + 2]! && y >= b[k * 4 + 1]! && y <= b[k * 4 + 3]!) d = rr * 0.99
    }
    if (d < bd) {
      bd = d
      best = k
    }
  }
  return best
}

function esc(t: string) {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function b64(png: Uint8Array) {
  let s = ''
  for (let i = 0; i < png.length; i += 0x8000) s += String.fromCharCode(...png.subarray(i, i + 0x8000))
  return btoa(s)
}

const f = (n: number) => (Math.round(n * 1000) / 1000).toString()

/** 보이는 레이어만 담은 SVG(종이 색, 원래 굵기). 시트 mm 단위 */
export function toSvg(p: Prepared, hidden: Uint8Array): string {
  const { w: W, h: H } = p.sheet.size
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${f(W)}mm" height="${f(H)}mm" viewBox="0 0 ${f(W)} ${f(H)}">`,
    `<rect width="${f(W)}" height="${f(H)}" fill="#fff"/>`,
    `<g transform="translate(0 ${f(H)}) scale(1 -1)" fill="none" stroke-linecap="round" stroke-linejoin="round">`,
  ]
  const after: string[] = []
  p.sheet.items.forEach((it, k) => {
    const L = p.layer[k]!
    if (L >= 0 && hidden[L]) return
    const col = inkFor(it.kind === 'fill' ? it.color : (it as { color?: string }).color, false, '#fff', it.kind === 'fill')
    if (it.kind === 'line') {
      out.push(`<polyline points="${Array.from(it.pts, f).join(' ')}" stroke="${col}" stroke-width="${f(it.w ?? 0.18)}"${it.dash?.length ? ` stroke-dasharray="${it.dash.map((d) => f(Math.abs(d))).join(' ')}"` : ''}/>`)
    } else if (it.kind === 'arc') {
      const sweep = arcSweep(it.a0, it.a1, it.r, it.cx, it.cy)
      if (sweep == null) return
      if (sweep >= Math.PI * 2 - 1e-6) out.push(`<circle cx="${f(it.cx)}" cy="${f(it.cy)}" r="${f(it.r)}" stroke="${col}" stroke-width="${f(it.w ?? 0.18)}"/>`)
      else {
        const x0 = it.cx + it.r * Math.cos(it.a0), y0 = it.cy + it.r * Math.sin(it.a0)
        const x1 = it.cx + it.r * Math.cos(it.a0 + sweep), y1 = it.cy + it.r * Math.sin(it.a0 + sweep)
        out.push(`<path d="M${f(x0)} ${f(y0)}A${f(it.r)} ${f(it.r)} 0 ${sweep > Math.PI ? 1 : 0} 1 ${f(x1)} ${f(y1)}" stroke="${col}" stroke-width="${f(it.w ?? 0.18)}"/>`)
      }
    } else if (it.kind === 'fill') {
      out.push(`<polygon points="${Array.from(it.pts, f).join(' ')}" fill="${col}" fill-rule="evenodd" stroke="none"${it.opacity != null && it.opacity < 1 ? ` fill-opacity="${f(it.opacity)}"` : ''}/>`)
    } else if (it.kind === 'text') {
      const x = it.x, y = H - it.y
      const deg = it.rot ? (-it.rot * 180) / Math.PI : 0
      after.push(`<text x="${f(x)}" y="${f(y)}" font-size="${f(it.size)}" fill="${col}" font-family="${esc(it.font ? `'${it.font.replace(/'/g, '')}', ${FONT_FALLBACK}` : FONT_FALLBACK)}"${it.align === 'center' ? ' text-anchor="middle"' : it.align === 'right' ? ' text-anchor="end"' : ''}${deg ? ` transform="rotate(${f(deg)} ${f(x)} ${f(y)})"` : ''}>${esc(it.text)}</text>`)
    } else if (it.kind === 'image') {
      after.push(`<image x="${f(it.x)}" y="${f(H - it.y - it.h)}" width="${f(it.w)}" height="${f(it.h)}" preserveAspectRatio="none" href="data:${it.mime ?? 'image/png'};base64,${b64(it.png)}"/>`)
    }
  })
  out.push('</g>', ...after, '</svg>')
  return out.join('\n')
}
