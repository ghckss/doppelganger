import { useEffect, useMemo, useRef, useState } from 'react';

export type MeetingRecorderStatus = 'idle' | 'recording' | 'stopping' | 'error';

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
  return value.toLocaleTimeString('ko-KR', {
    hour12: false
  });
}

function renderCapturedTranscript(entries: CapturedEntry[]): string {
  return entries
    .map((entry) => `[${formatCapturedTime(entry.capturedAt)}] ${entry.text}`)
    .join('\n');
}

export function useMeetingRecorder({
  language = 'ko-KR',
  tickMs = 1000,
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
  const tickTimerRef = useRef<number | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const statusRef = useRef<MeetingRecorderStatus>('idle');
  const stoppingRef = useRef(false);
  const stopResolverRef = useRef<((value: MeetingStopResult) => void) | null>(null);
  const startedAtRef = useRef('');
  const finalLinesRef = useRef<string[]>([]);
  const interimLineRef = useRef('');
  const capturedEntriesRef = useRef<CapturedEntry[]>([]);
  const lastCapturedTextRef = useRef('');
  const retryCountRef = useRef(0);

  const [status, setStatus] = useState<MeetingRecorderStatus>('idle');
  const [error, setError] = useState('');
  const [startedAt, setStartedAt] = useState('');
  const [endedAt, setEndedAt] = useState('');
  const [snapshotTranscript, setSnapshotTranscript] = useState('');
  const [retryCount, setRetryCount] = useState(0);
  const [shouldAutoSummarize, setShouldAutoSummarize] = useState(false);

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

  function captureTranscriptLine(value: string, { allowDuplicate = false } = {}) {
    const normalized = normalizeLine(value);
    if (!normalized) {
      return;
    }
    if (!allowDuplicate && normalized === lastCapturedTextRef.current) {
      return;
    }

    capturedEntriesRef.current.push({
      capturedAt: nowIso(),
      text: normalized
    });
    lastCapturedTextRef.current = normalized;
    syncCapturedTranscriptState();
  }

  function stopTicker() {
    if (!tickTimerRef.current) {
      return;
    }
    window.clearInterval(tickTimerRef.current);
    tickTimerRef.current = null;
  }

  function startTicker() {
    stopTicker();
    tickTimerRef.current = window.setInterval(() => {
      captureTranscriptLine(interimLineRef.current);
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
    teardownRecognition();

    if (!preserveSession) {
      finalLinesRef.current = [];
      interimLineRef.current = '';
      capturedEntriesRef.current = [];
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
          captureTranscriptLine(transcript);
          continue;
        }
        interimLine = transcript;
      }
      interimLineRef.current = interimLine;
    };

    recognition.onerror = (event) => {
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
      resolveStop(finalizeStop());
    };

    recognition.onend = () => {
      if (stoppingRef.current) {
        const result = finalizeStop();
        teardownRecognition();
        stoppingRef.current = false;
        setStatus('idle');
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

    stoppingRef.current = false;
    finalLinesRef.current = [];
    interimLineRef.current = '';
    capturedEntriesRef.current = [];
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

    await startRecognitionSession({ preserveSession: false });
  }

  async function stop(): Promise<MeetingStopResult> {
    if (statusRef.current !== 'recording') {
      return null;
    }

    setStatus('stopping');
    stoppingRef.current = true;
    stopRetryTimer();

    const recognition = recognitionRef.current;
    if (!recognition) {
      const result = finalizeStop();
      setStatus('idle');
      stoppingRef.current = false;
      return result;
    }

    return new Promise((resolve) => {
      stopResolverRef.current = resolve;
      try {
        recognition.stop();
      } catch (caught) {
        const message = normalizeLine((caught as Error)?.message || '');
        setStatus('error');
        setError(message || '음성 인식을 중지하지 못했습니다.');
        stoppingRef.current = false;
        resolve(finalizeStop());
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
  }, []);

  return {
    isSupported: Boolean(constructorRef),
    status,
    error,
    startedAt,
    endedAt,
    transcript: snapshotTranscript,
    retryCount,
    maxResumeAttempts,
    shouldAutoSummarize,
    start,
    stop,
    resetSession,
    clearAutoSummarizeRequest: () => setShouldAutoSummarize(false)
  };
}
