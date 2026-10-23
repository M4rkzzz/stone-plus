import { describe, expect, it, vi } from 'vitest'
import { applyGatewaySettingsTransaction } from '../../src/main/ipc/gateway-settings-transaction'
import type { GatewaySettings, GatewayStatus } from '../../src/shared/types'

function harness(wasRunning = true) {
  const previous: GatewaySettings = { host: '127.0.0.1', port: 15721, autoStart: false, logPayloads: false, requestTimeoutSeconds: 120 }
  let status: GatewayStatus = { running: false, host: previous.host, port: 15722, activeRequests: 0, totalRequests: 0, successRequests: 0 }
  return {
    previous, wasRunning,
    apply: vi.fn(async () => { throw new Error('new endpoint unavailable') }),
    restoreSettings: vi.fn(async () => undefined),
    restoreOutbound: vi.fn(),
    restoreBackups: vi.fn(async () => undefined),
    refreshConfig: vi.fn(),
    status: () => status,
    stop: vi.fn(async () => { status = { ...status, running: false } }),
    start: vi.fn(async () => { status = { ...status, running: true, host: previous.host, port: previous.port } }),
    publishStatus: vi.fn(),
    setStatus: (patch: Partial<GatewayStatus>) => { status = { ...status, ...patch } },
  }
}

describe('gateway settings transaction', () => {
  it('does not stop or restart anything on success', async () => {
    const transaction = harness()
    transaction.apply.mockResolvedValueOnce(undefined)
    await applyGatewaySettingsTransaction(transaction)
    expect(transaction.restoreSettings).not.toHaveBeenCalled()
    expect(transaction.start).not.toHaveBeenCalled()
    expect(transaction.stop).not.toHaveBeenCalled()
  })

  it('keeps a previously stopped gateway stopped after failure', async () => {
    const transaction = harness(false)
    await expect(applyGatewaySettingsTransaction(transaction)).rejects.toThrow('new endpoint unavailable')
    expect(transaction.start).not.toHaveBeenCalled()
    expect(transaction.status().running).toBe(false)
    expect(transaction.publishStatus).toHaveBeenCalledOnce()
  })

  it('undoes an already-started new listener after a later failure', async () => {
    const transaction = harness()
    transaction.setStatus({ running: true })
    await expect(applyGatewaySettingsTransaction(transaction)).rejects.toThrow('new endpoint unavailable')
    expect(transaction.stop).toHaveBeenCalledOnce()
    expect(transaction.start).toHaveBeenCalledOnce()
    expect(transaction.status()).toMatchObject({ running: true, port: 15721 })
  })

  it.each(['restoreSettings', 'restoreOutbound', 'refreshConfig'] as const)('does not launch a mixed configuration when %s fails', async (stage) => {
    const transaction = harness()
    transaction[stage].mockImplementationOnce(() => { throw new Error('rollback failure') })
    await expect(applyGatewaySettingsTransaction(transaction)).rejects.toThrow(/new endpoint unavailable; gateway rollback incomplete.*rollback failure/)
    expect(transaction.start).not.toHaveBeenCalled()
    expect(transaction.publishStatus).toHaveBeenCalledOnce()
  })

  it('reports both errors and the actual stopped state if the old listener cannot reopen', async () => {
    const transaction = harness()
    transaction.start.mockRejectedValueOnce(new Error('old endpoint occupied'))
    await expect(applyGatewaySettingsTransaction(transaction)).rejects.toThrow(/new endpoint unavailable.*old endpoint occupied/)
    expect(transaction.status().running).toBe(false)
    expect(transaction.publishStatus).toHaveBeenCalledOnce()
  })

  it('continues recovering the listener even if backup schedule rollback fails', async () => {
    const transaction = harness()
    transaction.restoreBackups.mockRejectedValueOnce(new Error('backup recovery failed'))
    await expect(applyGatewaySettingsTransaction(transaction)).rejects.toThrow('backup recovery failed')
    expect(transaction.status()).toMatchObject({ running: true, port: 15721 })
    expect(transaction.publishStatus).toHaveBeenCalledOnce()
  })
})
