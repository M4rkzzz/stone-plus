import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Braces,
  ChevronDown,
  CheckCircle2,
  Clipboard,
  Download,
  Eye,
  FileCode2,
  FolderCog,
  History,
  LoaderCircle,
  LogIn,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Undo2,
  Upload,
  Wrench,
} from 'lucide-react'
import type {
  AppSnapshot,
  ClientConfigBackup,
  ClientConfigEditorField,
  ClientConfigEditorState,
  ClientConfigFieldValue,
  ClientConfigFileRole,
  ClientConfigProfile,
  ClientConfigStatus,
  GatewayApi,
  ProfileBundle,
  Route,
  RouteClient,
} from '@shared/types'
import { clientNativeProtocols } from '@shared/types'
import { listRouteSources, resolveRouteSource } from '@shared/route-sources'
import {
  buildClientConfigWorkbenchPreview,
  createInitialClientConfigDrafts,
  getClientConfigFieldGuide,
  isClientConfigWorkbenchDirty,
  localizeClientConfigEditorField,
  resetClientConfigDrafts,
  type ClientConfigFieldDrafts,
  type ClientConfigFileDrafts,
} from '../client-config-workbench'
import { localizeBackendMessage } from '../backend-message'
import { clientBrandMeta as clientMeta } from '../brand-icons'
import { useI18n, type UiLanguage } from '../i18n'
import { setupPoolDisplayName } from '../system-generated-text'
import { Badge, ConfirmDialog, EmptyState, formatDateTime, InfoTip, Modal, Toggle } from '../ui'
import '../clients-view.css'
import { ManagedClientInstancesPanel } from '../managed-client-instances'
import { PersistentTaskCenter } from '../persistent-task-center'

const clientOrder: RouteClient[] = ['claude', 'codex', 'gemini']

const roleLabels: Record<ClientConfigFileRole, readonly [chinese: string, english: string]> = {
  'claude-settings': ['Claude 设置', 'Claude settings'],
  'claude-mcp': ['Claude MCP', 'Claude MCP'],
  'codex-config': ['Codex 配置', 'Codex configuration'],
  'codex-auth': ['Codex 认证', 'Codex authentication'],
  'gemini-settings': ['Gemini 设置', 'Gemini settings'],
  'gemini-env': ['Gemini 环境变量', 'Gemini environment'],
}

function roleLabel(role: ClientConfigFileRole, language: UiLanguage): string {
  return roleLabels[role][language === 'zh-CN' ? 0 : 1]
}

function newLocalToken(client: RouteClient): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return `stone_${client}_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

type FieldScope = 'all' | 'basic' | 'advanced'
type PreviewMode = 'preview' | 'source'
type ProfileBundleMode = 'import' | 'export'
type ConfigHealth = 'checking' | 'healthy' | 'needs-repair' | 'missing' | 'invalid' | 'blocked'

interface PendingSwitch {
  client: RouteClient
  profileId: string
}

interface ClientBackupGroup {
  groupId: string
  createdAt: number
  backups: ClientConfigBackup[]
}

export function ClientsView({
  snapshot,
  api,
}: {
  snapshot: AppSnapshot
  api: GatewayApi
}) {
  const { language, locale, t } = useI18n()
  const [activeClient, setActiveClient] = useState<RouteClient>('codex')
  const [statuses, setStatuses] = useState<ClientConfigStatus[]>([])
  const [backups, setBackups] = useState<Partial<Record<RouteClient, ClientConfigBackup[]>>>({})
  const [showBackups, setShowBackups] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [restoreTarget, setRestoreTarget] = useState<ClientBackupGroup | null>(null)
  const [officialLoginConfirm, setOfficialLoginConfirm] = useState(false)
  const [deleteProfileTarget, setDeleteProfileTarget] = useState<ClientConfigProfile | null>(null)
  const [pendingSwitch, setPendingSwitch] = useState<PendingSwitch | null>(null)
  const [busy, setBusy] = useState<string | null>('load')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [configHealth, setConfigHealth] = useState<ConfigHealth>('checking')
  const [configReadError, setConfigReadError] = useState<string | null>(null)
  const [profile, setProfile] = useState<ClientConfigProfile | null>(null)
  const [profileBundle, setProfileBundle] = useState('__closed__')
  const [profileBundleMode, setProfileBundleMode] = useState<ProfileBundleMode>('import')
  const [editor, setEditor] = useState<ClientConfigEditorState | null>(null)
  const [activeEditorRole, setActiveEditorRole] = useState<ClientConfigFileRole | null>(null)
  const [fieldDrafts, setFieldDrafts] = useState<ClientConfigFieldDrafts>({})
  const [fileDrafts, setFileDrafts] = useState<ClientConfigFileDrafts>({})
  const [activeField, setActiveField] = useState<string | null>(null)
  const [fieldSearch, setFieldSearch] = useState('')
  const [fieldScope, setFieldScope] = useState<FieldScope>('basic')
  const [previewMode, setPreviewMode] = useState<PreviewMode>('preview')
  const [routeSelections, setRouteSelections] = useState<Partial<Record<RouteClient, string>>>({})
  const [activeProfiles, setActiveProfiles] = useState<Record<RouteClient, string>>({
    claude: 'default-claude',
    codex: 'default-codex',
    gemini: 'default-gemini',
  })
  const requestSequence = useRef(0)

  const activeProfileId = activeProfiles[activeClient]

  const run = async <T,>(key: string, operation: () => Promise<T>): Promise<T | undefined> => {
    setBusy(key)
    setError(null)
    setNotice(null)
    try {
      return await operation()
    } catch (cause) {
      setError(errorMessage(cause, t('客户端配置操作失败', 'Client configuration operation failed'), language))
      return undefined
    } finally {
      setBusy(null)
    }
  }

  const loadWorkspace = useCallback(async (client: RouteClient, profileId: string, announce = false) => {
    const sequence = requestSequence.current + 1
    requestSequence.current = sequence
    setBusy(`workspace-${client}`)
    setError(null)
    setConfigHealth('checking')
    setConfigReadError(null)
    try {
      const [statusResult, editorResult, backupResult, previewResult] = await Promise.allSettled([
        api.getClientConfigs(profileId),
        api.getClientConfigEditor(client, profileId),
        api.listClientConfigBackups(client, profileId),
        api.previewClientConfig(client, profileId),
      ])
      if (sequence !== requestSequence.current) return
      if (statusResult.status === 'fulfilled') {
        setStatuses((current) => {
          const merged = new Map(current.map((item) => [item.client, item]))
          statusResult.value.forEach((item) => merged.set(item.client, item))
          return [...merged.values()]
        })
      }
      if (backupResult.status === 'fulfilled') {
        setBackups((current) => ({ ...current, [client]: backupResult.value }))
      }
      if (previewResult.status === 'fulfilled') {
        const hasManagedFile = previewResult.value.files.some((file) => file.existed)
        const connectionNeedsRepair = previewResult.value.files.some((file) => file.changed)
        setConfigHealth(!hasManagedFile ? 'missing' : connectionNeedsRepair ? 'needs-repair' : 'healthy')
      } else {
        const previewError = errorMessage(previewResult.reason, t('无法检查客户端连接配置', 'Unable to check the client connection configuration'), language)
        setConfigHealth(isClientTargetError(previewError) ? 'blocked' : 'invalid')
        setConfigReadError(previewError)
      }
      if (editorResult.status === 'fulfilled') {
        const nextEditor = editorResult.value
        setEditor(nextEditor)
        const drafts = createInitialClientConfigDrafts(nextEditor)
        setFieldDrafts(drafts.fieldDrafts)
        setFileDrafts(drafts.fileDrafts)
        setActiveEditorRole(preferredRole(nextEditor))
        setActiveField(null)
        setPreviewMode('preview')
        if (announce) setNotice(t(
          `${clientMeta[client].name} 配置已重新检查`,
          `${clientMeta[client].name} configuration checked again`,
        ))
      } else {
        setEditor(null)
        setFieldDrafts({})
        setFileDrafts({})
        setActiveEditorRole(null)
        setConfigReadError((current) => current ?? errorMessage(
          editorResult.reason,
          t('高级配置无法解析', 'Unable to parse the advanced configuration'),
          language,
        ))
      }
      if (statusResult.status === 'rejected' && editorResult.status === 'rejected') {
        setError(errorMessage(
          statusResult.reason,
          t('无法读取客户端配置状态', 'Unable to read the client configuration status'),
          language,
        ))
      }
    } catch (cause) {
      if (sequence === requestSequence.current) {
        setEditor(null)
        setConfigHealth('invalid')
        setConfigReadError(errorMessage(
          cause,
          t('无法读取客户端配置', 'Unable to read the client configuration'),
          language,
        ))
      }
    } finally {
      if (sequence === requestSequence.current) setBusy(null)
    }
  }, [api, language, t])

  useEffect(() => {
    void loadWorkspace(activeClient, activeProfileId)
  }, [activeClient, activeProfileId, loadWorkspace])

  useEffect(() => {
    if (!notice) return undefined
    const timer = window.setTimeout(() => setNotice(null), 4_000)
    return () => window.clearTimeout(timer)
  }, [notice])

  const workbench = useMemo(
    () => editor ? buildClientConfigWorkbenchPreview(editor, fieldDrafts, fileDrafts, language) : null,
    [editor, fieldDrafts, fileDrafts, language],
  )
  const localizedFields = useMemo(
    () => editor?.fields.map((field) => localizeClientConfigEditorField(field, language)) ?? [],
    [editor, language],
  )
  const isDirty = editor ? isClientConfigWorkbenchDirty(editor, fieldDrafts, fileDrafts) : false
  const codexAgentLimitField = activeClient === 'codex'
    ? editor?.fields.find((field) => field.id === 'codex.agentsMaxThreads')
    : undefined
  const codexAgentLimitValue = codexAgentLimitField
    ? draftValue(codexAgentLimitField, fieldDrafts)
    : null
  const codexAgentLimitDirty = Boolean(codexAgentLimitField)
    && !sameConfigValue(codexAgentLimitField?.value ?? null, codexAgentLimitValue)
  const codexAgentLimitValid = codexAgentLimitValue === null
    || (typeof codexAgentLimitValue === 'number'
      && Number.isInteger(codexAgentLimitValue)
      && codexAgentLimitValue >= 1
      && codexAgentLimitValue <= 64)
  const hasOtherEditorChanges = Boolean(editor) && (
    editor?.fields.some((field) => field.id !== 'codex.agentsMaxThreads'
      && !field.readOnly
      && !sameConfigValue(field.value, draftValue(field, fieldDrafts)))
    || editor?.files.some((file) => file.editable
      && file.content !== undefined
      && fileDrafts[file.role] !== undefined
      && fileDrafts[file.role] !== file.content)
  )
  const status = statuses.find((candidate) => candidate.client === activeClient)
  const hasExistingConfig = Boolean(status?.files.some((file) => file.exists))
  const meta = clientMeta[activeClient]
  const route = snapshot.routes.find((candidate) => candidate.client === activeClient)
  const routeSelection = routeSelections[activeClient] ?? route?.poolId ?? ''
  const resolvedRouteSource = route?.poolId ? resolveRouteSource(route.poolId, snapshot) : undefined
  const availableRouteSources = useMemo(() => listRouteSources(snapshot), [snapshot])
  const routeSources = useMemo(() => {
    if (!resolvedRouteSource || availableRouteSources.some((source) => source.id === resolvedRouteSource.summary.id)) return availableRouteSources
    return [resolvedRouteSource.summary, ...availableRouteSources]
  }, [availableRouteSources, resolvedRouteSource])
  const currentSourceAvailable = Boolean(route?.poolId && availableRouteSources.some((source) => source.id === route.poolId))
  const routeCompatible = route?.inboundProtocol === clientNativeProtocols[activeClient]

  useEffect(() => {
    const pendingSource = routeSelections[activeClient]
    if (!pendingSource || pendingSource !== route?.poolId) return
    setRouteSelections((current) => {
      if (current[activeClient] !== pendingSource) return current
      const next = { ...current }
      delete next[activeClient]
      return next
    })
  }, [activeClient, route?.poolId, routeSelections])
  const backupGroups = useMemo(
    () => groupClientBackups(backups[activeClient] ?? []),
    [activeClient, backups],
  )
  const latestBackupGroup = backupGroups[0]
  const selectedProfile = snapshot.clientProfiles.find((candidate) => candidate.id === activeProfileId)
  const activeDocument = workbench?.documents.find((document) => document.role === activeEditorRole)
    ?? workbench?.documents[0]
  const activeLocation = activeField ? workbench?.fieldLocations[activeField] : undefined
  const activeSourceFile = editor?.files.find((file) => file.role === activeDocument?.role)

  const visibleFields = useMemo(() => {
    if (!editor) return []
    const query = fieldSearch.trim().toLocaleLowerCase()
    return localizedFields.filter((field) => {
      if (fieldScope === 'basic' && field.advanced) return false
      if (fieldScope === 'advanced' && !field.advanced && !field.readOnly) return false
      if (!query) return true
      const guide = getClientConfigFieldGuide(field, language)
      return [field.label, field.id, field.section, field.description, field.path.join('.'), guide?.description]
        .some((value) => value?.toLocaleLowerCase().includes(query))
    })
  }, [editor, fieldScope, fieldSearch, language, localizedFields])

  const sections = useMemo(
    () => [...new Set(visibleFields.map((field) => field.section))],
    [visibleFields],
  )

  const requestContextSwitch = (client: RouteClient, profileId = activeProfiles[client]) => {
    if (client === activeClient && profileId === activeProfileId) return
    if (isDirty) {
      setPendingSwitch({ client, profileId })
      return
    }
    commitContextSwitch(client, profileId)
  }

  const commitContextSwitch = (client: RouteClient, profileId: string) => {
    setActiveProfiles((current) => ({ ...current, [client]: profileId }))
    setActiveClient(client)
    setEditor(null)
    setFieldDrafts({})
    setFileDrafts({})
    setActiveEditorRole(null)
    setActiveField(null)
    setShowBackups(false)
    setAdvancedOpen(false)
    setOfficialLoginConfirm(false)
    setFieldSearch('')
    setFieldScope('basic')
    setConfigHealth('checking')
    setConfigReadError(null)
    setPendingSwitch(null)
  }

  const selectField = (field: ClientConfigEditorField) => {
    setActiveField(field.id)
    setPreviewMode('preview')
    const location = workbench?.fieldLocations[field.id]
    if (location) setActiveEditorRole(location.role)
  }

  const saveEditor = async () => {
    if (!editor) return
    const patches = editor.fields
      .filter((field) => !field.readOnly && !sameConfigValue(field.value, draftValue(field, fieldDrafts)))
      .map((field) => ({ id: field.id, value: draftValue(field, fieldDrafts) }))
    const files = editor.files
      .filter((file) => file.editable && file.content !== undefined && fileDrafts[file.role] !== undefined && fileDrafts[file.role] !== file.content)
      .map((file) => ({ role: file.role, revision: file.revision, content: fileDrafts[file.role] ?? '' }))
    const result = await run(`save-editor-${editor.client}`, () => api.saveClientConfigEditor({
      client: editor.client,
      profileId: editor.profileId,
      patches,
      files,
    }))
    if (!result) return
    setNotice(result.changedFiles.length
      ? t(
        `${clientMeta[editor.client].name} 已保存 ${result.changedFiles.length} 个文件，并自动创建备份`,
        `${clientMeta[editor.client].name} saved ${result.changedFiles.length} ${result.changedFiles.length === 1 ? 'file' : 'files'} and created a backup automatically`,
      )
      : t(
        `${clientMeta[editor.client].name} 配置无需更改`,
        `${clientMeta[editor.client].name} configuration is already up to date`,
      ))
    await loadWorkspace(editor.client, editor.profileId)
  }

  const saveCodexAgentLimit = async () => {
    if (!editor || editor.client !== 'codex' || !codexAgentLimitField || !codexAgentLimitDirty
      || !codexAgentLimitValid || hasOtherEditorChanges) return
    const value = codexAgentLimitValue
    const result = await run('save-codex-agent-limit', () => api.saveClientConfigEditor({
      client: 'codex',
      profileId: editor.profileId,
      patches: [{ id: codexAgentLimitField.id, value }],
      files: [],
    }))
    if (!result) return
    setNotice(value === null
      ? t('子代理上限已恢复为 Codex 默认值', 'The subagent limit now follows the Codex default')
      : t(`子代理上限已设为 ${value}，重新启动 Codex 后生效`, `The subagent limit is now ${value}; restart Codex to apply it`))
    await loadWorkspace('codex', editor.profileId)
  }

  const repairConnection = async () => {
    const client = activeClient
    const result = await run(`repair-${client}`, () => api.repairClientConfig(client, activeProfileId))
    if (!result) return
    setNotice(result.rebuiltRoles.length
      ? t(
        `${meta.name} 已从损坏文件重建，并恢复 Stone+ 连接`,
        `${meta.name} was rebuilt from the damaged files and reconnected to Stone+`,
      )
      : t(
        `${meta.name} 已修复连接且保留其他设置`,
        `${meta.name} connection repaired while preserving the other settings`,
      ))
    await loadWorkspace(client, activeProfileId)
  }

  const repairedRouteDraft = (): Route | undefined => {
    if (!routeSelection || !availableRouteSources.some((source) => source.id === routeSelection)) return undefined
    const timestamp = Date.now()
    return {
      ...(route ?? {
        id: '',
        client: activeClient,
        modelMap: {},
        createdAt: timestamp,
      }),
      enabled: true,
      poolId: routeSelection,
      inboundProtocol: clientNativeProtocols[activeClient],
      localToken: route?.localToken || newLocalToken(activeClient),
      updatedAt: timestamp,
    }
  }

  const repairInternalRoute = async () => {
    const draft = repairedRouteDraft()
    if (!draft) {
      setError(t('请先选择一个可用上游', 'Select an available upstream first'))
      return
    }
    const result = await run(`repair-route-${activeClient}`, () => api.updateRoute(draft))
    if (!result) return
    setNotice(t('内部路由已修复并启用', 'The internal route was repaired and enabled'))
    await loadWorkspace(activeClient, activeProfileId)
  }

  const connectWithOneClick = async () => {
    const draft = repairedRouteDraft()
    if (!draft) {
      setError(t('请先选择一个可用上游', 'Select an available upstream first'))
      return
    }
    const result = await run(`connect-${activeClient}`, async () => {
      if (!routeHealthy) await api.updateRoute(draft)
      if (!snapshot.gatewayStatus.running) await api.startGateway()
      return api.repairClientConfig(activeClient, activeProfileId)
    })
    if (!result) return
    setNotice(t(`${meta.name} 已连接到 Stone+`, `${meta.name} is connected to Stone+`))
    await loadWorkspace(activeClient, activeProfileId)
  }

  const startLocalGateway = async () => {
    const result = await run('start-client-gateway', () => api.startGateway())
    if (!result) return
    setNotice(t('本地网关已启动，客户端连接可以继续配置', 'The local gateway is running; client connection setup can continue'))
  }

  const switchUpstream = async (sourceId: string) => {
    if (!sourceId || sourceId === route?.poolId) return
    const client = activeClient
    setRouteSelections((current) => ({ ...current, [client]: sourceId }))
    const result = await run(`switch-upstream-${client}`, () => api.setClientRouteSource({ client, sourceId }))
    if (!result) {
      setRouteSelections((current) => {
        const next = { ...current }
        delete next[client]
        return next
      })
      return
    }
    const nextRoute = result.routes.find((candidate) => candidate.client === client)
    setRouteSelections((current) => ({ ...current, [client]: nextRoute?.poolId ?? sourceId }))
    const sourceName = resolveRouteSource(sourceId, result)?.summary.name ?? t('新上游', 'the new upstream')
    setNotice(t(
      `已切换到 ${sourceName}，客户端配置文件未改动`,
      `Switched to ${sourceName}; the client configuration files were not changed`,
    ))
  }

  const restore = async () => {
    if (!restoreTarget) return
    const target = restoreTarget
    const result = await run(`restore-${activeClient}`, () => api.restoreClientConfigBackupSet(target.groupId, activeClient, activeProfileId))
    if (!result) return
    setRestoreTarget(null)
    setNotice(t(
      `${meta.name} 已完整恢复 ${result.restoredFiles.length} 个配置文件 · ${formatDateTime(target.createdAt, locale)}`,
      `${meta.name} restored ${result.restoredFiles.length} configuration ${result.restoredFiles.length === 1 ? 'file' : 'files'} · ${formatDateTime(target.createdAt, locale)}`,
    ))
    await loadWorkspace(activeClient, activeProfileId)
  }

  const restoreOfficialLogin = async () => {
    const profileId = activeProfileId
    const result = await run('restore-codex-official-login', () => (
      api.restoreCodexOfficialLoginAndSessions(profileId)
    ))
    if (!result) return
    setOfficialLoginConfirm(false)
    setNotice(t(
      '已完成：关闭 Codex → 恢复官方登录与会话 → 重新开启 Codex',
      'Completed: Close Codex → Restore official login and sessions → Reopen Codex',
    ))
    await loadWorkspace('codex', profileId)
  }

  const createBackup = async () => {
    const result = await run(`backup-${activeClient}`, () => api.createClientConfigBackup(activeClient, activeProfileId))
    if (!result) return
    setNotice(t(
      `${meta.name} 已备份 ${result.backups.length} 个配置文件，可随时一键恢复`,
      `${meta.name} backed up ${result.backups.length} configuration ${result.backups.length === 1 ? 'file' : 'files'} for one-click recovery`,
    ))
    await loadWorkspace(activeClient, activeProfileId)
  }

  const undoDrafts = () => {
    if (!editor) return
    const drafts = resetClientConfigDrafts(editor, 'current')
    setFieldDrafts(drafts.fieldDrafts)
    setFileDrafts(drafts.fileDrafts)
    setActiveField(null)
    setNotice(t('已撤销本页尚未保存的更改', 'Unsaved changes on this page were reverted'))
  }

  const saveProfile = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!profile) return
    const result = await run('save-profile', () => api.saveClientProfile({
      id: profile.isDefault ? undefined : profile.id,
      name: profile.name.trim(),
      client: profile.client,
      directory: profile.directory?.trim() || undefined,
      backupRetention: profile.backupRetention,
    }))
    if (!result) return
    const saved = profile.id
      ? result.clientProfiles.find((candidate) => candidate.id === profile.id)
      : result.clientProfiles
        .filter((candidate) => candidate.client === profile.client && !candidate.isDefault)
        .sort((left, right) => right.updatedAt - left.updatedAt)[0]
    setProfile(null)
    setNotice(t('配置 Profile 已保存', 'Configuration profile saved'))
    if (saved) commitContextSwitch(saved.client, saved.id)
  }

  const editProfile = () => {
    if (selectedProfile && !selectedProfile.isDefault) setProfile({ ...selectedProfile })
  }

  const deleteProfile = async () => {
    if (!deleteProfileTarget) return
    const target = deleteProfileTarget
    const result = await run(`delete-profile-${target.client}`, () => api.deleteClientProfile(target.id))
    if (!result) return
    setDeleteProfileTarget(null)
    commitContextSwitch(target.client, `default-${target.client}`)
    setNotice(t(`${target.name} Profile 已删除`, `${target.name} profile deleted`))
  }

  const exportProfile = async () => {
    if (!selectedProfile) return
    const bundle = await run(`export-${activeClient}`, () => api.exportClientProfile(selectedProfile.id))
    if (!bundle) return
    setProfileBundleMode('export')
    setProfileBundle(JSON.stringify(bundle, null, 2))
  }

  const openProfileImport = () => {
    setProfileBundleMode('import')
    setProfileBundle('')
  }

  const chooseProfileDirectory = async () => {
    if (!profile) return
    const directory = await run('choose-profile-directory', () => api.chooseClientConfigDirectory(profile.client, profile.directory))
    if (directory) setProfile({ ...profile, directory })
  }

  const importProfile = async () => {
    let parsed: ProfileBundle
    try {
      parsed = JSON.parse(profileBundle) as ProfileBundle
    } catch {
      setError(t('Profile JSON 无法解析', 'Unable to parse the profile JSON'))
      return
    }
    const result = await run('import-profile', () => api.importClientProfile(parsed))
    if (!result) return
    setProfileBundle('__closed__')
    setNotice(t('Profile 已导入，可在顶部列表中快速切换', 'Profile imported; you can switch to it from the list at the top'))
  }

  const copyPreview = async () => {
    if (!activeDocument?.content) return
    await navigator.clipboard?.writeText(activeDocument.content)
    setNotice(t(
      `${roleLabel(activeDocument.role, language)} 已复制`,
      `${roleLabel(activeDocument.role, language)} copied`,
    ))
  }

  const selectPreviewLine = (lineNumber: number) => {
    if (!workbench || !activeDocument) return
    const match = Object.entries(workbench.fieldLocations).find(([, location]) => (
      location.role === activeDocument.role
      && location.startLine !== undefined
      && lineNumber >= location.startLine
      && lineNumber <= (location.endLine ?? location.startLine)
    ))
    if (!match) return
    setActiveField(match[0])
    window.setTimeout(() => document.getElementById(`client-field-${safeDomId(match[0])}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0)
  }

  const gatewayHost = snapshot.gateway.host.includes(':') ? `[${snapshot.gateway.host}]` : snapshot.gateway.host
  const gatewayAddress = `http://${gatewayHost}:${snapshot.gateway.port}`
  const routeHealthy = Boolean(route?.enabled && route.localToken && routeCompatible && resolvedRouteSource && currentSourceAvailable)
  const connectionReady = configHealth === 'healthy' && routeHealthy && snapshot.gatewayStatus.running
  const connectionSummary = configHealth === 'checking'
    ? t('正在检查连接', 'Checking connection')
    : connectionReady
      ? t('已经可以使用', 'Ready to use')
      : configHealth === 'needs-repair'
        ? t('点击下方修复', 'Repair below')
        : configHealth === 'blocked'
          ? t('先处理内部路由', 'Set up the internal route first')
          : t('还有一项需要处理', 'One item still needs attention')

  return (
    <div className="page-stack client-manager-page">
      <div className="client-manager-tabbar">
        <nav className="client-manager-tabs" role="tablist" aria-label={t('客户端类型', 'Client type')}>
          {clientOrder.map((client) => {
            const item = clientMeta[client]
            return (
              <button
                type="button"
                role="tab"
                aria-selected={activeClient === client}
                className={activeClient === client ? 'active' : ''}
                disabled={Boolean(busy)}
                onClick={() => requestContextSwitch(client)}
                key={client}
              >
                <img className="client-manager-tabs__icon" src={item.icon} alt="" />
                <span className="client-manager-tabs__label">{item.name}</span>
              </button>
            )
          })}
        </nav>
      </div>

      {error && <div className="error-banner client-config-message" role="alert"><div><AlertTriangle size={16} /><span>{error}</span></div></div>}
      {notice && <div className="client-easy-toast" role="status"><CheckCircle2 size={16} /><span>{notice}</span></div>}

      <section className={`client-easy-card ${connectionReady ? 'is-ready' : ''}`}>
        <header className="client-easy-card__header">
          <div className="client-easy-identity">
            <span className="client-logo client-easy-identity__icon"><img src={meta.icon} alt="" /></span>
            <div>
              <div><strong>{meta.name}</strong><Badge tone={connectionReady ? 'success' : configHealth === 'invalid' ? 'danger' : configHealth === 'needs-repair' ? 'warning' : 'neutral'}>{connectionSummary}</Badge></div>
              <span>{status?.directory ?? selectedProfile?.directory ?? t('默认配置目录', 'Default configuration directory')}</span>
            </div>
          </div>
          <button
            className="icon-button client-manager-refresh"
            type="button"
            disabled={Boolean(busy) || isDirty}
            aria-label={t('重新检查', 'Check again')}
            title={isDirty
              ? t('请先保存或撤销高级设置中的更改', 'Save or revert the changes in Advanced settings first')
              : t('重新检查连接', 'Check the connection again')}
            onClick={() => void loadWorkspace(activeClient, activeProfileId, true)}
          >
            <RefreshCw size={16} className={busy?.startsWith('workspace-') ? 'spin' : undefined} />
          </button>
        </header>

        <div className="client-easy-route">
          <label className="client-easy-source" htmlFor="client-upstream-select">
            <span>{t('当前上游', 'Current upstream')}</span>
            <select
              id="client-upstream-select"
              aria-label={t('当前上游', 'Current upstream')}
              value={routeSelection}
              disabled={!route || Boolean(busy)}
              onChange={(event) => void switchUpstream(event.target.value)}
            >
              {!routeSelection && <option value="">{t('请选择上游', 'Select an upstream')}</option>}
              {routeSelection && !routeSources.some((source) => source.id === routeSelection) && (
                <option value={routeSelection}>{t('当前来源不可用', 'Current source unavailable')}</option>
              )}
              {routeSources.map((source) => (
                <option value={source.id} key={source.id}>
                  {setupPoolDisplayName(source.name, t)} · {sourceKindLabel(source.kind, language)} · {t(
                    `${source.accountCount} 个账号`,
                    `${source.accountCount} ${source.accountCount === 1 ? 'account' : 'accounts'}`,
                  )}{availableRouteSources.some((candidate) => candidate.id === source.id) ? '' : t('（暂不可用）', ' (temporarily unavailable)')}
                </option>
              ))}
            </select>
          </label>

          <div className="client-easy-route__arrow" aria-hidden="true"><span>→</span></div>

          <div className="client-easy-gateway">
            <span>{t('客户端固定连接', 'Fixed client connection')}</span>
            <strong>{t('Stone+ 本地网关', 'Stone+ local gateway')}</strong>
            <code>{gatewayAddress}</code>
          </div>
        </div>

        {activeClient === 'codex' && (
          <div className="client-easy-setting" data-testid="codex-agent-limit-setting">
            <label htmlFor="client-codex-agent-limit">
              <strong>{t('子代理上限', 'Subagent limit')}</strong>
              <InfoTip text={t(
                '限制同一 Codex 会话可同时运行的子代理数量，不包含主任务。调高会增加并行能力，也会增加额度和系统资源占用；留空跟随 Codex 默认值。',
                'Limits the number of subagents that can run concurrently in one Codex session, excluding the primary task. Higher values increase parallelism, usage, and system resource consumption. Leave blank to use the Codex default.',
              )} />
            </label>
            <div className="client-easy-setting__control">
              <input
                id="client-codex-agent-limit"
                type="number"
                min={1}
                max={64}
                step={1}
                value={typeof codexAgentLimitValue === 'number' ? codexAgentLimitValue : ''}
                placeholder={t('默认', 'Default')}
                aria-invalid={!codexAgentLimitValid}
                disabled={!codexAgentLimitField || Boolean(busy)}
                onChange={(event) => {
                  const value = event.target.value === '' ? null : Number(event.target.value)
                  setFieldDrafts((current) => ({ ...current, 'codex.agentsMaxThreads': value }))
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void saveCodexAgentLimit()
                }}
              />
              <span>{t('个', 'agents')}</span>
              <button
                className="text-button"
                type="button"
                disabled={!codexAgentLimitField || Boolean(busy) || codexAgentLimitValue === null}
                onClick={() => setFieldDrafts((current) => ({ ...current, 'codex.agentsMaxThreads': null }))}
              >
                {t('默认', 'Default')}
              </button>
              <button
                className="button button--secondary client-easy-setting__save"
                type="button"
                disabled={Boolean(busy) || !codexAgentLimitDirty || !codexAgentLimitValid || hasOtherEditorChanges}
                title={hasOtherEditorChanges
                  ? t('请先保存或撤销高级设置中的其他更改', 'Save or revert the other changes in Advanced settings first')
                  : !codexAgentLimitValid
                    ? t('请输入 1 到 64 之间的整数', 'Enter an integer from 1 to 64')
                    : t('保存到当前 Codex 配置目录', 'Save to the current Codex configuration profile')}
                onClick={() => void saveCodexAgentLimit()}
              >
                {busy === 'save-codex-agent-limit' ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}
                {t('保存', 'Save')}
              </button>
            </div>
          </div>
        )}

        <div className="client-easy-status" aria-label={t('连接状态', 'Connection status')}>
          <div className={`client-easy-status__item ${configHealth === 'healthy' ? 'is-ok' : configHealth === 'invalid' ? 'is-bad' : 'is-warn'}`}>
            {configHealth === 'checking'
              ? <LoaderCircle size={17} className="spin" />
              : configHealth === 'healthy'
                ? <CheckCircle2 size={17} />
                : <AlertTriangle size={17} />}
            <span><small>{t('配置文件', 'Configuration files')}</small><strong>{configHealth === 'checking'
              ? t('检查中', 'Checking')
              : configHealth === 'healthy'
                ? t('连接配置正常', 'Connection configuration is valid')
                : configHealth === 'needs-repair'
                  ? t('连接需要修复', 'Connection needs repair')
                  : configHealth === 'missing'
                    ? t('尚未配置', 'Not configured')
                    : configHealth === 'blocked'
                      ? t('等待路由就绪', 'Waiting for the route')
                      : t('文件已损坏', 'File is damaged')}</strong></span>
          </div>
          <div className={`client-easy-status__item ${routeHealthy ? 'is-ok' : 'is-warn'}`}>
            {routeHealthy ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
            <span><small>{t('内部路由', 'Internal route')}</small><strong>{!route
              ? t('缺少路由', 'Route missing')
              : !routeCompatible
                ? t('协议异常', 'Protocol mismatch')
                : !route.localToken
                  ? t('本地令牌缺失', 'Local token missing')
                  : !route.enabled
                    ? t('尚未启用', 'Not enabled')
                    : !resolvedRouteSource || !currentSourceAvailable
                      ? t('上游不可用', 'Upstream unavailable')
                      : t('运行正常', 'Running normally')}</strong></span>
          </div>
          <div className={`client-easy-status__item ${snapshot.gatewayStatus.running ? 'is-ok' : 'is-warn'}`}>
            {snapshot.gatewayStatus.running ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
            <span><small>{t('本地网关', 'Local gateway')}</small><strong>{snapshot.gatewayStatus.running
              ? t('正在运行', 'Running')
              : t('尚未启动', 'Not started')}</strong></span>
          </div>
        </div>

        {(configHealth === 'invalid' || configHealth === 'needs-repair') && (
          <div className="client-easy-problem" title={configReadError ?? undefined}>
            <AlertTriangle size={17} />
            <span>
              <strong>{configHealth === 'invalid'
                ? t('检测到配置文件异常', 'A configuration file problem was detected')
                : t('客户端仍在使用旧连接配置', 'The client is still using an old connection configuration')}</strong>
              <small>{configHealth === 'invalid'
                ? t('不用手工找错，下面的一键修复会先保存原文件再恢复连接。', 'One-click repair saves the original file before restoring the connection, so you do not need to find the error manually.')
                : t('点击一键修复即可改回 Stone+；模型、MCP 和其他设置会保留。', 'Use one-click repair to reconnect to Stone+. Models, MCP, and other settings are preserved.')}</small>
            </span>
          </div>
        )}

        <footer className="client-easy-actions">
          <button
            className="button button--primary client-easy-repair"
            type="button"
            disabled={Boolean(busy) || isDirty || !routeSelection || !availableRouteSources.some((source) => source.id === routeSelection)}
            title={isDirty
              ? t('请先保存或撤销高级设置中的更改', 'Save or revert the changes in Advanced settings first')
              : t('启用内部路由、启动网关并备份修复客户端配置', 'Enable the internal route, start the gateway, then back up and repair the client configuration')}
            onClick={() => void connectWithOneClick()}
          >
            {busy === `connect-${activeClient}` ? <LoaderCircle size={17} className="spin" /> : <Wrench size={17} />}
            {t('一键连接', 'Connect with one click')}
          </button>
          {!routeHealthy && (
            <button
              className="button button--secondary"
              type="button"
              disabled={Boolean(busy) || isDirty || !routeSelection || !availableRouteSources.some((source) => source.id === routeSelection)}
              onClick={() => void repairInternalRoute()}
            >
              {busy === `repair-route-${activeClient}` ? <LoaderCircle size={16} className="spin" /> : <Wrench size={16} />}
              {t('修复内部路由', 'Repair internal route')}
            </button>
          )}
          {(configHealth === 'invalid' || configHealth === 'needs-repair' || configHealth === 'missing') && (
            <button
              className="button button--secondary"
              type="button"
              disabled={Boolean(busy) || isDirty || !route?.localToken || !routeCompatible}
              title={!route?.localToken || !routeCompatible
                ? t('请先修复内部路由', 'Repair the internal route first')
                : t('备份原文件后只修复 Stone+ 连接项', 'Back up the original files, then repair only the Stone+ connection settings')}
              onClick={() => void repairConnection()}
            >
              {busy === `repair-${activeClient}` ? <LoaderCircle size={16} className="spin" /> : <FileCode2 size={16} />}
              {t('修复配置文件', 'Repair configuration files')}
            </button>
          )}
          {!snapshot.gatewayStatus.running && (
            <button className="button button--secondary" type="button" disabled={Boolean(busy)} onClick={() => void startLocalGateway()}>
              {busy === 'start-client-gateway' ? <LoaderCircle size={16} className="spin" /> : <Wrench size={16} />}{t('启动网关', 'Start gateway')}
            </button>
          )}
          {activeClient === 'codex' && (
            <button
              className="button button--secondary"
              type="button"
              disabled={Boolean(busy) || isDirty}
              title={isDirty
                ? t('请先保存或撤销高级设置中的更改', 'Save or revert the changes in Advanced settings first')
                : t('关闭 Codex，恢复官方登录与会话，再重新开启', 'Close Codex, restore official login and sessions, then reopen it')}
              onClick={() => setOfficialLoginConfirm(true)}
            >
              {busy === 'restore-codex-official-login' ? <LoaderCircle size={16} className="spin" /> : <LogIn size={16} />}
              {t('恢复官方登录', 'Restore official login')}
            </button>
          )}
          {latestBackupGroup && (
            <button
              className="button button--secondary"
              type="button"
              disabled={Boolean(busy) || isDirty}
              onClick={() => setRestoreTarget(latestBackupGroup)}
            >
              <RotateCcw size={16} />{t('恢复最近备份', 'Restore latest backup')}
            </button>
          )}
          <span><ShieldCheck size={14} />{t(
            '一键完成路由、网关与配置修复，不发送真实请求',
            'Completes route, gateway, and configuration repair without sending a real request',
          )}</span>
        </footer>
      </section>

      <ManagedClientInstancesPanel snapshot={snapshot} api={api} />
      <PersistentTaskCenter api={api} />

      <section className={`client-advanced ${advancedOpen ? 'is-open' : ''}`}>
        <button
          className="client-advanced__toggle"
          type="button"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((current) => !current)}
        >
          <span><SlidersHorizontal size={17} /><span><strong>{t('高级设置', 'Advanced settings')}</strong></span></span>
          <ChevronDown size={17} />
        </button>

        {advancedOpen && (
          <div className="client-advanced__body">
            <div className="client-advanced-toolbar">
              <label htmlFor="client-profile-select">
                <span>{t('配置目录', 'Configuration directory')}</span>
                <select id="client-profile-select" value={activeProfileId} onChange={(event) => requestContextSwitch(activeClient, event.target.value)}>
                  {snapshot.clientProfiles.filter((candidate) => candidate.client === activeClient).map((candidate) => (
                    <option value={candidate.id} key={candidate.id}>{candidate.isDefault ? t('默认配置', 'Default Profile') : candidate.name}{candidate.directory ? t(' · 自定义目录', ' · Custom directory') : ''}</option>
                  ))}
                </select>
              </label>
              <div className="client-advanced-toolbar__buttons">
                <button className="icon-button" type="button" title={t('新建配置目录', 'New configuration directory')} aria-label={t('新建配置目录', 'New configuration directory')} onClick={() => setProfile(newProfile(activeClient))}><Plus size={15} /></button>
                {!selectedProfile?.isDefault && <button className="icon-button" type="button" title={t('编辑当前配置目录', 'Edit current configuration directory')} aria-label={t('编辑当前配置目录', 'Edit current configuration directory')} onClick={editProfile}><Pencil size={14} /></button>}
                {!selectedProfile?.isDefault && <button className="icon-button" type="button" title={t('删除当前配置目录', 'Delete current configuration directory')} aria-label={t('删除当前配置目录', 'Delete current configuration directory')} onClick={() => setDeleteProfileTarget(selectedProfile ?? null)}><Trash2 size={14} /></button>}
                <button className="icon-button" type="button" title={t('导出目录定义', 'Export directory definition')} aria-label={t('导出目录定义', 'Export directory definition')} onClick={() => void exportProfile()}><Download size={14} /></button>
                <button className="icon-button" type="button" title={t('导入目录定义', 'Import directory definition')} aria-label={t('导入目录定义', 'Import directory definition')} onClick={openProfileImport}><Upload size={14} /></button>
              </div>
              <span className="client-advanced-toolbar__path">{status?.directory ?? selectedProfile?.directory ?? t('默认配置目录', 'Default configuration directory')}</span>
            </div>

            {!editor ? (
              <div className="client-advanced-unavailable">
                <FolderCog size={23} />
                <div>
                  <strong>{busy?.startsWith('workspace-')
                    ? t('正在读取配置', 'Reading configuration')
                    : t('高级编辑器无法打开', 'Unable to open the advanced editor')}</strong>
                  <span>{busy?.startsWith('workspace-')
                    ? t('请稍候…', 'Please wait…')
                    : configReadError ?? t('可先使用上方连接工具；其他配置文件需手动检查。', 'You can use the connection tools above first; other configuration files need to be checked manually.')}</span>
                </div>
              </div>
            ) : (
              <>
                <div className="client-manager-files" aria-label={t('配置文件', 'Configuration files')}>
                  {editor.files.map((file) => (
                    <button type="button" className={activeEditorRole === file.role ? 'active' : ''} onClick={() => setActiveEditorRole(file.role)} key={file.role}>
                      <FileCode2 size={15} />
                      <span><strong>{roleLabel(file.role, language)}</strong><code>{file.path}</code></span>
                      <Badge tone={file.exists ? 'neutral' : 'info'}>{file.exists ? file.format.toUpperCase() : t('将创建', 'Will be created')}</Badge>
                    </button>
                  ))}
                </div>

                <div className="client-manager-actions">
                  <div>
                    <button className="button button--secondary" type="button" disabled={Boolean(busy) || isDirty || !hasExistingConfig} onClick={() => void createBackup()}><ShieldCheck size={16} />{t('立即备份', 'Back up now')}</button>
                    <button className={`button button--secondary ${showBackups ? 'is-active' : ''}`} type="button" onClick={() => setShowBackups((current) => !current)}><History size={16} />{t('备份记录', 'Backup history')} <span>{backupGroups.length}</span></button>
                  </div>
                  <div>
                    <span className={`client-manager-save-state ${workbench?.hasErrors ? 'is-error' : isDirty ? 'is-dirty' : ''}`}>
                      {workbench?.hasErrors
                        ? t('配置格式有误', 'Invalid configuration format')
                        : isDirty
                          ? t('有未保存更改', 'Unsaved changes')
                          : t('已与磁盘同步', 'Synced with disk')}
                    </span>
                    <button className="button button--secondary" type="button" disabled={!isDirty || Boolean(busy)} onClick={undoDrafts}><Undo2 size={16} />{t('撤销', 'Revert')}</button>
                    <button className="button button--primary" type="button" disabled={!isDirty || Boolean(busy) || workbench?.hasErrors} onClick={() => void saveEditor()}>
                      {busy === `save-editor-${activeClient}` ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />}{t('保存更改', 'Save changes')}
                    </button>
                  </div>
                </div>

                {showBackups && (
                  <section className="client-manager-backups">
                    <header><div><History size={17} /><span><strong>{t('安全备份', 'Safe backups')}</strong></span></div><span>{t(`保留 ${backupGroups.length} 组`, `${backupGroups.length} ${backupGroups.length === 1 ? 'set' : 'sets'} retained`)}</span></header>
                    {backupGroups.length ? (
                      <div className="client-manager-backups__list">
                        {backupGroups.map((group, index) => (
                          <div key={group.groupId}>
                            <FileCode2 size={15} />
                            <span><strong>{group.backups.map((backup) => roleLabel(backup.role, language)).join(' + ')}{index === 0 ? t(' · 最近', ' · Latest') : ''}</strong><small>{formatDateTime(group.createdAt, locale)} · {t(
                              `${group.backups.length} 个文件`,
                              `${group.backups.length} ${group.backups.length === 1 ? 'file' : 'files'}`,
                            )}</small></span>
                            <code>{group.backups[0]?.backupPath}{group.backups.length > 1 ? `  +${group.backups.length - 1}` : ''}</code>
                            <button className="button button--secondary" type="button" disabled={Boolean(busy) || isDirty} onClick={() => setRestoreTarget(group)}><RotateCcw size={14} />{t('整组恢复', 'Restore set')}</button>
                          </div>
                        ))}
                      </div>
                    ) : <div className="client-manager-backups__empty">{t('还没有备份记录。', 'No backups yet.')}</div>}
                  </section>
                )}

                <div className="client-manager-workbench">
                  <section className="client-settings-pane" aria-label={t('可视化设置', 'Visual settings')}>
                    <header className="client-settings-pane__header">
                      <div><SlidersHorizontal size={18} /><span><strong>{t('手动设置', 'Manual settings')}</strong></span></div>
                      <Badge tone="info">{t(`${editor.fields.length} 项`, `${editor.fields.length} ${editor.fields.length === 1 ? 'item' : 'items'}`)}</Badge>
                    </header>
                    <div className="client-settings-tools">
                      <label className="client-settings-search"><Search size={15} /><input value={fieldSearch} onChange={(event) => setFieldSearch(event.target.value)} placeholder={t('搜索配置项', 'Search settings')} /></label>
                      <div className="client-settings-scope" role="group" aria-label={t('设置范围', 'Settings scope')}>
                        {([['basic', t('常用', 'Common')], ['all', t('全部', 'All')], ['advanced', t('高级', 'Advanced')]] as const).map(([value, label]) => (
                          <button type="button" className={fieldScope === value ? 'active' : ''} onClick={() => setFieldScope(value)} key={value}>{label}</button>
                        ))}
                      </div>
                    </div>
                    <div className="client-settings-content">
                      {sections.length ? sections.map((section) => (
                        <section className="client-settings-section" key={section}>
                          <header><h3>{section}</h3><span>{visibleFields.filter((field) => field.section === section).length}</span></header>
                          <div>
                            {visibleFields.filter((field) => field.section === section).map((field) => (
                              <ClientSettingRow
                                field={field}
                                value={draftValue(field, fieldDrafts)}
                                active={activeField === field.id}
                                onActivate={() => selectField(field)}
                                onChange={(value) => {
                                  setFieldDrafts((current) => ({ ...current, [field.id]: value }))
                                  selectField(field)
                                }}
                                onReset={() => {
                                  setFieldDrafts((current) => ({ ...current, [field.id]: cloneValue(field.defaultValue ?? null) }))
                                  selectField(field)
                                }}
                                key={field.id}
                              />
                            ))}
                          </div>
                        </section>
                      )) : <EmptyState icon={<Search size={22} />} title={t('没有匹配的设置', 'No matching settings')} description={t('换个关键词或范围', 'Try another keyword or scope')} />}
                    </div>
                  </section>

                  <aside className="client-preview-pane" aria-label={t('配置预览', 'Configuration preview')}>
                    <header className="client-preview-pane__header">
                      <div><Eye size={18} /><span><strong>{t('配置预览', 'Configuration preview')}</strong><small>{t('敏感值不会显示', 'Sensitive values are not shown')}</small></span></div>
                      <span className="client-preview-live"><i />{t('实时', 'Live')}</span>
                    </header>
                    <div className="client-preview-toolbar">
                      <div className="client-preview-tabs" role="tablist" aria-label={t('预览文件', 'Preview files')}>
                        {workbench?.documents.map((document) => (
                          <button type="button" role="tab" aria-selected={activeDocument?.role === document.role} className={activeDocument?.role === document.role ? 'active' : ''} onClick={() => setActiveEditorRole(document.role)} key={document.role}>
                            {roleLabel(document.role, language)}{document.changed && <i title={t('有更改', 'Changed')} />}
                          </button>
                        ))}
                      </div>
                      <div>
                        <button className={`icon-button ${previewMode === 'preview' ? 'active' : ''}`} type="button" title={t('预览', 'Preview')} onClick={() => setPreviewMode('preview')}><Eye size={14} /></button>
                        <button className={`icon-button ${previewMode === 'source' ? 'active' : ''}`} type="button" title={t('编辑完整文件', 'Edit full file')} disabled={!activeDocument?.editable} onClick={() => setPreviewMode('source')}><Braces size={14} /></button>
                        <button className="icon-button" type="button" title={t('复制', 'Copy')} disabled={!activeDocument?.content} onClick={() => void copyPreview()}><Clipboard size={14} /></button>
                      </div>
                    </div>
                    {activeDocument && (
                      <div className="client-preview-document">
                        <div className="client-preview-document__meta">
                          <code>{activeDocument.path}</code>
                          <div><Badge tone={activeDocument.changed ? 'warning' : 'neutral'}>{activeDocument.changed
                            ? t('待写入', 'Pending write')
                            : t('磁盘版本', 'On-disk version')}</Badge>{activeDocument.protectedValueCount > 0 && <Badge tone="success"><ShieldCheck size={11} />{t('敏感值已保护', 'Sensitive values protected')}</Badge>}</div>
                        </div>
                        {activeDocument.error && <div className="client-preview-error"><AlertTriangle size={15} /><span>{localizeBackendMessage(activeDocument.error, language, t('无法预览配置文件', 'Unable to preview the configuration file.'))}</span></div>}
                        {!activeDocument.editable ? (
                          <div className="client-preview-protected"><ShieldCheck size={28} /><strong>{t('认证文件受保护', 'Authentication file protected')}</strong><span>{t('只检测状态，不读取 Token。', 'Only its status is checked; tokens are never read.')}</span></div>
                        ) : previewMode === 'source' ? (
                          <div className="client-source-mode">
                            <div><Pencil size={14} /><span>{t('专家模式：直接编辑完整文件', 'Expert mode: edit the complete file directly')}</span></div>
                            <textarea className="client-source-editor mono" spellCheck={false} value={activeSourceFile ? fileDrafts[activeSourceFile.role] ?? activeSourceFile.content ?? '' : ''} onChange={(event) => activeSourceFile && setFileDrafts((current) => ({ ...current, [activeSourceFile.role]: event.target.value }))} />
                          </div>
                        ) : (
                          <CodePreview content={activeDocument.content ?? ''} startLine={activeLocation?.role === activeDocument.role ? activeLocation.startLine : undefined} endLine={activeLocation?.role === activeDocument.role ? activeLocation.endLine : undefined} onSelectLine={selectPreviewLine} />
                        )}
                      </div>
                    )}
                  </aside>
                </div>
              </>
            )}
          </div>
        )}
      </section>

      <ConfirmDialog
        open={officialLoginConfirm}
        title={t('恢复 Codex 官方登录', 'Restore official Codex login')}
        message={t(
          '将依次执行：1. 关闭 Codex；2. 备份配置并恢复官方登录与会话；3. 重新开启 Codex。现有官方登录令牌、模型、MCP 和其他设置会保留。继续吗？',
          'This will: 1. close Codex; 2. back up the configuration and restore official login and sessions; 3. reopen Codex. Existing official sign-in tokens, models, MCP, and other settings are preserved. Continue?',
        )}
        confirmLabel={t('开始恢复', 'Start recovery')}
        busy={busy === 'restore-codex-official-login'}
        onCancel={() => setOfficialLoginConfirm(false)}
        onConfirm={() => void restoreOfficialLogin()}
      />

      <ConfirmDialog
        open={Boolean(restoreTarget)}
        title={t('恢复客户端配置', 'Restore client configuration')}
        message={restoreTarget ? t(
          `恢复到 ${formatDateTime(restoreTarget.createdAt, locale)} 的版本吗？恢复前会先把当前配置再次备份。`,
          `Restore the version from ${formatDateTime(restoreTarget.createdAt, locale)}? The current configuration will be backed up first.`,
        ) : ''}
        confirmLabel={t('恢复', 'Restore')}
        busy={Boolean(restoreTarget && busy === `restore-${activeClient}`)}
        onCancel={() => setRestoreTarget(null)}
        onConfirm={() => void restore()}
      />

      <ConfirmDialog
        open={Boolean(deleteProfileTarget)}
        title={t('删除配置目录', 'Delete configuration directory')}
        message={deleteProfileTarget ? t(
          `删除“${deleteProfileTarget.name}”吗？磁盘上的配置文件不会被删除。`,
          `Delete “${deleteProfileTarget.name}”? Configuration files on disk will not be deleted.`,
        ) : ''}
        confirmLabel={t('删除', 'Delete')}
        busy={Boolean(deleteProfileTarget && busy === `delete-profile-${deleteProfileTarget.client}`)}
        onCancel={() => setDeleteProfileTarget(null)}
        onConfirm={() => void deleteProfile()}
      />

      <ConfirmDialog
        open={Boolean(pendingSwitch)}
        title={t('放弃未保存更改', 'Discard unsaved changes')}
        message={t('切换客户端或配置目录会丢弃尚未保存的更改。要继续吗？', 'Switching the client or configuration directory will discard unsaved changes. Continue?')}
        confirmLabel={t('放弃并切换', 'Discard and switch')}
        onCancel={() => setPendingSwitch(null)}
        onConfirm={() => pendingSwitch && commitContextSwitch(pendingSwitch.client, pendingSwitch.profileId)}
      />

      <Modal
        open={profileBundleMode === 'export' && profileBundle !== '__closed__'}
        title={t('导出目录定义', 'Export directory definition')}
        description={t('只包含目录和备份策略，不包含配置正文或 Token。', 'Includes only the directory and backup policy, not configuration contents or tokens.')}
        onClose={() => setProfileBundle('__closed__')}
        width="large"
        footer={<><button className="button button--secondary" type="button" onClick={() => setProfileBundle('__closed__')}>{t('关闭', 'Close')}</button><button className="button button--primary" type="button" onClick={() => navigator.clipboard?.writeText(profileBundle)}><Clipboard size={16} />{t('复制 JSON', 'Copy JSON')}</button></>}
      >
        <textarea className="profile-bundle-editor mono" rows={14} readOnly value={profileBundle} />
      </Modal>

      <Modal
        open={profileBundleMode === 'import' && profileBundle !== '__closed__'}
        title={t('导入目录定义', 'Import directory definition')}
        description={t('粘贴 Stone+ 导出的目录定义 JSON；不会导入配置正文或 Token。', 'Paste a directory definition JSON exported by Stone+. Configuration contents and tokens are not imported.')}
        onClose={() => setProfileBundle('__closed__')}
        width="large"
        footer={<><button className="button button--secondary" type="button" onClick={() => setProfileBundle('__closed__')}>{t('取消', 'Cancel')}</button><button className="button button--primary" type="button" disabled={!profileBundle.trim() || profileBundle === '__closed__'} onClick={() => void importProfile()}><Upload size={16} />{t('导入', 'Import')}</button></>}
      >
        <textarea className="profile-bundle-editor mono" rows={14} value={profileBundle === '__closed__' ? '' : profileBundle} onChange={(event) => setProfileBundle(event.target.value)} placeholder={t('粘贴目录定义 JSON', 'Paste directory definition JSON')} />
      </Modal>

      <Modal
        open={Boolean(profile)}
        title={profile?.id ? t('编辑配置目录', 'Edit configuration directory') : t('新建配置目录', 'New configuration directory')}
        description={t('只有便携版、多用户或多套配置时才需要', 'Only needed for portable installations, multiple users, or multiple configurations')}
        onClose={() => setProfile(null)}
        width="medium"
        footer={<><button className="button button--secondary" type="button" onClick={() => setProfile(null)}>{t('取消', 'Cancel')}</button><button className="button button--primary" type="submit" form="client-profile-form" disabled={busy === 'save-profile'}><Save size={16} />{t('保存', 'Save')}</button></>}
      >
        {profile && <form id="client-profile-form" className="form-grid" onSubmit={(event) => void saveProfile(event)}>
          <label className="field"><span>{t('客户端', 'Client')}</span><select value={profile.client} disabled={Boolean(profile.id)} onChange={(event) => setProfile({ ...profile, client: event.target.value as RouteClient })}><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="gemini">Gemini CLI</option></select></label>
          <label className="field"><span>{t('名称', 'Name')}</span><input required value={profile.name} onChange={(event) => setProfile({ ...profile, name: event.target.value })} placeholder={t('例如：工作配置', 'For example: Work configuration')} /></label>
          <label className="field field--full">
            <span>{t('配置目录', 'Configuration directory')}</span>
            <div className="client-profile-directory-picker">
              <input className="mono" value={profile.directory ?? ''} onChange={(event) => setProfile({ ...profile, directory: event.target.value })} placeholder={t('留空使用默认目录', 'Leave blank to use the default directory')} />
              <button className="button button--secondary" type="button" disabled={busy === 'choose-profile-directory'} onClick={() => void chooseProfileDirectory()}>
                {busy === 'choose-profile-directory' ? <LoaderCircle size={15} className="spin" /> : <FolderCog size={15} />}
                {t('选择目录', 'Choose folder')}
              </button>
            </div>
          </label>
          <label className="field"><span>{t('保留备份组数', 'Backup sets to retain')}</span><input type="number" min={1} max={100} value={profile.backupRetention} onChange={(event) => setProfile({ ...profile, backupRetention: Number(event.target.value) })} /></label>
        </form>}
      </Modal>
    </div>
  )
}

function ClientSettingRow({
  field,
  value,
  active,
  onActivate,
  onChange,
  onReset,
}: {
  field: ClientConfigEditorField
  value: ClientConfigFieldValue
  active: boolean
  onActivate: () => void
  onChange: (value: ClientConfigFieldValue) => void
  onReset: () => void
}) {
  const { language, t } = useI18n()
  const guide = getClientConfigFieldGuide(field, language)
  const description = field.description || guide?.description || t(
    `${field.label} 的客户端配置项。`,
    `${field.label} is a client configuration setting.`,
  )
  const optionHelp = guide?.optionHelp
  const currentIsDefault = value === null
  const isRecommended = field.recommendedValue !== undefined && sameConfigValue(value, field.recommendedValue)

  return (
    <article
      id={`client-field-${safeDomId(field.id)}`}
      className={`client-setting-row ${active ? 'is-active' : ''} ${field.readOnly ? 'is-readonly' : ''}`}
      onClick={onActivate}
    >
      <div className="client-setting-row__intro">
        <div>
          <label htmlFor={`client-control-${safeDomId(field.id)}`}>{field.label}</label>
          {field.advanced && <Badge tone="neutral">{t('高级', 'Advanced')}</Badge>}
          {field.managedByStone && <Badge tone="info">{t('Stone+ 管理', 'Stone+ managed')}</Badge>}
          {field.readOnly && <Badge tone="neutral">{t('仅查看', 'Read only')}</Badge>}
          {isRecommended && <Badge tone="success">{t('推荐', 'Recommended')}</Badge>}
        </div>
        <p>{description}</p>
        <button className="client-setting-path" type="button" onClick={onActivate} title={t('在右侧预览中定位', 'Locate in the preview on the right')}><FileCode2 size={12} /><code>{field.path.join('.')}</code></button>
      </div>

      <div className="client-setting-row__input" onClick={(event) => event.stopPropagation()}>
        {field.readOnly ? (
          <div className="client-setting-readonly"><code>{formatFieldValue(value, language)}</code><span>{field.sensitive
            ? t('敏感值已隐藏', 'Sensitive value hidden')
            : t('可在右侧完整文件中查看', 'View it in the complete file on the right')}</span></div>
        ) : field.control === 'toggle' ? (
          <div className="client-setting-toggle"><span>{value === true
            ? t('已开启', 'On')
            : value === false
              ? t('已关闭', 'Off')
              : t('跟随默认', 'Use default')}</span><Toggle checked={value === true} onChange={onChange} label={field.label} /></div>
        ) : field.control === 'select' ? (
          <select id={`client-control-${safeDomId(field.id)}`} value={typeof value === 'string' ? value : ''} onFocus={onActivate} onChange={(event) => onChange(event.target.value || null)}>
            <option value="">{guide?.defaultLabel ?? t('跟随客户端默认值', 'Use the client default')}</option>
            {field.options?.map((item) => <option value={item.value} key={item.value}>{item.label}{item.recommended ? t('（推荐）', ' (recommended)') : ''}</option>)}
          </select>
        ) : field.control === 'string-list' ? (
          <textarea id={`client-control-${safeDomId(field.id)}`} className="mono" rows={3} value={Array.isArray(value) ? value.join('\n') : ''} placeholder={t('每行一项；留空使用默认值', 'One item per line; leave blank to use the default')} onFocus={onActivate} onChange={(event) => onChange(event.target.value ? event.target.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) : null)} />
        ) : field.control === 'number' ? (
          <input id={`client-control-${safeDomId(field.id)}`} type="number" min={field.min} max={field.max} step={field.step} value={typeof value === 'number' ? value : ''} placeholder={field.placeholder ?? t('留空使用默认值', 'Leave blank to use the default')} onFocus={onActivate} onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))} />
        ) : (
          <input id={`client-control-${safeDomId(field.id)}`} value={typeof value === 'string' ? value : ''} placeholder={field.placeholder ?? t('留空使用默认值', 'Leave blank to use the default')} onFocus={onActivate} onChange={(event) => onChange(event.target.value || null)} />
        )}

        <div className="client-setting-row__choices">
          <span>{choiceSummary(field, guide?.defaultLabel, language)}</span>
          <button className="text-button" type="button" disabled={field.readOnly || currentIsDefault} onClick={onReset}><RotateCcw size={12} />{t('默认', 'Default')}</button>
        </div>

        {field.options && field.options.length > 0 && (
          <div className="client-setting-options">
            {field.options.map((item) => (
              <span className={value === item.value ? 'active' : ''} title={item.description ?? optionHelp?.[item.value]} key={item.value}>
                <strong>{item.label}</strong>{item.description ?? optionHelp?.[item.value] ? ` · ${item.description ?? optionHelp?.[item.value]}` : ''}
              </span>
            ))}
          </div>
        )}
      </div>
    </article>
  )
}

function CodePreview({
  content,
  startLine,
  endLine,
  onSelectLine,
}: {
  content: string
  startLine?: number
  endLine?: number
  onSelectLine: (line: number) => void
}) {
  const { t } = useI18n()
  const lines = content.split(/\r?\n/)
  return (
    <div className="client-code-preview mono" role="region" aria-label={t('配置文件内容', 'Configuration file contents')}>
      {lines.map((line, index) => {
        const lineNumber = index + 1
        const highlighted = startLine !== undefined && lineNumber >= startLine && lineNumber <= (endLine ?? startLine)
        return (
          <button type="button" className={highlighted ? 'is-highlighted' : ''} onClick={() => onSelectLine(lineNumber)} key={`${lineNumber}-${line}`}>
            <span>{lineNumber}</span><code>{line || ' '}</code>
          </button>
        )
      })}
    </div>
  )
}

function newProfile(client: RouteClient): ClientConfigProfile {
  return {
    id: '',
    name: '',
    client,
    backupRetention: 10,
    isDefault: false,
    createdAt: 0,
    updatedAt: 0,
  }
}

function preferredRole(editor: ClientConfigEditorState): ClientConfigFileRole | null {
  const preferred: Record<RouteClient, ClientConfigFileRole> = {
    claude: 'claude-settings',
    codex: 'codex-config',
    gemini: 'gemini-settings',
  }
  return editor.files.find((file) => file.role === preferred[editor.client])?.role
    ?? editor.files.find((file) => file.editable)?.role
    ?? editor.files[0]?.role
    ?? null
}

function draftValue(field: ClientConfigEditorField, drafts: ClientConfigFieldDrafts): ClientConfigFieldValue {
  return Object.prototype.hasOwnProperty.call(drafts, field.id) ? drafts[field.id] : field.value
}

function sameConfigValue(left: ClientConfigFieldValue, right: ClientConfigFieldValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function cloneValue(value: ClientConfigFieldValue): ClientConfigFieldValue {
  return Array.isArray(value) ? [...value] : value
}

function formatFieldValue(value: ClientConfigFieldValue, language: UiLanguage): string {
  if (value === null) return language === 'zh-CN' ? '未设置' : 'Not set'
  if (Array.isArray(value)) return value.join(', ') || (language === 'zh-CN' ? '空列表' : 'Empty list')
  return String(value)
}

function choiceSummary(field: ClientConfigEditorField, defaultLabel: string | undefined, language: UiLanguage): string {
  if (field.readOnly) return language === 'zh-CN'
    ? '从当前文件识别；请使用完整文件编辑器修改'
    : 'Detected in the current file; use the full-file editor to change it'
  if (field.control === 'select') return language === 'zh-CN'
    ? `可选：${field.options?.map((item) => item.label).join(' / ') || '客户端默认'}，或${defaultLabel ?? '跟随默认值'}`
    : `Choose ${field.options?.map((item) => item.label).join(' / ') || 'the client default'}, or ${defaultLabel ?? 'use the default'}`
  if (field.control === 'toggle') return language === 'zh-CN'
    ? '可选：开启 / 关闭 / 跟随客户端默认值'
    : 'Choose on, off, or the client default'
  if (field.control === 'string-list') return language === 'zh-CN'
    ? '可选：每行一项；留空时不写入该配置键'
    : 'Optional: one item per line; leave blank to omit this setting'
  if (field.control === 'number') {
    const range = field.min !== undefined || field.max !== undefined
      ? language === 'zh-CN'
        ? `（${field.min ?? '不限'} ～ ${field.max ?? '不限'}）`
        : ` (${field.min ?? 'no minimum'} to ${field.max ?? 'no maximum'})`
      : ''
    return language === 'zh-CN'
      ? `可选：自定义数值${range}，或留空跟随默认值`
      : `Optional: enter a custom number${range}, or leave blank to use the default`
  }

  return language === 'zh-CN'
    ? '可选：自定义值，或留空跟随客户端默认值'
    : 'Optional: enter a custom value, or leave blank to use the client default'
}

function groupClientBackups(backups: ClientConfigBackup[]): ClientBackupGroup[] {
  const grouped = new Map<string, ClientBackupGroup>()
  for (const backup of backups) {
    const groupId = backup.groupId || `${backup.createdAt}:${backup.backupPath}`
    const group = grouped.get(groupId)
    if (group) group.backups.push(backup)
    else grouped.set(groupId, { groupId, createdAt: backup.createdAt, backups: [backup] })
  }
  return [...grouped.values()].sort((left, right) => right.createdAt - left.createdAt || right.groupId.localeCompare(left.groupId))
}

function safeDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-')
}

function sourceKindLabel(kind: string, language: UiLanguage): string {
  if (kind === 'official-api') return language === 'zh-CN' ? '官方 API' : 'Official API'
  if (kind === 'relay') return language === 'zh-CN' ? '中转站' : 'Relay'
  if (kind === 'relay-aggregate') return language === 'zh-CN' ? '聚合中转' : 'Aggregate relay'
  return language === 'zh-CN' ? '号池' : 'Account pool'
}

function errorMessage(cause: unknown, fallback: string, language: UiLanguage): string {
  if (!(cause instanceof Error) || !cause.message.trim()) return fallback
  if (language === 'en' && /[\u3400-\u9fff]/u.test(cause.message)) return fallback
  return cause.message
}

function isClientTargetError(message: string): boolean {
  return /route does not exist|has no local token|native client protocol|路由不存在|本地令牌|入站协议/i.test(message)
}
