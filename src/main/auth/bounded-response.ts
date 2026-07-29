/** Reads a response body without allowing a chunked upstream to bypass its byte budget. */
export async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
  oversizedMessage: string,
  signal?: AbortSignal,
): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(oversizedMessage)
  }
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Buffer[] = []
  let size = 0
  const onAbort = (): void => { void reader.cancel(signal?.reason).catch(() => undefined) }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    if (signal?.aborted) throw abortReason(signal)
    for (;;) {
      const { done, value } = await reader.read()
      if (signal?.aborted) throw abortReason(signal)
      if (done) break
      size += value.byteLength
      if (size > maximumBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error(oversizedMessage)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError')
}
