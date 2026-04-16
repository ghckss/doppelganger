# Architecture Update (2026-04-14)

## Decision Summary

1. Server runtime: **현행 Node.js 유지**
   - 이유: 현재 Slack/GitHub/code_execution 도메인 로직이 이미 운영 기능을 포함하고 있어, Rust/Spring 전환은 기능 리스크와 재검증 비용이 큼.
   - 즉시 조치: `server/tsconfig.json`을 추가해 TypeScript 전환 기반을 마련.

2. Client runtime: **React + Vite 채택**
   - 이유: 현재는 API와 UI가 같은 프로세스에서 동작하므로, 빠른 분리와 개발 생산성을 우선.
   - Next.js는 SSR/라우팅 전략 재설계까지 포함되어 범위가 커져 이번 단계에서 제외.

3. Repo structure: **`server/` + `client/` 분리**
   - 이유: 배포/빌드/실행 경로를 분리해 변경 범위를 축소하고 UI 교체를 독립적으로 진행하기 위함.
   - 구현: 기존 `src`, `public`, `tests`를 `server/*`로 이동, 신규 `client/` React 앱 추가.

## Implemented Changes

- Root scripts updated for split layout.
  - `npm start` -> `node server/src/index.js`
  - `npm run dev:client` -> Vite client dev server
  - `npm test` -> `node --test "server/tests/**/*.test.js"`
- Server routing updated:
  - `/` -> `/app` redirect
  - `/app` + `/app/assets/*` static serving from `client/dist`
  - Legacy SSR routes (`/tasks`) remain for compatibility.
- API action endpoints now accept JSON under `/api/tasks/:id/*` for React client integration.
- React client baseline added at `client/`:
  - task list/detail, polling triggers, draft actions, code-review trigger, code-execution actions, progress UI.
  - latest UI structure:
    - left-side task list panel removed.
    - Slack / GitHub PR / 코드 작업 생성 섹션을 각각 독립 `panel`로 분리.
    - Slack 섹션 아티팩트에서 메시지/답글 본문(`artifact.content`)을 직접 표시.
    - 코드 작업 상세는 코드 작업 생성 섹션 하단(`create-task-bottom`)으로 배치.
    - Slack 상세에서 `초안 저장`, `승인` 버튼을 제거하고, 하단 우측에 `전송`, `무시` 버튼을 배치.
    - Slack 코드 분석 영역은 `codeReview.enabled=false` 및 비실행 상태(`not_requested`)인 경우 숨김.
    - Slack 전송 방식은 `답글/이모지` 토글로 노출하고, 이모지 모드에서 프리셋(`:eyes:` 등) 선택과 이모지 단독 전송을 지원.
    - 이모지 모드에서 선택한 alias에 대응하는 실제 이모지 glyph(예: 👀) 미리보기를 함께 표시.
    - Slack/GitHub/코드 작업 주요 영역 및 하위 편집 영역은 접기/펼치기 토글을 지원.
    - 상단 데이터 동기화 액션은 도메인별 개별 버튼 대신 `일괄 업데이트` 단일 버튼으로 통합.
    - 10분 주기 자동 `일괄 업데이트` 코드는 주석 처리 상태로 코드에 포함(필요 시 활성화 가능).
    - `client/src/App.tsx`는 오케스트레이션 중심으로 축소하고, 도메인 패널을 `client/src/components/*Panel.tsx`로 분리.
    - 공통 UI 클래스/배지/진행바는 `client/src/components/common.tsx`, 화면 파생 상태/포맷 헬퍼는 `client/src/task-view.ts`로 분리.
    - 초기 진입 시 작업 목록 로드 및 선택 상세 로드를 `App.tsx` 이펙트로 복구.
    - 코드 작업 생성에서 `기획 단계 실행`, `디자인 단계 실행` 체크박스 기본값은 둘 다 해제(false).
    - `새로고침`은 목록만이 아니라 선택된 상세까지 함께 다시 조회하도록 변경.
    - Slack/GitHub/코드 작업 목록과 선택 상세는 `@tanstack/react-query`로 조회/캐시 관리.
    - Slack/GitHub/코드 작업 목록/상세는 페이지 새로고침 없이 10초 주기 API refetch로 자동 최신화.
    - GitHub PR 초안 생성/저장 후에는 선택 task의 최신 detail을 즉시 에디터 상태에 반영해, 브라우저 전체 새로고침 없이 초안 본문이 갱신되도록 수정.
    - 코드 작업 생성 직후 코드 작업 패널/목록 섹션을 자동으로 펼쳐 즉시 진행 상태를 확인 가능하도록 변경.
    - 코드 작업 상세 액션에 `코드 작업 재개` 버튼을 추가하고, 실패/중단 상태에서 `POST /api/tasks/:id/resume`로 기존 task를 재개 가능.
    - `코드 작업 재개`는 항상 1단계 재시작이 아니라 마지막 체크포인트(예: 코딩 3단계/리뷰 단계)부터 이어서 실행.
    - 코드 작업 진행 카드에서 `n/8` 단계 표기 아래에 현재 단계 작업 요약(한 줄 설명)을 함께 표시.
    - 코드 작업 진행 카드 우상단에 현재 단계 경과 시간(초 단위)을 표시.
    - 코드 작업 진행 카드 하단(단계 설명 행 우측)에 `PR 생성` 버튼을 배치하고, `8/8` 완료 시에만 노출.
    - `PR 생성` 클릭 시 브랜치명 입력 모달을 띄우고, 입력 브랜치 기준으로 push + PR 생성을 수행.
    - PR 본문은 대상 저장소의 `.github/PULL_REQUEST_TEMPLATE.md`를 우선 사용하고, 제목은 `[SERVICE_PREFIX/BRANCH_TOKEN] PR_SIMPLE_SUMMARY` 형식으로 생성한다(예: `feature/FROMM-3372` -> `[FRM/FROMM-3372] ...`).
    - 코드 작업 상세에 `리뷰 라운드 내용` 영역을 추가해, `result.reviewRounds`와 `review_round/patch_round` 아티팩트를 통합 렌더링하여 라운드별 검토/수정 내역을 확인할 수 있도록 했다.
    - GitHub `Validation Failed: not all refs are readable` 오류 시 `owner:branch` head 형식으로 자동 재시도하고, 기존 PR 존재 시 재사용 처리.
    - 코드 작업이 완료되면 로컬 작업공간은 기존 브랜치로 자동 복귀하고, 자동 생성 작업 브랜치는 삭제한다. PR 생성 시에는 필요하면 `sourceCommit`으로 브랜치를 복구해 push/PR 처리 후 다시 정리한다.
    - 코딩/패치 에이전트가 변경사항을 커밋하지 않고 종료하면 서버가 자동 커밋(`auto_commit_*`) 후 다음 단계를 계속 진행하도록 보강.
    - GitHub 리뷰 전송(`POST /pulls/:number/reviews`)에서 `422 Unprocessable Entity` 발생 시, `POST /issues/:number/comments`로 자동 폴백해 전송 실패를 방지.
  - client styling system:
    - 기존 `client/src/styles.css` 기반 스타일을 제거.
    - Tailwind CSS로 전환 (`client/src/index.css`, `tailwind.config.cjs`, `postcss.config.cjs`).
    - `App.tsx`는 유틸리티 클래스 중심으로 스타일링.

## Next Step Candidates

1. React 화면 기능 parity 확대
   - 현재 SSR 상세 페이지에 있는 고급 UI(아티팩트 상세 렌더링 등)와 동일 수준으로 확장.
2. Server TypeScript incremental migration
   - `server/src`부터 `*.ts` 전환 시작 (domain별 점진 전환).
3. CI split pipeline
   - server test + client build를 분리한 검증 파이프라인 구성.
