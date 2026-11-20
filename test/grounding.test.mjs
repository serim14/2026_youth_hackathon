import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPolicies, Store, OpenAIClient, retrieve } from '../src/rag.mjs';
import { NOTICES, questionPlan, selectPolicyScope, buildEvidence, prepareGrounding, renderEvidenceSelection } from '../src/grounding.mjs';

const config = { apiKey: 'test-key', chatModel: 'test-model', embeddingModel: 'test-embedding', dimensions: 3, topK: 5 };
const records = loadPolicies(process.cwd()).policies;
const get = key => records.find(policy => policy.policy_key === key);
const resultOf = selection => Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(selection) }] }] });
const supported = evidence => JSON.stringify({ outcome: 'supported', evidence_ids: evidence.map(item => item.id) });

test('response schema permits evidence IDs only; all displayed facts are copied from original fields', async () => {
  const policy = get('GOV24-105100000001');
  const question = '근로장려금 지원금액과 자격 조건을 알려줘';
  const client = new OpenAIClient(config, async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const request = JSON.parse(options.body);
    assert.equal(request.store, false);
    assert.equal(request.text.format.strict, true);
    assert.equal(request.text.format.schema.additionalProperties, false);
    assert.deepEqual(Object.keys(request.text.format.schema.properties).sort(), ['evidence_ids', 'jurisdiction', 'missing_topics', 'outcome', 'related_sources', 'requested_topics', 'requested_year']);
    const body = JSON.parse(request.input);
    assert.ok(body.evidence.every(item => item.quote && item.path && item.id));
    assert.ok(body.evidence.every(item => !item.path.includes('mapped_conditions')));
    return resultOf({ outcome: 'supported', evidence_ids: body.evidence.filter(item => ['benefit.text', 'eligibility.criteria_text'].includes(item.path)).map(item => item.id) });
  });
  const result = await client.answer(question, [policy]);
  assert.equal(result.status, 'answered');
  assert.equal(result.sections[0].policyKey, policy.policy_key);
  assert.equal(result.sections[0].evidence[0].quote, policy.benefit.text);
  assert.ok(result.answer.includes('전년도 12.31.현재'));
  assert.ok(!result.answer.includes('2022년'));
  assert.equal(result.sources[0].reference, 1);
});

test('fabricated prose, unknown fields, duplicate evidence and malformed output are blocked', () => {
  const context = prepareGrounding('지원 금액 알려줘', [get('GOV24-105100000001')]);
  const id = context.evidence[0].id;
  for (const selection of [
    { outcome: 'supported', evidence_ids: [id], explanation: '최대 9999만원을 줍니다.' },
    { outcome: 'supported', evidence_ids: ['P1:eligibility.mapped_conditions'] },
    { outcome: 'supported', evidence_ids: ['P2:benefit.text'] },
    { outcome: 'supported', evidence_ids: [id, id] },
    { outcome: 'not-a-status', evidence_ids: [id] },
    null,
  ]) {
    const result = renderEvidenceSelection(JSON.stringify(selection), context);
    assert.equal(result.status, 'blocked');
    assert.equal(result.sections.length, 0);
    assert.ok(!result.answer.includes('9999'));
  }
  assert.equal(renderEvidenceSelection('bad JSON', context).status, 'blocked');
  const entry = context.evidence.find(item => item.id === id);
  entry.quote = '원본에 없는 9999만원';
  assert.equal(renderEvidenceSelection(supported([entry]), context).status, 'blocked');
});

test('empty LH eligibility and rent fields cannot be filled with general program knowledge', async () => {
  let called = false;
  const client = new OpenAIClient(config, async () => { called = true; throw new Error('not allowed'); });
  for (const [question, key] of [
    ['LH 신혼·신생아 매입임대Ⅱ 공고의 소득 상한과 연령 제한은?', 'LH-2015122300020749'],
    ['LH 청년 매입임대 공고의 보증금과 월 임대료는 얼마야?', 'LH-2015122300020759'],
  ]) {
    const result = await client.answer(question, [get(key)]);
    assert.equal(result.status, 'insufficient');
    assert.equal(result.answer, NOTICES.insufficient);
    assert.equal(result.sections.length, 0);
    assert.ok(!/130%|44세/.test(result.answer));
  }
  assert.equal(called, false);
});

test('no relevant policy, out-of-scope and personal-history requests return fixed notices', async () => {
  let calls = 0;
  const client = new OpenAIClient(config, async () => { calls++; throw new Error('not allowed'); });
  assert.equal((await client.answer('지원 정책 알려줘', [])).status, 'no_related');
  assert.equal((await client.answer('서울 영테크 제 개인 신청서의 접수번호와 승인 여부는?', records.slice(0, 2))).status, 'personal');
  assert.equal((await client.answer('도쿄도의 월세 지원액을 확정해줘', records.slice(0, 2))).status, 'out_of_scope');
  assert.equal((await client.answer("'전국 청년 평생소득' 신청 방법 알려줘", records)).status, 'no_related');
  assert.equal(calls, 0);
});

test('explicitly requested facility and region are respected before ranking', async () => {
  const scoped = selectPolicyScope('대구 희망옷장에서 면접 정장을 빌리려면?', records);
  assert.ok(scoped.some(policy => policy.policy_key === 'YOUTHCENTER-20261021005400214170'));
  assert.ok(scoped.every(policy => !policy.name.includes('꿈이룸')));
  assert.equal(scoped[0].policy_key, 'YOUTHCENTER-20261021005400214170');
  assert.ok(scoped.some(policy => policy.source_url?.includes('yongin')), 'Ranking keeps other regions as candidates');
  const store = new Store(':memory:');
  try {
    store.sync(records);
    const rows = await retrieve(store, '대구 희망옷장에서 세탁비와 대여 기간은?', config, { lexicalOnly: true });
    assert.equal(rows[0].policy.policy_key, 'YOUTHCENTER-20261021005400214170');
    assert.deepEqual(await retrieve(store, "'전국 청년 평생소득' 지원금", config, { lexicalOnly: true }), []);
  } finally { store.close(); }
});

test('whole fields retain applicant lease obligations and exceptions without model summarization', () => {
  const policy = get('YOUTHCENTER-20261021005400214181');
  const context = prepareGrounding('가업승계 지원에서 임대 경작과 임대 계약 예외 조건은?', [policy]);
  const evidence = context.evidence.filter(item => item.path === 'benefit.text');
  const result = renderEvidenceSelection(supported(evidence), context);
  assert.equal(result.sections[0].evidence[0].quote, policy.benefit.text);
  assert.ok(result.answer.includes('임대(5년 이상) 계약한 경우 가능'));
  assert.ok(result.answer.includes('5년 이상 (조)부모가 임대'));
});

test('selecting one eligibility field cannot omit the benefit requested in the same question', () => {
  const record = get('GOV24-138300000053');
  const context = prepareGrounding('피해자와 동반아동에게 각각 얼마를 지원하고 입소기간 요건은?', [record]);
  const target = context.evidence.find(item => item.path === 'eligibility.target_text');
  const result = renderEvidenceSelection(supported([target]), context);
  assert.ok(result.answer.includes('피해자 500만원'));
  assert.ok(result.answer.includes('동반아동 250만원'));
  assert.ok(result.answer.includes('4개월 이상'));
});

test('specific program names do not borrow application dates from neighboring programs', () => {
  const scoped = selectPolicyScope('전남 가족돌봄청년 자기돌봄비가 오늘 접수 중이야?', records);
  assert.ok(scoped.some(record => record.policy_key === 'YOUTHCENTER-20261113005400214853'));
  assert.ok(scoped.some(record => record.policy_key === 'YOUTHCENTER-20261113005400214853'));
  const context = prepareGrounding('자기돌봄비가 오늘 접수 중이야? 현재 상태와 마감일은?', scoped);
  assert.equal(context.response.status, 'current_status');
});

test('interest increment is never rewritten as a final interest rate', () => {
  const policy = get('GOV24-161300000088');
  const context = prepareGrounding('청년주택드림 통장의 우대금리 가산폭과 최종 이율은 얼마야?', [policy]);
  const result = renderEvidenceSelection(supported(context.evidence.filter(item => item.path === 'benefit.text')), context);
  assert.ok(result.answer.includes('우대금리 1.7%p 적용'));
  assert.ok(!result.answer.includes('최종 이율은 1.7'));
  assert.ok(result.missingTopics.includes('final_rate'));
  assert.equal(result.status, 'partial');
});

test('missing requested facets are reported even when other eligibility details exist', () => {
  const record = { policy_key: 'p', name: '청년 지원', source: 'TEST', eligibility: { target_text: '19세 이상 39세 이하 청년' } };
  const context = prepareGrounding('연령과 소득 기준은?', [record]);
  const result = renderEvidenceSelection(supported(context.evidence), context);
  assert.equal(result.status, 'partial');
  assert.ok(result.missingTopics.includes('income'));
  assert.ok(result.message.includes('소득 기준'));
  const missingOnly = prepareGrounding('정확한 소득 기준은?', [record]);
  assert.equal(missingOnly.response.status, 'insufficient');
});

test('current application status cannot be inferred from an old catalog date', async () => {
  const client = new OpenAIClient(config, async () => { throw new Error('should not run'); });
  const result = await client.answer('이 공고 지금 접수 중이야?', [get('LH-2015122300020749')]);
  assert.equal(result.status, 'current_status');
  assert.ok(result.answer.includes('확정할 수 없습니다'));
});

test('partial deadline evidence does not invent a closing date or time', () => {
  const context = prepareGrounding('LH 공고의 신청 마감일과 마감 시각은?', [get('LH-2015122300020749')]);
  assert.equal(context.response?.status, 'insufficient');
});

test('API errors, refusals and truncated selections produce distinct safe notices', async () => {
  const policies = [get('GOV24-105100000001')];
  const client = new OpenAIClient(config);
  client.post = async () => { throw new Error('secret-test-key'); };
  const error = await client.answer('지원 금액 알려줘', policies);
  assert.equal(error.status, 'service_error');
  assert.ok(!error.answer.includes('secret'));
  client.post = async () => ({ status: 'incomplete', output: [] });
  assert.equal((await client.answer('지원 금액 알려줘', policies)).status, 'blocked');
  client.post = async () => ({ status: 'completed', output: [{ content: [{ type: 'refusal' }] }] });
  assert.equal((await client.answer('지원 금액 알려줘', policies)).status, 'blocked');
});

test('model cannot smuggle arbitrary text through a negative outcome or missing evidence', () => {
  const context = prepareGrounding('지원 금액 알려줘', [get('GOV24-105100000001')]);
  const result = renderEvidenceSelection(JSON.stringify({ outcome: 'no_related', evidence_ids: [], message: '무조건 9999만원' }), context);
  assert.equal(result.status, 'blocked');
  const negative = renderEvidenceSelection(JSON.stringify({ outcome: 'no_related', evidence_ids: [] }), context);
  assert.equal(negative.answer, NOTICES.no_related);
  assert.equal(renderEvidenceSelection(supported([]), context).status, 'insufficient');
});
