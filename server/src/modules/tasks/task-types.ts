import type {
  DomainRegistry,
  Repository,
  TaskRecord,
  TaskServiceDependencies
} from '../../runtime-contracts.ts';

export const CODE_EXECUTION_RECOVERY_ERROR = '앱이 재시작되어 코드 작업 실행이 중단되었습니다. 작업을 다시 실행해 주세요.';
export const CODE_REVIEW_RECOVERY_ERROR = '앱이 재시작되어 코드 검토 실행이 중단되었습니다. 코드 검토를 다시 실행해 주세요.';

export type TaskModuleDependencies = TaskServiceDependencies;

export interface TaskQueryServiceLike {
  listTasks: (input?: { domain?: string; includeResolved?: boolean }) => TaskRecord[];
  getTaskDetail: (taskId: string) => TaskDetail;
}

export interface TaskCommandServiceLike {
  startSlackCodeReview: (taskId: string, options?: Record<string, unknown>) => Promise<{
    started: boolean;
    alreadyRunning: boolean;
    detail: TaskDetail;
  }>;
}

export interface TaskDetail {
  task: TaskRecord;
  artifacts: Array<Record<string, unknown>>;
  drafts: Array<Record<string, unknown>>;
  latestDraft?: Record<string, unknown>;
  executions: Array<Record<string, unknown>>;
  domain?: TaskDomainMap[string];
}

export type TaskDomainMap = DomainRegistry;
export type TaskRepository = Repository;
export type { TaskRecord };

export function assertTask(taskId: string, task: TaskRecord | null): TaskRecord {
  if (!task) {
    throw new Error(`작업을 찾을 수 없습니다: ${taskId}`);
  }
  return task;
}

export function toInteger(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.trunc(parsed);
}
