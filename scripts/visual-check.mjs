import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const baseUrl = process.env.STONE_PREVIEW_URL ?? 'http://127.0.0.1:5173'
const outputDirectory = fileURLToPath(new URL('../.artifacts/visual/', import.meta.url))
const pages = ['总览', '供应商', '号池', '路由', '客户端', '会话修复', '请求', '设置']
const modalCases = [
  {
    name: 'account-model-modal',
    page: '供应商',
    open: async (page) => {
      const row = page.locator('.accounts-table tbody tr').filter({ hasText: 'OpenAI 扩展账号' })
      await row.locator('button[title="更多操作"]').click()
      await row.locator('.context-menu button').filter({ hasText: '编辑' }).click()
    }
  },
  {
    name: 'pool-model-modal',
    page: '号池',
    open: async (page) => {
      const card = page.locator('.pool-card').filter({ hasText: 'Codex 主线路' })
      await card.locator('.text-button').filter({ hasText: '编辑配置' }).click()
    }
  },
  {
    name: 'account-import-modal',
    page: '供应商',
    scrollTo: '.account-file-import',
    open: async (page) => {
      await page.getByRole('button', { name: '导入 ChatGPT 账号' }).click()
    }
  }
]
const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 }
]

await mkdir(outputDirectory, { recursive: true })
const browser = await chromium.launch({
  channel: process.env.STONE_BROWSER_CHANNEL ?? 'msedge',
  headless: true
})
const results = []

try {
  for (const viewport of viewports) {
    const context = await browser.newContext({ viewport })
    const page = await context.newPage()
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await page.locator('.app-shell').waitFor()

    for (const label of pages) {
      await navigate(page, label, viewport.name)
      await page.waitForTimeout(250)
      const layout = await inspectLayout(page, '.page-content', true)

      const slug = `${viewport.name}-${pages.indexOf(label) + 1}`
      await page.screenshot({ path: join(outputDirectory, `${slug}.png`), fullPage: true })
      results.push({ viewport: viewport.name, page: label, ...layout })
    }

    for (const modalCase of modalCases) {
      await navigate(page, modalCase.page, viewport.name)
      await modalCase.open(page)
      const modal = page.locator('.modal')
      await modal.waitFor()
      await modal.locator(modalCase.scrollTo ?? '.model-policy').scrollIntoViewIfNeeded()
      await page.waitForTimeout(150)
      const layout = await inspectLayout(page, '.modal')
      await page.screenshot({ path: join(outputDirectory, `${viewport.name}-${modalCase.name}.png`) })
      results.push({ viewport: viewport.name, page: modalCase.name, ...layout })
      await modal.locator('button[title="关闭"]').click()
    }
    await context.close()
  }
} finally {
  await browser.close()
}

console.log(JSON.stringify(results, null, 2))
if (results.some((result) =>
  result.horizontalOverflow > 1
  || result.contentHorizontalOverflow > 1
  || result.clippedControls.length > 0
  || result.outOfBoundsControls.length > 0
  || result.overlappingControls.length > 0
)) {
  process.exitCode = 1
}

async function navigate(page, label, viewportName) {
  if (viewportName === 'mobile') {
    await page.locator('.topbar__menu').click()
  }
  await page.locator('.nav-item').filter({ hasText: label }).click()
}

async function inspectLayout(page, scopeSelector, includeTopbar = false) {
  return page.evaluate(({ scopeSelector, includeTopbar }) => {
    const root = document.documentElement
    const scope = document.querySelector(scopeSelector)
    const scopeRect = scope?.getBoundingClientRect()
    const describe = (element) => {
      const label = element.getAttribute('aria-label')
        || element.getAttribute('title')
        || element.textContent?.trim()
        || element.className
        || element.tagName.toLowerCase()
      return String(label).replace(/\s+/g, ' ').slice(0, 80)
    }
    const visibleRect = (element) => {
      const rect = element.getBoundingClientRect()
      let left = Math.max(0, rect.left)
      let top = Math.max(0, rect.top)
      let right = Math.min(root.clientWidth, rect.right)
      let bottom = Math.min(root.clientHeight, rect.bottom)
      let ancestor = element.parentElement
      while (ancestor) {
        const style = getComputedStyle(ancestor)
        if (/auto|scroll|hidden|clip/.test(`${style.overflow} ${style.overflowX} ${style.overflowY}`)) {
          const ancestorRect = ancestor.getBoundingClientRect()
          left = Math.max(left, ancestorRect.left)
          top = Math.max(top, ancestorRect.top)
          right = Math.min(right, ancestorRect.right)
          bottom = Math.min(bottom, ancestorRect.bottom)
        }
        ancestor = ancestor.parentElement
      }
      return { left, top, right, bottom, width: right - left, height: bottom - top }
    }
    const isVisible = (element) => {
      if (!(element instanceof HTMLElement) || element.offsetParent === null) return false
      const closedDetails = element.closest('details:not([open])')
      const visibleSummary = closedDetails?.querySelector(':scope > summary')
      if (closedDetails && !visibleSummary?.contains(element)) return false
      const rect = visibleRect(element)
      const style = getComputedStyle(element)
      return rect.width > 2 && rect.height > 2 && style.visibility !== 'hidden' && style.opacity !== '0'
    }
    const isInsideHorizontalScroller = (element) => {
      let ancestor = element.parentElement
      while (ancestor && ancestor !== scope) {
        const overflowX = getComputedStyle(ancestor).overflowX
        if ((overflowX === 'auto' || overflowX === 'scroll') && ancestor.scrollWidth > ancestor.clientWidth + 2) {
          return true
        }
        ancestor = ancestor.parentElement
      }
      return false
    }
    const scopedControls = scope
      ? [...scope.querySelectorAll('button, input, select, textarea, [role="button"]')]
      : []
    const topbarControls = includeTopbar
      ? [...document.querySelectorAll('.topbar button, .topbar input, .topbar select, .topbar textarea, .topbar [role="button"]')]
      : []
    const interactiveControls = [...scopedControls, ...topbarControls].filter(isVisible)
    const clippedCandidates = includeTopbar
      ? [...document.querySelectorAll('button, .badge, .nav-item')]
      : scope ? [...scope.querySelectorAll('button, .badge')] : []
    const clippedControls = clippedCandidates
      .filter(isVisible)
      .filter((element) => element.scrollWidth > element.clientWidth + 2 || element.scrollHeight > element.clientHeight + 2)
      .map(describe)
      .slice(0, 10)

    const outOfBoundsControls = scope && scopeRect
      ? interactiveControls
        .filter((element) => scope.contains(element) && !isInsideHorizontalScroller(element))
        .filter((element) => {
          const rect = element.getBoundingClientRect()
          const scopeRight = scopeRect.left + scope.clientWidth
          return rect.left < scopeRect.left - 1 || rect.right > scopeRight + 1
        })
        .map(describe)
        .slice(0, 10)
      : []

    const overlappingControls = []
    for (let leftIndex = 0; leftIndex < interactiveControls.length; leftIndex += 1) {
      const left = interactiveControls[leftIndex]
      const leftRect = visibleRect(left)
      for (let rightIndex = leftIndex + 1; rightIndex < interactiveControls.length; rightIndex += 1) {
        const right = interactiveControls[rightIndex]
        if (left.contains(right) || right.contains(left)) continue
        const rightRect = visibleRect(right)
        const overlapWidth = Math.min(leftRect.right, rightRect.right) - Math.max(leftRect.left, rightRect.left)
        const overlapHeight = Math.min(leftRect.bottom, rightRect.bottom) - Math.max(leftRect.top, rightRect.top)
        if (overlapWidth > 2 && overlapHeight > 2) {
          overlappingControls.push(`${describe(left)} <> ${describe(right)}`)
          if (overlappingControls.length === 10) break
        }
      }
      if (overlappingControls.length === 10) break
    }

    return {
      viewportWidth: root.clientWidth,
      documentWidth: root.scrollWidth,
      horizontalOverflow: Math.max(0, root.scrollWidth - root.clientWidth),
      contentWidth: scope?.clientWidth ?? 0,
      contentScrollWidth: scope?.scrollWidth ?? 0,
      contentHorizontalOverflow: scope ? Math.max(0, scope.scrollWidth - scope.clientWidth) : 0,
      clippedControls,
      outOfBoundsControls,
      overlappingControls
    }
  }, { scopeSelector, includeTopbar })
}
