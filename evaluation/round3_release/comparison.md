# 동일 30문항 개선 전후 비교

동일 질문·정답·원본 데이터·모델·임베딩 차원·검색 개수로 비교했다. 기준은 실행 전에 acceptance.json에 정했다. 핵심 사실·인용 외에도 상황에 맞는 안내 상태와 연도 충돌 처리 여부를 확인한다. 아래 결과는 이미 발견된 실패를 수정한 뒤 재평가한 회귀 결과이며, 미사용 문항의 성능 추정치가 아니다.

| 항목 | 개선 전 | 개선 후 |
|---|---:|---:|
| 핵심 원본 항목·인용 | 23/30 (76.7%) | 29/30 (96.7%) |
| 핵심 항목 + 안내 사유 + 연도 구분 | 19/30 (63.3%) | 29/30 (96.7%) |
| 지정 정답 정책 검색 상위 3개 포함 | 24/28 (85.7%) | 28/28 (100.0%) |

이진 기준으로 수정된 실패: T03, T07, T12, T18, T23, T25, T27, T28, T29, T30. 이전 통과에서 실패로 바뀐 문항: 없음. 부분정답과 오답의 차이는 아래 전체 검토를 함께 확인해야 한다.

| 답변 전체 추가 검토 | 개선 전 | 개선 후 |
|---|---:|---:|
| 정답 | 19 | 29 |
| 부분정답 | 6 | 0 |
| 오답 | 5 | 1 |

전체 검토도 Codex의 판단이다. T15는 종전 부분정답에서 최종 검증 차단 오답으로 바뀌었다. 자동 핵심 항목만 충족한 중간 실행을 최종 정답률로 채택하지 않았다. 상세 판단은 review.md에 있다.

일반 키워드·추정 지역은 후보를 제거하지 않고 순위에 반영한다. 복합 질문은 의미별 요청 주제를 함께 처리하고 원문 필드 전체에서 근거를 선택한다. 관련 공고와 요청 정보의 존재 여부는 분리하며, 요청한 공고에 없는 금액을 다른 후보의 금액으로 대신할 수 없다. 모델은 여전히 근거 ID와 제한된 판단 값만 반환하고 최종 문장은 원문과 고정 안내로 구성한다.

| 번호 | 이전 상태 | 이후 상태 | 이전 순위 | 이후 순위 | 비교 판정 |
|---|---|---|---:|---:|---|
| T01 | answered | answered | 1 | 1 | 통과 |
| T02 | answered | answered | 1 | 1 | 통과 |
| T03 | no_related | answered | - | 1 | 통과 |
| T04 | answered | answered | 1 | 1 | 통과 |
| T05 | answered | answered | 1 | 1 | 통과 |
| T06 | answered | answered | 1 | 1 | 통과 |
| T07 | insufficient | answered | - | 1 | 통과 |
| T08 | answered | answered | 1 | 1 | 통과 |
| T09 | answered | answered | 1 | 1 | 통과 |
| T10 | answered | answered | 1 | 1 | 통과 |
| T11 | answered | answered | 1 | 1 | 통과 |
| T12 | partial | answered | - | 1 | 통과 |
| T13 | answered | answered | 1 | 1 | 통과 |
| T14 | answered | answered | 1 | 1 | 통과 |
| T15 | answered | blocked | 1 | 1 | 핵심 원본 사실·인용 미충족; 안내 상태 blocked (기대: answered/partial/needs_clarification) |
| T16 | answered | answered | 1 | 1 | 통과 |
| T17 | answered | answered | 1 | 1 | 통과 |
| T18 | no_related | answered | - | 2 | 통과 |
| T19 | answered | answered | 1 | 1 | 통과 |
| T20 | answered | answered | 1 | 1 | 통과 |
| T21 | answered | needs_clarification | 2 | 2 | 통과 |
| T22 | answered | answered | 1 | 1 | 통과 |
| T23 | answered | answered | 1 | 1 | 통과 |
| T24 | answered | answered | 1 | 1 | 통과 |
| T25 | answered | answered | 1 | 1 | 통과 |
| T26 | insufficient | insufficient | 1 | 1 | 통과 |
| T27 | no_related | insufficient | 1 | 1 | 통과 |
| T28 | no_related | personal | 1 | 1 | 통과 |
| T29 | insufficient | no_related | - | - | 통과 |
| T30 | answered | out_of_scope | - | - | 통과 |

수정 중간 실행도 보존했다. round3_improved는 핵심 항목 29/30(다른 후보 금액으로 정보 부족 검사 통과), round3_improved_v2는 28/30(선택 검증 차단), round3_final은 29/30(재시도 후에도 공고 번호 불일치), round3_fixed는 30/30(전체 검토에서 누락 안내 모순 발견), round3_verified는 30/30(전체 검토에서 다른 사업의 부가 조건 발견)이다. 각각의 원인을 수정한 round3_release가 최종 코드 실행이다. 자동 핵심 점수와 답변 전체의 품질은 다르므로 전체 검토는 review.md를 함께 확인해야 한다. 이전 원문 제한 버전 보고서는 ../round3에 보존했다.

새로운 질문에서 동일한 성능을 보장하지 않는다. 원본 자체의 오류·누락·최신성과 의미에 따른 근거 선택의 불확실성은 남을 수 있다. 인용 정확도는 grounding-audit.json, 실제 답변은 results.md와 results.json에서 확인할 수 있다.
