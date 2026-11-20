import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPolicies, loadConfig, normalizeBaseUrl, chunkPolicy, policyText, Store, OpenAIClient, signature, indexEmbeddings, retrieve, cosine, combineRankings } from '../src/rag.mjs';

const config = { apiKey: 'test-key', embeddingModel: 'test-model', dimensions: 3, topK: 3, chatModel: 'test-chat' };
const policy = { id: 'one', policy_key: 'GOV24-one', name: '근로·자녀장려금', source: 'GOV24',
  summary: '소득과 재산이 적은 가구 지원', source_url: 'https://example.com/policy',
  benefit: { text: '최대 330만 원' }, eligibility: { criteria_text: '재산 2억4천만 원 미만' } };

test('CSV twins are ignored and conflicting JSON policy keys fail', () => {
  const root = mkdtempSync(join(tmpdir(), 'policy-rag-'));
  try {
    writeFileSync(join(root, 'A_정책카탈로그_DB적재용.json'), '\uFEFF' + JSON.stringify([policy]));
    writeFileSync(join(root, 'A_정책카탈로그_DB적재용.csv'), 'invalid,csv');
    assert.equal(loadPolicies(root).policies.length, 1);
    writeFileSync(join(root, 'B_정책카탈로그_DB적재용.json'), JSON.stringify([{ ...policy, name: '다른 내용' }]));
    assert.throws(() => loadPolicies(root), /중복 policy_key/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('nested benefit and eligibility survive chunking including tail and overlap', () => {
  const record = { ...policy, summary: '가'.repeat(4200) + '마지막내용' };
  const text = policyText(record);
  const chunks = chunkPolicy(record);
  assert.ok(text.includes('최대 330만 원') && text.includes('재산 2억4천만 원 미만'));
  assert.ok(chunks.length >= 3);
  assert.ok(chunks.every(chunk => chunk.text.includes(policy.name)));
  const bodies = chunks.map(chunk => chunk.text.split('\n').slice(2).join('\n'));
  assert.equal(bodies[0] + bodies.slice(1).map(body => Array.from(body).slice(180).join('')).join(''), text);
  assert.throws(() => chunkPolicy(policy, 10, 10));
});

test('indexing resumes from saved vectors and invalidates changed text/model', async () => {
  const store = new Store(':memory:');
  let calls = 0;
  const client = { embed: async texts => { calls++; return texts.map(() => [1, 0, 0]); } };
  try {
    store.sync([policy]);
    await indexEmbeddings(store, client, config);
    store.sync([policy]);
    await indexEmbeddings(store, client, config);
    assert.equal(calls, 1);
    store.sync([{ ...policy, summary: '변경된 지원내용' }]);
    await indexEmbeddings(store, client, config);
    assert.equal(calls, 2);
    await indexEmbeddings(store, client, { ...config, embeddingModel: 'other' });
    assert.equal(calls, 3);
  } finally { store.close(); }
});

test('completed batches survive an interrupted embedding job', async () => {
  const store = new Store(':memory:');
  const records = Array.from({ length: 45 }, (_, i) => ({ ...policy, id: `id${i}`, policy_key: `key${i}` }));
  let calls = 0;
  try {
    store.sync(records);
    await assert.rejects(indexEmbeddings(store, { embed: async texts => {
      if (++calls === 2) throw new Error('interrupted');
      return texts.map(() => [1, 0, 0]);
    } }, config), /interrupted/);
    const saved = store.chunks(signature(config)).filter(row => row.vector).length;
    assert.ok(saved > 0 && saved < records.length);
    let remaining = 0;
    await indexEmbeddings(store, { embed: async texts => { remaining += texts.length; return texts.map(() => [1, 0, 0]); } }, config);
    assert.equal(remaining, records.length - saved);
  } finally { store.close(); }
});

test('hybrid search deduplicates policy chunks and rejects incomplete indexes', async () => {
  const store = new Store(':memory:');
  try {
    store.sync([{ ...policy, summary: '장려금 '.repeat(1300) }, { ...policy, policy_key: 'LH-two', name: '임대주택', source: 'LH' }]);
    await assert.rejects(retrieve(store, '장려금', config, { client: {} }), /미완료/);
    const client = { embed: async texts => texts.map(() => [1, 0, 0]) };
    await indexEmbeddings(store, client, config);
    const rows = await retrieve(store, '장려금', config, { client });
    assert.equal(new Set(rows.map(row => row.policy.policy_key)).size, rows.length);
    assert.equal(rows[0].policy.policy_key, policy.policy_key);
    assert.ok(rows.every(row => row.policy.benefit.text === policy.benefit.text));
    const filtered = await retrieve(store, '임대주택', config, { lexicalOnly: true, source: 'LH' });
    assert.equal(filtered[0].policy.source, 'LH');
  } finally { store.close(); }
});

test('cosine handles zero vectors and dimension mismatch', () => {
  const blob = Buffer.alloc(12); blob.writeFloatLE(1, 0);
  assert.equal(cosine(blob, [1, 0, 0]), 1);
  assert.equal(cosine(blob, [0, 0, 0]), 0);
  assert.throws(() => cosine(blob, [1]), /차원/);
});

test('fusion preserves strong lexical evidence outside the semantic shortlist and supports semantic-only matches', () => {
  const lexical = [{ hash: 'target', score: 50.2 }, { hash: 'other', score: 38.5 }];
  const semantic = [{ hash: 'other', score: 0.523 },
    ...Array.from({ length: 110 }, (_, i) => ({ hash: `noise${i}`, score: 0.51 - i * 0.0001 })),
    { hash: 'target', score: 0.404 }];
  assert.equal(combineRankings(lexical, semantic)[0].hash, 'target');
  assert.equal(combineRankings([], semantic)[0].hash, 'other');
  assert.equal(combineRankings(lexical)[0].hash, 'target');
  assert.deepEqual(combineRankings([], []), []);
});

test('OpenAI embedding request authenticates and sorts response indexes', async () => {
  const client = new OpenAIClient(config, async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/embeddings');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(options.body);
    assert.equal(body.dimensions, 3);
    assert.deepEqual(body.input, ['a', 'b']);
    return Response.json({ data: [{ index: 1, embedding: [0, 1, 0] }, { index: 0, embedding: [1, 0, 0] }] });
  });
  assert.deepEqual(await client.embed(['a', 'b']), [[1, 0, 0], [0, 1, 0]]);
});

test('OpenAI rejects malformed embeddings', async () => {
  const client = new OpenAIClient(config, async () => Response.json({ data: [{ index: 0, embedding: [1] }] }));
  await assert.rejects(client.embed(['a']), /차원/);
});

test('rate limits retry, quota errors do not retry or leak the server message', async () => {
  let calls = 0;
  const client = new OpenAIClient(config, async () => {
    if (++calls === 1) return Response.json({ error: { code: 'rate_limit_exceeded' } }, { status: 429 });
    return Response.json({ data: [{ index: 0, embedding: [1, 0, 0] }] });
  }, async () => {});
  await client.embed(['a']);
  assert.equal(calls, 2);
  const quota = new OpenAIClient(config, async () => Response.json({ error: { code: 'insufficient_quota', message: 'secret test-key' } }, { status: 429 }));
  await assert.rejects(quota.embed(['a']), error => /잔액/.test(error.message) && !error.message.includes('test-key'));
});

test('full local corpus has no CSV duplication and expected policies rank in top 3', async () => {
  const corpus = loadPolicies(process.cwd());
  assert.equal(corpus.policies.length, 4610);
  assert.equal(Object.keys(corpus.counts).length, 3);
  const store = new Store(':memory:');
  try {
    store.sync(corpus.policies);
    for (const [query, expected] of [
      ['근로장려금 신청 자격', 'GOV24-105100000001'],
      ['강서염창 통합공공임대주택', 'LH-2015122300020807'],
      ['전남 가족돌봄 자기돌봄비', 'YOUTHCENTER-20261113005400214853'],
    ]) {
      const results = await retrieve(store, query, config, { lexicalOnly: true });
      assert.ok(results.some(row => row.policy.policy_key === expected), `${query}: ${results.map(r => r.policy.name).join(', ')}`);
    }
  } finally { store.close(); }
});

test('missing credentials fail before any network call', () => {
  assert.throws(() => new OpenAIClient({ ...config, apiKey: '' }), /OPENAI_API_KEY/);
  assert.ok(loadConfig().dimensions > 0);
});

test('user LLM variable names work without changing .env and process settings take precedence', () => {
  const root = mkdtempSync(join(tmpdir(), 'policy-rag-config-'));
  try {
    writeFileSync(join(root, '.env'), 'LLM_API_KEY=local-test-key\nLLM_BASE_URL=https://example.com/api/v1/\nLLM_MODEL=gpt-4o-mini\nKAKAO_REST_API_KEY=unrelated-key\n');
    const local = loadConfig(root, {});
    assert.equal(local.apiKey, 'local-test-key');
    assert.equal(local.baseUrl, 'https://example.com/api/v1');
    assert.equal(local.chatModel, 'gpt-4o-mini');
    assert.equal(local.embeddingModel, 'text-embedding-3-small');
    assert.equal(local.dimensions, 512);
    assert.equal(loadConfig(root, { OPENAI_API_KEY: 'process-test-key' }).apiKey, 'process-test-key');
    assert.equal(loadConfig(root, { OPENAI_CHAT_MODEL: 'process-model' }).chatModel, 'process-model');
    assert.equal(loadConfig(root, { LLM_API_KEY: ' ', OPENAI_API_KEY: 'fallback-key' }).apiKey, 'fallback-key');
    assert.notEqual(signature(local), signature({ ...local, baseUrl: 'https://other.example.com/v1' }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('configured base URL is used for requests and insecure or credential-bearing URLs fail', async () => {
  for (const url of ['invalid', 'http://example.com/v1', 'https://user:password@example.com/v1', 'https://example.com/v1?key=secret', 'https://example.com/v1#secret']) {
    assert.throws(() => normalizeBaseUrl(url));
  }
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8000/v1/'), 'http://127.0.0.1:8000/v1');
  const client = new OpenAIClient({ ...config, baseUrl: 'https://example.com/proxy/v1/' }, async url => {
    assert.equal(url, 'https://example.com/proxy/v1/embeddings');
    return Response.json({ data: [{ index: 0, embedding: [1, 0, 0] }] });
  });
  await client.embed(['a']);
});
