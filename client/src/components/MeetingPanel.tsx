import { useEffect, useRef, useState } from 'react';
import { summarizeMeeting } from '../api';
import { useMeetingRecorder } from '../hooks/useMeetingRecorder';
import type { CollapsibleSectionId, CollapsibleState } from '../task-view';
import { formatDateTime } from '../task-view';
import {
  BUTTON_CLASS,
  EMPTY_CLASS,
  PANEL_CLASS,
  SECTION_COUNT_CLASS,
  SECTION_HEADER_CLASS,
  SUB_BUTTON_CLASS
} from './common';

type MeetingPanelProps = {
  collapsedSections: CollapsibleState;
  onToggleSection: (sectionId: CollapsibleSectionId) => void;
};

type SummaryStatus = 'idle' | 'loading' | 'done' | 'error';

function mapRecorderStatusLabel(value: string): string {
  if (value === 'recording') return '녹음 중';
  if (value === 'paused') return '일시정지';
  if (value === 'stopping') return '종료 중';
  if (value === 'error') return '오류';
  return '대기';
}

export function MeetingPanel({ collapsedSections, onToggleSection }: MeetingPanelProps) {
  const recorder = useMeetingRecorder({
    language: 'ko-KR',
    tickMs: 10000
  });
  const [summaryStatus, setSummaryStatus] = useState<SummaryStatus>('idle');
  const [summary, setSummary] = useState('');
  const [polishedTranscript, setPolishedTranscript] = useState('');
  const [documentText, setDocumentText] = useState('');
  const [summaryError, setSummaryError] = useState('');
  const [transcriptCopyNotice, setTranscriptCopyNotice] = useState('');
  const [documentCopyNotice, setDocumentCopyNotice] = useState('');
  const autoSummaryTriggeredRef = useRef(false);
  const transcriptScrollRef = useRef<HTMLPreElement | null>(null);
  const [isTranscriptPinnedToBottom, setIsTranscriptPinnedToBottom] = useState(true);

  async function summarizeFromTranscript({
    transcript,
    startedAt,
    endedAt
  }: {
    transcript: string;
    startedAt: string;
    endedAt: string;
  }) {
    const normalizedTranscript = String(transcript || '').trim();
    if (!normalizedTranscript) {
      setSummaryStatus('error');
      setSummary('');
      setDocumentText('');
      setSummaryError('전사된 회의 내용이 없어 문서를 생성하지 못했습니다.');
      return;
    }

    setSummaryStatus('loading');
    setSummaryError('');
    try {
      const response = await summarizeMeeting({
        transcript: normalizedTranscript,
        startedAt: startedAt || recorder.startedAt || '',
        endedAt: endedAt || recorder.endedAt || '',
        language: 'ko-KR'
      });
      setPolishedTranscript(String(response.polishedTranscript || '').trim());
      setSummary(response.summary || '');
      setDocumentText(response.document || '');
      setSummaryStatus('done');
    } catch (caught) {
      const message = String((caught as Error)?.message || '').trim();
      setSummaryStatus('error');
      setSummary('');
      setDocumentText('');
      setSummaryError(message || '회의 정리 문서를 생성하지 못했습니다.');
    }
  }

  async function handleStart() {
    setSummaryStatus('idle');
    setSummary('');
    setPolishedTranscript('');
    setDocumentText('');
    setSummaryError('');
    setTranscriptCopyNotice('');
    setDocumentCopyNotice('');
    setIsTranscriptPinnedToBottom(true);
    autoSummaryTriggeredRef.current = false;
    recorder.resetSession();
    await recorder.start();
  }

  async function handlePause() {
    await recorder.pause();
  }

  async function handleResume() {
    await recorder.resume();
  }

  async function handleStopAndSummarize() {
    setTranscriptCopyNotice('');
    setDocumentCopyNotice('');
    const result = await recorder.stop();
    await summarizeFromTranscript({
      transcript: String(result?.transcript || ''),
      startedAt: result?.startedAt || recorder.startedAt || '',
      endedAt: result?.endedAt || recorder.endedAt || ''
    });
  }

  async function handleCopyTranscript() {
    const text = String(transcriptDisplayText || '').trim();
    if (!text) {
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setTranscriptCopyNotice('전사 내용을 클립보드에 복사했습니다.');
    } catch {
      setTranscriptCopyNotice('복사에 실패했습니다. 브라우저 권한을 확인해 주세요.');
    }
  }

  async function handleCopyDocument() {
    if (!documentText.trim()) {
      return;
    }
    try {
      await navigator.clipboard.writeText(documentText);
      setDocumentCopyNotice('문서를 클립보드에 복사했습니다.');
    } catch {
      setDocumentCopyNotice('복사에 실패했습니다. 브라우저 권한을 확인해 주세요.');
    }
  }

  useEffect(() => {
    if (!recorder.shouldAutoSummarize) {
      return;
    }
    if (summaryStatus === 'loading') {
      return;
    }
    if (autoSummaryTriggeredRef.current) {
      return;
    }

    autoSummaryTriggeredRef.current = true;
    void summarizeFromTranscript({
      transcript: recorder.transcript || '',
      startedAt: recorder.startedAt || '',
      endedAt: recorder.endedAt || new Date().toISOString()
    }).finally(() => {
      recorder.clearAutoSummarizeRequest();
    });
  }, [
    recorder,
    summaryStatus
  ]);

  const transcriptText = recorder.transcript || '';
  const transcriptDisplayText = polishedTranscript || transcriptText;
  const isRecording = recorder.status === 'recording';
  const canStart = recorder.isSupported && !['recording', 'paused', 'stopping'].includes(recorder.status);
  const canPause = recorder.status === 'recording';
  const canResume = recorder.status === 'paused';
  const canStop = recorder.status === 'recording' || recorder.status === 'paused';

  function updateTranscriptPinnedState(element: HTMLPreElement) {
    const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    setIsTranscriptPinnedToBottom(distanceToBottom <= 20);
  }

  function handleTranscriptScroll() {
    const element = transcriptScrollRef.current;
    if (!element) {
      return;
    }
    updateTranscriptPinnedState(element);
  }

  function scrollTranscriptToBottom() {
    const element = transcriptScrollRef.current;
    if (!element) {
      return;
    }
    element.scrollTop = element.scrollHeight;
    setIsTranscriptPinnedToBottom(true);
  }

  useEffect(() => {
    if (collapsedSections.meeting_transcript) {
      return;
    }
    if (!isTranscriptPinnedToBottom) {
      return;
    }
    const element = transcriptScrollRef.current;
    if (!element) {
      return;
    }
    element.scrollTop = element.scrollHeight;
  }, [collapsedSections.meeting_transcript, isTranscriptPinnedToBottom, transcriptDisplayText]);

  return (
    <section className={`${PANEL_CLASS} border-indigo-200 bg-indigo-50/70`}>
      <div className={`${SECTION_HEADER_CLASS} border-indigo-200 bg-indigo-100/70`}>
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold text-slate-800">회의 기록</h2>
          <span className={`${SECTION_COUNT_CLASS} border-indigo-200`}>한국어</span>
        </div>
        <button type="button" className={SUB_BUTTON_CLASS} onClick={() => onToggleSection('panel_meeting')}>
          {collapsedSections.panel_meeting ? '펼치기' : '접기'}
        </button>
      </div>

      {!collapsedSections.panel_meeting && (
        <div className="grid gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={BUTTON_CLASS} onClick={() => void handleStart()} disabled={!canStart}>
              시작
            </button>
            <button type="button" className={BUTTON_CLASS} onClick={() => void handlePause()} disabled={!canPause}>
              일시정지
            </button>
            <button type="button" className={BUTTON_CLASS} onClick={() => void handleResume()} disabled={!canResume}>
              재개
            </button>
            <button type="button" className={BUTTON_CLASS} onClick={() => void handleStopAndSummarize()} disabled={!canStop}>
              중지
            </button>
            <span className="text-sm text-slate-600">
              상태: <strong>{mapRecorderStatusLabel(recorder.status)}</strong>
            </span>
            {isRecording && <span className="text-xs text-indigo-700">실시간 갱신: 10초</span>}
            {recorder.retryCount > 0 && (
              <span className="text-xs text-amber-700">
                연결 재개 시도: {recorder.retryCount}/{recorder.maxResumeAttempts}
              </span>
            )}
          </div>

          {!recorder.isSupported && (
            <p className="text-sm text-rose-700">
              이 브라우저는 음성 인식을 지원하지 않습니다. Chrome 계열 브라우저를 사용해 주세요.
            </p>
          )}
          {recorder.error && <p className="text-sm text-rose-700">{recorder.error}</p>}
          {recorder.startedAt && (
            <p className="text-xs text-slate-600">
              시작: {formatDateTime(recorder.startedAt)}
              {recorder.endedAt ? ` · 종료: ${formatDateTime(recorder.endedAt)}` : ''}
            </p>
          )}

          <section className="grid gap-2 border-t border-dashed border-slate-300 pt-4">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-sm font-semibold text-slate-900">실시간 전사</h4>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className={SUB_BUTTON_CLASS}
                  onClick={() => void handleCopyTranscript()}
                  disabled={!transcriptDisplayText.trim()}
                >
                  전사 복사
                </button>
                <button type="button" className={SUB_BUTTON_CLASS} onClick={() => onToggleSection('meeting_transcript')}>
                  {collapsedSections.meeting_transcript ? '펼치기' : '접기'}
                </button>
              </div>
            </div>
            {!collapsedSections.meeting_transcript && (
              transcriptDisplayText
                ? (
                  <>
                    <div className="relative">
                      <pre
                        ref={transcriptScrollRef}
                        onScroll={handleTranscriptScroll}
                        className="m-0 min-h-40 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-slate-200 bg-white p-3 pr-12 text-sm text-slate-700"
                      >
                        {transcriptDisplayText}
                      </pre>
                      {!isTranscriptPinnedToBottom && (
                        <button
                          type="button"
                          className="absolute bottom-2 right-2 rounded-full border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 shadow-sm transition hover:bg-slate-100"
                          onClick={scrollTranscriptToBottom}
                          aria-label="실시간 전사 맨 아래로 이동"
                        >
                          ↓
                        </button>
                      )}
                    </div>
                    {transcriptCopyNotice && <p className="text-xs text-slate-600">{transcriptCopyNotice}</p>}
                  </>
                )
                : <p className={EMPTY_CLASS}>`시작`을 누르면 10초 단위로 전사 내용이 표시됩니다.</p>
            )}
          </section>

          <section className="grid gap-2 border-t border-dashed border-slate-300 pt-4">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-sm font-semibold text-slate-900">Confluence 문서 초안</h4>
              <button type="button" className={SUB_BUTTON_CLASS} onClick={() => onToggleSection('meeting_document')}>
                {collapsedSections.meeting_document ? '펼치기' : '접기'}
              </button>
            </div>

            {!collapsedSections.meeting_document && (
              <>
                {summaryStatus === 'loading' && <p className="text-sm text-slate-600">회의 내용을 분석해 문서를 생성하는 중입니다…</p>}
                {summaryStatus === 'error' && <p className="text-sm text-rose-700">{summaryError || '문서 생성 중 오류가 발생했습니다.'}</p>}
                {summary && <p className="text-sm text-slate-700">{summary}</p>}
                {documentText
                  ? (
                    <>
                      <pre className="m-0 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-700">{documentText}</pre>
                      <div className="flex items-center gap-2">
                        <button type="button" className={BUTTON_CLASS} onClick={() => void handleCopyDocument()}>
                          문서 복사
                        </button>
                        {documentCopyNotice && <span className="text-xs text-slate-600">{documentCopyNotice}</span>}
                      </div>
                    </>
                  )
                  : summaryStatus !== 'loading' && <p className={EMPTY_CLASS}>중지 후 자동으로 Confluence 붙여넣기용 문서를 생성합니다.</p>}
              </>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
