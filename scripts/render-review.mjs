import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPolicies } from '../src/rag.mjs';
import { resolveSuiteDirectory } from '../src/evaluation.mjs';

const suiteIndex = process.argv.indexOf('--suite');
if (suiteIndex >= 0 && (!process.argv[suiteIndex + 1] || process.argv[suiteIndex + 1].startsWith('--'))) throw new Error('--suite 뒤에 평가 세트 이름을 입력해 주세요.');
const directory = resolveSuiteDirectory(process.cwd(), suiteIndex < 0 ? '' : process.argv[suiteIndex + 1]);
const original = readFileSync(join(directory, 'results.json'), 'utf8');
const report = JSON.parse(original);
const notes = JSON.parse(readFileSync(join(directory, 'review-notes.json'), 'utf8'));
if (!report.completedAt || report.results.length !== 30 || notes.items.length !== 30 || new Set(notes.items.map(item => item.id)).size !== 30) throw new Error('완료된 30문항 평가와 검토 항목이 필요합니다.');
const policies = new Map(loadPolicies(process.cwd()).policies.map(p => [p.policy_key, p]));
const rows = notes.items.map(note => {
  const result = report.results.find(row => row.id === note.id);
  if (!result || !['정답', '부분정답', '오답'].includes(note.verdict)) throw new Error(`검토 항목 오류: ${note.id}`);
  if (note.answerQuote && !result.generated?.answer.includes(note.answerQuote)) throw new Error(`실제 답변 인용 불일치: ${note.id}`);
  for (const evidence of note.evidence || []) {
    const value = evidence.path.split('.').reduce((object, key) => object?.[key], policies.get(evidence.policyKey));
    if (evidence.quote ? typeof value !== 'string' || !value.includes(evidence.quote) : value !== evidence.value) throw new Error(`원본 근거 불일치: ${note.id}`);
  }
  return { ...note, question: result.question, automatedPass: result.grade.answerPassed };
});
const summary = Object.fromEntries(['정답', '부분정답', '오답'].map(verdict => [verdict, rows.filter(row => row.verdict === verdict).length]));
const review = { reviewedAt: new Date().toISOString(), baselineFingerprint: report.fingerprint,
  baselineResultsSha256: createHash('sha256').update(original).digest('hex'), method: notes.method, summary, items: rows };
writeFileSync(join(directory, 'review.json'), JSON.stringify(review, null, 2) + '\n', 'utf8');
const ratio = (n, d) => `${n}/${d} (${(n / d * 100).toFixed(1)}%)`;
const lines = ['# 30문항 답변 전체 추가 검토', '', notes.method, '',
  `원본 실행: ${report.startedAt} / 모델: ${report.models.chatModel}`, '',
  '| 항목 | 결과 |', '|---|---|',
  `| 검색 1위 정답 | ${ratio(report.summary.hitAt1, report.summary.retrievalTotal)} |`,
  `| 검색 상위 3개 정답 포함 | ${ratio(report.summary.hitAt3, report.summary.retrievalTotal)} |`,
  `| 사전 정의 핵심항목 자동 통과 | ${ratio(report.summary.answerCorrect, 30)} |`,
  `| 추가 검토: 정답 | ${ratio(summary['정답'], 30)} |`,
  `| 추가 검토: 부분정답 | ${ratio(summary['부분정답'], 30)} |`,
  `| 추가 검토: 오답 | ${ratio(summary['오답'], 30)} |`, '',
  `지정 정답 정책이 존재하는 ${report.summary.retrievalTotal}문항을 검색 지표의 분모로 사용했습니다. 나머지 ${report.summary.total - report.summary.retrievalTotal}문항은 범위 밖 질문입니다. 자동 핵심항목 ${report.summary.factTotal}개 중 ${report.summary.factCorrect}개가 충족됐습니다. 원본과 다른 내용, 필요한 조건 누락, 지역·연도 혼합 및 자동 채점의 표현 차이를 추가로 검토했습니다. 자동 결과 파일과 정답표는 변경하지 않았습니다.`, '',
  notes.context || '30개 자체 작성 문항을 한 번 실행한 결과입니다. 일부 정책은 이전 검증과 동일하므로 독립적인 외부 시험이나 서비스 전체의 정확도가 아닙니다.', '',
  '추가 검토도 Codex의 판단이며 전문가 검토를 대신하지 않습니다. 부분정답은 0.5점으로 임의 환산하지 않았습니다.', '',
  ...(notes.automaticCaveats?.length ? ['## 자동 점수 해석', '', ...notes.automaticCaveats.map(text => `- ${text}`), ''] : []),
  `## 부분정답 ${summary['부분정답']}건 및 오답 ${summary['오답']}건`, '',
];
for (const row of rows.filter(row => row.verdict !== '정답')) {
  lines.push(`### ${row.id}. ${row.question}`, '', `${row.verdict}: ${row.reason}`, '', ...(row.answerQuote ? [`실제 답변: “${row.answerQuote}”`, ''] : []),
    ...(row.evidence || []).map(evidence => `- 원본 ${evidence.policyKey} / ${evidence.path}: ${evidence.quote ?? 'null (정보 없음)'}`), '');
}
lines.push('## 전체 문항 검토', '', '| 번호 | 질문 | 판정 | 검토 내용 |', '|---|---|---|---|',
  ...rows.map(row => `| ${row.id} | ${row.question.replace(/\|/g, '\\|')} | ${row.verdict} | ${row.reason.replace(/\|/g, '\\|')} |`), '',
  '질문별 전체 생성 답변과 자동 기준은 [results.md](results.md), 구조화된 원본 실행 결과는 [results.json](results.json)에 있습니다.', '');
writeFileSync(join(directory, 'review.md'), lines.join('\n'), 'utf8');
console.log(JSON.stringify({ summary, automatic: report.summary, report: join(directory, 'review.md') }, null, 2));
