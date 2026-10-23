import { Component, createRef, type ErrorInfo, type ReactNode } from 'react'
import { RefreshCw, TriangleAlert } from 'lucide-react'
import { useI18n } from './i18n'

export interface BoundaryLabels {
  title: string
  description: string
  retry: string
  reload: string
}

interface BoundaryProps {
  labels: BoundaryLabels
  /** Remount-free reset signal: navigating to another page clears the error. */
  resetKey: string
  children: ReactNode
}

interface BoundaryState {
  error: Error | null
  resetKey: string
}

export class PageErrorBoundaryInner extends Component<BoundaryProps, BoundaryState> {
  readonly errorPanelRef = createRef<HTMLDivElement>()

  state: BoundaryState = {
    error: null,
    resetKey: this.props.resetKey,
  }

  static getDerivedStateFromError(error: Error): Pick<BoundaryState, 'error'> {
    return { error }
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    if (props.resetKey === state.resetKey) return null
    return { error: null, resetKey: props.resetKey }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Page render failed', error, info.componentStack)
    const panel = this.errorPanelRef.current
    if (!panel) return
    try {
      panel.focus({ preventScroll: true })
    } catch {
      panel.focus()
    }
  }

  private retry = (): void => this.setState({ error: null })

  private reload = (): void => window.location.reload()

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    const { labels } = this.props
    return (
      <div
        ref={this.errorPanelRef}
        className="page-error"
        role="alert"
        tabIndex={-1}
        aria-labelledby="page-error-title"
        aria-describedby="page-error-description"
      >
        <TriangleAlert size={28} aria-hidden="true" />
        <h2 id="page-error-title">{labels.title}</h2>
        <p id="page-error-description">{labels.description}</p>
        <div className="page-error__actions">
          <button className="button button--primary" type="button" onClick={this.retry}>
            <RefreshCw size={16} /> {labels.retry}
          </button>
          <button className="button button--secondary" type="button" onClick={this.reload}>
            {labels.reload}
          </button>
        </div>
      </div>
    )
  }
}

export function PageErrorBoundary({ resetKey, children }: { resetKey: string; children: ReactNode }) {
  const { t } = useI18n()
  const labels: BoundaryLabels = {
    title: t('页面渲染出错', 'This page failed to render'),
    description: t('该页面遇到意外错误，其余功能不受影响。', 'This page hit an unexpected error. The rest of the app keeps working.'),
    retry: t('重载本页', 'Reload this page'),
    reload: t('重启界面', 'Restart the interface'),
  }
  return <PageErrorBoundaryInner labels={labels} resetKey={resetKey}>{children}</PageErrorBoundaryInner>
}
