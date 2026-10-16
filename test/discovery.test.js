import assert from 'node:assert/strict'
import test from 'node:test'
import { discoverRouteModels } from '../src/discovery.ts'

function route(appType) {
  return {
    provider: 'ccswitch/' + appType + '/test',
    sourceId: 'test',
    appType,
    name: 'Test',
    baseURL: 'https://example.test/v1',
    protocol: appType === 'gemini' ? 'google-generative-ai' : appType === 'claude' ? 'anthropic-messages' : 'openai-responses',
    defaultModel: 'test-model',
    models: [{ id: 'test-model', name: 'test-model', contextWindow: 262_144, maxTokens: 32_768 }],
    authKind: 'api-key',
    fingerprint: 'test',
  }
}

test('discovery keeps non-Gemini model names intact and rejects unsafe numeric metadata', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    data: [
      { id: 'models/vendor-model', display_name: 'Vendor Model', contextWindow: 1e30, max_output_tokens: '8192' },
      { name: 'models/name-only' },
    ],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  try {
    const models = await discoverRouteModels(route('codex'), { token: 'test-key' })
    assert.deepEqual(models, [
      { id: 'models/vendor-model', name: 'Vendor Model', contextWindow: 262_144, maxTokens: 8_192 },
      { id: 'models/name-only', name: 'models/name-only', contextWindow: 262_144, maxTokens: 32_768 },
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('discovery removes models/ only for Gemini ids', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    models: [
      { name: 'models/gemini-test', displayName: 'Gemini Test', input_token_limit: '1000000' },
    ],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  try {
    const models = await discoverRouteModels(route('gemini'), { token: 'test-key' })
    assert.deepEqual(models, [
      { id: 'gemini-test', name: 'Gemini Test', contextWindow: 1_000_000, maxTokens: 32_768 },
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})
