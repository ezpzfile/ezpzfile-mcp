/**
 * 폰트 찾기 핵심 계산. 브라우저와 Node(시험) 양쪽에서 돈다. 다른 모듈을 가져오지 않는다.
 *
 * 흐름: 회색 이미지 → 잉크 지도(글자=1) → 줄 → 글자 칸 → 32x32 지문 → 글꼴 지문과 맞대기.
 * 글꼴 지문은 scripts/fontfind/build_index.py 가 같은 방법(잉크 상자 → 면적 평균 → 절반에서 자르기)으로 굽는다.
 */

export const N = 32
export type Bits = Uint32Array // 32 줄, 줄의 x 번째 칸 = 1 << x

export interface Gray {
  w: number
  h: number
  /** 0..255, 길이 w*h */
  data: Uint8Array | Uint8ClampedArray
}

/** 0..1 잉크 세기 지도 */
export interface Ink {
  w: number
  h: number
  v: Float32Array
}

export interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface Glyph {
  box: Box
  bits: Bits
  /** 잉크 칸 수 */
  pop: number
}

export interface Line {
  box: Box
  glyphs: Glyph[]
}

export type ScriptHint = 'la' | 'ko' | 'ja' | 'sc' | 'tc' | 'ar' | 'cy' | 'gr' | 'vi' | 'th' | 'hi'

/* ───────── 비트 ───────── */

export function popcnt(x: number): number {
  x -= (x >>> 1) & 0x55555555
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  x = (x + (x >>> 4)) & 0x0f0f0f0f
  return Math.imul(x, 0x01010101) >>> 24
}

export function popBits(b: Bits): number {
  let n = 0
  for (let i = 0; i < N; i++) n += popcnt(b[i])
  return n
}

/** 한 칸 두께로 부풀리기(8 방향) */
export function dilate(b: Bits, out: Bits = new Uint32Array(N)): Bits {
  for (let y = 0; y < N; y++) {
    let r = b[y]
    if (y > 0) r |= b[y - 1]
    if (y < N - 1) r |= b[y + 1]
    out[y] = (r | (r << 1) | (r >>> 1)) >>> 0
  }
  return out
}

/**
 * 두 지문의 닮은 정도 0..1.
 * 정확히 겹치는 비율(IoU)과 한 칸 어긋남을 봐주는 겹침을 섞는다.
 * 앞의 것은 획 굵기·끝 모양을, 뒤의 것은 전체 뼈대를 본다.
 */
export function similarity(a: Bits, aPop: number, aDil: Bits, t: Bits, tPop: number, tDil: Bits): number {
  if (!aPop || !tPop) return 0
  let inter = 0
  let aInT = 0
  let tInA = 0
  for (let y = 0; y < N; y++) {
    inter += popcnt(a[y] & t[y])
    aInT += popcnt(a[y] & tDil[y])
    tInA += popcnt(t[y] & aDil[y])
  }
  const iou = inter / (aPop + tPop - inter)
  const tol = (aInT / aPop + tInA / tPop) / 2
  return 0.5 * iou + 0.5 * tol
}

/* ───────── 이미지 → 잉크 ───────── */

function otsu(hist: Float64Array, total: number): number {
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  let sumB = 0
  let wB = 0
  let best = 0
  let th = 128
  for (let i = 0; i < 256; i++) {
    wB += hist[i]
    if (!wB) continue
    const wF = total - wB
    if (!wF) break
    sumB += i * hist[i]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best) {
      best = between
      th = i
    }
  }
  return th
}

/**
 * 회색 → 잉크 지도. 글자가 어두운지 밝은지(흰 글자)는 가장자리를 보고 정한다:
 * 가장자리는 대부분 바탕이다.
 */
export function toInk(g: Gray, invert?: boolean): Ink {
  const { w, h, data } = g
  const hist = new Float64Array(256)
  for (let i = 0; i < w * h; i++) hist[data[i]]++
  const th = otsu(hist, w * h)
  let darkEdge = 0
  let edge = 0
  const edgeAt = (i: number) => {
    edge++
    if (data[i] <= th) darkEdge++
  }
  for (let x = 0; x < w; x++) {
    edgeAt(x)
    edgeAt((h - 1) * w + x)
  }
  for (let y = 1; y < h - 1; y++) {
    edgeAt(y * w)
    edgeAt(y * w + w - 1)
  }
  // 가장자리가 대부분 어두우면 바탕이 어두운 것 → 밝은 글자
  const lightText = invert ?? darkEdge / edge > 0.5
  let sInk = 0
  let nInk = 0
  let sBg = 0
  let nBg = 0
  for (let i = 0; i < w * h; i++) {
    const isDark = data[i] <= th
    if (isDark !== lightText) {
      sInk += data[i]
      nInk++
    } else {
      sBg += data[i]
      nBg++
    }
  }
  const inkL = nInk ? sInk / nInk : lightText ? 255 : 0
  const bgL = nBg ? sBg / nBg : lightText ? 0 : 255
  const span = bgL - inkL || 1
  const v = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const t = (bgL - data[i]) / span
    v[i] = t < 0 ? 0 : t > 1 ? 1 : t
  }
  return { w, h, v }
}

/* ───────── 줄과 글자 나누기 ───────── */

interface Comp {
  x0: number
  y0: number
  x1: number
  y1: number
  n: number
}

/** 연결된 잉크 덩어리(8 방향). 너무 작은 점(잡티)은 버린다. */
function components(ink: Ink, box: Box, minPx: number): Comp[] {
  const { w, v } = ink
  const bw = box.x1 - box.x0
  const bh = box.y1 - box.y0
  const seen = new Uint8Array(bw * bh)
  const out: Comp[] = []
  const stack: number[] = []
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const k = y * bw + x
      if (seen[k] || v[(y + box.y0) * w + x + box.x0] < 0.5) continue
      const c: Comp = { x0: x, y0: y, x1: x + 1, y1: y + 1, n: 0 }
      seen[k] = 1
      stack.push(k)
      while (stack.length) {
        const p = stack.pop()!
        const px = p % bw
        const py = (p - px) / bw
        c.n++
        if (px < c.x0) c.x0 = px
        if (px + 1 > c.x1) c.x1 = px + 1
        if (py < c.y0) c.y0 = py
        if (py + 1 > c.y1) c.y1 = py + 1
        for (let dy = -1; dy <= 1; dy++) {
          const ny = py + dy
          if (ny < 0 || ny >= bh) continue
          for (let dx = -1; dx <= 1; dx++) {
            const nx = px + dx
            if (nx < 0 || nx >= bw) continue
            const q = ny * bw + nx
            if (seen[q] || v[(ny + box.y0) * w + nx + box.x0] < 0.5) continue
            seen[q] = 1
            stack.push(q)
          }
        }
      }
      if (c.n >= minPx) out.push({ x0: c.x0 + box.x0, x1: c.x1 + box.x0, y0: c.y0 + box.y0, y1: c.y1 + box.y0, n: c.n })
    }
  }
  return out
}

/** 가로 줄 나누기: 잉크 없는 행이 이어지는 곳에서 자른다. */
export function findLines(ink: Ink, box?: Box): Box[] {
  const b = box ?? { x0: 0, y0: 0, x1: ink.w, y1: ink.h }
  const rows: number[] = []
  for (let y = b.y0; y < b.y1; y++) {
    let s = 0
    for (let x = b.x0; x < b.x1; x++) if (ink.v[y * ink.w + x] >= 0.5) s++
    rows.push(s)
  }
  const out: Box[] = []
  let start = -1
  for (let i = 0; i <= rows.length; i++) {
    const on = i < rows.length && rows[i] > 0
    if (on && start < 0) start = i
    if (!on && start >= 0) {
      out.push({ x0: b.x0, x1: b.x1, y0: b.y0 + start, y1: b.y0 + i })
      start = -1
    }
  }
  // 아주 얇은 띠(밑줄·잡티)는 이웃 줄에 붙이거나 버린다
  const tall = out.length ? Math.max(...out.map((l) => l.y1 - l.y0)) : 0
  const merged: Box[] = []
  for (const l of out) {
    // 고른 영역의 위·아래 끝에 걸친 얇은 띠는 이웃 줄 글자의 끝자락이다(여백을 두고 고르면 생긴다). 버린다.
    if (l.y1 - l.y0 < 0.35 * tall && (l.y0 <= b.y0 || l.y1 >= b.y1)) continue
    const hgt = l.y1 - l.y0
    const prev = merged[merged.length - 1]
    if (prev && l.y0 - prev.y1 < Math.max(2, 0.12 * (prev.y1 - prev.y0)) && (hgt < 0.35 * tall || prev.y1 - prev.y0 < 0.35 * tall)) {
      prev.y1 = l.y1
      continue
    }
    merged.push({ ...l })
  }
  return merged.filter((l) => l.y1 - l.y0 >= Math.max(6, 0.25 * tall))
}

/**
 * 한 줄 → 글자 칸.
 * 한·중·일: 덩어리를 왼쪽부터 묶되, 묶음 폭이 글자 높이를 넘지 않게(이, 明 같은 글자는 여러 덩어리다).
 * 라틴: 위아래로 겹치는 덩어리(i 의 점)만 묶는다.
 */
export function splitGlyphBoxes(ink: Ink, line: Box, script: ScriptHint): Box[] {
  const lh = line.y1 - line.y0
  // 글자보다 긴 가로 획(밑줄, 글자를 잇는 바닥선 — 영도체처럼)은 모든 글자를 한 덩어리로 묶어 버린다.
  // 나누기에서만 그 획을 빼고, 나눈 뒤에는 각 칸 아래·위로 그 획 부분을 다시 넣는다(기준 글꼴도 글자마다 제 몫의 획을 갖고 있다).
  const runs = longRuns(ink, line, Math.max(8, lh * 1.3))
  const cut = runs.length ? withoutRuns(ink, runs) : ink
  const cells0 = splitCells(cut, line, script, lh)
  if (!runs.length) return cells0
  for (const c of cells0) {
    for (const r of runs) {
      if (r.x1 <= c.x0 || r.x0 >= c.x1) continue
      if (r.y < c.y0) c.y0 = r.y
      if (r.y + 1 > c.y1) c.y1 = r.y + 1
    }
  }
  return cells0
}

interface Run {
  y: number
  x0: number
  x1: number
}

/** 줄 안에서 maxLen 보다 긴 가로 잉크 줄기 */
function longRuns(ink: Ink, line: Box, maxLen: number): Run[] {
  const out: Run[] = []
  for (let y = line.y0; y < line.y1; y++) {
    let st = -1
    for (let x = line.x0; x <= line.x1; x++) {
      const on = x < line.x1 && ink.v[y * ink.w + x] >= 0.5
      if (on && st < 0) st = x
      if (!on && st >= 0) {
        if (x - st > maxLen) out.push({ y, x0: st, x1: x })
        st = -1
      }
    }
  }
  return out
}

function withoutRuns(ink: Ink, runs: Run[]): Ink {
  const v = ink.v.slice()
  // 획 가장자리(흐린 윗줄·아랫줄)가 남아 이웃 글자를 잇지 않게 위아래 한 줄씩 더 지운다
  for (const r of runs) for (let y = Math.max(0, r.y - 1); y <= Math.min(ink.h - 1, r.y + 1); y++) v.fill(0, y * ink.w + r.x0, y * ink.w + r.x1)
  return { ...ink, v }
}

function splitCells(ink: Ink, line: Box, script: ScriptHint, lh: number): Box[] {
  const comps = components(ink, line, Math.max(2, Math.round(lh * lh * 0.002)))
  if (!comps.length) return []
  comps.sort((a, b) => a.x0 - b.x0)
  const cells: Box[] = []
  if (script === 'la' || script === 'ar' || script === 'cy' || script === 'gr' || script === 'vi') {
    for (const c of comps) {
      const last = cells[cells.length - 1]
      if (last) {
        const ov = Math.min(last.x1, c.x1) - Math.max(last.x0, c.x0)
        const minW = Math.min(last.x1 - last.x0, c.x1 - c.x0)
        if (ov > 0.5 * minW) {
          last.x0 = Math.min(last.x0, c.x0)
          last.x1 = Math.max(last.x1, c.x1)
          last.y0 = Math.min(last.y0, c.y0)
          last.y1 = Math.max(last.y1, c.y1)
          continue
        }
      }
      cells.push({ x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1 })
    }
    return cells
  }
  // 한·중·일 글자는 거의 정사각형이고, 줄 높이가 곧 글자 높이다
  const em = lh
  for (const c of comps) {
    const last = cells[cells.length - 1]
    if (last) {
      const nx0 = Math.min(last.x0, c.x0)
      const nx1 = Math.max(last.x1, c.x1)
      const gap = c.x0 - last.x1
      // 가로로 겹치는 조각(阝 와 反 처럼)은 글자가 옆으로 늘어난 사진(간판 사진의 가로세로 비가 틀어진 것)이어도 한 글자다
      if ((nx1 - nx0 <= em * 1.08 && gap < em * 0.45) || (gap < 0 && nx1 - nx0 <= em * 1.45)) {
        last.x0 = nx0
        last.x1 = nx1
        last.y0 = Math.min(last.y0, c.y0)
        last.y1 = Math.max(last.y1, c.y1)
        continue
      }
    }
    cells.push({ x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1 })
  }
  // 문장 부호처럼 작은 칸은 버린다
  return cells.filter((b) => Math.max(b.x1 - b.x0, b.y1 - b.y0) >= em * 0.3)
}

/** 잉크 칸 → 32x32 지문 (면적 평균 후 0.5 에서 자르기) */
export function normalizeInk(ink: Ink, box: Box): Glyph | null {
  // 잉크 상자(0.5 넘는 칸 기준)로 다시 조인다
  let x0 = box.x1
  let x1 = box.x0
  let y0 = box.y1
  let y1 = box.y0
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      if (ink.v[y * ink.w + x] >= 0.5) {
        if (x < x0) x0 = x
        if (x + 1 > x1) x1 = x + 1
        if (y < y0) y0 = y
        if (y + 1 > y1) y1 = y + 1
      }
    }
  }
  if (x1 <= x0 || y1 <= y0) return null
  const w = x1 - x0
  const h = y1 - y0
  const s = N / Math.max(w, h)
  const tw = Math.max(1, Math.round(w * s))
  const th = Math.max(1, Math.round(h * s))
  const ox = (N - tw) >> 1
  const oy = (N - th) >> 1
  const bits = new Uint32Array(N)
  const sx = w / tw
  const sy = h / th
  for (let ty = 0; ty < th; ty++) {
    const fy0 = y0 + ty * sy
    const fy1 = fy0 + sy
    for (let tx = 0; tx < tw; tx++) {
      const fx0 = x0 + tx * sx
      const fx1 = fx0 + sx
      let acc = 0
      for (let yy = Math.floor(fy0); yy < Math.ceil(fy1); yy++) {
        const wy = Math.min(fy1, yy + 1) - Math.max(fy0, yy)
        if (wy <= 0) continue
        const row = yy * ink.w
        for (let xx = Math.floor(fx0); xx < Math.ceil(fx1); xx++) {
          const wx = Math.min(fx1, xx + 1) - Math.max(fx0, xx)
          if (wx <= 0) continue
          acc += ink.v[row + xx] * wx * wy
        }
      }
      if (acc / (sx * sy) >= 0.5) bits[oy + ty] |= 1 << (ox + tx)
    }
  }
  for (let i = 0; i < N; i++) bits[i] >>>= 0
  return { box: { x0, y0, x1, y1 }, bits, pop: popBits(bits) }
}

/** 고른 영역 → 줄과 글자 지문 */
export function extract(ink: Ink, script: ScriptHint, box?: Box): Line[] {
  const out: Line[] = []
  const area = box ?? { x0: 0, y0: 0, x1: ink.w, y1: ink.h }
  const clean = (cells: Box[]) => {
    // 고른 영역의 귀퉁이에 걸친 덩어리(이웃 그림·접힌 모서리 등)는 글자가 아니다
    if (cells.length >= 2) {
      const e = 1
      cells = cells.filter((c) => {
        const L = c.x0 <= area.x0 + e
        const R = c.x1 >= area.x1 - e
        const T = c.y0 <= area.y0 + e
        const B = c.y1 >= area.y1 - e
        return !((L || R) && (T || B))
      })
    }
    // 줄에서 동떨어진 덩어리(배경 무늬·옆 그림)도 뺀다:
    // 가운데 높이가 줄 글자들의 가운데에서 글자 높이의 0.6 배 넘게 벗어나거나, 높이가 1.8 배를 넘으면.
    if (cells.length >= 3) {
      const hs = cells.map((c) => c.y1 - c.y0).sort((p, q) => p - q)
      const cy = cells.map((c) => (c.y0 + c.y1) / 2).sort((p, q) => p - q)
      const mh = hs[hs.length >> 1]
      const my = cy[cy.length >> 1]
      cells = cells.filter((c) => Math.abs((c.y0 + c.y1) / 2 - my) <= 0.6 * mh && c.y1 - c.y0 <= 1.8 * mh)
    }
    return cells
  }
  for (const lb of findLines(ink, box)) {
    const raw = splitGlyphBoxes(ink, lb, script)
    let cells = clean(raw)
    if (cells.length && cells.length < raw.length) {
      // 덩어리를 빼면 줄 높이가 줄어든다. 한·중·일은 줄 높이로 글자를 나누므로 줄어든 줄로 다시 나눈다.
      const y0 = Math.min(...cells.map((c) => c.y0))
      const y1 = Math.max(...cells.map((c) => c.y1))
      const x0 = Math.min(...cells.map((c) => c.x0))
      const x1 = Math.max(...cells.map((c) => c.x1))
      cells = clean(splitGlyphBoxes(ink, { x0, y0, x1, y1 }, script))
    }
    const glyphs: Glyph[] = []
    for (const gb of cells) {
      const g = normalizeInk(ink, gb)
      if (g && g.pop >= 6) glyphs.push(g)
    }
    if (!glyphs.length) continue
    // 줄 상자는 남은 글자들을 꼭 맞게 감싼다(학습 모델은 줄째 보므로 옆의 배경이 들어가면 안 된다)
    const tight = glyphs.reduce(
      (a, g) => ({ x0: Math.min(a.x0, g.box.x0), y0: Math.min(a.y0, g.box.y0), x1: Math.max(a.x1, g.box.x1), y1: Math.max(a.y1, g.box.y1) }),
      { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity },
    )
    out.push({ box: tight, glyphs })
  }
  return out
}

/* ───────── 글자 읽기(기준 글꼴과 맞대기) ───────── */

/** 지문 묶음: 128 바이트씩 이어 붙인 것 → Uint32Array 보기 */
export function bitsAt(buf: Uint32Array, i: number): Bits {
  return buf.subarray(i * N, i * N + N)
}

export interface Prepared {
  /** 원래 지문 */
  bits: Uint32Array
  /** 부풀린 지문 */
  dil: Uint32Array
  /** 칸 수(0 = 그 글자 없음) */
  pop: Uint16Array
}

export function prepare(buf: Uint32Array): Prepared {
  const n = buf.length / N
  const dil = new Uint32Array(buf.length)
  const pop = new Uint16Array(n)
  for (let i = 0; i < n; i++) {
    const b = bitsAt(buf, i)
    pop[i] = popBits(b)
    if (pop[i]) dilate(b, dil.subarray(i * N, i * N + N))
  }
  return { bits: buf, dil, pop }
}

export interface ReadResult {
  char: string
  score: number
  /** 다음 후보 */
  alts: { char: string; score: number }[]
}

/* 글자 읽기는 16x16 으로 한다(기준 글꼴이 많아도 받는 양이 작게). 32x32 의 2x2 칸 중 둘 이상이 잉크면 잉크. */
export function pool16(b: Bits): Uint16Array {
  const o = new Uint16Array(16)
  for (let y = 0; y < 16; y++) {
    const r0 = b[2 * y]
    const r1 = b[2 * y + 1]
    let r = 0
    for (let x = 0; x < 16; x++) {
      const n = ((r0 >>> (2 * x)) & 1) + ((r0 >>> (2 * x + 1)) & 1) + ((r1 >>> (2 * x)) & 1) + ((r1 >>> (2 * x + 1)) & 1)
      if (n >= 2) r |= 1 << x
    }
    o[y] = r
  }
  return o
}

function dilate16(b: Uint16Array, out: Uint16Array, at: number) {
  for (let y = 0; y < 16; y++) {
    let r = b[at + y]
    if (y > 0) r |= b[at + y - 1]
    if (y < 15) r |= b[at + y + 1]
    out[at + y] = (r | (r << 1) | (r >>> 1)) & 0xffff
  }
}

export interface Ref16 {
  bits: Uint16Array
  dil: Uint16Array
  pop: Uint16Array
}

/** ref16.bin(기준 글꼴 R × 글자 C × 16 줄) 준비 */
export function prepareRef16(buf: Uint16Array): Ref16 {
  const n = buf.length / 16
  const dil = new Uint16Array(buf.length)
  const pop = new Uint16Array(n)
  for (let i = 0; i < n; i++) {
    let p = 0
    for (let y = 0; y < 16; y++) p += popcnt(buf[i * 16 + y])
    pop[i] = p
    if (p) dilate16(buf, dil, i * 16)
  }
  return { bits: buf, dil, pop }
}

/** 글자 하나 읽기. 기준 글꼴들 중 가장 닮은 값으로 글자마다 점수를 매긴다. */
export function readGlyph(g: Glyph, ref: Ref16, chars: string): ReadResult {
  const arr = Array.from(chars)
  const C = arr.length
  const R = ref.pop.length / C
  const a = pool16(g.bits)
  const ad = new Uint16Array(16)
  dilate16(a, ad, 0)
  let ap = 0
  for (let y = 0; y < 16; y++) ap += popcnt(a[y])
  const best = new Float32Array(C)
  if (ap) {
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        const i = r * C + c
        const tp = ref.pop[i]
        if (!tp) continue
        const o = i * 16
        let inter = 0
        let x = 0
        let z = 0
        for (let y = 0; y < 16; y++) {
          const t = ref.bits[o + y]
          inter += popcnt(a[y] & t)
          x += popcnt(a[y] & ref.dil[o + y])
          z += popcnt(t & ad[y])
        }
        const s = 0.5 * (inter / (ap + tp - inter)) + 0.25 * (x / ap + z / tp)
        if (s > best[c]) best[c] = s
      }
    }
  }
  const order = Array.from(best.keys()).sort((p, q) => best[q] - best[p]).slice(0, 4)
  return {
    char: arr[order[0]],
    score: best[order[0]],
    alts: order.slice(1).map((k) => ({ char: arr[k], score: best[k] })),
  }
}

/* ───────── 글꼴 순위 ───────── */

export interface Observed {
  glyph: Glyph
  char: string
}

export interface FaceScore {
  face: number
  score: number
  /** 맞대 본 글자 수 */
  n: number
}

/**
 * 글자마다 그 글자의 모든 글꼴 지문(shard)을 받아 와서, 글꼴별 평균 닮음을 낸다.
 * table(char) → { faces: 글꼴 번호들, data: 그 순서의 지문 } 또는 null(그 묶음에 없는 글자)
 */
export function rankFaces(
  obs: Observed[],
  table: (char: string) => { faces: number[]; data: Prepared; offset: number } | null,
): FaceScore[] {
  const sum = new Map<number, number>()
  const cnt = new Map<number, number>()
  const usable = obs.filter((o) => table(o.char))
  for (const o of usable) {
    const t = table(o.char)!
    const gd = dilate(o.glyph.bits)
    for (let j = 0; j < t.faces.length; j++) {
      const i = t.offset + j
      const p = t.data.pop[i]
      if (!p) continue
      const s = similarity(o.glyph.bits, o.glyph.pop, gd, bitsAt(t.data.bits, i), p, t.data.dil.subarray(i * N, i * N + N))
      const f = t.faces[j]
      sum.set(f, (sum.get(f) ?? 0) + s)
      cnt.set(f, (cnt.get(f) ?? 0) + 1)
    }
  }
  const need = Math.max(1, Math.ceil(usable.length * 0.7))
  const out: FaceScore[] = []
  for (const [f, s] of sum) {
    const n = cnt.get(f)!
    if (n < need) continue
    // 빠진 글자가 있으면 조금 깎는다
    out.push({ face: f, score: (s / n) * (0.9 + 0.1 * (n / usable.length)), n })
  }
  out.sort((a, b) => b.score - a.score)
  return out
}

/** 회색 이미지 키우기(쌍선형). 작은 글자는 키운 뒤 잉크를 잡아야 획 굵기가 덜 뭉개진다. */
export function upscale(g: Gray, f: number): Gray {
  if (f <= 1) return g
  const w = Math.round(g.w * f)
  const h = Math.round(g.h * f)
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const sy = Math.min(g.h - 1, Math.max(0, (y + 0.5) / f - 0.5))
    const y0 = Math.floor(sy)
    const y1 = Math.min(g.h - 1, y0 + 1)
    const fy = sy - y0
    for (let x = 0; x < w; x++) {
      const sx = Math.min(g.w - 1, Math.max(0, (x + 0.5) / f - 0.5))
      const x0 = Math.floor(sx)
      const x1 = Math.min(g.w - 1, x0 + 1)
      const fx = sx - x0
      const a = g.data[y0 * g.w + x0] * (1 - fx) + g.data[y0 * g.w + x1] * fx
      const b = g.data[y1 * g.w + x0] * (1 - fx) + g.data[y1 * g.w + x1] * fx
      out[y * w + x] = Math.round(a * (1 - fy) + b * fy)
    }
  }
  return { w, h, data: out }
}

/* ───────── 속 빈 글자(테두리 글자) ───────── */

/** 지문에서 바깥과 이어지지 않은 빈칸(구멍)을 찾는다. 돌려주는 값: 구멍 칸 지문 */
export function holes(b: Bits): Bits {
  // 바깥 빈칸을 테두리에서부터 4방향으로 채워 나간다
  const out = new Uint32Array(N)
  const full = 0xffffffff >>> 0
  for (let y = 0; y < N; y++) {
    const empty = ~b[y] >>> 0
    out[y] = y === 0 || y === N - 1 ? empty : (empty & ((1 | (1 << (N - 1))) >>> 0)) >>> 0
  }
  for (let changed = true; changed; ) {
    changed = false
    for (let y = 0; y < N; y++) {
      const empty = ~b[y] >>> 0
      let r = out[y]
      if (y > 0) r |= out[y - 1]
      if (y < N - 1) r |= out[y + 1]
      r = (r | (r << 1) | (r >>> 1)) & empty & full
      r >>>= 0
      if (r !== out[y]) {
        out[y] = r
        changed = true
      }
    }
  }
  const h = new Uint32Array(N)
  for (let y = 0; y < N; y++) h[y] = ~(b[y] | out[y]) >>> 0
  return h
}

/**
 * 속 빈 글자의 "글자 몸" 구멍만 고른다. 바깥 빈칸 → 선 → 구멍(몸) → 선 → 구멍(ㅇ·ㅁ 원래 안쪽) 처럼
 * 번갈아 싸이므로, 바깥에서 선을 홀수 번 넘어 닿는 구멍만 몸이다(ㅇ 안쪽은 비워 둔다).
 */
export function bodyHoles(b: Bits): Bits {
  const NN = N * N
  const ink = new Uint8Array(NN)
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) ink[y * N + x] = (b[y] >>> x) & 1
  const lab = new Int32Array(NN).fill(-1)
  const isOuter: boolean[] = []
  let n = 0
  const stack: number[] = []
  for (let i = 0; i < NN; i++) {
    if (lab[i] >= 0) continue
    const v = ink[i]
    const id = n++
    isOuter.push(false)
    lab[i] = id
    stack.push(i)
    while (stack.length) {
      const p = stack.pop()!
      const x = p % N
      const y = (p / N) | 0
      if (!v && (x === 0 || y === 0 || x === N - 1 || y === N - 1)) isOuter[id] = true
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          if (!v && dx && dy) continue // 빈칸은 4방향, 선은 8방향
          const xx = x + dx
          const yy = y + dy
          if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue
          const q = yy * N + xx
          if (lab[q] < 0 && ink[q] === v) {
            lab[q] = id
            stack.push(q)
          }
        }
    }
  }
  const adj: Set<number>[] = Array.from({ length: n }, () => new Set<number>())
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const p = y * N + x
      if (!ink[p]) continue
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          const yy = y + dy
          if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue
          const q = yy * N + xx
          if (!ink[q]) {
            adj[lab[p]].add(lab[q])
            adj[lab[q]].add(lab[p])
          }
        }
    }
  const dist = new Int32Array(n).fill(-1)
  const queue: number[] = []
  for (let i = 0; i < n; i++)
    if (isOuter[i]) {
      dist[i] = 0
      queue.push(i)
    }
  for (let h = 0; h < queue.length; h++) for (const m of adj[queue[h]]) if (dist[m] < 0) {
    dist[m] = dist[queue[h]] + 1
    queue.push(m)
  }
  const out = new Uint32Array(N)
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const p = y * N + x
      if (ink[p]) continue
      const c = lab[p]
      if (isOuter[c]) continue
      const d = dist[c] < 0 ? 2 : dist[c]
      if ((d >> 1) % 2 === 1) out[y] = (out[y] | (1 << x)) >>> 0
    }
  return out
}

/** 속 빈 글자 → 선이 글자 윤곽에 걸친 경우에 맞는 판(선 + 몸 구멍을 메움) */
export function fillHoles(g: Glyph): Glyph {
  const h = bodyHoles(g.bits)
  const bits = new Uint32Array(N)
  for (let y = 0; y < N; y++) bits[y] = (g.bits[y] | h[y]) >>> 0
  return { ...g, bits, pop: popBits(bits) }
}

/** 속 빈 글자 → 선이 글자 바깥에 그려진 경우에 맞는 판(몸 구멍만 = 원래 글자 모양). 몸이 없으면 null */
export function innerBody(g: Glyph): Glyph | null {
  const bits = bodyHoles(g.bits)
  const pop = popBits(bits)
  return pop > 3 ? { ...g, bits, pop } : null
}

/**
 * 한 줄의 글자들이 테두리만 있는 글자(속 빈 글자)인지. 보통 글자도 ㅁ·ㅇ·口 처럼 구멍이 있지만,
 * 테두리 글자는 구멍 넓이가 잉크의 3할을 넘는 글자가 대부분이다. 줄 전체로 본다.
 */
export function isHollowLine(gs: Glyph[]): boolean {
  if (gs.length < 2) return false
  let ink = 0
  let hole = 0
  let withHole = 0
  for (const g of gs) {
    const h = popBits(holes(g.bits))
    ink += g.pop
    hole += h
    if (h > g.pop * 0.3) withHole++
  }
  // 시험(무료 한글 지문): 보통 굵은 글자는 구멍/잉크 99%가 0.24 아래, 테두리 글자는 90%가 0.38 위
  return hole > ink * 0.3 && withHole >= gs.length * 0.6
}
