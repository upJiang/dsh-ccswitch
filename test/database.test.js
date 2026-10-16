import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { CcSwitchRepository } from '../src/database.ts'

test('opens a CC Switch database read-only and discovers a provider', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ccswitch-'))
  const dataDir = join(root, 'CC Switch Data')
  const dbPath = join(dataDir, 'cc-switch.db')
  mkdirSync(dataDir)

  try {
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE providers (
        id TEXT PRIMARY KEY,
        app_type TEXT NOT NULL,
        name TEXT NOT NULL,
        settings_config TEXT NOT NULL,
        meta TEXT NOT NULL,
        provider_type TEXT,
        sort_index INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE provider_endpoints (
        id INTEGER PRIMARY KEY,
        provider_id TEXT NOT NULL,
        app_type TEXT NOT NULL,
        url TEXT NOT NULL
      );
    `)
    db.prepare(`
      INSERT INTO providers (id, app_type, name, settings_config, meta, provider_type, sort_index)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'example-provider',
      'codex',
      'Example Provider',
      JSON.stringify({ OPENAI_API_KEY: 'test-key', base_url: 'https://example.test/v1' }),
      '{}',
      null,
      0,
    )
    db.close()

    const repository = new CcSwitchRepository({
      dbPath,
      discoverModels: false,
      providerSelectors: ['*'],
    })
    assert.equal(repository.exists(), true)
    assert.equal(repository.read(), true)
    assert.deepEqual(repository.current.routes.map(route => ({
      provider: route.provider,
      name: route.name,
      baseURL: route.baseURL,
    })), [{
      provider: 'ccswitch/codex/example-provider',
      name: 'Example Provider',
      baseURL: 'https://example.test/v1',
    }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('uses CC Switch apiFormat and modelCatalog for Codex routes', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ccswitch-'))
  const dataDir = join(root, 'CC Switch Data')
  const dbPath = join(dataDir, 'cc-switch.db')
  mkdirSync(dataDir)

  try {
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE providers (
        id TEXT PRIMARY KEY,
        app_type TEXT NOT NULL,
        name TEXT NOT NULL,
        settings_config TEXT NOT NULL,
        meta TEXT NOT NULL,
        provider_type TEXT,
        sort_index INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE provider_endpoints (
        id INTEGER PRIMARY KEY,
        provider_id TEXT NOT NULL,
        app_type TEXT NOT NULL,
        url TEXT NOT NULL
      );
    `)
    db.prepare(`
      INSERT INTO providers (id, app_type, name, settings_config, meta, provider_type, sort_index)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      'agentrouter',
      'codex',
      'AgentRouter',
      JSON.stringify({
        OPENAI_API_KEY: 'test-key',
        config: 'model = "gpt-6.1-sol"\nmodel_provider = "custom"\n\n[model_providers.custom]\nbase_url = "https://agentrouter.org/v1"\nwire_api = "responses"\n',
        modelCatalog: {
          models: [
            { model: 'gpt-6.1-sol', displayName: 'gpt-6.1-sol', contextWindow: 128_000 },
            { model: 'deepseek-v4-flash', displayName: 'deepseek-v4-flash', contextWindow: 64_000 },
          ],
        },
      }),
      JSON.stringify({ apiFormat: 'openai_chat' }),
      null,
      0,
    )
    db.close()

    const repository = new CcSwitchRepository({
      dbPath,
      discoverModels: false,
      providerSelectors: ['*'],
    })
    assert.equal(repository.read(), true)
    const route = repository.current.routes[0]
    assert.equal(route.protocol, 'openai-completions')
    assert.equal(route.defaultModel, 'gpt-6.1-sol')
    assert.deepEqual(route.models, [
      { id: 'gpt-6.1-sol', name: 'gpt-6.1-sol', contextWindow: 128_000, maxTokens: 32_768 },
      { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', contextWindow: 64_000, maxTokens: 32_768 },
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('normalizes Gemini catalog ids without changing Claude or Codex ids', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ccswitch-'))
  const dataDir = join(root, 'CC Switch Data')
  const dbPath = join(dataDir, 'cc-switch.db')
  mkdirSync(dataDir)
  try {
    const db = new DatabaseSync(dbPath)
    db.exec(`CREATE TABLE providers (id TEXT PRIMARY KEY, app_type TEXT NOT NULL, name TEXT NOT NULL, settings_config TEXT NOT NULL, meta TEXT NOT NULL, provider_type TEXT, sort_index INTEGER NOT NULL DEFAULT 0); CREATE TABLE provider_endpoints (id INTEGER PRIMARY KEY, provider_id TEXT NOT NULL, app_type TEXT NOT NULL, url TEXT NOT NULL);`)
    const insert = db.prepare(`INSERT INTO providers (id, app_type, name, settings_config, meta, provider_type, sort_index) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    insert.run('claude', 'claude', 'Claude', JSON.stringify({ base_url: 'https://claude.example.test', model: 'claude-opus', modelCatalog: { models: [{ id: 'claude-opus', displayName: 'Claude Opus', contextWindow: '200000' }, { id: 'claude-haiku', displayName: 'Claude Haiku', contextWindow: '100000' }] } }), '{}', null, 0)
    insert.run('gemini', 'gemini', 'Gemini', JSON.stringify({ base_url: 'https://gemini.example.test', model: 'models/gemini-2.5-flash', modelCatalog: { models: [{ id: 'models/gemini-2.5-flash', displayName: 'Gemini Flash', contextWindow: '1000000' }, { id: 'gemini-2.5-pro', displayName: 'Gemini Pro', contextWindow: 'bad-value' }] } }), '{}', null, 0)
    insert.run('codex', 'codex', 'Codex', JSON.stringify({ OPENAI_API_KEY: 'test-key', config: 'model = "gpt-6.1-sol"\nmodel_provider = "custom"\n\n[model_providers.custom]\nbase_url = "https://example.test/v1"\nwire_api = "chat"\n', modelCatalog: { models: [{ id: 'gpt-6.1-sol', displayName: 'GPT 6.1 Sol', contextWindow: '128000' }] } }), JSON.stringify({ api_format: 'openai_responses' }), null, 0)
    db.close()
    const repository = new CcSwitchRepository({ dbPath, discoverModels: false, providerSelectors: ['*'] })
    assert.equal(repository.read(), true)
    const claude = repository.current.routes.find(route => route.appType === 'claude')
    const gemini = repository.current.routes.find(route => route.appType === 'gemini')
    const codex = repository.current.routes.find(route => route.appType === 'codex')
    assert.deepEqual(claude?.models.map(model => [model.id, model.contextWindow]), [['claude-opus', 200000], ['claude-haiku', 100000]])
    assert.equal(gemini?.defaultModel, 'gemini-2.5-flash')
    assert.deepEqual(gemini?.models.map(model => [model.id, model.contextWindow]), [['gemini-2.5-flash', 1000000], ['gemini-2.5-pro', 262144]])
    assert.equal(codex?.protocol, 'openai-responses')
    assert.equal(codex?.models[0]?.id, 'gpt-6.1-sol')
    assert.equal(codex?.models[0]?.contextWindow, 128000)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('uses metadata apiFormat before settings api format for Codex protocol', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ccswitch-'))
  const dataDir = join(root, 'CC Switch Data')
  const dbPath = join(dataDir, 'cc-switch.db')
  mkdirSync(dataDir)
  try {
    const db = new DatabaseSync(dbPath)
    db.exec(`CREATE TABLE providers (id TEXT PRIMARY KEY, app_type TEXT NOT NULL, name TEXT NOT NULL, settings_config TEXT NOT NULL, meta TEXT NOT NULL, provider_type TEXT, sort_index INTEGER NOT NULL DEFAULT 0); CREATE TABLE provider_endpoints (id INTEGER PRIMARY KEY, provider_id TEXT NOT NULL, app_type TEXT NOT NULL, url TEXT NOT NULL);`)
    const insert = db.prepare(`INSERT INTO providers (id, app_type, name, settings_config, meta, provider_type, sort_index) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    insert.run('codex', 'codex', 'Codex', JSON.stringify({ OPENAI_API_KEY: 'test-key', base_url: 'https://example.test/v1', apiFormat: 'openai_responses', api_format: 'openai_responses' }), JSON.stringify({ apiFormat: 'openai_chat', api_format: 'openai_responses' }), null, 0)
    db.close()
    const repository = new CcSwitchRepository({ dbPath, discoverModels: false, providerSelectors: ['*'] })
    assert.equal(repository.read(), true)
    assert.equal(repository.current.routes[0]?.protocol, 'openai-completions')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects non-safe catalog numbers', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ccswitch-'))
  const dataDir = join(root, 'CC Switch Data')
  const dbPath = join(dataDir, 'cc-switch.db')
  mkdirSync(dataDir)
  try {
    const db = new DatabaseSync(dbPath)
    db.exec(`CREATE TABLE providers (id TEXT PRIMARY KEY, app_type TEXT NOT NULL, name TEXT NOT NULL, settings_config TEXT NOT NULL, meta TEXT NOT NULL, provider_type TEXT, sort_index INTEGER NOT NULL DEFAULT 0); CREATE TABLE provider_endpoints (id INTEGER PRIMARY KEY, provider_id TEXT NOT NULL, app_type TEXT NOT NULL, url TEXT NOT NULL);`)
    const insert = db.prepare(`INSERT INTO providers (id, app_type, name, settings_config, meta, provider_type, sort_index) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    insert.run('codex', 'codex', 'Codex', JSON.stringify({ OPENAI_API_KEY: 'test-key', base_url: 'https://example.test/v1', modelCatalog: { models: [ { model: 'fractional', contextWindow: 0.5 }, { model: 'zero', contextWindow: 0 }, { model: 'huge', contextWindow: 1e30 }, { model: 'valid', contextWindow: '64000' } ] } }), '{}', null, 0)
    db.close()
    const repository = new CcSwitchRepository({ dbPath, discoverModels: false, providerSelectors: ['*'] })
    assert.equal(repository.read(), true)
    const models = repository.current.routes[0]?.models ?? []
    assert.equal(models.find(model => model.id === 'fractional')?.contextWindow, 262_144)
    assert.equal(models.find(model => model.id === 'zero')?.contextWindow, 262_144)
    assert.equal(models.find(model => model.id === 'huge')?.contextWindow, 262_144)
    assert.equal(models.find(model => model.id === 'valid')?.contextWindow, 64_000)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('keeps the first duplicate catalog entry and skips empty Gemini defaults', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ccswitch-'))
  const dataDir = join(root, 'CC Switch Data')
  const dbPath = join(dataDir, 'cc-switch.db')
  mkdirSync(dataDir)
  try {
    const db = new DatabaseSync(dbPath)
    db.exec(`CREATE TABLE providers (id TEXT PRIMARY KEY, app_type TEXT NOT NULL, name TEXT NOT NULL, settings_config TEXT NOT NULL, meta TEXT NOT NULL, provider_type TEXT, sort_index INTEGER NOT NULL DEFAULT 0); CREATE TABLE provider_endpoints (id INTEGER PRIMARY KEY, provider_id TEXT NOT NULL, app_type TEXT NOT NULL, url TEXT NOT NULL);`)
    const insert = db.prepare(`INSERT INTO providers (id, app_type, name, settings_config, meta, provider_type, sort_index) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    insert.run('codex', 'codex', 'Codex', JSON.stringify({ base_url: 'https://example.test/v1', modelCatalog: { models: [
      { model: 'duplicate', displayName: 'First', contextWindow: 64_000 },
      { model: 'duplicate' },
    ] } }), '{}', null, 0)
    insert.run('gemini', 'gemini', 'Gemini', JSON.stringify({ base_url: 'https://example.test/v1', modelCatalog: { models: [
      { model: 'models/' },
      { model: 'models/gemini-valid', displayName: 'Valid Gemini' },
    ] } }), '{}', null, 1)
    db.close()
    const repository = new CcSwitchRepository({ dbPath, discoverModels: false, providerSelectors: ['*'] })
    assert.equal(repository.read(), true)
    const codex = repository.current.routes.find(route => route.appType === 'codex')
    const gemini = repository.current.routes.find(route => route.appType === 'gemini')
    assert.deepEqual(codex?.models.map(model => [model.id, model.name, model.contextWindow]), [['duplicate', 'First', 64_000]])
    assert.equal(gemini?.defaultModel, 'gemini-valid')
    assert.deepEqual(gemini?.models.map(model => model.id), ['gemini-valid'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
