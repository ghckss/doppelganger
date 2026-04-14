# kiwee-web - 사용자 웹 프론트엔드

> **저장소**: `~/workspace/kiwee-web`  
> **배포 URL**: `v2.kiwee.co.kr`  
> **유형**: React SPA (Vite), 모바일 앱 내 WebView로 동작

## 기술 스택

| 구분 | 기술 |
|------|------|
| 프레임워크 | React 18.3 (Vite 6.0) |
| 언어 | TypeScript 5.6 |
| 라우팅 | React Router 7.1 |
| 상태 관리 | Zustand 5.0 (9개 스토어) |
| 스타일링 | Vanilla CSS (유틸리티 클래스 기반) |
| HTTP | Axios 1.7 |
| UI | Swiper 11.2, react-zoom-pan-pinch |
| 빌드/배포 | Vite → S3 + CloudFront |
| 패키지 매니저 | pnpm |

## 핵심 역할

이 웹앱은 **두 가지 모드**로 동작한다:

1. **앱 내 WebView** (`kiwee-app`이 로드): 앨범 관리, 음악 재생, 갤러리 등 전체 기능
2. **독립 웹 접속**: 약관/정책 페이지만 노출 (`PolicyWeb`)

User-Agent에 `kiwee_device`가 포함되면 앱 모드, 아니면 웹 모드.

## 프로젝트 구조

```
src/
├── page/                    # 페이지 컴포넌트 (18개)
│   ├── Main.tsx             # 메인 허브 (앨범/플레이리스트/갤러리 탭)
│   ├── AlbumInfo.tsx        # 앨범 상세 (곡 목록, 영상, 아트워크)
│   ├── AudioPlayer.tsx      # HTML5 오디오 재생 핸들러
│   ├── User.tsx             # 인증 래퍼 (로그인/회원가입/비밀번호찾기)
│   ├── MyInfo.tsx           # 프로필 관리
│   ├── StoreList.tsx        # 스토어/결제
│   ├── HelpInfo.tsx         # QR/NFC 도움말
│   ├── Policy.tsx           # 약관
│   ├── user/                # 인증 하위 페이지
│   │   ├── Login.tsx
│   │   ├── Registe.tsx
│   │   └── FindPass.tsx
│   └── mainTab/             # 메인 탭 콘텐츠
│       ├── Album.tsx        # 앨범 브라우저 + QR/NFC/코드 추가
│       ├── PlayList.tsx     # 플레이리스트 관리
│       ├── Gallery.tsx      # 아티스트 갤러리
│       ├── LockPage.tsx     # 인증 게이트 (QR/NFC 미완료 시)
│       └── NonePage.tsx     # 비로그인 상태
├── components/              # 재사용 컴포넌트 (36개)
│   ├── Header.tsx           # 상단 네비게이션
│   ├── BotPlayer.tsx        # 하단 오디오 플레이어
│   ├── ModalPlayer.tsx      # 전체화면 플레이어 모달
│   ├── ModalPlayList.tsx    # 플레이리스트 모달
│   ├── ModalLogin.tsx       # 로그인 모달
│   ├── AlbumItem.tsx        # 앨범 카드
│   ├── SongItem.tsx         # 곡 리스트 아이템
│   └── ...                  # Toast, Loader, ImageModal 등
├── zustand/                 # 상태 관리
│   ├── store.ts             # 9개 Zustand 스토어
│   └── types.ts             # 스토어 타입
├── libs/
│   ├── service.ts           # Axios 설정 + 디바이스 브릿지
│   ├── config.ts            # API URL, S3 URL, 엔드포인트
│   └── utils.ts             # 검증 정규식, 유틸리티
├── lang/                    # 다국어 JSON
│   ├── ko.json, en.json, cn.json, jp.json
├── Layout/
│   └── Layout.tsx           # 레이아웃 + 디바이스 브릿지 이벤트 핸들러
├── css/
│   ├── common.css           # CSS 변수, 리셋, 유틸리티 클래스
│   └── layout.css           # 레이아웃 스타일
└── router/
    └── Router.tsx           # 라우터 설정 (앱/웹 분기)
```

## 라우트

### 앱 내 WebView 라우트 (User-Agent: `kiwee_device_*`)
| 경로 | 컴포넌트 | 설명 |
|------|----------|------|
| `/` | Main.tsx | 메인 (앨범/플레이리스트/갤러리 탭) |
| `/albumInfo` | AlbumInfo.tsx | 앨범 상세 |
| `/store` | StoreList.tsx | 스토어/결제 |
| `/user` | User.tsx | 로그인/회원가입/비밀번호찾기 |
| `/myInfo` | MyInfo.tsx | 프로필 설정 |
| `/myDetail` | UserDetail.tsx | 프로필 수정 |
| `/term` | Policy.tsx | 약관 |
| `/help` | HelpInfo.tsx | 도움말 |

### 웹 전용 라우트 (일반 브라우저)
| 경로 | 컴포넌트 | 설명 |
|------|----------|------|
| `/*` | PolicyWeb.tsx | 약관/정책만 노출 |

## 상태 관리 (Zustand 9개 스토어)

### 영속 스토어 (암호화 localStorage)
| 스토어 | 키 | 역할 |
|--------|-----|------|
| `useUser` | `k_u` | 사용자 인증 정보 (token, userInfo) |
| `useUserSet` | `k_us` | UI 설정 (viewMode, mainTabIndex, deviceOS) |
| `useLang` | `k_lg` | 언어 설정 (langCode, langInfo, 에러코드 매핑) |
| `useMusicData` | `k_md` | 플레이리스트 (곡 목록, 현재 재생, 반복/셔플) |

### 비영속 스토어
| 스토어 | 역할 |
|--------|------|
| `useLoading` | 로딩/토스트/다운로드 상태 |
| `useHeader` | 헤더 표시/모드 제어 |
| `usePlayer` | 오디오 재생 상태 (play/pause/seek/time) |
| `useModal` | 로그인/회원가입 모달 표시 |
| `useImageModal` | 이미지 뷰어 모달 |

**암호화 키**: `KIWEE__STORAGE__HASHKEY__34360759`

## 디바이스 브릿지 (Native App 연동)

`kiwee-web`은 `kiwee-app` 내부의 WebView에서 동작하며, `postMessage`로 통신한다.

### Web → Native (요청)
```typescript
// src/libs/service.ts - sendDeviceFunc()
window.ReactNativeWebView.postMessage(JSON.stringify({ code, message }))
```

| 코드 | 용도 |
|------|------|
| `scanCodeQR` | QR 스캐너 열기 |
| `scanCodeNFC` | NFC 리더 열기 |
| `getLocation` | 디바이스 위치 요청 |
| `openNewBrowser` | 외부 URL 브라우저 열기 |
| `onDownload` | 음악 파일 다운로드 요청 |
| `onPlaylistUpdated` | 플레이리스트 변경 동기화 |
| `onMediaStateChanged` | 재생/일시정지 알림 |
| `onMediaTime` | 재생 시간 동기화 |
| `onRepeatUpdated` | 반복 모드 변경 |
| `onSkip` | 곡 건너뛰기 |

### Native → Web (응답/이벤트)
```typescript
// src/Layout/Layout.tsx - window.message 이벤트 리스너
```

| 이벤트 | 용도 |
|--------|------|
| `kiwee_qr_success` | QR 스캔 결과 수신 |
| `kiwee_nfc_success` | NFC 읽기 결과 수신 |
| `getLocation` | 위치 정보 수신 |
| `onPlaylistUpdated` | 플레이리스트 동기화 |
| `onSyncState` | 앱 복귀 시 상태 동기화 |

### 플랫폼별 차이
- **Android**: 네이티브가 플레이리스트 관리, 웹은 동기화만
- **iOS**: 웹이 플레이리스트 관리, MediaSession API로 잠금화면 제어

## 인증

1. 이메일/비밀번호 → `POST /v1/login` → 토큰 수신
2. 토큰 → localStorage `token` 키 저장
3. Axios 인터셉터로 모든 요청에 `authorization` 헤더 자동 추가
4. 인증 오류 (code 100, 9998) → 토큰 자동 제거

### 인증(Certification) 게이트
- 사용자가 QR/NFC 코드를 스캔해야 앨범 콘텐츠 접근 가능
- `userInfo.certification === false` → `LockPage` 표시
- 인증 완료 → 전체 기능 이용

## 다국어

`src/lang/` 디렉토리에 4개 언어 JSON:
- `ko.json` (한국어), `en.json` (영어), `cn.json` (중국어), `jp.json` (일본어)
- 200+ 키 (UI 라벨, 에러 메시지)
- `useLang().setLang(code)` 로 전환
- 디바이스 로케일 기반 자동 설정

## 환경 설정

```bash
# .env.dev / .env.prod
VITE_ENV=dev|prod
VITE_API_URL=https://api-dev.kiwee.co.kr  # 또는 api.kiwee.co.kr
```

## 스크립트

```bash
pnpm dev            # Vite 개발 서버 (port 3000)
pnpm build:dev      # 개발 빌드
pnpm build:prod     # 프로덕션 빌드
pnpm deploy         # 프로덕션 빌드 + S3 배포 + CF 무효화
pnpm deploy:dev     # 개발 배포
```

## 데이터 모델

### UserInfo
```typescript
{
  idx: number, email: string, name: string,
  country: string, profile?: string,
  marketing: boolean, certification: boolean,
  create_dt: string, login_dt: string | null
}
```

### ResAlbumItem
```typescript
{
  idx: number, artist_idx: number,
  photo: string,          // S3 경로
  title: { ko, en, cn, ja },  // 다국어
  release_date: string,
  publisher: string, agency: string,
  artist: { idx, title: { ko, en, cn, ja }, profile }
}
```

## 특이사항

- **모바일 퍼스트**: 모바일 앱 WebView 내에서 주로 동작
- **모달 중심 UX**: 로그인/회원가입이 모달로 처리 (별도 페이지 아님)
- **전역 CSS**: 컴포넌트 스코프 스타일 없음, 전역 유틸리티 클래스 사용
- **Pretendard 폰트**: 커스텀 폰트 사용
- **S3 CDN**: `d3hr8xcaf9dorp.cloudfront.net`
