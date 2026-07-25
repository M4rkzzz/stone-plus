import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import {
  BUILT_IN_PROXY_PROFILE_VERSION,
  type BuiltInProxyImportFormat,
  type BuiltInProxyNodeType,
  type InternalProxyGroup,
  type InternalProxyNode,
  type InternalProxyRule,
  type InternalProxyRuleAction,
  type InternalProxyTlsOptions,
  type InternalProxyTransportOptions,
  type ParsedBuiltInProxyProfile,
  type ProxyRuleDowngrade
} from './profile-types'

const MAX_IMPORT_BYTES = 5 * 1024 * 1024
const MAX_NODES = 2_048
const MAX_RULES = 20_000
const MAX_YAML_DEPTH = 16
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const FORBIDDEN_RUNTIME_KEYS = new Set([
  'plugin', 'plugin-opts', 'plugin_opts', 'script', 'script-path', 'script_path',
  'command', 'executable', 'certificate_path', 'key_path', 'client_certificate_path',
  'client_key_path'
])
const SUPPORTED_SS_METHODS = new Set([
  'none', 'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305',
  'xchacha20-ietf-poly1305', '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm',
  '2022-blake3-chacha20-poly1305'
])

export type BuiltInProxyProfileErrorCode =
  | 'invalid-input'
  | 'input-too-large'
  | 'unsupported-format'
  | 'invalid-config'
  | 'no-supported-nodes'

export class BuiltInProxyProfileError extends Error {
  public readonly code: BuiltInProxyProfileErrorCode

  public constructor(code: BuiltInProxyProfileErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'BuiltInProxyProfileError'
    this.code = code
  }
}

export interface ParseBuiltInProxyProfileOptions {
  profileId?: string
  name?: string
  formatHint?: BuiltInProxyImportFormat
}

type NodeDraft = Omit<InternalProxyNode, 'id'>

interface ParseContext {
  warnings: string[]
}

interface ParsedPayload {
  format: BuiltInProxyImportFormat
  content: string
}

export function parseBuiltInProxyProfile(
  input: string | Buffer,
  options: ParseBuiltInProxyProfileOptions = {}
): ParsedBuiltInProxyProfile {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8')
  if (bytes.byteLength === 0) {
    throw new BuiltInProxyProfileError('invalid-input', 'The imported proxy profile is empty.')
  }
  if (bytes.byteLength > MAX_IMPORT_BYTES) {
    throw new BuiltInProxyProfileError('input-too-large', 'The imported proxy profile exceeds the 5 MiB safety limit.')
  }
  const raw = bytes.toString('utf8').replace(/^\uFEFF/, '').trim()
  if (!raw || raw.includes('\u0000')) {
    throw new BuiltInProxyProfileError('invalid-input', 'The imported proxy profile is not valid text.')
  }

  const payload = detectPayload(raw, options.formatHint)
  const context: ParseContext = { warnings: [] }
  const parsed = payload.format === 'sing-box-json'
    ? parseSingBoxJson(payload.content, context)
    : payload.format === 'clash-meta-yaml'
      ? parseClashYaml(payload.content, context)
      : parseUriList(payload.content, context)

  const nodes = deduplicateNodes(parsed.nodes, context)
  if (nodes.length === 0) {
    throw new BuiltInProxyProfileError(
      'no-supported-nodes',
      'The profile does not contain a supported proxy node.'
    )
  }
  const sourceFingerprint = sha256(raw)
  const profileName = safeName(options.name ?? parsed.name ?? 'Imported proxy profile', 'Imported proxy profile')
  const profileId = validProfileId(options.profileId) ?? `profile-${sourceFingerprint.slice(0, 20)}`
  return {
    version: BUILT_IN_PROXY_PROFILE_VERSION,
    id: profileId,
    name: profileName,
    format: payload.format,
    sourceFingerprint,
    nodes,
    groups: parsed.groups(nodes),
    rules: parsed.downgrade ? [] : parsed.rules,
    ruleStatus: parsed.downgrade ? 'fallback' : 'preserved',
    ...(parsed.downgrade ? { ruleDowngrade: parsed.downgrade } : {}),
    warnings: [...new Set(context.warnings)].slice(0, 100)
  }
}

interface FormatParseResult {
  name?: string
  nodes: NodeDraft[]
  groups: (nodes: InternalProxyNode[]) => InternalProxyGroup[]
  rules: InternalProxyRule[]
  downgrade?: ProxyRuleDowngrade
}

function detectPayload(raw: string, hint?: BuiltInProxyImportFormat): ParsedPayload {
  const decoded = maybeDecodeSubscriptionBase64(raw)
  const content = decoded ?? raw
  if (hint) {
    if (hint === 'sing-box-json' && !content.trimStart().startsWith('{')) {
      throw new BuiltInProxyProfileError('invalid-config', 'The selected sing-box import is not a JSON object.')
    }
    return { format: hint, content }
  }
  if (content.trimStart().startsWith('{')) return { format: 'sing-box-json', content }
  if (/^\s*(?:proxies|proxy-groups|rules)\s*:/m.test(content)) {
    return { format: 'clash-meta-yaml', content }
  }
  if (/(?:^|\n)\s*(?:ss|vmess|vless|trojan|hysteria2|hy2|tuic|socks5?|https?):\/\//i.test(content)) {
    return { format: 'uri-list', content }
  }
  throw new BuiltInProxyProfileError('unsupported-format', 'The proxy profile format is not supported.')
}

function maybeDecodeSubscriptionBase64(raw: string): string | undefined {
  const compact = raw.replace(/\s+/g, '')
  if (compact.includes('://') || compact.length < 8 || !/^[A-Za-z0-9+/_=-]+$/.test(compact)) return undefined
  try {
    const decoded = Buffer.from(compact.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    if (decoded.includes('\uFFFD') || decoded.includes('\u0000')) return undefined
    return /(?:^\s*\{|^\s*(?:proxies|proxy-groups|rules)\s*:|(?:^|\n)\s*\w+:\/\/)/m.test(decoded)
      ? decoded.trim()
      : undefined
  } catch {
    return undefined
  }
}

function parseSingBoxJson(content: string, context: ParseContext): FormatParseResult {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch (error) {
    throw new BuiltInProxyProfileError('invalid-config', 'The sing-box profile is not valid JSON.', { cause: error })
  }
  const root = recordValue(value, 'The sing-box profile must be a JSON object.')
  if (Array.isArray(root.inbounds)) context.warnings.push('Imported inbounds were ignored; Stone+ owns all local listeners.')
  if (root.experimental !== undefined) context.warnings.push('Imported controller and experimental settings were ignored.')
  if (root.endpoints !== undefined || root.services !== undefined) {
    context.warnings.push('Imported endpoint and service definitions were ignored.')
  }
  const outboundValues = arrayValue(root.outbounds)
  if (outboundValues.length > MAX_NODES * 2) {
    throw new BuiltInProxyProfileError('invalid-config', 'The sing-box profile contains too many outbounds.')
  }
  const nodes: NodeDraft[] = []
  const tagToDraft = new Map<string, NodeDraft>()
  const directTags = new Set(['direct'])
  const blockTags = new Set(['block', 'reject'])
  const groupRecords: Array<{ tag: string; type: string; members: string[] }> = []
  outboundValues.forEach((entry, index) => {
    if (!isRecord(entry)) return
    const type = optionalString(entry.type)?.toLowerCase()
    const tag = safeName(optionalString(entry.tag) ?? `outbound-${index + 1}`, `outbound-${index + 1}`)
    if (type === 'direct') { directTags.add(tag.toLowerCase()); return }
    if (type === 'block') { blockTags.add(tag.toLowerCase()); return }
    if (type === 'selector' || type === 'urltest') {
      groupRecords.push({ tag, type, members: stringArray(entry.outbounds) })
      return
    }
    if (!type) return
    try {
      const node = parseSingBoxNode(entry, type, tag)
      if (node) {
        nodes.push(node)
        tagToDraft.set(tag, node)
      } else {
        context.warnings.push(`Unsupported sing-box outbound type "${safeLogLabel(type)}" was ignored.`)
      }
    } catch {
      context.warnings.push(`Invalid or unsafe sing-box node "${safeLogLabel(tag)}" was ignored.`)
    }
  })
  const groupNames = new Set(groupRecords.map((group) => group.tag.toLowerCase()))
  const knownProxyTargets = new Set([...tagToDraft.keys(), ...groupRecords.map((group) => group.tag)].map((tag) => tag.toLowerCase()))
  const rulesResult = parseSingBoxRules(root.route, knownProxyTargets, directTags, blockTags)
  return {
    nodes,
    groups: (finalNodes) => buildGroups(groupRecords, tagToDraft, finalNodes),
    rules: rulesResult.rules,
    downgrade: rulesResult.downgrade ?? (groupNames.size > 0 && nodes.length === 0
      ? downgrade('missing-targets', 1, 'Imported groups do not reference a supported node; built-in safe rules will be used.')
      : undefined)
  }
}

function parseSingBoxNode(entry: Record<string, unknown>, type: string, name: string): NodeDraft | undefined {
  if (!isSupportedNodeType(type)) return undefined
  if (hasForbiddenRuntimeValue(entry)) throw new Error('unsafe runtime field')
  const server = requiredHost(entry.server)
  const serverPort = requiredPort(entry.server_port ?? entry.port)
  const base = {
    name,
    type,
    server,
    serverPort,
    credentials: {},
    tls: parseSingTls(entry.tls),
    transport: parseSingTransport(entry.transport),
    udp: optionalBoolean(entry.udp)
  } satisfies NodeDraft
  if (type === 'shadowsocks') {
    const method = requiredString(entry.method, 128).toLowerCase()
    if (!SUPPORTED_SS_METHODS.has(method)) throw new Error('unsupported cipher')
    return { ...base, credentials: { method, password: requiredSecret(entry.password) } }
  }
  if (type === 'vmess') {
    return {
      ...base,
      credentials: { uuid: requiredUuid(entry.uuid) },
      security: optionalString(entry.security)?.toLowerCase() ?? 'auto',
      alterId: boundedInteger(entry.alter_id, 0, 65535) ?? 0,
      packetEncoding: packetEncoding(entry.packet_encoding)
    }
  }
  if (type === 'vless') {
    return {
      ...base,
      credentials: { uuid: requiredUuid(entry.uuid) },
      flow: optionalSafeToken(entry.flow, 128),
      packetEncoding: packetEncoding(entry.packet_encoding)
    }
  }
  if (type === 'trojan') return { ...base, credentials: { password: requiredSecret(entry.password) } }
  if (type === 'hysteria2') {
    return {
      ...base,
      credentials: { password: requiredSecret(entry.password) },
      upMbps: positiveNumber(entry.up_mbps),
      downMbps: positiveNumber(entry.down_mbps),
      obfs: parseHysteriaObfs(entry.obfs)
    }
  }
  if (type === 'tuic') {
    return {
      ...base,
      credentials: { uuid: requiredUuid(entry.uuid), password: requiredSecret(entry.password) },
      congestionControl: optionalSafeToken(entry.congestion_control, 64),
      udpRelayMode: optionalSafeToken(entry.udp_relay_mode, 64)
    }
  }
  if (type === 'http') {
    return {
      ...base,
      credentials: {
        username: optionalSecret(entry.username),
        password: optionalSecret(entry.password)
      }
    }
  }
  return {
    ...base,
    credentials: {
      username: optionalSecret(entry.username),
      password: optionalSecret(entry.password)
    }
  }
}

function parseSingTls(value: unknown): InternalProxyTlsOptions | undefined {
  if (!isRecord(value) || value.enabled !== true) return undefined
  const tls: InternalProxyTlsOptions = {
    enabled: true,
    serverName: optionalHost(value.server_name),
    insecure: optionalBoolean(value.insecure),
    alpn: safeStringArray(value.alpn, 16, 64)
  }
  if (isRecord(value.utls) && value.utls.enabled === true) {
    tls.utlsFingerprint = optionalSafeToken(value.utls.fingerprint, 64) ?? 'chrome'
  }
  if (isRecord(value.reality) && value.reality.enabled === true) {
    tls.reality = {
      publicKey: requiredString(value.reality.public_key, 512),
      shortId: optionalSafeToken(value.reality.short_id, 128)
    }
  }
  return tls
}

function parseSingTransport(value: unknown): InternalProxyTransportOptions | undefined {
  if (!isRecord(value)) return undefined
  const type = optionalString(value.type)?.toLowerCase()
  if (type === undefined || type === 'tcp') return undefined
  if (!['ws', 'grpc', 'http', 'httpupgrade'].includes(type)) throw new Error('unsupported transport')
  const result: InternalProxyTransportOptions = { type: type as InternalProxyTransportOptions['type'] }
  if (type === 'ws' || type === 'http' || type === 'httpupgrade') {
    result.path = optionalPath(value.path)
    result.headers = safeHeaders(value.headers)
  }
  if (type === 'grpc') result.serviceName = optionalString(value.service_name)?.slice(0, 512)
  if (type === 'http') {
    result.host = safeStringArray(value.host, 16, 253)?.map(requiredHost)
    result.method = optionalSafeToken(value.method, 16)?.toUpperCase()
  }
  return result
}

function parseSingBoxRules(
  routeValue: unknown,
  proxyTargets: ReadonlySet<string>,
  directTags: ReadonlySet<string>,
  blockTags: ReadonlySet<string>
): { rules: InternalProxyRule[]; downgrade?: ProxyRuleDowngrade } {
  if (!isRecord(routeValue) || !Array.isArray(routeValue.rules) || routeValue.rules.length === 0) {
    return { rules: [], downgrade: downgrade('no-rules', 0, 'No safely convertible rules were found; built-in safe rules will be used.') }
  }
  const importedRules: unknown[] = routeValue.rules
  if (importedRules.length > MAX_RULES) {
    return { rules: [], downgrade: downgrade('unsupported-rules', importedRules.length, 'The imported rule set is too large; built-in safe rules will be used.') }
  }
  const rules: InternalProxyRule[] = []
  let unsupported = 0
  importedRules.forEach((value, index) => {
    const converted = isRecord(value)
      ? convertSingRule(value, proxyTargets, directTags, blockTags)
      : undefined
    if (!converted || (isCatchAll(converted) && index !== importedRules.length - 1)) unsupported += 1
    else rules.push(converted)
  })
  if (unsupported > 0 || rules.length === 0) {
    return { rules: [], downgrade: downgrade('unsupported-rules', unsupported || 1, 'Some imported rules are unsafe or unsupported; built-in safe rules will be used instead.') }
  }
  return { rules }
}

const SING_RULE_KEYS = new Set([
  'action', 'outbound', 'domain', 'domain_suffix', 'domain_keyword', 'ip_cidr',
  'ip_is_private', 'port', 'port_range', 'network', 'protocol'
])

function convertSingRule(
  value: Record<string, unknown>,
  proxyTargets: ReadonlySet<string>,
  directTags: ReadonlySet<string>,
  blockTags: ReadonlySet<string>
): InternalProxyRule | undefined {
  if (Object.keys(value).some((key) => !SING_RULE_KEYS.has(key))) return undefined
  const importedAction = optionalString(value.action)?.toLowerCase()
  const target = optionalString(value.outbound)?.toLowerCase()
  let action: InternalProxyRuleAction | undefined
  if (importedAction === 'reject' || (target && blockTags.has(target))) action = 'block'
  else if (target && directTags.has(target)) action = 'direct'
  else if (target && proxyTargets.has(target)) action = 'proxy'
  else if (importedAction === 'route' && !target) return undefined
  if (!action) return undefined
  try {
    return cleanRule({
      domains: safeDomains(value.domain, false),
      domainSuffixes: safeDomains(value.domain_suffix, true),
      domainKeywords: safeKeywords(value.domain_keyword),
      ipCidrs: safeCidrs(value.ip_cidr),
      ipIsPrivate: optionalBoolean(value.ip_is_private),
      ports: safePorts(value.port),
      portRanges: safePortRanges(value.port_range),
      networks: safeNetworks(value.network),
      protocols: safeProtocols(value.protocol),
      action
    })
  } catch {
    return undefined
  }
}

function parseClashYaml(content: string, context: ParseContext): FormatParseResult {
  let root: Record<string, unknown>
  try {
    root = recordValue(parseYamlSubset(content), 'The Clash Meta profile must be a mapping.')
  } catch (error) {
    throw new BuiltInProxyProfileError('invalid-config', 'The Clash Meta profile uses invalid or unsupported YAML.', { cause: error })
  }
  for (const key of ['listeners', 'tun', 'script', 'external-controller', 'external-ui']) {
    if (root[key] !== undefined) context.warnings.push(`Imported Clash setting "${key}" was ignored.`)
  }
  if (root['proxy-providers'] !== undefined || root['rule-providers'] !== undefined) {
    context.warnings.push('External Clash providers were not imported or executed.')
  }
  const proxyValues = arrayValue(root.proxies)
  if (proxyValues.length > MAX_NODES) throw new BuiltInProxyProfileError('invalid-config', 'The Clash profile contains too many nodes.')
  const nodes: NodeDraft[] = []
  const nameToDraft = new Map<string, NodeDraft>()
  proxyValues.forEach((value, index) => {
    if (!isRecord(value)) return
    const name = safeName(optionalString(value.name) ?? `proxy-${index + 1}`, `proxy-${index + 1}`)
    try {
      const node = parseClashNode(value, name)
      if (node) { nodes.push(node); nameToDraft.set(name, node) }
      else context.warnings.push(`Unsupported Clash node "${safeLogLabel(name)}" was ignored.`)
    } catch {
      context.warnings.push(`Invalid or unsafe Clash node "${safeLogLabel(name)}" was ignored.`)
    }
  })
  const groupValues = arrayValue(root['proxy-groups'])
  const groupRecords: Array<{ tag: string; type: string; members: string[] }> = []
  groupValues.forEach((value) => {
    if (!isRecord(value)) return
    const name = optionalString(value.name)
    const type = optionalString(value.type)?.toLowerCase()
    if (!name || !type || !['select', 'url-test', 'fallback', 'load-balance'].includes(type)) return
    if (arrayValue(value.use).length > 0) context.warnings.push(`Provider-backed group "${safeLogLabel(name)}" was imported without its external provider.`)
    groupRecords.push({ tag: safeName(name, 'Proxy group'), type, members: stringArray(value.proxies) })
  })
  const proxyTargets = new Set([...nameToDraft.keys(), ...groupRecords.map((group) => group.tag)].map((name) => name.toLowerCase()))
  const rulesResult = parseClashRules(root.rules, proxyTargets)
  return {
    name: optionalString(root.name),
    nodes,
    groups: (finalNodes) => buildGroups(groupRecords, nameToDraft, finalNodes),
    rules: rulesResult.rules,
    downgrade: rulesResult.downgrade
  }
}

function parseClashNode(value: Record<string, unknown>, name: string): NodeDraft | undefined {
  const clashType = optionalString(value.type)?.toLowerCase()
  const type = clashType === 'ss' ? 'shadowsocks'
    : clashType === 'socks5' ? 'socks'
      : clashType === 'hy2' ? 'hysteria2'
        : clashType
  if (!type || !isSupportedNodeType(type)) return undefined
  if (hasForbiddenRuntimeValue(value)) throw new Error('unsafe runtime field')
  const base = {
    name,
    type,
    server: requiredHost(value.server),
    serverPort: requiredPort(value.port),
    credentials: {},
    tls: parseClashTls(value),
    transport: parseClashTransport(value),
    udp: optionalBoolean(value.udp)
  } satisfies NodeDraft
  if (type === 'shadowsocks') {
    const method = requiredString(value.cipher, 128).toLowerCase()
    if (!SUPPORTED_SS_METHODS.has(method)) throw new Error('unsupported cipher')
    return { ...base, credentials: { method, password: requiredSecret(value.password) } }
  }
  if (type === 'vmess') return { ...base, credentials: { uuid: requiredUuid(value.uuid) }, security: optionalString(value.cipher) ?? 'auto', alterId: boundedInteger(value.alterId ?? value['alter-id'], 0, 65535) ?? 0 }
  if (type === 'vless') return { ...base, credentials: { uuid: requiredUuid(value.uuid) }, flow: optionalSafeToken(value.flow, 128) }
  if (type === 'trojan') return { ...base, credentials: { password: requiredSecret(value.password) } }
  if (type === 'hysteria2') return { ...base, credentials: { password: requiredSecret(value.password ?? value.auth) }, upMbps: positiveNumber(value.up), downMbps: positiveNumber(value.down), obfs: clashHysteriaObfs(value) }
  if (type === 'tuic') return { ...base, credentials: { uuid: requiredUuid(value.uuid), password: requiredSecret(value.password ?? value.token) }, congestionControl: optionalSafeToken(value['congestion-controller'] ?? value.congestion_control, 64), udpRelayMode: optionalSafeToken(value['udp-relay-mode'] ?? value.udp_relay_mode, 64) }
  return { ...base, credentials: { username: optionalSecret(value.username), password: optionalSecret(value.password) } }
}

function parseClashTls(value: Record<string, unknown>): InternalProxyTlsOptions | undefined {
  const security = optionalString(value.security)?.toLowerCase()
  const enabled = value.tls === true || security === 'tls' || security === 'reality' || value.type === 'trojan' || value.type === 'hysteria2' || value.type === 'hy2' || value.type === 'tuic'
  if (!enabled) return undefined
  const result: InternalProxyTlsOptions = {
    enabled: true,
    serverName: optionalHost(value.servername ?? value.sni),
    insecure: optionalBoolean(value['skip-cert-verify'] ?? value.insecure),
    alpn: safeStringArray(value.alpn, 16, 64),
    utlsFingerprint: optionalSafeToken(value['client-fingerprint'] ?? value.fingerprint, 64)
  }
  const reality = value['reality-opts']
  if (security === 'reality' && isRecord(reality)) {
    result.reality = {
      publicKey: requiredString(reality['public-key'] ?? reality.public_key, 512),
      shortId: optionalSafeToken(reality['short-id'] ?? reality.short_id, 128)
    }
  }
  return result
}

function parseClashTransport(value: Record<string, unknown>): InternalProxyTransportOptions | undefined {
  const network = optionalString(value.network)?.toLowerCase()
  if (!network || network === 'tcp') return undefined
  if (!['ws', 'grpc', 'http', 'h2', 'httpupgrade'].includes(network)) throw new Error('unsupported transport')
  if (network === 'ws') {
    const opts = isRecord(value['ws-opts']) ? value['ws-opts'] : {}
    return { type: 'ws', path: optionalPath(opts.path), headers: safeHeaders(opts.headers) }
  }
  if (network === 'grpc') {
    const opts = isRecord(value['grpc-opts']) ? value['grpc-opts'] : {}
    return { type: 'grpc', serviceName: optionalString(opts['grpc-service-name'] ?? opts.service_name)?.slice(0, 512) }
  }
  if (network === 'httpupgrade') {
    const opts = isRecord(value['httpupgrade-opts']) ? value['httpupgrade-opts'] : {}
    return { type: 'httpupgrade', path: optionalPath(opts.path), headers: safeHeaders(opts.headers) }
  }
  const opts = isRecord(value['h2-opts']) ? value['h2-opts'] : {}
  return { type: 'http', path: optionalPath(opts.path), host: safeStringArray(opts.host, 16, 253)?.map(requiredHost) }
}

function parseClashRules(value: unknown, proxyTargets: ReadonlySet<string>): { rules: InternalProxyRule[]; downgrade?: ProxyRuleDowngrade } {
  const values = arrayValue(value)
  if (values.length === 0) return { rules: [], downgrade: downgrade('no-rules', 0, 'No Clash rules were found; built-in safe rules will be used.') }
  if (values.length > MAX_RULES) return { rules: [], downgrade: downgrade('unsupported-rules', values.length, 'The imported rule set is too large; built-in safe rules will be used.') }
  const rules: InternalProxyRule[] = []
  let unsupported = 0
  values.forEach((entry, index) => {
    const rule = typeof entry === 'string' ? convertClashRule(entry, proxyTargets) : undefined
    if (!rule || (isCatchAll(rule) && index !== values.length - 1)) unsupported += 1
    else rules.push(rule)
  })
  if (unsupported > 0 || rules.length === 0) return { rules: [], downgrade: downgrade('unsupported-rules', unsupported || 1, 'Some Clash rules are unsafe or unsupported; built-in safe rules will be used instead.') }
  return { rules }
}

function convertClashRule(raw: string, proxyTargets: ReadonlySet<string>): InternalProxyRule | undefined {
  const parts = raw.split(',').map((part) => part.trim())
  const type = parts[0]?.toUpperCase()
  const catchAll = type === 'MATCH' || type === 'FINAL'
  const target = parts[catchAll ? 1 : 2]
  if (!type || !target) return undefined
  const action = clashAction(target, proxyTargets)
  if (!action) return undefined
  try {
    if (catchAll) return { action }
    const payload = parts[1]
    if (!payload) return undefined
    if (type === 'DOMAIN') return { domains: safeDomains(payload, false), action }
    if (type === 'DOMAIN-SUFFIX') return { domainSuffixes: safeDomains(payload, true), action }
    if (type === 'DOMAIN-KEYWORD') return { domainKeywords: safeKeywords(payload), action }
    if (type === 'IP-CIDR' || type === 'IP-CIDR6') return { ipCidrs: safeCidrs(payload), action }
    if (type === 'GEOIP' && payload.toUpperCase() === 'CN') return { ruleSetTags: ['geoip-cn'], action }
    if (type === 'GEOSITE' && payload.toUpperCase() === 'CN') return { ruleSetTags: ['geosite-cn'], action }
    if (type === 'DST-PORT') return { ports: safePorts(payload), action }
    if (type === 'NETWORK' && ['TCP', 'UDP'].includes(payload.toUpperCase())) return { networks: [payload.toLowerCase() as 'tcp' | 'udp'], action }
    return undefined
  } catch {
    return undefined
  }
}

function clashAction(target: string, proxyTargets: ReadonlySet<string>): InternalProxyRuleAction | undefined {
  const normalized = target.toLowerCase()
  if (normalized === 'direct') return 'direct'
  if (normalized === 'reject' || normalized === 'reject-drop') return 'block'
  if (proxyTargets.has(normalized)) return 'proxy'
  return undefined
}

function parseUriList(content: string, context: ParseContext): FormatParseResult {
  const nodes: NodeDraft[] = []
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
  if (lines.length > MAX_NODES) throw new BuiltInProxyProfileError('invalid-config', 'The URI subscription contains too many nodes.')
  lines.forEach((line, index) => {
    try {
      const node = parseProxyUri(line, index)
      if (node) nodes.push(node)
      else context.warnings.push(`Unsupported proxy URI at line ${index + 1} was ignored.`)
    } catch {
      context.warnings.push(`Invalid or unsafe proxy URI at line ${index + 1} was ignored.`)
    }
  })
  return {
    nodes,
    groups: (finalNodes) => finalNodes.length === 0 ? [] : [{ id: stableGroupId('All nodes'), name: 'All nodes', type: 'selector', nodeIds: finalNodes.map((node) => node.id) }],
    rules: [],
    downgrade: downgrade('no-rules', 0, 'URI subscriptions do not include safely convertible rules; built-in safe rules will be used.')
  }
}

function parseProxyUri(raw: string, index: number): NodeDraft | undefined {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw)?.[1]?.toLowerCase()
  if (!scheme) return undefined
  if (scheme === 'ss') return parseShadowsocksUri(raw, index)
  if (scheme === 'vmess') return parseVmessUri(raw, index)
  if (['vless', 'trojan', 'hysteria2', 'hy2', 'tuic', 'socks', 'socks5', 'http', 'https'].includes(scheme)) return parseStandardUri(raw, scheme, index)
  return undefined
}

function parseShadowsocksUri(raw: string, index: number): NodeDraft {
  let expanded = raw
  const withoutScheme = raw.slice(5)
  const beforeFragment = withoutScheme.split('#', 1)[0]
  if (!beforeFragment.includes('@')) {
    const decoded = decodeBase64Text(beforeFragment)
    if (!decoded.includes('@')) throw new Error('invalid ss payload')
    expanded = `ss://${decoded}${raw.includes('#') ? `#${raw.split('#').slice(1).join('#')}` : ''}`
  }
  const url = new URL(expanded)
  if (url.searchParams.has('plugin')) throw new Error('plugins are not imported')
  let method = decodeUriPart(url.username)
  let password = decodeUriPart(url.password)
  if (!password && method) {
    const decoded = decodeBase64Text(method)
    const delimiter = decoded.indexOf(':')
    if (delimiter < 1) throw new Error('missing credentials')
    method = decoded.slice(0, delimiter)
    password = decoded.slice(delimiter + 1)
  }
  method = method.toLowerCase()
  if (!SUPPORTED_SS_METHODS.has(method)) throw new Error('unsupported cipher')
  const server = requiredHost(url.hostname)
  const serverPort = requiredPort(url.port)
  return { name: uriName(url, `Shadowsocks ${index + 1}`), type: 'shadowsocks', server, serverPort, credentials: { method, password: requiredSecret(password) } }
}

function parseVmessUri(raw: string, index: number): NodeDraft {
  const body = raw.slice('vmess://'.length)
  if (!body.includes('@')) {
    const json = recordValue(JSON.parse(decodeBase64Text(body.split('#', 1)[0])), 'invalid vmess json')
    const network = optionalString(json.net)?.toLowerCase()
    const tlsEnabled = optionalString(json.tls)?.toLowerCase() === 'tls' || optionalString(json.security)?.toLowerCase() === 'tls'
    const transport = network && network !== 'tcp' ? parseClashTransport({
      network,
      'ws-opts': { path: json.path, headers: { Host: json.host } },
      'grpc-opts': { 'grpc-service-name': json.path }
    }) : undefined
    return {
      name: safeName(optionalString(json.ps) ?? `VMess ${index + 1}`, `VMess ${index + 1}`),
      type: 'vmess', server: requiredHost(json.add), serverPort: requiredPort(json.port),
      credentials: { uuid: requiredUuid(json.id) }, security: optionalString(json.scy) ?? 'auto',
      alterId: boundedInteger(json.aid, 0, 65535) ?? 0, transport,
      tls: tlsEnabled ? { enabled: true, serverName: optionalHost(json.sni ?? json.host), alpn: csvStrings(json.alpn), utlsFingerprint: optionalSafeToken(json.fp, 64) } : undefined
    }
  }
  return parseStandardUri(raw, 'vmess', index)
}

function parseStandardUri(raw: string, scheme: string, index: number): NodeDraft {
  const url = new URL(raw)
  const server = requiredHost(url.hostname)
  const serverPort = requiredPort(url.port || defaultUriPort(scheme))
  const query = url.searchParams
  const name = uriName(url, `${scheme.toUpperCase()} ${index + 1}`)
  if (scheme === 'vless' || scheme === 'vmess') {
    return {
      name, type: scheme, server, serverPort, credentials: { uuid: requiredUuid(decodeUriPart(url.username)) },
      flow: scheme === 'vless' ? optionalSafeToken(query.get('flow'), 128) : undefined,
      security: scheme === 'vmess' ? (query.get('encryption') ?? query.get('security') ?? 'auto') : undefined,
      transport: transportFromUri(query), tls: tlsFromUri(query)
    }
  }
  if (scheme === 'trojan') return { name, type: 'trojan', server, serverPort, credentials: { password: requiredSecret(decodeUriPart(url.username)) }, transport: transportFromUri(query), tls: tlsFromUri(query, true) }
  if (scheme === 'hysteria2' || scheme === 'hy2') return { name, type: 'hysteria2', server, serverPort, credentials: { password: requiredSecret(decodeUriPart(url.password || url.username)) }, tls: tlsFromUri(query, true), obfs: query.get('obfs') === 'salamander' ? { type: 'salamander', password: requiredSecret(query.get('obfs-password')) } : undefined }
  if (scheme === 'tuic') return { name, type: 'tuic', server, serverPort, credentials: { uuid: requiredUuid(decodeUriPart(url.username)), password: requiredSecret(decodeUriPart(url.password)) }, tls: tlsFromUri(query, true), congestionControl: optionalSafeToken(query.get('congestion_control'), 64), udpRelayMode: optionalSafeToken(query.get('udp_relay_mode'), 64) }
  const type: BuiltInProxyNodeType = scheme.startsWith('socks') ? 'socks' : 'http'
  return { name, type, server, serverPort, credentials: { username: optionalSecret(decodeUriPart(url.username)), password: optionalSecret(decodeUriPart(url.password)) }, tls: scheme === 'https' ? tlsFromUri(query, true) : undefined }
}

function transportFromUri(query: URLSearchParams): InternalProxyTransportOptions | undefined {
  const type = (query.get('type') ?? 'tcp').toLowerCase()
  if (type === 'tcp') return undefined
  if (!['ws', 'grpc', 'http', 'httpupgrade'].includes(type)) throw new Error('unsupported transport')
  if (type === 'grpc') return { type, serviceName: (query.get('serviceName') ?? query.get('service_name') ?? '').slice(0, 512) || undefined }
  const host = query.get('host')
  return { type: type as InternalProxyTransportOptions['type'], path: optionalPath(query.get('path')), headers: host ? { Host: requiredHost(host) } : undefined }
}

function tlsFromUri(query: URLSearchParams, defaultEnabled = false): InternalProxyTlsOptions | undefined {
  const security = (query.get('security') ?? '').toLowerCase()
  const enabled = defaultEnabled || security === 'tls' || security === 'reality' || query.get('tls') === '1'
  if (!enabled) return undefined
  const result: InternalProxyTlsOptions = {
    enabled: true,
    serverName: optionalHost(query.get('sni') ?? query.get('peer')),
    insecure: ['1', 'true'].includes((query.get('allowInsecure') ?? query.get('insecure') ?? '').toLowerCase()),
    alpn: csvStrings(query.get('alpn')),
    utlsFingerprint: optionalSafeToken(query.get('fp'), 64)
  }
  if (security === 'reality') result.reality = { publicKey: requiredString(query.get('pbk'), 512), shortId: optionalSafeToken(query.get('sid'), 128) }
  return result
}

function buildGroups(
  records: Array<{ tag: string; type: string; members: string[] }>,
  names: ReadonlyMap<string, NodeDraft>,
  nodes: InternalProxyNode[]
): InternalProxyGroup[] {
  const draftToId = new Map<NodeDraft, string>()
  nodes.forEach((node) => {
    const draft = [...names.values()].find((candidate) => stableNodeId(candidate) === node.id)
    if (draft) draftToId.set(draft, node.id)
  })
  const recordMap = new Map(records.map((record) => [record.tag.toLowerCase(), record]))
  const resolve = (name: string, seen: Set<string>): string[] => {
    const direct = [...names.entries()].find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
    if (direct) return draftToId.get(direct) ? [draftToId.get(direct)!] : []
    const key = name.toLowerCase()
    if (seen.has(key)) return []
    const group = recordMap.get(key)
    if (!group) return []
    const next = new Set(seen).add(key)
    return group.members.flatMap((member) => resolve(member, next))
  }
  return records.map((record): InternalProxyGroup => ({
    id: stableGroupId(record.tag),
    name: record.tag,
    type: record.type === 'urltest' || record.type === 'url-test' ? 'urltest'
      : record.type === 'fallback' ? 'fallback'
        : record.type === 'load-balance' ? 'load-balance' : 'selector',
    nodeIds: [...new Set(record.members.flatMap((member) => resolve(member, new Set([record.tag.toLowerCase()]))))]
  })).filter((group) => group.nodeIds.length > 0)
}

function deduplicateNodes(drafts: NodeDraft[], context: ParseContext): InternalProxyNode[] {
  const seen = new Set<string>()
  const nodes: InternalProxyNode[] = []
  for (const draft of drafts) {
    const id = stableNodeId(draft)
    if (seen.has(id)) { context.warnings.push('A duplicate proxy node was ignored.'); continue }
    seen.add(id)
    nodes.push({ id, ...draft })
  }
  return nodes
}

export function stableNodeId(node: NodeDraft | InternalProxyNode): string {
  const { name: _name, ...identity } = node
  return `node-${sha256(stableStringify(identity)).slice(0, 24)}`
}

function stableGroupId(name: string): string {
  return `group-${sha256(name.trim().toLowerCase()).slice(0, 20)}`
}

function downgrade(code: ProxyRuleDowngrade['code'], unsupportedCount: number, message: string): ProxyRuleDowngrade {
  return { code, unsupportedCount, message }
}

function cleanRule(rule: InternalProxyRule): InternalProxyRule {
  return Object.fromEntries(Object.entries(rule).filter(([, value]) => value !== undefined && (!Array.isArray(value) || value.length > 0))) as unknown as InternalProxyRule
}

function isCatchAll(rule: InternalProxyRule): boolean {
  return Object.keys(rule).every((key) => key === 'action')
}

function isSupportedNodeType(type: string): type is BuiltInProxyNodeType {
  return ['shadowsocks', 'vmess', 'vless', 'trojan', 'hysteria2', 'tuic', 'http', 'socks'].includes(type)
}

function hasForbiddenRuntimeValue(value: unknown, depth = 0): boolean {
  if (depth > 12) return true
  if (Array.isArray(value)) return value.some((item) => hasForbiddenRuntimeValue(item, depth + 1))
  if (!isRecord(value)) return false
  return Object.entries(value).some(([key, child]) => FORBIDDEN_RUNTIME_KEYS.has(key.toLowerCase()) || hasForbiddenRuntimeValue(child, depth + 1))
}

function parseHysteriaObfs(value: unknown): InternalProxyNode['obfs'] {
  if (!isRecord(value) || value.type !== 'salamander') return undefined
  return { type: 'salamander', password: requiredSecret(value.password) }
}

function clashHysteriaObfs(value: Record<string, unknown>): InternalProxyNode['obfs'] {
  return value.obfs === 'salamander' ? { type: 'salamander', password: requiredSecret(value['obfs-password']) } : undefined
}

function packetEncoding(value: unknown): InternalProxyNode['packetEncoding'] {
  return value === 'packetaddr' || value === 'xudp' ? value : undefined
}

function requiredHost(value: unknown): string {
  const host = requiredString(value, 253).replace(/^\[|\]$/g, '').toLowerCase()
  if (/[/\\\s]/.test(host) || hasAnyAsciiControl(host) || host === '0.0.0.0' || host === '::') throw new Error('invalid host')
  if (isIP(host)) return host
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/i.test(host)) throw new Error('invalid host')
  return host
}

function optionalHost(value: unknown): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : requiredHost(value)
}

function requiredPort(value: unknown): number {
  const port = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('invalid port')
  return Number(port)
}

function requiredString(value: unknown, max: number): string {
  if (typeof value !== 'string') throw new Error('missing string')
  const result = value.trim()
  if (!result || result.length > max || hasDisallowedAsciiControl(result)) throw new Error('invalid string')
  return result
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined
}

function requiredSecret(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || value.includes('\u0000')) throw new Error('invalid credential')
  return value
}

function optionalSecret(value: unknown): string | undefined {
  return value === undefined || value === null || value === '' ? undefined : requiredSecret(value)
}

function requiredUuid(value: unknown): string {
  const uuid = requiredString(value, 128).toLowerCase()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) throw new Error('invalid UUID')
  return uuid
}

function safeName(value: string, fallback: string): string {
  const result = replaceAsciiControls(value).trim().replace(/\s+/g, ' ')
  return result.slice(0, 128) || fallback
}

function safeLogLabel(value: string): string {
  return safeName(value, 'unnamed').replace(/["'`]/g, '').slice(0, 64)
}

function optionalSafeToken(value: unknown, max: number): string | undefined {
  const token = optionalString(value)
  if (!token) return undefined
  if (token.length > max || !/^[A-Za-z0-9._:+/-]+$/.test(token)) throw new Error('invalid token')
  return token
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function boundedInteger(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  if (!Number.isInteger(number) || Number(number) < min || Number(number) > max) throw new Error('invalid integer')
  return Number(number)
}

function positiveNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0 || number > 1_000_000) throw new Error('invalid number')
  return number
}

function safeHeaders(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const headers: Record<string, string> = {}
  const entries = Object.entries(value)
  if (entries.length > 32) throw new Error('too many headers')
  for (const [name, raw] of entries) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) || (typeof raw !== 'string' && typeof raw !== 'number')) throw new Error('invalid header')
    const header = String(raw)
    if (header.length > 2048 || header.includes('\r') || header.includes('\n') || header.includes('\u0000')) throw new Error('invalid header')
    headers[name] = header
  }
  return Object.keys(headers).length ? headers : undefined
}

function optionalPath(value: unknown): string | undefined {
  const path = optionalString(value)
  if (!path) return undefined
  if (path.length > 2048 || path.includes('\r') || path.includes('\n') || path.includes('\u0000') || !path.startsWith('/')) throw new Error('invalid transport path')
  return path
}

function safeDomains(value: unknown, allowLeadingDot: boolean): string[] | undefined {
  const values = scalarOrStringArray(value)
  if (!values) return undefined
  return values.map((domain) => {
    const normalized = domain.toLowerCase().replace(allowLeadingDot ? /^\./ : /$^/, '')
    if (isIP(normalized) || !/^(?=.{1,253}$)(?:[a-z0-9*](?:[a-z0-9_*-]{0,61}[a-z0-9*])?\.)*[a-z0-9*](?:[a-z0-9_*-]{0,61}[a-z0-9*])?$/i.test(normalized)) throw new Error('invalid domain')
    return normalized
  })
}

function safeKeywords(value: unknown): string[] | undefined {
  const values = scalarOrStringArray(value)
  if (!values) return undefined
  return values.map((entry) => {
    if (!entry || entry.length > 128 || hasAnyAsciiControl(entry)) throw new Error('invalid keyword')
    return entry
  })
}

function safeCidrs(value: unknown): string[] | undefined {
  const values = scalarOrStringArray(value)
  if (!values) return undefined
  return values.map((cidr) => {
    const [address, prefix, extra] = cidr.split('/')
    const version = isIP(address)
    const bits = prefix === undefined ? (version === 4 ? 32 : 128) : Number(prefix)
    if (!version || extra !== undefined || !Number.isInteger(bits) || bits < 0 || bits > (version === 4 ? 32 : 128)) throw new Error('invalid cidr')
    return `${address}/${bits}`
  })
}

function safePorts(value: unknown): number[] | undefined {
  if (value === undefined) return undefined
  const values = Array.isArray(value) ? value : [value]
  return values.map(requiredPort)
}

function safePortRanges(value: unknown): string[] | undefined {
  const values = scalarOrStringArray(value)
  if (!values) return undefined
  return values.map((range) => {
    const match = /^(\d+):(\d+)$/.exec(range)
    if (!match) throw new Error('invalid range')
    const start = requiredPort(match[1]); const end = requiredPort(match[2])
    if (start > end) throw new Error('invalid range')
    return `${start}:${end}`
  })
}

function safeNetworks(value: unknown): Array<'tcp' | 'udp'> | undefined {
  const values = scalarOrStringArray(value)
  if (!values) return undefined
  if (values.some((network) => network !== 'tcp' && network !== 'udp')) throw new Error('invalid network')
  return values as Array<'tcp' | 'udp'>
}

function safeProtocols(value: unknown): string[] | undefined {
  const values = scalarOrStringArray(value)
  if (!values) return undefined
  if (values.some((protocol) => !/^[a-z0-9_-]{1,32}$/i.test(protocol))) throw new Error('invalid protocol')
  return values
}

function scalarOrStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  return typeof value === 'string' ? [value] : safeStringArray(value, MAX_RULES, 2048)
}

function safeStringArray(value: unknown, maxItems: number, maxLength: number): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > maxItems) throw new Error('invalid list')
  return value.map((item) => requiredString(item, maxLength))
}

function stringArray(value: unknown): string[] {
  try { return safeStringArray(value, MAX_NODES * 2, 256) ?? [] } catch { return [] }
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recordValue(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(message)
  return value
}

function validProfileId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).filter((key) => key !== 'id').sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function decodeBase64Text(value: string): string {
  const compact = decodeURIComponentSafe(value).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  if (!compact || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) throw new Error('invalid base64')
  const decoded = Buffer.from(compact, 'base64').toString('utf8')
  if (!decoded || decoded.includes('\uFFFD') || decoded.includes('\u0000')) throw new Error('invalid base64 text')
  return decoded
}

function decodeUriPart(value: string): string {
  return decodeURIComponentSafe(value)
}

function decodeURIComponentSafe(value: string): string {
  try { return decodeURIComponent(value) } catch { throw new Error('invalid percent encoding') }
}

function uriName(url: URL, fallback: string): string {
  return safeName(url.hash ? decodeUriPart(url.hash.slice(1)) : fallback, fallback)
}

function defaultUriPort(scheme: string): string {
  if (scheme === 'http') return '80'
  if (scheme === 'https') return '443'
  if (scheme.startsWith('socks')) return '1080'
  return ''
}

function csvStrings(value: unknown): string[] | undefined {
  const text = optionalString(value)
  return text ? text.split(',').map((entry) => requiredString(entry, 64)) : undefined
}

// A deliberately non-general YAML reader. It accepts only mappings, sequences,
// quoted/bare scalars and flow collections. Anchors, aliases, tags, merge keys,
// block scalars and executable extensions are rejected.
interface YamlLine { indent: number; text: string; line: number }

function parseYamlSubset(content: string): unknown {
  const lines: YamlLine[] = []
  content.split(/\r?\n/).forEach((raw, index) => {
    if (/^\s*\t/.test(raw)) throw new Error(`tabs at line ${index + 1}`)
    const stripped = stripYamlComment(raw).replace(/\s+$/, '')
    if (!stripped.trim() || /^\s*(?:---|\.\.\.)\s*$/.test(stripped)) return
    const indent = /^ */.exec(stripped)![0].length
    const text = stripped.slice(indent)
    if (/(?:^|\s)[&*!][^\s]*/.test(text) || /^(?:\?|<<)\s*:/.test(text) || /:\s*[|>]\s*$/.test(text)) throw new Error(`unsupported YAML feature at line ${index + 1}`)
    lines.push({ indent, text, line: index + 1 })
  })
  if (lines.length === 0) return Object.create(null)
  const [value, next] = parseYamlBlock(lines, 0, lines[0].indent, 0)
  if (next !== lines.length) throw new Error(`invalid indentation at line ${lines[next].line}`)
  return value
}

function parseYamlBlock(lines: YamlLine[], index: number, indent: number, depth: number): [unknown, number] {
  if (depth > MAX_YAML_DEPTH) throw new Error('YAML nesting is too deep')
  return lines[index].text.startsWith('-')
    ? parseYamlSequence(lines, index, indent, depth)
    : parseYamlMapping(lines, index, indent, depth)
}

function parseYamlSequence(lines: YamlLine[], index: number, indent: number, depth: number): [unknown[], number] {
  const result: unknown[] = []
  while (index < lines.length && lines[index].indent === indent && /^-(?:\s|$)/.test(lines[index].text)) {
    const rest = lines[index].text.slice(1).trimStart()
    index += 1
    if (!rest) {
      if (index < lines.length && lines[index].indent > indent) {
        const parsed = parseYamlBlock(lines, index, lines[index].indent, depth + 1); result.push(parsed[0]); index = parsed[1]
      } else result.push(null)
      continue
    }
    const pair = splitYamlPair(rest)
    if (!pair) { result.push(parseYamlScalar(rest)); continue }
    const object: Record<string, unknown> = Object.create(null)
    const parsedFirst = parseYamlEntryValue(lines, index, indent, pair[1], depth)
    setYamlKey(object, parseYamlKey(pair[0]), parsedFirst.value); index = parsedFirst.next
    if (index < lines.length && lines[index].indent > indent) {
      const mapIndent = lines[index].indent
      const parsed = parseYamlMapping(lines, index, mapIndent, depth + 1)
      for (const [key, value] of Object.entries(parsed[0])) setYamlKey(object, key, value)
      index = parsed[1]
    }
    result.push(object)
  }
  return [result, index]
}

function parseYamlMapping(lines: YamlLine[], index: number, indent: number, depth: number): [Record<string, unknown>, number] {
  const result: Record<string, unknown> = Object.create(null)
  while (index < lines.length && lines[index].indent === indent && !lines[index].text.startsWith('-')) {
    const pair = splitYamlPair(lines[index].text)
    if (!pair) throw new Error(`invalid mapping at line ${lines[index].line}`)
    index += 1
    const parsed = parseYamlEntryValue(lines, index, indent, pair[1], depth)
    setYamlKey(result, parseYamlKey(pair[0]), parsed.value); index = parsed.next
  }
  return [result, index]
}

function parseYamlEntryValue(lines: YamlLine[], index: number, indent: number, raw: string, depth: number): { value: unknown; next: number } {
  if (raw.trim()) return { value: parseYamlScalar(raw.trim()), next: index }
  if (index < lines.length && lines[index].indent > indent) {
    const parsed = parseYamlBlock(lines, index, lines[index].indent, depth + 1)
    return { value: parsed[0], next: parsed[1] }
  }
  return { value: null, next: index }
}

function parseYamlScalar(raw: string): unknown {
  if (raw.startsWith('{') && raw.endsWith('}')) {
    const object: Record<string, unknown> = Object.create(null)
    for (const entry of splitFlow(raw.slice(1, -1))) {
      const pair = splitYamlPair(entry)
      if (!pair) throw new Error('invalid flow mapping')
      setYamlKey(object, parseYamlKey(pair[0]), parseYamlScalar(pair[1].trim()))
    }
    return object
  }
  if (raw.startsWith('[') && raw.endsWith(']')) return splitFlow(raw.slice(1, -1)).map((entry) => parseYamlScalar(entry.trim()))
  if (raw.startsWith('"')) {
    try { return JSON.parse(raw) } catch { throw new Error('invalid quoted YAML scalar') }
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'")
  if (/^[&*!]/.test(raw) || raw === '|' || raw === '>') throw new Error('unsupported YAML scalar')
  if (/^(?:null|~)$/i.test(raw)) return null
  if (/^(?:true|false)$/i.test(raw)) return raw.toLowerCase() === 'true'
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) return Number(raw)
  return raw
}

function splitYamlPair(raw: string): [string, string] | undefined {
  let quote = ''; let depth = 0
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]
    if (quote) { if (char === quote && (quote === "'" || raw[index - 1] !== '\\')) quote = ''; continue }
    if (char === "'" || char === '"') { quote = char; continue }
    if (char === '[' || char === '{') depth += 1
    else if (char === ']' || char === '}') depth -= 1
    else if (char === ':' && depth === 0 && (index + 1 === raw.length || /\s/.test(raw[index + 1]))) return [raw.slice(0, index).trim(), raw.slice(index + 1).trim()]
  }
  return undefined
}

function splitFlow(raw: string): string[] {
  if (!raw.trim()) return []
  const result: string[] = []; let start = 0; let quote = ''; let depth = 0
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]
    if (quote) { if (char === quote && (quote === "'" || raw[index - 1] !== '\\')) quote = ''; continue }
    if (char === "'" || char === '"') quote = char
    else if (char === '[' || char === '{') depth += 1
    else if (char === ']' || char === '}') depth -= 1
    else if (char === ',' && depth === 0) { result.push(raw.slice(start, index).trim()); start = index + 1 }
  }
  if (quote || depth !== 0) throw new Error('invalid flow collection')
  result.push(raw.slice(start).trim())
  return result
}

function parseYamlKey(raw: string): string {
  const value = parseYamlScalar(raw.trim())
  if (typeof value !== 'string' || !value || value.length > 128 || FORBIDDEN_KEYS.has(value)) throw new Error('invalid YAML key')
  return value
}

function setYamlKey(object: Record<string, unknown>, key: string, value: unknown): void {
  if (FORBIDDEN_KEYS.has(key) || Object.prototype.hasOwnProperty.call(object, key)) throw new Error('duplicate or unsafe YAML key')
  object[key] = value
}

function stripYamlComment(raw: string): string {
  let quote = ''
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]
    if (quote) { if (char === quote && (quote === "'" || raw[index - 1] !== '\\')) quote = ''; continue }
    if (char === "'" || char === '"') quote = char
    else if (char === '#' && (index === 0 || /\s/.test(raw[index - 1]))) return raw.slice(0, index)
  }
  return raw
}

function hasAnyAsciiControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
}

function hasDisallowedAsciiControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127
  })
}

function replaceAsciiControls(value: string): string {
  return [...value].map((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127 ? ' ' : character
  }).join('')
}
