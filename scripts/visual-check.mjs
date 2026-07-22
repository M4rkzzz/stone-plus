import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const baseUrl = process.env.STONE_PREVIEW_URL ?? 'http://127.0.0.1:5173'
const outputDirectory = fileURLToPath(new URL('../.artifacts/visual/', import.meta.url))
const pages = ['总览', '账号与中转', '代理', '号池', '路由', '客户端配置', '会话修复', '诊断', '请求记录', '设置', '帮助与下一步']
const englishPages = ['Overview', 'Accounts & Relays', 'Client Configuration', 'Diagnostics', 'Settings', 'Help & Next Steps']
const modalCases = [
  {
    name: 'account-model-modal',
    page: '账号与中转',
    open: async (page) => {
      const row = page.locator('.accounts-table tbody tr').first()
      await row.locator('button[title="更多操作"]').click()
      await page.locator('.context-menu--portal button').filter({ hasText: '编辑' }).click()
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
    page: '账号与中转',
    scrollTo: '.oauth-account-flow',
    open: async (page) => {
      await page.getByRole('button', { name: '添加 Codex 账号' }).click()
    }
  },
  {
    name: 'account-export-modal',
    page: '账号与中转',
    scrollTo: '.account-export__list',
    open: async (page) => {
      await page.getByRole('button', { name: '导出账号' }).click()
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
    await context.addInitScript(() => window.localStorage.setItem('stone.ui.language', 'zh-CN'))
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

  const englishContext = await browser.newContext({ viewport: viewports[0] })
  await englishContext.addInitScript(() => window.localStorage.setItem('stone.ui.language', 'en'))
  const englishPage = await englishContext.newPage()
  await englishPage.goto(baseUrl, { waitUntil: 'networkidle' })
  await englishPage.locator('.app-shell').waitFor()
  for (const label of englishPages) {
    await navigate(englishPage, label, 'desktop')
    await englishPage.waitForTimeout(200)
    const layout = await inspectLayout(englishPage, '.page-content', true)
    await englishPage.screenshot({
      path: join(outputDirectory, `english-${englishPages.indexOf(label) + 1}.png`),
      fullPage: true
    })
    results.push({ viewport: 'english-desktop', page: label, ...layout })
  }
  await navigate(englishPage, 'Settings', 'desktop')
  const languageSelect = englishPage.getByLabel('界面语言 / Display language')
  if (await languageSelect.inputValue() !== 'en') throw new Error('English language preference was not applied.')
  if (await englishPage.locator('.settings-section').first().getByText('语言 / Language').count() !== 1) {
    throw new Error('The bilingual language setting is not the first settings section.')
  }
  await englishContext.close()

  const systemLanguageContext = await browser.newContext({ viewport: viewports[0], locale: 'fr-FR' })
  const systemLanguagePage = await systemLanguageContext.newPage()
  await systemLanguagePage.goto(baseUrl, { waitUntil: 'networkidle' })
  await systemLanguagePage.locator('.nav-item').filter({ hasText: 'Overview' }).waitFor()
  await navigate(systemLanguagePage, 'Settings', 'desktop')
  if (await systemLanguagePage.getByLabel('界面语言 / Display language').inputValue() !== 'system') {
    throw new Error('A fresh non-Chinese system did not keep the default system-language preference.')
  }
  if (await systemLanguagePage.locator('html').getAttribute('lang') !== 'en') {
    throw new Error('A non-Chinese system did not resolve to the English interface.')
  }
  await systemLanguagePage.screenshot({
    path: join(outputDirectory, 'system-language-default.png'),
    fullPage: true
  })
  await systemLanguageContext.close()
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
      // Source tabs intentionally hide their inner count badge at the rounded
      // edge. Model-policy buttons also report their off-screen info tooltip in
      // scrollWidth even though the actual label is fully visible.
      .filter((element) => !element.matches('.source-type-tabs > button, .model-policy__modes > button, .strategy-options > button'))
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
