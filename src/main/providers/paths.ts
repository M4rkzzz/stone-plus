import type { ProviderEndpointInput } from './types'

export function protocolOperationPath(input: ProviderEndpointInput): {
  path: string
  query?: Readonly<Record<string, string>>
} {
  if (input.operation === 'models' || input.operation === 'health') return { path: 'models' }
  if (input.operation === 'search') {
    if (input.protocol !== 'openai-responses') {
      throw new Error('Standalone web search requires an OpenAI Responses provider endpoint')
    }
    return { path: 'alpha/search' }
  }

  switch (input.protocol) {
    case 'openai-responses':
      return { path: 'responses' }
    case 'openai-chat':
      return { path: 'chat/completions' }
    case 'anthropic-messages':
      return { path: 'messages' }
    case 'gemini': {
      const model = input.model?.trim()
      if (!model) throw new Error('A model is required for a Gemini provider endpoint')
      const method = input.stream ? 'streamGenerateContent' : 'generateContent'
      return {
        path: `models/${encodeURIComponent(model)}:${method}`,
        ...(input.stream ? { query: { alt: 'sse' } } : {})
      }
    }
  }
}
