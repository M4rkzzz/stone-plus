import {
  Children,
  isValidElement,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BuiltInProxyProfileSummary } from '../../src/shared/types'
import {
  NodesWorkspace,
  type NodesWorkspaceProps,
} from '../../src/renderer/src/views/built-in-proxy/NodesWorkspace'

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useMemo: (factory: () => unknown) => factory(),
    useState: vi.fn(),
  }
})

vi.mock('../../src/renderer/src/i18n', () => ({
  useI18n: () => ({
    locale: 'en-US',
    t: <T,>(_chinese: T, english: T): T => english,
  }),
}))

const mockedUseState = vi.mocked(useState)

describe('NodesWorkspace node table wiring', () => {
  beforeEach(() => {
    mockedUseState.mockReset()
  })

  it('puts the persisted active stable id first and keeps selection callbacks id-based', () => {
    const onSelectNode = vi.fn()
    const profile = workspaceProfile()
    const tree = renderWorkspace(profile, {
      query: '',
      sort: 'current',
      groupFilter: 'all',
      onSelectNode,
    })
    const rows = nodeRows(tree)

    expect(rows.map((row) => row.key)).toEqual([
      'stable-failure',
      'stable-slow',
      'stable-fast',
      'stable-testing',
      'stable-unknown',
      'stable-osaka',
      'stable-west',
    ])
    expect(profile.activeNodeId).toBe('stable-failure')

    const activeRow = rows[0]
    expect(elementProps(activeRow).className).toContain('is-active')
    const activeButton = useButton(activeRow)
    expect(elementProps(activeButton).disabled).toBe(true)
    expect(textContent(elementProps(activeButton).children)).toContain('Selected')

    const fastRow = rows.find((row) => row.key === 'stable-fast')
    expect(fastRow).toBeDefined()
    const fastButton = useButton(fastRow!)
    elementProps(fastButton).onClick?.()
    expect(onSelectNode).toHaveBeenCalledWith('stable-profile', 'stable-fast')
  })

  it('searches after group filtering, sorts failures last, and renders every latency grade', () => {
    const profile = workspaceProfile()
    const tree = renderWorkspace(profile, {
      query: 'Tokyo',
      sort: 'latency',
      groupFilter: 'east',
    })
    const rows = nodeRows(tree)

    expect(rows.map((row) => row.key)).toEqual([
      'stable-fast',
      'stable-slow',
      'stable-testing',
      'stable-unknown',
      'stable-failure',
    ])
    expect(rows.some((row) => row.key === 'stable-west')).toBe(false)
    expect(rows.some((row) => row.key === 'stable-osaka')).toBe(false)
    expect(profile.activeNodeId).toBe('stable-failure')
    expect(elementProps(rows.at(-1)!).className).toContain('is-active')

    const markup = renderToStaticMarkup(tree)
    expect(markup).toContain('Showing 5 / 6')
    expect(markup).toContain('aria-live="polite"')
    expect(markup).toContain('aria-atomic="true"')
    expect(markup).not.toContain('Tokyo West')
    expect(markup).not.toContain('Osaka East')
    expect(renderedRow(markup, 'Tokyo Fast')).toContain('badge--success')
    expect(renderedRow(markup, 'Tokyo Fast')).toContain('70 ms')
    expect(renderedRow(markup, 'Tokyo Fast')).toContain('aria-label="Test latency for node Tokyo Fast"')
    expect(renderedRow(markup, 'Tokyo Slow')).toContain('badge--danger')
    expect(renderedRow(markup, 'Tokyo Slow')).toContain('650 ms')
    expect(renderedRow(markup, 'Tokyo Testing')).toContain('badge--info')
    expect(renderedRow(markup, 'Tokyo Testing')).toContain('Testing')
    expect(renderedRow(markup, 'Tokyo Unknown')).toContain('badge--neutral')
    expect(renderedRow(markup, 'Tokyo Unknown')).toContain('Untested')
    expect(renderedRow(markup, 'Tokyo Failure')).toContain('badge--danger')
    expect(renderedRow(markup, 'Tokyo Failure')).toContain('Error')
  })
})

function renderWorkspace(
  profile: BuiltInProxyProfileSummary,
  input: {
    query: string
    sort: 'current' | 'latency' | 'name'
    groupFilter: string
    onSelectNode?: NodesWorkspaceProps['onSelectNode']
  },
): ReactElement {
  mockedUseState
    .mockReturnValueOnce([input.query, vi.fn()] as never)
    .mockReturnValueOnce([input.sort, vi.fn()] as never)
  return NodesWorkspace({
    section: 'nodes',
    profiles: [profile],
    activeProfileId: profile.id,
    groupFilter: input.groupFilter,
    collapsed: false,
    onSelectProfile: vi.fn(),
    onRefreshProfile: vi.fn(),
    onDeleteProfile: vi.fn(),
    onImportProfile: vi.fn(),
    onSelectGroup: vi.fn(),
    onToggleCollapsed: vi.fn(),
    onSelectNode: input.onSelectNode ?? vi.fn(),
    onTestLatency: vi.fn(),
  })
}

function nodeRows(tree: ReactElement): Array<ReactElement<Record<string, unknown>>> {
  return findElements(tree, (element) => element.type === 'tr' && element.key !== null)
}

function useButton(row: ReactElement<Record<string, unknown>>): ReactElement<Record<string, unknown>> {
  const button = findElements(row, (element) => (
    element.type === 'button'
    && typeof elementProps(element).className === 'string'
    && elementProps(element).className!.includes('nodes-workspace__use')
  ))[0]
  if (!button) throw new Error(`node row ${String(row.key)} has no use button`)
  return button
}

function findElements(
  root: ReactNode,
  predicate: (element: ReactElement<Record<string, unknown>>) => boolean,
): Array<ReactElement<Record<string, unknown>>> {
  const matches: Array<ReactElement<Record<string, unknown>>> = []
  const visit = (value: ReactNode) => {
    Children.forEach(value, (child) => {
      if (!isValidElement<Record<string, unknown>>(child)) return
      if (predicate(child)) matches.push(child)
      visit(elementProps(child).children as ReactNode)
    })
  }
  visit(root)
  return matches
}

function elementProps(element: ReactElement<Record<string, unknown>>): {
  children?: ReactNode
  className?: string
  disabled?: boolean
  onClick?: () => void
} {
  return element.props as {
    children?: ReactNode
    className?: string
    disabled?: boolean
    onClick?: () => void
  }
}

function textContent(value: ReactNode): string {
  let text = ''
  Children.forEach(value, (child) => {
    if (typeof child === 'string' || typeof child === 'number') text += String(child)
    else if (isValidElement<Record<string, unknown>>(child)) {
      text += textContent(elementProps(child).children as ReactNode)
    }
  })
  return text
}

function renderedRow(markup: string, nodeName: string): string {
  const row = (markup.match(/<tr(?: [^>]*)?>[\s\S]*?<\/tr>/gu) ?? [])
    .find((candidate) => candidate.includes(nodeName))
  if (!row) throw new Error(`rendered row for ${nodeName} was not found`)
  return row
}

function workspaceProfile(): BuiltInProxyProfileSummary {
  return {
    id: 'stable-profile',
    name: 'Stable profile',
    source: 'subscription',
    format: 'uri-list',
    nodes: [{
      id: 'stable-slow',
      name: 'Tokyo Slow',
      type: 'vless',
      groupIds: ['east'],
      latencyStatus: 'available',
      latencyMs: 650,
    }, {
      id: 'stable-fast',
      name: 'Tokyo Fast',
      type: 'hysteria2',
      groupIds: ['east'],
      latencyStatus: 'available',
      latencyMs: 70,
    }, {
      id: 'stable-failure',
      name: 'Tokyo Failure',
      type: 'vless',
      groupIds: ['east'],
      latencyStatus: 'error',
    }, {
      id: 'stable-testing',
      name: 'Tokyo Testing',
      type: 'socks',
      groupIds: ['east'],
      latencyStatus: 'testing',
    }, {
      id: 'stable-unknown',
      name: 'Tokyo Unknown',
      type: 'socks',
      groupIds: ['east'],
      latencyStatus: 'untested',
    }, {
      id: 'stable-osaka',
      name: 'Osaka East',
      type: 'shadowsocks',
      groupIds: ['east'],
      latencyStatus: 'available',
      latencyMs: 40,
    }, {
      id: 'stable-west',
      name: 'Tokyo West',
      type: 'hysteria2',
      groupIds: ['west'],
      latencyStatus: 'available',
      latencyMs: 20,
    }],
    nodeCount: 7,
    groupCount: 2,
    ruleStatus: 'preserved',
    activeNodeId: 'stable-failure',
    createdAt: 1,
    updatedAt: 2,
  }
}
