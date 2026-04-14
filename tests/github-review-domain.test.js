import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRepository } from '../src/db.js';
import { createGitHubReviewDomain } from '../src/domains/github-review-domain.js';

function createRepo() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-github-review-'));
  return createRepository(path.join(tempDir, 'agent.db'));
}

function createPullRequest(number, overrides = {}) {
  return {
    number,
    title: `PR ${number} title`,
    body: `PR ${number} body`,
    draft: false,
    html_url: `https://github.com/acme/demo/pull/${number}`,
    user: {
      login: `author-${number}`
    },
    base: {
      ref: 'main'
    },
    head: {
      ref: `feature-${number}`,
      sha: `sha-${number}`
    },
    changed_files: 1,
    updated_at: '2026-04-08T03:00:00.000Z',
    ...overrides
  };
}

function createDraftTask(repo, number) {
  const pullRequest = {
    owner: 'acme',
    repo: 'demo',
    repoSlug: 'acme/demo',
    number,
    title: `PR ${number} title`,
    body: `PR ${number} body`,
    author: `author-${number}`,
    baseRef: 'main',
    headRef: `feature-${number}`,
    headSha: `sha-${number}`,
    changedFiles: 1,
    htmlUrl: `https://github.com/acme/demo/pull/${number}`,
    draft: false,
    updatedAt: '2026-04-08T03:00:00.000Z'
  };

  const task = repo.upsertTask({
    domain: 'github_review',
    kind: 'review',
    externalId: `acme/demo#${number}`,
    title: `[깃허브 리뷰] demo#${number} PR ${number} title`,
    sourceUrl: pullRequest.htmlUrl,
    payload: {
      owner: 'acme',
      repo: 'demo',
      repoSlug: 'acme/demo',
      pullNumber: number,
      text: `#${number} PR ${number} title`,
      author: pullRequest.author,
      baseRef: pullRequest.baseRef,
      headRef: pullRequest.headRef,
      headSha: pullRequest.headSha,
      updatedAt: pullRequest.updatedAt,
      sourceUrl: pullRequest.htmlUrl
    }
  });

  const file = {
    sha: `file-sha-${number}`,
    path: 'src/app.js',
    status: 'modified',
    additions: 3,
    deletions: 1,
    patch: '@@ -1,2 +1,4 @@\n-const value = 1;\n+const value = 2;\n+export const flag = true;'
  };

  repo.replaceArtifacts(task.id, 'github_pull_request', [{
    externalId: String(number),
    title: 'PR 개요',
    content: `PR #${number}`,
    sortOrder: 0,
    metadata: pullRequest
  }]);
  repo.replaceArtifacts(task.id, 'github_pull_request_file', [{
    externalId: file.sha,
    title: file.path,
    content: file.patch,
    sortOrder: 0,
    metadata: file
  }]);

  return repo.getTask(task.id);
}

function createGeneratedReview({ provider, summary, reviewBody, approval = 'approved_with_no_changes', findings = [] }) {
  return {
    provider,
    summary,
    approval,
    findings,
    reviewBody,
    agentProvider: 'codex'
  };
}

test('github review domain lists candidates and skips draft PRs, self-authored PRs, and already-reviewed PRs', async () => {
  const repo = createRepo();
  let submitCount = 0;
  let generateCount = 0;

  const githubClient = {
    isConfigured: () => true,
    getAuthenticatedUserLogin: async () => 'reviewer',
    listOpenPullRequests: async () => [
      createPullRequest(1),
      createPullRequest(2, { draft: true }),
      createPullRequest(3),
      createPullRequest(4, {
        user: {
          login: 'reviewer'
        }
      })
    ],
    findLatestSubmittedReviewByUser: async ({ pullNumber }) => {
      if (pullNumber === 3) {
        return {
          id: 303,
          state: 'APPROVED',
          submitted_at: '2026-04-08T03:05:00.000Z',
          user: {
            login: 'reviewer'
          }
        };
      }

      return null;
    },
    listPullRequestFiles: async ({ pullNumber }) => [{
      sha: `file-sha-${pullNumber}`,
      filename: 'src/app.js',
      status: 'modified',
      additions: 3,
      deletions: 1,
      patch: '@@ -1,2 +1,4 @@\n-const value = 1;\n+const value = 2;\n+export const flag = true;'
    }],
    submitPullRequestReview: async () => {
      submitCount += 1;
      return {};
    }
  };

  const llmService = {
    generateGitHubReview: async () => {
      generateCount += 1;
      return {};
    }
  };

  const domain = createGitHubReviewDomain({
    config: {
      github: {
        owner: 'acme',
        repositories: ['demo']
      }
    },
    repo,
    githubClient,
    llmService
  });

  const firstPoll = await domain.poll();

  assert.equal(firstPoll.pullRequestsFound, 4);
  assert.equal(firstPoll.draftsSkipped, 1);
  assert.equal(firstPoll.selfAuthoredSkipped, 1);
  assert.equal(firstPoll.alreadyReviewedSkipped, 1);
  assert.equal(firstPoll.tasksProcessed, 1);
  assert.equal(firstPoll.candidatesListed, 1);
  assert.equal(firstPoll.draftsGenerated, 0);
  assert.equal(firstPoll.reviewsSubmitted, 0);
  assert.equal(submitCount, 0);
  assert.equal(generateCount, 0);

  const task = repo.getTaskByExternalId('github_review', 'acme/demo#1');
  assert.ok(task);
  assert.equal(task.status, 'new');
  assert.equal(task.summary, '리뷰 후보로 수집되었습니다. PR 상세에서 원하는 항목을 선택해 리뷰하세요.');
  assert.equal(repo.getLatestDraft(task.id), null);
  assert.equal(repo.listArtifacts(task.id, 'github_pull_request').length, 1);
  assert.equal(repo.listArtifacts(task.id, 'github_pull_request_file').length, 1);
  assert.equal(repo.listArtifacts(task.id, 'github_review_analysis').length, 0);

  const secondPoll = await domain.poll();

  assert.equal(secondPoll.pullRequestsFound, 4);
  assert.equal(secondPoll.draftsSkipped, 1);
  assert.equal(secondPoll.selfAuthoredSkipped, 1);
  assert.equal(secondPoll.alreadyReviewedSkipped, 1);
  assert.equal(secondPoll.tasksProcessed, 1);
  assert.equal(secondPoll.candidatesListed, 1);
  assert.equal(secondPoll.reviewsSubmitted, 0);
  assert.equal(submitCount, 0);
  assert.equal(generateCount, 0);
});

test('github review domain marks unresolved task as done when existing review is detected later', async () => {
  const repo = createRepo();
  let existingReview = null;

  const domain = createGitHubReviewDomain({
    config: {
      github: {
        owner: 'acme',
        repositories: ['demo']
      }
    },
    repo,
    githubClient: {
      isConfigured: () => true,
      getAuthenticatedUserLogin: async () => 'reviewer',
      listOpenPullRequests: async () => [createPullRequest(9)],
      findLatestSubmittedReviewByUser: async () => existingReview,
      listPullRequestFiles: async () => [{
        sha: 'file-sha-9',
        filename: 'src/app.js',
        status: 'modified',
        additions: 1,
        deletions: 0,
        patch: '@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;'
      }],
      submitPullRequestReview: async () => {
        return {};
      }
    },
    llmService: {
      generateGitHubReview: async () => {
        throw new Error('poll에서는 호출되면 안 됩니다');
      }
    }
  });

  const firstPoll = await domain.poll();
  assert.equal(firstPoll.pullRequestsFound, 1);
  assert.equal(firstPoll.tasksProcessed, 1);
  assert.equal(firstPoll.candidatesListed, 1);
  assert.equal(firstPoll.alreadyReviewedSkipped, 0);

  const pendingTask = repo.getTaskByExternalId('github_review', 'acme/demo#9');
  assert.ok(pendingTask);
  assert.equal(pendingTask.status, 'new');

  existingReview = {
    id: 909,
    state: 'COMMENTED',
    submitted_at: '2026-04-08T03:20:00.000Z',
    user: {
      login: 'reviewer'
    }
  };

  const secondPoll = await domain.poll();
  assert.equal(secondPoll.pullRequestsFound, 1);
  assert.equal(secondPoll.tasksProcessed, 0);
  assert.equal(secondPoll.candidatesListed, 0);
  assert.equal(secondPoll.alreadyReviewedSkipped, 1);
  assert.equal(secondPoll.reviewsSubmitted, 0);

  const task = repo.getTaskByExternalId('github_review', 'acme/demo#9');
  assert.ok(task);
  assert.equal(task.status, 'done');
  assert.equal(task.summary, 'GitHub에 이미 리뷰가 등록되어 있습니다.');
  assert.equal(task.last_error, null);
});

test('github review domain keeps the successful draft when next generation falls back', async () => {
  const repo = createRepo();
  const generatedResults = [
    createGeneratedReview({
      provider: 'cli:codex',
      summary: '토큰 갱신 흐름 변경으로 인증 처리 순서가 단순화되었습니다.',
      reviewBody: [
        '## 요약',
        '- 토큰 갱신 흐름 변경으로 인증 처리 순서가 단순화되었습니다.',
        '',
        '## 리뷰 의견',
        '- 🟡 [회귀 위험] 쿠키 만료 시 재시도 경로가 일부 생략될 수 있습니다.',
        '  파일: src/auth/token.ts',
        '  설명: 만료 토큰 상태에서 갱신 실패 후 종료 경로가 추가되었습니다.',
        '  제안: 실패 분기에서 세션 초기화 후 로그인 안내를 명시하세요.'
      ].join('\n'),
      approval: 'changes_requested',
      findings: [{
        id: 'f1',
        severity: 'medium',
        category: 'regression',
        title: '쿠키 만료 시 재시도 경로가 일부 생략될 수 있습니다.',
        description: '만료 토큰 상태에서 갱신 실패 후 종료 경로가 추가되었습니다.',
        fileRefs: ['src/auth/token.ts'],
        suggestedFix: '실패 분기에서 세션 초기화 후 로그인 안내를 명시하세요.',
        mustFix: true
      }]
    }),
    createGeneratedReview({
      provider: 'fallback:codex 생성 CLI 호출이 90초 제한 시간을 초과했습니다',
      summary: 'fallback summary',
      reviewBody: 'fallback body'
    })
  ];

  const domain = createGitHubReviewDomain({
    config: {
      github: {
        owner: 'acme',
        repositories: ['demo']
      }
    },
    repo,
    githubClient: {},
    llmService: {
      generateGitHubReview: async () => generatedResults.shift()
    }
  });

  let task = createDraftTask(repo, 21);
  const first = await domain.generateDraft(task);
  assert.equal(first.generated.reusedPreviousDraft, undefined);
  assert.equal(first.draft.content.includes('## 요약'), true);
  assert.equal(repo.listDrafts(task.id).length, 1);

  task = repo.getTask(task.id);
  const second = await domain.generateDraft(task);
  assert.equal(second.generated.reusedPreviousDraft, true);
  assert.equal(repo.listDrafts(task.id).length, 1);

  const latestDraft = repo.getLatestDraft(task.id);
  assert.ok(latestDraft);
  assert.equal(latestDraft.id, first.draft.id);
  assert.equal(latestDraft.content, first.draft.content);

  const updatedTask = repo.getTask(task.id);
  assert.equal(updatedTask.summary, first.generated.summary);
  assert.equal(updatedTask.last_error, 'fallback:codex 생성 CLI 호출이 90초 제한 시간을 초과했습니다');
});

test('github review domain restores the latest draft from previous successful output when latest is fallback', async () => {
  const repo = createRepo();
  const domain = createGitHubReviewDomain({
    config: {
      github: {
        owner: 'acme',
        repositories: ['demo']
      }
    },
    repo,
    githubClient: {},
    llmService: {
      generateGitHubReview: async () => createGeneratedReview({
        provider: 'fallback:temporary timeout',
        summary: 'fallback summary',
        reviewBody: 'fallback body'
      })
    }
  });

  const task = createDraftTask(repo, 22);
  const successDraft = repo.createDraft(task.id, '## 요약\n- 성공 초안\n\n## 리뷰 의견\n- 없음', {
    provider: 'cli:codex',
    approval: 'approved_with_no_changes',
    findingsCount: 0
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const fallbackDraft = repo.createDraft(task.id, '## 요약\n- fallback\n\n## 리뷰 의견\n- 없음', {
    provider: 'fallback:old timeout',
    approval: 'approved_with_no_changes',
    findingsCount: 0
  });
  assert.notEqual(successDraft.id, fallbackDraft.id);
  assert.equal(repo.getLatestDraft(task.id).id, fallbackDraft.id);

  const generated = await domain.generateDraft(repo.getTask(task.id));
  assert.equal(generated.generated.reusedPreviousDraft, true);

  const drafts = repo.listDrafts(task.id);
  assert.equal(drafts.length, 3);
  assert.equal(drafts[0].content, successDraft.content);
  assert.notEqual(drafts[0].id, successDraft.id);
  assert.equal(drafts[1].id, fallbackDraft.id);
  assert.equal(drafts[2].id, successDraft.id);
});
