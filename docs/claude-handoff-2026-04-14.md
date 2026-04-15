# Claude Handoff Prompt (2026-04-14)

> 2026-04-14 추가 업데이트: 런타임 코드는 `server/`로 이동했고, React 클라이언트가 `client/`로 분리되었습니다. 기존 `src/*`, `tests/*`, `public/*` 경로는 각각 `server/src/*`, `server/tests/*`, `server/public/*`로 해석해야 합니다.

아래 프롬프트를 Claude에게 그대로 전달해서 작업을 이어가세요.

---

You are taking over a Node.js local agent server project at:

- `/Users/hwanghochan/workspace/playground/doppelganger`

Please continue from the current implementation state without reverting unrelated behavior.

## Primary Context

This app has multiple domains (`slack_mention`, `github_review`, `code_execution`).
The current focus is **Slack mention reply assistant + project code analysis**.

Recent product decisions already implemented:

1. Slack project analysis must run against `master` branch.
2. For fromm-web analysis context, do not use `fromm-web-service-reference.md`.
3. Service docs are resolved by repo family:
   - fromm repos -> `docs/fromm/...`
   - kiwee repos -> `docs/kiwee/...`
4. fromm docs use fixed files:
   - `docs/fromm/backoffice.md`
   - `docs/fromm/partner.md`
   - `docs/fromm/channel.md`
   - `docs/fromm/store.md`
5. `fromm-web-service-reference.md` is intentionally excluded from Slack analysis prompt context.
6. Further repo-family expansions remain a separate follow-up task.
7. Slack 코드 분석 화면에서 저장소/분석 에이전트 수동 선택 UI는 제거하고 자동 선택으로 동작한다.
8. Slack 코드 분석은 진행률(`progressStep/Total/Percent/Label`)을 상태에 기록하고 UI에 표시한다.
9. Slack 답변 생성은 Claude 우선(haiku 의도)으로 시도하고, Claude 생성이 불가하면 Codex로 자동 폴백한다.
10. 코드 검토는 별도 요청 없이 자동으로 시작되며, 기본 초안에는 코드 검토 컨텍스트를 포함하지 않는다.
11. 코드 검토 컨텍스트를 반영한 초안은 별도 버튼으로 재생성한다.
12. 스토어/상품 정보 파악 요청 시 API 사용 경로보다 도메인 정보/정책/상품 정의 근거를 우선 찾도록 프롬프트를 보정했다.
13. Slack 답변 생성에서 Claude 실패가 반복되면 짧은 쿨다운 동안 Claude 재시도를 건너뛰고 Codex를 우선 사용한다.
14. Slack 초안 저장 시 최신 task payload를 기준으로 병합해, 비동기 코드리뷰 상태(`codeReview.analysisStatus`)가 오래된 값으로 덮어써지지 않게 한다.
15. Slack 코드분석 진행률은 완료 전 100%가 되지 않도록 총 단계를 6으로 조정하고, 실행 중 표시는 최대 99%로 제한한다.
16. Slack 코드분석 에이전트 실행은 기본 무제한이며, 필요 시 `SLACK_CODE_REVIEW_TIMEOUT_SECONDS`를 명시해 제한을 적용할 수 있다.
17. 기존 레거시 상태(`running`인데 진행률이 이미 완료치)에서는 UI에서 정체 복구용 재실행 버튼을 노출한다.
18. Slack 답변 초안은 개발자 중심 표현보다 기획/디자인/운영 담당자가 이해하기 쉬운 워딩으로 정리한다.
19. 공유/확인 요청에 특정 요소(범위, 우선순위, 일정 등)가 언급되면, 초안 답변에 해당 요소의 짧은 정의를 포함한다.
20. `code_execution` 작업 상세에서도 단계형 진행률(`executionProgress`)을 표시한다.
21. 프로세스 재시작 등으로 백그라운드 작업이 중단되면 `running` 고정 상태가 남지 않도록 자동 복구한다.
22. `hovis` 고유 명칭은 사용자 노출에서 `외부 에이전트 연결`로 대체하고, 생성 공급자 키는 `external`을 기준으로 사용한다.
23. `server/.env.example`는 8번째 줄 이후 키의 값 영역을 기본값이 아닌 키 설명 텍스트로 유지한다.
24. React 코드 분석 화면은 좌측 작업 목록 없이 Slack/GitHub PR/코드 작업 생성 3개 패널 중심으로 표시한다.
25. Slack 상세 아티팩트에서 메시지/답글 본문(`artifact.content`)이 직접 노출되어야 한다.
26. Slack 상세 액션은 코드 분석 영역 하단(`코드 검토 실행`, `초안 생성`, `코드 기반 초안 생성`) + 본문 하단 우측(`전송`, `무시`) 배치를 따른다.
27. Slack 코드 분석이 불필요한 상태(`codeReview.enabled=false` + 비실행 상태)에서는 코드 분석 진행 영역을 노출하지 않는다.
28. React 클라이언트 스타일링은 Tailwind CSS를 사용한다 (`client/src/index.css` + Tailwind/PostCSS 설정). 기존 `client/src/styles.css`는 제거되었다.
29. Slack 전송 방식은 `답글/이모지` 토글 UI를 사용하고, 이모지 모드에서 프리셋 선택 및 이모지 단독 전송이 가능해야 한다.
30. Slack/GitHub/코드 작업 패널과 주요 하위 영역(분석/편집/아티팩트/생성/목록)은 접기/펼치기 토글을 지원해야 한다.
31. Slack 이모지 모드에서는 alias(`eyes`)뿐 아니라 실제 glyph(👀) 미리보기도 노출되어야 한다.
32. 상단 수동 동기화 액션은 `일괄 업데이트` 단일 버튼을 사용하며, 10분 자동 일괄 업데이트 코드는 주석 블록으로 유지한다.

## What Is Already Implemented

### 1) Slack code analysis fixed to master branch

In `src/domains/slack-mention-domain.js`:

- `CODE_ANALYSIS_BASE_BRANCH = 'master'` is defined.
- `runCodeReview(...)` now creates a temporary git worktree at `master` via:
  - `createMasterAnalysisWorkspace(...)`
- Scope inference + code evidence analysis run inside that temporary `master` worktree.
- Worktree is cleaned up in `finally`.
- Analysis result state now includes:
  - `analysisBaseBranch: 'master'`

### 2) Service document input resolved by repo family

In `src/domains/slack-mention-domain.js`:

- `SERVICE_REFERENCE_DOC_GROUPS` maps:
  - `fromm` -> `backoffice.md`, `partner.md`, `channel.md`, `store.md`
  - `kiwee` -> `README.md`, `api-reference.md`, `architecture.md`, `kiwee-admin.md`, `kiwee-app.md`, `kiwee-web.md`
- `buildRepositoryContextSnapshot(...)` resolves group by selected repo name:
  - repo name includes `fromm` => reads from `<config.cwd>/docs/fromm`
  - repo name includes `kiwee` => reads from `<config.cwd>/docs/kiwee`
- Previous broad README/docs scan logic is removed from this path.

### 3) Prompt content updated

Scope prompt section now explicitly says it uses:

- repository structure + service docs (backoffice/partner/channel/store)

### 4) Tests updated and passing

`tests/slack-mention-domain.test.js` includes assertions that:

- fromm scope prompt contains:
  - `docs/fromm/backoffice.md`
  - `docs/fromm/partner.md`
  - `docs/fromm/channel.md`
  - `docs/fromm/store.md`
- scope prompt does **not** contain:
  - `fromm-web-service-reference.md`
- kiwee scope prompt contains:
  - `docs/kiwee/README.md`
  - `docs/kiwee/api-reference.md`
  - `docs/kiwee/architecture.md`
  - `docs/kiwee/kiwee-admin.md`
  - `docs/kiwee/kiwee-app.md`
  - `docs/kiwee/kiwee-web.md`
- analysis state includes:
  - `analysisBaseBranch === 'master'`

All tests currently pass:

- `npm test` -> pass (50/50)

### 5) Slack 코드 분석/답변 UX 변경

변경 파일:

- `src/domains/slack-mention-domain.js`
- `src/task-service.js`
- `src/server.js`
- `src/web/render.js`
- `public/styles.css`

주요 변경:

- 코드 분석 실행 시 저장소를 `autoSelectCodeReviewRepository(...)`로 자동 선택.
- 코드 분석 상태에 진행률 필드 추가:
  - `progressStep`
  - `progressTotalSteps`
  - `progressPercent`
  - `progressLabel`
- `runCodeReview(...)` 단계별로 진행률을 갱신하고 실패 시 실패 단계 라벨을 남김.
  - 총 단계는 6이며, 코드 근거 분석 중 단계는 `5/6`(83%)로 표시되어 완료 전 100%가 노출되지 않음.
- Slack 답변 생성:
  - Claude 우선 시도 후 실패(`fallback:*`) 시 Codex 재시도.
  - Claude 실패 직후에는 쿨다운(10분) 동안 Claude 재시도를 생략하고 Codex로 바로 생성.
  - 기본 초안 생성에서는 `includeCodeReviewContext=false`.
  - 별도 버튼으로 `includeCodeReviewContext=true` 생성 가능.
  - 초안 저장은 `repo.getTask(task.id)` 최신 payload를 기준으로 병합하여 진행 중/완료 코드리뷰 상태가 stale payload로 롤백되지 않음.
  - fallback/모델 결과 모두 비개발자 친화 표현으로 후처리(`스키마 -> 항목 구조` 등).
  - 공유/확인 요청에서 요소가 감지되면 `요청 기준에서 {요소}는 ...` 형식의 정의 문장을 답변에 삽입.
- 코드분석 에이전트 실행:
  - `agent.runner.runExec(...)`에 timeout 적용 가능하도록 확장.
  - Slack 코드분석(`infer scope` + `code evidence`) 실행 시 `SLACK_CODE_REVIEW_TIMEOUT_SECONDS`를 전달.
- 서버 라우팅:
  - `POST /tasks/:id/code-review`는 `startSlackCodeReview(...)`로 비동기 시작 후 즉시 응답/리다이렉트.
  - `GET /tasks/:id` / `GET /api/tasks/:id`에서 슬랙 태스크의 코드 검토를 자동 시작.
  - `POST /internal/poll/slack-mentions` 이후 `analysisStatus=not_requested` 태스크의 코드 검토 자동 시작.
- UI:
  - Slack 코드 분석 카드에서 저장소/에이전트 선택 입력 제거.
  - 분석 중 진행률 바와 단계 텍스트 노출.
  - `running` 상태이지만 진행률이 완료치(step>=total)인 경우 정체 상태로 간주하고 “코드 검토 다시 실행 (정체 복구)” 버튼 노출.
  - Slack 답변 “초안 다시 생성”은 기본(코드검토 미반영) 생성.
  - 코드검토 완료 시 “코드검토 반영 초안 생성” 버튼 노출.
  - Slack 답변 생성 안내는 Claude 우선, 실패 시 Codex 자동 전환.
  - 분석 running 상태에서는 task 상세 화면 자동 새로고침(3초).

### 6) Code Execution 진행률 UI/상태 추가

변경 파일:

- `src/domains/code-execution-domain.js`
- `src/web/render.js`
- `tests/code-execution-domain.test.js`

주요 변경:

- `code_execution` 결과에 `executionProgress` 구조를 추가:
  - `phase`
  - `label`
  - `currentStep`
  - `totalSteps`
  - `percent`
  - `reviewRound`
  - `reviewTotalRounds`
- 단계 진행 기준:
  - 작업 환경 점검 -> 계획 생성 -> 코딩 -> 리뷰/수정(3라운드) -> PR 초안 -> 완료
  - 총 단계 8, 완료 시 100%
- 코드 작업 상세 UI에 진행률 카드(퍼센트 바 + 단계 텍스트 + 리뷰 라운드)를 노출.
- 실행 중 상태에서는 진행률 표시를 최대 99%로 제한하고, 완료 상태(`awaiting_approval`, `done`)에서 100%를 노출.

### 7) 중단 작업 자동 복구(러닝 고정 방지)

변경 파일:

- `src/task-service.js`
- `src/domains/code-execution-domain.js`
- `src/web/render.js`
- `tests/task-service.test.js`
- `tests/code-execution-domain.test.js`

주요 변경:

- `TaskService` 생성 시 `recoverInterruptedBackgroundJobs()`를 실행해 중단 상태를 자동 복구.
  - `code_execution` + `status=running` -> `failed`로 전환, `executionProgress.phase='failed'` 기록, 복구 실행 로그(`recover_code_execution_run`) 남김.
  - `slack_mention`의 `payload.codeReview.analysisStatus='running'` -> `failed`로 전환, 복구 실행 로그(`recover_slack_code_review`) 남김.
- `code_execution` 런타임 실패(`runTask` catch) 시에도 `executionProgress.phase='failed'`를 항상 기록해 UI/상태 일관성 유지.
- 실행 이력 액션 라벨에 복구 액션 한글 레이블 추가.

### 8) 외부 에이전트 네이밍 전환

변경 파일:

- `src/config.js`
- `src/generation-client.js`
- `src/connectors/hovis-review-client.js`
- `src/llm-service.js`
- `src/web/render.js`
- `src/app.js`
- `README.md`
- `server/.env.example`
- `tests/config.test.js`
- `tests/generation-client.test.js`
- `tests/llm-service.test.js`

주요 변경:

- 생성 공급자에서 `hovis` 별칭은 내부 호환용으로만 유지하고, 정규화 결과는 `external`로 통일.
- 사용자 노출 provider 라벨은 `외부 에이전트 연결`로 표시.
- 외부 에이전트 실행 커맨드는 `EXTERNAL_AGENT_COMMAND`를 기본 키로 사용하고, 레거시 `HOVIS_COMMAND`는 fallback으로만 지원.
- GitHub 리뷰 외부 에이전트 결과 provider 값은 `external_agent`로 저장.
- `server/.env.example` 8줄 이후 모든 키의 값은 기본값 대신 설명 텍스트로 변경.

### 9) React 패널 구조 및 Slack 아티팩트 본문 표시

변경 파일:

- `client/src/App.tsx`

주요 변경:

- 좌측 작업 목록 영역 제거.
- 상단/메인 구조를 `Slack`, `GitHub PR`, `코드 작업 생성` 3개 독립 `section.panel`로 재구성.
- 섹션 간 단일 상세 선택 강제 없이 각 섹션 상세를 동시에 볼 수 있는 구조로 유지.
- 코드 작업 상세는 `코드 작업 생성` 내부 하단(`create-task-bottom`)으로 이동.
- Slack 상세 아티팩트에서 `slack_message` 타입의 `content`를 그대로 렌더링해 메시지/답글 본문을 확인 가능.

### 10) Slack 상세 액션 단순화

변경 파일:

- `client/src/App.tsx`

주요 변경:

- Slack 상세에서 `초안 저장`, `승인` 버튼 제거.
- 코드 분석 섹션 하단에만 `코드 검토 실행`, `초안 생성`, `코드 기반 초안 생성` 버튼 노출.
- 본문(답글 textarea) 하단 우측에 `전송`, `무시` 버튼 배치.
- `codeReview.enabled=false` 및 분석 비실행 상태에서는 코드 분석 진행 섹션 미노출.

### 11) Slack 이모지 전송 UI 복구 + 섹션 접기/펼치기

변경 파일:

- `client/src/App.tsx`

주요 변경:

- Slack 초안 편집에서 전송 방식을 드롭다운이 아니라 `답글/이모지` 토글 버튼으로 노출.
- 이모지 모드에서 리액션 이름 입력 + 프리셋(`eyes`, `thumbsup`, `white_check_mark`, `rocket`, `pray`) 선택 제공.
- 이모지 모드에서 alias 기반 실제 glyph 미리보기 영역을 함께 제공.
- 이모지 모드 전송 시 리액션 이름이 없으면 클라이언트에서 즉시 검증.
- 상위 패널(Slack/GitHub/코드 작업)과 하위 섹션(코드 분석, 초안 편집, 메시지/답글, 코드 작업 생성, 코드 작업 목록)에 접기/펼치기 버튼 추가.

### 12) React 스타일링 Tailwind 전환

변경 파일:

- `client/package.json`
- `client/postcss.config.cjs`
- `client/tailwind.config.cjs`
- `client/src/index.css`
- `client/src/main.tsx`
- `client/src/App.tsx`
- `client/src/styles.css` (삭제)

주요 변경:

- Tailwind CSS + PostCSS 설정 추가.
- React 엔트리에서 `index.css`를 로드하고 Tailwind 레이어(`@tailwind base/components/utilities`)를 사용.
- App UI의 기존 커스텀 클래스 스타일을 Tailwind 유틸리티 클래스로 대체.

### 13) Slack/GitHub 동기화 액션 통합

변경 파일:

- `client/src/App.tsx`

주요 변경:

- 헤더의 `Slack 멘션 업데이트`, `GitHub PR 후보 업데이트` 버튼을 제거하고 `일괄 업데이트` 버튼으로 통합.
- `runBatchUpdate()`에서 `pollSlackMentions()` + `pollGitHubReviews()`를 순차 실행.
- 10분 주기 자동 `일괄 업데이트`용 `useEffect` 코드를 주석으로 추가(현재 비활성).

## Key Files To Read First

1. `src/domains/slack-mention-domain.js`
   - constants near top:
     - `CODE_ANALYSIS_BASE_BRANCH`
     - `SERVICE_REFERENCE_DOC_GROUPS`
   - doc snapshot:
     - `buildRepositoryContextSnapshot(...)`
     - `resolveServiceReferenceDocGroup(...)`
   - master worktree utilities:
     - `createMasterAnalysisWorkspace(...)`
     - `resolveAnalysisFolderWorkdir(...)`
   - main flow:
     - `runCodeReview(...)`

2. `tests/slack-mention-domain.test.js`
   - test:
     - `"slack mention domain keeps default no-repo-lookup and runs auto repository analysis from detail action"`

3. `src/task-service.js`
   - `runSlackCodeReview(...)`
   - `startSlackCodeReview(...)`

4. `src/server.js`
  - route: `POST /tasks/:id/code-review`
  - route: `POST /tasks/:id/draft` (slack 도메인 생성 처리)

5. `src/web/render.js`
   - Slack detail UI code review section (자동 선택/진행률)
6. `src/domains/code-execution-domain.js`
   - `executionProgress` 업데이트 로직
   - `runTask(...)` / `runReviewLoop(...)` 단계 진행률 갱신
7. `src/task-service.js`
   - `recoverInterruptedBackgroundJobs()` 복구 로직

## Important Constraints

- Do not change `code_execution` domain behavior unless explicitly requested.
- Do not reintroduce `fromm-web-service-reference.md` in Slack analysis context.
- Keep master-branch analysis behavior.
- Keep existing Korean UX/text style where already used.
- Keep docs lookup rooted at `<config.cwd>/docs` and grouped by repo family (`fromm` / `kiwee`).

## Next Task Queue (What To Do Next)

1. 운영 관점 개선(선택):
   - 자동 저장소 선택 근거(score/reason)를 UI에서 더 구조적으로 표시.
2. 리포지토리 패밀리 확장(별도 작업):
   - 현재 `fromm/kiwee` 동작은 유지하고 신규 패밀리는 명시 요청 시 추가.

## Verification Checklist After Any Change

Run:

1. `node --test tests/slack-mention-domain.test.js`
2. `node --test tests/code-execution-domain.test.js`
3. `npm test`

Ensure:

- no regression in `runCodeReview(...)`
- no regression in draft regeneration after analysis
- code_execution 실행 중/완료 단계에서 진행률(`executionProgress`)이 올바르게 갱신되고 UI에 표시됨
- 프로세스 재시작/중단 후에도 `running` 상태가 남지 않고 자동 복구 로그가 남음
- no reference to legacy `fromm-web-service-reference.md` in scope prompt
- fromm repos resolve docs under `docs/fromm`
- kiwee repos resolve docs under `docs/kiwee`

---

If you make further edits, provide:

- changed files
- why each changed file changed
- test results
- any unresolved risk
