import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { createRepository } from '../src/db.js';
import { WorkspaceRunner } from '../src/connectors/workspace-runner.js';
import { createCodeExecutionDomain } from '../src/domains/code-execution-domain.js';

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'pipe' });
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
        title: 'Implement requested change',
        body: '## Summary\n- Implemented requested change\n'
      };
    }
  };

  const githubClient = {
    async createPullRequest({ owner, repo: repoName, head, base, title }) {
      return {
        number: 7,
        html_url: `https://github.com/${owner}/${repoName}/pull/7`,
        head,
        base,
        title
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
    needsPlanning: true,
    needsDesign: true
  });
  const createdTask = repo.getTask(task.id);
  assert.equal(createdTask.payload.agentProvider, 'claude');
  assert.equal(createdTask.result.executionProgress.phase, 'queued');
  assert.equal(createdTask.result.executionProgress.currentStep, 0);
  assert.equal(createdTask.result.executionProgress.totalSteps, 8);
  assert.equal(createdTask.result.executionProgress.percent, 0);

  await domain.start(task.id);

  await waitFor(() => {
    const current = repo.getTask(task.id);
    return current?.status === 'awaiting_approval';
  }, 'Timed out waiting for code task to finish');

  const finishedTask = repo.getTask(task.id);
  assert.equal(finishedTask.status, 'awaiting_approval');
  assert.equal(finishedTask.result.commits.length, 2);
  assert.equal(finishedTask.result.reviewRounds.length, 3);
  assert.equal(finishedTask.result.executionProgress.phase, 'completed');
  assert.equal(finishedTask.result.executionProgress.currentStep, 8);
  assert.equal(finishedTask.result.executionProgress.totalSteps, 8);
  assert.equal(finishedTask.result.executionProgress.percent, 100);
  assert.equal(codexCallCount, 0);
  assert.equal(repo.listArtifacts(task.id, 'prompt_plan').length, 1);
  assert.equal(repo.listArtifacts(task.id, 'product_plan').length, 1);
  assert.equal(repo.listArtifacts(task.id, 'design_spec').length, 1);
  assert.equal(repo.listArtifacts(task.id, 'review_round').length, 3);
  assert.equal(repo.listArtifacts(task.id, 'patch_round').length, 3);

  await domain.createPullRequest(task.id);

  const doneTask = repo.getTask(task.id);
  assert.equal(doneTask.status, 'done');
  assert.equal(doneTask.result.pullRequest.url, 'https://github.com/acme/demo/pull/7');
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
  assert.equal(failedTask.result.executionProgress.totalSteps, 8);
  assert.ok(failedTask.result.executionProgress.percent >= 0 && failedTask.result.executionProgress.percent <= 100);
  const executionActions = repo.listExecutions(task.id).map((execution) => execution.action);
  assert.ok(executionActions.includes('run_code_execution'));
});
