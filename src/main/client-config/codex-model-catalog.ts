import {
  DEEPSEEK_RESPONSES_OFFICIAL_MODELS,
  DEEPSEEK_V4_FLASH_CONTEXT_WINDOW,
  DEEPSEEK_V4_FLASH_EFFECTIVE_CONTEXT_PERCENT,
} from '@shared/deepseek'
import type { CodexModelRepairPolicy } from '@shared/codex-model-repair'

export const STONE_CODEX_MODEL_CATALOG_FILENAME = 'stone-deepseek-model-catalog.json'

const STONE_CODEX_BASE_INSTRUCTIONS = [
  'You are Stone+ Codex, a coding agent collaborating with the user in their workspace.',
  'Work through the task until the requested outcome is genuinely complete; do not stop after merely describing a change.',
  'Use only tools declared by the client. Never invent a tool or print a tool call as prose, XML, JSON, or a code block.',
  'For function tools, follow the declared JSON schema exactly. For freeform tools, send the raw tool input without a JSON wrapper.',
  'The apply_patch tool accepts patch text directly. Put the patch in the tool call, never in an assistant message.',
  'Inspect relevant files before editing, preserve unrelated user changes, and keep every modification scoped to the request.',
  'Treat tool results as authoritative conversation state. Preserve tool call identifiers, result ordering, and parallel batches.',
  'When independent read-only operations can run concurrently, issue them as parallel tool calls.',
  'After editing, run focused verification appropriate to the risk and fix failures caused by your changes.',
  'If a tool fails, reason from its actual error and try a safe alternative; never claim an action succeeded without evidence.',
  'Do not synthesize hidden Continue messages or wait for the user when the next safe implementation step is already clear.',
  'Protect credentials and private data: do not echo secrets in messages, commands, patches, or diagnostic output.',
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
    comp_hash: 'stone-deepseek-v2',
    reasoning_summary_format: 'experimental',
    default_reasoning_summary: 'none',
    display_name: displayName(model),
    description: 'DeepSeek V4 through Stone+ with native Codex tools.',
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
  const models = new Set<string>(DEEPSEEK_RESPONSES_OFFICIAL_MODELS)
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
