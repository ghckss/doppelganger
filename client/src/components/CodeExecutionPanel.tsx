import { useEffect, useMemo, useState } from 'react';
import {
  approveCodeTaskGate,
  createCodeTask,
  createPullRequest,
  deleteTask,
  resumeCodeTask,
  updateCodeTaskStatus
} from '../api';
import type { MetaResponse, Task, TaskDetail } from '../types';
import type {
  CollapsibleSectionId,
  CollapsibleState,
  ExecutionProgress,
  RunnerGate
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
  PANEL_CLASS,
  StatusBadge,
  SUB_BUTTON_CLASS
} from './common';
import { TaskTimeline } from './TaskTimeline';

type MergeFindingView = {
  id: string;
  severity: string;
  title: string;
  description: string;
  fileRefs: string[];
  action: string;
};

type ChunkView = {
  id: string;
  title: string;
  status: string;
  executorSummary: string;
  testsRun: string[];
  acceptanceCriteria: string[];
  mustFix: MergeFindingView[];
  shouldFix: MergeFindingView[];
  advisory: MergeFindingView[];
  patchCommits: string[];
  remainingKnownIssues: MergeFindingView[];
};

type RequirementContractView = {
  summary: string;
  goals: string[];
  nonGoals: string[];
  constraints: string[];
  acceptanceCriteria: string[];
  edgeCases: string[];
  openQuestions: string[];
};

type ImplementationPlanView = {
  summary: string;
  implementationSteps: string[];
  filesLikelyToChange: string[];
  architectureImpact: string[];
  risks: string[];
  rolloutConcerns: string[];
  validationStrategy: string[];
  chunkCommitBoundaries: string[];
  taskBreakdown: Array<{ id: string; title: string; acceptanceCriteria: string[] }>;
};

type FinalValidationView = {
  contractMet: boolean;
  regression: string;
  summary: string;
  residualRisks: string[];
  acceptanceResults: Array<{ criterion: string; status: string; evidence: string }>;
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
  onToggleSection: (sectionId: CollapsibleSectionId) => void;
  onSetCommand: (value: string) => void;
  onSetProjectId: (value: string) => void;
  onSetBaseBranch: (value: string) => void;
  onSetBranchName: (value: string) => void;
  onSetAgentProvider: (value: string) => void;
  onRunAction: (label: string, action: () => Promise<string | string[] | void>) => void;
};

type ManualCodeTaskStatus = 'running' | 'awaiting_approval' | 'failed' | 'done';

const EXECUTION_STEP_ITEMS = [
  { step: 1, label: '작업 환경 점검 + 브랜치 준비' },
  { step: 2, label: '요구사항 계약 작성 (Gate 1)' },
  { step: 3, label: '구현 계획 수립 (Gate 2)' },
  { step: 4, label: 'chunk 구현 · 리뷰 스웜 · 커밋' },
  { step: 5, label: '최종 검증' },
  { step: 6, label: 'runner 워크플로 완료' }
] as const;

const CONTINUATION_SOURCE_STATUSES = new Set(['done', 'awaiting_approval', 'failed']);
const MANUAL_STATUS_OPTIONS: ManualCodeTaskStatus[] = ['running', 'awaiting_approval', 'failed', 'done'];

const DEFAULT_PROGRESS: ExecutionProgress = {
  phase: '',
  label: '',
  currentStep: 0,
  totalSteps: 6,
  percent: 0,
  gate: '',
  chunkIndex: 0,
  chunkTotal: 0
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

function toTextList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => toText(entry)).filter(Boolean);
}

function normalizeManualCodeTaskStatus(value: unknown): ManualCodeTaskStatus {
  const normalized = toText(value).toLowerCase();
  if (MANUAL_STATUS_OPTIONS.includes(normalized as ManualCodeTaskStatus)) {
    return normalized as ManualCodeTaskStatus;
  }
  return 'running';
}

function parseMergeFinding(value: unknown): MergeFindingView {
  const source = toRecord(value);
  return {
    id: toText(source.id),
    severity: toText(source.severity),
    title: toText(source.title),
    description: toText(source.description),
    fileRefs: toTextList(source.fileRefs),
    action: toText(source.action)
  };
}

function parseMergeFindingList(value: unknown): MergeFindingView[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => parseMergeFinding(entry)).filter((finding) => finding.title || finding.description);
}

function runnerState(task: Task): Record<string, unknown> {
  return toRecord(toRecord(task.result).runner);
}

function resolveRequirementContract(task: Task): RequirementContractView | null {
  const source = toRecord(runnerState(task).requirementContract);
  if (Object.keys(source).length === 0) {
    return null;
  }
  return {
    summary: toText(source.summary),
    goals: toTextList(source.goals),
    nonGoals: toTextList(source.nonGoals),
    constraints: toTextList(source.constraints),
    acceptanceCriteria: toTextList(source.acceptanceCriteria),
    edgeCases: toTextList(source.edgeCases),
    openQuestions: toTextList(source.openQuestions)
  };
}

function resolveImplementationPlan(task: Task): ImplementationPlanView | null {
  const source = toRecord(runnerState(task).implementationPlan);
  if (Object.keys(source).length === 0) {
    return null;
  }
  const taskBreakdown = Array.isArray(source.taskBreakdown)
    ? source.taskBreakdown.map((entry) => {
      const chunk = toRecord(entry);
      return {
        id: toText(chunk.id),
        title: toText(chunk.title),
        acceptanceCriteria: toTextList(chunk.acceptanceCriteria)
      };
    })
    : [];
  return {
    summary: toText(source.summary),
    implementationSteps: toTextList(source.implementationSteps),
    filesLikelyToChange: toTextList(source.filesLikelyToChange),
    architectureImpact: toTextList(source.architectureImpact),
    risks: toTextList(source.risks),
    rolloutConcerns: toTextList(source.rolloutConcerns),
    validationStrategy: toTextList(source.validationStrategy),
    chunkCommitBoundaries: toTextList(source.chunkCommitBoundaries),
    taskBreakdown
  };
}

function resolveChunks(task: Task): ChunkView[] {
  const chunks = runnerState(task).chunks;
  if (!Array.isArray(chunks)) {
    return [];
  }
  return chunks.map((entry, index) => {
    const source = toRecord(entry);
    const merged = toRecord(source.mergedReview);
    return {
      id: toText(source.id) || `chunk_${index + 1}`,
      title: toText(source.title) || `구현 단위 ${index + 1}`,
      status: toText(source.status) || 'pending',
      executorSummary: toText(source.executorSummary),
      testsRun: toTextList(source.testsRun),
      acceptanceCriteria: toTextList(source.acceptanceCriteria),
      mustFix: parseMergeFindingList(merged.mustFix),
      shouldFix: parseMergeFindingList(merged.shouldFix),
      advisory: parseMergeFindingList(merged.advisory),
      patchCommits: toTextList(source.patchCommits),
      remainingKnownIssues: parseMergeFindingList(source.remainingKnownIssues)
    };
  });
}

type RefinementView = {
  iteration: number;
  status: string;
  rationale: string;
  title: string;
};

const REFINEMENT_STATUS_LABEL: Record<string, string> = {
  applied: '개선 반영됨',
  no_improvement: '개선점 없음(종료)',
  frame_exceeding: '프레임 초과 → 별도 작업 권장',
  no_progress: '진행 없음(종료)'
};

function resolveRefinements(task: Task): RefinementView[] {
  const refinements = runnerState(task).refinements;
  if (!Array.isArray(refinements)) {
    return [];
  }
  return refinements.map((entry, index) => {
    const source = toRecord(entry);
    return {
      iteration: Number(source.iteration) || index + 1,
      status: toText(source.status),
      rationale: toText(source.rationale),
      title: toText(source.title)
    };
  });
}

function resolveFinalValidation(task: Task): FinalValidationView | null {
  const source = toRecord(runnerState(task).finalValidation);
  if (Object.keys(source).length === 0) {
    return null;
  }
  return {
    contractMet: Boolean(source.contractMet),
    regression: toText(source.regression),
    summary: toText(source.summary),
    residualRisks: toTextList(source.residualRisks),
    acceptanceResults: Array.isArray(source.acceptanceResults)
      ? source.acceptanceResults.map((entry) => {
        const record = toRecord(entry);
        return {
          criterion: toText(record.criterion),
          status: toText(record.status),
          evidence: toText(record.evidence)
        };
      })
      : []
  };
}

function resolveGate(task: Task): RunnerGate {
  const progress = getExecutionProgress(task);
  return progress?.gate || '';
}

type RiskReviewView = {
  deletions: string[];
  dependencyChanges: string[];
  envChanges: string[];
};

function resolveRiskReview(task: Task): RiskReviewView | null {
  const source = toRecord(runnerState(task).riskReview);
  if (Object.keys(source).length === 0) {
    return null;
  }
  return {
    deletions: toTextList(source.deletions),
    dependencyChanges: toTextList(source.dependencyChanges),
    envChanges: toTextList(source.envChanges)
  };
}

type PlanPatchView = {
  reason: string;
  proposedChange: string;
};

function resolvePlanPatchRequest(task: Task): PlanPatchView | null {
  const source = toRecord(runnerState(task).planPatchRequest);
  if (Object.keys(source).length === 0) {
    return null;
  }
  return {
    reason: toText(source.reason),
    proposedChange: toText(source.proposedChange)
  };
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

function resolveCanCreatePullRequest(task: Task): boolean {
  const payload = toRecord(task.payload);
  const result = toRecord(task.result);
  if (typeof result.canCreatePullRequest === 'boolean') {
    return result.canCreatePullRequest;
  }
  if (typeof payload.canCreatePullRequest === 'boolean') {
    return payload.canCreatePullRequest;
  }
  const remoteUrl = toText(result.remoteUrl) || toText(payload.remoteUrl);
  return Boolean(remoteUrl);
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
  const chunkCount = Array.isArray(runnerState(task).chunks) ? (runnerState(task).chunks as unknown[]).length : 0;
  const pullRequestUrl = toText(toRecord(result.pullRequest).url);
  const parts: string[] = [];
  if (commitCount > 0) {
    parts.push(`커밋 ${commitCount}건`);
  }
  if (chunkCount > 0) {
    parts.push(`chunk ${chunkCount}개`);
  }
  if (pullRequestUrl) {
    parts.push(`PR ${pullRequestUrl}`);
  }
  if (parts.length > 0) {
    return parts.join(' · ');
  }
  return '결과 요약이 없습니다.';
}

function TextBlock({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) {
    return null;
  }
  return (
    <div>
      <p className="text-xs font-semibold text-slate-900">{title}</p>
      <ul className="mt-1 list-disc pl-5 text-xs text-slate-700">
        {items.map((item, index) => (
          <li key={`${title}-${index}`} className="whitespace-pre-wrap break-words">{item}</li>
        ))}
      </ul>
    </div>
  );
}

function FindingList({ title, findings, tone }: { title: string; findings: MergeFindingView[]; tone: 'rose' | 'amber' | 'slate' }) {
  if (findings.length === 0) {
    return null;
  }
  const toneClass = tone === 'rose'
    ? 'border-rose-200 bg-rose-50 text-rose-900'
    : tone === 'amber'
      ? 'border-amber-200 bg-amber-50 text-amber-900'
      : 'border-slate-200 bg-slate-50 text-slate-700';
  return (
    <div className={`rounded-md border p-2 ${toneClass}`}>
      <p className="text-xs font-semibold">{title} ({findings.length})</p>
      <ul className="mt-1 list-disc pl-5 text-xs">
        {findings.map((finding, index) => (
          <li key={`${title}-${finding.id || index}`} className="whitespace-pre-wrap break-words">
            <strong>{finding.severity || '-'}</strong>
            {finding.title ? ` · ${finding.title}` : ''}
            {finding.description ? ` — ${finding.description}` : ''}
            {finding.fileRefs.length > 0 ? ` (${finding.fileRefs.join(', ')})` : ''}
            {finding.action ? ` → ${finding.action}` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
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
  onToggleSection,
  onSetCommand,
  onSetProjectId,
  onSetBaseBranch,
  onSetBranchName,
  onSetAgentProvider,
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
  const [statusDraftByTaskId, setStatusDraftByTaskId] = useState<Record<string, ManualCodeTaskStatus>>({});
  const [regenerateOpenByTaskId, setRegenerateOpenByTaskId] = useState<Record<string, boolean>>({});
  const [regenerateDraftByTaskId, setRegenerateDraftByTaskId] = useState<Record<string, string>>({});
  const [answerOpenByTaskId, setAnswerOpenByTaskId] = useState<Record<string, boolean>>({});
  const [answerDraftByTaskId, setAnswerDraftByTaskId] = useState<Record<string, string[]>>({});

  const detailByTaskId = useMemo(() => {
    const next: Record<string, TaskDetail> = {};
    for (const detail of taskDetails) {
      next[detail.task.id] = detail;
    }
    return next;
  }, [taskDetails]);

  const gateTasks = useMemo(() => {
    const list = tasks
      .filter((task) => {
        const status = String(task.status || '').toLowerCase();
        const gate = resolveGate(task);
        return status === 'awaiting_approval' && (gate === 'spec' || gate === 'plan' || gate === 'risk' || gate === 'plan_patch');
      })
      .slice();
    list.sort((left, right) => String(right.updated_at || '').localeCompare(String(left.updated_at || '')));
    return list;
  }, [tasks]);

  const runningTasks = useMemo(() => {
    const list = tasks
      .filter((task) => {
        const status = String(task.status || '').toLowerCase();
        const gate = resolveGate(task);
        if (status === 'running' || status === 'failed') {
          return true;
        }
        return status === 'awaiting_approval' && gate === '';
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

  const gateTaskViews = useMemo(
    () => gateTasks.map((task) => {
      const detail = detailByTaskId[task.id] || null;
      const sourceTask = detail?.task || task;
      return {
        task: sourceTask,
        gate: resolveGate(sourceTask),
        commandText: resolveCommand(sourceTask) || toText(sourceTask.title) || sourceTask.id,
        contract: resolveRequirementContract(sourceTask),
        plan: resolveImplementationPlan(sourceTask),
        riskReview: resolveRiskReview(sourceTask),
        planPatch: resolvePlanPatchRequest(sourceTask)
      };
    }),
    [detailByTaskId, gateTasks]
  );

  const runningTaskViews = useMemo(
    () => runningTasks.map((task) => {
      const detail = detailByTaskId[task.id] || null;
      const sourceTask = detail?.task || task;
      const progress = getExecutionProgress(sourceTask) || DEFAULT_PROGRESS;
      const currentStep = Math.max(0, Number(progress.currentStep || 0));
      const commandText = resolveCommand(sourceTask);
      const taskMessage = toText(sourceTask.summary) || toText(sourceTask.title);
      const pullRequestUrl = resolvePullRequestUrl(sourceTask);
      const canResumeTask = ['failed', 'running'].includes(String(sourceTask.status || '').toLowerCase());
      const hasTokenOrAuthError = /token|auth|unauthorized|forbidden|401|403|인증/i.test(String(sourceTask.last_error || ''));
      const canCreatePullRequest = resolveCanCreatePullRequest(sourceTask);
      return {
        task: sourceTask,
        detail,
        progress,
        currentStep,
        elapsedSeconds: getExecutionStepElapsedSeconds(sourceTask, progress, nowMs),
        summary: summarizeExecutionStep(progress),
        chunks: resolveChunks(sourceTask),
        refinements: resolveRefinements(sourceTask),
        finalValidation: resolveFinalValidation(sourceTask),
        commandText,
        taskMessage,
        pullRequestUrl,
        currentTaskBranch: resolveTaskBranch(sourceTask),
        canShowCreatePrButton:
          canCreatePullRequest
          && currentStep >= Math.max(1, Number(progress.totalSteps || DEFAULT_PROGRESS.totalSteps))
          && !pullRequestUrl,
        canResumeTask,
        hasTokenOrAuthError
      };
    }),
    [detailByTaskId, nowMs, runningTasks]
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
    setStatusDraftByTaskId((current) => {
      const next: Record<string, ManualCodeTaskStatus> = {};
      let changed = false;
      for (const task of runningTasks) {
        const status = normalizeManualCodeTaskStatus(task.status);
        if (Object.prototype.hasOwnProperty.call(current, task.id)) {
          next[task.id] = current[task.id];
        } else {
          next[task.id] = status;
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

  function selectManualStatus(taskId: string, status: ManualCodeTaskStatus) {
    setStatusDraftByTaskId((current) => ({
      ...current,
      [taskId]: status
    }));
  }

  function approveGate(taskId: string, gate: RunnerGate) {
    if (gate !== 'spec' && gate !== 'plan') {
      return;
    }
    onRunAction(gate === 'spec' ? '요구사항 계약 승인' : '구현 계획 승인', async () => {
      await approveCodeTaskGate(taskId, { gate, decision: 'approve' });
      return taskId;
    });
  }

  function approveRunnerGate(taskId: string, gate: RunnerGate) {
    if (gate !== 'risk' && gate !== 'plan_patch') {
      return;
    }
    onRunAction(gate === 'risk' ? '위험 변경 승인' : '계획 패치 승인', async () => {
      await approveCodeTaskGate(taskId, { gate, decision: 'approve' });
      return taskId;
    });
  }

  function rejectRunnerGate(taskId: string, gate: RunnerGate) {
    if (gate !== 'risk' && gate !== 'plan_patch') {
      return;
    }
    const confirmed = window.confirm(gate === 'risk'
      ? '위험 변경을 거부하고 작업을 중단할까요?'
      : '계획 패치를 거부하고 작업을 중단할까요?');
    if (!confirmed) {
      return;
    }
    onRunAction(gate === 'risk' ? '위험 변경 거부' : '계획 패치 거부', async () => {
      await approveCodeTaskGate(taskId, { gate, decision: 'reject' });
      return taskId;
    });
  }

  function openRegenerate(taskId: string) {
    setRegenerateOpenByTaskId((current) => ({ ...current, [taskId]: true }));
  }

  function closeRegenerate(taskId: string) {
    setRegenerateOpenByTaskId((current) => ({ ...current, [taskId]: false }));
  }

  function setRegenerateDraft(taskId: string, value: string) {
    setRegenerateDraftByTaskId((current) => ({ ...current, [taskId]: value }));
  }

  function submitRegenerate(taskId: string, gate: RunnerGate) {
    if (gate !== 'spec' && gate !== 'plan') {
      return;
    }
    const feedback = (regenerateDraftByTaskId[taskId] || '').trim();
    if (!feedback) {
      return;
    }
    onRunAction(gate === 'spec' ? '요구사항 계약 재생성' : '구현 계획 재생성', async () => {
      await approveCodeTaskGate(taskId, { gate, decision: 'regenerate', feedback });
      setRegenerateOpenByTaskId((current) => ({ ...current, [taskId]: false }));
      setRegenerateDraftByTaskId((current) => ({ ...current, [taskId]: '' }));
      return taskId;
    });
  }

  function openAnswers(taskId: string, questionCount: number) {
    setAnswerDraftByTaskId((current) => ({
      ...current,
      [taskId]: (current[taskId] && current[taskId].length === questionCount)
        ? current[taskId]
        : Array.from({ length: questionCount }, () => '')
    }));
    setRegenerateOpenByTaskId((current) => ({ ...current, [taskId]: false }));
    setAnswerOpenByTaskId((current) => ({ ...current, [taskId]: true }));
  }

  function closeAnswers(taskId: string) {
    setAnswerOpenByTaskId((current) => ({ ...current, [taskId]: false }));
  }

  function setAnswer(taskId: string, index: number, value: string) {
    setAnswerDraftByTaskId((current) => {
      const next = (current[taskId] || []).slice();
      next[index] = value;
      return { ...current, [taskId]: next };
    });
  }

  function submitAnswers(taskId: string, questions: string[]) {
    const answers = answerDraftByTaskId[taskId] || [];
    const pairs = questions
      .map((question, index) => ({ question, answer: (answers[index] || '').trim() }))
      .filter((pair) => pair.answer);
    if (pairs.length === 0) {
      return;
    }
    const feedback = [
      '아래는 열린 질문(open questions)에 대한 답변입니다. 이 답변을 반영해 요구사항 계약을 갱신하고, 해결된 항목은 openQuestions에서 제거해 주세요.',
      ...pairs.map((pair, index) => `${index + 1}. Q: ${pair.question}\n   A: ${pair.answer}`)
    ].join('\n');
    onRunAction('열린 질문 답변 반영', async () => {
      await approveCodeTaskGate(taskId, { gate: 'spec', decision: 'regenerate', feedback });
      setAnswerOpenByTaskId((current) => ({ ...current, [taskId]: false }));
      setAnswerDraftByTaskId((current) => ({ ...current, [taskId]: [] }));
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
        agentProvider
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

  function submitTaskStatusChange(taskId: string) {
    const targetStatus = statusDraftByTaskId[taskId] || 'running';
    onRunAction('코드 작업 상태 변경', async () => {
      await updateCodeTaskStatus(taskId, {
        status: targetStatus
      });
      return taskId;
    });
  }

  return (
    <section className={`${PANEL_CLASS} border-amber-200 bg-amber-50/70`}>
      <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-100/80 px-3 py-2">
        <h2 className="text-base font-semibold text-slate-800">코드 작업 (runner 워크플로)</h2>
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
                className="grid gap-3 md:grid-cols-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  onRunAction('코드 작업 생성', async () => {
                    const created = await createCodeTask({
                      command,
                      projectId,
                      baseBranch,
                      branchName,
                      agentProvider
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
                <label className={`${LABEL_CLASS} md:col-span-4`}>
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
                <p className="md:col-span-4 text-xs text-slate-600">
                  실행하면 요구사항 계약(Gate 1) → 구현 계획(Gate 2) 순으로 승인 게이트가 표시됩니다.
                </p>
                <div className="md:col-span-4 flex justify-end">
                  <button type="submit" className={BUTTON_CLASS} disabled={Boolean(busyAction)}>실행</button>
                </div>
              </form>
            )}
          </section>

          <section className="mt-4 border-t border-slate-200 pt-4">
            <div className="mb-4 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-900">승인 게이트 ({gateTaskViews.length})</h3>
            </div>
            {gateTaskViews.length === 0 && (
              <p className={EMPTY_CLASS}>승인 대기 중인 게이트가 없습니다.</p>
            )}
            {gateTaskViews.length > 0 && (
              <div className="space-y-3">
                {gateTaskViews.map((view) => (
                  <article key={`gate-task-${view.task.id}`} className="rounded-xl border border-amber-300 bg-white p-3">
                    <header className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="whitespace-pre-wrap break-words text-sm font-semibold text-slate-900">{view.commandText}</p>
                        <p className="mt-1 text-xs font-medium text-amber-800">
                          {view.gate === 'spec' && 'Gate 1 · 요구사항 계약 승인 대기'}
                          {view.gate === 'plan' && 'Gate 2 · 구현 계획 승인 대기'}
                          {view.gate === 'risk' && 'Gate 3 · 위험 변경 승인 대기'}
                          {view.gate === 'plan_patch' && '계획 패치 승인 대기'}
                        </p>
                      </div>
                      <StatusBadge status={view.task.status} label={mapStatusLabel(view.task.status)} />
                    </header>

                    {view.gate === 'spec' && view.contract && (
                      <div className="mt-3 grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
                        {view.contract.summary && (
                          <p className="text-xs text-slate-700 whitespace-pre-wrap break-words">{view.contract.summary}</p>
                        )}
                        <TextBlock title="목표 (goals)" items={view.contract.goals} />
                        <TextBlock title="비목표 (non-goals)" items={view.contract.nonGoals} />
                        <TextBlock title="제약 (constraints)" items={view.contract.constraints} />
                        <TextBlock title="수용 기준 (acceptance criteria)" items={view.contract.acceptanceCriteria} />
                        <TextBlock title="엣지 케이스" items={view.contract.edgeCases} />
                        <TextBlock title="열린 질문 (open questions)" items={view.contract.openQuestions} />
                      </div>
                    )}

                    {view.gate === 'plan' && view.plan && (
                      <div className="mt-3 grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
                        {view.plan.summary && (
                          <p className="text-xs text-slate-700 whitespace-pre-wrap break-words">{view.plan.summary}</p>
                        )}
                        <TextBlock title="구현 단계" items={view.plan.implementationSteps} />
                        <TextBlock title="변경 예상 파일" items={view.plan.filesLikelyToChange} />
                        <TextBlock title="아키텍처 영향" items={view.plan.architectureImpact} />
                        <TextBlock title="리스크" items={view.plan.risks} />
                        <TextBlock title="검증 전략" items={view.plan.validationStrategy} />
                        {view.plan.taskBreakdown.length > 0 && (
                          <div>
                            <p className="text-xs font-semibold text-slate-900">chunk 분해 ({view.plan.taskBreakdown.length})</p>
                            <ol className="mt-1 grid gap-1">
                              {view.plan.taskBreakdown.map((chunk, index) => (
                                <li key={`${view.task.id}-plan-chunk-${chunk.id || index}`} className="rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-700">
                                  <strong>{index + 1}. {chunk.title}</strong>
                                  {chunk.acceptanceCriteria.length > 0 && (
                                    <ul className="mt-0.5 list-disc pl-4 text-[11px] text-slate-600">
                                      {chunk.acceptanceCriteria.map((criterion, criterionIndex) => (
                                        <li key={`${view.task.id}-plan-chunk-${index}-ac-${criterionIndex}`}>{criterion}</li>
                                      ))}
                                    </ul>
                                  )}
                                </li>
                              ))}
                            </ol>
                          </div>
                        )}
                      </div>
                    )}

                    {view.gate === 'risk' && (
                      <div className="mt-3 grid gap-2 rounded-lg border border-rose-200 bg-rose-50/60 p-3">
                        <p className="text-xs text-slate-700">
                          autopilot 중 위험 가능성이 있는 변경이 감지되었습니다. 검토 후 계속 진행할지 결정해 주세요.
                        </p>
                        <TextBlock title="파일 삭제" items={view.riskReview?.deletions ?? []} />
                        <TextBlock title="의존성/lockfile 변경" items={view.riskReview?.dependencyChanges ?? []} />
                        <TextBlock title=".env 변경" items={view.riskReview?.envChanges ?? []} />
                      </div>
                    )}

                    {view.gate === 'plan_patch' && (
                      <div className="mt-3 grid gap-2 rounded-lg border border-amber-200 bg-amber-50/60 p-3">
                        <p className="text-xs text-slate-700">
                          실행 중 계획 불일치가 보고되었습니다. 승인하면 패치 요청을 반영해 구현 계획을 다시 수립합니다(Gate 2 재검토).
                        </p>
                        {view.planPatch?.reason && (
                          <p className="text-xs text-slate-700 whitespace-pre-wrap break-words"><strong>불일치 사유:</strong> {view.planPatch.reason}</p>
                        )}
                        {view.planPatch?.proposedChange && (
                          <p className="text-xs text-slate-700 whitespace-pre-wrap break-words"><strong>제안된 변경:</strong> {view.planPatch.proposedChange}</p>
                        )}
                      </div>
                    )}

                    {((view.gate === 'spec' && !view.contract) || (view.gate === 'plan' && !view.plan)) && (
                      <p className="mt-3 text-xs text-slate-600">게이트 산출물을 불러오는 중입니다.</p>
                    )}

                    {view.gate === 'spec' && answerOpenByTaskId[view.task.id] && (view.contract?.openQuestions.length ?? 0) > 0 && (
                      <section className="mt-3 rounded-lg border border-sky-200 bg-sky-50/60 p-3">
                        <p className="text-xs font-semibold text-slate-900">열린 질문 답변</p>
                        <p className="mt-1 text-[11px] text-slate-600">
                          각 질문에 답하면, 답변을 반영해 요구사항 계약을 다시 생성합니다(답변한 항목만 전달).
                        </p>
                        <div className="mt-2 grid gap-2">
                          {(view.contract?.openQuestions ?? []).map((question, index) => (
                            <label key={`${view.task.id}-oq-${index}`} className="grid gap-1 text-xs text-slate-700">
                              <span className="whitespace-pre-wrap break-words">{index + 1}. {question}</span>
                              <textarea
                                className={INPUT_CLASS}
                                value={(answerDraftByTaskId[view.task.id] || [])[index] || ''}
                                onChange={(event) => setAnswer(view.task.id, index, event.target.value)}
                                rows={2}
                                placeholder="이 질문에 대한 답변(비워두면 전달하지 않음)"
                              />
                            </label>
                          ))}
                        </div>
                        <div className="mt-2 flex flex-wrap justify-end gap-2">
                          <button
                            type="button"
                            className={SUB_BUTTON_CLASS}
                            onClick={() => closeAnswers(view.task.id)}
                            disabled={Boolean(busyAction)}
                          >
                            취소
                          </button>
                          <button
                            type="button"
                            className={BUTTON_CLASS}
                            onClick={() => submitAnswers(view.task.id, view.contract?.openQuestions ?? [])}
                            disabled={Boolean(busyAction) || !(answerDraftByTaskId[view.task.id] || []).some((answer) => answer.trim())}
                          >
                            답변 반영해 재생성
                          </button>
                        </div>
                      </section>
                    )}

                    {regenerateOpenByTaskId[view.task.id] && (
                      <section className="mt-3 rounded-lg border border-slate-200 bg-white p-3">
                        <label className={LABEL_CLASS}>
                          재생성 요청 사항
                          <textarea
                            className={INPUT_CLASS}
                            value={regenerateDraftByTaskId[view.task.id] || ''}
                            onChange={(event) => setRegenerateDraft(view.task.id, event.target.value)}
                            rows={3}
                            placeholder={view.gate === 'spec'
                              ? '예: 비목표에 SEO는 제외, 인증 토큰 만료 처리도 수용 기준에 추가해 주세요'
                              : '예: chunk를 2개로 나누고, layout.tsx 신설 대신 page.tsx 서버화로 진행해 주세요'}
                            autoFocus
                          />
                        </label>
                        <p className="mt-1 text-[11px] text-slate-600">
                          입력한 요청 사항을 반영해 {view.gate === 'spec' ? '요구사항 계약' : '구현 계획'}을 다시 생성합니다.
                        </p>
                        <div className="mt-2 flex flex-wrap justify-end gap-2">
                          <button
                            type="button"
                            className={SUB_BUTTON_CLASS}
                            onClick={() => closeRegenerate(view.task.id)}
                            disabled={Boolean(busyAction)}
                          >
                            취소
                          </button>
                          <button
                            type="button"
                            className={BUTTON_CLASS}
                            onClick={() => submitRegenerate(view.task.id, view.gate)}
                            disabled={Boolean(busyAction) || !(regenerateDraftByTaskId[view.task.id] || '').trim()}
                          >
                            재생성 요청 제출
                          </button>
                        </div>
                      </section>
                    )}

                    <section className="mt-3 flex flex-wrap justify-end gap-2">
                      {(view.gate === 'spec' || view.gate === 'plan') && (
                        <>
                          {view.gate === 'spec' && (view.contract?.openQuestions.length ?? 0) > 0 && (
                            <button
                              type="button"
                              className={SUB_BUTTON_CLASS}
                              onClick={() => (answerOpenByTaskId[view.task.id]
                                ? closeAnswers(view.task.id)
                                : openAnswers(view.task.id, view.contract?.openQuestions.length ?? 0))}
                              disabled={Boolean(busyAction)}
                            >
                              {answerOpenByTaskId[view.task.id] ? '답변 입력 닫기' : `열린 질문 답변 (${view.contract?.openQuestions.length ?? 0})`}
                            </button>
                          )}
                          <button
                            type="button"
                            className={SUB_BUTTON_CLASS}
                            onClick={() => (regenerateOpenByTaskId[view.task.id] ? closeRegenerate(view.task.id) : openRegenerate(view.task.id))}
                            disabled={Boolean(busyAction)}
                          >
                            {regenerateOpenByTaskId[view.task.id] ? '재생성 입력 닫기' : '다시 생성'}
                          </button>
                          <button
                            type="button"
                            className={BUTTON_CLASS}
                            onClick={() => approveGate(view.task.id, view.gate)}
                            disabled={Boolean(busyAction)}
                          >
                            {view.gate === 'spec' ? '승인 · 구현 계획 수립' : '승인 · 구현 시작'}
                          </button>
                        </>
                      )}
                      {(view.gate === 'risk' || view.gate === 'plan_patch') && (
                        <>
                          <button
                            type="button"
                            className={SUB_BUTTON_CLASS}
                            onClick={() => rejectRunnerGate(view.task.id, view.gate)}
                            disabled={Boolean(busyAction)}
                          >
                            중단
                          </button>
                          <button
                            type="button"
                            className={BUTTON_CLASS}
                            onClick={() => approveRunnerGate(view.task.id, view.gate)}
                            disabled={Boolean(busyAction)}
                          >
                            {view.gate === 'risk' ? '승인 · 계속 진행' : '승인 · 계획 갱신'}
                          </button>
                        </>
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
                  const currentStatus = normalizeManualCodeTaskStatus(view.task.status);
                  const selectedManualStatus = statusDraftByTaskId[view.task.id] || currentStatus;
                  const canSubmitManualStatus = selectedManualStatus !== currentStatus;
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
                            <div className="flex items-start justify-between gap-3">
                              <h4 className="text-sm font-semibold text-slate-900">세부 진행현황</h4>
                              {view.elapsedSeconds !== null && (
                                <p className="text-xs font-medium text-slate-600">{view.elapsedSeconds}초째 진행 중</p>
                              )}
                            </div>
                            <p className="mt-1 text-xs text-slate-500">
                              {view.progress.currentStep}/{view.progress.totalSteps}
                              {view.progress.chunkTotal > 0 && ` · chunk ${view.progress.chunkIndex}/${view.progress.chunkTotal}`}
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
                              <h4 className="text-sm font-semibold text-slate-900">chunk 진행 내역</h4>
                              <p className="text-xs text-slate-500">{view.chunks.length}개</p>
                            </div>
                            {view.chunks.length === 0 && (
                              <p className="text-xs text-slate-600">
                                구현이 시작되면 chunk별 구현/리뷰/커밋 내역이 여기에 표시됩니다.
                              </p>
                            )}
                            <div className="grid gap-2">
                              {view.chunks.map((chunk, index) => (
                                <details key={`${view.task.id}-chunk-${chunk.id || index}`} className="rounded-lg border border-slate-200 bg-white px-3 py-2" open>
                                  <summary className="cursor-pointer text-sm font-semibold text-slate-900">
                                    {index + 1}. {chunk.title}
                                    {chunk.status ? ` · ${chunk.status === 'committed' ? '커밋 완료' : chunk.status}` : ''}
                                    {chunk.mustFix.length > 0 ? ` · must-fix ${chunk.mustFix.length}` : ''}
                                  </summary>
                                  <div className="mt-2 grid gap-2 text-sm text-slate-700">
                                    {chunk.executorSummary && (
                                      <p><strong>구현 요약:</strong> {chunk.executorSummary}</p>
                                    )}
                                    {chunk.testsRun.length > 0 && (
                                      <p className="text-xs text-slate-600">실행한 검증: {chunk.testsRun.join(', ')}</p>
                                    )}
                                    <FindingList title="must-fix (P0/P1)" findings={chunk.mustFix} tone="rose" />
                                    <FindingList title="should-fix (P2)" findings={chunk.shouldFix} tone="amber" />
                                    <FindingList title="advisory (P3/P4)" findings={chunk.advisory} tone="slate" />
                                    {chunk.patchCommits.length > 0 && (
                                      <p className="text-xs text-slate-600">수정 커밋: {chunk.patchCommits.join(', ')}</p>
                                    )}
                                    {chunk.remainingKnownIssues.length > 0 && (
                                      <FindingList title="남은 알려진 이슈" findings={chunk.remainingKnownIssues} tone="slate" />
                                    )}
                                  </div>
                                </details>
                              ))}
                            </div>
                          </section>

                          {view.refinements.length > 0 && (
                            <section className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                              <h4 className="text-sm font-semibold text-slate-900">완료 후 개선 루프 ({view.refinements.length})</h4>
                              <ul className="mt-1 list-disc pl-5 text-xs text-slate-700">
                                {view.refinements.map((refinement, index) => (
                                  <li key={`${view.task.id}-refine-${index}`} className="whitespace-pre-wrap break-words">
                                    <strong>{refinement.iteration}회차 · {REFINEMENT_STATUS_LABEL[refinement.status] || refinement.status}</strong>
                                    {refinement.title ? ` · ${refinement.title}` : ''}
                                    {refinement.rationale ? ` — ${refinement.rationale}` : ''}
                                  </li>
                                ))}
                              </ul>
                            </section>
                          )}

                          {view.finalValidation && (
                            <section className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                              <h4 className="text-sm font-semibold text-slate-900">
                                최종 검증 {view.finalValidation.contractMet ? '· 계약 충족' : '· 미충족 항목 있음'}
                              </h4>
                              {view.finalValidation.summary && (
                                <p className="mt-1 text-xs text-slate-700 whitespace-pre-wrap break-words">{view.finalValidation.summary}</p>
                              )}
                              {view.finalValidation.acceptanceResults.length > 0 && (
                                <ul className="mt-2 list-disc pl-5 text-xs text-slate-700">
                                  {view.finalValidation.acceptanceResults.map((result, index) => (
                                    <li key={`${view.task.id}-acceptance-${index}`} className="whitespace-pre-wrap break-words">
                                      <strong>{result.status || '-'}</strong>
                                      {result.criterion ? ` · ${result.criterion}` : ''}
                                      {result.evidence ? ` — ${result.evidence}` : ''}
                                    </li>
                                  ))}
                                </ul>
                              )}
                              {view.finalValidation.residualRisks.length > 0 && (
                                <p className="mt-1 text-xs text-rose-700">잔여 리스크: {view.finalValidation.residualRisks.join(', ')}</p>
                              )}
                            </section>
                          )}

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

                          <section className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                            <div className="flex flex-wrap items-end justify-between gap-2">
                              <label className="grid gap-1 text-xs text-slate-700">
                                상태 변경
                                <select
                                  className={INPUT_CLASS}
                                  value={selectedManualStatus}
                                  onChange={(event) => selectManualStatus(
                                    view.task.id,
                                    normalizeManualCodeTaskStatus(event.target.value)
                                  )}
                                  disabled={Boolean(busyAction)}
                                >
                                  {MANUAL_STATUS_OPTIONS.map((statusOption) => (
                                    <option key={`${view.task.id}-status-${statusOption}`} value={statusOption}>
                                      {mapStatusLabel(statusOption)}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <button
                                type="button"
                                className={SUB_BUTTON_CLASS}
                                onClick={() => submitTaskStatusChange(view.task.id)}
                                disabled={Boolean(busyAction) || !canSubmitManualStatus}
                              >
                                상태 변경 적용
                              </button>
                            </div>
                            <p className="mt-2 text-xs text-slate-600">
                              실행이 멈춘 경우 상태를 수동 정리할 수 있습니다.
                            </p>
                          </section>

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
