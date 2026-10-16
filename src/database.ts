import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { statSync } from 'node:fs'
import type {
  CcSwitchAppType,
  CcSwitchAuthKind,
  CcSwitchConfig,
  CcSwitchModel,
  CcSwitchModelOverrides,
  CcSwitchReasoningEffort,
  CcSwitchRoute,
  CcSwitchSnapshot,
} from './types.ts'
import { DEFAULT_PROVIDER_SELECTION_PATH, providerSelected, readProviderSelectors } from './selection.ts'
import { resolveCcSwitchPaths } from './paths.ts'

export interface ProviderRecord {
  readonly id: string
  readonly appType: CcSwitchAppType
  readonly settings: Record<string, unknown>
  readonly meta: Record<string, unknown>
  readonly providerType?: string
}

interface ProviderRow {
  id: string
  app_type: string
  name: string
  settings_config: string
  meta: string
  provider_type: string | null
}

interface EndpointRow {
  provider_id: string
  app_type: string
  url: string
}

const APP_TYPES: readonly CcSwitchAppType[] = ['claude', 'codex', 'gemini']
const DEFAULT_CONTEXT_WINDOW = 262_144
const DEFAULT_MAX_TOKENS = 32_768
const CODEX_REASONING_EFFORTS: readonly CcSwitchReasoningEffort[] = ['minimal', 'low', 'medium', 'high']

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function configuredCodexReasoningEffort(value: string | undefined): CcSwitchReasoningEffort | undefined {
  const normalized = value?.trim().toLowerCase()
  if (normalized === undefined || normalized.length === 0) return 'minimal'
  if (normalized === 'provider') return undefined
  if (CODEX_REASONING_EFFORTS.includes(normalized as CcSwitchReasoningEffort)) {
    return normalized as CcSwitchReasoningEffort
  }
  throw new Error('DSH_CCSWITCH_CODEX_REASONING must be provider, minimal, low, medium, or high')
}

function jsonObject(raw: string): Record<string, unknown> {
  try {
    return objectValue(JSON.parse(raw))
  } catch {
    return {}
  }
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function envValue(settings: Record<string, unknown>, name: string): string | undefined {
  return nonEmpty(objectValue(settings.env)[name])
}

function settingValue(settings: Record<string, unknown>, ...names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = nonEmpty(settings[name])
    if (value !== undefined) return value
  }
  return undefined
}

function authBindingAccount(meta: Record<string, unknown>, provider: string): string | undefined {
  const binding = objectValue(meta.authBinding)
  const source = nonEmpty(binding.source)
  const authProvider = nonEmpty(binding.auth_provider)
    ?? nonEmpty(binding.authProvider)
  if (source === 'managed_account' && authProvider === provider) {
    return nonEmpty(binding.account_id) ?? nonEmpty(binding.accountId)
  }
  return undefined
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function codexConfigValue(config: string, key: string): string | undefined {
  const match = config.match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*[\"']([^\"']+)[\"']`, 'm'))
  return nonEmpty(match?.[1])
}

function codexProviderConfig(config: string, apiFormat: string | undefined): { baseURL?: string; protocol?: 'openai-completions' | 'openai-responses' } {
  const providerId = codexConfigValue(config, 'model_provider')
  const section = providerId === undefined ? '' : config.match(
    // Do not use the multiline flag here: `$` must mean end-of-config, not
    // the end of the provider header line.
    new RegExp(`\\[model_providers\\.${escapeRegExp(providerId)}\\]([\\s\\S]*?)(?=\\n\\[|$)`),
  )?.[1] ?? ''
  const baseURL = codexConfigValue(section, 'base_url')
  const wireApi = codexConfigValue(section, 'wire_api')
  // CC Switch keeps Codex's wire_api=responses even when the selected
  // upstream only speaks Chat Completions. Its local proxy performs the
  // Responses <-> Chat conversion. DSH must honor the provider's actual
  // upstream format when bypassing that proxy.
  const protocol = apiFormat === 'openai_chat'
    ? 'openai-completions'
    : apiFormat === 'openai_responses'
      ? 'openai-responses'
      : wireApi === 'chat' || wireApi === 'completions'
        ? 'openai-completions'
        : 'openai-responses'
  return {
    ...(baseURL === undefined ? {} : { baseURL }),
    protocol,
  }
}

function stripGeminiModelPrefix(id: string): string {
  return id.replace(/^models\//, '').trim()
}

function normalizeModelId(appType: CcSwitchAppType, id: string): string {
  return appType === 'gemini' ? stripGeminiModelPrefix(id) : id.trim()
}

function modelCatalogEntries(settings: Record<string, unknown>): unknown[] {
  const raw = settings.modelCatalog
  const catalog = objectValue(raw)
  return Array.isArray(catalog.models) ? catalog.models : []
}

function positiveCatalogNumber(value: unknown): number | undefined {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim().length > 0 ? Number(value.trim()) : NaN
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : undefined
}

function defaultModel(settings: Record<string, unknown>, appType: CcSwitchAppType): string {
  const env = objectValue(settings.env)
  let catalogId: string | undefined
  for (const value of modelCatalogEntries(settings)) {
    const item = objectValue(value)
    const id = nonEmpty(item.model) ?? nonEmpty(item.id)
    if (id !== undefined) {
      const normalizedId = normalizeModelId(appType, id)
      if (normalizedId.length > 0) {
        catalogId = normalizedId
        break
      }
    }
  }
  const value = appType === 'claude'
    ? nonEmpty(settings.model) ?? nonEmpty(env.ANTHROPIC_MODEL)
    : appType === 'codex'
      ? codexConfigValue(nonEmpty(settings.config) ?? '', 'model')
      : nonEmpty(env.GEMINI_MODEL) ?? nonEmpty(settings.model)
  return value ?? catalogId ?? (appType === 'claude'
    ? 'claude-sonnet-4-5'
    : appType === 'codex' ? 'gpt-5.5' : 'gemini-2.5-flash')
}

function configuredModels(
  settings: Record<string, unknown>,
  appType: CcSwitchAppType,
  fallback: string,
): { models: CcSwitchModel[]; modelOverrides: ReadonlyMap<string, CcSwitchModelOverrides> } {
  const raw = modelCatalogEntries(settings)
  const unique = new Map<string, CcSwitchModel>()
  const modelOverrides = new Map<string, CcSwitchModelOverrides>()
  for (const value of raw) {
    const item = objectValue(value)
    const id = nonEmpty(item.model) ?? nonEmpty(item.id)
    if (id === undefined) continue
    const normalizedId = normalizeModelId(appType, id)
    if (normalizedId.length === 0) continue
    if (unique.has(normalizedId)) continue
    const configuredName = nonEmpty(item.displayName) ?? nonEmpty(item.display_name)
    const configuredContextWindow = positiveCatalogNumber(item.contextWindow)
      ?? positiveCatalogNumber(item.context_window)
    const configuredMaxTokens = positiveCatalogNumber(item.maxTokens)
    unique.set(normalizedId, {
      id: normalizedId,
      name: configuredName ?? normalizedId,
      contextWindow: configuredContextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: configuredMaxTokens ?? DEFAULT_MAX_TOKENS,
    })
    const overrides: CcSwitchModelOverrides = {
      ...(configuredName === undefined ? {} : { name: configuredName }),
      ...(configuredContextWindow === undefined ? {} : { contextWindow: configuredContextWindow }),
      ...(configuredMaxTokens === undefined ? {} : { maxTokens: configuredMaxTokens }),
    }
    if (Object.keys(overrides).length > 0) modelOverrides.set(normalizedId, overrides)
  }
  const fallbackId = normalizeModelId(appType, fallback)
  if (fallbackId.length > 0 && !unique.has(fallbackId)) {
    unique.set(fallbackId, { id: fallbackId, name: fallbackId, contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS })
  }
  return { models: [...unique.values()], modelOverrides }
}

function parseConfiguredAuth(
  settings: Record<string, unknown>,
  meta: Record<string, unknown>,
  appType: CcSwitchAppType,
  providerType: string | undefined,
): { kind: CcSwitchAuthKind; accountId?: string } {
  if (appType === 'claude') {
    return { kind: envValue(settings, 'ANTHROPIC_AUTH_TOKEN') === undefined ? 'api-key' : 'claude-token' }
  }
  if (appType === 'codex') {
    const auth = objectValue(settings.auth)
    const mode = nonEmpty(auth.auth_mode) ?? nonEmpty(auth.authMode)
    const accountId = authBindingAccount(meta, 'codex_oauth')
    if (providerType === 'codex_oauth' || mode === 'chatgpt' || accountId !== undefined) {
      return { kind: 'codex-oauth', ...(accountId === undefined ? {} : { accountId }) }
    }
    return { kind: 'api-key' }
  }
  const config = objectValue(settings.config)
  const security = objectValue(config.security)
  const auth = objectValue(security.auth)
  const selected = nonEmpty(config.selectedAuthType) ?? nonEmpty(auth.selectedType)
  const configuredKey = envValue(settings, 'GEMINI_API_KEY') ?? settingValue(settings, 'apiKey', 'api_key')
  if (providerType === 'gemini_cli' || providerType === 'gemini-oauth'
    || selected === 'oauth-personal' || selected === 'oauth' || selected === 'google-oauth'
    || configuredKey?.startsWith('ya29.') === true || configuredKey?.startsWith('{') === true) {
    return { kind: 'gemini-oauth' }
  }
  return { kind: 'api-key' }
}

function routeFromRow(row: ProviderRow, endpoint: string | undefined): { route: CcSwitchRoute; record: ProviderRecord } | undefined {
  if (!APP_TYPES.includes(row.app_type as CcSwitchAppType)) return undefined
  const appType = row.app_type as CcSwitchAppType
  const settings = jsonObject(row.settings_config)
  const meta = jsonObject(row.meta)
  const providerType = nonEmpty(row.provider_type)
    ?? nonEmpty(meta.providerType)
    ?? nonEmpty(meta.provider_type)
  const apiFormat = appType === 'codex'
    ? nonEmpty(meta.apiFormat)
      ?? nonEmpty(meta.api_format)
      ?? nonEmpty(settings.api_format)
      ?? nonEmpty(settings.apiFormat)
    : undefined
  const codex = appType === 'codex' ? codexProviderConfig(nonEmpty(settings.config) ?? '', apiFormat) : {}
  const auth = parseConfiguredAuth(settings, meta, appType, providerType)
  const hasInlineCredential = appType === 'claude'
    ? envValue(settings, 'ANTHROPIC_AUTH_TOKEN') !== undefined
      || envValue(settings, 'ANTHROPIC_API_KEY') !== undefined
      || settingValue(settings, 'apiKey', 'api_key') !== undefined
    : appType === 'codex'
      ? nonEmpty(objectValue(settings.auth).OPENAI_API_KEY) !== undefined
        || settingValue(settings, 'OPENAI_API_KEY', 'apiKey', 'api_key') !== undefined
      : envValue(settings, 'GEMINI_API_KEY') !== undefined
        || settingValue(settings, 'apiKey', 'api_key') !== undefined
  const defaultBaseURL = auth.kind === 'codex-oauth'
    ? 'https://chatgpt.com/backend-api/codex'
    : auth.kind === 'gemini-oauth'
      ? 'https://generativelanguage.googleapis.com/v1beta'
      : hasInlineCredential
        ? appType === 'claude'
          ? 'https://api.anthropic.com'
          : appType === 'codex' ? 'https://api.openai.com/v1' : 'https://generativelanguage.googleapis.com/v1beta'
        : undefined
  const baseURL = appType === 'claude'
    ? envValue(settings, 'ANTHROPIC_BASE_URL') ?? settingValue(settings, 'base_url', 'baseURL') ?? endpoint ?? defaultBaseURL
    : appType === 'codex'
      ? codex.baseURL ?? settingValue(settings, 'base_url', 'baseURL') ?? endpoint ?? defaultBaseURL
      : envValue(settings, 'GOOGLE_GEMINI_BASE_URL') ?? settingValue(settings, 'base_url', 'baseURL') ?? endpoint ?? defaultBaseURL
  if (baseURL === undefined) return undefined

  const model = defaultModel(settings, appType)
  const configured = configuredModels(settings, appType, model)
  const sourceId = row.id.trim()
  if (sourceId.length === 0 || model.length === 0) return undefined
  const route: CcSwitchRoute = {
    provider: `ccswitch/${appType}/${sourceId}`,
    sourceId,
    appType,
    name: row.name.trim() || sourceId,
    baseURL: baseURL.replace(/\/$/, ''),
    protocol: appType === 'claude'
      ? 'anthropic-messages'
      : appType === 'gemini' ? 'google-generative-ai' : codex.protocol ?? 'openai-responses',
    defaultModel: normalizeModelId(appType, model),
    models: configured.models,
    ...(configured.modelOverrides.size === 0 ? {} : { modelOverrides: configured.modelOverrides }),
    authKind: auth.kind,
    ...(auth.accountId === undefined ? {} : { accountId: auth.accountId }),
    fingerprint: hash({
      id: sourceId,
      appType,
      name: row.name,
      settings: row.settings_config,
      meta: row.meta,
      providerType,
      endpoint,
    }),
  }
  return {
    route,
    record: { id: sourceId, appType, settings, meta, ...(providerType === undefined ? {} : { providerType }) },
  }
}

export class CcSwitchRepository {
  readonly config: CcSwitchConfig
  private records = new Map<string, ProviderRecord>()
  private snapshot: CcSwitchSnapshot = { version: 0, fingerprint: '', routes: [] }

  constructor(options: Partial<CcSwitchConfig> = {}) {
    const defaults = resolveCcSwitchPaths()
    const dbPath = options.dbPath ?? process.env.DSH_CCSWITCH_DB ?? defaults.database
    const requestedApps = options.appTypes ?? APP_TYPES
    const codexReasoningEffort = options.codexReasoningEffort
      ?? configuredCodexReasoningEffort(process.env.DSH_CCSWITCH_CODEX_REASONING)
    this.config = {
      dbPath,
      pollIntervalMs: Math.max(500, options.pollIntervalMs ?? 2_000),
      appTypes: APP_TYPES.filter(app => requestedApps.includes(app)),
      discoverModels: options.discoverModels ?? true,
      ...(options.providerSelectors === undefined ? {} : { providerSelectors: options.providerSelectors }),
      providerSelectionPath: options.providerSelectionPath
        ?? process.env.DSH_CCSWITCH_PROVIDERS_FILE
        ?? DEFAULT_PROVIDER_SELECTION_PATH,
      ...(codexReasoningEffort === undefined ? {} : { codexReasoningEffort }),
    }
  }

  get current(): CcSwitchSnapshot {
    return this.snapshot
  }

  read(): boolean {
    const db = new DatabaseSync(this.config.dbPath, { readOnly: true })
    try {
      const providers = db.prepare(
        'SELECT id, app_type, name, settings_config, meta, provider_type FROM providers ORDER BY app_type, sort_index, id',
      ).all() as unknown as ProviderRow[]
      const endpoints = db.prepare(
        'SELECT provider_id, app_type, url FROM provider_endpoints ORDER BY id',
      ).all() as unknown as EndpointRow[]
      const endpointMap = new Map<string, string>()
      for (const endpoint of endpoints) {
        const key = `${endpoint.app_type}:${endpoint.provider_id}`
        if (!endpointMap.has(key) && nonEmpty(endpoint.url) !== undefined) endpointMap.set(key, endpoint.url.trim())
      }
      const nextRecords = new Map<string, ProviderRecord>()
      const routes: CcSwitchRoute[] = []
      const selectors = this.config.providerSelectors ?? readProviderSelectors(this.config.providerSelectionPath)
      for (const row of providers) {
        const appType = row.app_type as CcSwitchAppType
        if (!this.config.appTypes.includes(appType)) continue
        const result = routeFromRow(row, endpointMap.get(`${row.app_type}:${row.id}`))
        if (result === undefined) continue
        if (!providerSelected(result.route, selectors)) continue
        routes.push(result.route)
        nextRecords.set(`${appType}:${row.id}`, result.record)
      }
      const fingerprint = hash(routes.map(route => route.fingerprint))
      if (fingerprint === this.snapshot.fingerprint) return false
      this.records = nextRecords
      this.snapshot = { version: this.snapshot.version + 1, fingerprint, routes }
      return true
    } finally {
      db.close()
    }
  }

  record(route: Pick<CcSwitchRoute, 'appType' | 'sourceId'>): ProviderRecord | undefined {
    return this.records.get(`${route.appType}:${route.sourceId}`)
  }

  exists(): boolean {
    try {
      return statSync(this.config.dbPath).isFile()
    } catch {
      return false
    }
  }
}

export function defaultRepositoryConfig(): Partial<CcSwitchConfig> {
  return {}
}
