# fromm-web 모노레포 종합 문서

> fromm 플랫폼의 모든 웹 서비스를 담은 pnpm workspace 기반 모노레포.
> 아티스트-팬 소통, 굿즈 커머스, 채널 관리, 내부 운영 도구 등을 포함.

---

## 목차

1. [모노레포 개요](#1-모노레포-개요)
2. [앱 한눈에 비교](#2-앱-한눈에-비교)
3. [공유 패키지](#3-공유-패키지)
4. [빌드 시스템](#4-빌드-시스템)
5. [공통 아키텍처 패턴](#5-공통-아키텍처-패턴)
6. [환경 및 배포](#6-환경-및-배포)
7. [개별 앱 문서 링크](#7-개별-앱-문서-링크)
8. [신규 작업자/에이전트 온보딩 가이드](#8-신규-작업자에이전트-온보딩-가이드)

---

## 1. 모노레포 개요

```
fromm-web/
├── apps/                       # 웹 애플리케이션 (8개)
│   ├── backoffice/            # 내부 운영 어드민 (Vite SPA)         — 605 파일
│   ├── partner/               # 소속사/매니저 포털 (Vite SPA)       — 480 파일
│   ├── store/                 # 이커머스 스토어 (Next.js Pages)     — 1,092 파일 ★ 최대
│   ├── channel/               # 채널/팬커뮤니티 (Next.js Pages)     — 564 파일
│   ├── message/               # 메시지 앱 (Vite)                    — 137 파일
│   ├── account/               # 계정 관리 (Vite SPA)               — 74 파일
│   ├── app/                   # 앱 런처 (Vite SPA)                 — 12 파일
│   └── fromm/                 # 랜딩 페이지 (Astro)                — 4 파일
├── packages/                   # 공유 패키지 (8개)
│   ├── components/            # Panda CSS frommPreset (디자인 토큰)
│   ├── fromm/                 # 공통 유틸리티 라이브러리
│   ├── msw-handler/           # MSW(Mock Service Worker) 공용 핸들러
│   ├── ui/                    # 공유 UI 컴포넌트
│   ├── libs/                  # 공용 라이브러리
│   ├── fds/                   # Fromm Design System
│   ├── eslint-config-custom/  # ESLint 공용 설정
│   └── tsconfig/              # TypeScript 공용 설정
├── pnpm-workspace.yaml         # workspace: ["apps/*", "packages/*"]
├── turbo.json                  # Turborepo 파이프라인 설정
└── package.json                # 루트 스크립트 (build, format, typecheck, lint, test)
```

### 루트 명령어
```bash
pnpm build              # 전체 빌드 (turbo)
pnpm all                # format + lint + typecheck + test
pnpm dev:channel        # 개별 앱 개발 서버
pnpm dev:store
pnpm dev:partner
pnpm dev:backoffice
pnpm generate:types     # DTO 타입 자동 생성
```

---

## 2. 앱 한눈에 비교

| | **backoffice** | **partner** | **store** | **channel** |
|--|:---:|:---:|:---:|:---:|
| **사용자** | 내부 운영팀 | 소속사/매니저 | 소비자 (팬) | 팬/아티스트 |
| **프레임워크** | Vite SPA | Vite SPA | Next.js 14 Pages | Next.js 14 Pages |
| **라우팅** | React Router v7 | React Router v6 | Next.js `[M]/...` | Next.js Pages |
| **렌더링** | CSR | CSR | SSR/SSG/ISR | CSR + SSR |
| **스타일** | Panda CSS | Panda CSS | Panda CSS | Panda CSS |
| **서버 상태** | React Query v5 | React Query v5 | React Query v4 | React Query v5 |
| **글로벌 상태** | Jotai | Jotai | Jotai | Jotai |
| **폼** | React Hook Form | 커스텀 InputFields | Modular Forms + Valibot | Modular Forms + Valibot |
| **리치 텍스트** | TipTap | TipTap | — | — |
| **다국어** | — | — | next-translate (4개) | 커스텀 lazy i18n (4개) |
| **결제** | — | — | Portone/Toss/PayPal ★ | — |
| **분석** | — | — | Mixpanel + GA + GTM | Mixpanel |
| **에러 모니터링** | — | — | 커스텀 ErrorBoundary | Sentry |
| **웹뷰** | ❌ | ❌ | 웹뷰 + 브라우저 | ✅ 모바일 전용 |
| **소스 파일 수** | 605 | 480 | 1,092 | 564 |
| **핵심 복잡도** | goods 도메인 (20 쿼리) | 통계/정산 | 주문/결제 플로우 ★ | 포스트/댓글 시스템 |

### 4개 앱의 역할 관계

```
[backoffice] ──관리──→ 아티스트/그룹/소속사/채널/상품/VOD/이벤트/배너
                          ↓                    ↓              ↓
[partner] ──운영──→ 채널 콘텐츠/공지/일정/정산/멤버십/이벤트 참여자
                          ↓                    ↓
[channel] ←──팬 이용──→ 포스트/댓글/라이브/멤버십/공지/일정
[store]   ←──팬 구매──→ 굿즈/번들/결제/구독/VOD/이벤트 응모
```

---

## 3. 공유 패키지

| 패키지 | 역할 | 사용하는 앱 |
|--------|------|-----------|
| **@packages/components** | Panda CSS `frommPreset` (디자인 토큰, 색상, 타이포그래피, 간격) | 전체 |
| **@packages/fromm** | 공통 유틸리티 통합 관리 | 일부 |
| **@packages/msw-handler** | MSW 목 서비스 워커 공용 핸들러 | backoffice, partner, channel, store |
| **ui** | 공유 UI 컴포넌트 | 일부 |
| **eslint-config-custom** | ESLint 공용 규칙 | 전체 |
| **tsconfig** | TypeScript 공용 설정 | 전체 |
| **libs** | 공용 라이브러리 | 일부 |
| **fds** | Fromm Design System | 일부 |

---

## 4. 빌드 시스템

### Turborepo 파이프라인
```json
{
  "build:package": { "dependsOn": ["^build:package"], "cache": true },
  "build":         { "dependsOn": ["^build"], "outputs": [".next/**"] },
  "dev":           { "cache": false, "persistent": true },
  "format":        {},
  "typecheck":     {},
  "lint":          { "dependsOn": ["^lint"] },
  "test":          { "dependsOn": ["^test"] }
}
```

### DTO 타입 생성 방식

| 앱 | 방식 | 소스 |
|----|------|------|
| **backoffice** | `scripts/generate-types.js` → `dto/*.types.ts` | OpenAPI docs-json (7개 엔드포인트) |
| **channel** | `scripts/generate-types.js` → `dto/*.types.ts` | OpenAPI docs-json |
| **store** | `@knowmerce/fromm-store-api-*` npm 패키지 | npm 배포 |
| **partner** | `@knowmerce/fromm-partner-api-*` npm 패키지 | npm 배포 |

---

## 5. 공통 아키텍처 패턴

### 5-1. API 클라이언트 팩토리
모든 앱이 동일한 패턴의 API 클라이언트 사용:

```typescript
// createApiClient(baseUrl) → { get, post, put, delete }
const api = createApiClient({ baseURL: 'https://...' });
api.get<ResponseType>({ pathname: '/path', query: { ... }, signal });
api.post<ResponseType>({ pathname: '/path', body: { ... } });
```

**공통 특성:**
- 타임아웃 (기본 10초)
- AbortSignal 지원 (React Query 연동)
- 쿠키 기반 인증 (`credentials: 'include'`)
- ApiError 클래스로 에러 타입화
- 쿼리 파라미터 null/undefined 자동 제거

### 5-2. 상태 관리 구조
```
Jotai Atoms     → UI 상태 (모달, 필터, 탭, 로딩)
React Query     → 서버 상태 (API 데이터, 캐시, 뮤테이션)
React Hook Form → 폼 상태 (backoffice)
Modular Forms   → 폼 상태 (store, channel)
useState        → 컴포넌트 로컬 상태
```

### 5-3. 스타일 시스템
모든 앱이 **Panda CSS** 사용:
- `@packages/components`의 `frommPreset` 공유
- 다크모드 비활성화 (라이트 모드 고정)
- 빌드 타임 CSS-in-JS
- 커스텀 z-index 토큰 (top: 50, middle: 30, bottom: 10)
- `styled-system/` 디렉토리에 빌드 산출물

### 5-4. React Query 패턴

| 패턴 | 용도 |
|------|------|
| `useGet{Entity}(id)` | 단건 조회 (useSuspenseQuery) |
| `useGet{Entity}s(params)` | 목록 조회 |
| `useGet{Entity}sCount(params)` | 건수 조회 (페이지네이션용) |
| `useCreate{Entity}()` | 생성 뮤테이션 |
| `useUpdate{Entity}()` | 수정 뮤테이션 |
| `useDelete{Entity}()` | 삭제 뮤테이션 |

뮤테이션 후 `queryClient.invalidateQueries()`로 캐시 무효화.

### 5-5. Value Object (VO) 패턴
```typescript
class EntityVo {
    static from(response: ApiResponseType) {
        return new EntityVo(response);
    }
    constructor(response: ApiResponseType) {
        // API 응답 → 화면용 데이터 변환
    }
}
```

---

## 6. 환경 및 배포

### 환경 단계
| 환경 | 용도 | API 도메인 패턴 |
|------|------|---------------|
| **dev** | 개발 | `*-api-dev.frommyarti.com` |
| **qa** | QA 테스트 | `*-api-qa.frommyarti.com` |
| **stage** | 스테이징 | `*-api-stage.frommyarti.com` |
| **prod** | 프로덕션 | `*-api.frommyarti.com` |

### API 도메인 목록
| API 서비스 | 사용 앱 |
|-----------|---------|
| `backoffice-api` | backoffice |
| `partner-api` | partner |
| `store-api` | store, partner |
| `channel-api` | channel |
| `media-api` | backoffice, partner, channel |
| `account-api` | partner, store |
| `message-api` | store |
| `membership-api` | channel, store |
| `translate-api` | channel |

### S3 버킷 (미디어 저장)
| 버킷 | 환경 | 용도 |
|------|------|------|
| `fromm-dev-contents` / `fromm-contents` | dev/prod | 기본 콘텐츠 |
| `fromm-common-dev-contents` / `fromm-common-contents` | dev/prod | 공용 |
| `fromm-store-dev-contents` / `fromm-store-contents` | dev/prod | 스토어 |
| `fromm-channel-dev-contents` / `fromm-channel-contents` | dev/prod | 채널 |

### CDN 도메인
- `channel-[dev-]contents.frommyarti.com`
- `store-[dev-]contents.frommyarti.com`
- `common-[dev-]contents.frommyarti.com`

---

## 7. 개별 앱 문서 링크

| 앱 | 문서 | CLAUDE.md |
|----|------|-----------|
| **backoffice** | [docs/backoffice.md](./backoffice.md) | `apps/backoffice/CLAUDE.md` ✅ (상세) |
| **partner** | [docs/partner.md](./partner.md) | ❌ 없음 |
| **store** | [docs/store.md](./store.md) | `apps/store/CLAUDE.md` ✅ (상세) |
| **channel** | [docs/channel.md](./channel.md) | ❌ 없음 |

---

## 8. 신규 작업자/에이전트 온보딩 가이드

### 빠른 시작 (5분)
1. 이 문서(README.md)를 읽어 전체 구조 파악
2. 작업 대상 앱의 개별 문서 읽기
3. 해당 앱의 `CLAUDE.md`가 있으면 함께 참고

### 앱별 핵심 진입점

| 작업 대상 | 먼저 읽을 파일 |
|----------|-------------|
| **backoffice 새 도메인 추가** | `Constants.ts` (Path), `router/index.tsx`, `Navigation/MenuList.tsx`, 기존 도메인 하나의 pages/ |
| **partner 기능 수정** | `constants/` (Path, Env), `router/index.tsx`, `Navigation/MenuList.tsx` |
| **store 상품/결제** | `Constants.ts` (Secret, PG), `hooks/order/usePurchase.tsx` ★, `docs/order-flow.md` |
| **channel 포스트/댓글** | `common/Constants.ts`, `domains/post/`, `domains/comment/`, `common/command/runCommand.ts` |

### 앱 간 공통점 (모든 앱에 적용)
- Panda CSS 스타일 → `styled-system/` 빌드 산출물, `panda.config.ts` 설정
- Jotai → 글로벌 UI 상태 (모달, 필터, 로딩)
- React Query → 서버 데이터 패칭, 캐시, 뮤테이션
- API 클라이언트 → `createApiClient()` 팩토리, AbortSignal, 쿠키 인증
- VO 패턴 → `XxxVo.from(apiResponse)` 정적 팩토리 메서드
- Toast → react-toastify 기반 알림

### 앱별 고유 특성 (주의 필요)

| 앱 | 고유 특성 |
|----|----------|
| **backoffice** | RowTable 폼 시스템, createRouter CRUD 자동 생성, OpenAPI DTO 자동 생성 |
| **partner** | @knowmerce npm 패키지 DTO, Recharts 차트, Excel/PDF 내보내기, 멀티 채널 관리 |
| **store** | [M] 마켓 파라미터, 결제 PG 5종, AES 암호화, ISR, next-translate 다국어 |
| **channel** | 모바일 웹뷰 전용, 네이티브 브릿지 (runCommand), 커스텀 lazy i18n, Sentry 모니터링 |
