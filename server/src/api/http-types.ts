export type RequestBody = Record<string, unknown>;

export interface DraftMetadata {
  provider?: string;
  reactionName?: string;
  [key: string]: unknown;
}

export interface TaskPayload {
  codeReview?: {
    analysisStatus?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface TaskRecord {
  domain: string;
  status: string;
  summary?: string | null;
  approval_state?: string | null;
  payload?: TaskPayload;
  [key: string]: unknown;
}

export interface TaskDetail {
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

export interface TaskServiceApi {
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
  deleteTask(taskId: string): void;
  createCodeExecutionPullRequest(taskId: string, input: { branchName?: string }): Promise<TaskDetail>;
  pollSlackMentions(): Promise<unknown>;
  pollGitHubReviews(): Promise<unknown>;
  saveDraft(taskId: string, input: Record<string, unknown>): void;
  approveTask(taskId: string): TaskDetail;
  ignoreTask(taskId: string): TaskDetail;
  executeTask(taskId: string, input: { message: string; reactionName: string; addReaction: boolean }): Promise<TaskDetail>;
}

export interface MeetingSummaryResult {
  summary: string;
  polishedTranscript?: string;
  document: string;
  provider: string;
  agentProvider?: string;
}

export interface LlmServiceApi {
  generateMeetingSummary?: (input: {
    transcript: string;
    startedAt: string;
    endedAt: string;
    language: string;
  }) => Promise<MeetingSummaryResult>;
}
