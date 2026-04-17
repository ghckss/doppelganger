# Company Work Agent Server Plan

## Summary
- Build a local agent server that supports Slack mention response assistance, GitHub code review, and local code execution behind one shared platform.
- Implement Slack mention handling first, while keeping the task model, approvals, connectors, and UI reusable across implemented domains.
- Run on a personal or company-managed Mac. Reading and analysis are automated. Any write operation requires explicit user action from the local web UI.

## Architecture
- Core platform
  - `server/`에 `connector` layer(Slack, GitHub, OpenAI, local workspace execution).
  - `task` store backed by SQLite.
  - `approval` and `execution` history shared across domains.
  - `client/` React UI + `server/` API로 list/detail/review/draft/approval/execution 제공.
  - `cron/CLI` entrypoints for polling jobs.
- Domain workers
  - `slack_mention` is implemented now.
  - `github_review` and `code_execution` are implemented with the same interface and setup checks.

## Slack Mention Flow
1. A cron job runs every 10 minutes and calls `node server/src/cli.js poll slack-mentions`.
2. The poller uses Slack search to find fresh direct mentions of the configured user.
3. Each mention is normalized into a task and the parent thread is stored as artifacts.
4. The web UI shows one task at a time with thread context, summary, and editable reply draft.
5. The user can type a reply manually or regenerate/edit the suggested reply and send it through Slack API.

## Shared Task Model
- `new`: collected but not reviewed.
- `drafted`: summary and/or draft exists.
- `awaiting_approval`: ready for user decision.
- `done`: external write finished.
- `ignored`: intentionally skipped.
- `failed`: last execution failed.

## Keys Required
- Slack
  - `SLACK_READ_TOKEN`
  - `SLACK_WRITE_TOKEN`
  - `SLACK_USER_ID` optional if the read token already resolves to the user to track
- OpenAI
  - `OPENAI_API_KEY` optional for AI summary/draft generation. Without it the app falls back to a deterministic local summary.
- GitHub
  - `GITHUB_TOKEN`
  - `GITHUB_OWNER`
  - `GITHUB_REPOSITORIES`
- Local app
  - `DATABASE_PATH`
  - `APP_HOST`
  - `APP_PORT`
  - `SESSION_SECRET`
  - `APP_ENCRYPTION_KEY`

## Acceptance Criteria
- The server starts locally without third-party npm packages.
- Slack mention polling stores tasks and thread context in SQLite.
- The web UI supports review, draft generation, manual edit, ignore, approve, and send for Slack mention tasks.
- The system exposes connector readiness for Slack, GitHub, OpenAI, and local workspace execution.
- Tests cover repository behavior, Slack polling normalization, and LLM fallback behavior.
