import type { GatewaySettings, GatewayStatus } from '@shared/types'

interface GatewaySettingsTransaction {
  previous: GatewaySettings
  wasRunning: boolean
  apply(): Promise<void>
  restoreSettings(): Promise<void>
  restoreOutbound(): void
  restoreBackups(): Promise<void>
  refreshConfig(): void
  status(): GatewayStatus
  stop(): Promise<void>
  start(): Promise<void>
  publishStatus(): void
}

/** A failed settings change must not strand every client on a dead endpoint.
 * The caller holds the gateway lifecycle queue through rollback as well.
 * Restore only gateway settings, never an old snapshot of routes/accounts. */
export async function applyGatewaySettingsTransaction(transaction: GatewaySettingsTransaction): Promise<void> {
  try {
    await transaction.apply()
  } catch (error) {
    // Gateway status currently derives its address from the runtime config.
    // Capture it before publishing the old config, which would otherwise hide
    // a newly-bound listener that still needs to be stopped.
    const listenerBeforeRollback = transaction.status()
    const failures: string[] = []
    const attempt = async (stage: string, action: () => void | Promise<void>): Promise<boolean> => {
      try {
        await action()
        return true
      } catch (rollbackError) {
        failures.push(`${stage}: ${messageOf(rollbackError)}`)
        return false
      }
    }
    // Do not restart with a mixture of old and new settings if persistence or
    // transport recovery failed. Still publish the actual observed state.
    const settingsRestored = await attempt('settings', transaction.restoreSettings)
    const outboundRestored = await attempt('outbound', transaction.restoreOutbound)
    await attempt('backups', transaction.restoreBackups)
    if (settingsRestored && outboundRestored) {
      await attempt('listener', async () => {
        const wrongAddress = listenerBeforeRollback.host !== transaction.previous.host
          || listenerBeforeRollback.port !== transaction.previous.port
        if (listenerBeforeRollback.running && (!transaction.wasRunning || wrongAddress)) await transaction.stop()
        transaction.refreshConfig()
        if (transaction.wasRunning && !transaction.status().running) await transaction.start()
        const restored = transaction.status()
        if (restored.running !== transaction.wasRunning || (restored.running && (
          restored.host !== transaction.previous.host || restored.port !== transaction.previous.port
        ))) throw new Error('Gateway did not return to its previous listening state')
      })
    }
    await attempt('status', transaction.publishStatus)
    if (failures.length) {
      throw new Error(`${messageOf(error)}; gateway rollback incomplete (${failures.join('; ')})`, { cause: error })
    }
    throw error
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
