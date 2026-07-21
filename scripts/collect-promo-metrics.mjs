#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const API_ROOT = 'https://api.github.com'
const API_VERSION = '2022-11-28'
const PAGE_SIZE = 100
const MAX_PAGES = 100
const REQUEST_TIMEOUT_MS = 25_000
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504])
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, '..')

let partialFailures = []

async function main() {
const options = parseArguments(process.argv.slice(2))
const repository = await resolveRepository(options.repository)
const outputDirectory = resolveOutputDirectory(options.output)
const initialCredential = options.anonymous
  ? { token: null, source: 'anonymous' }
  : await resolveCredential()
partialFailures = []
let authentication = initialCredential
let client = new GitHubClient(initialCredential.token)

let repositoryData
try {
  repositoryData = await client.json(`/repos/${repository}`)
} catch (error) {
  if (!(error instanceof GitHubApiError) || error.status !== 401 || !initialCredential.token) throw error

  // A stale environment/GCM credential must not prevent public metrics from being collected.
  authentication = { token: null, source: 'anonymous-fallback' }
  client = new GitHubClient(null)
  partialFailures.push({
    section: 'authentication',
    reason: 'credential_rejected',
    status: 401,
  })
  repositoryData = await client.json(`/repos/${repository}`)
}

const encodedRepository = repository.split('/').map(encodeURIComponent).join('/')
const issuesResult = await optionalSection('issues', async () => {
  const records = await client.paginate(`/repos/${encodedRepository}/issues?state=all&sort=created&direction=asc`)
  return summarizeIssues(records)
})
const releasesResult = await optionalSection('releases', async () => {
  const records = await client.paginate(`/repos/${encodedRepository}/releases`)
  return summarizeReleases(records)
})
const stargazersResult = await optionalSection('stargazers_timeline', async () => {
  const records = await client.paginate(`/repos/${encodedRepository}/stargazers`, {
    Accept: 'application/vnd.github.star+json',
  })
  return summarizeStargazers(records, repositoryData.created_at)
})
const trafficResult = options.noTraffic
  ? unavailable('disabled')
  : await optionalSection('traffic', () => collectTraffic(client, encodedRepository))

const rateLimitResult = await optionalSection('rate_limit', async () => {
  const value = await client.json('/rate_limit')
  return normalizeRateLimit(value)
}, { recordFailure: false })

const collectedAt = new Date().toISOString()
const snapshot = {
  schemaVersion: 1,
  collectedAt,
  repository: {
    fullName: repositoryData.full_name,
    htmlUrl: repositoryData.html_url,
    description: repositoryData.description,
    visibility: repositoryData.visibility,
    defaultBranch: repositoryData.default_branch,
    createdAt: repositoryData.created_at,
    updatedAt: repositoryData.updated_at,
    pushedAt: repositoryData.pushed_at,
    archived: Boolean(repositoryData.archived),
  },
  audience: {
    stars: toNonNegativeInteger(repositoryData.stargazers_count),
    forks: toNonNegativeInteger(repositoryData.forks_count),
    watchers: toNonNegativeInteger(repositoryData.watchers_count),
    subscribers: toNonNegativeInteger(repositoryData.subscribers_count),
  },
  collaboration: issuesResult,
  releases: releasesResult,
  stargazersTimeline: stargazersResult,
  traffic: trafficResult,
  collection: {
    authenticated: Boolean(authentication.token),
    credentialSource: authentication.source,
    rateLimit: rateLimitResult.available ? rateLimitResult.data : null,
    partialFailures,
  },
}

if (!options.dryRun) {
  await persistSnapshot(outputDirectory, snapshot, options.resetBaseline)
}

printSummary(snapshot, outputDirectory, options.dryRun)
}

async function optionalSection(section, task, { recordFailure = true } = {}) {
  try {
    return { available: true, data: await task() }
  } catch (error) {
    const normalized = normalizeFailure(error)
    if (recordFailure) partialFailures.push({ section, ...normalized })
    return unavailable(normalized.reason, normalized.status)
  }
}

function unavailable(reason, status) {
  return {
    available: false,
    reason,
    ...(status ? { status } : {}),
  }
}

class GitHubClient {
  constructor(token) {
    this.token = token
  }

  async json(path, extraHeaders = {}) {
    const url = `${API_ROOT}${path}`
    let lastError

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const response = await fetch(url, {
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'StonePlus-promo-metrics',
            'X-GitHub-Api-Version': API_VERSION,
            ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
            ...extraHeaders,
          },
          signal: controller.signal,
        })
        if (response.ok) return await response.json()

        const error = new GitHubApiError(response.status, classifyHttpFailure(response.status, response.headers))
        if (!RETRYABLE_STATUSES.has(response.status) || attempt === 2) throw error
        lastError = error
        const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10)
        await sleep(Number.isFinite(retryAfter) ? retryAfter * 1_000 : 500 * 2 ** attempt)
      } catch (error) {
        if (error instanceof GitHubApiError) throw error
        lastError = error
        if (attempt === 2) break
        await sleep(500 * 2 ** attempt)
      } finally {
        clearTimeout(timeout)
      }
    }

    if (lastError?.name === 'AbortError') throw new MetricCollectionError('request_timeout')
    throw new MetricCollectionError('network_error')
  }

  async paginate(path, extraHeaders = {}) {
    const separator = path.includes('?') ? '&' : '?'
    const records = []
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const batch = await this.json(`${path}${separator}per_page=${PAGE_SIZE}&page=${page}`, extraHeaders)
      if (!Array.isArray(batch)) throw new MetricCollectionError('invalid_api_response')
      records.push(...batch)
      if (batch.length < PAGE_SIZE) return records
    }
    throw new MetricCollectionError('pagination_limit_reached')
  }
}

class GitHubApiError extends Error {
  constructor(status, reason) {
    super(`GitHub API request failed (${status}).`)
    this.name = 'GitHubApiError'
    this.status = status
    this.reason = reason
  }
}

class MetricCollectionError extends Error {
  constructor(reason) {
    super(`Metric collection failed: ${reason}.`)
    this.name = 'MetricCollectionError'
    this.reason = reason
  }
}

async function collectTraffic(api, repo) {
  const [views, clones, referrers, paths] = await Promise.all([
    api.json(`/repos/${repo}/traffic/views?per=day`),
    api.json(`/repos/${repo}/traffic/clones?per=day`),
    api.json(`/repos/${repo}/traffic/popular/referrers`),
    api.json(`/repos/${repo}/traffic/popular/paths`),
  ])

  return {
    windowDays: 14,
    views: {
      total: toNonNegativeInteger(views.count),
      unique: toNonNegativeInteger(views.uniques),
      daily: normalizeTrafficSeries(views.views),
    },
    clones: {
      total: toNonNegativeInteger(clones.count),
      unique: toNonNegativeInteger(clones.uniques),
      daily: normalizeTrafficSeries(clones.clones),
    },
    referrers: Array.isArray(referrers)
      ? referrers.map((entry) => ({
          referrer: String(entry.referrer ?? ''),
          views: toNonNegativeInteger(entry.count),
          unique: toNonNegativeInteger(entry.uniques),
        }))
      : [],
    popularPaths: Array.isArray(paths)
      ? paths.map((entry) => ({
          path: String(entry.path ?? ''),
          title: String(entry.title ?? ''),
          views: toNonNegativeInteger(entry.count),
          unique: toNonNegativeInteger(entry.uniques),
        }))
      : [],
  }
}

function normalizeTrafficSeries(records) {
  if (!Array.isArray(records)) return []
  return records.map((entry) => ({
    timestamp: entry.timestamp,
    count: toNonNegativeInteger(entry.count),
    unique: toNonNegativeInteger(entry.uniques),
  }))
}

function summarizeIssues(records) {
  const summary = {
    issues: { total: 0, open: 0, closed: 0 },
    pullRequests: { total: 0, open: 0, closed: 0 },
  }
  for (const record of records) {
    const target = record?.pull_request ? summary.pullRequests : summary.issues
    target.total += 1
    if (record?.state === 'open') target.open += 1
    if (record?.state === 'closed') target.closed += 1
  }
  return summary
}

function summarizeReleases(records) {
  const releases = records
    .filter((record) => record && !record.draft)
    .map((record) => {
      const assets = Array.isArray(record.assets)
        ? record.assets.map((asset) => {
            const kind = classifyAsset(asset.name)
            return {
              name: String(asset.name ?? ''),
              kind,
              sizeBytes: toNonNegativeInteger(asset.size),
              downloads: toNonNegativeInteger(asset.download_count),
              updatedAt: asset.updated_at ?? null,
              downloadUrl: asset.browser_download_url ?? null,
            }
          })
        : []
      return {
        id: record.id,
        tagName: record.tag_name,
        name: record.name || record.tag_name,
        htmlUrl: record.html_url,
        publishedAt: record.published_at,
        prerelease: Boolean(record.prerelease),
        assets,
        assetDownloads: sum(assets.map((asset) => asset.downloads)),
        binaryDownloads: sum(assets.filter((asset) => asset.kind === 'binary').map((asset) => asset.downloads)),
      }
    })
    .sort((left, right) => Date.parse(right.publishedAt ?? 0) - Date.parse(left.publishedAt ?? 0))

  const assets = releases.flatMap((release) => release.assets)
  return {
    count: releases.length,
    latest: releases[0]
      ? {
          id: releases[0].id,
          tagName: releases[0].tagName,
          name: releases[0].name,
          htmlUrl: releases[0].htmlUrl,
          publishedAt: releases[0].publishedAt,
          prerelease: releases[0].prerelease,
          assetDownloads: releases[0].assetDownloads,
          binaryDownloads: releases[0].binaryDownloads,
        }
      : null,
    assets: assets.length,
    assetDownloads: sum(assets.map((asset) => asset.downloads)),
    binaryDownloads: sum(assets.filter((asset) => asset.kind === 'binary').map((asset) => asset.downloads)),
    metadataDownloads: sum(assets.filter((asset) => asset.kind === 'metadata').map((asset) => asset.downloads)),
    byRelease: releases,
  }
}

function classifyAsset(name) {
  const normalized = String(name ?? '').toLowerCase()
  if (/\.(?:exe|msi|msix|dmg|pkg|appimage|deb|rpm|apk|zip|7z|tgz|tar\.gz|tar\.xz|tar\.bz2)$/.test(normalized)) {
    return 'binary'
  }
  if (/\.(?:blockmap|ya?ml|json|txt|sha256|sha512|sig|asc)$/.test(normalized)) return 'metadata'
  return 'other'
}

function summarizeStargazers(records, repositoryCreatedAt) {
  const stars = records
    .map((record) => record?.starred_at)
    .filter((timestamp) => typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp)))
    .sort((left, right) => Date.parse(left) - Date.parse(right))
  if (stars.length !== records.length) throw new MetricCollectionError('missing_stargazer_timestamps')

  const dailyMap = new Map()
  for (const timestamp of stars) {
    const date = timestamp.slice(0, 10)
    dailyMap.set(date, (dailyMap.get(date) ?? 0) + 1)
  }
  let cumulative = 0
  const daily = [...dailyMap.entries()].map(([date, added]) => {
    cumulative += added
    return { date, added, total: cumulative }
  })
  return {
    repositoryCreatedAt,
    count: stars.length,
    firstStarAt: stars[0] ?? null,
    lastStarAt: stars.at(-1) ?? null,
    daily,
  }
}

function normalizeRateLimit(value) {
  const core = value?.resources?.core
  if (!core) return null
  return {
    limit: toNonNegativeInteger(core.limit),
    remaining: toNonNegativeInteger(core.remaining),
    resetsAt: Number.isFinite(Number(core.reset)) ? new Date(Number(core.reset) * 1_000).toISOString() : null,
  }
}

async function persistSnapshot(directory, snapshot, resetBaseline) {
  const snapshotDirectory = resolve(directory, 'snapshots')
  await mkdir(snapshotDirectory, { recursive: true })

  const filename = `${snapshot.collectedAt.replaceAll(':', '-').replace('.', '-')}.json`
  const latestPath = resolve(directory, 'latest.json')
  const baselinePath = resolve(directory, 'baseline.json')
  const snapshotPath = resolve(snapshotDirectory, filename)
  const historyPath = resolve(directory, 'history.csv')
  const json = `${JSON.stringify(snapshot, null, 2)}\n`

  await atomicWrite(snapshotPath, json)
  await atomicWrite(latestPath, json)
  if (resetBaseline || !(await fileExists(baselinePath))) await atomicWrite(baselinePath, json)
  await appendHistory(historyPath, snapshot)
}

async function appendHistory(path, snapshot) {
  const header = [
    'collected_at',
    'stars',
    'forks',
    'watchers',
    'issues_open',
    'pull_requests_open',
    'releases',
    'asset_downloads',
    'binary_downloads',
    'views_14d',
    'unique_visitors_14d',
    'clones_14d',
    'unique_cloners_14d',
  ]
  const collaboration = snapshot.collaboration.available ? snapshot.collaboration.data : null
  const releases = snapshot.releases.available ? snapshot.releases.data : null
  const traffic = snapshot.traffic.available ? snapshot.traffic.data : null
  const row = [
    snapshot.collectedAt,
    snapshot.audience.stars,
    snapshot.audience.forks,
    snapshot.audience.watchers,
    collaboration?.issues.open,
    collaboration?.pullRequests.open,
    releases?.count,
    releases?.assetDownloads,
    releases?.binaryDownloads,
    traffic?.views.total,
    traffic?.views.unique,
    traffic?.clones.total,
    traffic?.clones.unique,
  ]

  let previous = ''
  try {
    previous = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const output = previous || `${header.join(',')}\n`
  await atomicWrite(path, `${output}${row.map(csvValue).join(',')}\n`)
}

async function atomicWrite(path, contents) {
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.tmp`
  await writeFile(temporaryPath, contents, 'utf8')
  await rename(temporaryPath, path)
}

async function fileExists(path) {
  try {
    await readFile(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

async function resolveCredential() {
  const environmentToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (environmentToken) return { token: environmentToken.trim(), source: 'environment' }

  try {
    const result = spawnSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
      env: {
        ...process.env,
        GCM_INTERACTIVE: 'Never',
        GIT_TERMINAL_PROMPT: '0',
      },
    })
    if (result.status !== 0) return { token: null, source: 'anonymous' }
    const credential = parseCredentialOutput(result.stdout)
    return credential.password
      ? { token: credential.password, source: 'git-credential-manager' }
      : { token: null, source: 'anonymous' }
  } catch {
    return { token: null, source: 'anonymous' }
  }
}

function parseCredentialOutput(output) {
  const credential = {}
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    credential[line.slice(0, separator)] = line.slice(separator + 1)
  }
  return credential
}

async function resolveRepository(explicitRepository) {
  if (explicitRepository) return validateRepository(explicitRepository)
  if (process.env.PROMO_GITHUB_REPOSITORY) return validateRepository(process.env.PROMO_GITHUB_REPOSITORY)
  if (process.env.GITHUB_REPOSITORY) return validateRepository(process.env.GITHUB_REPOSITORY)

  try {
    const packageJson = JSON.parse(await readFile(resolve(REPOSITORY_ROOT, 'package.json'), 'utf8'))
    const repositoryUrl = typeof packageJson.repository === 'string'
      ? packageJson.repository
      : packageJson.repository?.url
    const match = String(repositoryUrl ?? '').match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/i)
    if (match) return validateRepository(`${match[1]}/${match[2]}`)
  } catch {
    // Fall through to the project default when package metadata is unavailable.
  }
  return 'M4rkzzz/stone-plus'
}

function validateRepository(value) {
  const normalized = String(value).trim()
  if (!REPOSITORY_PATTERN.test(normalized)) {
    throw new Error('Repository must use the owner/name form.')
  }
  return normalized
}

function resolveOutputDirectory(value) {
  if (!value) return resolve(REPOSITORY_ROOT, '.promo', 'metrics')
  return isAbsolute(value) ? resolve(value) : resolve(REPOSITORY_ROOT, value)
}

function parseArguments(argumentsList) {
  const parsed = {
    repository: null,
    output: null,
    anonymous: false,
    dryRun: false,
    noTraffic: false,
    resetBaseline: false,
  }
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]
    if (argument === '--repo' || argument === '--output') {
      const value = argumentsList[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`)
      parsed[argument === '--repo' ? 'repository' : 'output'] = value
      index += 1
      continue
    }
    if (argument === '--anonymous') parsed.anonymous = true
    else if (argument === '--dry-run') parsed.dryRun = true
    else if (argument === '--no-traffic') parsed.noTraffic = true
    else if (argument === '--reset-baseline') parsed.resetBaseline = true
    else if (argument === '--help' || argument === '-h') {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  return parsed
}

function printHelp() {
  console.log(`Collect Stone+ GitHub promotion metrics.

Usage:
  node scripts/collect-promo-metrics.mjs [options]

Options:
  --repo owner/name     Repository to inspect (defaults to package.json repository)
  --output path         Metrics directory (defaults to .promo/metrics)
  --anonymous           Skip GITHUB_TOKEN, GH_TOKEN and Git Credential Manager
  --no-traffic          Skip owner-only GitHub traffic metrics
  --dry-run             Collect and print a summary without writing files
  --reset-baseline      Replace baseline.json with the new snapshot
  -h, --help            Show this help
`)
}

function printSummary(snapshot, directory, dryRun) {
  const collaboration = snapshot.collaboration.available ? snapshot.collaboration.data : null
  const releases = snapshot.releases.available ? snapshot.releases.data : null
  const traffic = snapshot.traffic.available ? snapshot.traffic.data : null
  const summary = [
    `GitHub metrics collected for ${snapshot.repository.fullName}.`,
    `Stars ${snapshot.audience.stars} | Forks ${snapshot.audience.forks}`,
    `Open issues ${collaboration?.issues.open ?? 'n/a'} | Open PRs ${collaboration?.pullRequests.open ?? 'n/a'}`,
    `Release binary downloads ${releases?.binaryDownloads ?? 'n/a'} | All asset downloads ${releases?.assetDownloads ?? 'n/a'}`,
    traffic
      ? `14-day traffic: ${traffic.views.unique} unique visitors, ${traffic.clones.unique} unique cloners`
      : `14-day traffic: unavailable (${snapshot.traffic.reason})`,
    dryRun ? 'Dry run: no files written.' : `Saved to ${directory}`,
  ]
  console.log(summary.join('\n'))
}

function normalizeFailure(error) {
  if (error instanceof GitHubApiError) return { reason: error.reason, status: error.status }
  if (error instanceof MetricCollectionError) return { reason: error.reason }
  if (error?.name === 'AbortError') return { reason: 'request_timeout' }
  return { reason: 'unexpected_error' }
}

function classifyHttpFailure(status, headers) {
  if (status === 401) return 'authentication_required'
  if (status === 403 && headers.get('x-ratelimit-remaining') === '0') return 'rate_limited'
  if (status === 403) return 'insufficient_permission'
  if (status === 404) return 'not_found_or_insufficient_permission'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'github_unavailable'
  return `http_${status}`
}

function toNonNegativeInteger(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0
}

function sum(values) {
  return values.reduce((total, value) => total + toNonNegativeInteger(value), 0)
}

function csvValue(value) {
  if (value === null || value === undefined) return ''
  const string = String(value)
  return /[",\r\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

try {
  await main()
} catch (error) {
  const failure = normalizeFailure(error)
  console.error(`GitHub metrics collection failed: ${failure.reason}${failure.status ? ` (HTTP ${failure.status})` : ''}.`)
  process.exitCode = 1
}
