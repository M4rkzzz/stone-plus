import type { GatewayApi } from '@shared/types'

declare global {
  interface Window {
    stone: GatewayApi
    stonePlatform: NodeJS.Platform
  }
}

export {}
