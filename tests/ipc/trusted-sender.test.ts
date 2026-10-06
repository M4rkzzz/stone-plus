import { beforeEach, describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  owner: {} as object,
  fromWebContents: vi.fn(),
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: electron.fromWebContents },
}))

import { assertTrustedSender } from '../../src/main/ipc/trusted-sender'

describe('trusted IPC sender', () => {
  beforeEach(() => {
    electron.fromWebContents.mockReturnValue(electron.owner)
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('ELECTRON_RENDERER_URL', 'https://attacker.example')
  })

  it('never promotes an environment-provided renderer in production', () => {
    const mainFrame = { url: 'https://attacker.example/index.html' }
    expect(() => assertTrustedSender({
      senderFrame: mainFrame,
      sender: { mainFrame },
    } as never)).toThrow('untrusted origin')
  })

  it('also ignores a loopback development renderer in production', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://127.0.0.1:5173')
    const mainFrame = { url: 'http://127.0.0.1:5173/index.html' }
    expect(() => assertTrustedSender({
      senderFrame: mainFrame,
      sender: { mainFrame },
    } as never)).toThrow('untrusted origin')
  })
})
