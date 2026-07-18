import { contextBridge, ipcRenderer } from 'electron'
import type { GatewayApi } from '@shared/types'

const stone: GatewayApi = {
  getSnapshot: () => ipcRenderer.invoke('stone:get-snapshot'),
  saveProvider: (input) => ipcRenderer.invoke('stone:save-provider', input),
  refreshProviderModels: (id) => ipcRenderer.invoke('stone:refresh-provider-models', id),
  deleteProvider: (id) => ipcRenderer.invoke('stone:delete-provider', id),
  saveAccount: (input) => ipcRenderer.invoke('stone:save-account', input),
  refreshAccountModels: (id) => ipcRenderer.invoke('stone:refresh-account-models', id),
  testAccountModel: (accountId, model) => ipcRenderer.invoke('stone:test-account-model', accountId, model),
  importChatGptAccounts: (input) => ipcRenderer.invoke('stone:import-chatgpt-accounts', input),
  importChatGptAccountFiles: (input) => ipcRenderer.invoke('stone:import-chatgpt-account-files', input),
  getBrowserImportQueue: () => ipcRenderer.invoke('stone:get-browser-import-queue'),
  removeBrowserImportItem: (id) => ipcRenderer.invoke('stone:remove-browser-import-item', id),
  clearBrowserImportQueue: () => ipcRenderer.invoke('stone:clear-browser-import-queue'),
  importBrowserJsonQueue: (input) => ipcRenderer.invoke('stone:import-browser-json-queue', input),
  exportChatGptAccounts: (input) => ipcRenderer.invoke('stone:export-chatgpt-accounts', input),
  deleteAccount: (id) => ipcRenderer.invoke('stone:delete-account', id),
  deleteAccounts: (ids) => ipcRenderer.invoke('stone:delete-accounts', ids),
  saveProxy: (input) => ipcRenderer.invoke('stone:save-proxy', input),
  deleteProxy: (id) => ipcRenderer.invoke('stone:delete-proxy', id),
  checkProxy: (id) => ipcRenderer.invoke('stone:check-proxy', id),
  savePool: (input) => ipcRenderer.invoke('stone:save-pool', input),
  deletePool: (id) => ipcRenderer.invoke('stone:delete-pool', id),
  updateRoute: (route) => ipcRenderer.invoke('stone:update-route', route),
  updateGateway: (settings) => ipcRenderer.invoke('stone:update-gateway', settings),
  startGateway: () => ipcRenderer.invoke('stone:start-gateway'),
  stopGateway: () => ipcRenderer.invoke('stone:stop-gateway'),
  rebuildOutboundConnections: () => ipcRenderer.invoke('stone:rebuild-outbound-connections'),
  detectSystemProxy: () => ipcRenderer.invoke('stone:detect-system-proxy'),
  runNetworkDiagnostics: (input) => ipcRenderer.invoke('stone:run-network-diagnostics', input),
  checkAccount: (id) => ipcRenderer.invoke('stone:check-account', id),
  refreshAccountCodexQuota: (id) => ipcRenderer.invoke('stone:refresh-account-codex-quota', id),
  getAccountCodexQuotaHistory: (id, from, to) => ipcRenderer.invoke('stone:get-account-codex-quota-history', id, from, to),
  clearLogs: () => ipcRenderer.invoke('stone:clear-logs'),
  clearHealthEvents: () => ipcRenderer.invoke('stone:clear-health-events'),
  listProviderPresets: () => ipcRenderer.invoke('stone:list-provider-presets'),
  onboardProvider: (input) => ipcRenderer.invoke('stone:onboard-provider', input),
  saveClientProfile: (input) => ipcRenderer.invoke('stone:save-client-profile', input),
  deleteClientProfile: (id) => ipcRenderer.invoke('stone:delete-client-profile', id),
  exportClientProfile: (id) => ipcRenderer.invoke('stone:export-client-profile', id),
  importClientProfile: (bundle) => ipcRenderer.invoke('stone:import-client-profile', bundle),
  getClientConfigs: (profileId) => ipcRenderer.invoke('stone:get-client-configs', profileId),
  previewClientConfig: (client, profileId) => ipcRenderer.invoke('stone:preview-client-config', client, profileId),
  applyClientConfig: (client, profileId) => ipcRenderer.invoke('stone:apply-client-config', client, profileId),
  listClientConfigBackups: (client, profileId) => ipcRenderer.invoke('stone:list-client-config-backups', client, profileId),
  restoreClientConfig: (backupPath, client, profileId) => ipcRenderer.invoke('stone:restore-client-config', backupPath, client, profileId),
  getClientConfigEditor: (client, profileId) => ipcRenderer.invoke('stone:get-client-config-editor', client, profileId),
  saveClientConfigEditor: (input) => ipcRenderer.invoke('stone:save-client-config-editor', input),
  listStateBackups: () => ipcRenderer.invoke('stone:list-state-backups'),
  createStateBackup: () => ipcRenderer.invoke('stone:create-state-backup'),
  verifyStateBackup: (path) => ipcRenderer.invoke('stone:verify-state-backup', path),
  restoreStateBackup: (path) => ipcRenderer.invoke('stone:restore-state-backup', path),
  getDesktopRuntimeSettings: () => ipcRenderer.invoke('stone:get-desktop-runtime-settings'),
  updateDesktopRuntimeSettings: (settings) => ipcRenderer.invoke('stone:update-desktop-runtime-settings', settings),
  exportDiagnostics: () => ipcRenderer.invoke('stone:export-diagnostics'),
  getUpdateState: () => ipcRenderer.invoke('stone:get-update-state'),
  checkForUpdates: () => ipcRenderer.invoke('stone:check-for-updates'),
  ignoreUpdate: (version) => ipcRenderer.invoke('stone:ignore-update', version),
  downloadUpdate: () => ipcRenderer.invoke('stone:download-update'),
  installUpdate: () => ipcRenderer.invoke('stone:install-update'),
  openUpdatePage: () => ipcRenderer.invoke('stone:open-update-page'),
  getFrpTunnelState: () => ipcRenderer.invoke('stone:get-frp-tunnel-state'),
  saveFrpTunnelConfig: (content) => ipcRenderer.invoke('stone:save-frp-tunnel-config', content),
  startFrpTunnel: () => ipcRenderer.invoke('stone:start-frp-tunnel'),
  stopFrpTunnel: () => ipcRenderer.invoke('stone:stop-frp-tunnel'),
  clearFrpTunnelLogs: () => ipcRenderer.invoke('stone:clear-frp-tunnel-logs'),
  inspectCodexSessionRepair: () => ipcRenderer.invoke('stone:inspect-codex-session-repair'),
  previewCodexSessionRepair: (targetProvider) => ipcRenderer.invoke('stone:preview-codex-session-repair', targetProvider),
  repairCodexSessions: (targetProvider, expectedRevision) => ipcRenderer.invoke('stone:repair-codex-sessions', targetProvider, expectedRevision),
  onSnapshot: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: Awaited<ReturnType<GatewayApi['getSnapshot']>>) => {
      listener(snapshot)
    }
    ipcRenderer.on('stone:snapshot', handler)
    return () => ipcRenderer.removeListener('stone:snapshot', handler)
  },
  onAccountImportProgress: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: Parameters<typeof listener>[0]) => {
      listener(progress)
    }
    ipcRenderer.on('stone:account-import-progress', handler)
    return () => ipcRenderer.removeListener('stone:account-import-progress', handler)
  },
  onBrowserImportQueue: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: Awaited<ReturnType<GatewayApi['getBrowserImportQueue']>>) => {
      listener(state)
    }
    ipcRenderer.on('stone:browser-import-queue', handler)
    return () => ipcRenderer.removeListener('stone:browser-import-queue', handler)
  },
  onBrowserOpenTab: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, request: { url?: unknown; guestId?: unknown }) => {
      if (typeof request?.url !== 'string' || typeof request?.guestId !== 'number') return
      try {
        const protocol = new URL(request.url).protocol
        if (protocol !== 'http:' && protocol !== 'https:') return
      } catch {
        return
      }
      listener({ url: request.url, guestId: request.guestId })
    }
    ipcRenderer.on('stone:browser-open-tab', handler)
    return () => ipcRenderer.removeListener('stone:browser-open-tab', handler)
  },
  onUpdateState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: Awaited<ReturnType<GatewayApi['getUpdateState']>>) => {
      listener(state)
    }
    ipcRenderer.on('stone:update-state', handler)
    return () => ipcRenderer.removeListener('stone:update-state', handler)
  }
}

contextBridge.exposeInMainWorld('stone', stone)
