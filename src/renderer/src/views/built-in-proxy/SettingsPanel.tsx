import {
  useEffect,
  useId,
  useRef,
  useState,
} from 'react'
import {
  AlertTriangle,
  Check,
  Globe2,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Network,
  Power,
  Router,
  ShieldCheck,
} from 'lucide-react'
import type {
  BuiltInProxyAccessMode,
  BuiltInProxyRuntimeState,
} from '@shared/types'
import { useI18n } from '../../i18n'
import { ConfirmDialog } from '../../ui'
import './SettingsPanel.css'

export interface SettingsWorkspacePendingState {
  /** Requested access mode while the existing mode remains the persisted truth. */
  accessMode?: BuiltInProxyAccessMode
  /** Requested LAN value; `false` still represents an active operation. */
  lanEnabled?: boolean
  /** Requested auto-start value; `false` still represents an active operation. */
  autoStart?: boolean
}

export interface SettingsWorkspaceProps {
  runtime: BuiltInProxyRuntimeState
  disabled?: boolean
  pending?: SettingsWorkspacePendingState
  actionError?: string | null
  onAccessModeChange: (mode: BuiltInProxyAccessMode) => void
  onLanEnabledChange: (enabled: boolean) => boolean | void | Promise<boolean | void>
  onAutoStartChange: (enabled: boolean) => void
}

type AccessPresentation = 'idle' | 'applying' | 'ready' | 'error'

const accessModes: readonly BuiltInProxyAccessMode[] = ['system', 'tun']

/**
 * Settings-only workspace for the built-in proxy. It deliberately exposes no
 * controller secret, raw sing-box configuration, or unsupported advanced
 * switches; all mutations flow through the existing dedicated actions.
 */
export function SettingsWorkspace({
  runtime,
  disabled = false,
  pending = {},
  actionError,
  onAccessModeChange,
  onLanEnabledChange,
  onAutoStartChange,
}: SettingsWorkspaceProps) {
  const { t } = useI18n()
  const [confirmLan, setConfirmLan] = useState(false)
  const lanToggleRef = useRef<HTMLInputElement>(null)
  const headingId = useId()
  const statusId = useId()
  const lanLabelId = useId()
  const lanDescriptionId = useId()
  const autoStartLabelId = useId()
  const autoStartDescriptionId = useId()
  const safetyId = useId()
  const safetyHeadingId = useId()
  const settings = runtime.settings
  const lanConfirmationOpen = confirmLan && !settings.lanEnabled
  const accessPending = pending.accessMode !== undefined
  const lanPending = pending.lanEnabled !== undefined
  const autoStartPending = pending.autoStart !== undefined
  const runtimeTransitioning = runtime.status === 'starting'
    || runtime.status === 'stopping'
    || runtime.accessState.status === 'applying'
  const controlsDisabled = disabled
    || lanConfirmationOpen
    || runtimeTransitioning
    || accessPending
    || lanPending
    || autoStartPending
  const anyPending = accessPending || lanPending || autoStartPending || runtimeTransitioning
  const accessPresentation = resolveAccessPresentation(runtime, accessPending || lanPending)
  const port = resolveMixedPort(runtime, accessPresentation === 'ready')
  const portText = port === undefined
    ? t('启动时自动选择', 'Selected automatically at start')
    : String(port)
  const endpointText = port === undefined
    ? t('等待端口分配', 'Waiting for port assignment')
    : `127.0.0.1:${port}`
  const mixedListenText = port === undefined
    ? t('等待端口分配', 'Waiting for port assignment')
    : `${settings.lanEnabled ? '0.0.0.0' : '127.0.0.1'}:${port}`
  const visibleError = actionError?.trim() || runtime.error?.message
  const pendingAnnouncement = accessPending
    ? t('正在切换接入方式', 'Switching access mode')
    : lanPending
      ? t('正在更新局域网访问', 'Updating LAN access')
      : autoStartPending
        ? t('正在更新自启动设置', 'Updating auto-start')
        : undefined

  const statusLabel = pendingAnnouncement ?? (accessPresentation === 'ready'
    ? settings.accessMode === 'system'
      ? t('系统代理已应用', 'System proxy applied')
      : t('TUN 已运行', 'TUN running')
    : accessPresentation === 'applying'
      ? t('正在应用设置', 'Applying settings')
      : accessPresentation === 'error'
        ? t('接入未就绪', 'Access not ready')
        : runtime.desiredEnabled
          ? t('接入尚未验证', 'Access not verified')
          : t('接入未启用', 'Access inactive'))

  useEffect(() => {
    if (settings.lanEnabled && confirmLan) setConfirmLan(false)
  }, [confirmLan, settings.lanEnabled])

  const closeLanConfirmation = () => {
    setConfirmLan(false)
    setTimeout(() => lanToggleRef.current?.focus(), 0)
  }

  return (
    <section
      className="built-in-proxy-settings-workspace"
      aria-labelledby={headingId}
      aria-describedby={safetyId}
      aria-busy={anyPending}
    >
      <header className="built-in-proxy-settings-workspace__header">
        <div className="built-in-proxy-settings-workspace__title">
          <span aria-hidden="true"><ShieldCheck size={20} /></span>
          <div>
            <h2 id={headingId}>{t('代理设置', 'Proxy settings')}</h2>
            <p>{t(
              '选择 Stone+ 如何接入本机网络，并管理 mixed 入口的暴露范围。',
              'Choose how Stone+ connects to this device and manage mixed endpoint exposure.',
            )}</p>
          </div>
        </div>
        <span
          id={statusId}
          className={`built-in-proxy-settings-workspace__status is-${accessPresentation}`}
          role="status"
          aria-live="polite"
        >
          {accessPresentation === 'applying'
            ? <LoaderCircle aria-hidden="true" size={14} className="spin" />
            : accessPresentation === 'ready'
              ? <Check aria-hidden="true" size={14} />
              : accessPresentation === 'error'
                ? <AlertTriangle aria-hidden="true" size={14} />
                : null}
          {statusLabel}
        </span>
      </header>

      {visibleError && (
        <div className="built-in-proxy-settings-workspace__error" role="alert">
          <AlertTriangle aria-hidden="true" size={17} />
          <div>
            <strong>{t('设置未能生效', 'Settings were not applied')}</strong>
            <p>{visibleError}</p>
          </div>
        </div>
      )}

      <fieldset
        className="built-in-proxy-settings-workspace__group"
        disabled={controlsDisabled || accessPending}
        aria-busy={accessPending || lanPending}
        aria-describedby={statusId}
      >
        <legend>{t('接入方式', 'Access mode')}</legend>
        <p className="built-in-proxy-settings-workspace__group-description">{t(
          '两种方式共用当前 sing-box mixed 入口；切换完成前，页面不会把目标状态显示为已生效。',
          'Both modes use the current sing-box mixed endpoint; the target is not shown as active until switching completes.',
        )}</p>
        <div className="built-in-proxy-settings-workspace__mode-grid">
          {accessModes.map((mode) => {
            const selected = settings.accessMode === mode
            const applying = pending.accessMode === mode
            const modeLabelId = `${headingId}-${mode}-label`
            const modeDescriptionId = `${headingId}-${mode}-description`
            return (
              <label
                key={mode}
                className={`built-in-proxy-settings-workspace__mode ${selected ? 'is-selected' : ''} ${applying ? 'is-applying' : ''}`}
              >
                <input
                  type="radio"
                  name={`${headingId}-access-mode`}
                  value={mode}
                  checked={selected}
                  aria-labelledby={modeLabelId}
                  aria-describedby={`${modeDescriptionId} ${statusId}`}
                  aria-busy={applying || undefined}
                  onChange={() => {
                    if (!selected) onAccessModeChange(mode)
                  }}
                />
                <span className="built-in-proxy-settings-workspace__mode-icon" aria-hidden="true">
                  {mode === 'system' ? <Network size={19} /> : <Router size={19} />}
                </span>
                <span className="built-in-proxy-settings-workspace__mode-copy">
                  <strong id={modeLabelId}>{mode === 'system' ? t('系统代理', 'System proxy') : 'TUN'}</strong>
                  <small id={modeDescriptionId}>{mode === 'system'
                    ? t(
                        '让遵循系统代理的 Windows 应用使用 Stone+ mixed 端口。',
                        'Route Windows applications that honor the system proxy through the Stone+ mixed port.',
                      )
                    : t(
                        '覆盖不遵循系统代理的应用；每次启动都需要临时提权。',
                        'Cover applications that ignore the system proxy; temporary elevation is required on every start.',
                      )}</small>
                </span>
                <span className="built-in-proxy-settings-workspace__mode-state" aria-hidden="true">
                  {applying ? <LoaderCircle size={15} className="spin" /> : selected ? <Check size={15} /> : null}
                </span>
              </label>
            )
          })}
        </div>
      </fieldset>

      <dl
        className="built-in-proxy-settings-workspace__details"
        aria-label={accessPresentation === 'ready'
          ? t('当前端点', 'Current endpoints')
          : t('计划端点', 'Planned endpoints')}
      >
        <div>
          <dt><Globe2 aria-hidden="true" size={16} />{t('mixed 端口', 'Mixed port')}</dt>
          <dd className="built-in-proxy-settings-workspace__detail-value"><strong>{portText}</strong></dd>
          <dd className="built-in-proxy-settings-workspace__detail-hint">{accessPresentation === 'ready'
            ? t('当前运行端口', 'Current runtime port')
            : t('计划值；首次自动选择后由 Stone+ 记住', 'Planned value; Stone+ remembers the first automatic selection')}</dd>
        </div>
        <div>
          <dt><Network aria-hidden="true" size={16} />{settings.accessMode === 'system'
            ? t('系统代理目标', 'System proxy target')
            : t('TUN 上游', 'TUN upstream')}</dt>
          <dd className="built-in-proxy-settings-workspace__detail-value"><code>{endpointText}</code></dd>
          <dd className="built-in-proxy-settings-workspace__detail-hint">{accessPresentation === 'ready'
            ? t('已验证的本机回环地址', 'Verified local loopback address')
            : t('计划使用的本机回环地址', 'Planned local loopback address')}</dd>
        </div>
        <div>
          <dt><LockKeyhole aria-hidden="true" size={16} />{t('mixed 监听', 'Mixed listener')}</dt>
          <dd className="built-in-proxy-settings-workspace__detail-value"><code>{mixedListenText}</code></dd>
          <dd className="built-in-proxy-settings-workspace__detail-hint">{accessPresentation === 'ready'
            ? settings.lanEnabled
              ? t('正在允许局域网访问', 'LAN access is active')
              : t('正在仅限本机访问', 'Local-only access is active')
            : settings.lanEnabled
              ? t('计划允许局域网访问', 'Planned LAN access')
              : t('计划仅限本机访问', 'Planned local-only access')}</dd>
        </div>
      </dl>

      <div
        className="built-in-proxy-settings-workspace__toggles"
        role="group"
        aria-label={t('入口暴露与启动', 'Endpoint exposure and startup')}
      >
        <label className={`built-in-proxy-settings-workspace__toggle ${settings.lanEnabled ? 'is-warning' : ''}`}>
          <span className="built-in-proxy-settings-workspace__toggle-copy">
            <strong id={lanLabelId}>{t('允许局域网访问', 'Allow LAN access')}</strong>
            <small id={lanDescriptionId}>{settings.lanEnabled
              ? t(
                  '同一网络中的设备可能未经额外认证访问 mixed 入口；仅应在可信网络中开启。',
                  'Devices on the same network may reach the mixed endpoint without additional authentication; enable this only on a trusted network.',
                )
              : t('mixed 入口仅监听本机回环。', 'The mixed endpoint listens on local loopback only.')}</small>
          </span>
          <span className="built-in-proxy-settings-workspace__switch">
            {lanPending && <LoaderCircle aria-hidden="true" size={13} className="spin" />}
            <input
              ref={lanToggleRef}
              type="checkbox"
              role="switch"
              checked={settings.lanEnabled}
              disabled={controlsDisabled || lanPending}
              aria-labelledby={lanLabelId}
              aria-describedby={lanDescriptionId}
              aria-busy={lanPending || undefined}
              onChange={(event) => {
                if (event.currentTarget.checked) setConfirmLan(true)
                else onLanEnabledChange(false)
              }}
            />
            <span aria-hidden="true" />
          </span>
        </label>

        <label className="built-in-proxy-settings-workspace__toggle">
          <span className="built-in-proxy-settings-workspace__toggle-copy">
            <strong id={autoStartLabelId}><Power aria-hidden="true" size={15} />{t('随 Stone+ 启动', 'Start with Stone+')}</strong>
            <small id={autoStartDescriptionId}>{t(
              '应用启动时恢复内置代理的期望开启状态。',
              'Restore the desired built-in proxy state when the app starts.',
            )}</small>
          </span>
          <span className="built-in-proxy-settings-workspace__switch">
            {autoStartPending && <LoaderCircle aria-hidden="true" size={13} className="spin" />}
            <input
              type="checkbox"
              role="switch"
              checked={settings.autoStart}
              disabled={controlsDisabled || autoStartPending}
              aria-labelledby={autoStartLabelId}
              aria-describedby={autoStartDescriptionId}
              aria-busy={autoStartPending || undefined}
              onChange={(event) => onAutoStartChange(event.currentTarget.checked)}
            />
            <span aria-hidden="true" />
          </span>
        </label>
      </div>

      <aside
        id={safetyId}
        className="built-in-proxy-settings-workspace__safety"
        aria-labelledby={safetyHeadingId}
      >
        <div aria-hidden="true"><ShieldCheck size={18} /></div>
        <div>
          <h3 id={safetyHeadingId}>{t('本机安全边界', 'Local security boundary')}</h3>
          <ul>
            <li><LockKeyhole aria-hidden="true" size={14} />{t(
              '控制接口始终只监听回环，不随局域网开关暴露。',
              'The controller always listens on loopback and is never exposed by the LAN switch.',
            )}</li>
            <li><KeyRound aria-hidden="true" size={14} />{t(
              '控制接口使用随机密钥；密钥不会发送到页面。',
              'The controller uses a random secret that is never sent to this page.',
            )}</li>
            <li><Router aria-hidden="true" size={14} />{t(
              'TUN 仅使用本次启动的临时提权，不安装常驻特权服务。',
              'TUN uses temporary elevation for the current start and installs no persistent privileged service.',
            )}</li>
          </ul>
        </div>
      </aside>

      {lanConfirmationOpen && (
        <ConfirmDialog
          open
          title={t('允许局域网访问？', 'Allow LAN access?')}
          message={t(
            '同一网络中的设备可能未经额外认证使用 mixed 入口。请仅在可信局域网中开启。控制接口仍保持回环监听。',
            'Devices on the same network may use the mixed endpoint without additional authentication. Enable this only on a trusted LAN. The controller remains loopback-only.',
          )}
          confirmLabel={t('确认开启', 'Enable LAN access')}
          busy={lanPending}
          onCancel={closeLanConfirmation}
          onConfirm={() => {
            void Promise.resolve(onLanEnabledChange(true)).then((success) => {
              if (success !== false) closeLanConfirmation()
            }).catch(() => undefined)
          }}
        />
      )}
    </section>
  )
}

function resolveAccessPresentation(
  runtime: BuiltInProxyRuntimeState,
  settingsPending: boolean,
): AccessPresentation {
  if (
    settingsPending
    || runtime.status === 'starting'
    || runtime.status === 'stopping'
    || runtime.accessState.status === 'applying'
  ) return 'applying'

  const port = runtime.effectiveRoute.mixedPort
  const endpointPort = loopbackEndpointPort(runtime.accessState.endpoint)
  const expectedRoute = runtime.settings.accessMode === 'tun' ? 'built-in-tun' : 'built-in-mixed'
  if (
    runtime.desiredEnabled
    && !runtime.error
    && runtime.status === 'ready'
    && runtime.routeGeneration === runtime.effectiveRoute.generation
    && runtime.accessState.status === 'ready'
    && runtime.accessState.mode === runtime.settings.accessMode
    && Number.isFinite(runtime.accessState.verifiedAt)
    && runtime.effectiveRoute.kind === expectedRoute
    && validPort(port)
    && endpointPort === port
  ) return 'ready'

  if (
    runtime.status === 'error'
    || runtime.accessState.status === 'error'
    || runtime.effectiveRoute.kind === 'blocked'
    || runtime.error
  ) return 'error'
  return 'idle'
}

function resolveMixedPort(runtime: BuiltInProxyRuntimeState, useEffectiveRoute: boolean): number | undefined {
  if (useEffectiveRoute && validPort(runtime.effectiveRoute.mixedPort)) return runtime.effectiveRoute.mixedPort
  return validPort(runtime.settings.mixedPort) ? runtime.settings.mixedPort : undefined
}

function loopbackEndpointPort(value: string | undefined): number | undefined {
  if (!value) return undefined
  try {
    const endpoint = new URL(value)
    if (
      endpoint.protocol !== 'http:'
      || endpoint.hostname !== '127.0.0.1'
      || endpoint.username
      || endpoint.password
      || endpoint.pathname !== '/'
      || endpoint.search
      || endpoint.hash
    ) return undefined
    const port = Number(endpoint.port)
    return validPort(port) ? port : undefined
  } catch {
    return undefined
  }
}

function validPort(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 65_535
}
