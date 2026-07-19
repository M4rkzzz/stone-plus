import type { AppSnapshot, GatewayApi, Pool, PublicAccount } from '@shared/types'

type SetupWizardSourceApi = Pick<GatewayApi, 'saveAccount' | 'saveAggregateRelay'>

/** Persist the network exit selected by the wizard before any upstream check runs. */
export async function persistSetupWizardSourceProxy(
  api: SetupWizardSourceApi,
  account: PublicAccount,
  proxyId: string,
  aggregate?: Pool,
): Promise<AppSnapshot | null> {
  if (aggregate?.kind === 'relay-aggregate') {
    if ((aggregate.proxyId ?? '') === proxyId) return null
    return api.saveAggregateRelay({
      id: aggregate.id,
      name: aggregate.name,
      protocol: aggregate.protocol,
      strategy: aggregate.strategy === 'weighted-round-robin' || aggregate.strategy === 'round-robin'
        ? aggregate.strategy
        : 'priority',
      members: aggregate.members.map((member, index) => ({
        accountId: member.accountId,
        order: member.order ?? index,
        weight: member.weight ?? 1,
      })),
      stickySessions: aggregate.stickySessions,
      stickyTtlMinutes: aggregate.stickyTtlMinutes,
      maxRetries: aggregate.maxRetries,
      proxyId,
    })
  }
  if ((account.proxyId ?? '') === proxyId) return null
  return api.saveAccount({
    id: account.id,
    providerId: account.providerId,
    name: account.name,
    priority: account.priority,
    weight: account.weight,
    maxConcurrency: account.maxConcurrency,
    modelPolicy: account.modelPolicy,
    modelAllowlist: account.modelAllowlist,
    proxyId,
  })
}

/** Convert a successful void IPC action into an explicit success sentinel. */
export async function confirmSetupWizardAction(operation: () => Promise<void>): Promise<true> {
  await operation()
  return true
}
