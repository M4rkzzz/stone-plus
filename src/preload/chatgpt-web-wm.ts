import { contextBridge, ipcRenderer } from 'electron'
import {
  CHATGPT_WEB_WM_STREAM_CHANNEL,
  CHATGPT_WEB_WM_STREAM_TOKEN_ARGUMENT,
  isChatGptWebWmRequestId,
  isChatGptWebWmStreamEvent,
} from '@shared/chatgpt-web-wm-stream'

const bridgeToken = process.argv
  .find((value) => value.startsWith(CHATGPT_WEB_WM_STREAM_TOKEN_ARGUMENT))
  ?.slice(CHATGPT_WEB_WM_STREAM_TOKEN_ARGUMENT.length) ?? ''

if (process.isMainFrame && bridgeToken.length >= 32) {
  contextBridge.exposeInMainWorld('__stoneWebWmStream', Object.freeze({
    emit(requestId: unknown, event: unknown): boolean {
      if (!isChatGptWebWmRequestId(requestId) || !isChatGptWebWmStreamEvent(event)) return false
      ipcRenderer.send(CHATGPT_WEB_WM_STREAM_CHANNEL, bridgeToken, requestId, event)
      return true
    },
  }))
}
