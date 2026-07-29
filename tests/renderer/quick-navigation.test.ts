import { CircleGauge, Settings } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import { filterQuickNavigationItems, type QuickNavigationItem } from '../../src/renderer/src/quick-navigation-model'

type TestPage = 'overview' | 'providers' | 'settings'

const items: Array<QuickNavigationItem<TestPage>> = [
  { id: 'overview', label: ['总览', 'Overview'], description: ['查看状态和额度', 'See status and quota'], keywords: ['主页 健康', 'home health'], icon: CircleGauge },
  { id: 'providers', label: ['账号与中转', 'Accounts & Relays'], description: ['管理账号、API 和中转站', 'Manage accounts, APIs, and relays'], keywords: ['密钥 导入', 'key import'], icon: CircleGauge },
  { id: 'settings', label: ['设置', 'Settings'], description: ['调整主题、备份和更新', 'Configure themes, backups, and updates'], keywords: ['深色 语言', 'dark language'], icon: Settings },
]

describe('quick navigation search', () => {
  it('matches labels, descriptions, and bilingual keywords', () => {
    expect(filterQuickNavigationItems(items, '账号', [], 'overview').map((item) => item.id)).toEqual(['providers'])
    expect(filterQuickNavigationItems(items, 'relay', [], 'overview').map((item) => item.id)).toEqual(['providers'])
    expect(filterQuickNavigationItems(items, 'dark', [], 'overview').map((item) => item.id)).toEqual(['settings'])
    expect(filterQuickNavigationItems(items, '状态 额度', [], 'settings').map((item) => item.id)).toEqual(['overview'])
  })

  it('shows recent destinations first without duplicating them', () => {
    const result = filterQuickNavigationItems(items, '', ['settings', 'providers', 'overview'], 'overview')

    expect(result.map((item) => item.id)).toEqual(['settings', 'providers', 'overview'])
    expect(new Set(result.map((item) => item.id)).size).toBe(result.length)
  })
})

