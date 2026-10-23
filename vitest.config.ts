import { resolve } from 'node:path'
import { availableParallelism } from 'node:os'
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
    restoreMocks: true,
    // High-core hosts otherwise spawn one fork per available CPU, which can
    // starve the event loop in local HTTP integration tests without improving
    // the suite's wall-clock time.
    maxWorkers: Math.max(1, Math.min(8, availableParallelism() - 1))
  }
})
