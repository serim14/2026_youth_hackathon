import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadPolicies } from '../src/rag.mjs';
import { prepareCases, gradeCase, summarize, markdownReport, resolveSuiteDirectory } from '../src/evaluation.mjs';
import { join } from 'node:path';

const item = { id: 'Q', category: '정책명', question: '지원 금액?', policyKeys: ['gold'], facts: [{ label: '330만원', pattern: '330\\s*만원' }] };
const retrieved = [{ policy: { policy_key: 'other' } }, { policy: { policy_key: 'gold' } }];

test('all 30 benchmark gold answers are grounded before any API request', () => {
  const questions = JSON.parse(readFileSync('evaluation/questions.json', 'utf8'));
  const cases = prepareCases(questions, loadPolicies(process.cwd()).policies);
  assert.equal(cases.length, 30);
  assert.equal(cases.filter(q => q.requireAbstention).length, 2);
  assert.equal(cases.filter(q => q.category === '정보부족').length, 3);
  assert.ok(cases.every(q => q.policyKeys.every(key => q.acceptedPolicyKeys.includes(key))));
  assert.throws(() => prepareCases(questions.slice(1), []), /30/);
});

test('round 2 has 30 new questions and disjoint gold policy records', () => {
  const policies = loadPolicies(process.cwd()).policies;
  const original = prepareCases(JSON.parse(readFileSync('evaluation/questions.json', 'utf8')), policies);
  const next = prepareCases(JSON.parse(readFileSync('evaluation/round2/questions.json', 'utf8')), policies);
  const oldKeys = new Set(original.flatMap(q => q.acceptedPolicyKeys));
  const oldQuestions = new Set(original.map(q => q.question));
  assert.equal(next.length, 30);
  assert.ok(next.every(q => !oldQuestions.has(q.question)));
  assert.ok(next.every(q => q.acceptedPolicyKeys.every(key => !oldKeys.has(key))));
  assert.equal(next.filter(q => q.category === '정보부족').length, 3);
  assert.equal(next.filter(q => q.requireAbstention).length, 2);
});

test('suite output directories preserve original results and reject path traversal', () => {
  const root = process.cwd();
  assert.equal(resolveSuiteDirectory(root), join(root, 'evaluation'));
  assert.equal(resolveSuiteDirectory(root, 'round2'), join(root, 'evaluation', 'round2'));
  for (const value of ['../other', '..\\other', '/tmp', 'C:\\other', 'round2/results']) assert.throws(() => resolveSuiteDirectory(root, value));
});

test('retrieving the gold policy alone does not pass the answer', () => {
  const grade = gradeCase(item, retrieved, { sections: [{ policyKey: 'gold', explanation: '자료 확인 필요' }], message: '' });
  assert.equal(grade.rank, 2);
  assert.equal(grade.hitAt3, true);
  assert.equal(grade.answerPassed, false);
});

test('facts in an unrelated citation or auto-appended disclaimer earn no credit', () => {
  const grade = gradeCase(item, retrieved, { answer: '330만원', sections: [{ policyKey: 'other', explanation: '330만원' }], message: '' });
  assert.equal(grade.factsPassed, 0);
  assert.equal(grade.citationPassed, false);
  assert.equal(grade.answerPassed, false);
  assert.equal(gradeCase(item, retrieved, { sections: [{ policyKey: 'gold', explanation: '330 만원' }], message: '' }).answerPassed, true);
});

test('missing-information and out-of-scope questions require appropriate abstention', () => {
  const unknown = { ...item, category: '정보부족', facts: [{ label: '확인 불가', pattern: '확인 불가' }], forbiddenPatterns: ['18시 마감'] };
  assert.equal(gradeCase(unknown, retrieved, { sections: [], message: '확인 불가' }).answerPassed, true);
  assert.equal(gradeCase(unknown, retrieved, { sections: [{ policyKey: 'gold', explanation: '확인 불가. 18시 마감' }], message: '' }).answerPassed, false);
  const outside = { ...unknown, category: '범위밖', policyKeys: [], requireAbstention: true };
  assert.equal(gradeCase(outside, retrieved, { sections: [], message: '확인 불가' }).answerPassed, true);
  assert.equal(gradeCase(outside, retrieved, { sections: [{ policyKey: 'other', explanation: '확인 불가' }], message: '' }).answerPassed, false);
});

test('retrieval denominator excludes cases with no gold policy', () => {
  const normal = { ...item, grade: gradeCase(item, retrieved, { sections: [{ policyKey: 'gold', explanation: '330만원' }], message: '' }) };
  const outside = { ...item, policyKeys: [], category: '범위밖', requireAbstention: true, facts: [{ label: '확인 불가', pattern: '확인 불가' }] };
  const negative = { ...outside, grade: gradeCase(outside, [], { sections: [], message: '확인 불가' }) };
  const summary = summarize([normal, negative]);
  assert.equal(summary.total, 2);
  assert.equal(summary.retrievalTotal, 1);
  assert.equal(summary.hitAt1, 0);
  assert.equal(summary.hitAt3, 1);
  assert.equal(summary.meanReciprocalRank, 0.5);
  assert.equal(summary.answerCorrect, 2);
  assert.ok(markdownReport({ startedAt: 'test', models: { chatModel: 'test', topK: 5 }, summary, results: [] }).includes('2/2 (100.0%)'));
});
