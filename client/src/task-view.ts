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

export function summarizeExecutionStep(progress: ExecutionProgress): string {
  const currentStep = Math.max(0, Number(progress.currentStep || 0));
  const reviewRound = Math.max(0, Number(progress.reviewRound || 0));
  const reviewTotalRounds = Math.max(0, Number(progress.reviewTotalRounds || 0));

  if (currentStep <= 0) {
    return '작업 대기 상태입니다. 실행이 시작되면 저장소 점검부터 순차적으로 진행됩니다.';
  }
  if (currentStep === 1) {
    return '저장소 접근 가능 여부, 기준 브랜치, 작업 브랜치 상태를 점검하고 실행 환경을 준비합니다.';
  }
  if (currentStep === 2) {
    return '요청을 구현 가능한 작업 단위로 정리하고, 필요 시 기획/디자인 산출물을 생성합니다.';
  }
  if (currentStep === 3) {
    return '코딩 에이전트가 실제 코드를 수정하고 커밋 단위로 구현을 진행합니다.';
  }
  if (currentStep >= 4 && currentStep <= 6) {
    const roundLabel = reviewRound > 0 && reviewTotalRounds > 0
      ? `${reviewRound}/${reviewTotalRounds}`
      : `${currentStep - 3}/3`;
    return `리뷰 라운드 ${roundLabel} 진행 중입니다. 검토 결과에 따라 수정·재검토를 반복합니다.`;
  }
  if (currentStep === 7) {
    return '커밋/리뷰 결과를 정리해 PR 설명(초안 제목·본문)과 제출 정보를 준비합니다.';
  }
  if (currentStep >= 8) {
    return '코드 작업이 완료되어 PR 생성 또는 후속 승인/전송 단계를 진행할 수 있습니다.';
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
