import type { ApiSourceInput } from '@shared/types'

export type ProviderProbeDraftBinding = Pick<
  ApiSourceInput,
  'id' | 'sourceType' | 'kind' | 'baseUrl' | 'protocol' | 'responsesCompactMode' | 'credential' | 'proxyId' | 'defaultModel'
>

/** Bind a probe to one modal incarnation and the exact connection/model tested. */
export function providerProbeDraftBinding(draft: ProviderProbeDraftBinding, modalSession: number): string {
  return JSON.stringify({
    modalSession,
    id: draft.id?.trim() ?? null,
    sourceType: draft.sourceType,
    kind: draft.kind,
    baseUrl: draft.baseUrl.trim().replace(/\/$/, ''),
    protocol: draft.protocol,
    responsesCompactMode: draft.responsesCompactMode ?? null,
    credential: draft.credential?.trim() ?? '',
    proxyId: draft.proxyId?.trim() ?? '',
    defaultModel: draft.defaultModel?.trim() ?? '',
  })
}
