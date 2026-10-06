import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { codexStateDatabasePaths } from '../../src/main/codex/state-database-paths'

describe('Codex state database paths', () => {
  it('uses sqlite_home from config before the environment override', () => {
    const codexHome = resolve('C:/test-home/.codex')
    const configured = resolve('C:/configured-state')
    const environment = resolve('C:/environment-state')

    expect(codexStateDatabasePaths(
      codexHome,
      `sqlite_home = '${configured.replace(/'/g, "''")}'\n`,
      { CODEX_SQLITE_HOME: environment },
      resolve('C:/test-home'),
    )).toEqual([
      join(codexHome, 'state_5.sqlite'),
      join(configured, 'state_5.sqlite'),
    ])
  })

  it('falls back to CODEX_SQLITE_HOME and expands a user-relative path', () => {
    const userHome = resolve('C:/test-home')
    const codexHome = join(userHome, '.codex')

    expect(codexStateDatabasePaths(
      codexHome,
      '',
      { CODEX_SQLITE_HOME: '~/state' },
      userHome,
    )).toEqual([
      join(codexHome, 'state_5.sqlite'),
      join(userHome, 'state', 'state_5.sqlite'),
    ])
  })

  it('deduplicates an override that resolves to the primary Codex home', () => {
    const codexHome = resolve('C:/test-home/.codex')
    expect(codexStateDatabasePaths(
      codexHome,
      '',
      { CODEX_SQLITE_HOME: codexHome },
      resolve('C:/test-home'),
    )).toEqual([join(codexHome, 'state_5.sqlite')])
  })
})
