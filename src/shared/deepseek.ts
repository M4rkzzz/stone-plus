export const DEEPSEEK_RESPONSES_DEFAULT_MODEL = 'deepseek-v4-flash'

/**
 * Models currently documented for the official DeepSeek Responses/Codex API.
 * Compatible relays are intentionally not restricted to this catalog.
 */
export const DEEPSEEK_RESPONSES_OFFICIAL_MODELS = Object.freeze([
  DEEPSEEK_RESPONSES_DEFAULT_MODEL,
] as const)

const officialModelSet = new Set<string>(DEEPSEEK_RESPONSES_OFFICIAL_MODELS)

export function isOfficialDeepSeekResponsesModel(model: string): boolean {
  return officialModelSet.has(model.trim())
}

export function filterOfficialDeepSeekResponsesModels(models: readonly string[]): string[] {
  return models.filter(isOfficialDeepSeekResponsesModel)
}
