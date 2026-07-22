import type { Protocol, ResponsesCompactMode, UpstreamSourceType } from '@shared/types'

export type { ResponsesCompactMode } from '@shared/types'

export const responsesCompactModes: readonly ResponsesCompactMode[] = [
  'legacy',
  'passthrough',
  'native',
]

export const responsesCompactModeCopy: Record<ResponsesCompactMode, {
  labelZh: string
  labelEn: string
  helpZh: string
  helpEn: string
}> = {
  legacy: {
    labelZh: '传统回退（兼容优先）',
    labelEn: 'Legacy fallback (compatibility first)',
    helpZh: 'Stone+ 仅对独立 /responses/compact 请求用普通 Responses 生成文本摘要；原生 compaction_trigger 会被拒绝，也不会把已有 encrypted_content 或 Compact 连续性元数据头发给中转。适合未明确声明 compact 能力的中转，也是旧配置的默认行为。',
    helpEn: 'Stone+ creates a text summary only for standalone /responses/compact requests. Native compaction_trigger requests are rejected, and existing encrypted_content or Compact continuity metadata headers are not sent to the relay. Use this for relays without explicit compact support; it is also the default for existing configurations.',
  },
  passthrough: {
    labelZh: 'Opaque 历史透传',
    labelEn: 'Opaque history passthrough',
    helpZh: '独立 /responses/compact 请求仍使用文本回退，原生 compaction_trigger 仍会被拒绝；但已有 encrypted_content 及维持连续性所需的 Codex 元数据头会原样发给中转。仅当中转明确支持续传 opaque 历史时选择，否则可能返回 4xx 并中断任务。',
    helpEn: 'Standalone /responses/compact still uses the text fallback, and native compaction_trigger remains unsupported; existing encrypted_content and the Codex metadata headers needed for continuity are forwarded unchanged. Select this only when the relay explicitly supports continuing opaque history, or requests may fail with 4xx and interrupt the task.',
  },
  native: {
    labelZh: '完整原生 Compact',
    labelEn: 'Full native compact',
    helpZh: '将原生 compact 请求、终止事件、后续 encrypted_content 及维持连续性所需的 Codex 元数据头交给中转处理。仅当中转完整实现 Codex / Responses compact 协议时选择；虚假兼容会导致断流或历史损坏。',
    helpEn: 'The relay handles native compact requests, terminal events, subsequent encrypted_content, and the Codex metadata headers needed for continuity. Select this only when it fully implements the Codex / Responses compact protocol; partial compatibility can truncate streams or corrupt task history.',
  },
}

export function effectiveResponsesCompactMode(value: unknown): ResponsesCompactMode {
  return responsesCompactModes.includes(value as ResponsesCompactMode)
    ? value as ResponsesCompactMode
    : 'legacy'
}

export function relayCanConfigureResponsesCompact(
  sourceType: UpstreamSourceType,
  protocol: Protocol,
): boolean {
  return sourceType === 'relay' && protocol === 'openai-responses'
}

export function officialOpenAiUsesNativeCompact(
  sourceType: UpstreamSourceType,
  kind: string,
  protocol: Protocol,
): boolean {
  return sourceType === 'official-api' && kind === 'openai' && protocol === 'openai-responses'
}

export function responsesCompactModeForSave(
  sourceType: UpstreamSourceType,
  protocol: Protocol,
  value: unknown,
): ResponsesCompactMode | undefined {
  return relayCanConfigureResponsesCompact(sourceType, protocol)
    ? effectiveResponsesCompactMode(value)
    : undefined
}
