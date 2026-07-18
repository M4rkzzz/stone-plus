import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
const profileDirectory = join(clientConfigHome, 'profiles', 'work-claude')
const profileSettingsPath = join(profileDirectory, 'settings.json')
const privateConfigMarker = 'stone-smoke-private-config-marker'
const proxyPasswordMarker = 'stone-smoke-proxy-password-private-v05'
const databasePath = join(userData, 'stone-state.sqlite3')
const legacyStatePath = join(userData, 'stone-state.json')
const originalClaudeSettings = `${JSON.stringify({
  custom: { marker: privateConfigMarker },
  env: { STONE_SMOKE_KEEP: 'yes' }
}, null, 2)}\n`
const executablePath = process.env.STONE_ELECTRON_PATH ?? defaultElectronPath(projectRoot)
const gatewayPort = await findAvailablePort()

await rm(artifacts, { recursive: true, force: true })
await mkdir(claudeDirectory, { recursive: true })
await writeFile(claudeSettingsPath, originalClaudeSettings)
const electronApp = await electron.launch({
  executablePath,
  args: ['.'],
  cwd: projectRoot,
  env: {
    ...process.env,
    STONE_USER_DATA_DIR: userData,
    STONE_CLIENT_CONFIG_HOME: clientConfigHome
  },
  timeout: 30_000
})

try {
  const window = await electronApp.firstWindow({ timeout: 30_000 })
  const pageErrors = []
  window.on('pageerror', (error) => pageErrors.push(error.message))
  window.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text())
  })
  await window.locator('.app-shell').waitFor({ timeout: 30_000 })

  const bootSnapshot = await window.evaluate(() => window.stone.getSnapshot())
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
  const chatGptImport = await window.evaluate(({ providerId, expired }) => window.stone.importChatGptAccounts({
    providerId,
    content: JSON.stringify({ access_token: 'smoke-oauth-private', account_id: 'acct-smoke-team', email: 'smoke@example.test', expired })
  }), { providerId: initial.providers.find((provider) => provider.kind === 'openai' && provider.protocol === 'openai-responses')?.id, expired: chatGptExpiry })
  const oauthProxySnapshot = await window.evaluate(async ({ accountId, proxyId }) => {
    const snapshot = await window.stone.getSnapshot()
    const account = snapshot.accounts.find((candidate) => candidate.id === accountId)
    if (!account) throw new Error('Imported OAuth account was not found during proxy binding.')
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
  }, { accountId: chatGptImport.importedAccountIds[0], proxyId: proxy?.id })
  const presets = await window.evaluate(() => window.stone.listProviderPresets())
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
  const profileRestored = await window.evaluate(
    ({ backupPath, profileId }) => window.stone.restoreClientConfig(backupPath, 'claude', profileId),
    { backupPath: profileBackups[0]?.backupPath, profileId: profile?.id }
  )
  const clientEditor = await window.evaluate((profileId) => window.stone.getClientConfigEditor('claude', profileId), profile?.id)
  const profileToken = profileWritten.env?.ANTHROPIC_AUTH_TOKEN
  const clientEditorSafe = Boolean(
    profileToken
    && clientEditor.fields.some((field) => field.id === 'claude.model')
    && clientEditor.files.some((file) => file.role === 'claude-settings' && file.editable)
    && !JSON.stringify(clientEditor).includes(profileToken)
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
  const claudeRoute = initial.routes.find((route) => route.client === 'claude')
  const expectedGatewayBaseUrl = `http://${initial.gateway.host.includes(':') ? `[${initial.gateway.host}]` : initial.gateway.host}:${initial.gateway.port}`
  const started = await window.evaluate(() => window.stone.startGateway())
  const probe = await fetch(`http://${started.gatewayStatus.host}:${started.gatewayStatus.port}/health`)
  const stopped = await window.evaluate(() => window.stone.stopGateway())
  await window.screenshot({ path: join(artifacts, 'window.png') })

  const result = {
    title: await window.title(),
    providers: initial.providers.length,
    routes: initial.routes.length,
    credentialsExposed: Object.hasOwn(initial, 'credentials'),
    vaultAvailable: initial.vaultAvailable,
    vaultBackend: initial.vaultBackend,
    clientConfigCount: clientConfigs.length,
    providerPresetsAvailable: presets.length >= 3,
    proxySnapshotSafe: Boolean(proxy?.hasPassword)
      && !Object.hasOwn(proxy, 'credentialId')
      && !Object.hasOwn(proxy, 'password')
      && !JSON.stringify(withProxy).includes(proxyPasswordMarker),
    chatGptAccountImported: chatGptImport.importedAccountIds.length === 1
      && chatGptImport.createdAccountIds.length === 1
      && chatGptImport.createdAccountIds[0] === chatGptImport.importedAccountIds[0]
      && chatGptImport.updatedAccountIds.length === 0
      && chatGptImport.snapshot.accounts.some((account) => account.id === chatGptImport.importedAccountIds[0]
        && account.credentialType === 'chatgpt-oauth'
        && !Object.hasOwn(account, 'credentialId'))
      && !JSON.stringify(chatGptImport).includes('smoke-oauth-private')
      && !JSON.stringify(chatGptImport).includes('acct-smoke-team'),
    oauthProxyBound: Boolean(proxy)
      && oauthProxySnapshot.accounts.some((account) => account.id === chatGptImport.importedAccountIds[0]
        && account.credentialType === 'chatgpt-oauth'
        && account.proxyId === proxy.id)
      && !JSON.stringify(oauthProxySnapshot).includes(proxyPasswordMarker)
      && !JSON.stringify(oauthProxySnapshot).includes('smoke-oauth-private')
      && !JSON.stringify(oauthProxySnapshot).includes('acct-smoke-team'),
    profilePortable: profileBundle.format === 'stone-client-profile' && profileBundle.version === 1,
    diagnosticsSafe: diagnostics.version === expectedAppVersion
      && !JSON.stringify(diagnostics).includes('localToken')
      && !JSON.stringify(diagnostics).includes('acct-smoke-team')
      && !JSON.stringify(diagnostics).includes('smoke-oauth-private')
      && !JSON.stringify(diagnostics).includes(proxyPasswordMarker),
    sqliteProxyPasswordEncrypted: persistedProxyEncrypted
      && databaseFiles.filter(Boolean).every((contents) => !contents.includes(Buffer.from(proxyPasswordMarker))),
    backupProxyPasswordEncrypted: Boolean(backupContents)
      && !backupContents.includes(Buffer.from(proxyPasswordMarker)),
    stateBackupCreated: Boolean(backupCreated.backup)
      && stateBackups.some((backup) => backup.path === backupCreated.backup?.path)
      && backupVerified.integrity === 'valid',
    defaultProfilesPresent: initial.clientProfiles.length === 3
      && initial.clientProfiles.every((candidate) => candidate.isDefault),
    profileCreated: Boolean(profile && profile.client === 'claude' && profile.backupRetention === 2),
    profileScoped: profileConfigs.length === 3
      && profileConfigs.find((config) => config.client === 'claude')?.directory === profileDirectory
      && profilePreview.profileId === profile?.id
      && profilePreview.files.every((file) => file.managedFields.length > 0)
      && profileApplied.changedFiles[0] === profileSettingsPath
      && profileWritten.custom === undefined
      && profileWritten.env?.ANTHROPIC_AUTH_TOKEN === claudeRoute?.localToken,
    profileBackupRestored: profileBackups.length === 1
      && profileRestored.sourceBackup === profileBackups[0]?.backupPath
      && profileRestored.restoredFile === profileSettingsPath,
    clientEditorSafe,
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
    gatewayStarted: started.gatewayStatus.running,
    gatewayProbeStatus: probe.status,
    gatewayStopped: !stopped.gatewayStatus.running,
    pageErrors
  }
  console.log(JSON.stringify(result, null, 2))

  if (
    result.title !== 'Stone+' ||
    result.providers < 1 ||
    result.routes !== 3 ||
    result.credentialsExposed ||
    result.clientConfigCount !== 3 ||
    !result.providerPresetsAvailable ||
    !result.proxySnapshotSafe ||
    !result.chatGptAccountImported ||
    !result.oauthProxyBound ||
    !result.profilePortable ||
    !result.diagnosticsSafe ||
    !result.sqliteProxyPasswordEncrypted ||
    !result.backupProxyPasswordEncrypted ||
    !result.stateBackupCreated ||
    !result.defaultProfilesPresent ||
    !result.profileCreated ||
    !result.profileScoped ||
    !result.profileBackupRestored ||
    !result.clientEditorSafe ||
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
    !result.gatewayStarted ||
    result.gatewayProbeStatus !== 404 ||
    !result.gatewayStopped ||
    result.pageErrors.length > 0
  ) {
    process.exitCode = 1
  }
} finally {
  await electronApp.close()
}

function isPathInside(root, candidate) {
  const pathFromRoot = relative(resolve(root), resolve(candidate))
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
}

function defaultElectronPath(root) {
  if (process.platform === 'win32') return join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  if (process.platform === 'darwin') {
    return join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
  }
  return join(root, 'node_modules', 'electron', 'dist', 'electron')
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
