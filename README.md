# Doppelganger Agent Server

A local agent server for company workflows.

Project layout:
- `server/`: Node.js API/automation runtime (existing domain logic 유지)
- `client/`: React + Vite UI (신규 기본 UI)
- `docs/`: fromm/kiwee 분석 문서 및 운영 문서

Current state:
- Slack mention handling is implemented end-to-end, including automatic summary and reply-draft generation during polling.
- Slack mention detail supports optional manual repository analysis for deeper replies, while default polling/drafting does not inspect repositories.
- GitHub PR review is implemented for configured repositories, with open PR candidate polling, draft PR skip, duplicate-review skip, and manual selection from the web UI before posting comments.
- Local code execution is implemented with prompt planning, optional planning/design phases, coding, review loops, and PR creation.
- Meeting recording is implemented in the React UI with Korean real-time transcript capture (1s refresh) and Confluence paste-ready summary document generation.

## Requirements
- Node.js 22+
- SQLite available through Node's built-in `node:sqlite`

## Setup
1. Copy `server/.env.example` to `server/.env`.
2. Fill in the server/service keys you want to use.
3. Set client API target in `client/.env`:
   ```bash
   VITE_SERVER_URL=http://127.0.0.1:4318
   ```
   - If client and server origins differ in dev, add allowed origins in `server/.env`:
     ```bash
     APP_CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
     ```
4. Start the server:
   ```bash
   npm start
   ```
5. Start the client (development):
   ```bash
   npm run dev:client
   ```
6. Open:
   - React UI: `http://127.0.0.1:4318/app` (build 기준) 또는 Vite dev URL
   - Legacy SSR UI: `http://127.0.0.1:4318/tasks`

## Slack scopes
Read token should be able to:
- search messages
- read thread history in the channel types you care about

Write token should be able to:
- post thread replies
- add reactions to the mentioned message

A practical setup is often:
- read token: user token with `search:read` and relevant history scopes
- write token: bot or user token with `chat:write`
- if you want emoji reactions too: add `reactions:write`
- if you want to ignore specific channels during polling: set `SLACK_IGNORE_CHANNELS` (comma-separated channel IDs or channel names, e.g. `C12345,#ops-alerts`)

## Cron example
```cron
*/10 * * * * cd /Users/hwanghochan/workspace/playground/doppelganger && /usr/bin/env node server/src/cli.js poll slack-mentions >> .local/cron.log 2>&1
```

## Slack manual code review in detail view
- By default, Slack polling/draft generation does not query repositories.
- In Slack task detail, click `코드 검토 실행` to run a read-only Codex/Claude analysis from thread context.
- 코드 검토 실행 시 에이전트가 스레드 대화 + 저장소 문서(`README`, `docs/`)를 먼저 읽고 저장소/조회 폴더를 자동 선택합니다. 고정 키워드 매핑 규칙에는 의존하지 않습니다.
- After analysis completes, the server regenerates the reply draft with code evidence.
- This step does not modify repository files.
- 코드 검토 결과가 요청 의도에서 이탈했다고 감지되면(예: 상품 정보 요청인데 API 사용 방식만 설명), 재검증 1회를 수행하고 계속 이탈 시 실패로 종료합니다.
- 근거 링크는 본문 텍스트에 삽입하지 않고, 초안 메타데이터로 저장되어 상세 화면의 본문 하단 `근거 링크` 영역에 별도로 표시됩니다.
- Slack/GitHub/코드작업 상세에는 실행 이력을 시간순으로 확인할 수 있는 `작업 타임라인` 섹션이 제공됩니다.
- Slack 답변 전송 시 사용자가 최종 수정한 본문이 로컬 스타일 메모리에 누적되고, 이후 초안 생성 프롬프트에 반영되어 어투/문장 길이/표현 습관을 점진적으로 맞춥니다.

## Meeting recording workflow
1. Open the `회의 기록` panel in `/app`.
2. Click `시작` to begin browser speech recognition (`ko-KR`).
3. During recording, transcript updates every 10 seconds in `실시간 전사`.
4. Use `일시정지` / `재개` for breaks without ending the session.
5. Click `중지` to stop recording. The transcript panel is refined for word-level recognition/grammar/spelling while preserving original line flow, then the Confluence draft is generated automatically.
6. Review `Confluence 문서 초안` and click `문서 복사` to paste into Confluence.

Notes:
- Transcript and generated document are session-local UI state (not persisted to DB).
- Browser speech recognition support is required (Chrome-family recommended).

## Scripts
- `npm start`: run the HTTP server
- `npm run dev`: run the HTTP server with watch mode
- `npm run dev:client`: run the React client in Vite dev mode
- `npm run build:client`: build the React client (`client/dist`)
- `npm run poll:slack`: perform one Slack mention poll
- `npm run poll:github`: perform one GitHub PR review poll
- `npm test`: run the test suite

## Generation providers
- `GENERATION_PROVIDER=cli|openai|fallback|external` (default: `cli`)
- `GENERATION_AGENT_PROVIDER=codex|claude` (default: `codex`)
- Optional per-scope override:
  - `SLACK_GENERATION_PROVIDER`, `SLACK_GENERATION_AGENT_PROVIDER`
  - `GITHUB_REVIEW_PROVIDER`, `GITHUB_REVIEW_AGENT_PROVIDER`
  - `CODE_PLANNING_PROVIDER`, `CODE_PLANNING_AGENT_PROVIDER`
  - `MEETING_NOTES_PROVIDER`, `MEETING_NOTES_AGENT_PROVIDER`
- `EXTERNAL_AGENT_COMMAND` sets the external-agent review CLI executable.
  - 실행 방식은 `pr` 서브커맨드를 호출하고 PR URL을 stdin으로 전달합니다.
- `GENERATION_TIMEOUT_SECONDS` controls CLI generation timeout (default: 90s)
- `GENERATION_TIMEOUT_SECONDS=0` disables global generation timeout
- Optional per-scope timeout:
  - `SLACK_GENERATION_TIMEOUT_SECONDS`
  - `GITHUB_REVIEW_TIMEOUT_SECONDS`
  - `CODE_PLANNING_TIMEOUT_SECONDS`
  - `MEETING_NOTES_TIMEOUT_SECONDS`
  - Set any of them to `0` to disable timeout for that scope only

## GitHub review workflow
1. Set `GITHUB_TOKEN`, `GITHUB_OWNER`, and `GITHUB_REPOSITORIES`.
2. For `knowmerce/fromm-web`, use:
   - `GITHUB_OWNER=knowmerce`
   - `GITHUB_REPOSITORIES=fromm-web`
3. Choose generation mode:
   - CLI-first: `GENERATION_PROVIDER=cli` (default)
   - OpenAI: `GENERATION_PROVIDER=openai` + `OPENAI_API_KEY`
   - External agent for GitHub review only: `GITHUB_REVIEW_PROVIDER=external` (+ `EXTERNAL_AGENT_COMMAND` if needed)
4. Run `npm run poll:github` or click `GitHub PR 후보 가져오기` in the web UI.
5. The poll will:
   - fetch all open PRs in the configured repositories
   - skip draft PRs
   - skip PRs authored by the authenticated GitHub user
   - skip PRs already reviewed by the authenticated GitHub user
   - create/update candidate tasks in the local queue
6. Open a candidate PR from the home screen, generate or edit the draft review, then post as `COMMENT`.
7. If generation fails, the task stays editable with fallback summary so you can retry or post manually.
8. Once a PR has been reviewed, the poll does not review it again.
9. GitHub 근거 링크는 리뷰 본문에 삽입하지 않고 초안 메타데이터로 저장되며, 상세 화면의 본문 하단 `근거 링크` 영역에서 확인합니다.

## Code execution workflow
1. Put the repositories you want to work on under `~/workspace`.
2. Choose default agent provider with `AGENT_PROVIDER` (`codex` or `claude`).
3. Ensure the selected CLI is available on PATH:
   - Codex: `CODEX_COMMAND` (default `codex`)
   - Claude: `CLAUDE_COMMAND` (default `claude`)
4. Open `http://127.0.0.1:4318/app` and use the project picker in the "코드 작업 생성" 영역.
5. Select the agent (`Codex` or `Claude`) per task.
6. The server will generate a prompt plan, optionally run planning/design phases, run a coding agent, perform three review loops, and stop before PR creation.
7. In task detail, `PR 생성` appears only after step `8/8` is complete.
8. Click `PR 생성`, enter the branch name in the modal, then push + PR creation runs with that branch.
9. 코드 작업 실행 자체는 `WORKSPACE_ALLOWLIST`를 기준으로 허용되며, `GITHUB_REPOSITORIES`에 없는 저장소도 실행할 수 있습니다.
10. 단, `GITHUB_REPOSITORIES`에 없는 저장소는 `PR 생성` 단계에서만 제한됩니다.

### PR creation rules
- Source template: `<selected repository>/.github/PULL_REQUEST_TEMPLATE.md`
- PR title format: `[SERVICE_PREFIX/BRANCH_TOKEN] PR_SIMPLE_SUMMARY`
- `SERVICE_PREFIX` is inferred from repo/project metadata (fallback: `SERVICE`).
- `BRANCH_TOKEN` is the last segment of the input branch name (e.g. `feature/FROMM-3372` -> `FROMM-3372`).
- If the template includes placeholders, these are replaced:
  - `{{PR_SIMPLE_SUMMARY}}`
  - `{{PR_SUMMARY}}`
  - `{{DOPPELGANGER_PR_SUMMARY}}`
- If placeholders are not found, generated summary is appended below the template.
- If GitHub returns `Validation Failed: not all refs are readable`, PR creation retries with `owner:branch` head format and short backoff.

### Code execution step map (`executionProgress.currentStep`)
- `0`: queued (작업 시작 대기)
- `1`: 작업 환경 점검 + 브랜치 준비
- `2`: 프롬프트/기획/디자인 계획 생성
- `3`: 코딩 에이전트 실행
- `4`: 리뷰/수정 라운드 1
- `5`: 리뷰/수정 라운드 2
- `6`: 리뷰/수정 라운드 3
- `7`: PR 초안 정리
- `8`: 코드 작업 완료

Resume behavior:
- `코드 작업 재개`는 항상 1단계부터 다시 시작하지 않습니다.
- 실패/중단 시점의 체크포인트(`executionProgress.currentStep`, `phase`, 저장된 review rounds/artifacts)를 기준으로 가능한 가장 가까운 단계부터 이어서 실행합니다.
- UI에서는 진행 카드의 `n/8` 표시 아래에 현재 단계에서 수행 중인 작업 요약 한 줄을 함께 표시합니다.
- UI에서는 진행 카드 우상단에 현재 단계 기준 경과 시간(초 단위, `task.updated_at` 기반)을 표시합니다.
- UI에서는 코드 작업 상세에 `리뷰 라운드 내용` 영역이 표시되며, `result.reviewRounds`와 `review_round/patch_round` 아티팩트를 합쳐 각 라운드의 검토/수정 내역을 확인할 수 있습니다.
- 코드 작업 완료 시 로컬 저장소는 `restoreBranch`(기존 브랜치)로 자동 복귀하며, 자동 생성된 작업 브랜치(`doppelganger/...`)는 로컬에서 삭제됩니다.
- PR 생성 시 작업 브랜치가 이미 삭제된 상태면 `result.sourceCommit` 기준으로 임시 복구해 push/PR 생성 후 다시 정리합니다.

## Notes
- 현재 서버는 기존 Node.js 런타임을 유지하고, TypeScript 전환 기반(`server/tsconfig.json`)만 먼저 적용했습니다.
- 클라이언트는 Next.js 대신 React + Vite로 분리해 서버 도메인 로직과 UI 배포 수명주기를 분리했습니다.
- `OPENAI_API_KEY` is optional unless the selected generation provider uses OpenAI.
- Default generation mode is CLI, so quota issues on OpenAI do not block normal usage.
- If `OPENAI_MODEL` is omitted, the server defaults to `gpt-5.3-codex`.
- The server stores local state in SQLite at `DATABASE_PATH`.
- The app binds to `127.0.0.1` by default for local-only access.
