import { contextBridge, ipcRenderer } from 'electron'
import type { AppRuntimeDelta, GatewayApi } from '@shared/types'

const builtInProxyErrorPattern = /\[stone-built-in-proxy-error:([a-z0-9_-]+):(retryable|fatal)\]\s*([\s\S]*)$/i

const invokeBuiltInProxy = async (channel: string, ...args: unknown[]) => {
  try {
    return await ipcRenderer.invoke(channel, ...args)
  } catch (error) {
    const serializedMessage = error instanceof Error ? error.message : String(error)
    const match = serializedMessage.match(builtInProxyErrorPattern)
    if (!match) throw error
    const classified = new Error(match[3] || 'Built-in proxy operation failed.')
    classified.name = 'BuiltInProxyError'
    Object.assign(classified, {
      category: match[1],
      code: match[1],
      retryable: match[2] === 'retryable',
    })
    throw classified
  }
}

const stone: GatewayApi = {
  setUiLanguage: (language) => ipcRenderer.invoke('stone:set-ui-language', language),
  getSnapshot: () => ipcRenderer.invoke('stone:get-snapshot'),
  saveProvider: (input) => ipcRenderer.invoke('stone:save-provider', input),
  refreshProviderModels: (id) => ipcRenderer.invoke('stone:refresh-provider-models', id),
  deleteProvider: (id) => ipcRenderer.invoke('stone:delete-provider', id),
  saveAccount: (input) => ipcRenderer.invoke('stone:save-account', input),
  saveAccountTag: (input) => ipcRenderer.invoke('stone:save-account-tag', input),
  deleteAccountTag: (id) => ipcRenderer.invoke('stone:delete-account-tag', id),
  setAccountTags: (input) => ipcRenderer.invoke('stone:set-account-tags', input),
  refreshAccountModels: (id) => ipcRenderer.invoke('stone:refresh-account-models', id),
  testAccountModel: (accountId, model) => ipcRenderer.invoke('stone:test-account-model', accountId, model),
  importChatGptAccounts: (input) => ipcRenderer.invoke('stone:import-chatgpt-accounts', input),
  importChatGptAccountFiles: (input) => ipcRenderer.invoke('stone:import-chatgpt-account-files', input),
  startChatGptOAuth: (input) => ipcRenderer.invoke('stone:start-chatgpt-oauth', input),
  openChatGptOAuth: (sessionId) => ipcRenderer.invoke('stone:open-chatgpt-oauth', sessionId),
  waitChatGptOAuth: (sessionId) => ipcRenderer.invoke('stone:wait-chatgpt-oauth', sessionId),
  submitChatGptOAuthCallback: (input) => ipcRenderer.invoke('stone:submit-chatgpt-oauth-callback', input),
  cancelChatGptOAuth: (sessionId) => ipcRenderer.invoke('stone:cancel-chatgpt-oauth', sessionId),
  getBrowserImportQueue: () => ipcRenderer.invoke('stone:get-browser-import-queue'),
  removeBrowserImportItem: (id) => ipcRenderer.invoke('stone:remove-browser-import-item', id),
  clearBrowserImportQueue: () => ipcRenderer.invoke('stone:clear-browser-import-queue'),
  getBrowserJsonCache: () => ipcRenderer.invoke('stone:get-browser-json-cache'),
  saveBrowserJsonCacheItem: (id) => ipcRenderer.invoke('stone:save-browser-json-cache-item', id),
  removeBrowserJsonCacheItem: (id) => ipcRenderer.invoke('stone:remove-browser-json-cache-item', id),
  clearBrowserJsonCache: () => ipcRenderer.invoke('stone:clear-browser-json-cache'),
  importBrowserJsonQueue: (input) => ipcRenderer.invoke('stone:import-browser-json-queue', input),
  exportChatGptAccounts: (input) => ipcRenderer.invoke('stone:export-chatgpt-accounts', input),
  deleteAccount: (id) => ipcRenderer.invoke('stone:delete-account', id),
  deleteAccounts: (ids) => ipcRenderer.invoke('stone:delete-accounts', ids),
  saveProxy: (input) => ipcRenderer.invoke('stone:save-proxy', input),
  deleteProxy: (id) => ipcRenderer.invoke('stone:delete-proxy', id),
  checkProxy: (id) => ipcRenderer.invoke('stone:check-proxy', id),
  getBuiltInProxyState: () => invokeBuiltInProxy('stone:get-built-in-proxy-state'),
  setBuiltInProxyEnabled: (enabled) => invokeBuiltInProxy('stone:set-built-in-proxy-enabled', enabled),
  retryBuiltInProxy: () => invokeBuiltInProxy('stone:retry-built-in-proxy'),
  importBuiltInProxyProfile: (input) => invokeBuiltInProxy('stone:import-built-in-proxy-profile', input),
  refreshBuiltInProxyProfile: (id) => invokeBuiltInProxy('stone:refresh-built-in-proxy-profile', id),
  deleteBuiltInProxyProfile: (id) => invokeBuiltInProxy('stone:delete-built-in-proxy-profile', id),
  selectBuiltInProxyProfile: (id) => invokeBuiltInProxy('stone:select-built-in-proxy-profile', id),
  selectBuiltInProxyNode: (profileId, nodeId) => invokeBuiltInProxy('stone:select-built-in-proxy-node', profileId, nodeId),
  setBuiltInProxyRuleMode: (mode) => invokeBuiltInProxy('stone:set-built-in-proxy-rule-mode', mode),
  setBuiltInProxyAccessMode: (mode) => invokeBuiltInProxy('stone:set-built-in-proxy-access-mode', mode),
  setBuiltInProxyLanEnabled: (enabled) => invokeBuiltInProxy('stone:set-built-in-proxy-lan-enabled', enabled),
  setBuiltInProxyAutoStart: (enabled) => invokeBuiltInProxy('stone:set-built-in-proxy-auto-start', enabled),
  testBuiltInProxyLatency: (profileId, nodeIds) => invokeBuiltInProxy('stone:test-built-in-proxy-latency', profileId, nodeIds),
  getBuiltInProxyTraffic: () => invokeBuiltInProxy('stone:get-built-in-proxy-traffic'),
  listBuiltInProxyConnections: () => invokeBuiltInProxy('stone:list-built-in-proxy-connections'),
  closeBuiltInProxyConnection: (id) => invokeBuiltInProxy('stone:close-built-in-proxy-connection', id),
  savePool: (input) => ipcRenderer.invoke('stone:save-pool', input),
  deletePool: (id) => ipcRenderer.invoke('stone:delete-pool', id),
  setRouteSourceFastMode: (input) => ipcRenderer.invoke('stone:set-route-source-fast-mode', input),
  saveApiSource: (input) => ipcRenderer.invoke('stone:save-api-source', input),
  probeApiSource: (input) => ipcRenderer.invoke('stone:probe-api-source', input),
  previewRoute: (input) => ipcRenderer.invoke('stone:preview-route', input),
  deleteApiSource: (id) => ipcRenderer.invoke('stone:delete-api-source', id),
  saveAggregateRelay: (input) => ipcRenderer.invoke('stone:save-aggregate-relay', input),
  getSetupWizardState: () => ipcRenderer.invoke('stone:get-setup-wizard-state'),
  saveSetupWizardProgress: (input) => ipcRenderer.invoke('stone:save-setup-wizard-progress', input),
  discardSetupWizard: () => ipcRenderer.invoke('stone:discard-setup-wizard'),
  completeSetupWizard: (sessionId) => ipcRenderer.invoke('stone:complete-setup-wizard', sessionId),
  applySetupRouting: (input) => ipcRenderer.invoke('stone:apply-setup-routing', input),
  ensureGatewayRunning: (input) => ipcRenderer.invoke('stone:ensure-gateway-running', input),
  verifySetupRoute: (input) => ipcRenderer.invoke('stone:verify-setup-route', input),
  setClientRouteSource: (input) => ipcRenderer.invoke('stone:set-client-route-source', input),
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
  getAccountCodexQuotaCycleCosts: (id) => ipcRenderer.invoke('stone:get-account-codex-quota-cycle-costs', id),
  clearLogs: () => ipcRenderer.invoke('stone:clear-logs'),
  getRequestReplayTemplate: (id) => ipcRenderer.invoke('stone:get-request-replay-template', id),
  replayRequest: (id) => ipcRenderer.invoke('stone:replay-request', id),
  getLocalEventServerStatus: () => ipcRenderer.invoke('stone:get-local-event-server-status'),
  clearHealthEvents: () => ipcRenderer.invoke('stone:clear-health-events'),
  saveClientProfile: (input) => ipcRenderer.invoke('stone:save-client-profile', input),
  deleteClientProfile: (id) => ipcRenderer.invoke('stone:delete-client-profile', id),
  exportClientProfile: (id) => ipcRenderer.invoke('stone:export-client-profile', id),
  importClientProfile: (bundle) => ipcRenderer.invoke('stone:import-client-profile', bundle),
  chooseClientConfigDirectory: (client, currentDirectory) => ipcRenderer.invoke('stone:choose-client-config-directory', client, currentDirectory),
  getClientConfigs: (profileId) => ipcRenderer.invoke('stone:get-client-configs', profileId),
  previewClientConfig: (client, profileId) => ipcRenderer.invoke('stone:preview-client-config', client, profileId),
  applyClientConfig: (client, profileId) => ipcRenderer.invoke('stone:apply-client-config', client, profileId),
  repairClientConfig: (client, profileId) => ipcRenderer.invoke('stone:repair-client-config', client, profileId),
  restoreCodexOfficialLoginAndSessions: (profileId) => ipcRenderer.invoke('stone:restore-codex-official-login-and-sessions', profileId),
  listClientConfigBackups: (client, profileId) => ipcRenderer.invoke('stone:list-client-config-backups', client, profileId),
  createClientConfigBackup: (client, profileId) => ipcRenderer.invoke('stone:create-client-config-backup', client, profileId),
  restoreLatestClientConfigBackup: (client, profileId) => ipcRenderer.invoke('stone:restore-latest-client-config-backup', client, profileId),
  restoreClientConfigBackupSet: (groupId, client, profileId) => ipcRenderer.invoke('stone:restore-client-config-backup-set', groupId, client, profileId),
  restoreClientConfig: (backupPath, client, profileId) => ipcRenderer.invoke('stone:restore-client-config', backupPath, client, profileId),
  getClientConfigEditor: (client, profileId) => ipcRenderer.invoke('stone:get-client-config-editor', client, profileId),
  saveClientConfigEditor: (input) => ipcRenderer.invoke('stone:save-client-config-editor', input),
  listManagedClientInstances: () => ipcRenderer.invoke('stone:list-managed-client-instances'),
  saveManagedClientInstance: (input) => ipcRenderer.invoke('stone:save-managed-client-instance', input),
  deleteManagedClientInstance: (id) => ipcRenderer.invoke('stone:delete-managed-client-instance', id),
  startManagedClientInstance: (id) => ipcRenderer.invoke('stone:start-managed-client-instance', id),
  stopManagedClientInstance: (id) => ipcRenderer.invoke('stone:stop-managed-client-instance', id),
  listPersistentTasks: () => ipcRenderer.invoke('stone:list-persistent-tasks'),
  pausePersistentTask: (id) => ipcRenderer.invoke('stone:pause-persistent-task', id),
  resumePersistentTask: (id) => ipcRenderer.invoke('stone:resume-persistent-task', id),
  waitForPersistentTask: (id) => ipcRenderer.invoke('stone:wait-for-persistent-task', id),
  cancelPersistentTask: (id) => ipcRenderer.invoke('stone:cancel-persistent-task', id),
  clearPersistentTasks: () => ipcRenderer.invoke('stone:clear-persistent-tasks'),
  startAccountCheckTask: (accountIds) => ipcRenderer.invoke('stone:start-account-check-task', accountIds),
  listStateBackups: () => ipcRenderer.invoke('stone:list-state-backups'),
  createStateBackup: () => ipcRenderer.invoke('stone:create-state-backup'),
  verifyStateBackup: (path) => ipcRenderer.invoke('stone:verify-state-backup', path),
  restoreStateBackup: (path) => ipcRenderer.invoke('stone:restore-state-backup', path),
  exportPortableStateBackup: (password) => ipcRenderer.invoke('stone:export-portable-state-backup', password),
  importPortableStateBackup: (password) => ipcRenderer.invoke('stone:import-portable-state-backup', password),
  getWebDavBackupConfiguration: () => ipcRenderer.invoke('stone:get-webdav-backup-configuration'),
  saveWebDavBackupConfiguration: (input) => ipcRenderer.invoke('stone:save-webdav-backup-configuration', input),
  clearWebDavBackupConfiguration: () => ipcRenderer.invoke('stone:clear-webdav-backup-configuration'),
  testWebDavBackup: () => ipcRenderer.invoke('stone:test-webdav-backup'),
  listWebDavBackups: () => ipcRenderer.invoke('stone:list-webdav-backups'),
  uploadLatestWebDavBackup: (password) => ipcRenderer.invoke('stone:upload-latest-webdav-backup', password),
  downloadWebDavBackup: (name, password) => ipcRenderer.invoke('stone:download-webdav-backup', name, password),
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
  repairCodexSessionsAndRestartChatGpt: (targetProvider, expectedRevision) => ipcRenderer.invoke('stone:repair-codex-sessions-and-restart-chatgpt', targetProvider, expectedRevision),
  previewCodexSessionIndexCleanup: () => ipcRenderer.invoke('stone:preview-codex-session-index-cleanup'),
  cleanupCodexSessionIndexAndRestart: (snapshotSha256, threadIds) => ipcRenderer.invoke('stone:cleanup-codex-session-index-and-restart', snapshotSha256, threadIds),
  listCodexSessions: (query) => ipcRenderer.invoke('stone:list-codex-sessions', query),
  openCodexSessionLocation: (id, expectedRevision) => ipcRenderer.invoke('stone:open-codex-session-location', id, expectedRevision),
  exportCodexSession: (id, expectedRevision) => ipcRenderer.invoke('stone:export-codex-session', id, expectedRevision),
  trashCodexSession: (id, expectedRevision) => ipcRenderer.invoke('stone:trash-codex-session', id, expectedRevision),
  restoreCodexSession: (id, expectedRevision) => ipcRenderer.invoke('stone:restore-codex-session', id, expectedRevision),
  onSnapshot: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: Awaited<ReturnType<GatewayApi['getSnapshot']>>) => {
      listener(snapshot)
    }
    ipcRenderer.on('stone:snapshot', handler)
    return () => ipcRenderer.removeListener('stone:snapshot', handler)
  },
  onBuiltInProxyState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: Awaited<ReturnType<GatewayApi['getBuiltInProxyState']>>) => {
      listener(state)
    }
    ipcRenderer.on('stone:built-in-proxy-state', handler)
    return () => ipcRenderer.removeListener('stone:built-in-proxy-state', handler)
  },
  onRuntimeDelta: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, delta: AppRuntimeDelta) => {
      listener(delta)
    }
    ipcRenderer.on('stone:runtime-delta', handler)
    return () => ipcRenderer.removeListener('stone:runtime-delta', handler)
  },
  onManagedClientInstancesChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, instances: Awaited<ReturnType<GatewayApi['listManagedClientInstances']>>) => {
      listener(instances)
    }
    ipcRenderer.on('stone:managed-client-instances', handler)
    return () => ipcRenderer.removeListener('stone:managed-client-instances', handler)
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
contextBridge.exposeInMainWorld('stonePlatform', process.platform)
