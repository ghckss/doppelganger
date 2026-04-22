import {
  appendSlackStyleMemory,
  SLACK_STYLE_MEMORY_STATE_KEY,
  stringifySlackStyleMemory
} from '../../slack-style-memory.ts';
import {
  assertTask,
  type TaskModuleDependencies,
  type TaskQueryServiceLike
} from './task-types.ts';

interface TaskCommandDependencies extends TaskModuleDependencies {
  queryService: TaskQueryServiceLike;
  slackCodeReviewJobs: Map<string, Promise<unknown>>;
}

export class TaskCommandService {
  config: any;
  repo: any;
  domains: Record<string, any>;
  queryService: TaskQueryServiceLike;
  slackCodeReviewJobs: Map<string, Promise<unknown>>;

  constructor({ config, repo, domains, queryService, slackCodeReviewJobs }: TaskCommandDependencies) {
    this.config = config;
    this.repo = repo;
    this.domains = domains;
    this.queryService = queryService;
    this.slackCodeReviewJobs = slackCodeReviewJobs;
  }

  async generateDraft(taskId: string, options: Record<string, unknown> = {}) {
    const task = assertTask(taskId, this.repo.getTask(taskId));
    const domain = this.domains[task.domain];
    if (!domain?.generateDraft) {
      throw new Error(`${task.domain} 도메인은 초안 생성을 지원하지 않습니다`);
    }

    const generated = await domain.generateDraft(task, options);
    this.repo.logExecution(taskId, 'generate_draft', 'success', {
      request: options,
      response: generated.generated
    });

    return this.queryService.getTaskDetail(taskId);
  }

  async runSlackCodeReview(taskId: string, options: Record<string, unknown> = {}) {
    const task = assertTask(taskId, this.repo.getTask(taskId));
    if (task.domain !== 'slack_mention') {
      throw new Error(`해당 작업은 슬랙 멘션이 아닙니다: ${taskId}`);
    }

    const domain = this.domains.slack_mention;
    if (!domain?.runCodeReview) {
      throw new Error('슬랙 도메인에서 코드 검토 실행을 지원하지 않습니다');
    }

    try {
      const result = await domain.runCodeReview(task, options);
      this.repo.logExecution(taskId, 'run_slack_code_review', 'success', {
        request: options,
        response: {
          analysis: result.analysis
        }
      });
      return this.queryService.getTaskDetail(taskId);
    } catch (error: any) {
      this.repo.logExecution(taskId, 'run_slack_code_review', 'failed', {
        request: options,
        error: error.message
      });
      throw error;
    }
  }

  async startSlackCodeReview(taskId: string, options: Record<string, unknown> = {}) {
    const task = assertTask(taskId, this.repo.getTask(taskId));
    if (task.domain !== 'slack_mention') {
      throw new Error(`해당 작업은 슬랙 멘션이 아닙니다: ${taskId}`);
    }

    const domain = this.domains.slack_mention;
    if (!domain?.runCodeReview) {
      throw new Error('슬랙 도메인에서 코드 검토 실행을 지원하지 않습니다');
    }

    if (this.slackCodeReviewJobs.has(taskId)) {
      return {
        started: false,
        alreadyRunning: true,
        detail: this.queryService.getTaskDetail(taskId)
      };
    }

    const jobPromise = (async () => {
      try {
        await this.runSlackCodeReview(taskId, options);
      } catch {
        // 실패 상세는 runSlackCodeReview에서 이미 실행 로그/태스크 상태에 반영됨
      } finally {
        this.slackCodeReviewJobs.delete(taskId);
      }
    })();
    this.slackCodeReviewJobs.set(taskId, jobPromise);

    return {
      started: true,
      alreadyRunning: false,
      detail: this.queryService.getTaskDetail(taskId)
    };
  }

  async createCodeExecutionTask(input: Record<string, unknown>) {
    const domain = this.domains.code_execution;
    if (!domain?.createTask) {
      throw new Error('코드 작업 도메인을 사용할 수 없습니다');
    }

    const task = await domain.createTask(input);
    await domain.start(task.id, { resumeFromCheckpoint: false });
    return this.queryService.getTaskDetail(task.id);
  }

  async startCodeExecutionTask(taskId: string) {
    const task = assertTask(taskId, this.repo.getTask(taskId));
    if (task.domain !== 'code_execution') {
      throw new Error(`해당 작업은 코드 작업이 아닙니다: ${taskId}`);
    }

    const domain = this.domains.code_execution;
    const started = await domain.start(taskId, { resumeFromCheckpoint: false });
    if (started && typeof started === 'object' && started.started === false) {
      throw new Error('작업이 이미 실행 중입니다');
    }
    return this.queryService.getTaskDetail(taskId);
  }

  async resumeCodeExecutionTask(taskId: string) {
    const task = assertTask(taskId, this.repo.getTask(taskId));
    if (task.domain !== 'code_execution') {
      throw new Error(`해당 작업은 코드 작업이 아닙니다: ${taskId}`);
    }

    const status = String(task.status || '').toLowerCase();
    if (!['failed', 'running'].includes(status)) {
      throw new Error(`재개 가능한 상태가 아닙니다: ${task.status}`);
    }

    const domain = this.domains.code_execution;
    const started = await domain.start(taskId, { resumeFromCheckpoint: true });
    if (started && typeof started === 'object' && started.started === false) {
      throw new Error('작업이 이미 실행 중입니다');
    }
    this.repo.logExecution(taskId, 'resume_code_execution', 'success');
    return this.queryService.getTaskDetail(taskId);
  }

  async createCodeExecutionPullRequest(taskId: string, options: Record<string, unknown> = {}) {
    const task = assertTask(taskId, this.repo.getTask(taskId));
    if (task.domain !== 'code_execution') {
      throw new Error(`해당 작업은 코드 작업이 아닙니다: ${taskId}`);
    }

    const domain = this.domains.code_execution;
    await domain.createPullRequest(taskId, options);
    return this.queryService.getTaskDetail(taskId);
  }

  saveDraft(taskId: string, {
    content,
    summary,
    metadata = {}
  }: {
    content?: string;
    summary?: string;
    metadata?: Record<string, unknown>;
  }) {
    const task = assertTask(taskId, this.repo.getTask(taskId));
    const sendMode = String(metadata.sendMode || '').trim() || 'reply';
    const normalizedContent = sendMode === 'reaction' ? '' : String(content || '').trim();
    const latestDraft = this.repo.getLatestDraft(taskId);
    const reactionName = sendMode === 'reaction'
      ? String(metadata.reactionName || latestDraft?.metadata?.reactionName || '').trim()
      : '';
    const allowReactionOnly = task.domain === 'slack_mention' && Boolean(reactionName);

    if (!normalizedContent && !allowReactionOnly) {
      throw new Error('초안 내용이 필요합니다');
    }

    const nextMetadata = {
      ...(latestDraft?.metadata || {}),
      ...metadata,
      sendMode,
      provider: 'manual'
    } as Record<string, unknown>;
    if (sendMode !== 'reaction' || !nextMetadata.reactionName) {
      delete nextMetadata.reactionName;
    }

    this.repo.createDraft(taskId, normalizedContent, nextMetadata);
    this.repo.updateTask(taskId, {
      status: 'drafted',
      summary: summary === undefined ? task.summary : String(summary || '').trim(),
      approvalState: 'pending',
      lastError: null
    });
    this.repo.logExecution(taskId, 'save_draft', 'success');
    return this.queryService.getTaskDetail(taskId);
  }

  approveTask(taskId: string) {
    assertTask(taskId, this.repo.getTask(taskId));
    this.repo.updateTask(taskId, {
      status: 'awaiting_approval',
      approvalState: 'approved'
    });
    this.repo.logExecution(taskId, 'approve', 'success');
    return this.queryService.getTaskDetail(taskId);
  }

  ignoreTask(taskId: string) {
    assertTask(taskId, this.repo.getTask(taskId));
    this.repo.updateTask(taskId, {
      status: 'ignored',
      approvalState: 'rejected'
    });
    this.repo.logExecution(taskId, 'ignore', 'success');
    return this.queryService.getTaskDetail(taskId);
  }

  async executeTask(taskId: string, { message, reactionName, addReaction }: {
    message?: string;
    reactionName?: string;
    addReaction?: boolean;
  }) {
    const task = assertTask(taskId, this.repo.getTask(taskId));
    const domain = this.domains[task.domain];
    if (!domain?.execute) {
      throw new Error(`${task.domain} 도메인은 실행을 지원하지 않습니다`);
    }

    this.repo.updateTask(taskId, {
      approvalState: 'approved'
    });

    try {
      const result = await domain.execute(task, {
        message,
        reactionName,
        addReaction
      });
      this.captureSlackStyleFeedback(task, { message });
      this.repo.updateTask(taskId, {
        status: 'done',
        approvalState: 'approved',
        result,
        lastError: null
      });
      this.repo.logExecution(taskId, 'execute', 'success', {
        request: {
          message,
          reactionName,
          addReaction: Boolean(addReaction)
        },
        response: result
      });
    } catch (error: any) {
      this.repo.updateTask(taskId, {
        status: 'failed',
        lastError: error.message
      });
      this.repo.logExecution(taskId, 'execute', 'failed', {
        request: {
          message,
          reactionName,
          addReaction: Boolean(addReaction)
        },
        error: error.message
      });
      throw error;
    }

    return this.queryService.getTaskDetail(taskId);
  }

  captureSlackStyleFeedback(task: any, { message }: { message?: string }) {
    if (!task || task.domain !== 'slack_mention') {
      return;
    }

    const finalReply = String(message || '').trim();
    if (!finalReply) {
      return;
    }

    const drafts = this.repo.listDrafts(task.id);
    const generatedDraft = drafts.find((draft: any) => {
      const provider = String(draft?.metadata?.provider || '').trim().toLowerCase();
      return provider && provider !== 'manual' && String(draft?.content || '').trim();
    });
    const previousMemoryRaw = this.repo.getState(SLACK_STYLE_MEMORY_STATE_KEY, '');
    const nextMemory = appendSlackStyleMemory(previousMemoryRaw, {
      taskId: task.id,
      prompt: task.payload?.text || task.title || '',
      generatedReply: generatedDraft?.content || '',
      finalReply
    });
    this.repo.setState(SLACK_STYLE_MEMORY_STATE_KEY, stringifySlackStyleMemory(nextMemory));
  }
}
