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
import {
  containsHanText,
  localizeBackendMessage,
  localizeReleaseNotes,
} from './backend-message'
import { Badge, Modal } from './ui'
import { translate, useI18n, type UiLanguage } from './i18n'

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
  const { t, language } = useI18n()
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
        <strong>{bannerTitle(state, language)}</strong>
        <span>{bannerDescription(state, language)}</span>
        {state.status === 'downloading' && state.progress && <UpdateProgress state={state} compact />}
      </div>
      <div className="update-banner__actions">
        <button className="button button--secondary" type="button" onClick={actions.onOpen}>{t('查看说明', 'View Notes')}</button>
        {state.status === 'available' && (
          <>
            <button className="text-button" type="button" disabled={busy} onClick={() => void actions.onIgnore()}>{t('忽略此版本', 'Ignore This Version')}</button>
            {state.automaticUpdateSupported ? (
              <button className="button button--primary" type="button" disabled={busy} onClick={() => void actions.onDownload()}>
                {actions.action === 'download' ? <LoaderCircle size={16} className="spin" /> : <Download size={16} />}{t('下载更新', 'Download Update')}
              </button>
            ) : (
              <button className="button button--primary" type="button" disabled={busy} onClick={() => void actions.onOpenPage()}>
                <ExternalLink size={16} />{t('打开 Release', 'Open Release')}
              </button>
            )}
          </>
        )}
        {state.status === 'downloaded' && (
          <button className="button button--primary" type="button" disabled={busy} onClick={() => void actions.onInstall()}>
            {actions.action === 'install' ? <LoaderCircle size={16} className="spin" /> : <Rocket size={16} />}{t('更新并重启', 'Update & Restart')}
          </button>
        )}
        {state.status === 'error' && (
          <button className="button button--primary" type="button" disabled={busy} onClick={() => void (state.automaticUpdateSupported ? actions.onDownload() : actions.onCheck())}>
            <RefreshCw size={16} className={busy ? 'spin' : undefined} />{t('重试', 'Retry')}
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
  const { t, language, locale } = useI18n()
  if (!state) return null
  const release = state.release
  const busy = action !== null || state.status === 'checking' || state.status === 'installing'
  const ignored = Boolean(release && state.ignoredVersion === release.version)
  const rawError = actionError ?? state.error
  const error = rawError ? localizeBackendMessage(rawError, language, t('更新操作失败。', 'The update operation failed.')) : null
  const localizedNotes = release ? localizeReleaseNotes(release.notes, language) : ''
  const originalReleaseNotes = language === 'en' && containsHanText(localizedNotes)
  const highlights = release ? releaseHighlights(localizedNotes) : []

  return (
    <Modal
      open={open}
      title={release?.title || (state.status === 'up-to-date' ? t('StonePlus 已是最新版本', 'StonePlus is up to date') : t('StonePlus 应用更新', 'StonePlus App Update'))}
      description={release ? `v${state.currentVersion} → v${release.version}` : t(`当前版本 v${state.currentVersion}`, `Current version v${state.currentVersion}`)}
      width="large"
      closable={state.status !== 'installing'}
      onClose={onClose}
      footer={
        <>
          {state.status !== 'installing' && <button className="button button--secondary" type="button" onClick={onClose}>{t('稍后处理', 'Later')}</button>}
          {release && state.automaticUpdateSupported && state.status !== 'unsupported' && <button className="button button--secondary" type="button" disabled={action === 'open-page'} onClick={() => void onOpenPage()}><ExternalLink size={16} />{t('打开 Release', 'Open Release')}</button>}
          {state.status === 'available' && !ignored && <button className="text-button" type="button" disabled={busy} onClick={() => void onIgnore()}>{t('忽略此版本', 'Ignore This Version')}</button>}
          {(state.status === 'idle' || state.status === 'up-to-date' || state.status === 'error') && !release && (
            <button className="button button--primary" type="button" disabled={busy} onClick={() => void onCheck()}>
              {action === 'check' ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />}{t('检查更新', 'Check for Updates')}
            </button>
          )}
          {state.status === 'unsupported' && (
            <button className="button button--primary" type="button" disabled={action === 'open-page'} onClick={() => void onOpenPage()}><ExternalLink size={16} />{t('查看 Releases', 'View Releases')}</button>
          )}
          {state.status === 'available' && state.automaticUpdateSupported && (
            <button className="button button--primary" type="button" disabled={busy} onClick={() => void onDownload()}>
              {action === 'download' || action === 'install' ? <LoaderCircle size={16} className="spin" /> : <Rocket size={16} />}{t('确认更新', 'Confirm Update')}
            </button>
          )}
          {state.status === 'available' && !state.automaticUpdateSupported && (
            <button className="button button--primary" type="button" disabled={action === 'open-page'} onClick={() => void onOpenPage()}><ExternalLink size={16} />{t('手动下载', 'Download Manually')}</button>
          )}
          {state.status === 'downloading' && (
            <button className="button button--primary" type="button" disabled><LoaderCircle size={16} className="spin" />{t('正在下载', 'Downloading')}</button>
          )}
          {state.status === 'downloaded' && (
            <button className="button button--primary" type="button" disabled={busy} onClick={() => void onInstall()}>
              {action === 'install' ? <LoaderCircle size={16} className="spin" /> : <Rocket size={16} />}{t('立即安装并重启', 'Install & Restart Now')}
            </button>
          )}
          {state.status === 'installing' && <button className="button button--primary" type="button" disabled><LoaderCircle size={16} className="spin" />{t('正在重启 StonePlus', 'Restarting StonePlus')}</button>}
          {state.status === 'error' && release && state.automaticUpdateSupported && (
            <button className="button button--primary" type="button" disabled={busy} onClick={() => void onDownload()}><RefreshCw size={16} />{t('重新下载', 'Download Again')}</button>
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
              <span>{statusDescription(state, language)}</span>
            </div>
          </div>
          <div className="update-dialog__badges">
            <Badge tone={statusTone(state)}>{statusLabel(state, language)}</Badge>
            {ignored && <Badge tone="neutral">{t('已忽略', 'Ignored')}</Badge>}
          </div>
        </div>

        {state.status === 'downloading' && state.progress && <UpdateProgress state={state} />}
        {!state.automaticUpdateSupported && (
          <div className="update-support-notice"><AlertTriangle size={17} /><div><strong>{t('当前安装形式不支持应用内自动更新', 'This installation does not support automatic in-app updates')}</strong><span>{state.automaticUpdateReason ? localizeBackendMessage(state.automaticUpdateReason, language, t('请前往 GitHub Releases 手动下载安装。', 'Download and install the update manually from GitHub Releases.')) : t('请前往 GitHub Releases 手动下载安装。', 'Download and install the update manually from GitHub Releases.')}</span></div></div>
        )}
        {error && <div className="update-error" role="alert"><AlertTriangle size={16} /><span>{error}</span></div>}

        {release ? (
          <section className="update-notes">
            <header>
              <div><Sparkles size={17} /><strong>{t('版本亮点', 'Release Highlights')}</strong>{originalReleaseNotes && <Badge tone="neutral">Original release notes</Badge>}</div>
              <span>{formatReleaseDate(release.publishedAt, language, locale)}</span>
            </header>
            <div className="update-notes__body">
              {highlights.length
                ? <div className="update-highlights">{highlights.map((highlight, index) => <div className="update-highlight" key={`${index}-${highlight}`}><span>{index + 1}</span><p>{highlight}</p></div>)}</div>
                : <p className="muted">{t('此版本没有提供发布说明。', 'No release notes were provided for this version.')}</p>}
            </div>
          </section>
        ) : (
          <div className="update-dialog__empty">{state.status === 'up-to-date' ? <CheckCircle2 size={28} /> : <RefreshCw size={26} />}<span>{state.status === 'up-to-date' ? t('当前安装的 StonePlus 已是最新版本。', 'The installed StonePlus version is up to date.') : t('手动检查后会在这里显示版本信息和发布说明。', 'Version information and release notes will appear here after a manual check.')}</span></div>
        )}
      </div>
    </Modal>
  )
}

export function UpdateProgress({ state, compact = false }: { state: AppUpdateState; compact?: boolean }) {
  const { t } = useI18n()
  const progress = state.progress
  if (!progress) return null
  const percent = Math.max(0, Math.min(100, progress.percent))
  return (
    <div className={`update-progress ${compact ? 'update-progress--compact' : ''}`}>
      <div className="update-progress__labels">
        <span>{formatBytes(progress.transferred)} / {formatBytes(progress.total)}</span>
        <strong>{percent.toFixed(percent >= 10 ? 0 : 1)}%</strong>
      </div>
      <div className="update-progress__track" role="progressbar" aria-label={t('更新下载进度', 'Update download progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}>
        <span style={{ width: `${percent}%` }} />
      </div>
      {!compact && <span className="update-progress__speed">{formatBytes(progress.bytesPerSecond)}/s</span>}
    </div>
  )
}

export function statusLabel(state: AppUpdateState, language: UiLanguage = currentLanguage()): string {
  switch (state.status) {
    case 'unsupported': return translate(language, '需手动更新', 'Manual update required')
    case 'idle': return translate(language, '尚未检查', 'Not checked')
    case 'checking': return translate(language, '正在检查', 'Checking')
    case 'up-to-date': return translate(language, '已是最新', 'Up to date')
    case 'available': return translate(language, '发现新版本', 'Update available')
    case 'downloading': return translate(language, '正在下载', 'Downloading')
    case 'downloaded': return translate(language, '等待重启', 'Restart required')
    case 'installing': return translate(language, '正在安装', 'Installing')
    case 'error': return translate(language, '更新失败', 'Update failed')
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

function bannerTitle(state: AppUpdateState, language: UiLanguage): string {
  if (state.status === 'downloading') return translate(language, `正在下载 StonePlus ${state.release?.version}`, `Downloading StonePlus ${state.release?.version}`)
  if (state.status === 'downloaded') return translate(language, `StonePlus ${state.release?.version} 已准备就绪`, `StonePlus ${state.release?.version} is ready`)
  if (state.status === 'installing') return translate(language, 'StonePlus 正在安装更新', 'StonePlus is installing the update')
  if (state.status === 'error') return translate(language, 'StonePlus 更新遇到问题', 'StonePlus encountered an update problem')
  return translate(language, `发现 StonePlus ${state.release?.version}`, `StonePlus ${state.release?.version} is available`)
}

function bannerDescription(state: AppUpdateState, language: UiLanguage): string {
  if (state.status === 'downloading') return translate(language, '下载会在后台继续，完成后可更新并重启。', 'The download will continue in the background. Update and restart when it finishes.')
  if (state.status === 'downloaded') return translate(language, '重启会关闭当前窗口与正在运行的本地请求。', 'Restarting will close this window and interrupt running local requests.')
  if (state.status === 'installing') return translate(language, '应用即将关闭并重新启动。', 'The app will close and restart shortly.')
  if (state.status === 'error') return state.error
    ? localizeBackendMessage(state.error, language, translate(language, '请重试或前往 GitHub Releases 手动下载。', 'Try again or download the update manually from GitHub Releases.'))
    : translate(language, '请重试或前往 GitHub Releases 手动下载。', 'Try again or download the update manually from GitHub Releases.')
  return state.release?.title || translate(language, '查看发布说明后选择下载或忽略此版本。', 'Review the release notes, then download or ignore this version.')
}

function statusTitle(state: AppUpdateState): string {
  if (state.release) return `StonePlus ${state.release.version}`
  return `StonePlus ${state.currentVersion}`
}

function statusDescription(state: AppUpdateState, language: UiLanguage): string {
  if (state.status === 'unsupported') return state.automaticUpdateReason
    ? localizeBackendMessage(state.automaticUpdateReason, language, translate(language, '请从 GitHub Releases 手动下载适合当前平台的安装包。', 'Download the installer for your platform manually from GitHub Releases.'))
    : translate(language, '请从 GitHub Releases 手动下载适合当前平台的安装包。', 'Download the installer for your platform manually from GitHub Releases.')
  if (state.status === 'checking') return translate(language, '正在从 GitHub Releases 获取最新版本信息。', 'Fetching the latest version from GitHub Releases.')
  if (state.status === 'up-to-date') return translate(language, '当前版本无需更新。', 'The current version does not need an update.')
  if (state.status === 'available') return translate(language, '新版本已发布，可查看说明并选择安装。', 'A new version is available. Review the notes and choose whether to install it.')
  if (state.status === 'downloading') return translate(language, '安装包正在后台下载。', 'The installer is downloading in the background.')
  if (state.status === 'downloaded') return translate(language, '安装包已完成校验，可以更新并重启。', 'The installer has been verified and is ready to update and restart.')
  if (state.status === 'installing') return translate(language, 'StonePlus 将在安装完成后重新启动。', 'StonePlus will restart after installation completes.')
  if (state.status === 'error') return translate(language, '更新操作未完成，现有版本仍可继续使用。', 'The update did not complete. You can continue using the current version.')
  return translate(language, '手动检查 GitHub Releases 中的最新版本。', 'Check GitHub Releases for the latest version manually.')
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)))
  const amount = value / 1024 ** index
  return `${amount.toFixed(index === 0 || amount >= 100 ? 0 : 1)} ${units[index]}`
}

function formatReleaseDate(value: string, language: UiLanguage, locale: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return translate(language, '发布时间未知', 'Release date unknown')
  return new Intl.DateTimeFormat(locale, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(timestamp)
}

function currentLanguage(): UiLanguage {
  if (typeof document !== 'undefined' && /^zh(?:[-_]|$)/i.test(document.documentElement.lang)) return 'zh-CN'
  return 'en'
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
