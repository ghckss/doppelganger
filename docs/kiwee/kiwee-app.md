# kiwee-app - 모바일 앱 (iOS/Android)

> **저장소**: `~/workspace/kiwee-app`  
> **앱 이름**: `kiwee-album`  
> **번들 ID**: `com.knowmerce.kiwee`  
> **유형**: React Native (Expo) 하이브리드 앱

## 기술 스택

| 구분 | 기술 |
|------|------|
| 프레임워크 | React Native 0.76 + Expo 52 |
| 언어 | TypeScript 5.3 |
| 라우팅 | Expo Router 4.0 (파일 기반) |
| 상태 관리 | Zustand 5.0 (AsyncStorage 영속화) |
| WebView | react-native-webview 13.12 |
| 오디오 | react-native-track-player 4.1 |
| NFC | react-native-nfc-manager 3.16 |
| 카메라 | expo-camera 16.0 |
| 파일 시스템 | expo-file-system 18.0 |
| AWS | @aws-sdk/client-s3 3.750 |
| 애니메이션 | react-native-reanimated 3.16 |

## 핵심 역할

`kiwee-app`은 **WebView 래퍼 + 네이티브 기능 제공자**이다:

- `v2.kiwee.co.kr` (kiwee-web)을 WebView로 로드
- 네이티브 전용 기능 제공: QR/NFC 스캔, 오프라인 음악 재생, 파일 다운로드
- 네트워크 오프라인 시 자체 오프라인 플레이어 제공

## 프로젝트 구조

```
├── app/                          # Expo Router 페이지 (파일 기반 라우팅)
│   ├── _layout.tsx              # 루트 레이아웃 (NFC/딥링크 핸들러)
│   ├── index.tsx                # 메인 (온라인→WebView, 오프라인→네이티브 플레이어)
│   ├── camera.tsx               # QR 스캐너
│   ├── nfc.tsx                  # NFC 리더
│   ├── offline.tsx              # 오프라인 음악 플레이어
│   └── notification.click.tsx   # 알림 탭 핸들러
│
├── components/                   # UI 컴포넌트
│   ├── MainWebView.tsx          # WebView 래퍼 (메시지 브릿지)
│   ├── OfflineMusicPlayer.tsx   # 오프라인 플레이어 UI
│   ├── MusicCard.tsx            # 곡 리스트 아이템 (다국어)
│   ├── AlertModal.tsx           # 확인 다이얼로그
│   └── ResumeDownload.tsx       # 다운로드 재개 매니저
│
├── hooks/                        # 커스텀 훅
│   ├── useTrackPlayerEventHandlers.tsx  # 오디오 플레이어 이벤트
│   └── useSyncTrackPlayerWithWebView.tsx  # 네이티브↔웹 동기화
│
├── onMessageHandlers/            # WebView 메시지 핸들러
│   ├── index.ts                 # 메시지 라우터
│   ├── downloadMusicFiles.ts    # 다운로드 트리거
│   ├── onPlaylistUpdated.ts     # 플레이리스트 동기화
│   ├── onMediaStateChanged.ts   # 재생/일시정지
│   ├── onMediaTime.ts           # 재생 시간 동기화
│   ├── onSkip.ts                # 곡 건너뛰기
│   ├── scanQr.ts                # QR 스캔 네비게이션
│   ├── scanNfc.tsx              # NFC 스캔 네비게이션
│   ├── getLocation.ts           # 위치 조회
│   └── openBrowser.ts           # 외부 URL 열기
│
├── utils/                        # 유틸리티
│   ├── downloadManager.ts       # S3 파일 다운로드 (Presigned URL)
│   ├── downloadTaskManager.ts   # 다운로드 큐 관리 (JSON 영속화)
│   ├── fileListManager.ts       # 다운로드 파일 레지스트리
│   └── filesystemUtils.ts       # 파일 시스템 작업
│
├── types/                        # TypeScript 타입
│   ├── songInfo.ts              # 곡 메타데이터
│   ├── customTrack.ts           # 확장 트랙 (다국어)
│   └── multiLanguage.ts         # 다국어 타입
│
├── zustand/store.ts             # Zustand 스토어 (5개)
├── constants/                    # 상수 (Colors, FileSystem, Typos)
├── app.json                      # Expo 설정
└── eas.json                      # EAS 빌드 프로필
```

## 화면 구성

| 경로 | 파일 | 설명 |
|------|------|------|
| `/` | index.tsx | 메인: 온라인이면 WebView, 오프라인이면 네이티브 플레이어 |
| `/camera` | camera.tsx | QR 코드 스캐너 (expo-camera) |
| `/nfc` | nfc.tsx | NFC 태그 리더 (바텀 모달 UI) |
| `/offline` | offline.tsx | 오프라인 음악 플레이어 (파일 관리, 삭제) |
| `/notification.click` | notification.click.tsx | 푸시 알림 딥링크 |

## 상태 관리 (Zustand)

| 스토어 | 영속화 | 역할 |
|--------|--------|------|
| `useWebview` | X | WebView 인스턴스 참조 |
| `useRegionCode` | X | 언어 코드 (기본: "ko") |
| `useDownloadManager` | X | 다운로드 요청 큐, 남은 태스크 |
| `useTrackPlayer` | O (AsyncStorage) | 다운로드 파일 목록, 현재 재생, 반복 모드 |
| `usePlayList` | O (AsyncStorage) | 재생 큐 (활성/원본), 세션 ID |

## WebView 브릿지 프로토콜

### 메시지 구조
```typescript
// 요청 (Web → Native)
interface RequestMessage {
  code: SFuncName;    // 함수명
  message: string;    // JSON 페이로드
}

// 응답 (Native → Web)
interface ResponseMessage<T> {
  code: SFuncName;
  data: T;
}
```

### 지원 함수 (SFuncName)

| 코드 | 방향 | 동작 |
|------|------|------|
| `scanCodeQR` | Web→Native→Web | QR 스캐너 열고 결과 반환 |
| `scanCodeNFC` | Web→Native→Web | NFC 리더 열고 결과 반환 |
| `getLocation` | Web→Native→Web | GPS 위치 반환 |
| `openNewBrowser` | Web→Native | 외부 URL 열기 |
| `onDownload` | Web→Native | 음악 파일 다운로드 시작 |
| `onPlaylistUpdated` | 양방향 | 플레이리스트 동기화 |
| `onMediaStateChanged` | Web→Native | 재생 상태 변경 |
| `onMediaTime` | Web→Native | 재생 시간 동기화 |
| `onSkip` | Web→Native | 곡 건너뛰기 |
| `onRepeatUpdated` | Web→Native | 반복 모드 변경 |
| `onSyncState` | Native→Web | 앱 복귀 시 상태 동기화 |

## 오프라인 음악 시스템

### 다운로드 플로우
1. Web에서 `onDownload` 메시지 + `SongInfo[]` 전송
2. 각 곡에 대해 `POST /v1/media/file/downloadUrl` → Presigned URL 획득
3. `expo-file-system`으로 음악 파일 + 앨범 아트워크 다운로드
4. 메타데이터 → `play_list.json`에 저장
5. 다운로드 큐에서 제거 → `download_task_list.json` 갱신

### 로컬 저장 구조
```
DocumentDirectory/offline_music/
├── play_list.json              # 다운로드 곡 레지스트리
├── download_task_list.json     # 대기 중 다운로드 큐
├── [음악 파일들]               # *.mp3 등
└── [앨범 아트워크]             # *.jpg 등
```

### 오프라인 재생
- `react-native-track-player`로 네이티브 오디오 재생
- 로컬 파일 기반 재생 (인터넷 불필요)
- 재생/일시정지, 이전/다음, 프로그레스 바
- 파일 편집 모드 (선택, 삭제)

## 데이터 모델

### SongInfo
```typescript
interface SongInfo {
  album_idx: number;
  idx: number;
  localIdx: string;              // 고유 식별자
  title: MultiLanguage;          // { ko, en, cn, ja }
  artist: MultiLanguage;
  arrangement: MultiLanguage;
  composition: MultiLanguage;
  lyrics: MultiLanguage;
  filepath: string;              // 로컬 파일 경로
  photo: string;                 // 앨범 아트 경로
  play_time: string;             // "MM:SS"
  titleTrack: boolean;           // 타이틀곡 여부
  preSignedUrl?: string;         // S3 URL
  url?: string;                  // 스트리밍 URL
}

type MultiLanguage = { ko: string; en: string; cn: string; ja: string; }
```

## 네이티브 기능

| 기능 | 모듈 | 용도 |
|------|------|------|
| QR 스캔 | expo-camera | 앨범 카드 QR 코드 스캔 |
| NFC 읽기 | react-native-nfc-manager | 앨범 카드 NFC 태그 스캔 |
| 오디오 재생 | react-native-track-player | 네이티브 오디오 (큐잉, 백그라운드) |
| 파일 저장 | expo-file-system | 음악 파일 로컬 저장 |
| 네트워크 | expo-network | 온라인/오프라인 감지 |
| 백그라운드 | expo-background-fetch | 중단된 다운로드 재개 |
| 햅틱 | expo-haptics | 진동 피드백 |

### 플랫폼 권한
- **iOS**: 백그라운드 오디오 (`UIBackgroundModes: ["audio"]`)
- **Android**: CAMERA, RECORD_AUDIO, READ/WRITE_EXTERNAL_STORAGE, WAKE_LOCK

## 빌드 & 배포

### EAS 빌드 프로필 (eas.json)
| 프로필 | 용도 |
|--------|------|
| development | 개발 빌드 (디버그) |
| internal | 내부 테스트 APK |
| preview | 프리뷰 빌드 |
| production | 스토어 제출용 |
| adhoc | iOS Ad-hoc 배포 |

### 스크립트
```bash
npm start              # Expo 개발 서버
npm run android        # Android 실행
npm run ios            # iOS 실행
npm run build:android  # EAS Android 빌드 (internal APK)
npm run build:ios      # EAS iOS 빌드
npm test               # Jest 테스트
npm run lint           # ESLint
```

## 특이사항

- **WebView 디버깅 활성화**: `webviewDebuggingEnabled={true}` (개발/프로덕션 공통)
- **캐시 비활성화**: `cacheMode="LOAD_NO_CACHE"` (항상 최신 웹 로드)
- **커스텀 User-Agent**: `kiwee_device_{ios|android}` (웹 앱이 앱 모드 감지용)
- **타이포 주의**: `useDeepComapreEffect` (typo in filename)
- **JSON 기반 영속화**: SQLite 미사용, JSON 파일로 데이터 관리
- **다운로드 재개**: 앱 재시작 시 중단된 다운로드 자동 재개
- **디바운스 메시징**: WebView 통신에 디바운스 적용 (과도한 메시지 방지)
