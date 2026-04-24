import type { loadConfig } from '../core/config.ts';

export type AppConfig = ReturnType<typeof loadConfig>;

export interface TaskRecord {
  id: string;
  domain: string;
  kind?: string;
  title?: string;
  status: string;
  approval_state?: string;
  source_url?: string | null;
  summary?: string | null;
  payload?: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  last_error?: string | null;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface ArtifactRecord {
  id: string;
  task_id: string;
  type: string;
  external_id?: string | null;
  title?: string | null;
  content?: string | null;
  sort_order?: number;
  metadata?: Record<string, unknown>;
  created_at?: string;
  [key: string]: unknown;
}

export interface DraftRecord {
  id: string;
  task_id: string;
  content: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
  [key: string]: unknown;
}

export interface ExecutionRecord {
  id: string;
  task_id: string;
  action: string;
  status: string;
  request?: unknown;
  response?: unknown;
  error?: string | null;
  created_at?: string;
  [key: string]: unknown;
}

export interface Repository {
  listTasks: (input?: { domain?: string }) => TaskRecord[];
  getTask: (taskId: string) => TaskRecord | null;
  getTaskByExternalId: (domain: string, externalId: string) => TaskRecord | null;
  upsertTask: (taskInput: Record<string, unknown>) => TaskRecord;
  updateTask: (taskId: string, fields: Record<string, unknown>) => TaskRecord | null;
  deleteTask: (taskId: string) => boolean;
  replaceArtifacts: (taskId: string, type: string, artifacts: Array<Record<string, unknown>>) => void;
  createArtifact: (taskId: string, type: string, artifact: Record<string, unknown>) => ArtifactRecord | null;
  listArtifacts: (taskId: string, type?: string) => ArtifactRecord[];
  createDraft: (taskId: string, content: string, metadata?: Record<string, unknown>) => DraftRecord | null;
  getLatestDraft: (taskId: string) => DraftRecord | null;
  listDrafts: (taskId: string) => DraftRecord[];
  logExecution: (
    taskId: string,
    action: string,
    status: string,
    details?: { request?: unknown; response?: unknown; error?: string | null }
  ) => string;
  listExecutions: (taskId: string) => ExecutionRecord[];
  getState: (key: string, fallback?: string | null) => string | null;
  setState: (key: string, value: string) => void;
}

export interface DomainDescriptor {
  id?: string;
  label?: string;
  implemented?: boolean;
  capabilities?: Record<string, unknown>;
  setupKeys?: string[];
}

export interface TaskDomain extends DomainDescriptor {
  poll?: (...args: unknown[]) => Promise<unknown>;
  generateDraft?: (...args: unknown[]) => Promise<Record<string, unknown>>;
  execute?: (...args: unknown[]) => Promise<Record<string, unknown>>;
  runCodeReview?: (...args: unknown[]) => Promise<Record<string, unknown>>;
  listProjects?: () => unknown[];
  createTask?: (input: Record<string, unknown>) => Promise<TaskRecord>;
  start?: (taskId: string, options?: Record<string, unknown>) => Promise<unknown>;
  createPullRequest?: (taskId: string, options?: Record<string, unknown>) => Promise<unknown>;
}

export type DomainRegistry = Record<string, TaskDomain>;

export interface TaskServiceDependencies {
  config: Record<string, unknown>;
  repo: Repository;
  domains: DomainRegistry;
}
