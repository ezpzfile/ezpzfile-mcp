/**
 * 폰트 찾기 학습 모델(글자 읽기 없이 줄 이미지 → 글꼴 특징 벡터)의 앞뒤 계산.
 * 브라우저와 Node(시험) 양쪽에서 돈다. 다른 모듈을 가져오지 않는다. 모델 실행(onnxruntime)은 부르는 쪽이 한다.
 *
 * 학습(scripts/fontfind/train/common.py)과 똑같이 맞춘다:
 *   회색 줄 이미지 → 높이 64 로 늘이고 줄이기(가로세로 비 유지) → 0..1 → 평균 0·표준편차 1.
 * 학습은 너비 256 조각으로 했으므로, 긴 줄은 256 창을 겹쳐 밀며 뽑아 평균한다.
 */
import type { Box, Gray } from './core.ts'

export const H = 64
export const DIM = 256
const WIN = 256
const STRIDE = 192

/** 회색 이미지의 한 영역 → 높이 64 의 0..1 배열(쌍선형) */
function resizeTo64(g: Gray, b: Box): { w: number; a: Float32Array } {
  const bw = Math.max(1, b.x1 - b.x0)
  const bh = Math.max(1, b.y1 - b.y0)
  const w = Math.max(8, Math.round((bw * H) / bh))
  const a = new Float32Array(w * H)
  const sx = bw / w
  const sy = bh / H
  // 많이 줄일 때는 한 칸에 여러 원본 칸을 평균(상자 필터)해야 가는 획이 사라지지 않는다
  const kx = Math.max(1, Math.floor(sx))
  const ky = Math.max(1, Math.floor(sy))
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0
      let n = 0
      for (let dy = 0; dy < ky; dy++) {
        const fy = Math.min(g.h - 1, Math.max(0, b.y0 + (y + (dy + 0.5) / ky) * sy - 0.5))
        const y0 = Math.floor(fy)
        const y1 = Math.min(g.h - 1, y0 + 1)
        const ty = fy - y0
        for (let dx = 0; dx < kx; dx++) {
          const fx = Math.min(g.w - 1, Math.max(0, b.x0 + (x + (dx + 0.5) / kx) * sx - 0.5))
          const x0 = Math.floor(fx)
          const x1 = Math.min(g.w - 1, x0 + 1)
          const tx = fx - x0
          const p = g.data[y0 * g.w + x0] * (1 - tx) + g.data[y0 * g.w + x1] * tx
          const q = g.data[y1 * g.w + x0] * (1 - tx) + g.data[y1 * g.w + x1] * tx
          s += p * (1 - ty) + q * ty
          n++
        }
      }
      a[y * w + x] = s / n / 255
    }
  }
  return { w, a }
}

function normalize(a: Float32Array): Float32Array {
  let m = 0
  for (let i = 0; i < a.length; i++) m += a[i]
  m /= a.length
  let v = 0
  for (let i = 0; i < a.length; i++) v += (a[i] - m) ** 2
  const s = Math.max(Math.sqrt(v / a.length), 0.05)
  const out = new Float32Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = (a[i] - m) / s
  return out
}

function borderMedian(a: Float32Array, w: number): number {
  const v: number[] = []
  for (let x = 0; x < w; x++) v.push(a[x], a[(H - 1) * w + x])
  for (let y = 0; y < H; y++) v.push(a[y * w], a[y * w + w - 1])
  v.sort((p, q) => p - q)
  return v[v.length >> 1]
}

/**
 * 줄 상자들 → 모델 입력 조각들. 상자마다 위아래로 줄 높이의 15% 여백을 둔다(학습 그림과 비슷하게).
 * 반환: 각 조각 { data: Float32Array(64*w), w }
 */
/**
 * 줄 둘레 여백에 이웃 줄·배경 그림이 들어오면 모델이 흔들린다. 글자 칸 밖은 바탕색(여백의 가운데값)으로 칠한 사본을 만든다.
 */
function masked(g: Gray, b: Box, glyphs: Box[]): Gray & { bg: number } {
  const w = b.x1 - b.x0
  const h = b.y1 - b.y0
  const inside = new Uint8Array(w * h)
  const pad = Math.max(1, Math.round(h * 0.02))
  for (const c of glyphs) {
    for (let y = Math.max(b.y0, c.y0 - pad); y < Math.min(b.y1, c.y1 + pad); y++)
      for (let x = Math.max(b.x0, c.x0 - pad); x < Math.min(b.x1, c.x1 + pad); x++) inside[(y - b.y0) * w + (x - b.x0)] = 1
  }
  const bgs: number[] = []
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!inside[y * w + x]) bgs.push(g.data[(y + b.y0) * g.w + x + b.x0])
  // 글자 칸이 상자를 꽉 채우면 상자 바로 바깥 둘레에서 바탕을 잰다
  if (bgs.length < 16) {
    for (let x = Math.max(0, b.x0 - 2); x < Math.min(g.w, b.x1 + 2); x++) {
      if (b.y0 >= 2) bgs.push(g.data[(b.y0 - 2) * g.w + x])
      if (b.y1 + 1 < g.h) bgs.push(g.data[(b.y1 + 1) * g.w + x])
    }
  }
  bgs.sort((p, q) => p - q)
  const bg = bgs.length ? bgs[bgs.length >> 1] : 255
  const data = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = inside[y * w + x] ? g.data[(y + b.y0) * g.w + x + b.x0] : bg
  return { w, h, data, bg }
}

/** 여백 비율(줄 높이 대비). 학습 그림은 여백이 2~40% 로 제각각이었다. 몇 가지로 뽑아 평균하면 고른 영역에 덜 흔들린다. */
const MARGINS = [0.06, 0.18, 0.32]

/** 한 장(높이 64 의 0..1) → 모델 입력 조각들 */
function pieces(w: number, a: Float32Array, out: { data: Float32Array; w: number }[]) {
  if (w < 64) {
    // 너무 짧은 줄은 바탕색으로 늘린다
    const bg = borderMedian(a, w)
    const ww = 64
    const p = new Float32Array(ww * H).fill(bg)
    const x0 = (ww - w) >> 1
    for (let y = 0; y < H; y++) p.set(a.subarray(y * w, y * w + w), y * ww + x0)
    out.push({ data: normalize(p), w: ww })
    return
  }
  if (w <= WIN + 64) {
    out.push({ data: normalize(a), w })
    return
  }
  for (let x = 0; ; x += STRIDE) {
    const x0 = Math.min(x, w - WIN)
    const p = new Float32Array(WIN * H)
    for (let y = 0; y < H; y++) p.set(a.subarray(y * w + x0, y * w + x0 + WIN), y * WIN)
    out.push({ data: normalize(p), w: WIN })
    if (x0 >= w - WIN) break
  }
}

/**
 * 줄 상자들 → 모델 입력 조각들.
 * glyphs(줄마다 글자 칸)를 주면 글자 칸 밖은 바탕색으로 칠하고, 여백도 바탕색으로 만들어 붙인다:
 * 이웃 줄·배경 그림이 섞이지 않고, 사용자가 영역을 넓게 골랐든 좁게 골랐든 같은 입력이 된다.
 */
export function lineInputs(g: Gray, lines: Box[], glyphs?: Box[][]): { data: Float32Array; w: number }[] {
  const out: { data: Float32Array; w: number }[] = []
  for (let li = 0; li < lines.length; li++) {
    const lb = lines[li]
    const h = lb.y1 - lb.y0
    if (h < 4) continue
    if (!glyphs?.[li]?.length) {
      const m = Math.round(h * 0.15)
      const b = { x0: Math.max(0, lb.x0 - m), y0: Math.max(0, lb.y0 - m), x1: Math.min(g.w, lb.x1 + m), y1: Math.min(g.h, lb.y1 + m) }
      const { w, a } = resizeTo64(g, b)
      pieces(w, a, out)
      continue
    }
    const src = masked(g, lb, glyphs[li])
    for (const r of MARGINS) {
      const m = Math.max(1, Math.round(h * r))
      const W = src.w + 2 * m
      const Hh = src.h + 2 * m
      const data = new Uint8Array(W * Hh).fill(src.bg)
      for (let y = 0; y < src.h; y++) data.set(src.data.subarray(y * src.w, (y + 1) * src.w), (y + m) * W + m)
      const { w, a } = resizeTo64({ w: W, h: Hh, data }, { x0: 0, y0: 0, x1: W, y1: Hh })
      pieces(w, a, out)
    }
  }
  return out
}

/** 여러 조각의 특징 벡터 → 평균 내어 길이 1 로 */
export function meanEmbedding(embs: Float32Array[]): Float32Array | null {
  if (!embs.length) return null
  const e = new Float32Array(DIM)
  for (const v of embs) for (let i = 0; i < DIM; i++) e[i] += v[i]
  let n = 0
  for (let i = 0; i < DIM; i++) n += e[i] * e[i]
  n = Math.sqrt(n) || 1
  for (let i = 0; i < DIM; i++) e[i] /= n
  return e
}

/** float16 바이트 → Float32Array */
export function f16ToF32(buf: Uint16Array): Float32Array {
  const out = new Float32Array(buf.length)
  for (let i = 0; i < buf.length; i++) {
    const h = buf[i]
    const s = h & 0x8000 ? -1 : 1
    const e = (h >> 10) & 0x1f
    const f = h & 0x3ff
    out[i] = e === 0 ? s * 2 ** -14 * (f / 1024) : e === 31 ? (f ? NaN : s * Infinity) : s * 2 ** (e - 15) * (1 + f / 1024)
  }
  return out
}

export interface Protos {
  /** 행마다 256 */
  v: Float32Array
  /** 행 → 가족 번호(keys 의 자리) */
  fam: Int32Array
  /** 행 → 굵기 */
  weight: Int16Array
  keys: string[]
}

/** 가족마다 가장 닮은 대표 벡터의 코사인(-1..1)과 그 굵기 */
export function rankFamilies(e: Float32Array, p: Protos): { k: string; sim: number; weight: number }[] {
  const n = p.fam.length
  const best = new Float32Array(p.keys.length).fill(-2)
  const bw = new Int16Array(p.keys.length)
  for (let r = 0; r < n; r++) {
    let s = 0
    const o = r * DIM
    for (let i = 0; i < DIM; i++) s += p.v[o + i] * e[i]
    const f = p.fam[r]
    if (s > best[f]) {
      best[f] = s
      bw[f] = p.weight[r]
    }
  }
  const out: { k: string; sim: number; weight: number }[] = []
  for (let f = 0; f < p.keys.length; f++) if (best[f] > -2) out.push({ k: p.keys[f], sim: best[f], weight: bw[f] })
  out.sort((a, b) => b.sim - a.sim)
  return out
}

/**
 * 유료 폰트는 글꼴 파일이 없어 글자 맞대기 점수가 없다. 같은 이미지에서 무료 가족들의 (모델 닮음 → 글자 맞대기 점수) 관계를
 * 직선으로 맞춰, 유료 폰트의 글자 맞대기 점수를 짐작해 무료와 같은 저울(0.6 × 모델 + 0.4 × 글자)에 올린다.
 */
export function fitLine(pairs: [number, number][]): { a: number; b: number } {
  const n = pairs.length
  if (n < 3) return { a: 0, b: n ? pairs.reduce((s, p) => s + p[1], 0) / n : 0 }
  let sx = 0, sy = 0, sxx = 0, sxy = 0
  for (const [x, y] of pairs) {
    sx += x
    sy += y
    sxx += x * x
    sxy += x * y
  }
  const d = n * sxx - sx * sx
  const a = d > 1e-9 ? (n * sxy - sx * sy) / d : 0
  return { a, b: (sy - a * sx) / n }
}

/** 유료 폰트 점수(무료 합친 점수와 같은 저울). delta: 시험으로 맞춘 보정, alpha: 모델 몫 */
export function paidScore(ml: number, line: { a: number; b: number }, delta: number, alpha = 0.6): number {
  return alpha * ml + (1 - alpha) * (line.a * ml + line.b) + delta
}

/** 글자 묶음별 모델 몫(나머지는 글자 맞대기). 시험 이미지로 맞춘다 */
export const ML_ALPHA: Record<string, number> = { ko: 0.5, ja: 0.6, la: 0.3, sc: 0.6, tc: 0.6 }
