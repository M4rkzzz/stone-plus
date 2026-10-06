const BARE_IPV4_URL = /^(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?:\/.*)?$/
const BARE_BRACKETED_IPV6_URL = /^\[[0-9a-f:.%]+\](?::\d{1,5})?(?:\/.*)?$/i

/**
 * Relay imports may use a plain IP address. Treat that explicit shape as HTTP
 * while keeping arbitrary scheme-less hostnames invalid, so typos do not
 * silently become plaintext credential destinations.
 */
export function inferProviderUrlScheme(value: string): string {
  const trimmed = value.trim()
  return BARE_IPV4_URL.test(trimmed) || BARE_BRACKETED_IPV6_URL.test(trimmed)
    ? `http://${trimmed}`
    : trimmed
}

export function parseProviderHttpUrl(value: string): URL {
  const url = new URL(inferProviderUrlScheme(value))
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Provider URLs must use HTTP or HTTPS.')
  }
  if (!url.hostname) throw new Error('Provider URL must include a host.')
  if (url.username || url.password) {
    throw new Error('Provider credentials must not be embedded in the URL.')
  }
  if (url.search || url.hash) {
    throw new Error('Provider base URLs cannot contain a query string or fragment.')
  }
  return url
}

export function normalizeProviderHttpUrl(value: string, exact = false): string {
  const normalized = parseProviderHttpUrl(value).toString()
  return exact ? normalized : normalized.replace(/\/$/, '')
}
