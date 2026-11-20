import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPolicies, policyText, chunkPolicy, signature, retrieve } from './rag.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const matches = (pattern, text) => new RegExp(pattern, 'iu').test(text.normalize('NFKC'));
const atPath = (object, path) => path.split('.').reduce((value, key) => value?.[key], object);
const identity = text => String(text).normalize('NFKC').replace(/\[정정공고\]/g, '').replace(/^\d{4}년?\s*/, '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();

export function resolveSuiteDirectory(root, suite = '') {
  if (suite && !/^[A-Za-z0-9_-]+$/.test(suite)) throw new Error('평가 세트 이름에는 영문·숫자·밑줄·하이픈만 사용할 수 있습니다.');
  return join(root, 'evaluation', suite);
}

export function prepareCases(questions, policies) {
  if (questions.length !== 30 || new Set(questions.map(q => q.id)).size !== 30) throw new Error('서로 다른 ID의 질문 30개가 필요합니다.');
  const byKey = new Map(policies.map(p => [p.policy_key, p]));
  return questions.map(item => {
    if (!item.question || !item.facts?.length) throw new Error(`${item.id}: 질문 또는 정답 기준이 없습니다.`);
    const originals = item.policyKeys.map(key => {
      if (!byKey.has(key)) throw new Error(`${item.id}: 원본 정책 ${key}가 없습니다.`);
      return byKey.get(key);
    });
    for (const fact of item.facts) {
      new RegExp(fact.pattern, 'iu');
      if (fact.path) {
        const value = atPath(originals[0], fact.path);
        if (typeof value !== 'string' || !value.includes(fact.quote)) throw new Error(`${item.id}: 원본 정답 인용 불일치 (${fact.label})`);
        if (!matches(fact.pattern, policyText(originals[0]))) throw new Error(`${item.id}: 원본의 정답 패턴 불일치 (${fact.label})`);
      }
      for (const path of fact.missingPaths || []) if (atPath(originals[0], path) != null) throw new Error(`${item.id}: ${path}는 누락된 정보가 아닙니다.`);
    }
    // Accept duplicate catalog entries with the same title, organization and evidence.
    // Resolve this gold set before retrieval to avoid relabelling a miss as a hit.
    const acceptedKeys = new Set(item.policyKeys);
    for (const policy of policies) {
      if (!originals.some(original => identity(original.name) === identity(policy.name) && identity(original.organization) === identity(policy.organization))) continue;
      if (!item.facts.every(fact => fact.path ? matches(fact.pattern, policyText(policy)) : (fact.missingPaths || []).every(path => atPath(policy, path) == null))) continue;
      acceptedKeys.add(policy.policy_key);
    }
    return { ...item, acceptedPolicyKeys: [...acceptedKeys], goldPolicies: originals.map(policy => ({
      policyKey: policy.policy_key, name: policy.name, source: policy.source, sourceUrl: policy.source_url,
    })) };
  });
}

export function gradeCase(item, retrieved, generated) {
  const acceptable = new Set(item.acceptedPolicyKeys || item.policyKeys);
  const relevant = retrieved.map((row, i) => acceptable.has(row.policy.policy_key) ? i + 1 : null).filter(Boolean);
  const rank = relevant[0] || null;
  const sections = generated.sections || [];
  const cited = sections.filter(section => acceptable.has(section.policyKey));
  // Facts from an unrelated policy or the program's generic disclaimer cannot earn credit.
  const relevantText = acceptable.size ? cited.map(section => section.explanation).join('\n') + '\n' + (generated.message || '')
    : sections.map(section => section.explanation).join('\n') + '\n' + (generated.message || '');
  const checks = item.facts.map(fact => ({ label: fact.label, passed: matches(fact.pattern, relevantText) }));
  const forbiddenMatches = (item.forbiddenPatterns || []).filter(pattern => matches(pattern, relevantText));
  const abstentionPassed = !item.requireAbstention || sections.length === 0;
  const citationPassed = acceptable.size ? cited.length > 0 || (item.category === '정보부족' && rank !== null && sections.length === 0) : sections.length === 0;
  return { rank, retrievalApplicable: acceptable.size > 0, hitAt1: rank === 1, hitAt3: rank !== null && rank <= 3,
    hitAt5: rank !== null && rank <= 5, checks, factsPassed: checks.filter(check => check.passed).length,
    citationPassed, abstentionPassed, forbiddenMatches,
    answerPassed: checks.every(check => check.passed) && !forbiddenMatches.length && abstentionPassed && citationPassed };
}

export function summarize(results) {
  const retrieval = results.filter(row => row.grade.retrievalApplicable);
  const count = predicate => results.filter(predicate).length;
  const categories = {};
  for (const category of new Set(results.map(row => row.category))) {
    const subset = results.filter(row => row.category === category);
    categories[category] = { total: subset.length, answerCorrect: subset.filter(row => row.grade.answerPassed).length };
  }
  return { total: results.length, errors: count(row => Boolean(row.error)),
    retrievalTotal: retrieval.length,
    hitAt1: retrieval.filter(row => row.grade.hitAt1).length,
    hitAt3: retrieval.filter(row => row.grade.hitAt3).length,
    hitAt5: retrieval.filter(row => row.grade.hitAt5).length,
    meanReciprocalRank: retrieval.reduce((sum, row) => sum + (row.grade.rank ? 1 / row.grade.rank : 0), 0) / (retrieval.length || 1),
    answerCorrect: count(row => row.grade.answerPassed),
    factCorrect: results.reduce((sum, row) => sum + row.grade.factsPassed, 0),
    factTotal: results.reduce((sum, row) => sum + row.grade.checks.length, 0), categories };
}

export function markdownReport(report) {
  const s = report.summary;
  const ratio = (n, d) => `${n}/${d} (${d ? (n / d * 100).toFixed(1) : '0.0'}%)`;
  const escape = text => String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const lines = ['# 정책 RAG 30문항 평가', '',
    `실행: ${report.startedAt} / 답변 모델: ${report.models.chatModel} / 검색 정책 수: ${report.models.topK}`, '',
    `- 검색 1위 정답: ${ratio(s.hitAt1, s.retrievalTotal)}`,
    `- 검색 상위 3개 정답 포함: ${ratio(s.hitAt3, s.retrievalTotal)}`,
    `- 검색 상위 5개 정답 포함: ${ratio(s.hitAt5, s.retrievalTotal)}`,
    `- 답변 핵심항목 모두 충족: ${ratio(s.answerCorrect, s.total)}`,
    `- 개별 핵심항목 충족: ${ratio(s.factCorrect, s.factTotal)}`,
    `- 실행 오류: ${s.errors}`, '',
    '정답은 제공된 JSON 원문을 기준으로 실행 전에 고정했습니다. 같은 정책명·기관·정답 근거를 가진 중복 레코드는 동등 정답으로 인정합니다. 정책명을 명시한 질문, 상황 설명, 지역 구분, 자격 예외, 정보 부족 및 범위 밖 질문을 섞었습니다.', '',
    '답변 판정은 기대 정책의 인용, 원본에서 정한 핵심항목 패턴 전부 충족, 지정한 금지 표현 부재를 함께 검사하는 엄격한 자동 판정입니다. 정보 부족 질문은 구체 정보 누락 인정을, 범위 밖 질문은 정책을 지어내지 않고 답변을 보류하는지를 검사합니다. 자동으로 붙이는 일반 안내 문구는 정답 인정에 쓰지 않습니다. 30개 자체 작성 문항의 1회 실행이며, 전체 사실성이나 실서비스 정확도를 대표하지 않습니다. 표현 차이로 자동 판정이 틀릴 수 있어 JSON의 실제 답변과 함께 확인해야 합니다.', '',
    '| 유형 | 핵심항목 모두 충족 |', '|---|---|',
    ...Object.entries(s.categories).map(([name, value]) => `| ${name} | ${ratio(value.answerCorrect, value.total)} |`), '',
    '| 번호 | 유형 | 질문 | 정답 순위 | 답변 판정 | 미충족 항목 |', '|---|---|---|---:|---|---|',
    ...report.results.map(row => `| ${row.id} | ${row.category} | ${escape(row.question)} | ${row.grade.retrievalApplicable ? row.grade.rank || '5위 밖' : '해당 없음'} | ${row.grade.answerPassed ? '통과' : '실패'} | ${escape([...(row.grade.checks || []).filter(c => !c.passed).map(c => c.label), ...(!row.grade.citationPassed ? ['정답 출처 없음'] : []), ...(!row.grade.abstentionPassed ? ['답변 보류 실패'] : []), ...(row.grade.forbiddenMatches.length ? ['금지 표현'] : []), ...(row.error ? [row.error] : [])].join('; ') || '-')} |`), '',
    '## 질문별 원본 정답과 실제 답변', '',
  ];
  for (const row of report.results) {
    lines.push(`### ${row.id}. ${row.question}`, '', `유형: ${row.category} / 자동 판정: ${row.grade.answerPassed ? '통과' : '실패'} / 정답 순위: ${row.grade.rank || '해당 없음 또는 검색 실패'}`, '',
      ...row.goldPolicies.map(policy => `- 기대 정책: ${policy.name} (${policy.policyKey}) / ${policy.sourceUrl || 'URL 없음'}`),
      ...row.facts.map(fact => `- 기준: ${fact.label}${fact.path ? ` / ${fact.path}: ${fact.quote}` : fact.missingPaths ? ` / 원본 누락: ${fact.missingPaths.join(', ')}` : ''}`), '',
      '실제 답변:', '', row.generated?.answer || row.error || '(없음)', '');
  }
  return lines.join('\n');
}

export async function runEvaluation(config, store, client, { resume = false, suite = '' } = {}) {
  const root = config.root;
  const directory = resolveSuiteDirectory(root, suite);
  const questionsText = readFileSync(join(directory, 'questions.json'), 'utf8');
  const { policies } = loadPolicies(root);
  const cases = prepareCases(JSON.parse(questionsText), policies);
  const stats = store.stats(signature(config));
  const chunks = store.chunks(signature(config));
  const expectedHashes = new Set(policies.flatMap(p => chunkPolicy(p)).map(chunk => chunk.hash));
  if (stats.policies !== policies.length || !stats.chunks || stats.chunks !== stats.embedded || stats.chunks !== expectedHashes.size || chunks.some(chunk => !expectedHashes.has(chunk.hash))) {
    throw new Error('전체 인덱스가 없거나 원본·설정과 다릅니다. index를 먼저 실행해 주세요.');
  }
  const codeHash = digest(readFileSync(join(root, 'src', 'rag.mjs')));
  const groundingHash = digest(readFileSync(join(root, 'src', 'grounding.mjs')));
  const graderHash = digest(readFileSync(join(root, 'src', 'evaluation.mjs')));
  const corpusHash = digest(JSON.stringify([...expectedHashes].sort()));
  const models = { chatModel: config.chatModel, embeddingModel: config.embeddingModel, dimensions: config.dimensions, topK: config.topK, baseUrl: config.baseUrl };
  const fingerprint = digest(JSON.stringify({ questionsText, codeHash, groundingHash, graderHash, corpusHash, models }));
  const outputPath = join(directory, 'results.json');
  let report = { startedAt: new Date().toISOString(), timezone: 'Asia/Seoul', fingerprint, codeHash, groundingHash, graderHash, corpusHash,
    suite: suite || 'original', models, index: stats, goldCases: cases, results: [], summary: summarize([]) };
  if (resume && existsSync(outputPath)) {
    report = JSON.parse(readFileSync(outputPath, 'utf8'));
    if (report.fingerprint !== fingerprint) throw new Error('코드·문항·원본·설정이 바뀌어 이전 평가를 이어갈 수 없습니다.');
  } else if (existsSync(outputPath)) {
    throw new Error('기존 결과가 있습니다. --resume으로 같은 실행을 이어가거나 기존 결과를 별도 보관한 후 시작해 주세요.');
  }
  const done = new Set(report.results.map(row => row.id));
  const pending = cases.filter(item => !done.has(item.id));
  const save = () => {
    report.results.sort((a, b) => a.id.localeCompare(b.id));
    report.updatedAt = new Date().toISOString();
    report.summary = summarize(report.results);
    writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    writeFileSync(join(directory, 'results.md'), markdownReport(report), 'utf8');
  };
  save();
  // Batch only query embeddings. Answers use exactly the normal production RAG path.
  const queryVectors = pending.length ? await client.embed(pending.map(item => item.question)) : [];
  const vectors = new Map(pending.map((item, i) => [item.question, queryVectors[i]]));
  const queryClient = { embed: async texts => texts.map(text => vectors.get(text)) };
  let cursor = 0;
  async function worker() {
    while (cursor < pending.length) {
      const item = pending[cursor++];
      const started = Date.now();
      let retrieved = [], generated = null, error;
      try {
        retrieved = await retrieve(store, item.question, config, { client: queryClient });
        generated = await client.answer(item.question, retrieved.map(row => row.policy));
      } catch (caught) { error = caught.message; }
      const grade = gradeCase(item, retrieved, generated || { sections: [], message: '' });
      if (error) grade.answerPassed = false;
      report.results.push({ ...item, grade, generated, error, elapsedMs: Date.now() - started,
        retrieved: retrieved.map(row => ({ policy: { policy_key: row.policy.policy_key, name: row.policy.name, source: row.policy.source, source_url: row.policy.source_url }, score: row.score })) });
      save();
      console.log(`${report.results.length}/30 ${item.id} 검색 ${grade.rank || '-'}위 / 답변 ${grade.answerPassed ? '통과' : '실패'}${error ? ' / 실행 오류' : ''}`);
    }
  }
  await Promise.all([worker(), worker()]);
  report.completedAt = new Date().toISOString();
  save();
  return report;
}
