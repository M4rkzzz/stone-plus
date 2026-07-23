import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import packageMetadata from './package.json'

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(packageMetadata.version)
  },
  resolve: {
    alias: {
      '@shared': resolve('src/shared')
    }
  },
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    clearMocks: true,
    restoreMocks: true
  }
})
