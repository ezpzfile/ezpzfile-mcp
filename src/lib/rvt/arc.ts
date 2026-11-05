/**
 * 호(arc)의 각도 범위를 안전하게 정리한다. 2D 화면(draw2d), RVT 시트(SheetViewer), 시트 PDF 가 같이 쓴다.
 *
 * 예전에는 `while (sweep < 0) sweep += 2π` 로 맞췄는데, 망가진 파일에서 각도가 -1e300 처럼 아주 크면
 * 2π 를 더해도 값이 바뀌지 않아 화면이 멈췄다. 이제는 나머지 셈으로 한 번에 맞춘다.
 * 각도·반지름·중심이 숫자가 아니면(NaN, 무한대) null 을 돌려주고, 그 호는 그리지 않는다.
 */
const TAU = Math.PI * 2

/** 시작 각도에서 반시계 방향으로 도는 양(0 이상, 한 바퀴면 정확히 2π). 못 쓰는 호면 null */
export function arcSweep(a0: number, a1: number, r = 1, cx = 0, cy = 0): number | null {
  if (!Number.isFinite(a0) || !Number.isFinite(a1) || !Number.isFinite(r) || !Number.isFinite(cx) || !Number.isFinite(cy) || r < 0) return null
  const s = a1 - a0
  if (!Number.isFinite(s)) return null
  if (s >= TAU - 1e-6) return TAU
  if (s >= 0) return s
  const m = s % TAU
  return m < 0 ? m + TAU : m
}

export const ARC_FULL = TAU
