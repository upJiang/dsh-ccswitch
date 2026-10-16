import type { CcSwitchCredential } from './types.ts'
import type { CcSwitchModel, CcSwitchRoute } from './types.ts'

const MAX_BYTES = 2 * 1024 * 1024
const DEFAULT_CONTEXT_WINDOW = 262_144
const DEFAULT_MAX_TOKENS = 32_768

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function positive(value: unknown): number | undefined {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim().length > 0 ? Number(value.trim()) : NaN
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : undefined
}

function listURL(route: CcSwitchRoute): string {
  if (route.appType === 'codex' && route.authKind === 'codex-oauth') return 'https://chatgpt.com/backend-api/codex/models'
  const base = route.baseURL.replace(/\/+$/, '')
  return route.appType === 'gemini' && !base.endsWith('/v1beta') ? `${base}/v1beta/models` : `${base}/models`
}

async function boundedJSON(response: Response): Promise<unknown> {
  if (Number(response.headers.get('content-length') ?? 0) > MAX_BYTES) throw new Error('model listing is too large')
  if (response.body === null) return undefined
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      total += part.value.byteLength
      if (total > MAX_BYTES) throw new Error('model listing is too large')
      chunks.push(part.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

function entries(body: unknown): unknown[] {
  if (Array.isArray(body)) return body
  if (body !== null && typeof body === 'object') {
    const record = body as Record<string, unknown>
    for (const key of ['data', 'models', 'items']) if (Array.isArray(record[key])) return record[key] as unknown[]
    if (record.models !== null && typeof record.models === 'object') {
      return Object.entries(record.models as Record<string, unknown>).map(([id, value]) => ({
        ...(value !== null && typeof value === 'object' ? value : {}),
        id,
      }))
    }
    return Object.entries(record).map(([id, value]) => ({ ...(value !== null && typeof value === 'object' ? value : {}), id }))
  }
  return []
}

function parseModel(route: CcSwitchRoute, value: unknown): CcSwitchModel | undefined {
  const record = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
  const id = text(record.slug) ?? text(record.id) ?? text(record.model) ?? text(record.name)
  if (id === undefined) return undefined
  const contextWindow = positive(record.context_window) ?? positive(record.contextWindow)
    ?? positive(record.context_length) ?? positive(record.input_token_limit) ?? DEFAULT_CONTEXT_WINDOW
  const maxTokens = positive(record.max_output_tokens) ?? positive(record.maxTokens)
    ?? positive(record.output_token_limit) ?? DEFAULT_MAX_TOKENS
  const modelId = route.appType === 'gemini' ? id.replace(/^models\//, '').trim() : id
  if (modelId.length === 0) return undefined
  return { id: modelId, name: text(record.display_name) ?? text(record.displayName) ?? modelId, contextWindow, maxTokens }
}

function authHeaders(route: CcSwitchRoute, credential: CcSwitchCredential): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json', ...credential.headers }
  if (route.authKind === 'api-key' && credential.token !== undefined) {
    if (route.appType === 'claude') headers['x-api-key'] = credential.token
    else if (route.appType === 'gemini') headers['x-goog-api-key'] = credential.token
    else headers.authorization = `Bearer ${credential.token}`
  } else if (credential.token !== undefined && route.appType !== 'gemini') {
    headers.authorization ??= `Bearer ${credential.token}`
  }
  return headers
}

export async function discoverRouteModels(
  route: CcSwitchRoute,
  credential: CcSwitchCredential,
  signal?: AbortSignal,
): Promise<readonly CcSwitchModel[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort('discovery timeout'), 5_000)
  const requestSignal = signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
  try {
    const response = await fetch(listURL(route), { headers: authHeaders(route, credential), signal: requestSignal })
    if (!response.ok) throw new Error(`model listing returned HTTP ${response.status}`)
    const models = entries(await boundedJSON(response))
      .map(value => parseModel(route, value))
      .filter((model): model is CcSwitchModel => model !== undefined)
    const unique = new Map(models.map(model => [model.id, model]))
    return unique.size > 0 ? [...unique.values()] : route.models
  } finally {
    clearTimeout(timer)
  }
}
