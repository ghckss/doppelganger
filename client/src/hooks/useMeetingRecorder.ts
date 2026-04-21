import { useEffect, useMemo, useRef, useState } from 'react';

export type MeetingRecorderStatus = 'idle' | 'recording' | 'paused' | 'stopping' | 'error';

export type MeetingStopResult = {
  transcript: string;
  startedAt: string;
  endedAt: string;
} | null;

type MeetingRecorderOptions = {
  language?: string;
  tickMs?: number;
  maxResumeAttempts?: number;
  resumeDelayMs?: number;
};

type CapturedEntry = {
  capturedAt: string;
  text: string;
};

type StartAudioCaptureOptions = {
  preserveSession?: boolean;
};

function nowIso() {
  return new Date().toISOString();
}

function normalizeLine(value: string): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function mapRecognitionErrorMessage(errorCode: string): string {
  const reason = normalizeLine(errorCode).toLowerCase();
  if (reason === 'network') {
    return '네트워크 연결 문제로 음성 인식이 중단되었습니다. 인터넷/VPN/방화벽 설정을 확인한 뒤 다시 시도합니다.';
  }
  if (reason === 'not-allowed' || reason === 'service-not-allowed') {
    return '마이크 또는 음성 인식 권한이 거부되었습니다. 브라우저 권한 설정을 확인해 주세요.';
  }
  if (reason === 'audio-capture') {
    return '마이크 장치를 찾지 못했습니다. 입력 장치 연결 상태를 확인해 주세요.';
  }
  if (reason === 'no-speech') {
    return '음성이 감지되지 않았습니다. 마이크 입력 레벨을 확인해 주세요.';
  }
  if (!reason) {
    return '음성 인식 중 오류가 발생했습니다.';
  }
  return `음성 인식 오류: ${reason}`;
}

function mapAudioRecordingErrorMessage(error: unknown): string {
  const name = normalizeLine((error as { name?: string })?.name || '').toLowerCase();
  if (name === 'notallowederror' || name === 'securityerror') {
    return '녹음 권한이 거부되어 파일 저장용 녹음을 진행할 수 없습니다. 브라우저 마이크 권한을 허용해 주세요.';
  }
  if (name === 'notfounderror' || name === 'devicesnotfounderror') {
    return '녹음 장치를 찾을 수 없어 파일 저장용 녹음을 시작하지 못했습니다.';
  }
  if (name === 'notreadableerror') {
    return '마이크 장치를 현재 사용할 수 없어 파일 저장용 녹음을 시작하지 못했습니다.';
  }
  const message = normalizeLine((error as { message?: string })?.message || '');
  if (message) {
    return `녹음 파일 저장 기능 오류: ${message}`;
  }
  return '녹음 파일 저장 기능을 시작하지 못했습니다.';
}

function sanitizeIsoForFilename(value: string): string {
  const source = String(value || '');
  if (!source) {
    return '';
  }
  return source
    .replace(/[-:]/g, '')
    .replace(/\..*$/, '')
    .replace('T', '-')
    .trim();
}

function resolveAudioExtension(mimeType: string): string {
  const type = String(mimeType || '').toLowerCase();
  if (type.includes('ogg')) {
    return 'ogg';
  }
  if (type.includes('mp4') || type.includes('m4a')) {
    return 'm4a';
  }
  return 'webm';
}

function pickPreferredAudioMimeType(): string {
  if (typeof window === 'undefined' || typeof window.MediaRecorder === 'undefined') {
    return '';
  }
  if (typeof window.MediaRecorder.isTypeSupported !== 'function') {
    return '';
  }
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4'
  ];
  for (const candidate of candidates) {
    if (window.MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return '';
}

function composeTranscript(finalLines: string[], interimLine: string): string {
  const sections = [...finalLines];
  if (interimLine) {
    sections.push(interimLine);
  }
  return sections
    .map((line) => normalizeLine(line))
    .filter(Boolean)
    .join('\n');
}

function formatCapturedTime(isoString: string): string {
  const value = new Date(isoString);
  if (Number.isNaN(value.valueOf())) {
    return '';
  }
  const hour = String(value.getHours()).padStart(2, '0');
  const minute = String(value.getMinutes()).padStart(2, '0');
  const second = String(value.getSeconds()).padStart(2, '0');
  return `${hour}:${minute}:${second}`;
}

function renderCapturedTranscript(entries: CapturedEntry[]): string {
  return entries
    .map((entry) => `[${formatCapturedTime(entry.capturedAt)}] ${entry.text}`)
    .join('\n');
}

export function useMeetingRecorder({
  language = 'ko-KR',
  tickMs = 10000,
  maxResumeAttempts = 3,
  resumeDelayMs = 900
}: MeetingRecorderOptions = {}) {
  const constructorRef = useMemo(() => {
    if (typeof window === 'undefined') {
      return null;
    }
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }, []);

  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioMimeTypeRef = useRef('');
  const audioRecordingUrlRef = useRef('');
  const tickTimerRef = useRef<number | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const statusRef = useRef<MeetingRecorderStatus>('idle');
  const stoppingRef = useRef(false);
  const pauseRequestedRef = useRef(false);
  const stopResolverRef = useRef<((value: MeetingStopResult) => void) | null>(null);
  const startedAtRef = useRef('');
  const finalLinesRef = useRef<string[]>([]);
  const interimLineRef = useRef('');
  const capturedEntriesRef = useRef<CapturedEntry[]>([]);
  const pendingEntriesRef = useRef<CapturedEntry[]>([]);
  const lastCapturedTextRef = useRef('');
  const retryCountRef = useRef(0);

  const [status, setStatus] = useState<MeetingRecorderStatus>('idle');
  const [error, setError] = useState('');
  const [startedAt, setStartedAt] = useState('');
  const [endedAt, setEndedAt] = useState('');
  const [snapshotTranscript, setSnapshotTranscript] = useState('');
  const [audioError, setAudioError] = useState('');
  const [audioRecordingUrl, setAudioRecordingUrl] = useState('');
  const [audioFileName, setAudioFileName] = useState('');
  const [retryCount, setRetryCount] = useState(0);
  const [shouldAutoSummarize, setShouldAutoSummarize] = useState(false);
  const isAudioRecordingSupported = useMemo(() => {
    if (typeof window === 'undefined') {
      return false;
    }
    return Boolean(window.MediaRecorder && navigator?.mediaDevices?.getUserMedia);
  }, []);

  function setRetryCountState(value: number) {
    const normalized = Math.max(0, Math.trunc(Number(value) || 0));
    retryCountRef.current = normalized;
    setRetryCount(normalized);
  }

  function stopRetryTimer() {
    if (!retryTimerRef.current) {
      return;
    }
    window.clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
  }

  function resetRetryState() {
    stopRetryTimer();
    setRetryCountState(0);
  }

  function syncCapturedTranscriptState() {
    setSnapshotTranscript(renderCapturedTranscript(capturedEntriesRef.current));
  }

  function flushPendingTranscriptEntries() {
    if (pendingEntriesRef.current.length === 0) {
      return;
    }
    capturedEntriesRef.current = [...capturedEntriesRef.current, ...pendingEntriesRef.current];
    pendingEntriesRef.current = [];
    syncCapturedTranscriptState();
  }

  function captureTranscriptLine(value: string, { allowDuplicate = false } = {}) {
    const normalized = normalizeLine(value);
    if (!normalized) {
      return;
    }
    if (!allowDuplicate && normalized === lastCapturedTextRef.current) {
      return;
    }

    pendingEntriesRef.current.push({
      capturedAt: nowIso(),
      text: normalized
    });
    lastCapturedTextRef.current = normalized;
  }

  function stopTicker() {
    if (!tickTimerRef.current) {
      return;
    }
    window.clearInterval(tickTimerRef.current);
    tickTimerRef.current = null;
  }

  function updateAudioRecordingUrl(nextUrl: string) {
    if (audioRecordingUrlRef.current && audioRecordingUrlRef.current !== nextUrl) {
      URL.revokeObjectURL(audioRecordingUrlRef.current);
    }
    audioRecordingUrlRef.current = nextUrl;
    setAudioRecordingUrl(nextUrl);
  }

  function stopAudioTracks() {
    const stream = mediaStreamRef.current;
    if (!stream) {
      return;
    }
    for (const track of stream.getTracks()) {
      track.stop();
    }
    mediaStreamRef.current = null;
  }

  function teardownMediaRecorder() {
    const recorder = mediaRecorderRef.current;
    if (!recorder) {
      return;
    }
    recorder.ondataavailable = null;
    recorder.onstop = null;
    recorder.onerror = null;
    mediaRecorderRef.current = null;
  }

  function finalizeAudioRecording() {
    if (audioChunksRef.current.length === 0) {
      return;
    }

    const mimeType = audioMimeTypeRef.current || 'audio/webm';
    const blob = new Blob(audioChunksRef.current, {
      type: mimeType
    });
    if (!blob.size) {
      return;
    }

    const objectUrl = URL.createObjectURL(blob);
    const baseTimestamp = sanitizeIsoForFilename(startedAtRef.current) || sanitizeIsoForFilename(nowIso());
    const extension = resolveAudioExtension(mimeType);
    updateAudioRecordingUrl(objectUrl);
    setAudioFileName(`meeting-recording-${baseTimestamp}.${extension}`);
  }

  async function stopAudioCapture() {
    const recorder = mediaRecorderRef.current;
    if (!recorder) {
      stopAudioTracks();
      return;
    }

    if (recorder.state === 'inactive') {
      finalizeAudioRecording();
      teardownMediaRecorder();
      stopAudioTracks();
      return;
    }

    await new Promise<void>((resolve) => {
      const handleStop = () => {
        recorder.removeEventListener('stop', handleStop);
        resolve();
      };
      recorder.addEventListener('stop', handleStop, { once: true });
      try {
        recorder.stop();
      } catch {
        recorder.removeEventListener('stop', handleStop);
        resolve();
      }
    });
  }

  function pauseAudioCapture() {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== 'recording') {
      return;
    }
    try {
      recorder.pause();
    } catch {
      // Ignore pause errors from unsupported recorder states.
    }
  }

  function resumeAudioCapture() {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state !== 'paused') {
      return;
    }
    try {
      recorder.resume();
    } catch {
      // Ignore resume errors from unsupported recorder states.
    }
  }

  async function startAudioCapture({ preserveSession = false }: StartAudioCaptureOptions = {}) {
    if (!isAudioRecordingSupported) {
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      return;
    }

    if (!preserveSession) {
      audioChunksRef.current = [];
      audioMimeTypeRef.current = '';
      setAudioFileName('');
      updateAudioRecordingUrl('');
      setAudioError('');
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const preferredMimeType = pickPreferredAudioMimeType();
      const recorder = preferredMimeType
        ? new MediaRecorder(stream, { mimeType: preferredMimeType })
        : new MediaRecorder(stream);

      audioMimeTypeRef.current = recorder.mimeType || preferredMimeType || 'audio/webm';
      recorder.ondataavailable = (event: BlobEvent) => {
        if (!event.data || event.data.size <= 0) {
          return;
        }
        audioChunksRef.current.push(event.data);
      };
      recorder.onerror = (event: Event) => {
        const message = normalizeLine((event as { error?: { message?: string } })?.error?.message || '');
        setAudioError(message ? `녹음 중 오류가 발생했습니다: ${message}` : '녹음 중 오류가 발생했습니다.');
      };
      recorder.onstop = () => {
        finalizeAudioRecording();
        teardownMediaRecorder();
        stopAudioTracks();
      };

      mediaRecorderRef.current = recorder;
      recorder.start();
    } catch (error) {
      setAudioError(mapAudioRecordingErrorMessage(error));
      stopAudioTracks();
    }
  }

  function resetAudioCaptureState() {
    const recorder = mediaRecorderRef.current;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      try {
        if (recorder.state !== 'inactive') {
          recorder.stop();
        }
      } catch {
        // Ignore stop errors while clearing session.
      }
    }
    mediaRecorderRef.current = null;
    stopAudioTracks();
    audioChunksRef.current = [];
    audioMimeTypeRef.current = '';
    setAudioFileName('');
    updateAudioRecordingUrl('');
    setAudioError('');
  }

  function startTicker() {
    stopTicker();
    tickTimerRef.current = window.setInterval(() => {
      captureTranscriptLine(interimLineRef.current);
      flushPendingTranscriptEntries();
    }, Math.max(200, tickMs));
  }

  function teardownRecognition() {
    const recognition = recognitionRef.current;
    if (!recognition) {
      return;
    }
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    recognitionRef.current = null;
  }

  function resolveStop(value: MeetingStopResult) {
    if (!stopResolverRef.current) {
      return;
    }
    const resolve = stopResolverRef.current;
    stopResolverRef.current = null;
    resolve(value);
  }

  function finalizeStop() {
    stopTicker();
    stopRetryTimer();
    captureTranscriptLine(interimLineRef.current);
    flushPendingTranscriptEntries();

    const composedTranscript = composeTranscript(finalLinesRef.current, interimLineRef.current);
    let finalTranscript = capturedEntriesRef.current
      .map((entry) => normalizeLine(entry.text))
      .filter(Boolean)
      .join('\n')
      .trim();

    if (!finalTranscript && composedTranscript) {
      const lines = composedTranscript
        .split('\n')
        .map((line) => normalizeLine(line))
        .filter(Boolean);
      capturedEntriesRef.current = lines.map((line) => ({
        capturedAt: nowIso(),
        text: line
      }));
      pendingEntriesRef.current = [];
      lastCapturedTextRef.current = lines.length > 0 ? lines[lines.length - 1] : '';
      finalTranscript = composedTranscript;
      syncCapturedTranscriptState();
    }

    const endedAtIso = nowIso();
    if (!capturedEntriesRef.current.length) {
      setSnapshotTranscript(finalTranscript);
    }
    setEndedAt(endedAtIso);
    return {
      transcript: finalTranscript,
      startedAt: startedAtRef.current,
      endedAt: endedAtIso
    };
  }

  function scheduleResumeAttempt(message: string) {
    const attempt = retryCountRef.current + 1;
    if (attempt > maxResumeAttempts) {
      return false;
    }

    setRetryCountState(attempt);
    setStatus('recording');
    setError(`${message} 연결 재개 시도 ${attempt}/${maxResumeAttempts}`);
    stopRetryTimer();
    retryTimerRef.current = window.setTimeout(() => {
      void startRecognitionSession({ preserveSession: true });
    }, Math.max(300, resumeDelayMs));
    return true;
  }

  async function startRecognitionSession({ preserveSession = false } = {}) {
    if (!constructorRef) {
      setStatus('error');
      setError('이 브라우저는 음성 인식을 지원하지 않습니다.');
      return;
    }

    stopRetryTimer();
    stopResolverRef.current = null;
    pauseRequestedRef.current = false;
    teardownRecognition();

    if (!preserveSession) {
      finalLinesRef.current = [];
      interimLineRef.current = '';
      capturedEntriesRef.current = [];
      pendingEntriesRef.current = [];
      lastCapturedTextRef.current = '';
      startedAtRef.current = '';
      setStartedAt('');
      setEndedAt('');
      setSnapshotTranscript('');
      resetRetryState();
      setShouldAutoSummarize(false);
    }

    const recognition = new constructorRef();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = language;

    recognition.onresult = (event) => {
      let interimLine = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const transcript = normalizeLine(event.results[index]?.[0]?.transcript || '');
        if (!transcript) {
          continue;
        }
        if (event.results[index].isFinal) {
          finalLinesRef.current.push(transcript);
          captureTranscriptLine(transcript, { allowDuplicate: true });
          continue;
        }
        interimLine = transcript;
      }
      interimLineRef.current = interimLine;
    };

    recognition.onerror = (event) => {
      if (pauseRequestedRef.current) {
        return;
      }
      if (stoppingRef.current) {
        return;
      }

      teardownRecognition();
      const message = mapRecognitionErrorMessage(String(event?.error || ''));
      if (scheduleResumeAttempt(message)) {
        return;
      }

      setStatus('error');
      setError(`${message} 연결 재개 시도 ${maxResumeAttempts}회 실패로 지금까지 기록한 내용으로 정리를 진행합니다.`);
      setShouldAutoSummarize(true);
      stoppingRef.current = false;
      void stopAudioCapture();
      resolveStop(finalizeStop());
    };

    recognition.onend = () => {
      if (pauseRequestedRef.current) {
        captureTranscriptLine(interimLineRef.current);
        flushPendingTranscriptEntries();
        teardownRecognition();
        pauseRequestedRef.current = false;
        stopTicker();
        stopRetryTimer();
        setStatus('paused');
        setError('');
        return;
      }

      if (stoppingRef.current) {
        const result = finalizeStop();
        teardownRecognition();
        stoppingRef.current = false;
        setStatus('idle');
        void stopAudioCapture();
        resolveStop(result);
        return;
      }

      if (statusRef.current === 'recording') {
        teardownRecognition();
        const message = '음성 인식 연결이 중간에 종료되었습니다.';
        if (scheduleResumeAttempt(message)) {
          return;
        }
        setStatus('error');
        setError(`${message} 연결 재개 시도 ${maxResumeAttempts}회 실패로 지금까지 기록한 내용으로 정리를 진행합니다.`);
        setShouldAutoSummarize(true);
        void stopAudioCapture();
        resolveStop(finalizeStop());
      }
    };

    recognitionRef.current = recognition;
    if (!startedAtRef.current) {
      const startedAtIso = nowIso();
      startedAtRef.current = startedAtIso;
      setStartedAt(startedAtIso);
    }

    setStatus('recording');
    startTicker();
    try {
      recognition.start();
      setError('');
      if (preserveSession && retryCountRef.current > 0) {
        setRetryCountState(0);
      }
    } catch (caught) {
      teardownRecognition();
      const message = normalizeLine((caught as Error)?.message || '') || '음성 인식을 시작하지 못했습니다.';
      if (scheduleResumeAttempt(message)) {
        return;
      }
      stopTicker();
      setStatus('error');
      setError(`${message} 연결 재개 시도 ${maxResumeAttempts}회 실패로 지금까지 기록한 내용으로 정리를 진행합니다.`);
      setShouldAutoSummarize(true);
      void stopAudioCapture();
      resolveStop(finalizeStop());
    }
  }

  function resetSession() {
    stopTicker();
    stopRetryTimer();
    stopResolverRef.current = null;

    const currentRecognition = recognitionRef.current;
    teardownRecognition();
    if (currentRecognition) {
      try {
        currentRecognition.abort();
      } catch {
        // Ignore abort errors during cleanup.
      }
    }

    resetAudioCaptureState();

    stoppingRef.current = false;
    pauseRequestedRef.current = false;
    finalLinesRef.current = [];
    interimLineRef.current = '';
    capturedEntriesRef.current = [];
    pendingEntriesRef.current = [];
    lastCapturedTextRef.current = '';
    startedAtRef.current = '';
    setStartedAt('');
    setEndedAt('');
    setSnapshotTranscript('');
    setError('');
    setShouldAutoSummarize(false);
    resetRetryState();
    setStatus('idle');
  }

  async function start() {
    if (!constructorRef) {
      setStatus('error');
      setError('이 브라우저는 음성 인식을 지원하지 않습니다.');
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setStatus('error');
      setError('인터넷 연결이 없어 음성 인식을 시작할 수 없습니다. 연결 후 다시 시작해 주세요.');
      return;
    }

    await startAudioCapture({ preserveSession: false });
    await startRecognitionSession({ preserveSession: false });
    if (statusRef.current !== 'recording') {
      await stopAudioCapture();
    }
  }

  async function stop(): Promise<MeetingStopResult> {
    if (statusRef.current !== 'recording' && statusRef.current !== 'paused') {
      return null;
    }

    if (statusRef.current === 'paused') {
      pauseRequestedRef.current = false;
      stopRetryTimer();
      const result = finalizeStop();
      setStatus('idle');
      await stopAudioCapture();
      return result;
    }

    setStatus('stopping');
    stoppingRef.current = true;
    stopRetryTimer();

    const recognition = recognitionRef.current;
    if (!recognition) {
      const result = finalizeStop();
      setStatus('idle');
      stoppingRef.current = false;
      await stopAudioCapture();
      return result;
    }

    return new Promise((resolve) => {
      stopResolverRef.current = (result) => {
        void stopAudioCapture().finally(() => {
          resolve(result);
        });
      };
      try {
        recognition.stop();
      } catch (caught) {
        const message = normalizeLine((caught as Error)?.message || '');
        setStatus('error');
        setError(message || '음성 인식을 중지하지 못했습니다.');
        stoppingRef.current = false;
        const result = finalizeStop();
        void stopAudioCapture().finally(() => {
          resolve(result);
        });
      }

      window.setTimeout(() => {
        if (!stopResolverRef.current) {
          return;
        }
        stoppingRef.current = false;
        setStatus('idle');
        resolveStop(finalizeStop());
      }, 3000);
    });
  }

  async function pause() {
    if (statusRef.current !== 'recording') {
      return;
    }

    pauseRequestedRef.current = true;
    stopRetryTimer();
    stopTicker();
    setStatus('paused');
    pauseAudioCapture();

    const recognition = recognitionRef.current;
    if (!recognition) {
      captureTranscriptLine(interimLineRef.current);
      flushPendingTranscriptEntries();
      return;
    }

    try {
      recognition.stop();
    } catch (caught) {
      pauseRequestedRef.current = false;
      const message = normalizeLine((caught as Error)?.message || '');
      setStatus('error');
      setError(message || '음성 인식을 일시정지하지 못했습니다.');
    }
  }

  async function resume() {
    if (statusRef.current !== 'paused') {
      return;
    }
    setError('');
    await startRecognitionSession({ preserveSession: true });
    resumeAudioCapture();
  }

  function downloadAudioRecording(): boolean {
    if (!audioRecordingUrl || !audioFileName || typeof document === 'undefined') {
      return false;
    }
    const anchor = document.createElement('a');
    anchor.href = audioRecordingUrl;
    anchor.download = audioFileName;
    anchor.rel = 'noopener';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    return true;
  }

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => () => {
    stopTicker();
    stopRetryTimer();
    stopResolverRef.current = null;
    const currentRecognition = recognitionRef.current;
    teardownRecognition();
    if (currentRecognition) {
      try {
        currentRecognition.abort();
      } catch {
        // Ignore abort errors during cleanup.
      }
    }
    resetAudioCaptureState();
    if (audioRecordingUrlRef.current) {
      URL.revokeObjectURL(audioRecordingUrlRef.current);
      audioRecordingUrlRef.current = '';
    }
  }, []);

  return {
    isSupported: Boolean(constructorRef),
    status,
    error,
    startedAt,
    endedAt,
    transcript: snapshotTranscript,
    audioError,
    audioRecordingUrl,
    audioFileName,
    hasAudioRecording: Boolean(audioRecordingUrl && audioFileName),
    isAudioRecordingSupported,
    retryCount,
    maxResumeAttempts,
    shouldAutoSummarize,
    downloadAudioRecording,
    start,
    pause,
    resume,
    stop,
    resetSession,
    clearAutoSummarizeRequest: () => setShouldAutoSummarize(false)
  };
}
