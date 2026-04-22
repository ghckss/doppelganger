import {
  CODE_EXECUTION_RECOVERY_ERROR,
  CODE_REVIEW_RECOVERY_ERROR,
  toInteger,
  type TaskCommandServiceLike,
  type TaskModuleDependencies,
  type TaskQueryServiceLike
} from './task-types.ts';

interface TaskBackgroundDependencies extends TaskModuleDependencies {
  queryService: TaskQueryServiceLike;
  commandService: TaskCommandServiceLike;
}

export class TaskBackgroundService {
  repo: any;
  domains: Record<string, any>;
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

  async pollSlackMentions() {
    const domain = this.domains.slack_mention;
    const pollResult = await domain.poll();
    const pendingSlackTasks = this.queryService.listTasks({ domain: 'slack_mention', includeResolved: false });
    let autoCodeReviewsStarted = 0;
    let autoCodeReviewsSkipped = 0;

    for (const task of pendingSlackTasks) {
      const analysisStatus = String(task.payload?.codeReview?.analysisStatus || '').toLowerCase();
      if (analysisStatus && analysisStatus !== 'not_requested') {
        autoCodeReviewsSkipped += 1;
        continue;
      }

      const started = await this.commandService.startSlackCodeReview(task.id, {});
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
}
