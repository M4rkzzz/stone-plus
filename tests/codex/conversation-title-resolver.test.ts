import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CodexConversationTitleResolver } from '../../src/main/codex'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('CodexConversationTitleResolver', () => {
  it('reads the current title from the local Codex thread database', async () => {
    const home = await mkdtemp(join(tmpdir(), 'stone-codex-title-'))
    temporaryDirectories.push(home)
    const codexDirectory = join(home, '.codex')
    await mkdir(codexDirectory)
    const database = new DatabaseSync(join(codexDirectory, 'state_5.sqlite'))
    database.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT NOT NULL)')
    database.prepare('INSERT INTO threads (id, title) VALUES (?, ?)').run('thread-one', '  修复 Stone   请求页面  ')
    database.close()

    const resolver = new CodexConversationTitleResolver(home)
    expect(resolver.resolve('thread-one')).toBe('修复 Stone 请求页面')
    expect(resolver.resolve('missing')).toBeUndefined()
    resolver.close()
  })

  it('does not fail when Codex has no local database', async () => {
    const home = await mkdtemp(join(tmpdir(), 'stone-codex-title-missing-'))
    temporaryDirectories.push(home)
    const resolver = new CodexConversationTitleResolver(home)
    expect(resolver.resolve('thread-one')).toBeUndefined()
    resolver.close()
  })
})
