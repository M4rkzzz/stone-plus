type JsonObject = Record<string, unknown>

const SANDBOX_PERMISSION_KEY = 'sandbox_permissions'
const SANDBOX_JUSTIFICATION_KEY = 'justification'
const DSH_COMPATIBILITY_NOTE = 'Stone+ compatibility: invoke this tool without sandbox_permissions or justification.'

function objectValue(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined
}

function sanitizeToolSchema(value: unknown): { schema: unknown; changed: boolean } {
  const schema = objectValue(value)
  const properties = objectValue(schema?.properties)
  if (!schema || !properties
    || (!Object.hasOwn(properties, SANDBOX_PERMISSION_KEY)
      && !Object.hasOwn(properties, SANDBOX_JUSTIFICATION_KEY))) {
    return { schema: value, changed: false }
  }

  const nextProperties = { ...properties }
  delete nextProperties[SANDBOX_PERMISSION_KEY]
  delete nextProperties[SANDBOX_JUSTIFICATION_KEY]
  const nextSchema: JsonObject = { ...schema, properties: nextProperties }
  if (Array.isArray(schema.required)) {
    nextSchema.required = schema.required.filter((key) => (
      key !== SANDBOX_PERMISSION_KEY && key !== SANDBOX_JUSTIFICATION_KEY
    ))
  }
  return { schema: nextSchema, changed: true }
}

/**
 * DSH exposes sandbox escalation parameters on normal filesystem and shell tools.
 * GPT-family models can speculatively fill those retry-only fields on the first
 * call, which DSH correctly rejects. Hide the fields on the compatibility route
 * so the first call runs under the session's already-selected sandbox policy.
 */
export function sanitizeDeepSeekHarnessRequestTools(body: JsonObject): JsonObject {
  if (!Array.isArray(body.tools)) return body
  let changed = false
  const tools = body.tools.map((toolValue) => {
    const tool = objectValue(toolValue)
    const definition = objectValue(tool?.function)
    if (!tool || !definition) return toolValue
    const sanitized = sanitizeToolSchema(definition.parameters)
    if (!sanitized.changed) return toolValue
    changed = true
    const description = typeof definition.description === 'string'
      ? `${definition.description}\n\n${DSH_COMPATIBILITY_NOTE}`
      : DSH_COMPATIBILITY_NOTE
    return {
      ...tool,
      function: {
        ...definition,
        description,
        parameters: sanitized.schema,
      },
    }
  })
  return changed ? { ...body, tools } : body
}

/** Remove only DSH's retry-only top-level arguments; nested user data is intact. */
export function sanitizeDeepSeekHarnessToolArguments(value: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    return value
  }
  const object = objectValue(parsed)
  if (!object
    || (!Object.hasOwn(object, SANDBOX_PERMISSION_KEY)
      && !Object.hasOwn(object, SANDBOX_JUSTIFICATION_KEY))) {
    return value
  }
  const sanitized = { ...object }
  delete sanitized[SANDBOX_PERMISSION_KEY]
  delete sanitized[SANDBOX_JUSTIFICATION_KEY]
  return JSON.stringify(sanitized)
}

export function sanitizeDeepSeekHarnessChatResponse(body: JsonObject): JsonObject {
  if (!Array.isArray(body.choices)) return body
  let changed = false
  const choices = body.choices.map((choiceValue) => {
    const choice = objectValue(choiceValue)
    const message = objectValue(choice?.message)
    if (!choice || !message || !Array.isArray(message.tool_calls)) return choiceValue
    let callsChanged = false
    const toolCalls = message.tool_calls.map((callValue) => {
      const call = objectValue(callValue)
      const definition = objectValue(call?.function)
      if (!call || !definition || typeof definition.arguments !== 'string') return callValue
      const argumentsValue = sanitizeDeepSeekHarnessToolArguments(definition.arguments)
      if (argumentsValue === definition.arguments) return callValue
      callsChanged = true
      return { ...call, function: { ...definition, arguments: argumentsValue } }
    })
    if (!callsChanged) return choiceValue
    changed = true
    return { ...choice, message: { ...message, tool_calls: toolCalls } }
  })
  return changed ? { ...body, choices } : body
}
