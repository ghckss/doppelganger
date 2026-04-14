# Partner 앱 종합 문서

> fromm 서비스의 **파트너(소속사/매니저) 관리 포털**. 채널 콘텐츠 관리, 이벤트, 멤버십, 정산, 사용자/권한 관리 등을 수행하는 SPA.

---

## 1. 기술 스택 요약

| 영역 | 기술 | 비고 |
|------|------|------|
| 빌드 | **Vite 5** (SWC) | `vite.config.ts` |
| UI 프레임워크 | **React 18** + TypeScript 5.3 | |
| 스타일 | **Panda CSS** | `@packages/components` frommPreset |
| 라우팅 | **React Router v6** | |
| 서버 상태 | **React Query v5** | staleTime/gcTime 60초, retry 3 |
| 글로벌 상태 | **Jotai** | me, channels, artiGroups, filters, modal |
| 폼 | 직접 구현 (InputFields 컴포넌트) | |
| 리치 텍스트 | **TipTap** (테이블, 이미지, 컬러, 링크 등 확장) | |
| 차트 | **Recharts** | 메시지/멤버십 통계 |
| 파일 내보내기 | **jspdf**, **exceljs** | PDF/Excel 내보내기 |
| 알림 | **react-toastify** | |
| 에러 바운더리 | **react-error-boundary** | |
| 비디오 | **react-player** | |
| 애니메이션 | **lottie-react** | |
| 이미지 압축 | **browser-image-compression** | |

---

## 2. 프로젝트 구조

```
apps/partner/
├── src/
│   ├── main.tsx                # 앱 진입점 (QueryClient, ErrorBoundary, Router)
│   ├── common/                 # 공유 계층
│   │   ├── api/               # API 클라이언트 (18개 모듈)
│   │   ├── atom/              # Jotai atoms (me, channels, artiGroups, filters, modal)
│   │   ├── components/        # 공용 UI 컴포넌트 (100+)
│   │   │   ├── InputFields/   # 폼 입력 (Checkbox, DateTime, Image, Video, Translate 등)
│   │   │   ├── ShowFields/    # 읽기 전용 표시 (Date, Image, String, Translate 등)
│   │   │   ├── Layout/        # 메인 레이아웃
│   │   │   ├── ListTable/     # 목록 테이블
│   │   │   ├── Navigation/    # 3단계 사이드 네비게이션
│   │   │   ├── PageContainer/ # 페이지 헤더/액션 컨테이너
│   │   │   ├── Pagination/    # 페이지네이션
│   │   │   ├── TextEditor/    # TipTap WYSIWYG 에디터
│   │   │   ├── charts/        # LineChart, PieChart (Recharts)
│   │   │   └── widgets/       # Button, Dropdown, SearchField 등
│   │   ├── hooks/             # 공용 커스텀 훅
│   │   ├── modal/             # 모달 컴포넌트
│   │   ├── queries/           # 공용 쿼리 훅 (upload, countries)
│   │   ├── router/            # 라우터 설정
│   │   ├── utils/             # 유틸리티 (api, date, browser, string)
│   │   └── vo/                # 공용 Value Object
│   ├── domain/                 # 비즈니스 도메인 (16개)
│   │   ├── account/           # 계정 관리
│   │   ├── auth/              # 인증 (로그인/로그아웃)
│   │   ├── channel/           # 채널 소개 관리
│   │   ├── department/        # 부서 관리
│   │   ├── event/             # 이벤트 관리 + 이벤트 참여자
│   │   ├── feed/              # 팬 피드 게시판
│   │   ├── home/              # 대시보드 홈
│   │   ├── media/             # 미디어 피드 (라벨 + 콘텐츠)
│   │   ├── membership/        # 멤버십 관리 + 통계
│   │   ├── message/           # 메시지 통계 대시보드
│   │   ├── notice/            # 공지사항 (라벨 + 게시물)
│   │   ├── permission/        # 권한 관리
│   │   ├── profile/           # 내 프로필 관리
│   │   ├── schedule/          # 일정 관리
│   │   └── settlement/        # 정산 관리
│   ├── constants/              # 전역 상수 (Env, Path, API URL)
│   ├── res/                    # SVG 아이콘, Lottie 애니메이션
│   ├── styles/                 # 글로벌 CSS
│   └── mocks/                  # MSW 핸들러
├── package.json
├── vite.config.ts
└── panda.config.ts
```

---

## 3. 환경 설정

### 환경 변수
- `VITE_APP_ENV` — `dev` | `qa` | `stage` | `prod` | `local`
- `VITE_APP_GOOGLE_API_KEY` — Google API 키

### API Base URL (4개 서비스)
| 서비스 | dev | prod |
|--------|-----|------|
| Account | `account-api-dev.frommyarti.com` | `account-api.frommyarti.com` |
| Partner | `partner-api-dev.frommyarti.com` | `partner-api.frommyarti.com` |
| Media | `media-api-dev.frommyarti.com` | `media-api.frommyarti.com` |
| Store | `store-api-dev.frommyarti.com` | `store-api.frommyarti.com` |

### Import Alias
| Alias | 실제 경로 |
|-------|----------|
| `common` | `src/common` |
| `domain` | `src/domain` |
| `res` | `src/res` |
| `styles` | `src/styles` |
| `styled-system` | `styled-system/` |

### 개발 명령어
```bash
pnpm dev          # 개발 서버 (Vite)
pnpm build        # 프로덕션 빌드
pnpm typecheck    # TypeScript 타입 체크
pnpm format       # Biome + ESLint fix + tsc
pnpm test         # Vitest 테스트
```

---

## 4. 라우팅 시스템

### 전체 라우트 맵

| 네비게이션 | 라우트 | 도메인 |
|-----------|--------|--------|
| **채널** | | |
| └ 채널 소개 | `/channel/channel` | `domain/channel` |
| └ 공지사항 > 분류 관리 | `/channel/notice/label` | `domain/notice` |
| └ 공지사항 > 게시물 관리 | `/channel/notice` | `domain/notice` |
| └ 일정 > 일정 관리 | `/channel/schedule` | `domain/schedule` |
| └ 팬 피드 > 게시판 관리 | `/channel/feed/board` | `domain/feed` |
| └ 미디어 피드 > 분류 관리 | `/channel/media/label` | `domain/media` |
| └ 미디어 피드 > 콘텐츠 관리 | `/channel/media` | `domain/media` |
| **이벤트** | `/store/event` | `domain/event` |
| └ 참여자 관리 | `/store/event/:eventId/users` | `domain/event` |
| **멤버십** | | |
| └ 멤버십 관리 | `/membership/membership` | `domain/membership` |
| └ 기록 관리 | `/membership/history` | `domain/membership` |
| **정산** | | |
| └ 부서관리 | `/settlement/department` | `domain/department` |
| └ 정산 내역 | `/settlement/settlement` | `domain/settlement` |
| └ 메시지 통계 | `/dashboard/message` | `domain/message` |
| └ 멤버십 통계 | `/dashboard/membership` | `domain/membership` |
| **사용자 관리** | | |
| └ 계정 관리 | `/account/management` | `domain/account` |
| └ 권한 관리 | `/permission/management` | `domain/permission` |
| **프로필** | `/profile` | `domain/profile` |
| **인증** | `/signin` | `domain/auth` |

---

## 5. 도메인별 인벤토리

| 도메인 | 페이지 | 쿼리 훅 | VO | 컴포넌트 | 비고 |
|--------|--------|---------|-----|---------|------|
| **auth** | 1 (signin) | 5 | — | — | 쿠키 인증, 토큰 갱신 |
| **home** | 1 | — | — | 1 | 대시보드 웰컴 |
| **channel** | 3 (L/S/E) | 6 | 1 | 1 | 채널 소개, 피드보드 |
| **notice** | 8 (라벨 4 + 게시물 4) | 12 | 2 | — | 라벨/게시물 CRUD, 푸시 발송 |
| **schedule** | 4 (CRUD) | 7 | 1 | — | 일정 관리 |
| **feed** | 4 (CRUD) | 6 | 1 | — | 팬 피드 게시판 |
| **media** | 8 (라벨 4 + 콘텐츠 4) | 12 | 2 | — | 미디어 라벨/콘텐츠 CRUD |
| **event** | 8 (이벤트 4 + 참여자 4) | 12 | 3 | 1 | 이벤트 + 참여자 관리 |
| **membership** | 3 (L/S + history) | 15 | 7 | 4 | 멤버십, 통계, 내보내기 |
| **message** | 1 (dashboard) | 4 | 1 | 6 | 메시지 통계 차트 |
| **settlement** | 4 | 8 | 3 | — | 정산 내역, 승인 |
| **department** | 4 (CRUD) | 9 | 2 | 3 | 부서 관리, 아티스트 배정 |
| **account** | 4 (CRUD) | 7 | 1 | — | 매니저 계정 관리 |
| **permission** | 3 (L/S/E) | 4 | 1 | — | 권한 관리 |
| **profile** | 2 (S/E) | 2 | 1 | 1 | 내 프로필 + 비밀번호 변경 |

**총계**: ~300+ 소스 파일, 80+ 쿼리 훅, 100+ 컴포넌트

---

## 6. 핵심 패턴

### API 계층 (18개 모듈)
- `account.ts` — 로그인/로그아웃/토큰 갱신/비밀번호 초기화
- `channels.ts` — 채널 목록/상세/수정
- `notices.ts` — 공지 라벨 + 게시물 CRUD + 푸시
- `schedules.ts` — 일정 CRUD + 라벨 조회
- `media.ts` — 미디어 라벨 + 콘텐츠 CRUD
- `feed.ts` — 팬 피드 게시판 CRUD
- `memberships.ts` — 멤버십 조회, 유저 목록, 내보내기, 동의
- `settlement.ts` — 정산 목록/상세/승인/요약
- `departments.ts` — 부서 CRUD + 소속 아티스트
- `users.ts` — 계정/권한 관리
- `events.ts` — 이벤트 CRUD
- `eventUsers.ts` — 이벤트 참여자 관리 + 파일 업로드
- `artis.ts` — 부서 아티스트 관리
- `artiGroups.ts` — 아티 그룹 조회
- `manager.ts` — 내 정보(getMe) + 채널 목록 + 프로필 수정
- `upload.ts` — 파일/비디오/이미지 업로드 (S3 서명 URL)
- `statistics.ts` — 메시지/멤버십 통계 + 내보내기
- `common.ts` — 국가 목록

### DTO 타입
@knowmerce 네임스페이스의 npm 패키지에서 API 타입을 가져옴:
- `fromm-partner-api-channel`, `fromm-partner-api-channel-notice`, `fromm-partner-api-channel-media`
- `fromm-partner-api-membership`, `fromm-partner-api-settlement`, `fromm-partner-api-arti`
- `fromm-partner-api-manager`, `fromm-partner-api-channel-schedule`, `fromm-partner-api-channel-feed-board`
- `fromm-store-api-common`, `fromm-api-media`, `fromm-account-api`, `fromm-store-event`

### 컴포넌트 패턴
- **InputFields/**: 폼 입력 (CheckboxInput, ImageInput, VideoInput, TranslateInput, DateTimeInput 등)
- **ShowFields/**: 읽기 전용 (StringField, DateField, ImageField, TranslateField 등)
- **Layout**: 네비게이션 + 헤더 + 콘텐츠
- **PageContainer**: 페이지 제목 + 브레드크럼 + 액션 버튼
- **ListTable**: 목록 데이터 테이블
- **Chart**: LineChart, PieChart (Recharts)

### 공용 훅
| 훅 | 용도 |
|----|------|
| `useToast()` | 토스트 알림 |
| `useFileUpload()` | S3 파일/비디오 업로드 |
| `useExcelExport()` | Excel 내보내기 |
| `useOnApiError()` | API 에러 처리 |
| `usePagination()` | 페이지네이션 (URL ?page 기반) |

### backoffice와의 차이점
| 항목 | backoffice | partner |
|------|-----------|---------|
| 사용자 | 내부 운영팀 | 소속사/매니저 |
| DTO 소스 | OpenAPI docs-json 자동 생성 | @knowmerce npm 패키지 |
| 폼 시스템 | React Hook Form + RowTable | 커스텀 InputFields/ShowFields |
| 차트 | 없음 | Recharts (통계 대시보드) |
| 파일 내보내기 | 없음 | jspdf + exceljs |
| 비디오 | 없음 | react-player |
| 권한 관리 | 없음 (단일 관리자) | 계정/권한 분리 |

---

## 7. 주의사항

- **CLAUDE.md 없음** — 이 문서가 에이전트 가이드 역할
- **React Router v6** — backoffice(v7)와 버전이 다름
- **DTO는 npm 패키지** — backoffice처럼 자동 생성이 아니라 `@knowmerce/fromm-partner-api-*` 패키지에서 import
- **멤버십 접근 권한** — `MembershipAccessGuard` 컴포넌트로 멤버십 페이지 접근 제어
- **통계 데이터** — 메시지/멤버십 통계는 별도 statistics API 사용, CSV/Excel 내보내기 지원
- **멀티 채널** — 파트너는 여러 채널을 관리할 수 있으며, `channelsAtom`으로 채널 목록 관리
