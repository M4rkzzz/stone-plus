import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Archive,
  CheckCircle2,
  ChevronDown,
  Download,
  ExternalLink,
  FileJson,
  Globe2,
  Home,
  LoaderCircle,
  Plus,
  RefreshCw,
  RotateCw,
  Trash2,
  ZoomIn,
  XCircle,
} from 'lucide-react'
import type {
  AppSnapshot,
  AccountImportProgress,
  BrowserImportQueueState,
  BrowserJsonCacheState,
  ChatGptAccountImportProxyMode,
  GatewayApi,
} from '@shared/types'
import { localizeBackendError, localizeBackendMessage } from '../backend-message'
import { translate, useI18n, type UiLanguage } from '../i18n'
import { setupPoolDisplayName } from '../system-generated-text'
import { Badge, ImportProgress, Modal } from '../ui'

const DEFAULT_URL = 'https://aiprobe.top/'
const SHORTCUTS_KEY = 'stone.builtin-browser.shortcuts.v1'
const ZOOM_KEY = 'stone.builtin-browser.zoom.v1'
const ZOOM_LEVELS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200]
const EMPTY_QUEUE: BrowserImportQueueState = { items: [], readyCount: 0, totalBytes: 0, revision: 0 }
const EMPTY_CACHE: BrowserJsonCacheState = { items: [], totalBytes: 0 }

interface BrowserShortcut {
  id: string
  name: string
  url: string
}

interface EmbeddedWebview extends HTMLElement {
  loadURL(url: string): Promise<void>
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  canGoBack(): boolean
  canGoForward(): boolean
  getURL(): string
  getWebContentsId(): number
  setZoomFactor(factor: number): void
}

interface BrowserTab {
  id: string
  title: string
  url: string
  address: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
}

type NavigationEvent = Event & { url?: string }
type PageTitleEvent = Event & { title?: string }

export function BrowserView({ snapshot, api }: { snapshot: AppSnapshot; api: GatewayApi }) {
  const { t, language, locale } = useI18n()
  const [tabs, setTabs] = useState<BrowserTab[]>(() => [createBrowserTab(DEFAULT_URL, language)])
  const [activeTabId, setActiveTabId] = useState(() => tabs[0].id)
  const webviewsRef = useRef(new Map<string, EmbeddedWebview>())
  const [zoom, setZoom] = useState(loadZoom)
  const [shortcuts, setShortcuts] = useState<BrowserShortcut[]>(loadShortcuts)
  const [shortcutOpen, setShortcutOpen] = useState(false)
  const [shortcutDraft, setShortcutDraft] = useState({ name: '', url: '' })
  const [queue, setQueue] = useState<BrowserImportQueueState>(EMPTY_QUEUE)
  const [cache, setCache] = useState<BrowserJsonCacheState>(EMPTY_CACHE)
  const [cacheOpen, setCacheOpen] = useState(false)
  const [cacheBusyId, setCacheBusyId] = useState<string | null>(null)
  const [cacheError, setCacheError] = useState('')
  const [importOpen, setImportOpen] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [tagId, setTagId] = useState<string | null>(null)
  const [poolId, setPoolId] = useState<string | null>(null)
  const [proxyMode, setProxyMode] = useState<ChatGptAccountImportProxyMode>('preserve')
  const [proxyId, setProxyId] = useState('')
  const [busy, setBusy] = useState(false)
  const [importProgress, setImportProgress] = useState<AccountImportProgress | null>(null)
  const importProgressId = useRef<string | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0]

  const readyItems = useMemo(() => queue.items.filter((item) => item.status === 'ready'), [queue.items])
  const selectedReadyIds = useMemo(() => selectedIds.filter((id) => readyItems.some((item) => item.id === id)), [readyItems, selectedIds])
  const compatiblePools = useMemo(
    () => snapshot.pools.filter((pool) => pool.kind === 'standard' && pool.protocol === 'openai-responses'),
    [snapshot.pools],
  )

  useEffect(() => {
    let active = true
    const refreshCache = () => api.getBrowserJsonCache()
      .then((next) => { if (active) setCache(next) })
      .catch(() => undefined)
    void api.getBrowserImportQueue().then((next) => { if (active) setQueue(next) }).catch(() => undefined)
    void refreshCache()
    const unsubscribe = api.onBrowserImportQueue((next) => {
      if (active) setQueue(next)
      void refreshCache()
    })
    return () => { active = false; unsubscribe() }
  }, [api])

  useEffect(() => api.onAccountImportProgress((progress) => {
    if (progress.progressId === importProgressId.current) setImportProgress(progress)
  }), [api])

  const updateTab = useCallback((id: string, patch: Partial<BrowserTab>): void => {
    setTabs((current) => current.map((tab) => tab.id === id ? { ...tab, ...patch } : tab))
  }, [])

  const registerWebview = useCallback((id: string, webview: EmbeddedWebview | null): void => {
    if (webview) webviewsRef.current.set(id, webview)
    else webviewsRef.current.delete(id)
  }, [])

  const openTab = useCallback((value = DEFAULT_URL): void => {
    if (!isHttpUrl(value)) return
    const tab = createBrowserTab(value, language)
    setTabs((current) => [...current, tab])
    setActiveTabId(tab.id)
  }, [language])

  useEffect(() => api.onBrowserOpenTab((request) => {
    const belongsToThisBrowser = [...webviewsRef.current.values()]
      .some((webview) => webview.getWebContentsId() === request.guestId)
    if (belongsToThisBrowser && isHttpUrl(request.url)) openTab(request.url)
  }), [api, openTab])

  useEffect(() => {
    localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(shortcuts))
  }, [shortcuts])

  useEffect(() => {
    localStorage.setItem(ZOOM_KEY, String(zoom))
  }, [zoom])

  const navigate = (value: string): void => {
    try {
      const url = normalizeUrl(value, language)
      updateTab(activeTab.id, { address: url, url })
      setError('')
      void webviewsRef.current.get(activeTab.id)?.loadURL(url).catch(() => undefined)
    } catch (cause) {
      setError(localizeBackendError(cause, language, t('网址无效', 'Invalid URL')))
    }
  }

  const submitAddress = (event: FormEvent): void => {
    event.preventDefault()
    navigate(activeTab.address)
  }

  const closeTab = (id: string): void => {
    if (tabs.length <= 1) return
    const closingIndex = tabs.findIndex((tab) => tab.id === id)
    const remaining = tabs.filter((tab) => tab.id !== id)
    setTabs(remaining)
    if (activeTabId === id) {
      setActiveTabId(remaining[Math.min(Math.max(closingIndex, 0), remaining.length - 1)].id)
    }
  }

  const saveShortcut = (event: FormEvent): void => {
    event.preventDefault()
    try {
      const url = normalizeUrl(shortcutDraft.url, language)
      const name = shortcutDraft.name.trim() || new URL(url).hostname
      setShortcuts((current) => [...current, { id: crypto.randomUUID(), name: name.slice(0, 30), url }])
      setShortcutDraft({ name: '', url: '' })
      setShortcutOpen(false)
      setError('')
    } catch (cause) {
      setError(localizeBackendError(cause, language, t('快捷入口网址无效', 'Invalid shortcut URL')))
    }
  }

  const openImport = (): void => {
    setSelectedIds(readyItems.map((item) => item.id))
    setError('')
    setImportOpen(true)
  }

  const importSelected = async (): Promise<void> => {
    if (!selectedReadyIds.length) { setError(t('请至少选择一个已下载完成的 JSON。', 'Select at least one downloaded JSON file.')); return }
    const progressId = crypto.randomUUID()
    importProgressId.current = progressId
    setImportProgress({ progressId, phase: 'importing', completed: 0, total: selectedReadyIds.length, percent: 0, message: t('正在准备批量导入…', 'Preparing batch import…') })
    setBusy(true)
    setError('')
    try {
      const result = await api.importBrowserJsonQueue({
        itemIds: selectedReadyIds,
        tagId,
        poolId,
        proxyMode,
        proxyId: proxyMode === 'proxy' ? proxyId : undefined,
        progressId,
      })
      const succeeded = result.fileResults.filter((item) => item.status === 'imported').length
      const failed = result.fileResults.filter((item) => item.status === 'failed')
      const modelsRefreshed = result.detectionResults.filter((item) => item.availableModelCount !== undefined).length
      const modelFailures = result.detectionResults.filter((item) => item.modelRefreshError)
      const poolAppendError = result.assignmentSummary.poolAppendError
        ? localizeBackendMessage(result.assignmentSummary.poolAppendError, language, t('号池追加失败', 'Pool update failed.'))
        : undefined
      const fileFailure = failed[0]?.error
        ? localizeBackendMessage(failed[0].error, language, t('文件导入失败', 'File import failed.'))
        : undefined
      const modelFailure = modelFailures[0]?.modelRefreshError
        ? localizeBackendMessage(modelFailures[0].modelRefreshError, language, t('模型刷新失败', 'Model refresh failed.'))
        : undefined
      setNotice(t(
        `批量导入完成：文件成功 ${succeeded} 个、失败 ${failed.length} 个；新增 ${result.createdAccountIds.length} 个账号、更新 ${result.updatedAccountIds.length} 个账号；检测成功 ${result.detectionResults.filter((item) => item.ok).length} 个，Tag 覆盖 ${result.assignmentSummary.tagUpdatedAccountCount} 个，加入号池 ${result.assignmentSummary.poolMembersAdded} 个；模型刷新成功 ${modelsRefreshed} 个、失败 ${modelFailures.length} 个。${poolAppendError ? ` 号池追加失败：${poolAppendError}。` : ''}${fileFailure ? ` ${failed[0].fileName}：${fileFailure}` : modelFailure ? ` ${modelFailures[0].accountName}：${modelFailure}` : ''}`,
        `Batch import complete: ${succeeded} files succeeded and ${failed.length} failed; ${result.createdAccountIds.length} accounts created and ${result.updatedAccountIds.length} updated; ${result.detectionResults.filter((item) => item.ok).length} checks passed; tags applied to ${result.assignmentSummary.tagUpdatedAccountCount}; ${result.assignmentSummary.poolMembersAdded} added to the pool; model refresh succeeded for ${modelsRefreshed} and failed for ${modelFailures.length}.${poolAppendError ? ` Pool update failed: ${poolAppendError}.` : ''}${fileFailure ? ` ${failed[0].fileName}: ${fileFailure}` : modelFailure ? ` ${modelFailures[0].accountName}: ${modelFailure}` : ''}`,
      ))
      setImportOpen(false)
    } catch (cause) {
      setError(localizeBackendError(cause, language, t('挂起 JSON 批量导入失败', 'Failed to import queued JSON files')))
    } finally {
      importProgressId.current = null
      setImportProgress(null)
      setBusy(false)
    }
  }

  const removeQueueItem = async (id: string): Promise<void> => {
    setQueue(await api.removeBrowserImportItem(id))
    setSelectedIds((current) => current.filter((candidate) => candidate !== id))
  }

  const openCache = async (): Promise<void> => {
    setCacheError('')
    setCacheOpen(true)
    try {
      setCache(await api.getBrowserJsonCache())
    } catch (cause) {
      setCacheError(localizeBackendError(cause, language, t('无法读取下载缓存', 'Unable to read download cache')))
    }
  }

  const saveCachedItem = async (id: string): Promise<void> => {
    setCacheBusyId(id)
    setCacheError('')
    try {
      const result = await api.saveBrowserJsonCacheItem(id)
      if (!result.cancelled) setNotice(t('缓存 JSON 已另存。', 'Cached JSON saved successfully.'))
    } catch (cause) {
      setCacheError(localizeBackendError(cause, language, t('缓存 JSON 另存失败', 'Failed to save cached JSON')))
    } finally {
      setCacheBusyId(null)
    }
  }

  const removeCachedItem = async (id: string): Promise<void> => {
    setCacheBusyId(id)
    setCacheError('')
    try {
      setCache(await api.removeBrowserJsonCacheItem(id))
    } catch (cause) {
      setCacheError(localizeBackendError(cause, language, t('删除缓存失败', 'Failed to delete cached file')))
    } finally {
      setCacheBusyId(null)
    }
  }

  const clearCache = async (): Promise<void> => {
    if (!window.confirm(t('确定清空全部已下载 JSON 缓存吗？此操作不会删除已导入的账号。', 'Clear the entire downloaded JSON cache? Imported accounts will not be deleted.'))) return
    setCacheBusyId('clear')
    setCacheError('')
    try {
      setCache(await api.clearBrowserJsonCache())
    } catch (cause) {
      setCacheError(localizeBackendError(cause, language, t('清空缓存失败', 'Failed to clear cache')))
    } finally {
      setCacheBusyId(null)
    }
  }

  const proxyValue = proxyMode === 'preserve' ? '__preserve__' : proxyMode === 'direct' ? '__direct__' : proxyId

  return <div className="page-stack builtin-browser-page">
    <section className={`browser-import-banner ${queue.readyCount ? 'browser-import-banner--active' : ''}`}>
      <span className="browser-import-banner__icon"><FileJson size={20} /></span>
      <div>
        <strong>{queue.readyCount ? t(`已挂起 ${queue.readyCount} 个 JSON`, `${queue.readyCount} JSON files queued`) : t('暂无挂起 JSON', 'No queued JSON')}</strong>
      </div>
      <div className="browser-import-banner__actions">
        <button type="button" className="text-button browser-cache-button" disabled={busy} onClick={() => void openCache()}><Archive size={14} />{t('缓存', 'Cache')}{cache.items.length ? ` ${cache.items.length}` : ''}</button>
        {queue.items.length > 0 && <button type="button" className="text-button button--danger-text" disabled={busy} onClick={() => void api.clearBrowserImportQueue().then(setQueue)}>{t('清空', 'Clear')}</button>}
        <button type="button" className="button button--primary" disabled={!queue.readyCount || busy} onClick={openImport}><Download size={16} />{t('确认导入', 'Review import')}</button>
      </div>
    </section>

    {notice && <div className="client-config-notice"><CheckCircle2 size={16} /><span>{notice}</span></div>}
    {error && !importOpen && <div className="client-config-message error-banner"><XCircle size={16} /><span>{error}</span></div>}

    <section className="builtin-browser panel panel--flush">
      <div className="builtin-browser__shortcuts">
        {shortcuts.map((shortcut) => <div className="browser-shortcut" key={shortcut.id}>
          <button type="button" className={activeTab.url.startsWith(shortcut.url) ? 'active' : ''} onClick={() => navigate(shortcut.url)} title={shortcut.url}>
            <Globe2 size={14} /><span>{shortcut.name}</span>
          </button>
          <button type="button" className="browser-shortcut__remove" aria-label={t(`删除 ${shortcut.name}`, `Delete ${shortcut.name}`)} onClick={() => setShortcuts((current) => current.filter((item) => item.id !== shortcut.id))}><XCircle size={13} /></button>
        </div>)}
        <button type="button" className="browser-shortcut-add" onClick={() => setShortcutOpen(true)}><Plus size={14} />{t('添加', 'Add')}</button>
      </div>
      <div className="builtin-browser__tabs" role="tablist" aria-label={t('浏览器标签页', 'Browser tabs')}>
        {tabs.map((tab) => <button
          type="button"
          role="tab"
          aria-selected={tab.id === activeTab.id}
          className={`browser-tab ${tab.id === activeTab.id ? 'browser-tab--active' : ''}`}
          key={tab.id}
          onClick={() => setActiveTabId(tab.id)}
          title={`${tab.title}\n${tab.url}`}
        >
          {tab.loading ? <LoaderCircle size={13} className="spin" /> : <Globe2 size={13} />}
          <span>{tab.title}</span>
          <span
            role="button"
            aria-label={t(`关闭 ${tab.title}`, `Close ${tab.title}`)}
            aria-disabled={tabs.length <= 1}
            className={`browser-tab__close ${tabs.length <= 1 ? 'disabled' : ''}`}
            onClick={(event) => { event.stopPropagation(); closeTab(tab.id) }}
          ><XCircle size={13} /></span>
        </button>)}
        <button type="button" className="browser-tab-add" title={t('新建标签页', 'New tab')} aria-label={t('新建标签页', 'New tab')} onClick={() => openTab()}><Plus size={15} /></button>
      </div>
      <div className="builtin-browser__toolbar">
        <button type="button" className="icon-button" disabled={!activeTab.canGoBack} title={t('后退', 'Back')} onClick={() => webviewsRef.current.get(activeTab.id)?.goBack()}><ArrowLeft size={17} /></button>
        <button type="button" className="icon-button" disabled={!activeTab.canGoForward} title={t('前进', 'Forward')} onClick={() => webviewsRef.current.get(activeTab.id)?.goForward()}><ArrowRight size={17} /></button>
        <button type="button" className="icon-button" title={t('主页', 'Home')} onClick={() => navigate(DEFAULT_URL)}><Home size={16} /></button>
        <button type="button" className="icon-button" title={activeTab.loading ? t('停止', 'Stop') : t('刷新', 'Reload')} onClick={() => activeTab.loading ? webviewsRef.current.get(activeTab.id)?.stop() : webviewsRef.current.get(activeTab.id)?.reload()}>{activeTab.loading ? <XCircle size={16} /> : <RotateCw size={16} />}</button>
        <form className="builtin-browser__address" onSubmit={submitAddress}>
          <Globe2 size={15} />
          <input aria-label={t('网址', 'URL')} value={activeTab.address} onChange={(event) => updateTab(activeTab.id, { address: event.target.value })} spellCheck={false} />
          {activeTab.loading && <LoaderCircle size={15} className="spin" />}
        </form>
        <button type="button" className="icon-button" title={t('转到', 'Go')} onClick={() => navigate(activeTab.address)}><ExternalLink size={16} /></button>
        <label className="browser-zoom" title={t('页面显示比例', 'Page zoom')}><ZoomIn size={15} /><select aria-label={t('页面显示比例', 'Page zoom')} value={zoom} onChange={(event) => setZoom(Number(event.target.value))}>{ZOOM_LEVELS.map((level) => <option value={level} key={level}>{level}%</option>)}</select></label>
      </div>
      <div className="builtin-browser__viewport">
        {tabs.map((tab) => <BrowserTabPane
          key={tab.id}
          tab={tab}
          active={tab.id === activeTab.id}
          zoom={zoom}
          onUpdate={updateTab}
          onReady={registerWebview}
          language={language}
        />)}
      </div>
    </section>

    <Modal open={shortcutOpen} title={t('添加快捷入口', 'Add shortcut')} onClose={() => setShortcutOpen(false)} footer={<>
      <button type="button" className="button button--secondary" onClick={() => setShortcutOpen(false)}>{t('取消', 'Cancel')}</button>
      <button type="submit" form="browser-shortcut-form" className="button button--primary"><Plus size={16} />{t('添加', 'Add')}</button>
    </>}>
      <form id="browser-shortcut-form" className="form-grid" onSubmit={saveShortcut}>
        <label className="field field--full"><span>{t('名称', 'Name')}</span><input value={shortcutDraft.name} maxLength={30} placeholder={t('例如 AIProbe', 'For example, AIProbe')} onChange={(event) => setShortcutDraft({ ...shortcutDraft, name: event.target.value })} /></label>
        <label className="field field--full"><span>{t('网址', 'URL')}</span><input required value={shortcutDraft.url} placeholder="https://example.com/" onChange={(event) => setShortcutDraft({ ...shortcutDraft, url: event.target.value })} /></label>
      </form>
    </Modal>

    <Modal open={cacheOpen} title={t(`下载缓存（${cache.items.length}）`, `Download cache (${cache.items.length})`)} width="large" onClose={() => setCacheOpen(false)} footer={<>
      <span className="modal-selection-count">{t('共', 'Total')} {formatBytes(cache.totalBytes)}</span>
      {cache.items.length > 0 && <button type="button" className="button button--secondary button--danger-text" disabled={cacheBusyId !== null} onClick={() => void clearCache()}><Trash2 size={15} />{t('清空缓存', 'Clear cache')}</button>}
      <button type="button" className="button button--secondary" disabled={cacheBusyId !== null} onClick={() => setCacheOpen(false)}>{t('关闭', 'Close')}</button>
    </>}>
      <div className="browser-cache-modal">
        {cacheError && <div className="client-config-message error-banner"><XCircle size={16} /><span>{cacheError}</span></div>}
        {cache.items.length ? <div className="browser-import-list">
          {cache.items.map((item) => <div className="browser-cache-item" key={item.id}>
            <FileJson size={18} />
            <div><strong>{item.fileName}</strong><span>{formatCacheTime(item.receivedAt, locale)} · {formatBytes(item.sizeBytes)}</span></div>
            <button type="button" className="button button--secondary" disabled={cacheBusyId !== null} onClick={() => void saveCachedItem(item.id)}>{cacheBusyId === item.id ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}{t('另存为', 'Save as')}</button>
            <button type="button" className="icon-button button--danger-text" disabled={cacheBusyId !== null} title={t('删除缓存', 'Delete cached file')} onClick={() => void removeCachedItem(item.id)}><Trash2 size={15} /></button>
          </div>)}
        </div> : <div className="browser-cache-empty"><Archive size={24} /><strong>{t('暂无下载缓存', 'No cached downloads')}</strong><span>{t('在内置浏览器下载有效 JSON 后会自动保留一份。', 'A copy is retained automatically whenever a valid JSON file is downloaded in the built-in browser.')}</span></div>}
      </div>
    </Modal>

    <Modal open={importOpen} title={t(`导入 Sub2API / CPA（${selectedReadyIds.length}/${readyItems.length}）`, `Import Sub2API / CPA (${selectedReadyIds.length}/${readyItems.length})`)} width="large" closable={!busy} onClose={() => setImportOpen(false)} footer={<>
      <span className="modal-selection-count">{t(`已选 ${selectedReadyIds.length} 个，共`, `${selectedReadyIds.length} selected,`)} {formatBytes(readyItems.filter((item) => selectedReadyIds.includes(item.id)).reduce((total, item) => total + item.sizeBytes, 0))}</span>
      <button type="button" className="button button--secondary" disabled={busy} onClick={() => setImportOpen(false)}>{t('继续下载', 'Continue downloading')}</button>
      <button type="button" className="button button--primary" disabled={busy || !selectedReadyIds.length || (proxyMode === 'proxy' && !proxyId)} onClick={() => void importSelected()}>{busy ? <RefreshCw size={16} className="spin" /> : <Download size={16} />}{busy ? t('正在导入并检测…', 'Importing and checking…') : t('导入所选 JSON', 'Import selected JSON')}</button>
    </>}>
      <div className="browser-import-modal">
        <details className="browser-import-options">
          <summary><div><strong>{t('账号归类与网络（可选）', 'Account organization and network (optional)')}</strong><span>{t('为本批次设置 Tag、目标号池与出口代理', 'Set a tag, destination pool, and outbound proxy for this batch')}</span></div><ChevronDown size={16} /></summary>
          <div className="form-grid browser-import-options__body">
          <label className="field"><span>{t('本批次 Tag', 'Tag for this batch')}</span><select value={tagId ?? ''} onChange={(event) => setTagId(event.target.value || null)}><option value="">{t('未标记（同时清空重复账号的 Tag）', 'Untagged (also clears tags on duplicate accounts)')}</option>{snapshot.accountTags.map((tag) => <option value={tag.id} key={tag.id}>{tag.name}</option>)}</select></label>
          <label className="field"><span>{t('导入后加入号池（可选）', 'Add to pool after import (optional)')}</span><select value={poolId ?? ''} onChange={(event) => setPoolId(event.target.value || null)}><option value="">{t('不加入号池', 'Do not add to a pool')}</option>{compatiblePools.map((pool) => <option value={pool.id} key={pool.id}>{setupPoolDisplayName(pool.name, t)} · {t(`${pool.members.length} 个成员`, `${pool.members.length} members`)} · {pool.strategy}</option>)}</select></label>
          <label className="field field--full"><span>{t('批量出口代理', 'Outbound proxy for this batch')}</span><select value={proxyValue} onChange={(event) => {
            const value = event.target.value
            if (value === '__preserve__') { setProxyMode('preserve'); setProxyId('') }
            else if (value === '__direct__') { setProxyMode('direct'); setProxyId('') }
            else { setProxyMode('proxy'); setProxyId(value) }
          }}><option value="__preserve__">{t('不指定 / 沿用 JSON 配置', 'Unspecified / keep JSON settings')}</option><option value="__direct__">{t('直连（清除 JSON 代理）', 'Direct (clear JSON proxy)')}</option>{snapshot.proxies.map((proxy) => <option value={proxy.id} key={proxy.id}>{proxy.name} · {proxy.protocol.toUpperCase()} · {proxy.host}:{proxy.port}</option>)}</select><small>{proxyMode === 'proxy' ? t('本批账号统一使用所选代理，导入后的状态刷新与模型查询也走该代理。', 'All accounts in this batch use the selected proxy, including post-import status and model checks.') : proxyMode === 'direct' ? t('本批账号全部直连，并清除 JSON 中的代理设置。', 'All accounts in this batch connect directly, and proxy settings from JSON are removed.') : t('保留 JSON 内仍有效的 proxyId；没有有效代理时使用直连。', 'Keep a valid proxyId from each JSON file; use direct access when no valid proxy is present.')}</small></label>
          </div>
        </details>
        {busy && importProgress && <ImportProgress progress={importProgress} />}
        {error && <div className="client-config-message error-banner"><XCircle size={16} /><span>{error}</span></div>}
        <div className="browser-import-list">
          <div className="browser-import-list__head"><label><input type="checkbox" checked={readyItems.length > 0 && selectedReadyIds.length === readyItems.length} onChange={(event) => setSelectedIds(event.target.checked ? readyItems.map((item) => item.id) : [])} />{t('全选已完成文件', 'Select all completed files')}</label><span>{t(`${queue.items.length} 个记录`, `${queue.items.length} records`)}</span></div>
          {queue.items.map((item) => <div className={`browser-import-item browser-import-item--${item.status}`} key={item.id}>
            <input type="checkbox" disabled={item.status !== 'ready' || busy} checked={selectedIds.includes(item.id)} onChange={(event) => setSelectedIds((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} />
            <FileJson size={18} />
            <div><strong>{item.fileName}</strong><span>{item.sourceUrl || t('未知来源', 'Unknown source')} · {formatBytes(item.sizeBytes)}</span>{item.error && <small>{localizeBackendMessage(item.error, language, t('下载失败', 'Download failed.'))}</small>}</div>
            <Badge tone={item.status === 'ready' ? 'success' : item.status === 'failed' ? 'danger' : 'warning'}>{item.status === 'ready' ? t('待导入', 'Ready') : item.status === 'failed' ? t('失败', 'Failed') : t('下载中', 'Downloading')}</Badge>
            <button type="button" className="icon-button button--danger-text" disabled={busy} title={t('移除', 'Remove')} onClick={() => void removeQueueItem(item.id)}><Trash2 size={15} /></button>
          </div>)}
        </div>
      </div>
    </Modal>
  </div>
}

function BrowserTabPane({
  tab,
  active,
  zoom,
  onUpdate,
  onReady,
  language,
}: {
  tab: BrowserTab
  active: boolean
  zoom: number
  onUpdate: (id: string, patch: Partial<BrowserTab>) => void
  onReady: (id: string, webview: EmbeddedWebview | null) => void
  language: UiLanguage
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const webviewRef = useRef<EmbeddedWebview | null>(null)
  const webviewReadyRef = useRef(false)
  const initialUrlRef = useRef(tab.url)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    if (!window.stone) {
      host.innerHTML = `<div class="builtin-browser__preview"><strong>${translate(language, '内置浏览器仅在桌面应用中运行', 'The built-in browser is available only in the desktop app')}</strong></div>`
      return
    }

    const webview = document.createElement('webview') as EmbeddedWebview
    webview.className = 'builtin-browser__webview'
    webview.setAttribute('partition', 'persist:stone-browser')
    webview.setAttribute('allowpopups', 'true')
    webview.setAttribute('webpreferences', 'contextIsolation=yes,sandbox=yes,nodeIntegration=no,webSecurity=yes')

    const syncNavigation = (event?: NavigationEvent): void => {
      const nextUrl = event?.url || webview.getURL() || initialUrlRef.current
      onUpdate(tab.id, {
        url: nextUrl,
        address: nextUrl,
        canGoBack: webview.canGoBack(),
        canGoForward: webview.canGoForward(),
      })
    }
    const startLoading = (): void => onUpdate(tab.id, { loading: true })
    const stopLoading = (): void => {
      onUpdate(tab.id, { loading: false })
      syncNavigation()
    }
    const updateTitle = (event: PageTitleEvent): void => {
      const title = event.title?.trim()
      if (title) onUpdate(tab.id, { title: title.slice(0, 80) })
    }
    const applyZoom = (): void => {
      webviewReadyRef.current = true
      webview.setZoomFactor(zoomRef.current / 100)
    }

    webview.addEventListener('did-navigate', syncNavigation as EventListener)
    webview.addEventListener('did-navigate-in-page', syncNavigation as EventListener)
    webview.addEventListener('did-start-loading', startLoading)
    webview.addEventListener('did-stop-loading', stopLoading)
    webview.addEventListener('did-fail-load', stopLoading)
    webview.addEventListener('page-title-updated', updateTitle as EventListener)
    webview.addEventListener('did-attach', applyZoom)
    webview.addEventListener('dom-ready', applyZoom)
    webview.setAttribute('src', initialUrlRef.current)
    host.replaceChildren(webview)
    webviewRef.current = webview
    onReady(tab.id, webview)

    return () => {
      onReady(tab.id, null)
      webviewReadyRef.current = false
      webviewRef.current = null
      webview.remove()
    }
  }, [language, onReady, onUpdate, tab.id])

  useEffect(() => {
    if (webviewReadyRef.current) webviewRef.current?.setZoomFactor(zoom / 100)
  }, [zoom])

  return <div
    ref={hostRef}
    className={`builtin-browser__tab-pane ${active ? 'builtin-browser__tab-pane--active' : ''}`}
    aria-hidden={!active}
  />
}

function createBrowserTab(url: string, language: UiLanguage): BrowserTab {
  let title = translate(language, '新标签页', 'New tab')
  try {
    title = new URL(url).hostname || title
  } catch {
    // URL is validated before tabs are created.
  }
  return {
    id: crypto.randomUUID(),
    title,
    url,
    address: url,
    loading: true,
    canGoBack: false,
    canGoForward: false,
  }
}

function loadZoom(): number {
  const value = Number(localStorage.getItem(ZOOM_KEY))
  return ZOOM_LEVELS.includes(value) ? value : 100
}

function loadShortcuts(): BrowserShortcut[] {
  const fallback = [{ id: 'aiprobe-default', name: 'AIProbe', url: DEFAULT_URL }]
  try {
    const parsed = JSON.parse(localStorage.getItem(SHORTCUTS_KEY) || '') as unknown
    if (!Array.isArray(parsed)) return fallback
    const valid = parsed.filter((item): item is BrowserShortcut => Boolean(
      item && typeof item === 'object' && typeof (item as BrowserShortcut).id === 'string'
      && typeof (item as BrowserShortcut).name === 'string' && isHttpUrl((item as BrowserShortcut).url),
    )).slice(0, 30)
    return valid.length ? valid : fallback
  } catch {
    return fallback
  }
}

function normalizeUrl(value: string, language: UiLanguage): string {
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(value.trim()) ? value.trim() : `https://${value.trim()}`
  if (!isHttpUrl(candidate)) throw new Error(translate(language, '仅支持 http:// 或 https:// 网址。', 'Only http:// and https:// URLs are supported.'))
  return new URL(candidate).toString()
}

function isHttpUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function formatCacheTime(value: number, locale: string): string {
  return new Date(value).toLocaleString(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}
