import {
  AlertTriangle,
  CheckCircle2,
  Download,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  Rocket,
  Sparkles,
} from 'lucide-react'
import type { AppUpdateState } from '@shared/types'
import { Badge, Modal } from './ui'

export type UpdateAction = 'check' | 'ignore' | 'download' | 'install' | 'open-page'

export interface AppUpdateController {
  state: AppUpdateState | null
  action: UpdateAction | null
  error: string | null
  openDialog: () => void
  check: () => Promise<void>
  ignore: () => Promise<void>
  download: () => Promise<void>
  install: () => Promise<void>
  openPage: () => Promise<void>
}

interface UpdateActions {
  action: UpdateAction | null
  onOpen: () => void
  onCheck: () => Promise<void>
  onIgnore: () => Promise<void>
  onDownload: () => Promise<void>
  onInstall: () => Promise<void>
  onOpenPage: () => Promise<void>
}

export function UpdateBanner({ state, ...actions }: { state: AppUpdateState } & UpdateActions) {
  const release = state.release
  const ignored = release && state.ignoredVersion === release.version
  const visibleStatus = state.status === 'available'
    || state.status === 'downloading'
    || state.status === 'downloaded'
    || state.status === 'installing'
    || (state.status === 'error' && Boolean(release))
  if (!release || !visibleStatus || (ignored && state.status === 'available')) return null

  const busy = actions.action !== null
  return (
    <section className={`update-banner update-banner--${state.status}`} aria-live="polite">
      <div className="update-banner__icon">{updateIcon(state)}</div>
      <div className="update-banner__content">
        <strong>{bannerTitle(state)}</strong>
        <span>{bannerDescription(state)}</span>
        {state.status === 'downloading' && state.progress && <UpdateProgress state={state} compact />}
      </div>
      <div className="update-banner__actions">
        <button className="button button--secondary" type="button" onClick={actions.onOpen}>查看说明</button>
        {state.status === 'available' && (
          <>
            <button className="text-button" type="button" disabled={busy} onClick={() => void actions.onIgnore()}>忽略此版本</button>
            {state.automaticUpdateSupported ? (
              <button className="button button--primary" type="button" disabled={busy} onClick={() => void actions.onDownload()}>
                {actions.action === 'download' ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}下载更新
              </button>
            ) : (
              <button className="button button--primary" type="button" disabled={busy} onClick={() => void actions.onOpenPage()}>
                <ExternalLink size={16} />打开 Release
              </button>
            )}
          </>
        )}
        {state.status === 'downloaded' && (
          <button className="button button--primary" type="button" disabled={busy} onClick={() => void actions.onInstall()}>
            {actions.action === 'install' ? <LoaderCircle size={16} className="spin" /> : <Rocket size={16} />}更新并重启
          </button>
        )}
        {state.status === 'error' && (
          <button className="button button--primary" type="button" disabled={busy} onClick={() => void (state.automaticUpdateSupported ? actions.onDownload() : actions.onCheck())}>
            <RefreshCw size={16} className={busy ? 'spin' : undefined} />重试
          </button>
        )}
      </div>
    </section>
  )
}

export function UpdateDialog({
  open,
  state,
  action,
  actionError,
  onClose,
  onCheck,
  onIgnore,
  onDownload,
  onInstall,
  onOpenPage,
}: {
  open: boolean
  state: AppUpdateState | null
  action: UpdateAction | null
  actionError: string | null
  onClose: () => void
  onCheck: () => Promise<void>
  onIgnore: () => Promise<void>
  onDownload: () => Promise<void>
  onInstall: () => Promise<void>
  onOpenPage: () => Promise<void>
}) {
  if (!state) return null
  const release = state.release
  const busy = action !== null || state.status === 'checking' || state.status === 'installing'
  const ignored = Boolean(release && state.ignoredVersion === release.version)
  const error = actionError ?? state.error
  const highlights = release ? releaseHighlights(release.notes) : []

  return (
    <Modal
      open={open}
      title={release?.title || (state.status === 'up-to-date' ? 'Stone+ 已是最新版本' : 'Stone+ 应用更新')}
      description={release ? `v${state.currentVersion} → v${release.version}` : `当前版本 v${state.currentVersion}`}
      width="large"
      closable={state.status !== 'installing'}
      onClose={onClose}
      footer={
        <>
          {state.status !== 'installing' && <button className="button button--secondary" type="button" onClick={onClose}>稍后处理</button>}
          {release && state.automaticUpdateSupported && state.status !== 'unsupported' && <button className="button button--secondary" type="button" disabled={action === 'open-page'} onClick={() => void onOpenPage()}><ExternalLink size={16} />打开 Release</button>}
          {state.status === 'available' && !ignored && <button className="text-button" type="button" disabled={busy} onClick={() => void onIgnore()}>忽略此版本</button>}
          {(state.status === 'idle' || state.status === 'up-to-date' || state.status === 'error') && !release && (
            <button className="button button--primary" type="button" disabled={busy} onClick={() => void onCheck()}>
              {action === 'check' ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}检查更新
            </button>
          )}
          {state.status === 'unsupported' && (
            <button className="button button--primary" type="button" disabled={action === 'open-page'} onClick={() => void onOpenPage()}><ExternalLink size={16} />查看 Releases</button>
          )}
          {state.status === 'available' && state.automaticUpdateSupported && (
            <button className="button button--primary" type="button" disabled={busy} onClick={() => void onDownload()}>
              {action === 'download' || action === 'install' ? <LoaderCircle size={16} className="spin" /> : <Rocket size={16} />}确认更新
            </button>
          )}
          {state.status === 'available' && !state.automaticUpdateSupported && (
            <button className="button button--primary" type="button" disabled={action === 'open-page'} onClick={() => void onOpenPage()}><ExternalLink size={16} />手动下载</button>
          )}
          {state.status === 'downloading' && (
            <button className="button button--primary" type="button" disabled><LoaderCircle size={16} className="spin" />正在下载</button>
          )}
          {state.status === 'downloaded' && (
            <button className="button button--primary" type="button" disabled={busy} onClick={() => void onInstall()}>
              {action === 'install' ? <LoaderCircle size={16} className="spin" /> : <Rocket size={16} />}立即安装并重启
            </button>
          )}
          {state.status === 'installing' && <button className="button button--primary" type="button" disabled><LoaderCircle size={16} className="spin" />正在重启 Stone+</button>}
          {state.status === 'error' && release && state.automaticUpdateSupported && (
            <button className="button button--primary" type="button" disabled={busy} onClick={() => void onDownload()}><RefreshCw size={16} />重新下载</button>
          )}
        </>
      }
    >
      <div className="update-dialog">
        <div className="update-dialog__summary">
          <div>
            <span className="update-dialog__mark">{updateIcon(state)}</span>
            <div>
              <strong>{statusTitle(state)}</strong>
              <span>{statusDescription(state)}</span>
            </div>
          </div>
          <div className="update-dialog__badges">
            <Badge tone={statusTone(state)}>{statusLabel(state)}</Badge>
            {ignored && <Badge tone="neutral">已忽略</Badge>}
          </div>
        </div>

        {state.status === 'downloading' && state.progress && <UpdateProgress state={state} />}
        {!state.automaticUpdateSupported && (
          <div className="update-support-notice"><AlertTriangle size={17} /><div><strong>当前安装形式不支持应用内自动更新</strong><span>{state.automaticUpdateReason ?? '请前往 GitHub Releases 手动下载安装。'}</span></div></div>
        )}
        {error && <div className="update-error" role="alert"><AlertTriangle size={16} /><span>{error}</span></div>}

        {release ? (
          <section className="update-notes">
            <header>
              <div><Sparkles size={17} /><strong>版本亮点</strong></div>
              <span>{formatReleaseDate(release.publishedAt)}</span>
            </header>
            <div className="update-notes__body">
              {highlights.length
                ? <div className="update-highlights">{highlights.map((highlight, index) => <div className="update-highlight" key={`${index}-${highlight}`}><span>{index + 1}</span><p>{highlight}</p></div>)}</div>
                : <p className="muted">此版本没有提供发布说明。</p>}
            </div>
          </section>
        ) : (
          <div className="update-dialog__empty">{state.status === 'up-to-date' ? <CheckCircle2 size={28} /> : <RefreshCw size={26} />}<span>{state.status === 'up-to-date' ? '当前安装的 Stone+ 已是最新版本。' : '手动检查后会在这里显示版本信息和发布说明。'}</span></div>
        )}
      </div>
    </Modal>
  )
}

export function UpdateProgress({ state, compact = false }: { state: AppUpdateState; compact?: boolean }) {
  const progress = state.progress
  if (!progress) return null
  const percent = Math.max(0, Math.min(100, progress.percent))
  return (
    <div className={`update-progress ${compact ? 'update-progress--compact' : ''}`}>
      <div className="update-progress__labels">
        <span>{formatBytes(progress.transferred)} / {formatBytes(progress.total)}</span>
        <strong>{percent.toFixed(percent >= 10 ? 0 : 1)}%</strong>
      </div>
      <div className="update-progress__track" role="progressbar" aria-label="更新下载进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}>
        <span style={{ width: `${percent}%` }} />
      </div>
      {!compact && <span className="update-progress__speed">{formatBytes(progress.bytesPerSecond)}/s</span>}
    </div>
  )
}

export function statusLabel(state: AppUpdateState): string {
  switch (state.status) {
    case 'unsupported': return '需手动更新'
    case 'idle': return '尚未检查'
    case 'checking': return '正在检查'
    case 'up-to-date': return '已是最新'
    case 'available': return '发现新版本'
    case 'downloading': return '正在下载'
    case 'downloaded': return '等待重启'
    case 'installing': return '正在安装'
    case 'error': return '更新失败'
  }
}

export function statusTone(state: AppUpdateState): 'neutral' | 'success' | 'warning' | 'danger' | 'info' {
  if (state.status === 'up-to-date' || state.status === 'downloaded') return 'success'
  if (state.status === 'error') return 'danger'
  if (state.status === 'available' || state.status === 'downloading' || state.status === 'checking') return 'info'
  if (state.status === 'unsupported') return 'warning'
  return 'neutral'
}

function updateIcon(state: AppUpdateState) {
  if (state.status === 'downloading' || state.status === 'checking' || state.status === 'installing') return <LoaderCircle size={19} className="spin" />
  if (state.status === 'downloaded' || state.status === 'up-to-date') return <CheckCircle2 size={19} />
  if (state.status === 'error' || state.status === 'unsupported') return <AlertTriangle size={19} />
  return <Sparkles size={19} />
}

function bannerTitle(state: AppUpdateState): string {
  if (state.status === 'downloading') return `正在下载 Stone+ ${state.release?.version}`
  if (state.status === 'downloaded') return `Stone+ ${state.release?.version} 已准备就绪`
  if (state.status === 'installing') return 'Stone+ 正在安装更新'
  if (state.status === 'error') return 'Stone+ 更新遇到问题'
  return `发现 Stone+ ${state.release?.version}`
}

function bannerDescription(state: AppUpdateState): string {
  if (state.status === 'downloading') return '下载会在后台继续，完成后可更新并重启。'
  if (state.status === 'downloaded') return '重启会关闭当前窗口与正在运行的本地请求。'
  if (state.status === 'installing') return '应用即将关闭并重新启动。'
  if (state.status === 'error') return state.error ?? '请重试或前往 GitHub Releases 手动下载。'
  return state.release?.title || '查看发布说明后选择下载或忽略此版本。'
}

function statusTitle(state: AppUpdateState): string {
  if (state.release) return `Stone+ ${state.release.version}`
  return `Stone+ ${state.currentVersion}`
}

function statusDescription(state: AppUpdateState): string {
  if (state.status === 'unsupported') return state.automaticUpdateReason ?? '请从 GitHub Releases 手动下载适合当前平台的安装包。'
  if (state.status === 'checking') return '正在从 GitHub Releases 获取最新版本信息。'
  if (state.status === 'up-to-date') return '当前版本无需更新。'
  if (state.status === 'available') return '新版本已发布，可查看说明并选择安装。'
  if (state.status === 'downloading') return '安装包正在后台下载。'
  if (state.status === 'downloaded') return '安装包已完成校验，可以更新并重启。'
  if (state.status === 'installing') return 'Stone+ 将在安装完成后重新启动。'
  if (state.status === 'error') return '更新操作未完成，现有版本仍可继续使用。'
  return '手动检查 GitHub Releases 中的最新版本。'
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)))
  const amount = value / 1024 ** index
  return `${amount.toFixed(index === 0 || amount >= 100 ? 0 : 1)} ${units[index]}`
}

function formatReleaseDate(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return '发布时间未知'
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(timestamp)
}

function releaseHighlights(notes: string): string[] {
  const lines = notes
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const bulletLines = lines.filter((line) => /^(?:[-*+]\s+|\d+[.)]\s+)/.test(line))
  const candidates = bulletLines.length
    ? bulletLines
    : lines.filter((line) => !/^#{1,6}\s+/.test(line))

  return [...new Set(candidates
    .map((line) => line
      .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, '')
      .replace(/\[([^\]]+)]\([^\s)]+(?:\s+"[^"]*")?\)/g, '$1')
      .replace(/[*_`~]/g, '')
      .trim())
    .filter(Boolean))]
    .slice(0, 10)
}
