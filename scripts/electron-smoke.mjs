import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright-core'

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const packageMetadata = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
const expectedAppVersion = packageMetadata.version
const artifacts = join(projectRoot, '.artifacts', 'electron-smoke')
const userData = join(artifacts, 'user-data')
const clientConfigHome = join(artifacts, 'client-config-home')
const claudeDirectory = join(clientConfigHome, '.claude')
const claudeSettingsPath = join(claudeDirectory, 'settings.json')
const codexDirectory = join(clientConfigHome, '.codex')
const codexConfigPath = join(codexDirectory, 'config.toml')
const profileDirectory = join(clientConfigHome, 'profiles', 'work-claude')
const profileSettingsPath = join(profileDirectory, 'settings.json')
const privateConfigMarker = 'stone-smoke-private-config-marker'
const proxyPasswordMarker = 'stone-smoke-proxy-password-private-v05'
const databasePath = join(userData, 'stone-state.sqlite3')
const legacyStatePath = join(userData, 'stone-state.json')
const fakeClientRoot = join(artifacts, 'fake-client-e2e')
const fakeClientScript = join(fakeClientRoot, 'fake-client.cjs')
const fakeClientLogPath = join(fakeClientRoot, 'events.jsonl')
const fakeProfileRoot = join(fakeClientRoot, 'profiles')
const smokeClientPids = new Set()
const originalClaudeSettings = `${JSON.stringify({
  custom: { marker: privateConfigMarker },
  env: { STONE_SMOKE_KEEP: 'yes' }
}, null, 2)}\n`
const packagedExecutablePath = process.env.STONE_ELECTRON_PATH
const executablePath = packagedExecutablePath ?? defaultElectronPath(projectRoot)

await rm(artifacts, { recursive: true, force: true })
await mkdir(claudeDirectory, { recursive: true })
await mkdir(fakeClientRoot, { recursive: true })
await writeFile(claudeSettingsPath, originalClaudeSettings)
await writeFile(fakeClientScript, fakeClientSource(), 'utf8')
const upstream = await startMockUpstream()
let electronApp

try {
  const upstreamPort = upstream.address().port
  const gatewayPort = await findAvailablePort()
  electronApp = await electron.launch({
    executablePath,
    args: packagedExecutablePath ? [] : ['.'],
    cwd: projectRoot,
    env: {
      ...process.env,
      STONE_USER_DATA_DIR: userData,
      STONE_CLIENT_CONFIG_HOME: clientConfigHome
    },
    timeout: 30_000
  })

  const pageErrors = []
  const observedWindows = new WeakSet()
  const observeWindow = (page) => {
    if (observedWindows.has(page)) return
    observedWindows.add(page)
    page.on('pageerror', (error) => pageErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') pageErrors.push(message.text())
    })
  }
  electronApp.on('window', observeWindow)
  const window = await electronApp.firstWindow({ timeout: 30_000 })
  observeWindow(window)
  await window.evaluate(() => window.localStorage.setItem('stone.ui.language', 'zh-CN'))
  await window.reload({ waitUntil: 'domcontentloaded' })
  await window.locator('.app-shell').waitFor({ timeout: 30_000 })
  await window.keyboard.press('Control+K')
  const quickNavigationSearch = window.getByRole('combobox', { name: '搜索 Stone+ 功能' })
  await quickNavigationSearch.waitFor()
  await quickNavigationSearch.fill('请求记录')
  await quickNavigationSearch.press('Enter')
  await window.getByRole('heading', { name: '请求日志', exact: true }).waitFor()
  const quickNavigationWorks = await window.evaluate(() => window.location.hash === '#requests')
  await window.locator('.nav-item').filter({ hasText: '总览' }).click()
  await window.getByRole('heading', { name: '总览', exact: true }).waitFor()
  const agentControlButton = window.getByRole('button', { name: 'Agent 控制' })
  await agentControlButton.waitFor({ timeout: 30_000 })
  const chatGptRepairRestartButtonVisible = await agentControlButton.isVisible()
    && await agentControlButton.getAttribute('aria-haspopup') === 'dialog'
  await agentControlButton.click()
  const grokBuildLifecycleVisible = await window.locator('.agent-lifecycle__agent').filter({ hasText: 'Grok Build' }).isVisible()
  await agentControlButton.click()
  await window.locator('.nav-item').filter({ hasText: '会话修复' }).click()
  await window.getByRole('heading', { name: '会话修复' }).waitFor({ timeout: 30_000 })
  const providerRepairPanel = window.locator('.session-repair-panel:not(.session-index-cleanup-panel)')
  await providerRepairPanel.waitFor({ state: 'visible', timeout: 30_000 })
  const sessionRepairLoaded = await providerRepairPanel.isVisible()

  const { browserControlsCompact, browserViewportResizes } = await (async () => {
    const originalBounds = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBounds())
    const readRects = () => window.evaluate(() => {
      const rect = (selector) => {
        const element = document.querySelector(selector)
        if (!element) return undefined
        const bounds = element.getBoundingClientRect()
        return { top: bounds.top, right: bounds.right, bottom: bounds.bottom, left: bounds.left, width: bounds.width, height: bounds.height }
      }
      return {
        shortcuts: rect('.builtin-browser__shortcuts'),
        shortcutList: rect('.builtin-browser__shortcut-list'),
        importControls: rect('.browser-import-inline'),
        toolbar: rect('.builtin-browser__toolbar'),
        viewport: rect('.builtin-browser__viewport'),
        pane: rect('.builtin-browser__tab-pane--active'),
        webview: rect('.builtin-browser__webview'),
      }
    })
    const setWindowSize = (width, height) => electronApp.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height)
    }, { width, height })
    const aligned = (sample) => Boolean(sample.viewport && sample.pane && sample.webview
      && Math.abs(sample.viewport.width - sample.pane.width) <= 1
      && Math.abs(sample.viewport.height - sample.pane.height) <= 1
      && Math.abs(sample.viewport.width - sample.webview.width) <= 1
      && Math.abs(sample.viewport.height - sample.webview.height) <= 1)

    try {
      await window.evaluate(() => { window.location.hash = '#browser' })
      await window.locator('.builtin-browser__webview').waitFor({ state: 'attached', timeout: 15_000 })
      await setWindowSize(1_040, 680)
      await window.waitForTimeout(120)
      const compact = await readRects()
      await setWindowSize(1_500, 1_000)
      await window.waitForFunction((minimumHeight) => (
        (document.querySelector('.builtin-browser__viewport')?.getBoundingClientRect().height ?? 0) > minimumHeight
      ), (compact.viewport?.height ?? 0) + 120, { timeout: 10_000 })
      const expanded = await readRects()
      await window.screenshot({ path: join(artifacts, 'builtin-browser-resized.png') })

      return {
        browserControlsCompact: Boolean(expanded.shortcuts && expanded.shortcutList && expanded.importControls && expanded.toolbar
          && expanded.importControls.left >= expanded.shortcutList.right - 1
          && Math.abs(
            (expanded.importControls.top + expanded.importControls.height / 2)
              - (expanded.shortcuts.top + expanded.shortcuts.height / 2),
          ) <= 1
          && expanded.importControls.right <= expanded.shortcuts.right + 1
          && expanded.toolbar.bottom - expanded.shortcuts.top <= 105),
        browserViewportResizes: aligned(compact)
          && aligned(expanded)
          && (expanded.viewport?.height ?? 0) > (compact.viewport?.height ?? 0) + 120
          && (expanded.webview?.height ?? 0) > (compact.webview?.height ?? 0) + 120,
      }
    } finally {
      if (originalBounds) {
        await electronApp.evaluate(({ BrowserWindow }, bounds) => {
          BrowserWindow.getAllWindows()[0]?.setBounds(bounds)
        }, originalBounds)
      }
    }
  })()

  const bootSnapshot = await window.evaluate(() => window.stone.getSnapshot())
  const originalOutboundNetworkMode = bootSnapshot.gateway.outboundNetworkMode ?? 'direct'
  const initialBuiltInProxyState = await window.evaluate(() => window.stone.getBuiltInProxyState())
  const waitForExternalProxySurface = async () => {
    const toolbarLabel = window.locator('.proxy-toolbar').getByText('可复用代理', { exact: true })
    const emptyState = window.getByText('尚未配置代理', { exact: true })
    await Promise.all([
      toolbarLabel.waitFor({ state: 'visible', timeout: 30_000 }),
      emptyState.waitFor({ state: 'visible', timeout: 30_000 }),
    ])
    return await toolbarLabel.isVisible() && await emptyState.isVisible()
  }
  await window.locator('.nav-item').filter({ hasText: /^代理$/ }).click()
  await window.getByRole('heading', { name: '代理', exact: true }).waitFor()
  const externalProxySurfaceVisible = await waitForExternalProxySurface()
  const enableBuiltInProxy = window.getByRole('switch', { name: '开启内置代理' })
  await enableBuiltInProxy.click()
  const builtInProxyMaster = window.locator('.built-in-proxy-master')
  await builtInProxyMaster.getByText('等待配置', { exact: true }).waitFor()
  await window.locator('.built-in-proxy-guide').getByText('尚未接管', { exact: true }).waitFor()
  await window.getByRole('heading', { name: '导入第一份有效配置' }).waitFor()
  const disableBuiltInProxy = window.getByRole('switch', { name: '关闭内置代理' })
  await disableBuiltInProxy.waitFor()
  await window.waitForFunction((outboundMode) => Promise.all([
    window.stone.getBuiltInProxyState(),
    window.stone.getSnapshot(),
  ]).then(([runtime, snapshot]) => (
    runtime.desiredEnabled
      && runtime.status === 'disabled'
      && runtime.profiles.length === 0
      && !runtime.settings.hasEverActivated
      && runtime.effectiveRoute.kind === 'external'
      && (snapshot.gateway.outboundNetworkMode ?? 'direct') === outboundMode
  )), originalOutboundNetworkMode)
  const enabledWithoutProfileState = await window.evaluate(() => window.stone.getBuiltInProxyState())
  const enabledWithoutProfileSnapshot = await window.evaluate(() => window.stone.getSnapshot())
  const builtInProxySafeImportVisible = await window.locator('.built-in-proxy-import').getByText(
    '只解析受支持的节点、分组与规则，不运行外来 inbound、脚本或文件路径。',
    { exact: true },
  ).isVisible()
    && await window.getByRole('button', { name: '校验并导入' }).isVisible()
    && await window.locator('#built-in-proxy-workspace-panel').count() === 0
    && await window.locator('.proxy-toolbar').count() === 0
  await disableBuiltInProxy.click()
  await enableBuiltInProxy.waitFor()
  await window.waitForFunction((outboundMode) => Promise.all([
    window.stone.getBuiltInProxyState(),
    window.stone.getSnapshot(),
  ]).then(([runtime, snapshot]) => (
    !runtime.desiredEnabled
      && runtime.status === 'disabled'
      && runtime.profiles.length === 0
      && runtime.effectiveRoute.kind === 'external'
      && (snapshot.gateway.outboundNetworkMode ?? 'direct') === outboundMode
  )), originalOutboundNetworkMode)
  const disabledBuiltInProxyState = await window.evaluate(() => window.stone.getBuiltInProxyState())
  const disabledBuiltInProxySnapshot = await window.evaluate(() => window.stone.getSnapshot())
  const externalProxySurfaceRestored = await waitForExternalProxySurface()
  const initial = await window.evaluate(({ settings, port }) => window.stone.updateGateway({
    ...settings,
    port,
    autoStart: false
  }), { settings: bootSnapshot.gateway, port: gatewayPort })
  const withProxy = await window.evaluate((password) => window.stone.saveProxy({
    name: 'Smoke SOCKS5 Proxy',
    protocol: 'socks5',
    host: '127.0.0.1',
    port: 65_535,
    username: 'smoke-user',
    password
  }), proxyPasswordMarker)
  const proxy = withProxy.proxies.find((candidate) => candidate.name === 'Smoke SOCKS5 Proxy')
  const chatGptExpiry = new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const k12Tag = initial.accountTags.find((tag) => tag.name === 'K12')
  if (!proxy) throw new Error('The isolated smoke proxy was not created.')
  const beforeRejectedImport = await window.evaluate(() => window.stone.getSnapshot())
  const credentialRowsBeforeRejectedImport = sqliteCredentialRowCount(databasePath)
  let rejectedChatGptImportError = ''
  try {
    await window.evaluate(({ tagId, expired, proxyId }) => window.stone.importChatGptAccounts({
      tagId,
      poolId: null,
      proxyMode: 'proxy',
      proxyId,
      content: JSON.stringify({ access_token: 'smoke-oauth-private', account_id: 'acct-smoke-team', email: 'smoke@example.test', expired })
    }), { tagId: k12Tag?.id ?? null, expired: chatGptExpiry, proxyId: proxy.id })
  } catch (error) {
    rejectedChatGptImportError = error instanceof Error ? error.message : String(error)
  }
  const afterRejectedImport = await window.evaluate(() => window.stone.getSnapshot())
  const credentialRowsAfterRejectedImport = sqliteCredentialRowCount(databasePath)
  const rejectedImportAccountIdsUnchanged = JSON.stringify(beforeRejectedImport.accounts.map(({ id }) => id).sort())
    === JSON.stringify(afterRejectedImport.accounts.map(({ id }) => id).sort())
  const rejectedImportProviderIdsUnchanged = JSON.stringify(beforeRejectedImport.providers.map(({ id }) => id).sort())
    === JSON.stringify(afterRejectedImport.providers.map(({ id }) => id).sort())

  const officialSnapshot = await window.evaluate(() => window.stone.saveApiSource({
    name: 'Smoke OpenAI Official', sourceType: 'official-api', kind: 'openai',
    baseUrl: 'https://ignored.example/v1', protocol: 'openai-responses', credential: 'official-private',
    models: ['gpt-smoke'], defaultModel: 'gpt-smoke', priority: 1, weight: 10, maxConcurrency: 2
  }))
  const officialProvider = officialSnapshot.providers.find((provider) => provider.name === 'Smoke OpenAI Official')
  const officialAccount = officialSnapshot.accounts.find((account) => account.providerId === officialProvider?.id)
  if (!officialProvider || !officialAccount) throw new Error('The official smoke API account was not created atomically.')
  const apiProxySnapshot = await window.evaluate(async ({ accountId, proxyId }) => {
    const snapshot = await window.stone.getSnapshot()
    const account = snapshot.accounts.find((candidate) => candidate.id === accountId)
    if (!account) throw new Error('Official API account was not found during proxy binding.')
    return window.stone.saveAccount({
      id: account.id,
      providerId: account.providerId,
      name: account.name,
      priority: account.priority,
      weight: account.weight,
      maxConcurrency: account.maxConcurrency,
      modelAllowlist: account.modelAllowlist,
      proxyId
    })
  }, { accountId: officialAccount.id, proxyId: proxy.id })
  const apiPoolSnapshot = await window.evaluate((accountId) => window.stone.savePool({
    name: 'Smoke Official API Pool',
    kind: 'standard',
    protocol: 'openai-responses',
    strategy: 'balanced',
    accountIds: [accountId],
    modelPolicy: 'all',
    modelAllowlist: [],
    stickySessions: true,
    stickyTtlMinutes: 60,
    maxRetries: 0
  }), officialAccount.id)
  const apiPool = apiPoolSnapshot.pools.find((pool) => pool.name === 'Smoke Official API Pool')

  const relayOneSnapshot = await window.evaluate(({ port }) => window.stone.saveApiSource({
    name: 'Smoke Relay One', sourceType: 'relay', kind: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${port}/v1`, protocol: 'openai-responses', credential: 'relay-one-private',
    models: ['gpt-smoke'], defaultModel: 'gpt-smoke', priority: 1, weight: 10, maxConcurrency: 2
  }), { port: upstreamPort })
  const relayOneProvider = relayOneSnapshot.providers.find((provider) => provider.name === 'Smoke Relay One')
  const relayOneAccount = relayOneSnapshot.accounts.find((account) => account.providerId === relayOneProvider?.id)
  const relayTwoSnapshot = await window.evaluate(({ port }) => window.stone.saveApiSource({
    name: 'Smoke Relay Two', sourceType: 'relay', kind: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${port}/v1`, protocol: 'openai-responses', credential: 'relay-two-private',
    models: ['gpt-smoke'], defaultModel: 'gpt-smoke', priority: 2, weight: 20, maxConcurrency: 2
  }), { port: upstreamPort })
  const relayTwoProvider = relayTwoSnapshot.providers.find((provider) => provider.name === 'Smoke Relay Two')
  const relayTwoAccount = relayTwoSnapshot.accounts.find((account) => account.providerId === relayTwoProvider?.id)
  if (!relayOneProvider || !relayOneAccount || !relayTwoProvider || !relayTwoAccount) {
    throw new Error('Smoke API sources were not created atomically.')
  }
  const relayProbe = await window.evaluate(({ id, port }) => window.stone.probeApiSource({
    id, name: 'Smoke Relay One', sourceType: 'relay', kind: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${port}/v1`, protocol: 'openai-responses', model: 'gpt-smoke'
  }), { id: relayOneProvider?.id, port: upstreamPort })
  const aggregateSnapshot = await window.evaluate(({ firstId, secondId }) => window.stone.saveAggregateRelay({
    name: 'Smoke Aggregate Relay', protocol: 'openai-responses', strategy: 'weighted-round-robin',
    members: [{ accountId: firstId, order: 0, weight: 10 }, { accountId: secondId, order: 1, weight: 20 }],
    stickySessions: false, stickyTtlMinutes: 60, maxRetries: 1
  }), { firstId: relayOneAccount?.id, secondId: relayTwoAccount?.id })
  const aggregateRelay = aggregateSnapshot.pools.find((pool) => pool.name === 'Smoke Aggregate Relay')

  const existingWizard = await window.evaluate(() => window.stone.getSetupWizardState())
  const wizard = existingWizard ?? await window.evaluate(() => window.stone.saveSetupWizardProgress({ step: 'scan' }))
  await window.evaluate(({ sessionId, sourceId }) => window.stone.saveSetupWizardProgress({
    sessionId, step: 'routing', sourceType: 'relay', sourceId, client: 'codex', model: 'gpt-smoke'
  }), { sessionId: wizard.sessionId, sourceId: relayOneAccount?.id })
  const setupRouting = await window.evaluate(({ sessionId, sourceId }) => window.stone.applySetupRouting({
    sessionId, sourceId, client: 'codex', model: 'gpt-smoke'
  }), { sessionId: wizard.sessionId, sourceId: relayOneAccount?.id })
  const setupGateway = await window.evaluate((port) => window.stone.ensureGatewayRunning({ host: '127.0.0.1', port }), gatewayPort)
  const setupVerification = await window.evaluate(({ sessionId, routeId }) => window.stone.verifySetupRoute({
    sessionId, routeId, client: 'codex', model: 'gpt-smoke'
  }), { sessionId: wizard.sessionId, routeId: setupRouting.routeId })
  await window.evaluate(async (sessionId) => {
    await window.stone.saveSetupWizardProgress({ sessionId, step: 'client-config' })
    await window.stone.completeSetupWizard(sessionId)
  }, wizard.sessionId)
  const completedWizard = await window.evaluate(() => window.stone.getSetupWizardState())
  await window.evaluate(() => window.stone.stopGateway())

  await window.locator('.nav-item').filter({ hasText: '账号与中转' }).click()
  await window.getByRole('heading', { name: '账号与中转' }).waitFor()
  await window.getByRole('button', { name: '添加 Codex 账号' }).first().click()
  const accountAddDialog = window.getByRole('dialog', { name: '添加 Codex 账号' })
  const oauthAddTab = accountAddDialog.getByRole('tab', { name: /OAuth 授权/ })
  const tokenJsonAddTab = accountAddDialog.getByRole('tab', { name: /Token \/ JSON/ })
  await accountAddDialog.locator('.account-import-options > summary').click()
  const accountAddTag = accountAddDialog.getByRole('radio', { name: 'K12', exact: true })
  const oauthProxySelect = accountAddDialog.locator('label').filter({ hasText: '代理' }).locator('select')
  const oauthProxyOptions = await oauthProxySelect.locator('option').allTextContents()
  await accountAddTag.click()
  const oauthAccountAddUiWorks = await oauthAddTab.getAttribute('aria-selected') === 'true'
    && await accountAddDialog.getByRole('tabpanel', { name: /^OAuth 授权/ }).isVisible()
    && await accountAddTag.getAttribute('aria-checked') === 'true'
    && !oauthProxyOptions.some((label) => label.includes('沿用文件配置'))
    && await accountAddDialog.getByText('以下设置同时应用于 OAuth 授权和 Token / JSON 导入').isVisible()
  await tokenJsonAddTab.click()
  const tokenJsonProxyOptions = await oauthProxySelect.locator('option').allTextContents()
  const tokenJsonAccountAddUiWorks = await tokenJsonAddTab.getAttribute('aria-selected') === 'true'
    && await accountAddDialog.getByRole('tabpanel', { name: /^Token \/ JSON/ }).isVisible()
    && tokenJsonProxyOptions.some((label) => label.includes('沿用文件配置'))
  await accountAddDialog.getByRole('button', { name: '取消', exact: true }).click()
  await accountAddDialog.waitFor({ state: 'hidden' })
  const rejectedImportAbsentFromUi = await window.locator('.accounts-table tbody tr').count() === 0
    && await window.getByText('smoke@example.test', { exact: true }).count() === 0
  await window.getByRole('tab', { name: /官方 API/ }).click()
  const officialSourceVisible = await window.locator('.provider-card').filter({ hasText: 'Smoke OpenAI Official' }).isVisible()
  await window.getByRole('tab', { name: /中转站/ }).click()
  const relaySourceVisible = await window.locator('.provider-card:not(.aggregate-relay-card)').filter({ hasText: 'Smoke Relay One' }).isVisible()
  const aggregateVisible = await window.locator('.provider-card').filter({ hasText: 'Smoke Aggregate Relay' }).isVisible()

  await window.getByRole('button', { name: '添加聚合中转' }).click()
  const aggregateDialog = window.getByRole('dialog', { name: '添加聚合中转' })
  await aggregateDialog.getByLabel('显示名称').fill('Smoke UI Aggregate Relay')
  const relayOneMemberToggle = aggregateDialog.locator('.aggregate-member-picker__toggle').filter({ hasText: 'Smoke Relay One' })
  const relayTwoMemberToggle = aggregateDialog.locator('.aggregate-member-picker__toggle').filter({ hasText: 'Smoke Relay Two' })
  await relayOneMemberToggle.click()
  await relayTwoMemberToggle.click()
  const aggregateMemberSelectionWorks = await relayOneMemberToggle.getAttribute('aria-pressed') === 'true'
    && await relayTwoMemberToggle.getAttribute('aria-pressed') === 'true'
    && await relayOneMemberToggle.locator('xpath=..').evaluate((element) => element.classList.contains('selected'))
    && await relayTwoMemberToggle.locator('xpath=..').evaluate((element) => element.classList.contains('selected'))
    && await relayOneMemberToggle.locator('.checkbox-mark svg').isVisible()
    && await relayTwoMemberToggle.locator('.checkbox-mark svg').isVisible()
  await aggregateDialog.getByRole('button', { name: '保存聚合中转' }).click()
  await aggregateDialog.waitFor({ state: 'hidden' })
  const aggregateUiSnapshot = await window.evaluate(() => window.stone.getSnapshot())
  const aggregateUiRelay = aggregateUiSnapshot.pools.find((pool) => pool.name === 'Smoke UI Aggregate Relay')
  const aggregateUiSaveWorks = Boolean(aggregateUiRelay?.kind === 'relay-aggregate'
    && aggregateUiRelay.members.length === 2
    && aggregateUiRelay.members.some((member) => member.accountId === relayOneAccount.id)
    && aggregateUiRelay.members.some((member) => member.accountId === relayTwoAccount.id))
    && await window.locator('.provider-card').filter({ hasText: 'Smoke UI Aggregate Relay' }).isVisible()

  await window.locator('.nav-item').filter({ hasText: '路由' }).click()
  await window.getByRole('heading', { name: '客户端路由' }).waitFor()
  const codexRouteEditor = window.locator('.route-editor').filter({ hasText: 'Codex' })
  const routeSourceSelect = codexRouteEditor.locator('.route-fields select').first()
  const routeSourceOptionLabels = await routeSourceSelect.locator('option').allTextContents()
  const routeSourceOptionsVisible = routeSourceOptionLabels.some((label) => label.includes('Smoke OpenAI Official'))
    && routeSourceOptionLabels.some((label) => label.includes('Smoke Relay One'))
    && routeSourceOptionLabels.some((label) => label.includes('Smoke Relay Two'))
  await routeSourceSelect.selectOption(relayOneProvider.id)
  await codexRouteEditor.getByRole('button', { name: '保存路由' }).click()
  await codexRouteEditor.getByText('配置已同步').waitFor()
  const routeSourceSnapshot = await window.evaluate(() => window.stone.getSnapshot())
  const routeSourceSaveWorks = routeSourceSnapshot.routes.some((route) => route.client === 'codex' && route.poolId === relayOneProvider.id)

  await window.locator('.nav-item').filter({ hasText: '号池' }).click()
  await window.getByRole('heading', { name: '号池', exact: true }).waitFor()
  const apiPoolCard = window.locator('.pool-card').filter({ hasText: 'Smoke Official API Pool' })
  const aggregatePoolCard = window.locator('.pool-card').filter({ hasText: 'Smoke Aggregate Relay' })
  const relayPoolCard = window.locator('.pool-card--relay-source').filter({ hasText: 'Smoke Relay One' })
  const apiFastSwitch = apiPoolCard.getByRole('switch', { name: '号池 Smoke Official API Pool FAST' })
  const aggregateFastSwitch = aggregatePoolCard.getByRole('switch', { name: '号池 Smoke Aggregate Relay FAST' })
  const relayFastSwitch = relayPoolCard.getByRole('switch', { name: '中转站 Smoke Relay One FAST' })
  await apiPoolCard.waitFor()
  await aggregatePoolCard.waitFor()
  await relayPoolCard.waitFor()
  const poolFastSurfaceTogglesVisible = await apiFastSwitch.isVisible()
    && await aggregateFastSwitch.isVisible()
    && await relayFastSwitch.isVisible()
  const relayReadOnlyPoolCardVisible = await relayPoolCard.isVisible()
    && await relayPoolCard.getByText('只读', { exact: true }).isVisible()
    && await relayPoolCard.getByText('配置只读', { exact: true }).isVisible()

  await apiFastSwitch.click()
  await aggregateFastSwitch.click()
  await relayFastSwitch.click()
  await window.waitForFunction(({ apiPoolId, aggregatePoolId, relayId }) => window.stone.getSnapshot().then((snapshot) => (
    snapshot.pools.find((pool) => pool.id === apiPoolId)?.forceFastMode === true
      && snapshot.pools.find((pool) => pool.id === aggregatePoolId)?.forceFastMode === true
      && snapshot.providers.find((provider) => provider.id === relayId)?.forceFastMode === true
  )), {
    apiPoolId: apiPool?.id,
    aggregatePoolId: aggregateRelay?.id,
    relayId: relayOneProvider.id,
  })
  const fastModeSnapshot = await window.evaluate(() => window.stone.getSnapshot())

  await window.locator('.nav-item').filter({ hasText: '路由' }).click()
  await window.locator('.nav-item').filter({ hasText: '号池' }).click()
  const fastModeTogglePersisted = await window.locator('.pool-card').filter({ hasText: 'Smoke Official API Pool' })
    .getByRole('switch', { name: '号池 Smoke Official API Pool FAST' }).getAttribute('aria-checked') === 'true'
    && await window.locator('.pool-card').filter({ hasText: 'Smoke Aggregate Relay' })
      .getByRole('switch', { name: '号池 Smoke Aggregate Relay FAST' }).getAttribute('aria-checked') === 'true'
    && await window.locator('.pool-card--relay-source').filter({ hasText: 'Smoke Relay One' })
      .getByRole('switch', { name: '中转站 Smoke Relay One FAST' }).getAttribute('aria-checked') === 'true'

  upstream.requests.length = 0
  const fastGateway = await window.evaluate(() => window.stone.startGateway())
  const fastRoute = fastModeSnapshot.routes.find((route) => route.client === 'codex')
  let directRelayFastResponseStatus = 0
  try {
    const fastResponse = await fetch(`http://${fastGateway.gatewayStatus.host}:${fastGateway.gatewayStatus.port}/v1/responses`, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: {
        authorization: `Bearer ${fastRoute?.localToken ?? ''}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-smoke',
        input: 'Verify direct relay FAST mode',
        stream: false,
        service_tier: 'default',
      }),
    })
    directRelayFastResponseStatus = fastResponse.status
    await fastResponse.arrayBuffer()
  } finally {
    await window.evaluate(() => window.stone.stopGateway())
  }
  const directRelayFastRequest = upstream.requests.find((request) => request.method === 'POST' && /\/responses(?:\?|$)/.test(request.path))
  const directRelayFastServiceTier = directRelayFastResponseStatus === 200
    && directRelayFastRequest?.body?.service_tier === 'priority'

  await apiPoolCard.getByRole('button', { name: '编辑配置' }).click()
  const poolK12Quick = window.locator('.pool-tag-quick-select button').filter({ hasText: 'K12' })
  const poolEditorWorks = await poolK12Quick.isVisible() && !await poolK12Quick.evaluate((element) => element.classList.contains('active'))
  await window.getByRole('button', { name: '取消' }).click()

  await window.evaluate(({ sessionId }) => window.stone.saveSetupWizardProgress({
    sessionId,
    step: 'source',
    sourceMethod: null,
    sourceId: null,
    tagId: null,
    poolId: null,
    proxyId: null,
  }), { sessionId: wizard.sessionId })
  await window.evaluate(() => { window.location.hash = '#setup' })
  await window.getByRole('heading', { name: '你准备使用什么来源？' }).waitFor({ timeout: 15_000 })
  await window.getByRole('button', { name: /ChatGPT \/ Codex 账号/ }).click()
  await window.getByRole('heading', { name: '添加 Codex 账号', exact: true }).waitFor()
  const setupOauthTab = window.getByRole('tab', { name: /OAuth 授权/ })
  const setupTokenJsonTab = window.getByRole('tab', { name: /Token \/ JSON/ })
  await window.locator('.setup-account-shared > summary').click()
  const setupTagSelect = window.locator('label').filter({ hasText: '账号 Tag（代替备注）' }).locator('select')
  const setupPoolSelect = window.locator('label').filter({ hasText: '导入后加入号池' }).locator('select')
  const setupProxySelect = window.locator('label').filter({ hasText: 'Token 交换与后续检测代理' }).locator('select')
  await setupTagSelect.selectOption(k12Tag.id)
  await window.waitForFunction((tagId) => window.stone.getSetupWizardState().then((state) => state?.tagId === tagId), k12Tag.id)
  const setupOauthUiWorks = await setupOauthTab.getAttribute('aria-selected') === 'true'
    && await window.getByRole('tabpanel', { name: 'OAuth 授权添加账号' }).isVisible()
    && (await setupPoolSelect.locator('option').allTextContents()).some((label) => label.includes('Smoke Official API Pool'))
    && (await setupProxySelect.locator('option').allTextContents()).some((label) => label.includes('Smoke SOCKS5 Proxy'))
    && await window.getByText('截图中的“备注”已适配为 Stone+ Tag，授权和导入使用相同设置。').isVisible()
  await setupTokenJsonTab.click()
  await window.getByRole('tabpanel', { name: 'Token 或 JSON 导入账号' }).waitFor()
  const setupTokenJsonUiWorks = await setupTokenJsonTab.getAttribute('aria-selected') === 'true'
    && await window.getByRole('tabpanel', { name: 'Token 或 JSON 导入账号' }).isVisible()
    && await window.evaluate(() => window.stone.getSetupWizardState().then((state) => state?.sourceMethod === 'token-json'))
  await window.evaluate(async (sessionId) => {
    await window.stone.saveSetupWizardProgress({ sessionId, step: 'client-config' })
    await window.stone.completeSetupWizard(sessionId)
  }, wizard.sessionId)
  await window.evaluate(() => { window.location.hash = '#overview' })
  await window.getByRole('heading', { name: '总览' }).waitFor()
  await window.evaluate(() => { window.location.hash = '#setup' })
  await window.getByRole('heading', { name: '配置已经跑通' }).waitFor({ timeout: 15_000 })
  const setupSuccessVisible = await window.getByRole('heading', { name: '配置已经跑通' }).isVisible()
  const profileBundle = await window.evaluate(() => window.stone.exportClientProfile('default-claude'))
  const diagnostics = JSON.parse(await window.evaluate(() => window.stone.exportDiagnostics()))
  const backupCreated = await window.evaluate(() => window.stone.createStateBackup())
  const stateBackups = await window.evaluate(() => window.stone.listStateBackups())
  const backupVerified = await window.evaluate((path) => window.stone.verifyStateBackup(path), backupCreated.backup?.path)
  const databaseFiles = await Promise.all([
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`
  ].map(readFileIfExists))
  const backupContents = backupCreated.backup?.path
    ? await readFile(backupCreated.backup.path)
    : undefined
  let persistedProxyEncrypted = false
  if (proxy) {
    const inspectionDatabase = new DatabaseSync(databasePath, { readOnly: true })
    try {
      const proxyRow = inspectionDatabase.prepare('SELECT payload FROM proxies WHERE id = ?').get(proxy.id)
      const persistedProxy = proxyRow?.payload ? JSON.parse(String(proxyRow.payload)) : undefined
      const credentialRow = persistedProxy?.credentialId
        ? inspectionDatabase.prepare('SELECT encrypted_value FROM credentials WHERE id = ?').get(persistedProxy.credentialId)
        : undefined
      persistedProxyEncrypted = Boolean(
        persistedProxy?.credentialId
        && credentialRow?.encrypted_value
        && credentialRow.encrypted_value !== proxyPasswordMarker
        && !String(credentialRow.encrypted_value).includes(proxyPasswordMarker)
      )
    } finally {
      inspectionDatabase.close()
    }
  }
  const withProfile = await window.evaluate((directory) => window.stone.saveClientProfile({
    name: 'Smoke Profile',
    client: 'claude',
    directory,
    backupRetention: 2
  }), profileDirectory)
  const profile = withProfile.clientProfiles.find((candidate) => candidate.name === 'Smoke Profile')
  const clientConfigs = await window.evaluate(() => window.stone.getClientConfigs())
  const claudeConfig = clientConfigs.find((config) => config.client === 'claude')
  const preview = await window.evaluate(() => window.stone.previewClientConfig('claude'))
  const profileConfigs = await window.evaluate((profileId) => window.stone.getClientConfigs(profileId), profile?.id)
  const profilePreview = await window.evaluate((profileId) => window.stone.previewClientConfig('claude', profileId), profile?.id)
  const profileApplied = await window.evaluate((profileId) => window.stone.applyClientConfig('claude', profileId), profile?.id)
  const profileWritten = JSON.parse(await readFile(profileSettingsPath, 'utf8'))
  await writeFile(profileSettingsPath, `${JSON.stringify({
    ...profileWritten,
    env: {
      ...profileWritten.env,
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:1'
    }
  }, null, 2)}\n`)
  await window.evaluate((profileId) => window.stone.applyClientConfig('claude', profileId), profile?.id)
  const profileBackups = await window.evaluate((profileId) => window.stone.listClientConfigBackups('claude', profileId), profile?.id)
  const profileSettingsBackup = profileBackups.find((backup) => backup.targetPath === profileSettingsPath)
  const profileRestored = await window.evaluate(
    ({ backupPath, profileId }) => window.stone.restoreClientConfig(backupPath, 'claude', profileId),
    { backupPath: profileSettingsBackup?.backupPath, profileId: profile?.id }
  )
  const restoredProfileSettings = JSON.parse(await readFile(profileSettingsPath, 'utf8'))
  const clientEditor = await window.evaluate((profileId) => window.stone.getClientConfigEditor('claude', profileId), profile?.id)
  const profileToken = profileWritten.env?.ANTHROPIC_AUTH_TOKEN
  const clientEditorPlaintextVisible = Boolean(
    profileToken
    && clientEditor.fields.some((field) => field.id === 'claude.model')
    && clientEditor.files.some((file) => file.role === 'claude-settings' && file.editable)
    && JSON.stringify(clientEditor).includes(profileToken)
  )
  const clientEditorSaved = await window.evaluate((profileId) => window.stone.saveClientConfigEditor({
    client: 'claude',
    profileId,
    patches: [{ id: 'claude.model', value: 'claude-smoke-model' }],
    files: [],
  }), profile?.id)
  const editorWrittenProfile = JSON.parse(await readFile(profileSettingsPath, 'utf8'))
  const applied = await window.evaluate(() => window.stone.applyClientConfig('claude'))
  const updatedClaudeSettings = JSON.parse(await readFile(claudeSettingsPath, 'utf8'))
  const backups = await window.evaluate(() => window.stone.listClientConfigBackups('claude'))
  const afterApplyConfigs = await window.evaluate(() => window.stone.getClientConfigs())
  const restored = await window.evaluate((backupPath) => window.stone.restoreClientConfig(backupPath, 'claude'), backups[0]?.backupPath)
  const restoredClaudeSettings = await readFile(claudeSettingsPath, 'utf8')
  const backupsAfterRestore = await window.evaluate(() => window.stone.listClientConfigBackups('claude'))
  const manualClientBackup = await window.evaluate(() => window.stone.createClientConfigBackup('claude'))
  await writeFile(claudeSettingsPath, '{"smoke":"changed-after-manual-backup"}\n')
  const manualClientRestore = await window.evaluate(() => window.stone.restoreLatestClientConfigBackup('claude'))
  const manualClientRestoredSettings = await readFile(claudeSettingsPath, 'utf8')
  const claudeRoute = initial.routes.find((route) => route.client === 'claude')
  const expectedGatewayBaseUrl = `http://${initial.gateway.host.includes(':') ? `[${initial.gateway.host}]` : initial.gateway.host}:${initial.gateway.port}`
  await mkdir(codexDirectory, { recursive: true })
  await window.evaluate(() => window.stone.repairClientConfig('codex'))
  await writeFile(codexConfigPath, 'model_provider = [broken\n', 'utf8')
  const codexRepair = await window.evaluate(() => window.stone.repairClientConfig('codex'))
  const repairedCodexConfig = await readFile(codexConfigPath, 'utf8')
  const codexRepairBackups = await window.evaluate(() => window.stone.listClientConfigBackups('codex'))
  const repairedCodexBackupContent = codexRepair.backups[0]?.backupPath
    ? await readFile(codexRepair.backups[0].backupPath, 'utf8')
    : ''
  const started = await window.evaluate(() => window.stone.startGateway())
  const probe = await fetch(`http://${started.gatewayStatus.host}:${started.gatewayStatus.port}/health`, {
    signal: AbortSignal.timeout(5_000),
  })
  await probe.arrayBuffer()
  await window.locator('.nav-item').filter({ hasText: '客户端配置' }).click()
  await window.locator('.client-easy-card').waitFor()
  await window.getByText('连接配置正常').waitFor()
  const codexClientTab = window.locator('.client-manager-tabs').getByRole('tab', { name: /Codex/ })
  const clientUpstreamSelect = window.getByLabel('当前上游')
  const currentClientSource = await clientUpstreamSelect.inputValue()
  const switchTargetId = [relayOneProvider.id, relayTwoProvider.id].find((id) => id !== currentClientSource)
  if (!switchTargetId) throw new Error('No alternate smoke route source was available for the client switch test.')
  const codexConfigBeforeSourceSwitch = await readFile(codexConfigPath, 'utf8')
  await clientUpstreamSelect.selectOption(switchTargetId)
  await window.getByText(/客户端配置文件未改动/).waitFor()
  await window.waitForTimeout(250)
  const sourceSwitchSnapshot = await window.evaluate(() => window.stone.getSnapshot())
  const codexConfigAfterSourceSwitch = await readFile(codexConfigPath, 'utf8')
  const agentLimitSetting = window.locator('[data-testid="codex-agent-limit-setting"]')
  const agentLimitInput = agentLimitSetting.locator('#client-codex-agent-limit')
  const codexConfigBeforeAgentLimit = await readFile(codexConfigPath, 'utf8')
  await agentLimitInput.fill('5')
  await agentLimitSetting.getByRole('button', { name: '保存' }).click()
  const agentLimitRestartDialog = window.getByRole('alertdialog').filter({ hasText: '需要重开 Codex' })
  await agentLimitRestartDialog.waitFor()
  const agentLimitRestartPromptWorks = await agentLimitRestartDialog.getByRole('button', { name: '保存并重开' }).isVisible()
  await agentLimitRestartDialog.getByRole('button', { name: '取消' }).click()
  await agentLimitRestartDialog.waitFor({ state: 'hidden' })
  const codexConfigAfterAgentLimitCancel = await readFile(codexConfigPath, 'utf8')
  const agentLimitSaved = await window.evaluate(() => window.stone.saveClientConfigEditor({
    client: 'codex',
    patches: [{ id: 'codex.agentsMaxThreads', value: 5 }],
    files: [],
  }))
  const codexConfigAfterAgentLimitSave = await readFile(codexConfigPath, 'utf8')
  const clientAgentLimitSaved = agentLimitRestartPromptWorks
    && codexConfigAfterAgentLimitCancel === codexConfigBeforeAgentLimit
    && agentLimitSaved.changedFiles.includes(codexConfigPath)
    && /(?:^|\n)(?:agents\.)?max_threads = 5(?:\r?\n|$)/.test(codexConfigAfterAgentLimitSave)
  const advancedToggle = window.getByRole('button', { name: /高级设置/ })
  const advancedHiddenByDefault = await window.locator('.client-manager-workbench').count() === 0
  await advancedToggle.click()
  await window.locator('.client-manager-workbench').waitFor()
  const advancedEditorAvailable = await advancedToggle.getAttribute('aria-expanded') === 'true'
  await advancedToggle.click()
  const clientConfigEasyUiWorks = await codexClientTab.getAttribute('aria-selected') === 'true'
    && await window.getByRole('heading', { name: '客户端配置' }).count() === 0
    && await window.locator('.client-easy-status__item').count() === 3
    && await window.getByRole('button', { name: /一键(?:修复)?连接/ }).isVisible()
    && await window.getByRole('button', { name: '恢复官方登录' }).isVisible()
    && advancedHiddenByDefault
    && advancedEditorAvailable
    && await clientUpstreamSelect.inputValue() === switchTargetId
  await window.screenshot({ path: join(artifacts, 'client-config-easy.png') })

  const grokRelaySnapshot = await window.evaluate(({ port }) => window.stone.saveApiSource({
    name: 'Smoke Grok Relay',
    sourceType: 'relay',
    kind: 'xai-compatible',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    protocol: 'openai-responses',
    credential: 'grok-smoke-private',
    models: ['grok-smoke'],
    defaultModel: 'grok-smoke',
    priority: 1,
    weight: 1,
    maxConcurrency: 2,
  }), { port: upstreamPort })
  const grokRelayProvider = grokRelaySnapshot.providers.find((provider) => provider.name === 'Smoke Grok Relay')
  if (!grokRelayProvider) throw new Error('Could not create the native Grok smoke route source.')
  await window.evaluate((sourceId) => window.stone.setClientRouteSource({ client: 'grokbuild', sourceId }), grokRelayProvider.id)

  const fakeClientDefinitions = [
    { client: 'claude', target: 'claude-code', name: 'Smoke Fake Claude' },
    { client: 'codex', target: 'codex-cli', name: 'Smoke Fake Codex' },
    { client: 'gemini', target: 'gemini-cli', name: 'Smoke Fake Gemini' },
    { client: 'grokbuild', target: 'grok-build', name: 'Smoke Fake Grok Build' },
  ]
  for (const client of ['claude', 'codex', 'gemini']) {
    await window.evaluate(({ client, sourceId }) => window.stone.setClientRouteSource({ client, sourceId }), {
      client,
      sourceId: relayOneProvider.id,
    })
  }
  let managedRouteSnapshot = await window.evaluate(() => window.stone.getSnapshot())
  for (const definition of fakeClientDefinitions) {
    const route = managedRouteSnapshot.routes.find((candidate) => candidate.client === definition.client)
    if (!route) throw new Error(`Could not prepare the ${definition.client} managed-client route.`)
    managedRouteSnapshot = await window.evaluate((route) => window.stone.updateRoute({ ...route, enabled: true }), route)
  }
  const managedSmokeInstances = []
  for (const definition of fakeClientDefinitions) {
    const directory = join(fakeProfileRoot, definition.client)
    await mkdir(directory, { recursive: true })
    const profileName = `${definition.name} Profile`
    const profileSnapshot = await window.evaluate(({ name, client, directory }) => window.stone.saveClientProfile({
      name,
      client,
      directory,
      backupRetention: 2,
    }), { name: profileName, client: definition.client, directory })
    const fakeProfile = profileSnapshot.clientProfiles.find((candidate) => candidate.name === profileName)
    const fakeRoute = managedRouteSnapshot.routes.find((candidate) => candidate.client === definition.client)
    if (!fakeProfile || !fakeRoute) throw new Error(`Could not prepare the ${definition.client} fake client profile.`)
    await window.evaluate(({ client, profileId }) => window.stone.repairClientConfig(client, profileId), {
      client: definition.client,
      profileId: fakeProfile.id,
    })
    const saved = await window.evaluate((input) => window.stone.saveManagedClientInstance(input), {
      name: definition.name,
      client: definition.client,
      configDirectory: directory,
      workingDirectory: projectRoot,
      executablePath: process.execPath,
      launchArgs: [fakeClientScript, definition.client, fakeClientLogPath],
      launchMode: 'background',
      routeId: fakeRoute.id,
      profileId: fakeProfile.id,
    })
    const instance = saved.find((candidate) => candidate.name === definition.name && candidate.client === definition.client)
    if (!instance) throw new Error(`Could not create the ${definition.client} fake managed instance.`)
    managedSmokeInstances.push({ ...definition, directory, profileId: fakeProfile.id, id: instance.id })
  }

  const managedInstanceRow = (name) => window.locator('.managed-instances__list article').filter({ hasText: name })
  for (const instance of managedSmokeInstances) await managedInstanceRow(instance.name).waitFor({ timeout: 15_000 })
  const firstGeneration = new Map()
  for (const instance of managedSmokeInstances) {
    const row = managedInstanceRow(instance.name)
    await row.getByTitle('启动', { exact: true }).click()
    const running = await waitForManagedInstanceRunning(window, instance.id)
    if (!running?.pid || !running.processAlive) throw new Error(`${instance.name} did not expose a live PID after its UI start.`)
    firstGeneration.set(instance.client, running.pid)
    smokeClientPids.add(running.pid)
  }
  await waitForFakeClientStarts(fakeClientLogPath, fakeClientDefinitions.map(({ client }) => client), 1)
  const managedClientUiLaunchesRealProcesses = managedSmokeInstances.every((instance) => pidIsAlive(firstGeneration.get(instance.client)))

  for (const instance of managedSmokeInstances) {
    await window.evaluate((id) => window.stone.stopManagedClientInstance(id), instance.id)
  }
  await Promise.all([...firstGeneration.values()].map((pid) => waitForPidStopped(pid)))
  const managedClientStopsRealProcesses = [...firstGeneration.values()].every((pid) => !pidIsAlive(pid))

  const beforeRepair = new Map()
  for (const instance of managedSmokeInstances) {
    await window.evaluate((id) => window.stone.startManagedClientInstance(id), instance.id)
    const running = await waitForManagedInstanceRunning(window, instance.id)
    if (!running?.pid || !running.processAlive) throw new Error(`${instance.name} did not restart before repair.`)
    beforeRepair.set(instance.client, running.pid)
    smokeClientPids.add(running.pid)
  }
  await waitForFakeClientStarts(fakeClientLogPath, fakeClientDefinitions.map(({ client }) => client), 2)

  const repairOperations = new Map()
  const afterRepair = new Map()
  for (const instance of managedSmokeInstances) {
    const operation = await window.evaluate((target) => window.stone.restoreAgent(target, {
      ensureRunning: true,
      repairSessions: false,
      repairWorkspaceIndex: false,
    }), instance.target)
    repairOperations.set(instance.client, operation)
    await window.waitForFunction(async ({ id, previousPid }) => {
      const current = (await window.stone.listManagedClientInstances()).find((candidate) => candidate.id === id)
      return current?.status === 'running' && current.processAlive === true && Boolean(current.pid && current.pid !== previousPid)
    }, { id: instance.id, previousPid: beforeRepair.get(instance.client) }, { timeout: 30_000 })
    const running = await findManagedInstance(window, instance.id)
    if (!running?.pid) throw new Error(`${instance.name} did not expose its repaired PID.`)
    afterRepair.set(instance.client, running.pid)
    smokeClientPids.add(running.pid)
  }
  await waitForFakeClientStarts(fakeClientLogPath, fakeClientDefinitions.map(({ client }) => client), 3)
  await Promise.all([...beforeRepair.values()].map((pid) => waitForPidStopped(pid)))
  const fakeClientRecords = await readFakeClientRecords(fakeClientLogPath)
  const requiredRepairPhases = ['inspect', 'close', 'restore-connection', 'validate', 'start']
  const managedClientRepairRestartsRealProcesses = managedSmokeInstances.every((instance) => {
    const previousPid = beforeRepair.get(instance.client)
    const repairedPid = afterRepair.get(instance.client)
    const operation = repairOperations.get(instance.client)
    const targetResult = operation?.results.find((candidate) => candidate.target === instance.target)
    const starts = fakeClientRecords.filter((record) => record.event === 'start' && record.client === instance.client)
    return operation?.status === 'succeeded'
      && targetResult?.status === 'succeeded'
      && requiredRepairPhases.every((phase) => targetResult.phases.includes(phase))
      && Number.isInteger(repairedPid)
      && repairedPid !== previousPid
      && !pidIsAlive(previousPid)
      && pidIsAlive(repairedPid)
      && starts.length === 3
      && new Set(starts.map(({ pid }) => pid)).size === 3
  })
  const managedClientProfilesIsolated = managedSmokeInstances.every((instance) => {
    const starts = fakeClientRecords.filter((record) => record.event === 'start' && record.client === instance.client)
    return starts.length === 3 && starts.every((record) => record.configDirectory === instance.directory)
  })
  await window.screenshot({ path: join(artifacts, 'managed-client-instances.png') })

  for (const instance of managedSmokeInstances) {
    await window.evaluate((id) => window.stone.stopManagedClientInstance(id), instance.id)
  }
  await Promise.all([...afterRepair.values()].map((pid) => waitForPidStopped(pid)))

  await window.locator('.sidebar-help').click()
  await window.getByRole('heading', { name: '帮助中心' }).waitFor()
  await window.locator('.help-assistant').waitFor()
  const helpChecklistCount = await window.locator('.help-checklist > button').count()
  const helpSearch = window.getByRole('searchbox', { name: '搜索帮助文档' })
  await helpSearch.fill('429')
  await window.locator('.help-results__grid button').filter({ hasText: '常见问题' }).click()
  const quotaFaq = window.locator('.help-faq-list summary').filter({ hasText: '出现 429 / 配额不足或并发限制？' })
  await quotaFaq.click()
  const helpCenterUiWorks = helpChecklistCount === 5
    && await quotaFaq.locator('..').evaluate((element) => element.hasAttribute('open'))
    && await window.getByText('增加重试次数不会产生新额度。', { exact: false }).isVisible()
  await window.screenshot({ path: join(artifacts, 'help-center.png') })
  await window.evaluate(() => {
    window.localStorage.setItem('stone.ui.language', 'en')
    window.location.hash = '#overview'
  })
  await window.reload({ waitUntil: 'domcontentloaded' })
  await window.locator('.nav-item').filter({ hasText: 'Overview' }).waitFor()
  await window.locator('.nav-item').filter({ hasText: 'Settings' }).click()
  await window.getByRole('heading', { name: 'Settings' }).waitFor()
  const languageSelect = window.getByLabel('界面语言 / Display language')
  const englishUiWorks = await window.getByRole('heading', { name: 'Settings' }).isVisible()
    && await window.locator('.settings-section').first().getByText('语言 / Language').isVisible()
    && await languageSelect.inputValue() === 'en'
    && await window.locator('.nav-item').filter({ hasText: 'Accounts & Relays' }).isVisible()
    && await window.locator('.nav-item').filter({ hasText: 'Client Configuration' }).isVisible()
  await languageSelect.selectOption('zh-CN')
  await window.locator('.nav-item').filter({ hasText: '总览' }).waitFor()
  const switchedToChinese = await languageSelect.inputValue() === 'zh-CN'
  await languageSelect.selectOption('en')
  await window.locator('.nav-item').filter({ hasText: 'Overview' }).waitFor()
  const languageSwitchWorks = switchedToChinese && await languageSelect.inputValue() === 'en'
  await window.screenshot({ path: join(artifacts, 'english-settings.png') })
  const stopped = await window.evaluate(() => window.stone.stopGateway())
  const gatewayPortReleased = await portAvailable(
    started.gatewayStatus.host,
    started.gatewayStatus.port,
  )
  await window.screenshot({ path: join(artifacts, 'window.png') })

  const result = {
    title: await window.title(),
    quickNavigationWorks,
    providers: initial.providers.length,
    routes: initial.routes.length,
    credentialsExposed: Object.hasOwn(initial, 'credentials'),
    vaultAvailable: initial.vaultAvailable,
    vaultBackend: initial.vaultBackend,
    clientConfigCount: clientConfigs.length,
    externalProxySurfaceVisible: initialBuiltInProxyState.desiredEnabled === false
      && initialBuiltInProxyState.status === 'disabled'
      && initialBuiltInProxyState.profiles.length === 0
      && initialBuiltInProxyState.effectiveRoute.kind === 'external'
      && externalProxySurfaceVisible,
    builtInProxyFirstRunSafe: enabledWithoutProfileState.desiredEnabled
      && enabledWithoutProfileState.status === 'disabled'
      && enabledWithoutProfileState.profiles.length === 0
      && !enabledWithoutProfileState.settings.hasEverActivated
      && enabledWithoutProfileState.effectiveRoute.kind === 'external'
      && enabledWithoutProfileState.effectiveRoute.generation === initialBuiltInProxyState.effectiveRoute.generation
      && (enabledWithoutProfileSnapshot.gateway.outboundNetworkMode ?? 'direct') === originalOutboundNetworkMode
      && builtInProxySafeImportVisible,
    builtInProxyDisabledCleanly: !disabledBuiltInProxyState.desiredEnabled
      && disabledBuiltInProxyState.status === 'disabled'
      && disabledBuiltInProxyState.profiles.length === 0
      && disabledBuiltInProxyState.effectiveRoute.kind === 'external'
      && disabledBuiltInProxyState.effectiveRoute.generation === initialBuiltInProxyState.effectiveRoute.generation
      && (disabledBuiltInProxySnapshot.gateway.outboundNetworkMode ?? 'direct') === originalOutboundNetworkMode
      && externalProxySurfaceRestored,
    proxySnapshotSafe: Boolean(proxy?.hasPassword)
      && !Object.hasOwn(proxy, 'credentialId')
      && !Object.hasOwn(proxy, 'password')
      && !JSON.stringify(withProxy).includes(proxyPasswordMarker),
    rejectedChatGptImportRolledBack: Boolean(k12Tag)
      && /未通过远程校验|failed remote validation/i.test(rejectedChatGptImportError)
      && rejectedImportAccountIdsUnchanged
      && rejectedImportProviderIdsUnchanged
      && credentialRowsAfterRejectedImport === credentialRowsBeforeRejectedImport
      && !afterRejectedImport.accounts.some((account) => account.name === 'smoke@example.test'),
    apiPoolCreated: Boolean(apiPool?.members.some((member) => member.accountId === officialAccount.id)),
    oauthAccountAddUiWorks,
    tokenJsonAccountAddUiWorks,
    setupOauthUiWorks,
    setupTokenJsonUiWorks,
    rejectedImportAbsentFromUi,
    poolEditorWorks,
    apiSourcesCreated: Boolean(relayOneProvider && relayTwoProvider)
      && officialSnapshot.providers.some((provider) => provider.name === 'Smoke OpenAI Official' && provider.baseUrl === 'https://api.openai.com/v1')
      && officialSourceVisible
      && relaySourceVisible,
    sourceProbePassed: relayProbe.ok && relayProbe.stages.some((stage) => stage.id === 'generation' && stage.status === 'success'),
    aggregateCreated: Boolean(aggregateRelay?.kind === 'relay-aggregate'
      && aggregateRelay.strategy === 'weighted-round-robin'
      && aggregateRelay.members.length === 2)
      && aggregateVisible,
    aggregateMemberSelectionWorks,
    aggregateUiSaveWorks,
    routeSourceOptionsVisible,
    routeSourceSaveWorks,
    relayReadOnlyPoolCardVisible,
    poolFastSurfaceTogglesVisible,
    fastModeTogglePersisted,
    directRelayFastServiceTier,
    setupWizardCompleted: Boolean(setupRouting.poolId
      && setupGateway.started
      && setupVerification.ok
      && completedWizard?.completed
      && completedWizard.step === 'complete'
      && setupSuccessVisible),
    apiAccountProxyBound: apiProxySnapshot.accounts.some((account) => account.id === officialAccount.id
        && account.credentialType === 'api-key'
        && account.proxyId === proxy.id)
      && !JSON.stringify(apiProxySnapshot).includes(proxyPasswordMarker)
      && !JSON.stringify(apiProxySnapshot).includes('official-private'),
    profilePortable: profileBundle.format === 'stone-client-profile' && profileBundle.version === 1,
    diagnosticsSafe: diagnostics.version === expectedAppVersion
      && !JSON.stringify(diagnostics).includes('localToken')
      && !JSON.stringify(diagnostics).includes('acct-smoke-team')
      && !JSON.stringify(diagnostics).includes('smoke-oauth-private')
      && !JSON.stringify(diagnostics).includes('relay-one-private')
      && !JSON.stringify(diagnostics).includes('official-private')
      && !JSON.stringify(diagnostics).includes(proxyPasswordMarker),
    sqliteProxyPasswordEncrypted: persistedProxyEncrypted
      && databaseFiles.filter(Boolean).every((contents) => !contents.includes(Buffer.from(proxyPasswordMarker))),
    sourceCredentialsEncrypted: databaseFiles.filter(Boolean).every((contents) => (
      !contents.includes(Buffer.from('relay-one-private'))
      && !contents.includes(Buffer.from('relay-two-private'))
      && !contents.includes(Buffer.from('official-private'))
    )) && !JSON.stringify(officialSnapshot).includes('official-private')
      && !JSON.stringify(relayTwoSnapshot).includes('relay-two-private'),
    backupProxyPasswordEncrypted: Boolean(backupContents)
      && !backupContents.includes(Buffer.from(proxyPasswordMarker)),
    stateBackupCreated: Boolean(backupCreated.backup)
      && stateBackups.some((backup) => backup.path === backupCreated.backup?.path)
      && backupVerified.integrity === 'valid',
    defaultProfilesPresent: initial.clientProfiles.length === 4
      && initial.clientProfiles.every((candidate) => candidate.isDefault),
    profileCreated: Boolean(profile && profile.client === 'claude' && profile.backupRetention === 2),
    profileScoped: profileConfigs.length === 4
      && profileConfigs.find((config) => config.client === 'claude')?.directory === profileDirectory
      && profilePreview.profileId === profile?.id
      && profilePreview.files.every((file) => file.managedFields.length > 0)
      && profileApplied.changedFiles[0] === profileSettingsPath
      && profileWritten.custom === undefined
      && profileWritten.env?.ANTHROPIC_AUTH_TOKEN === claudeRoute?.localToken,
    profileBackupRestored: Boolean(profileSettingsBackup)
      && profileRestored.sourceBackup === profileSettingsBackup?.backupPath
      && profileRestored.restoredFile === profileSettingsPath
      && restoredProfileSettings.env?.ANTHROPIC_BASE_URL === 'http://127.0.0.1:1'
      && restoredProfileSettings.env?.ANTHROPIC_AUTH_TOKEN === profileToken,
    clientEditorPlaintextVisible,
    clientEditorSaved: clientEditorSaved.changedFiles.includes(profileSettingsPath)
      && editorWrittenProfile.model === 'claude-smoke-model'
      && editorWrittenProfile.env?.ANTHROPIC_AUTH_TOKEN === profileToken,
    sqliteStateCreated: (await stat(databasePath)).isFile(),
    legacyJsonAbsent: await missing(legacyStatePath),
    clientConfigPathsIsolated: clientConfigs.every((config) => (
      isPathInside(clientConfigHome, config.directory)
      && config.files.every((file) => isPathInside(clientConfigHome, file.path))
    )),
    clientConfigDetected: Boolean(
      claudeConfig?.configured
      && claudeConfig.files.find((file) => file.role === 'claude-settings')?.exists
    ),
    clientConfigMetadataSafe: !JSON.stringify({
      clientConfigs,
      preview,
      applied,
      backups,
      afterApplyConfigs,
      restored
    }).includes(privateConfigMarker),
    clientConfigPreviewed: preview.client === 'claude'
      && preview.files.length === 1
      && preview.files[0].existed
      && preview.files[0].changed,
    clientConfigApplied: applied.changedFiles.length === 1
      && applied.changedFiles[0] === claudeSettingsPath
      && applied.backups.length === 1,
    clientConfigPreserved: updatedClaudeSettings.custom?.marker === privateConfigMarker
      && updatedClaudeSettings.env?.STONE_SMOKE_KEEP === 'yes',
    clientConfigTargeted: updatedClaudeSettings.env?.ANTHROPIC_BASE_URL === expectedGatewayBaseUrl
      && updatedClaudeSettings.env?.ANTHROPIC_AUTH_TOKEN === claudeRoute?.localToken,
    clientConfigBackupListed: backups.length === 1
      && backups[0].backupPath === applied.backups[0]?.backupPath
      && afterApplyConfigs.find((config) => config.client === 'claude')?.backupCount === 1,
    clientConfigRestored: restoredClaudeSettings === originalClaudeSettings
      && restored.sourceBackup === backups[0]?.backupPath,
    clientConfigSafetyBackup: Boolean(restored.safetyBackup)
      && backupsAfterRestore.length === 2
      && backupsAfterRestore.every((backup) => isPathInside(clientConfigHome, backup.backupPath)),
    clientConfigBackupSet: manualClientBackup.backups.some((backup) => backup.targetPath === claudeSettingsPath)
      && manualClientBackup.backups.every((backup) => backup.groupId === manualClientBackup.groupId)
      && manualClientRestore.groupId === manualClientBackup.groupId
      && manualClientRestore.restoredFiles.includes(claudeSettingsPath)
      && manualClientRestoredSettings === restoredClaudeSettings,
    clientConfigRepairRebuilds: codexRepair.rebuiltRoles.includes('codex-config')
      && codexRepair.backups.some((backup) => backup.targetPath === codexConfigPath)
      && codexRepairBackups.some((backup) => backup.backupPath === codexRepair.backups[0]?.backupPath)
      && repairedCodexBackupContent === 'model_provider = [broken\n'
      && repairedCodexConfig.includes('model_provider = "stone"')
      && repairedCodexConfig.includes('[model_providers.stone]'),
    clientRouteSwitchPreservesConfig: sourceSwitchSnapshot.routes.find((route) => route.client === 'codex')?.poolId === switchTargetId
      && codexConfigBeforeSourceSwitch === codexConfigAfterSourceSwitch,
    clientAgentLimitSaved,
    clientConfigEasyUiWorks,
    managedClientUiLaunchesRealProcesses,
    managedClientStopsRealProcesses,
    managedClientRepairRestartsRealProcesses,
    managedClientProfilesIsolated,
    gatewayStarted: started.gatewayStatus.running,
    gatewayProbeStatus: probe.status,
    gatewayStopped: !stopped.gatewayStatus.running && gatewayPortReleased,
    helpCenterUiWorks,
    englishUiWorks,
    languageSwitchWorks,
    chatGptRepairRestartButtonVisible,
    grokBuildLifecycleVisible,
    sessionRepairLoaded,
    browserControlsCompact,
    browserViewportResizes,
    pageErrors
  }
  console.log(JSON.stringify(result, null, 2))

  if (
    result.title !== 'Stone+' ||
    !result.quickNavigationWorks ||
    result.providers < 1 ||
    result.routes !== 4 ||
    result.credentialsExposed ||
    result.clientConfigCount !== 4 ||
    !result.externalProxySurfaceVisible ||
    !result.builtInProxyFirstRunSafe ||
    !result.builtInProxyDisabledCleanly ||
    !result.proxySnapshotSafe ||
    !result.rejectedChatGptImportRolledBack ||
    !result.apiPoolCreated ||
    !result.oauthAccountAddUiWorks ||
    !result.tokenJsonAccountAddUiWorks ||
    !result.setupOauthUiWorks ||
    !result.setupTokenJsonUiWorks ||
    !result.rejectedImportAbsentFromUi ||
    !result.poolEditorWorks ||
    !result.apiSourcesCreated ||
    !result.sourceProbePassed ||
    !result.aggregateCreated ||
    !result.aggregateMemberSelectionWorks ||
    !result.aggregateUiSaveWorks ||
    !result.routeSourceOptionsVisible ||
    !result.routeSourceSaveWorks ||
    !result.relayReadOnlyPoolCardVisible ||
    !result.poolFastSurfaceTogglesVisible ||
    !result.fastModeTogglePersisted ||
    !result.directRelayFastServiceTier ||
    !result.setupWizardCompleted ||
    !result.apiAccountProxyBound ||
    !result.profilePortable ||
    !result.diagnosticsSafe ||
    !result.sqliteProxyPasswordEncrypted ||
    !result.sourceCredentialsEncrypted ||
    !result.backupProxyPasswordEncrypted ||
    !result.stateBackupCreated ||
    !result.defaultProfilesPresent ||
    !result.profileCreated ||
    !result.profileScoped ||
    !result.profileBackupRestored ||
    !result.clientEditorPlaintextVisible ||
    !result.clientEditorSaved ||
    !result.sqliteStateCreated ||
    !result.legacyJsonAbsent ||
    !result.clientConfigPathsIsolated ||
    !result.clientConfigDetected ||
    !result.clientConfigMetadataSafe ||
    !result.clientConfigPreviewed ||
    !result.clientConfigApplied ||
    !result.clientConfigPreserved ||
    !result.clientConfigTargeted ||
    !result.clientConfigBackupListed ||
    !result.clientConfigRestored ||
    !result.clientConfigSafetyBackup ||
    !result.clientConfigBackupSet ||
    !result.clientConfigRepairRebuilds ||
    !result.clientRouteSwitchPreservesConfig ||
    !result.clientAgentLimitSaved ||
    !result.clientConfigEasyUiWorks ||
    !result.managedClientUiLaunchesRealProcesses ||
    !result.managedClientStopsRealProcesses ||
    !result.managedClientRepairRestartsRealProcesses ||
    !result.managedClientProfilesIsolated ||
    !result.gatewayStarted ||
    result.gatewayProbeStatus !== 404 ||
    !result.gatewayStopped ||
    !result.helpCenterUiWorks ||
    !result.englishUiWorks ||
    !result.languageSwitchWorks ||
    !result.chatGptRepairRestartButtonVisible ||
    !result.grokBuildLifecycleVisible ||
    !result.sessionRepairLoaded ||
    !result.browserControlsCompact ||
    !result.browserViewportResizes ||
    result.pageErrors.length > 0
  ) {
    process.exitCode = 1
  }
} finally {
  try {
    if (electronApp) await electronApp.close()
  } finally {
    for (const pid of smokeClientPids) {
      try { process.kill(pid, 'SIGTERM') } catch { /* The fake client already exited. */ }
    }
    await new Promise((resolvePromise, reject) => upstream.close((error) => error ? reject(error) : resolvePromise()))
  }
}

async function findManagedInstance(window, id) {
  return window.evaluate((instanceId) => window.stone.listManagedClientInstances()
    .then((instances) => instances.find((candidate) => candidate.id === instanceId)), id)
}

async function waitForManagedInstanceRunning(window, id) {
  await window.waitForFunction(async (instanceId) => {
    const current = (await window.stone.listManagedClientInstances()).find((candidate) => candidate.id === instanceId)
    return current?.status === 'failed'
      || (current?.status === 'running' && current.processAlive === true && Number.isInteger(current.pid))
  }, id, { timeout: 15_000 })
  const instance = await findManagedInstance(window, id)
  if (instance?.status === 'failed') throw new Error(instance.lastError ?? `Managed client ${id} failed to start.`)
  return instance
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForPidStopped(pid, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!pidIsAlive(pid)) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  }
  throw new Error(`Fake managed client PID ${pid} did not stop within ${timeoutMs}ms.`)
}

async function readFakeClientRecords(path) {
  const contents = await readFile(path, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return ''
    throw error
  })
  return contents.trim()
    ? contents.trim().split(/\r?\n/).map((line) => JSON.parse(line))
    : []
}

async function waitForFakeClientStarts(path, clients, generations, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const records = await readFakeClientRecords(path)
    if (clients.every((client) => records.filter((record) => record.event === 'start' && record.client === client).length >= generations)) {
      return records
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
  }
  throw new Error(`Fake managed clients did not reach generation ${generations} within ${timeoutMs}ms.`)
}

function fakeClientSource() {
  return String.raw`const { appendFileSync } = require('node:fs')
const [client, logPath] = process.argv.slice(2)
const configKeys = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  gemini: 'GEMINI_CLI_HOME',
  grokbuild: 'GROK_HOME',
}
appendFileSync(logPath, JSON.stringify({
  event: 'start',
  client,
  pid: process.pid,
  configDirectory: process.env[configKeys[client]],
}) + '\n')
setInterval(() => {}, 1_000)
`
}

function isPathInside(root, candidate) {
  const pathFromRoot = relative(resolve(root), resolve(candidate))
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
}

function defaultElectronPath(root) {
  const projectRequire = createRequire(join(root, 'package.json'))
  const executable = projectRequire('electron')
  if (typeof executable !== 'string' || !isAbsolute(executable)) {
    throw new Error('The installed Electron package did not resolve to an executable path.')
  }
  return executable
}

async function missing(path) {
  try {
    await stat(path)
    return false
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    throw error
  }
}

async function readFileIfExists(path) {
  try {
    return await readFile(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

function sqliteCredentialRowCount(path) {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    const row = database.prepare('SELECT COUNT(*) AS count FROM credentials').get()
    return Number(row?.count ?? 0)
  } finally {
    database.close()
  }
}

async function portAvailable(host, port) {
  const server = createServer()
  return new Promise((resolvePromise) => {
    server.once('error', () => resolvePromise(false))
    server.listen(port, host, () => {
      server.close((error) => resolvePromise(!error))
    })
  })
}

async function findAvailablePort() {
  const server = createServer()
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()))
  if (!port) throw new Error('Could not reserve a gateway port for the Electron smoke test.')
  return port
}

async function startMockUpstream() {
  const requests = []
  const server = createServer((socket) => {
    let request = ''
    socket.on('data', (chunk) => {
      request += chunk.toString('utf8')
      const headerEnd = request.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const headers = request.slice(0, headerEnd).split('\r\n')
      const contentLength = Number(headers.find((line) => /^content-length:/i.test(line))?.split(':')[1]?.trim() ?? 0)
      if (Buffer.byteLength(request.slice(headerEnd + 4)) < contentLength) return
      const [method, path] = headers[0].split(' ')
      const rawBody = request.slice(headerEnd + 4)
      let requestBody
      try {
        requestBody = rawBody ? JSON.parse(rawBody) : undefined
      } catch {
        requestBody = rawBody
      }
      requests.push({ method, path, body: requestBody })
      let payload
      if (method === 'GET' && /\/models(?:\?|$)/.test(path)) {
        payload = { object: 'list', data: [{ id: 'gpt-smoke', object: 'model' }] }
      } else if (method === 'POST' && /\/responses(?:\?|$)/.test(path)) {
        payload = {
          id: 'resp-smoke', object: 'response', status: 'completed', model: 'gpt-smoke',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
        }
      } else if (method === 'POST' && /\/chat\/completions(?:\?|$)/.test(path)) {
        payload = { id: 'chat-smoke', choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
      } else {
        payload = { error: { message: `Unhandled smoke upstream path: ${method} ${path}` } }
      }
      const status = payload.error ? 404 : 200
      const body = JSON.stringify(payload)
      socket.end(`HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Not Found'}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
    })
  })
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  if (!address || typeof address !== 'object') throw new Error('Could not start the mock upstream server.')
  return { close: (callback) => server.close(callback), address: () => address, requests }
}
