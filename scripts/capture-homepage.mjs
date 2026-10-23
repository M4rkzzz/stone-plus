// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 StonePlus Contributors

import { mkdir } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = join(root, 'docs', 'screenshots', 'en')
const pages = [
  ['Overview', 'overview'],
  ['Accounts & Relays', 'accounts'],
  ['Pools', 'pools'],
  ['Routes', 'routes'],
  ['Client Configuration', 'clients'],
]

const server = await createServer({
  configFile: join(root, 'vite.config.ts'),
  server: {
    host: '127.0.0.1', port: 5178, strictPort: true,
    fs: { allow: [root, realpathSync(join(root, 'node_modules'))] },
  },
})
let browser
try {
  await mkdir(output, { recursive: true })
  await server.listen()
  browser = await chromium.launch({ channel: process.env.STONE_BROWSER_CHANNEL ?? 'msedge', headless: true })
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'en-US', reducedMotion: 'reduce' })
  await context.addInitScript(() => localStorage.setItem('stone.ui.language', 'en'))
  const page = await context.newPage()
  await page.goto('http://127.0.0.1:5178', { waitUntil: 'networkidle' })
  await page.locator('.app-shell').waitFor()
  for (const [label, file] of pages) {
    await page.locator('.nav-item').filter({ hasText: label }).click()
    if (file === 'accounts') await page.getByRole('tab', { name: /Official APIs/ }).click()
    await page.waitForTimeout(350)
    await page.evaluate(() => document.fonts.ready)
    const chinese = await page.locator('body').innerText().then((text) => text.match(/[\u3400-\u9fff]+/gu) ?? [])
    if (chinese.length) throw new Error(`${label} still contains Chinese text: ${[...new Set(chinese)].join(', ')}`)
    await page.screenshot({ path: join(output, `${file}.png`), animations: 'disabled' })
    console.log(`Captured English ${label}.`)
  }
} finally {
  await browser?.close()
  await server.close()
}
