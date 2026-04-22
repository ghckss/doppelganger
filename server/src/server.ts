import http from 'node:http';

const DEFAULT_DEV_CORS_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173'
]);

type RequestBody = Record<string, unknown>;

interface DraftMetadata {
  provider?: string;
  reactionName?: string;
  [key: string]: unknown;
}

interface TaskPayload {
  codeReview?: {
    analysisStatus?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface TaskRecord {
  domain: string;
  status: string;
  summary?: string | null;
  approval_state?: string | null;
  payload?: TaskPayload;
  [key: string]: unknown;
}

interface TaskDetail {
  task: TaskRecord;
  latestDraft?: {
    content?: string;
    metadata?: DraftMetadata;
    [key: string]: unknown;
  };
  domain?: {
    capabilities?: {
      drafting?: boolean;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface TaskServiceApi {
  config: {
    app?: {
      baseUrl?: unknown;
      corsOrigins?: unknown[];
    };
    workspace: {
      projectsRoot: string;
    };
    agent?: {
      defaultProvider?: string;
    };
    [key: string]: unknown;
  };
  listTasks(input: { includeResolved: boolean }): unknown;
  getCodeExecutionProjects(): unknown;
  getConnectorReadiness(): unknown;
  getDomainCatalog(): unknown;
  createCodeExecutionTask(input: Record<string, unknown>): Promise<TaskDetail>;
  getTaskDetail(taskId: string): TaskDetail;
  generateDraft(taskId: string, input: Record<string, unknown>): Promise<TaskDetail>;
  startSlackCodeReview(taskId: string, input: Record<string, unknown>): Promise<{
    started: boolean;
    alreadyRunning: boolean;
    detail: TaskDetail;
  }>;
  startCodeExecutionTask(taskId: string): Promise<TaskDetail>;
  resumeCodeExecutionTask(taskId: string): Promise<TaskDetail>;
  createCodeExecutionPullRequest(taskId: string, input: { branchName?: string }): Promise<TaskDetail>;
  pollSlackMentions(): Promise<unknown>;
  pollGitHubReviews(): Promise<unknown>;
  saveDraft(taskId: string, input: Record<string, unknown>): void;
  approveTask(taskId: string): TaskDetail;
  ignoreTask(taskId: string): TaskDetail;
  executeTask(taskId: string, input: { message: string; reactionName: string; addReaction: boolean }): Promise<TaskDetail>;
}

interface MeetingSummaryResult {
  summary: string;
  polishedTranscript?: string;
  document: string;
  provider: string;
  agentProvider?: string;
}

interface LlmServiceApi {
  generateMeetingSummary?: (input: {
    transcript: string;
    startedAt: string;
    endedAt: string;
    language: string;
  }) => Promise<MeetingSummaryResult>;
}

function toRequestBody(value: unknown): RequestBody {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as RequestBody;
}

function readStringField(body: RequestBody, key: string): string {
  return String(body[key] ?? '').trim();
}

function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8'
  });
  response.end(JSON.stringify(payload, null, 2));
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function parseRequestBody(request: http.IncomingMessage): Promise<RequestBody> {
  const rawBody = await readBody(request);
  const contentType = request.headers['content-type'] || '';

  if (contentType.includes('application/json')) {
    const parsed = rawBody ? JSON.parse(rawBody) : {};
    return toRequestBody(parsed);
  }

  const params = new URLSearchParams(rawBody);
  return Object.fromEntries(params.entries()) as RequestBody;
}

function normalizeOrigin(value: unknown): string {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return '';
  }

  try {
    const parsed = new URL(normalized);
    if (!parsed.protocol || !parsed.host) {
      return '';
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
}

function buildAllowedCorsOrigins(config: { app?: { baseUrl?: unknown; corsOrigins?: unknown[] } } | undefined): Set<string> {
  const allowed = new Set(DEFAULT_DEV_CORS_ORIGINS);
  const baseOrigin = normalizeOrigin(config?.app?.baseUrl);
  if (baseOrigin) {
    allowed.add(baseOrigin);
  }

  const configuredOrigins = Array.isArray(config?.app?.corsOrigins) ? config.app.corsOrigins : [];
  for (const origin of configuredOrigins) {
    const normalized = normalizeOrigin(origin);
    if (normalized) {
      allowed.add(normalized);
    }
  }

  return allowed;
}

function applyCorsHeaders(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  allowedOrigins: Set<string>
): boolean {
  const origin = String(request.headers.origin || '').trim();
  if (!origin || !allowedOrigins.has(origin)) {
    return false;
  }

  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Vary', 'Origin');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  response.setHeader('Access-Control-Max-Age', '86400');
  return true;
}

function getAnalysisStatus(detail: TaskDetail): string {
  return String(detail.task.payload?.codeReview?.analysisStatus || '');
}

export function createHttpServer({
  taskService,
  llmService
}: {
  taskService: unknown;
  llmService: unknown;
}): http.Server {
  const service = taskService as TaskServiceApi;
  const summarizer = llmService as LlmServiceApi;
  const allowedCorsOrigins = buildAllowedCorsOrigins(service?.config || {});

  return http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;

    try {
      const corsApplied = applyCorsHeaders(request, response, allowedCorsOrigins);
      if (request.method === 'OPTIONS') {
        if (corsApplied) {
          response.writeHead(204);
          response.end();
          return;
        }
        response.writeHead(404);
        response.end();
        return;
      }

      const hasUsableDraft = (detail: TaskDetail) => Boolean(
        detail.latestDraft?.content || detail.latestDraft?.metadata?.reactionName
      );
      const shouldAutoGenerateDraft = (detail: TaskDetail) => detail.domain?.capabilities?.drafting
        && detail.task.domain !== 'github_review'
        && detail.task.status !== 'failed'
        && (!detail.task.summary || !hasUsableDraft(detail));

      if (request.method === 'GET' && pathname === '/') {
        sendJson(response, 200, {
          ok: true,
          message: 'API 서버가 실행 중입니다. React UI는 별도 클라이언트 서버에서 제공합니다.',
          endpoints: {
            health: '/healthz',
            meta: '/api/meta',
            tasks: '/api/tasks'
          }
        });
        return;
      }

      if (request.method === 'GET' && pathname === '/healthz') {
        sendJson(response, 200, {
          ok: true,
          uptimeSeconds: Math.round(process.uptime())
        });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/meetings/summarize') {
        const body = await parseRequestBody(request);
        const transcript = readStringField(body, 'transcript');
        if (!transcript) {
          sendJson(response, 400, {
            ok: false,
            error: '회의 전사 내용이 필요합니다'
          });
          return;
        }

        if (!summarizer?.generateMeetingSummary) {
          throw new Error('회의 정리 서비스를 사용할 수 없습니다');
        }

        const result = await summarizer.generateMeetingSummary({
          transcript,
          startedAt: readStringField(body, 'startedAt'),
          endedAt: readStringField(body, 'endedAt'),
          language: readStringField(body, 'language') || 'ko-KR'
        });

        sendJson(response, 200, {
          ok: true,
          summary: result.summary,
          polishedTranscript: result.polishedTranscript || '',
          document: result.document,
          provider: result.provider,
          agentProvider: result.agentProvider || ''
        });
        return;
      }

      if (request.method === 'GET' && pathname === '/api/tasks') {
        sendJson(response, 200, {
          tasks: service.listTasks({
            includeResolved: url.searchParams.get('includeResolved') === '1'
          }),
          projects: service.getCodeExecutionProjects(),
          readiness: service.getConnectorReadiness(),
          domains: service.getDomainCatalog()
        });
        return;
      }

      if (request.method === 'GET' && pathname === '/api/meta') {
        sendJson(response, 200, {
          projects: service.getCodeExecutionProjects(),
          readiness: service.getConnectorReadiness(),
          domains: service.getDomainCatalog(),
          projectsRoot: service.config.workspace.projectsRoot,
          defaultAgentProvider: service.config.agent?.defaultProvider || 'codex'
        });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/tasks/code-execution') {
        const body = await parseRequestBody(request);
        const detail = await service.createCodeExecutionTask({
          command: readStringField(body, 'command'),
          projectId: readStringField(body, 'projectId'),
          baseBranch: readStringField(body, 'baseBranch'),
          branchName: readStringField(body, 'branchName'),
          agentProvider: readStringField(body, 'agentProvider'),
          needsPlanning: String(body.needsPlanning || '').toLowerCase() === 'true',
          needsDesign: String(body.needsDesign || '').toLowerCase() === 'true'
        });
        sendJson(response, 201, detail);
        return;
      }

      const taskApiMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (request.method === 'GET' && taskApiMatch) {
        const taskId = decodeURIComponent(taskApiMatch[1]);
        let detail = service.getTaskDetail(taskId);
        if (shouldAutoGenerateDraft(detail)) {
          detail = await service.generateDraft(taskId, {});
        }
        if (detail.task.domain === 'slack_mention') {
          const analysisStatus = String(detail.task.payload?.codeReview?.analysisStatus || '').toLowerCase();
          if (!analysisStatus || analysisStatus === 'not_requested') {
            await service.startSlackCodeReview(taskId, {});
            detail = service.getTaskDetail(taskId);
          }
        }
        sendJson(response, 200, detail);
        return;
      }

      const runCodeTaskMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/run$/);
      if (request.method === 'POST' && runCodeTaskMatch) {
        const taskId = decodeURIComponent(runCodeTaskMatch[1]);
        const detail = await service.startCodeExecutionTask(taskId);
        sendJson(response, 200, {
          ok: true,
          taskId,
          status: detail.task.status
        });
        return;
      }

      const resumeCodeTaskMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/resume$/);
      if (request.method === 'POST' && resumeCodeTaskMatch) {
        const taskId = decodeURIComponent(resumeCodeTaskMatch[1]);
        const detail = await service.resumeCodeExecutionTask(taskId);
        sendJson(response, 200, {
          ok: true,
          taskId,
          status: detail.task.status
        });
        return;
      }

      const createPrMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/create-pr$/);
      if (request.method === 'POST' && createPrMatch) {
        const taskId = decodeURIComponent(createPrMatch[1]);
        const body = await parseRequestBody(request);
        const detail = await service.createCodeExecutionPullRequest(taskId, {
          branchName: readStringField(body, 'branchName')
        });
        sendJson(response, 200, {
          ok: true,
          taskId,
          status: detail.task.status
        });
        return;
      }

      if (request.method === 'POST' && pathname === '/internal/poll/slack-mentions') {
        const result = await service.pollSlackMentions();
        sendJson(response, 200, result);
        return;
      }

      if (request.method === 'POST' && pathname === '/internal/poll/github-reviews') {
        const result = await service.pollGitHubReviews();
        sendJson(response, 200, result);
        return;
      }

      const draftMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/draft$/);
      if (request.method === 'POST' && draftMatch) {
        const taskId = decodeURIComponent(draftMatch[1]);
        const body = await parseRequestBody(request);
        if (readStringField(body, 'mode') === 'generate') {
          const task = service.getTaskDetail(taskId).task;
          const includeCodeReviewContext = readStringField(body, 'includeCodeReviewContext').toLowerCase() === 'true';
          const detail = await service.generateDraft(taskId, task.domain === 'slack_mention'
            ? {
              includeCodeReviewContext
            }
            : {
              generationAgentProvider: readStringField(body, 'generationAgentProvider')
            });
          const latestProvider = detail.latestDraft?.metadata?.provider || '';
          sendJson(response, 200, {
            ok: true,
            taskId,
            status: detail.task.status,
            provider: latestProvider
          });
          return;
        }

        service.saveDraft(taskId, {
          content: readStringField(body, 'draft'),
          summary: readStringField(body, 'summary'),
          metadata: {
            sendMode: readStringField(body, 'sendMode'),
            replyCategory: readStringField(body, 'replyCategory'),
            replyCategoryLabel: readStringField(body, 'replyCategoryLabel'),
            requestedAction: readStringField(body, 'requestedAction'),
            reactionName: readStringField(body, 'reactionName')
          }
        });
        sendJson(response, 200, {
          ok: true,
          taskId
        });
        return;
      }

      const codeReviewMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/code-review$/);
      if (request.method === 'POST' && codeReviewMatch) {
        const taskId = decodeURIComponent(codeReviewMatch[1]);
        const started = await service.startSlackCodeReview(taskId, {});
        sendJson(response, 200, {
          ok: true,
          taskId,
          started: started.started,
          alreadyRunning: started.alreadyRunning,
          status: getAnalysisStatus(started.detail)
        });
        return;
      }

      const approveMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/approve$/);
      if (request.method === 'POST' && approveMatch) {
        const taskId = decodeURIComponent(approveMatch[1]);
        const detail = service.approveTask(taskId);
        sendJson(response, 200, {
          ok: true,
          taskId,
          status: detail.task.status,
          approvalState: detail.task.approval_state
        });
        return;
      }

      const ignoreMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/ignore$/);
      if (request.method === 'POST' && ignoreMatch) {
        const taskId = decodeURIComponent(ignoreMatch[1]);
        const detail = service.ignoreTask(taskId);
        sendJson(response, 200, {
          ok: true,
          taskId,
          status: detail.task.status
        });
        return;
      }

      const sendMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/send$/);
      if (request.method === 'POST' && sendMatch) {
        const taskId = decodeURIComponent(sendMatch[1]);
        const body = await parseRequestBody(request);
        const sendMode = readStringField(body, 'sendMode');
        const draft = readStringField(body, 'draft');
        const reactionName = readStringField(body, 'reactionName');
        service.saveDraft(taskId, {
          content: draft,
          summary: readStringField(body, 'summary'),
          metadata: {
            sendMode,
            replyCategory: readStringField(body, 'replyCategory'),
            replyCategoryLabel: readStringField(body, 'replyCategoryLabel'),
            requestedAction: readStringField(body, 'requestedAction'),
            reactionName
          }
        });
        const detail = await service.executeTask(taskId, {
          message: sendMode === 'reaction' ? '' : draft,
          reactionName: sendMode === 'reaction' ? reactionName : '',
          addReaction: sendMode === 'reaction'
        });
        sendJson(response, 200, {
          ok: true,
          taskId,
          status: detail.task.status
        });
        return;
      }

      sendJson(response, 404, {
        ok: false,
        error: '요청한 경로가 존재하지 않습니다.'
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, {
        ok: false,
        error: message
      });
    }
  });
}
