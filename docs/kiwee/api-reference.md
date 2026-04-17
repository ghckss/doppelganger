# Kiwee API Reference

> **Base URL**: `https://api.kiwee.co.kr` (prod) / `https://api-dev.kiwee.co.kr` (dev)  
> **전 요청 POST 방식**, Content-Type: `application/json`

## 공통 헤더

| 헤더 | 값 | 용도 |
|------|-----|------|
| `Content-Type` | `application/json` | 모든 요청 |
| `scd` | `KIWEESCD` (사용자) / `KIWEEADMINSCD` (관리자) | 서비스 식별 |
| `authorization` | `{JWT token}` | 인증된 요청 |

## 사용자 API (`/v1/*`) - kiwee-web, kiwee-app 사용

### 인증

| 엔드포인트 | 설명 | 비고 |
|-----------|------|------|
| `POST /v1/login` | 로그인 (이메일+비밀번호) | 토큰 반환 |
| `POST /v1/login/find` | 비밀번호 재설정 이메일 발송 | |
| `POST /v1/login/certification` | 비밀번호 재설정 인증 | |
| `POST /v1/login/passwordUpdate` | 비밀번호 변경 | |
| `POST /v1/join` | 회원가입 | |
| `POST /v1/join/emailValid` | 이메일 인증 코드 발송 | |
| `POST /v1/join/certification` | 이메일 인증 확인 | |
| `POST /v1/auth` | 사용자 정보 조회 | 토큰 필요 |
| `POST /v1/auth/update` | 프로필 수정 | 토큰 필요 |
| `POST /v1/auth/leave` | 회원 탈퇴 | 토큰 필요 |
| `POST /v1/auth/certification` | QR/NFC 코드로 인증 | 토큰 필요 |

### 앨범

| 엔드포인트 | 설명 | 비고 |
|-----------|------|------|
| `POST /v1/album/list` | 사용자 앨범 목록 | 토큰 필요 |
| `POST /v1/album/get` | 앨범 상세 조회 | |
| `POST /v1/album/insert` | QR/NFC 코드로 앨범 등록 | 토큰 필요 |
| `POST /v1/album/play` | 재생 이벤트 로깅 | |

### 플레이리스트

| 엔드포인트 | 설명 | 비고 |
|-----------|------|------|
| `POST /v1/playlist/list` | 플레이리스트 조회 | 토큰 필요 |
| `POST /v1/playlist/insert` | 곡 추가 | 토큰 필요 |
| `POST /v1/playlist/delete` | 곡 삭제 | 토큰 필요 |
| `POST /v1/playlist/duplicationDelete` | 중복 제거 | 토큰 필요 |
| `POST /v1/playlist/sort` | 순서 변경 | 토큰 필요 |

### 갤러리

| 엔드포인트 | 설명 | 비고 |
|-----------|------|------|
| `POST /v1/gallery/list` | 갤러리 목록 | |
| `POST /v1/gallery/artist` | 아티스트 정보 | |
| `POST /v1/gallery/fav` | 좋아요/즐겨찾기 | 토큰 필요 |

### 스토어

| 엔드포인트 | 설명 | 비고 |
|-----------|------|------|
| `POST /v1/store/list` | 스토어 상품 목록 | |
| `POST /v1/store/insert` | 구매/등록 | 토큰 필요 |

### 미디어

| 엔드포인트 | 설명 | 비고 |
|-----------|------|------|
| `POST /v1/media/file/downloadUrl` | S3 Presigned URL 획득 | `{ filePath }` |

### 기타

| 엔드포인트 | 설명 |
|-----------|------|
| `POST /term` | 약관 텍스트 조회 (타입별) |
| `POST /config` | 앱 설정 조회 |

---

## 관리자 API (`/admin/*`) - kiwee-admin 사용

### 인증

| 엔드포인트 | 설명 |
|-----------|------|
| `POST /admin/login/login` | 관리자 로그인 |
| `POST /admin/auth/info` | 관리자 정보 조회 |

### 회원 관리

| 엔드포인트 | 설명 |
|-----------|------|
| `POST /admin/user/list` | 회원 목록 (활성/탈퇴) |

### 앨범 관리

| 엔드포인트 | 설명 |
|-----------|------|
| `POST /admin/album/list` | 앨범 목록 |
| `POST /admin/album/detail` | 앨범 상세 |

### 통계

| 엔드포인트 | 설명 |
|-----------|------|
| `POST /admin/stats/*` | 앨범 등록/오디오/비디오 재생 통계 |

### 운영

| 엔드포인트 | 설명 |
|-----------|------|
| `POST /admin/service/*` | 관리자 계정, 약관/정책 관리 |
| `POST /admin/base/getS3Url` | S3 다운로드 URL 발급 |

---

## 에러 응답 코드

| 코드 | 의미 | 처리 |
|------|------|------|
| 100 | 로그인 필요 | 토큰 제거 + 로그인 화면 |
| 9998 | 세션 만료 | 토큰 제거 + 로그인 화면 |
| 기타 | 서비스별 에러 | `codeToStr()` 로 다국어 메시지 매핑 |

## WebView 브릿지 API (kiwee-app ↔ kiwee-web)

> `postMessage` 기반 통신. REST API가 아닌 네이티브 브릿지.

### 요청/응답 구조
```typescript
interface Message {
  code: string;      // 함수명
  message: string;   // JSON 페이로드
}
```

### 메시지 코드

| 코드 | 방향 | 용도 | 페이로드 |
|------|------|------|---------|
| `scanCodeQR` | Web→App→Web | QR 스캔 | 결과: `{ data: "scanned_code" }` |
| `scanCodeNFC` | Web→App→Web | NFC 스캔 | 결과: `{ data: "tag_data" }` |
| `getLocation` | Web→App→Web | GPS 위치 | 결과: `{ lat, lng }` |
| `openNewBrowser` | Web→App | URL 열기 | `{ url: "https://..." }` |
| `onDownload` | Web→App | 다운로드 | `{ songs: SongInfo[] }` |
| `onPlaylistUpdated` | 양방향 | 큐 동기화 | `{ playlist: Track[] }` |
| `onMediaStateChanged` | Web→App | 재생/일시정지 | `{ state: "play"\|"pause" }` |
| `onMediaTime` | Web→App | 시간 동기화 | `{ currentTime, duration }` |
| `onSkip` | Web→App | 건너뛰기 | `{ direction: "next"\|"prev" }` |
| `onRepeatUpdated` | Web→App | 반복 모드 | `{ mode: 0\|1\|2 }` |
| `onCurrentIndexChanged` | App→Web | 트랙 변경 | `{ idx: string }` |
| `onSyncState` | App→Web | 상태 동기화 | 전체 플레이어 상태 |
