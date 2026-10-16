import assert from 'node:assert/strict'
import test from 'node:test'
import { CcSwitchAdapter, requestHeaders } from '../src/adapter.ts'
import { discoverRouteModels } from '../src/discovery.ts'
import { modelForRoute } from '../src/provider.ts'

function route(appType, modelId) {
  return {
    provider: `ccswitch/${appType}/test`,
    sourceId: 'test',
    appType,
    name: 'Test',
    baseURL: 'https://example.test/v1',
    protocol: appType === 'claude' ? 'anthropic-messages'
      : appType === 'gemini' ? 'google-generative-ai' : 'openai-responses',
    defaultModel: modelId,
    models: [{ id: modelId, name: modelId, contextWindow: 128_000, maxTokens: 8_192 }],
    authKind: 'api-key',
    fingerprint: 'test',
  }
}

test('declares image input for Claude, Codex, and Gemini routes', () => {
  for (const appType of ['claude', 'codex', 'gemini']) {
    const model = modelForRoute(route(appType, appType === 'codex' ? 'gpt-4.1' : `${appType}-model`), appType === 'codex' ? 'gpt-4.1' : `${appType}-model`)
    assert.deepEqual(model?.input, ['text', 'image'])
  }
})

test('enables verified reasoning levels only for reasoning-capable Codex model families', () => {
  const reasoning = modelForRoute(route('codex', 'gpt-5.6-sol'), 'gpt-5.6-sol')
  assert.equal(reasoning?.reasoning, true)
  assert.deepEqual(reasoning?.thinkingLevelMap, {
    off: null,
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: null,
    max: null,
  })

  assert.equal(modelForRoute(route('codex', 'gpt-4.1'), 'gpt-4.1')?.reasoning, false)
  assert.equal(modelForRoute(route('claude', 'claude-sonnet-4-5'), 'claude-sonnet-4-5')?.reasoning, false)
})

test('publishes the configured Codex reasoning default to DSH', async () => {
  const codex = route('codex', 'gpt-5.6-sol')
  const repository = {
    current: { version: 1, fingerprint: 'test', routes: [codex] },
    config: { codexReasoningEffort: 'minimal' },
  }
  const adapter = new CcSwitchAdapter(repository)

  const resolved = await adapter.resolveModel(codex.provider, codex.defaultModel)
  assert.deepEqual(resolved.reasoning, {
    efforts: [
      { id: 'minimal', name: 'Minimal' },
      { id: 'low', name: 'Low' },
      { id: 'medium', name: 'Medium' },
      { id: 'high', name: 'High' },
    ],
    defaultEffort: 'minimal',
  })
})

test('adds the Codex client fingerprint for AgentRouter without overriding a caller header', () => {
  const agentRouter = route('codex', 'gpt-6.1-sol')
  agentRouter.baseURL = 'https://agentrouter.org/v1'
  assert.equal(requestHeaders(agentRouter, 'test-key').originator, 'codex_cli_rs')
  assert.equal(requestHeaders(agentRouter, 'test-key', { originator: 'custom-client' }).originator, 'custom-client')
  assert.equal(requestHeaders(route('codex', 'gpt-6.1-sol'), 'test-key').originator, undefined)
})

test('preserves a caller Originator header regardless of casing', () => {
  const agentRouter = route('codex', 'gpt-6.1-sol')
  agentRouter.baseURL = 'https://agentrouter.org/v1'
  const headers = requestHeaders(agentRouter, 'test-key', { Originator: 'custom-client' })
  assert.equal(headers.Originator, 'custom-client')
  assert.equal(Object.keys(headers).filter(key => key.toLowerCase() === 'originator').length, 1)
})

test('merges discovered models with configured models and preserves configured metadata', async () => {
  const codex = route('codex', 'gpt-6.1-sol')
  codex.models = [
    { id: 'gpt-6.1-sol', name: 'Configured GPT', contextWindow: 128_000, maxTokens: 32_768 },
    { id: 'deepseek-v4-flash', name: 'Configured DeepSeek', contextWindow: 64_000, maxTokens: 32_768 },
  ]
  codex.modelOverrides = new Map([
    ['gpt-6.1-sol', { name: 'Configured GPT', contextWindow: 128_000 }],
    ['deepseek-v4-flash', { name: 'Configured DeepSeek', contextWindow: 64_000, maxTokens: 32_768 }],
  ])
  const repository = {
    current: { version: 1, fingerprint: 'test', routes: [codex] },
    config: { codexReasoningEffort: 'minimal' },
  }
  const adapter = new CcSwitchAdapter(repository)
  adapter.setDiscoveredModels(codex.provider, [
    { id: 'gpt-6.1-sol', name: 'Remote GPT', contextWindow: 1, maxTokens: 1 },
    { id: 'remote-model', name: 'Remote Model', contextWindow: 32_000, maxTokens: 4_096 },
  ])
  const models = await adapter.listModels(codex.provider)
  assert.deepEqual(models.map(model => [model.id, model.name]), [
    ['gpt-6.1-sol', 'Configured GPT'],
    ['remote-model', 'Remote Model'],
    ['deepseek-v4-flash', 'Configured DeepSeek'],
  ])
  const configured = adapter.current().models.getModel(codex.provider, 'gpt-6.1-sol')
  assert.deepEqual(
    [configured?.name, configured?.contextWindow, configured?.maxTokens],
    ['Configured GPT', 128_000, 1],
  )
  const partialConfigured = adapter.current().models.getModel(codex.provider, 'deepseek-v4-flash')
  assert.deepEqual(
    [partialConfigured?.name, partialConfigured?.contextWindow, partialConfigured?.maxTokens],
    ['Configured DeepSeek', 64_000, 32_768],
  )
})

test('keeps discovered metadata when the configured catalog has no explicit overrides', async () => {
  for (const appType of ['claude', 'codex', 'gemini']) {
    const modelId = `${appType}-test`
    const configured = route(appType, modelId)
    configured.models = [{ id: modelId, name: modelId, contextWindow: 262_144, maxTokens: 32_768 }]
    configured.modelOverrides = undefined
    const repository = {
      current: { version: 1, fingerprint: 'test', routes: [configured] },
      config: { codexReasoningEffort: 'minimal' },
    }
    const adapter = new CcSwitchAdapter(repository)
    adapter.setDiscoveredModels(configured.provider, [
      { id: modelId, name: 'Remote Name', contextWindow: 16_000, maxTokens: 8_192 },
    ])
    const models = await adapter.listModels(configured.provider)
    assert.deepEqual(models.map(model => [model.id, model.name]), [[modelId, 'Remote Name']])
    const resolved = await adapter.resolveModel(configured.provider, modelId)
    assert.equal(resolved.context?.contextWindow, 16_000)
    const internalModel = adapter.current().models.getModel(configured.provider, modelId)
    assert.equal(internalModel?.maxTokens, 8_192)
  }
})

test('uses the discovered output limit in the final OpenAI Responses request', async () => {
  const codex = route('codex', 'gpt-4.1')
  codex.baseURL = 'https://agentrouter.example.test/v1'
  codex.models = [{ id: 'gpt-4.1', name: 'gpt-4.1', contextWindow: 262_144, maxTokens: 32_768 }]
  codex.modelOverrides = undefined
  const repository = {
    current: { version: 1, fingerprint: 'test', routes: [codex] },
    config: { codexReasoningEffort: 'minimal' },
    record: () => ({ settings: { OPENAI_API_KEY: 'test-key' } }),
  }
  const adapter = new CcSwitchAdapter(repository)

  const originalFetch = globalThis.fetch
  let requestBody
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === 'https://agentrouter.example.test/v1/models') {
      return new Response(JSON.stringify({
        data: [{ id: 'gpt-4.1', display_name: 'Remote GPT', contextWindow: 16_000, max_output_tokens: 8_192 }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    assert.equal(url, 'https://agentrouter.example.test/v1/responses')
    requestBody = JSON.parse(String(init?.body))
    const response = { id: 'resp_test', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
    return new Response(
      `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response })}\n\n` +
      `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`,
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )
  }
  try {
    const discovered = await discoverRouteModels(codex, { token: 'test-key' })
    adapter.setDiscoveredModels(codex.provider, discovered)
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: codex.provider,
      model: codex.defaultModel,
      messages: [{
        id: 'message-1',
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
        source: { kind: 'user' },
      }],
    })) chunks.push(chunk)
    assert.equal(requestBody.model, 'gpt-4.1')
    assert.equal(requestBody.max_output_tokens, 8_192)
    assert.ok(chunks.some(chunk => chunk.type === 'finish'))
  } finally {
    globalThis.fetch = originalFetch
  }
})
