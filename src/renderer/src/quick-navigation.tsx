import { useEffect, useMemo, useRef, useState } from 'react'
import { CornerDownLeft, Search } from 'lucide-react'
import { useI18n } from './i18n'
import { Modal } from './ui'
import { filterQuickNavigationItems, type QuickNavigationItem } from './quick-navigation-model'

export function QuickNavigation({
  open,
  activeId,
  recentIds,
  items,
  onClose,
  onSelect,
}: {
  open: boolean
  activeId: string
  recentIds: readonly string[]
  items: readonly QuickNavigationItem<string>[]
  onClose: () => void
  onSelect: (id: string) => void
}) {
  const { t, language } = useI18n()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const visibleItems = useMemo(
    () => filterQuickNavigationItems(items, query, recentIds, activeId),
    [activeId, items, query, recentIds],
  )

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
    window.setTimeout(() => inputRef.current?.select(), 0)
  }, [open])

  useEffect(() => {
    if (activeIndex < visibleItems.length) return
    setActiveIndex(Math.max(0, visibleItems.length - 1))
  }, [activeIndex, visibleItems.length])

  const choose = (id: string) => {
    onSelect(id)
    onClose()
  }

  return (
    <Modal
      open={open}
      title={t('查找功能或执行操作', 'Find a feature or run an action')}
      description={t('搜索页面、功能或安全操作；停止网关等有影响的操作仍会再次确认。', 'Search pages, features, or safe actions. Impactful actions such as stopping the gateway still require confirmation.')}
      onClose={onClose}
      width="medium"
    >
      <div className="quick-navigation">
        <label className="quick-navigation__search">
          <Search size={17} aria-hidden="true" />
          <input
            ref={inputRef}
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="quick-navigation-results"
            aria-activedescendant={visibleItems[activeIndex] ? `quick-navigation-${visibleItems[activeIndex].id}` : undefined}
            aria-label={t('搜索 Stone+ 功能', 'Search Stone+ features')}
            placeholder={t('例如：账号、代理、重建出口、检查更新…', 'For example: accounts, proxy, rebuild connections, check updates…')}
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActiveIndex(0) }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setActiveIndex((current) => visibleItems.length ? (current + 1) % visibleItems.length : 0)
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setActiveIndex((current) => visibleItems.length ? (current - 1 + visibleItems.length) % visibleItems.length : 0)
              } else if (event.key === 'Home') {
                event.preventDefault()
                setActiveIndex(0)
              } else if (event.key === 'End') {
                event.preventDefault()
                setActiveIndex(Math.max(0, visibleItems.length - 1))
              } else if (event.key === 'Enter' && visibleItems[activeIndex]) {
                event.preventDefault()
                choose(visibleItems[activeIndex].id)
              }
            }}
          />
          {query && <span className="quick-navigation__count">{visibleItems.length}</span>}
        </label>

        <div id="quick-navigation-results" className="quick-navigation__results" role="listbox" aria-label={t('功能列表', 'Feature list')}>
          {visibleItems.map((item, index) => {
            const Icon = item.icon
            const recent = recentIds.includes(item.id) && item.id !== activeId
            return (
              <button
                id={`quick-navigation-${item.id}`}
                key={item.id}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                className={`quick-navigation__item ${index === activeIndex ? 'quick-navigation__item--active' : ''}`}
                onPointerEnter={() => setActiveIndex(index)}
                onClick={() => choose(item.id)}
              >
                <span className="quick-navigation__icon"><Icon size={18} /></span>
                <span className="quick-navigation__copy">
                  <strong>{item.label[language === 'zh-CN' ? 0 : 1]}</strong>
                  <small>{item.description[language === 'zh-CN' ? 0 : 1]}</small>
                </span>
                {item.kind === 'action'
                  ? <span className="quick-navigation__badge quick-navigation__badge--action">{t('操作', 'Action')}</span>
                  : item.id === activeId
                  ? <span className="quick-navigation__badge">{t('当前', 'Current')}</span>
                  : recent && <span className="quick-navigation__badge">{t('最近', 'Recent')}</span>}
                {index === activeIndex && <CornerDownLeft className="quick-navigation__enter" size={15} aria-hidden="true" />}
              </button>
            )
          })}
          {!visibleItems.length && (
            <div className="quick-navigation__empty">
              <Search size={22} />
              <strong>{t('没有找到对应功能', 'No matching feature')}</strong>
              <span>{t('可以尝试“账号”“代理”“日志”或“设置”等更短的关键词。', 'Try a shorter term such as accounts, proxy, logs, or settings.')}</span>
            </div>
          )}
        </div>

        <div className="quick-navigation__help" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd>{t('选择', 'Select')}</span>
          <span><kbd>Enter</kbd>{t('打开', 'Open')}</span>
          <span><kbd>Esc</kbd>{t('关闭', 'Close')}</span>
        </div>
      </div>
    </Modal>
  )
}
