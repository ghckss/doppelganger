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

test('code execution domain orchestrates coding, reviews, and pull request creation', async () => {
  const workspace = createGitWorkspace();
  const repo = createRepository(path.join(workspace.root, 'agent.db'));
  const workspaceRunner = new WorkspaceRunner({
    workspace: {
      allowlist: [workspace.root, fs.realpathSync(workspace.root)]
    }
  });

  let callCount = 0;
  let codexCallCount = 0;
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
    async runExec({ workdir, schema }) {
      callCount += 1;

      if (schema.required.includes('findings')) {
        if (callCount === 2) {
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

      if (schema.required.includes('resolvedFindingIds')) {
        writeFile(path.join(workdir, 'src', 'index.js'), 'export const value = 2;\n');
        run('git', ['add', 'src/index.js'], workdir);
        run('git', ['commit', '-m', 'fix: address review round 1'], workdir);

        return {
          parsed: {
            summary: 'Applied the requested review fix.',
            resolvedFindingIds: ['review-1'],
            declinedFindingIds: [],
            testsRun: ['npm test'],
            notes: ['Updated the exported value.']
          },
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
    async createPromptPlan() {
      return {
        summary: 'Implement the requested change.',
        goal: 'Add the requested feature and keep the repo reviewable.',
        taskType: 'feature',
        successCriteria: ['Feature implemented', 'Repo clean after automation'],
        deliverables: ['Code change', 'PR draft'],
        constraints: ['Do not revert unrelated changes'],
        relevantContext: ['main branch']
      };
    },
    async createProductPlan() {
      return {
        summary: 'Product plan',
        problem: 'Need the requested code change',
        userScenarios: ['User gets the requested repository change'],
        acceptanceCriteria: ['Feature implemented'],
        outOfScope: ['Unrelated cleanup'],
        risks: ['Low']
      };
    },
    async createDesignSpec() {
      return {
        summary: 'Design guidance',
        targets: ['README'],
        layoutChanges: ['Keep layout simple'],
        visualRules: ['Match existing style'],
        interactionStates: [],
        accessibilityChecks: ['Preserve readable text'],
        responsiveNotes: []
      };
    },
    async createPullRequestDraft() {
      return {
        title: 'feat(demo): Implement requested change',
        body: '## Summary\n- Implemented requested change\n'
      };
    }
  };

  let lastPullRequestRequest = null;
  let lastUpdatePullRequestRequest = null;
  let updatePullRequestCallCount = 0;
  let createPullRequestCallCount = 0;
  let existingPullRequest = null;
  const githubClient = {
    async createPullRequest({ owner, repo: repoName, head, base, title, body }) {
      createPullRequestCallCount += 1;
      lastPullRequestRequest = {
        owner,
        repoName,
        head,
        base,
        title,
        body
      };
      if (createPullRequestCallCount >= 2) {
        throw new GitHubApiError('Validation Failed', {
          status: 422,
          payload: {
            message: 'Validation Failed',
            errors: [
              {
                message: `A pull request already exists for ${owner}:${head}.`
              }
            ]
          },
          method: 'POST',
          path: `/repos/${owner}/${repoName}/pulls`
        });
      }

      existingPullRequest = {
        number: 7,
        html_url: `https://github.com/${owner}/${repoName}/pull/7`,
        head: {
          ref: head
        },
        base: {
          ref: base
        },
        title
      };
      return {
        number: 7,
        html_url: `https://github.com/${owner}/${repoName}/pull/7`,
        head,
        base,
        title
      };
    },
    async listOpenPullRequests() {
      return existingPullRequest ? [existingPullRequest] : [];
    },
    async updatePullRequest({ owner, repo: repoName, pullNumber, title, body, base }) {
      updatePullRequestCallCount += 1;
      lastUpdatePullRequestRequest = {
        owner,
        repoName,
        pullNumber,
        title,
        body,
        base
      };
      return {
        number: pullNumber,
        html_url: `https://github.com/${owner}/${repoName}/pull/${pullNumber}`,
        title,
        body,
        base
      };
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
    branchName: 'feature/custom-demo-branch',
    needsPlanning: true,
    needsDesign: true
  });
  const createdTask = repo.getTask(task.id);
  assert.equal(createdTask.payload.agentProvider, 'claude');
  assert.equal(createdTask.result.executionProgress.phase, 'queued');
  assert.equal(createdTask.result.executionProgress.currentStep, 0);
  assert.equal(createdTask.result.executionProgress.totalSteps, 6);
  assert.equal(createdTask.result.executionProgress.percent, 0);

  await domain.start(task.id);

  await waitFor(() => {
    const current = repo.getTask(task.id);
    return current?.status === 'awaiting_approval';
  }, 'Timed out waiting for code task to finish');

  const finishedTask = repo.getTask(task.id);
  assert.equal(finishedTask.status, 'awaiting_approval');
  assert.equal(finishedTask.result.branch, 'feature/custom-demo-branch');
  assert.equal(finishedTask.result.commits.length, 2);
  assert.equal(finishedTask.result.reviewRounds.length, 1);
  assert.equal(finishedTask.result.executionProgress.phase, 'completed');
  assert.equal(finishedTask.result.executionProgress.currentStep, 6);
  assert.equal(finishedTask.result.executionProgress.totalSteps, 6);
  assert.equal(finishedTask.result.executionProgress.percent, 100);
  assert.equal(codexCallCount, 0);
  assert.equal(repo.listArtifacts(task.id, 'prompt_plan').length, 1);
  assert.equal(repo.listArtifacts(task.id, 'product_plan').length, 1);
  assert.equal(repo.listArtifacts(task.id, 'design_spec').length, 1);
  assert.equal(repo.listArtifacts(task.id, 'review_round').length, 1);
  assert.equal(repo.listArtifacts(task.id, 'patch_round').length, 1);
  assert.equal(read('git', ['branch', '--show-current'], workspace.repoDir), 'main');
  assert.equal(hasLocalBranch(workspace.repoDir, finishedTask.result.branch), false);
  assert.equal(read('git', ['show', 'main:README.md'], workspace.repoDir), '# Demo\n\nImplemented by agent.');
  assert.equal(read('git', ['show', 'main:src/index.js'], workspace.repoDir), 'export const value = 2;');
  assert.equal(typeof finishedTask.result.sourceCommit, 'string');
  assert.ok(finishedTask.result.sourceCommit.length > 0);
  assert.equal(finishedTask.result.branchCleanup?.deleted, true);

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
  assert.equal(lastPullRequestRequest.title, '[DEMO/demo-pr] Implement requested change');
  assert.match(lastPullRequestRequest.body, /## PR 개요/);
  assert.match(lastPullRequestRequest.body, /Implement requested change/);
  assert.match(lastPullRequestRequest.body, /## Summary/);
  assert.equal(doneTask.result.pullRequest.servicePrefix, 'DEMO');
  assert.equal(doneTask.result.pullRequest.sourceBranch, doneTask.result.branch);
  assert.equal(doneTask.result.pullRequest.head, remoteBranch);
  assert.equal(doneTask.result.pullRequest.templateUsed, true);
  assert.equal(createPullRequestCallCount, 1);

  await domain.createPullRequest(task.id, {
    branchName: remoteBranch
  });
  const doneTaskWithExistingPr = repo.getTask(task.id);
  assert.equal(doneTaskWithExistingPr.status, 'done');
  assert.match(doneTaskWithExistingPr.summary, /기존 PR을 확인했습니다/);
  assert.equal(doneTaskWithExistingPr.result.pullRequest.number, 7);
  assert.equal(createPullRequestCallCount, 2);
  assert.equal(updatePullRequestCallCount, 1);
  assert.equal(lastUpdatePullRequestRequest.owner, 'acme');
  assert.equal(lastUpdatePullRequestRequest.repoName, 'demo');
  assert.equal(lastUpdatePullRequestRequest.pullNumber, 7);
  assert.equal(lastUpdatePullRequestRequest.title, '[DEMO/demo-pr] Implement requested change');
  assert.match(lastUpdatePullRequestRequest.body, /## PR 개요/);
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
  const domain = createCodeExecutionDomain({
    config: {
      agent: {
        defaultProvider: 'claude'
      },
      workspace: {
        projectsRoot: workspace.root
      },
      github: {
        owner: 'acme',
        repositories: ['fromm-web']
      }
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
      async assertAvailable() {},
      async runExec() {
        throw new Error('codex should not be selected in this test');
      }
    },
    claudeCliRunner: {
      async assertAvailable() {},
      async runExec({ workdir, schema }) {
        if (schema.required.includes('findings')) {
          return {
            parsed: {
              summary: 'No issues found.',
              findings: [],
              approval: 'approved_with_no_changes',
              residualRisks: []
            },
            stdout: '',
            stderr: '',
            durationMs: 1
          };
        }

        if (schema.required.includes('resolvedFindingIds')) {
          throw new Error('Patch step should not run when review has no findings');
        }

        writeFile(path.join(workdir, 'README.md'), '# Demo\n\nAllowlist-based run.\n');
        run('git', ['add', 'README.md'], workdir);
        run('git', ['commit', '-m', 'feat: allowlist code execution run'], workdir);

        return {
          parsed: {
            summary: 'Implemented requested change.',
            testsRun: ['npm test'],
            notes: ['Completed in workspace allowlist project.']
          },
          stdout: '',
          stderr: '',
          durationMs: 1
        };
      }
    },
    codeTaskPlanner: {
      async createPromptPlan() {
        return {
          summary: 'Allowlist execution test',
          goal: 'Run coding workflow even when repo is not in GitHub repository allowlist.',
          taskType: 'feature',
          successCriteria: [],
          deliverables: [],
          constraints: [],
          relevantContext: []
        };
      },
      async createPullRequestDraft() {
        return {
          title: 'Allowlist workflow test',
          body: '## Summary\n- Verify PR restriction scope\n'
        };
      }
    }
  });

  const task = await domain.createTask({
    command: 'Run with workspace allowlist only',
    agentProvider: 'claude',
    workdir: workspace.repoDir,
    baseBranch: 'main',
    needsPlanning: false,
    needsDesign: false
  });

  await domain.start(task.id);

  await waitFor(() => {
    const current = repo.getTask(task.id);
    return current?.status === 'awaiting_approval';
  }, 'Timed out waiting for allowlist code task to finish');

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

  const claudeCliRunner = {
    async assertAvailable() {},
    async runExec({ workdir, schema }) {
      if (schema.required.includes('findings')) {
        return {
          parsed: {
            summary: 'No issues found.',
            findings: [],
            approval: 'approved_with_no_changes',
            residualRisks: []
          },
          stdout: '',
          stderr: '',
          durationMs: 1
        };
      }

      if (schema.required.includes('resolvedFindingIds')) {
        throw new Error('Patch step should not run when no findings exist');
      }

      writeFile(path.join(workdir, 'README.md'), '# Demo\n\nDirty worktree fallback.\n');
      return {
        parsed: {
          summary: 'Implemented without creating a commit.',
          testsRun: ['npm test'],
          notes: ['Left unstaged changes intentionally.']
        },
        stdout: '',
        stderr: '',
        durationMs: 1
      };
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
          summary: 'Dirty worktree fallback test',
          goal: 'Auto-commit dirty coding output',
          taskType: 'feature',
          successCriteria: [],
          deliverables: [],
          constraints: [],
          relevantContext: []
        };
      },
      async createPullRequestDraft() {
        return {
          title: 'Dirty fallback PR',
          body: 'Auto-commit fallback verification'
        };
      }
    }
  });

  const task = await domain.createTask({
    command: 'Verify dirty worktree fallback',
    agentProvider: 'claude',
    workdir: workspace.repoDir,
    baseBranch: 'main',
    needsPlanning: false,
    needsDesign: false
  });

  await domain.start(task.id);

  await waitFor(() => {
    const current = repo.getTask(task.id);
    return current?.status === 'awaiting_approval';
  }, 'Timed out waiting for fallback auto-commit task to finish');

  const finishedTask = repo.getTask(task.id);
  assert.equal(finishedTask.status, 'awaiting_approval');
  assert.ok(Array.isArray(finishedTask.result.commits));
  assert.ok(finishedTask.result.commits.some((commit) => commit.subject.includes('auto-commit coding agent workspace changes')));

  const executionActions = repo.listExecutions(task.id).map((execution) => execution.action);
  assert.ok(executionActions.includes('auto_commit_coding_changes'));
});

test('code execution domain resumes from coding checkpoint without rerunning planning', async () => {
  const workspace = createGitWorkspace();
  const repo = createRepository(path.join(workspace.root, 'agent.db'));
  const workspaceRunner = new WorkspaceRunner({
    workspace: {
      allowlist: [workspace.root, fs.realpathSync(workspace.root)]
    }
  });

  let codingCalls = 0;
  const claudeCliRunner = {
    async assertAvailable() {},
    async runExec({ workdir, schema }) {
      if (schema.required.includes('findings')) {
        return {
          parsed: {
            summary: 'No issues found.',
            findings: [],
            approval: 'approved_with_no_changes',
            residualRisks: []
          },
          stdout: '',
          stderr: '',
          durationMs: 1
        };
      }

      if (schema.required.includes('resolvedFindingIds')) {
        throw new Error('Patch step should not run when no findings exist');
      }

      codingCalls += 1;
      if (codingCalls === 1) {
        throw new Error('Simulated token expiration during coding step');
      }

      writeFile(path.join(workdir, 'README.md'), '# Demo\n\nResume from coding checkpoint.\n');
      run('git', ['add', 'README.md'], workdir);
      run('git', ['commit', '-m', 'feat: resume coding checkpoint'], workdir);

      return {
        parsed: {
          summary: 'Completed coding after resume.',
          testsRun: ['npm test'],
          notes: ['Resumed from coding checkpoint.']
        },
        stdout: '',
        stderr: '',
        durationMs: 1
      };
    }
  };

  let promptPlanCalls = 0;
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
        promptPlanCalls += 1;
        return {
          summary: 'Resume checkpoint plan',
          goal: 'Resume from coding step',
          taskType: 'feature',
          successCriteria: [],
          deliverables: [],
          constraints: [],
          relevantContext: []
        };
      },
      async createPullRequestDraft() {
        return {
          title: 'Resume checkpoint PR',
          body: 'resume checkpoint validation'
        };
      }
    }
  });

  const task = await domain.createTask({
    command: 'Resume from coding checkpoint',
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
  }, 'Timed out waiting for first failed run');

  const failedTask = repo.getTask(task.id);
  assert.equal(failedTask.result.executionProgress.currentStep, 3);
  assert.equal(promptPlanCalls, 1);

  await domain.start(task.id, { resumeFromCheckpoint: true });

  await waitFor(() => {
    const current = repo.getTask(task.id);
    return current?.status === 'awaiting_approval';
  }, 'Timed out waiting for resumed run');

  const resumedTask = repo.getTask(task.id);
  assert.equal(resumedTask.status, 'awaiting_approval');
  assert.equal(promptPlanCalls, 1);
  assert.match(resumedTask.summary, /PR 생성 준비/);

  const executionActions = repo.listExecutions(task.id).map((execution) => execution.action);
  assert.ok(executionActions.includes('resume_from_checkpoint'));
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
  assert.equal(createdTask.result.executionProgress.reviewTotalRounds, 1);
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
      async runExec({ workdir, schema }) {
        if (schema.required.includes('findings')) {
          return {
            parsed: {
              summary: 'No issues found.',
              findings: [],
              approval: 'approved_with_no_changes',
              residualRisks: []
            },
            stdout: '',
            stderr: '',
            durationMs: 1
          };
        }

        if (schema.required.includes('resolvedFindingIds')) {
          throw new Error('patch round should not run');
        }

        writeFile(path.join(workdir, 'README.md'), '# Bootstrap\n');
        run('git', ['add', 'README.md'], workdir);
        run('git', ['commit', '-m', 'feat: bootstrap repository'], workdir);
        return {
          parsed: {
            summary: 'Bootstrapped repository files.',
            testsRun: [],
            notes: []
          },
          stdout: '',
          stderr: '',
          durationMs: 1
        };
      }
    },
    claudeCliRunner: null,
    codeTaskPlanner: {
      async createPromptPlan() {
        return {
          summary: 'Bootstrap repository',
          goal: 'Create initial project files',
          taskType: 'feature',
          successCriteria: ['Initial files committed'],
          deliverables: ['README'],
          constraints: [],
          relevantContext: []
        };
      },
      async createProductPlan() {
        throw new Error('not used');
      },
      async createDesignSpec() {
        throw new Error('not used');
      },
      async createPullRequestDraft() {
        return {
          title: 'feat: bootstrap repository',
          body: '- bootstrap'
        };
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

  await domain.start(task.id);

  await waitFor(() => {
    const current = repo.getTask(task.id);
    return current?.status === 'awaiting_approval';
  }, 'Timed out waiting for code task to finish in empty repository');

  const finishedTask = repo.getTask(task.id);
  assert.equal(finishedTask.status, 'awaiting_approval');
  assert.equal(read('git', ['branch', '--show-current'], workspace.repoDir), 'main');
  assert.equal(read('git', ['show', 'main:README.md'], workspace.repoDir), '# Bootstrap');
  assert.equal(hasLocalBranch(workspace.repoDir, finishedTask.result.branch), false);
});

test('code execution domain supports plan mode and stops after planning with confirmation requests', async () => {
  const workspace = createGitWorkspace();
  const repo = createRepository(path.join(workspace.root, 'agent.db'));
  const workspaceRunner = new WorkspaceRunner({
    workspace: {
      allowlist: [workspace.root, fs.realpathSync(workspace.root)]
    }
  });

  let cliRunCount = 0;
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
        cliRunCount += 1;
        throw new Error('plan mode should not run coding/review agent');
      }
    },
    claudeCliRunner: null,
    codeTaskPlanner: {
      async createPromptPlan() {
        return {
          summary: 'Plan-only summary',
          goal: 'Create a plan and ask for user decisions',
          taskType: 'feature',
          successCriteria: ['plan created'],
          deliverables: ['prompt plan'],
          constraints: ['stay in scope'],
          relevantContext: ['main branch'],
          confirmationRequests: [{
            id: 'scope_preference',
            title: '변경 범위',
            question: '어떤 범위로 반영할까요?',
            options: [{
              id: 'minimal_change',
              label: '최소 변경',
              description: '요청 범위만 반영',
              recommended: true
            }, {
              id: 'balanced_change',
              label: '균형 변경',
              description: '요청 범위 + 인접 안정화',
              recommended: false
            }]
          }]
        };
      },
      async createProductPlan() {
        return {
          summary: 'Product plan summary',
          problem: 'Need alignment before coding',
          userScenarios: ['Operator confirms scope'],
          acceptanceCriteria: ['Decision captured'],
          outOfScope: [],
          risks: []
        };
      },
      async createDesignSpec() {
        return {
          summary: 'No design change',
          targets: [],
          layoutChanges: [],
          visualRules: [],
          interactionStates: [],
          accessibilityChecks: [],
          responsiveNotes: []
        };
      },
      async createPullRequestDraft() {
        throw new Error('not used in plan mode');
      }
    }
  });

  const task = await domain.createTask({
    command: 'Plan this change first',
    workdir: workspace.repoDir,
    baseBranch: 'main',
    executionMode: 'plan',
    needsPlanning: true,
    needsDesign: false
  });

  await domain.start(task.id);

  await waitFor(() => {
    const current = repo.getTask(task.id);
    return current?.status === 'awaiting_approval';
  }, 'Timed out waiting for plan mode task to finish');

  const finishedTask = repo.getTask(task.id);
  assert.equal(finishedTask.status, 'awaiting_approval');
  assert.equal(finishedTask.payload.executionMode, 'plan');
  assert.equal(finishedTask.result.executionProgress.totalSteps, 3);
  assert.equal(finishedTask.result.executionProgress.currentStep, 3);
  assert.equal(finishedTask.result.executionProgress.phase, 'plan_completed');
  assert.equal(finishedTask.result.planMode.status, 'awaiting_confirmation');
  assert.deepEqual(finishedTask.result.planMode.unresolvedRequestIds, ['scope_preference']);
  assert.equal(repo.listArtifacts(task.id, 'plan_confirmation_requests').length, 1);
  assert.equal(repo.listArtifacts(task.id, 'coding_prompt').length, 0);
  assert.equal(repo.listArtifacts(task.id, 'review_round').length, 0);
  assert.equal(cliRunCount, 0);
  assert.equal(read('git', ['branch', '--show-current'], workspace.repoDir), 'main');
});

test('plan mode requires selection before start and can continue into coding after selections are saved', async () => {
  const workspace = createGitWorkspace();
  const repo = createRepository(path.join(workspace.root, 'agent.db'));
  const workspaceRunner = new WorkspaceRunner({
    workspace: {
      allowlist: [workspace.root, fs.realpathSync(workspace.root)]
    }
  });

  let runExecCount = 0;
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
      async runExec({ workdir, schema }) {
        runExecCount += 1;

        if (schema.required.includes('findings')) {
          return {
            parsed: {
              summary: 'No findings.',
              findings: [],
              approval: 'approved_with_no_changes',
              residualRisks: []
            },
            stdout: '',
            stderr: '',
            durationMs: 1
          };
        }

        if (schema.required.includes('resolvedFindingIds')) {
          throw new Error('patch round should not run when there are no findings');
        }

        writeFile(path.join(workdir, 'src', 'plan-mode.js'), 'export const planMode = true;\n');
        run('git', ['add', 'src/plan-mode.js'], workdir);
        run('git', ['commit', '-m', 'feat: apply plan-mode implementation'], workdir);
        return {
          parsed: {
            summary: 'Applied code changes from confirmed plan.',
            testsRun: ['npm test'],
            notes: []
          },
          stdout: '',
          stderr: '',
          durationMs: 1
        };
      }
    },
    claudeCliRunner: null,
    codeTaskPlanner: {
      async createPromptPlan() {
        return {
          summary: 'Plan summary',
          goal: 'Collect selection and then execute coding',
          taskType: 'feature',
          successCriteria: ['selection stored', 'code implemented'],
          deliverables: ['code change'],
          constraints: ['stay in scope'],
          relevantContext: ['main branch'],
          confirmationRequests: [{
            id: 'scope_preference',
            title: '변경 범위',
            question: '변경 범위를 선택하세요.',
            options: [{
              id: 'minimal_change',
              label: '최소 변경',
              description: '요청 범위만 반영',
              recommended: true
            }, {
              id: 'balanced_change',
              label: '균형 변경',
              description: '요청 범위 + 인접 안정화',
              recommended: false
            }]
          }]
        };
      },
      async createProductPlan() {
        return {
          summary: 'Product plan',
          problem: 'Need selection before coding',
          userScenarios: [],
          acceptanceCriteria: [],
          outOfScope: [],
          risks: []
        };
      },
      async createDesignSpec() {
        return {
          summary: 'No design plan',
          targets: [],
          layoutChanges: [],
          visualRules: [],
          interactionStates: [],
          accessibilityChecks: [],
          responsiveNotes: []
        };
      },
      async createPullRequestDraft() {
        return {
          title: 'Plan mode follow-up',
          body: '## Summary\n- plan mode continued into coding\n'
        };
      }
    }
  });

  const task = await domain.createTask({
    command: 'Run planning first, then continue',
    workdir: workspace.repoDir,
    baseBranch: 'main',
    executionMode: 'plan'
  });

  await domain.start(task.id);
  await waitFor(() => repo.getTask(task.id)?.status === 'awaiting_approval', 'Timed out waiting for plan mode');

  const startWithoutSelection = await domain.start(task.id, { startFromPlan: true });
  assert.equal(startWithoutSelection.started, true);
  await waitFor(() => repo.getTask(task.id)?.status === 'failed', 'Timed out waiting for selection validation failure');
  assert.match(String(repo.getTask(task.id)?.last_error || ''), /플랜 확인 항목 선택이 필요합니다/);

  domain.savePlanSelections(task.id, {
    selections: {
      scope_preference: 'minimal_change'
    }
  });
  const afterSelection = repo.getTask(task.id);
  assert.equal(afterSelection.result.planMode.status, 'ready_for_execution');
  assert.equal(afterSelection.payload.planSelections.scope_preference, 'minimal_change');

  await domain.start(task.id, { startFromPlan: true });
  await waitFor(() => repo.getTask(task.id)?.status === 'awaiting_approval', 'Timed out waiting for full execution');

  const finishedTask = repo.getTask(task.id);
  assert.equal(finishedTask.payload.executionMode, 'full');
  assert.equal(finishedTask.result.planMode.status, 'confirmed');
  assert.equal(finishedTask.result.executionProgress.totalSteps, 6);
  assert.equal(finishedTask.result.executionProgress.currentStep, 6);
  assert.ok(Array.isArray(finishedTask.result.commits));
  assert.ok(finishedTask.result.commits.length >= 1);
  assert.equal(read('git', ['show', 'main:src/plan-mode.js'], workspace.repoDir), 'export const planMode = true;');
  assert.equal(runExecCount, 2);
});
