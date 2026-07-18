export {
  OutboundTransportManager,
  probeProxy,
  proxyEntryAddress,
  resolveEffectiveProxy,
  type OutboundTransportManagerOptions,
  type ProxyProbeResult
} from './transport'
export {
  isLocalTarget,
  isLoopbackHostname,
  parseSystemProxyChain,
  summarizeSystemProxyChain,
  type ParseSystemProxyOptions,
  type SystemProxyDirective
} from './system-proxy'
