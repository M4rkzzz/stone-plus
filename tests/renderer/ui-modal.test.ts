import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../../src/renderer/src/i18n'
import { ConfirmDialog, Modal } from '../../src/renderer/src/ui'

describe('shared modal accessibility', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      localStorage: { getItem: () => 'en', setItem: () => undefined },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })
    vi.stubGlobal('navigator', { language: 'en-US' })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('associates the title and description with a focusable modal dialog', () => {
    const markup = renderToStaticMarkup(createElement(
      I18nProvider,
      null,
      createElement(Modal, {
        open: true,
        title: 'Route details',
        description: 'Current published generation',
        onClose: vi.fn(),
        children: 'Body',
      }),
    ))

    expect(markup).toContain('role="dialog"')
    expect(markup).toContain('aria-modal="true"')
    expect(markup).toContain('tabindex="-1"')
    expect(markup).toContain('aria-label="Close"')
    const titleId = attribute(markup, 'aria-labelledby')
    const descriptionId = attribute(markup, 'aria-describedby')
    expect(markup).toContain(`id="${titleId}"`)
    expect(markup).toContain(`id="${descriptionId}"`)
  })

  it('uses alert-dialog semantics and a safe initial focus target for confirmations', () => {
    const markup = renderToStaticMarkup(createElement(
      I18nProvider,
      null,
      createElement(ConfirmDialog, {
        open: true,
        title: 'Delete profile?',
        message: 'This removes encrypted credentials.',
        onCancel: vi.fn(),
        onConfirm: vi.fn(),
      }),
    ))

    expect(markup).toContain('role="alertdialog"')
    expect(markup).toMatch(/<button(?=[^>]*data-modal-initial-focus="true")(?=[^>]*>Cancel<)[^>]*>/)
    const descriptionId = attribute(markup, 'aria-describedby')
    expect(markup).toContain(`id="${descriptionId}"`)
    expect(markup).toContain('This removes encrypted credentials.')
  })

  it('keeps a busy confirmation modal and its background dismissal locked', () => {
    const markup = renderToStaticMarkup(createElement(
      I18nProvider,
      null,
      createElement(ConfirmDialog, {
        open: true,
        busy: true,
        title: 'Enable LAN access?',
        message: 'Applying the new mixed listener.',
        onCancel: vi.fn(),
        onConfirm: vi.fn(),
      }),
    ))

    expect(markup).toContain('role="alertdialog"')
    expect(markup).toContain('aria-busy="true"')
    expect(markup).not.toContain('aria-label="Close"')
    expect(markup.match(/<button[^>]*disabled=""/g)).toHaveLength(2)
  })

  it('isolates the background, traps focus, restores the trigger, and closes only the top layer', async () => {
    const layoutEffects: Array<() => void | (() => void)> = []
    vi.resetModules()
    vi.doMock('react', async () => {
      const actual = await vi.importActual<typeof import('react')>('react')
      let id = 0
      return {
        ...actual,
        useId: () => `modal-test-${++id}`,
        useLayoutEffect: (effect: () => void | (() => void)) => layoutEffects.push(effect),
        useRef: <T>(initial: T) => ({ current: initial }),
      }
    })
    vi.doMock('../../src/renderer/src/i18n', () => ({
      useI18n: () => ({ t: <T>(_chinese: T, english: T) => english }),
    }))
    vi.doMock('react-dom', async () => {
      const actual = await vi.importActual<typeof import('react-dom')>('react-dom')
      return { ...actual, createPortal: (children: ReactNode) => children }
    })

    try {
      const { Modal: IsolatedModal } = await import('../../src/renderer/src/ui')
      const document = new FakeDocument()
      vi.stubGlobal('HTMLElement', FakeElement)
      vi.stubGlobal('document', document)
      const app = document.body.append(new FakeElement(document))
      const trigger = app.append(new FakeElement(document))
      const preservedBackground = document.body.append(new FakeElement(document))
      preservedBackground.setAttribute('inert', 'persisted')
      preservedBackground.setAttribute('aria-hidden', 'false')
      document.activeElement = trigger

      const parentClose = vi.fn()
      const parentLayer = mountFakeModal(
        IsolatedModal({ open: true, title: 'Parent', onClose: parentClose, children: 'Parent body' }),
        document,
        document.body,
      )
      const parentCleanup = runNextLayoutEffect(layoutEffects)
      expect(parentLayer.first.focusCount).toBe(1)
      expect(app.getAttribute('inert')).toBe('')
      expect(app.getAttribute('aria-hidden')).toBe('true')

      document.activeElement = parentLayer.last
      const forwardTab = fakeKeyEvent('Tab')
      document.keydown?.(forwardTab)
      expect(forwardTab.preventDefault).toHaveBeenCalledOnce()
      expect(parentLayer.first.focusCount).toBe(2)

      document.activeElement = parentLayer.first
      const reverseTab = fakeKeyEvent('Tab', true)
      document.keydown?.(reverseTab)
      expect(reverseTab.preventDefault).toHaveBeenCalledOnce()
      expect(parentLayer.last.focusCount).toBe(1)

      const childTrigger = parentLayer.dialog.append(new FakeElement(document))
      document.activeElement = childTrigger
      const lockedClose = vi.fn()
      const lockedLayer = mountFakeModal(
        IsolatedModal({ open: true, title: 'Locked child', closable: false, onClose: lockedClose, children: 'Busy' }),
        document,
        document.body,
      )
      const lockedCleanup = runNextLayoutEffect(layoutEffects)
      const lockedEscape = fakeKeyEvent('Escape')
      document.keydown?.(lockedEscape)
      expect(lockedClose).not.toHaveBeenCalled()
      expect(parentClose).not.toHaveBeenCalled()
      expect(lockedEscape.stopImmediatePropagation).toHaveBeenCalledOnce()
      lockedCleanup?.()
      document.body.remove(lockedLayer.backdrop)
      await flushMicrotasks()
      expect(childTrigger.focusCount).toBe(1)

      document.activeElement = childTrigger
      const childClose = vi.fn()
      const childLayer = mountFakeModal(
        IsolatedModal({ open: true, title: 'Child', onClose: childClose, children: 'Child body' }),
        document,
        document.body,
      )
      const childCleanup = runNextLayoutEffect(layoutEffects)
      expect(parentLayer.backdrop.getAttribute('inert')).toBe('')
      expect(childLayer.first.focusCount).toBe(1)

      const escape = fakeKeyEvent('Escape')
      document.keydown?.(escape)
      expect(childClose).toHaveBeenCalledOnce()
      expect(parentClose).not.toHaveBeenCalled()
      expect(escape.stopImmediatePropagation).toHaveBeenCalledOnce()

      childCleanup?.()
      document.body.remove(childLayer.backdrop)
      await flushMicrotasks()
      expect(childTrigger.focusCount).toBe(2)
      expect(parentLayer.backdrop.getAttribute('inert')).toBeNull()

      document.keydown?.(fakeKeyEvent('Escape'))
      expect(parentClose).toHaveBeenCalledOnce()

      parentCleanup?.()
      document.body.remove(parentLayer.backdrop)
      await flushMicrotasks()
      expect(trigger.focusCount).toBe(1)
      expect(app.getAttribute('inert')).toBeNull()
      expect(app.getAttribute('aria-hidden')).toBeNull()
      expect(preservedBackground.getAttribute('inert')).toBe('persisted')
      expect(preservedBackground.getAttribute('aria-hidden')).toBe('false')
      expect(document.keydown).toBeNull()
    } finally {
      vi.doUnmock('react')
      vi.doUnmock('../../src/renderer/src/i18n')
      vi.doUnmock('react-dom')
      vi.resetModules()
    }
  })
})

function attribute(markup: string, name: string): string {
  const value = markup.match(new RegExp(`${name}="([^"]+)"`))?.[1]
  expect(value).toBeTruthy()
  return value ?? ''
}

interface TestReactElement {
  type?: unknown
  props: Record<string, unknown> & { children?: ReactNode; className?: string; ref?: { current: unknown } }
}

function findReactElement(node: unknown, predicate: (element: TestReactElement) => boolean): TestReactElement | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findReactElement(child, predicate)
      if (match) return match
    }
    return undefined
  }
  if (!node || typeof node !== 'object') return undefined
  const element = node as Partial<TestReactElement>
  if (element.props && predicate(element as TestReactElement)) return element as TestReactElement
  return findReactElement(element.props?.children, predicate)
}

function mountFakeModal(
  tree: unknown,
  document: FakeDocument,
  app: FakeElement,
): { backdrop: FakeElement; dialog: FakeElement; first: FakeElement; last: FakeElement } {
  const backdropElement = findReactElement(tree, (element) => (
    element.type === 'div' && element.props.className === 'modal-backdrop'
  ))
  const dialogElement = findReactElement(tree, (element) => element.type === 'section')
  expect(backdropElement).toBeTruthy()
  expect(dialogElement).toBeTruthy()

  const backdrop = app.append(new FakeElement(document))
  const dialog = backdrop.append(new FakeElement(document, -1))
  const first = dialog.append(new FakeElement(document))
  const last = dialog.append(new FakeElement(document))
  dialog.focusable = [first, last]
  expect(backdropElement?.props.ref).toBeTruthy()
  expect(dialogElement?.props.ref).toBeTruthy()
  if (backdropElement?.props.ref) backdropElement.props.ref.current = backdrop
  if (dialogElement?.props.ref) dialogElement.props.ref.current = dialog
  return { backdrop, dialog, first, last }
}

function runNextLayoutEffect(effects: Array<() => void | (() => void)>): (() => void) | undefined {
  const effect = effects.shift()
  expect(effect).toBeTruthy()
  return effect?.() ?? undefined
}

function fakeKeyEvent(key: string, shiftKey = false): KeyboardEvent & {
  preventDefault: ReturnType<typeof vi.fn>
  stopPropagation: ReturnType<typeof vi.fn>
  stopImmediatePropagation: ReturnType<typeof vi.fn>
} {
  return {
    key,
    shiftKey,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    stopImmediatePropagation: vi.fn(),
  } as unknown as KeyboardEvent & {
    preventDefault: ReturnType<typeof vi.fn>
    stopPropagation: ReturnType<typeof vi.fn>
    stopImmediatePropagation: ReturnType<typeof vi.fn>
  }
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve))
}

class FakeDocument {
  readonly body: FakeElement
  activeElement: FakeElement | null = null
  keydown: ((event: KeyboardEvent) => void) | null = null
  readonly defaultView = {
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  }

  constructor() {
    this.body = new FakeElement(this)
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'keydown') this.keydown = listener as (event: KeyboardEvent) => void
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'keydown' && this.keydown === listener) this.keydown = null
  }
}

class FakeElement {
  readonly attributes = new Map<string, string>()
  readonly children: FakeElement[] = []
  parentElement: FakeElement | null = null
  focusable: FakeElement[] = []
  focusCount = 0
  isConnected = true

  constructor(readonly ownerDocument: FakeDocument, readonly tabIndex = 0) {}

  append<T extends FakeElement>(child: T): T {
    child.parentElement = this
    child.isConnected = true
    this.children.push(child)
    return child
  }

  remove(child: FakeElement): void {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
    child.parentElement = null
    child.disconnect()
  }

  disconnect(): void {
    this.isConnected = false
    for (const child of this.children) child.disconnect()
  }

  contains(target: unknown): boolean {
    if (target === this) return true
    return this.children.some((child) => child.contains(target))
  }

  focus(): void {
    this.ownerDocument.activeElement = this
    this.focusCount += 1
  }

  querySelector(selector: string): FakeElement | null {
    if (selector === '[autofocus]') return this.findWithAttribute('autofocus')
    if (selector === '[data-modal-initial-focus]') return this.findWithAttribute('data-modal-initial-focus')
    return null
  }

  querySelectorAll(): FakeElement[] {
    return this.focusable
  }

  findWithAttribute(name: string): FakeElement | null {
    for (const child of this.children) {
      if (child.getAttribute(name) !== null) return child
      const nested = child.findWithAttribute(name)
      if (nested) return nested
    }
    return null
  }

  matches(selector: string): boolean {
    return selector === ':disabled' && this.getAttribute('disabled') !== null
  }

  closest(selector: string): FakeElement | null {
    if (selector.includes('[inert]') && this.getAttribute('inert') !== null) return this
    if (selector.includes('[hidden]') && this.getAttribute('hidden') !== null) return this
    if (selector.includes('[aria-hidden="true"]') && this.getAttribute('aria-hidden') === 'true') return this
    return this.parentElement?.closest(selector) ?? null
  }

  getClientRects(): Array<Record<string, never>> {
    return [{}]
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }
}
