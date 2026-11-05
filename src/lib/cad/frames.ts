/**
 * 모형 공간에 도면 여러 장이 나란히 그려진 CAD 파일에서 도곽(테두리 네모)을 찾는다.
 * 한국 건축 도면은 모형 공간 한 곳에 수십 장을 늘어놓는 일이 흔해서, 통째로 PDF 한 쪽에 넣으면 글자가 안 보인다.
 * 찾은 도곽마다 PDF 한 쪽씩 만들 수 있게 한다.
 *
 * 찾는 법
 * - 축에 나란한 닫힌 네모(4~5점 폴리선)와, 따로 그은 네 변(가로 두 줄 + 세로 두 줄)으로 된 네모를 모은다.
 * - 너무 작은 것(긴 쪽이 전체의 1.5% 아래), 용지에 가까운 비율(1.1~1.75)이 아닌 것, 안이 빈 것은 뺀다.
 * - 그린 것의 60% 이상이 도곽 안에 있어야 하고, 후보가 30개를 넘으면 비율이 고르게 같아야 한다. 아니면 도곽 없음으로 본다.
 * - 다른 도곽 안에 든 네모(안쪽 테두리, 표 칸)는 뺀다.
 * - 위 줄부터, 왼쪽부터 차례를 매긴다.
 */
import type { RvtSheet2D } from '#/lib/rvt/types'

export type Box = [number, number, number, number]

interface Seg { a: number; b: number; c: number } // 가로: x a..b, y c / 세로: y a..b, x c

export function findFrames(sheet: RvtSheet2D): Box[] {
  const W = sheet.size.w
  const H = sheet.size.h
  const big = Math.max(W, H)
  const minSide = big * 0.015
  const tol = big * 0.0006
  const rects: Box[] = []
  const hs: Seg[] = []
  const vs: Seg[] = []
  const near = (a: number, b: number) => Math.abs(a - b) <= tol

  for (const it of sheet.items) {
    if (it.kind !== 'line') continue
    const p = it.pts
    const n = p.length / 2
    if (n === 2) {
      const [x0, y0, x1, y1] = [p[0]!, p[1]!, p[2]!, p[3]!]
      if (near(y0, y1) && Math.abs(x1 - x0) >= minSide) hs.push({ a: Math.min(x0, x1), b: Math.max(x0, x1), c: (y0 + y1) / 2 })
      else if (near(x0, x1) && Math.abs(y1 - y0) >= minSide) vs.push({ a: Math.min(y0, y1), b: Math.max(y0, y1), c: (x0 + x1) / 2 })
      continue
    }
    // 폴리선: 변마다 나눠서도 모으고, 4~5점 닫힌 네모면 바로 넣는다
    for (let i = 0; i + 3 < p.length; i += 2) {
      const x0 = p[i]!, y0 = p[i + 1]!, x1 = p[i + 2]!, y1 = p[i + 3]!
      if (near(y0, y1) && Math.abs(x1 - x0) >= minSide) hs.push({ a: Math.min(x0, x1), b: Math.max(x0, x1), c: (y0 + y1) / 2 })
      else if (near(x0, x1) && Math.abs(y1 - y0) >= minSide) vs.push({ a: Math.min(y0, y1), b: Math.max(y0, y1), c: (x0 + x1) / 2 })
    }
    if (n === 4 || n === 5) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (let i = 0; i < 8; i += 2) { x0 = Math.min(x0, p[i]!); x1 = Math.max(x1, p[i]!); y0 = Math.min(y0, p[i + 1]!); y1 = Math.max(y1, p[i + 1]!) }
      let ok = true
      for (let i = 0; i < 8; i += 2) { const x = p[i]!, y = p[i + 1]!; if (!((near(x, x0) || near(x, x1)) && (near(y, y0) || near(y, y1)))) ok = false }
      if (ok) rects.push([x0, y0, x1, y1])
    }
  }

  // 따로 그은 네 변: 같은 가로 폭의 가로선 두 줄 + 양 끝을 잇는 세로선
  if (hs.length * hs.length < 4e6) {
    hs.sort((p, q) => p.a - q.a || p.c - q.c)
    const vAt = (x: number, ya: number, yb: number) => vs.some((v) => near(v.c, x) && v.a <= ya + tol && v.b >= yb - tol)
    for (let i = 0; i < hs.length; i++) {
      const h1 = hs[i]!
      for (let j = i + 1; j < hs.length; j++) {
        const h2 = hs[j]!
        if (h2.a > h1.a + tol) break
        if (!near(h1.b, h2.b) || Math.abs(h2.c - h1.c) < minSide) continue
        const ya = Math.min(h1.c, h2.c), yb = Math.max(h1.c, h2.c)
        if (vAt(h1.a, ya, yb) && vAt(h1.b, ya, yb)) rects.push([h1.a, ya, h1.b, yb])
      }
    }
  }

  // 크기·모양 거르기
  let cand = rects.filter(([x0, y0, x1, y1]) => {
    const w = x1 - x0, h = y1 - y0
    if (Math.max(w, h) < minSide || Math.min(w, h) <= 0) return false
    // 용지 비율에 가까운 것만(A 계열 1.414, 레터 1.29, B·ANSI 1.55 언저리). 창·가구·범례 네모는 대개 여기서 빠진다
    const r = Math.max(w, h) / Math.min(w, h)
    return r >= 1.1 && r <= 1.75
  })
  // 같은 네모가 여러 번 잡힌 것 하나로
  const uniq: Box[] = []
  for (const b of cand) if (!uniq.some((u) => near(u[0], b[0]) && near(u[1], b[1]) && near(u[2], b[2]) && near(u[3], b[3]))) uniq.push(b)
  cand = uniq
  // 다른 네모 안에 든 것 빼기(바깥 도곽만)
  const inside = (a: Box, b: Box) => a !== b && a[0] >= b[0] - tol && a[1] >= b[1] - tol && a[2] <= b[2] + tol && a[3] <= b[3] + tol
  cand = cand.filter((a) => !cand.some((b) => inside(a, b)))
  // 안에 그린 것이 있는 것만
  const centers: number[] = []
  for (const it of sheet.items) {
    if (it.kind === 'line' && it.pts.length >= 4) centers.push((it.pts[0]! + it.pts[2]!) / 2, (it.pts[1]! + it.pts[3]!) / 2)
    else if (it.kind === 'text') centers.push(it.x, it.y)
    else if (it.kind === 'arc') centers.push(it.cx, it.cy)
  }
  cand = cand.filter(([x0, y0, x1, y1]) => {
    let n = 0
    for (let i = 0; i < centers.length; i += 2) { const x = centers[i]!, y = centers[i + 1]!; if (x > x0 && x < x1 && y > y0 && y < y1 && ++n >= 12) return true }
    return false
  })
  if (cand.length < 2) return []
  // 도곽이라면 그린 것 대부분이 도곽 안에 있어야 한다(도면 한 장 안의 작은 네모들을 도곽으로 잘못 보지 않게)
  let tot = 0, inAny = 0
  for (let i = 0; i < centers.length; i += 2) {
    const x = centers[i]!, y = centers[i + 1]!
    tot++
    if (cand.some(([x0, y0, x1, y1]) => x > x0 && x < x1 && y > y0 && y < y1)) inAny++
  }
  if (tot === 0 || inAny / tot < 0.6) return []
  // 후보가 아주 많으면 모양이 고르게 같은 비율일 때만 믿는다
  if (cand.length > 30) {
    const rs = cand.map(([x0, y0, x1, y1]) => Math.max(x1 - x0, y1 - y0) / Math.min(x1 - x0, y1 - y0)).sort((a, b) => a - b)
    const mid = rs[rs.length >> 1]!
    if (rs.filter((r) => Math.abs(r / mid - 1) > 0.05).length > cand.length * 0.1) return []
  }
  // 위 줄부터, 왼쪽부터
  const hMed = cand.map((b) => b[3] - b[1]).sort((a, b) => a - b)[cand.length >> 1]!
  cand.sort((a, b) => {
    const dy = b[3] - a[3]
    if (Math.abs(dy) > hMed * 0.5) return dy
    return a[0] - b[0]
  })
  return cand.slice(0, 300)
}
