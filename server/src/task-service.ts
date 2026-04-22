import { TaskBackgroundService } from './modules/tasks/task-background.service.ts';
import { TaskCommandService } from './modules/tasks/task-command.service.ts';
import { TaskQueryService } from './modules/tasks/task-query.service.ts';

export class TaskService {
  config: any;
  repo: any;
  domains: Record<string, any>;
  queryService: TaskQueryService;
  commandService: TaskCommandService;
  backgroundService: TaskBackgroundService;
  slackCodeReviewJobs: Map<string, Promise<unknown>>;
  recoverySummary: {
    codeExecutionRecovered: number;
    slackCodeReviewRecovered: number;
  };

  constructor({ config, repo, domains }: { config: any; repo: any; domains: Record<string, any> }) {
    this.config = config;
    this.repo = repo;
    this.domains = domains;
    this.slackCodeReviewJobs = new Map();
    this.queryService = new TaskQueryService({
      config,
      repo,
      domains
    });
    this.commandService = new TaskCommandService({
      config,
      repo,
      domains,
      queryService: this.queryService,
      slackCodeReviewJobs: this.slackCodeReviewJobs
    });
    this.backgroundService = new TaskBackgroundService({
      config,
      repo,
      domains,
      queryService: this.queryService,
      commandService: this.commandService
    });
    this.recoverySummary = this.backgroundService.recoverInterruptedBackgroundJobs();
  }

  listTasks(input: { domain?: string; includeResolved?: boolean } = {}) {
    return this.queryService.listTasks(input);
  }

  getNextPendingTaskId(taskId: string, input: { domain?: string } = {}) {
    return this.queryService.getNextPendingTaskId(taskId, input);
  }

  getFirstPendingTaskId(input: { domain?: string } = {}) {
    return this.queryService.getFirstPendingTaskId(input);
  }

  getDomainCatalog() {
    return this.queryService.getDomainCatalog();
  }

  getConnectorReadiness() {
    return this.queryService.getConnectorReadiness();
  }

  getCodeExecutionProjects() {
    return this.queryService.getCodeExecutionProjects();
  }

  getTaskDetail(taskId: string) {
    return this.queryService.getTaskDetail(taskId);
  }

  async pollSlackMentions() {
    return this.backgroundService.pollSlackMentions();
  }

  async pollGitHubReviews() {
    return this.backgroundService.pollGitHubReviews();
  }

  async generateDraft(taskId: string, options: Record<string, unknown> = {}) {
    return this.commandService.generateDraft(taskId, options);
  }

  async runSlackCodeReview(taskId: string, options: Record<string, unknown> = {}) {
    return this.commandService.runSlackCodeReview(taskId, options);
  }

  async startSlackCodeReview(taskId: string, options: Record<string, unknown> = {}) {
    return this.commandService.startSlackCodeReview(taskId, options);
  }

  async createCodeExecutionTask(input: Record<string, unknown>) {
    return this.commandService.createCodeExecutionTask(input);
  }

  async startCodeExecutionTask(taskId: string) {
    return this.commandService.startCodeExecutionTask(taskId);
  }

  async resumeCodeExecutionTask(taskId: string) {
    return this.commandService.resumeCodeExecutionTask(taskId);
  }

  async createCodeExecutionPullRequest(taskId: string, options: Record<string, unknown> = {}) {
    return this.commandService.createCodeExecutionPullRequest(taskId, options);
  }

  saveDraft(taskId: string, input: {
    content?: string;
    summary?: string;
    metadata?: Record<string, unknown>;
  }) {
    return this.commandService.saveDraft(taskId, input);
  }

  approveTask(taskId: string) {
    return this.commandService.approveTask(taskId);
  }

  ignoreTask(taskId: string) {
    return this.commandService.ignoreTask(taskId);
  }

  async executeTask(taskId: string, input: {
    message?: string;
    reactionName?: string;
    addReaction?: boolean;
  }) {
    return this.commandService.executeTask(taskId, input);
  }
}
