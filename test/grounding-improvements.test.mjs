import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadPolicies, Store, retrieve, OpenAIClient } from '../src/rag.mjs';
import { selectPolicyScope, prepareGrounding, renderEvidenceSelection, questionPlan } from '../src/grounding.mjs';

const policies = loadPolicies(process.cwd()).policies;
const cases = JSON.parse(readFileSync('evaluation/round3/questions.json', 'utf8'));
const get = key => policies.find(p => p.policy_key === key);

test('generic terms never exclude designated policies before retrieval', () => {
  for (const id of ['T03', 'T07', 'T12', 'T18']) {
    const item = cases.find(q => q.id === id);
    const scope = selectPolicyScope(item.question, policies);
    assert.equal(scope.length, policies.length);
    assert.ok(scope.some(p => item.policyKeys.includes(p.policy_key)), id);
  }
});

test('previously excluded policies appear among top lexical results', async () => {
  const store = new Store(':memory:');
  try {
    store.sync(policies);
    for (const id of ['T03', 'T07', 'T12', 'T18']) {
      const item = cases.find(q => q.id === id);
      const results = await retrieve(store, item.question, { embeddingModel: 'test', dimensions: 3, topK: 3 }, { lexicalOnly: true });
      assert.ok(results.some(r => item.policyKeys.includes(r.policy.policy_key)), id);
    }
  } finally { store.close(); }
});

test('semantic topic coverage can select application information even outside method fields', () => {
  const policy = get('YOUTHCENTER-20260513005400213195');
  const context = prepareGrounding('부산온나청년패스의 신청 경로와 이용 절차를 알려줘', [policy]);
  assert.ok(context.evidence.some(item => item.path === 'benefit.text'));
  const ids = context.evidence.filter(item => ['benefit.text', 'application.method_text'].includes(item.path)).map(item => item.id);
  const result = renderEvidenceSelection(JSON.stringify({ outcome: 'supported', evidence_ids: ids, related_sources: [1], requested_topics: ['benefit', 'method'], missing_topics: [], jurisdiction: 'korea', requested_year: null }), context);
  assert.ok(result.answer.includes('신청즉시 발급, 실시간 승인'));
  assert.ok(result.answer.includes('QR코드 인식'));
  assert.ok(result.answer.includes('부산청년플랫폼'));
});

test('submission-route paraphrases and multiple requests are retained', () => {
  const policy = get('YOUTHCENTER-20260522005400213214');
  const context = prepareGrounding('지원금과 신청서는 어떤 경로로 제출해?', [policy]);
  assert.ok(context.plan.topics.includes('benefit') && context.plan.topics.includes('method'));
  const id = context.evidence.find(item => item.path === 'benefit.text').id;
  const result = renderEvidenceSelection(JSON.stringify({ outcome: 'supported', evidence_ids: [id], related_sources: [1], requested_topics: ['benefit', 'method'], missing_topics: [], jurisdiction: 'korea', requested_year: null }), context);
  assert.ok(result.answer.includes('프로젝트당 지원금 400만원'));
  assert.ok(result.answer.includes('담당자 이메일 제출'));
});

test('notice reason depends on related sources rather than a single model outcome', () => {
  const context = prepareGrounding('노숙인 등 복지 지원의 내용은?', [get('GOV24-135200005060')]);
  assert.equal(renderEvidenceSelection(JSON.stringify({ outcome: 'no_related', evidence_ids: [], related_sources: [1] }), context).status, 'insufficient');
  const unmatched = prepareGrounding('해저도시 정착지원금은 얼마야?', [get('GOV24-135200005060')]);
  assert.equal(renderEvidenceSelection(JSON.stringify({ outcome: 'insufficient', evidence_ids: [], related_sources: [] }), unmatched).status, 'no_related');
});

test('missing-topic notices cannot contradict quoted evidence or add unrequested information', () => {
  const policy = get('GOV24-313000000114');
  const context = prepareGrounding('이 융자의 한도와 연이율은 얼마야?', [policy]);
  const id = context.evidence.find(item => item.path === 'benefit.text').id;
  const result = renderEvidenceSelection(JSON.stringify({ outcome: 'supported', evidence_ids: [id], related_sources: [1], requested_topics: ['benefit'], missing_topics: ['benefit', 'organization', 'period', 'method'] }), context);
  assert.equal(result.status, 'answered');
  assert.deepEqual(result.missingTopics, []);
  assert.ok(!result.answer.includes('원문에서 확인하지 못한 항목'));
  const missing = prepareGrounding('이 융자의 신청 방법과 한도는?', [{ ...policy, application: { ...policy.application, method_text: null } }]);
  const partial = renderEvidenceSelection(JSON.stringify({ outcome: 'supported', evidence_ids: ['P1:benefit.text'], related_sources: [1], requested_topics: ['benefit', 'method'], missing_topics: [] }), missing);
  assert.equal(partial.status, 'partial');
  assert.ok(partial.missingTopics.includes('method'));
});

test('exact program existence cannot become a no-related notice', () => {
  const context = prepareGrounding('노숙인 등 복지 지원의 내용은?', [get('GOV24-135200005060')]);
  assert.equal(renderEvidenceSelection(JSON.stringify({ outcome: 'no_related', evidence_ids: [], related_sources: [] }), context).status, 'insufficient');
});

test('a named program cannot include the different conditions of an adjacent program', () => {
  const question = cases.find(item => item.id === 'T03').question;
  const context = prepareGrounding(question, [get('GOV24-138300000016'), {
    policy_key: 'unrelated-exit-grant', name: '가정폭력 피해자 보호시설 퇴소자 자립지원금',
    eligibility: { target_text: '입소기간이 4개월 이상인 퇴소자에게 자립지원금 지급' },
  }]);
  const selected = context.evidence.filter(item => item.topics.includes('eligibility')).map(item => item.id);
  const result = renderEvidenceSelection(JSON.stringify({ outcome: 'supported', evidence_ids: selected, related_sources: [1, 2], requested_topics: ['eligibility'], missing_topics: [] }), context);
  assert.equal(result.sections.length, 1);
  assert.equal(result.sections[0].policyKey, 'GOV24-138300000016');
  assert.ok(result.answer.includes('6개월 이상'));
  assert.ok(!result.answer.includes('4개월 이상'));
  assert.ok(result.discarded_evidence_count > 0);
});

test('personal reservations and other foreign jurisdictions are recognized without listing test cities', () => {
  assert.equal(questionPlan('부산 센터의 제 대관이 확정됐는지와 예약번호를 조회해줘').notice, 'personal');
  for (const question of ['캐나다 밴쿠버시에 사는 청년의 월세 보조금은?', '프랑스에 거주하는 청년의 주거 지원금은?', '호주 정부의 청년 월세 보조금은?']) assert.equal(questionPlan(question).notice, 'out_of_scope');
  assert.equal(questionPlan('북한이탈주민의 정착지원금은 얼마야?').notice, undefined);
});

test('missing monetary amounts produce information-missing rather than invented cash or nonexistent-policy claims', async () => {
  const client = new OpenAIClient({ apiKey: 'test-key', chatModel: 'test' });
  client.post = async () => { throw new Error('Must not invoke the model'); };
  const result = await client.answer('노숙인 등 복지 지원의 1인 정액 지급액은 얼마야?', [get('GOV24-135200005060')]);
  assert.equal(result.status, 'insufficient');
  assert.ok(!/\d+원/u.test(result.answer));
});

test('another retrieved program cannot supply a monetary amount missing from the named program', async () => {
  const client = new OpenAIClient({ apiKey: 'test-key', chatModel: 'test' });
  let called = false;
  client.post = async () => { called = true; throw new Error('Must not invoke model'); };
  const result = await client.answer('노숙인 등 복지 지원의 1인 정액 지급액은 얼마야?', [get('GOV24-135200005060'), get('GOV24-105100000001')]);
  assert.equal(result.status, 'insufficient');
  assert.equal(called, false);
});

test('version conflicts display original periods and modification dates and request clarification', () => {
  const records = [get('YOUTHCENTER-20260513005400213190'), get('YOUTHCENTER-20250517005400210846')];
  const context = prepareGrounding('부산 신진청년예술인 지원의 선발 인원은 몇 명이야?', records);
  const ids = context.evidence.filter(item => item.path === 'benefit.text').map(item => item.id);
  const result = renderEvidenceSelection(JSON.stringify({ outcome: 'supported', evidence_ids: ids, related_sources: [1, 2], requested_topics: ['benefit'], missing_topics: [], jurisdiction: 'korea', requested_year: null }), context);
  assert.equal(result.status, 'needs_clarification');
  assert.ok(result.answer.includes('20250717 ~ 20250717'));
  assert.ok(result.answer.includes('적용 연도와 다를 수 있음'));
  assert.ok(result.message.includes('적용 연도'));
  assert.ok(result.sections.every(section => section.evidence.every(evidence => typeof evidence.quote === 'string')));
});

test('typed decisions cannot add arbitrary topics, sources, years or uncited policy claims', () => {
  const context = prepareGrounding('지원 금액은?', [get('GOV24-105100000001')]);
  const id = context.evidence.find(item => item.path === 'benefit.text').id;
  for (const metadata of [{ requested_topics: ['free text 9999만원'] }, { related_sources: [2] }, { requested_year: '2026' }, { jurisdiction: 'anything' }, { related_sources: [] }]) {
    const result = renderEvidenceSelection(JSON.stringify({ outcome: 'supported', evidence_ids: [id], ...metadata }), context);
    assert.equal(result.status, 'blocked');
  }
});

test('inconsistent selections get one bounded repair against unchanged original evidence', async () => {
  const client = new OpenAIClient({ apiKey: 'test-key', chatModel: 'test' });
  const inputs = [];
  client.post = async (_, request) => {
    inputs.push(request.input);
    const data = JSON.parse(request.input);
    const id = data.evidence.find(item => item.path === 'benefit.text').id;
    const selection = { outcome: 'supported', evidence_ids: inputs.length === 1 ? [id, id] : [id], related_sources: [1] };
    return { status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(selection) }] }], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } };
  };
  const result = await client.answer('지원 금액은?', [get('GOV24-105100000001')]);
  assert.equal(result.status, 'answered');
  assert.equal(result.selection_attempts, 2);
  assert.deepEqual(result.repair_history, ['duplicate_evidence_ids']);
  assert.equal(inputs[0], inputs[1]);
  assert.equal(result.usage.total_tokens, 30);
  assert.ok(result.answer.includes('맞벌이 가구 최대 330만 원'));
});

test('failed repairs stay blocked after two attempts and never output the invalid response', async () => {
  const client = new OpenAIClient({ apiKey: 'test-key', chatModel: 'test' });
  let calls = 0;
  client.post = async () => { calls++; return { status: 'completed', output: [{ content: [{ type: 'output_text', text: '{"outcome":"supported","evidence_ids":["FAKE-9999"]}' }] }] }; };
  const result = await client.answer('지원 금액은?', [get('GOV24-105100000001')]);
  assert.equal(calls, 2);
  assert.equal(result.status, 'blocked');
  assert.ok(!result.answer.includes('9999'));
});

test('valid evidence survives while fields outside the declared related sources are discarded', () => {
  const context = prepareGrounding('지원 금액은?', [get('GOV24-105100000001'), get('YOUTHCENTER-20261113005400214853')]);
  const wanted = context.evidence.find(item => item.policyKey === 'GOV24-105100000001' && item.path === 'benefit.text');
  const other = context.evidence.find(item => item.policyKey === 'YOUTHCENTER-20261113005400214853' && item.path === 'benefit.text');
  const result = renderEvidenceSelection(JSON.stringify({ outcome: 'supported', evidence_ids: [wanted.id, other.id], related_sources: [wanted.source_number] }), context);
  assert.equal(result.status, 'answered');
  assert.equal(result.discarded_evidence_count, 1);
  assert.equal(result.sections.length, 1);
  assert.ok(result.answer.includes('맞벌이 가구 최대 330만 원'));
  assert.ok(!result.answer.includes('우리카드'));
  assert.ok(result.sections.every(section => section.policyKey === 'GOV24-105100000001'));
});
