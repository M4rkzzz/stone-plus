import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type PropsWithChildren, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, Check, LoaderCircle, MoreHorizontal, X } from 'lucide-react'
import type { AccountCircuitState, AccountImportProgress, AccountStatus, Protocol, RequestLog } from '@shared/types'
import { useI18n } from './i18n'

export const protocolLabels: Record<Protocol, string> = {
  'anthropic-messages': 'Anthropic Messages',
  'openai-responses': 'OpenAI Responses',
  'openai-chat': 'OpenAI Chat',
  gemini: 'Gemini',
}

export const accountStatusLabels = {
  get active() { return localeText('可用', 'Available') },
  get cooldown() { return localeText('冷却中', 'Cooling down') },
  get disabled() { return localeText('已停用', 'Disabled') },
  get expired() { return localeText('已过期', 'Expired') },
  get checking() { return localeText('检测中', 'Checking') },
} as Record<AccountStatus, string>

export const requestStatusLabels = {
  get success() { return localeText('成功', 'Success') },
  get error() { return localeText('失败', 'Failed') },
  get streaming() { return localeText('传输中', 'Streaming') },
} as Record<RequestLog['status'], string>

export function Badge({ tone = 'neutral', children }: PropsWithChildren<{ tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }>) {
  return <span className={`badge badge--${tone}`}>{children}</span>
}

export function AccountStatusBadge({ status, circuitState }: { status: AccountStatus; circuitState?: AccountCircuitState }) {
  const { t } = useI18n()
  if (circuitState === 'half-open') return <Badge tone="warning">{t('探测中', 'Probing')}</Badge>
  if (circuitState === 'open' && status === 'active') return <Badge tone="danger">{t('已熔断', 'Circuit open')}</Badge>
  const tone = status === 'active' ? 'success' : status === 'cooldown' || status === 'checking' ? 'warning' : 'danger'
  return (
    <Badge tone={tone}>
      {status === 'checking' && <LoaderCircle size={12} className="spin" />}
      {t(accountStatusLabelsZh[status], accountStatusLabelsEn[status])}
    </Badge>
  )
}

export function RequestStatusBadge({ status, statusCode, requestKind }: {
  status: RequestLog['status']
  statusCode?: number
  requestKind?: RequestLog['requestKind']
}) {
  const { t } = useI18n()
  if (status === 'success' && requestKind === 'compaction') {
    return <Badge tone="info">{t('压缩', 'Compaction')}</Badge>
  }
  const tone = status === 'success' ? statusCode === 499 ? 'warning' : 'success' : status === 'streaming' ? 'info' : 'danger'
  return <Badge tone={tone}>{t(requestStatusLabelsZh[status], requestStatusLabelsEn[status])}</Badge>
}

export function InfoTip({ text, focusable = true }: { text: string; focusable?: boolean }) {
  return (
    <span className="info-tip" tabIndex={focusable ? 0 : undefined} role="img" aria-label={text} data-tooltip={text}>
      <AlertCircle aria-hidden="true" size={13} />
    </span>
  )
}

export function PageHeader({
  title,
  actions,
}: {
  title: string
  actions?: ReactNode
}) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
      </div>
      {actions && <div className="page-header__actions">{actions}</div>}
    </div>
  )
}

interface ModalStackEntry {
  id: symbol
  backdrop: HTMLDivElement
  dialog: HTMLElement
  closable: () => boolean
  close: () => void
  restoreFocusTo: HTMLElement | null
}

interface BackgroundIsolationSnapshot {
  element: Element
  inert: string | null
  ariaHidden: string | null
}

const modalStack: ModalStackEntry[] = []
const focusableSelector = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  'audio[controls]',
  'video[controls]',
  'summary',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')
let isolatedBackground: BackgroundIsolationSnapshot[] = []
let modalListenerDocument: Document | null = null

function topModal(): ModalStackEntry | undefined {
  return modalStack[modalStack.length - 1]
}

function isTopModal(id: symbol): boolean {
  return topModal()?.id === id
}

function handleModalKeyDown(event: KeyboardEvent): void {
  const modal = topModal()
  if (!modal) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    if (modal.closable()) modal.close()
    return
  }
  if (event.key !== 'Tab') return
  trapModalTabKey(event, modal.dialog)
}

function trapModalTabKey(event: KeyboardEvent, dialog: HTMLElement): void {
  const focusable = focusableElements(dialog)
  const activeElement = dialog.ownerDocument.activeElement
  if (focusable.length === 0) {
    event.preventDefault()
    event.stopPropagation()
    focusElement(dialog)
    return
  }
  const activeIndex = focusable.findIndex((element) => element === activeElement)
  if (activeIndex < 0) {
    event.preventDefault()
    event.stopPropagation()
    focusElement(event.shiftKey ? focusable[focusable.length - 1] : focusable[0])
    return
  }
  const atBoundary = event.shiftKey ? activeIndex === 0 : activeIndex === focusable.length - 1
  if (!atBoundary) return
  event.preventDefault()
  event.stopPropagation()
  focusElement(event.shiftKey ? focusable[focusable.length - 1] : focusable[0])
}

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
    .map((element, index) => ({ element, index }))
    .filter(({ element }) => canReceiveModalFocus(element))
    .sort((left, right) => {
      const leftOrder = left.element.tabIndex > 0 ? left.element.tabIndex : Number.MAX_SAFE_INTEGER
      const rightOrder = right.element.tabIndex > 0 ? right.element.tabIndex : Number.MAX_SAFE_INTEGER
      return leftOrder === rightOrder ? left.index - right.index : leftOrder - rightOrder
    })
    .map(({ element }) => element)
}

function canReceiveModalFocus(element: HTMLElement): boolean {
  if (element.tabIndex < 0 || element.matches(':disabled')) return false
  if (element.closest('[inert], [hidden], [aria-hidden="true"]')) return false
  const view = element.ownerDocument.defaultView
  const style = view?.getComputedStyle(element)
  if (style?.display === 'none' || style?.visibility === 'hidden') return false
  return typeof element.getClientRects !== 'function' || element.getClientRects().length > 0
}

function focusInitialModalElement(dialog: HTMLElement): void {
  const activeElement = dialog.ownerDocument.activeElement
  if (activeElement && dialog.contains(activeElement)) return
  const explicitTarget = dialog.querySelector<HTMLElement>('[autofocus]')
  const safeTarget = dialog.querySelector<HTMLElement>('[data-modal-initial-focus]')
  const target = [explicitTarget, safeTarget].find((element): element is HTMLElement => (
    Boolean(element && canReceiveModalFocus(element))
  )) ?? focusableElements(dialog)[0] ?? dialog
  focusElement(target)
}

function focusElement(element: HTMLElement): void {
  try {
    element.focus({ preventScroll: true })
  } catch {
    element.focus()
  }
}

function registerModal(entry: ModalStackEntry): void {
  modalStack.push(entry)
  syncModalListener()
  refreshBackgroundIsolation()
  focusInitialModalElement(entry.dialog)
}

function unregisterModal(entry: ModalStackEntry): void {
  const index = modalStack.findIndex((candidate) => candidate.id === entry.id)
  if (index < 0) return
  modalStack.splice(index, 1)
  syncModalListener()
  refreshBackgroundIsolation()
  queueMicrotask(() => restoreModalFocus(entry))
}

function syncModalListener(): void {
  const nextDocument = topModal()?.dialog.ownerDocument ?? null
  if (modalListenerDocument === nextDocument) return
  modalListenerDocument?.removeEventListener('keydown', handleModalKeyDown, true)
  modalListenerDocument = nextDocument
  modalListenerDocument?.addEventListener('keydown', handleModalKeyDown, true)
}

function refreshBackgroundIsolation(): void {
  for (const snapshot of isolatedBackground) {
    restoreAttribute(snapshot.element, 'inert', snapshot.inert)
    restoreAttribute(snapshot.element, 'aria-hidden', snapshot.ariaHidden)
  }
  isolatedBackground = []

  const modal = topModal()
  if (!modal) return
  let branch: Element = modal.backdrop
  const body = modal.dialog.ownerDocument.body
  while (branch.parentElement) {
    const parent = branch.parentElement
    for (const sibling of Array.from(parent.children)) {
      if (sibling === branch) continue
      isolatedBackground.push({
        element: sibling,
        inert: sibling.getAttribute('inert'),
        ariaHidden: sibling.getAttribute('aria-hidden'),
      })
      sibling.setAttribute('inert', '')
      sibling.setAttribute('aria-hidden', 'true')
    }
    if (parent === body) break
    branch = parent
  }
}

function restoreAttribute(element: Element, name: string, value: string | null): void {
  if (value === null) element.removeAttribute(name)
  else element.setAttribute(name, value)
}

function restoreModalFocus(entry: ModalStackEntry): void {
  // React Strict Mode deliberately re-runs layout effects. A layer registered
  // again with the same identity is still open and must retain focus.
  if (modalStack.some((candidate) => candidate.id === entry.id)) return
  const currentTop = topModal()
  const target = entry.restoreFocusTo
  if (target && canRestoreModalFocus(target) && (!currentTop || currentTop.dialog.contains(target))) {
    focusElement(target)
    return
  }
  if (currentTop) focusInitialModalElement(currentTop.dialog)
}

function canRestoreModalFocus(element: HTMLElement): boolean {
  return element.isConnected
    && !element.matches(':disabled')
    && !element.closest('[inert], [hidden], [aria-hidden="true"]')
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
  busy = false,
  dialogRole = 'dialog',
  describedBy,
}: {
  open: boolean
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
  width?: 'small' | 'medium' | 'large' | 'xlarge'
  closable?: boolean
  busy?: boolean
  dialogRole?: 'dialog' | 'alertdialog'
  describedBy?: string
}) {
  const { t } = useI18n()
  const titleId = useId()
  const descriptionId = useId()
  const backdropRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const modalIdRef = useRef<symbol | null>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  const wasOpenRef = useRef(false)
  const onCloseRef = useRef(onClose)
  const closableRef = useRef(closable)
  onCloseRef.current = onClose
  closableRef.current = closable
  if (!modalIdRef.current) modalIdRef.current = Symbol('modal')
  const modalId = modalIdRef.current
  const ariaDescribedBy = [description ? descriptionId : undefined, describedBy]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(' ') || undefined

  // Capture the opener during the closed -> open render, before React applies
  // a descendant's autoFocus during commit. The ref write is intentionally
  // render-local and is refreshed for every later reopening of this instance.
  if (open && !wasOpenRef.current && typeof document !== 'undefined') {
    const activeElement = document.activeElement
    restoreFocusRef.current = activeElement instanceof HTMLElement ? activeElement : null
  }
  wasOpenRef.current = open

  useLayoutEffect(() => {
    if (!open || !backdropRef.current || !dialogRef.current) return
    const dialog = dialogRef.current
    const activeElement = dialog.ownerDocument.activeElement
    if (activeElement instanceof HTMLElement && !dialog.contains(activeElement)) restoreFocusRef.current = activeElement
    else if (restoreFocusRef.current && !restoreFocusRef.current.isConnected) restoreFocusRef.current = null
    const entry: ModalStackEntry = {
      id: modalId,
      backdrop: backdropRef.current,
      dialog,
      closable: () => closableRef.current,
      close: () => onCloseRef.current(),
      restoreFocusTo: restoreFocusRef.current,
    }
    registerModal(entry)
    return () => unregisterModal(entry)
  }, [modalId, open])

  const requestClose = () => {
    if (closableRef.current && isTopModal(modalId)) onCloseRef.current()
  }

  if (!open) return null
  const modalContent = (
    <div ref={backdropRef} className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
      <section
        ref={dialogRef}
        className={`modal modal--${width}`}
        role={dialogRole}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={ariaDescribedBy}
        aria-busy={busy || undefined}
        tabIndex={-1}
      >
        <header className="modal__header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p id={descriptionId}>{description}</p>}
          </div>
          {closable && (
            <button type="button" className="icon-button" onClick={requestClose} title={t('关闭', 'Close')} aria-label={t('关闭', 'Close')}>
              <X aria-hidden="true" size={18} />
            </button>
          )}
        </header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__footer">{footer}</footer>}
      </section>
    </div>
  )
  return typeof document !== 'undefined' && document.body
    ? createPortal(modalContent, document.body)
    : modalContent
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
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
  const { t } = useI18n()
  const messageId = useId()
  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      width="small"
      closable={!busy}
      busy={busy}
      dialogRole="alertdialog"
      describedBy={messageId}
      footer={
        <>
          <button type="button" className="button button--secondary" data-modal-initial-focus onClick={onCancel} disabled={busy}>
            {t('取消', 'Cancel')}
          </button>
          <button type="button" className="button button--danger" onClick={onConfirm} disabled={busy}>
            {busy && <LoaderCircle size={16} className="spin" />}
            {confirmLabel ?? t('删除', 'Delete')}
          </button>
        </>
      }
    >
      <div id={messageId} className="confirm-message">
        <AlertCircle aria-hidden="true" size={20} />
        <p>{message}</p>
      </div>
    </Modal>
  )
}

export function Toggle({ checked, onChange, label, disabled = false }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
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
  const { t, language } = useI18n()
  const percent = Math.max(0, Math.min(100, Math.round(progress.percent)))
  const phaseLabel = progress.phase === 'importing' ? t('导入账号', 'Importing accounts') : progress.phase === 'refreshing' ? t('刷新状态与模型', 'Refreshing status and models') : t('处理完成', 'Complete')
  return <div className="account-import-progress" role="progressbar" aria-label={t('账号导入总体进度', 'Overall account import progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
    <div className="account-import-progress__heading"><strong>{phaseLabel}</strong><span>{percent}%</span></div>
    <div className="account-import-progress__track"><span style={{ width: `${percent}%` }} /></div>
    <div className="account-import-progress__detail"><span>{importProgressMessage(progress.message, language)}</span></div>
  </div>
}

export function EmptyState({ icon, title, description, action }: { icon: ReactNode; title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">{icon}</div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  )
}

export function FieldError({ children }: PropsWithChildren) {
  if (!children) return null
  return <span className="field-error">{children}</span>
}

export function SaveButton({ busy, label }: { busy?: boolean; label?: string }) {
  const { t } = useI18n()
  return (
    <button type="submit" className="button button--primary" disabled={busy}>
      {busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}
      {label ?? t('保存', 'Save')}
    </button>
  )
}

export function formatCompactNumber(value: number, locale = currentLocale()) {
  return new Intl.NumberFormat(locale, { notation: value >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value)
}

export function formatDateTime(value?: number, locale = currentLocale()) {
  if (!value) return '—'
  return new Intl.DateTimeFormat(locale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(value)
}

export function relativeTime(value?: number, locale = currentLocale()) {
  const chinese = isChineseLocale(locale)
  if (!value) return chinese ? '从未' : 'Never'
  const seconds = Math.max(1, Math.round((Date.now() - value) / 1000))
  if (seconds < 60) return chinese ? `${seconds} 秒前` : `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return chinese ? `${minutes} 分钟前` : `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return chinese ? `${hours} 小时前` : `${hours}h ago`
  const days = Math.round(hours / 24)
  return chinese ? `${days} 天前` : `${days}d ago`
}

export function durationLabel(milliseconds: number) {
  if (milliseconds < 1000) return `${milliseconds} ms`
  return `${(milliseconds / 1000).toFixed(milliseconds >= 10000 ? 1 : 2)} s`
}

export function gatewayBaseUrl(host: string, port: number) {
  const address = host.includes(':') ? `[${host}]` : host
  return `http://${address}:${port}`
}

const accountStatusLabelsZh: Record<AccountStatus, string> = {
  active: '可用',
  cooldown: '冷却中',
  disabled: '已停用',
  expired: '已过期',
  checking: '检测中',
}

const accountStatusLabelsEn: Record<AccountStatus, string> = {
  active: 'Available',
  cooldown: 'Cooling down',
  disabled: 'Disabled',
  expired: 'Expired',
  checking: 'Checking',
}

const requestStatusLabelsZh: Record<RequestLog['status'], string> = {
  success: '成功',
  error: '失败',
  streaming: '传输中',
}

const requestStatusLabelsEn: Record<RequestLog['status'], string> = {
  success: 'Success',
  error: 'Failed',
  streaming: 'Streaming',
}

function currentLocale(): string {
  if (typeof window === 'undefined') return 'en-US'
  try {
    const preference = window.localStorage.getItem('stone.ui.language')
    if (preference === 'zh-CN') return 'zh-CN'
    if (preference === 'en') return 'en-US'
  } catch {
    // Fall through to the system language.
  }
  const resolved = navigator.language || document.documentElement.lang
  return isChineseLocale(resolved) ? 'zh-CN' : 'en-US'
}

function isChineseLocale(locale: string): boolean {
  return /^zh(?:[-_]|$)/i.test(locale)
}

function localeText(chinese: string, english: string): string {
  return isChineseLocale(currentLocale()) ? chinese : english
}

function importProgressMessage(message: string, language: 'zh-CN' | 'en'): string {
  if (language === 'zh-CN' || !/[\u3400-\u9fff]/u.test(message)) return message
  const patterns: Array<[RegExp, string | ((match: RegExpMatchArray) => string)]> = [
    [/^正在解析并导入账号…?$/, 'Parsing and importing accounts…'],
    [/^已导入\s*(\d+)\s*个账号$/, (match) => `Imported ${match[1]} account(s)`],
    [/^正在刷新状态与查询模型\s*(\d+)\/(\d+)$/, (match) => `Refreshing status and models ${match[1]}/${match[2]}`],
    [/^正在整理 Tag 与号池成员…?$/, 'Organizing Tags and pool members…'],
    [/^导入、状态刷新与模型查询已完成$/, 'Import, status refresh, and model lookup complete'],
    [/^正在导入文件\s*(\d+)\/(\d+)$/, (match) => `Importing files ${match[1]}/${match[2]}`],
    [/^正在准备(?:批量)?导入…?$/, 'Preparing import…'],
    [/^等待选择账号文件…?$/, 'Waiting for account files…'],
  ]
  for (const [pattern, replacement] of patterns) {
    const match = message.match(pattern)
    if (match) return typeof replacement === 'string' ? replacement : replacement(match)
  }
  return 'Processing account import…'
}
