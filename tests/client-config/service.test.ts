import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientConfigParseError, ClientConfigService } from '../../src/main/client-config'

describe('ClientConfigService', () => {
  let homeDir: string
  let service: ClientConfigService
  const fixedDate = new Date('2026-07-12T01:02:03.456Z')

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'stone-client-config-'))
    service = new ClientConfigService({
      homeDir,
      platform: process.platform,
      now: () => fixedDate,
      randomId: () => `test-${Math.random().toString(16).slice(2)}`,
    })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(homeDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
        break
      } catch (error) {
        if (attempt === 4) throw error
      }
    }
  })

  it('detects configured clients and their concrete files', async () => {
    await mkdir(service.paths.claude.directory, { recursive: true })
    await writeFile(service.paths.claude.settings.path, '{}\n')

    const detected = await service.detect()

    expect(detected.find((item) => item.client === 'claude')).toMatchObject({
      directoryExists: true,
      configured: true,
      files: [
        { role: 'claude-settings', exists: true },
        { role: 'claude-mcp', exists: false },
      ],
    })
    expect(detected.find((item) => item.client === 'codex')).toMatchObject({
      directoryExists: false,
      configured: false,
    })
  })

  it('backs up an existing Claude config before atomic replacement and can restore it', async () => {
    const original = '{"unknown":{"keep":true},"env":{"SHELL":"zsh"}}\n'
    const token = 'stone_claude_secret'
    await mkdir(service.paths.claude.directory, { recursive: true })
    await writeFile(service.paths.claude.settings.path, original)
    const consoleSpy = vi.spyOn(console, 'log')

    const applied = await service.apply('claude', { gatewayBaseUrl: 'http://127.0.0.1:15721', token })

    expect(applied.changedFiles).toEqual([service.paths.claude.settings.path])
    expect(applied.backups).toHaveLength(1)
    expect(applied.backups[0].backupPath).toMatch(/settings\.json\.stone-backup\.20260712T010203456Z$/)
    expect(JSON.stringify(applied)).not.toContain(token)
    expect(consoleSpy).not.toHaveBeenCalled()
    expect(await readFile(applied.backups[0].backupPath, 'utf8')).toBe(original)
    const changed = JSON.parse(await readFile(service.paths.claude.settings.path, 'utf8'))
    expect(changed.unknown.keep).toBe(true)
    expect(changed.env.ANTHROPIC_AUTH_TOKEN).toBe(token)
    expect((await readdir(service.paths.claude.directory)).some((name) => name.endsWith('.tmp'))).toBe(false)

    const listed = await service.listBackups('claude')
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ createdAt: fixedDate.getTime(), role: 'claude-settings' })

    const restored = await service.restore(listed[0].backupPath, 'claude')
    expect(restored.safetyBackup).toBeDefined()
    expect(restored.safetyBackup?.backupPath).toMatch(/\.1$/)
    expect(await readFile(service.paths.claude.settings.path, 'utf8')).toBe(original)
    expect(await service.listBackups('claude')).toHaveLength(2)
  })

  it('creates new Codex files and only backs up files changed on a later apply', async () => {
    const first = await service.apply('codex', {
      gatewayBaseUrl: 'http://127.0.0.1:15721',
      token: 'first-token',
    })

    expect(first.backups).toEqual([])
    expect(first.changedFiles).toHaveLength(2)
    expect(await readFile(service.paths.codex.config.path, 'utf8')).toContain('wire_api = "responses"')
    expect(JSON.parse(await readFile(service.paths.codex.auth.path, 'utf8')).OPENAI_API_KEY).toBe('first-token')

    const second = await service.apply('codex', {
      gatewayBaseUrl: 'http://127.0.0.1:15721',
      token: 'second-token',
    })

    expect(second.changedFiles).toEqual([service.paths.codex.auth.path])
    expect(second.backups).toHaveLength(1)
    expect(second.backups[0].role).toBe('codex-auth')
    expect(JSON.parse(await readFile(service.paths.codex.auth.path, 'utf8')).OPENAI_API_KEY).toBe('second-token')
  })

  it('scopes a profile to a custom directory without touching the default client path', async () => {
    const customDirectory = join(homeDir, 'profiles', 'work-claude')
    const scoped = service.withOverrides({ claudeDirectory: customDirectory })

    const result = await scoped.apply('claude', {
      gatewayBaseUrl: 'http://127.0.0.1:15721',
      token: 'profile-token',
    })

    expect(result.changedFiles).toEqual([join(customDirectory, 'settings.json')])
    expect(JSON.parse(await readFile(join(customDirectory, 'settings.json'), 'utf8')).env.ANTHROPIC_AUTH_TOKEN)
      .toBe('profile-token')
    await expect(readFile(service.paths.claude.settings.path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains only the configured number of backups per managed file', async () => {
    let current = fixedDate.getTime()
    const rotating = new ClientConfigService({
      homeDir,
      platform: process.platform,
      now: () => new Date(current),
      randomId: () => `retention-${current}`,
    })
    await rotating.apply('claude', {
      gatewayBaseUrl: 'http://127.0.0.1:15721',
      token: 'token-0',
    }, { backupRetention: 2 })

    let latest
    for (let index = 1; index <= 4; index += 1) {
      current += 1_000
      latest = await rotating.apply('claude', {
        gatewayBaseUrl: 'http://127.0.0.1:15721',
        token: `token-${index}`,
      }, { backupRetention: 2 })
    }

    expect(await rotating.listBackups('claude')).toHaveLength(2)
    expect(latest?.removedBackups).toHaveLength(1)
    expect(JSON.stringify(latest)).not.toContain('token-4')
  }, 15_000)

  it('backs up and updates both Gemini files without touching unrelated settings', async () => {
    await mkdir(service.paths.gemini.directory, { recursive: true })
    await writeFile(service.paths.gemini.settings.path, '{"theme":"Default","security":{"auth":{"custom":true}}}\n')
    await writeFile(service.paths.gemini.env.path, 'KEEP_THIS=yes\nGEMINI_API_KEY=old\n')

    const result = await service.apply('gemini', {
      gatewayBaseUrl: 'http://localhost:15721',
      token: 'gemini-token',
    })

    expect(result.backups).toHaveLength(2)
    const settings = JSON.parse(await readFile(service.paths.gemini.settings.path, 'utf8'))
    const env = await readFile(service.paths.gemini.env.path, 'utf8')
    expect(settings).toMatchObject({ theme: 'Default', security: { auth: { custom: true, selectedType: 'gemini-api-key' } } })
    expect(env).toContain('KEEP_THIS=yes')
    expect(env).toContain('GEMINI_API_KEY="gemini-token"')
    expect(env).toContain('GEMINI_API_KEY_AUTH_MECHANISM="bearer"')
    expect(env).toContain('GOOGLE_GEMINI_BASE_URL="http://localhost:15721"')
  })

  it('creates and restores coherent multi-file backup sets without merging same-millisecond operations', async () => {
    await mkdir(service.paths.codex.directory, { recursive: true })
    await writeFile(service.paths.codex.config.path, 'model = "snapshot-one"\n')
    await writeFile(service.paths.codex.auth.path, '{"OPENAI_API_KEY":"snapshot-one"}\n')

    const first = await service.createBackupSet('codex')
    expect(first.backups.map((backup) => backup.role)).toEqual(['codex-config', 'codex-auth'])
    expect(new Set(first.backups.map((backup) => backup.groupId))).toEqual(new Set([first.groupId]))
    expect(new Set(first.backups.map((backup) => backup.createdAt))).toEqual(new Set([fixedDate.getTime()]))

    await writeFile(service.paths.codex.config.path, 'model = "snapshot-two"\n')
    await writeFile(service.paths.codex.auth.path, '{"OPENAI_API_KEY":"snapshot-two"}\n')
    const second = await service.createBackupSet('codex')

    expect(second.groupId).not.toBe(first.groupId)
    expect(second.backups.every((backup) => backup.backupPath.endsWith('.1'))).toBe(true)
    await expect(service.restoreBackupSet('codex', fixedDate.getTime()))
      .rejects.toThrow('use the exact group id')

    await writeFile(service.paths.codex.config.path, 'model = "current"\n')
    await writeFile(service.paths.codex.auth.path, '{"OPENAI_API_KEY":"current"}\n')
    const restored = await service.restoreBackupSet('codex', first.groupId)

    expect(restored.restoredFiles).toEqual([
      service.paths.codex.config.path,
      service.paths.codex.auth.path,
    ])
    expect(restored.sourceBackups.every((backup) => backup.groupId === first.groupId)).toBe(true)
    expect(restored.safetyBackupSet?.backups).toHaveLength(2)
    expect(new Set(restored.safetyBackupSet?.backups.map((backup) => backup.groupId)))
      .toEqual(new Set([restored.safetyBackupSet?.groupId]))
    expect(await readFile(service.paths.codex.config.path, 'utf8')).toBe('model = "snapshot-one"\n')
    expect(await readFile(service.paths.codex.auth.path, 'utf8')).toBe('{"OPENAI_API_KEY":"snapshot-one"}\n')
  })

  it('serializes concurrent backup requests so their file groups cannot interleave', async () => {
    await mkdir(service.paths.codex.directory, { recursive: true })
    await writeFile(service.paths.codex.config.path, 'model = "concurrent"\n')
    await writeFile(service.paths.codex.auth.path, '{"OPENAI_API_KEY":"concurrent"}\n')

    const [first, second] = await Promise.all([
      service.createBackupSet('codex'),
      service.createBackupSet('codex'),
    ])

    expect(first.groupId).not.toBe(second.groupId)
    expect(first.backups).toHaveLength(2)
    expect(second.backups).toHaveLength(2)
    expect(new Set((await service.listBackups('codex')).map((backup) => backup.groupId)).size).toBe(2)
  })

  it('restores the latest backup set and reports clearly when no backup exists', async () => {
    await expect(service.restoreLatestBackupSet('gemini')).rejects.toThrow('No backups are available for gemini')
    await expect(service.createBackupSet('gemini')).rejects.toThrow('No existing gemini configuration files')

    await mkdir(service.paths.gemini.directory, { recursive: true })
    await writeFile(service.paths.gemini.settings.path, '{"ui":{"theme":"snapshot"}}\n')
    await writeFile(service.paths.gemini.env.path, 'KEEP=snapshot\n')
    const created = await service.createBackupSet('gemini')
    await writeFile(service.paths.gemini.settings.path, '{"ui":{"theme":"changed"}}\n')
    await writeFile(service.paths.gemini.env.path, 'KEEP=changed\n')

    const restored = await service.restoreLatestBackupSet('gemini')

    expect(restored.groupId).toBe(created.groupId)
    expect(await readFile(service.paths.gemini.settings.path, 'utf8')).toBe('{"ui":{"theme":"snapshot"}}\n')
    expect(await readFile(service.paths.gemini.env.path, 'utf8')).toBe('KEEP=snapshot\n')
  })

  it('rolls back files already restored when a later file write fails', async () => {
    let writeSequence = 0
    const sabotaged = new ClientConfigService({
      homeDir,
      platform: process.platform,
      now: () => fixedDate,
      randomId: () => {
        writeSequence += 1
        if (writeSequence === 2) {
          rmSync(sabotaged.paths.codex.auth.path, { force: true })
          mkdirSync(sabotaged.paths.codex.auth.path)
        }
        return `restore-${writeSequence}`
      },
    })
    await mkdir(sabotaged.paths.codex.directory, { recursive: true })
    await writeFile(sabotaged.paths.codex.config.path, 'model = "backup"\n')
    await writeFile(sabotaged.paths.codex.auth.path, '{"OPENAI_API_KEY":"backup"}\n')
    const backup = await sabotaged.createBackupSet('codex')
    await writeFile(sabotaged.paths.codex.config.path, 'model = "before-restore"\n')
    await writeFile(sabotaged.paths.codex.auth.path, '{"OPENAI_API_KEY":"before-restore"}\n')

    await expect(sabotaged.restoreBackupSet('codex', backup.groupId)).rejects.toBeDefined()

    expect(await readFile(sabotaged.paths.codex.config.path, 'utf8')).toBe('model = "before-restore"\n')
    const safetyGroups = (await sabotaged.listBackups('codex'))
      .filter((record) => record.groupId !== backup.groupId)
    expect(safetyGroups).toHaveLength(2)
    expect(new Set(safetyGroups.map((record) => record.groupId)).size).toBe(1)
  })

  it.skipIf(process.platform === 'win32')('uses private POSIX modes for credential files, temporary replacements, and backups', async () => {
    await mkdir(service.paths.codex.directory, { recursive: true })
    await writeFile(service.paths.codex.config.path, 'model = "gpt-5"\n', { mode: 0o644 })
    await writeFile(service.paths.codex.auth.path, '{"OPENAI_API_KEY":"old"}\n', { mode: 0o644 })
    await chmod(service.paths.codex.config.path, 0o644)
    await chmod(service.paths.codex.auth.path, 0o644)

    const result = await service.apply('codex', {
      gatewayBaseUrl: 'http://127.0.0.1:15721',
      token: 'private-token',
    })

    expect((await stat(service.paths.codex.config.path)).mode & 0o777).toBe(0o600)
    expect((await stat(service.paths.codex.auth.path)).mode & 0o777).toBe(0o600)
    for (const backup of result.backups) {
      expect((await stat(backup.backupPath)).mode & 0o777).toBe(0o600)
    }
    expect((await readdir(service.paths.codex.directory)).some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  it('does not create a backup or modify the file when planning fails', async () => {
    const invalid = '{not json}\n'
    await mkdir(service.paths.claude.directory, { recursive: true })
    await writeFile(service.paths.claude.settings.path, invalid)

    await expect(service.apply('claude', {
      gatewayBaseUrl: 'http://127.0.0.1:15721',
      token: 'never-written',
    })).rejects.toBeInstanceOf(ClientConfigParseError)

    expect(await readFile(service.paths.claude.settings.path, 'utf8')).toBe(invalid)
    expect(await service.listBackups('claude')).toEqual([])
  })

  it('rejects restoring an unmanaged path', async () => {
    const unmanaged = join(homeDir, 'unmanaged.backup')
    await writeFile(unmanaged, 'data')
    await expect(service.restore(unmanaged)).rejects.toThrow('not managed')
  })

  it('rejects restoring a backup through a different client scope before changing files', async () => {
    await mkdir(service.paths.claude.directory, { recursive: true })
    await writeFile(service.paths.claude.settings.path, '{"env":{"KEEP":"claude"}}\n')
    await mkdir(service.paths.codex.directory, { recursive: true })
    await writeFile(service.paths.codex.auth.path, '{"OPENAI_API_KEY":"codex-original"}\n')

    await service.apply('claude', {
      gatewayBaseUrl: 'http://127.0.0.1:15721',
      token: 'claude-updated',
    })
    await service.apply('codex', {
      gatewayBaseUrl: 'http://127.0.0.1:15721',
      token: 'codex-updated',
    })
    const codexBackup = (await service.listBackups('codex'))
      .find((backup) => backup.role === 'codex-auth')
    expect(codexBackup).toBeDefined()
    const claudeBefore = await readFile(service.paths.claude.settings.path, 'utf8')
    const claudeBackupsBefore = await service.listBackups('claude')

    await expect(service.restore(codexBackup!.backupPath, 'claude')).rejects.toThrow('not managed')
    expect(await readFile(service.paths.claude.settings.path, 'utf8')).toBe(claudeBefore)
    expect(await service.listBackups('claude')).toEqual(claudeBackupsBefore)
    expect(JSON.parse(await readFile(service.paths.codex.auth.path, 'utf8')).OPENAI_API_KEY)
      .toBe('codex-updated')
    expect(await service.listBackups('codex')).toHaveLength(1)

    const restored = await service.restore(codexBackup!.backupPath, 'codex')
    expect(restored.client).toBe('codex')
    expect(JSON.parse(await readFile(service.paths.codex.auth.path, 'utf8')).OPENAI_API_KEY)
      .toBe('codex-original')
  })
})
