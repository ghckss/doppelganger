# Kiwee Project - Overview

Kiwee는 **실물 음반 카드**를 QR/NFC로 스캔하여 디지털 음악 콘텐츠를 이용할 수 있는 음악 플랫폼이다.

## 저장소 구성

| 저장소 | 역할 | 기술 스택 | 배포 URL |
|--------|------|-----------|----------|
| `kiwee-admin` | 관리자 대시보드 | React (CRA), Zustand, MUI | `admin.kiwee.co.kr` |
| `kiwee-web` | 사용자 웹 프론트엔드 | React (Vite), TypeScript, Zustand | `v2.kiwee.co.kr` |
| `kiwee-app` | 모바일 앱 (iOS/Android) | React Native (Expo), TypeScript, Zustand | App Store / Play Store |

## 아키텍처 개요

```
┌─────────────────────────────────────────────────────────┐
│                    사용자 흐름                            │
│                                                         │
│  실물 앨범 카드 → QR/NFC 스캔 → 앨범 등록 → 음악 재생     │
└─────────────────────────────────────────────────────────┘

┌──────────────┐     WebView      ┌──────────────┐
│  kiwee-app   │ ◄──────────────► │  kiwee-web   │
│  (모바일 앱)  │   postMessage    │  (웹 프론트)   │
│              │   Bridge API     │              │
│ - QR/NFC 스캔│                  │ - 앨범 관리    │
│ - 오프라인 재생│                  │ - 플레이리스트  │
│ - 파일 다운로드│                  │ - 갤러리       │
└──────┬───────┘                  └──────┬───────┘
       │                                 │
       │         REST API (Axios)        │
       └────────────┬────────────────────┘
                    │
                    ▼
          ┌─────────────────┐
          │  Backend API     │
          │  api.kiwee.co.kr │
          │  (별도 저장소)    │
          └────────┬────────┘
                   │
          ┌────────┴────────┐
          │  AWS S3 / CDN   │
          │  CloudFront     │
          └─────────────────┘
                   ▲
                   │
          ┌────────┴────────┐
          │  kiwee-admin    │
          │  (관리자 대시보드) │
          │  admin.kiwee.co.kr│
          └─────────────────┘
```

## 공통 기술 요소

| 항목 | 내용 |
|------|------|
| **상태 관리** | 전 저장소 Zustand 사용 |
| **HTTP 클라이언트** | Axios (모든 요청 POST 방식) |
| **API 인증 헤더** | `scd` 헤더 (admin: `KIWEEADMINSCD`, web/app: `KIWEESCD`) |
| **인증 토큰** | JWT, localStorage에 저장, 모든 요청에 `authorization` 헤더로 전송 |
| **다국어** | 한국어(ko), 영어(en), 중국어(cn), 일본어(ja) 지원 |
| **배포** | AWS S3 + CloudFront, GitHub Actions CI/CD |
| **패키지 매니저** | pnpm |
| **암호화 스토리지** | CryptoJS AES로 localStorage 암호화 |

## Backend API

모든 프론트엔드가 공유하는 단일 백엔드:

| 환경 | URL |
|------|-----|
| Production | `https://api.kiwee.co.kr` |
| Development | `https://api-dev.kiwee.co.kr` |

## 문서 목록

- [kiwee-admin.md](./kiwee-admin.md) - 관리자 대시보드 상세 문서
- [kiwee-web.md](./kiwee-web.md) - 사용자 웹 프론트엔드 상세 문서
- [kiwee-app.md](./kiwee-app.md) - 모바일 앱 상세 문서
- [architecture.md](./architecture.md) - 시스템 아키텍처 및 저장소 간 연동
- [api-reference.md](./api-reference.md) - API 엔드포인트 레퍼런스
