import { isIP } from 'node:net'
import type { BuiltInProxyCustomRuleSet } from '@shared/types'
import type {
  BuiltInProxyRuleMode,
  InternalProxyNode,
  InternalProxyRule,
  ParsedBuiltInProxyProfile
} from './profile-types'

const DIRECT_TAG = 'stone-direct'
const DIRECT_DNS_TAG = 'stone-direct-dns'

/**
 * Stable first-party service domains that must remain reachable when a
 * subscription's own rules would otherwise route them directly or reject
 * them. Configured relay/provider hosts are appended by the orchestrator.
 */
export const BUILT_IN_REQUIRED_PROXY_DOMAINS = Object.freeze([
  'openai.com',
  'chatgpt.com',
  'anthropic.com',
  'claude.ai',
  'claude.com',
  'x.ai',
  'grok.com',
  'cli-chat-proxy.grok.com',
  'generativelanguage.googleapis.com',
  'aiplatform.googleapis.com',
  'oauth2.googleapis.com',
  'cloudcode-pa.googleapis.com',
])

export type BuiltInProxyAccessMode = 'system' | 'tun'

export type SingBoxJson = null | boolean | number | string | SingBoxJson[] | { [key: string]: SingBoxJson }

export interface SingBoxSourceConfiguration extends Record<string, unknown> {
  log: { level: string; timestamp: boolean }
  dns: {
    servers: Array<{
      type: string
      tag: string
      server?: string
      server_port?: number
      detour?: string
    }>
    final: string
    strategy: string
  }
  outbounds: Array<Record<string, SingBoxJson>>
  route: {
    auto_detect_interface: boolean
    rules: Array<Record<string, SingBoxJson>>
    rule_set?: Array<Record<string, SingBoxJson>>
    final: string
  }
}

export interface BuildSingBoxConfigInput {
  profile: ParsedBuiltInProxyProfile
  activeNodeId?: string
  mode: BuiltInProxyRuleMode
  /** Runtime listener ownership stays in SingBoxService; this controls policy only. */
  accessMode: BuiltInProxyAccessMode
  /** Explicit visual override for rule mode. Undefined preserves profile rules/fallback behavior. */
  customRules?: BuiltInProxyCustomRuleSet
  /** Configured relay/provider hosts supplement the stable first-party list. */
  requiredProxyDomains?: readonly string[]
  /** Explicit legacy override. Omitted uses the platform resolver. */
  dnsServers?: string[]
}

export interface BuildSingBoxConfigResult {
  /** Listener-free source config. SingBoxService atomically adds mixed/TUN/controller runtime state. */
  config: SingBoxSourceConfiguration
  activeNodeId?: string
  activeOutboundTag?: string
  /** Main-process-only node/tag map used by controller delay tests. */
  outboundTags: Record<string, string>
  requestedNodeMissing: boolean
  routePolicy: 'preserved' | 'fallback' | 'global' | 'direct'
  warnings: string[]
}

export type BuiltInProxyConfigErrorCode = 'invalid-profile' | 'no-active-node' | 'invalid-dns-server'

export class BuiltInProxyConfigError extends Error {
  public readonly code: BuiltInProxyConfigErrorCode

  public constructor(code: BuiltInProxyConfigErrorCode, message: string) {
    super(message)
    this.name = 'BuiltInProxyConfigError'
    this.code = code
  }
}

/**
 * Reconstructs an allow-listed sing-box source configuration from the parsed
 * profile. Imported JSON/YAML is never spread into the output. The service is
 * the sole owner of listener ports and the controller secret, so they cannot
 * leak through IPC/orchestration code.
 */
export function buildSingBoxConfig(input: BuildSingBoxConfigInput): BuildSingBoxConfigResult {
  validateProfileShape(input.profile)
  const warnings: string[] = []
  const needsProxy = input.mode !== 'direct'
  const requested = input.activeNodeId
  const active = requested
    ? input.profile.nodes.find((node) => node.id === requested) ?? input.profile.nodes[0]
    : input.profile.nodes[0]
  const requestedNodeMissing = Boolean(requested && active?.id !== requested)
  if (requestedNodeMissing && active) warnings.push(`The active node is no longer available; switched to "${safeLabel(active.name)}".`)
  if (needsProxy && !active) throw new BuiltInProxyConfigError('no-active-node', 'The selected profile has no active proxy node.')

  const dnsServers = buildDnsServers(input.dnsServers)
  const outboundTags = Object.fromEntries(input.profile.nodes.map((node) => [node.id, outboundTagForNodeId(node.id)]))
  const activeTag = active ? outboundTags[active.id] : undefined
  const outbounds: Array<Record<string, SingBoxJson>> = [directOutbound()]
  if (needsProxy) {
    outbounds.unshift(...input.profile.nodes.map((node) => nodeOutbound(node, outboundTags[node.id])))
  }

  const importedRules = input.profile.rules.filter((rule) => !rule.ruleSetTags?.length)
  if (importedRules.length !== input.profile.rules.length) {
    warnings.push('Subscription GEOIP/GEOSITE rules requiring an external database were skipped; remaining supported subscription rules were preserved.')
  }
  const selectedPolicy = input.mode === 'direct'
    ? 'direct'
    : input.mode === 'global'
      ? 'global'
      : importedRules.length > 0
        ? 'preserved'
        : 'fallback'
  if (input.mode === 'rule' && input.customRules !== undefined) {
    warnings.push('The saved standalone custom rule set was ignored; rule mode now follows the active subscription rules.')
  }
  if (input.mode === 'rule' && input.profile.ruleDowngrade?.message) {
    warnings.push(input.profile.ruleDowngrade.message)
  }

  const route = buildRoute(
    importedRules,
    selectedPolicy,
    activeTag,
    normalizeRequiredProxyDomains(input.requiredProxyDomains),
  )
  return {
    config: {
      log: { level: 'warn', timestamp: true },
      dns: {
        servers: dnsServers,
        final: DIRECT_DNS_TAG,
        strategy: 'prefer_ipv4'
      },
      outbounds,
      route
    },
    activeNodeId: needsProxy ? active?.id : requested && input.profile.nodes.some((node) => node.id === requested) ? requested : active?.id,
    activeOutboundTag: needsProxy ? activeTag : undefined,
    outboundTags: needsProxy ? outboundTags : {},
    requestedNodeMissing,
    routePolicy: selectedPolicy,
    warnings
  }
}

function buildRoute(
  importedRules: InternalProxyRule[],
  policy: BuildSingBoxConfigResult['routePolicy'],
  proxyTag?: string,
  requiredProxyDomains: readonly string[] = BUILT_IN_REQUIRED_PROXY_DOMAINS,
): SingBoxSourceConfiguration['route'] {
  const rules: Array<Record<string, SingBoxJson>> = [
    routeRule({ ip_cidr: ['127.0.0.0/8', '::1/128'] }, 'direct', proxyTag)
  ]
  let sniffActionAdded = false
  const pushPolicyRule = (
    rule: Record<string, SingBoxJson>,
    requiresSniff = false
  ): void => {
    if (requiresSniff && !sniffActionAdded) {
      // Since sing-box 1.13, sniffing is a Stone-owned non-final route action,
      // not an imported inbound option. Insert it only where a later rule
      // needs inspected domain/protocol metadata so IP-only routes stay fast.
      rules.push({ action: 'sniff', timeout: '300ms' })
      sniffActionAdded = true
    }
    rules.push(rule)
  }
  let finalAction: InternalProxyRule['action'] = policy === 'direct' ? 'direct' : 'proxy'
  let policyRules: InternalProxyRule[] = []

  if (policy === 'fallback') {
    // A subscription without safely convertible rules simply uses the
    // selected node. Stone+ no longer downloads or owns a geographic ruleset.
  } else if (policy === 'preserved') {
    policyRules = importedRules
    for (let index = importedRules.length - 1; index >= 0; index -= 1) {
      const candidate = importedRules[index]
      if (candidate && isCatchAll(candidate) && candidate.action !== 'block') {
        finalAction = candidate.action
        break
      }
    }
  }

  if (policy !== 'direct') {
    const missingDomains = requiredProxyDomains.filter((domain) => (
      !isDomainGuaranteedProxy(domain, policyRules, finalAction)
    ))
    if (missingDomains.length > 0) {
      pushPolicyRule(
        routeRule({ domain_suffix: missingDomains }, 'proxy', proxyTag),
        true,
      )
    }
  }

  for (const rule of policyRules) {
    if (isCatchAll(rule) && rule.action !== 'block') continue
    pushPolicyRule(convertRule(rule, proxyTag), importedRuleRequiresSniff(rule))
  }

  const final = finalAction === 'direct'
    ? DIRECT_TAG
    : requireProxyTag(proxyTag)

  return {
    auto_detect_interface: true,
    rules,
    final
  }
}

function importedRuleRequiresSniff(rule: InternalProxyRule): boolean {
  return Boolean(
    rule.domains?.length
    || rule.domainSuffixes?.length
    || rule.domainKeywords?.length
    || rule.protocols?.length
  )
}

function convertRule(rule: InternalProxyRule, proxyTag?: string): Record<string, SingBoxJson> {
  const match: Record<string, SingBoxJson> = {}
  if (rule.domains?.length) match.domain = rule.domains
  if (rule.domainSuffixes?.length) match.domain_suffix = rule.domainSuffixes
  if (rule.domainKeywords?.length) match.domain_keyword = rule.domainKeywords
  if (rule.ipCidrs?.length) match.ip_cidr = rule.ipCidrs
  if (rule.ipIsPrivate !== undefined) match.ip_is_private = rule.ipIsPrivate
  if (rule.ports?.length) match.port = rule.ports
  if (rule.portRanges?.length) match.port_range = rule.portRanges
  if (rule.networks?.length) match.network = rule.networks
  if (rule.protocols?.length) match.protocol = rule.protocols
  return routeRule(match, rule.action, proxyTag)
}

function routeRule(
  match: Record<string, SingBoxJson>,
  action: InternalProxyRule['action'],
  proxyTag?: string
): Record<string, SingBoxJson> {
  if (action === 'block') return { ...match, action: 'reject', method: 'default' }
  return { ...match, action: 'route', outbound: action === 'direct' ? DIRECT_TAG : requireProxyTag(proxyTag) }
}

function directOutbound(): Record<string, SingBoxJson> {
  return { type: 'direct', tag: DIRECT_TAG, domain_resolver: DIRECT_DNS_TAG }
}

function nodeOutbound(node: InternalProxyNode, tag: string): Record<string, SingBoxJson> {
  const base: Record<string, SingBoxJson> = {
    type: node.type,
    tag,
    server: node.server,
    server_port: node.serverPort,
    domain_resolver: DIRECT_DNS_TAG
  }
  if (node.type === 'shadowsocks') {
    base.method = requireCredential(node.credentials.method)
    base.password = requireCredential(node.credentials.password)
  } else if (node.type === 'vmess') {
    base.uuid = requireCredential(node.credentials.uuid)
    base.security = node.security ?? 'auto'
    base.alter_id = node.alterId ?? 0
    if (node.packetEncoding) base.packet_encoding = node.packetEncoding
  } else if (node.type === 'vless') {
    base.uuid = requireCredential(node.credentials.uuid)
    if (node.flow) base.flow = node.flow
    if (node.packetEncoding) base.packet_encoding = node.packetEncoding
  } else if (node.type === 'trojan' || node.type === 'hysteria2') {
    base.password = requireCredential(node.credentials.password)
  } else if (node.type === 'tuic') {
    base.uuid = requireCredential(node.credentials.uuid)
    base.password = requireCredential(node.credentials.password)
  } else {
    if (node.credentials.username) base.username = node.credentials.username
    if (node.credentials.password) base.password = node.credentials.password
    if (node.type === 'socks') base.version = '5'
  }
  if (node.tls) base.tls = tlsConfig(node.tls)
  if (node.transport) base.transport = transportConfig(node.transport)
  if (node.udp !== undefined) base.udp = node.udp
  if (node.type === 'hysteria2') {
    if (node.upMbps) base.up_mbps = node.upMbps
    if (node.downMbps) base.down_mbps = node.downMbps
    if (node.obfs) base.obfs = { type: node.obfs.type, password: node.obfs.password }
  }
  if (node.type === 'tuic') {
    if (node.congestionControl) base.congestion_control = node.congestionControl
    if (node.udpRelayMode) base.udp_relay_mode = node.udpRelayMode
  }
  return base
}

function tlsConfig(tls: NonNullable<InternalProxyNode['tls']>): Record<string, SingBoxJson> {
  const result: Record<string, SingBoxJson> = { enabled: true }
  if (tls.serverName) result.server_name = tls.serverName
  if (tls.insecure !== undefined) result.insecure = tls.insecure
  if (tls.alpn?.length) result.alpn = tls.alpn
  if (tls.utlsFingerprint) result.utls = { enabled: true, fingerprint: tls.utlsFingerprint }
  if (tls.reality) result.reality = { enabled: true, public_key: tls.reality.publicKey, ...(tls.reality.shortId ? { short_id: tls.reality.shortId } : {}) }
  return result
}

function transportConfig(transport: NonNullable<InternalProxyNode['transport']>): Record<string, SingBoxJson> {
  const result: Record<string, SingBoxJson> = { type: transport.type }
  if (transport.path) result.path = transport.path
  if (transport.headers) result.headers = transport.headers
  if (transport.serviceName) result.service_name = transport.serviceName
  if (transport.host?.length) result.host = transport.host
  if (transport.method) result.method = transport.method
  return result
}

function buildDnsServers(value?: string[]): SingBoxSourceConfiguration['dns']['servers'] {
  if (value === undefined) return [{ type: 'local', tag: DIRECT_DNS_TAG }]
  const servers = value
  const normalized = [...new Set(servers.map((server) => server.trim()))]
  if (normalized.length === 0 || normalized.length > 4 || normalized.some((server) => isIP(server) === 0 || isLoopback(server))) {
    throw new BuiltInProxyConfigError('invalid-dns-server', 'DNS upstreams must be one to four non-loopback IP addresses.')
  }
  return normalized.map((server, index) => ({
    type: 'udp',
    tag: index === 0 ? DIRECT_DNS_TAG : `${DIRECT_DNS_TAG}-${index + 1}`,
    server,
    server_port: 53,
    detour: DIRECT_TAG,
  }))
}

function normalizeRequiredProxyDomains(value?: readonly string[]): string[] {
  const candidates = [...BUILT_IN_REQUIRED_PROXY_DOMAINS, ...(value ?? [])]
  return [...new Set(candidates.map((domain) => domain.trim().toLowerCase().replace(/^\.+|\.+$/g, '')))]
    .filter((domain) => (
      domain.length > 0
      && domain.length <= 253
      && isIP(domain) === 0
      && !isLoopback(domain)
      && domain.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    ))
}

function isDomainGuaranteedProxy(
  domain: string,
  rules: readonly InternalProxyRule[],
  finalAction: InternalProxyRule['action'],
): boolean {
  for (const rule of rules) {
    if (!ruleMatchesDomainWithoutExtraConditions(rule, domain)) continue
    return rule.action === 'proxy'
  }
  return finalAction === 'proxy'
}

function ruleMatchesDomainWithoutExtraConditions(rule: InternalProxyRule, domain: string): boolean {
  if (
    rule.ipCidrs?.length
    || rule.ipIsPrivate !== undefined
    || rule.ports?.length
    || rule.portRanges?.length
    || rule.networks?.length
    || rule.protocols?.length
    || rule.ruleSetTags?.length
  ) return false
  if (isCatchAll(rule)) return true
  let hasDomainMatcher = false
  if (rule.domains?.length) {
    hasDomainMatcher = true
    if (!rule.domains.some((candidate) => candidate.toLowerCase() === domain)) return false
  }
  if (rule.domainSuffixes?.length) {
    hasDomainMatcher = true
    if (!rule.domainSuffixes.some((suffix) => {
      const normalized = suffix.toLowerCase().replace(/^\./, '')
      return domain === normalized || domain.endsWith(`.${normalized}`)
    })) return false
  }
  if (rule.domainKeywords?.length) {
    hasDomainMatcher = true
    if (!rule.domainKeywords.some((keyword) => domain.includes(keyword.toLowerCase()))) return false
  }
  return hasDomainMatcher
}

function validateProfileShape(profile: ParsedBuiltInProxyProfile): void {
  if (!profile || profile.version !== 1 || !Array.isArray(profile.nodes) || !Array.isArray(profile.rules)) {
    throw new BuiltInProxyConfigError('invalid-profile', 'The decrypted proxy profile is invalid.')
  }
  for (const node of profile.nodes) {
    if (!node || typeof node.id !== 'string' || typeof node.name !== 'string' || typeof node.server !== 'string' || !Number.isInteger(node.serverPort) || node.serverPort < 1 || node.serverPort > 65535) {
      throw new BuiltInProxyConfigError('invalid-profile', 'The decrypted proxy profile contains an invalid node.')
    }
  }
}

export function outboundTagForNodeId(nodeId: string): string {
  const suffix = nodeId.replace(/[^A-Za-z0-9_-]/g, '').slice(-32)
  if (!suffix) throw new BuiltInProxyConfigError('invalid-profile', 'The active proxy node identifier is invalid.')
  return `stone-${suffix}`
}

function requireProxyTag(value?: string): string {
  if (!value) throw new BuiltInProxyConfigError('no-active-node', 'The selected profile has no active proxy node.')
  return value
}

function requireCredential(value?: string): string {
  if (!value) throw new BuiltInProxyConfigError('invalid-profile', 'The selected node is missing an encrypted credential.')
  return value
}

function isCatchAll(rule: InternalProxyRule): boolean {
  return Object.keys(rule).every((key) => key === 'action')
}

function isLoopback(address: string): boolean {
  return address === '::1' || address.startsWith('127.')
}

function safeLabel(value: string): string {
  return [...value].map((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127 || '"\'`'.includes(character) ? ' ' : character
  }).join('').trim().slice(0, 64) || 'fallback node'
}
