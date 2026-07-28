import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

function developmentRendererUrl(): URL | undefined {
  // Packaged builds never run as Electron's default app and are compiled with
  // NODE_ENV=production. VITEST is kept explicit so IPC contract tests can use
  // their loopback renderer fixture without weakening the production boundary.
  const developmentRuntime = process.env.NODE_ENV !== 'production'
    && (process.defaultApp === true || process.env.VITEST === 'true')
  if (!developmentRuntime) return undefined
  const configured = process.env.ELECTRON_RENDERER_URL
  if (!configured) return undefined

  try {
    const url = new URL(configured)
    const loopback = url.hostname === 'localhost'
      || url.hostname === '127.0.0.1'
      || url.hostname === '[::1]'
    if (!loopback || (url.protocol !== 'http:' && url.protocol !== 'https:')) return undefined
    return url
  } catch {
    return undefined
  }
}

function isPackagedRendererUrl(candidate: URL): boolean {
  const expected = new URL(pathToFileURL(join(__dirname, '../renderer/index.html')).toString())
  return candidate.protocol === 'file:'
    && candidate.host === expected.host
    && decodeURIComponent(candidate.pathname).replaceAll('\\', '/')
      === decodeURIComponent(expected.pathname).replaceAll('\\', '/')
}

export function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const frame = event.senderFrame
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (!frame || !owner || frame !== event.sender.mainFrame) {
    throw new Error('Stone+ rejected IPC from an untrusted frame.')
  }

  const url = new URL(frame.url)
  const developmentUrl = developmentRendererUrl()
  const trusted = developmentUrl
    ? url.origin === developmentUrl.origin
    : isPackagedRendererUrl(url)
  if (!trusted) throw new Error('Stone+ rejected IPC from an untrusted origin.')
}
