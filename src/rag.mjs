import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseEnv } from 'node:util';
import { answerWithEvidence, selectPolicyScope, policyMatchScore } from './grounding.mjs';

export function loadConfig(root = process.cwd(), environment = process.env) {
  const envPath = join(root, '.env');
  // Node's parser handles quoting and comments; never print the key.
  const values = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const local = values ? parseEnv(values) : {};
  const get = (names, fallback) => {
    const keys = Array.isArray(names) ? names : [names];
    for (const source of [environment, local]) {
      for (const key of keys) if (source[key]?.trim()) return source[key].trim();
    }
    return fallback;
  };
  const dimensions = Number(get('OPENAI_EMBEDDING_DIMENSIONS', '512'));
  const topK = Number(get('RAG_TOP_K', '5'));
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 3072) throw new Error('임베딩 차원은 1~3072 정수여야 합니다.');
  if (!Number.isInteger(topK) || topK < 1 || topK > 20) throw new Error('RAG_TOP_K는 1~20 정수여야 합니다.');
  const baseUrl = normalizeBaseUrl(get(['LLM_BASE_URL', 'OPENAI_BASE_URL'], 'https://api.openai.com/v1'));
  return {
    root: resolve(root), apiKey: get(['LLM_API_KEY', 'OPENAI_API_KEY'], ''), baseUrl,
    chatModel: get(['LLM_MODEL', 'OPENAI_CHAT_MODEL'], 'gpt-4.1-mini'),
    embeddingModel: get('OPENAI_EMBEDDING_MODEL', 'text-embedding-3-small'),
    dimensions, topK,
  };
}

export function normalizeBaseUrl(value = 'https://api.openai.com/v1') {
  let url;
  try { url = new URL(value); } catch { throw new Error('LLM_BASE_URL이 올바른 URL이 아닙니다.'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('LLM_BASE_URL은 HTTPS 또는 로컬 HTTP 주소여야 합니다.');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('LLM_BASE_URL에는 인증정보, 쿼리 또는 해시를 넣지 마세요.');
  return url.href.replace(/\/+$/, '');
}

export function loadPolicies(root) {
  // Intentionally load only JSON catalogs; matching CSVs are the same source.
  const files = readdirSync(root).filter(name => name.endsWith('_정책카탈로그_DB적재용.json')).sort();
  if (!files.length) throw new Error('정책카탈로그 JSON 파일이 없습니다.');
  const policies = new Map();
  const counts = {};
  let duplicateCount = 0;
  for (const file of files) {
    const records = JSON.parse(readFileSync(join(root, file), 'utf8').replace(/^\uFEFF/, ''));
    if (!Array.isArray(records)) throw new Error(`${file}: JSON 배열이 필요합니다.`);
    counts[file] = records.length;
    for (const record of records) {
      if (!record.id || !record.policy_key || !record.name || !record.source) throw new Error(`${file}: 필수 필드가 누락되었습니다.`);
      const policy = { ...record, filename: file };
      const key = record.policy_key;
      if (policies.has(key)) {
        if (JSON.stringify(policies.get(key)) !== JSON.stringify(policy)) throw new Error(`서로 다른 내용의 중복 policy_key: ${key}`);
        duplicateCount++;
      } else policies.set(key, policy);
    }
  }
  return { policies: [...policies.values()], counts, duplicateCount };
}

function flatten(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(flatten).filter(Boolean).join('\n');
  if (typeof value === 'object') return Object.entries(value).map(([k, v]) => {
    const text = flatten(v);
    return text ? `${k}: ${text}` : '';
  }).filter(Boolean).join('\n');
  return String(value).trim();
}

export function policyText(policy) {
  // Free-text conditions are authoritative; broad imported flags remain labelled.
  return [
    ['정책명', policy.name], ['출처', policy.source], ['기관', policy.organization],
    ['분야', policy.service_field], ['요약', policy.summary], ['지원내용', policy.benefit],
    ['신청정보', policy.application], ['지원대상', policy.eligibility?.target_text],
    ['선정조건', policy.eligibility?.criteria_text], ['대상별 상세', policy.eligibility?.target_sections],
    ['원본 매핑조건(검토 필요)', policy.eligibility?.mapped_conditions],
    ['검토상태', policy.review_decision], ['원본수정일', policy.source_modified_at_raw],
    ['원문링크', policy.source_url],
  ].map(([label, value]) => {
    const text = flatten(value);
    return text ? `${label}: ${text}` : '';
  }).filter(Boolean).join('\n');
}

export function chunkPolicy(policy, size = 1800, overlap = 180) {
  if (size <= overlap || overlap < 0) throw new Error('청크 크기는 중첩 길이보다 커야 합니다.');
  const body = Array.from(policyText(policy));
  const prefix = `정책: ${policy.name}\n정책키: ${policy.policy_key}\n`;
  const chunks = [];
  for (let start = 0; start < body.length; start += size - overlap) {
    const text = prefix + body.slice(start, start + size).join('');
    const hash = createHash('sha256').update(policy.policy_key + '\0' + text).digest('hex');
    chunks.push({ hash, policyKey: policy.policy_key, title: policy.name, text });
    if (start + size >= body.length) break;
  }
  return chunks;
}

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(resolve(path, '..'), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS policies (key TEXT PRIMARY KEY, record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks (hash TEXT PRIMARY KEY, policy_key TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS embeddings (hash TEXT NOT NULL, signature TEXT NOT NULL, vector BLOB NOT NULL, PRIMARY KEY(hash, signature));
    `);
  }
  close() { this.db.close(); }
  stats(signature) {
    return {
      policies: this.db.prepare('SELECT COUNT(*) AS count FROM policies').get().count,
      chunks: this.db.prepare('SELECT COUNT(*) AS count FROM chunks').get().count,
      embedded: this.db.prepare('SELECT COUNT(*) AS count FROM chunks c JOIN embeddings e ON c.hash=e.hash WHERE e.signature=?').get(signature).count,
    };
  }
  sync(policies) {
    const chunks = [...new Map(policies.flatMap(policy => chunkPolicy(policy)).map(chunk => [chunk.hash, chunk])).values()];
    const insertPolicy = this.db.prepare('INSERT INTO policies VALUES (?, ?)');
    const insertChunk = this.db.prepare('INSERT INTO chunks VALUES (?, ?, ?, ?)');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM chunks; DELETE FROM policies;');
      for (const p of policies) insertPolicy.run(p.policy_key, JSON.stringify(p));
      for (const c of chunks) insertChunk.run(c.hash, c.policyKey, c.title, c.text);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return chunks.length;
  }
  chunks(signature) {
    return this.db.prepare(`SELECT c.*, e.vector FROM chunks c LEFT JOIN embeddings e ON c.hash=e.hash AND e.signature=? ORDER BY c.hash`).all(signature);
  }
  saveVectors(rows, vectors, signature) {
    const insert = this.db.prepare('INSERT OR REPLACE INTO embeddings VALUES (?, ?, ?)');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      rows.forEach((row, i) => {
        const buffer = Buffer.alloc(vectors[i].length * 4);
        vectors[i].forEach((value, j) => buffer.writeFloatLE(value, j * 4));
        insert.run(row.hash, signature, buffer);
      });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  policy(key) {
    return JSON.parse(this.db.prepare('SELECT record FROM policies WHERE key=?').get(key).record);
  }
  policies() { return this.db.prepare('SELECT record FROM policies ORDER BY key').all().map(row => JSON.parse(row.record)); }
}

export function signature(config) { return `${normalizeBaseUrl(config.baseUrl)}|${config.embeddingModel}:${config.dimensions}`; }

export class OpenAIClient {
  constructor(config, fetcher = fetch, sleep = ms => new Promise(r => setTimeout(r, ms))) {
    if (!config.apiKey || config.apiKey === 'your_api_key_here') throw new Error('.env의 LLM_API_KEY 또는 OPENAI_API_KEY에 키를 입력해 주세요.');
    this.config = config;
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.fetcher = fetcher;
    this.sleep = sleep;
  }
  async post(endpoint, body) {
    for (let attempt = 0; attempt < 5; attempt++) {
      let response;
      try {
        response = await this.fetcher(`${this.baseUrl}/${endpoint}`, {
          method: 'POST', headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
        });
      } catch {
        if (attempt === 4) throw new Error('OpenAI 연결 실패: 네트워크 및 프록시 설정을 확인해 주세요.');
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      const result = await response.json();
      if (response.ok) return result;
      const code = result.error?.code || result.error?.type || 'unknown';
      if (code !== 'insufficient_quota' && (response.status === 429 || response.status >= 500) && attempt < 4) {
        const retrySeconds = Number(response.headers.get('retry-after'));
        await this.sleep(Math.min(30000, Math.max(1000 * 2 ** attempt, (retrySeconds || 0) * 1000)));
        continue;
      }
      // Do not echo a server message that might contain submitted credentials.
      const guidance = response.status === 401 ? 'API 키를 확인해 주세요.' : code === 'insufficient_quota' ? 'API 결제 및 잔액을 확인해 주세요.' : '모델 접근 권한, 사용량 한도 및 요청 설정을 확인해 주세요.';
      throw new Error(`OpenAI API HTTP ${response.status}: ${guidance}`);
    }
  }
  async embed(texts) {
    const result = await this.post('embeddings', {
      model: this.config.embeddingModel, input: texts,
      dimensions: this.config.dimensions, encoding_format: 'float',
    });
    const data = [...(result.data || [])].sort((a, b) => a.index - b.index);
    if (data.length !== texts.length || data.some((item, i) => item.index !== i || !Array.isArray(item.embedding) || item.embedding.length !== this.config.dimensions || item.embedding.some(n => !Number.isFinite(n)))) {
      throw new Error('임베딩 응답 개수 또는 차원이 올바르지 않습니다.');
    }
    return data.map(item => item.embedding);
  }
  async answer(question, policies, today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' })) {
    return answerWithEvidence(this, question, policies, today);
  }
}

export async function indexEmbeddings(store, client, config, report = () => {}) {
  const sig = signature(config);
  const chunks = store.chunks(sig);
  const pending = chunks.filter(chunk => !chunk.vector);
  let done = chunks.length - pending.length;
  report({ done, total: chunks.length });
  // Conservative character budget keeps Korean batches comfortably below token limits.
  while (pending.length) {
    const batch = [];
    let chars = 0;
    while (pending.length && batch.length < 32 && (chars + pending[0].text.length <= 24000 || !batch.length)) {
      const chunk = pending.shift();
      batch.push(chunk);
      chars += chunk.text.length;
    }
    const vectors = await client.embed(batch.map(row => row.text));
    store.saveVectors(batch, vectors, sig);
    done += batch.length;
    report({ done, total: chunks.length });
  }
  return { total: chunks.length, embedded: done };
}

function terms(text) {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return words.flatMap(word => {
    if (!/[가-힣]/.test(word) || word.length < 2) return [word];
    return [word, ...Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2))];
  });
}

export function keywordRank(chunks, question) {
  const query = [...new Set(terms(question))];
  const docs = chunks.map(chunk => {
    const tokens = terms(`${chunk.title} ${chunk.title} ${chunk.title} ${chunk.text}`);
    const counts = new Map();
    for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
    return { chunk, counts, titleTerms: new Set(terms(chunk.title)), length: tokens.length };
  });
  const avg = docs.reduce((sum, doc) => sum + doc.length, 0) / (docs.length || 1);
  const df = new Map(query.map(term => [term, docs.filter(doc => doc.counts.has(term)).length]));
  return docs.map(doc => ({ ...doc.chunk, score: query.reduce((sum, term) => {
    const frequency = doc.counts.get(term) || 0;
    const idf = Math.log(1 + (docs.length - df.get(term) + 0.5) / (df.get(term) + 0.5));
    const bodyScore = idf * frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * doc.length / (avg || 1)));
    return sum + bodyScore + (doc.titleTerms.has(term) ? idf * 2.5 : 0);
  }, 0) })).filter(row => row.score > 0).sort((a, b) => b.score - a.score);
}

export function cosine(blob, vector) {
  const bytes = Buffer.from(blob);
  if (bytes.length !== vector.length * 4) throw new Error('저장된 벡터 차원이 다릅니다. 인덱스를 다시 생성해 주세요.');
  let dot = 0, left = 0, right = 0;
  vector.forEach((b, i) => {
    const a = bytes.readFloatLE(i * 4);
    dot += a * b; left += a * a; right += b * b;
  });
  return left && right ? dot / Math.sqrt(left * right) : 0;
}

export function combineRankings(lexical, semantic = []) {
  // Normalize the actual scores instead of rewarding membership in both shortlists.
  // This preserves a strong policy-name match even when a long document embeds poorly.
  const maxLexical = lexical[0]?.score || 1;
  const maxSemantic = Math.max(semantic[0]?.score || 0, 0.000001);
  const lexicalScores = new Map(lexical.map(row => [row.hash, row.score / maxLexical]));
  const semanticScores = new Map(semantic.map(row => [row.hash, Math.max(0, row.score) / maxSemantic]));
  const candidates = new Map([...semantic.slice(0, 100), ...lexical.slice(0, 100)].map(row => [row.hash, row]));
  return [...candidates.values()].map(row => ({ ...row,
    score: (semantic.length ? 0.6 : 1) * (lexicalScores.get(row.hash) || 0)
      + 0.4 * (semanticScores.get(row.hash) || 0),
  })).filter(row => row.score > 0).sort((a, b) => b.score - a.score);
}

export async function retrieve(store, question, config, { client, lexicalOnly = false, source } = {}) {
  if (!question.trim()) throw new Error('질문을 입력해 주세요.');
  let chunks = store.chunks(signature(config));
  if (!chunks.length) throw new Error('검색할 데이터가 없습니다. 먼저 index --lexical을 실행해 주세요.');
  let scoped = selectPolicyScope(question, store.policies());
  if (source) scoped = scoped.filter(policy => policy.source === source);
  const policyKeys = new Set(scoped.map(policy => policy.policy_key));
  const byKey = new Map(scoped.map(policy => [policy.policy_key, policy]));
  chunks = chunks.filter(row => policyKeys.has(row.policy_key));
  if (!chunks.length) return [];
  const lexical = keywordRank(chunks, question);
  let semantic = [];
  if (!lexicalOnly) {
    if (chunks.some(row => !row.vector)) throw new Error('임베딩 인덱스가 미완료입니다. index를 실행하거나 --lexical로 검색해 주세요.');
    const [queryVector] = await client.embed([question]);
    semantic = chunks.map(row => ({ ...row, score: cosine(row.vector, queryVector) })).sort((a, b) => b.score - a.score);
  }
  const results = [];
  const seen = new Set();
  const ranked = combineRankings(lexical, semantic).map(row => ({ ...row, score: row.score + 0.3 * policyMatchScore(question, byKey.get(row.policy_key)) }))
    .sort((a, b) => b.score - a.score);
  for (const row of ranked) {
    if (seen.has(row.policy_key)) continue;
    seen.add(row.policy_key);
    results.push({ policy: store.policy(row.policy_key), score: row.score, matchedText: row.text });
    if (results.length === config.topK) break;
  }
  return results;
}
