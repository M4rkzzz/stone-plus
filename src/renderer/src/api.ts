import type { GatewayApi } from '@shared/types'
import { createMockApi } from './mockApi'

declare global {
  interface Window {
    stone?: GatewayApi
    stonePlatform?: NodeJS.Platform
  }
}

let browserMock: GatewayApi | undefined

export function getGatewayApi(): GatewayApi {
  const electronApi = window.stone as GatewayApi | undefined
  if (electronApi) return electronApi
  browserMock ??= createMockApi()
  return browserMock
}
