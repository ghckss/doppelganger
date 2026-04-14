# Doppelganger Agent Server

A local agent server for company workflows.

Current state:
- Slack mention handling is implemented end-to-end, including automatic summary and reply-draft generation during polling.
- Slack mention detail supports optional manual repository analysis for deeper replies, while default polling/drafting does not inspect repositories.
- GitHub PR review is implemented for configured repositories, with open PR candidate polling, draft PR skip, duplicate-review skip, and manual selection from the web UI before posting comments.
- Local code execution is implemented with prompt planning, optional planning/design phases, coding, review loops, and PR creation.

## Requirements
- Node.js 22+
- SQLite available through Node's built-in `node:sqlite`

## Setup
1. Copy `.env.example` to `.env`.
2. Fill in the service keys you want to use.
3. Start the server:
   ```bash
   npm start
   ```
4. Open `http://127.0.0.1:4318/tasks`.

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
*/10 * * * * cd /Users/hwanghochan/workspace/playground/doppelganger && /usr/bin/env node src/cli.js poll slack-mentions >> .local/cron.log 2>&1
```

## Slack manual code review in detail view
- By default, Slack polling/draft generation does not query repositories.
- In Slack task detail, choose a repository and click `코드 검토 실행` to run a read-only Codex/Claude analysis from thread context.
- 코드 검토 실행 시 에이전트가 스레드 대화 + 저장소 문서(`README`, `docs/`)를 먼저 읽고 조회 폴더를 추론합니다. 고정 키워드 매핑 규칙에는 의존하지 않습니다.
- After analysis completes, the server regenerates the reply draft with code evidence.
- This step does not modify repository files.

## Scripts
- `npm start`: run the HTTP server
- `npm run dev`: run the HTTP server with watch mode
- `npm run poll:slack`: perform one Slack mention poll
- `npm run poll:github`: perform one GitHub PR review poll
- `npm test`: run the test suite

## Generation providers
- `GENERATION_PROVIDER=cli|openai|fallback|hovis` (default: `cli`)
- `GENERATION_AGENT_PROVIDER=codex|claude` (default: `codex`)
- Optional per-scope override:
  - `SLACK_GENERATION_PROVIDER`, `SLACK_GENERATION_AGENT_PROVIDER`
  - `GITHUB_REVIEW_PROVIDER`, `GITHUB_REVIEW_AGENT_PROVIDER`
  - `CODE_PLANNING_PROVIDER`, `CODE_PLANNING_AGENT_PROVIDER`
- `HOVIS_COMMAND` sets the `hovis` CLI executable (default: `hovis`).
  - 실행 방식은 `hovis pr` 호출 후 PR URL을 stdin으로 전달합니다.
- `GENERATION_TIMEOUT_SECONDS` controls CLI generation timeout (default: 90s)
- `GENERATION_TIMEOUT_SECONDS=0` disables global generation timeout
- Optional per-scope timeout:
  - `SLACK_GENERATION_TIMEOUT_SECONDS`
  - `GITHUB_REVIEW_TIMEOUT_SECONDS`
  - `CODE_PLANNING_TIMEOUT_SECONDS`
  - Set any of them to `0` to disable timeout for that scope only

## GitHub review workflow
1. Set `GITHUB_TOKEN`, `GITHUB_OWNER`, and `GITHUB_REPOSITORIES`.
2. For `knowmerce/fromm-web`, use:
   - `GITHUB_OWNER=knowmerce`
   - `GITHUB_REPOSITORIES=fromm-web`
3. Choose generation mode:
   - CLI-first: `GENERATION_PROVIDER=cli` (default)
   - OpenAI: `GENERATION_PROVIDER=openai` + `OPENAI_API_KEY`
   - Hovis for GitHub review only: `GITHUB_REVIEW_PROVIDER=hovis` (+ `HOVIS_COMMAND` if needed)
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

## Code execution workflow
1. Put the repositories you want to work on under `~/workspace`.
2. Choose default agent provider with `AGENT_PROVIDER` (`codex` or `claude`).
3. Ensure the selected CLI is available on PATH:
   - Codex: `CODEX_COMMAND` (default `codex`)
   - Claude: `CLAUDE_COMMAND` (default `claude`)
4. Open `http://127.0.0.1:4318/tasks` and use the project picker in the "Create Code Task" form.
5. Select the agent (`Codex` or `Claude`) per task.
6. The server will generate a prompt plan, optionally run planning/design phases, run a coding agent, perform three review loops, and stop before PR creation.
7. Use the task detail page to create the PR after review.

## Notes
- `OPENAI_API_KEY` is optional unless the selected generation provider uses OpenAI.
- Default generation mode is CLI, so quota issues on OpenAI do not block normal usage.
- If `OPENAI_MODEL` is omitted, the server defaults to `gpt-5.3-codex`.
- The server stores local state in SQLite at `DATABASE_PATH`.
- The app binds to `127.0.0.1` by default for local-only access.
