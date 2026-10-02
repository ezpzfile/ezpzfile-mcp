/**
 * ReadableStream 을 `for await ... of` 로 돌 수 있게 채워 넣는다.
 *
 * 아이폰 사파리(iOS 18.7 / 26.6.1 에서 확인)에는
 * `ReadableStream.prototype[Symbol.asyncIterator]` 가 없다. 규격에는 있지만
 * 아직 안 들어간 것이라, 데스크톱 사파리·크롬·파이어폭스에서는 멀쩡하고 그
 * 기기에서만 없다.
 *
 * pdf.js 는 쪽에서 글자를 뽑을 때(`getTextContent`) 그 문법으로 조각을
 * 받는다. 없으면 그 자리에서 `undefined is not a function` 으로 넘어진다.
 * 쪽을 그리는 길은 따로라서 문서는 멀쩡히 보이고, **글자 목록만 통째로
 * 비어** 원본 글자를 못 고치고 찾기도 0건이 된다. 내려받는 글꼴을 모으는
 * 자리에서도 같은 문법을 쓴다.
 *
 * 규격에 적힌 `values()` 를 그대로 만들어 붙인다. 이미 있는 브라우저에서는
 * 아무 일도 하지 않는다.
 */
export function ensureStreamIteration(): void {
  if (typeof ReadableStream === 'undefined') return
  const proto = ReadableStream.prototype as unknown as Record<string | symbol, unknown>
  if (typeof proto[Symbol.asyncIterator] === 'function') return

  function values<T>(this: ReadableStream<T>, options?: { preventCancel?: boolean }) {
    const preventCancel = options?.preventCancel ?? false
    const reader = this.getReader()
    const walk = {
      async next(): Promise<IteratorResult<T, undefined>> {
        try {
          const step = await reader.read()
          if (step.done) {
            reader.releaseLock()
            return { done: true, value: undefined }
          }
          return { done: false, value: step.value }
        } catch (err) {
          // 읽다가 깨지면 자물쇠를 풀어 준다. 안 그러면 흐름이 영영 잠긴다.
          reader.releaseLock()
          throw err
        }
      },
      async return(): Promise<IteratorResult<T, undefined>> {
        if (preventCancel) {
          reader.releaseLock()
        } else {
          const stop = reader.cancel()
          reader.releaseLock()
          await stop
        }
        return { done: true, value: undefined }
      },
      [Symbol.asyncIterator]() {
        return walk
      },
    }
    return walk
  }

  const put = (key: string | symbol) =>
    Object.defineProperty(proto, key, { value: values, writable: true, configurable: true })
  if (typeof proto.values !== 'function') put('values')
  put(Symbol.asyncIterator)
}
