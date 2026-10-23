import type { AccountModelTestResult } from '@shared/types'

export type ModelTestState =
  | { status: 'testing' }
  | { status: 'success'; latencyMs: number; statusCode?: number; responsePreview?: string }
  | { status: 'failure'; message: string; latencyMs?: number; statusCode?: number }

export function modelTestCompleted(result: AccountModelTestResult, fallbackMessage = '模型未返回有效响应'): ModelTestState {
  if (result.ok) {
    return {
      status: 'success',
      latencyMs: result.latencyMs,
      statusCode: result.statusCode,
      responsePreview: result.responsePreview,
    }
  }
  return {
    status: 'failure',
    message: result.responsePreview || fallbackMessage,
    latencyMs: result.latencyMs,
    statusCode: result.statusCode,
  }
}

export function modelTestFailed(cause: unknown, fallbackMessage = '模型测试失败'): ModelTestState {
  return {
    status: 'failure',
    message: cause instanceof Error ? cause.message : fallbackMessage,
  }
}

export function modelTestTitle(model: string, state?: ModelTestState, language: 'zh-CN' | 'en' = 'zh-CN'): string {
  const chinese = language === 'zh-CN'
  if (!state) return chinese ? `测试模型 ${model}` : `Test model ${model}`
  if (state.status === 'testing') return chinese ? `正在测试 ${model}` : `Testing ${model}`
  if (state.status === 'success') {
    const status = state.statusCode ? ` · HTTP ${state.statusCode}` : ''
    const preview = state.responsePreview ? ` · ${state.responsePreview}` : ''
    return chinese
      ? `${model} 可用 · ${state.latencyMs} ms${status}${preview}`
      : `${model} available · ${state.latencyMs} ms${status}${preview}`
  }
  const latency = state.latencyMs === undefined ? '' : ` · ${state.latencyMs} ms`
  const status = state.statusCode ? ` · HTTP ${state.statusCode}` : ''
  return chinese
    ? `${model} 不可用${latency}${status} · ${state.message}`
    : `${model} unavailable${latency}${status} · ${state.message}`
}
