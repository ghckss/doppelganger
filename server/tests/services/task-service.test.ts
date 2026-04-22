import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRepository } from '../../src/infra/db.ts';
import { parseSlackStyleMemory, SLACK_STYLE_MEMORY_STATE_KEY } from '../../src/modules/slack/slack-style-memory.ts';
import { TaskService } from '../../src/modules/tasks/task.service.ts';

function createRepo() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-task-service-'));
  return createRepository(path.join(tempDir, 'agent.db'));
}

test('TaskService hides resolved tasks from the default queue but can include them explicitly', () => {
  const repo = createRepo();
  repo.upsertTask({
    domain: 'slack_mention',
    kind: 'reply',
    externalId: 'active',
    title: 'Active task',
    status: 'drafted',
    payload: {}
  });
  repo.upsertTask({
    domain: 'slack_mention',
    kind: 'reply',
    externalId: 'done',
    title: 'Done task',
    status: 'done',
    payload: {}
  });
  repo.upsertTask({
    domain: 'slack_mention',
    kind: 'reply',
    externalId: 'ignored',
    title: 'Ignored task',
    status: 'ignored',
    payload: {}
  });

  const service = new TaskService({
    config: {},
    repo,
    domains: {}
  });

  assert.deepEqual(service.listTasks().map((task) => task.external_id), ['active']);
  assert.deepEqual(
    service.listTasks({ includeResolved: true }).map((task) => task.external_id).sort(),
    ['active', 'done', 'ignored']
  );
});

test('TaskService allows saving an empty Slack draft when a reaction emoji is provided', () => {
  const repo = createRepo();
  const task = repo.upsertTask({
    domain: 'slack_mention',
    kind: 'reply',
    externalId: 'reaction-only',
    title: 'Reaction only task',
    status: 'new',
    payload: {}
  });

  const service = new TaskService({
    config: {},
    repo,
    domains: {}
  });

  service.saveDraft(task.id, {
    content: '',
    summary: '요약',
    metadata: {
      sendMode: 'reaction',
      reactionName: 'white_check_mark'
    }
  });

  const latestDraft = repo.getLatestDraft(task.id);
  assert.equal(latestDraft.content, '');
  assert.equal(latestDraft.metadata.sendMode, 'reaction');
  assert.equal(latestDraft.metadata.reactionName, 'white_check_mark');
});

test('TaskService stores sent Slack reply as style feedback memory', async () => {
  const repo = createRepo();
  const task = repo.upsertTask({
    domain: 'slack_mention',
    kind: 'reply',
    externalId: 'style-feedback',
    title: 'Style feedback task',
    status: 'drafted',
    payload: {
      text: '<@U123> 공유 부탁드립니다.'
    }
  });
  repo.createDraft(task.id, '확인했습니다. 정리해서 공유드리겠습니다.', {
    provider: 'cli:codex'
  });
  repo.createDraft(task.id, '확인했습니다.\n범위와 일정 정리해서 전달드리겠습니다.', {
    provider: 'manual',
    sendMode: 'reply'
  });

  const service = new TaskService({
    config: {},
    repo,
    domains: {
      slack_mention: {
        execute: async () => ({
          provider: 'slack',
          response: {
            ok: true
          }
        })
      }
    }
  });

  await service.executeTask(task.id, {
    message: '확인했습니다.\n범위와 일정 정리해서 전달드리겠습니다.',
    reactionName: '',
    addReaction: false
  });

  const savedRaw = repo.getState(SLACK_STYLE_MEMORY_STATE_KEY, '');
  const memory = parseSlackStyleMemory(savedRaw);
  assert.equal(memory.entries.length, 1);
  assert.equal(memory.entries[0].taskId, task.id);
  assert.match(memory.entries[0].prompt, /공유 부탁드립니다/);
  assert.equal(memory.entries[0].generatedReply, '확인했습니다. 정리해서 공유드리겠습니다.');
  assert.equal(memory.entries[0].finalReply, '확인했습니다.\n범위와 일정 정리해서 전달드리겠습니다.');
  assert.equal(memory.entries[0].finalReply.includes('\n'), true);
  assert.equal(memory.entries[0].changed, true);
});

test('TaskService picks the next pending Slack task in queue order', () => {
  const repo = createRepo();
  const oldest = repo.upsertTask({
    domain: 'slack_mention',
    kind: 'reply',
    externalId: 'oldest',
    title: 'Oldest task',
    status: 'drafted',
    payload: {}
  });
  const middle = repo.upsertTask({
    domain: 'slack_mention',
    kind: 'reply',
    externalId: 'middle',
    title: 'Middle task',
    status: 'drafted',
    payload: {}
  });
  const newest = repo.upsertTask({
    domain: 'slack_mention',
    kind: 'reply',
    externalId: 'newest',
    title: 'Newest task',
    status: 'drafted',
    payload: {}
  });
  const updateTimestamps = repo.db.prepare('UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?');
  updateTimestamps.run('2026-04-09T00:00:01.000Z', '2026-04-09T00:00:01.000Z', oldest.id);
  updateTimestamps.run('2026-04-09T00:00:02.000Z', '2026-04-09T00:00:02.000Z', middle.id);
  updateTimestamps.run('2026-04-09T00:00:03.000Z', '2026-04-09T00:00:03.000Z', newest.id);

  const service = new TaskService({
    config: {},
    repo,
    domains: {}
  });

  assert.equal(service.getNextPendingTaskId(newest.id, { domain: 'slack_mention' }), middle.id);
  assert.equal(service.getNextPendingTaskId(middle.id, { domain: 'slack_mention' }), oldest.id);
  assert.equal(service.getNextPendingTaskId(oldest.id, { domain: 'slack_mention' }), newest.id);
});

test('TaskService returns null when the current Slack task is the last pending item', () => {
  const repo = createRepo();
  const onlyTask = repo.upsertTask({
    domain: 'slack_mention',
    kind: 'reply',
    externalId: 'only-task',
    title: 'Only task',
    status: 'drafted',
    payload: {}
  });

  const service = new TaskService({
    config: {},
    repo,
    domains: {}
  });

  assert.equal(service.getNextPendingTaskId(onlyTask.id, { domain: 'slack_mention' }), null);
});

test('TaskService returns the first pending Slack task in queue order', () => {
  const repo = createRepo();
  const oldest = repo.upsertTask({
    domain: 'slack_mention',
    kind: 'reply',
    externalId: 'oldest',
    title: 'Oldest task',
    status: 'drafted',
    payload: {}
  });
  repo.upsertTask({
    domain: 'slack_mention',
    kind: 'reply',
    externalId: 'ignored',
    title: 'Ignored task',
    status: 'ignored',
    payload: {}
  });
  const newest = repo.upsertTask({
    domain: 'slack_mention',
    kind: 'reply',
    externalId: 'newest',
    title: 'Newest task',
    status: 'drafted',
    payload: {}
  });
  const updateTimestamps = repo.db.prepare('UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?');
  updateTimestamps.run('2026-04-09T00:00:01.000Z', '2026-04-09T00:00:01.000Z', oldest.id);
  updateTimestamps.run('2026-04-09T00:00:03.000Z', '2026-04-09T00:00:03.000Z', newest.id);

  const service = new TaskService({
    config: {},
    repo,
    domains: {}
  });

  assert.equal(service.getFirstPendingTaskId({ domain: 'slack_mention' }), newest.id);
});

test('TaskService does not start Slack code review automatically after mention polling', async () => {
  const repo = createRepo();
  repo.upsertTask({
    domain: 'slack_mention',
    kind: 'reply',
    externalId: 'auto-review',
    title: 'Auto review',
    status: 'drafted',
    payload: {
      codeReview: {
        analysisStatus: 'not_requested'
      }
    }
  });
  repo.upsertTask({
    domain: 'slack_mention',
    kind: 'reply',
    externalId: 'skip-review',
    title: 'Skip review',
    status: 'drafted',
    payload: {
      codeReview: {
        analysisStatus: 'completed'
      }
    }
  });

  let runCodeReviewCalls = 0;
  const service = new TaskService({
    config: {},
    repo,
    domains: {
      slack_mention: {
        poll: async () => ({
          domain: 'slack_mention',
          matchesFound: 2,
          tasksProcessed: 2,
          draftsGenerated: 0
        }),
        runCodeReview: async () => {
          runCodeReviewCalls += 1;
          return {
            analysis: {}
          };
        }
      }
    }
  });

  const result = await service.pollSlackMentions();

  assert.equal(result.matchesFound, 2);
  assert.equal(result.autoCodeReviewsStarted, 0);
  assert.equal(result.autoCodeReviewsSkipped, 0);
  assert.equal(runCodeReviewCalls, 0);
});

test('TaskService recovers interrupted background jobs on initialization', () => {
  const repo = createRepo();
  const codeTask = repo.upsertTask({
    domain: 'code_execution',
    kind: 'implementation',
    externalId: 'code-running',
    title: 'Interrupted code execution',
    status: 'running',
    summary: '코딩 에이전트를 실행하는 중입니다',
    payload: {},
    result: {
      executionProgress: {
        phase: 'coding',
        label: '코딩 에이전트 실행',
        currentStep: 3,
        totalSteps: 8,
        percent: 38
      }
    }
  });
  const slackTask = repo.upsertTask({
    domain: 'slack_mention',
    kind: 'reply',
    externalId: 'slack-running-review',
    title: 'Interrupted slack review',
    status: 'drafted',
    payload: {
      codeReview: {
        analysisStatus: 'running',
        progressStep: 4,
        progressTotalSteps: 6,
        progressPercent: 67,
        progressLabel: '코드 근거 분석 중'
      }
    }
  });

  const service = new TaskService({
    config: {},
    repo,
    domains: {}
  });

  assert.deepEqual(service.recoverySummary, {
    codeExecutionRecovered: 1,
    slackCodeReviewRecovered: 1
  });

  const recoveredCodeTask = repo.getTask(codeTask.id);
  assert.equal(recoveredCodeTask.status, 'failed');
  assert.equal(recoveredCodeTask.result.executionProgress.phase, 'failed');
  assert.equal(recoveredCodeTask.result.executionProgress.currentStep, 3);
  assert.equal(recoveredCodeTask.result.executionProgress.totalSteps, 8);
  assert.equal(recoveredCodeTask.result.executionProgress.percent, 38);
  assert.match(recoveredCodeTask.last_error, /앱이 재시작되어 코드 작업 실행이 중단되었습니다/);

  const recoveredSlackTask = repo.getTask(slackTask.id);
  assert.equal(recoveredSlackTask.payload.codeReview.analysisStatus, 'failed');
  assert.equal(recoveredSlackTask.payload.codeReview.progressStep, 4);
  assert.equal(recoveredSlackTask.payload.codeReview.progressTotalSteps, 6);
  assert.equal(recoveredSlackTask.payload.codeReview.progressPercent, 67);
  assert.match(recoveredSlackTask.payload.codeReview.error, /앱이 재시작되어 코드 검토 실행이 중단되었습니다/);

  const codeExecutionActions = repo.listExecutions(codeTask.id).map((execution) => execution.action);
  const slackRecoveryActions = repo.listExecutions(slackTask.id).map((execution) => execution.action);
  assert.ok(codeExecutionActions.includes('recover_code_execution_run'));
  assert.ok(slackRecoveryActions.includes('recover_slack_code_review'));
});

test('TaskService resumes failed code execution tasks', async () => {
  const repo = createRepo();
  const task = repo.upsertTask({
    domain: 'code_execution',
    kind: 'implementation',
    externalId: 'resume-target',
    title: 'Resume target',
    status: 'failed',
    payload: {},
    result: {
      executionProgress: {
        phase: 'failed',
        label: '실패',
        currentStep: 3,
        totalSteps: 8,
        percent: 38
      }
    }
  });

  let startedTaskId = '';
  const service = new TaskService({
    config: {},
    repo,
    domains: {
      code_execution: {
        start: async (taskId) => {
          startedTaskId = taskId;
          return { started: true };
        }
      }
    }
  });

  const detail = await service.resumeCodeExecutionTask(task.id);
  assert.equal(startedTaskId, task.id);
  assert.equal(detail.task.id, task.id);

  const executionActions = repo.listExecutions(task.id).map((execution) => execution.action);
  assert.ok(executionActions.includes('resume_code_execution'));
});

test('TaskService rejects resume for non-resumable code execution status', async () => {
  const repo = createRepo();
  const task = repo.upsertTask({
    domain: 'code_execution',
    kind: 'implementation',
    externalId: 'resume-reject',
    title: 'Resume reject',
    status: 'awaiting_approval',
    payload: {}
  });

  const service = new TaskService({
    config: {},
    repo,
    domains: {
      code_execution: {
        start: async () => ({ started: true })
      }
    }
  });

  await assert.rejects(
    service.resumeCodeExecutionTask(task.id),
    /재개 가능한 상태가 아닙니다/
  );
});

test('TaskService reports already-running state when starting code execution task', async () => {
  const repo = createRepo();
  const task = repo.upsertTask({
    domain: 'code_execution',
    kind: 'implementation',
    externalId: 'start-already-running',
    title: 'Start already running',
    status: 'running',
    payload: {}
  });

  const service = new TaskService({
    config: {},
    repo,
    domains: {
      code_execution: {
        start: async () => ({ started: false })
      }
    }
  });

  await assert.rejects(
    service.startCodeExecutionTask(task.id),
    /작업이 이미 실행 중입니다/
  );
});
