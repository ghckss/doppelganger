export type Task = {
  id: string;
  domain: string;
  title: string;
  status: string;
  approval_state: string;
  source_url: string | null;
  summary: string | null;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type TaskArtifact = {
  id: string;
  task_id: string;
  type: string;
  title: string | null;
  content: string | null;
  created_at: string;
  metadata: Record<string, unknown>;
};

export type TaskDraft = {
  id: string;
  task_id: string;
  content: string;
  created_at: string;
  metadata: Record<string, unknown>;
};

export type TaskExecution = {
  id: string;
  task_id: string;
  action: string;
  status: string;
  request: Record<string, unknown> | null;
  response: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
};

export type TaskDomainCatalog = {
  id: string;
  label: string;
  implemented: boolean;
  capabilities: {
    polling: boolean;
    drafting: boolean;
    execution: boolean;
  };
};

export type Project = {
  id: string;
  name: string;
  path: string;
  git: boolean;
  allowed: boolean;
};

export type ConnectorReadiness = Record<string, { ready: boolean; missing: string[] }>;

export type TaskDetail = {
  task: Task;
  artifacts: TaskArtifact[];
  drafts: TaskDraft[];
  latestDraft: TaskDraft | null;
  executions: TaskExecution[];
  domain: TaskDomainCatalog | null;
};

export type TaskListResponse = {
  tasks: Task[];
  projects: Project[];
  readiness: ConnectorReadiness;
  domains: TaskDomainCatalog[];
};

export type MetaResponse = {
  projects: Project[];
  readiness: ConnectorReadiness;
  domains: TaskDomainCatalog[];
  projectsRoot: string;
  defaultAgentProvider: string;
};
