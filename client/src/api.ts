import type {
  MeetingSummaryRequest,
  MeetingSummaryResponse,
  MetaResponse,
  TaskDetail,
  TaskListResponse
} from './types';

type JsonValue = Record<string, unknown> | Array<unknown> | string | number | boolean | null;

type RequestOptions = {
  method?: string;
  body?: JsonValue;
};

const API_BASE_URL = String(import.meta.env.VITE_SERVER_URL || '').trim().replace(/\/+$/, '');

function resolveApiUrl(url: string): string {
  if (!API_BASE_URL) {
    return url;
  }

  if (/^https?:\/\//.test(url)) {
    return url;
  }

  return `${API_BASE_URL}${url.startsWith('/') ? '' : '/'}${url}`;
}

async function requestJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(resolveApiUrl(url), {
    method: options.method || 'GET',
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await response.text();
  let payload: Record<string, unknown> = {};
  if (text) {
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      payload = {};
    }
  }

  if (!response.ok) {
    const message = typeof payload?.error === 'string'
      ? payload.error
      : `요청이 실패했습니다 (HTTP ${response.status})`;
    throw new Error(message);
  }

  return payload as T;
}

export function fetchTasks(includeResolved: boolean): Promise<TaskListResponse> {
  return requestJson<TaskListResponse>(`/api/tasks?includeResolved=${includeResolved ? '1' : '0'}`);
}

export function fetchMeta(): Promise<MetaResponse> {
  return requestJson<MetaResponse>('/api/meta');
}

export function fetchTaskDetail(taskId: string): Promise<TaskDetail> {
  return requestJson<TaskDetail>(`/api/tasks/${encodeURIComponent(taskId)}`);
}

export function createCodeTask(input: {
  command: string;
  projectId: string;
  baseBranch: string;
  agentProvider: string;
  needsPlanning: boolean;
  needsDesign: boolean;
}): Promise<TaskDetail> {
  return requestJson<TaskDetail>('/api/tasks/code-execution', {
    method: 'POST',
    body: input
  });
}

export function runTask(taskId: string): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(`/api/tasks/${encodeURIComponent(taskId)}/run`, {
    method: 'POST'
  });
}

export function resumeCodeTask(taskId: string): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(`/api/tasks/${encodeURIComponent(taskId)}/resume`, {
    method: 'POST'
  });
}

export function createPullRequest(taskId: string, input: { branchName?: string } = {}): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(`/api/tasks/${encodeURIComponent(taskId)}/create-pr`, {
    method: 'POST',
    body: input
  });
}

export function pollSlackMentions(): Promise<Record<string, unknown>> {
  return requestJson<Record<string, unknown>>('/internal/poll/slack-mentions', {
    method: 'POST'
  });
}

export function pollGitHubReviews(): Promise<Record<string, unknown>> {
  return requestJson<Record<string, unknown>>('/internal/poll/github-reviews', {
    method: 'POST'
  });
}

export function generateDraft(taskId: string, includeCodeReviewContext: boolean): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(`/api/tasks/${encodeURIComponent(taskId)}/draft`, {
    method: 'POST',
    body: {
      mode: 'generate',
      includeCodeReviewContext
    }
  });
}

export function saveDraft(taskId: string, input: {
  draft: string;
  summary: string;
  sendMode: string;
  reactionName: string;
}): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(`/api/tasks/${encodeURIComponent(taskId)}/draft`, {
    method: 'POST',
    body: input
  });
}

export function startCodeReview(taskId: string): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(`/api/tasks/${encodeURIComponent(taskId)}/code-review`, {
    method: 'POST'
  });
}

export function approveTask(taskId: string): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(`/api/tasks/${encodeURIComponent(taskId)}/approve`, {
    method: 'POST'
  });
}

export function ignoreTask(taskId: string): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(`/api/tasks/${encodeURIComponent(taskId)}/ignore`, {
    method: 'POST'
  });
}

export function sendTask(taskId: string, input: {
  draft: string;
  summary: string;
  sendMode: string;
  reactionName: string;
}): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>(`/api/tasks/${encodeURIComponent(taskId)}/send`, {
    method: 'POST',
    body: input
  });
}

export function summarizeMeeting(input: MeetingSummaryRequest): Promise<MeetingSummaryResponse> {
  return requestJson<MeetingSummaryResponse>('/api/meetings/summarize', {
    method: 'POST',
    body: input
  });
}
