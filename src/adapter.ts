import { createModels, getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type { Api, Model, Models, MutableModels, SimpleStreamOptions, ThinkingLevel } from '@earendil-works/pi-ai'
import { attributionHeaders, contentHasImage, LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { resolveCredential } from './auth.ts'
import { CcSwitchRepository } from './database.ts'
import { toPiContext } from './context.ts'
import { toStreamChunks } from './stream.ts'
import { buildProvider } from './provider.ts'
import type { CcSwitchModel, CcSwitchRoute, CcSwitchSnapshot } from './types.ts'

interface Snapshot {
  source: CcSwitchSnapshot
  revision: number
  models: Models
  routes: ReadonlyMap<string, CcSwitchRoute>
}

export function requestHeaders(route: CcSwitchRoute, token: string, extra: Readonly<Record<string, string>> | undefined): Record<string, string | null> {
  const headers: Record<string, string | null> = { ...extra }
  if (route.authKind === 'claude-token') {
    headers.authorization = `Bearer ${token}`
    headers['x-api-key'] = null
  } else if (route.authKind === 'gemini-oauth') {
    headers.authorization = `Bearer ${token}`
    headers['x-goog-api-key'] = null
  } else if (route.authKind === 'codex-oauth') {
    headers.authorization = `Bearer ${token}`
    if (route.accountId !== undefined) headers['chatgpt-account-id'] = route.accountId
    headers.originator = 'cc-switch'
  }
  // AgentRouter currently gates generic HTTP clients behind a recognized
  // Codex client fingerprint. CC Switch's own Codex path supplies this
  // identity, so preserve the same compatibility when DSH talks to the
  // upstream directly rather than through CC Switch's local proxy.
  if (route.appType === 'codex') {
    try {
      const host = new URL(route.baseURL).hostname.toLowerCase()
      if (host === 'agentrouter.org' || host.endsWith('.agentrouter.org')) {
        if (!Object.keys(headers).some(key => key.toLowerCase() === 'originator')) headers.originator = 'codex_cli_rs'
      }
    } catch {
      // Invalid URLs are handled by the transport later.
    }
  }
  const attribution = attributionHeaders()
  const reserved = new Set(Object.keys(attribution).map(key => key.toLowerCase()))
  for (const key of Object.keys(headers)) if (reserved.has(key.toLowerCase())) delete headers[key]
  return { ...headers, ...attribution }
}

function modelInfo(model: Model<Api>): LlmModelInfo {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    inputModalities: [...model.input],
  }
}

function reasoningInfo(
  model: Model<Api>,
  defaultEffort: string | undefined,
): Pick<LlmResolvedModelInfo, 'reasoning'> | Record<string, never> {
  if (!model.reasoning) return {}
  const levels = getSupportedThinkingLevels(model)
  const hasDefault = defaultEffort !== undefined && levels.some(level => level === defaultEffort)
  return {
    reasoning: {
      efforts: levels.map(level => ({
        id: ReasoningEffortId(level),
        name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`,
      })),
      ...hasDefault ? { defaultEffort: ReasoningEffortId(defaultEffort) } : {},
    },
  }
}

function resolveReasoningLevel(model: Model<Api>, effort: string | undefined): ThinkingLevel | undefined {
  if (effort === undefined) return undefined
  const supported = getSupportedThinkingLevels(model)
  if (supported.some(level => level === effort) && effort !== 'off') return effort as ThinkingLevel
  throw new LlmError(
    `CC Switch provider "${model.provider}" model "${model.id}" does not support reasoning effort "${effort}"`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

export class CcSwitchAdapter extends LlmAdapter {
  private snapshot: Snapshot | undefined
  private discovered = new Map<string, readonly CcSwitchModel[]>()
  private discoveredRevision = 0

  constructor(
    private readonly repository: CcSwitchRepository,
    private readonly resolveAttachments?: () => AttachmentStore | undefined,
  ) {
    super()
  }

  /** Publish endpoint-discovered models without touching the CC Switch DB. */
  setDiscoveredModels(provider: string, models: readonly CcSwitchModel[]): void {
    if (models.length === 0) return
    const route = this.repository.current.routes.find(route => route.provider === provider)
    const configured = route?.models ?? []
    const overrides = route?.modelOverrides
    const merged = new Map(models.map(model => [model.id, model]))
    for (const model of configured) {
      const discovered = merged.get(model.id)
      if (discovered === undefined) {
        merged.set(model.id, model)
        continue
      }
      const explicit = overrides?.get(model.id)
      merged.set(model.id, {
        ...discovered,
        ...(explicit?.name === undefined ? {} : { name: explicit.name }),
        ...(explicit?.contextWindow === undefined ? {} : { contextWindow: explicit.contextWindow }),
        ...(explicit?.maxTokens === undefined ? {} : { maxTokens: explicit.maxTokens }),
      })
    }
    const next = [...merged.values()]
    const previous = this.discovered.get(provider)
    const same = previous !== undefined && previous.length === next.length
      && previous.every((model, index) => model.id === next[index]?.id
        && model.name === next[index]?.name
        && model.contextWindow === next[index]?.contextWindow
        && model.maxTokens === next[index]?.maxTokens)
    if (same) return
    this.discovered.set(provider, next.map(model => ({ ...model })))
    this.discoveredRevision += 1
    this.snapshot = undefined
  }

  clearDiscoveredModels(): void {
    if (this.discovered.size === 0) return
    this.discovered.clear()
    this.discoveredRevision += 1
    this.snapshot = undefined
  }

  private current(): Snapshot {
    const source = this.repository.current
    if (this.snapshot?.source === source && this.snapshot.revision === this.discoveredRevision) return this.snapshot
    const models: MutableModels = createModels()
    const routes = new Map(source.routes.map(route => {
      const discovered = this.discovered.get(route.provider)
      return [route.provider, discovered === undefined ? route : { ...route, models: discovered }]
    }))
    for (const route of routes.values()) models.setProvider(buildProvider(route))
    this.snapshot = { source, revision: this.discoveredRevision, models, routes: routes as ReadonlyMap<string, CcSwitchRoute> }
    return this.snapshot
  }

  private route(snapshot: Snapshot, provider: string): CcSwitchRoute {
    const route = snapshot.routes.get(provider)
    if (route === undefined) throw new LlmError(`CC Switch provider "${provider}" is not available`, 'NO_ADAPTER')
    return route
  }

  private model(snapshot: Snapshot, provider: string, modelId: string): Model<Api> {
    this.route(snapshot, provider)
    const model = snapshot.models.getModel(provider, modelId)
    if (model === undefined) throw new LlmError(`CC Switch model "${modelId}" is not available`, 'UNKNOWN_MODEL')
    return model
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: this.current().routes.get(provider)?.name ?? provider }
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const snapshot = this.current()
    this.route(snapshot, provider)
    return Promise.resolve(snapshot.models.getModels(provider).map(modelInfo))
  }

  override resolveModel(provider: string, modelId: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const model = this.model(this.current(), provider, modelId)
    return Promise.resolve({
      ...modelInfo(model),
      context: { contextWindow: model.contextWindow },
      ...reasoningInfo(model, this.repository.config.codexReasoningEffort),
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.stop !== undefined) {
      throw new LlmError('dsh-ccswitch does not support GenerateOptions.stop', 'UNSUPPORTED_OPTION')
    }
    const snapshot = this.current()
    const route = this.route(snapshot, options.provider)
    const model = this.model(snapshot, options.provider, options.model)
    const reasoning = resolveReasoningLevel(
      model,
      options.reasoningEffort ?? (model.reasoning ? this.repository.config.codexReasoningEffort : undefined),
    )
    const credential = await resolveCredential(route, this.repository)
    const containsImage = options.messages.some(message => contentHasImage(message.content))
    if (containsImage && !model.input.includes('image')) {
      throw new LlmError(`CC Switch model "${model.id}" does not support image input`, 'UNSUPPORTED_CONTENT')
    }
    const attachments = containsImage ? this.resolveAttachments?.() : undefined
    if (containsImage && attachments === undefined) {
      throw new LlmError('CC Switch image input requires the durable attachment service', 'UNSUPPORTED_CONTENT')
    }
    const context = attachments === undefined
      ? toPiContext(options, undefined)
      : await toPiContext(options, attachments)
    const streamOptions: SimpleStreamOptions = {
      apiKey: credential.token,
      headers: requestHeaders(route, credential.token ?? '', credential.headers),
      signal: options.signal,
      ...options.temperature === undefined ? {} : { temperature: options.temperature },
      ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
      ...options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) },
      ...reasoning === undefined ? {} : { reasoning },
      maxRetries: 0,
    }
    const events = snapshot.models.streamSimple(model, context, streamOptions)
    yield* toStreamChunks(events, model.contextWindow)
  }
}
