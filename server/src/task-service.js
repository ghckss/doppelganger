import { getConnectorReadiness } from './config.js';

const CODE_EXECUTION_RECOVERY_ERROR = '앱이 재시작되어 코드 작업 실행이 중단되었습니다. 작업을 다시 실행해 주세요.';
const CODE_REVIEW_RECOVERY_ERROR = '앱이 재시작되어 코드 검토 실행이 중단되었습니다. 코드 검토를 다시 실행해 주세요.';

function assertTask(taskId, task) {
  if (!task) {
    throw new Error(`작업을 찾을 수 없습니다: ${taskId}`);
  }

  return task;
}

function toInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.trunc(parsed);
}

export class TaskService {
  constructor({ config, repo, domains }) {
    this.config = config;
    this.repo = repo;
    this.domains = domains;
    this.slackCodeReviewJobs = new Map();
    this.recoverySummary = this.recoverInterruptedBackgroundJobs();
  }

  recoverInterruptedBackgroundJobs() {
    const tasks = this.repo.listTasks();
    const recoveredAt = new Date().toISOString();
    let codeExecutionRecovered = 0;
    let slackCodeReviewRecovered = 0;

    for (const task of tasks) {
      if (task.domain === 'code_execution' && task.status === 'running') {
        const currentResult = task.result && typeof task.result === 'object' ? task.result : {};
        const previousProgress = currentResult.executionProgress && typeof currentResult.executionProgress === 'object'
          ? currentResult.executionProgress
          : {};
        const totalSteps = Math.max(1, toInteger(previousProgress.totalSteps, 8));
        const currentStep = Math.max(0, Math.min(totalSteps, toInteger(previousProgress.currentStep, 0)));
        const inferredPercent = Math.round((currentStep / totalSteps) * 100);
        const percent = Math.max(0, Math.min(99, toInteger(previousProgress.percent, inferredPercent)));
        this.repo.updateTask(task.id, {
          status: 'failed',
          summary: '중단된 코드 작업을 자동 복구했습니다. 다시 실행해 주세요.',
          result: {
            ...currentResult,
            executionProgress: {
              ...previousProgress,
              phase: 'failed',
              label: '앱 재시작으로 코드 작업이 중단되었습니다. 다시 실행해 주세요.',
              currentStep,
              totalSteps,
              percent
            }
          },
          lastError: CODE_EXECUTION_RECOVERY_ERROR
        });
        this.repo.logExecution(task.id, 'recover_code_execution_run', 'success', {
          response: {
            recoveredAt,
            reason: 'process_restart'
          }
        });
        codeExecutionRecovered += 1;
      }

      if (task.domain === 'slack_mention') {
        const codeReview = task.payload?.codeReview;
        if (String(codeReview?.analysisStatus || '').toLowerCase() !== 'running') {
          continue;
        }

        const totalSteps = Math.max(1, toInteger(codeReview.progressTotalSteps, 6));
        const progressStep = Math.max(0, Math.min(totalSteps, toInteger(codeReview.progressStep, 0)));
        const inferredPercent = Math.round((progressStep / totalSteps) * 100);
        const progressPercent = Math.max(0, Math.min(99, toInteger(codeReview.progressPercent, inferredPercent)));

        this.repo.updateTask(task.id, {
          payload: {
            ...(task.payload || {}),
            codeReview: {
              ...(codeReview || {}),
              analysisStatus: 'failed',
              progressStep,
              progressTotalSteps: totalSteps,
              progressPercent,
              progressLabel: '앱 재시작으로 코드 검토가 중단되었습니다. 다시 실행해 주세요.',
              analyzedAt: recoveredAt,
              error: CODE_REVIEW_RECOVERY_ERROR
            }
          },
          lastError: CODE_REVIEW_RECOVERY_ERROR
        });
        this.repo.logExecution(task.id, 'recover_slack_code_review', 'success', {
          response: {
            recoveredAt,
            reason: 'process_restart'
          }
        });
        slackCodeReviewRecovered += 1;
      }
    }

    return {
      codeExecutionRecovered,
      slackCodeReviewRecovered
    };
  }

  listTasks({ domain, includeResolved = false } = {}) {
    const tasks = this.repo.listTasks({ domain });
    if (includeResolved) {
      return tasks;
    }

    return tasks.filter((task) => task.status !== 'done' && task.status !== 'ignored');
  }

  getNextPendingTaskId(taskId, { domain } = {}) {
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

  getFirstPendingTaskId({ domain } = {}) {
    return this.listTasks({ domain, includeResolved: false })[0]?.id || null;
  }

  getDomainCatalog() {
    const readiness = getConnectorReadiness(this.config);

    return Object.values(this.domains).map((domain) => ({
      id: domain.id,
      label: domain.label,
      implemented: domain.implemented,
      capabilities: domain.capabilities,
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

  getTaskDetail(taskId) {
    const task = assertTask(taskId, this.repo.getTask(taskId));
    const artifacts = this.repo.listArtifacts(taskId);
    const drafts = this.repo.listDrafts(taskId);
    const executions = this.repo.listExecutions(taskId);
    const domain = this.domains[task.domain] || null;

    return {
      task,
      artifacts,
      drafts,
      latestDraft: drafts[0] || null,
      executions,
      domain
    };
  }

  async pollSlackMentions() {
    const domain = this.domains.slack_mention;
    const pollResult = await domain.poll();
    const pendingSlackTasks = this.listTasks({ domain: 'slack_mention', includeResolved: false });
    let autoCodeReviewsStarted = 0;
    let autoCodeReviewsSkipped = 0;

    for (const task of pendingSlackTasks) {
      const analysisStatus = String(task.payload?.codeReview?.analysisStatus || '').toLowerCase();
      if (analysisStatus && analysisStatus !== 'not_requested') {
        autoCodeReviewsSkipped += 1;
        continue;
      }

      const started = await this.startSlackCodeReview(task.id, {});
      if (started.started) {
        autoCodeReviewsStarted += 1;
      } else {
        autoCodeReviewsSkipped += 1;
      }
    }

    return {
      ...pollResult,
      autoCodeReviewsStarted,
      autoCodeReviewsSkipped
    };
  }

  async pollGitHubReviews() {
    const domain = this.domains.github_review;
    return domain.poll();
  }

  async generateDraft(taskId, options = {}) {
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

    return this.getTaskDetail(taskId);
  }

  async runSlackCodeReview(taskId, options = {}) {
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
      return this.getTaskDetail(taskId);
    } catch (error) {
      this.repo.logExecution(taskId, 'run_slack_code_review', 'failed', {
        request: options,
        error: error.message
      });
      throw error;
    }
  }

  async startSlackCodeReview(taskId, options = {}) {
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
        detail: this.getTaskDetail(taskId)
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
      detail: this.getTaskDetail(taskId)
    };
  }

  async createCodeExecutionTask(input) {
    const domain = this.domains.code_execution;
    if (!domain?.createTask) {
      throw new Error('코드 작업 도메인을 사용할 수 없습니다');
    }

    const task = await domain.createTask(input);
    await domain.start(task.id, { resumeFromCheckpoint: false });
    return this.getTaskDetail(task.id);
  }

  async startCodeExecutionTask(taskId) {
    const task = assertTask(taskId, this.repo.getTask(taskId));
    if (task.domain !== 'code_execution') {
      throw new Error(`해당 작업은 코드 작업이 아닙니다: ${taskId}`);
    }

    const domain = this.domains.code_execution;
    const started = await domain.start(taskId, { resumeFromCheckpoint: false });
    if (started && typeof started === 'object' && started.started === false) {
      throw new Error('작업이 이미 실행 중입니다');
    }
    return this.getTaskDetail(taskId);
  }

  async resumeCodeExecutionTask(taskId) {
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
    return this.getTaskDetail(taskId);
  }

  async createCodeExecutionPullRequest(taskId, options = {}) {
    const task = assertTask(taskId, this.repo.getTask(taskId));
    if (task.domain !== 'code_execution') {
      throw new Error(`해당 작업은 코드 작업이 아닙니다: ${taskId}`);
    }

    const domain = this.domains.code_execution;
    await domain.createPullRequest(taskId, options);
    return this.getTaskDetail(taskId);
  }

  saveDraft(taskId, { content, summary, metadata = {} }) {
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
    };
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
    return this.getTaskDetail(taskId);
  }

  approveTask(taskId) {
    assertTask(taskId, this.repo.getTask(taskId));
    this.repo.updateTask(taskId, {
      status: 'awaiting_approval',
      approvalState: 'approved'
    });
    this.repo.logExecution(taskId, 'approve', 'success');
    return this.getTaskDetail(taskId);
  }

  ignoreTask(taskId) {
    assertTask(taskId, this.repo.getTask(taskId));
    this.repo.updateTask(taskId, {
      status: 'ignored',
      approvalState: 'rejected'
    });
    this.repo.logExecution(taskId, 'ignore', 'success');
    return this.getTaskDetail(taskId);
  }

  async executeTask(taskId, { message, reactionName, addReaction }) {
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
    } catch (error) {
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

    return this.getTaskDetail(taskId);
  }
}
