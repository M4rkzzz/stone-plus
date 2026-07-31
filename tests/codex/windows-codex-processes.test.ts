import { describe, expect, it, vi } from 'vitest'
import {
  encodedPowerShellArgs,
  findBlockingWindowsCodexPids,
  parseTaskListProcessIds,
} from '../../src/main/codex/windows-codex-processes'

describe('Windows Codex process enumeration', () => {
  it('uses an encoded non-throwing PowerShell command and normalizes PIDs', async () => {
    const runCommand = vi.fn(async () => ({ stdout: '42\r\n7\r\n42\r\n', stderr: '' }))

    await expect(findBlockingWindowsCodexPids({ platform: 'win32', runCommand })).resolves.toEqual([7, 42])
    expect(runCommand).toHaveBeenCalledWith('powershell.exe', expect.arrayContaining(['-EncodedCommand']))
    const encoded = runCommand.mock.calls[0]?.[1].at(-1) ?? ''
    const script = Buffer.from(encoded, 'base64').toString('utf16le')
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

  it('reports both enumeration failures', async () => {
    const runCommand = vi.fn(async (file: string) => {
      throw new Error(file === 'tasklist.exe' ? 'tasklist blocked' : 'PowerShell blocked')
    })

    await expect(findBlockingWindowsCodexPids({ platform: 'win32', runCommand }))
      .rejects.toThrow(/PowerShell blocked.*tasklist blocked/)
  })

  it('encodes scripts as Windows PowerShell UTF-16LE command arguments', () => {
    const args = encodedPowerShellArgs("$value = '测试'")
    expect(args.at(-2)).toBe('-EncodedCommand')
    expect(Buffer.from(args.at(-1) ?? '', 'base64').toString('utf16le')).toBe("$value = '测试'")
  })

  it('parses localized tasklist output conservatively', () => {
    expect(parseTaskListProcessIds([
      '信息: 没有运行的任务匹配指定标准。',
      '"ChatGPT.exe","101","Console","1","20 K"',
      '"unrelated.exe","102","Console","1","20 K"',
    ].join('\r\n'))).toEqual([101])
  })
})
