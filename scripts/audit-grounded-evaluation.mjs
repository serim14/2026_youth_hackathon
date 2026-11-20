import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPolicies } from '../src/rag.mjs';
import { resolveSuiteDirectory } from '../src/evaluation.mjs';
import { NOTICES, prepareGrounding, renderEvidenceSelection, selectPolicyScope, questionPlan } from '../src/grounding.mjs';

const suiteIndex = process.argv.indexOf('--suite');
if (suiteIndex < 0 || !process.argv[suiteIndex + 1]) throw new Error('--suite 이름을 입력해 주세요.');
const directory = resolveSuiteDirectory(process.cwd(), process.argv[suiteIndex + 1]);
const report = JSON.parse(readFileSync(join(directory, 'results.json'), 'utf8'));
assert.ok(report.completedAt && report.results.length === 30);
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
assert.equal(report.codeHash, hash('src/rag.mjs'), 'RAG changed after evaluation');
assert.equal(report.groundingHash, hash('src/grounding.mjs'), 'Grounding changed after evaluation');
const policies = loadPolicies(process.cwd()).policies;
const byKey = new Map(policies.map(policy => [policy.policy_key, policy]));
const results = report.results.map(row => {
  const response = row.generated;
  let passed = false, error, evidenceCount = 0;
  try {
    assert.ok(response && !row.error, 'Missing answer');
    if (response.sections.length) {
      assert.ok(['answered', 'partial', 'needs_clarification'].includes(response.status));
      for (const section of response.sections) {
        const policy = byKey.get(section.policyKey);
        assert.ok(policy && section.evidence.length, 'Missing original policy/evidence');
        for (const evidence of section.evidence) {
          const value = evidence.path.split('.').reduce((object, key) => object?.[key], policy);
          assert.equal(evidence.quote, value, 'Quoted field differs from original');
          assert.ok(!evidence.path.includes('mapped_conditions'));
          evidenceCount++;
        }
      }
      const retrieved = row.retrieved.map(item => byKey.get(item.policy.policy_key));
      const context = prepareGrounding(row.question, retrieved);
      assert.ok(!context.response, 'Unexpected preflight notice');
      const selection = response.selection || { outcome: 'supported', evidence_ids: response.sections.map(section => section.evidence[0].id) };
      const rendered = renderEvidenceSelection(JSON.stringify(selection), context);
      assert.equal(response.answer, rendered.answer, 'Answer contains text outside source fields/templates');
      assert.deepEqual(response.sections, rendered.sections);
      assert.deepEqual(response.missingTopics, rendered.missingTopics);
      assert.equal(response.status, rendered.status);
    } else {
      assert.ok(Object.hasOwn(NOTICES, response.status), 'Unknown notice');
      assert.equal(response.answer, NOTICES[response.status], 'Notice contains arbitrary model text');
      assert.deepEqual(response.sources, []);
    }
    passed = true;
  } catch (caught) { error = caught.message; }
  const scope = selectPolicyScope(row.question, policies);
  const keys = new Set(scope.map(policy => policy.policy_key));
  return { id: row.id, status: response?.status, passed, error, evidenceCount,
    designatedPolicyRetrieved: row.grade.rank !== null,
    designatedPolicyExcludedByScope: row.acceptedPolicyKeys.length > 0 && row.acceptedPolicyKeys.every(key => !keys.has(key)),
    scopedPolicies: scope.length, requestedTopics: questionPlan(row.question).topics,
    selectedPolicies: response?.sections.map(section => section.policyKey) || [] };
});
const audit = { auditedAt: new Date().toISOString(), baselineFingerprint: report.fingerprint,
  definition: '원본 필드의 인용문 및 코드 템플릿과 출력이 일치하는지 검사한다. 질문 관련성·정답성·안내 사유의 적절성은 별도 검토한다.',
  summary: { total: results.length, sourceAndTemplateMatch: results.filter(row => row.passed).length,
    quotedFields: results.reduce((sum, row) => sum + row.evidenceCount, 0),
    answersWithQuotes: report.results.filter(row => row.generated?.sections.length).length,
    notices: report.results.filter(row => row.generated && !row.generated.sections.length).length,
    apiErrors: report.results.filter(row => row.error || row.generated?.status === 'service_error').length,
    validationBlocked: report.results.filter(row => row.generated?.status === 'blocked').length }, results };
writeFileSync(join(directory, 'grounding-audit.json'), JSON.stringify(audit, null, 2) + '\n', 'utf8');
console.log(JSON.stringify(audit.summary, null, 2));
for (const row of results.filter(row => !row.designatedPolicyRetrieved && row.designatedPolicyExcludedByScope)) console.log(`${row.id}: designated answer excluded by scope (${row.scopedPolicies} candidates)`);
if (audit.summary.sourceAndTemplateMatch !== results.length) process.exitCode = 1;
