const VERSION_SEGMENT = /^v\d+(?:[a-z]+\d*)?$/i
const CREDENTIAL_QUERY_NAMES = new Set(['access_token', 'api-key', 'api_key', 'apikey', 'authorization', 'key', 'token'])

export function buildVersionedEndpoint(
  baseUrl: string,
  defaultVersion: string,
  endpointPath: string,
  query: Readonly<Record<string, string>> = {}
): string {
  const url = parseProviderUrl(baseUrl)
  const baseSegments = url.pathname.split('/').filter(Boolean)
  if (!VERSION_SEGMENT.test(baseSegments.at(-1) ?? '')) baseSegments.push(defaultVersion)

  const endpointSegments = endpointPath.split('/').filter(Boolean)
  url.pathname = `/${[...baseSegments, ...endpointSegments].join('/')}`
  url.hash = ''
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value)
  return url.toString()
}

function parseProviderUrl(baseUrl: string): URL {
  const trimmed = baseUrl.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('Provider base URL must be an absolute HTTP(S) URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Provider base URL must use HTTP(S)')
  }
  if (url.username || url.password) {
    throw new Error('Provider base URL must not contain credentials')
  }
  for (const name of url.searchParams.keys()) {
    if (CREDENTIAL_QUERY_NAMES.has(name.toLowerCase())) {
      throw new Error('Provider base URL must not contain credentials')
    }
  }
  return url
}
