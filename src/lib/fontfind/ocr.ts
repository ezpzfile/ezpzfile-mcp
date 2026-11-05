/**
 * 폰트 찾기: 사진 속 글자 줄 찾기와 읽기(PaddleOCR 모델, Apache-2.0). 브라우저와 Node(시험) 양쪽에서 돈다.
 *
 * 1. 줄 찾기(det): 사진 전체를 한 번 보고 글자가 있는 곳의 확률 지도를 낸다. 덩어리마다 기울어진 네모를 씌운다.
 *    밝은 글자·어두운 글자, 배경색이 섞인 사진에서도 줄 단위로 잡는다(한 가지 문턱으로 흑백을 나누던 예전 방식과 다르다).
 * 2. 줄 바로 펴기: 기울어진 네모를 반듯하게 잘라 낸다(기울어진 글자도 바로 선다).
 * 3. 읽기(rec): 바로 편 줄을 읽는다. 한·중·일·영 공용 모델 하나, 한글은 한국어 모델.
 *
 * 모델 실행(onnxruntime)은 부르는 쪽이 넘긴다(run). 이미지는 브라우저 밖으로 나가지 않는다.
 */
import { normalizeInk, toInk } from './core.ts'
import type { Box, Glyph, Gray, Ink } from './core.ts'

/** RGBA(캔버스 ImageData 와 같은 배치) */
export interface Rgba {
  w: number
  h: number
  data: Uint8ClampedArray | Uint8Array
}

export interface Pt {
  x: number
  y: number
}

/** 기울어진 네모: 가운데, 글자 방향 길이(len), 글자 높이(th), 글자 방향 각도(라디안) */
export interface RRect {
  cx: number
  cy: number
  len: number
  th: number
  ang: number
  /** 세로쓰기(글자가 위에서 아래로) */
  vertical: boolean
}

export interface OcrChar {
  c: string
  /** 줄 안의 가로 위치(0~1) */
  x: number
  p: number
}

export interface OcrLine {
  rect: RRect
  /** 네 귀퉁이(왼위·오위·오아래·왼아래) */
  quad: Pt[]
  /** 귀퉁이를 다 담는 반듯한 상자(화면 표시·영역 비교용) */
  box: Box
  /** 글자 높이(원본 칸) */
  h: number
  det: number
  text: string
  conf: number
  chars: OcrChar[]
}

/** 모델 하나 돌리기: 입력 [1,3,H,W] → 출력(첫 번째) 데이터와 모양 */
export type Run = (input: Float32Array, dims: number[]) => Promise<{ data: Float32Array; dims: readonly number[] }>

/* ───────── 줄 찾기 ───────── */

/** 확률 지도 크기: 긴 변을 이만큼(32 배수). 작은 사진은 키운다(작은 글자도 잡히게) */
const DET_SIDE = 960

export async function detect(img: Rgba, run: Run, side = DET_SIDE): Promise<{ rect: RRect; score: number }[]> {
  const s = side / Math.max(img.w, img.h)
  const W = Math.max(32, Math.round((img.w * s) / 32) * 32)
  const H = Math.max(32, Math.round((img.h * s) / 32) * 32)
  // 모델 입력: BGR, (x/255 - 평균) / 표준편차
  const x = new Float32Array(3 * W * H)
  const mean = [0.485, 0.456, 0.406]
  const std = [0.229, 0.224, 0.225]
  const sx = img.w / W
  const sy = img.h / H
  for (let y = 0; y < H; y++) {
    const fy = Math.min(img.h - 1, (y + 0.5) * sy - 0.5)
    for (let xx = 0; xx < W; xx++) {
      const fx = Math.min(img.w - 1, (xx + 0.5) * sx - 0.5)
      const px = bilinear(img, fx, fy)
      // px 는 RGB → B, G, R 차례로
      for (let c = 0; c < 3; c++) x[c * W * H + y * W + xx] = (px[2 - c] / 255 - mean[c]) / std[c]
    }
  }
  const o = await run(x, [1, 3, H, W])
  const p = o.data
  // 0.3 넘는 칸을 이어 덩어리로
  const on = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) on[i] = p[i] > 0.3 ? 1 : 0
  const seen = new Uint8Array(W * H)
  const out: { rect: RRect; score: number }[] = []
  const stack: number[] = []
  const xs: number[] = []
  const ys: number[] = []
  for (let i = 0; i < W * H; i++) {
    if (!on[i] || seen[i]) continue
    xs.length = 0
    ys.length = 0
    let sum = 0
    seen[i] = 1
    stack.push(i)
    while (stack.length) {
      const q = stack.pop()!
      const qx = q % W
      const qy = (q - qx) / W
      xs.push(qx)
      ys.push(qy)
      sum += p[q]
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = qx + dx
          const ny = qy + dy
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
          const r = ny * W + nx
          if (on[r] && !seen[r]) {
            seen[r] = 1
            stack.push(r)
          }
        }
    }
    if (xs.length < 10) continue
    const score = sum / xs.length
    if (score < 0.6) continue
    const r = orientedRect(xs, ys)
    if (Math.min(r.len, r.th) < 2) continue
    // 확률 지도는 글자보다 안쪽으로 줄어 있다: 둘레를 넓힌다(PaddleOCR 과 같은 1.5 배)
    const d = (r.len * r.th * 1.5) / (2 * (r.len + r.th))
    r.len += 2 * d
    r.th += 2 * d
    // 원본 칸으로
    out.push({ rect: scaleRect(r, sx, sy), score })
  }
  return mergeRows(out)
}

/**
 * 한 줄인데 글자 사이가 넓어 따로 잡힌 네모(크게 쓴 大 와 阪 등)를 잇는다.
 * 둘 다 반듯한 가로줄이고, 높이가 비슷하고(12% 안), 위아래로 70% 넘게 겹치고, 사이가 높이의 0.6 배 안일 때.
 */
function mergeRows(rs: { rect: RRect; score: number }[]): { rect: RRect; score: number }[] {
  const flat = (r: RRect) => !r.vertical && Math.abs(r.ang) < (3 * Math.PI) / 180
  const box = (r: RRect) => ({ x0: r.cx - r.len / 2, x1: r.cx + r.len / 2, y0: r.cy - r.th / 2, y1: r.cy + r.th / 2 })
  const out = rs.slice()
  for (let changed = true; changed; ) {
    changed = false
    outer: for (let i = 0; i < out.length; i++) {
      const a = out[i].rect
      if (!flat(a)) continue
      for (let j = i + 1; j < out.length; j++) {
        const b = out[j].rect
        if (!flat(b) || Math.abs(a.th - b.th) > 0.12 * Math.max(a.th, b.th)) continue
        const A = box(a)
        const B = box(b)
        const ov = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0)
        const gap = Math.max(A.x0, B.x0) - Math.min(A.x1, B.x1)
        const th = Math.max(a.th, b.th)
        if (ov < 0.7 * Math.min(a.th, b.th) || gap > 0.6 * th) continue
        const x0 = Math.min(A.x0, B.x0)
        const x1 = Math.max(A.x1, B.x1)
        const y0 = Math.min(A.y0, B.y0)
        const y1 = Math.max(A.y1, B.y1)
        const ra = a.len * a.th
        const rb = b.len * b.th
        out[i] = { rect: { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, len: x1 - x0, th: y1 - y0, ang: 0, vertical: false }, score: (out[i].score * ra + out[j].score * rb) / (ra + rb) }
        out.splice(j, 1)
        changed = true
        break outer
      }
    }
  }
  return out
}

function bilinear(img: Rgba, x: number, y: number): [number, number, number] {
  const x0 = Math.max(0, Math.floor(x))
  const y0 = Math.max(0, Math.floor(y))
  const x1 = Math.min(img.w - 1, x0 + 1)
  const y1 = Math.min(img.h - 1, y0 + 1)
  const fx = Math.min(1, Math.max(0, x - x0))
  const fy = Math.min(1, Math.max(0, y - y0))
  const d = img.data
  const a = (y0 * img.w + x0) * 4
  const b = (y0 * img.w + x1) * 4
  const c = (y1 * img.w + x0) * 4
  const e = (y1 * img.w + x1) * 4
  const v = (k: number) => (d[a + k] * (1 - fx) + d[b + k] * fx) * (1 - fy) + (d[c + k] * (1 - fx) + d[e + k] * fx) * fy
  return [v(0), v(1), v(2)]
}

/** 점들을 감싸는 가장 작은 기울어진 네모(볼록 껍질의 변마다 돌려 보기) */
function orientedRect(xs: number[], ys: number[]): RRect {
  // 칸 가운데가 아니라 칸 전체를 감싸도록 귀퉁이 넷을 넣는다
  const pts: Pt[] = []
  for (let i = 0; i < xs.length; i++) {
    pts.push({ x: xs[i], y: ys[i] }, { x: xs[i] + 1, y: ys[i] }, { x: xs[i], y: ys[i] + 1 }, { x: xs[i] + 1, y: ys[i] + 1 })
  }
  const hull = convexHull(pts)
  let best: { area: number; ang: number; w: number; h: number; cx: number; cy: number } | null = null
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]
    const b = hull[(i + 1) % hull.length]
    const ang = Math.atan2(b.y - a.y, b.x - a.x)
    const c = Math.cos(ang)
    const s = Math.sin(ang)
    let u0 = Infinity
    let u1 = -Infinity
    let v0 = Infinity
    let v1 = -Infinity
    for (const p of hull) {
      const u = p.x * c + p.y * s
      const v = -p.x * s + p.y * c
      if (u < u0) u0 = u
      if (u > u1) u1 = u
      if (v < v0) v0 = v
      if (v > v1) v1 = v
    }
    const area = (u1 - u0) * (v1 - v0)
    if (!best || area < best.area - 1e-6) {
      const um = (u0 + u1) / 2
      const vm = (v0 + v1) / 2
      best = { area, ang, w: u1 - u0, h: v1 - v0, cx: um * c - vm * s, cy: um * s + vm * c }
    }
  }
  const r = best!
  // 긴 변이 글자 방향. 각도는 -90°~90°(글자가 거꾸로 서지 않게)
  let len = r.w
  let th = r.h
  let ang = r.ang
  if (th > len) {
    ;[len, th] = [th, len]
    ang += Math.PI / 2
  }
  while (ang > Math.PI / 2) ang -= Math.PI
  while (ang <= -Math.PI / 2) ang += Math.PI
  // 거의 수직인 긴 줄은 세로쓰기로 본다(일본어 세로 간판 등)
  const vertical = Math.abs(Math.abs(ang) - Math.PI / 2) < (25 * Math.PI) / 180 && len > th * 1.5
  if (!vertical && Math.abs(ang) > Math.PI / 4) {
    // 거의 정사각형(글자 한두 개)인데 긴 변이 세로로 잡혔다: 글자를 눕히지 않게 가로 기준으로
    ;[len, th] = [th, len]
    ang -= Math.sign(ang) * (Math.PI / 2)
  }
  return { cx: r.cx, cy: r.cy, len, th, ang, vertical }
}

function convexHull(pts: Pt[]): Pt[] {
  const p = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lo: Pt[] = []
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop()
    lo.push(q)
  }
  const up: Pt[] = []
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i]
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop()
    up.push(q)
  }
  up.pop()
  lo.pop()
  return lo.concat(up)
}

function scaleRect(r: RRect, sx: number, sy: number): RRect {
  // 가로·세로 배율이 거의 같다(32 배수로 맞추며 조금 다를 뿐): 길이는 방향에 맞춰 섞는다
  const c = Math.abs(Math.cos(r.ang))
  const s = Math.abs(Math.sin(r.ang))
  return { ...r, cx: r.cx * sx, cy: r.cy * sy, len: r.len * (c * sx + s * sy), th: r.th * (s * sx + c * sy) }
}

export function rectQuad(r: RRect): Pt[] {
  const c = Math.cos(r.ang)
  const s = Math.sin(r.ang)
  const u = { x: (c * r.len) / 2, y: (s * r.len) / 2 }
  const v = { x: (-s * r.th) / 2, y: (c * r.th) / 2 }
  return [
    { x: r.cx - u.x - v.x, y: r.cy - u.y - v.y },
    { x: r.cx + u.x - v.x, y: r.cy + u.y - v.y },
    { x: r.cx + u.x + v.x, y: r.cy + u.y + v.y },
    { x: r.cx - u.x + v.x, y: r.cy - u.y + v.y },
  ]
}

export function quadBox(q: Pt[], w: number, h: number): Box {
  return {
    x0: Math.max(0, Math.floor(Math.min(...q.map((p) => p.x)))),
    y0: Math.max(0, Math.floor(Math.min(...q.map((p) => p.y)))),
    x1: Math.min(w, Math.ceil(Math.max(...q.map((p) => p.x)))),
    y1: Math.min(h, Math.ceil(Math.max(...q.map((p) => p.y)))),
  }
}

/* ───────── 줄 바로 펴기 ───────── */

/**
 * 기울어진 네모를 반듯하게(글자 방향이 가로가 되게) 잘라 낸다. outH: 결과 높이(글자 높이를 이만큼으로 키우거나 줄인다).
 * 세로쓰기는 돌리지 않고 세운 채로 자른다(글자를 눕히면 읽기도 맞대기도 안 된다). 가로 줄로 바꾸는 건 verticalToRow.
 */
export function cropRect(img: Rgba, r: RRect, outH?: number): Rgba {
  // 반듯한 줄을 같은 크기로: 칸을 그대로 옮긴다(되뽑기로 획이 흐려지지 않게. 학습 모델이 선명도에 민감하다)
  if (!r.vertical && Math.abs(r.ang) < Math.PI / 180 && (!outH || Math.abs(outH - r.th) < 1.5)) {
    const W = Math.max(1, Math.round(r.len))
    const H = Math.max(1, Math.round(r.th))
    const x0 = Math.round(r.cx - W / 2)
    const y0 = Math.round(r.cy - H / 2)
    const out = new Uint8ClampedArray(W * H * 4)
    for (let v = 0; v < H; v++) {
      const y = Math.min(img.h - 1, Math.max(0, y0 + v))
      for (let u = 0; u < W; u++) {
        const x = Math.min(img.w - 1, Math.max(0, x0 + u))
        const si = (y * img.w + x) * 4
        const di = (v * W + u) * 4
        out[di] = img.data[si]
        out[di + 1] = img.data[si + 1]
        out[di + 2] = img.data[si + 2]
        out[di + 3] = 255
      }
    }
    return { w: W, h: H, data: out }
  }
  // 세로쓰기: 글자 방향은 위→아래. 가로 len 은 줄 폭(th), 세로는 len
  const ang = r.vertical ? r.ang - Math.sign(r.ang || 1) * (Math.PI / 2) : r.ang
  const wid = r.vertical ? r.th : r.len
  const hgt = r.vertical ? r.len : r.th
  const s = outH ? outH / (r.vertical ? r.th : hgt) : 1
  const W = Math.max(1, Math.round(wid * s))
  const H = Math.max(1, Math.round(hgt * s))
  const c = Math.cos(ang)
  const sn = Math.sin(ang)
  const out = new Uint8ClampedArray(W * H * 4)
  for (let v = 0; v < H; v++) {
    const dv = (v + 0.5) / s - hgt / 2
    for (let u = 0; u < W; u++) {
      const du = (u + 0.5) / s - wid / 2
      const x = r.cx + du * c - dv * sn - 0.5
      const y = r.cy + du * sn + dv * c - 0.5
      const px = bilinear(img, Math.min(img.w - 1, Math.max(0, x)), Math.min(img.h - 1, Math.max(0, y)))
      const k = (v * W + u) * 4
      out[k] = px[0]
      out[k + 1] = px[1]
      out[k + 2] = px[2]
      out[k + 3] = 255
    }
  }
  return { w: W, h: H, data: out }
}

export function rgbaGray(img: Rgba): Gray {
  const g = new Uint8Array(img.w * img.h)
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (img.data[j] * 299 + img.data[j + 1] * 587 + img.data[j + 2] * 114) / 1000
  return { w: img.w, h: img.h, data: g }
}

/**
 * 글자를 검은색, 바탕을 흰색으로 맞춘다(흰 글자·색 바탕도). 대비도 끝까지 늘린다.
 * 잘라 낸 줄의 가장자리는 대부분 바탕이라는 것으로 글자 쪽을 고른다(core.toInk).
 */
export function normalizeStrip(g: Gray): Gray {
  // 글자 쪽 고르기: 잉크로 잡힌 칸이 바탕보다 밝으면 흰 글자 → 뒤집는다
  const ink = toInk(g)
  let si = 0
  let ni = 0
  let sb = 0
  let nb = 0
  for (let i = 0; i < g.data.length; i++) {
    if (ink.v[i] >= 0.5) {
      si += g.data[i]
      ni++
    } else {
      sb += g.data[i]
      nb++
    }
  }
  const flip = ni > 0 && nb > 0 && si / ni > sb / nb
  // 대비 늘리기: 1%·99% 밝기를 0·255 로(글자 가장자리의 부드러운 칸은 그대로 둔다. 학습 모델이 그렇게 배웠다)
  const hist = new Uint32Array(256)
  for (const v of g.data) hist[flip ? 255 - v : v]++
  const n = g.data.length
  let lo = 0
  let hi = 255
  for (let a = 0, k = 0; k < 256; k++) {
    a += hist[k]
    if (a >= n * 0.01) {
      lo = k
      break
    }
  }
  for (let a = 0, k = 255; k >= 0; k--) {
    a += hist[k]
    if (a >= n * 0.01) {
      hi = k
      break
    }
  }
  const span = Math.max(1, hi - lo)
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const v = flip ? 255 - g.data[i] : g.data[i]
    out[i] = Math.max(0, Math.min(255, Math.round(((v - lo) * 255) / span)))
  }
  return { w: g.w, h: g.h, data: out }
}

/**
 * 세로쓰기 줄(세운 채로 자른 것) → 글자를 왼쪽부터 가로로 늘어놓은 줄.
 * 잉크 없는 가로줄에서 글자를 끊는다. 너무 작게 끊긴 조각(가로획 사이 틈)은 앞 글자에 붙인다.
 */
export function verticalToRow(img: Rgba): Rgba {
  const g = normalizeStrip(rgbaGray(img))
  const W = img.w
  const rows: boolean[] = []
  for (let y = 0; y < img.h; y++) {
    let n = 0
    for (let x = 0; x < W; x++) if (g.data[y * W + x] < 128) n++
    rows.push(n > 0)
  }
  const segs: [number, number][] = []
  let st = -1
  for (let y = 0; y <= img.h; y++) {
    const on = y < img.h && rows[y]
    if (on && st < 0) st = y
    if (!on && st >= 0) {
      segs.push([st, y])
      st = -1
    }
  }
  // 글자 높이 ≈ 줄 폭. 조각을 글자 하나 크기까지 묶는다
  const em = W * 0.8
  const chars: [number, number][] = []
  for (const s of segs) {
    const last = chars[chars.length - 1]
    if (last && s[1] - last[0] <= em * 1.1 && s[0] - last[1] < em * 0.3) last[1] = s[1]
    else chars.push([s[0], s[1]])
  }
  if (!chars.length) return img
  const gap = Math.round(W * 0.15)
  const outW = chars.length * (W + gap) + gap
  const out = new Uint8ClampedArray(outW * W * 4)
  // 바탕색: 가장자리 첫 칸
  for (let i = 0; i < outW * W; i++) {
    out[i * 4] = img.data[0]
    out[i * 4 + 1] = img.data[1]
    out[i * 4 + 2] = img.data[2]
    out[i * 4 + 3] = 255
  }
  let ox = gap
  for (const [a, b] of chars) {
    const ch = b - a
    const oy = Math.max(0, Math.round((W - ch) / 2))
    for (let y = 0; y < Math.min(ch, W); y++)
      for (let x = 0; x < W; x++) {
        const si = ((a + y) * W + x) * 4
        const di = ((oy + y) * outW + ox + x) * 4
        out[di] = img.data[si]
        out[di + 1] = img.data[si + 1]
        out[di + 2] = img.data[si + 2]
      }
    ox += W + gap
  }
  return { w: outW, h: W, data: out }
}

/* ───────── 읽기 ───────── */

const REC_H = 48
const REC_MAX_W = 1600

/** 바로 편 줄 하나 읽기. dict[0] 은 빈칸(CTC blank), 끝은 띄어쓰기 */
export async function recognize(strip: Rgba, run: Run, dict: string[]): Promise<{ text: string; conf: number; chars: OcrChar[] }> {
  const W = Math.min(REC_MAX_W, Math.max(16, Math.ceil((REC_H * strip.w) / strip.h)))
  const x = new Float32Array(3 * REC_H * W)
  const sx = strip.w / W
  const sy = strip.h / REC_H
  for (let y = 0; y < REC_H; y++)
    for (let u = 0; u < W; u++) {
      const px = bilinear(strip, Math.min(strip.w - 1, (u + 0.5) * sx - 0.5), Math.min(strip.h - 1, (y + 0.5) * sy - 0.5))
      for (let c = 0; c < 3; c++) x[c * REC_H * W + y * W + u] = (px[2 - c] / 255 - 0.5) / 0.5
    }
  const o = await run(x, [1, 3, REC_H, W])
  const T = o.dims[1]
  const C = o.dims[2]
  const chars: OcrChar[] = []
  let last = -1
  for (let t = 0; t < T; t++) {
    let bi = 0
    let bp = -1
    for (let k = 0; k < C; k++) {
      const v = o.data[t * C + k]
      if (v > bp) {
        bp = v
        bi = k
      }
    }
    if (bi !== last && bi !== 0) chars.push({ c: dict[bi] ?? '', x: (t + 0.5) / T, p: bp })
    last = bi
  }
  const real = chars.filter((c) => c.c.trim())
  return {
    text: chars.map((c) => c.c).join('').trim(),
    conf: real.length ? real.reduce((a, c) => a + c.p, 0) / real.length : 0,
    chars: real,
  }
}

/** 받은 사전 글 → dict(앞에 CTC 빈칸, 끝에 띄어쓰기) */
export function parseDict(txt: string): string[] {
  const lines = txt.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return ['', ...lines.map((l) => l.replace(/\r$/, '')), ' ']
}

/* ───────── 글자 종류 ───────── */

export type LineScript = 'ja' | 'han' | 'ko' | 'la' | 'gr' | 'other'

export function countKinds(text: string) {
  let kana = 0
  let han = 0
  let hangul = 0
  let latin = 0
  let greek = 0
  let digit = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if ((c >= 0x3041 && c <= 0x30ff && c !== 0x30fb && c !== 0x30fc) || (c >= 0xff66 && c <= 0xff9d)) kana++
    else if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || c === 0x3005) han++
    else if ((c >= 0xac00 && c <= 0xd7a3) || (c >= 0x3131 && c <= 0x318e)) hangul++
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c <= 0x24f) || (c >= 0x1e00 && c <= 0x1eff)) latin++
    else if (c >= 0x370 && c <= 0x3ff) greek++
    else if (c >= 0x30 && c <= 0x39) digit++
  }
  return { kana, han, hangul, latin, greek, digit }
}

/** 공용 모델로 읽은 줄의 글자 종류. 가나가 한 자라도 있으면 일본어 */
export function lineKind(text: string, conf: number): LineScript {
  if (conf < 0.6) return 'other'
  const k = countKinds(text)
  if (k.kana > 0) return 'ja'
  const letters = k.han + k.latin + k.greek
  if (!letters) return 'other'
  if (k.han >= Math.max(1, k.latin)) return 'han'
  if (k.greek > k.latin) return 'gr'
  return 'la'
}

/* ───────── 읽은 글자 수로 글자 칸 나누기 ───────── */

/**
 * 한·중·일 줄을 읽기 모델이 읽은 글자 수만큼 칸으로 나눈다(두 색 글자·획이 떨어진 큰 간판 글자를 여러 조각으로 자르지 않게).
 * xs: 읽은 글자들의 가로 위치(줄 칸 기준, 왼쪽부터). 칸 경계는 이웃 글자 위치의 가운데에서, 잉크가 가장 적은 세로줄로 옮긴다.
 */
export function splitByChars(ink: Ink, line: Box, xs: number[]): Glyph[] {
  const n = xs.length
  if (!n) return []
  const lh = line.y1 - line.y0
  const col = (x: number) => {
    let s = 0
    for (let y = line.y0; y < line.y1; y++) s += ink.v[y * ink.w + x]
    return s
  }
  const cuts: number[] = []
  for (let k = 0; k + 1 < n; k++) {
    const mid = Math.round((xs[k] + xs[k + 1]) / 2)
    const r = Math.max(2, Math.round(Math.min(lh * 0.25, (xs[k + 1] - xs[k]) * 0.35)))
    let best = mid
    let bv = Infinity
    for (let x = Math.max(line.x0 + 1, mid - r); x <= Math.min(line.x1 - 1, mid + r); x++) {
      // 같은 잉크면 가운데에 가까운 쪽
      const v = col(x) + Math.abs(x - mid) * 0.01
      if (v < bv) {
        bv = v
        best = x
      }
    }
    cuts.push(best)
  }
  const edges = [line.x0, ...cuts, line.x1]
  const out: Glyph[] = []
  for (let k = 0; k < n; k++) {
    if (edges[k + 1] - edges[k] < 2) continue
    const g = normalizeInk(ink, { x0: edges[k], x1: edges[k + 1], y0: line.y0, y1: line.y1 })
    if (g && g.pop >= 6) out.push(g)
  }
  return out
}
