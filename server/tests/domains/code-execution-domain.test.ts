import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { createRepository } from '../../src/infra/db.ts';
import { WorkspaceRunner } from '../../src/connectors/workspace-runner.ts';
import { GitHubApiError } from '../../src/connectors/github-client.ts';
import { createCodeExecutionDomain } from '../../src/domains/code-execution-domain.ts';

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'pipe' });
}

function read(command, args, cwd) {
  return execFileSync(command, args, { cwd, stdio: 'pipe' }).toString('utf8').trim();
}

function hasLocalBranch(cwd, branchName) {
  try {
    read('git', ['rev-parse', '--verify', `refs/heads/${branchName}`], cwd);
    return true;
  } catch {
    return false;
  }
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function createGitWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-code-domain-'));
  const remoteRoot = path.join(root, 'acme');
  const remoteDir = path.join(remoteRoot, 'demo.git');
  const repoDir = path.join(root, 'repo');

  fs.mkdirSync(remoteRoot, { recursive: true });
  run('git', ['init', '--bare', remoteDir], root);

  fs.mkdirSync(repoDir, { recursive: true });
  run('git', ['init', '-b', 'main'], repoDir);
  run('git', ['config', 'user.name', 'Test User'], repoDir);
  run('git', ['config', 'user.email', 'test@example.com'], repoDir);

  writeFile(path.join(repoDir, 'package.json'), JSON.stringify({
    name: 'demo',
    private: true,
    scripts: {
      test: 'node --test'
    }
  }, null, 2));
  writeFile(path.join(repoDir, '.github', 'PULL_REQUEST_TEMPLATE.md'), [
    '## PR 개요',
    '- {{PR_SIMPLE_SUMMARY}}',
    '',
    '## 작업 내용',
    '{{PR_SUMMARY}}'
  ].join('\n'));
  writeFile(path.join(repoDir, 'src', 'index.js'), 'export const value = 1;\n');

  run('git', ['add', '.'], repoDir);
  run('git', ['commit', '-m', 'chore: initial commit'], repoDir);
  run('git', ['remote', 'add', 'origin', `file://${remoteDir}`], repoDir);
  run('git', ['push', '-u', 'origin', 'main'], repoDir);

  return {
    root,
    repoDir
  };
}

function createEmptyGitWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-code-domain-empty-'));
  const repoDir = path.join(root, 'repo');

  fs.mkdirSync(repoDir, { recursive: true });
  run('git', ['init', '-b', 'main'], repoDir);
  run('git', ['config', 'user.name', 'Test User'], repoDir);
  run('git', ['config', 'user.email', 'test@example.com'], repoDir);

  return {
    root,
    repoDir
  };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(message);
}

function classifySchema(schema) {
  const required = Array.isArray(schema?.required) ? schema.required : [];
  if (required.includes('goals')) return 'contract';
  if (required.includes('taskBreakdown')) return 'plan';
  if (required.includes('contractMet')) return 'final';
  if (required.includes('improvementFound')) return 'refinement';
  if (required.includes('mustFix')) return 'merge';
  if (required.includes('findings')) return 'reviewer';
  if (required.includes('resolvedFindingIds')) return 'patch';
  return 'executor';
}

// 새 runner 플로의 모든 단계 스키마에 응답하는 fake CLI runner. executor만 보통 테스트별로 override.
function makeRunnerCli(overrides = {}) {
  const handlers = {
    async contract() {
      return { summary: '', goals: ['goal'], nonGoals: [], constraints: [], acceptanceCriteria: ['criterion'], edgeCases: [], openQuestions: [] };
    },
    async plan() {
      return {
        summary: '',
        implementationSteps: ['step'],
        filesLikelyToChange: ['README.md'],
        architectureImpact: [],
        risks: [],
        rolloutConcerns: [],
        validationStrategy: ['npm test'],
        chunkCommitBoundaries: ['chunk 1'],
        taskBreakdown: [{ id: 'chunk_1', title: 'Implement requested change', acceptanceCriteria: ['criterion'] }]
      };
    },
    async reviewer() {
      return { summary: 'No issues found.', findings: [], approval: 'approved_with_no_changes', residualRisks: [] };
    },
    async merge() {
      return { mustFix: [], shouldFix: [], advisory: [], duplicates: [], discarded: [] };
    },
    async patch() {
      throw new Error('patch step should not run');
    },
    async final() {
      return { contractMet: true, regression: '', summary: 'ok', residualRisks: [], acceptanceResults: [{ criterion: 'criterion', status: 'met', evidence: 'x' }] };
    },
    async refinement() {
      // 기본: 개선점 없음 → 완료 후 개선 루프 즉시 종료.
      return { improvementFound: false, inFrame: true, unresolvedCount: 0, rationale: '', chunk: { id: '', title: '', acceptanceCriteria: [] } };
    },
    async executor() {
      throw new Error('executor handler not configured for this test');
    },
    ...overrides
  };
  return {
    async assertAvailable() {},
    async runExec(args) {
      const kind = classifySchema(args?.schema);
      const handler = handlers[kind] as (input: unknown) => unknown;
      const parsed = await handler(args);
      return { parsed, stdout: '', stderr: '', durationMs: 1 };
    }
  };
}

async function driveThroughGates(domain, repo, taskId) {
  await domain.start(taskId);
  await waitFor(() => {
    const current = repo.getTask(taskId);
    return current?.status === 'awaiting_approval' && current?.result?.executionProgress?.gate === 'spec';
  }, 'Timed out waiting for Gate 1');
  await domain.approveGate(taskId, { gate: 'spec', decision: 'approve' });
  await waitFor(() => {
    const current = repo.getTask(taskId);
    return current?.status === 'awaiting_approval' && current?.result?.executionProgress?.gate === 'plan';
  }, 'Timed out waiting for Gate 2');
  await domain.approveGate(taskId, { gate: 'plan', decision: 'approve' });
  await waitFor(() => {
    const current = repo.getTask(taskId);
    const status = String(current?.status || '');
    const phase = current?.result?.executionProgress?.phase;
    return status === 'done' || (status === 'awaiting_approval' && phase === 'completed') || status === 'failed';
  }, 'Timed out waiting for runner workflow completion');
}

test('code execution domain runs runner workflow with spec/plan gates, chunk review, and PR creation', async () => {
  const workspace = createGitWorkspace();
  const repo = createRepository(path.join(workspace.root, 'agent.db'));
  const workspaceRunner = new WorkspaceRunner({
    workspace: {
      allowlist: [workspace.root, fs.realpathSync(workspace.root)]
    }
  });

  let codexCallCount = 0;
  let reviewerCallCount = 0;
  const codexCliRunner = {
    async assertAvailable() {
      codexCallCount += 1;
      throw new Error('codex runner should not be used for this task');
    },
    async runExec() {
      codexCallCount += 1;
      throw new Error('codex runner should not be used for this task');
    }
  };
  const claudeCliRunner = {
    async assertAvailable() {},
    async runExec({ workdir, schema, prompt }) {
      const required = Array.isArray(schema?.required) ? schema.required : [];

      if (required.includes('goals')) {
        return {
          parsed: {
            summary: 'Update the exported value as requested.',
            goals: ['Update the exported value in src/index.js'],
            nonGoals: ['Unrelated refactors'],
            constraints: ['Keep changes minimal'],
            acceptanceCriteria: ['src/index.js exports the updated value'],
            edgeCases: [],
            openQuestions: []
          },
          stdout: '',
          stderr: '',
          durationMs: 1
        };
      }

      if (required.includes('taskBreakdown')) {
        return {
          parsed: {
            summary: 'Implement the change in a single chunk.',
            implementationSteps: ['Create README and update export'],
            filesLikelyToChange: ['README.md', 'src/index.js'],
            architectureImpact: [],
            risks: [],
            rolloutConcerns: [],
            validationStrategy: ['npm test'],
            chunkCommitBoundaries: ['chunk 1'],
            taskBreakdown: [{
              id: 'chunk_1',
              title: 'Implement requested change',
              acceptanceCriteria: ['src/index.js exports the updated value']
            }]
          },
          stdout: '',
          stderr: '',
          durationMs: 1
        };
      }

      if (required.includes('contractMet')) {
        return {
          parsed: {
            contractMet: true,
            regression: 'No regressions detected.',
            summary: 'All acceptance criteria met.',
            residualRisks: [],
            acceptanceResults: [{
              criterion: 'src/index.js exports the updated value',
              status: 'met',
              evidence: 'export const value = 2;'
            }]
          },
          stdout: '',
          stderr: '',
          durationMs: 1
        };
      }

      if (required.includes('improvementFound')) {
        return {
          parsed: {
            improvementFound: false,
            inFrame: true,
            unresolvedCount: 0,
            rationale: 'No in-frame improvement remains.',
            chunk: { id: '', title: '', acceptanceCriteria: [] }
          },
          stdout: '',
          stderr: '',
          durationMs: 1
        };
      }

      if (required.includes('mustFix')) {
        return {
          parsed: {
            mustFix: [{
              id: 'm1',
              severity: 'P1',
              title: 'Update exported value',
              description: 'The exported value still uses the old number.',
              fileRefs: ['src/index.js'],
              action: 'Update the export to 2 and commit the change.'
            }],
            shouldFix: [],
            advisory: [],
            duplicates: [],
            discarded: []
          },
          stdout: '',
          stderr: '',
          durationMs: 1
        };
      }

      if (required.includes('findings')) {
        reviewerCallCount += 1;
        if (reviewerCallCount === 1) {
          return {
            parsed: {
              summary: 'One missing behavior needs adjustment.',
              findings: [{
                id: 'review-1',
                severity: 'medium',
                category: 'bug',
                title: 'Value export not updated',
                description: 'The feature file exists, but the exported value still uses the old number.',
                fileRefs: ['src/index.js'],
                suggestedFix: 'Update the export to the new value and commit the change.',
                mustFix: true
              }],
              approval: 'changes_requested',
              residualRisks: []
            },
            stdout: '',
            stderr: '',
            durationMs: 1
          };
        }
        return {
          parsed: {
            summary: 'No further issues found.',
            findings: [],
            approval: 'approved_with_no_changes',
            residualRisks: []
          },
          stdout: '',
          stderr: '',
          durationMs: 1
        };
      }

      // 패치 단계는 더 이상 스키마를 쓰지 않으므로 프롬프트(역할 라벨)로 구분한다.
      if (String(prompt || '').includes('Targeted Fix')) {
        writeFile(path.join(workdir, 'src', 'index.js'), 'export const value = 2;\n');
        run('git', ['add', 'src/index.js'], workdir);
        run('git', ['commit', '-m', 'fix: address review finding'], workdir);
        return {
          lastMessage: 'Applied the requested review fix; updated the exported value.',
          parsed: null,
          stdout: '',
          stderr: '',
          durationMs: 1
        };
      }

      writeFile(path.join(workdir, 'README.md'), '# Demo\n\nImplemented by agent.\n');
      run('git', ['add', 'README.md'], workdir);
      run('git', ['commit', '-m', 'feat: implement requested change'], workdir);
      return {
        parsed: {
          summary: 'Implemented the requested change.',
          testsRun: ['npm test'],
          notes: ['Created README and committed the initial implementation.']
        },
        stdout: '',
        stderr: '',
        durationMs: 1
      };
    }
  };

  const planner = {
    async createPullRequestDraft() {
      return {
        title: 'feat(demo): Implement requested change',
        body: '## Summary\n- Implemented requested change\n'
      };
    }
  };

  let lastPullRequestRequest = null;
  let createPullRequestCallCount = 0;
  const githubClient = {
    async createPullRequest({ owner, repo: repoName, head, base, title, body }) {
      createPullRequestCallCount += 1;
      lastPullRequestRequest = { owner, repoName, head, base, title, body };
      return {
        number: 7,
        html_url: `https://github.com/${owner}/${repoName}/pull/7`,
        head,
        base,
        title
      };
    },
    async listOpenPullRequests() {
      return [];
    },
    async updatePullRequest() {
      throw new Error('updatePullRequest should not be called when PR is newly created');
    }
  };

  const domain = createCodeExecutionDomain({
    config: {
      agent: {
        defaultProvider: 'codex'
      },
      workspace: {
        projectsRoot: workspace.root
      },
      github: {
        owner: '',
        repositories: []
      }
    },
    repo,
    workspaceRunner,
    githubClient,
    codexCliRunner,
    claudeCliRunner,
    codeTaskPlanner: planner
  });

  assert.deepEqual(domain.listProjects().map((project) => project.name), ['repo']);

  const task = await domain.createTask({
    command: 'Implement the requested change',
    agentProvider: 'claude',
    workdir: workspace.repoDir,
    baseBranch: 'main',
    branchName: 'feature/custom-demo-branch'
  });
  const createdTask = repo.getTask(task.id);
  assert.equal(createdTask.payload.agentProvider, 'claude');
  assert.equal(createdTask.result.executionProgress.phase, 'queued');
  assert.equal(createdTask.result.executionProgress.totalSteps, 6);

  // Gate 1: 요구사항 계약
  await domain.start(task.id);
  await waitFor(() => {
    const current = repo.getTask(task.id);
    return current?.status === 'awaiting_approval'
      && current?.result?.executionProgress?.gate === 'spec';
  }, 'Timed out waiting for Gate 1 (requirement contract)');
  const specTask = repo.getTask(task.id);
  assert.equal(specTask.result.executionProgress.currentStep, 2);
  assert.equal(repo.listArtifacts(task.id, 'requirement_contract').length, 1);
  assert.ok(Array.isArray(specTask.result.runner.requirementContract.goals));
  assert.equal(specTask.result.runner.requirementContract.goals.length, 1);

  // Gate 2: 구현 계획
  await domain.approveGate(task.id, { gate: 'spec', decision: 'approve' });
  await waitFor(() => {
    const current = repo.getTask(task.id);
    return current?.status === 'awaiting_approval'
      && current?.result?.executionProgress?.gate === 'plan';
  }, 'Timed out waiting for Gate 2 (implementation plan)');
  const planTask = repo.getTask(task.id);
  assert.equal(planTask.result.executionProgress.currentStep, 3);
  assert.equal(repo.listArtifacts(task.id, 'implementation_plan').length, 1);
  assert.equal(planTask.result.runner.implementationPlan.taskBreakdown.length, 1);

  // 승인 후 chunk 구현 → 최종 검증 → 완료
  await domain.approveGate(task.id, { gate: 'plan', decision: 'approve' });
  await waitFor(() => {
    const current = repo.getTask(task.id);
    return current?.status === 'awaiting_approval'
      && current?.result?.executionProgress?.phase === 'completed';
  }, 'Timed out waiting for runner workflow completion');

  const finishedTask = repo.getTask(task.id);
  assert.equal(finishedTask.status, 'awaiting_approval');
  assert.equal(finishedTask.result.branch, 'feature/custom-demo-branch');
  assert.equal(finishedTask.result.commits.length, 2);
  assert.equal(finishedTask.result.executionProgress.phase, 'completed');
  assert.equal(finishedTask.result.executionProgress.currentStep, 6);
  assert.equal(finishedTask.result.executionProgress.percent, 100);
  assert.equal(finishedTask.result.runner.chunks.length, 1);
  assert.equal(finishedTask.result.runner.chunks[0].status, 'committed');
  assert.equal(finishedTask.result.runner.finalValidation.contractMet, true);
  assert.equal(codexCallCount, 0);
  assert.equal(repo.listArtifacts(task.id, 'final_validation').length, 1);
  assert.ok(repo.listArtifacts(task.id, 'review_round').length >= 1);
  assert.ok(repo.listArtifacts(task.id, 'patch_round').length >= 1);
  assert.equal(read('git', ['branch', '--show-current'], workspace.repoDir), 'main');
  assert.equal(hasLocalBranch(workspace.repoDir, finishedTask.result.branch), true);
  assert.equal(read('git', ['show', `${finishedTask.result.branch}:README.md`], workspace.repoDir), '# Demo\n\nImplemented by agent.');
  assert.equal(read('git', ['show', `${finishedTask.result.branch}:src/index.js`], workspace.repoDir), 'export const value = 2;');
  assert.equal(read('git', ['show', 'main:src/index.js'], workspace.repoDir), 'export const value = 1;');
  assert.equal(typeof finishedTask.result.sourceCommit, 'string');
  assert.ok(finishedTask.result.sourceCommit.length > 0);

  const remoteBranch = 'release/demo-pr';
  await domain.createPullRequest(task.id, {
    branchName: remoteBranch
  });

  const doneTask = repo.getTask(task.id);
  assert.equal(doneTask.status, 'done');
  assert.equal(doneTask.result.pullRequest.url, 'https://github.com/acme/demo/pull/7');
  assert.equal(lastPullRequestRequest.owner, 'acme');
  assert.equal(lastPullRequestRequest.repoName, 'demo');
  assert.equal(lastPullRequestRequest.head, remoteBranch);
  assert.equal(lastPullRequestRequest.base, 'main');
  assert.equal(createPullRequestCallCount, 1);
});

test('createPullRequest retries with owner-prefixed head when refs are unreadable', async () => {
  const workspace = createGitWorkspace();
  const repo = createRepository(path.join(workspace.root, 'agent.db'));
  const workspaceRunner = new WorkspaceRunner({
    workspace: {
      allowlist: [workspace.root, fs.realpathSync(workspace.root)]
    }
  });
  const triedHeads = [];
  const githubClient = {
    async createPullRequest({ owner, repo: repoName, head, base, title }) {
      triedHeads.push(head);
      if (head === 'feature/FROMM-3372') {
        throw new GitHubApiError('Validation Failed: not all refs are readable', {
          status: 422,
          payload: {
            message: 'Validation Failed',
            errors: [
              {
                message: 'not all refs are readable'
              }
            ]
          },
          method: 'POST',
          path: `/repos/${owner}/${repoName}/pulls`
        });
      }

      return {
        number: 11,
        html_url: `https://github.com/${owner}/${repoName}/pull/11`,
        head,
        base,
        title
      };
    },
    async listOpenPullRequests() {
      return [];
    }
  };

  const domain = createCodeExecutionDomain({
    config: {
      agent: {
        defaultProvider: 'codex'
      },
      workspace: {
        projectsRoot: workspace.root
      },
      github: {
        owner: '',
        repositories: []
      }
    },
    repo,
    workspaceRunner,
    githubClient,
    codexCliRunner: {
      async assertAvailable() {},
      async runExec() {
        throw new Error('runExec should not be called in this test');
      }
    },
    claudeCliRunner: {
      async assertAvailable() {},
      async runExec() {
        throw new Error('runExec should not be called in this test');
      }
    },
    codeTaskPlanner: {}
  });

  const task = repo.upsertTask({
    domain: 'code_execution',
    kind: 'implementation',
    title: '[코드] PR 생성 head fallback 검증',
    status: 'awaiting_approval',
    approvalState: 'pending',
    payload: {
      command: 'head fallback',
      projectId: 'repo',
      projectName: 'repo',
      workdir: workspace.repoDir,
      baseBranch: 'main',
      repoOwner: 'acme',
      repoName: 'demo',
      repoSlug: 'acme/demo',
      remoteUrl: '',
      agentProvider: 'codex',
      needsPlanning: false,
      needsDesign: false,
      branchName: 'main'
    },
    result: {
      branch: 'main',
      baseBranch: 'main',
      repoSlug: 'acme/demo',
      commits: [],
      reviewRounds: [],
      pullRequest: {
        title: 'Head fallback validation',
        body: '## Summary\n- Head fallback test\n'
      }
    },
    sourceUrl: null,
    summary: 'PR 생성 테스트'
  });

  await domain.createPullRequest(task.id, {
    branchName: 'feature/FROMM-3372'
  });

  const doneTask = repo.getTask(task.id);
  assert.equal(doneTask.status, 'done');
  assert.deepEqual(triedHeads, [
    'feature/FROMM-3372',
    'acme:feature/FROMM-3372'
  ]);
  assert.equal(doneTask.result.pullRequest.url, 'https://github.com/acme/demo/pull/11');
  assert.equal(doneTask.result.pullRequest.head, 'feature/FROMM-3372');
});

test('createPullRequest formats title with FRM prefix and branch ticket token', async () => {
  const workspace = createGitWorkspace();
  const repo = createRepository(path.join(workspace.root, 'agent.db'));
  const workspaceRunner = new WorkspaceRunner({
    workspace: {
      allowlist: [workspace.root, fs.realpathSync(workspace.root)]
    }
  });
  let capturedTitle = '';
  let capturedBody = '';
  const githubClient = {
    async createPullRequest({ owner, repo: repoName, head, base, title, body }) {
      capturedTitle = title;
      capturedBody = body;
      return {
        number: 19,
        html_url: `https://github.com/${owner}/${repoName}/pull/19`,
        head,
        base,
        title
      };
    },
    async listOpenPullRequests() {
      return [];
    },
    async updatePullRequest() {
      throw new Error('updatePullRequest should not be called when PR is newly created');
    }
  };

  const domain = createCodeExecutionDomain({
    config: {
      agent: {
        defaultProvider: 'codex'
      },
      workspace: {
        projectsRoot: workspace.root
      },
      github: {
        owner: '',
        repositories: []
      }
    },
    repo,
    workspaceRunner,
    githubClient,
    codexCliRunner: {
      async assertAvailable() {},
      async runExec() {
        throw new Error('runExec should not be called in this test');
      }
    },
    claudeCliRunner: {
      async assertAvailable() {},
      async runExec() {
        throw new Error('runExec should not be called in this test');
      }
    },
    codeTaskPlanner: {}
  });

  const task = repo.upsertTask({
    domain: 'code_execution',
    kind: 'implementation',
    title: '[코드] 제목 규칙 테스트',
    status: 'awaiting_approval',
    approvalState: 'pending',
    payload: {
      command: 'title format',
      projectId: 'fromm-web',
      projectName: 'fromm-web',
      workdir: workspace.repoDir,
      baseBranch: 'main',
      repoOwner: 'acme',
      repoName: 'fromm-web',
      repoSlug: 'acme/fromm-web',
      remoteUrl: '',
      agentProvider: 'codex',
      needsPlanning: false,
      needsDesign: false,
      branchName: 'main'
    },
    result: {
      branch: 'main',
      baseBranch: 'main',
      repoSlug: 'acme/fromm-web',
      commits: [],
      reviewRounds: [],
      pullRequest: {
        title: 'feat(fromm): Astro→React 마이그레이션 및 리다이렉트/사이트맵 안정화',
        body: '## Summary\n- Body\n'
      }
    },
    sourceUrl: null,
    summary: 'PR 생성 테스트'
  });

  await domain.createPullRequest(task.id, {
    branchName: 'feature/FROMM-3372'
  });

  assert.equal(capturedTitle, '[FRM/FROMM-3372] Astro→React 마이그레이션 및 리다이렉트/사이트맵 안정화');
  assert.match(capturedBody, /## PR 개요/);
  assert.match(capturedBody, /## 작업 내용/);
});

test('code execution uses WORKSPACE_ALLOWLIST even when repository is outside GITHUB_REPOSITORIES and blocks only PR creation', async () => {
  const workspace = createGitWorkspace();
  const repo = createRepository(path.join(workspace.root, 'agent.db'));
  const workspaceRunner = new WorkspaceRunner({
    workspace: {
      allowlist: [workspace.root, fs.realpathSync(workspace.root)]
    }
  });

  let githubCreatePullRequestCalls = 0;
  const claudeCliRunner = makeRunnerCli({
    async executor({ workdir }) {
      writeFile(path.join(workdir, 'README.md'), '# Demo\n\nAllowlist-based run.\n');
      run('git', ['add', 'README.md'], workdir);
      run('git', ['commit', '-m', 'feat: allowlist code execution run'], workdir);
      return { summary: 'Implemented requested change.', testsRun: ['npm test'], notes: [] };
    }
  });
  const domain = createCodeExecutionDomain({
    config: {
      agent: { defaultProvider: 'claude' },
      workspace: { projectsRoot: workspace.root },
      github: { owner: 'acme', repositories: ['fromm-web'] }
    },
    repo,
    workspaceRunner,
    githubClient: {
      async createPullRequest() {
        githubCreatePullRequestCalls += 1;
        throw new Error('createPullRequest should not be called for disallowed repo');
      },
      async listOpenPullRequests() {
        return [];
      }
    },
    codexCliRunner: {
      async assertAvailable() {
        throw new Error('codex should not be selected in this test');
      },
      async runExec() {
        throw new Error('codex should not run in this test');
      }
    },
    claudeCliRunner,
    codeTaskPlanner: {
      async createPullRequestDraft() {
        return { title: 'Allowlist workflow test', body: '## Summary\n- Verify PR restriction scope\n' };
      }
    }
  });

  const task = await domain.createTask({
    command: 'Run with workspace allowlist only',
    agentProvider: 'claude',
    workdir: workspace.repoDir,
    baseBranch: 'main'
  });

  await driveThroughGates(domain, repo, task.id);

  const finished = repo.getTask(task.id);
  assert.equal(finished.status, 'awaiting_approval');
  assert.equal(finished.payload.githubRepositoryAllowed, false);

  await assert.rejects(
    () => domain.createPullRequest(task.id, { branchName: 'feature/allowlist-test' }),
    /GITHUB_REPOSITORIES 허용 목록/
  );

  const afterCreatePrFailure = repo.getTask(task.id);
  assert.equal(afterCreatePrFailure.status, 'awaiting_approval');
  assert.match(afterCreatePrFailure.last_error, /GITHUB_REPOSITORIES 허용 목록/);
  assert.equal(githubCreatePullRequestCalls, 0);
  assert.equal(read('git', ['branch', '--show-current'], workspace.repoDir), 'main');
});

test('createTask falls back to codex when requested claude is unavailable', async () => {
  const workspace = createGitWorkspace();
  const repo = createRepository(path.join(workspace.root, 'agent.db'));
  const workspaceRunner = new WorkspaceRunner({
    workspace: {
      allowlist: [workspace.root, fs.realpathSync(workspace.root)]
    }
  });

  let codexAvailableChecks = 0;
  let claudeAvailableChecks = 0;

  const codexCliRunner = {
    async assertAvailable() {
      codexAvailableChecks += 1;
    },
    async runExec() {
      throw new Error('runExec should not be called during task creation');
    }
  };

  const claudeCliRunner = {
    async assertAvailable() {
      claudeAvailableChecks += 1;
      throw new Error('Command failed: claude --version Error: claude not found in PATH');
    },
    async runExec() {
      throw new Error('runExec should not be called during task creation');
    }
  };

  const domain = createCodeExecutionDomain({
    config: {
      agent: {
        defaultProvider: 'codex'
      },
      workspace: {
        projectsRoot: workspace.root
      },
      github: {
        owner: '',
        repositories: []
      }
    },
    repo,
    workspaceRunner,
    githubClient: {
      async createPullRequest() {
        throw new Error('not used');
      }
    },
    codexCliRunner,
    claudeCliRunner,
    codeTaskPlanner: {}
  });

  const task = await domain.createTask({
    command: 'Implement fallback behavior',
    agentProvider: 'claude',
    workdir: workspace.repoDir,
    baseBranch: 'main',
    needsPlanning: false,
    needsDesign: false
  });

  const stored = repo.getTask(task.id);
  assert.equal(stored.payload.agentProvider, 'codex');
  assert.equal(claudeAvailableChecks, 1);
  assert.equal(codexAvailableChecks, 1);
});

test('code execution domain marks progress as failed when coding runner crashes', async () => {
  const workspace = createGitWorkspace();
  const repo = createRepository(path.join(workspace.root, 'agent.db'));
  const workspaceRunner = new WorkspaceRunner({
    workspace: {
      allowlist: [workspace.root, fs.realpathSync(workspace.root)]
    }
  });

  const claudeCliRunner = {
    async assertAvailable() {},
    async runExec({ schema }) {
      if (schema.required.includes('summary') && !schema.required.includes('findings')) {
        throw new Error('Simulated coding agent crash');
      }
      throw new Error('Unexpected schema call');
    }
  };

  const domain = createCodeExecutionDomain({
    config: {
      agent: {
        defaultProvider: 'claude'
      },
      workspace: {
        projectsRoot: workspace.root
      },
      github: {
        owner: '',
        repositories: []
      }
    },
    repo,
    workspaceRunner,
    githubClient: {
      async createPullRequest() {
        throw new Error('not used');
      }
    },
    codexCliRunner: {
      async assertAvailable() {
        throw new Error('codex should not be selected in this test');
      },
      async runExec() {
        throw new Error('codex should not run in this test');
      }
    },
    claudeCliRunner,
    codeTaskPlanner: {
      async createPromptPlan() {
        return {
          summary: 'Crash test',
          goal: 'Verify failure state',
          taskType: 'feature',
          successCriteria: [],
          deliverables: [],
          constraints: [],
          relevantContext: []
        };
      },
      async createPullRequestDraft() {
        throw new Error('not used');
      }
    }
  });

  const task = await domain.createTask({
    command: 'Trigger runner crash',
    agentProvider: 'claude',
    workdir: workspace.repoDir,
    baseBranch: 'main',
    needsPlanning: false,
    needsDesign: false
  });

  await domain.start(task.id);

  await waitFor(() => {
    const current = repo.getTask(task.id);
    return current?.status === 'failed';
  }, 'Timed out waiting for failed code task');

  const failedTask = repo.getTask(task.id);
  assert.equal(failedTask.status, 'failed');
  assert.match(failedTask.last_error, /Simulated coding agent crash/);
  assert.equal(failedTask.result.executionProgress.phase, 'failed');
  assert.equal(failedTask.result.executionProgress.totalSteps, 6);
  assert.ok(failedTask.result.executionProgress.percent >= 0 && failedTask.result.executionProgress.percent <= 100);
  const executionActions = repo.listExecutions(task.id).map((execution) => execution.action);
  assert.ok(executionActions.includes('run_code_execution'));
});

test('code execution domain auto-commits coding changes when agent leaves dirty worktree', async () => {
  const workspace = createGitWorkspace();
  const repo = createRepository(path.join(workspace.root, 'agent.db'));
  const workspaceRunner = new WorkspaceRunner({
    workspace: {
      allowlist: [workspace.root, fs.realpathSync(workspace.root)]
    }
  });

  const claudeCliRunner = makeRunnerCli({
    async executor({ workdir }) {
      writeFile(path.join(workdir, 'README.md'), '# Demo\n\nDirty worktree fallback.\n');
      return {
        summary: 'Implemented without creating a commit.',
        testsRun: ['npm test'],
        notes: ['Left unstaged changes intentionally.']
      };
    }
  });

  const domain = createCodeExecutionDomain({
    config: {
      agent: { defaultProvider: 'claude' },
      workspace: { projectsRoot: workspace.root },
      github: { owner: '', repositories: [] }
    },
    repo,
    workspaceRunner,
    githubClient: {
      async createPullRequest() {
        throw new Error('not used');
      }
    },
    codexCliRunner: {
      async assertAvailable() {
        throw new Error('codex should not be selected in this test');
      },
      async runExec() {
        throw new Error('codex should not run in this test');
      }
    },
    claudeCliRunner,
    codeTaskPlanner: {
      async createPullRequestDraft() {
        return { title: 'Dirty fallback PR', body: 'Auto-commit fallback verification' };
      }
    }
  });

  const task = await domain.createTask({
    command: 'Verify dirty worktree fallback',
    agentProvider: 'claude',
    workdir: workspace.repoDir,
    baseBranch: 'main'
  });

  await driveThroughGates(domain, repo, task.id);

  const finishedTask = repo.getTask(task.id);
  assert.equal(finishedTask.status, 'awaiting_approval');
  assert.ok(Array.isArray(finishedTask.result.commits));
  assert.ok(finishedTask.result.commits.some((commit) => commit.subject.startsWith('runner chunk 1:')));

  const executionActions = repo.listExecutions(task.id).map((execution) => execution.action);
  assert.ok(executionActions.includes('auto_commit_coding_changes'));
});

test('code execution domain resumes execution after a failed chunk without rerunning gates', async () => {
  const workspace = createGitWorkspace();
  const repo = createRepository(path.join(workspace.root, 'agent.db'));
  const workspaceRunner = new WorkspaceRunner({
    workspace: {
      allowlist: [workspace.root, fs.realpathSync(workspace.root)]
    }
  });

  let contractCalls = 0;
  let planCalls = 0;
  let executorAttempts = 0;
  let failExecutor = true;
  const claudeCliRunner = makeRunnerCli({
    async contract() {
      contractCalls += 1;
      return { summary: '', goals: ['goal'], nonGoals: [], constraints: [], acceptanceCriteria: ['criterion'], edgeCases: [], openQuestions: [] };
    },
    async plan() {
      planCalls += 1;
      return {
        summary: '',
        implementationSteps: ['step'],
        filesLikelyToChange: ['README.md'],
        architectureImpact: [],
        risks: [],
        rolloutConcerns: [],
        validationStrategy: ['npm test'],
        chunkCommitBoundaries: ['chunk 1'],
        taskBreakdown: [{ id: 'chunk_1', title: 'Implement requested change', acceptanceCriteria: ['criterion'] }]
      };
    },
    async executor({ workdir }) {
      executorAttempts += 1;
      if (failExecutor) {
        throw new Error('Simulated executor crash');
      }
      writeFile(path.join(workdir, 'README.md'), '# Demo\n\nResumed run.\n');
      run('git', ['add', 'README.md'], workdir);
      run('git', ['commit', '-m', 'feat: resume implement'], workdir);
      return { summary: 'Implemented on resume.', testsRun: ['npm test'], notes: [] };
    }
  });

  const domain = createCodeExecutionDomain({
    config: {
      agent: { defaultProvider: 'claude' },
      workspace: { projectsRoot: workspace.root },
      github: { owner: '', repositories: [] }
    },
    repo,
    workspaceRunner,
    githubClient: {
      async createPullRequest() {
        throw new Error('not used');
      }
    },
    codexCliRunner: {
      async assertAvailable() {
        throw new Error('codex should not be selected in this test');
      },
      async runExec() {
        throw new Error('codex should not run in this test');
      }
    },
    claudeCliRunner,
    codeTaskPlanner: {
      async createPullRequestDraft() {
        return { title: 'Resume PR', body: 'resume verification' };
      }
    }
  });

  const task = await domain.createTask({
    command: 'Verify resume after failed chunk',
    agentProvider: 'claude',
    workdir: workspace.repoDir,
    baseBranch: 'main'
  });

  await domain.start(task.id);
  await waitFor(() => {
    const current = repo.getTask(task.id);
    return current?.status === 'awaiting_approval' && current?.result?.executionProgress?.gate === 'spec';
  }, 'Timed out waiting for Gate 1');
  await domain.approveGate(task.id, { gate: 'spec', decision: 'approve' });
  await waitFor(() => {
    const current = repo.getTask(task.id);
    return current?.status === 'awaiting_approval' && current?.result?.executionProgress?.gate === 'plan';
  }, 'Timed out waiting for Gate 2');
  await domain.approveGate(task.id, { gate: 'plan', decision: 'approve' });
  await waitFor(() => repo.getTask(task.id)?.status === 'failed', 'Timed out waiting for execution failure');

  assert.equal(contractCalls, 1);
  assert.equal(planCalls, 1);
  assert.equal(executorAttempts, 1);

  failExecutor = false;
  await domain.start(task.id, { resumeFromCheckpoint: true });
  await waitFor(() => {
    const current = repo.getTask(task.id);
    const status = String(current?.status || '');
    const phase = current?.result?.executionProgress?.phase;
    return status === 'done' || (status === 'awaiting_approval' && phase === 'completed');
  }, 'Timed out waiting for resumed completion');

  // 게이트(spec/plan)는 재실행되지 않아야 한다.
  assert.equal(contractCalls, 1);
  assert.equal(planCalls, 1);
  assert.equal(executorAttempts, 2);

  const finishedTask = repo.getTask(task.id);
  assert.equal(finishedTask.result.runner.chunks.length, 1);
  assert.equal(finishedTask.result.runner.chunks[0].status, 'committed');
  assert.equal(read('git', ['show', `${finishedTask.result.branch}:README.md`], workspace.repoDir), '# Demo\n\nResumed run.');
});

test('code execution domain runs post-completion refinement loop within frame', async () => {
  const workspace = createGitWorkspace();
  const repo = createRepository(path.join(workspace.root, 'agent.db'));
  const workspaceRunner = new WorkspaceRunner({
    workspace: {
      allowlist: [workspace.root, fs.realpathSync(workspace.root)]
    }
  });

  let executorCount = 0;
  let refinementCount = 0;
  const claudeCliRunner = makeRunnerCli({
    async executor({ workdir }) {
      executorCount += 1;
      const file = `src/feature-${executorCount}.js`;
      writeFile(path.join(workdir, file), `export const f${executorCount} = ${executorCount};\n`);
      run('git', ['add', file], workdir);
      run('git', ['commit', '-m', `feat: chunk ${executorCount}`], workdir);
      return { summary: `Implemented ${file}`, testsRun: [], notes: [] };
    },
    async refinement() {
      refinementCount += 1;
      if (refinementCount === 1) {
        return {
          improvementFound: true,
          inFrame: true,
          unresolvedCount: 1,
          rationale: 'Extract a helper to satisfy maintainability criterion.',
          chunk: { id: 'refine_1', title: 'extract helper', acceptanceCriteria: ['helper extracted'] }
        };
      }
      return { improvementFound: false, inFrame: true, unresolvedCount: 0, rationale: 'done', chunk: { id: '', title: '', acceptanceCriteria: [] } };
    }
  });

  const domain = createCodeExecutionDomain({
    config: {
      agent: { defaultProvider: 'claude' },
      workspace: { projectsRoot: workspace.root },
      github: { owner: '', repositories: [] }
    },
    repo,
    workspaceRunner,
    githubClient: {
      async createPullRequest() {
        throw new Error('not used');
      }
    },
    codexCliRunner: {
      async assertAvailable() {
        throw new Error('codex should not run');
      },
      async runExec() {
        throw new Error('codex should not run');
      }
    },
    claudeCliRunner,
    codeTaskPlanner: {
      async createPullRequestDraft() {
        return { title: 'refinement PR', body: 'refinement verification' };
      }
    }
  });

  const task = await domain.createTask({
    command: 'Add feature with refinement',
    agentProvider: 'claude',
    workdir: workspace.repoDir,
    baseBranch: 'main'
  });

  await driveThroughGates(domain, repo, task.id);

  const finished = repo.getTask(task.id);
  assert.equal(finished.status, 'awaiting_approval');
  // 초기 chunk 1개 + 개선 루프 chunk 1개
  assert.equal(finished.result.runner.chunks.length, 2);
  assert.ok(finished.result.runner.chunks[1].title.startsWith('[개선]'));
  assert.ok(Array.isArray(finished.result.runner.refinements));
  assert.ok(finished.result.runner.refinements.some((entry) => entry.status === 'applied'));
  // 개선 루프는 1회 적용 후 다음 점검에서 종료 → 점검 2회
  assert.equal(refinementCount, 2);
  assert.equal(executorCount, 2);
});

test('code execution domain pauses at risk gate (Gate 3) on destructive change and resumes on approval', async () => {
  const workspace = createGitWorkspace();
  const repo = createRepository(path.join(workspace.root, 'agent.db'));
  const workspaceRunner = new WorkspaceRunner({
    workspace: {
      allowlist: [workspace.root, fs.realpathSync(workspace.root)]
    }
  });

  const claudeCliRunner = makeRunnerCli({
    async executor({ workdir }) {
      writeFile(path.join(workdir, 'src', 'added.js'), 'export const added = 1;\n');
      run('git', ['rm', 'src/index.js'], workdir);
      run('git', ['add', 'src/added.js'], workdir);
      run('git', ['commit', '-m', 'feat: add file and delete index'], workdir);
      return { summary: 'Added a file and removed src/index.js', testsRun: [], notes: [] };
    }
  });

  const domain = createCodeExecutionDomain({
    config: {
      agent: { defaultProvider: 'claude' },
      workspace: { projectsRoot: workspace.root },
      github: { owner: '', repositories: [] }
    },
    repo,
    workspaceRunner,
    githubClient: { async createPullRequest() { throw new Error('not used'); } },
    codexCliRunner: {
      async assertAvailable() { throw new Error('codex should not run'); },
      async runExec() { throw new Error('codex should not run'); }
    },
    claudeCliRunner,
    codeTaskPlanner: { async createPullRequestDraft() { return { title: 't', body: 'b' }; } }
  });

  const gateOf = () => repo.getTask(task.id)?.result?.executionProgress?.gate;
  const isAwaiting = () => String(repo.getTask(task.id)?.status || '') === 'awaiting_approval';

  const task = await domain.createTask({
    command: 'Risky change',
    agentProvider: 'claude',
    workdir: workspace.repoDir,
    baseBranch: 'main'
  });

  await domain.start(task.id);
  await waitFor(() => isAwaiting() && gateOf() === 'spec', 'spec gate');
  await domain.approveGate(task.id, { gate: 'spec', decision: 'approve' });
  await waitFor(() => isAwaiting() && gateOf() === 'plan', 'plan gate');
  await domain.approveGate(task.id, { gate: 'plan', decision: 'approve' });
  await waitFor(() => isAwaiting() && gateOf() === 'risk', 'risk gate');

  const riskTask = repo.getTask(task.id);
  assert.ok(riskTask.result.runner.riskReview.deletions.includes('src/index.js'));

  await domain.approveGate(task.id, { gate: 'risk', decision: 'approve' });
  await waitFor(() => {
    const current = repo.getTask(task.id);
    return current?.result?.executionProgress?.phase === 'completed';
  }, 'completion after risk approval');

  const finished = repo.getTask(task.id);
  assert.equal(finished.status, 'awaiting_approval');
  assert.equal(finished.payload.riskApproved, true);
  assert.equal(finished.result.runner.chunks[0].status, 'committed');
});

test('code execution domain enters plan patch loop when executor reports a plan mismatch', async () => {
  const workspace = createGitWorkspace();
  const repo = createRepository(path.join(workspace.root, 'agent.db'));
  const workspaceRunner = new WorkspaceRunner({
    workspace: {
      allowlist: [workspace.root, fs.realpathSync(workspace.root)]
    }
  });

  let executorCalls = 0;
  const claudeCliRunner = makeRunnerCli({
    async executor({ workdir }) {
      executorCalls += 1;
      if (executorCalls === 1) {
        return {
          summary: 'Plan does not fit repository reality.',
          testsRun: [],
          notes: [],
          planPatchRequest: { reason: 'expected helper module is missing', proposedChange: 'add a setup step before the change' }
        };
      }
      writeFile(path.join(workdir, 'README.md'), '# Demo\n\nImplemented after plan patch.\n');
      run('git', ['add', 'README.md'], workdir);
      run('git', ['commit', '-m', 'feat: implement after plan patch'], workdir);
      return { summary: 'Implemented after patch', testsRun: [], notes: [] };
    }
  });

  const domain = createCodeExecutionDomain({
    config: {
      agent: { defaultProvider: 'claude' },
      workspace: { projectsRoot: workspace.root },
      github: { owner: '', repositories: [] }
    },
    repo,
    workspaceRunner,
    githubClient: { async createPullRequest() { throw new Error('not used'); } },
    codexCliRunner: {
      async assertAvailable() { throw new Error('codex should not run'); },
      async runExec() { throw new Error('codex should not run'); }
    },
    claudeCliRunner,
    codeTaskPlanner: { async createPullRequestDraft() { return { title: 't', body: 'b' }; } }
  });

  const gateOf = () => repo.getTask(task.id)?.result?.executionProgress?.gate;
  const isAwaiting = () => String(repo.getTask(task.id)?.status || '') === 'awaiting_approval';

  const task = await domain.createTask({
    command: 'Change needing plan patch',
    agentProvider: 'claude',
    workdir: workspace.repoDir,
    baseBranch: 'main'
  });

  await domain.start(task.id);
  await waitFor(() => isAwaiting() && gateOf() === 'spec', 'spec gate');
  await domain.approveGate(task.id, { gate: 'spec', decision: 'approve' });
  await waitFor(() => isAwaiting() && gateOf() === 'plan', 'plan gate');
  await domain.approveGate(task.id, { gate: 'plan', decision: 'approve' });
  await waitFor(() => isAwaiting() && gateOf() === 'plan_patch', 'plan patch gate');

  const patchTask = repo.getTask(task.id);
  assert.match(patchTask.result.runner.planPatchRequest.reason, /helper module is missing/);

  // 패치 승인 → 계획 재수립(Gate 2)으로 복귀
  await domain.approveGate(task.id, { gate: 'plan_patch', decision: 'approve' });
  await waitFor(() => isAwaiting() && gateOf() === 'plan', 'plan gate after patch');
  assert.equal(repo.listArtifacts(task.id, 'plan_patch_history').length, 1);

  // 갱신된 계획 승인 → 구현 재개 → 완료
  await domain.approveGate(task.id, { gate: 'plan', decision: 'approve' });
  await waitFor(() => {
    const current = repo.getTask(task.id);
    return current?.result?.executionProgress?.phase === 'completed';
  }, 'completion after plan patch');

  const finished = repo.getTask(task.id);
  assert.equal(finished.status, 'awaiting_approval');
  assert.equal(executorCalls, 2);
  assert.equal(finished.result.runner.chunks[0].status, 'committed');
});

test('createTask can continue from a previous completed code task', async () => {
  const workspace = createGitWorkspace();
  const repo = createRepository(path.join(workspace.root, 'agent.db'));
  const workspaceRunner = new WorkspaceRunner({
    workspace: {
      allowlist: [workspace.root, fs.realpathSync(workspace.root)]
    }
  });

  let codexAvailableCalls = 0;
  let claudeAvailableCalls = 0;
  const domain = createCodeExecutionDomain({
    config: {
      agent: {
        defaultProvider: 'codex'
      },
      workspace: {
        projectsRoot: workspace.root
      },
      github: {
        owner: '',
        repositories: []
      }
    },
    repo,
    workspaceRunner,
    githubClient: {
      async createPullRequest() {
        throw new Error('not used');
      }
    },
    codexCliRunner: {
      async assertAvailable() {
        codexAvailableCalls += 1;
        throw new Error('codex should not be selected for continuation');
      },
      async runExec() {
        throw new Error('not used');
      }
    },
    claudeCliRunner: {
      async assertAvailable() {
        claudeAvailableCalls += 1;
      },
      async runExec() {
        throw new Error('not used');
      }
    },
    codeTaskPlanner: {
      async createPromptPlan() {
        throw new Error('not used');
      },
      async createPullRequestDraft() {
        throw new Error('not used');
      }
    }
  });

  const previousTask = repo.upsertTask({
    domain: 'code_execution',
    kind: 'implementation',
    title: '[코드] Previous task',
    status: 'done',
    payload: {
      command: 'Initial implementation',
      workdir: workspace.repoDir,
      baseBranch: 'main',
      branchName: 'feature/initial',
      agentProvider: 'claude'
    },
    result: {
      branch: 'feature/initial',
      promptPlan: {
        summary: 'Initial plan summary'
      },
      commits: [{
        sha: 'abc1234def',
        subject: 'feat: initial change'
      }],
      reviewRounds: [{
        round: 1,
        review: {
          findings: [{ id: 'review-1' }],
          approval: 'changes_requested'
        }
      }]
    },
    summary: 'Initial task summary'
  });

  const followUpTask = await domain.createTask({
    command: 'Follow-up implementation',
    continueFromTaskId: previousTask.id
  });
  const createdTask = repo.getTask(followUpTask.id);
  assert.equal(codexAvailableCalls, 0);
  assert.equal(claudeAvailableCalls, 1);
  assert.equal(fs.realpathSync(createdTask.payload.workdir), fs.realpathSync(workspace.repoDir));
  assert.equal(createdTask.payload.baseBranch, 'main');
  assert.equal(createdTask.payload.agentProvider, 'claude');
  assert.equal(createdTask.payload.continueFromTaskId, previousTask.id);
  assert.equal(createdTask.payload.parentTaskId, previousTask.id);
  assert.equal(createdTask.payload.rootTaskId, previousTask.id);
  assert.equal(createdTask.result.executionProgress.totalSteps, 6);
  assert.equal(createdTask.result.executionProgress.gate, '');
  assert.match(createdTask.summary, /이전 작업을 이어 실행 대기 중입니다/);
  assert.deepEqual(createdTask.payload.continuationContext.previousCommits, [
    'feat: initial change (abc1234)'
  ]);
  assert.deepEqual(createdTask.payload.continuationContext.previousReview, [
    'round 1: findings 1, changes_requested'
  ]);
  assert.equal(createdTask.payload.continuationContext.previousPromptPlanSummary, 'Initial plan summary');
});

test('createTask rejects continuation when previous task is still running', async () => {
  const workspace = createGitWorkspace();
  const repo = createRepository(path.join(workspace.root, 'agent.db'));
  const workspaceRunner = new WorkspaceRunner({
    workspace: {
      allowlist: [workspace.root, fs.realpathSync(workspace.root)]
    }
  });

  const domain = createCodeExecutionDomain({
    config: {
      agent: {
        defaultProvider: 'claude'
      },
      workspace: {
        projectsRoot: workspace.root
      },
      github: {
        owner: '',
        repositories: []
      }
    },
    repo,
    workspaceRunner,
    githubClient: {
      async createPullRequest() {
        throw new Error('not used');
      }
    },
    codexCliRunner: {
      async assertAvailable() {},
      async runExec() {
        throw new Error('not used');
      }
    },
    claudeCliRunner: {
      async assertAvailable() {},
      async runExec() {
        throw new Error('not used');
      }
    },
    codeTaskPlanner: {
      async createPromptPlan() {
        throw new Error('not used');
      },
      async createPullRequestDraft() {
        throw new Error('not used');
      }
    }
  });

  const runningTask = repo.upsertTask({
    domain: 'code_execution',
    kind: 'implementation',
    title: '[코드] Running task',
    status: 'running',
    payload: {
      command: 'Running implementation',
      workdir: workspace.repoDir,
      baseBranch: 'main'
    }
  });

  await assert.rejects(
    () => domain.createTask({
      command: 'Should fail',
      continueFromTaskId: runningTask.id
    }),
    /현재 상태에서는 이어서 실행할 수 없습니다/
  );
});

test('createTask treats unknown baseBranch as requested branch name when branchName is empty', async () => {
  const workspace = createGitWorkspace();
  const repo = createRepository(path.join(workspace.root, 'agent.db'));
  const workspaceRunner = new WorkspaceRunner({
    workspace: {
      allowlist: [workspace.root, fs.realpathSync(workspace.root)]
    }
  });

  const domain = createCodeExecutionDomain({
    config: {
      agent: {
        defaultProvider: 'codex'
      },
      workspace: {
        projectsRoot: workspace.root
      },
      github: {
        owner: '',
        repositories: []
      }
    },
    repo,
    workspaceRunner,
    githubClient: {
      async createPullRequest() {
        throw new Error('not used');
      }
    },
    codexCliRunner: {
      async assertAvailable() {},
      async runExec() {
        throw new Error('not used');
      }
    },
    claudeCliRunner: null,
    codeTaskPlanner: {
      async createPromptPlan() {
        throw new Error('not used');
      },
      async createPullRequestDraft() {
        throw new Error('not used');
      }
    }
  });

  const task = await domain.createTask({
    command: 'Implement follow-up change',
    projectId: 'repo',
    baseBranch: 'work/hochan/FROMM-2985/FROMM-3102',
    branchName: ''
  });
  const createdTask = repo.getTask(task.id);

  assert.equal(createdTask.payload.baseBranch, 'main');
  assert.equal(createdTask.payload.requestedBranchName, 'work/hochan/FROMM-2985/FROMM-3102');
});

test('createTask returns friendly error when explicit baseBranch is not found', async () => {
  const workspace = createGitWorkspace();
  const repo = createRepository(path.join(workspace.root, 'agent.db'));
  const workspaceRunner = new WorkspaceRunner({
    workspace: {
      allowlist: [workspace.root, fs.realpathSync(workspace.root)]
    }
  });

  const domain = createCodeExecutionDomain({
    config: {
      agent: {
        defaultProvider: 'codex'
      },
      workspace: {
        projectsRoot: workspace.root
      },
      github: {
        owner: '',
        repositories: []
      }
    },
    repo,
    workspaceRunner,
    githubClient: {
      async createPullRequest() {
        throw new Error('not used');
      }
    },
    codexCliRunner: {
      async assertAvailable() {},
      async runExec() {
        throw new Error('not used');
      }
    },
    claudeCliRunner: null,
    codeTaskPlanner: {
      async createPromptPlan() {
        throw new Error('not used');
      },
      async createPullRequestDraft() {
        throw new Error('not used');
      }
    }
  });

  await assert.rejects(
    () => domain.createTask({
      command: 'Explicit invalid base branch',
      projectId: 'repo',
      baseBranch: 'missing/base',
      branchName: 'work/hochan/FROMM-3102'
    }),
    /기준 브랜치를 찾지 못했습니다: missing\/base/
  );
});

test('code execution can run on repository without commit history', async () => {
  const workspace = createEmptyGitWorkspace();
  const repo = createRepository(path.join(workspace.root, 'agent.db'));
  const workspaceRunner = new WorkspaceRunner({
    workspace: {
      allowlist: [workspace.root, fs.realpathSync(workspace.root)]
    }
  });

  const codexCliRunner = makeRunnerCli({
    async executor({ workdir }) {
      writeFile(path.join(workdir, 'README.md'), '# Bootstrap\n');
      run('git', ['add', 'README.md'], workdir);
      run('git', ['commit', '-m', 'feat: bootstrap repository'], workdir);
      return { summary: 'Bootstrapped repository files.', testsRun: [], notes: [] };
    }
  });

  const domain = createCodeExecutionDomain({
    config: {
      agent: { defaultProvider: 'codex' },
      workspace: { projectsRoot: workspace.root },
      github: { owner: '', repositories: [] }
    },
    repo,
    workspaceRunner,
    githubClient: {
      async createPullRequest() {
        throw new Error('not used');
      }
    },
    codexCliRunner,
    claudeCliRunner: null,
    codeTaskPlanner: {
      async createPullRequestDraft() {
        return { title: 'feat: bootstrap repository', body: '- bootstrap' };
      }
    }
  });

  const task = await domain.createTask({
    command: 'Bootstrap repository',
    projectId: 'repo',
    baseBranch: 'master'
  });
  const createdTask = repo.getTask(task.id);
  assert.equal(createdTask.payload.baseBranch, 'main');

  await driveThroughGates(domain, repo, task.id);

  const finishedTask = repo.getTask(task.id);
  assert.equal(finishedTask.status, 'done');
  assert.equal(read('git', ['branch', '--show-current'], workspace.repoDir), finishedTask.result.branch);
  assert.equal(hasLocalBranch(workspace.repoDir, finishedTask.result.branch), true);
  assert.equal(read('git', ['show', `${finishedTask.result.branch}:README.md`], workspace.repoDir), '# Bootstrap');
  assert.equal(Boolean(finishedTask.result.canCreatePullRequest), false);
});
