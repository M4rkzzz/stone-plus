import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type PropsWithChildren, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, Check, LoaderCircle, MoreHorizontal, X } from 'lucide-react'
import type { AccountCircuitState, AccountImportProgress, AccountStatus, Protocol, RequestLog } from '@shared/types'

export const protocolLabels: Record<Protocol, string> = {
  'anthropic-messages': 'Anthropic Messages',
  'openai-responses': 'OpenAI Responses',
  'openai-chat': 'OpenAI Chat',
  gemini: 'Gemini',
}

export const accountStatusLabels: Record<AccountStatus, string> = {
  active: '可用',
  cooldown: '冷却中',
  disabled: '已停用',
  expired: '已过期',
  checking: '检测中',
}

export const requestStatusLabels: Record<RequestLog['status'], string> = {
  success: '成功',
  error: '失败',
  streaming: '传输中',
}

export function Badge({ tone = 'neutral', children }: PropsWithChildren<{ tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }>) {
  return <span className={`badge badge--${tone}`}>{children}</span>
}

export function AccountStatusBadge({ status, circuitState }: { status: AccountStatus; circuitState?: AccountCircuitState }) {
  if (circuitState === 'half-open') return <Badge tone="warning">探测中</Badge>
  if (circuitState === 'open' && status === 'active') return <Badge tone="danger">已熔断</Badge>
  const tone = status === 'active' ? 'success' : status === 'cooldown' || status === 'checking' ? 'warning' : 'danger'
  return (
    <Badge tone={tone}>
      {status === 'checking' && <LoaderCircle size={12} className="spin" />}
      {accountStatusLabels[status]}
    </Badge>
  )
}

export function RequestStatusBadge({ status }: { status: RequestLog['status'] }) {
  const tone = status === 'success' ? 'success' : status === 'streaming' ? 'info' : 'danger'
  return <Badge tone={tone}>{requestStatusLabels[status]}</Badge>
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: ReactNode
}) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </div>
  )
}

export function Modal({
  open,
  title,
  description,
  children,
  footer,
  onClose,
  width = 'medium',
  closable = true,
}: {
  open: boolean
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
  width?: 'small' | 'medium' | 'large' | 'xlarge'
  closable?: boolean
}) {
  const titleId = useId()

  useEffect(() => {
    if (!open || !closable) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [closable, onClose, open])

  if (!open) return null
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => closable && event.target === event.currentTarget && onClose()}>
      <section className={`modal modal--${width}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="modal__header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          {closable && (
            <button type="button" className="icon-button" onClick={onClose} title="关闭">
              <X size={18} />
            </button>
          )}
        </header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__footer">{footer}</footer>}
      </section>
    </div>
  )
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = '删除',
  busy,
  onCancel,
  onConfirm,
}: {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      width="small"
      footer={
        <>
          <button type="button" className="button button--secondary" onClick={onCancel} disabled={busy}>
            取消
          </button>
          <button type="button" className="button button--danger" onClick={onConfirm} disabled={busy}>
            {busy && <LoaderCircle size={16} className="spin" />}
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="confirm-message">
        <AlertCircle size={20} />
        <p>{message}</p>
      </div>
    </Modal>
  )
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      className={`toggle ${checked ? 'toggle--on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  )
}

export function OverflowMenu({
  open,
  onOpenChange,
  label,
  children,
}: PropsWithChildren<{
  open: boolean
  onOpenChange: (open: boolean) => void
  label: string
}>) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' })

  useLayoutEffect(() => {
    if (!open) return
    const updatePosition = () => {
      const trigger = triggerRef.current
      const menu = menuRef.current
      if (!trigger || !menu) return
      const triggerRect = trigger.getBoundingClientRect()
      const menuRect = menu.getBoundingClientRect()
      const viewportMargin = 8
      const gap = 4
      const maximumLeft = Math.max(viewportMargin, window.innerWidth - menuRect.width - viewportMargin)
      const left = Math.max(viewportMargin, Math.min(maximumLeft, triggerRect.right - menuRect.width))
      const roomBelow = window.innerHeight - triggerRect.bottom - viewportMargin
      const top = roomBelow >= menuRect.height + gap
        ? triggerRect.bottom + gap
        : Math.max(viewportMargin, triggerRect.top - menuRect.height - gap)
      setPosition({ top, left, visibility: 'visible' })
    }
    updatePosition()
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) onOpenChange(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onOpenChange(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [onOpenChange, open])

  return <div className="menu-wrap">
    <button
      ref={triggerRef}
      className="icon-button"
      type="button"
      title={label}
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={() => onOpenChange(!open)}
    >
      <MoreHorizontal size={18} />
    </button>
    {open && createPortal(
      <div ref={menuRef} className="context-menu context-menu--portal" role="menu" style={position}>{children}</div>,
      document.body,
    )}
  </div>
}

export function ImportProgress({ progress }: { progress: AccountImportProgress }) {
  const percent = Math.max(0, Math.min(100, Math.round(progress.percent)))
  const phaseLabel = progress.phase === 'importing' ? '导入账号' : progress.phase === 'refreshing' ? '刷新状态与模型' : '处理完成'
  return <div className="account-import-progress" role="progressbar" aria-label="账号导入总体进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
    <div className="account-import-progress__heading"><strong>{phaseLabel}</strong><span>{percent}%</span></div>
    <div className="account-import-progress__track"><span style={{ width: `${percent}%` }} /></div>
    <div className="account-import-progress__detail"><span>{progress.message}</span><small>导入 0–50% · 状态与模型 50–100%</small></div>
  </div>
}

export function EmptyState({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  )
}

export function FieldError({ children }: PropsWithChildren) {
  if (!children) return null
  return <span className="field-error">{children}</span>
}

export function SaveButton({ busy, label = '保存' }: { busy?: boolean; label?: string }) {
  return (
    <button type="submit" className="button button--primary" disabled={busy}>
      {busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}
      {label}
    </button>
  )
}

export function formatCompactNumber(value: number) {
  return new Intl.NumberFormat('zh-CN', { notation: value >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value)
}

export function formatDateTime(value?: number) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(value)
}

export function relativeTime(value?: number) {
  if (!value) return '从未'
  const seconds = Math.max(1, Math.round((Date.now() - value) / 1000))
  if (seconds < 60) return `${seconds} 秒前`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

export function durationLabel(milliseconds: number) {
  if (milliseconds < 1000) return `${milliseconds} ms`
  return `${(milliseconds / 1000).toFixed(milliseconds >= 10000 ? 1 : 2)} s`
}

export function gatewayBaseUrl(host: string, port: number) {
  const address = host.includes(':') ? `[${host}]` : host
  return `http://${address}:${port}`
}
