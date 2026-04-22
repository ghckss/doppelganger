// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRepository } from '../src/db.ts';
import { createSlackMentionDomain } from '../src/domains/slack-mention-domain.ts';

function createRepo() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-slack-'));
  return createRepository(path.join(tempDir, 'agent.db'));
}

test('slack mention domain polls mentions, drafts replies, and executes replies', async () => {
  const repo = createRepo();
  const sentReplies = [];
  const addedReactions = [];
  let draftCalls = 0;
  const slackClient = {
    isConfigured: () => true,
    searchMentionsSince: async () => [{
      channelId: 'C123',
      channelName: 'eng',
      ts: '1710000000.000100',
      threadTs: '1710000000.000100',
      permalink: 'https://example.slack.com/archives/C123/p1710000000000100',
      text: '<@U123> can you review this?',
      user: 'U999',
      createdAt: '2026-04-08T00:00:00.000Z'
    }],
    getThread: async () => [
      {
        externalId: '1710000000.000100',
        content: '<@U123> can you review this?',
        metadata: { user: 'U999' }
      },
      {
        externalId: '1710000001.000100',
        content: 'Need answer before lunch.',
        metadata: { user: 'U999' }
      }
    ],
    postReply: async (payload) => {
      sentReplies.push(payload);
      return {
        channel: payload.channelId,
        ts: '1710000002.000100',
        message: {
          text: payload.text
        }
      };
    },
    addReaction: async (payload) => {
      addedReactions.push(payload);
      return {
        ok: true,
        name: payload.name
      };
    }
  };
  const llmService = {
    generateSlackDraft: async () => {
      draftCalls += 1;
      return {
        summary: '점심 전 리뷰 가능 여부 요청이 들어왔고, 지금은 검토 착수 여부와 공유 시점을 짧게 답해야 하는 상황입니다.',
        requestedAction: '처리 시작과 ETA를 답변',
        replyIntent: '리뷰 착수와 공유 시점을 명확히 전달',
        suggestedReply: '확인했습니다. 리뷰 확인해서 코멘트 남기겠습니다.',
        replyCategory: 'action_request',
        replyCategoryLabel: '액션 요청',
        reactionName: 'white_check_mark',
        provider: 'test'
      };
    }
  };

  const domain = createSlackMentionDomain({
    config: {
      slack: {
        initialLookbackMinutes: 10
      }
    },
    repo,
    slackClient,
    llmService
  });

  const pollResult = await domain.poll();
  assert.equal(pollResult.matchesFound, 1);
  assert.equal(pollResult.draftsGenerated, 1);
  assert.equal(draftCalls, 1);

  const task = repo.listTasks()[0];
  assert.ok(task);
  assert.equal(repo.listArtifacts(task.id, 'slack_message').length, 2);
  assert.match(repo.getTask(task.id).summary, /점심 전 리뷰 가능 여부 요청/);
  assert.equal(repo.getLatestDraft(task.id).content, '확인했습니다. 리뷰 확인해서 코멘트 남기겠습니다.');
  assert.equal(repo.getLatestDraft(task.id).metadata.replyCategory, 'action_request');
  assert.equal(repo.getLatestDraft(task.id).metadata.reactionName, 'white_check_mark');
  assert.equal(repo.getLatestDraft(task.id).metadata.replyIntent, '리뷰 착수와 공유 시점을 명확히 전달');

  const executionResult = await domain.execute(repo.getTask(task.id), {
    message: '확인했습니다. 리뷰 확인해서 코멘트 남기겠습니다.',
    reactionName: 'white_check_mark',
    addReaction: true
  });

  assert.equal(executionResult.provider, 'slack');
  assert.equal(sentReplies.length, 1);
  assert.equal(sentReplies[0].channelId, 'C123');
  assert.equal(addedReactions.length, 1);
  assert.equal(addedReactions[0].ts, '1710000000.000100');
});

test('slack mention domain can send reaction only without posting a text reply', async () => {
  const repo = createRepo();
  const sentReplies = [];
  const addedReactions = [];
  const task = repo.upsertTask({
    domain: 'slack_mention',
    kind: 'reply',
    externalId: 'C123:1710000000.000100',
    title: 'Reaction only',
    payload: {
      channelId: 'C123',
      threadTs: '1710000000.000100',
      ts: '1710000000.000100'
    }
  });

  const domain = createSlackMentionDomain({
    config: {
      slack: {
        initialLookbackMinutes: 10
      }
    },
    repo,
    slackClient: {
      isConfigured: () => true,
      postReply: async (payload) => {
        sentReplies.push(payload);
        return {
          channel: payload.channelId,
          ts: '1710000002.000100',
          message: {
            text: payload.text
          }
        };
      },
      addReaction: async (payload) => {
        addedReactions.push(payload);
        return {
          ok: true,
          name: payload.name
        };
      }
    },
    llmService: {
      generateSlackDraft: async () => {
        throw new Error('not used');
      }
    }
  });

  const executionResult = await domain.execute(task, {
    message: '',
    reactionName: 'white_check_mark',
    addReaction: true
  });

  assert.equal(executionResult.provider, 'slack');
  assert.equal(executionResult.response, null);
  assert.equal(sentReplies.length, 0);
  assert.equal(addedReactions.length, 1);
  assert.equal(addedReactions[0].name, 'white_check_mark');
});

test('slack mention domain does not recreate drafts when the thread is unchanged', async () => {
  const repo = createRepo();
  let draftCalls = 0;
  const mention = {
    channelId: 'C123',
    channelName: 'eng',
    ts: '1710000000.000100',
    threadTs: '1710000000.000100',
    permalink: 'https://example.slack.com/archives/C123/p1710000000000100',
    text: '<@U123> can you review this?',
    user: 'U999',
    createdAt: '2026-04-08T00:00:00.000Z'
  };
  const thread = [
    {
      externalId: '1710000000.000100',
      content: '<@U123> can you review this?',
      metadata: { user: 'U999' }
    }
  ];
  const slackClient = {
    isConfigured: () => true,
    searchMentionsSince: async () => [mention],
    getThread: async () => thread
  };
  const llmService = {
    generateSlackDraft: async () => {
      draftCalls += 1;
      return {
        summary: 'Summary',
        requestedAction: 'Reply',
        suggestedReply: 'Reply draft',
        replyCategory: 'action_request',
        replyCategoryLabel: '액션 요청',
        reactionName: 'white_check_mark',
        provider: 'test'
      };
    }
  };

  const domain = createSlackMentionDomain({
    config: {
      slack: {
        initialLookbackMinutes: 10
      }
    },
    repo,
    slackClient,
    llmService
  });

  const firstPoll = await domain.poll();
  const secondPoll = await domain.poll();

  assert.equal(firstPoll.draftsGenerated, 1);
  assert.equal(secondPoll.draftsGenerated, 0);
  assert.equal(draftCalls, 1);
  assert.equal(repo.listDrafts(repo.listTasks()[0].id).length, 1);
});

test('slack mention domain skips mentions already resolved by reply or ignore', async () => {
  const repo = createRepo();
  const mention = {
    channelId: 'C123',
    channelName: 'eng',
    ts: '1710000000.000100',
    threadTs: '1710000000.000100',
    permalink: 'https://example.slack.com/archives/C123/p1710000000000100',
    text: '<@U123> can you review this?',
    user: 'U999',
    createdAt: '2026-04-08T00:00:00.000Z'
  };

  const task = repo.upsertTask({
    domain: 'slack_mention',
    kind: 'reply',
    externalId: `${mention.channelId}:${mention.ts}`,
    title: 'Resolved mention',
    status: 'done',
    payload: {}
  });

  let threadFetches = 0;
  let draftCalls = 0;
  const domain = createSlackMentionDomain({
    config: {
      slack: {
        initialLookbackMinutes: 10
      }
    },
    repo,
    slackClient: {
      isConfigured: () => true,
      searchMentionsSince: async () => [mention],
      getThread: async () => {
        threadFetches += 1;
        return [];
      }
    },
    llmService: {
      generateSlackDraft: async () => {
        draftCalls += 1;
        return {
          summary: 'unused',
          requestedAction: 'unused',
          suggestedReply: 'unused',
          replyCategory: 'action_request',
          replyCategoryLabel: '액션 요청',
          reactionName: '',
          provider: 'test'
        };
      }
    }
  });

  const pollResult = await domain.poll();

  assert.equal(pollResult.matchesFound, 1);
  assert.equal(pollResult.tasksProcessed, 0);
  assert.equal(pollResult.draftsGenerated, 0);
  assert.equal(threadFetches, 0);
  assert.equal(draftCalls, 0);
  assert.equal(repo.getTask(task.id).status, 'done');
});

test('slack mention domain ignores mentions from configured channels', async () => {
  const repo = createRepo();
  let draftCalls = 0;
  const mentions = [
    {
      channelId: 'C_IGNORE',
      channelName: 'ops-alerts',
      ts: '1710000000.000100',
      threadTs: '1710000000.000100',
      permalink: 'https://example.slack.com/archives/C_IGNORE/p1710000000000100',
      text: '<@U123> 장애 알림입니다.',
      user: 'U999',
      createdAt: '2026-04-08T00:00:00.000Z'
    },
    {
      channelId: 'C_WORK',
      channelName: 'eng',
      ts: '1710000001.000100',
      threadTs: '1710000001.000100',
      permalink: 'https://example.slack.com/archives/C_WORK/p1710000001000100',
      text: '<@U123> 리뷰 부탁드립니다.',
      user: 'U999',
      createdAt: '2026-04-08T00:00:01.000Z'
    }
  ];

  const domain = createSlackMentionDomain({
    config: {
      slack: {
        initialLookbackMinutes: 10,
        ignoreChannels: ['C_IGNORE', '#ops-alerts']
      }
    },
    repo,
    slackClient: {
      isConfigured: () => true,
      searchMentionsSince: async () => mentions,
      getThread: async ({ channelId }) => [
        {
          externalId: channelId === 'C_WORK' ? '1710000001.000100' : '1710000000.000100',
          content: 'thread body',
          metadata: { user: 'U999' }
        }
      ]
    },
    llmService: {
      generateSlackDraft: async () => {
        draftCalls += 1;
        return {
          summary: '요약',
          requestedAction: '요청',
          suggestedReply: '답변',
          replyCategory: 'action_request',
          replyCategoryLabel: '액션 요청',
          reactionName: '',
          provider: 'test'
        };
      }
    }
  });

  const pollResult = await domain.poll();

  assert.equal(pollResult.matchesFound, 2);
  assert.equal(pollResult.ignoredChannelsSkipped, 1);
  assert.equal(pollResult.tasksProcessed, 1);
  assert.equal(draftCalls, 1);
  const tasks = repo.listTasks();
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].payload.channelId, 'C_WORK');
});

test('slack mention domain applies overlap to avoid missing near-boundary messages', async () => {
  const repo = createRepo();
  repo.setState('slack_mentions.last_success_at', '2026-04-08T03:20:02.086Z');

  let receivedCutoff = null;
  const slackClient = {
    isConfigured: () => true,
    searchMentionsSince: async ({ cutoffUnixSeconds }) => {
      receivedCutoff = cutoffUnixSeconds;
      return [];
    }
  };

  const domain = createSlackMentionDomain({
    config: {
      slack: {
        initialLookbackMinutes: 10
      }
    },
    repo,
    slackClient,
    llmService: {
      generateSlackDraft: async () => {
        throw new Error('not used');
      }
    }
  });

  await domain.poll();

  assert.equal(receivedCutoff, 1775618282);
});

test('slack mention domain keeps default no-repo-lookup and runs auto repository analysis from detail action', async () => {
  const repo = createRepo();
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-slack-workspace-'));
  const projectPath = path.join(workspaceRoot, 'fromm-web');
  const mappedFolderPath = path.join(projectPath, 'apps', 'channel');
  const docsPath = path.join(workspaceRoot, 'docs', 'fromm');
  fs.mkdirSync(path.join(projectPath, '.git'), { recursive: true });
  fs.mkdirSync(mappedFolderPath, { recursive: true });
  fs.mkdirSync(docsPath, { recursive: true });
  fs.writeFileSync(path.join(docsPath, 'backoffice.md'), '# backoffice\n로그인 정책 문서');
  fs.writeFileSync(path.join(docsPath, 'partner.md'), '# partner\n파트너 서비스 문서');
  fs.writeFileSync(path.join(docsPath, 'channel.md'), '# channel\n채널 서비스 문서');
  fs.writeFileSync(path.join(docsPath, 'store.md'), '# store\n스토어 서비스 문서');
  fs.writeFileSync(path.join(docsPath, 'fromm-web-service-reference.md'), '# legacy\n기존 단일 참조 문서');

  const mention = {
    channelId: 'C123',
    channelName: 'eng',
    ts: '1710000000.000100',
    threadTs: '1710000000.000100',
    permalink: 'https://example.slack.com/archives/C123/p1710000000000100',
    text: '<@U123> 로그인 오류 확인 부탁드립니다.',
    user: 'U999',
    createdAt: '2026-04-08T00:00:00.000Z'
  };
  const draftInputs = [];
  const runExecCalls = [];

  const domain = createSlackMentionDomain({
    config: {
      cwd: workspaceRoot,
      slack: {
        initialLookbackMinutes: 10,
        codeAnalysisMaxFindings: 6
      },
      agent: {
        defaultProvider: 'codex'
      },
      github: {
        owner: 'knowmerce',
        repositories: ['fromm-web']
      },
      workspace: {
        projectsRoot: workspaceRoot,
        allowlist: [workspaceRoot]
      }
    },
    repo,
    slackClient: {
      isConfigured: () => true,
      searchMentionsSince: async () => [mention],
      getThread: async () => [
        {
          externalId: '1710000000.000100',
          content: '<@U123> 로그인 오류 확인 부탁드립니다.',
          metadata: { user: 'U999' }
        },
        {
          externalId: '1710000001.000100',
          content: '오늘 오전 배포 이후 발생했습니다.',
          metadata: { user: 'U777' }
        }
      ]
    },
    workspaceRunner: {
      assertAllowed: (workdir) => workdir
    },
    codexCliRunner: {
      assertAvailable: async () => {},
      runExec: async ({ workdir, schema, prompt }) => {
        runExecCalls.push({ workdir, schema });
        const required = Array.isArray(schema?.required) ? schema.required : [];
        if (required.includes('selectedFolder')) {
          assert.equal(workdir, projectPath);
          assert.match(prompt, /docs\/fromm\/backoffice\.md/);
          assert.match(prompt, /docs\/fromm\/partner\.md/);
          assert.match(prompt, /docs\/fromm\/channel\.md/);
          assert.match(prompt, /docs\/fromm\/store\.md/);
          assert.doesNotMatch(prompt, /fromm-web-service-reference\.md/);
          return {
            parsed: {
              selectedFolder: 'apps/channel',
              rationale: '스레드의 로그인 오류 맥락과 문서 기준으로 channel 서비스 인증 흐름이 가장 관련 있습니다.',
              investigationPlan: 'apps/channel 내부 auth/login 경로와 세션 검증 흐름부터 확인합니다.'
            }
          };
        }

        assert.equal(workdir, mappedFolderPath);
        return {
          parsed: {
            summary: 'fromm-web 저장소에서 로그인 오류와 관련된 인증 경로를 확인했습니다.',
            replyHints: [
              'src/auth/login.ts:42 기준으로 영향 범위를 확인 중입니다.'
            ],
            findings: [
              {
                path: 'src/auth/login.ts',
                line: 42,
                excerpt: 'const loginError = "auth_failed";',
                reason: '로그인 실패 처리 분기입니다.'
              },
              {
                path: 'src/auth/session.ts',
                line: 77,
                excerpt: 'if (!token) throw new Error("token missing");',
                reason: '세션 토큰 검증 분기입니다.'
              }
            ]
          }
        };
      }
    },
    llmService: {
      generateSlackDraft: async (input) => {
        draftInputs.push(input);
        const hasCodeReview = input.codeReviewContext?.analysisStatus === 'completed';
        return {
          summary: hasCodeReview
            ? '로그인 오류 관련 코드 위치를 확인했고 영향 범위를 검토 중인 상황입니다.'
            : '로그인 오류 보고가 들어와 우선 확인이 필요한 상황입니다.',
          requestedAction: '처리 시작과 ETA를 답변',
          replyIntent: '처리 착수와 다음 공유 시점을 전달',
          suggestedReply: hasCodeReview
            ? '로그인 관련 코드 경로를 확인했고 영향 범위를 점검 중입니다. 확인되는 내용부터 공유드리겠습니다.'
            : '로그인 오류 확인 중입니다. 진행 상황 공유드리겠습니다.',
          replyCategory: 'owner_incident',
          replyCategoryLabel: '책임자 호출 / 장애 상황',
          reactionName: '',
          provider: 'test'
        };
      }
    }
  });

  await domain.poll();

  const polledTask = repo.listTasks()[0];
  assert.equal(repo.listDrafts(polledTask.id).length, 1);
  const candidateState = repo.getTask(polledTask.id).payload.codeReview;
  assert.equal(candidateState.enabled, false);
  assert.equal(candidateState.selectedRepo, '');
  assert.equal(candidateState.analysisStatus, 'not_requested');
  assert.match(candidateState.selectionReason, /자동 선택/);

  await domain.runCodeReview(repo.getTask(polledTask.id), {});

  const updatedTask = repo.getTask(polledTask.id);
  const analysisState = updatedTask.payload.codeReview;
  assert.equal(analysisState.enabled, true);
  assert.equal(analysisState.selectedRepo, 'fromm-web');
  assert.equal(analysisState.selectedFolder, 'apps/channel');
  assert.equal(analysisState.analysisStatus, 'completed');
  assert.equal(analysisState.scopeSource, 'agent_inferred');
  assert.match(analysisState.scopeRationale, /로그인 오류 맥락/);
  assert.match(analysisState.scopeInvestigationPlan, /auth\/login/);
  assert.match(analysisState.selectionReason, /문서\/스레드 문맥/);
  assert.equal(analysisState.findings.length, 2);
  assert.match(analysisState.summary, /인증 경로를 확인/);
  assert.ok(Array.isArray(analysisState.replyHints));
  assert.equal(analysisState.analysisAgentProvider, 'codex');
  assert.equal(analysisState.analysisBaseBranch, 'master');
  assert.equal(repo.listArtifacts(polledTask.id, 'slack_code_analysis').length, 1);
  assert.equal(runExecCalls.length, 2);
  assert.equal(repo.listDrafts(polledTask.id).length, 1);
  assert.ok(draftInputs.every((input) => !input.codeReviewContext));

  await domain.generateDraft(repo.getTask(polledTask.id), {
    includeCodeReviewContext: true
  });
  assert.equal(repo.listDrafts(polledTask.id).length, 2);
  assert.ok(draftInputs.some((input) => input.codeReviewContext?.analysisStatus === 'completed'));
});

test('slack mention domain uses kiwee doc group when selected repo is kiwee', async () => {
  const repo = createRepo();
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-slack-kiwee-workspace-'));
  const projectPath = path.join(workspaceRoot, 'kiwee-web');
  const docsPath = path.join(workspaceRoot, 'docs', 'kiwee');
  fs.mkdirSync(path.join(projectPath, '.git'), { recursive: true });
  fs.mkdirSync(docsPath, { recursive: true });
  fs.writeFileSync(path.join(docsPath, 'README.md'), '# kiwee');
  fs.writeFileSync(path.join(docsPath, 'api-reference.md'), '# api');
  fs.writeFileSync(path.join(docsPath, 'architecture.md'), '# architecture');
  fs.writeFileSync(path.join(docsPath, 'kiwee-admin.md'), '# admin');
  fs.writeFileSync(path.join(docsPath, 'kiwee-app.md'), '# app');
  fs.writeFileSync(path.join(docsPath, 'kiwee-web.md'), '# web');

  const mention = {
    channelId: 'C123',
    channelName: 'eng',
    ts: '1710000000.000100',
    threadTs: '1710000000.000100',
    permalink: 'https://example.slack.com/archives/C123/p1710000000000100',
    text: '<@U123> 키위 웹 동작을 점검해주세요.',
    user: 'U999',
    createdAt: '2026-04-08T00:00:00.000Z'
  };

  const domain = createSlackMentionDomain({
    config: {
      cwd: workspaceRoot,
      slack: {
        initialLookbackMinutes: 10,
        codeAnalysisMaxFindings: 6
      },
      agent: {
        defaultProvider: 'codex'
      },
      github: {
        owner: 'knowmerce',
        repositories: ['kiwee-web']
      },
      workspace: {
        projectsRoot: workspaceRoot,
        allowlist: [workspaceRoot]
      }
    },
    repo,
    slackClient: {
      isConfigured: () => true,
      searchMentionsSince: async () => [mention],
      getThread: async () => [
        {
          externalId: '1710000000.000100',
          content: '<@U123> 키위 웹 동작을 점검해주세요.',
          metadata: { user: 'U999' }
        }
      ]
    },
    workspaceRunner: {
      assertAllowed: (workdir) => workdir
    },
    codexCliRunner: {
      assertAvailable: async () => {},
      runExec: async ({ workdir, schema, prompt }) => {
        const required = Array.isArray(schema?.required) ? schema.required : [];
        if (required.includes('selectedFolder')) {
          assert.equal(workdir, projectPath);
          assert.match(prompt, /docs\/kiwee\/README\.md/);
          assert.match(prompt, /docs\/kiwee\/api-reference\.md/);
          assert.match(prompt, /docs\/kiwee\/architecture\.md/);
          assert.match(prompt, /docs\/kiwee\/kiwee-admin\.md/);
          assert.match(prompt, /docs\/kiwee\/kiwee-app\.md/);
          assert.match(prompt, /docs\/kiwee\/kiwee-web\.md/);
          return {
            parsed: {
              selectedFolder: '',
              rationale: 'kiwee 웹 영역 문서 기준으로 저장소 루트 확인이 필요합니다.',
              investigationPlan: '핵심 진입점부터 순서대로 확인합니다.'
            }
          };
        }

        assert.equal(workdir, projectPath);
        return {
          parsed: {
            summary: 'kiwee-web 저장소 확인을 시작했습니다.',
            replyHints: ['키위 웹 관련 경로를 먼저 확인하겠습니다.'],
            findings: []
          }
        };
      }
    },
    llmService: {
      generateSlackDraft: async () => ({
        summary: '키위 웹 관련 이슈를 확인 중입니다.',
        requestedAction: '진행 상황 공유',
        suggestedReply: '키위 웹 관련 코드를 확인 중이며 확인되는 내용부터 공유드리겠습니다.',
        replyCategory: 'owner_task',
        replyCategoryLabel: '담당 작업',
        reactionName: '',
        provider: 'test'
      })
    }
  });

  await domain.poll();
  const task = repo.listTasks()[0];
  await domain.runCodeReview(repo.getTask(task.id), {
    selectedRepo: 'kiwee-web'
  });

  const updated = repo.getTask(task.id);
  assert.equal(updated.payload.codeReview.analysisStatus, 'completed');
  assert.equal(updated.payload.codeReview.analysisBaseBranch, 'master');
});

test('slack mention domain falls back to codex draft generation when claude generation is unavailable', async () => {
  const repo = createRepo();
  const task = repo.upsertTask({
    domain: 'slack_mention',
    kind: 'reply',
    externalId: 'C123:1710000000.000100',
    title: 'Fallback generation',
    payload: {
      channelId: 'C123',
      channelName: 'eng',
      ts: '1710000000.000100',
      threadTs: '1710000000.000100',
      text: '<@U123> 답변 작성 부탁드립니다.'
    }
  });
  repo.replaceArtifacts(task.id, 'slack_message', [
    {
      externalId: '1710000000.000100',
      title: '원본 메시지',
      content: '<@U123> 답변 작성 부탁드립니다.',
      metadata: { user: 'U999' }
    }
  ]);

  const requestedProviders = [];
  const domain = createSlackMentionDomain({
    config: {
      slack: {
        initialLookbackMinutes: 10
      }
    },
    repo,
    slackClient: {
      isConfigured: () => true
    },
    llmService: {
      generateSlackDraft: async (input) => {
        requestedProviders.push(input.agentProvider);
        if (input.agentProvider === 'claude') {
          return {
            summary: 'claude unavailable',
            requestedAction: '확인',
            suggestedReply: 'fallback',
            replyCategory: 'action_request',
            replyCategoryLabel: '액션 요청',
            reactionName: '',
            provider: 'fallback:claude token missing',
            agentProvider: ''
          };
        }
        return {
          summary: 'codex로 초안을 생성했습니다.',
          requestedAction: '처리 시작 공유',
          replyIntent: '처리 시작 안내',
          suggestedReply: '요청하신 내용을 확인했고 진행 상황을 공유드리겠습니다.',
          replyCategory: 'action_request',
          replyCategoryLabel: '액션 요청',
          reactionName: '',
          provider: 'cli:codex',
          agentProvider: 'codex'
        };
      }
    }
  });

  await domain.generateDraft(task, {});

  assert.deepEqual(requestedProviders, ['claude', 'codex']);
  const latestDraft = repo.getLatestDraft(task.id);
  assert.equal(latestDraft.metadata.generationAgentProvider, 'codex');
  assert.equal(latestDraft.content, '요청하신 내용을 확인했고 진행 상황을 공유드리겠습니다.');
});

test('slack mention domain skips claude draft generation during cooldown after fallback failure', async () => {
  const repo = createRepo();
  const task = repo.upsertTask({
    domain: 'slack_mention',
    kind: 'reply',
    externalId: 'C123:1710000000.000100',
    title: 'Cooldown generation',
    payload: {
      channelId: 'C123',
      channelName: 'eng',
      ts: '1710000000.000100',
      threadTs: '1710000000.000100',
      text: '<@U123> 답변 작성 부탁드립니다.'
    }
  });
  repo.replaceArtifacts(task.id, 'slack_message', [
    {
      externalId: '1710000000.000100',
      title: '원본 메시지',
      content: '<@U123> 답변 작성 부탁드립니다.',
      metadata: { user: 'U999' }
    }
  ]);

  const requestedProviders = [];
  const domain = createSlackMentionDomain({
    config: {
      slack: {
        initialLookbackMinutes: 10
      }
    },
    repo,
    slackClient: {
      isConfigured: () => true
    },
    llmService: {
      generateSlackDraft: async (input) => {
        requestedProviders.push(input.agentProvider);
        if (input.agentProvider === 'claude') {
          return {
            summary: 'claude unavailable',
            requestedAction: '확인',
            suggestedReply: 'fallback',
            replyCategory: 'action_request',
            replyCategoryLabel: '액션 요청',
            reactionName: '',
            provider: 'fallback:claude token missing',
            agentProvider: ''
          };
        }
        return {
          summary: 'codex로 초안을 생성했습니다.',
          requestedAction: '처리 시작 공유',
          replyIntent: '처리 시작 안내',
          suggestedReply: '요청하신 내용을 확인했고 진행 상황을 공유드리겠습니다.',
          replyCategory: 'action_request',
          replyCategoryLabel: '액션 요청',
          reactionName: '',
          provider: 'cli:codex',
          agentProvider: 'codex'
        };
      }
    }
  });

  await domain.generateDraft(task, {});
  await domain.generateDraft(repo.getTask(task.id), {});

  assert.deepEqual(requestedProviders, ['claude', 'codex', 'codex']);
});

test('slack mention domain generateDraft preserves latest codeReview state when stale task snapshot is provided', async () => {
  const repo = createRepo();
  const task = repo.upsertTask({
    domain: 'slack_mention',
    kind: 'reply',
    externalId: 'C123:1710000000.000100',
    title: 'Preserve code review state',
    payload: {
      channelId: 'C123',
      channelName: 'eng',
      ts: '1710000000.000100',
      threadTs: '1710000000.000100',
      text: '<@U123> 상태 확인 부탁드립니다.',
      codeReview: {
        enabled: true,
        analysisStatus: 'running',
        progressStep: 2
      }
    }
  });
  repo.replaceArtifacts(task.id, 'slack_message', [
    {
      externalId: '1710000000.000100',
      title: '원본 메시지',
      content: '<@U123> 상태 확인 부탁드립니다.',
      metadata: { user: 'U999' }
    }
  ]);

  const staleTask = repo.getTask(task.id);
  repo.updateTask(task.id, {
    payload: {
      ...(staleTask.payload || {}),
      codeReview: {
        enabled: true,
        analysisStatus: 'completed',
        progressStep: 5
      }
    }
  });

  const domain = createSlackMentionDomain({
    config: {
      slack: {
        initialLookbackMinutes: 10
      }
    },
    repo,
    slackClient: {
      isConfigured: () => true
    },
    llmService: {
      generateSlackDraft: async () => ({
        summary: '코드 리뷰 결과를 바탕으로 답변을 준비했습니다.',
        requestedAction: '처리 상황 공유',
        replyIntent: '현재 상태를 간단히 안내',
        suggestedReply: '코드 리뷰 결과 확인 후 바로 공유드리겠습니다.',
        replyCategory: 'action_request',
        replyCategoryLabel: '액션 요청',
        reactionName: '',
        provider: 'cli:codex',
        agentProvider: 'codex'
      })
    }
  });

  await domain.generateDraft(staleTask, {});

  const updatedTask = repo.getTask(task.id);
  assert.equal(updatedTask.payload.codeReview.analysisStatus, 'completed');
  assert.equal(updatedTask.payload.codeReview.progressStep, 5);
});

test('slack mention domain does not show 100% progress before code review completion', async () => {
  const repo = createRepo();
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-slack-progress-workspace-'));
  const projectPath = path.join(workspaceRoot, 'fromm-web');
  const docsPath = path.join(workspaceRoot, 'docs', 'fromm');
  fs.mkdirSync(path.join(projectPath, '.git'), { recursive: true });
  fs.mkdirSync(docsPath, { recursive: true });
  fs.writeFileSync(path.join(docsPath, 'backoffice.md'), '# backoffice');
  fs.writeFileSync(path.join(docsPath, 'partner.md'), '# partner');
  fs.writeFileSync(path.join(docsPath, 'channel.md'), '# channel');
  fs.writeFileSync(path.join(docsPath, 'store.md'), '# store');

  const mention = {
    channelId: 'C123',
    channelName: 'eng',
    ts: '1710000000.000100',
    threadTs: '1710000000.000100',
    permalink: 'https://example.slack.com/archives/C123/p1710000000000100',
    text: '<@U123> 상품 정보 확인 부탁드립니다.',
    user: 'U999',
    createdAt: '2026-04-08T00:00:00.000Z'
  };

  let resolveReview;
  const reviewGate = new Promise((resolve) => {
    resolveReview = resolve;
  });

  const domain = createSlackMentionDomain({
    config: {
      cwd: workspaceRoot,
      slack: {
        initialLookbackMinutes: 10
      },
      agent: {
        defaultProvider: 'codex'
      },
      github: {
        repositories: ['fromm-web']
      },
      workspace: {
        projectsRoot: workspaceRoot,
        allowlist: [workspaceRoot]
      }
    },
    repo,
    slackClient: {
      isConfigured: () => true,
      searchMentionsSince: async () => [mention],
      getThread: async () => [
        {
          externalId: '1710000000.000100',
          content: '<@U123> 상품 정보 확인 부탁드립니다.',
          metadata: { user: 'U999' }
        }
      ]
    },
    workspaceRunner: {
      assertAllowed: (workdir) => workdir
    },
    codexCliRunner: {
      assertAvailable: async () => {},
      runExec: async ({ schema }) => {
        const required = Array.isArray(schema?.required) ? schema.required : [];
        if (required.includes('selectedFolder')) {
          return {
            parsed: {
              selectedFolder: '',
              rationale: '스토어 도메인을 저장소 루트 기준으로 확인합니다.',
              investigationPlan: '상품 관련 경로를 우선 확인합니다.'
            }
          };
        }
        return reviewGate;
      }
    },
    llmService: {
      generateSlackDraft: async () => ({
        summary: '요청사항을 확인했습니다.',
        requestedAction: '확인 후 공유',
        suggestedReply: '확인 중이며 공유드리겠습니다.',
        replyCategory: 'action_request',
        replyCategoryLabel: '액션 요청',
        reactionName: '',
        provider: 'test'
      })
    }
  });

  await domain.poll();
  const task = repo.listTasks()[0];
  const runPromise = domain.runCodeReview(repo.getTask(task.id), {});

  await new Promise((resolve) => setTimeout(resolve, 0));

  const runningState = repo.getTask(task.id).payload.codeReview;
  assert.equal(runningState.analysisStatus, 'running');
  assert.equal(runningState.progressStep, 5);
  assert.equal(runningState.progressTotalSteps, 6);
  assert.equal(runningState.progressPercent, 83);

  resolveReview({
    parsed: {
      summary: '상품 정보를 확인했습니다.',
      replyHints: ['핵심 경로를 정리 중입니다.'],
      findings: []
    }
  });

  await runPromise;

  const completedState = repo.getTask(task.id).payload.codeReview;
  assert.equal(completedState.analysisStatus, 'completed');
  assert.equal(completedState.progressStep, 6);
  assert.equal(completedState.progressTotalSteps, 6);
  assert.equal(completedState.progressPercent, 100);
});
