# kiwee-admin - 관리자 대시보드

> **저장소**: `~/workspace/kiwee-admin`  
> **배포 URL**: `admin.kiwee.co.kr`  
> **유형**: React SPA (Create React App)

## 기술 스택

| 구분 | 기술 |
|------|------|
| 프레임워크 | React 18.2 (CRA) |
| 언어 | JavaScript (TypeScript 미사용) |
| 라우팅 | React Router DOM 6.2 |
| 상태 관리 | Zustand 5.0 (주력), Redux Toolkit (레거시) |
| UI | Material-UI (MUI) 5.15 + Emotion |
| 스타일링 | SCSS + CSS Variables + MUI |
| 차트 | Recharts 2.13, FullCalendar 6.1, Three.js |
| HTTP | Axios 0.24 |
| 빌드/배포 | CRA → S3 + CloudFront, GitHub Actions |
| 패키지 매니저 | pnpm |

## 프로젝트 구조

```
src/
├── pages/                  # 페이지 컴포넌트 (기능별)
│   ├── auth/               # 로그인, 약관
│   ├── dashboard/          # 대시보드 (통계, 차트)
│   ├── user/               # 회원 관리 (활성/탈퇴)
│   ├── album/              # 앨범/음원/아티스트 관리
│   ├── stats/              # 통계 (앨범등록, 재생)
│   ├── service/            # 운영 (관리자, 약관, 마스터PW)
│   └── test/               # 개발용/에러 페이지
├── components/             # 재사용 UI 컴포넌트 (30+)
├── store/store.js          # Zustand 스토어 (useUser, usePopup)
├── utils/
│   ├── service.js          # Axios API 래퍼
│   └── utils.js            # 유틸리티 (검증, 포맷, 디바운스 등)
├── libs/
│   ├── consts.js           # 상수, API URL, 권한 구조, 국가코드
│   └── routes.js           # 라우트 정의
└── assets/                 # CSS, 폰트, 이미지 (SVG 150+)
```

## 라우트 & 페이지

| 경로 | 컴포넌트 | 설명 |
|------|----------|------|
| `/login` | Login.js | 관리자 로그인 |
| `/` | DashBoard1.js | 메인 대시보드 (통계, 차트, 신규유저/앨범) |
| `/user` | User.js | 활성 회원 목록/관리 |
| `/user2` | User2.js | 탈퇴 회원 목록 |
| `/album1` | Album1.js | 앨범 목록, QR코드, 엑셀 내보내기 |
| `/album2` | Album2.js | 앨범 등록 현황 |
| `/album3` | Album3.js | 아티스트 관리 |
| `/stats1` | Stats1.js | 앨범 등록 통계 |
| `/stats2` | Stats2.js | 오디오 재생 통계 |
| `/stats3` | Stats3.js | 비디오 재생 통계 |
| `/service1` | Service1.js | 관리자 계정 관리 |
| `/service2` | Service2.js | 약관/정책 관리 |
| `/servicePassword` | ServicePassword.js | 마스터 비밀번호 (레벨10 전용) |

## 상태 관리 (Zustand)

### useUser 스토어
```javascript
{
  token: string | null,        // JWT 토큰
  mbData: object | null,       // 관리자 정보 + 권한(auth)
  intro: boolean,
  permission: boolean,
  bodyData: object | null,     // 폼 데이터
  reports: array,              // 리포트 데이터
  // Actions
  login(data),                 // 토큰 설정 + 리로드
  logout(),                    // 토큰 제거 + 상태 초기화
  setUser(data),               // 사용자 데이터 업데이트
}
```

- **영속화**: CryptoJS AES 암호화 후 localStorage 저장
- **암호화 키**: `CLONEFIT__STORAGE__HASHKEY__2024`

### usePopup 스토어
- 전역 모달 제어 (제목, 메시지, 커스텀 컴포넌트, 콜백)
- Framer Motion 애니메이션

## 인증 & 권한

### 로그인 플로우
1. 이메일/비밀번호 → `POST /admin/login/login`
2. 응답 토큰 → localStorage `@token` 저장
3. 모든 API 요청에 `authorization` 헤더로 전송

### RBAC (역할 기반 접근 제어)
```javascript
mbData.auth = {
  dashboard: { dashboard1: boolean },
  user: { user1: boolean, user2: boolean },
  album: { album1, album2, album3 },
  stats: { stats1, stats2, stats3 },
  service: { service1, service2 }
}
```
- 라우트별 `mbData?.auth?.{section}?.{page}` 체크
- 레벨 기반: `mbData?.level === 10` (마스터 비밀번호 등)

## API 통신

- **방식**: 모든 요청 POST
- **Base URL**: `REACT_APP_API_URL` 환경변수
- **인증 헤더**: `scd: KIWEEADMINSCD`, `authorization: {token}`

```javascript
// src/utils/service.js
postData(url, sender={})
  // axios.post(API_URL + url, sender, { headers })
```

### 주요 엔드포인트
```
/admin/login/login         - 로그인
/admin/auth/info           - 관리자 정보 조회
/admin/user/list           - 회원 목록
/admin/album/list          - 앨범 목록
/admin/album/detail        - 앨범 상세
/admin/base/getS3Url       - S3 다운로드 URL
/admin/stats/*             - 통계 API
/admin/service/*           - 운영 API
```

## 주요 컴포넌트

| 컴포넌트 | 설명 |
|----------|------|
| Header.js | 상단 네비게이션 (55px) |
| LeftNav.js | 좌측 사이드바 (240px) |
| Input.js | 텍스트 입력 (다음 주소검색 연동) |
| InputFile*.js | 파일 업로드 (이미지, 비디오, 다중) |
| InputDate/DateTime.js | 날짜/시간 선택기 |
| PageNation.js | 페이지네이션 |
| ChartCard.js | 차트 컨테이너 |
| Popup.js | 전역 모달 (Framer Motion) |
| TextArea.js | 리치 텍스트 에디터 (Toast UI Editor) |

## 환경 설정

```bash
# .env.dev / .env.prod
REACT_APP_ENV=dev|prod
REACT_APP_API_URL=https://api-dev.kiwee.co.kr  # 또는 api.kiwee.co.kr
```

## 스크립트

```bash
pnpm dev           # 개발 서버 실행 (.env.dev 복사 후)
pnpm build:dev     # 개발 빌드
pnpm build:prod    # 프로덕션 빌드
pnpm deploy:prod   # 빌드 + S3 배포 + CloudFront 무효화
pnpm deploy:dev    # 개발 환경 배포
```

## 특이사항

- **데스크톱 전용**: min-width 1900px (반응형 미지원)
- **가상 스크롤링**: React Virtuoso로 대용량 리스트 처리
- **엑셀 내보내기**: ExcelJS/XLSX로 데이터 엑셀 다운로드
- **QR 생성**: QRCode 라이브러리로 앨범 QR 코드 생성
- **3D 시각화**: Three.js + React Three Fiber (대시보드)
- **소켓**: Socket.io 클라이언트 존재하나 현재 비활성화
