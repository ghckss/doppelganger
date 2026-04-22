import {
  CODE_EXECUTION_RECOVERY_ERROR,
  CODE_REVIEW_RECOVERY_ERROR,
  toInteger,
  type TaskCommandServiceLike,
  type TaskDomainMap,
  type TaskModuleDependencies,
  type TaskRepository,
  type TaskQueryServiceLike
} from './task-types.ts';

interface TaskBackgroundDependencies extends TaskModuleDependencies {
  queryService: TaskQueryServiceLike;
  commandService: TaskCommandServiceLike;
}

interface SlackPollResult {
  matchesFound?: number;
  tasksProcessed?: number;
  draftsGenerated?: number;
  autoCodeReviewsStarted: number;
  autoCodeReviewsSkipped: number;
  [key: string]: unknown;
}

export class TaskBackgroundService {
  repo: TaskRepository;
  domains: TaskDomainMap;
  queryService: TaskQueryServiceLike;
  commandService: TaskCommandServiceLike;

  constructor({ repo, domains, queryService, commandService }: TaskBackgroundDependencies) {
    this.repo = repo;
    this.domains = domains;
    this.queryService = queryService;
    this.commandService = commandService;
  }

  recoverInterruptedBackgroundJobs() {
    const tasks = this.repo.listTasks();
    const recoveredAt = new Date().toISOString();
    let codeExecutionRecovered = 0;
    let slackCodeReviewRecovered = 0;

    for (const task of tasks) {
      if (task.domain === 'code_execution' && task.status === 'running') {
        const currentResult = task.result && typeof task.result === 'object'
          ? task.result as Record<string, unknown>
          : {};
        const previousProgressRaw = currentResult.executionProgress;
        const previousProgress = previousProgressRaw && typeof previousProgressRaw === 'object'
          ? previousProgressRaw as Record<string, unknown>
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
        const payload = task.payload && typeof task.payload === 'object'
          ? task.payload as Record<string, unknown>
          : {};
        const codeReviewRaw = payload.codeReview;
        const codeReview = codeReviewRaw && typeof codeReviewRaw === 'object'
          ? codeReviewRaw as Record<string, unknown>
          : {};
        if (String(codeReview.analysisStatus || '').toLowerCase() !== 'running') {
          continue;
        }

        const totalSteps = Math.max(1, toInteger(codeReview.progressTotalSteps, 6));
        const progressStep = Math.max(0, Math.min(totalSteps, toInteger(codeReview.progressStep, 0)));
        const inferredPercent = Math.round((progressStep / totalSteps) * 100);
        const progressPercent = Math.max(0, Math.min(99, toInteger(codeReview.progressPercent, inferredPercent)));

        this.repo.updateTask(task.id, {
          payload: {
            ...payload,
            codeReview: {
              ...codeReview,
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

  async pollSlackMentions(): Promise<SlackPollResult> {
    const domain = this.domains.slack_mention;
    const pollResult = await domain.poll();
    const autoCodeReviewsStarted = 0;
    const autoCodeReviewsSkipped = 0;

    return {
      ...((pollResult && typeof pollResult === 'object' ? pollResult : {}) as Record<string, unknown>),
      autoCodeReviewsStarted,
      autoCodeReviewsSkipped
    };
  }

  async pollGitHubReviews() {
    const domain = this.domains.github_review;
    return domain.poll();
  }
}
