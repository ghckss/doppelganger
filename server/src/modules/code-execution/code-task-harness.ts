export type CodeTaskHarnessStage = 'coding' | 'review' | 'patch';

export interface CodeTaskHarnessRules {
  global: string[];
  coding: string[];
  review: string[];
  patch: string[];
}

/**
 * 코드 작업 하네스 규칙 정의.
 *
 * - `global`: 모든 단계(coding/review/patch)에 공통 적용
 * - `coding`: 코딩 에이전트 단계에만 적용
 * - `review`: 리뷰 에이전트 단계에만 적용
 * - `patch`: 패치(수정) 에이전트 단계에만 적용
 *
 * 각 항목은 프롬프트에 bullet 규칙으로 주입됩니다.
 */
export const CODE_TASK_HARNESS_RULES: CodeTaskHarnessRules = {
  global: [
    '요청 목표를 먼저 한 문장으로 재정의하고 범위를 임의 확대 해석하지 않는다.',
    '요청 범위 밖 기능/리팩터링/파일 이동/네이밍 변경/포맷 변경은 하지 않는다.',
    '기존 패턴, 스타일, 아키텍처를 우선 존중한다.',
    '변경은 항상 최소 diff 원칙으로 수행한다.',
    '관련 없는 파일, 경고, 린트/타입 이슈는 요청 범위 밖이면 건드리지 않는다.',
    '기존 공개 API 동작 및 하위 호환을 명시 요청 없이 깨지 않는다.',
    '보안/인증/권한/결제/데이터 손실 위험 영역은 보수적으로 처리한다.',
    '토큰/키/개인정보 등 민감정보를 코드/로그/테스트 데이터에 남기지 않는다.',
    '존재하지 않는 파일/함수/동작을 지어내지 않는다.',
    '파일 수정 전 역할과 영향 범위를 파악하고 호출부/사용처를 함께 확인한다.',
    'null/undefined, 비동기 실패, 경계 조건을 항상 점검한다.',
    '예외를 숨기지 말고 의미 있는 실패 경로를 유지한다.',
    'enum 사용을 지양하고 가능한 경우 union literal 타입으로 대체한다.',
    'any 타입은 금지하며, 불가피한 경우 범위를 최소화하고 이유를 notes에 남긴다.',
    '타입 변환에 단항 + 또는 "" + 패턴을 쓰지 않고 Number(), String(), toString()을 사용한다.',
    '상위 상대 경로(../)는 alias/절대 경로 체계가 있는 저장소에서만 금지한다. alias가 없으면 기존 import 관례를 따른다.',
    '상수 네이밍은 기존 저장소 규칙을 따르되, 명시 규칙이 있으면 PascalCase를 우선한다.',
    '검증 불가 항목은 생략하지 말고 실행 불가 사유를 남긴다.',
    '작업 트리는 항상 clean 상태로 유지하고 커밋은 의미 단위로 분리한다.',
    '커밋 메시지는 PREFIX: MESSAGE 형식을 지키고 WIP 커밋을 금지한다.',
    '자동 생성 파일/빌드 산출물/lockfile은 실제 필요 시에만 수정한다.',
    '작업 종료 시 변경 이유와 잠재 리스크를 짧게 요약한다.'
  ],
  coding: [
    '기존 유틸/훅/컴포넌트/헬퍼 재사용 가능성을 먼저 확인한다.',
    '과도한 추상화보다 현재 요구사항을 충족하는 단순한 구현을 우선한다.',
    '타입은 구체적으로 작성하고 any/과한 타입 단언(as)을 지양한다.',
    'nullable 값은 사용 직전에 안전하게 좁혀 처리한다.',
    '외부 API 응답은 신뢰하지 않고 shape 검증을 고려한다.',
    '비동기 로직은 중복 실행, race condition, 취소/실패 경로를 고려한다.',
    '재시도 로직은 멱등성/종료조건/백오프가 보장될 때만 적용한다.',
    '배열/객체 변환 시 원본 불변성을 유지한다.',
    'UI 변경 시 로딩/에러/빈 상태를 빠뜨리지 않는다.',
    'React에서는 effect 남용을 피하고 외부 동기화 목적일 때만 useEffect를 사용한다.',
    '데이터 패칭 목적의 useEffect 사용을 금지하고, 가능한 경우 TanStack Query를 사용한다.',
    'React에서는 derived state 중복 보관을 피하고 상태 출처를 명확히 한다.',
    '컴포넌트 선언은 기존 저장소 관례를 따르되, 팀 규칙이 없으면 FC<Props> + ComponentNameProps 패턴을 우선한다.',
    '조건 분기는 if-else 중첩보다 early return 패턴을 우선한다.',
    'mutateAsync는 의도를 드러내는 이름(예: submitOrder)으로 rename해서 사용한다.',
    '컴포넌트 길이가 약 200줄을 넘으면 분리 후보를 검토하되 import churn이 더 큰 경우 분리를 보류한다.',
    'Next.js App Router 문맥이면 page.tsx는 서버 컴포넌트로 유지하고 인터랙션은 별도 ClientPage로 분리한다.',
    'Next.js App Router 문맥이면 use client 경계는 leaf에 가깝게 배치한다.',
    'query key 체계가 있는 저장소면 queryKeys.ts(또는 동등한 중앙 모듈)에서 관리한다.',
    '스타일 단위는 기존 시스템을 우선하고, 명시되지 않으면 rem을 우선 사용하되 1px/2px 등 미세 단위 예외는 허용한다.',
    'Fragment 사용은 가능하면 <> 단축 문법을 우선한다.',
    '폼/요청 처리에서 중복 submit, stale response, 실패 복구를 고려한다.',
    '접근성 영향이 있는 UI 변경은 키보드 사용성과 aria를 함께 점검한다.',
    '문서화가 필요한 동작 변경은 관련 문서를 함께 갱신한다.',
    '테스트 추가가 가능하면 happy path와 실패 케이스를 함께 다룬다.'
  ],
  review: [
    '리뷰는 스타일보다 장애 가능성, 회귀, 유지보수 리스크를 우선 식별한다.',
    '지적은 코드 근거 기반으로 작성하고 추측성 코멘트는 금지한다.',
    '각 finding에는 문제 원인, 실패 시나리오, 영향 범위를 명시한다.',
    '코멘트는 actionable 하게 작성한다.',
    '변경 파일뿐 아니라 호출부/타입/테스트/상태 흐름을 함께 점검한다.',
    'null/undefined 처리 누락과 에러 handling 누락을 우선 점검한다.',
    '비동기 흐름의 race condition, 중복 요청/중복 submit 가능성을 점검한다.',
    'cleanup 누락(listener/timer/subscription) 여부를 점검한다.',
    'React stale closure, dependency 배열, derived state 중복을 점검한다.',
    '인증/권한/입력 검증/XSS/민감정보 노출 여부를 점검한다.',
    '공개 API 시그니처 변경의 breaking change 가능성을 점검한다.',
    'enum/any/상위 상대참조(../)/단일문자 제네릭(T,U,V) 남용 여부를 점검한다.',
    'default export는 Next.js page/layout 등 프레임워크 관례 위치에서만 사용되었는지 점검한다.',
    '.env 파일이 커밋에 포함되지 않았는지 점검한다.',
    'Next.js App Router 문맥이면 page.tsx에 직접 use client가 붙지 않았는지 점검한다.',
    '상태/스타일/데이터 패칭 라이브러리(Tailwind, styled-components, Redux, Zustand, SWR, TanStack Query) 혼용으로 인한 정책 위반 여부를 점검한다.',
    '테스트 범위가 변경 대비 충분한지, 실패 케이스를 포함하는지 점검한다.',
    '심각도와 우선순위(must/should/nit)를 구분해 정렬한다.',
    'findings가 없더라도 residual risk가 있으면 명시한다.',
    '리뷰 마지막에 핵심 리스크 1~3개를 요약한다.'
  ],
  patch: [
    '패치는 review finding 해결 범위 내에서 최소 diff로 수행한다.',
    'mustFix와 high severity 항목을 우선 해결한다.',
    '요청 범위 밖 스타일 정리/구조 개편/신규 기능 추가를 금지한다.',
    '명시적으로 요청되지 않은 리팩터링을 금지한다.',
    '기존 public API와 호출 시그니처를 명시 요청 없이 변경하지 않는다.',
    '기존 코드 구조/네이밍/export 방식을 가능한 유지한다.',
    '한 패치에서 여러 논리 변경을 섞지 않는다.',
    '가드 조건(null/bounds/status)을 우선 활용해 안전하게 수정한다.',
    '임시 우회가 필요하면 적용 조건을 좁게 두고 한계를 notes에 남긴다.',
    '패치가 인접 분기/흐름에 부작용을 만들지 않는지 확인한다.',
    'silent fallback보다 관측 가능한 안전 실패를 우선한다.',
    '기존 import 스타일(절대/상대)과 스타일 시스템(Panda CSS 등 저장소 규칙)을 유지한다.',
    '불필요한 주석/docstring/타입 어노테이션 추가를 금지한다.',
    '해결/미해결 항목을 resolvedFindingIds/declinedFindingIds로 명확히 남긴다.',
    'declined 항목은 기술적 이유와 영향 범위를 notes에 기록한다.',
    '관련 검증을 재실행하고 testsRun에 정확히 기록한다.',
    '테스트 추가가 어려우면 최소 검증 시나리오를 notes에 남긴다.',
    '라운드별 패치 커밋은 전용 커밋으로 분리한다.',
    '종료 전 작업 트리는 반드시 clean 상태여야 한다.'
  ]
};

function normalizeRules(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }
  return values
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function renderRuleList(values: string[]): string {
  return values.map((value) => `- ${value}`).join('\n');
}

function collectRuleGroups(stage: CodeTaskHarnessStage): Array<{ title: string; rules: string[] }> {
  const globalRules = normalizeRules(CODE_TASK_HARNESS_RULES.global);
  const codingRules = normalizeRules(CODE_TASK_HARNESS_RULES.coding);
  const reviewRules = normalizeRules(CODE_TASK_HARNESS_RULES.review);
  const patchRules = normalizeRules(CODE_TASK_HARNESS_RULES.patch);

  if (stage === 'coding') {
    return [
      { title: 'Global Rules', rules: globalRules },
      { title: 'Coding Stage Rules', rules: codingRules }
    ];
  }

  if (stage === 'review') {
    return [
      { title: 'Global Rules', rules: globalRules },
      { title: 'Review Stage Rules', rules: reviewRules }
    ];
  }

  return [
    { title: 'Global Rules', rules: globalRules },
    { title: 'Patch Stage Rules', rules: patchRules }
  ];
}

function stageGuidance(stage: CodeTaskHarnessStage): string[] {
  if (stage === 'coding') {
    return [
      'Treat rule mismatches as in-stage rework: fix them before returning final JSON when the fix is safe and in scope.',
      'Do not defer harness-only cleanup to review/patch stages unless the change is unsafe in the current run.'
    ];
  }

  if (stage === 'review') {
    return [
      'Prioritize behavioral regressions, structural risks, and policy/safety concerns.',
      'Do not raise findings for cosmetic/style-only harness mismatches that should already be handled in coding.'
    ];
  }

  return [
    'Apply review findings safely with minimal diff and avoid widening scope.'
  ];
}

export function buildCodeTaskHarnessSection(stage: CodeTaskHarnessStage): string {
  const groups = collectRuleGroups(stage).filter((group) => group.rules.length > 0);
  if (groups.length === 0) {
    return '';
  }

  const sections: string[] = [
    '## Execution Harness',
    'The following rules are quality guidance for this run.',
    'Do not abort execution solely for rule mismatch.',
    ...stageGuidance(stage)
  ];

  groups.forEach((group) => {
    sections.push(`### ${group.title}`);
    sections.push(renderRuleList(group.rules));
  });

  return sections.join('\n');
}

export function applyCodeTaskHarnessPrompt(stage: CodeTaskHarnessStage, prompt: string): string {
  const harnessSection = buildCodeTaskHarnessSection(stage);
  if (!harnessSection) {
    return prompt;
  }

  return [harnessSection, '', prompt].join('\n');
}
