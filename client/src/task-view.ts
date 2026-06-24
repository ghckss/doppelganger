import type { Task, TaskDetail, TaskDomainCatalog } from './types';

export const STATUS_LABELS: Record<string, string> = {
  new: '신규',
  drafted: '초안 작성됨',
  awaiting_approval: '승인 대기',
  approved: '승인됨',
  pending: '대기',
  rejected: '거절됨',
  ignored: '무시됨',
  done: '완료',
  failed: '실패',
  running: '실행 중',
  success: '성공'
};

export const DOMAIN_LABELS: Record<string, string> = {
  slack_mention: 'Slack 멘션',
  github_review: 'GitHub 리뷰',
  code_execution: '코드 작업'
};

export const DOMAIN_IDS = ['slack_mention', 'github_review', 'code_execution'] as const;

export type DomainId = (typeof DOMAIN_IDS)[number];

export type CodeReviewStatus = {
  analysisStatus: string;
  progressStep: number;
  progressTotalSteps: number;
  progressPercent: number;
  progressLabel: string;
};

export type RunnerGate = '' | 'spec' | 'plan' | 'risk' | 'plan_patch';

export type ExecutionProgress = {
  phase: string;
  label: string;
  currentStep: number;
  totalSteps: number;
  percent: number;
  gate: RunnerGate;
  chunkIndex: number;
  chunkTotal: number;
};

export type DraftEditorState = {
  content: string;
  summary: string;
  sendMode: string;
  reactionName: string;
};

export type CollapsibleSectionId =
  | 'panel_meeting'
  | 'meeting_transcript'
  | 'meeting_document'
  | 'panel_slack'
  | 'panel_github'
  | 'panel_code'
  | 'slack_analysis'
  | 'slack_draft'
  | 'slack_artifacts'
  | 'slack_timeline'
  | 'github_draft'
  | 'github_timeline'
  | 'code_create'
  | 'code_tasks'
  | 'code_timeline';

export type CollapsibleState = Record<CollapsibleSectionId, boolean>;

export const EMOJI_PRESET_OPTIONS = [
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

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function asText(value: unknown, fallback = ''): string {
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

export function getCodeReviewStatus(task: Task): CodeReviewStatus | null {
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

export function getExecutionProgress(task: Task): ExecutionProgress | null {
  const progress = asRecord(asRecord(task.result).executionProgress);
  if (Object.keys(progress).length === 0) {
    return null;
  }

  const gateValue = asText(progress.gate);
  return {
    phase: asText(progress.phase),
    label: asText(progress.label),
    currentStep: asNumber(progress.currentStep),
    totalSteps: asNumber(progress.totalSteps),
    percent: asNumber(progress.percent),
    gate: gateValue === 'spec' || gateValue === 'plan' ? gateValue : '',
    chunkIndex: asNumber(progress.chunkIndex),
    chunkTotal: asNumber(progress.chunkTotal)
  };
}

export function summarizeExecutionStep(progress: ExecutionProgress): string {
  const currentStep = Math.max(0, Number(progress.currentStep || 0));
  const chunkIndex = Math.max(0, Number(progress.chunkIndex || 0));
  const chunkTotal = Math.max(0, Number(progress.chunkTotal || 0));

  if (progress.phase === 'refinement') {
    return '완료 후 개선 루프: 승인된 계약/계획 프레임 안의 개선점을 점검하고 추가로 반영합니다(최대 2회).';
  }

  if (currentStep <= 0) {
    return '작업 대기 상태입니다. 실행이 시작되면 저장소 점검부터 순차적으로 진행됩니다.';
  }
  if (currentStep === 1) {
    return '저장소 접근 가능 여부, 기준 브랜치, 작업 브랜치 상태를 점검하고 실행 환경을 준비합니다.';
  }
  if (currentStep === 2) {
    return '요청을 요구사항 계약(Requirement Contract)으로 정리합니다. 승인하면 구현 계획 단계로 진행합니다.';
  }
  if (currentStep === 3) {
    return '저장소를 점검해 구현 계획(Implementation Plan)과 chunk 분해를 수립합니다. 승인하면 구현을 시작합니다.';
  }
  if (currentStep === 4) {
    const chunkLabel = chunkTotal > 0 ? ` (chunk ${chunkIndex}/${chunkTotal})` : '';
    return `승인된 계획을 chunk 단위로 구현하고, 각 chunk마다 리뷰 스웜·머지 리뷰·수정을 거쳐 커밋합니다${chunkLabel}.`;
  }
  if (currentStep === 5) {
    return '최종 검증으로 요구사항 계약·수용 기준·회귀 여부를 점검하고 PR 초안을 준비합니다.';
  }
  if (currentStep >= 6) {
    return 'runner 워크플로가 완료되어 PR 생성 또는 후속 승인/전송 단계를 진행할 수 있습니다.';
  }

  return '작업 진행 정보를 집계 중입니다.';
}

export function getExecutionStepElapsedSeconds(task: Task, progress: ExecutionProgress | null, nowMs = Date.now()): number | null {
  if (!progress) {
    return null;
  }

  if (String(task.status || '').toLowerCase() !== 'running') {
    return null;
  }

  const currentStep = Math.max(0, Number(progress.currentStep || 0));
  if (currentStep <= 0) {
    return null;
  }

  const updatedAtMs = Date.parse(String(task.updated_at || ''));
  if (!Number.isFinite(updatedAtMs)) {
    return null;
  }

  return Math.max(0, Math.floor((nowMs - updatedAtMs) / 1000));
}

export function formatDateTime(value: string): string {
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

export function mapDomainLabel(domain: string): string {
  return DOMAIN_LABELS[domain] || domain;
}

export function mapStatusLabel(status: string): string {
  return STATUS_LABELS[status] || status;
}

export function mapCodeReviewStatus(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === 'not_requested') return '실행 대기';
  if (normalized === 'running') return '실행 중';
  if (normalized === 'completed') return '완료';
  if (normalized === 'failed') return '실패';
  return status || '-';
}

export function findDomain(catalog: TaskDomainCatalog[] | undefined, domainId: string): TaskDomainCatalog | null {
  if (!catalog) {
    return null;
  }
  return catalog.find((domain) => domain.id === domainId) || null;
}

export function toDraftEditor(detail: TaskDetail): DraftEditorState {
  return {
    content: detail.latestDraft?.content || '',
    summary: detail.task.summary || '',
    sendMode: asText(detail.latestDraft?.metadata?.sendMode, 'reply'),
    reactionName: asText(detail.latestDraft?.metadata?.reactionName, '')
  };
}

export function normalizeReactionName(value: string): string {
  return String(value || '')
    .trim()
    .replace(/^:+/, '')
    .replace(/:+$/, '');
}

export function resolveReactionGlyph(name: string): string {
  const normalized = normalizeReactionName(name).toLowerCase();
  if (!normalized) {
    return '';
  }
  return EMOJI_GLYPH_BY_NAME[normalized] || '';
}
