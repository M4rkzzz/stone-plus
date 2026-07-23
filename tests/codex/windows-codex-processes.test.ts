import { describe, expect, it, vi } from 'vitest'
import {
  findBlockingWindowsCodexPids,
  parseTaskListProcessIds,
} from '../../src/main/codex/windows-codex-processes'

describe('Windows Codex process enumeration', () => {
  it('uses a non-throwing PowerShell command and normalizes PIDs', async () => {
    const runCommand = vi.fn(async () => ({ stdout: '42\r\n7\r\n42\r\n', stderr: '' }))

    await expect(findBlockingWindowsCodexPids({ platform: 'win32', runCommand })).resolves.toEqual([7, 42])

    const script = runCommand.mock.calls[0]?.[1].at(-1) ?? ''
    expect(script).toContain("$ErrorActionPreference = 'SilentlyContinue'")
    expect(script).toContain('$items = @(')
    expect(script).toMatch(/exit 0$/)
  })

  it('falls back to tasklist without mistaking the lowercase Codex CLI for the desktop app', async () => {
    const runCommand = vi.fn(async (file: string, args: string[]) => {
      if (file === 'powershell.exe') throw new Error('PowerShell policy blocked')
      const filter = args.at(-1) ?? ''
      return filter.includes('ChatGPT')
        ? { stdout: '"ChatGPT.exe","22","Console","1","10 K"', stderr: '' }
        : { stdout: '"Codex.exe","33","Console","1","10 K"\r\n"codex.exe","44","Console","1","10 K"', stderr: '' }
    })

    await expect(findBlockingWindowsCodexPids({ platform: 'win32', runCommand })).resolves.toEqual([22, 33])
  })

  it('parses localized tasklist output conservatively', () => {
    expect(parseTaskListProcessIds([
      '信息: 没有运行的任务匹配指定标准。',
      '"ChatGPT.exe","101","Console","1","20 K"',
      '"unrelated.exe","102","Console","1","20 K"',
    ].join('\r\n'))).toEqual([101])
  })
})
