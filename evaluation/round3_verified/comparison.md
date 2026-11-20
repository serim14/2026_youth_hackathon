# 동일 30문항 개선 전후 비교

동일 질문·정답·원본 데이터·모델·임베딩 차원·검색 개수로 비교했다. 기준은 실행 전에 acceptance.json에 정했다. 핵심 사실·인용 외에도 상황에 맞는 안내 상태와 연도 충돌 처리 여부를 확인한다. 아래 결과는 이미 발견된 실패를 수정한 뒤 재평가한 회귀 결과이며, 미사용 문항의 성능 추정치가 아니다.

| 항목 | 개선 전 | 개선 후 |
|---|---:|---:|
| 핵심 원본 항목·인용 | 23/30 (76.7%) | 30/30 (100.0%) |
| 핵심 항목 + 안내 사유 + 연도 구분 | 19/30 (63.3%) | 30/30 (100.0%) |
| 지정 정답 정책 검색 상위 3개 포함 | 24/28 (85.7%) | 28/28 (100.0%) |

수정된 실패: T03, T07, T12, T15, T18, T23, T25, T27, T28, T29, T30. 회귀: 없음.

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
| T15 | answered | answered | 1 | 1 | 통과 |
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

최초 수정 버전의 결과는 ../round3_improved/results.json에 별도 보존했다. 최초 수정은 핵심 항목 29/30이었으며, 다른 후보의 금액이 정보 부족 검사를 통과시키는 문제를 보완한 뒤 최종 실행했다. 이전 원문 제한 버전의 보고서는 ../round3에 보존했다.

새로운 질문에서 동일한 성능을 보장하지 않는다. 원본 자체의 오류·누락·최신성과 의미에 따른 근거 선택의 불확실성은 남을 수 있다. 인용 정확도는 grounding-audit.json, 실제 답변은 results.md와 results.json에서 확인할 수 있다.
