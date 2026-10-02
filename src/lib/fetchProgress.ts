/**
 * 큰 정적 파일을 진행률과 함께 내려받는다.
 *
 * fetch(url).arrayBuffer() 한 줄로도 되지만, 몇 MB 짜리 모델·엔진·글꼴을 그렇게
 * 받으면 화면이 아무 말 없이 몇 초 멈춘다. 사용자는 그 침묵을 고장으로 읽는다.
 */

/** 전체 크기를 모르면 ratio 는 null 이다. */
export type RatioReport = (ratio: number | null) => void

export async function fetchWithProgress(url: string, report: RatioReport): Promise<ArrayBuffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`FETCH_FAILED ${res.status} ${url}`)

  const total = Number(res.headers.get('content-length')) || 0
  if (!res.body || !total) {
    report(null)
    return res.arrayBuffer()
  }

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    report(Math.min(1, received / total))
  }

  const out = new Uint8Array(received)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out.buffer
}
