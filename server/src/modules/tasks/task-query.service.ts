import { getConnectorReadiness } from '../../core/config.ts';
import {
  assertTask,
  type TaskDetail,
  type TaskDomainMap,
  type TaskModuleDependencies,
  type TaskRepository
} from './task-types.ts';

export class TaskQueryService {
  config: TaskModuleDependencies['config'];
  repo: TaskRepository;
  domains: TaskDomainMap;

  constructor({ config, repo, domains }: TaskModuleDependencies) {
    this.config = config;
    this.repo = repo;
    this.domains = domains;
  }

  listTasks({ domain, includeResolved = false }: { domain?: string; includeResolved?: boolean } = {}) {
    const tasks = this.repo.listTasks({ domain });
    if (includeResolved) {
      return tasks;
    }
    return tasks.filter((task) => task.status !== 'done' && task.status !== 'ignored');
  }

  getNextPendingTaskId(taskId: string, { domain }: { domain?: string } = {}) {
    const tasks = this.listTasks({ domain, includeResolved: false });
    if (tasks.length === 0) {
      return null;
    }

    const currentIndex = tasks.findIndex((task) => task.id === taskId);
    if (currentIndex === -1) {
      return tasks[0]?.id || null;
    }

    if (tasks.length === 1) {
      return null;
    }

    return tasks[currentIndex + 1]?.id || tasks[0]?.id || null;
  }

  getFirstPendingTaskId({ domain }: { domain?: string } = {}) {
    return this.listTasks({ domain, includeResolved: false })[0]?.id || null;
  }

  getDomainCatalog() {
    const readiness = getConnectorReadiness(this.config);

    return Object.values(this.domains).map((domain) => ({
      id: domain.id || '',
      label: domain.label || '',
      implemented: Boolean(domain.implemented),
      capabilities: domain.capabilities || {},
      setupKeys: domain.setupKeys || [],
      readiness
    }));
  }

  getConnectorReadiness() {
    return getConnectorReadiness(this.config);
  }

  getCodeExecutionProjects() {
    const domain = this.domains.code_execution;
    if (!domain?.listProjects) {
      return [];
    }
    return domain.listProjects();
  }

  getTaskDetail(taskId: string): TaskDetail {
    const task = assertTask(taskId, this.repo.getTask(taskId));
    const artifacts = this.repo.listArtifacts(taskId);
    const drafts = this.repo.listDrafts(taskId);
    const executions = this.repo.listExecutions(taskId);
    const domain = this.domains[task.domain] || null;

    return {
      task,
      artifacts,
      drafts,
      latestDraft: drafts[0] || undefined,
      executions,
      domain: domain || undefined
    };
  }
}
