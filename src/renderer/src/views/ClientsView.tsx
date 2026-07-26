import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Braces,
  ChevronDown,
  CheckCircle2,
  Clipboard,
  Code2,
  Download,
  Eye,
  ExternalLink,
  FileCode2,
  FolderCog,
  History,
  LoaderCircle,
  LogIn,
  Monitor,
  Pencil,
  Plus,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
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
import type { AgentLifecycleSnapshot, AgentTarget } from '@shared/agent-lifecycle'
import { clientNativeProtocols } from '@shared/types'
import { enumerateRouteSourceModels, listRouteSourcesForClient, resolveRouteSource } from '@shared/route-sources'
import {
  buildClientConfigWorkbenchPreview,
  clientRouteSelectionDisabled,
  clientSettingOptionClassName,
  createInitialClientConfigDrafts,
  getClientConfigFieldGuide,
  isClientConfigWorkbenchDirty,
  localizeClientConfigEditorField,
  oneClickAgentRuntimeAction,
  oneClickRouteModelMap,
  oneClickRouteNeedsUpdate,
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
import { agentActionBlockReason, localizedLifecycleError } from '../agent-lifecycle-control'
import { ExclusiveAsyncOperation } from '../async-operation'
import { agentLifecycleRenderKey } from '../app-render-state'
import { shouldAcceptSnapshotRevision } from '../runtime-delta'

const clientOrder: RouteClient[] = ['claude', 'codex', 'gemini', 'grokbuild']

interface AgentInstallMeta {
  name: string
  client: RouteClient
  surface: 'desktop' | 'terminal' | 'extension'
  launchOnly?: boolean
  channel: readonly [chinese: string, english: string]
  detection: readonly [chinese: string, english: string]
  configuration: readonly [chinese: string, english: string]
  installAction: readonly [chinese: string, english: string]
}

const agentInstallMeta: Record<AgentTarget, AgentInstallMeta> = {
  'codex-desktop': {
    name: 'ChatGPT Desktop',
    client: 'codex',
    surface: 'desktop',
    channel: ['OpenAI 官方获取页面', 'Official OpenAI download page'],
    detection: ['自动检测 Windows 应用安装与运行状态', 'Automatically checks Windows app installation and running state'],
    configuration: ['Stone+ 自动维护 Codex 连接配置。', 'Stone+ manages the Codex connection automatically.'],
    installAction: ['打开官方下载', 'Open download page'],
  },
  'codex-cli': {
    name: 'Codex CLI',
    client: 'codex',
    surface: 'terminal',
    channel: ['官方安装指引', 'Official installation guide'],
    detection: ['自动检查标准安装位置与 PATH', 'Automatically checks standard install locations and PATH'],
    configuration: ['Stone+ 自动维护 CLI 连接配置。', 'Stone+ manages the CLI connection automatically.'],
    installAction: ['打开官方指引', 'Open official guide'],
  },
  'claude-code': {
    name: 'Claude Code CLI',
    client: 'claude',
    surface: 'terminal',
    channel: ['官方安装指引', 'Official installation guide'],
    detection: ['自动检查标准安装位置与 PATH', 'Automatically checks standard install locations and PATH'],
    configuration: ['Stone+ 自动维护共享的 Claude Code CLI 连接配置。', 'Stone+ manages the shared Claude Code CLI connection automatically.'],
    installAction: ['打开官方指引', 'Open official guide'],
  },
  'claude-code-desktop': {
    name: 'Claude Code Desktop',
    client: 'claude',
    surface: 'desktop',
    launchOnly: true,
    channel: ['Claude 官方下载页', 'Official Claude download page'],
    detection: ['自动检测 Claude Desktop 安装；不接管桌面应用进程', 'Detects Claude Desktop without taking control of its process'],
    configuration: ['接管时自动允许 Cowork 访问任意网络主机并隐藏官方模式选择器；该配置影响 Chat、Cowork 和 Code，完整退出并重开 Claude Desktop 后生效。Stone+ 不会结束宿主进程。', 'When taking over, Stone+ automatically allows Cowork to access any network host and hides the official mode chooser. The settings affect Chat, Cowork, and Code and take effect after fully quitting and reopening Claude Desktop. Stone+ does not close the host app.'],
    installAction: ['打开官方下载页', 'Open official download page'],
  },
  'claude-code-vsc': {
    name: 'Claude Code VSC',
    client: 'claude',
    surface: 'extension',
    launchOnly: true,
    channel: ['Visual Studio Marketplace', 'Visual Studio Marketplace'],
    detection: ['自动检测官方 anthropic.claude-code 扩展', 'Detects the official anthropic.claude-code extension'],
    configuration: ['打开时自动写入扩展连接配置；Stone+ 不会关闭或重启 VS Code。', 'Writes the extension connection automatically when opened; Stone+ never closes or restarts VS Code.'],
    installAction: ['打开扩展市场', 'Open extension marketplace'],
  },
  'gemini-cli': {
    name: 'Gemini CLI',
    client: 'gemini',
    surface: 'terminal',
    channel: ['官方安装指引', 'Official installation guide'],
    detection: ['自动检查标准安装位置与 PATH', 'Automatically checks standard install locations and PATH'],
    configuration: ['Stone+ 自动维护 CLI 连接配置。', 'Stone+ manages the CLI connection automatically.'],
    installAction: ['打开官方指引', 'Open official guide'],
  },
  'grok-build': {
    name: 'Grok Build',
    client: 'grokbuild',
    surface: 'terminal',
    channel: ['xAI 官方安装指引', 'Official xAI installation guide'],
    detection: ['自动检查 ~/.grok/bin、标准安装位置与 PATH', 'Automatically checks ~/.grok/bin, standard install locations, and PATH'],
    configuration: ['Stone+ 自动维护 Grok Build 连接配置。', 'Stone+ manages the Grok Build connection automatically.'],
    installAction: ['打开官方指引', 'Open official guide'],
  },
}

const clientAgentTargets: Record<RouteClient, readonly AgentTarget[]> = {
  codex: ['codex-desktop', 'codex-cli'],
  claude: ['claude-code', 'claude-code-desktop', 'claude-code-vsc'],
  gemini: ['gemini-cli'],
  grokbuild: ['grok-build'],
}

const roleLabels: Record<ClientConfigFileRole, readonly [chinese: string, english: string]> = {
  'claude-settings': ['Claude 设置', 'Claude settings'],
  'claude-mcp': ['Claude MCP', 'Claude MCP'],
  'codex-config': ['Codex 配置', 'Codex configuration'],
  'codex-auth': ['Codex 认证', 'Codex authentication'],
  'gemini-settings': ['Gemini 设置', 'Gemini settings'],
  'gemini-env': ['Gemini 环境变量', 'Gemini environment'],
  'grok-config': ['Grok Build 配置', 'Grok Build configuration'],
}

function roleLabel(role: ClientConfigFileRole, language: UiLanguage): string {
  return roleLabels[role][language === 'zh-CN' ? 0 : 1]
}

function agentSurfaceIcon(surface: AgentInstallMeta['surface']) {
  if (surface === 'desktop') return <Monitor size={11} aria-hidden="true" />
  if (surface === 'extension') return <Code2 size={11} aria-hidden="true" />
  return <Terminal size={11} aria-hidden="true" />
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
  const [claudeDesktopOfficialRestoreConfirm, setClaudeDesktopOfficialRestoreConfirm] = useState(false)
  const [claudeDesktopOfficialRestoreBusy, setClaudeDesktopOfficialRestoreBusy] = useState(false)
  const [codexRestartConfirm, setCodexRestartConfirm] = useState<'editor' | 'agent-limit' | null>(null)
  const [deleteProfileTarget, setDeleteProfileTarget] = useState<ClientConfigProfile | null>(null)
  const [pendingSwitch, setPendingSwitch] = useState<PendingSwitch | null>(null)
  const [busy, setBusy] = useState<string | null>('load')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [agentLifecycle, setAgentLifecycle] = useState<AgentLifecycleSnapshot | null>(null)
  const [agentCheckError, setAgentCheckError] = useState<string | null>(null)
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
    grokbuild: 'default-grokbuild',
  })
  const requestSequence = useRef(0)
  const agentLifecycleRevision = useRef(-1)
  const agentLifecycleRenderState = useRef<string | undefined>(undefined)
  const operationGate = useRef(new ExclusiveAsyncOperation())
  const claudeDesktopOfficialRestoreInFlight = useRef(false)

  const activeProfileId = activeProfiles[activeClient]
  const claudeDesktopOfficialRestoreBlockedByLifecycle = Boolean(agentLifecycle?.busy)
  const claudeDesktopOfficialRestoreDisabled = claudeDesktopOfficialRestoreBusy
    || claudeDesktopOfficialRestoreBlockedByLifecycle
  const claudeDesktopOfficialRestoreLabel = claudeDesktopOfficialRestoreBusy
    ? t('正在恢复 Claude Desktop 官方模式', 'Restoring Claude Desktop official mode')
    : claudeDesktopOfficialRestoreBlockedByLifecycle
      ? t('客户端操作进行中，完成后可恢复 Claude Desktop 官方模式', 'A client operation is in progress. Restore Claude Desktop official mode after it finishes.')
      : t('恢复 Claude Desktop 官方模式', 'Restore Claude Desktop official mode')
  const claudeDesktopOfficialRestoreTitle = claudeDesktopOfficialRestoreBusy
    ? t('正在恢复官方模式，请稍候。', 'Official mode is being restored. Please wait.')
    : claudeDesktopOfficialRestoreBlockedByLifecycle
      ? t('另一项客户端接管、修复或启动操作正在进行；完成后可恢复官方模式。', 'Another client takeover, repair, or launch operation is in progress. Restore official mode after it finishes.')
      : t('移除 Stone+ 写入的第三方推理配置并恢复 Claude Desktop 官方模式。', 'Remove the third-party inference settings written by Stone+ and restore Claude Desktop official mode.')

  const acceptAgentLifecycle = useCallback((next: AgentLifecycleSnapshot) => {
    if (!shouldAcceptSnapshotRevision(agentLifecycleRevision.current, next.revision)) return
    agentLifecycleRevision.current = next.revision
    const renderState = agentLifecycleRenderKey(next)
    if (agentLifecycleRenderState.current === renderState) return
    agentLifecycleRenderState.current = renderState
    setAgentLifecycle(next)
  }, [])

  const run = async <T,>(key: string, operation: () => Promise<T>): Promise<T | undefined> => {
    const outcome = await operationGate.current.run(async () => {
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
    })
    return outcome.started ? outcome.value : undefined
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

  const refreshAgents = useCallback(async () => {
    try {
      const next = await api.getAgentLifecycleSnapshot()
      acceptAgentLifecycle(next)
      setAgentCheckError(null)
    } catch (cause) {
      setAgentCheckError(errorMessage(cause, t('无法检测客户端安装状态', 'Unable to check client installation status'), language))
    }
  }, [acceptAgentLifecycle, api, language, t])

  useEffect(() => {
    void refreshAgents()
    return api.onAgentLifecycleChanged((event) => {
      acceptAgentLifecycle(event.snapshot)
      setAgentCheckError(null)
    })
  }, [acceptAgentLifecycle, api, refreshAgents])

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
  const availableRouteSources = useMemo(
    () => listRouteSourcesForClient(activeClient, snapshot),
    [activeClient, snapshot],
  )
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
  const restoreDeletionBackups = restoreTarget?.backups.filter((backup) => backup.existed === false) ?? []
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

  const saveEditor = async (restartCodex = false) => {
    if (!editor) return
    const patches = editor.fields
      .filter((field) => !field.readOnly && !sameConfigValue(field.value, draftValue(field, fieldDrafts)))
      .map((field) => ({ id: field.id, value: draftValue(field, fieldDrafts) }))
    const files = editor.files
      .filter((file) => file.editable && file.content !== undefined && fileDrafts[file.role] !== undefined && fileDrafts[file.role] !== file.content)
      .map((file) => ({ role: file.role, revision: file.revision, content: fileDrafts[file.role] ?? '' }))
    if (editor.client === 'codex' && !restartCodex && (patches.length > 0 || files.length > 0)) {
      setCodexRestartConfirm('editor')
      return
    }
    const result = await run(`save-editor-${editor.client}`, async () => {
      const saved = await api.saveClientConfigEditor({
        client: editor.client,
        profileId: editor.profileId,
        patches,
        files,
      })
      if (restartCodex && saved.changedFiles.length > 0) {
        try {
          await api.repairCodexSessionsAndRestartChatGpt()
        } catch (error) {
          const backupGroupId = saved.backups[0]?.groupId
          if (backupGroupId) {
            await api.restoreClientConfigBackupSet(backupGroupId, 'codex', editor.profileId)
          }
          throw error
        }
      }
      return saved
    })
    if (!result) return
    setCodexRestartConfirm(null)
    const newConversationNotice = result.requiresNewConversation
      ? t('；权限模式已切换为 Auto，请新建会话后使用。旧会话中待确认的工具调用不会自动重放', '; permission mode changed to Auto. Start a new conversation before continuing; pending tool calls from the old conversation are not replayed')
      : ''
    setNotice(result.changedFiles.length
      ? t(
        `${clientMeta[editor.client].name} 已保存 ${result.changedFiles.length} 个文件，并自动创建备份${restartCodex ? '；已完成关闭、修复会话和重新开启' : ''}${newConversationNotice}`,
        `${clientMeta[editor.client].name} saved ${result.changedFiles.length} ${result.changedFiles.length === 1 ? 'file' : 'files'} and created a backup automatically${restartCodex ? '; Codex was closed, its sessions repaired, and reopened' : ''}${newConversationNotice}`,
      )
      : t(
        `${clientMeta[editor.client].name} 配置无需更改`,
        `${clientMeta[editor.client].name} configuration is already up to date`,
      ))
    await loadWorkspace(editor.client, editor.profileId)
  }

  const saveCodexAgentLimit = async (restartCodex = false) => {
    if (!editor || editor.client !== 'codex' || !codexAgentLimitField || !codexAgentLimitDirty
      || !codexAgentLimitValid || hasOtherEditorChanges) return
    const value = codexAgentLimitValue
    if (!restartCodex) {
      setCodexRestartConfirm('agent-limit')
      return
    }
    const result = await run('save-codex-agent-limit', async () => {
      const saved = await api.saveClientConfigEditor({
        client: 'codex',
        profileId: editor.profileId,
        patches: [{ id: codexAgentLimitField.id, value }],
        files: [],
      })
      try {
        await api.repairCodexSessionsAndRestartChatGpt()
      } catch (error) {
        const backupGroupId = saved.backups[0]?.groupId
        if (backupGroupId) {
          await api.restoreClientConfigBackupSet(backupGroupId, 'codex', editor.profileId)
        }
        throw error
      }
      return saved
    })
    if (!result) return
    setCodexRestartConfirm(null)
    setNotice(value === null
      ? t('子代理上限已恢复为 Codex 默认值，并已重开 Codex', 'The subagent limit now follows the Codex default and Codex was reopened')
      : t(`子代理上限已设为 ${value}，并已重开 Codex`, `The subagent limit is now ${value} and Codex was reopened`))
    await loadWorkspace('codex', editor.profileId)
  }

  const repairConnection = async () => {
    const client = activeClient
    const result = await run(`repair-${client}`, () => api.repairClientConfig(client, activeProfileId))
    if (!result) return
    const restartNotice = client === 'grokbuild'
      ? t('；重启 Grok Build 后生效', '; restart Grok Build to apply the change')
      : ''
    setNotice(result.rebuiltRoles.length
      ? t(
        `${meta.name} 已从损坏文件重建，并恢复 Stone+ 连接${restartNotice}`,
        `${meta.name} was rebuilt from the damaged files and reconnected to Stone+${restartNotice}`,
      )
      : t(
        `${meta.name} 已修复连接且保留其他设置${restartNotice}`,
        `${meta.name} connection repaired while preserving the other settings${restartNotice}`,
      ))
    await loadWorkspace(client, activeProfileId)
  }

  const installAgent = async (target: AgentTarget) => {
    const result = await run(`install-${target}`, async () => {
      const operation = await api.installAgent(target)
      acceptAgentLifecycle(operation.snapshot)
      const failure = operation.results.find((item) => item.target === target)?.error
      if (operation.status === 'failed' || failure) throw new Error(failure
        ? localizedLifecycleError(failure, t)
        : t('安装未能完成', 'Installation could not be completed'))
      return operation
    })
    if (!result) return
    setNotice(t(
      `已打开 ${agentInstallMeta[target].name} 官方安装指引；安装完成后请重新检测`,
      `Opened the official ${agentInstallMeta[target].name} installation guide. Check again after installation.`,
    ))
  }

  const startInstalledAgent = async (target: AgentTarget) => {
    const agent = agentLifecycle?.agents[target]
    if (agent) {
      const blockedReason = agentActionBlockReason(agent, Object.values(agentLifecycle.agents), t)
      if (blockedReason) {
        setNotice(null)
        setError(blockedReason)
        return
      }
    }

    const result = await run(`start-${target}`, async () => {
      const operation = await api.startAgent(target)
      acceptAgentLifecycle(operation.snapshot)
      const failure = operation.results.find((item) => item.target === target)?.error
      if (operation.status === 'failed' || failure) throw new Error(failure
        ? localizedLifecycleError(failure, t)
        : t('客户端未能启动', 'The client could not be started'))
      return operation
    })
    if (!result) return
    const itemMeta = agentInstallMeta[target]
    if (target === 'claude-code-desktop') {
      setNotice(!agent?.configured
        ? t(
          'Claude Desktop 配置已写入并已打开 Code；完整退出并重开 Claude Desktop 后生效。Stone+ 不会结束宿主进程。',
          'Claude Desktop settings were written and Code was opened. Fully quit and reopen Claude Desktop to apply them. Stone+ does not close the host app.',
        )
        : t(
          'Claude Desktop Code 已打开；配置影响 Chat、Cowork 和 Code，Stone+ 不会结束宿主进程。',
          'Claude Desktop Code was opened. The settings affect Chat, Cowork, and Code; Stone+ does not close the host app.',
        ))
      return
    }
    setNotice(itemMeta.launchOnly
      ? t(`${itemMeta.name} 已打开`, `${itemMeta.name} opened`)
      : t(`${itemMeta.name} 已启动`, `${itemMeta.name} started`))
  }

  const restoreClaudeDesktopOfficialMode = async () => {
    if (claudeDesktopOfficialRestoreInFlight.current || agentLifecycle?.busy) return
    claudeDesktopOfficialRestoreInFlight.current = true
    setClaudeDesktopOfficialRestoreBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await api.restoreClaudeDesktopOfficialMode()
      setClaudeDesktopOfficialRestoreConfirm(false)
      setNotice(result.changed
        ? t(
          '已仅移除 Stone+ 写入的 Claude Desktop 配置并恢复官方 1P 模式。请完整退出并重开 Claude Desktop 后使用官方模式。',
          'Only the Claude Desktop settings written by Stone+ were removed, and official 1P mode was restored. Fully quit and reopen Claude Desktop before using official mode.',
        )
        : t(
          '未发现 Stone+ 写入的 Claude Desktop 配置，当前已是官方 1P 模式。若应用正在运行，请完整退出并重开以刷新界面。',
          'No Claude Desktop settings written by Stone+ were found; official 1P mode is already active. If the app is running, fully quit and reopen it to refresh the interface.',
        ))
      void refreshAgents()
    } catch (cause) {
      setClaudeDesktopOfficialRestoreConfirm(false)
      setError(errorMessage(
        cause,
        t('Claude Desktop 官方模式恢复失败', 'Could not restore Claude Desktop official mode'),
        language,
      ))
    } finally {
      claudeDesktopOfficialRestoreInFlight.current = false
      setClaudeDesktopOfficialRestoreBusy(false)
    }
  }

  const repairedRouteDraft = (): Route | undefined => {
    if (!routeSelection || !availableRouteSources.some((source) => source.id === routeSelection)) return undefined
    const timestamp = Date.now()
    const selectedSource = resolveRouteSource(routeSelection, snapshot)
    const modelMap = oneClickRouteModelMap(
      route?.modelMap ?? {},
      enumerateRouteSourceModels(selectedSource, snapshot),
    )
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
      modelMap,
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
      const routeUpdated = oneClickRouteNeedsUpdate(route, draft)
      if (routeUpdated) await api.updateRoute(draft)
      if (!snapshot.gatewayStatus.running) await api.startGateway()
      let preflightChanged = true
      try {
        const preview = await api.previewClientConfig(activeClient, activeProfileId)
        preflightChanged = preview.files.some((file) => file.changed)
      } catch {
        // A malformed file is still repairable. The repair call below owns the
        // backup/rebuild behavior and the postflight must become readable.
      }
      const repair = await api.repairClientConfig(activeClient, activeProfileId)
      const verification = await api.previewClientConfig(activeClient, activeProfileId)
      const remaining = verification.files.filter((file) => file.changed).map((file) => file.role)
      if (remaining.length > 0) {
        throw new Error(t(
          `一键连接后仍检测到配置残留：${remaining.join('、')}`,
          `Configuration drift remains after one-click connection: ${remaining.join(', ')}`,
        ))
      }
      const connectionUpdated = routeUpdated || preflightChanged || repair.changedFiles.length > 0
      const restarted: string[] = []
      let unmanagedRunning = false
      if (connectionUpdated) {
        let lifecycle = await api.getAgentLifecycleSnapshot()
        acceptAgentLifecycle(lifecycle)
        for (const target of clientAgentTargets[activeClient]) {
          const agent = lifecycle.agents[target]
          const runtimeAction = oneClickAgentRuntimeAction(agent)
          if (runtimeAction === 'none') continue
          if (runtimeAction === 'manual-restart') {
            unmanagedRunning = true
            continue
          }
          const operation = await api.restartAgent(target)
          acceptAgentLifecycle(operation.snapshot)
          lifecycle = operation.snapshot
          const failure = operation.results.find((item) => item.target === target)?.error
          if (operation.status === 'failed' || failure) {
            throw new Error(failure
              ? localizedLifecycleError(failure, t)
              : t(`${agentInstallMeta[target].name} 未能重启`, `${agentInstallMeta[target].name} could not restart`))
          }
          restarted.push(agentInstallMeta[target].name)
        }
      }
      return {
        repair,
        updated: connectionUpdated,
        restarted,
        unmanagedRunning,
      }
    })
    if (!result) return
    const verified = result.updated
      ? t('已复核并更新旧连接残留', 'Legacy connection residue was checked and updated')
      : t('未发现冲突残留，连接配置已确认', 'No conflicting residue was found; the connection was verified')
    const activation = result.restarted.length > 0
      ? t(`；已自动重启 ${result.restarted.join('、')}`, `; automatically restarted ${result.restarted.join(', ')}`)
      : result.unmanagedRunning
        ? t('；检测到非 Stone+ 托管会话，请手动重启客户端后生效', '; an unmanaged session is running; restart the client manually to apply the change')
        : ''
    setNotice(t(`${meta.name} 已连接到 Stone+；${verified}${activation}`, `${meta.name} is connected to Stone+; ${verified}${activation}`))
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

  const selectUpstream = (sourceId: string) => {
    if (!route) {
      setRouteSelections((current) => ({ ...current, [activeClient]: sourceId }))
      setError(null)
      return
    }
    void switchUpstream(sourceId)
  }

  const restore = async () => {
    if (!restoreTarget) return
    const target = restoreTarget
    const result = await run(`restore-${activeClient}`, () => api.restoreClientConfigBackupSet(target.groupId, activeClient, activeProfileId))
    if (!result) return
    setRestoreTarget(null)
    const deletedFiles = result.deletedFiles
      ?? result.sourceBackups.filter((backup) => backup.existed === false).map((backup) => backup.targetPath)
    const restoredValueCount = result.restoredFiles.length
    setNotice(deletedFiles.length > 0
      ? t(
          `${meta.name} 已恢复 ${restoredValueCount} 个文件快照，并按备份状态删除 ${deletedFiles.length} 个文件 · ${formatDateTime(target.createdAt, locale)}`,
          `${meta.name} restored ${restoredValueCount} file ${restoredValueCount === 1 ? 'snapshot' : 'snapshots'} and deleted ${deletedFiles.length} ${deletedFiles.length === 1 ? 'file' : 'files'} to match the backup · ${formatDateTime(target.createdAt, locale)}`,
        )
      : t(
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
    const deletionMarkers = result.backups.filter((backup) => backup.existed === false).length
    const valueSnapshots = result.backups.length - deletionMarkers
    setNotice(deletionMarkers > 0
      ? t(
          `${meta.name} 已保存 ${valueSnapshots} 个文件快照和 ${deletionMarkers} 个“不存在”标记，可精确恢复`,
          `${meta.name} saved ${valueSnapshots} file ${valueSnapshots === 1 ? 'snapshot' : 'snapshots'} and ${deletionMarkers} absence ${deletionMarkers === 1 ? 'marker' : 'markers'} for an exact restore`,
        )
      : t(
          `${meta.name} 已备份 ${valueSnapshots} 个配置文件，可随时一键恢复`,
          `${meta.name} backed up ${valueSnapshots} configuration ${valueSnapshots === 1 ? 'file' : 'files'} for one-click recovery`,
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

      {clientAgentTargets[activeClient].length > 0 && <div className={`client-install-list ${clientAgentTargets[activeClient].length > 1 ? 'is-multi' : ''} ${activeClient === 'claude' ? 'is-claude-surfaces' : ''}`} aria-label={t('安装与启动', 'Install and launch')}>
        {clientAgentTargets[activeClient].map((target) => {
          const item = agentLifecycle?.agents[target]
          const itemMeta = agentInstallMeta[target]
          const installing = busy === `install-${target}` || item?.busyAction === 'install'
          const starting = busy === `start-${target}` || item?.busyAction === 'start'
          const isDesktopDownload = target === 'codex-desktop'
          const isClaudeDesktop = target === 'claude-code-desktop'
          const launchOnly = itemMeta.launchOnly === true
          const itemError = item?.error ? localizedLifecycleError(item.error, t) : agentCheckError
          const statusLabel = !item
            ? t('正在检测', 'Checking')
            : item.installed
              ? isClaudeDesktop
                ? item.configured
                  ? t('已写入；重开后生效', 'Written; reopen to apply')
                  : t('打开时自动写入', 'Configures when opened')
                : !launchOnly && item.running
                  ? t('运行中', 'Running')
                  : t('已安装', 'Installed')
              : t('未安装', 'Not installed')
          const description = !item?.installed
            ? isClaudeDesktop
              ? t('将打开 Claude 官方下载页；Stone+ 不会静默安装，完成安装后请返回重新检测。', 'Opens the official Claude download page. Stone+ does not install it silently; return and check again after installation.')
              : isDesktopDownload
                ? t('ChatGPT Desktop 内含 Codex；从官方页面获取后 Stone+ 会自动识别。', 'ChatGPT Desktop includes Codex; Stone+ detects it automatically after installation.')
                : t('打开官方安装指引；完成安装后返回此处重新检测。', 'Open the official installation guide, then return here and check again after installation.')
            : isClaudeDesktop
              ? item.configured
                ? t('已写入；接管时会允许 Cowork 访问任意网络主机并隐藏官方模式选择器。完整退出并重开 Claude Desktop 后生效；Stone+ 不会结束宿主进程。', 'Written. Takeover allows Cowork to access any network host and hides the official mode chooser. Fully quit and reopen Claude Desktop to apply; Stone+ does not close the host app.')
                : t('打开时自动写入 Claude Desktop 全局第三方推理配置并打开 Code，同时允许 Cowork 访问任意网络主机并隐藏官方模式选择器。完整退出并重开后生效；Stone+ 不会结束宿主进程。', 'Opening writes the global Claude Desktop third-party inference settings and opens Code, while allowing Cowork to access any network host and hiding the official mode chooser. Fully quit and reopen to apply; Stone+ does not close the host app.')
              : launchOnly
                ? t(...itemMeta.configuration)
                : item.running
                  ? t('客户端已就绪，无需额外设置。', 'The client is ready with no additional setup required.')
                  : t('检测完成，可以直接启动。', 'Detection complete. The client is ready to launch.')
          const installedActionLabel = isClaudeDesktop
            ? item?.configured
              ? t('打开 Code', 'Open Code')
              : t('配置并打开 Code', 'Configure and open Code')
            : launchOnly
              ? t('打开', 'Open')
              : t('启动', 'Launch')
          const startProgressLabel = isClaudeDesktop
            ? item?.configured
              ? t('正在打开 Code…', 'Opening Code…')
              : t('正在配置并打开 Code…', 'Configuring and opening Code…')
            : launchOnly
              ? t('正在打开客户端…', 'Opening client…')
              : t('正在启动客户端…', 'Launching client…')
          return (
            <section className="client-install" key={target} data-testid={`client-install-${target}`}>
              <div className="client-install__main">
                <div className="client-install__identity">
                  <span className="client-install__icon"><img src={clientMeta[itemMeta.client].icon} alt="" /><span className="client-install__surface-icon">{agentSurfaceIcon(itemMeta.surface)}</span></span>
                  <div className="client-install__copy">
                    <div className="client-install__title">
                      <strong>{itemMeta.name}</strong>
                      <span className={`client-install__status ${itemError ? 'is-error' : item?.installed ? 'is-installed' : item ? 'is-missing' : ''}`}>
                        {!item ? <LoaderCircle size={12} className="spin" /> : itemError ? <AlertTriangle size={12} /> : item.installed ? <CheckCircle2 size={12} /> : <Download size={12} />}
                        {statusLabel}{item?.version ? ` · v${item.version.replace(/^v/i, '')}` : ''}
                      </span>
                    </div>
                    {!isClaudeDesktop && <span className="client-install__description">{description}</span>}
                  </div>
                </div>
                <div className="client-install__actions">
                  <button
                    className="icon-button"
                    type="button"
                    aria-label={t('重新检测客户端', 'Check client again')}
                    title={t('重新检测客户端', 'Check client again')}
                    disabled={Boolean(busy) || agentLifecycle?.busy}
                    onClick={() => void refreshAgents()}
                  >
                    <RefreshCw size={15} />
                  </button>
                  {isClaudeDesktop && (
                    <button
                      className="button button--secondary client-install__restore-official"
                      type="button"
                      aria-label={claudeDesktopOfficialRestoreLabel}
                      aria-busy={claudeDesktopOfficialRestoreBusy || undefined}
                      title={claudeDesktopOfficialRestoreTitle}
                      disabled={claudeDesktopOfficialRestoreDisabled}
                      onClick={() => setClaudeDesktopOfficialRestoreConfirm(true)}
                    >
                      {claudeDesktopOfficialRestoreBusy ? <LoaderCircle size={16} className="spin" /> : <Undo2 size={16} />}
                      {t('恢复官方模式', 'Restore official mode')}
                    </button>
                  )}
                  {!item?.installed ? (
                    <button
                      className="button button--primary client-install__primary"
                      type="button"
                      disabled={!item || Boolean(busy) || agentLifecycle?.busy || installing}
                      onClick={() => void installAgent(target)}
                    >
                      {installing ? <LoaderCircle size={16} className="spin" /> : <ExternalLink size={16} />}
                      {t(...itemMeta.installAction)}
                    </button>
                  ) : (
                    <button
                      className="button button--primary client-install__primary"
                      type="button"
                      disabled={Boolean(busy) || agentLifecycle?.busy || starting || (!launchOnly && item.running)}
                      onClick={() => void startInstalledAgent(target)}
                    >
                      {starting ? <LoaderCircle size={16} className="spin" /> : !launchOnly && item.running ? <CheckCircle2 size={16} /> : <Play size={16} />}
                      {!launchOnly && item.running ? t('正在运行', 'Running') : installedActionLabel}
                    </button>
                  )}
                </div>
              </div>
              {(installing || starting) && <div className="client-install__progress" role="status"><LoaderCircle size={15} className="spin" /><span>{installing ? t('正在打开官方安装指引…', 'Opening the official installation guide…') : startProgressLabel}</span></div>}
              {itemError && <div className="client-install__error" role="alert"><AlertTriangle size={15} /><span>{itemError}</span></div>}
              <details className="client-install__advanced">
                <summary className="client-install__advanced-toggle"><span><SlidersHorizontal size={15} />{t('安装详情', 'Installation details')}</span><ChevronDown size={15} /></summary>
                <div className="client-install__advanced-body">
                  <div className="client-install__advanced-grid">
                    <label className="client-install__field"><span>{t('默认渠道', 'Default channel')}</span><input value={itemMeta.channel[language === 'zh-CN' ? 0 : 1]} readOnly /></label>
                    <label className="client-install__field"><span>{t('检测方式', 'Detection')}</span><input value={itemMeta.detection[language === 'zh-CN' ? 0 : 1]} readOnly /></label>
                  </div>
                  <p className="client-install__hint">{t(...itemMeta.configuration)}</p>
                </div>
              </details>
            </section>
          )
        })}
      </div>}

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
              disabled={clientRouteSelectionDisabled(Boolean(busy), availableRouteSources.length)}
              onChange={(event) => selectUpstream(event.target.value)}
            >
              {!routeSelection && <option value="">{t('请选择上游', 'Select an upstream')}</option>}
              {routeSelection && !routeSources.some((source) => source.id === routeSelection) && (
                <option value={routeSelection}>{t('当前来源不可用', 'Current source unavailable')}</option>
              )}
              {routeSources.map((source) => (
                <option value={source.id} key={source.id} disabled={!availableRouteSources.some((candidate) => candidate.id === source.id)}>
                  {setupPoolDisplayName(source.name, t)} · {sourceKindLabel(source.kind, language)} · {t(
                    `${source.accountCount} 个账号`,
                    `${source.accountCount} ${source.accountCount === 1 ? 'account' : 'accounts'}`,
                  )}{availableRouteSources.some((candidate) => candidate.id === source.id) ? '' : t('（暂不可用）', ' (temporarily unavailable)')}
                </option>
              ))}
            </select>
            {activeClient === 'grokbuild' && <small>{t('Grok Build 仅显示原生 Responses 的 Grok 号池或 Grok 中转站；Chat 兼容来源不会出现在这里。', 'Grok Build lists only Responses-native Grok pools or relays; Chat compatibility sources are hidden.')}</small>}
            {activeClient === 'claude' && routeSources.find((source) => source.id === routeSelection)?.protocol === 'kiro-claude' && <small>{t('Kiro Claude 兼容桥已强制开启。Manual 切换 Auto 后请新建会话，旧待确认调用不会自动重放。', 'The Kiro Claude bridge is always enabled. Start a new conversation after switching Manual to Auto; old pending calls are not replayed.')}</small>}
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
                : t('点击一键修复即可改回 Stone+；客户端模型偏好、MCP 和其他设置会保留，冲突的旧中转模型覆盖会迁移到路由层。', 'Use one-click repair to reconnect to Stone+. Client model preferences, MCP, and other settings are preserved while conflicting relay model overrides move to the route layer.')}</small>
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
                <button className="icon-button" type="button" disabled={isDirty} title={isDirty ? t('请先保存或撤销未保存更改', 'Save or revert unsaved changes first') : t('新建配置目录', 'New configuration directory')} aria-label={t('新建配置目录', 'New configuration directory')} onClick={() => setProfile(newProfile(activeClient))}><Plus size={15} /></button>
                {!selectedProfile?.isDefault && <button className="icon-button" type="button" disabled={isDirty} title={isDirty ? t('请先保存或撤销未保存更改', 'Save or revert unsaved changes first') : t('编辑当前配置目录', 'Edit current configuration directory')} aria-label={t('编辑当前配置目录', 'Edit current configuration directory')} onClick={editProfile}><Pencil size={14} /></button>}
                {!selectedProfile?.isDefault && <button className="icon-button" type="button" disabled={isDirty} title={isDirty ? t('请先保存或撤销未保存更改', 'Save or revert unsaved changes first') : t('删除当前配置目录', 'Delete current configuration directory')} aria-label={t('删除当前配置目录', 'Delete current configuration directory')} onClick={() => setDeleteProfileTarget(selectedProfile ?? null)}><Trash2 size={14} /></button>}
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
                            {group.backups.some((backup) => backup.existed === false) ? <Trash2 size={15} /> : <FileCode2 size={15} />}
                            <span><strong>{group.backups.map((backup) => (
                              `${roleLabel(backup.role, language)}${backup.existed === false ? t('（恢复时删除）', ' (delete on restore)') : ''}`
                            )).join(' + ')}{index === 0 ? t(' · 最近', ' · Latest') : ''}</strong><small>{formatDateTime(group.createdAt, locale)} · {backupGroupContentsLabel(group, language)}</small></span>
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
        open={claudeDesktopOfficialRestoreConfirm}
        title={t('恢复 Claude Desktop 官方模式？', 'Restore Claude Desktop official mode?')}
        message={t(
          '此操作只会移除 Stone+ 写入的 Claude Desktop 第三方推理配置，并恢复官方 1P 模式；不会删除 Claude 账号、会话或其他应用设置。完成后必须完整退出并重开 Claude Desktop，官方模式选择器才会恢复并生效。继续吗？',
          'This only removes the Claude Desktop third-party inference settings written by Stone+ and restores official 1P mode. It does not delete your Claude account, conversations, or other app settings. You must fully quit and reopen Claude Desktop for the official mode chooser to return and take effect. Continue?',
        )}
        confirmLabel={t('恢复官方模式', 'Restore official mode')}
        busy={claudeDesktopOfficialRestoreBusy}
        onCancel={() => setClaudeDesktopOfficialRestoreConfirm(false)}
        onConfirm={() => void restoreClaudeDesktopOfficialMode()}
      />

      <ConfirmDialog
        open={Boolean(codexRestartConfirm)}
        title={t('需要重开 Codex', 'Codex must be reopened')}
        message={t(
          '该改动只有重开 Codex 后才能可靠生效。确定后将保存改动，立即执行“关闭 Codex → 修复会话/provider → 开启 Codex”；取消则放弃并回退本次界面改动。',
          'This change takes effect reliably only after Codex is reopened. Confirm to save it and immediately run Close Codex → Repair sessions/provider → Reopen Codex. Cancel to discard and roll back the pending UI changes.',
        )}
        confirmLabel={t('保存并重开', 'Save and reopen')}
        busy={busy === 'save-editor-codex' || busy === 'save-codex-agent-limit'}
        onCancel={() => {
          setCodexRestartConfirm(null)
          undoDrafts()
        }}
        onConfirm={() => {
          if (codexRestartConfirm === 'agent-limit') void saveCodexAgentLimit(true)
          else if (codexRestartConfirm === 'editor') void saveEditor(true)
        }}
      />

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
          `恢复到 ${formatDateTime(restoreTarget.createdAt, locale)} 的版本吗？恢复前会先把当前配置再次备份。${restoreDeletionBackups.length > 0 ? ` 备份中 ${restoreDeletionBackups.map((backup) => roleLabel(backup.role, language)).join('、')} 当时不存在；继续将删除这些当前文件。` : ''}`,
          `Restore the version from ${formatDateTime(restoreTarget.createdAt, locale)}? The current configuration will be backed up first.${restoreDeletionBackups.length > 0 ? ` ${restoreDeletionBackups.map((backup) => roleLabel(backup.role, language)).join(', ')} did not exist in this backup; continuing will delete the current files.` : ''}`,
        ) : ''}
        confirmLabel={restoreDeletionBackups.length > 0 ? t('恢复并删除', 'Restore and delete') : t('恢复', 'Restore')}
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
          <label className="field"><span>{t('客户端', 'Client')}</span><select value={profile.client} disabled={Boolean(profile.id)} onChange={(event) => setProfile({ ...profile, client: event.target.value as RouteClient })}><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="gemini">Gemini CLI</option><option value="grokbuild">Grok Build</option></select></label>
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
              <span className={clientSettingOptionClassName(value, item.value)} title={item.description ?? optionHelp?.[item.value]} key={item.value}>
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
  const selectedLine = Math.min(lines.length, Math.max(1, startLine ?? 1))
  return (
    <div
      className="client-code-preview mono"
      role="region"
      aria-label={t('配置文件内容；使用上下方向键选择行', 'Configuration file contents; use the up and down arrow keys to select a line')}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown' && event.key !== 'Home' && event.key !== 'End') return
        event.preventDefault()
        const next = event.key === 'Home'
          ? 1
          : event.key === 'End'
            ? lines.length
            : Math.min(lines.length, Math.max(1, selectedLine + (event.key === 'ArrowUp' ? -1 : 1)))
        onSelectLine(next)
      }}
    >
      {lines.map((line, index) => {
        const lineNumber = index + 1
        const highlighted = startLine !== undefined && lineNumber >= startLine && lineNumber <= (endLine ?? startLine)
        return (
          <div className={highlighted ? 'is-highlighted' : ''} aria-current={highlighted ? 'true' : undefined} onClick={() => onSelectLine(lineNumber)} key={`${lineNumber}-${line}`}>
            <span>{lineNumber}</span><code>{line || ' '}</code>
          </div>
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
    grokbuild: 'grok-config',
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

function backupGroupContentsLabel(group: ClientBackupGroup, language: UiLanguage): string {
  const deletionMarkers = group.backups.filter((backup) => backup.existed === false).length
  const valueSnapshots = group.backups.length - deletionMarkers
  if (deletionMarkers === 0) {
    return language === 'zh-CN'
      ? `${valueSnapshots} 个文件`
      : `${valueSnapshots} ${valueSnapshots === 1 ? 'file' : 'files'}`
  }
  return language === 'zh-CN'
    ? `${valueSnapshots} 个文件快照 · ${deletionMarkers} 个删除标记`
    : `${valueSnapshots} file ${valueSnapshots === 1 ? 'snapshot' : 'snapshots'} · ${deletionMarkers} deletion ${deletionMarkers === 1 ? 'marker' : 'markers'}`
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
