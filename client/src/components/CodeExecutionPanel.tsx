import { useEffect, useMemo, useState } from 'react';
import {
  createCodeTask,
  createPullRequest,
  deleteTask,
  resumeCodeTask,
  runTask,
  saveCodeTaskPlanSelections
} from '../api';
import type { MetaResponse, Task, TaskDetail } from '../types';
import type {
  CollapsibleSectionId,
  CollapsibleState,
  ExecutionProgress
} from '../task-view';
import {
  formatDateTime,
  getExecutionProgress,
  getExecutionStepElapsedSeconds,
  mapStatusLabel,
  summarizeExecutionStep
} from '../task-view';
import {
  BUTTON_CLASS,
  EMPTY_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  modeButtonClass,
  PANEL_CLASS,
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

type CodeExecutionPanelProps = {
  meta: MetaResponse | null;
  tasks: Task[];
  taskDetails: TaskDetail[];
  collapsedSections: CollapsibleState;
  busyAction: string;
  command: string;
  projectId: string;
  baseBranch: string;
  branchName: string;
  agentProvider: string;
  executionMode: 'full' | 'plan';
  needsPlanning: boolean;
  needsDesign: boolean;
  onToggleSection: (sectionId: CollapsibleSectionId) => void;
  onSetCommand: (value: string) => void;
  onSetProjectId: (value: string) => void;
  onSetBaseBranch: (value: string) => void;
  onSetBranchName: (value: string) => void;
  onSetAgentProvider: (value: string) => void;
  onSetExecutionMode: (value: 'full' | 'plan') => void;
  onSetNeedsPlanning: (value: boolean) => void;
  onSetNeedsDesign: (value: boolean) => void;
  onRunAction: (label: string, action: () => Promise<string | string[] | void>) => void;
};

type PlanConfirmationOptionView = {
  id: string;
  label: string;
  description: string;
  recommended: boolean;
};

type PlanConfirmationRequestView = {
  id: string;
  title: string;
  question: string;
  options: PlanConfirmationOptionView[];
};

const EXECUTION_STEP_ITEMS = [
  { step: 1, label: '작업 환경 점검 + 브랜치 준비' },
  { step: 2, label: '프롬프트/기획/디자인 계획 생성' },
  { step: 3, label: '코딩 에이전트 실행' },
  { step: 4, label: '리뷰/수정 라운드 1' },
  { step: 5, label: 'PR 초안 정리' },
  { step: 6, label: '코드 작업 완료' }
] as const;

const CONTINUATION_SOURCE_STATUSES = new Set(['done', 'awaiting_approval', 'failed']);

const DEFAULT_PROGRESS: ExecutionProgress = {
  phase: '',
  label: '',
  currentStep: 0,
  totalSteps: 6,
  percent: 0,
  reviewRound: 0,
  reviewTotalRounds: 1
};

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

function normalizeIdentifier(value: unknown): string {
  return toText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parsePlanConfirmationOption(value: unknown, requestId: string, index: number): PlanConfirmationOptionView {
  const source = toRecord(value);
  const optionId = normalizeIdentifier(source.id) || `${requestId}_option_${index + 1}`;
  const label = toText(source.label) || `옵션 ${index + 1}`;
  const description = toText(source.description) || label;
  return {
    id: optionId,
    label,
    description,
    recommended: Boolean(source.recommended)
  };
}

function parsePlanConfirmationRequest(value: unknown, index: number): PlanConfirmationRequestView | null {
  const source = toRecord(value);
  const requestId = normalizeIdentifier(source.id) || `confirm_${index + 1}`;
  if (!requestId) {
    return null;
  }

  const options = Array.isArray(source.options)
    ? source.options.map((option, optionIndex) => parsePlanConfirmationOption(option, requestId, optionIndex))
    : [];
  if (options.length === 0) {
    options.push({
      id: `${requestId}_default`,
      label: '기본안',
      description: '기본 권장안으로 진행합니다.',
      recommended: true
    });
  }

  if (!options.some((option) => option.recommended)) {
    options[0] = {
      ...options[0],
      recommended: true
    };
  }

  return {
    id: requestId,
    title: toText(source.title) || `확인 항목 ${index + 1}`,
    question: toText(source.question) || '작업 진행 전에 선택이 필요합니다.',
    options
  };
}

function parsePlanSelections(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.entries(value as Record<string, unknown>).reduce((accumulator, [requestId, optionId]) => {
    const normalizedRequestId = normalizeIdentifier(requestId);
    const normalizedOptionId = normalizeIdentifier(optionId);
    if (!normalizedRequestId || !normalizedOptionId) {
      return accumulator;
    }
    accumulator[normalizedRequestId] = normalizedOptionId;
    return accumulator;
  }, {} as Record<string, string>);
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

function mergeReviewRoundList(detail: TaskDetail): ReviewRoundView[] {
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

function resolveCommand(task: Task): string {
  return toText(toRecord(task.payload).command);
}

function resolveTaskBranch(task: Task): string {
  const payload = toRecord(task.payload);
  const result = toRecord(task.result);
  return toText(result.branch) || toText(payload.branchName);
}

function resolvePullRequestUrl(task: Task): string {
  const result = toRecord(task.result);
  const pullRequest = toRecord(result.pullRequest);
  return toText(pullRequest.url);
}

function resolveExecutionMode(task: Task): 'full' | 'plan' {
  const mode = toText(toRecord(task.payload).executionMode).toLowerCase();
  if (mode === 'plan' || mode === 'plan_only') {
    return 'plan';
  }
  return 'full';
}

function resolvePlanConfirmationRequests(task: Task, detail: TaskDetail | null): PlanConfirmationRequestView[] {
  const result = toRecord(task.result);
  const planMode = toRecord(result.planMode);
  const requestsSource = Array.isArray(planMode.confirmationRequests)
    ? planMode.confirmationRequests
    : [];
  if (requestsSource.length > 0) {
    return requestsSource
      .map((request, index) => parsePlanConfirmationRequest(request, index))
      .filter((request): request is PlanConfirmationRequestView => Boolean(request));
  }

  const promptPlan = toRecord(result.promptPlan);
  const fallbackSource = Array.isArray(promptPlan.confirmationRequests)
    ? promptPlan.confirmationRequests
    : detail?.artifacts
      ?.filter((artifact) => artifact.type === 'plan_confirmation_requests')
      .at(-1)
      ?.metadata
      ?.confirmationRequests;

  if (!Array.isArray(fallbackSource)) {
    return [];
  }

  return fallbackSource
    .map((request, index) => parsePlanConfirmationRequest(request, index))
    .filter((request): request is PlanConfirmationRequestView => Boolean(request));
}

function resolvePlanSelections(task: Task): Record<string, string> {
  const payload = toRecord(task.payload);
  const result = toRecord(task.result);
  const planMode = toRecord(result.planMode);
  return {
    ...parsePlanSelections(payload.planSelections),
    ...parsePlanSelections(planMode.selections)
  };
}

type ContinuationHistoryItem = {
  id: string;
  status: string;
  command: string;
  resultSummary: string;
  updatedAt: string;
};

function resolveContinuationRootTaskId(taskId: string, taskById: Map<string, Task>): string {
  let currentTask = taskById.get(taskId) || null;
  if (!currentTask) {
    return taskId;
  }

  const visited = new Set<string>();
  while (currentTask && !visited.has(currentTask.id)) {
    visited.add(currentTask.id);
    const payload = toRecord(currentTask.payload);
    const explicitRoot = toText(payload.rootTaskId);
    if (explicitRoot) {
      return explicitRoot;
    }
    const parentTaskId = toText(payload.parentTaskId);
    if (!parentTaskId) {
      return currentTask.id;
    }
    currentTask = taskById.get(parentTaskId) || null;
  }

  return taskId;
}

function resolveContinuationResultSummary(task: Task): string {
  const summaryText = toText(task.summary);
  if (summaryText) {
    return summaryText;
  }

  const result = toRecord(task.result);
  const commitCount = Array.isArray(result.commits) ? result.commits.length : 0;
  const reviewRoundCount = Array.isArray(result.reviewRounds) ? result.reviewRounds.length : 0;
  const pullRequestUrl = toText(toRecord(result.pullRequest).url);
  const parts: string[] = [];
  if (commitCount > 0) {
    parts.push(`커밋 ${commitCount}건`);
  }
  if (reviewRoundCount > 0) {
    parts.push(`리뷰 ${reviewRoundCount}회`);
  }
  if (pullRequestUrl) {
    parts.push(`PR ${pullRequestUrl}`);
  }
  if (parts.length > 0) {
    return parts.join(' · ');
  }
  return '결과 요약이 없습니다.';
}

export function CodeExecutionPanel({
  meta,
  tasks,
  taskDetails,
  collapsedSections,
  busyAction,
  command,
  projectId,
  baseBranch,
  branchName,
  agentProvider,
  executionMode,
  needsPlanning,
  needsDesign,
  onToggleSection,
  onSetCommand,
  onSetProjectId,
  onSetBaseBranch,
  onSetBranchName,
  onSetAgentProvider,
  onSetExecutionMode,
  onSetNeedsPlanning,
  onSetNeedsDesign,
  onRunAction
}: CodeExecutionPanelProps) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [collapsedTaskById, setCollapsedTaskById] = useState<Record<string, boolean>>({});
  const [collapsedTimelineByTaskId, setCollapsedTimelineByTaskId] = useState<Record<string, boolean>>({});
  const [createPrTaskId, setCreatePrTaskId] = useState('');
  const [prBranchName, setPrBranchName] = useState('');
  const [resumeHistoryModalOpen, setResumeHistoryModalOpen] = useState(false);
  const [continueFromTaskId, setContinueFromTaskId] = useState('');
  const [continueCommand, setContinueCommand] = useState('');
  const [planSelectionsByTaskId, setPlanSelectionsByTaskId] = useState<Record<string, Record<string, string>>>({});

  const detailByTaskId = useMemo(() => {
    const next: Record<string, TaskDetail> = {};
    for (const detail of taskDetails) {
      next[detail.task.id] = detail;
    }
    return next;
  }, [taskDetails]);

  const runningTasks = useMemo(() => {
    const list = tasks
      .filter((task) => String(task.status || '').toLowerCase() === 'running' && resolveExecutionMode(task) === 'full')
      .slice();
    list.sort((left, right) => String(right.updated_at || '').localeCompare(String(left.updated_at || '')));
    return list;
  }, [tasks]);
  const planModeTasks = useMemo(() => {
    const list = tasks
      .filter((task) => {
        const status = String(task.status || '').toLowerCase();
        return resolveExecutionMode(task) === 'plan'
          && (status === 'awaiting_approval' || status === 'running' || status === 'failed');
      })
      .slice();
    list.sort((left, right) => String(right.updated_at || '').localeCompare(String(left.updated_at || '')));
    return list;
  }, [tasks]);
  const continuationCandidates = useMemo(() => {
    const list = tasks
      .filter((task) => CONTINUATION_SOURCE_STATUSES.has(String(task.status || '').toLowerCase()))
      .slice();
    list.sort((left, right) => String(right.updated_at || '').localeCompare(String(left.updated_at || '')));
    return list;
  }, [tasks]);
  const selectedContinuationTask = useMemo(
    () => continuationCandidates.find((task) => task.id === continueFromTaskId) || null,
    [continuationCandidates, continueFromTaskId]
  );
  const selectedContinuationHistory = useMemo((): ContinuationHistoryItem[] => {
    if (!selectedContinuationTask) {
      return [];
    }

    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const rootTaskId = resolveContinuationRootTaskId(selectedContinuationTask.id, taskById);
    const historyTasks = tasks
      .filter((task) => {
        const payload = toRecord(task.payload);
        const taskRootId = toText(payload.rootTaskId);
        if (task.id === rootTaskId) {
          return true;
        }
        if (taskRootId && taskRootId === rootTaskId) {
          return true;
        }
        const parentTaskId = toText(payload.parentTaskId);
        if (!taskRootId && parentTaskId && taskById.has(parentTaskId)) {
          const derivedRoot = resolveContinuationRootTaskId(task.id, taskById);
          return derivedRoot === rootTaskId;
        }
        return false;
      })
      .sort((left, right) => String(left.created_at || '').localeCompare(String(right.created_at || '')));

    if (historyTasks.length === 0) {
      historyTasks.push(selectedContinuationTask);
    }

    return historyTasks.map((task) => ({
      id: task.id,
      status: String(task.status || ''),
      command: resolveCommand(task) || toText(task.title) || task.id,
      resultSummary: resolveContinuationResultSummary(task),
      updatedAt: toText(task.updated_at)
    }));
  }, [selectedContinuationTask, tasks]);

  const runningTaskViews = useMemo(
    () => runningTasks.map((task) => {
      const detail = detailByTaskId[task.id] || null;
      const sourceTask = detail?.task || task;
      const progress = getExecutionProgress(sourceTask) || DEFAULT_PROGRESS;
      const currentStep = Math.max(0, Number(progress.currentStep || 0));
      const reviewRoundList = detail ? mergeReviewRoundList(detail) : [];
      const commandText = resolveCommand(sourceTask);
      const taskMessage = toText(sourceTask.summary) || toText(sourceTask.title);
      const pullRequestUrl = resolvePullRequestUrl(sourceTask);
      const canResumeTask = ['failed', 'running'].includes(String(sourceTask.status || '').toLowerCase());
      const hasTokenOrAuthError = /token|auth|unauthorized|forbidden|401|403|인증/i.test(String(sourceTask.last_error || ''));
      return {
        task: sourceTask,
        detail,
        progress,
        currentStep,
        elapsedSeconds: getExecutionStepElapsedSeconds(sourceTask, progress, nowMs),
        summary: summarizeExecutionStep(progress),
        reviewRoundList,
        commandText,
        taskMessage,
        pullRequestUrl,
        currentTaskBranch: resolveTaskBranch(sourceTask),
        canShowCreatePrButton: currentStep >= Math.max(1, Number(progress.totalSteps || DEFAULT_PROGRESS.totalSteps)) && !pullRequestUrl,
        canResumeTask,
        hasTokenOrAuthError
      };
    }),
    [detailByTaskId, nowMs, runningTasks]
  );
  const planTaskViews = useMemo(
    () => planModeTasks.map((task) => {
      const detail = detailByTaskId[task.id] || null;
      const sourceTask = detail?.task || task;
      const requests = resolvePlanConfirmationRequests(sourceTask, detail);
      const persistedSelections = resolvePlanSelections(sourceTask);
      const localSelections = planSelectionsByTaskId[sourceTask.id] || {};
      const selections = {
        ...persistedSelections,
        ...localSelections
      };
      const unresolvedRequestIds = requests
        .map((request) => request.id)
        .filter((requestId) => !selections[requestId]);
      const status = String(sourceTask.status || '').toLowerCase();
      return {
        task: sourceTask,
        detail,
        commandText: resolveCommand(sourceTask) || toText(sourceTask.title) || sourceTask.id,
        requests,
        selections,
        unresolvedRequestIds,
        canSave: requests.length > 0,
        canStart: status === 'awaiting_approval' && unresolvedRequestIds.length === 0,
        canResume: status === 'failed'
      };
    }),
    [detailByTaskId, planModeTasks, planSelectionsByTaskId]
  );

  const createPrTarget = useMemo(
    () => runningTaskViews.find((view) => view.task.id === createPrTaskId) || null,
    [createPrTaskId, runningTaskViews]
  );

  useEffect(() => {
    setCollapsedTaskById((current) => {
      const next: Record<string, boolean> = {};
      let changed = false;
      for (const task of runningTasks) {
        if (Object.prototype.hasOwnProperty.call(current, task.id)) {
          next[task.id] = current[task.id];
        } else {
          next[task.id] = false;
          changed = true;
        }
      }
      const hasRemoved = Object.keys(current).some((taskId) => !runningTasks.some((task) => task.id === taskId));
      if (!changed && !hasRemoved && Object.keys(current).length === Object.keys(next).length) {
        return current;
      }
      return next;
    });
  }, [runningTasks]);

  useEffect(() => {
    setCollapsedTimelineByTaskId((current) => {
      const next: Record<string, boolean> = {};
      let changed = false;
      for (const task of runningTasks) {
        if (Object.prototype.hasOwnProperty.call(current, task.id)) {
          next[task.id] = current[task.id];
        } else {
          next[task.id] = collapsedSections.code_timeline;
          changed = true;
        }
      }
      const hasRemoved = Object.keys(current).some((taskId) => !runningTasks.some((task) => task.id === taskId));
      if (!changed && !hasRemoved && Object.keys(current).length === Object.keys(next).length) {
        return current;
      }
      return next;
    });
  }, [collapsedSections.code_timeline, runningTasks]);

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
  }, [runningTasks]);

  useEffect(() => {
    if (createPrTaskId && !runningTaskViews.some((view) => view.task.id === createPrTaskId)) {
      setCreatePrTaskId('');
      setPrBranchName('');
    }
  }, [createPrTaskId, runningTaskViews]);

  useEffect(() => {
    if (planTaskViews.length === 0) {
      return;
    }
    setPlanSelectionsByTaskId((current) => {
      const next: Record<string, Record<string, string>> = {};
      let changed = false;
      for (const view of planTaskViews) {
        const existing = current[view.task.id] || {};
        next[view.task.id] = {
          ...view.selections,
          ...existing
        };
        const before = JSON.stringify(existing);
        const after = JSON.stringify(next[view.task.id]);
        if (before !== after) {
          changed = true;
        }
      }
      const hasRemoved = Object.keys(current).some((taskId) => !planTaskViews.some((view) => view.task.id === taskId));
      if (!changed && !hasRemoved) {
        return current;
      }
      return next;
    });
  }, [planTaskViews]);

  useEffect(() => {
    if (!resumeHistoryModalOpen) {
      return;
    }
    setContinueFromTaskId((current) => (
      continuationCandidates.some((task) => task.id === current)
        ? current
        : continuationCandidates[0]?.id || ''
    ));
  }, [continuationCandidates, resumeHistoryModalOpen]);

  function toggleRunningTask(taskId: string) {
    setCollapsedTaskById((current) => ({
      ...current,
      [taskId]: !current[taskId]
    }));
  }

  function toggleTaskTimeline(taskId: string) {
    setCollapsedTimelineByTaskId((current) => ({
      ...current,
      [taskId]: !current[taskId]
    }));
  }

  function selectPlanOption(taskId: string, requestId: string, optionId: string) {
    setPlanSelectionsByTaskId((current) => ({
      ...current,
      [taskId]: {
        ...(current[taskId] || {}),
        [requestId]: optionId
      }
    }));
  }

  function savePlanSelections(taskId: string) {
    const selections = planSelectionsByTaskId[taskId] || {};
    onRunAction('플랜 선택 저장', async () => {
      await saveCodeTaskPlanSelections(taskId, selections);
      return taskId;
    });
  }

  function startFromPlan(taskId: string) {
    const selections = planSelectionsByTaskId[taskId] || {};
    onRunAction('플랜 확정 후 코드 실행', async () => {
      await saveCodeTaskPlanSelections(taskId, selections);
      await runTask(taskId, { startFromPlan: true });
      return taskId;
    });
  }

  function openCreatePrModal(taskId: string, suggestedBranch: string) {
    setCreatePrTaskId(taskId);
    setPrBranchName(suggestedBranch);
  }

  function closeCreatePrModal() {
    setCreatePrTaskId('');
    setPrBranchName('');
  }

  function openResumeHistoryModal() {
    if (continuationCandidates.length === 0) {
      return;
    }
    setResumeHistoryModalOpen(true);
    setContinueFromTaskId(continuationCandidates[0]?.id || '');
    setContinueCommand('');
  }

  function closeResumeHistoryModal() {
    setResumeHistoryModalOpen(false);
    setContinueFromTaskId('');
    setContinueCommand('');
  }

  function removeContinuationTask(taskId: string) {
    const targetTask = continuationCandidates.find((task) => task.id === taskId) || null;
    if (!targetTask) {
      return;
    }
    const targetCommand = resolveCommand(targetTask) || toText(targetTask.title) || taskId;
    const confirmed = window.confirm(`이전 작업을 목록에서 제거할까요?\n\n${targetCommand}`);
    if (!confirmed) {
      return;
    }

    onRunAction('이전 작업 제거', async () => {
      await deleteTask(taskId);
      setContinueFromTaskId((current) => (current === taskId ? '' : current));
    });
  }

  function submitContinueTask() {
    const selectedTask = selectedContinuationTask;
    const normalizedCommand = continueCommand.trim();
    if (!selectedTask || !normalizedCommand) {
      return;
    }

    onRunAction('이전 작업 이어가기', async () => {
      const created = await createCodeTask({
        command: normalizedCommand,
        projectId,
        baseBranch,
        branchName,
        continueFromTaskId: selectedTask.id,
        agentProvider,
        executionMode,
        needsPlanning,
        needsDesign
      });
      return created.task.id;
    });
    closeResumeHistoryModal();
  }

  function submitCreatePullRequest() {
    const taskId = createPrTarget?.task.id || '';
    const normalizedBranchName = prBranchName.trim();
    if (!taskId || !normalizedBranchName) {
      return;
    }

    onRunAction('PR 생성', async () => {
      await createPullRequest(taskId, {
        branchName: normalizedBranchName
      });
      return taskId;
    });
    closeCreatePrModal();
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
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className={SUB_BUTTON_CLASS}
                  onClick={openResumeHistoryModal}
                  disabled={Boolean(busyAction) || continuationCandidates.length === 0}
                >
                  이전 작업 이어가기
                </button>
                <button type="button" className={SUB_BUTTON_CLASS} onClick={() => onToggleSection('code_create')}>
                  {collapsedSections.code_create ? '펼치기' : '접기'}
                </button>
              </div>
            </div>
            {!collapsedSections.code_create && (
              <form
                className="grid gap-3 md:grid-cols-5"
                onSubmit={(event) => {
                  event.preventDefault();
                  onRunAction('코드 작업 생성', async () => {
                    const created = await createCodeTask({
                      command,
                      projectId,
                      baseBranch,
                      branchName,
                      agentProvider,
                      executionMode,
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
                <label className={LABEL_CLASS}>
                  실행 모드
                  <select
                    className={INPUT_CLASS}
                    value={executionMode}
                    onChange={(event) => onSetExecutionMode(event.target.value === 'plan' ? 'plan' : 'full')}
                  >
                    <option value="full">전체 실행 (플랜+코딩)</option>
                    <option value="plan">플랜 모드 (계획/확인 요청)</option>
                  </select>
                </label>
                <label className={`${LABEL_CLASS} md:col-span-5`}>
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
                <div className='flex gap-2 md:col-span-2'>
                  <label className="flex items-center gap-2 text-sm text-slate-700">
                    <input type="checkbox" checked={needsPlanning} onChange={(event) => onSetNeedsPlanning(event.target.checked)} />
                    기획 단계 실행
                  </label>
                  <label className="flex items-center gap-2 text-sm text-slate-700">
                    <input type="checkbox" checked={needsDesign} onChange={(event) => onSetNeedsDesign(event.target.checked)} />
                    디자인 단계 실행
                  </label>
                </div>
                <div className="md:col-span-3 flex justify-end">
                  <button type="submit" className={BUTTON_CLASS} disabled={Boolean(busyAction)}>실행</button>
                </div>
              </form>
            )}
          </section>

          <section className="mt-4 border-t border-slate-200 pt-4">
            <div className="mb-4 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-900">플랜 모드 확인 요청 ({planTaskViews.length})</h3>
            </div>
            {planTaskViews.length === 0 && (
              <p className={EMPTY_CLASS}>선택 대기 중인 플랜 모드 작업이 없습니다.</p>
            )}
            {planTaskViews.length > 0 && (
              <div className="space-y-3">
                {planTaskViews.map((view) => (
                  <article key={`plan-task-${view.task.id}`} className="rounded-xl border border-slate-200 bg-white p-3">
                    <header className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="whitespace-pre-wrap break-words text-sm font-semibold text-slate-900">{view.commandText}</p>
                        <p className="mt-1 text-xs text-slate-600">{mapStatusLabel(view.task.status)}</p>
                      </div>
                      <StatusBadge status={view.task.status} label={mapStatusLabel(view.task.status)} />
                    </header>
                    <p className="mt-2 whitespace-pre-wrap break-words text-xs text-slate-700">
                      {toText(view.task.summary) || '플랜 모드 설명이 아직 없습니다.'}
                    </p>

                    {view.requests.length === 0 ? (
                      <p className="mt-3 text-xs text-slate-600">
                        {view.canStart
                          ? '추가 확인 항목이 없어 바로 코드 실행을 시작할 수 있습니다.'
                          : '확인 요청 항목을 불러오는 중입니다.'}
                      </p>
                    ) : (
                      <div className="mt-3 grid gap-2">
                        {view.requests.map((request) => {
                          const selectedOptionId = normalizeIdentifier(view.selections[request.id]);
                          return (
                            <section key={`${view.task.id}-${request.id}`} className="rounded-lg border border-slate-200 bg-slate-50 p-2">
                              <p className="text-xs font-semibold text-slate-900">{request.title}</p>
                              <p className="mt-1 text-xs text-slate-700">{request.question}</p>
                              <div className="mt-2 flex flex-wrap gap-2">
                                {request.options.map((option) => {
                                  const selected = selectedOptionId === option.id;
                                  return (
                                    <button
                                      key={`${view.task.id}-${request.id}-${option.id}`}
                                      type="button"
                                      className={modeButtonClass(selected)}
                                      onClick={() => selectPlanOption(view.task.id, request.id, option.id)}
                                      disabled={Boolean(busyAction)}
                                    >
                                      {option.label}{option.recommended ? ' (권장)' : ''}
                                    </button>
                                  );
                                })}
                              </div>
                              <p className="mt-1 text-[11px] text-slate-600">
                                {request.options.find((option) => option.id === selectedOptionId)?.description
                                  || '옵션을 선택해 주세요.'}
                              </p>
                            </section>
                          );
                        })}
                      </div>
                    )}

                    {view.unresolvedRequestIds.length > 0 && (
                      <p className="mt-2 text-xs text-amber-700">
                        미선택 항목: {view.unresolvedRequestIds.join(', ')}
                      </p>
                    )}

                    <section className="mt-3 flex flex-wrap justify-end gap-2">
                      {view.canSave && (
                        <button
                          type="button"
                          className={SUB_BUTTON_CLASS}
                          onClick={() => savePlanSelections(view.task.id)}
                          disabled={Boolean(busyAction)}
                        >
                          선택 저장
                        </button>
                      )}
                      {view.canStart && (
                        <button
                          type="button"
                          className={BUTTON_CLASS}
                          onClick={() => startFromPlan(view.task.id)}
                          disabled={Boolean(busyAction)}
                        >
                          플랜 확정 후 코드 실행
                        </button>
                      )}
                      {view.canResume && (
                        <button
                          type="button"
                          className={BUTTON_CLASS}
                          onClick={() => onRunAction('코드 작업 재개', async () => {
                            await resumeCodeTask(view.task.id);
                            return view.task.id;
                          })}
                          disabled={Boolean(busyAction)}
                        >
                          플랜 모드 재개
                        </button>
                      )}
                    </section>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="mt-4 border-t border-slate-200 pt-4">
            <div className="mb-4 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-900">실행 중 코드 작업 ({runningTasks.length})</h3>
              <button type="button" className={SUB_BUTTON_CLASS} onClick={() => onToggleSection('code_tasks')}>
                {collapsedSections.code_tasks ? '펼치기' : '접기'}
              </button>
            </div>

            {!collapsedSections.code_tasks && (
              <div className="space-y-3">
                {runningTaskViews.length === 0 && (
                  <p className={EMPTY_CLASS}>현재 실행 중인 코드 작업이 없습니다.</p>
                )}

                {runningTaskViews.map((view) => {
                  const isCollapsed = Boolean(collapsedTaskById[view.task.id]);
                  const timelineCollapsed = collapsedTimelineByTaskId[view.task.id] ?? collapsedSections.code_timeline;
                  return (
                    <article key={view.task.id} className="rounded-xl border border-slate-200 bg-white p-3">
                      <header className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="whitespace-pre-wrap break-words text-sm font-semibold text-slate-900">
                            {view.commandText || view.task.title || view.task.id}
                          </p>
                          <p className="mt-1 text-xs text-slate-500">{mapStatusLabel(view.task.status)}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          <StatusBadge status={view.task.status} label={mapStatusLabel(view.task.status)} />
                          <button type="button" className={SUB_BUTTON_CLASS} onClick={() => toggleRunningTask(view.task.id)}>
                            {isCollapsed ? '펼치기' : '접기'}
                          </button>
                        </div>
                      </header>

                      {!isCollapsed && (
                        <div className="mt-3 grid gap-3">
                          <section className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                            <h4 className="text-sm font-semibold text-slate-900">작업 메시지</h4>
                            <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700">
                              {view.taskMessage || '작업 메시지가 아직 없습니다.'}
                            </p>
                          </section>

                          <section className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                            <h4 className="text-sm font-semibold text-slate-900">작업 요청 메시지</h4>
                            <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-700">
                              {view.commandText || '작업 요청 메시지가 아직 없습니다.'}
                            </p>
                          </section>

                          <section className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                            <div className="flex items-start justify-between gap-3">
                              <h4 className="text-sm font-semibold text-slate-900">세부 진행현황</h4>
                              {view.elapsedSeconds !== null && (
                                <p className="text-xs font-medium text-slate-600">{view.elapsedSeconds}초째 진행 중</p>
                              )}
                            </div>
                            <p className="mt-1 text-xs text-slate-500">
                              {view.progress.currentStep}/{view.progress.totalSteps}
                              {view.progress.reviewTotalRounds > 0 && ` · 리뷰 ${view.progress.reviewRound}/${view.progress.reviewTotalRounds}`}
                              {view.progress.label ? ` · ${view.progress.label}` : ''}
                            </p>
                            <p className="mt-1 text-xs text-slate-700">{view.summary}</p>
                            <ul className="mt-2 rounded-md border border-slate-200 bg-white p-2 text-xs">
                              {EXECUTION_STEP_ITEMS.map((item) => {
                                const state = stepState(view.currentStep, item.step);
                                return (
                                  <li key={`${view.task.id}-step-${item.step}`} className={`py-0.5 ${stepStateClass(state)}`}>
                                    {String(item.step).padStart(2, '0')}. {item.label}
                                  </li>
                                );
                              })}
                            </ul>
                          </section>

                          <section className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                            <div className="mb-2 flex items-center justify-between gap-3">
                              <h4 className="text-sm font-semibold text-slate-900">리뷰 라운드 내용</h4>
                              <p className="text-xs text-slate-500">{view.reviewRoundList.length}건</p>
                            </div>
                            {view.reviewRoundList.length === 0 && (
                              <p className="text-xs text-slate-600">
                                리뷰 라운드가 시작되면 검토 결과와 수정 내역이 여기에 표시됩니다.
                              </p>
                            )}
                            <div className="grid gap-2">
                              {view.reviewRoundList.map((round) => {
                                const findings = round.review?.findings || [];
                                return (
                                  <details key={`${view.task.id}-round-${round.round}`} className="rounded-lg border border-slate-200 bg-white px-3 py-2" open>
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
                                              <li key={`${view.task.id}-round-${round.round}-${finding.id || finding.title || index}`}>
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
                                      {round.review?.residualRisks.length ? (
                                        <p className="text-xs text-rose-700">잔여 리스크: {round.review.residualRisks.join(', ')}</p>
                                      ) : null}
                                    </div>
                                  </details>
                                );
                              })}
                            </div>
                          </section>

                          {view.detail ? (
                            <TaskTimeline
                              executions={view.detail.executions}
                              collapsed={timelineCollapsed}
                              onToggle={() => toggleTaskTimeline(view.task.id)}
                            />
                          ) : (
                            <section className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                              <h4 className="text-sm font-semibold text-slate-900">작업 타임라인</h4>
                              <p className="mt-1 text-xs text-slate-600">타임라인 상세를 불러오는 중입니다.</p>
                            </section>
                          )}

                          {view.task.last_error && (
                            <p className="text-sm text-rose-700">오류: {view.task.last_error}</p>
                          )}

                          <section className="flex flex-wrap justify-end gap-2">
                            {view.canShowCreatePrButton && (
                              <button
                                type="button"
                                className={BUTTON_CLASS}
                                onClick={() => openCreatePrModal(view.task.id, view.currentTaskBranch)}
                                disabled={Boolean(busyAction)}
                              >
                                PR 생성
                              </button>
                            )}
                            {view.canResumeTask && (
                              <button
                                type="button"
                                className={BUTTON_CLASS}
                                onClick={() => onRunAction('코드 작업 재개', async () => {
                                  await resumeCodeTask(view.task.id);
                                  return view.task.id;
                                })}
                                disabled={Boolean(busyAction)}
                              >
                                코드 작업 재개
                              </button>
                            )}
                          </section>

                          {view.canResumeTask && (
                            <p className="text-xs text-slate-600">
                              실행이 중단/정체된 경우 <strong>코드 작업 재개</strong>로 이어서 진행할 수 있습니다.
                              {view.hasTokenOrAuthError ? ' 토큰/인증 오류가 원인이면 토큰 갱신 후 재개하세요.' : ''}
                            </p>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}

      {resumeHistoryModalOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/55 p-4">
          <section className="w-full max-w-2xl rounded-xl border border-slate-200 bg-white p-4 shadow-lg">
            <h4 className="text-base font-semibold text-slate-900">이전 작업 이어가기</h4>
            <p className="mt-1 text-sm text-slate-700">
              이전 코드 작업의 맥락을 이어서 새 코드 작업을 시작합니다. 새 작업 명령은 필수입니다.
            </p>
            {continuationCandidates.length === 0 ? (
              <p className="mt-3 text-sm text-slate-600">이어갈 수 있는 이전 코드 작업이 없습니다.</p>
            ) : (
              <div className="mt-3 max-h-72 space-y-2 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-2">
                {continuationCandidates.map((task) => {
                  const taskPayload = toRecord(task.payload);
                  const isSelected = continueFromTaskId === task.id;
                  const taskCommand = toText(taskPayload.command) || toText(task.title);
                  return (
                    <div
                      key={task.id}
                      className={`flex items-start gap-2 rounded-md border px-2 py-2 ${
                        isSelected ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'
                      }`}
                    >
                      <label className="flex min-w-0 flex-1 cursor-pointer gap-2">
                        <input
                          type="radio"
                          className="mt-1"
                          name="continueFromTaskId"
                          value={task.id}
                          checked={isSelected}
                          onChange={() => setContinueFromTaskId(task.id)}
                        />
                        <span className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-slate-900">{taskCommand}</p>
                          <p className="mt-0.5 text-xs text-slate-600">
                            {mapStatusLabel(task.status)} · 업데이트 {formatDateTime(task.updated_at)}
                          </p>
                          <p className="mt-1 whitespace-pre-wrap break-words text-xs text-slate-700">
                            {toText(task.summary) || '작업 요약이 없습니다.'}
                          </p>
                        </span>
                      </label>
                      <button
                        type="button"
                        className="rounded border border-rose-200 px-2 py-1 text-xs font-medium text-rose-700 hover:bg-rose-50"
                        onClick={() => removeContinuationTask(task.id)}
                        disabled={Boolean(busyAction)}
                      >
                        제거
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <section className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <h5 className="text-sm font-semibold text-slate-900">선택 작업 히스토리 타임라인</h5>
              {!selectedContinuationTask && (
                <p className="mt-1 text-xs text-slate-600">작업을 선택하면 입력 명령과 결과 히스토리를 표시합니다.</p>
              )}
              {selectedContinuationTask && selectedContinuationHistory.length === 0 && (
                <p className="mt-1 text-xs text-slate-600">표시할 히스토리가 없습니다.</p>
              )}
              {selectedContinuationTask && selectedContinuationHistory.length > 0 && (
                <div className="mt-2 max-h-56 overflow-y-auto rounded-md border border-slate-200 bg-white p-2">
                  <ol className="space-y-2">
                    {selectedContinuationHistory.map((historyItem, index) => {
                      const selected = historyItem.id === selectedContinuationTask.id;
                      return (
                        <li
                          key={`continuation-history-${historyItem.id}`}
                          className={`rounded-md border px-2 py-2 ${
                            selected ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'
                          }`}
                        >
                          <p className="text-xs font-semibold text-slate-900">
                            {String(index + 1).padStart(2, '0')}. {mapStatusLabel(historyItem.status)}
                            {historyItem.updatedAt ? ` · ${formatDateTime(historyItem.updatedAt)}` : ''}
                          </p>
                          <p className="mt-1 whitespace-pre-wrap break-words text-xs text-slate-700">
                            <strong>입력:</strong> {historyItem.command}
                          </p>
                          <p className="mt-1 whitespace-pre-wrap break-words text-xs text-slate-700">
                            <strong>결과:</strong> {historyItem.resultSummary}
                          </p>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              )}
            </section>
            <label className={`${LABEL_CLASS} mt-3`}>
              새 작업 명령(필수)
              <textarea
                className={INPUT_CLASS}
                value={continueCommand}
                onChange={(event) => setContinueCommand(event.target.value)}
                rows={3}
                placeholder="예: 이전 작업의 캐시 전략은 유지하고, 상세 페이지 에러 복구 흐름만 보완"
              />
            </label>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className={SUB_BUTTON_CLASS}
                onClick={closeResumeHistoryModal}
                disabled={Boolean(busyAction)}
              >
                취소
              </button>
              <button
                type="button"
                className={BUTTON_CLASS}
                onClick={submitContinueTask}
                disabled={Boolean(busyAction) || !selectedContinuationTask || !continueCommand.trim()}
              >
                이어서 작업 시작
              </button>
            </div>
          </section>
        </div>
      )}

      {createPrTarget && (
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
                onClick={closeCreatePrModal}
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
