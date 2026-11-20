# 정책 카탈로그 RAG

JSON 정책 4,610개(LH 6개, 온통청년 4,027개, 정부24 577개)를 사용하는 로컬 RAG입니다. 이름이 같은 CSV는 적재하지 않습니다. Node.js 24 이상에서 추가 패키지 설치 없이 실행합니다.

## 시작하기

프로젝트 폴더의 `.env`에 입력한 `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL`을 사용합니다. 현재 설정은 OpenAI API와 `gpt-4o-mini`입니다. 키는 `.gitignore`로 제외됩니다. 기존 이름인 `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_CHAT_MODEL`도 지원합니다. 프로세스 환경변수가 `.env`보다 우선하며, 같은 위치에 두 이름이 있으면 `LLM_*`가 우선합니다.

```dotenv
LLM_API_KEY=여기에_API_키
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_EMBEDDING_DIMENSIONS=512
RAG_TOP_K=5
```

임베딩은 같은 API 주소와 키를 사용합니다. 카카오·ODsay 키는 현재 정책 검색과 답변 생성 과정에서는 사용하지 않습니다.

```powershell
# 데이터 현황 확인 (키 값은 출력하지 않음)
node src/cli.mjs inspect

# 실제 API로 표본 적재 → 임베딩 → 검색 → 출처 포함 답변 검증
node src/cli.mjs verify

# 전체 데이터 임베딩 생성
node src/cli.mjs index

# 전체 임베딩 완료 여부와 4개 질문의 검색·출처 검증
node src/cli.mjs verify --full

# 하이브리드 검색 및 RAG 답변
node src/cli.mjs search "청년 월세 지원"
node src/cli.mjs ask "근로장려금의 지원 금액과 신청 조건을 알려줘"
```

`verify`, `index`, `ask` 및 임베딩 검색은 OpenAI API를 유료 호출합니다. `verify`는 전체와 분리된 표본 DB를 사용하며 전체 인덱스를 완성하지 않습니다. 전체 `index`는 키 입력 후 별도로 실행합니다. 실패하거나 중단하면 같은 명령을 재실행하세요. 완료된 배치의 임베딩은 재사용합니다. 데이터 내용 또는 임베딩 모델·차원이 바뀐 청크만 새로 임베딩합니다.

`verify --full`은 전체 인덱스의 적재·임베딩 개수와 원본 변경 여부를 확인한 뒤, LH·온통청년·정부24 정책에 대한 질문 4개를 실제 API로 검색합니다. 정답 정책의 상위 3개 포함 여부와 생성 답변의 정답 출처 인용을 검사하고 `.rag/validation-report.json`에 결과를 저장합니다. 이 검증은 정해진 질문에 대한 동작 확인이며 모든 질문의 답변 품질을 보장하지는 않습니다. `inspect`에서 현재 설정에 해당하는 임베딩 완료 개수를 확인할 수 있습니다.

## 키 없이 확인하기

```powershell
node src/cli.mjs index --lexical
node src/cli.mjs search "근로장려금 신청 자격" --lexical
node --test
```

`search --lexical`은 API를 호출하지 않습니다. `ask --lexical`은 검색 임베딩을 생략하지만 답변 생성 API는 호출합니다. `search`와 `ask`에 `--json`을 추가하면 구조화된 결과를 출력합니다.

PowerShell에서 `npm.ps1` 실행이 차단되는 환경은 위 `node` 명령을 사용하거나 `npm.cmd test`, `npm.cmd run verify`처럼 실행할 수 있습니다.

## 처리 방식

- 중첩 JSON의 지원 내용, 자격 조건, 신청 기간·방법, 원문 URL을 텍스트로 보존합니다.
- 정책 단위로 1,800자 청크를 만들고 180자를 중첩합니다. 각 청크에 정책명과 정책키를 붙입니다.
- `.rag/policies.sqlite`에 원문, 청크, 임베딩을 저장합니다. API 주소·모델·차원별 임베딩 캐시를 분리합니다.
- 한국어 2글자 조각을 포함한 BM25 키워드 검색과 임베딩 코사인 검색의 점수를 각각 정규화해 60:40으로 결합하고 정책별로 중복을 제거합니다. 짧은 정책명 질문의 키워드 근거가 임베딩 순위 때문에 사라지는 것을 줄입니다.
- 질문에 명시된 공고·별칭을 확인합니다. 일반 키워드·추정 지역은 후보를 제거하지 않고 정책명·지역 일치도를 순위에 반영합니다. 모델은 원문 필드 ID와 제한된 판단 값만 선택하며, 설명 문장은 생성하지 않습니다.
- 선택된 공고에서 질문한 주제의 원문 필드를 코드가 가져와 인용 형태로 출력합니다. 금액·단위·조건·예외가 변하지 않도록 필드 전체를 보존합니다. ID·필드 경로·정책의 연결과 원문 문자열을 검사하고, 생성된 설명·없는 ID·다른 공고의 ID·임의 메시지는 차단합니다.
- 원본의 포괄적인 `mapped_conditions`는 답변 근거에서 제외합니다. 개인 신청 내역, 현재 접수 여부 및 비어 있는 소득·연령·금액은 일반 지식으로 보충하지 않습니다. CLI는 실제 답변에 사용한 공고의 출처만 표시합니다.

기본 임베딩은 `text-embedding-3-small` 512차원, 검색 정책 수는 5개입니다. 답변 모델은 `.env`의 `LLM_MODEL` 설정을 따르며 현재 `gpt-4o-mini`입니다. 모델 설정이 전혀 없으면 `gpt-4.1-mini`를 사용합니다. API 구현은 [임베딩 API](https://developers.openai.com/api/reference/resources/embeddings/methods/create)와 [Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create)를 사용합니다.

모든 원본 정책은 `review_decision=REVIEW`입니다. 현재 답변은 원문 인용 중심이므로 원본의 오류·오래된 정보·서로 다른 공고의 충돌은 그대로 남을 수 있습니다. 모델이 근거를 선택하는 정확도까지 보장하지는 않습니다. 온라인 원문을 실시간 갱신하거나 개인별 자격을 확정하는 기능은 포함하지 않습니다.

## 원문 제한 및 안내 응답

`src/grounding.mjs`에서 원문 근거의 선택·검사·출력과 안내 문구를 처리합니다. 모델 출력에는 근거 ID, 관련 공고 번호, 요청·누락 주제, 관할, 질문에 명시된 연도와 처리 상태만 정해진 자료형·허용 값으로 받습니다. 최종 답변은 모델이 만든 문장을 쓰지 않고 저장된 원본 필드와 코드에 정의된 안내 문구로 조립합니다. 복합 질문은 의미별 요청 주제를 확인하고 전체 원문 필드에서 근거를 선택합니다. 선택된 공고의 해당 주제 필드를 함께 보존해 금액·단위·조건·예외가 빠지는 것을 줄입니다. 누락 안내는 실제 요청 주제와 인용한 원문을 다시 대조해 만듭니다.

관련 공고의 존재와 요청 정보의 존재를 구분합니다. 질문에 사업명이 명확히 있으면 그 사업 및 같은 사업의 유사 제목 자료로 근거를 제한합니다. 특정 사업에 없는 정액 지급액을 다른 후보의 금액으로 보충하지 않습니다. 개인 예약·신청 조회와 해외 관할 질문은 각각 전용 안내를 제공합니다. 같은 사업의 서로 다른 연도 자료를 함께 인용하면 신청 기간·원본 수정일을 표시하고 적용 공고를 확인하도록 안내합니다. 원본 수정일을 적용 연도로 단정하지 않습니다.

근거 ID나 선택 형식의 오류는 같은 원문으로 최대 한 번 다시 선택합니다. 검증 기준은 그대로 유지하며 실패하면 `blocked`로 응답합니다. 관련 공고 목록에 없는 근거는 제외하고, 유효한 근거만 남는 경우 그 근거로 답합니다. 남는 근거가 없으면 답변을 차단합니다. JSON 응답의 `selection_attempts`, `repair_history`, `discarded_evidence_count`로 선택 재시도·제외 상황을 확인할 수 있습니다.

`ask --json`은 `status`, `answer`, `sections`, `sources`, `missingTopics`를 반환합니다. 각 section의 `evidence`에는 원본 필드 경로와 원문이 포함됩니다.

| status | 처리 |
|---|---|
| `answered` | 질문 주제에 해당하는 원문을 인용 |
| `partial` | 확인 가능한 원문과 확인하지 못한 항목 안내 |
| `no_related` | 일치하는 관련 공고를 찾지 못했다는 안내 |
| `insufficient` | 관련 공고에 요청한 정보가 부족하다는 안내 |
| `needs_clarification` | 지역·연도·대상 등의 구체화 요청 |
| `current_status` | 현재 접수 여부는 최신 공고에서 확인하도록 안내 |
| `personal` | 개인 접수번호·승인 내역은 조회할 수 없다는 안내 |
| `out_of_scope` | 정책 카탈로그 범위 밖이라는 안내 |
| `blocked` | 원문 근거 검증 실패로 답변을 제공하지 않았다는 안내 |
| `service_error` | 답변 서비스 이용 실패 안내 |

예를 들어 자격 필드가 비어 있는 LH 공고의 소득·연령을 물으면 관련 정보가 부족하다는 안내를 반환합니다. 개인 접수번호는 조회할 수 없다고 안내합니다. 존재하지 않는 공고명은 유사한 다른 사업으로 바꿔 답하지 않도록 검색 범위를 제한합니다. 임베딩 데이터는 변경하지 않아 재생성 없이 적용됩니다.

```powershell
node --test
node scripts/verify-grounding.mjs
```

자동 테스트 51개와 실제 API를 사용하는 15개 회귀 질문 검증이 모두 통과했습니다. [실제 API 검증 기록](evaluation/grounding-verification.json)과 [검증 설명](evaluation/grounding-verification.md)을 확인할 수 있습니다. 이는 해당 사례의 동작 확인이며 전체 질문의 정답률을 의미하지 않습니다.

테스트는 파일 중복 방지, 중첩 필드 및 청크 보존, 임베딩 캐시·중단 복구, 검색 결과, API 요청·오류 처리와 출처 번호를 확인합니다. 모의 API 테스트와 실제 API 표본 검증은 서로 별개입니다.

## 30문항 평가

아래 두 세트의 결과는 원문 제한을 적용하기 전 구현의 기록입니다. 기존 보고서는 보존했습니다.

[질문·원본 정답 기준](evaluation/questions.json), [전체 실행 답변과 자동 점수](evaluation/results.md), [답변 전체 추가 검토](evaluation/review.md)를 확인할 수 있습니다.

이번 실행은 `gpt-4o-mini`와 기존 전체 인덱스를 사용했습니다. 정답 정책이 있는 28문항 중 27문항은 검색 1위, 28문항 모두 상위 3개에 포함됐습니다. 사전 정의된 핵심항목 55개는 모두 통과했지만, 생성된 추가 설명까지 원문과 대조한 Codex 검토에서는 정답 24개와 부분정답 6개로 분류했습니다. 자세한 실패 근거는 추가 검토 보고서에 있습니다. 자동 통과율을 전체 답변 사실성으로 해석하면 안 됩니다. 자체 작성한 30문항의 1회 실행이며 독립적인 외부 시험은 아닙니다.

```powershell
# API 호출 없이 30개 정답의 원본 근거 확인
node scripts/evaluate.mjs --check

# 실제 API 평가 실행 (30개 답변 생성으로 요금 발생)
node scripts/evaluate.mjs

# 중단된 동일 평가 이어가기. 완료된 결과는 다시 호출하지 않음
node scripts/evaluate.mjs --resume

# 저장된 답변과 원본을 대조한 추가 검토 보고서 생성 (API 호출 없음)
node scripts/render-review.mjs
```

평가 중에는 RAG 코드·문항·정답을 고정하며, 검색에 사용한 원본과 코드 해시를 결과에 저장합니다. 이미 결과가 존재하면 새 평가로 덮어쓰지 않습니다. 새로운 실행을 비교하려면 기존 결과를 먼저 별도 보관해야 합니다. `review-notes.json`은 이번 생성 답변에 대해 작성한 검토 기록이므로 새 실행의 검토에는 다시 작성해야 합니다.

### 두 번째 30문항 세트

이전 문항 및 사전 지정 정답 정책과 겹치지 않는 새 질문은 [round2/questions.json](evaluation/round2/questions.json)에 있습니다. [추가 검토 보고서](evaluation/round2/review.md)와 [실제 답변·자동 점수](evaluation/round2/results.md)를 별도로 보존했습니다.

새 세트의 결과는 추가 검토 기준 정답 23개(76.7%), 부분정답 5개, 오답 2개입니다. 사전 지정 정책 키의 상위 5개 포함률은 25/28(89.3%), 자동 답변 통과는 24/30입니다. 명칭이 다른 같은 제도를 찾은 경우나 정규식의 표현 차이에 따른 자동 오판을 검토 보고서에 구분했습니다. 자동 점수는 사후 수정하지 않았습니다. 두 세트의 질문 난이도는 동일하지 않으므로 점수만으로 성능 변화를 판단할 수 없습니다.

```powershell
node scripts/evaluate.mjs --suite round2 --check
node scripts/evaluate.mjs --suite round2 --resume
node scripts/render-review.mjs --suite round2
```

`--suite 이름`은 `evaluation/이름` 아래의 질문과 결과를 사용하므로 기존 세트를 덮어쓰지 않습니다. 평가 코드가 변경되면 기존 실행의 `--resume`은 재현성을 위해 거절될 수 있으며, 저장된 보고서는 그대로 읽을 수 있습니다.

### 원문 제한 적용 후 신규 30문항

원문 제한을 수정할 때 사용한 15개 회귀 질문 외에, 이전 60문항과 질문·지정 정답 정책이 겹치지 않는 [round3/questions.json](evaluation/round3/questions.json)으로 다시 검증했습니다. 테스트 중 RAG·grounding 코드는 수정하지 않았습니다.

추가 검토는 **정답 19개(63.3%), 부분정답 6개, 오답 5개**입니다. 자동 핵심항목 통과는 23/30, 지정 정답 정책의 상위 5개 검색 포함은 24/28입니다. [추가 검토 보고서](evaluation/round3/review.md)와 [30개 실제 응답](evaluation/round3/results.md)을 확인할 수 있습니다.

[원문 일치 감사](evaluation/round3/grounding-audit.json)에서는 30개 출력이 원문 및 코드 템플릿과 일치했고, 인용 필드 49개 모두 원본과 같았습니다. 그러나 과도한 검색 범위 제한으로 실제 정답을 제외하거나, 복합 질문 일부를 누락하거나, 해외 질문에 국내 공고를 보여 주는 문제가 남았습니다. 원문을 그대로 인용했다는 결과와 질문에 올바르게 답했다는 결과를 구분해야 합니다. 안내 문구의 사유가 틀린 사례도 추가 검토에서 부분정답으로 분리했습니다.

```powershell
node scripts/evaluate.mjs --suite round3 --check
node scripts/evaluate.mjs --suite round3 --resume
node scripts/audit-grounded-evaluation.mjs --suite round3
node scripts/render-review.mjs --suite round3
```

`audit-grounded-evaluation`은 인용문이 원본 필드와 같은지, 답변이 현재 원문 출력 코드로 재구성되는지 검사합니다. 질문 관련성이나 안내 사유를 자동 보증하는 검사는 아닙니다.

### 세 번째 실험 실패를 반영한 현재 버전

검색 후보의 과도한 제외, 복합 질문의 제출 경로·이용 방법 누락, 안내 사유 혼동과 공고·연도 혼합을 보완했습니다. 일반 키워드는 순위를 조정하고, 명시된 사업과 다른 사업의 근거는 출력에서 제외합니다. 정보 부족 안내도 요청 주제와 실제 인용문을 대조합니다. 원문 밖의 금액·조건을 생성하지 않는 제한은 유지합니다. 기존 인덱스를 그대로 사용하므로 재임베딩은 필요 없습니다.

질문·정답·모델·데이터를 고정해 재실행한 [개선 전후 비교](evaluation/round3_release/comparison.md)와 [답변 전체 추가 검토](evaluation/round3_release/review.md)를 확인할 수 있습니다.

| 항목 | 개선 전 round3 | 현재 round3_release |
|---|---:|---:|
| 핵심 항목·인용 자동 통과 | 23/30 | 29/30 |
| 전체 검토 정답 | 19/30 (63.3%) | 29/30 (96.7%) |
| 전체 검토 부분정답 / 오답 | 6 / 5 | 0 / 1 |
| 정답 정책 검색 상위 3개 포함 | 24/28 | 28/28 |

남은 오답 T15는 지원금·제출 경로의 원문이 있지만 모델의 근거 ID와 공고 번호가 재시도 후에도 불일치해 차단된 경우입니다. 임의로 답변을 채우거나 정답으로 계산하지 않았습니다. 인용 필드 64개는 모두 원본과 일치했고 전체 출력 30개는 원문·고정 안내 템플릿 검사에 통과했습니다. 별도의 기존 15개 API 회귀 질문도 모두 통과했습니다. 실패 사례를 수정하는 데 사용한 동일 문항의 결과이므로 미사용 질문의 정답률 추정치는 아닙니다.

중간 버전의 자동 30/30 결과도 보존했지만 전체 검토에서 안내 모순·다른 사업의 부가 조건이 발견됐습니다. 최종 코드는 `round3_release` 결과로 판단합니다. 변경 이력과 남은 실패는 비교·검토 보고서에 기록했습니다.

```powershell
# API 호출 없이 저장된 최종 실행의 원문 일치·비교·전체 검토 보고서 확인
node scripts/audit-grounded-evaluation.mjs --suite round3_release
node scripts/render-review.mjs --suite round3_release
node scripts/compare-evaluation.mjs --suite round3_release
```
