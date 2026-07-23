import { describe, expect, it } from 'vitest'
import { modelTestCompleted, modelTestFailed, modelTestTitle } from '../../src/renderer/src/model-test-state'

describe('renderer account model test state', () => {
  it('keeps successful latency and safe preview for the session display', () => {
    const state = modelTestCompleted({
      ok: true,
      model: 'gpt-5.6',
      latencyMs: 284,
      statusCode: 200,
      responsePreview: 'OK',
    })

    expect(state).toEqual({
      status: 'success',
      latencyMs: 284,
      statusCode: 200,
      responsePreview: 'OK',
    })
    expect(modelTestTitle('gpt-5.6', state)).toBe('gpt-5.6 可用 · 284 ms · HTTP 200 · OK')
  })

  it('turns thrown safe errors into a visible failure without persisting anything', () => {
    const state = modelTestFailed(new Error('上游不允许该模型'))

    expect(state).toEqual({ status: 'failure', message: '上游不允许该模型' })
    expect(modelTestTitle('gpt-5.6', state)).toContain('上游不允许该模型')
  })

  it('handles an unsuccessful structured response defensively', () => {
    const state = modelTestCompleted({
      ok: false,
      model: 'gpt-5.6',
      latencyMs: 95,
      statusCode: 404,
      responsePreview: 'model_not_found',
    })

    expect(state).toEqual({
      status: 'failure',
      message: 'model_not_found',
      latencyMs: 95,
      statusCode: 404,
    })
  })
})
