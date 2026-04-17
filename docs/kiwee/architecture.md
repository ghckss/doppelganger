# Kiwee 시스템 아키텍처

## 전체 시스템 구성

```
┌────────────────────────────────────────────────────────────────────┐
│                          사용자 (모바일)                            │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                    kiwee-app (Expo)                           │  │
│  │                                                              │  │
│  │  ┌─────────────┐  postMessage  ┌─────────────────────────┐  │  │
│  │  │ Native Layer │ ◄──────────► │ WebView (kiwee-web)      │  │  │
│  │  │              │              │ v2.kiwee.co.kr           │  │  │
│  │  │ - QR Scanner │              │                         │  │  │
│  │  │ - NFC Reader │              │ - 앨범 관리              │  │  │
│  │  │ - TrackPlayer│              │ - 플레이리스트            │  │  │
│  │  │ - File I/O   │              │ - 갤러리                 │  │  │
│  │  │ - Offline    │              │ - 인증/프로필             │  │  │
│  │  └──────┬───────┘              └───────────┬─────────────┘  │  │
│  │         │                                  │                 │  │
│  └─────────┼──────────────────────────────────┼─────────────────┘  │
│            │                                  │                    │
└────────────┼──────────────────────────────────┼────────────────────┘
             │                                  │
             │        REST API (Axios)          │
             └──────────────┬───────────────────┘
                            │
                            ▼
              ┌─────────────────────────┐
              │     Backend API          │
              │  api.kiwee.co.kr         │
              │  (별도 저장소, 미분석)    │
              └──────────┬──────────────┘
                         │
              ┌──────────┴──────────────┐
              │                         │
              ▼                         ▼
    ┌─────────────────┐      ┌──────────────────┐
    │  AWS S3          │      │  Database         │
    │  (파일 저장)      │      │  (데이터 저장)     │
    └─────────────────┘      └──────────────────┘
              │
              ▼
    ┌─────────────────┐
    │  CloudFront CDN  │
    │  (정적 자산 배포)  │
    └─────────────────┘
              ▲
              │
    ┌─────────┴─────────┐
    │  kiwee-admin       │
    │  admin.kiwee.co.kr │
    │  (관리자 대시보드)   │
    └───────────────────┘
```

## 저장소 간 관계

### kiwee-web ↔ kiwee-app (밀접한 연동)

이 두 저장소는 **하나의 제품**처럼 동작한다:

1. `kiwee-app`이 `kiwee-web`을 WebView로 로드
2. `postMessage` 기반 양방향 통신
3. 웹이 UI/비즈니스 로직, 앱이 네이티브 기능 담당

```
Web (kiwee-web)                    Native (kiwee-app)
─────────────────                  ──────────────────
"QR 스캔해줘"    ──postMessage──►  QR 카메라 열기
                 ◄──postMessage──  스캔 결과 반환

"곡 다운로드해줘" ──postMessage──►  S3에서 파일 다운로드
                 ◄──postMessage──  완료 알림

"재생해줘"       ──postMessage──►  TrackPlayer 재생
"현재 시간?"     ◄──postMessage──  재생 시간 동기화
```

### kiwee-admin ↔ 다른 저장소 (독립적)

`kiwee-admin`은 동일한 백엔드 API를 사용하지만 완전히 독립적:

- 별도 도메인 (`admin.kiwee.co.kr`)
- 별도 인증 시스템 (`/admin/login/login`)
- 별도 API 경로 (`/admin/*`)
- 별도 `scd` 헤더 (`KIWEEADMINSCD`)

## API 구조

### 엔드포인트 네임스페이스

```
api.kiwee.co.kr
├── /v1/                    # 사용자 API (kiwee-web, kiwee-app)
│   ├── /login              # 로그인
│   ├── /join               # 회원가입
│   ├── /auth               # 사용자 정보/수정/탈퇴
│   ├── /album              # 앨범 CRUD
│   ├── /playlist           # 플레이리스트 CRUD
│   ├── /gallery            # 갤러리/아티스트
│   ├── /store              # 스토어/결제
│   └── /media              # 미디어 파일 URL
│
└── /admin/                 # 관리자 API (kiwee-admin)
    ├── /login              # 관리자 로그인
    ├── /auth               # 관리자 정보
    ├── /user               # 회원 관리
    ├── /album              # 앨범 관리
    ├── /stats              # 통계
    ├── /service            # 운영 관리
    └── /base               # 공통 (S3 URL 등)
```

### 인증 헤더 비교

| 저장소 | scd 헤더 | authorization | 토큰 저장 |
|--------|----------|---------------|-----------|
| kiwee-admin | `KIWEEADMINSCD` | JWT | localStorage `@token` |
| kiwee-web | `KIWEESCD` | JWT | localStorage `token` |
| kiwee-app | (웹 통해 간접) | (웹 통해 간접) | (WebView 세션) |

## 배포 인프라

```
GitHub (push)
    │
    ▼
GitHub Actions (CI/CD)
    │
    ├── kiwee-admin (master/dev branch)
    │   └── Build (CRA) → S3 (admin.kiwee.co.kr) → CloudFront 무효화
    │
    ├── kiwee-web (master/dev branch)
    │   └── Build (Vite) → S3 (v2.kiwee.co.kr) → CloudFront 무효화
    │
    └── kiwee-app
        └── EAS Build → App Store / Play Store / Internal Distribution
```

### 환경별 URL

| 환경 | Admin | Web | API |
|------|-------|-----|-----|
| Production | admin.kiwee.co.kr | v2.kiwee.co.kr | api.kiwee.co.kr |
| Development | (dev S3 bucket) | (dev S3 bucket) | api-dev.kiwee.co.kr |

### S3/CDN 구조

| 용도 | 도메인/버킷 |
|------|-------------|
| Admin 호스팅 | `s3://admin.kiwee.co.kr` |
| Web 호스팅 | `s3://v2.kiwee.co.kr` |
| 미디어 CDN | `d3hr8xcaf9dorp.cloudfront.net` |
| AWS 리전 | `ap-northeast-2` (서울) |

## 데이터 흐름

### 앨범 등록 플로우
```
1. 사용자가 실물 앨범 카드의 QR/NFC 스캔
2. kiwee-app: 네이티브 카메라/NFC로 코드 읽기
3. kiwee-app → kiwee-web: 스캔 결과 postMessage
4. kiwee-web → API: POST /v1/album/insert { code }
5. API → kiwee-web: 앨범 데이터 반환
6. kiwee-web: UI에 앨범 표시
```

### 음악 재생 플로우 (온라인)
```
1. kiwee-web: 곡 선택 → 플레이리스트 업데이트
2. kiwee-web → kiwee-app: onPlaylistUpdated postMessage
3. kiwee-app: TrackPlayer로 재생 시작
4. kiwee-app → kiwee-web: 재생 시간 동기화 (onMediaTime)
5. kiwee-web: UI 프로그레스 바 업데이트
```

### 음악 다운로드 & 오프라인 재생 플로우
```
1. kiwee-web → kiwee-app: onDownload { songs: SongInfo[] }
2. kiwee-app → API: POST /v1/media/file/downloadUrl { filePath }
3. API → kiwee-app: { downloadUrl: presignedS3Url }
4. kiwee-app: expo-file-system으로 파일 다운로드
5. kiwee-app: play_list.json에 메타데이터 저장
6. (오프라인 시) kiwee-app: 자체 플레이어 UI로 로컬 파일 재생
```

### 관리자 워크플로우
```
1. 관리자 로그인 → POST /admin/login/login
2. RBAC 권한에 따라 메뉴 접근
3. 앨범/유저/통계 관리 → /admin/* API 호출
4. 데이터는 사용자 앱(kiwee-web/app)에 실시간 반영
```

## 공통 패턴 & 컨벤션

### 상태 관리
- **전 저장소 Zustand 사용**
- 영속화가 필요한 스토어는 `persist` 미들웨어 + 암호화
- admin/web: CryptoJS AES + localStorage
- app: AsyncStorage

### API 호출
- **전 요청 POST 방식** (GET 미사용)
- Axios 인스턴스 + 인터셉터
- 에러 → toast/alert 알림
- 인증 만료 → 자동 토큰 제거

### 다국어
- 4개 언어: ko, en, cn, ja
- 데이터 모델에 다국어 필드: `{ ko: string, en: string, cn: string, ja: string }`
- UI 문자열: JSON 파일 기반

### 파일/미디어
- 모든 미디어 파일은 S3에 저장
- CloudFront CDN으로 배포
- API를 통해 Presigned URL 획득 후 접근

## 작업 시 주의사항

1. **kiwee-web 수정 시**: kiwee-app의 WebView 브릿지에 영향 확인 필요
2. **브릿지 메시지 변경 시**: 양쪽 저장소 동시 수정 필요
3. **API 변경 시**: admin과 web/app 모두 영향 범위 확인
4. **배포 순서**: API → web → app 순서가 안전 (하위 호환성)
5. **환경 분리**: .env.dev/.env.prod 주의, 실수로 prod 배포하지 않도록
6. **Admin은 데스크톱 전용**: 반응형 미지원 (min-width: 1900px)
7. **App은 세로 모드 전용**: `orientation: "portrait"` 고정
