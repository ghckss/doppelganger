# Store 앱 종합 문서

> fromm 서비스의 **이커머스 스토어**. 아티스트 굿즈 쇼핑, 주문/결제, 멤버십, VOD 에피소드 시청 등 소비자용 웹 서비스. 모바일 웹뷰 + 데스크톱 브라우저 지원.

---

## 1. 기술 스택 요약

| 영역 | 기술 | 비고 |
|------|------|------|
| 프레임워크 | **Next.js 14** (Pages Router) | SSR/SSG/ISR 활용 |
| UI | **React 18** + TypeScript 5.1 | |
| 스타일 | **Panda CSS** | frommPreset, 모바일 퍼스트 |
| 서버 상태 | **React Query v4** | jotai-tanstack-query 연동 |
| 글로벌 상태 | **Jotai** | me, cart, order, product, sort 등 18개 atom 파일 |
| 폼 | **@modular-forms/react** + **Valibot** | |
| 결제 | **Portone(아임포트)**, **TossPayments**, PayPal, Eximbay | 12종 결제수단 |
| 국제화 | **next-translate** | ko, en, ja, zh (4개 언어) |
| 분석 | **Mixpanel**, **Google Analytics**, **GTM** | |
| HTTP | **Axios** | 5개 API 인스턴스 |
| 채팅 | **Sendbird UIKit** | |
| 미디어 | **@egjs/react-flicking**, react-player, lottie-react | |
| 테스트 | **Vitest** (단위) + **Playwright** (E2E) | |
| 에러 모니터링 | 커스텀 ErrorBoundary | |

---

## 2. 프로젝트 구조

```
apps/store/
├── src/
│   ├── api/                    # API 클라이언트 (26개 도메인 모듈)
│   │   ├── auth/               # 인증, PIN, 이메일 인증
│   │   ├── order/              # 주문 생성/조회 ★ 핵심
│   │   ├── payment/            # 결제/환불/자동결제 ★ 핵심
│   │   ├── goods/, bundle/     # 상품/번들 상세
│   │   ├── cart/               # 장바구니 CRUD
│   │   ├── delivery/           # 배송 정보/배송비
│   │   ├── discount/           # 할인 계산
│   │   ├── brand/, arti/       # 아티스트/브랜드 페이지
│   │   ├── product/            # 상품 목록/카테고리
│   │   ├── home/               # 홈 배너/메뉴/추천
│   │   ├── event/, eventUser/  # 이벤트 + 참여자
│   │   ├── membership/         # 멤버십 정보
│   │   ├── content/            # VOD 콘텐츠 코드
│   │   ├── billingKey/         # 정기결제 카드 등록
│   │   ├── subscriptions/      # 구독 관리
│   │   ├── campaign/           # 프로모션 캠페인
│   │   ├── couriers/           # 배송 추적
│   │   ├── live/               # 라이브 스트리밍 토큰
│   │   ├── notice/             # 푸시 알림
│   │   ├── options/            # 상품 옵션/재고
│   │   └── terms/              # 이용약관
│   ├── atom/                   # Jotai 상태 (18개 파일)
│   │   ├── me.ts, cart.ts, order.tsx, orderItem.ts
│   │   ├── product.tsx, goods.ts, bundle.ts, sort.tsx
│   │   ├── brand.tsx, arti/, countries.ts
│   │   ├── modal.ts, backPage.ts, moveTop.ts
│   │   ├── common.ts, eventApply.ts, vwr.ts
│   │   └── createUseContextAtom.ts
│   ├── components/             # React 컴포넌트 (234개)
│   │   ├── home/               # 홈페이지 (배너, 메뉴, 추천)
│   │   ├── product/            # 상품 목록/검색
│   │   ├── goods/              # 상품 상세
│   │   ├── cart/               # 장바구니
│   │   ├── order/              # 주문서 ★ 핵심
│   │   ├── order-complete/     # 주문 완료
│   │   ├── auto-pay/           # 자동결제 관리
│   │   ├── arti/, brand/       # 아티스트/브랜드 페이지
│   │   ├── episode/            # VOD 에피소드 뷰어
│   │   ├── event/              # 이벤트 참여
│   │   ├── membership/         # 멤버십 페이지
│   │   ├── subscriptions/      # 구독 관리
│   │   ├── signup/, find-password/ # 인증 UI
│   │   ├── my-contents/        # 내 콘텐츠 라이브러리
│   │   ├── terms/, trial/      # 약관, 체험판
│   │   ├── shared/             # 공용 (Alert, HeaderBar, Footer, ErrorBoundary 등)
│   │   ├── styled/             # Panda CSS 스타일드 컴포넌트
│   │   └── widgets/            # 재사용 위젯
│   ├── domain/                 # 비즈니스 로직 계층
│   │   ├── order/              # 주문 유효성 검사/결제 로직 ★
│   │   ├── price/              # 가격 계산
│   │   ├── form/               # 폼 유효성
│   │   ├── searchPredicate/    # 검색 필터
│   │   └── selectedGoods/      # 선택 상품 관리
│   ├── hooks/                  # 커스텀 훅 (60+)
│   │   ├── order/              # 결제 오케스트레이션 ★ 핵심
│   │   ├── paymentSDK/         # PG사 SDK 로더
│   │   ├── goods/, discount/   # 상품/할인 훅
│   │   ├── auto-pay/           # 자동결제 훅
│   │   ├── countries/, live/   # 국가/라이브
│   │   └── 공용 훅들...
│   ├── pages/                  # Next.js 페이지 라우터
│   │   └── [M]/               # ★ 마켓 파라미터 동적 라우트
│   ├── queries/                # React Query 훅 (90+)
│   ├── utils/                  # 유틸리티 (25+)
│   ├── vo/                     # Value Object
│   ├── Constants.ts            # 전역 상수 (Path, Secret, PG 설정)
│   ├── Types.ts                # 전역 타입
│   └── Styles.ts               # 테마/글로벌 스타일
├── locales/                    # 다국어 번역 파일 (ko, en, ja, zh)
├── i18n.json                   # next-translate 설정 (70+ 라우트 매핑)
├── package.json
├── next.config.js
├── panda.config.ts
└── CLAUDE.md                   # AI 에이전트 가이드 (상세)
```

---

## 3. 환경 설정

### API Base URL (5개 서비스)
| 서비스 | dev | prod |
|--------|-----|------|
| Store | `store-api-dev.frommyarti.com` | `store-api.frommyarti.com` |
| Message | `message-api-dev.frommyarti.com` | `message-api.frommyarti.com` |
| Membership | `membership-api-dev.frommyarti.com` | `membership-api.frommyarti.com` |
| Channel | `channel-api-dev.frommyarti.com` | `channel-api.frommyarti.com` |
| Account | `account-api-dev.frommyarti.com` | `account-api.frommyarti.com` |

### 결제 PG사 설정 (Constants.ts > Secret)
- `PORTONE_MERCHANT_ID` — Portone(아임포트) 가맹점 ID
- `TOSSPAYMENTS_MID` — TossPayments 가맹점 ID
- `KAKAOPAY_MID` — 카카오페이
- `PAYPAL_MID` — PayPal
- `EXIMBAY_MID` — Eximbay (해외결제)

### 지원 결제수단 (12종)
`card`, `trans`, `vbank`, `alipay`, `wechat`, `paypal`, `eximbay_card`, `tosspayments_card`, `tosspayments_trans`, `tosspayments_vbank`, `kakaopay`, `frommpay`

### 다국어 (4개 언어)
- 한국어 (ko, 기본), 영어 (en), 일본어 (ja), 중국어 (zh)
- 통화: KRW, USD

---

## 4. 라우팅 시스템

### [M] 마켓 파라미터
모든 라우트가 `/[M]/...` 패턴. `[M]`은 마켓 파라미터로 `parseMegaParams()`로 파싱.

### 주요 라우트

| 카테고리 | 라우트 | 용도 |
|---------|--------|------|
| **홈** | `/[M]/` | 메인 (배너, 메뉴, 추천) |
| **인증** | `/[M]/signin`, `/signup`, `/find-password` | 로그인/회원가입/비밀번호 찾기 |
| **상품** | `/[M]/product` | 상품 목록 (카테고리, 검색) |
| | `/[M]/goods/[id]` | 상품 상세 |
| | `/[M]/bundle/[id]` | 번들 상세 |
| **아티스트** | `/[M]/arti/[artiPath]` | 아티스트 페이지 |
| | `/[M]/brand/[brandPath]` | 브랜드 페이지 |
| **주문/결제** ★ | `/[M]/cart` | 장바구니 |
| | `/[M]/order` | 주문서 (결제) |
| | `/[M]/order-complete` | 주문 완료 |
| | `/[M]/order/list` | 주문 내역 |
| | `/[M]/order/[id]` | 주문 상세 |
| | `/[M]/order/delivery/[id]` | 배송 조회 |
| **자동결제** | `/[M]/auto-pay` | 카드 관리 + 자동결제 |
| | `/[M]/auto-pay/toss` | TossPayments 빌링키 |
| | `/[M]/auto-pay/password` | 결제 비밀번호 |
| **콘텐츠** | `/[M]/episode/[episodeId]` | VOD 에피소드 뷰어 |
| | `/[M]/my-contents` | 내 콘텐츠 라이브러리 |
| | `/[M]/trial` | 체험판 |
| | `/[M]/content-code` | 콘텐츠 코드 입력 |
| **구독** | `/[M]/subscribe` | 구독 관리 |
| | `/[M]/memberships` | 멤버십 |
| **기타** | `/[M]/event/[...path]` | 이벤트 참여 |
| | `/[M]/campaign/[campaignPath]` | 프로모션 캠페인 |
| | `/[M]/faq`, `/terms`, `/notice` | 고객지원 |
| **프리뷰** | `/[M]/preview/*` | 미리보기 모드 (SSG) |

---

## 5. 핵심 비즈니스 로직 (주문/결제 플로우) ★

### 위험 파일 목록 (CLAUDE.md 지정)
이 파일들은 결제 로직을 담당하며, 수정 시 높은 비즈니스 리스크:

| 파일 | 역할 |
|------|------|
| `hooks/order/usePurchase.tsx` | 결제 오케스트레이터 (전체 흐름 관리) |
| `hooks/order/useFrommPayOrder.tsx` | 자동결제(frommpay) 로직 |
| `hooks/order/useNormalOrder.tsx` | 일반 결제 로직 |
| `hooks/order/usePrepareOrder.tsx` | 결제 전 유효성 검증 |
| `domain/order/checkOrderBody.ts` | 주문 데이터 검증 |
| `queries/order/useCreateOrder/index.ts` | 주문 생성 (암호화 포함) |
| `api/order/index.ts` | 주문 API 함수들 |

### 결제 흐름 요약
```
사용자 결제 클릭
  → usePrepareOrder: 주문 데이터 검증
  → checkOrderBody: 필수값/유효성 체크
  → useCreateOrder: 주문 생성 API (AES 암호화)
  → usePurchase: PG사별 분기
    ├── useNormalOrder: Portone/TossPayments SDK 호출
    └── useFrommPayOrder: 자동결제 (billingKey)
  → paymentComplete API: 결제 완료 처리
  → order-complete 페이지 이동
```

### 추가 문서
- `docs/order-flow.md` — 결제 흐름 상세 (8,000줄+)
- `docs/payment-methods.md` — 결제수단 매트릭스
- `docs/panda-css-usage-rules.md` — 스타일 컨벤션

---

## 6. 도메인별 요약

| 기능 | API 모듈 | 컴포넌트 | 쿼리 훅 | 주요 상태(Atom) |
|------|---------|---------|---------|---------------|
| **홈** | home | home/* | banners, menus, recommended | product, sort |
| **상품 검색** | product | product/* | productCount, goodsList | product, sort |
| **상품 상세** | goods, bundle, options | goods/* | getGoods, getBundle, getOptions | goods, orderItem |
| **장바구니** | cart | cart/* | addCart, deleteCart, updateCart | cart, orderItem |
| **주문/결제** ★ | order, payment | order/* | createOrder, orderComplete, paymentAgain | order, modal |
| **자동결제** | billingKey, payment | auto-pay/* | billingKeys, createBillingKey | — |
| **아티스트** | arti, brand | arti/*, brand/* | getArti, getBrand, goodsList | — |
| **이벤트** | event, eventUser | event/* | getEvent, applyEvent | eventApply |
| **콘텐츠** | content | episode/*, my-contents/* | playHistory, contentCode | — |
| **구독** | subscriptions | subscriptions/* | getSubscriptions, autoRenewal | — |
| **멤버십** | membership | membership/* | getMembershipUsers | — |
| **인증** | auth | signup/*, find-password/* | signIn, signUp, verifyEmail | me |

---

## 7. 공용 훅 (주요)

| 훅 | 용도 |
|----|------|
| `usePurchase()` | 결제 전체 오케스트레이션 ★ |
| `useNormalOrder()` | 일반 PG 결제 |
| `useFrommPayOrder()` | 자동결제 |
| `usePrepareOrder()` | 결제 전 검증 |
| `useOrderBody()` | 주문 데이터 구성 |
| `useDiscount()` | 할인 계산 |
| `useIMPScript()` | Portone SDK 로더 |
| `useRequestBillingKey()` | 카드 등록 플로우 |
| `useLoggedInRequired()` | 로그인 필수 리다이렉트 |
| `useMixpanel()` | 이벤트 트래킹 |
| `useGTM()` | Google Tag Manager |
| `useCountries()` | 국가 목록 |
| `useDaumPostcode()` | 한국 주소 검색 |
| `useModal()`, `useStackViewModal()` | 모달/스택뷰 |
| `useToast()` | 토스트 알림 |
| `useCookieCurrency()` | 통화 설정 (KRW/USD) |
| `useLang()` | 언어 감지 |

---

## 8. SSR/SSG/ISR 패턴

| 데이터 페칭 방식 | 사용 페이지 | 비고 |
|----------------|-----------|------|
| **getStaticProps (ISR)** | product, brand, arti, faq, terms | 고트래픽 정적 페이지 |
| **getServerSideProps** | 인증 필요 페이지 | |
| **클라이언트 React Query** | cart, order, my-contents | 사용자 데이터 |
| **프리뷰 모드** | `/[M]/preview/*` | SSG로 관리 |

---

## 9. 주의사항

- **결제 로직 수정 시 극히 주의** — `hooks/order/`, `domain/order/`, `api/order/` 는 높은 비즈니스 리스크
- **[M] 마켓 파라미터** — 모든 페이지 라우트가 `[M]`으로 시작. `parseMegaParams()`로 파싱 필요
- **Pages Router** — App Router가 아님. `pages/` 디렉토리 기반
- **React Query v4** — channel(v5)과 버전이 다름 (`jotai-tanstack-query` 연동)
- **DTO는 npm 패키지** — `@knowmerce/fromm-store-api-*` 패키지에서 타입 import
- **다국어** — `i18n.json`에 70+ 라우트별 번역 네임스페이스 매핑 필수
- **Panda CSS 변경 시** — `pnpm prepare` 실행 필수 (코드젠)
- **AES 암호화** — 주문 생성 시 `browser-crypto`로 AES-256 암호화
