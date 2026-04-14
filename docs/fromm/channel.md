# Channel 앱 종합 문서

> fromm 서비스의 **채널(팬 커뮤니티) 앱**. 아티스트 포스트/미디어 피드, 댓글, 공지사항, 일정, 멤버십 등 팬-아티스트 소통 플랫폼. **모바일 웹뷰 전용** (앱 내장 브라우저).

---

## 1. 기술 스택 요약

| 영역 | 기술 | 비고 |
|------|------|------|
| 프레임워크 | **Next.js 14** (Pages Router) | SSR, standalone 출력 |
| UI | **React 18** + TypeScript 5 | |
| 스타일 | **Panda CSS** | frommPreset, 모바일 퍼스트 (max-width 420px) |
| 서버 상태 | **React Query v5** | staleTime/gcTime 커스텀 |
| 글로벌 상태 | **Jotai** | loading, tab, isHydrated |
| 폼 | **@modular-forms/react** + **Valibot** | |
| 모니터링 | **Sentry** (client + server + edge) | `/monitoring` 터널 |
| 분석 | **Mixpanel** | 동적 import |
| 국제화 | 커스텀 i18n (lazy dictionary loading) | ko, en, ja, zh |
| 미디어 | **react-player/lazy**, **@egjs/react-flicking**, **swiper**, **photoswipe** | |
| 비디오 | **@knowmerce/vwr-client-react** | fromm 전용 플레이어 |
| 웹뷰 브릿지 | `runCommand()` | 네이티브 앱 통신 |

---

## 2. 프로젝트 구조

```
apps/channel/
├── dto/                        # 자동 생성 DTO 타입 (23개 파일)
│   ├── channel.types.ts        # 채널 정보
│   ├── post.types.ts           # 아티스트 포스트
│   ├── feed-post.types.ts      # 팬 피드 포스트
│   ├── media-post.types.ts     # 미디어 포스트
│   ├── comment.types.ts        # 댓글 (아티/팬/미디어)
│   ├── notice.types.ts         # 공지사항
│   ├── membership.types.ts     # 멤버십
│   ├── live-room.types.ts      # 라이브 룸
│   ├── schedule.types.ts       # 일정
│   └── ...                     # 총 23개 파일
├── locales/                    # 다국어 번역 파일
├── scripts/
│   └── generate-types.js       # OpenAPI → DTO 자동 생성
├── src/
│   ├── pages/                  # Next.js Pages Router ★
│   │   ├── _app.tsx           # 앱 프로바이더 (QueryClient, Jotai, i18n, VWR)
│   │   ├── index.tsx          # 홈 (채널 목록)
│   │   ├── welcome/           # 환영 페이지
│   │   ├── channels/
│   │   │   ├── more/          # 채널 더보기
│   │   │   └── [channelPath]/ # 채널 상세 (동적)
│   │   │       ├── index.tsx              # 피드 (아티스트 탭)
│   │   │       ├── arti/[postId]/         # 아티스트 포스트 상세
│   │   │       ├── feed/[postId]/         # 팬 포스트 상세
│   │   │       ├── media/[postId]/        # 미디어 포스트 상세
│   │   │       ├── comment/.../           # 댓글/답글 상세
│   │   │       └── liveBridge/            # 라이브 리다이렉트
│   │   ├── intro/[channelPath]/           # 채널 인트로
│   │   ├── memberships/                   # 멤버십
│   │   ├── notices/[channelPath]/         # 공지사항
│   │   ├── schedule/[channelPath]/        # 일정
│   │   └── preview/                       # 프리뷰
│   ├── common/                 # 공유 계층
│   │   ├── api/               # API 클라이언트 (18개 모듈)
│   │   ├── atom/              # Jotai atoms
│   │   ├── command/           # 네이티브 웹뷰 브릿지 (runCommand)
│   │   ├── components/        # 공용 UI (12개)
│   │   ├── hooks/             # 커스텀 훅 (24개)
│   │   ├── i18n/              # 번역 프로바이더 + 딕셔너리 로더
│   │   ├── modalBase/         # 모달/바텀시트/스택뷰/다이얼로그 시스템
│   │   ├── queries/           # QueryKey 상수
│   │   ├── utils/             # 유틸리티 (18개)
│   │   └── vo/                # 공용 VO
│   ├── domains/                # 비즈니스 도메인 (13개)
│   │   ├── channels/          # 채널 목록/관리
│   │   ├── post/              # 포스트 (artist, feed, media, common)
│   │   ├── comment/           # 댓글 (comment, reply, common)
│   │   ├── profiles/          # 프로필 설정
│   │   ├── memberships/       # 멤버십
│   │   ├── notices/           # 공지사항
│   │   ├── schedule/          # 일정
│   │   ├── intro/             # 채널 인트로
│   │   ├── hashtag/           # 해시태그 검색
│   │   ├── arti/              # 아티스트 프로필
│   │   ├── live/              # 라이브 룸
│   │   └── more/              # 더보기
│   ├── ui/                     # 재사용 UI (Skeleton, SnackBar, Toggle, TextFields)
│   ├── res/                    # SVG 아이콘, JSON, Lottie
│   └── styles/                 # 글로벌 CSS
├── sentry.client.config.ts     # Sentry 클라이언트 (세션 리플레이 10%)
├── sentry.server.config.ts     # Sentry 서버
├── sentry.edge.config.ts       # Sentry 엣지
├── next.config.js
├── panda.config.ts
└── package.json
```

---

## 3. 환경 설정

### API Base URL (4개 서비스)
| 서비스 | 용도 |
|--------|------|
| ChannelApi | 채널/포스트/댓글/공지/일정/멤버십/구독/배너 |
| TranslateApi | 번역 API |
| MediaApi | 미디어 업로드 |
| MembershipApi | 멤버십 결제/관리 |

### 모바일 웹뷰 특성
- **최대 너비**: 420px (breakpoint-phone)
- **폴드 기기**: 280-330px 대응
- **DVH 폴리필**: `100dvh` CSS 지원 (`initDvhPolyfill`)
- **뷰포트**: `viewport-fit=cover` (노치 대응)
- **네이티브 브릿지**: `window.nativeBack`, `window.entryPathname`
- 쿠키 기반 인증 (`accessToken`, `language`)

### 개발 명령어
```bash
pnpm dev          # 개발 서버
pnpm build        # 프로덕션 빌드 (prebuild → next build)
pnpm typecheck    # TypeScript 타입 체크
pnpm eslint:check # ESLint
pnpm test         # Vitest 테스트
pnpm e2e          # Playwright E2E
```

---

## 4. 도메인 구조 (코로케이션 패턴)

각 도메인이 자체 `pages/`, `components/`, `queries/`, `hooks/`, `atom/`, `vo/`를 소유:

```
domains/{feature}/
├── pages/          # 페이지 컴포넌트 (라우트 대응)
├── components/     # 도메인 전용 UI
├── queries/        # React Query 훅
├── hooks/          # 도메인 전용 로직
├── atom/           # Jotai atoms
└── vo/             # Value Object (API → 화면 데이터)
```

### 도메인별 인벤토리

| 도메인 | 역할 | 쿼리 훅 | 주요 컴포넌트 |
|--------|------|---------|-------------|
| **channels** | 채널 목록, 입장, 구독/탈퇴 | getChannels, getMyChannels, getChannel, enterChannel | ChannelCardList, ChannelProfile |
| **post** | 아티/팬/미디어 포스트 | getPostList, getFeedPostList, getMediaPostList, mutate 좋아요/삭제/신고 | PostCard, PostImage, PostVideo, PostNavBar |
| **comment** | 댓글/답글 | getCommentList, getReplyList, createComment, deleteComment | CommentCard, CommentForm, ReplyArea |
| **profiles** | 프로필 설정, 닉네임, 알림 | getTokenUser, updateProfile | ProfileSettingBottomSheet, NameSetting |
| **memberships** | 멤버십 카드, 결제 | getMembership | MembershipCardList, MembershipNotice |
| **notices** | 공지사항 목록/상세 | getNotices, getNoticeLabels, getNotice | LabelSlide, NoticeContent |
| **schedule** | 일정 캘린더 | getSchedules | Calendar, DatePicker, ScheduleList |
| **intro** | 채널 인트로 페이지 | getChannelIntro | IntroContents, IntroMemberList |
| **hashtag** | 해시태그 검색 | getHashtagPostList | HashtagSearchBar, HashtagPostList |
| **live** | 라이브 룸 | getLiveRooms, createLiveRoom | LiveList, LiveProfileBottomSheet |
| **arti** | 아티스트 정보 | — | — |
| **more** | 채널 더보기 | — | MoreChannelList |

---

## 5. 핵심 아키텍처 패턴

### 5-1. 네이티브 웹뷰 브릿지
```typescript
// common/command/runCommand.ts
runCommand({ key: 'openBrowser', url: '...' });
runCommand({ key: 'openInAppBrowser', url: '...' });
runCommand({ key: 'closeInAppBrowser' });
runCommand({ key: 'download', url: '...', type: 'image' });
runCommand({ key: 'downloadAll', urls: [...], type: 'image' });
runCommand({ key: 'pageLoadFinished' });
runCommand({ key: 'openEditPostFanFeed', postId, channelId, boardId, hasMembership });
```

### 5-2. API 클라이언트 패턴
```typescript
// 클라이언트 사이드
import { channelApi } from '@/common/utils/api';
channelApi.get<T>({ pathname, query, signal });
channelApi.post<T>({ pathname, body });

// 서버 사이드 (SSR)
import { serverFetch } from '@/common/utils/serverApi';
const data = await serverFetch<T>('/channels/...', { headers: { 'channel-id': id } });
```

### 5-3. 모달 시스템
4가지 모달 타입, 모두 Jotai atom 기반:

| 타입 | 훅 | 용도 |
|------|-----|------|
| **Dialog** | `useDialog()` | 확인/취소 다이얼로그 |
| **BottomSheet** | `useBottomSheet()` | 하단 시트 (메뉴, 설정) |
| **StackView** | `useStackView()` | 전체 화면 스택 네비게이션 |
| **AlertDialog** | `useAlertDialog()` | 간단 알림 |

### 5-4. 서버 프리페치 (HydrationBoundary)
```typescript
// pages/channels/[channelPath]/arti/page.tsx 패턴
const Page = async ({ params }) => {
    const queryClient = new QueryClient();
    await queryClient.prefetchInfiniteQuery({
        queryKey: QueryKeys.artistPostList.detailKey({ channelId }),
        queryFn: () => serverFetch<T>('/posts?...'),
        initialPageParam: null
    });
    return (
        <HydrationBoundary state={dehydrate(queryClient)}>
            <ArtistPage />
        </HydrationBoundary>
    );
};
```

### 5-5. 포스트 탭 시스템
채널 페이지는 3개 탭으로 구성:
- **아티스트 피드** (`artist`) — 아티스트 공식 포스트
- **팬 피드** (`feed`) — 팬 커뮤니티 포스트
- **미디어 피드** (`media`) — 미디어 콘텐츠 (비디오, 이미지)

각 탭은 독립적인 쿼리 훅, VO, 컴포넌트를 가짐.

### 5-6. React Query staleTime 전략 (최적화 적용됨)

| 쿼리 | staleTime | gcTime | 근거 |
|------|-----------|--------|------|
| `getTokenUser` | ∞ | ∞ | JWT decode 결과, 세션 내 불변 |
| `getChannel` | 5분 | 10분 | 채널 기본 정보, 변경 빈도 낮음 |
| `getMyChannels` | 5분 | 10분 | 구독 목록 |
| `getChannelBanner` | 10분 | 15분 | 관리자 수동 변경 |
| `getMediaLabelList` | 10분 | 15분 | 마스터 데이터 |
| `getNoticeLabelList` | 10분 | 15분 | 마스터 데이터 |
| Infinite Query (목록) | 2분 | 5분 | 스크롤 중 refetch 방지 |
| `getLiveRooms` | 30초 | 1분 | 실시간성 필요 |

---

## 6. API 모듈 (18개)

| 모듈 | 주요 함수 |
|------|----------|
| `channels.ts` | getChannels, getMyChannels, getChannel, enterChannel, subscribeChannel |
| `posts.ts` | getPostList, likePost, cancelLikePost |
| `feedPosts.ts` | getFeedPostList, createFeedPost, updateFeedPost, deleteFeedPost |
| `media.ts` | getMediaPostList, getMediaPost, getMediaLabelList |
| `comments.ts` | getCommentList, createComment, deleteComment, likeComment |
| `feedComments.ts` | getFeedCommentList, createFeedComment |
| `artiComments.ts` | getArtiCommentList, getArtiCommentCount |
| `notices.ts` | getNotices, getNotice, getNoticeLabels |
| `schedules.ts` | getSchedules |
| `memberships.ts` | getMembership 관련 |
| `live.ts` | getLiveRooms |
| `banners.ts` | getChannelBanners |
| `hashtag.ts` | 해시태그 검색 |
| `arti.ts` | 아티스트 정보 |
| `fan.ts` | 팬/구독자 정보 |
| `translate.ts` | 번역 API |
| `upload.ts` | 미디어 업로드 |
| `subscribers.ts` | 구독자 관리 |

---

## 7. 공용 훅 (주요)

| 훅 | 용도 |
|----|------|
| `useRouter()` | Next.js 라우터 래퍼 |
| `useTranslation(ns)` | 다국어 번역 (`t('key')`) |
| `useMixpanel()` | 이벤트 트래킹 (window.mixpanel 참조) |
| `useAuth()` | 권한 체크 (포스트 수정/삭제/신고 등) |
| `useGetMe()` | 현재 사용자 (fan/arti) |
| `useOnApiError()` | API 에러 핸들링 |
| `useCreateLiveRoom()` | 라이브 룸 생성 |
| `useApiTranslate()` | API 기반 번역 |
| `useFilterUrlText()` | URL 텍스트 필터링 |

---

## 8. Sentry 모니터링

| 설정 | 값 |
|------|-----|
| 조직 | `knowmerce` |
| 프로젝트 | `fromm-channel` |
| 세션 리플레이 | 10% 샘플링 |
| 에러 리플레이 | 100% |
| 터널 라우트 | `/monitoring` (광고차단 우회) |
| 소스맵 | 확대 업로드 + 숨김 처리 |
| 컴포넌트 어노테이션 | 활성화 |

---

## 9. 다른 앱과의 비교

| 항목 | channel | store | partner | backoffice |
|------|---------|-------|---------|-----------|
| 프레임워크 | Next.js 14 Pages | Next.js 14 Pages | Vite SPA | Vite SPA |
| 사용자 | 팬/아티스트 | 소비자 | 소속사/매니저 | 내부 운영 |
| 렌더링 | CSR + SSR | SSR/SSG/ISR | CSR | CSR |
| React Query | v5 | v4 | v5 | v5 |
| 라우팅 | Next.js Pages | Next.js Pages [M]/ | React Router v6 | React Router v7 |
| 결제 | — | Portone/Toss/PayPal | — | — |
| 웹뷰 | ✅ (모바일 전용) | 웹뷰 + 브라우저 | ❌ | ❌ |
| 다국어 | 커스텀 lazy i18n | next-translate | — | — |
| 에러 모니터링 | Sentry | 커스텀 | — | — |

---

## 10. 주의사항

- **모바일 웹뷰 전용** — 420px 최대 너비, 네이티브 브릿지 의존
- **네이티브 브릿지 필수** — `runCommand()`로 앱 기능 호출 (다운로드, 브라우저, 라이브 등)
- **Pages Router** — App Router가 아님 (`src/pages/` 기반)
- **JWT 디코딩** — `jwtDecode` 유틸 사용 (jsonwebtoken 제거됨)
- **mixpanel** — 정적 import 제거됨, `window.mixpanel` 전역 참조 패턴
- **react-player/lazy** — 비디오 플레이어 lazy 로딩 적용
- **dynamic import** — PostImage(swiper), ChannelBanner(@egjs), PhotoSwipe(lightbox) 등 코드 스플리팅
- **DTO 자동 생성** — `scripts/generate-types.js`로 `dto/` 파일 생성, 직접 수정 금지
