import { join } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import { loadConfig, loadPolicies, chunkPolicy, Store, OpenAIClient, signature, indexEmbeddings, retrieve } from './rag.mjs';

const [command = 'help', ...args] = process.argv.slice(2);
const lexicalOnly = args.includes('--lexical');
const jsonOutput = args.includes('--json');
const positional = args.filter(arg => !arg.startsWith('--'));
let config;
let store;

function printSources(results) {
  results.forEach(({ policy }, i) => console.log(`[${i + 1}] ${policy.name}\n    ${policy.policy_key} | ${policy.source}\n    ${policy.source_url || '원문 URL 없음'}`));
}

try {
  config = loadConfig();
  if (command === 'inspect') {
    const corpus = loadPolicies(config.root);
    const dbPath = join(config.root, '.rag', 'policies.sqlite');
    if (existsSync(dbPath)) store = new Store(dbPath);
    console.log(JSON.stringify({ files: corpus.counts, policies: corpus.policies.length, duplicateCount: corpus.duplicateCount,
      chunks: corpus.policies.reduce((n, policy) => n + chunkPolicy(policy).length, 0),
      apiKeyConfigured: Boolean(config.apiKey), baseUrl: config.baseUrl, embeddingModel: config.embeddingModel, chatModel: config.chatModel,
      reviewRequired: corpus.policies.filter(policy => policy.review_decision === 'REVIEW').length,
      index: store?.stats(signature(config)) || null }, null, 2));
  } else if (command === 'index') {
    const client = lexicalOnly ? null : new OpenAIClient(config);
    const { policies } = loadPolicies(config.root);
    store = new Store(join(config.root, '.rag', 'policies.sqlite'));
    const chunks = store.sync(policies);
    console.log(`정책 ${policies.length}개, 청크 ${chunks}개 적재 완료.`);
    if (client) await indexEmbeddings(store, client, config, ({ done, total }) => console.log(`임베딩 ${done}/${total}`));
  } else if (command === 'search' || command === 'ask') {
    const question = positional.join(' ').trim();
    if (!question) throw new Error('질문을 입력해 주세요.');
    const client = command === 'ask' || !lexicalOnly ? new OpenAIClient(config) : null;
    store = new Store(join(config.root, '.rag', 'policies.sqlite'));
    const results = await retrieve(store, question, config, { client, lexicalOnly });
    if (!results.length && command === 'search') {
      console.log('관련 정책을 찾지 못했습니다. 지역, 정책명 또는 지원 분야를 구체적으로 입력해 주세요.');
    } else if (command === 'search') {
      if (jsonOutput) console.log(JSON.stringify(results, null, 2));
      else printSources(results);
    } else {
      const response = await client.answer(question, results.map(result => result.policy));
      if (jsonOutput) console.log(JSON.stringify(response, null, 2));
      else {
        console.log(response.answer);
        if (response.sources.length) {
          console.log('\n참고한 자료:');
          response.sources.forEach(policy => console.log(`[${policy.reference}] ${policy.name}\n    ${policy.policy_key} | ${policy.source}\n    ${policy.source_url || '원문 URL 없음'}`));
        }
      }
    }
  } else if (command === 'verify' && args.includes('--full')) {
    const client = new OpenAIClient(config);
    const { policies } = loadPolicies(config.root);
    store = new Store(join(config.root, '.rag', 'policies.sqlite'));
    const stats = store.stats(signature(config));
    if (stats.policies !== policies.length || !stats.chunks || stats.chunks !== stats.embedded) throw new Error('전체 임베딩 적재가 미완료입니다. 먼저 index를 실행해 주세요.');
    const expectedHashes = new Set(policies.flatMap(p => chunkPolicy(p)).map(c => c.hash));
    if (expectedHashes.size !== stats.chunks || store.chunks(signature(config)).some(c => !expectedHashes.has(c.hash))) throw new Error('원본 파일이 변경되었습니다. index를 다시 실행해 주세요.');
    const cases = [
      { question: '근로장려금 신청 자격', expectedKey: 'GOV24-105100000001' },
      { question: '강서염창 통합공공임대주택', expectedKey: 'LH-2015122300020807' },
      { question: '전남 가족돌봄 자기돌봄비', expectedKey: 'YOUTHCENTER-20261113005400214853' },
      { question: '일을 하지만 소득과 재산이 적은 가구를 위한 근로·자녀장려금의 지원 금액과 조건은?', expectedKey: 'GOV24-105100000001' },
    ];
    const checks = [];
    let answerResults;
    for (const item of cases) {
      const results = await retrieve(store, item.question, config, { client });
      const foundIndex = results.findIndex(row => row.policy.policy_key === item.expectedKey);
      const rank = foundIndex < 0 ? null : foundIndex + 1;
      checks.push({ ...item, rank, passed: rank !== null && rank <= 3,
        sources: results.map(row => ({ policyKey: row.policy.policy_key, name: row.policy.name })) });
      console.log(`${rank !== null && rank <= 3 ? '통과' : '실패'}: ${item.question} (정답 순위: ${rank ?? '없음'})`);
      answerResults = results;
    }
    const generated = await client.answer(cases.at(-1).question, answerResults.map(row => row.policy));
    const expectedReference = answerResults.findIndex(row => row.policy.policy_key === cases.at(-1).expectedKey) + 1;
    const citationPassed = expectedReference > 0 && [...generated.answer.matchAll(/\[(\d+)\]/g)].some(match => Number(match[1]) === expectedReference);
    const report = { checkedAt: new Date().toISOString(), chatModel: config.chatModel,
      embeddingModel: config.embeddingModel, dimensions: config.dimensions, index: stats,
      checks, hitAt1: checks.filter(c => c.rank === 1).length / checks.length,
      hitAt3: checks.filter(c => c.passed).length / checks.length,
      citationPassed, answer: generated.answer, usage: generated.usage,
      passed: checks.every(c => c.passed) && citationPassed };
    writeFileSync(join(config.root, '.rag', 'validation-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log('\n' + generated.answer);
    printSources(answerResults);
    console.log(`\n전체 검증: ${stats.policies}개 정책, ${stats.embedded}/${stats.chunks}개 임베딩, Hit@3 ${report.hitAt3 * 100}%, 정답 출처 인용 ${citationPassed ? '통과' : '실패'}`);
    console.log('검증 기록: .rag/validation-report.json (정해진 4개 질문에 대한 확인)');
    if (!report.passed) throw new Error('전체 검증에서 실패한 항목이 있습니다. 검증 기록을 확인해 주세요.');
  } else if (command === 'verify') {
    // End-to-end smoke test isolated from the full corpus index and its completion state.
    const client = new OpenAIClient(config);
    const { policies } = loadPolicies(config.root);
    const target = policies.find(policy => policy.policy_key === 'GOV24-105100000001');
    if (!target) throw new Error('검증용 근로·자녀장려금 정책이 없습니다.');
    const sample = [target, ...['LH', 'YOUTHCENTER', 'GOV24'].flatMap(source => policies.filter(p => p.source === source && p.policy_key !== target.policy_key).slice(0, 3))];
    store = new Store(join(config.root, '.rag', 'verification.sqlite'));
    store.sync(sample);
    await indexEmbeddings(store, client, config, ({ done, total }) => console.log(`검증용 임베딩 ${done}/${total}`));
    const question = '근로·자녀장려금의 지원 금액과 신청 조건을 알려줘';
    const results = await retrieve(store, question, config, { client });
    if (!results.slice(0, 3).some(result => result.policy.policy_key === target.policy_key)) throw new Error('검색 검증 실패: 정답 정책이 상위 3개에 없습니다.');
    const result = await client.answer(question, results.map(row => row.policy));
    console.log(result.answer);
    if (!/\[\d+\]/.test(result.answer)) throw new Error('답변 검증 실패: 출처 인용이 없습니다.');
    printSources(results);
    console.log(`\nAPI 검증 통과: ${sample.length}개 정책, ${signature(config)}, 검색 상위 3개 및 답변 출처 확인.`);
    console.log('이 검증은 표본에 대한 동작 확인입니다. 전체 적재는 node src/cli.mjs index를 실행하세요.');
  } else {
    console.log(`사용법 (Node.js 24 이상):
  node src/cli.mjs inspect
  node src/cli.mjs index --lexical        # 키 없이 텍스트 적재
  node src/cli.mjs search "근로장려금" --lexical
  node src/cli.mjs verify                 # API 표본 검증 (유료 호출)
  node src/cli.mjs verify --full          # 전체 인덱스 검색·답변 검증
  node src/cli.mjs index                  # 전체 임베딩 생성 (유료 호출, 재시작 가능)
  node src/cli.mjs ask "청년 주거 지원 알려줘"
  node src/cli.mjs ask "근로장려금 조건" --lexical
  node src/cli.mjs search "청년 주거 지원" --json
  node --test`);
    if (command !== 'help') process.exitCode = 1;
  }
} catch (error) {
  console.error(`오류: ${error.message}`);
  process.exitCode = 1;
} finally { store?.close(); }
