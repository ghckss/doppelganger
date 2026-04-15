import { startTransition, type ReactNode, useEffect, useState } from 'react';
import {
  approveTask,
  createCodeTask,
  createPullRequest,
  fetchMeta,
  fetchTaskDetail,
  fetchTasks,
  generateDraft,
  ignoreTask,
  pollGitHubReviews,
  pollSlackMentions,
  runTask,
  saveDraft,
  sendTask,
  startCodeReview
} from './api';
import type { MetaResponse, Task, TaskDetail, TaskDomainCatalog, TaskListResponse } from './types';

const STATUS_LABELS: Record<string, string> = {
  new: '신규',
  drafted: '초안 작성됨',
  awaiting_approval: '승인 대기',
  approved: '승인됨',
  pending: '대기',
  rejected: '거절됨',
  ignored: '무시됨',
  done: '완료',
  failed: '실패',
  running: '실행 중'
};

const DOMAIN_LABELS: Record<string, string> = {
  slack_mention: 'Slack 멘션',
  github_review: 'GitHub 리뷰',
  code_execution: '코드 작업'
};

const DOMAIN_IDS = ['slack_mention', 'github_review', 'code_execution'] as const;

type DomainId = (typeof DOMAIN_IDS)[number];

type CodeReviewStatus = {
  analysisStatus: string;
  progressStep: number;
  progressTotalSteps: number;
  progressPercent: number;
  progressLabel: string;
};

type ExecutionProgress = {
  phase: string;
  label: string;
  currentStep: number;
  totalSteps: number;
  percent: number;
  reviewRound: number;
  reviewTotalRounds: number;
};

type DraftEditorState = {
  content: string;
  summary: string;
  sendMode: string;
  reactionName: string;
};

type CollapsibleSectionId =
  | 'panel_slack'
  | 'panel_github'
  | 'panel_code'
  | 'slack_analysis'
  | 'slack_draft'
  | 'slack_artifacts'
  | 'github_draft'
  | 'code_create'
  | 'code_tasks';

type CollapsibleState = Record<CollapsibleSectionId, boolean>;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asText(value: unknown, fallback = ''): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === null || value === undefined) {
    return fallback;
  }
  return String(value);
}

function asNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return numeric;
}

function getCodeReviewStatus(task: Task): CodeReviewStatus | null {
  const codeReview = asRecord(asRecord(task.payload).codeReview);
  if (Object.keys(codeReview).length === 0) {
    return null;
  }

  return {
    analysisStatus: asText(codeReview.analysisStatus),
    progressStep: asNumber(codeReview.progressStep),
    progressTotalSteps: asNumber(codeReview.progressTotalSteps),
    progressPercent: asNumber(codeReview.progressPercent),
    progressLabel: asText(codeReview.progressLabel)
  };
}

function getExecutionProgress(task: Task): ExecutionProgress | null {
  const progress = asRecord(asRecord(task.result).executionProgress);
  if (Object.keys(progress).length === 0) {
    return null;
  }

  return {
    phase: asText(progress.phase),
    label: asText(progress.label),
    currentStep: asNumber(progress.currentStep),
    totalSteps: asNumber(progress.totalSteps),
    percent: asNumber(progress.percent),
    reviewRound: asNumber(progress.reviewRound),
    reviewTotalRounds: asNumber(progress.reviewTotalRounds)
  };
}

function formatDateTime(value: string): string {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(date);
}

function mapDomainLabel(domain: string): string {
  return DOMAIN_LABELS[domain] || domain;
}

function mapStatusLabel(status: string): string {
  return STATUS_LABELS[status] || status;
}

function mapCodeReviewStatus(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === 'not_requested') return '실행 대기';
  if (normalized === 'running') return '실행 중';
  if (normalized === 'completed') return '완료';
  if (normalized === 'failed') return '실패';
  return status || '-';
}

const INPUT_CLASS = 'mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200';
const BUTTON_CLASS = 'inline-flex items-center justify-center rounded-xl border border-transparent bg-emerald-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50';
const SUB_BUTTON_CLASS = 'inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 ';
const BADGE_BASE_CLASS = 'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium';
const EMOJI_PRESET_OPTIONS = [
  { name: 'eyes', glyph: '👀' },
  { name: 'thumbsup', glyph: '👍' },
  { name: 'white_check_mark', glyph: '✅' },
  { name: 'rocket', glyph: '🚀' },
  { name: 'pray', glyph: '🙏' }
] as const;

const EMOJI_GLYPH_BY_NAME: Record<string, string> = EMOJI_PRESET_OPTIONS.reduce((accumulator, option) => {
  accumulator[option.name] = option.glyph;
  return accumulator;
}, {} as Record<string, string>);

function normalizeReactionName(value: string): string {
  return String(value || '')
    .trim()
    .replace(/^:+/, '')
    .replace(/:+$/, '');
}

function resolveReactionGlyph(name: string): string {
  const normalized = normalizeReactionName(name).toLowerCase();
  if (!normalized) {
    return '';
  }
  return EMOJI_GLYPH_BY_NAME[normalized] || '';
}

function statusBadgeTone(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === 'running') return 'border-emerald-200 bg-emerald-50 text-emerald-800';
  if (normalized === 'failed') return 'border-rose-200 bg-rose-50 text-rose-800';
  if (normalized === 'done') return 'border-green-200 bg-green-50 text-green-800';
  if (normalized === 'approved') return 'border-green-200 bg-green-50 text-green-800';
  if (normalized === 'awaiting_approval') return 'border-amber-200 bg-amber-50 text-amber-800';
  if (normalized === 'ignored') return 'border-slate-200 bg-slate-100 text-slate-700';
  if (normalized === 'pending') return 'border-slate-200 bg-slate-100 text-slate-700';
  return 'border-slate-200 bg-slate-100 text-slate-700';
}

function renderStatusBadge(status: string, label: string): ReactNode {
  return (
    <span className={`${BADGE_BASE_CLASS} ${statusBadgeTone(status)}`}>
      {label}
    </span>
  );
}

function DomainBadge({ label }: { label: string }) {
  return (
    <span className={`${BADGE_BASE_CLASS} border-amber-200 bg-amber-50 text-amber-800`}>
      {label}
    </span>
  );
}

function ProgressBar({ percent }: { percent: number }) {
  const safePercent = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
      <div className="h-full rounded-full bg-emerald-500 transition-all duration-300" style={{ width: `${safePercent}%` }} />
    </div>
  );
}

function findDomain(catalog: TaskDomainCatalog[] | undefined, domainId: string): TaskDomainCatalog | null {
  if (!catalog) {
    return null;
  }
  return catalog.find((domain) => domain.id === domainId) || null;
}

function toDraftEditor(detail: TaskDetail): DraftEditorState {
  return {
    content: detail.latestDraft?.content || '',
    summary: detail.task.summary || '',
    sendMode: asText(detail.latestDraft?.metadata?.sendMode, 'reply'),
    reactionName: asText(detail.latestDraft?.metadata?.reactionName, '')
  };
}

export default function App() {
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [taskPayload, setTaskPayload] = useState<TaskListResponse | null>(null);
  const [selectedTaskIdByDomain, setSelectedTaskIdByDomain] = useState<Record<DomainId, string>>({
    slack_mention: '',
    github_review: '',
    code_execution: ''
  });
  const [taskDetails, setTaskDetails] = useState<Record<string, TaskDetail>>({});
  const [detailLoadingByTaskId, setDetailLoadingByTaskId] = useState<Record<string, boolean>>({});
  const [draftEditorsByTaskId, setDraftEditorsByTaskId] = useState<Record<string, DraftEditorState>>({});

  const [loadingTasks, setLoadingTasks] = useState(false);
  const [busyAction, setBusyAction] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const [command, setCommand] = useState('');
  const [projectId, setProjectId] = useState('');
  const [baseBranch, setBaseBranch] = useState('master');
  const [agentProvider, setAgentProvider] = useState('codex');
  const [needsPlanning, setNeedsPlanning] = useState(true);
  const [needsDesign, setNeedsDesign] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<CollapsibleState>({
    panel_slack: false,
    panel_github: false,
    panel_code: false,
    slack_analysis: false,
    slack_draft: false,
    slack_artifacts: true,
    github_draft: false,
    code_create: false,
    code_tasks: true
  });

  const tasks = taskPayload?.tasks || [];
  const slackTasks = tasks.filter((task) => task.domain === 'slack_mention');
  const githubReviewTasks = tasks.filter((task) => task.domain === 'github_review');
  const codeExecutionTasks = tasks.filter((task) => task.domain === 'code_execution');

  const selectedSlackTaskId = selectedTaskIdByDomain.slack_mention || '';
  const selectedGitHubTaskId = selectedTaskIdByDomain.github_review || '';
  const selectedCodeTaskId = selectedTaskIdByDomain.code_execution || '';

  const slackDetail = selectedSlackTaskId ? taskDetails[selectedSlackTaskId] || null : null;
  const githubDetail = selectedGitHubTaskId ? taskDetails[selectedGitHubTaskId] || null : null;
  const codeDetail = selectedCodeTaskId ? taskDetails[selectedCodeTaskId] || null : null;

  const slackEditor = slackDetail ? draftEditorsByTaskId[slackDetail.task.id] : null;
  const githubEditor = githubDetail ? draftEditorsByTaskId[githubDetail.task.id] : null;

  const slackDomain = slackDetail ? findDomain(taskPayload?.domains, slackDetail.task.domain) : null;
  const githubDomain = githubDetail ? findDomain(taskPayload?.domains, githubDetail.task.domain) : null;

  const slackCodeReview = slackDetail ? getCodeReviewStatus(slackDetail.task) : null;
  const slackCodeReviewState = slackDetail ? asRecord(asRecord(slackDetail.task.payload).codeReview) : {};
  const slackCodeReviewEnabled = Boolean(slackCodeReviewState.enabled);
  const slackCodeReviewStatus = asText(slackCodeReviewState.analysisStatus).toLowerCase();
  const showSlackCodeReviewSection = Boolean(
    slackDetail
    && (
      slackCodeReviewEnabled
      || ['running', 'completed', 'failed'].includes(slackCodeReviewStatus)
      || (slackCodeReview?.progressTotalSteps || 0) > 0
    )
  );
  const codeExecutionProgress = codeDetail ? getExecutionProgress(codeDetail.task) : null;
  const anyDetailLoading = Object.values(detailLoadingByTaskId).some(Boolean);

  async function reloadTasks() {
    setLoadingTasks(true);
    try {
      const payload = await fetchTasks(false);
      startTransition(() => {
        setTaskPayload(payload);
      });
      setError('');
    } catch (caught) {
      setError(asText((caught as Error).message, '작업 목록을 불러오지 못했습니다.'));
    } finally {
      setLoadingTasks(false);
    }
  }

  async function runBatchUpdate() {
    await pollSlackMentions();
    await pollGitHubReviews();
  }

  async function reloadTaskDetail(taskId: string) {
    if (!taskId) {
      return;
    }

    setDetailLoadingByTaskId((current) => ({
      ...current,
      [taskId]: true
    }));

    try {
      const payload = await fetchTaskDetail(taskId);
      startTransition(() => {
        setTaskDetails((current) => ({
          ...current,
          [taskId]: payload
        }));
      });
      setDraftEditorsByTaskId((current) => {
        if (current[taskId]) {
          return current;
        }
        return {
          ...current,
          [taskId]: toDraftEditor(payload)
        };
      });
      setError('');
    } catch (caught) {
      setError(asText((caught as Error).message, '작업 상세를 불러오지 못했습니다.'));
    } finally {
      setDetailLoadingByTaskId((current) => ({
        ...current,
        [taskId]: false
      }));
    }
  }

  async function runAction(label: string, action: () => Promise<string | string[] | void>) {
    setBusyAction(label);
    setNotice('');
    setError('');

    try {
      const result = await action();
      const resultTaskIds = Array.isArray(result)
        ? result.filter(Boolean)
        : result
          ? [result]
          : [];

      setNotice(`${label} 완료`);
      await reloadTasks();

      const selectedTaskIds = Object.values(selectedTaskIdByDomain).filter(Boolean);
      const detailTaskIds = Array.from(new Set([...selectedTaskIds, ...resultTaskIds]));
      await Promise.all(detailTaskIds.map((taskId) => reloadTaskDetail(taskId)));
    } catch (caught) {
      setError(asText((caught as Error).message, `${label} 처리에 실패했습니다.`));
    } finally {
      setBusyAction('');
    }
  }

  function updateDraftEditor(taskId: string, patch: Partial<DraftEditorState>) {
    setDraftEditorsByTaskId((current) => ({
      ...current,
      [taskId]: {
        ...(current[taskId] || {
          content: '',
          summary: '',
          sendMode: 'reply',
          reactionName: ''
        }),
        ...patch
      }
    }));
  }

  function toggleSection(sectionId: CollapsibleSectionId) {
    setCollapsedSections((current) => ({
      ...current,
      [sectionId]: !current[sectionId]
    }));
  }

  useEffect(() => {
    let stopped = false;

    async function bootstrap() {
      try {
        const payload = await fetchMeta();
        if (stopped) {
          return;
        }
        setMeta(payload);
        setAgentProvider(payload.defaultAgentProvider || 'codex');
        setProjectId((current) => current || payload.projects[0]?.id || '');
      } catch (caught) {
        if (stopped) {
          return;
        }
        setError(asText((caught as Error).message, '초기 정보를 불러오지 못했습니다.'));
      }
    }

    void bootstrap();

    return () => {
      stopped = true;
    };
  }, []);

  // useEffect(() => {
  //   const handle = window.setInterval(() => {
  //     void runAction('일괄 업데이트', runBatchUpdate);
  //   }, 10 * 60 * 1000);
  //   return () => {
  //     window.clearInterval(handle);
  //   };
  // }, []);

  useEffect(() => {
    setSelectedTaskIdByDomain((current) => {
      const next: Record<DomainId, string> = {
        ...current
      };

      const domainTaskMap: Record<DomainId, Task[]> = {
        slack_mention: slackTasks,
        github_review: githubReviewTasks,
        code_execution: codeExecutionTasks
      };

      for (const domain of DOMAIN_IDS) {
        const domainTasks = domainTaskMap[domain];
        const exists = domainTasks.some((task) => task.id === current[domain]);
        next[domain] = exists ? current[domain] : domainTasks[0]?.id || '';
      }

      if (
        current.slack_mention === next.slack_mention
        && current.github_review === next.github_review
        && current.code_execution === next.code_execution
      ) {
        return current;
      }

      return next;
    });
  }, [slackTasks, githubReviewTasks, codeExecutionTasks]);

  const slackMessageArtifacts = slackDetail
    ? slackDetail.artifacts.filter((artifact) => artifact.type === 'slack_message')
    : [];

  const panelClass = 'rounded-2xl border bg-slate-50 p-4 shadow-sm';
  const sectionHeaderClass = 'mb-3 flex items-center justify-between gap-3 rounded-lg border px-3 py-2';
  const sectionCountClass = 'rounded-full border bg-white px-2 py-0.5 text-xs font-semibold text-slate-600';
  const labelClass = 'grid gap-1.5 text-sm text-slate-700';
  const emptyClass = 'text-sm text-slate-500';
  const modeButtonClass = (active: boolean) => `inline-flex items-center justify-center rounded-lg border px-3 py-1.5 text-sm font-semibold transition ${active
    ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
    : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100'}`;
  const normalizedSlackReactionName = normalizeReactionName(slackEditor?.reactionName || '');
  const slackReactionGlyph = resolveReactionGlyph(normalizedSlackReactionName);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-950 to-slate-900">
      <div className="mx-auto grid min-h-screen w-full max-w-[1200px] grid-rows-[auto,1fr,auto] px-4 pb-4 sm:px-6">
        <header className="flex flex-col gap-4 py-5 text-slate-100 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.08em] text-slate-300">작업 관제 콘솔</p>
            <h1 className="mt-1 text-2xl font-bold">Doppelganger</h1>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={BUTTON_CLASS} onClick={() => void runAction('일괄 업데이트', runBatchUpdate)} disabled={Boolean(busyAction)}>
              일괄 업데이트
            </button>
            <button type="button" className={BUTTON_CLASS} onClick={() => void reloadTasks()} disabled={loadingTasks}>
              새로고침
            </button>
          </div>
        </header>

        <main className="flex flex-col gap-5 pb-4">
          <section className={`${panelClass} border-sky-200 bg-sky-50/70`}>
            <div className={`${sectionHeaderClass} border-sky-200 bg-sky-100/80`}>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold text-slate-800">Slack</h2>
                <span className={`${sectionCountClass} border-sky-200`}>{slackTasks.length}건</span>
              </div>
              <button type="button" className={SUB_BUTTON_CLASS} onClick={() => toggleSection('panel_slack')}>
                {collapsedSections.panel_slack ? '펼치기' : '접기'}
              </button>
            </div>

            {!collapsedSections.panel_slack && (
              <>
                <div className="mb-4">
              <label className={labelClass}>
                작업 선택
                <select
                  className={INPUT_CLASS}
                  value={selectedSlackTaskId}
                  onChange={(event) => {
                    setSelectedTaskIdByDomain((current) => ({
                      ...current,
                      slack_mention: event.target.value
                    }));
                  }}
                  disabled={slackTasks.length === 0}
                >
                  {slackTasks.length === 0 && (
                    <option value="">선택 가능한 작업이 없습니다</option>
                  )}
                  {slackTasks.map((task) => (
                    <option key={task.id} value={task.id}>
                      {`${mapStatusLabel(task.status)} · ${task.title}`}
                    </option>
                  ))}
                </select>
                  </label>
                </div>

                {!selectedSlackTaskId && <p className={emptyClass}>Slack 작업이 없습니다.</p>}
                {selectedSlackTaskId && !slackDetail && <p className={emptyClass}>Slack 상세를 불러오는 중입니다.</p>}

                {selectedSlackTaskId && slackDetail && slackEditor && (
                  <article className="grid gap-4 border-t border-slate-200 pt-4">
                <header className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                  <h3 className="text-lg font-semibold text-slate-900">{slackDetail.task.title}</h3>
                  <div className="flex flex-wrap gap-1.5">
                    {renderStatusBadge(slackDetail.task.status, mapStatusLabel(slackDetail.task.status))}
                    {renderStatusBadge(slackDetail.task.approval_state, mapStatusLabel(slackDetail.task.approval_state))}
                    <DomainBadge label={mapDomainLabel(slackDetail.task.domain)} />
                  </div>
                </header>

                <p className="text-sm text-slate-600">{slackDetail.task.summary || '요약이 아직 없습니다.'}</p>
                {slackDetail.task.last_error && <p className="text-sm text-rose-700">오류: {slackDetail.task.last_error}</p>}

                {showSlackCodeReviewSection && (
                  <section className="grid gap-3 rounded-xl border border-slate-200 bg-white p-3">
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="text-sm font-semibold text-slate-900">코드 분석 진행</h4>
                      <button type="button" className={SUB_BUTTON_CLASS} onClick={() => toggleSection('slack_analysis')}>
                        {collapsedSections.slack_analysis ? '펼치기' : '접기'}
                      </button>
                    </div>
                    {!collapsedSections.slack_analysis && (
                      <>
                        {slackCodeReview && (
                          <>
                            <p className="text-sm text-slate-700">{mapCodeReviewStatus(slackCodeReview.analysisStatus)}</p>
                            <div>
                              <ProgressBar percent={slackCodeReview.progressPercent} />
                            </div>
                            <p className="text-xs text-slate-500">
                              {slackCodeReview.progressStep}/{slackCodeReview.progressTotalSteps} · {slackCodeReview.progressLabel || '진행 상태 없음'}
                            </p>
                          </>
                        )}

                        <section className="flex flex-wrap gap-2 justify-end">
                          <button type="button" className={BUTTON_CLASS} onClick={() => void runAction('코드 검토 실행', async () => { await startCodeReview(slackDetail.task.id); return slackDetail.task.id; })} disabled={Boolean(busyAction)}>
                            코드 검토 실행
                          </button>
                          {slackDomain?.capabilities?.drafting && (
                            <>
                              <button type="button" className={BUTTON_CLASS} onClick={() => void runAction('초안 생성', async () => { await generateDraft(slackDetail.task.id, false); return slackDetail.task.id; })} disabled={Boolean(busyAction)}>
                                초안 생성
                              </button>
                              <button type="button" className={BUTTON_CLASS} onClick={() => void runAction('코드 기반 초안 생성', async () => { await generateDraft(slackDetail.task.id, true); return slackDetail.task.id; })} disabled={Boolean(busyAction)}>
                                코드 기반 초안 생성
                              </button>
                            </>
                          )}
                        </section>
                      </>
                    )}
                  </section>
                )}

                <section className="grid gap-3 border-t border-dashed border-slate-300 pt-4">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="text-sm font-semibold text-slate-900">초안/요약 편집</h4>
                    <button type="button" className={SUB_BUTTON_CLASS} onClick={() => toggleSection('slack_draft')}>
                      {collapsedSections.slack_draft ? '펼치기' : '접기'}
                    </button>
                  </div>
                  {!collapsedSections.slack_draft && (
                    <>
                      <label className={labelClass}>
                        요약
                        <input className={INPUT_CLASS} value={slackEditor.summary} onChange={(event) => updateDraftEditor(slackDetail.task.id, { summary: event.target.value })} />
                      </label>
                      <div className={labelClass}>
                        <span>전송 방식</span>
                        <div className="mt-1 flex flex-wrap gap-2">
                          <button type="button" className={modeButtonClass(slackEditor.sendMode === 'reply')} onClick={() => updateDraftEditor(slackDetail.task.id, { sendMode: 'reply' })}>
                            답글
                          </button>
                          <button type="button" className={modeButtonClass(slackEditor.sendMode === 'reaction')} onClick={() => updateDraftEditor(slackDetail.task.id, { sendMode: 'reaction' })}>
                            이모지
                          </button>
                        </div>
                      </div>
                      {slackEditor.sendMode === 'reaction' && (
                        <>
                          <label className={labelClass}>
                            이모지 이름
                            <input className={INPUT_CLASS} value={slackEditor.reactionName} onChange={(event) => updateDraftEditor(slackDetail.task.id, { reactionName: normalizeReactionName(event.target.value) })} placeholder="eyes" />
                          </label>
                          <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                            <span className="text-2xl" aria-hidden>{slackReactionGlyph || '🙂'}</span>
                            <div className="text-sm">
                              <p className="font-semibold text-slate-800">이모지 미리보기</p>
                              <p className="text-slate-600">{normalizedSlackReactionName ? `:${normalizedSlackReactionName}:` : '리액션 이름을 입력하세요'}</p>
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {EMOJI_PRESET_OPTIONS.map((emoji) => (
                              <button key={emoji.name} type="button" className={modeButtonClass(normalizedSlackReactionName === emoji.name)} onClick={() => updateDraftEditor(slackDetail.task.id, { reactionName: emoji.name })}>
                                <span aria-hidden>{emoji.glyph}</span> :{emoji.name}:
                              </button>
                            ))}
                          </div>
                          <p className="text-xs text-slate-500">이모지 모드에서는 본문 없이 전송할 수 있습니다.</p>
                        </>
                      )}
                      {slackEditor.sendMode !== 'reaction' && (
                        <label className={labelClass}>
                          본문
                          <textarea className={INPUT_CLASS} value={slackEditor.content} onChange={(event) => updateDraftEditor(slackDetail.task.id, { content: event.target.value })} rows={8} />
                        </label>
                      )}
                      <div className="flex flex-wrap justify-end gap-2">
                        <button
                          type="button"
                          className={BUTTON_CLASS}
                          onClick={() => {
                            const reactionNameToSend = normalizeReactionName(slackEditor.reactionName);
                            if (slackEditor.sendMode === 'reaction' && !reactionNameToSend) {
                              setError('이모지 전송에는 리액션 이름이 필요합니다.');
                              return;
                            }
                            void runAction('작업 전송', async () => {
                              await sendTask(slackDetail.task.id, {
                                draft: slackEditor.content,
                                summary: slackEditor.summary,
                                sendMode: slackEditor.sendMode,
                                reactionName: reactionNameToSend
                              });
                              return slackDetail.task.id;
                            });
                          }}
                          disabled={Boolean(busyAction)}
                        >
                          전송
                        </button>
                        <button type="button" className={BUTTON_CLASS} onClick={() => void runAction('작업 무시', async () => { await ignoreTask(slackDetail.task.id); return slackDetail.task.id; })} disabled={Boolean(busyAction)}>
                          무시
                        </button>
                      </div>
                    </>
                  )}
                </section>

                <section className="grid gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="text-sm font-semibold text-slate-900">메시지 / 답글</h4>
                    <button type="button" className={SUB_BUTTON_CLASS} onClick={() => toggleSection('slack_artifacts')}>
                      {collapsedSections.slack_artifacts ? '펼치기' : '접기'}
                    </button>
                  </div>
                  {!collapsedSections.slack_artifacts && (
                    <ul className="grid gap-2">
                      {slackMessageArtifacts.map((artifact) => (
                        <li key={artifact.id} className="grid gap-2 rounded-lg border border-slate-200 bg-white p-3">
                          <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                            <strong className="text-slate-900">{artifact.title || '메시지'}</strong>
                            <span className="text-xs text-slate-500">{formatDateTime(artifact.created_at)}</span>
                          </div>
                          <pre className="m-0 whitespace-pre-wrap break-words rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">{artifact.content || '(내용 없음)'}</pre>
                        </li>
                      ))}
                      {slackMessageArtifacts.length === 0 && <li className={emptyClass}>표시할 메시지/답글 아티팩트가 없습니다.</li>}
                    </ul>
                  )}
                </section>
                  </article>
                )}
              </>
            )}
          </section>

          <section className={`${panelClass} border-emerald-200 bg-emerald-50/60`}>
            <div className={`${sectionHeaderClass} border-emerald-200 bg-emerald-100/80`}>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold text-slate-800">GitHub PR</h2>
                <span className={`${sectionCountClass} border-emerald-200`}>{githubReviewTasks.length}건</span>
              </div>
              <button type="button" className={SUB_BUTTON_CLASS} onClick={() => toggleSection('panel_github')}>
                {collapsedSections.panel_github ? '펼치기' : '접기'}
              </button>
            </div>

            {!collapsedSections.panel_github && (
              <>
                <div className="mb-4">
              <label className={labelClass}>
                작업 선택
                <select
                  className={INPUT_CLASS}
                  value={selectedGitHubTaskId}
                  onChange={(event) => {
                    setSelectedTaskIdByDomain((current) => ({
                      ...current,
                      github_review: event.target.value
                    }));
                  }}
                  disabled={githubReviewTasks.length === 0}
                >
                  {githubReviewTasks.length === 0 && (
                    <option value="">선택 가능한 작업이 없습니다</option>
                  )}
                  {githubReviewTasks.map((task) => (
                    <option key={task.id} value={task.id}>
                      {`${mapStatusLabel(task.status)} · ${task.title}`}
                    </option>
                  ))}
                </select>
                  </label>
                </div>

                {!selectedGitHubTaskId && <p className={emptyClass}>GitHub PR 작업이 없습니다.</p>}
                {selectedGitHubTaskId && !githubDetail && <p className={emptyClass}>GitHub PR 상세를 불러오는 중입니다.</p>}

                {selectedGitHubTaskId && githubDetail && githubEditor && (
                  <article className="grid gap-4 border-t border-slate-200 pt-4">
                <header className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                  <h3 className="text-lg font-semibold text-slate-900">{githubDetail.task.title}</h3>
                  <div className="flex flex-wrap gap-1.5">
                    {renderStatusBadge(githubDetail.task.status, mapStatusLabel(githubDetail.task.status))}
                    {renderStatusBadge(githubDetail.task.approval_state, mapStatusLabel(githubDetail.task.approval_state))}
                    <DomainBadge label={mapDomainLabel(githubDetail.task.domain)} />
                  </div>
                </header>

                <p className="text-sm text-slate-600">{githubDetail.task.summary || '요약이 아직 없습니다.'}</p>
                {githubDetail.task.last_error && <p className="text-sm text-rose-700">오류: {githubDetail.task.last_error}</p>}

                <section className="flex flex-wrap gap-2">
                  {githubDomain?.capabilities?.drafting && (
                    <button type="button" className={BUTTON_CLASS} onClick={() => void runAction('초안 생성', async () => { await generateDraft(githubDetail.task.id, false); return githubDetail.task.id; })} disabled={Boolean(busyAction)}>
                      초안 생성
                    </button>
                  )}
                  <button type="button" className={BUTTON_CLASS} onClick={() => void runAction('작업 승인', async () => { await approveTask(githubDetail.task.id); return githubDetail.task.id; })} disabled={Boolean(busyAction)}>
                    승인
                  </button>
                  <button type="button" className={BUTTON_CLASS} onClick={() => void runAction('작업 무시', async () => { await ignoreTask(githubDetail.task.id); return githubDetail.task.id; })} disabled={Boolean(busyAction)}>
                    무시
                  </button>
                </section>

                <section className="grid gap-3 border-t border-dashed border-slate-300 pt-4">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="text-sm font-semibold text-slate-900">초안/요약 편집</h4>
                    <button type="button" className={SUB_BUTTON_CLASS} onClick={() => toggleSection('github_draft')}>
                      {collapsedSections.github_draft ? '펼치기' : '접기'}
                    </button>
                  </div>
                  {!collapsedSections.github_draft && (
                    <>
                      <label className={labelClass}>
                        요약
                        <input className={INPUT_CLASS} value={githubEditor.summary} onChange={(event) => updateDraftEditor(githubDetail.task.id, { summary: event.target.value })} />
                      </label>
                      <label className={labelClass}>
                        본문
                        <textarea className={INPUT_CLASS} value={githubEditor.content} onChange={(event) => updateDraftEditor(githubDetail.task.id, { content: event.target.value })} rows={8} />
                      </label>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className={BUTTON_CLASS}
                          onClick={() => void runAction('초안 저장', async () => {
                            await saveDraft(githubDetail.task.id, {
                              draft: githubEditor.content,
                              summary: githubEditor.summary,
                              sendMode: 'reply',
                              reactionName: ''
                            });
                            return githubDetail.task.id;
                          })}
                          disabled={Boolean(busyAction)}
                        >
                          초안 저장
                        </button>
                        <button
                          type="button"
                          className={BUTTON_CLASS}
                          onClick={() => void runAction('작업 전송', async () => {
                            await sendTask(githubDetail.task.id, {
                              draft: githubEditor.content,
                              summary: githubEditor.summary,
                              sendMode: 'reply',
                              reactionName: ''
                            });
                            return githubDetail.task.id;
                          })}
                          disabled={Boolean(busyAction)}
                        >
                          전송
                        </button>
                      </div>
                    </>
                  )}
                </section>
                  </article>
                )}
              </>
            )}
          </section>

          <section className={`${panelClass} border-amber-200 bg-amber-50/70`}>
            <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-100/80 px-3 py-2">
              <h2 className="text-base font-semibold text-slate-800">코드 작업</h2>
              <button type="button" className={SUB_BUTTON_CLASS} onClick={() => toggleSection('panel_code')}>
                {collapsedSections.panel_code ? '펼치기' : '접기'}
              </button>
            </div>

            {!collapsedSections.panel_code && (
              <>
                <section className="grid gap-3">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-slate-900">코드 작업 생성</h3>
                    <button type="button" className={SUB_BUTTON_CLASS} onClick={() => toggleSection('code_create')}>
                      {collapsedSections.code_create ? '펼치기' : '접기'}
                    </button>
                  </div>
                  {!collapsedSections.code_create && (
                    <form
                      className="grid gap-3 md:grid-cols-3"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void runAction('코드 작업 생성', async () => {
                          const created = await createCodeTask({
                            command,
                            projectId,
                            baseBranch,
                            agentProvider,
                            needsPlanning,
                            needsDesign
                          });
                          setSelectedTaskIdByDomain((current) => ({
                            ...current,
                            code_execution: created.task.id
                          }));
                          return created.task.id;
                        });
                      }}
                    >
                      <label className={labelClass}>
                        프로젝트
                        <select className={INPUT_CLASS} value={projectId} onChange={(event) => setProjectId(event.target.value)} required>
                          {(meta?.projects || []).map((project) => (
                            <option key={project.id} value={project.id}>
                              {project.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className={labelClass}>
                        기준 브랜치
                        <input className={INPUT_CLASS} value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)} />
                      </label>
                      <label className={labelClass}>
                        에이전트
                        <select className={INPUT_CLASS} value={agentProvider} onChange={(event) => setAgentProvider(event.target.value)}>
                          <option value="codex">Codex</option>
                          <option value="claude">Claude</option>
                        </select>
                      </label>
                      <label className={`${labelClass} md:col-span-3`}>
                        명령
                        <textarea
                          className={INPUT_CLASS}
                          value={command}
                          onChange={(event) => setCommand(event.target.value)}
                          rows={3}
                          placeholder="예: Slack 멘션 답변 생성 실패 시 로깅 원인 분석"
                          required
                        />
                      </label>
                      <label className="flex items-center gap-2 text-sm text-slate-700">
                        <input type="checkbox" checked={needsPlanning} onChange={(event) => setNeedsPlanning(event.target.checked)} />
                        기획 단계 실행
                      </label>
                      <label className="flex items-center gap-2 text-sm text-slate-700">
                        <input type="checkbox" checked={needsDesign} onChange={(event) => setNeedsDesign(event.target.checked)} />
                        디자인 단계 실행
                      </label>
                      <div className="md:col-span-3">
                        <button type="submit" className={BUTTON_CLASS} disabled={Boolean(busyAction)}>실행</button>
                      </div>
                    </form>
                  )}
                </section>

                <section className="mt-4 border-t border-slate-200 pt-4">
                  <div className="flex items-center justify-between gap-2 mb-4">
                    <h3 className="text-sm font-semibold text-slate-900">코드 작업 목록</h3>
                    <button type="button" className={SUB_BUTTON_CLASS} onClick={() => toggleSection('code_tasks')}>
                      {collapsedSections.code_tasks ? '펼치기' : '접기'}
                    </button>
                  </div>
                  {!collapsedSections.code_tasks && (
                    <>
              <div className={`${sectionHeaderClass} border-amber-200 bg-amber-100/80`}>
                <h2 className="text-base font-semibold text-slate-800">코드 작업</h2>
                <span className={`${sectionCountClass} border-amber-200`}>{codeExecutionTasks.length}건</span>
              </div>

              <div className="mb-4">
                <label className={labelClass}>
                  작업 선택
                  <select
                    className={INPUT_CLASS}
                    value={selectedCodeTaskId}
                    onChange={(event) => {
                      setSelectedTaskIdByDomain((current) => ({
                        ...current,
                        code_execution: event.target.value
                      }));
                    }}
                    disabled={codeExecutionTasks.length === 0}
                  >
                    {codeExecutionTasks.length === 0 && (
                      <option value="">선택 가능한 작업이 없습니다</option>
                    )}
                    {codeExecutionTasks.map((task) => (
                      <option key={task.id} value={task.id}>
                        {`${mapStatusLabel(task.status)} · ${task.title}`}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {!selectedCodeTaskId && <p className={emptyClass}>코드 작업이 없습니다.</p>}
              {selectedCodeTaskId && !codeDetail && <p className={emptyClass}>코드 작업 상세를 불러오는 중입니다.</p>}

              {selectedCodeTaskId && codeDetail && (
                <article className="grid gap-4 border-t border-slate-200 pt-4">
                  <header className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                    <h3 className="text-lg font-semibold text-slate-900">{codeDetail.task.title}</h3>
                    <div className="flex flex-wrap gap-1.5">
                      {renderStatusBadge(codeDetail.task.status, mapStatusLabel(codeDetail.task.status))}
                      {renderStatusBadge(codeDetail.task.approval_state, mapStatusLabel(codeDetail.task.approval_state))}
                      <DomainBadge label={mapDomainLabel(codeDetail.task.domain)} />
                    </div>
                  </header>

                  <p className="text-sm text-slate-600">{codeDetail.task.summary || '요약이 아직 없습니다.'}</p>
                  {codeDetail.task.last_error && <p className="text-sm text-rose-700">오류: {codeDetail.task.last_error}</p>}

                  {codeExecutionProgress && (
                    <section className="rounded-xl border border-slate-200 bg-white p-3">
                      <h4 className="text-sm font-semibold text-slate-900">코드 작업 진행</h4>
                      <p className="mt-1 text-sm text-slate-700">{codeExecutionProgress.phase || '-'}</p>
                      <div className="mt-2">
                        <ProgressBar percent={codeExecutionProgress.percent} />
                      </div>
                      <p className="mt-2 text-xs text-slate-500">
                        {codeExecutionProgress.currentStep}/{codeExecutionProgress.totalSteps}
                        {codeExecutionProgress.reviewTotalRounds > 0 && ` · 리뷰 ${codeExecutionProgress.reviewRound}/${codeExecutionProgress.reviewTotalRounds}`}
                        {codeExecutionProgress.label ? ` · ${codeExecutionProgress.label}` : ''}
                      </p>
                    </section>
                  )}

                  <section className="flex flex-wrap gap-2">
                    <button type="button" className={BUTTON_CLASS} onClick={() => void runAction('코드 작업 실행', async () => { await runTask(codeDetail.task.id); return codeDetail.task.id; })} disabled={Boolean(busyAction)}>
                      코드 작업 실행
                    </button>
                    <button type="button" className={BUTTON_CLASS} onClick={() => void runAction('PR 생성', async () => { await createPullRequest(codeDetail.task.id); return codeDetail.task.id; })} disabled={Boolean(busyAction)}>
                      PR 생성
                    </button>
                    <button type="button" className={BUTTON_CLASS} onClick={() => void runAction('작업 승인', async () => { await approveTask(codeDetail.task.id); return codeDetail.task.id; })} disabled={Boolean(busyAction)}>
                      승인
                    </button>
                    <button type="button" className={BUTTON_CLASS} onClick={() => void runAction('작업 무시', async () => { await ignoreTask(codeDetail.task.id); return codeDetail.task.id; })} disabled={Boolean(busyAction)}>
                      무시
                    </button>
                  </section>
                </article>
              )}
                    </>
                  )}
                </section>
              </>
            )}
          </section>
        </main>

        <footer className="flex flex-wrap items-center gap-4 border-t border-slate-700/60 py-3 text-sm text-slate-200">
          {loadingTasks || anyDetailLoading ? <span>데이터 동기화 중…</span> : <span>동기화 완료</span>}
          {busyAction && <span>실행 중: {busyAction}</span>}
          {notice && <span className="text-emerald-300">{notice}</span>}
          {error && <span className="text-rose-300">{error}</span>}
        </footer>
      </div>
    </div>
  );
}
