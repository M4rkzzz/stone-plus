import { createElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PageErrorBoundaryInner,
  type BoundaryLabels,
} from '../../src/renderer/src/page-error-boundary'

const labels: BoundaryLabels = {
  title: 'This page failed to render',
  description: 'This page hit an unexpected error. The rest of the app keeps working.',
  retry: 'Reload this page',
  reload: 'Restart the interface',
}

describe('page error boundary', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('turns a render failure into a generic fallback without exposing the error detail', () => {
    const secret = 'Bearer sk-secret-render-detail'
    const renderError = new Error(`Request to C:\\Users\\stone failed with ${secret}`)
    const ThrowingPage = (): ReactNode => {
      throw renderError
    }

    expect(() => renderToStaticMarkup(createElement(ThrowingPage))).toThrow(renderError)

    const boundary = createBoundary()
    boundary.state = {
      ...boundary.state,
      ...PageErrorBoundaryInner.getDerivedStateFromError(renderError),
    }
    const markup = renderToStaticMarkup(boundary.render() as ReactElement)

    expect(markup).toContain(labels.title)
    expect(markup).toContain(labels.description)
    expect(markup).toContain('role="alert"')
    expect(markup).toContain('tabindex="-1"')
    expect(markup).not.toContain(renderError.message)
    expect(markup).not.toContain(secret)
    expect(markup).not.toContain('C:\\Users\\stone')
  })

  it('logs the detailed render failure only to the console and focuses the fallback', () => {
    const boundary = createBoundary()
    const focus = vi.fn()
    boundary.errorPanelRef.current = { focus } as unknown as HTMLDivElement
    const error = new Error('private diagnostic detail')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    boundary.componentDidCatch(error, { componentStack: '\n    at BrokenPage' })

    expect(consoleError).toHaveBeenCalledWith('Page render failed', error, '\n    at BrokenPage')
    expect(focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('retries the current page and clears an error before a reset-key page change renders', () => {
    const error = new Error('render failed')
    const boundary = createBoundary('accounts')
    boundary.state = { error, resetKey: 'accounts' }
    const setState = vi.spyOn(boundary, 'setState').mockImplementation(() => undefined)
    const [retryButton] = findButtons(boundary.render())

    retryButton?.props.onClick?.()

    expect(setState).toHaveBeenCalledWith({ error: null })
    expect(PageErrorBoundaryInner.getDerivedStateFromProps(
      { ...boundary.props, resetKey: 'routes' },
      boundary.state,
    )).toEqual({ error: null, resetKey: 'routes' })
    expect(PageErrorBoundaryInner.getDerivedStateFromProps(boundary.props, boundary.state)).toBeNull()
  })

  it('reloads the interface only from the explicit reload action', () => {
    const reload = vi.fn()
    vi.stubGlobal('window', { location: { reload } })
    const boundary = createBoundary()
    boundary.state = { error: new Error('render failed'), resetKey: 'accounts' }
    const [, reloadButton] = findButtons(boundary.render())

    reloadButton?.props.onClick?.()

    expect(reload).toHaveBeenCalledOnce()
  })
})

function createBoundary(resetKey = 'accounts'): PageErrorBoundaryInner {
  return new PageErrorBoundaryInner({
    labels,
    resetKey,
    children: createElement('div', null, 'Healthy page'),
  })
}

interface ButtonElement {
  type: 'button'
  props: { children?: ReactNode; onClick?: () => void }
}

function findButtons(node: ReactNode): ButtonElement[] {
  if (Array.isArray(node)) return node.flatMap(findButtons)
  if (!node || typeof node !== 'object' || !('props' in node)) return []
  const element = node as ReactElement<{ children?: ReactNode; onClick?: () => void }>
  const nested = findButtons(element.props.children)
  return element.type === 'button'
    ? [{ type: 'button', props: element.props }, ...nested]
    : nested
}
