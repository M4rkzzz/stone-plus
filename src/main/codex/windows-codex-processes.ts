import { execFile } from 'node:child_process'

export interface ProcessCommandResult {
  stdout: string
  stderr: string
}

export type ProcessCommandRunner = (file: string, args: string[]) => Promise<ProcessCommandResult>

const listBlockingDesktopCommand = [
  "$ErrorActionPreference = 'SilentlyContinue';",
  "$items = @(Get-Process -Name 'ChatGPT','Codex' -ErrorAction SilentlyContinue);",
  'foreach ($item in $items) {',
  "  if ($item.ProcessName -ieq 'ChatGPT') { [Console]::Out.WriteLine($item.Id); continue }",
  '  try { $file = [IO.Path]::GetFileName($item.Path) } catch { $file = $null }',
  "  if ($file -ceq 'Codex.exe') { [Console]::Out.WriteLine($item.Id) }",
  '}',
  'exit 0',
].join(' ')

export async function findBlockingWindowsCodexPids(options: {
  platform?: NodeJS.Platform
  runCommand?: ProcessCommandRunner
} = {}): Promise<number[]> {
  if ((options.platform ?? process.platform) !== 'win32') return []
  const runCommand = options.runCommand ?? runProcessCommand
  try {
    const result = await runCommand('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      listBlockingDesktopCommand,
    ])
    return parseProcessIds(result.stdout)
  } catch (powershellCause) {
    try {
      const [chatGpt, portableCodex] = await Promise.all([
        runCommand('tasklist.exe', ['/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq ChatGPT.exe']),
        runCommand('tasklist.exe', ['/FO', 'CSV', '/NH', '/FI', 'IMAGENAME eq Codex.exe']),
      ])
      return parseTaskListProcessIds(`${chatGpt.stdout}\n${portableCodex.stdout}`)
    } catch {
      throw new Error('无法确认 Codex 是否已关闭：' + messageOf(powershellCause))
    }
  }
}

export function parseProcessIds(output: string): number[] {
  return uniqueSortedPids(output.split(/\r?\n/).map((value) => Number(value.trim())))
}

export function parseTaskListProcessIds(output: string): number[] {
  return uniqueSortedPids(output.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^"([^"]+)","(\d+)"/)
    if (!match) return []
    const image = match[1]
    if (image.toLocaleLowerCase() !== 'chatgpt.exe' && image !== 'Codex.exe') return []
    return [Number(match[2])]
  }))
}

function uniqueSortedPids(values: number[]): number[] {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))]
    .sort((left, right) => left - right)
}

function runProcessCommand(file: string, args: string[]): Promise<ProcessCommandResult> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || stdout || error.message).trim()))
        return
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
