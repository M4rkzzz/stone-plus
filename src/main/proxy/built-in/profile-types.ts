export const BUILT_IN_PROXY_PROFILE_VERSION = 1 as const

export type BuiltInProxyImportFormat = 'sing-box-json' | 'clash-meta-yaml' | 'uri-list'

export type BuiltInProxyNodeType =
  | 'shadowsocks'
  | 'vmess'
  | 'vless'
  | 'trojan'
  | 'hysteria2'
  | 'tuic'
  | 'http'
  | 'socks'

export type BuiltInProxyRuleMode = 'rule' | 'global' | 'direct'

/**
 * Credentials intentionally live only in the main-process profile payload.
 * Renderer/shared summaries must be derived with summarizeBuiltInProxyProfile
 * and must never serialize this object directly.
 */
export interface InternalProxyCredentials {
  username?: string
  password?: string
  uuid?: string
  method?: string
}

export interface InternalProxyTlsOptions {
  enabled: true
  serverName?: string
  insecure?: boolean
  alpn?: string[]
  utlsFingerprint?: string
  reality?: {
    publicKey: string
    shortId?: string
  }
}

export interface InternalProxyTransportOptions {
  type: 'ws' | 'grpc' | 'http' | 'httpupgrade'
  path?: string
  headers?: Record<string, string>
  serviceName?: string
  host?: string[]
  method?: string
}

export interface InternalProxyNode {
  /** Stable SHA-256-derived identifier. It never contains a credential verbatim. */
  id: string
  name: string
  type: BuiltInProxyNodeType
  server: string
  serverPort: number
  credentials: InternalProxyCredentials
  tls?: InternalProxyTlsOptions
  transport?: InternalProxyTransportOptions
  udp?: boolean
  flow?: string
  packetEncoding?: 'packetaddr' | 'xudp'
  alterId?: number
  security?: string
  congestionControl?: string
  udpRelayMode?: string
  upMbps?: number
  downMbps?: number
  obfs?: {
    type: 'salamander'
    password: string
  }
}

export interface InternalProxyGroup {
  id: string
  name: string
  type: 'selector' | 'urltest' | 'fallback' | 'load-balance'
  nodeIds: string[]
}

export type InternalProxyRuleAction = 'proxy' | 'direct' | 'block'

/** A deliberately small, data-only intersection of Clash and sing-box rules. */
export interface InternalProxyRule {
  domains?: string[]
  domainSuffixes?: string[]
  domainKeywords?: string[]
  ipCidrs?: string[]
  ipIsPrivate?: boolean
  ports?: number[]
  portRanges?: string[]
  networks?: Array<'tcp' | 'udp'>
  protocols?: string[]
  ruleSetTags?: Array<'geosite-cn' | 'geoip-cn'>
  action: InternalProxyRuleAction
}

export interface ProxyRuleDowngrade {
  code: 'unsupported-rules' | 'missing-targets' | 'no-rules'
  message: string
  unsupportedCount: number
}

export interface ParsedBuiltInProxyProfile {
  version: typeof BUILT_IN_PROXY_PROFILE_VERSION
  id: string
  name: string
  format: BuiltInProxyImportFormat
  /** Hash of the imported bytes, suitable for refresh/change detection. */
  sourceFingerprint: string
  nodes: InternalProxyNode[]
  groups: InternalProxyGroup[]
  rules: InternalProxyRule[]
  ruleStatus: 'preserved' | 'fallback'
  ruleDowngrade?: ProxyRuleDowngrade
  warnings: string[]
}

export interface BuiltInProxyNodeSummary {
  id: string
  name: string
  type: BuiltInProxyNodeType
  groupIds: string[]
  latencyStatus: 'untested'
}

export interface ParsedBuiltInProxyProfileSummary {
  id: string
  name: string
  format: BuiltInProxyImportFormat
  sourceFingerprint: string
  nodeCount: number
  groupCount: number
  ruleStatus: 'preserved' | 'fallback'
  warning?: string
  nodes: BuiltInProxyNodeSummary[]
}

export function summarizeBuiltInProxyProfile(
  profile: ParsedBuiltInProxyProfile
): ParsedBuiltInProxyProfileSummary {
  return {
    id: profile.id,
    name: profile.name,
    format: profile.format,
    sourceFingerprint: profile.sourceFingerprint,
    nodeCount: profile.nodes.length,
    groupCount: profile.groups.length,
    ruleStatus: profile.ruleStatus,
    warning: profile.ruleDowngrade?.message ?? profile.warnings[0],
    nodes: profile.nodes.map((node) => ({
      id: node.id,
      name: node.name,
      type: node.type,
      groupIds: profile.groups
        .filter((group) => group.nodeIds.includes(node.id))
        .map((group) => group.id),
      latencyStatus: 'untested'
    }))
  }
}
