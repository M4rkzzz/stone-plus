import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  LoaderCircle,
  Network,
  Save,
  Timer,
  Archive,
  RotateCcw,
  FileDown,
  BellRing,
  Download,
  ExternalLink,
  RefreshCw,
  Rocket,
  Sparkles,
  Languages,
  LockKeyhole,
  Upload,
  Radio,
  Cloud,
  Trash2,
} from 'lucide-react'
import type {
  AppSnapshot,
  BackupRecordSummary,
  GatewayApi,
  GatewaySettings,
  LocalEventServerStatus,
  SystemProxyDetectionResult,
  WebDavBackupConfiguration,
  WebDavBackupEntry,
} from '@shared/types'
import type { ActionRunner } from '../App'
import { redactSensitiveText } from '../async-operation'
import { localizeBackendError, localizeBackendMessage } from '../backend-message'
import { Badge, FieldError, gatewayBaseUrl, InfoTip, PageHeader, Toggle } from '../ui'
import { StoneMark } from '../StoneMark'
import { UpdateProgress, statusLabel, statusTone, type AppUpdateController } from '../UpdateDialog'
import { translate, useI18n, type UiLanguage } from '../i18n'
import {
  LatestAutosaveScheduler,
  SETTINGS_AUTOSAVE_DELAY_MS,
  validateGatewayDraft,
} from '../settings-autosave'
import { BUILT_IN_PROXY_TAKEOVER_NOTICE, useBuiltInProxyInterlock } from '../built-in-proxy-interlocks'

type GatewaySaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'invalid' | 'error'

interface PendingGatewaySave {
  settings: GatewaySettings
  language: UiLanguage
}

interface GatewaySaveResult {
  snapshot: AppSnapshot
  runtimeError?: string
}

function SettingRow({ title, description, control }: { title: string; description?: string; control: React.ReactNode }) {
  return <div className="setting-row"><div><strong>{title}{description && <InfoTip text={description} />}</strong></div>{control}</div>
}

// Exported for the renderer contract test; the function itself is side-effect free.
// eslint-disable-next-line react-refresh/only-export-components
export function systemProxyTargetPresentation(
  target: string,
  language: UiLanguage,
): { label: string; endpoint: string } {
  try {
    const url = new URL(target)
    const path = url.pathname === '/' ? '' : url.pathname
    const endpoint = `${url.host}${path}`
    const label = (() => {
      if (url.hostname === 'chatgpt.com') {
        if (url.pathname === '/backend-api/codex/responses') {
          return translate(language, 'Codex 对话接口', 'Codex responses')
        }
        if (url.pathname === '/backend-api/codex/models') {
          return translate(language, 'Codex 模型接口', 'Codex models')
        }
        if (url.pathname === '/backend-api/wham/usage') {
          return translate(language, 'Codex 额度接口', 'Codex quota')
        }
        return translate(language, 'ChatGPT 网站', 'ChatGPT website')
      }
      if (url.hostname === 'auth.openai.com') return 'OpenAI OAuth'
      if (url.hostname === 'api.openai.com') return 'OpenAI API'
      return url.hostname
    })()
    return { label, endpoint: endpoint || url.hostname }
  } catch {
    return {
      label: translate(language, '上游目标', 'Upstream target'),
      endpoint: target,
    }
  }
}

// Exported for the renderer contract test; the function itself is side-effect free.
// eslint-disable-next-line react-refresh/only-export-components
export function systemProxyErrorMessage(error: string | undefined, language: UiLanguage): string {
  if (!error?.trim()) return ''
  const value = error.trim()
  const normalized = value.toUpperCase()
  const message = (chinese: string, english: string): string => translate(language, chinese, english)

  if (/PROXY_AUTH_REQUIRED|HTTP\s*407|REQUIRES? AUTHENTICATION/i.test(value)) {
    return message(
      '系统代理需要认证，请在代理软件或 Windows 代理设置中更新用户名和密码。',
      'The system proxy requires authentication. Update its username and password in the proxy app or Windows proxy settings.',
    )
  }
  if (/TIMEOUT|ETIMEDOUT|TIMED OUT/i.test(value)) {
    return message(
      '连接系统代理超时，请检查代理节点是否可用及分流规则是否命中。',
      'The system proxy connection timed out. Check that the proxy node is available and the routing rule matches.',
    )
  }
  if (/ENOTFOUND|EAI_AGAIN|DNS RESOLUTION|\bDNS\b/i.test(value)) {
    return message(
      '域名解析失败，请检查系统代理的 DNS 或远程解析设置。',
      'DNS resolution failed. Check the system proxy DNS or remote-resolution settings.',
    )
  }
  if (/CERT|TLS|SSL|SELF_SIGNED/i.test(value)) {
    return message(
      'TLS/证书校验失败，请检查代理的 HTTPS 解密和系统证书。',
      'TLS/certificate validation failed. Check HTTPS inspection and the system certificate store.',
    )
  }
  if (/ECONNREFUSED|CONNECTION WAS REFUSED/i.test(value)) {
    return message(
      '连接被拒绝，请确认代理软件正在运行且系统代理端口有效。',
      'The connection was refused. Confirm that the proxy app is running and the Windows proxy port is valid.',
    )
  }
  if (/ECONNRESET|EPIPE|UND_ERR_SOCKET|CONNECTION WAS RESET/i.test(value)) {
    return message(
      '连接被中途重置，请更换代理节点或检查 TLS 分流规则。',
      'The connection was reset. Change the proxy node or check TLS routing rules.',
    )
  }
  if (/REQUEST WAS ABORTED|ABORTED/i.test(value)) {
    return message(
      '连接检测已取消，请重新开启系统代理后重试。',
      'The connection test was cancelled. Re-enable the system proxy and try again.',
    )
  }
  if (/ROUTE RESOLUTION FAILED|ROUTE DETAILS ARE UNAVAILABLE|SYSTEM PROXY (?:RESOLUTION FAILED|RESOLVER IS UNAVAILABLE|RETURNED NO USABLE ROUTE)/i.test(value)) {
    return message(
      '未能读取代理路由详情，但已使用当前 Windows 系统代理完成连接。',
      'Proxy route details are unavailable, but the connection used the current Windows system proxy.',
    )
  }
  if (/CONNECTION FAILED|ERR_[A-Z0-9_]+|UND_ERR_[A-Z0-9_]+/.test(normalized)) {
    return message(
      '无法通过系统代理连接该目标，请检查代理软件、节点和分流规则。',
      'Could not reach this target through the system proxy. Check the proxy app, node, and routing rules.',
    )
  }

  const fallback = message('目标连接失败。', 'Target connection failed.')
  if (language === 'zh-CN' && !/[\u3400-\u9fff]/u.test(value)) return fallback
  return localizeBackendMessage(value, language, fallback)
}

export function SettingsView({
  snapshot,
  api,
  runAction,
  busyKeys,
  update,
}: {
  snapshot: AppSnapshot
  api: GatewayApi
  runAction: ActionRunner
  busyKeys: Set<string>
  update: AppUpdateController
}) {
  const { t, language, locale, preference, setPreference } = useI18n()
  const builtInProxyInterlocked = useBuiltInProxyInterlock(snapshot, api)
  const [draft, setDraft] = useState<GatewaySettings>(snapshot.gateway)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saveState, setSaveState] = useState<GatewaySaveState>('idle')
  const [saveError, setSaveError] = useState('')
  const [backups, setBackups] = useState<BackupRecordSummary[]>([])
  const [operationNotice, setOperationNotice] = useState('')
  const [connectionNotice, setConnectionNotice] = useState('')
  const [systemProxyStatus, setSystemProxyStatus] = useState<SystemProxyDetectionResult>()
  const [portablePassword, setPortablePassword] = useState('')
  const [portableBusy, setPortableBusy] = useState('')
  const [webDavConfiguration, setWebDavConfiguration] = useState<WebDavBackupConfiguration>({ baseUrl: '', username: '', hasPassword: false, configured: false })
  const [webDavDraft, setWebDavDraft] = useState({ baseUrl: '', username: '', password: '' })
  const [webDavEntries, setWebDavEntries] = useState<WebDavBackupEntry[]>([])
  const [webDavBusy, setWebDavBusy] = useState('')
  const [localEvents, setLocalEvents] = useState<LocalEventServerStatus>()
  const latestDraftRef = useRef(draft)
  const dirtyRef = useRef(false)
  const persistedGatewayRef = useRef(snapshot.gateway)
  const pendingLaunchAtLoginRef = useRef<boolean | undefined>(undefined)
  const mountedRef = useRef(false)
  const systemProxyDetectionGenerationRef = useRef(0)
  const apiRef = useRef(api)
  const runActionRef = useRef(runAction)
  const languageRef = useRef(language)
  const portablePasswordRef = useRef(portablePassword)
  const webDavPasswordRef = useRef(webDavDraft.password)
  const portableBusyRef = useRef('')
  const webDavBusyRef = useRef('')
  apiRef.current = api
  runActionRef.current = runAction
  languageRef.current = language
  portablePasswordRef.current = portablePassword
  webDavPasswordRef.current = webDavDraft.password

  const autosaveRef = useRef<LatestAutosaveScheduler<PendingGatewaySave, GatewaySaveResult> | null>(null)
  if (!autosaveRef.current) {
    autosaveRef.current = new LatestAutosaveScheduler({
      onStart: () => {
        if (mountedRef.current) setSaveState('saving')
      },
      persist: async ({ settings, language: saveLanguage }) => {
        const previousGateway = persistedGatewayRef.current
        let savedSnapshot: AppSnapshot | undefined
        const success = await runActionRef.current('save-settings', async () => {
          savedSnapshot = await apiRef.current.updateGateway(settings)
          return savedSnapshot
        })
        if (!success || !savedSnapshot) throw new Error('Gateway settings could not be saved.')

        const authoritativeGateway = savedSnapshot.gateway
        persistedGatewayRef.current = authoritativeGateway
        let runtimeError: string | undefined
        const launchAtLogin = Boolean(authoritativeGateway.launchAtLogin)
        if (pendingLaunchAtLoginRef.current !== undefined
          || Boolean(previousGateway.launchAtLogin) !== launchAtLogin) {
          try {
            await apiRef.current.updateDesktopRuntimeSettings({
              launchAtLogin,
            })
            pendingLaunchAtLoginRef.current = undefined
          } catch (cause) {
            pendingLaunchAtLoginRef.current = launchAtLogin
            runtimeError = localizeBackendError(
              cause,
              saveLanguage,
              translate(saveLanguage, '登录启动设置应用失败', 'Failed to apply the login startup setting'),
            )
          }
        }
        return { snapshot: savedSnapshot, ...(runtimeError ? { runtimeError } : {}) }
      },
      onSuccess: ({ snapshot: savedSnapshot, runtimeError }) => {
        dirtyRef.current = false
        const authoritativeGateway = savedSnapshot.gateway
        latestDraftRef.current = authoritativeGateway
        if (!mountedRef.current) return
        setDraft(authoritativeGateway)
        setErrors({})
        setSaveError(runtimeError ?? '')
        setSaveState(runtimeError ? 'error' : 'saved')
      },
      onError: () => {
        if (!mountedRef.current) return
        setSaveError(translate(languageRef.current, '设置未保存，请点击重试', 'Settings were not saved. Click to retry.'))
        setSaveState('error')
      },
    })
  }

  useEffect(() => {
    persistedGatewayRef.current = snapshot.gateway
    if (dirtyRef.current) return
    latestDraftRef.current = snapshot.gateway
    setDraft(snapshot.gateway)
  }, [snapshot.gateway])
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      portablePasswordRef.current = ''
      webDavPasswordRef.current = ''
      portableBusyRef.current = ''
      webDavBusyRef.current = ''
      void autosaveRef.current?.flush()
    }
  }, [])
  useEffect(() => {
    void api.listStateBackups().then(setBackups).catch((cause: unknown) => {
      setOperationNotice(localizeBackendError(
        cause,
        language,
        translate(language, '无法读取本地备份列表。', 'Unable to read local backups.'),
      ))
    })
  }, [api, language])
  useEffect(() => {
    void api.getAutomaticBackupRuntimeState().then((state) => {
      if (!state.blocked) return
      setOperationNotice(localizeBackendMessage(
        state.message ?? '',
        language,
        translate(
          language,
          '自动备份已安全阻断；请保存或清除 WebDAV 配置后重试。',
          'Automatic backups are safely blocked. Save or clear the WebDAV configuration, then retry.',
        ),
      ))
    }).catch((cause: unknown) => {
      setOperationNotice(localizeBackendError(
        cause,
        language,
        translate(language, '无法确认自动备份运行状态。', 'Unable to confirm automatic backup status.'),
      ))
    })
  }, [api, language])
  useEffect(() => {
    void api.getWebDavBackupConfiguration().then((configuration) => {
      setWebDavConfiguration(configuration)
      webDavPasswordRef.current = ''
      setWebDavDraft({ baseUrl: configuration.baseUrl, username: configuration.username, password: '' })
      if (configuration.configured) void api.listWebDavBackups().then(setWebDavEntries).catch(() => undefined)
    }).catch((cause: unknown) => {
      setOperationNotice(localizeBackendError(
        cause,
        language,
        translate(language, 'WebDAV 配置需要修复后才能继续备份。', 'Repair the WebDAV configuration before continuing backups.'),
      ))
    })
  }, [api, language])
  useEffect(() => { void api.getLocalEventServerStatus().then(setLocalEvents).catch(() => undefined) }, [api])
  useEffect(() => {
    setErrors(dirtyRef.current ? validateGatewayDraft(latestDraftRef.current, language) : {})
    setOperationNotice('')
    setConnectionNotice('')
  }, [language])
  useEffect(() => {
    if (!builtInProxyInterlocked) return
    systemProxyDetectionGenerationRef.current += 1
    setSystemProxyStatus(undefined)
    setConnectionNotice('')
  }, [builtInProxyInterlocked])

  const updateDraft = useCallback((patch: Partial<GatewaySettings>, immediate = false) => {
    const next = { ...latestDraftRef.current, ...patch }
    latestDraftRef.current = next
    dirtyRef.current = true
    setSaveError('')
    setDraft(next)
    const nextErrors = validateGatewayDraft(next, languageRef.current)
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) {
      autosaveRef.current?.invalidate()
      setSaveState('invalid')
      return
    }
    setSaveState('pending')
    autosaveRef.current?.schedule(
      { settings: { ...next, host: next.host.trim() }, language: languageRef.current },
      immediate ? 0 : SETTINGS_AUTOSAVE_DELAY_MS,
    )
  }, [])

  const retryAutosave = useCallback(() => {
    const current = latestDraftRef.current
    const nextErrors = validateGatewayDraft(current, languageRef.current)
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length) {
      autosaveRef.current?.invalidate()
      setSaveState('invalid')
      return
    }
    dirtyRef.current = true
    setSaveError('')
    setSaveState('pending')
    autosaveRef.current?.schedule(
      { settings: { ...current, host: current.host.trim() }, language: languageRef.current },
      0,
    )
  }, [])

  const addressChanged = draft.host !== snapshot.gateway.host || draft.port !== snapshot.gateway.port
  const currentEndpoint = gatewayBaseUrl(snapshot.gatewayStatus.host, snapshot.gatewayStatus.port)
  const appUpdate = update.state
  const updateBusy = update.action !== null || appUpdate?.status === 'checking' || appUpdate?.status === 'installing'
  const ignoredRelease = Boolean(appUpdate?.release && appUpdate.ignoredVersion === appUpdate.release.version)
  const effectiveSaveState = busyKeys.has('save-settings') ? 'saving' : saveState
  const autoSaveLabel = effectiveSaveState === 'saving'
    ? t('正在保存', 'Saving')
    : effectiveSaveState === 'pending'
      ? t('即将自动保存', 'Saving shortly')
      : effectiveSaveState === 'invalid'
        ? t('等待有效输入', 'Waiting for valid input')
        : effectiveSaveState === 'error'
          ? t('自动保存失败，点击重试', 'Autosave failed — click to retry')
          : effectiveSaveState === 'saved'
            ? t('已自动保存', 'Autosaved')
            : t('更改自动保存', 'Changes autosave')

  const clearPortablePassword = () => {
    portablePasswordRef.current = ''
    setPortablePassword('')
  }

  const beginPortableOperation = (key: string): boolean => {
    if (portableBusyRef.current) return false
    portableBusyRef.current = key
    setPortableBusy(key)
    return true
  }

  const finishPortableOperation = (key: string) => {
    if (portableBusyRef.current !== key) return
    portableBusyRef.current = ''
    setPortableBusy('')
  }

  const beginWebDavOperation = (key: string): boolean => {
    if (webDavBusyRef.current) return false
    webDavBusyRef.current = key
    setWebDavBusy(key)
    return true
  }

  const finishWebDavOperation = (key: string) => {
    if (webDavBusyRef.current !== key) return
    webDavBusyRef.current = ''
    setWebDavBusy('')
  }

  const beginPortableWebDavOperation = (key: string): boolean => {
    if (portableBusyRef.current || webDavBusyRef.current) return false
    portableBusyRef.current = key
    webDavBusyRef.current = key
    setPortableBusy(key)
    setWebDavBusy(key)
    return true
  }

  const sensitiveOperationError = (cause: unknown, fallback: string, secrets: readonly string[]) => redactSensitiveText(
    localizeBackendError(cause, language, fallback),
    secrets,
  )

  const createBackup = async () => {
    const result = await api.createStateBackup()
    setBackups(await api.listStateBackups())
    setOperationNotice(result.backup ? t(`备份已创建：${result.backup.path}`, `Backup created: ${result.backup.path}`) : t('备份已创建', 'Backup created'))
  }

  const restoreBackup = async (backup: BackupRecordSummary) => {
    if (!window.confirm(t('恢复会替换当前本地数据并需要重启 Stone+，是否继续？', 'Restoring will replace the current local data and requires restarting Stone+. Continue?'))) return
    try {
      const result = await api.restoreStateBackup(backup.path)
      const runtime = await api.getAutomaticBackupRuntimeState()
      setOperationNotice(runtime.blocked
        ? localizeBackendMessage(
            runtime.message ?? '',
            language,
            t('数据已恢复，但自动备份仍处于安全阻断状态。', 'Data was restored, but automatic backups remain safely blocked.'),
          )
        : result.restartRequired
          ? t('数据已恢复，请退出并重新启动 Stone+。', 'Data restored. Quit and restart Stone+.')
          : t('数据已恢复。', 'Data restored.'))
    } catch (cause) {
      const runtime = await api.getAutomaticBackupRuntimeState().catch(() => undefined)
      setOperationNotice(localizeBackendError(
        cause,
        language,
        runtime?.blocked
          ? t('恢复后的安全清理尚未完成，自动备份保持阻断；请修复 WebDAV 配置后重试。', 'Post-restore safety cleanup is incomplete and automatic backups remain blocked. Repair WebDAV and retry.')
          : t('恢复失败；如果提示数据已恢复，请重启 Stone+ 后核对状态。', 'Restore failed. If the message says data was restored, restart Stone+ and verify its state.'),
      ))
    }
  }

  const exportPortableBackup = async () => {
    const password = portablePasswordRef.current
    if (password.length < 8) {
      setOperationNotice(t('迁移备份密码至少需要 8 个字符。', 'Portable backup passwords require at least 8 characters.'))
      return
    }
    if (!beginPortableOperation('export')) return
    try {
      const result = await api.exportPortableStateBackup(password)
      if (!result.cancelled) setOperationNotice(t(`加密迁移备份已导出：${result.path ?? ''}`, `Encrypted portable backup exported: ${result.path ?? ''}`))
      clearPortablePassword()
    } catch (cause) {
      setOperationNotice(sensitiveOperationError(cause, t('迁移备份导出失败', 'Failed to export portable backup'), [password]))
    } finally { finishPortableOperation('export') }
  }

  const importPortableBackup = async () => {
    const password = portablePasswordRef.current
    if (password.length < 8) {
      setOperationNotice(t('请输入备份文件使用的密码。', 'Enter the password used by the backup file.'))
      return
    }
    if (!beginPortableOperation('import')) return
    try {
      const result = await api.importPortableStateBackup(password)
      clearPortablePassword()
      if (result.cancelled) {
        return
      }
      try {
        setBackups(await api.listStateBackups())
        setOperationNotice(t('加密迁移备份已导入，请在下方备份列表中确认并恢复。', 'Encrypted portable backup imported. Review and restore it from the backup list below.'))
      } catch {
        setOperationNotice(t('加密迁移备份已导入，但备份列表刷新失败；重新打开设置页即可刷新。', 'The encrypted portable backup was imported, but the backup list could not be refreshed. Reopen Settings to refresh it.'))
      }
    } catch (cause) {
      setOperationNotice(sensitiveOperationError(cause, t('迁移备份导入失败', 'Failed to import portable backup'), [password]))
    } finally { finishPortableOperation('import') }
  }

  const saveWebDav = async () => {
    const password = webDavPasswordRef.current
    if (!beginWebDavOperation('save')) return
    try {
      const configuration = await api.saveWebDavBackupConfiguration({
        baseUrl: webDavDraft.baseUrl.trim(),
        username: webDavDraft.username.trim() || undefined,
        password: password || undefined,
      })
      setWebDavConfiguration(configuration)
      setWebDavDraft((current) => ({ ...current, baseUrl: configuration.baseUrl, username: configuration.username, password: '' }))
      webDavPasswordRef.current = ''
      try {
        const runtime = await api.getAutomaticBackupRuntimeState()
        setBackups(await api.listStateBackups())
        setOperationNotice(runtime.blocked
          ? localizeBackendMessage(
              runtime.message ?? '',
              language,
              t('WebDAV 配置已保存，但自动备份仍处于安全阻断状态。', 'WebDAV was saved, but automatic backups remain safely blocked.'),
            )
          : t('WebDAV 配置已安全保存。', 'WebDAV configuration saved securely.'))
      } catch (cause) {
        setOperationNotice(localizeBackendError(
          cause,
          language,
          t('WebDAV 配置已保存，但备份状态刷新失败。', 'WebDAV was saved, but the backup status could not be refreshed.'),
        ))
      }
    } catch (cause) {
      setOperationNotice(sensitiveOperationError(cause, t('WebDAV 配置保存失败', 'Failed to save WebDAV configuration'), [password]))
    } finally { finishWebDavOperation('save') }
  }

  const testWebDav = async () => {
    if (!beginWebDavOperation('test')) return
    try {
      await api.testWebDavBackup()
      setOperationNotice(t('WebDAV 连接测试通过。', 'WebDAV connection test passed.'))
    } catch (cause) {
      setOperationNotice(localizeBackendError(cause, language, t('WebDAV 连接测试失败', 'WebDAV connection test failed')))
    } finally { finishWebDavOperation('test') }
  }

  const refreshWebDav = async () => {
    if (!beginWebDavOperation('list')) return
    try { setWebDavEntries(await api.listWebDavBackups()) }
    catch (cause) { setOperationNotice(localizeBackendError(cause, language, t('无法读取远端备份', 'Unable to list remote backups'))) }
    finally { finishWebDavOperation('list') }
  }

  const uploadWebDav = async () => {
    const password = portablePasswordRef.current
    if (password.length < 8) return setOperationNotice(t('请先输入至少 8 个字符的迁移备份密码。', 'Enter a portable backup password with at least 8 characters.'))
    if (!beginPortableWebDavOperation('upload')) return
    try {
      const result = await api.uploadLatestWebDavBackup(password)
      clearPortablePassword()
      const [localBackups, remoteBackups] = await Promise.allSettled([
        api.listStateBackups(),
        api.listWebDavBackups(),
      ])
      if (localBackups.status === 'fulfilled') setBackups(localBackups.value)
      if (remoteBackups.status === 'fulfilled') setWebDavEntries(remoteBackups.value)
      const refreshFailed = localBackups.status === 'rejected' || remoteBackups.status === 'rejected'
      setOperationNotice(refreshFailed
        ? t(`加密备份已上传：${result.entry.name}；列表刷新失败。`, `Encrypted backup uploaded: ${result.entry.name}; the backup list could not be refreshed.`)
        : t(`加密备份已上传：${result.entry.name}`, `Encrypted backup uploaded: ${result.entry.name}`))
    } catch (cause) {
      setOperationNotice(sensitiveOperationError(cause, t('WebDAV 上传失败；本地备份不受影响', 'WebDAV upload failed; the local backup is unaffected'), [password]))
    } finally { finishWebDavOperation('upload'); finishPortableOperation('upload') }
  }

  const downloadWebDav = async (entry: WebDavBackupEntry) => {
    const password = portablePasswordRef.current
    if (password.length < 8) return setOperationNotice(t('请先输入至少 8 个字符的迁移备份密码。', 'Enter a portable backup password with at least 8 characters.'))
    const key = `download:${entry.name}`
    if (!beginPortableWebDavOperation(key)) return
    try {
      await api.downloadWebDavBackup(entry.name, password)
      clearPortablePassword()
      try {
        setBackups(await api.listStateBackups())
        setOperationNotice(t(`远端备份已下载并导入：${entry.name}`, `Remote backup downloaded and imported: ${entry.name}`))
      } catch {
        setOperationNotice(t(`远端备份已下载并导入：${entry.name}；列表刷新失败。`, `Remote backup downloaded and imported: ${entry.name}; the backup list could not be refreshed.`))
      }
    } catch (cause) {
      setOperationNotice(sensitiveOperationError(cause, t('远端备份下载或导入失败', 'Failed to download or import the remote backup'), [password]))
    } finally { finishWebDavOperation(key); finishPortableOperation(key) }
  }

  const clearWebDav = async () => {
    if (!beginWebDavOperation('clear')) return
    try {
      const configuration = await api.clearWebDavBackupConfiguration()
      setWebDavConfiguration(configuration)
      webDavPasswordRef.current = ''
      setWebDavDraft({ baseUrl: '', username: '', password: '' })
      setWebDavEntries([])
      try {
        const runtime = await api.getAutomaticBackupRuntimeState()
        setBackups(await api.listStateBackups())
        setOperationNotice(runtime.blocked
          ? localizeBackendMessage(
              runtime.message ?? '',
              language,
              t('WebDAV 配置已清除，但自动备份仍处于安全阻断状态。', 'WebDAV was cleared, but automatic backups remain safely blocked.'),
            )
          : t('WebDAV 配置已清除。', 'WebDAV configuration cleared.'))
      } catch (cause) {
        setOperationNotice(localizeBackendError(
          cause,
          language,
          t('WebDAV 配置已清除，但备份状态刷新失败。', 'WebDAV was cleared, but the backup status could not be refreshed.'),
        ))
      }
    } finally { finishWebDavOperation('clear') }
  }

  const exportDiagnostics = async () => {
    const report = await api.exportDiagnostics()
    await navigator.clipboard?.writeText(report)
    setOperationNotice(t('脱敏诊断报告已复制到剪贴板。', 'The redacted diagnostics report was copied to the clipboard.'))
  }

  const rebuildConnections = async () => {
    setConnectionNotice(t('正在建立新的低延迟出口连接…', 'Establishing new low-latency outbound connections…'))
    try {
      await api.rebuildOutboundConnections()
      setConnectionNotice(t('出站连接已重建并预热；旧连接会在现有请求结束后释放。', 'Outbound connections were rebuilt and warmed up; old connections will be released after their current requests finish.'))
    } catch (cause) {
      setConnectionNotice(localizeBackendError(cause, language, t('出站连接重建失败', 'Failed to rebuild outbound connections')))
    }
  }

  const detectSystemProxy = async (generation: number) => {
    setConnectionNotice(t('正在读取 Windows 系统代理并检测 OpenAI 连接…', 'Reading the Windows system proxy and testing OpenAI connectivity…'))
    try {
      const result = await api.detectSystemProxy()
      if (systemProxyDetectionGenerationRef.current !== generation) return
      setSystemProxyStatus(result)
      const reachable = result.targets.filter((target) => target.reachable).length
      setConnectionNotice(t(`系统代理检测完成：${reachable}/${result.targets.length} 个目标可达。`, `System proxy test complete: ${reachable}/${result.targets.length} target(s) reachable.`))
    } catch (cause) {
      if (systemProxyDetectionGenerationRef.current !== generation) return
      setConnectionNotice(localizeBackendError(cause, language, t('系统代理检测失败', 'System proxy test failed')))
    }
  }

  const setSystemProxyEnabled = (enabled: boolean) => {
    if (builtInProxyInterlocked) return
    const generation = systemProxyDetectionGenerationRef.current + 1
    systemProxyDetectionGenerationRef.current = generation
    updateDraft({ outboundNetworkMode: enabled ? 'system' : 'direct' }, true)
    if (!enabled) {
      setSystemProxyStatus(undefined)
      setConnectionNotice('')
      return
    }
    void detectSystemProxy(generation)
  }

  return (
    <div className="page-stack">
      <PageHeader
        title={t('设置', 'Settings')}
        actions={effectiveSaveState === 'error'
          ? <button className={`settings-autosave-status settings-autosave-status--${effectiveSaveState}`} type="button" onClick={retryAutosave} title={saveError || autoSaveLabel}><AlertTriangle size={15} /><span>{autoSaveLabel}</span></button>
          : <div className={`settings-autosave-status settings-autosave-status--${effectiveSaveState}`} role="status" aria-live="polite" title={saveError || autoSaveLabel}>{effectiveSaveState === 'saving' ? <LoaderCircle size={15} className="spin" /> : effectiveSaveState === 'invalid' ? <AlertTriangle size={15} /> : <CheckCircle2 size={15} />}<span>{autoSaveLabel}</span></div>}
      />

      {addressChanged && snapshot.gatewayStatus.running && <div className="warning-banner"><AlertTriangle size={17} /><div><strong>{t('更改后将自动重启网关', 'The gateway will restart automatically after the change')}</strong><span>{t(`当前请求仍使用 ${currentEndpoint}`, `Current requests still use ${currentEndpoint}`)}</span></div></div>}

      <section className="settings-section">
        <header><div className="settings-section__icon"><Languages size={18} /></div><div><h2>语言 / Language</h2></div></header>
        <div className="settings-section__content">
          <label className="field">
            <span>界面语言 / Display language</span>
            <select aria-label="界面语言 / Display language" value={preference} onChange={(event) => setPreference(event.target.value as 'system' | 'zh-CN' | 'en')}>
              <option value="system">跟随系统 / Follow system</option>
              <option value="zh-CN">中文 / Chinese</option>
              <option value="en">英文 / English</option>
            </select>
            <small>更改后立即生效并自动保存 / Changes apply instantly and are saved automatically.</small>
          </label>
        </div>
      </section>

      <section className="settings-section">
        <header><div className="settings-section__icon"><Network size={18} /></div><div><h2>{t('本地网关', 'Local Gateway')}</h2></div></header>
        <div className="settings-section__content">
          <div className="form-grid settings-fields">
            <label className="field"><span>{t('监听地址', 'Listen Address')}</span><select value={draft.host} onChange={(event) => updateDraft({ host: event.target.value }, true)}><option value="127.0.0.1">127.0.0.1 (IPv4)</option><option value="::1">::1 (IPv6)</option><option value="localhost">localhost</option></select><FieldError>{errors.host}</FieldError></label>
            <label className="field"><span>{t('端口', 'Port')}</span><input className="mono" type="number" min={1024} max={65535} value={draft.port} onChange={(event) => updateDraft({ port: Number(event.target.value) })} /><FieldError>{errors.port}</FieldError></label>
            <label className="field"><span className="field-label-with-help">{t('连接 / 流空闲超时', 'Connection / Stream Idle Timeout')}<InfoTip text={t('仅限制连接或流无数据的空闲时间，持续输出时不会中断。', 'Only limits idle time without data; active streams are not interrupted.')} /></span><div className="input-suffix"><input type="number" min={5} max={600} value={draft.requestTimeoutSeconds} onChange={(event) => updateDraft({ requestTimeoutSeconds: Number(event.target.value) })} /><span>{t('秒', 'sec')}</span></div><FieldError>{errors.timeout}</FieldError></label>
            <div className="field"><span>{t('当前端点', 'Current Endpoint')}</span><code className="settings-endpoint">{currentEndpoint}</code></div>
          </div>
          <SettingRow title={t('应用启动时运行网关', 'Run gateway when the app starts')} control={<Toggle checked={draft.autoStart} onChange={(value) => updateDraft({ autoStart: value }, true)} label={t('应用启动时运行网关', 'Run gateway when the app starts')} />} />
          <SettingRow title={t('Responses WebSocket', 'Responses WebSocket')} description={t('连续对话可减少重复连接，体验可能更顺畅；但仅部分客户端支持，某些代理或网络下更容易断线。一般保持关闭，客户端明确支持时再开启。', 'Consecutive conversations may feel smoother by avoiding repeated connections, but only some clients support it and certain proxies or networks may disconnect more often. Leave it off unless your client explicitly supports it.')} control={<Toggle checked={draft.responsesWebSocketEnabled === true} onChange={(value) => updateDraft({ responsesWebSocketEnabled: value }, true)} label={t('启用 Responses WebSocket', 'Enable Responses WebSocket')} />} />
          <SettingRow title={t('禁用 Codex Micro', 'Disable Codex Micro')} description={t('右上角重新开启 Codex 时，跳过 Work Louder 设备扫描，缓解部分 Windows 电脑的卡顿；不修改 Codex 安装文件。', 'When Codex is reopened from the top-right button, skip Work Louder device discovery to avoid freezes on some Windows PCs. Codex installation files are not modified.')} control={<Toggle checked={draft.disableCodexMicro === true} onChange={(value) => updateDraft({ disableCodexMicro: value }, true)} label={t('禁用 Codex Micro', 'Disable Codex Micro')} />} />
          <SettingRow title={t('登录系统时启动 Stone+', 'Launch Stone+ at login')} control={<Toggle checked={Boolean(draft.launchAtLogin)} onChange={(value) => updateDraft({ launchAtLogin: value }, true)} label={t('登录系统时启动 Stone+', 'Launch Stone+ at login')} />} />
          <SettingRow title={t('桌面健康通知', 'Desktop health notifications')} description={t('账号停用、冷却、额度耗尽或恢复时通知', 'Notify when accounts are disabled, cooling down, out of quota, or recovered')} control={<Toggle checked={draft.desktopNotifications !== false} onChange={(value) => updateDraft({ desktopNotifications: value }, true)} label={t('桌面健康通知', 'Desktop health notifications')} />} />
          <SettingRow
            title={t('适配系统代理', 'Use system proxy')}
            description={t('开启后立即读取并验证 Windows 系统代理或 PAC，之后自动接管所有未显式指定代理的上游连接；无需开启 TUN，也无需另行检测。', 'Immediately read and verify the Windows system proxy or PAC, then use it automatically for every upstream connection without an explicit proxy. No TUN mode or separate test is required.')}
            control={<fieldset disabled={builtInProxyInterlocked} aria-label={t('适配系统代理', 'Use system proxy')} style={{ border: 0, margin: 0, minInlineSize: 0, opacity: builtInProxyInterlocked ? 0.5 : 1, padding: 0 }}><Toggle checked={draft.outboundNetworkMode === 'system'} onChange={setSystemProxyEnabled} label={t('适配系统代理', 'Use system proxy')} /></fieldset>}
          />
          {builtInProxyInterlocked && <div className="client-config-notice">{t(BUILT_IN_PROXY_TAKEOVER_NOTICE.zh, BUILT_IN_PROXY_TAKEOVER_NOTICE.en)}</div>}
          {!builtInProxyInterlocked && draft.outboundNetworkMode === 'system' && systemProxyStatus && <div className="system-proxy-status">{systemProxyStatus.targets.map((target, index) => {
            const presentation = systemProxyTargetPresentation(target.target, language)
            const summary = localizeBackendMessage(target.summary, language, t('已读取系统代理路由', 'System proxy route detected.'))
            const error = systemProxyErrorMessage(target.error, language)
            return <div key={`${target.target}::${index}`}><span className={target.reachable ? 'status-dot status-dot--online' : 'status-dot status-dot--error'} /><span><strong>{presentation.label}</strong><small>{presentation.endpoint} · {summary}{target.latencyMs !== undefined ? ` · ${target.latencyMs} ms` : ''}{error ? ` · ${error}` : ''}</small></span></div>
          })}</div>}
          <SettingRow title={t('重建低延迟出口', 'Rebuild low-latency connections')} description={t('切换梯子、网络或节点后，建立并预热一代新的多通道连接', 'Establish and warm up fresh connections after changing networks or proxy nodes')} control={<button className="button button--secondary" type="button" onClick={() => void rebuildConnections()}><RefreshCw size={16} />{t('重建并预热', 'Rebuild & Warm Up')}</button>} />
          {connectionNotice && <div className="client-config-notice">{connectionNotice}</div>}
        </div>
      </section>

      <section className="settings-section">
        <header><div className="settings-section__icon settings-section__icon--secure"><Archive size={18} /></div><div><h2>{t('备份与恢复', 'Backup & Restore')}</h2></div></header>
        <div className="settings-section__content">
          <SettingRow title={t('自动备份', 'Automatic backups')} description={t('Stone+ 启动时创建校验过的本地快照', 'Create a verified local snapshot when Stone+ starts')} control={<Toggle checked={draft.automaticBackups !== false} onChange={(value) => updateDraft({ automaticBackups: value }, true)} label={t('自动备份', 'Automatic backups')} />} />
          <label className="field backup-retention"><span>{t('最多保留备份', 'Maximum backups')}</span><div className="input-suffix"><input type="number" min={1} max={100} value={draft.backupRetention ?? 10} onChange={(event) => updateDraft({ backupRetention: Number(event.target.value) })} /><span>{t('份', 'files')}</span></div><FieldError>{errors.backupRetention}</FieldError></label>
          <div className="settings-actions"><button className="button button--secondary" type="button" onClick={() => void createBackup()}><Archive size={16} />{t('立即备份', 'Back Up Now')}</button><button className="button button--secondary" type="button" onClick={() => void exportDiagnostics()}><FileDown size={16} />{t('复制诊断报告', 'Copy Diagnostics Report')}</button><button className="button button--secondary" type="button" onClick={() => void api.clearHealthEvents()}><BellRing size={16} />{t('清除健康事件', 'Clear Health Events')}</button></div>
          <div className="portable-backup-actions">
            <label className="field"><span><LockKeyhole size={14} />{t('迁移备份密码', 'Portable backup password')}</span><input type="password" value={portablePassword} disabled={Boolean(portableBusy)} autoComplete="new-password" maxLength={1024} placeholder={t('至少 8 个字符', 'At least 8 characters')} onChange={(event) => { portablePasswordRef.current = event.target.value; setPortablePassword(event.target.value) }} /></label>
            <button className="button button--secondary" type="button" disabled={Boolean(portableBusy)} onClick={() => void exportPortableBackup()}>{portableBusy === 'export' ? <LoaderCircle size={16} className="spin" /> : <FileDown size={16} />}{t('导出加密备份', 'Export encrypted')}</button>
            <button className="button button--secondary" type="button" disabled={Boolean(portableBusy)} onClick={() => void importPortableBackup()}>{portableBusy === 'import' ? <LoaderCircle size={16} className="spin" /> : <Upload size={16} />}{t('导入加密备份', 'Import encrypted')}</button>
          </div>
          <div className="webdav-backup-panel">
            <div className="webdav-backup-panel__header"><span><Cloud size={16} /><strong>WebDAV</strong><small>{t('可选的端到端加密迁移备份同步', 'Optional end-to-end encrypted portable backup sync')}</small></span>{webDavConfiguration.configured && <Badge tone="success">{t('已配置', 'Configured')}</Badge>}</div>
            <div className="form-grid">
              <label className="field field--full"><span>WebDAV URL</span><input className="mono" value={webDavDraft.baseUrl} disabled={Boolean(webDavBusy)} placeholder="https://dav.example/StonePlus/" onChange={(event) => setWebDavDraft({ ...webDavDraft, baseUrl: event.target.value })} /></label>
              <label className="field"><span>{t('用户名', 'Username')}</span><input value={webDavDraft.username} disabled={Boolean(webDavBusy)} autoComplete="username" onChange={(event) => setWebDavDraft({ ...webDavDraft, username: event.target.value })} /></label>
              <label className="field"><span>{t('密码', 'Password')}</span><input type="password" value={webDavDraft.password} disabled={Boolean(webDavBusy)} autoComplete="new-password" placeholder={webDavConfiguration.hasPassword ? t('留空保留已保存密码', 'Leave blank to keep saved password') : t('系统安全存储', 'Stored by the system')} onChange={(event) => { webDavPasswordRef.current = event.target.value; setWebDavDraft({ ...webDavDraft, password: event.target.value }) }} /></label>
            </div>
            {webDavConfiguration.requiresPassword && <div className="settings-inline-warning">{t('服务器地址中的旧密码已移除，请重新输入 WebDAV 密码。', 'The legacy password embedded in the server URL was removed. Enter the WebDAV password again.')}</div>}
            <div className="settings-actions"><button className="button button--secondary" type="button" disabled={Boolean(webDavBusy)} onClick={() => void saveWebDav()}>{webDavBusy === 'save' ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />}{t('保存 WebDAV', 'Save WebDAV')}</button><button className="button button--secondary" type="button" disabled={!webDavConfiguration.configured || Boolean(webDavBusy)} onClick={() => void testWebDav()}>{webDavBusy === 'test' ? <LoaderCircle size={16} className="spin" /> : <Network size={16} />}{t('测试连接', 'Test')}</button><button className="button button--secondary" type="button" disabled={!webDavConfiguration.configured || portablePassword.length < 8 || Boolean(webDavBusy) || Boolean(portableBusy)} onClick={() => void uploadWebDav()}>{webDavBusy === 'upload' ? <LoaderCircle size={16} className="spin" /> : <Upload size={16} />}{t('上传最新加密备份', 'Upload latest encrypted backup')}</button><button className="icon-button" type="button" disabled={!webDavConfiguration.configured || Boolean(webDavBusy)} title={t('清除 WebDAV 配置', 'Clear WebDAV configuration')} onClick={() => void clearWebDav()}><Trash2 size={16} /></button></div>
            {webDavConfiguration.configured && <div className="webdav-backup-list"><div className="webdav-backup-list__heading"><strong>{t('远端备份', 'Remote backups')}</strong><button className="text-button" type="button" disabled={Boolean(webDavBusy)} onClick={() => void refreshWebDav()}><RefreshCw size={14} className={webDavBusy === 'list' ? 'spin' : ''} />{t('刷新', 'Refresh')}</button></div>{webDavEntries.map((entry) => <div key={entry.name}><span><strong>{entry.name}</strong><small>{entry.size === undefined ? '' : `${Math.ceil(entry.size / 1024)} KB`}{entry.modifiedAt ? ` · ${new Date(entry.modifiedAt).toLocaleString(locale)}` : ''}</small></span><button className="button button--secondary" type="button" disabled={Boolean(webDavBusy) || Boolean(portableBusy) || portablePassword.length < 8} onClick={() => void downloadWebDav(entry)}>{webDavBusy === `download:${entry.name}` ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}{t('下载并导入', 'Download & import')}</button></div>)}{!webDavEntries.length && <span className="muted">{t('暂无远端备份', 'No remote backups')}</span>}</div>}
          </div>
          {operationNotice && <div className="client-config-notice">{operationNotice}</div>}
          <div className="state-backup-list">{backups.slice(0, 6).map((backup) => <div key={backup.path}><span><strong>{new Date(backup.createdAt).toLocaleString(locale)}</strong><small>{Math.ceil(backup.size / 1024)} KB · {backup.automatic ? t('自动', 'Automatic') : t('手动', 'Manual')} · {backup.integrity === 'valid' ? t('校验通过', 'Verified') : t('损坏', 'Corrupted')}</small></span><button className="icon-button" type="button" disabled={backup.integrity !== 'valid'} title={t('恢复此备份', 'Restore this backup')} onClick={() => void restoreBackup(backup)}><RotateCcw size={15} /></button></div>)}{!backups.length && <span className="muted">{t('暂无状态备份', 'No state backups')}</span>}</div>
        </div>
      </section>

      <section className="settings-section">
        <header><div className="settings-section__icon settings-section__icon--logs"><Timer size={18} /></div><div><h2>{t('请求日志', 'Request Logs')}</h2></div></header>
        <div className="settings-section__content">
          <SettingRow title={t('日志内容', 'Log contents')} description={t('记录路由、状态、延迟与 Token 计数，不保存提示词或模型输出', 'Records routing, status, latency, and Token counts without saving prompts or model output')} control={<Badge tone="success">{t('仅元数据', 'Metadata only')}</Badge>} />
          <SettingRow title={t('临时捕获回放负载', 'Temporary replay capture')} description={t('仅在内存中限量保留新请求约 30 分钟，用于脱敏查看和本机回放；不会写入日志、数据库或备份。关闭后立即清空。', 'Retain a limited number of new requests in memory for about 30 minutes for redacted inspection and local replay. Never written to logs, the database, or backups; disabling clears them immediately.')} control={<Toggle checked={draft.logPayloads === true} onChange={(value) => updateDraft({ logPayloads: value }, true)} label={t('临时捕获回放负载', 'Temporary replay capture')} />} />
          <div className="log-summary"><span>{t('当前日志', 'Current logs')}</span><strong>{t(`${snapshot.requestLogs.length} 条记录`, `${snapshot.requestLogs.length} record(s)`)}</strong><Badge tone="success">{t('仅元数据', 'Metadata only')}</Badge></div>
        </div>
      </section>

      <section className="settings-section">
        <header><div className="settings-section__icon"><Radio size={18} /></div><div><h2>{t('本地插件事件', 'Local Plugin Events')}</h2></div></header>
        <div className="settings-section__content">
          <SettingRow title={t('只读事件流', 'Read-only event stream')} description={t('向本机插件推送网关、账号与请求生命周期事件；仅监听回环地址并要求发现文件中的 Bearer Token。', 'Publishes gateway, account, and request lifecycle events to local plugins. Loopback-only and requires the Bearer token stored in the discovery file.')} control={<Badge tone={localEvents?.running ? 'success' : 'neutral'}>{localEvents?.running ? t('运行中', 'Running') : t('不可用', 'Unavailable')}</Badge>} />
          <div className="log-summary"><span>{t('连接地址', 'Address')}</span><strong className="mono">{localEvents?.address ?? '—'}</strong><Badge tone="neutral">Bearer Token</Badge></div>
          <div className="log-summary"><span>{t('发现文件', 'Discovery file')}</span><strong className="mono">{localEvents?.discoveryFile || '—'}</strong><span>{t(`${localEvents?.connectedClients ?? 0} 个客户端`, `${localEvents?.connectedClients ?? 0} client(s)`)}</span></div>
          <small className="muted">{t('鉴权已启用。Token 不会返回界面；本机插件从权限受限的发现文件读取。', 'Authentication is enabled. The token is never returned to the UI; local plugins read it from the permission-restricted discovery file.')}</small>
        </div>
      </section>

      <section className="settings-section">
        <header><div className="settings-section__icon settings-section__icon--update"><Sparkles size={18} /></div><div><h2>{t('应用更新', 'App Updates')}</h2></div></header>
        <div className="settings-section__content">
          <div className="update-settings-status">
            <div>
              <span className="update-settings-status__icon">{appUpdate?.status === 'checking' || appUpdate?.status === 'downloading' || appUpdate?.status === 'installing' ? <LoaderCircle size={19} className="spin" /> : appUpdate?.status === 'downloaded' || appUpdate?.status === 'up-to-date' ? <CheckCircle2 size={19} /> : <Sparkles size={19} />}</span>
              <div>
                <strong>{appUpdate?.release ? `Stone+ ${appUpdate.release.version}` : `Stone+ ${appUpdate?.currentVersion ?? __APP_VERSION__}`}</strong>
                <span>{updateSettingsDescription(appUpdate, language)}</span>
              </div>
            </div>
            <div className="update-settings-status__badges">
              <Badge tone={appUpdate ? statusTone(appUpdate) : 'neutral'}>{appUpdate ? statusLabel(appUpdate, language) : t('正在读取', 'Loading')}</Badge>
              {ignoredRelease && <Badge tone="neutral">{t('已忽略', 'Ignored')}</Badge>}
            </div>
          </div>

          {appUpdate?.status === 'downloading' && appUpdate.progress && <UpdateProgress state={appUpdate} />}
          {appUpdate && !appUpdate.automaticUpdateSupported && (
            <div className="update-settings-reason"><AlertTriangle size={16} /><span>{appUpdate.automaticUpdateReason ? localizeBackendMessage(appUpdate.automaticUpdateReason, language, t('当前安装形式需要从 GitHub Releases 手动更新。', 'This installation must be updated manually from GitHub Releases.')) : t('当前安装形式需要从 GitHub Releases 手动更新。', 'This installation must be updated manually from GitHub Releases.')}</span></div>
          )}
          {(update.error || appUpdate?.error) && <div className="update-error" role="alert"><AlertTriangle size={16} /><span>{localizeBackendMessage(update.error ?? appUpdate?.error, language, t('更新操作失败', 'The update operation failed.'))}</span></div>}

          <div className="settings-actions update-settings-actions">
            <button className="button button--secondary" type="button" disabled={updateBusy || appUpdate?.status === 'downloading'} onClick={() => void update.check()}>
              {update.action === 'check' || appUpdate?.status === 'checking' ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}{t('手动检查', 'Check Manually')}
            </button>
            {appUpdate?.release && <button className="button button--secondary" type="button" onClick={update.openDialog}>{t('查看版本亮点', 'View Highlights')}</button>}
            {appUpdate?.status === 'available' && !ignoredRelease && <button className="text-button" type="button" disabled={updateBusy} onClick={() => void update.ignore()}>{t('忽略此版本', 'Ignore This Version')}</button>}
            {appUpdate?.status === 'available' && appUpdate.automaticUpdateSupported && (
              <button className="button button--primary" type="button" disabled={updateBusy} onClick={() => void update.download()}>
                {update.action === 'download' || update.action === 'install' ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}{t('更新并安装', 'Update & Install')}
              </button>
            )}
            {appUpdate?.status === 'downloaded' && (
              <button className="button button--primary" type="button" disabled={updateBusy} onClick={() => void update.install()}>
                {update.action === 'install' ? <LoaderCircle size={16} className="spin" /> : <Rocket size={16} />}{t('立即安装并重启', 'Install & Restart Now')}
              </button>
            )}
            {appUpdate && (!appUpdate.automaticUpdateSupported || appUpdate.status === 'unsupported') && (
              <button className="button button--primary" type="button" disabled={update.action === 'open-page'} onClick={() => void update.openPage()}>
                <ExternalLink size={16} />{t('打开 Releases', 'Open Releases')}
              </button>
            )}
          </div>
          <div className="update-settings-meta">
            <span>{t(`当前版本 v${appUpdate?.currentVersion ?? __APP_VERSION__}`, `Current version v${appUpdate?.currentVersion ?? __APP_VERSION__}`)}</span>
            <span>{appUpdate?.checkedAt ? t(`上次检查 ${new Date(appUpdate.checkedAt).toLocaleString(locale)}`, `Last checked ${new Date(appUpdate.checkedAt).toLocaleString(locale)}`) : t('尚未手动检查更新', 'No manual update check yet')}</span>
          </div>
        </div>
      </section>

      <section className="about-line">
        <StoneMark small />
        <div className="about-line__identity">
          <strong>Stone+</strong>
          <span>{__APP_VERSION__} · Source Available 1.0 · Unofficial community fork</span>
        </div>
        <div className="about-line__links" aria-label={t('项目法律信息', 'Project legal information')}>
          <button className="text-button" type="button" onClick={() => void api.openProjectPage('source')}>{t('对应源码', 'Source')}</button>
          <button className="text-button" type="button" onClick={() => void api.openProjectPage('license')}>{t('许可证', 'License')}</button>
          <button className="text-button" type="button" onClick={() => void api.openProjectPage('notices')}>{t('第三方声明', 'Notices')}</button>
          <button className="text-button" type="button" onClick={() => void api.openProjectPage('trademarks')}>{t('品牌政策', 'Brand Policy')}</button>
        </div>
        <Badge tone={appUpdate ? statusTone(appUpdate) : 'neutral'}>{appUpdate ? statusLabel(appUpdate, language) : 'GitHub Releases'}</Badge>
      </section>
    </div>
  )
}

function updateSettingsDescription(update: AppUpdateController['state'], language: UiLanguage): string {
  if (!update) return translate(language, '正在读取当前安装的更新能力。', 'Reading update capabilities for this installation.')
  if (update.status === 'unsupported') return translate(language, '当前安装形式不支持应用内自动更新。', 'This installation does not support automatic in-app updates.')
  if (update.status === 'idle') return translate(language, '手动检查 GitHub Releases 中的最新版本。', 'Check GitHub Releases for the latest version manually.')
  if (update.status === 'checking') return translate(language, '正在获取最新版本与发布说明。', 'Fetching the latest version and release notes.')
  if (update.status === 'up-to-date') return translate(language, '当前安装的 Stone+ 已是最新版本。', 'The installed Stone+ version is up to date.')
  if (update.status === 'available') return update.ignoredVersion === update.release?.version ? translate(language, '此版本已忽略，仍可手动查看或下载。', 'This version is ignored, but you can still view or download it manually.') : translate(language, '新版本已发布，可查看说明后下载。', 'A new version is available. Review the notes before downloading.')
  if (update.status === 'downloading') return translate(language, '安装包正在后台下载。', 'The installer is downloading in the background.')
  if (update.status === 'downloaded') return translate(language, '安装包已就绪，重启 Stone+ 即可完成更新。', 'The installer is ready. Restart Stone+ to complete the update.')
  if (update.status === 'installing') return translate(language, 'Stone+ 正在关闭并安装新版本。', 'Stone+ is closing and installing the new version.')
  return translate(language, '更新操作失败，当前版本仍可继续使用。', 'The update failed. You can continue using the current version.')
}
