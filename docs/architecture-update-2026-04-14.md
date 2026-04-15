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
