import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, Store, OpenAIClient, retrieve } from '../src/rag.mjs';

const original = JSON.parse(readFileSync('evaluation/questions.json', 'utf8'));
const second = JSON.parse(readFileSync('evaluation/round2/questions.json', 'utf8'));
const cases = [
  ['Q03', ['answered', 'partial'], ['전년도 12.31.현재'], ['2022년']],
  ['Q22', ['answered', 'partial'], ['청년몽땅정보통'], ['추가 조건은 없습니다']],
  ['Q28', ['insufficient', 'current_status'], [], ['현재 접수 중입니다']],
  ['N06', ['answered', 'partial'], ['500만원', '250만원', '4개월'], []],
  ['N11', ['answered', 'partial'], ['지원내용이 중복되지'], []],
  ['N12', ['answered', 'partial'], ['1.7%p'], ['최종 이율은 1.7']],
  ['N14', ['answered', 'partial'], ['20세 ~ 27세'], []],
  ['N19', ['answered', 'partial'], ['2회 분할'], []],
  ['N20', ['answered', 'partial'], ['3박 4일', '연 3회'], ['2박 3일', '꿈이룸']],
  ['N25', ['answered', 'partial'], ['임대(5년 이상) 계약한 경우 가능'], []],
  ['N26', ['insufficient'], [], []],
  ['N27', ['insufficient'], [], ['44세', '130%']],
  ['N28', ['personal'], [], []],
  ['N29', ['no_related'], [], []],
  ['N30', ['out_of_scope'], [], []],
].map(([id, statuses, required, forbidden]) => ({ ...[...original, ...second].find(item => item.id === id), statuses, required, forbidden }));

const config = loadConfig();
const store = new Store(join(config.root, '.rag', 'policies.sqlite'));
const client = new OpenAIClient(config);
const report = { startedAt: new Date().toISOString(), chatModel: config.chatModel,
  codeHashes: Object.fromEntries(['src/rag.mjs', 'src/grounding.mjs'].map(path => [path, createHash('sha256').update(readFileSync(path)).digest('hex')])), results: [] };
try {
  const vectors = await client.embed(cases.map(item => item.question));
  for (const [index, item] of cases.entries()) {
    let response, error;
    try {
      const results = await retrieve(store, item.question, config, { client: { embed: async () => [vectors[index]] } });
      response = await client.answer(item.question, results.map(row => row.policy));
      assert.ok(item.statuses.includes(response.status), `unexpected status: ${response.status}`);
      for (const text of item.required) assert.ok(response.answer.includes(text), `missing original evidence: ${text}`);
      for (const text of item.forbidden) assert.ok(!response.answer.includes(text), `unsupported text: ${text}`);
      for (const section of response.sections) {
        const policy = store.policy(section.policyKey);
        assert.ok(section.evidence.length);
        for (const proof of section.evidence) {
          const value = proof.path.split('.').reduce((record, key) => record?.[key], policy);
          assert.equal(proof.quote, value);
          assert.ok(!proof.path.includes('mapped_conditions'));
        }
      }
    } catch (caught) { error = caught.message; }
    report.results.push({ id: item.id, question: item.question, expectedStatuses: item.statuses, passed: !error, error, response });
    writeFileSync('evaluation/grounding-verification.json', JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log(`${report.results.length}/${cases.length} ${item.id} ${error ? '실패' : '통과'} (${response?.status || 'error'})${error ? ': ' + error : ''}`);
  }
  report.completedAt = new Date().toISOString();
  report.summary = { total: report.results.length, passed: report.results.filter(item => item.passed).length };
  writeFileSync('evaluation/grounding-verification.json', JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(report.summary));
  if (report.summary.passed !== report.summary.total) process.exitCode = 1;
} finally { store.close(); }
