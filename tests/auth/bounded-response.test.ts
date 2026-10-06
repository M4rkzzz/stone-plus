import { describe, expect, it } from 'vitest'
import {
  readBoundedResponseBuffer,
  readBoundedResponseText,
} from '../../src/main/auth/bounded-response'

describe('bounded response readers', () => {
  it('returns bounded text and binary payloads', async () => {
    await expect(readBoundedResponseText(new Response('stone'), 5, 'too large')).resolves.toBe('stone')
    await expect(readBoundedResponseBuffer(new Response('plus'), 4, 'too large'))
      .resolves.toEqual(Buffer.from('plus'))
  })

  it('cancels a chunked response as soon as its byte budget is exceeded', async () => {
    let cancelled = false
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4))
        controller.enqueue(new Uint8Array(4))
      },
      cancel() {
        cancelled = true
      },
    }))

    await expect(readBoundedResponseBuffer(response, 7, 'too large')).rejects.toThrow('too large')
    expect(cancelled).toBe(true)
  })
})
