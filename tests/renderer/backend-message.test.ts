import { describe, expect, it } from 'vitest'
import type { ApiSourceProbeStage } from '../../src/shared/types'
import {
  containsHanText,
  localizeBackendError,
  localizeBackendMessage,
  localizeProviderProbeStage,
  localizeReleaseNotes,
  providerProbeStageLabel,
  providerProbeStatusLabel,
} from '../../src/renderer/src/backend-message'

describe('renderer backend-message localization', () => {
  it('keeps Chinese messages unchanged in the Chinese UI', () => {
    expect(localizeBackendMessage('检查更新超时，请确认网络后重试。', 'zh-CN', 'fallback'))
      .toBe('检查更新超时，请确认网络后重试。')
  })

  it('translates stable backend messages exactly', () => {
    expect(localizeBackendMessage('OAuth Token 交换超时。', 'en', 'OAuth failed.'))
      .toBe('OAuth token exchange timed out.')
    expect(localizeBackendMessage('已发现 27 个可用模型。', 'en', 'Model discovery failed.'))
      .toBe('27 available model(s) found.')
    expect(localizeBackendMessage('会话文件在修复前发生变化，请重新预览：sessions/abc.jsonl', 'en', 'Session repair failed.'))
      .toBe('A session file changed before repair. Preview again: sessions/abc.jsonl')
  })

  it('uses an English safe fallback for unknown Chinese while retaining diagnostics', () => {
    const localized = localizeBackendMessage('未知错误：HTTP 499，120 秒后 ECONNRESET', 'en', 'The upstream request failed.')
    expect(localized).toContain('The upstream request failed.')
    expect(localized).toContain('HTTP 499')
    expect(localized).toContain('120 s')
    expect(localized).toContain('ECONNRESET')
    expect(containsHanText(localized)).toBe(false)
  })

  it('does not leak a Chinese fallback and preserves an already-English backend error', () => {
    expect(localizeBackendMessage('新的未知错误', 'en', '操作失败'))
      .toBe('The operation could not be completed.')
    expect(localizeBackendError(new Error('connect ETIMEDOUT'), 'en', 'Connection failed.'))
      .toBe('connect ETIMEDOUT')
  })

  it('localizes provider probe stage labels, status, and messages', () => {
    const stage: ApiSourceProbeStage = {
      id: 'models',
      status: 'success',
      message: '已发现 8 个可用模型。',
      latencyMs: 42,
    }
    expect(localizeProviderProbeStage(stage, 'en')).toEqual({ ...stage, message: '8 available model(s) found.' })
    expect(providerProbeStageLabel(stage, 'en')).toBe('Models')
    expect(providerProbeStatusLabel(stage, 'en')).toBe('Passed')
    expect(localizeProviderProbeStage(stage, 'zh-CN')).toBe(stage)
  })

  it('translates internal fallback release notes but preserves external notes', () => {
    expect(localizeReleaseNotes('完整更新说明请打开 GitHub Release 查看。', 'en'))
      .toBe('Open the GitHub Release to view the complete release notes.')
    expect(localizeReleaseNotes('社区作者的原始发布说明', 'en'))
      .toBe('社区作者的原始发布说明')
  })
})
