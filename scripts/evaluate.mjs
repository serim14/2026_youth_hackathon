import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadConfig, loadPolicies, Store, OpenAIClient } from '../src/rag.mjs';
import { prepareCases, runEvaluation, resolveSuiteDirectory } from '../src/evaluation.mjs';

let store;
try {
  const config = loadConfig();
  const suiteIndex = process.argv.indexOf('--suite');
  if (suiteIndex >= 0 && (!process.argv[suiteIndex + 1] || process.argv[suiteIndex + 1].startsWith('--'))) throw new Error('--suite 뒤에 평가 세트 이름을 입력해 주세요.');
  const suite = suiteIndex < 0 ? '' : process.argv[suiteIndex + 1];
  const directory = resolveSuiteDirectory(config.root, suite);
  const cases = prepareCases(JSON.parse(readFileSync(join(directory, 'questions.json'), 'utf8')), loadPolicies(config.root).policies);
  console.log(`평가 문항 ${cases.length}개, 원본 근거와 동등 정답 확인 완료.`);
  if (!process.argv.includes('--check')) {
    store = new Store(join(config.root, '.rag', 'policies.sqlite'));
    const report = await runEvaluation(config, store, new OpenAIClient(config), { resume: process.argv.includes('--resume'), suite });
    console.log(JSON.stringify(report.summary, null, 2));
    console.log(`결과: ${join(directory, 'results.md')} 및 ${join(directory, 'results.json')}`);
  }
} catch (error) {
  console.error(`평가 오류: ${error.message}`);
  process.exitCode = 1;
} finally { store?.close(); }
