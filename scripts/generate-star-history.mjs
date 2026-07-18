import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const DEFAULT_REPOSITORY = 'M4rkzzz/stone-plus'
const DEFAULT_OUTPUT = 'docs/star-history.svg'
const PAGE_SIZE = 100

const repository = process.env.GITHUB_REPOSITORY || DEFAULT_REPOSITORY
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  throw new Error('GITHUB_REPOSITORY must contain a valid owner and repository name.')
}

const data = process.env.STAR_HISTORY_FIXTURE_JSON
  ? JSON.parse(process.env.STAR_HISTORY_FIXTURE_JSON)
  : process.env.STAR_HISTORY_FIXTURE
    ? JSON.parse(await readFile(resolve(process.env.STAR_HISTORY_FIXTURE), 'utf8'))
    : await fetchStarHistory(repository, process.env.GITHUB_TOKEN)
const outputPath = resolve(process.env.STAR_HISTORY_OUTPUT || DEFAULT_OUTPUT)
const svg = renderStarHistory(repository, normalizeData(data))

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, svg, 'utf8')
console.log(`Wrote ${outputPath} with ${data.stars.length} stars.`)

async function fetchStarHistory(repo, token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Stone-star-history-generator',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  }
  const metadata = await githubJson(`/repos/${repo}`, headers)
  const stars = []

  for (let page = 1; ; page += 1) {
    const records = await githubJson(`/repos/${repo}/stargazers?per_page=${PAGE_SIZE}&page=${page}`, {
      ...headers,
      Accept: 'application/vnd.github.star+json'
    })
    if (!Array.isArray(records)) throw new Error('GitHub returned an invalid stargazer list.')
    for (const record of records) {
      if (!record || typeof record.starred_at !== 'string') {
        throw new Error('GitHub did not return stargazer timestamps. An authenticated token is required.')
      }
      stars.push(record.starred_at)
    }
    if (records.length < PAGE_SIZE) break
  }

  return { createdAt: metadata.created_at, stars }
}

async function githubJson(path, headers) {
  const response = await fetch(`https://api.github.com${path}`, { headers })
  if (!response.ok) {
    const remaining = response.headers.get('x-ratelimit-remaining')
    throw new Error(`GitHub request failed with status ${response.status}${remaining ? ` (${remaining} requests remaining)` : ''}.`)
  }
  return response.json()
}

function normalizeData(value) {
  if (!value || typeof value !== 'object') throw new Error('Star history data must be an object.')
  const createdAt = parseDate(value.createdAt, 'createdAt')
  if (!Array.isArray(value.stars)) throw new Error('Star history stars must be an array.')
  const stars = value.stars.map((date, index) => parseDate(date, `stars[${index}]`)).sort((left, right) => left - right)
  return { createdAt, stars }
}

function parseDate(value, field) {
  const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(timestamp)) throw new Error(`Star history ${field} must be a valid date.`)
  return timestamp
}

function renderStarHistory(repo, { createdAt, stars }) {
  const width = 960
  const height = 480
  const plot = { left: 74, top: 104, right: 34, bottom: 58 }
  const plotWidth = width - plot.left - plot.right
  const plotHeight = height - plot.top - plot.bottom
  const lastStarAt = stars.at(-1) ?? createdAt
  const maximumTime = Math.max(lastStarAt, createdAt + 24 * 60 * 60 * 1000)
  const timeSpan = maximumTime - createdAt
  const yMaximum = stars.length <= 5 ? 5 : niceMaximum(stars.length)
  const x = (timestamp) => plot.left + ((timestamp - createdAt) / timeSpan) * plotWidth
  const y = (count) => plot.top + plotHeight - (count / yMaximum) * plotHeight
  const points = [{ timestamp: createdAt, count: 0 }, ...stars.map((timestamp, index) => ({ timestamp, count: index + 1 }))]
  const line = `${stepPath(points, x, y)} H ${formatNumber(x(maximumTime))}`
  const area = `${line} V ${formatNumber(y(0))} H ${formatNumber(x(createdAt))} Z`
  const finalPoint = points.at(-1)
  const xTicks = Array.from({ length: 5 }, (_, index) => createdAt + (timeSpan * index) / 4)
  const yTicks = Array.from({ length: 6 }, (_, index) => (yMaximum * index) / 5)
  const subtitle = `${stars.length} ${stars.length === 1 ? 'star' : 'stars'} - history stored in this repository`
  const emptyMessage = stars.length === 0
    ? '<text class="empty" x="480" y="278" text-anchor="middle">Star history starts with the first star</text>'
    : ''

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="960" height="480" viewBox="0 0 960 480" role="img" aria-labelledby="title description">
  <title id="title">${escapeXml(repo)} star history</title>
  <desc id="description">${escapeXml(subtitle)}</desc>
  <style>
    .title { fill: #f0f6fc; font: 700 24px Inter, "Segoe UI", Arial, sans-serif; }
    .subtitle, .axis { fill: #8b949e; font: 12px Inter, "Segoe UI", Arial, sans-serif; }
    .count { fill: #f0f6fc; font: 700 30px Inter, "Segoe UI", Arial, sans-serif; }
    .label { fill: #8b949e; font: 600 11px Inter, "Segoe UI", Arial, sans-serif; text-transform: uppercase; }
    .grid { stroke: #30363d; stroke-width: 1; }
    .line { fill: none; stroke: #3fbf8b; stroke-linecap: round; stroke-linejoin: round; stroke-width: 3; }
    .area { fill: #238a65; fill-opacity: .2; }
    .point { fill: #3fbf8b; stroke: #0d1117; stroke-width: 3; }
    .empty { fill: #8b949e; font: 600 15px Inter, "Segoe UI", Arial, sans-serif; }
  </style>
  <rect width="960" height="480" rx="10" fill="#0d1117"/>
  <rect x=".5" y=".5" width="959" height="479" rx="9.5" fill="none" stroke="#30363d"/>
  <text class="title" x="34" y="45">Stone Star History</text>
  <text class="subtitle" x="34" y="68">${escapeXml(subtitle)}</text>
  <text class="label" x="926" y="33" text-anchor="end">Current</text>
  <text class="count" x="926" y="67" text-anchor="end">${stars.length}</text>
  ${yTicks.map((count) => `<line class="grid" x1="${plot.left}" y1="${formatNumber(y(count))}" x2="${width - plot.right}" y2="${formatNumber(y(count))}"/>`).join('\n  ')}
  ${xTicks.map((timestamp) => `<line class="grid" x1="${formatNumber(x(timestamp))}" y1="${plot.top}" x2="${formatNumber(x(timestamp))}" y2="${height - plot.bottom}"/>`).join('\n  ')}
  ${yTicks.map((count) => `<text class="axis" x="${plot.left - 12}" y="${formatNumber(y(count) + 4)}" text-anchor="end">${formatCount(count)}</text>`).join('\n  ')}
  ${xTicks.map((timestamp) => `<text class="axis" x="${formatNumber(x(timestamp))}" y="${height - 28}" text-anchor="middle">${formatDate(timestamp, timeSpan)}</text>`).join('\n  ')}
  <path class="area" d="${area}"/>
  <path class="line" d="${line}"/>
  <circle class="point" cx="${formatNumber(x(finalPoint.timestamp))}" cy="${formatNumber(y(finalPoint.count))}" r="5"/>
  ${emptyMessage}
</svg>
`
}

function stepPath(points, x, y) {
  let path = `M ${formatNumber(x(points[0].timestamp))} ${formatNumber(y(points[0].count))}`
  for (const point of points.slice(1)) {
    path += ` H ${formatNumber(x(point.timestamp))} V ${formatNumber(y(point.count))}`
  }
  return path
}

function niceMaximum(value) {
  const magnitude = 10 ** Math.floor(Math.log10(value))
  for (const multiplier of [1, 2, 5, 10]) {
    const candidate = magnitude * multiplier
    if (candidate >= value) return candidate
  }
  return value
}

function formatDate(timestamp, span) {
  const date = new Date(timestamp)
  if (span <= 2 * 24 * 60 * 60 * 1000) {
    return new Intl.DateTimeFormat('en', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'UTC'
    }).format(date)
  }
  if (span <= 180 * 24 * 60 * 60 * 1000) {
    return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date)
  }
  return new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', timeZone: 'UTC' }).format(date)
}

function formatCount(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function formatNumber(value) {
  return Number(value.toFixed(2))
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}
