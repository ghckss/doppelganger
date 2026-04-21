import { useEffect, useMemo, useState } from 'react';
import { approveTask, createCodeTask, createPullRequest, ignoreTask, resumeCodeTask, runTask } from '../api';
import type { MetaResponse, Task, TaskDetail } from '../types';
import type {
  CollapsibleSectionId,
  CollapsibleState,
  ExecutionProgress
} from '../task-view';
import {
  getExecutionProgress,
  getExecutionStepElapsedSeconds,
  mapDomainLabel,
  mapStatusLabel,
  summarizeExecutionStep
} from '../task-view';
import {
  BUTTON_CLASS,
  DomainBadge,
  EMPTY_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  PANEL_CLASS,
  SECTION_COUNT_CLASS,
  SECTION_HEADER_CLASS,
  StatusBadge,
  SUB_BUTTON_CLASS
} from './common';
import { TaskTimeline } from './TaskTimeline';

type ReviewFindingView = {
  id: string;
  severity: string;
  category: string;
  title: string;
  description: string;
  fileRefs: string[];
  suggestedFix: string;
  mustFix: boolean;
};

type ReviewRoundView = {
  round: number;
  review: {
    summary: string;
    approval: string;
    residualRisks: string[];
    findings: ReviewFindingView[];
  } | null;
  patch: {
    summary: string;
    resolvedFindings: string[];
    declinedFindings: string[];
    testsRun: string[];
    notes: string[];
    newCommits: string[];
  } | null;
};

const EXECUTION_STEP_ITEMS = [
  { step: 1, label: '작업 환경 점검 + 브랜치 준비' },
  { step: 2, label: '프롬프트/기획/디자인 계획 생성' },
  { step: 3, label: '코딩 에이전트 실행' },
  { step: 4, label: '리뷰/수정 라운드 1' },
  { step: 5, label: '리뷰/수정 라운드 2' },
  { step: 6, label: '리뷰/수정 라운드 3' },
  { step: 7, label: 'PR 초안 정리' },
  { step: 8, label: '코드 작업 완료' }
] as const;

function stepState(currentStep: number, step: number): 'done' | 'current' | 'pending' {
  if (currentStep > step) {
    return 'done';
  }
  if (currentStep === step) {
    return 'current';
  }
  return 'pending';
}

function stepStateClass(state: 'done' | 'current' | 'pending'): string {
  if (state === 'done') {
    return 'text-emerald-700';
  }
  if (state === 'current') {
    return 'text-amber-800 font-semibold';
  }
  return 'text-slate-500';
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function toText(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).trim();
}

function toNumber(value: unknown, fallback = 0): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return numeric;
}

function toTextList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => toText(entry)).filter(Boolean);
}

function parseReviewFinding(value: unknown): ReviewFindingView {
  const source = toRecord(value);
  return {
    id: toText(source.id),
    severity: toText(source.severity),
    category: toText(source.category),
    title: toText(source.title),
    description: toText(source.description),
    fileRefs: toTextList(source.fileRefs),
    suggestedFix: toText(source.suggestedFix),
    mustFix: Boolean(source.mustFix)
  };
}

function parseReviewSection(value: unknown): ReviewRoundView['review'] {
  const source = toRecord(value);
  if (Object.keys(source).length === 0) {
    return null;
  }

  const findings = Array.isArray(source.findings)
    ? source.findings.map((finding) => parseReviewFinding(finding))
    : [];
  return {
    summary: toText(source.summary),
    approval: toText(source.approval),
    residualRisks: toTextList(source.residualRisks),
    findings
  };
}

function parsePatchSection(value: unknown): ReviewRoundView['patch'] {
  const source = toRecord(value);
  if (Object.keys(source).length === 0) {
    return null;
  }

  return {
    summary: toText(source.summary),
    resolvedFindings: toTextList(source.resolvedFindings),
    declinedFindings: toTextList(source.declinedFindings),
    testsRun: toTextList(source.testsRun),
    notes: toTextList(source.notes),
    newCommits: toTextList(source.newCommits)
  };
}

function parseRoundNumber(value: unknown): number {
  const direct = toNumber(value, 0);
  return direct > 0 ? Math.trunc(direct) : 0;
}

function extractRoundFromTitle(value: unknown): number {
  const text = toText(value);
  if (!text) {
    return 0;
  }
  const matched = text.match(/(\d+)/);
  if (!matched) {
    return 0;
  }
  return parseRoundNumber(matched[1]);
}

function mergeReviewRoundList(detail: TaskDetail | null): ReviewRoundView[] {
  if (!detail) {
    return [];
  }

  const taskResult = toRecord(detail.task.result);
  const map = new Map<number, ReviewRoundView>();
  const roundsFromResult = Array.isArray(taskResult.reviewRounds) ? taskResult.reviewRounds : [];

  roundsFromResult.forEach((round) => {
    const source = toRecord(round);
    const roundNumber = parseRoundNumber(source.round);
    if (roundNumber <= 0) {
      return;
    }

    map.set(roundNumber, {
      round: roundNumber,
      review: parseReviewSection(source.review),
      patch: parsePatchSection(source.patch)
    });
  });

  const reviewArtifacts = detail.artifacts.filter((artifact) => artifact.type === 'review_round');
  reviewArtifacts.forEach((artifact) => {
    const roundNumber = parseRoundNumber(artifact.metadata?.round) || extractRoundFromTitle(artifact.title);
    if (roundNumber <= 0) {
      return;
    }

    const current = map.get(roundNumber) || { round: roundNumber, review: null, patch: null };
    const parsedReview = parseReviewSection(artifact.metadata);
    map.set(roundNumber, {
      ...current,
      review: parsedReview || current.review
    });
  });

  const patchArtifacts = detail.artifacts.filter((artifact) => artifact.type === 'patch_round');
  patchArtifacts.forEach((artifact) => {
    const roundNumber = parseRoundNumber(artifact.metadata?.round) || extractRoundFromTitle(artifact.title);
    if (roundNumber <= 0) {
      return;
    }

    const current = map.get(roundNumber) || { round: roundNumber, review: null, patch: null };
    const parsedPatch = parsePatchSection(artifact.metadata);
    map.set(roundNumber, {
      ...current,
      patch: parsedPatch || current.patch
    });
  });

  return Array.from(map.values()).sort((left, right) => left.round - right.round);
}

type CodeExecutionPanelProps = {
  meta: MetaResponse | null;
  tasks: Task[];
  selectedTaskId: string;
  detail: TaskDetail | null;
  executionProgress: ExecutionProgress | null;
  collapsedSections: CollapsibleState;
  busyAction: string;
  command: string;
  projectId: string;
  baseBranch: string;
  branchName: string;
  agentProvider: string;
  needsPlanning: boolean;
  needsDesign: boolean;
  onToggleSection: (sectionId: CollapsibleSectionId) => void;
  onSelectTask: (taskId: string) => void;
  onSetCommand: (value: string) => void;
  onSetProjectId: (value: string) => void;
  onSetBaseBranch: (value: string) => void;
  onSetBranchName: (value: string) => void;
  onSetAgentProvider: (value: string) => void;
  onSetNeedsPlanning: (value: boolean) => void;
  onSetNeedsDesign: (value: boolean) => void;
  onRunAction: (label: string, action: () => Promise<string | string[] | void>) => void;
};

export function CodeExecutionPanel({
  meta,
  tasks,
  selectedTaskId,
  detail,
  executionProgress,
  collapsedSections,
  busyAction,
  command,
  projectId,
  baseBranch,
  branchName,
  agentProvider,
  needsPlanning,
  needsDesign,
  onToggleSection,
  onSelectTask,
  onSetCommand,
  onSetProjectId,
  onSetBaseBranch,
  onSetBranchName,
  onSetAgentProvider,
  onSetNeedsPlanning,
  onSetNeedsDesign,
  onRunAction
}: CodeExecutionPanelProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [showCreatePrModal, setShowCreatePrModal] = useState(false);
  const [prBranchName, setPrBranchName] = useState('');
  const [collapsedRunningTaskById, setCollapsedRunningTaskById] = useState<Record<string, boolean>>({});
  const sortedTasks = useMemo(() => {
    const list = [...tasks];
    list.sort((left, right) => {
      const leftRunning = String(left.status || '').toLowerCase() === 'running';
      const rightRunning = String(right.status || '').toLowerCase() === 'running';
      if (leftRunning !== rightRunning) {
        return leftRunning ? -1 : 1;
      }

      const leftUpdated = String(left.updated_at || '');
      const rightUpdated = String(right.updated_at || '');
      return rightUpdated.localeCompare(leftUpdated);
    });
    return list;
  }, [tasks]);
  const runningTasks = useMemo(
    () => sortedTasks.filter((task) => String(task.status || '').toLowerCase() === 'running'),
    [sortedTasks]
  );
  const runningTaskViews = useMemo(
    () => runningTasks.map((task) => {
      const rawProgress = getExecutionProgress(task);
      const progress = rawProgress || {
        phase: '',
        label: '',
        currentStep: 0,
        totalSteps: 8,
        percent: 0,
        reviewRound: 0,
        reviewTotalRounds: 3
      };
      return {
        task,
        progress,
        summary: summarizeExecutionStep(progress),
        elapsedSeconds: getExecutionStepElapsedSeconds(task, rawProgress, nowMs)
      };
    }),
    [runningTasks, nowMs]
  );
  const executionStepSummary = executionProgress
    ? summarizeExecutionStep(executionProgress)
    : '';
  const executionStepElapsedSeconds = detail && executionProgress
    ? getExecutionStepElapsedSeconds(detail.task, executionProgress, nowMs)
    : null;
  const taskPayload = detail?.task.payload && typeof detail.task.payload === 'object'
    ? detail.task.payload
    : {};
  const detailCommandText = toText((taskPayload as Record<string, unknown>).command);
  const taskResult = detail?.task.result && typeof detail.task.result === 'object'
    ? detail.task.result
    : {};
  const currentTaskBranch = String(taskResult.branch || taskPayload.branchName || '').trim();
  const pullRequestRecord = taskResult.pullRequest && typeof taskResult.pullRequest === 'object'
    ? taskResult.pullRequest as Record<string, unknown>
    : null;
  const pullRequestUrl = pullRequestRecord ? String(pullRequestRecord.url || '').trim() : '';
  const canShowCreatePrButton = Boolean(
    detail
    && executionProgress
    && Number(executionProgress.currentStep || 0) >= 8
    && !pullRequestUrl
  );

  const canResumeSelectedTask = Boolean(
    detail
    && ['failed', 'running'].includes(String(detail.task.status || '').toLowerCase())
  );
  const hasTokenOrAuthError = Boolean(
    detail
    && /token|auth|unauthorized|forbidden|401|403|인증/i.test(String(detail.task.last_error || ''))
  );
  const reviewRoundList = useMemo(() => mergeReviewRoundList(detail), [detail]);

  useEffect(() => {
    setCollapsedRunningTaskById((current) => {
      const next: Record<string, boolean> = {};
      let changed = false;

      for (const task of runningTasks) {
        if (Object.prototype.hasOwnProperty.call(current, task.id)) {
          next[task.id] = current[task.id];
          continue;
        }
        next[task.id] = false;
        changed = true;
      }

      for (const taskId of Object.keys(current)) {
        if (!runningTasks.some((task) => task.id === taskId)) {
          changed = true;
          break;
        }
      }

      if (!changed) {
        const currentKeys = Object.keys(current);
        if (currentKeys.length === Object.keys(next).length) {
          return current;
        }
      }

      return next;
    });
  }, [runningTasks]);

  useEffect(() => {
    if (runningTasks.length === 0) {
      return;
    }

    setNowMs(Date.now());
    const timerId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);
    return () => {
      window.clearInterval(timerId);
    };
  }, [
    runningTasks
  ]);

  useEffect(() => {
    setShowCreatePrModal(false);
    setPrBranchName(currentTaskBranch);
  }, [detail?.task.id, currentTaskBranch]);

  function openCreatePrModal() {
    setPrBranchName(currentTaskBranch);
    setShowCreatePrModal(true);
  }

  function submitCreatePullRequest() {
    if (!detail) {
      return;
    }

    const normalizedBranchName = prBranchName.trim();
    if (!normalizedBranchName) {
      return;
    }

    onRunAction('PR 생성', async () => {
      await createPullRequest(detail.task.id, {
        branchName: normalizedBranchName
      });
      return detail.task.id;
    });
    setShowCreatePrModal(false);
  }

  function toggleRunningTask(taskId: string) {
    setCollapsedRunningTaskById((current) => ({
      ...current,
      [taskId]: !current[taskId]
    }));
  }

  return (
    <section className={`${PANEL_CLASS} border-amber-200 bg-amber-50/70`}>
      <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-100/80 px-3 py-2">
        <h2 className="text-base font-semibold text-slate-800">코드 작업</h2>
        <button type="button" className={SUB_BUTTON_CLASS} onClick={() => onToggleSection('panel_code')}>
          {collapsedSections.panel_code ? '펼치기' : '접기'}
        </button>
      </div>

      {!collapsedSections.panel_code && (
        <>
          <section className="grid gap-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-900">코드 작업 생성</h3>
              <button type="button" className={SUB_BUTTON_CLASS} onClick={() => onToggleSection('code_create')}>
                {collapsedSections.code_create ? '펼치기' : '접기'}
              </button>
            </div>
            {!collapsedSections.code_create && (
              <form
                className="grid gap-3 md:grid-cols-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  onRunAction('코드 작업 생성', async () => {
                    const created = await createCodeTask({
                      command,
                      projectId,
                      baseBranch,
                      branchName,
                      agentProvider,
                      needsPlanning,
                      needsDesign
                    });
                    return created.task.id;
                  });
                }}
              >
                <label className={LABEL_CLASS}>
                  프로젝트
                  <select className={INPUT_CLASS} value={projectId} onChange={(event) => onSetProjectId(event.target.value)} required>
                    {(meta?.projects || []).map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={LABEL_CLASS}>
                  기준 브랜치
                  <input className={INPUT_CLASS} value={baseBranch} onChange={(event) => onSetBaseBranch(event.target.value)} />
                </label>
                <label className={LABEL_CLASS}>
                  작업 브랜치(선택)
                  <input
                    className={INPUT_CLASS}
                    value={branchName}
                    onChange={(event) => onSetBranchName(event.target.value)}
                    placeholder="예: feature/FROMM-1234"
                  />
                </label>
                <label className={LABEL_CLASS}>
                  에이전트
                  <select className={INPUT_CLASS} value={agentProvider} onChange={(event) => onSetAgentProvider(event.target.value)}>
                    <option value="codex">Codex</option>
                    <option value="claude">Claude</option>
                  </select>
                </label>
                <label className={`${LABEL_CLASS} md:col-span-3`}>
                  명령
                  <textarea
                    className={INPUT_CLASS}
                    value={command}
                    onChange={(event) => onSetCommand(event.target.value)}
                    rows={3}
                    placeholder="예: Slack 멘션 답변 생성 실패 시 로깅 원인 분석"
                    required
                  />
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={needsPlanning} onChange={(event) => onSetNeedsPlanning(event.target.checked)} />
                  기획 단계 실행
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={needsDesign} onChange={(event) => onSetNeedsDesign(event.target.checked)} />
                  디자인 단계 실행
                </label>
                <div className="md:col-span-3 flex justify-end">
                  <button type="submit" className={BUTTON_CLASS} disabled={Boolean(busyAction)}>실행</button>
                </div>
              </form>
            )}
          </section>

          <section className="mt-4 border-t border-slate-200 pt-4">
            <div className="mb-4 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-900">실행 중 코드 작업</h3>
              <button type="button" className={SUB_BUTTON_CLASS} onClick={() => onToggleSection('code_tasks')}>
                {collapsedSections.code_tasks ? '펼치기' : '접기'}
              </button>
            </div>
            {!collapsedSections.code_tasks && (
              <>
                <div className={`${SECTION_HEADER_CLASS} border-amber-200 bg-amber-100/80`}>
                  <h2 className="text-base font-semibold text-slate-800">실행 중 작업</h2>
                  <span className={`${SECTION_COUNT_CLASS} border-amber-200`}>{runningTasks.length}건</span>
                </div>

                <div className="mb-4">
                  <p className="mb-2 text-xs text-slate-600">
                    실행 중인 태스크만 표시합니다.
                  </p>
                  <div className="max-h-[34rem] space-y-2 overflow-y-auto rounded-lg border border-slate-200 bg-white p-2">
                    {runningTaskViews.length === 0 && (
                      <p className={EMPTY_CLASS}>현재 실행 중인 코드 작업이 없습니다.</p>
                    )}
                    {runningTaskViews.map(({ task, progress, summary, elapsedSeconds }) => {
                      const isCollapsed = Boolean(collapsedRunningTaskById[task.id]);
                      const isSelected = task.id === selectedTaskId;
                      const taskCommand = toText(toRecord(task.payload).command) || task.title;
                      const currentStep = Math.max(0, Number(progress.currentStep || 0));
                      return (
                        <article
                          key={task.id}
                          className={`rounded-lg border p-3 ${isSelected ? 'border-amber-300 bg-amber-50/70' : 'border-slate-200 bg-white'}`}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="whitespace-pre-wrap break-words text-sm font-semibold text-slate-900">{taskCommand}</p>
                              <p className="mt-1 text-xs text-slate-500">{mapStatusLabel(task.status)}</p>
                            </div>
                            <div className="flex items-center gap-2">
                              <StatusBadge status={task.status} label={mapStatusLabel(task.status)} />
                              <button
                                type="button"
                                className={SUB_BUTTON_CLASS}
                                onClick={() => toggleRunningTask(task.id)}
                              >
                                {isCollapsed ? '펼치기' : '접기'}
                              </button>
                            </div>
                          </div>

                          {!isCollapsed && (
                            <div className="mt-3 space-y-2">
                              <p className="text-xs text-slate-500">
                                {progress.currentStep}/{progress.totalSteps}
                                {progress.reviewTotalRounds > 0 && ` · 리뷰 ${progress.reviewRound}/${progress.reviewTotalRounds}`}
                                {progress.label ? ` · ${progress.label}` : ''}
                              </p>
                              <div className="flex items-start justify-between gap-3">
                                <p className="text-xs text-slate-700">{summary}</p>
                                {elapsedSeconds !== null && (
                                  <p className="text-xs font-medium text-slate-600">{elapsedSeconds}초째 진행 중</p>
                                )}
                              </div>
                              <ul className="rounded-md border border-slate-200 bg-slate-50 p-2 text-xs">
                                {EXECUTION_STEP_ITEMS.map((item) => {
                                  const state = stepState(currentStep, item.step);
                                  return (
                                    <li key={`${task.id}-step-${item.step}`} className={`py-0.5 ${stepStateClass(state)}`}>
                                      {String(item.step).padStart(2, '0')}. {item.label}
                                    </li>
                                  );
                                })}
                              </ul>
                              <div className="flex justify-end">
                                <button
                                  type="button"
                                  className={SUB_BUTTON_CLASS}
                                  onClick={() => onSelectTask(task.id)}
                                >
                                  상세 보기
                                </button>
                              </div>
                            </div>
                          )}
                        </article>
                      );
                    })}
                  </div>
                </div>

                {!selectedTaskId && <p className={EMPTY_CLASS}>코드 작업이 없습니다.</p>}
                {selectedTaskId && !detail && <p className={EMPTY_CLASS}>코드 작업 상세를 불러오는 중입니다.</p>}

                {selectedTaskId && detail && (
                  <article className="grid gap-4 border-t border-slate-200 pt-4">
                    <header className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                      <h3 className="text-lg font-semibold text-slate-900">{detail.task.title}</h3>
                      <div className="flex flex-wrap gap-1.5">
                        <StatusBadge status={detail.task.status} label={mapStatusLabel(detail.task.status)} />
                        <StatusBadge status={detail.task.approval_state} label={mapStatusLabel(detail.task.approval_state)} />
                        <DomainBadge label={mapDomainLabel(detail.task.domain)} />
                      </div>
                    </header>

                    {detailCommandText && (
                      <section className="rounded-xl border border-slate-200 bg-white p-3">
                        <h4 className="text-sm font-semibold text-slate-900">작업 요청 메시지</h4>
                        <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700">{detailCommandText}</p>
                      </section>
                    )}

                    <p className="text-sm text-slate-600">{detail.task.summary || '요약이 아직 없습니다.'}</p>
                    {detail.task.last_error && <p className="text-sm text-rose-700">오류: {detail.task.last_error}</p>}

                    {executionProgress && (
                      <section className="rounded-xl border border-slate-200 bg-white p-3">
                        <div className="flex items-start justify-between gap-3">
                          <h4 className="text-sm font-semibold text-slate-900">세부 진행 현황</h4>
                          {executionStepElapsedSeconds !== null && (
                            <p className="text-xs font-medium text-slate-600">{executionStepElapsedSeconds}초째 진행 중</p>
                          )}
                        </div>
                        <p className="mt-2 text-xs text-slate-500">
                          {executionProgress.currentStep}/{executionProgress.totalSteps}
                          {executionProgress.reviewTotalRounds > 0 && ` · 리뷰 ${executionProgress.reviewRound}/${executionProgress.reviewTotalRounds}`}
                          {executionProgress.label ? ` · ${executionProgress.label}` : ''}
                        </p>
                        <div className="mt-1 flex items-start justify-between gap-3">
                          <p className="text-xs text-slate-700">{executionStepSummary}</p>
                          {canShowCreatePrButton && (
                            <button
                              type="button"
                              className={BUTTON_CLASS}
                              onClick={openCreatePrModal}
                              disabled={Boolean(busyAction)}
                            >
                              PR 생성
                            </button>
                          )}
                        </div>
                        <ul className="mt-2 rounded-md border border-slate-200 bg-slate-50 p-2 text-xs">
                          {EXECUTION_STEP_ITEMS.map((item) => {
                            const state = stepState(Math.max(0, Number(executionProgress.currentStep || 0)), item.step);
                            return (
                              <li key={`detail-step-${item.step}`} className={`py-0.5 ${stepStateClass(state)}`}>
                                {String(item.step).padStart(2, '0')}. {item.label}
                              </li>
                            );
                          })}
                        </ul>
                      </section>
                    )}

                    <section className="rounded-xl border border-slate-200 bg-white p-3">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <h4 className="text-sm font-semibold text-slate-900">리뷰 라운드 내용</h4>
                        <p className="text-xs text-slate-500">{reviewRoundList.length}건</p>
                      </div>
                      {reviewRoundList.length === 0 && (
                        <p className="text-xs text-slate-600">
                          리뷰 라운드가 시작되면 검토 결과와 수정 내역이 여기에 표시됩니다.
                        </p>
                      )}
                      <div className="grid gap-2">
                        {reviewRoundList.map((round) => {
                          const findings = round.review?.findings || [];
                          return (
                            <details key={round.round} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2" open>
                              <summary className="cursor-pointer text-sm font-semibold text-slate-900">
                                라운드 {round.round}
                                {round.review?.approval ? ` · ${round.review.approval}` : ''}
                                {findings.length > 0 ? ` · 발견사항 ${findings.length}건` : ''}
                              </summary>

                              <div className="mt-2 grid gap-2 text-sm text-slate-700">
                                {round.review?.summary && (
                                  <p>
                                    <strong>리뷰 요약:</strong> {round.review.summary}
                                  </p>
                                )}

                                {findings.length > 0 && (
                                  <div className="rounded-md border border-amber-200 bg-amber-50 p-2">
                                    <p className="text-xs font-semibold text-amber-900">발견사항</p>
                                    <ul className="mt-1 list-disc pl-5 text-xs text-amber-900">
                                      {findings.map((finding, index) => (
                                        <li key={`${round.round}-${finding.id || finding.title || index}`}>
                                          <strong>{finding.severity || '-'}</strong>
                                          {finding.mustFix ? ' [Must Fix]' : ''}
                                          {finding.title ? ` · ${finding.title}` : ''}
                                          {finding.description ? ` — ${finding.description}` : ''}
                                          {finding.fileRefs.length > 0 ? ` (${finding.fileRefs.join(', ')})` : ''}
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                )}

                                {round.patch?.summary && (
                                  <p>
                                    <strong>수정 요약:</strong> {round.patch.summary}
                                  </p>
                                )}

                                {round.patch && (
                                  <div className="grid gap-1 text-xs text-slate-600">
                                    {round.patch.resolvedFindings.length > 0 && (
                                      <p>해결한 항목: {round.patch.resolvedFindings.join(', ')}</p>
                                    )}
                                    {round.patch.declinedFindings.length > 0 && (
                                      <p>보류/미해결 항목: {round.patch.declinedFindings.join(', ')}</p>
                                    )}
                                    {round.patch.testsRun.length > 0 && (
                                      <p>실행한 테스트: {round.patch.testsRun.join(', ')}</p>
                                    )}
                                    {round.patch.newCommits.length > 0 && (
                                      <p>라운드 커밋: {round.patch.newCommits.join(', ')}</p>
                                    )}
                                    {round.patch.notes.length > 0 && (
                                      <p>노트: {round.patch.notes.join(', ')}</p>
                                    )}
                                  </div>
                                )}

                                {round.review?.residualRisks && round.review.residualRisks.length > 0 && (
                                  <p className="text-xs text-rose-700">잔여 리스크: {round.review.residualRisks.join(', ')}</p>
                                )}
                              </div>
                            </details>
                          );
                        })}
                      </div>
                    </section>

                    <TaskTimeline
                      executions={detail.executions}
                      collapsed={collapsedSections.code_timeline}
                      onToggle={() => onToggleSection('code_timeline')}
                    />

                    <section className="flex flex-wrap gap-2 justify-end">
                      <button
                        type="button"
                        className={BUTTON_CLASS}
                        onClick={() => onRunAction('코드 작업 실행', async () => {
                          await runTask(detail.task.id);
                          return detail.task.id;
                        })}
                        disabled={Boolean(busyAction)}
                      >
                        코드 작업 실행
                      </button>
                      {canResumeSelectedTask && (
                        <button
                          type="button"
                          className={BUTTON_CLASS}
                          onClick={() => onRunAction('코드 작업 재개', async () => {
                            await resumeCodeTask(detail.task.id);
                            return detail.task.id;
                          })}
                          disabled={Boolean(busyAction)}
                        >
                          코드 작업 재개
                        </button>
                      )}
                    </section>
                    <section className="flex flex-wrap gap-2 justify-end">
                      <button
                        type="button"
                        className={BUTTON_CLASS}
                        onClick={() => onRunAction('작업 승인', async () => {
                          await approveTask(detail.task.id);
                          return detail.task.id;
                        })}
                        disabled={Boolean(busyAction)}
                      >
                        승인
                      </button>
                      <button
                        type="button"
                        className={BUTTON_CLASS}
                        onClick={() => onRunAction('작업 무시', async () => {
                          await ignoreTask(detail.task.id);
                          return detail.task.id;
                        })}
                        disabled={Boolean(busyAction)}
                      >
                        무시
                      </button>
                    </section>
                    {canResumeSelectedTask && (
                      <p className="text-xs text-slate-600">
                        실행 중 중단/오류가 발생한 작업은 <strong>코드 작업 재개</strong>로 이어서 진행할 수 있습니다.
                        {hasTokenOrAuthError ? ' 토큰/인증 오류가 원인이면 토큰 갱신 후 재개하세요.' : ''}
                      </p>
                    )}
                  </article>
                )}
              </>
            )}
          </section>
        </>
      )}
      {showCreatePrModal && detail && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/55 p-4">
          <section className="w-full max-w-xl rounded-xl border border-slate-200 bg-white p-4 shadow-lg">
            <h4 className="text-base font-semibold text-slate-900">PR 생성</h4>
            <p className="mt-1 text-sm text-slate-700">
              push 및 PR에 사용할 브랜치명을 입력하세요.
            </p>
            <label className={`${LABEL_CLASS} mt-3`}>
              브랜치명
              <input
                className={INPUT_CLASS}
                value={prBranchName}
                onChange={(event) => setPrBranchName(event.target.value)}
                placeholder="예: doppelganger/feature-xyz"
                autoFocus
              />
            </label>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className={SUB_BUTTON_CLASS}
                onClick={() => setShowCreatePrModal(false)}
                disabled={Boolean(busyAction)}
              >
                취소
              </button>
              <button
                type="button"
                className={BUTTON_CLASS}
                onClick={submitCreatePullRequest}
                disabled={Boolean(busyAction) || !prBranchName.trim()}
              >
                생성
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
