import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadPolicies } from '../src/rag.mjs';
import { resolveSuiteDirectory } from '../src/evaluation.mjs';

const index = process.argv.indexOf('--suite');
if (index < 0 || !process.argv[index + 1]) throw new Error('--suite 이름을 입력해 주세요.');
const directory = resolveSuiteDirectory(process.cwd(), process.argv[index + 1]);
const acceptance = JSON.parse(readFileSync(join(directory, 'acceptance.json'), 'utf8'));
const before = JSON.parse(readFileSync(acceptance.baseline, 'utf8'));
const after = JSON.parse(readFileSync(join(directory, 'results.json'), 'utf8'));
assert.ok(after.completedAt && before.completedAt);
assert.equal(readFileSync(join(directory, 'questions.json'), 'utf8'), readFileSync(acceptance.questionSource, 'utf8'));
assert.deepEqual(after.models, before.models);
assert.equal(after.corpusHash, before.corpusHash);
assert.deepEqual(after.goldCases, before.goldCases);
const policies = new Map(loadPolicies(process.cwd()).policies.map(policy => [policy.policy_key, policy]));

function quality(row) {
  const failures = [];
  if (!row.grade.answerPassed) failures.push('핵심 원본 사실·인용 미충족');
  const expected = acceptance.requiredStatuses[row.id] || acceptance.positiveStatuses;
  if (!expected.includes(row.generated?.status)) failures.push(`안내 상태 ${row.generated?.status} (기대: ${expected.join('/')})`);
  if (row.id === acceptance.versionCase.id && row.generated?.sections.length > 1) {
    const years = row.generated.sections.map(section => {
      const policy = policies.get(section.policyKey);
      for (const value of [policy.application?.period_text, policy.name, policy.source_modified_at_raw]) {
        const match = String(value || '').match(/20\d{2}/u);
        if (match) return match[0];
      }
    }).filter(Boolean);
    if (new Set(years).size > 1 && (row.generated.status !== 'needs_clarification'
      || row.generated.sections.some(section => !section.evidence?.some(evidence => ['source_modified_at_raw', 'application.period_text'].includes(evidence.path))))) failures.push('서로 다른 연도 자료의 날짜 표시·확인 요청 누락');
  }
  return { passed: !failures.length, failures };
}
const rows = after.results.map(row => {
  const old = before.results.find(item => item.id === row.id);
  return { id: row.id, question: row.question, before: quality(old), after: quality(row),
    beforeRank: old.grade.rank, afterRank: row.grade.rank, beforeStatus: old.generated?.status, afterStatus: row.generated?.status };
});
const summary = { total: rows.length, beforeCore: before.summary.answerCorrect, afterCore: after.summary.answerCorrect,
  beforeQuality: rows.filter(row => row.before.passed).length, afterQuality: rows.filter(row => row.after.passed).length,
  beforeHitAt3: before.summary.hitAt3, afterHitAt3: after.summary.hitAt3, retrievalTotal: after.summary.retrievalTotal,
  fixed: rows.filter(row => !row.before.passed && row.after.passed).map(row => row.id),
  regressed: rows.filter(row => row.before.passed && !row.after.passed).map(row => row.id) };
let fullReview;
const oldReviewPath = join(dirname(acceptance.baseline), 'review.json'), newReviewPath = join(directory, 'review.json');
if (existsSync(oldReviewPath) && existsSync(newReviewPath)) {
  const oldReview = JSON.parse(readFileSync(oldReviewPath, 'utf8')), newReview = JSON.parse(readFileSync(newReviewPath, 'utf8'));
  assert.equal(oldReview.baselineFingerprint, before.fingerprint);
  assert.equal(newReview.baselineFingerprint, after.fingerprint);
  fullReview = { before: oldReview.summary, after: newReview.summary };
}
const report = { comparedAt: new Date().toISOString(), baselineFingerprint: before.fingerprint, improvedFingerprint: after.fingerprint, acceptance, summary, fullReview, results: rows };
writeFileSync(join(directory, 'comparison.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
const ratio = (n, total) => `${n}/${total} (${(n / total * 100).toFixed(1)}%)`;
const lines = ['# 동일 30문항 개선 전후 비교', '',
  '동일 질문·정답·원본 데이터·모델·임베딩 차원·검색 개수로 비교했다. 기준은 실행 전에 acceptance.json에 정했다. 핵심 사실·인용 외에도 상황에 맞는 안내 상태와 연도 충돌 처리 여부를 확인한다. 아래 결과는 이미 발견된 실패를 수정한 뒤 재평가한 회귀 결과이며, 미사용 문항의 성능 추정치가 아니다.', '',
  '| 항목 | 개선 전 | 개선 후 |', '|---|---:|---:|',
  `| 핵심 원본 항목·인용 | ${ratio(summary.beforeCore, rows.length)} | ${ratio(summary.afterCore, rows.length)} |`,
  `| 핵심 항목 + 안내 사유 + 연도 구분 | ${ratio(summary.beforeQuality, rows.length)} | ${ratio(summary.afterQuality, rows.length)} |`,
  `| 지정 정답 정책 검색 상위 3개 포함 | ${ratio(summary.beforeHitAt3, summary.retrievalTotal)} | ${ratio(summary.afterHitAt3, summary.retrievalTotal)} |`, '',
  `이진 기준으로 수정된 실패: ${summary.fixed.join(', ') || '없음'}. 이전 통과에서 실패로 바뀐 문항: ${summary.regressed.join(', ') || '없음'}. 부분정답과 오답의 차이는 아래 전체 검토를 함께 확인해야 한다.`, '',
  ...(fullReview ? ['| 답변 전체 추가 검토 | 개선 전 | 개선 후 |', '|---|---:|---:|',
    ...['정답', '부분정답', '오답'].map(label => `| ${label} | ${fullReview.before[label]} | ${fullReview.after[label]} |`), '',
    '전체 검토도 Codex의 판단이다. T15는 종전 부분정답에서 최종 검증 차단 오답으로 바뀌었다. 자동 핵심 항목만 충족한 중간 실행을 최종 정답률로 채택하지 않았다. 상세 판단은 review.md에 있다.', ''] : []),
  '일반 키워드·추정 지역은 후보를 제거하지 않고 순위에 반영한다. 복합 질문은 의미별 요청 주제를 함께 처리하고 원문 필드 전체에서 근거를 선택한다. 관련 공고와 요청 정보의 존재 여부는 분리하며, 요청한 공고에 없는 금액을 다른 후보의 금액으로 대신할 수 없다. 모델은 여전히 근거 ID와 제한된 판단 값만 반환하고 최종 문장은 원문과 고정 안내로 구성한다.', '',
  '| 번호 | 이전 상태 | 이후 상태 | 이전 순위 | 이후 순위 | 비교 판정 |', '|---|---|---|---:|---:|---|',
  ...rows.map(row => `| ${row.id} | ${row.beforeStatus} | ${row.afterStatus} | ${row.beforeRank || '-'} | ${row.afterRank || '-'} | ${row.after.passed ? '통과' : row.after.failures.join('; ')} |`), '',
  '수정 중간 실행도 보존했다. round3_improved는 핵심 항목 29/30(다른 후보 금액으로 정보 부족 검사 통과), round3_improved_v2는 28/30(선택 검증 차단), round3_final은 29/30(재시도 후에도 공고 번호 불일치), round3_fixed는 30/30(전체 검토에서 누락 안내 모순 발견), round3_verified는 30/30(전체 검토에서 다른 사업의 부가 조건 발견)이다. 각각의 원인을 수정한 round3_release가 최종 코드 실행이다. 자동 핵심 점수와 답변 전체의 품질은 다르므로 전체 검토는 review.md를 함께 확인해야 한다. 이전 원문 제한 버전 보고서는 ../round3에 보존했다.', '',
  '새로운 질문에서 동일한 성능을 보장하지 않는다. 원본 자체의 오류·누락·최신성과 의미에 따른 근거 선택의 불확실성은 남을 수 있다. 인용 정확도는 grounding-audit.json, 실제 답변은 results.md와 results.json에서 확인할 수 있다.', ''];
writeFileSync(join(directory, 'comparison.md'), lines.join('\n'), 'utf8');
console.log(JSON.stringify(summary, null, 2));
