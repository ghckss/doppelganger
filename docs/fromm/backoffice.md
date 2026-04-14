# Backoffice 앱 종합 문서

> fromm 서비스의 내부 관리 도구. 아티스트/그룹/소속사 관리, 스토어(프로젝트/상품/번들), 채널, VOD, 이벤트, 배너 등의 CRUD를 수행하는 어드민 SPA.

---

## 1. 기술 스택 요약

| 영역 | 기술 | 비고 |
|------|------|------|
| 빌드 | **Vite 7** | SPA, `vite.config.ts` |
| UI 프레임워크 | **React 18** + TypeScript 5.3 | |
| 스타일 | **Panda CSS** | `@packages/components`의 `frommPreset` 사용, 다크모드 비활성화 |
| 라우팅 | **React Router v7** | `createBrowserRouter` |
| 서버 상태 | **React Query v5** | staleTime/gcTime: 1분, retry 3 |
| 글로벌 상태 | **Jotai** | 모달, 필터, 프리뷰 |
| 폼 | **React Hook Form v7** | RowTable 시스템과 통합 |
| 리치 텍스트 | **TipTap** | 공지사항, 이벤트 설명 등 |
| 알림 | **react-toastify** | |
| 에러 바운더리 | **react-error-boundary** | |
| Mock | **@packages/msw-handler** (workspace) | |

---

## 2. 프로젝트 구조

```
apps/backoffice/
├── dto/                          # 자동 생성 DTO 타입 (OpenAPI → TypeScript)
│   ├── auth.types.ts
│   ├── channel.types.ts
│   ├── common.types.ts
│   ├── media.types.ts
│   ├── membership.types.ts
│   ├── message.types.ts
│   └── store.types.ts
├── scripts/
│   └── generate-types.js         # OpenAPI docs-json → DTO 자동 생성
├── styled-system/                # Panda CSS 빌드 산출물
├── src/
│   ├── main.tsx                  # 앱 진입점 (QueryClient, ErrorBoundary, Router)
│   ├── common/                   # 공유 계층
│   │   ├── api/                  # API 클라이언트 함수 (도메인별 정리)
│   │   ├── atom/                 # Jotai atoms (filter, modal, globalPreview)
│   │   ├── components/           # 공용 UI 컴포넌트
│   │   ├── hooks/                # 공용 커스텀 훅
│   │   ├── queries/              # React Query 유틸리티
│   │   ├── router/               # 라우터 설정 + createRouter 유틸
│   │   ├── utils/                # 순수 유틸리티 함수
│   │   └── Constants.ts          # Path, Env, API URL, Regex 등 상수
│   ├── domains/                  # 비즈니스 도메인별 기능 모듈
│   │   ├── app/                  # 메인 대시보드
│   │   ├── auth/                 # 인증 (로그인/로그아웃/토큰)
│   │   ├── channel/              # 채널 관리 (채널, 채널 배너)
│   │   ├── common/               # 기본 정보 (소속사, 그룹, 아티스트)
│   │   ├── message/              # 메시지 (앱 배너 관리)
│   │   ├── service/              # 부가서비스 (VOD/에피소드, 이벤트, 이모티콘, 멤버십, 테마)
│   │   └── store/                # 스토어 (상품관, 프로젝트, 상품, 번들, 재고, 구매제한)
│   ├── mocks/                    # MSW 핸들러
│   ├── res/                      # SVG 아이콘, 이미지
│   └── styles/                   # 글로벌 CSS
├── package.json
├── vite.config.ts
├── panda.config.ts
└── CLAUDE.md                     # AI 에이전트용 가이드 (상세)
```

---

## 3. 환경 설정

### 환경 변수
- `VITE_APP_ENV` — `dev` | `qa` | `stage` | `prod`

### API Base URL (환경별)
| 환경 | Backoffice API | Media API |
|------|----------------|-----------|
| dev | `https://backoffice-api-dev.frommyarti.com` | `https://media-api-dev.frommyarti.com` |
| qa | `https://backoffice-api-qa.frommyarti.com` | `https://media-api-qa.frommyarti.com` |
| stage | `https://backoffice-api-stage.frommyarti.com` | `https://media-api-stage.frommyarti.com` |
| prod | `https://backoffice-api.frommyarti.com` | `https://media-api.frommyarti.com` |

### Import Alias
| Alias | 실제 경로 |
|-------|----------|
| `@/common` | `src/common` |
| `@/domains` | `src/domains` |
| `@/res` | `src/res` |
| `@/styles` | `src/styles` |
| `@/dto` | `dto` |
| `styled-system` | `styled-system/` |

### 개발 명령어
```bash
pnpm dev          # 개발 서버 (prebuild 자동 실행)
pnpm build        # 프로덕션 빌드
pnpm typecheck    # TypeScript 타입 체크
pnpm lint         # ESLint
pnpm format       # Biome 포맷팅 + ESLint fix + tsc
pnpm test         # Vitest 테스트
```

---

## 4. 라우팅 시스템

### createRouter 패턴
`createRouter(basePath, pageMap)` 유틸이 CRUD 라우트를 자동 생성:

| PageMap 키 | 생성 라우트 | 용도 |
|-----------|-----------|------|
| `list` | `/{basePath}` | 목록 페이지 |
| `show` | `/{basePath}/:id` | 상세 페이지 |
| `create` | `/{basePath}/create` | 생성 페이지 |
| `edit` | `/{basePath}/edit/:id` | 수정 페이지 |

### 전체 라우트 맵

| 네비게이션 카테고리 | 라우트 | 도메인 |
|------------------|--------|--------|
| **기본 정보 관리** | | |
| └ 소속사 | `/common/agency` | `domains/common/agency` |
| └ 그룹 | `/common/group` | `domains/common/group` |
| └ 아티스트 | `/common/arti` | `domains/common/artis` |
| **스토어 관리** | | |
| └ 상품관 | `/store/artishop` | `domains/store/shop` |
| └ 프로젝트 | `/store/project` | `domains/store/project` |
| └ 상품 | `/store/project/:projectId/goods` | `domains/store/goods` |
| └ 번들 | `/store/project/:projectId/bundle` | `domains/store/bundle` |
| └ 구매 제한 | `/store/restriction` | `domains/store/restriction` |
| **채널 관리** | | |
| └ 채널 | `/channel/channels` | `domains/channel/channels` |
| **부가서비스 관리** | | |
| └ VOD | `/service/vod` | `domains/service/vod` |
| └ 에피소드 | `/service/vod/:contentId/episode` | `domains/service/episode` |
| └ 이벤트 | `/service/event` | `domains/service/event` |
| **마케팅 관리** | | |
| └ [앱] 친구 목록 배너 | `/marketing/banners/message/friends` | `domains/message/banners` |
| └ [앱] 더보기 배너 | `/marketing/banners/message/more` | `domains/message/banners` |
| └ [채널] 목록 배너 | `/marketing/banners/channel/channels` | `domains/channel/banners` |
| **인증** | `/signin` | `domains/auth` |

---

## 5. 도메인별 상세

### 5-1. 도메인 구조 컨벤션

모든 도메인은 동일한 디렉토리 패턴을 따름:

```
domains/{category}/{feature}/
├── pages/              # list.tsx, show.tsx, create.tsx, edit.tsx
├── components/         # CreateContainer, EditContainer 등 폼 컴포넌트
├── queries/            # React Query 훅 (useGet*, useCreate*, useUpdate*, useDelete*)
├── hooks/              # 도메인 전용 커스텀 훅
└── vo/                 # Value Object (API 응답 → 화면용 데이터 변환)
```

### 5-2. 도메인 인벤토리

| 도메인 | 서브 도메인 | 페이지 | 쿼리 훅 | VO | 컴포넌트 | 비고 |
|--------|-----------|--------|---------|-----|---------|------|
| **common** | agency | 4 (CRUD) | 5 | 2 | 4 | 소속사 관리 |
| | artis | 4 (CRUD) | 8 | 2 | 5 | 아티스트 관리, ID/PW 변경 포함 |
| | group | 4 (CRUD) | 5 | 1 | 4 | 그룹 관리 |
| **store** | shop | 4 (CRUD) | 6 | 2 | 4 | 상품관(아티 샵) 관리 |
| | project | 4 (CRUD) | 9 | 2 | 3 | 프로젝트 관리, 복사/배송알림 |
| | goods | 2 (show/edit) | 20 | 4 | 11 | **가장 복잡한 도메인** — 상품, 옵션, 서브상품, 액션 |
| | bundle | 2 (show/edit) | 10 | 2 | 3 | 번들 관리, 복사 기능 |
| | restriction | 4 (CRUD) | 6 | 2 | 3 | 구매 제한 정책 |
| | inventory | — | 2 | 1 | 1 | 재고 관리 (쿼리 전용) |
| **channel** | channels | 4 (CRUD) | 7 | 2 | 2 | 채널 관리 |
| | banners | 4 (CRUD) | 6 | 2 | 2 | 채널 배너 |
| **service** | vod | 4 (CRUD) | 6 | 2 | 2 | VOD 콘텐츠 |
| | episode | 3 (CRU) | 6 | 2 | 3 | VOD 에피소드 (VOD 하위) |
| | event | 4 (CRUD) | 6 | 2 | 3 | 이벤트 관리 |
| | emoticon | — | 1 | — | — | 이모티콘 조회 전용 |
| | membership | — | 1 | — | — | 멤버십 조회 전용 |
| | theme | — | 1 | — | — | 테마 조회 전용 |
| **message** | banners | 8 (friends 4 + more 4) | 6 | 2 | 4 | 앱 배너 (친구/더보기 통합) |
| **auth** | — | 1 (signin) | 4 | — | — | 로그인/로그아웃/토큰 갱신 |

**총계**: 약 462개 소스 파일, 120+ 쿼리 훅, 60 컴포넌트, 38 VO 파일

---

## 6. 핵심 패턴 상세

### 6-1. API 계층

```
src/common/api/
├── auth/auth.ts           # signIn, signOut, refreshCookie, getMe
├── common/                # agencies, artiGroups, artis, media(업로드)
├── channel/               # channels, banners
├── membership/            # memberships
├── message/               # banners, emoticons, star, themes
└── store/                 # artiShops, projects, goods, bundle, contents, event, inventories, restriction
```

**API 클라이언트 구현**: `src/common/utils/api.ts`
- `createApiClient(baseUrl)` — 팩토리 함수
- `backofficeApi` — 메인 API (기본 타임아웃 10초)
- `mediaApi` — 미디어 업로드 API
- HTTP 메서드: `get()`, `post()`, `put()`, `delete()`
- 에러: `ApiError(errorType, errorData, message)` 클래스
- 인증: 쿠키 기반 (`credentials: 'include'`)
- AbortSignal 지원 (React Query 연동)

### 6-2. DTO 타입 자동 생성

```bash
# scripts/generate-types.js가 다음 OpenAPI 엔드포인트에서 타입 생성:
- media-api-dev.frommyarti.com/docs-json/media     → dto/media.types.ts
- backoffice-api-dev.frommyarti.com/docs-json/common → dto/common.types.ts
- backoffice-api-dev.frommyarti.com/docs-json/store  → dto/store.types.ts
- backoffice-api-dev.frommyarti.com/docs-json/auth   → dto/auth.types.ts
- backoffice-api-dev.frommyarti.com/docs-json/channel → dto/channel.types.ts
- backoffice-api-dev.frommyarti.com/docs-json/membership → dto/membership.types.ts
- backoffice-api-dev.frommyarti.com/docs-json/message → dto/message.types.ts
```

`pnpm prebuild` 실행 시 자동으로 최신 타입이 생성됨.

### 6-3. React Query 쿼리 훅 패턴

```typescript
// 목록 조회: useGet{Entity}s(params)
// 건수 조회: useGet{Entity}sCount(params)
// 단건 조회: useGet{Entity}(id)
// 생성:     useCreate{Entity}()
// 수정:     useUpdate{Entity}()
// 삭제:     useDelete{Entity}()
```

모든 쿼리 훅은:
- `useSuspenseQuery` 또는 `useQuery` 사용
- `queryKey`에 파라미터 포함하여 캐시 분리
- Mutation 후 `queryClient.invalidateQueries()`로 캐시 무효화
- `signal` 전달하여 컴포넌트 언마운트 시 자동 취소

### 6-4. VO (Value Object) 패턴

API 응답 → 화면 표시용 데이터 변환:

```typescript
// 단건 VO
class EntityVo {
    id: number;
    name: string;
    // ...화면에 필요한 필드만 추출

    static from(response: GetEntityResponse) {
        return new EntityVo(response);
    }
    constructor(response: GetEntityResponse) {
        this.id = response.entity.id;
        this.name = response.entity.name;
    }
}

// 목록 VO
class EntitiesVo {
    entities: EntityItem[];

    static from(response: GetEntitiesResponse) {
        return new EntitiesVo(response);
    }
}
```

### 6-5. 페이지 구현 패턴

**List 페이지:**
```
SearchField → 키워드 검색
Filter → 아티스트/채널 필터
usePagination → 페이지네이션 상태
useGet{Entity}sCount → 전체 건수
useGet{Entity}s → 현재 페이지 데이터
ListTable → 테이블 렌더링
Pagination → 페이지 네비게이션
```

**Show 페이지:**
```
useParams() → id 추출
useGet{Entity}(id) → 데이터 조회
RowTable + TextRow.Viewer 등 → 읽기 전용 표시
PageContainer buttons → 수정/삭제 버튼
```

**Create/Edit 페이지:**
```
FormProvider (React Hook Form)
CreateContainer/EditContainer → 폼 레이아웃
RowTable + TextRow.Editor 등 → 입력 폼
useFormSubmit → 제출 + validation scroll
useCreate{Entity} / useUpdate{Entity} → 뮤테이션
usePreventBackNavigation → 뒤로가기 방지
```

### 6-6. 공용 컴포넌트

| 컴포넌트 | 위치 | 용도 |
|---------|------|------|
| **Layout** | `components/Layout` | 전체 레이아웃 (네비게이션 + 헤더 + 콘텐츠 + 모달) |
| **PageContainer** | `components/PageContainer` | 페이지 헤더, 제목, 액션 버튼 |
| **ListTable** | `components/Table/ListTable` | 목록 테이블 (text/image/tag/custom 셀) |
| **Pagination** | `components/Pagination` | URL 기반 페이지네이션 |
| **SearchField** | `components/SearchField` | 검색 입력 (React Hook Form 연동) |
| **Filter** | `components/Filter` | 드롭다운 필터 (Jotai + localStorage 영속) |
| **RowTable** | `components/RowTable/*` | 폼 레이아웃 시스템 (13종 Row 타입) |
| **BaseModal** | `components/modal/BaseModal` | 스택형 모달 (Jotai atom) |
| **AlertModal** | `components/modal/AlertModal` | 확인/취소 다이얼로그 |
| **GlobalPreview** | `components/Preivew` | 스토어 프리뷰 iframe |

### 6-7. 공용 훅

| 훅 | 용도 |
|----|------|
| `useCommonErrorAlert` | API 에러 → AlertModal 표시 |
| `useDebounce(value, delay)` | 디바운스 (검색 입력 등) |
| `useFormSubmit(onSubmit)` | 폼 제출 + 에러 필드 스크롤 |
| `useMediaUpload()` | 이미지/비디오/자막 업로드 (S3 서명 URL, 멀티파트) |
| `usePagination(totalCount, itemsPerPage)` | URL `?page` 기반 페이지네이션 |
| `usePreventBackNavigation(isActive)` | 브라우저 뒤로가기 방지 |
| `useToast()` | 토스트 알림 표시 |

### 6-8. 미디어 업로드 시스템

`useMediaUpload` 훅이 제공하는 업로드 방식:

| 방식 | 용도 | 구현 |
|------|------|------|
| **tempUpload** | 임시 이미지 업로드 | 서명 URL → PUT 업로드 |
| **directUpload** | 확정 이미지 업로드 | 서명 URL → PUT 업로드 |
| **multipartVideo** | 대용량 비디오 업로드 | 100MB 청크 분할 → 병렬 PUT → complete |

S3 버킷:
- `fromm-dev-contents` / `fromm-contents` — 기본
- `fromm-common-dev-contents` / `fromm-common-contents` — 공용
- `fromm-store-dev-contents` / `fromm-store-contents` — 스토어
- `fromm-channel-dev-contents` / `fromm-channel-contents` — 채널

---

## 7. 새 기능 추가 가이드

### 새 도메인 CRUD 추가 시:

1. **API 함수 작성**: `src/common/api/{category}/{entity}.ts`
2. **VO 작성**: `src/domains/{category}/{entity}/vo/`
3. **쿼리 훅 작성**: `src/domains/{category}/{entity}/queries/` (Get/Create/Update/Delete)
4. **컴포넌트 작성**: `CreateContainer`, `EditContainer` 등
5. **페이지 작성**: `pages/list.tsx`, `show.tsx`, `create.tsx`, `edit.tsx`
6. **페이지 export**: `pages/index.ts`에서 `{ list, show, create, edit }` 객체 export
7. **라우터 등록**: `src/common/router/index.tsx`에 `createRouter(Path.NewEntity, NewEntityPages)` 추가
8. **상수 추가**: `Constants.ts`의 `Path`에 경로 추가
9. **네비게이션 등록**: `Navigation/MenuList.tsx`에 메뉴 항목 추가

---

## 8. 주의사항

- **DTO 파일 직접 수정 금지** — `dto/*.types.ts`는 자동 생성됨. API 스키마 변경 후 `pnpm prebuild` 실행
- **쿠키 기반 인증** — `credentials: 'include'`로 쿠키 자동 전송. 토큰 갱신은 `useRefreshToken` 훅이 담당
- **goods 도메인 복잡도** — 상품(goods)은 옵션(options), 서브상품(subGoods), 액션(actions), 배송(delivery) 등 다중 하위 엔티티를 가짐. 쿼리 훅 20개로 가장 복잡
- **프리뷰 시스템** — 스토어 관련 엔티티는 `PreviewSrc` 상수로 프리뷰 URL 생성 가능
- **모달 스택** — `useCustomModal()`은 여러 모달을 스택으로 쌓을 수 있음. `useAlertModal()`은 단일 알림만
- **필터 영속화** — Filter 컴포넌트의 선택값은 localStorage에 저장됨
