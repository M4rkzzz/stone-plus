import { BrowserWindow, type IpcMainInvokeEvent } from 'electron'

export function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const frame = event.senderFrame
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (!frame || !owner || frame !== event.sender.mainFrame) {
    throw new Error('Stone+ rejected IPC from an untrusted frame.')
  }

  const url = new URL(frame.url)
  const developmentUrl = process.env.ELECTRON_RENDERER_URL
  const trusted = developmentUrl
    ? url.origin === new URL(developmentUrl).origin
    : url.protocol === 'file:' && decodeURIComponent(url.pathname).replaceAll('\\', '/').endsWith('/out/renderer/index.html')
  if (!trusted) throw new Error('Stone+ rejected IPC from an untrusted origin.')
}
