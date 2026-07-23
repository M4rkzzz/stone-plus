import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import packageMetadata from './package.json'

export default defineConfig({
  root: resolve('src/renderer'),
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(packageMetadata.version)
  },
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  },
  build: {
    outDir: resolve('dist-web'),
    emptyOutDir: true
  }
})
