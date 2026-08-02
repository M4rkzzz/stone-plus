import {
  DEEPSEEK_V4_FLASH_CONTEXT_WINDOW,
  DEEPSEEK_V4_FLASH_EFFECTIVE_CONTEXT_PERCENT,
} from '@shared/deepseek'
import type { CodexModelRepairPolicy } from '@shared/codex-model-repair'

export const STONE_CODEX_MODEL_CATALOG_FILENAME = 'stone-deepseek-model-catalog.json'

const STONE_CODEX_BASE_INSTRUCTIONS = [
  'You are a coding agent working in the user\'s workspace.',
  'Use the tools declared by the client to inspect, edit, test, and finish the requested work.',
  'Invoke tools through their structured interface; never print a tool call as prose or a code block.',
  'Treat tool results as authoritative conversation state and preserve call identifiers and ordering.',
  'Parallelize independent safe tool calls when useful, and continue until the task is genuinely complete.',
].join('\n')

const reasoningLevels = [
  { effort: 'none', description: 'Answer without extended reasoning' },
  { effort: 'low', description: 'Fast responses with lighter reasoning' },
  { effort: 'high', description: 'Deeper reasoning for complex work' },
  { effort: 'max', description: 'Maximum reasoning depth for the hardest work' },
]

function displayName(model: string): string {
  return model.split(/[-_.:/]+/).filter(Boolean).map((part) => (
    part.length <= 4 ? part.toUpperCase() : `${part[0].toUpperCase()}${part.slice(1)}`
  )).join(' ')
}

function catalogEntry(model: string) {
  return {
    slug: model,
    prefer_websockets: false,
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text',
    input_modalities: ['text'],
    supports_image_detail_original: false,
    truncation_policy: { mode: 'tokens', limit: 10_000 },
    supports_parallel_tool_calls: true,
    tool_mode: null,
    multi_agent_version: 'v2',
    use_responses_lite: false,
    include_skills_usage_instructions: true,
    auto_review_model_override: null,
    context_window: DEEPSEEK_V4_FLASH_CONTEXT_WINDOW,
    max_context_window: DEEPSEEK_V4_FLASH_CONTEXT_WINDOW,
    effective_context_window_percent: DEEPSEEK_V4_FLASH_EFFECTIVE_CONTEXT_PERCENT,
    auto_compact_token_limit: null,
    comp_hash: 'stone-deepseek-v1',
    reasoning_summary_format: 'experimental',
    default_reasoning_summary: 'none',
    display_name: displayName(model),
    description: 'DeepSeek V4 Flash through Stone+ with native Codex tools.',
    default_reasoning_level: 'max',
    supported_reasoning_levels: reasoningLevels,
    shell_type: 'shell_command',
    visibility: 'list',
    minimal_client_version: '0.144.0',
    supported_in_api: true,
    availability_nux: null,
    upgrade: null,
    priority: 10,
    model_messages: {
      instructions_template: STONE_CODEX_BASE_INSTRUCTIONS,
      instructions_variables: {
        personality_default: '',
        personality_friendly: '',
        personality_pragmatic: '',
      },
      approvals: null,
    },
    experimental_supported_tools: [],
    supports_search_tool: true,
    default_service_tier: null,
    supports_reasoning_summaries: false,
    base_instructions: STONE_CODEX_BASE_INSTRUCTIONS,
  }
}

/**
 * Collect every Codex-facing alias that can be selected while the whole route
 * is backed by DeepSeek. Upstream-only values are included as a recovery path
 * for configurations left behind by other switchers.
 */
export function deepSeekCodexCatalogModels(
  configuredModels: readonly unknown[],
  policy?: CodexModelRepairPolicy,
): string[] {
  const models = new Set<string>(['deepseek-v4-flash'])
  for (const value of configuredModels) {
    if (typeof value === 'string' && value.trim()) models.add(value.trim())
  }
  if (policy) {
    models.add(policy.fallbackModel)
    for (const [clientModel, upstreamModel] of Object.entries(policy.modelMap)) {
      if (clientModel !== '*' && clientModel.trim()) models.add(clientModel.trim())
      if (/^deepseek(?:[-_.:/]|$)/i.test(upstreamModel.trim())) models.add(upstreamModel.trim())
    }
  }
  return [...models].filter(Boolean)
}

export function renderDeepSeekCodexModelCatalog(models: readonly string[]): string {
  const unique = [...new Set(models.map((model) => model.trim()).filter(Boolean))]
  return `${JSON.stringify({ models: unique.map(catalogEntry) }, null, 2)}\n`
}
