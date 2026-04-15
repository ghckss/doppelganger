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
  running: '실행 중'
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

export type ExecutionProgress = {
  phase: string;
  label: string;
  currentStep: number;
  totalSteps: number;
  percent: number;
  reviewRound: number;
  reviewTotalRounds: number;
};

export type DraftEditorState = {
  content: string;
  summary: string;
  sendMode: string;
  reactionName: string;
};

export type CollapsibleSectionId =
  | 'panel_slack'
  | 'panel_github'
  | 'panel_code'
  | 'slack_analysis'
  | 'slack_draft'
  | 'slack_artifacts'
  | 'github_draft'
  | 'code_create'
  | 'code_tasks';

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
