import type { ProviderKind, RouteClient } from '@shared/types'

const anthropicIcon = new URL('./assets/client-icons/anthropic.svg', import.meta.url).href
const claudeIcon = new URL('./assets/client-icons/claude.svg', import.meta.url).href
const openAiIcon = new URL('./assets/client-icons/openai.svg', import.meta.url).href
const geminiIcon = new URL('./assets/client-icons/gemini.svg', import.meta.url).href
export const grokIcon = new URL('./assets/client-icons/grok.svg', import.meta.url).href

export const clientBrandMeta: Record<RouteClient, { name: string; icon: string }> = {
  claude: { name: 'Claude Code', icon: claudeIcon },
  codex: { name: 'Codex', icon: openAiIcon },
  gemini: { name: 'Gemini CLI', icon: geminiIcon },
  grokbuild: { name: 'Grok Build', icon: grokIcon },
}

export function providerBrandIcon(kind: ProviderKind): string | undefined {
  if (kind === 'anthropic' || kind === 'anthropic-compatible') return anthropicIcon
  if (kind === 'openai' || kind === 'openai-compatible') return openAiIcon
  if (kind === 'google') return geminiIcon
  if (kind === 'xai' || kind === 'xai-compatible') return grokIcon
  return undefined
}
