import fs from 'node:fs';
import path from 'node:path';
import {
  buildCodingPrompt,
  buildPatchPrompt,
  buildPullRequestDraft,
  buildReviewPrompt,
  codingAgentSchema,
  patchAgentSchema,
  renderArtifactContent,
  reviewAgentSchema
} from '../code-task-prompts.js';
import { normalizeWhitespace, safeArray, truncateText } from '../utils.js';

const CODE_REVIEW_ROUNDS = 3;
const CODE_EXECUTION_TOTAL_STEPS = CODE_REVIEW_ROUNDS + 5;

function parseBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value || '').toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'on' || normalized === 'yes';
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36) || 'task';
}

function parseRemoteUrl(remoteUrl) {
  const normalized = String(remoteUrl || '').trim();
  if (!normalized) {
    return {
      owner: '',
      name: '',
      repoSlug: ''
    };
  }

  const sshMatch = normalized.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    const owner = sshMatch[1];
    const name = sshMatch[2];
    return {
      owner,
      name,
      repoSlug: `${owner}/${name}`
    };
  }

  try {
    const url = new URL(normalized);
    const parts = url.pathname.split('/').filter(Boolean);
    const owner = parts.at(-2) || '';
    const rawName = (parts.at(-1) || '').replace(/\.git$/, '');
    return {
      owner: owner || '',
      name: rawName || '',
      repoSlug: owner && rawName ? `${owner}/${rawName}` : ''
    };
  } catch {
    return {
      owner: '',
      name: '',
      repoSlug: ''
    };
  }
}

function readScripts(workdir) {
  const packageJsonPath = path.join(workdir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    return {};
  }

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    return packageJson.scripts || {};
  } catch {
    return {};
  }
}

function recommendedChecksFromScripts(scripts) {
  const checks = [];
  if (scripts.test) {
    checks.push('npm test');
  }
  if (scripts.lint) {
    checks.push('npm run lint');
  }
  if (scripts.build) {
    checks.push('npm run build');
  }
  return checks;
}

function buildDirtyWorkspaceError(statusLines) {
  const lines = safeArray(statusLines).map((line) => normalizeWhitespace(line)).filter(Boolean);
  if (lines.length === 0) {
    return '자동 코드 작업을 시작하기 전에 저장소가 깨끗해야 합니다';
  }

  const previewLimit = 8;
  const preview = lines.slice(0, previewLimit).join(' | ');
  const remainder = lines.length > previewLimit ? ` (외 ${lines.length - previewLimit}건)` : '';
  return `자동 코드 작업을 시작하기 전에 저장소가 깨끗해야 합니다: ${preview}${remainder}`;
}

function formatExecutionError(error) {
  const base = normalizeWhitespace(error?.message || '알 수 없는 오류');
  const details = [
    error?.details?.stderr,
    error?.details?.lastMessage,
    error?.details?.stdout
  ].map((value) => normalizeWhitespace(value)).filter(Boolean);

  if (details.length === 0) {
    return base;
  }

  const merged = truncateText(details.join(' | '), 1000);
  if (!merged || base.includes(merged)) {
    return base;
  }
  return `${base}: ${merged}`;
}

function compactStrings(values) {
  return safeArray(values).map((value) => normalizeWhitespace(value)).filter(Boolean);
}

function normalizeAgentProvider(value, fallback = 'codex') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'codex' || normalized === 'claude') {
    return normalized;
  }
  return fallback;
}

function toInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.trunc(parsed);
}

function buildExecutionProgress({
  phase,
  label,
  currentStep = 0,
  totalSteps = CODE_EXECUTION_TOTAL_STEPS,
  reviewRound = 0,
  reviewTotalRounds = CODE_REVIEW_ROUNDS
} = {}) {
  const normalizedTotalSteps = Math.max(1, toInteger(totalSteps, CODE_EXECUTION_TOTAL_STEPS));
  const normalizedCurrentStep = Math.max(0, Math.min(normalizedTotalSteps, toInteger(currentStep, 0)));
  const normalizedReviewTotalRounds = Math.max(1, toInteger(reviewTotalRounds, CODE_REVIEW_ROUNDS));
  const normalizedReviewRound = Math.max(0, Math.min(normalizedReviewTotalRounds, toInteger(reviewRound, 0)));
  return {
    phase: normalizeWhitespace(phase) || 'unknown',
    label: normalizeWhitespace(label),
    currentStep: normalizedCurrentStep,
    totalSteps: normalizedTotalSteps,
    percent: Math.round((normalizedCurrentStep / normalizedTotalSteps) * 100),
    reviewRound: normalizedReviewRound,
    reviewTotalRounds: normalizedReviewTotalRounds
  };
}

function reviewArtifactData(round, review) {
  return {
    round,
    summary: review.summary,
    approval: review.approval,
    residualRisks: compactStrings(review.residualRisks),
    findings: safeArray(review.findings).map((finding) => ({
      id: normalizeWhitespace(finding.id),
      severity: normalizeWhitespace(finding.severity),
      category: normalizeWhitespace(finding.category),
      title: normalizeWhitespace(finding.title),
      description: normalizeWhitespace(finding.description),
      fileRefs: compactStrings(finding.fileRefs),
      suggestedFix: normalizeWhitespace(finding.suggestedFix),
      mustFix: Boolean(finding.mustFix)
    }))
  };
}

function patchArtifactData(round, patch, commitSummary) {
  return {
    round,
    summary: patch.summary,
    resolvedFindings: compactStrings(patch.resolvedFindingIds),
    declinedFindings: compactStrings(patch.declinedFindingIds),
    testsRun: compactStrings(patch.testsRun),
    notes: compactStrings(patch.notes),
    newCommits: commitSummary
  };
}

export function createCodeExecutionDomain({
  config,
  repo,
  workspaceRunner,
  githubClient,
  codexCliRunner,
  claudeCliRunner,
  codeTaskPlanner
}) {
  const activeRuns = new Set();
  const agentCliRunners = {
    codex: codexCliRunner || null,
    claude: claudeCliRunner || null
  };

  function defaultAgentProvider() {
    return normalizeAgentProvider(config.agent?.defaultProvider || 'codex');
  }

  function resolveAgentProvider(inputProvider) {
    const preferred = normalizeAgentProvider(inputProvider, defaultAgentProvider());
    if (agentCliRunners[preferred]) {
      return preferred;
    }

    if (agentCliRunners.codex) {
      return 'codex';
    }

    if (agentCliRunners.claude) {
      return 'claude';
    }

    throw new Error('사용 가능한 코드 실행 에이전트가 없습니다');
  }

  function getAgentRunner(provider) {
    const resolved = resolveAgentProvider(provider);
    const runner = agentCliRunners[resolved];
    if (!runner) {
      throw new Error(`지원하지 않는 에이전트입니다: ${resolved}`);
    }
    return {
      provider: resolved,
      runner
    };
  }

  async function getAvailableAgentRunner(provider, workdir) {
    const preferred = getAgentRunner(provider);
    try {
      await preferred.runner.assertAvailable(workdir);
      return preferred;
    } catch (preferredError) {
      const fallbackProvider = preferred.provider === 'claude' ? 'codex' : 'claude';
      const fallbackRunner = agentCliRunners[fallbackProvider];
      if (!fallbackRunner) {
        throw preferredError;
      }

      try {
        await fallbackRunner.assertAvailable(workdir);
        return {
          provider: fallbackProvider,
          runner: fallbackRunner
        };
      } catch {
        throw preferredError;
      }
    }
  }

  function listProjects() {
    const root = config.workspace.projectsRoot;
    if (!root || !fs.existsSync(root)) {
      return [];
    }

    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => {
        const projectPath = path.join(root, entry.name);
        let allowed = false;
        try {
          workspaceRunner.assertAllowed(projectPath);
          allowed = true;
        } catch {
          allowed = false;
        }

        return {
          id: entry.name,
          name: entry.name,
          path: projectPath,
          git: fs.existsSync(path.join(projectPath, '.git')),
          allowed
        };
      })
      .filter((project) => project.git && project.allowed)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  function resolveProjectInput(input) {
    const projectId = normalizeWhitespace(input.projectId);
    if (projectId) {
      const project = listProjects().find((candidate) => candidate.id === projectId);
      if (!project) {
        throw new Error(`알 수 없는 프로젝트입니다: ${projectId}`);
      }

      return project;
    }

    const workdir = normalizeWhitespace(input.workdir);
    if (workdir) {
      return {
        id: path.basename(workdir),
        name: path.basename(workdir),
        path: workdir
      };
    }

    throw new Error('프로젝트가 필요합니다');
  }

  async function runGit(workdir, args) {
    const result = await workspaceRunner.run('git', args, { workdir });
    return result.stdout.trim();
  }

  async function listWorkspaceFiles(workdir) {
    try {
      const result = await workspaceRunner.run('rg', ['--files'], { workdir });
      return result.stdout.split(/\r?\n/).filter(Boolean).slice(0, 200);
    } catch {
      const result = await workspaceRunner.run('git', ['ls-files'], { workdir });
      return result.stdout.split(/\r?\n/).filter(Boolean).slice(0, 200);
    }
  }

  async function inspectWorkspace(workdir, requestedBaseBranch = '') {
    const absoluteWorkdir = workspaceRunner.assertAllowed(workdir);
    const root = await runGit(absoluteWorkdir, ['rev-parse', '--show-toplevel']);
    const currentBranch = await runGit(root, ['branch', '--show-current']);
    const baseBranch = normalizeWhitespace(requestedBaseBranch || currentBranch || 'main');
    await runGit(root, ['rev-parse', '--verify', baseBranch]);

    let remoteUrl = '';
    try {
      remoteUrl = await runGit(root, ['remote', 'get-url', 'origin']);
    } catch {
      remoteUrl = '';
    }

    const parsedRemote = parseRemoteUrl(remoteUrl);
    if (config.github.repositories.length > 0 && parsedRemote.name && !config.github.repositories.includes(parsedRemote.name)) {
      throw new Error(`저장소가 GITHUB_REPOSITORIES 허용 목록에 없습니다: ${parsedRemote.name}`);
    }

    const statusOutput = await runGit(root, ['status', '--porcelain']);
    const scripts = readScripts(root);
    const fileSample = await listWorkspaceFiles(root);

    return {
      git: {
        root,
        currentBranch: currentBranch || baseBranch,
        baseBranch,
        remoteUrl,
        owner: parsedRemote.owner,
        name: parsedRemote.name,
        repoSlug: parsedRemote.repoSlug,
        isDirty: Boolean(statusOutput.trim()),
        statusLines: statusOutput.split(/\r?\n/).filter(Boolean)
      },
      scripts,
      recommendedChecks: recommendedChecksFromScripts(scripts),
      fileSample
    };
  }

  async function assertCleanWorktree(workdir, message) {
    const status = await runGit(workdir, ['status', '--porcelain']);
    if (status.trim()) {
      throw new Error(message || '저장소 작업 트리가 깨끗해야 합니다');
    }
  }

  async function statusLinesForWorktree(workdir) {
    const status = await runGit(workdir, ['status', '--porcelain']);
    return status.split(/\r?\n/).filter(Boolean);
  }

  async function autoCommitWorktreeIfDirty(taskId, workdir, {
    action,
    phase,
    commitMessage,
    dirtyErrorMessage
  }) {
    const beforeStatusLines = await statusLinesForWorktree(workdir);
    if (beforeStatusLines.length === 0) {
      return {
        autoCommitted: false
      };
    }

    try {
      await runGit(workdir, ['add', '-A']);
      const stagedFilesOutput = await runGit(workdir, ['diff', '--cached', '--name-only']);
      const stagedFiles = stagedFilesOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (stagedFiles.length === 0) {
        throw new Error('변경 파일을 자동 커밋 대상으로 스테이징하지 못했습니다');
      }

      await runGit(workdir, ['commit', '--no-verify', '-m', commitMessage]);
      const commitSha = await runGit(workdir, ['rev-parse', '--short', 'HEAD']);
      const afterStatusLines = await statusLinesForWorktree(workdir);
      if (afterStatusLines.length > 0) {
        throw new Error(`${dirtyErrorMessage}: ${afterStatusLines.join(' | ')}`);
      }

      repo.logExecution(taskId, action, 'success', {
        response: {
          phase,
          commitMessage,
          commitSha: commitSha.trim(),
          stagedFiles,
          statusLinesBefore: beforeStatusLines
        }
      });

      return {
        autoCommitted: true,
        commitSha: commitSha.trim(),
        stagedFiles
      };
    } catch (error) {
      throw new Error(`${dirtyErrorMessage}: ${formatExecutionError(error)}`);
    }
  }

  async function ensureBranch(task, workspace) {
    const currentTask = repo.getTask(task.id);
    const existingBranch = normalizeWhitespace(currentTask.payload?.branchName);
    if (existingBranch) {
      await runGit(workspace.git.root, ['checkout', existingBranch]);
      return existingBranch;
    }

    if (workspace.git.isDirty) {
      throw new Error(buildDirtyWorkspaceError(workspace.git.statusLines));
    }

    const branchName = `doppelganger/${slugify(currentTask.payload?.command)}-${Date.now().toString(36)}`;
    await runGit(workspace.git.root, ['checkout', '-b', branchName, workspace.git.baseBranch]);
    repo.updateTask(task.id, {
      payload: {
        ...currentTask.payload,
        branchName
      }
    });
    return branchName;
  }

  async function listCommitsSince(workdir, baseBranch) {
    const result = await runGit(workdir, ['log', '--reverse', '--format=%H%x1f%s', `${baseBranch}..HEAD`]);
    return result
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [sha, subject] = line.split('\x1f');
        return {
          sha,
          subject
        };
      });
  }

  async function listCommitSubjects(workdir, baseBranch, previousCount = 0) {
    const commits = await listCommitsSince(workdir, baseBranch);
    return commits.slice(previousCount).map((commit) => `${commit.subject} (${commit.sha.slice(0, 7)})`);
  }

  function latestArtifactMetadata(taskId, type) {
    const latest = repo.listArtifacts(taskId, type).at(-1);
    const metadata = latest?.metadata;
    if (!metadata || typeof metadata !== 'object') {
      return null;
    }
    return metadata;
  }

  function loadStoredPlans(taskId, task) {
    return {
      promptPlan: task?.result?.promptPlan || latestArtifactMetadata(taskId, 'prompt_plan'),
      productPlan: latestArtifactMetadata(taskId, 'product_plan'),
      designSpec: latestArtifactMetadata(taskId, 'design_spec')
    };
  }

  function resolveResumeStartStep(task, plans, resumeFromCheckpoint) {
    if (!resumeFromCheckpoint) {
      return 1;
    }

    const result = task?.result && typeof task.result === 'object' ? task.result : {};
    const progress = result.executionProgress && typeof result.executionProgress === 'object'
      ? result.executionProgress
      : {};
    const phase = normalizeWhitespace(progress.phase).toLowerCase();
    const currentStep = Math.max(0, toInteger(progress.currentStep, 0));
    const reviewRoundsCount = safeArray(result.reviewRounds).length;
    const hasPromptPlan = Boolean(plans.promptPlan);

    if (phase === 'pr_draft' || currentStep >= CODE_EXECUTION_TOTAL_STEPS - 1) {
      return 7;
    }
    if (phase === 'review' || currentStep >= 4 || reviewRoundsCount > 0) {
      return 4;
    }
    if ((phase === 'coding' || currentStep >= 3) && hasPromptPlan) {
      return 3;
    }
    if (phase === 'planning' || currentStep >= 2) {
      return 2;
    }

    return 1;
  }

  function storeArtifact(taskId, type, title, data) {
    const sortOrder = repo.listArtifacts(taskId, type).length;
    repo.createArtifact(taskId, type, {
      title,
      content: renderArtifactContent(title, data),
      sortOrder,
      metadata: data
    });
  }

  function updateTaskProgress(taskId, summary, resultPatch = {}) {
    const task = repo.getTask(taskId);
    repo.updateTask(taskId, {
      status: 'running',
      approvalState: 'pending',
      summary,
      result: {
        ...(task.result || {}),
        ...resultPatch
      },
      lastError: null
    });
  }

  function updateExecutionProgress(taskId, summary, progress, resultPatch = {}) {
    updateTaskProgress(taskId, summary, {
      ...resultPatch,
      executionProgress: buildExecutionProgress(progress)
    });
  }

  async function createTask(input) {
    const command = normalizeWhitespace(input.command);
    const project = resolveProjectInput(input);
    if (!command) {
      throw new Error('작업 지시가 필요합니다');
    }

    const workspace = await inspectWorkspace(project.path, input.baseBranch);
    const selectedAgent = await getAvailableAgentRunner(input.agentProvider, workspace.git.root);

    const task = repo.upsertTask({
      domain: 'code_execution',
      kind: 'implementation',
      title: `[코드] ${truncateText(command, 90)}`,
      status: 'new',
      approvalState: 'pending',
      payload: {
        command,
        projectId: project.id,
        projectName: project.name,
        workdir: workspace.git.root,
        baseBranch: workspace.git.baseBranch,
        repoOwner: workspace.git.owner,
        repoName: workspace.git.name,
        repoSlug: workspace.git.repoSlug,
        remoteUrl: workspace.git.remoteUrl,
        agentProvider: selectedAgent.provider,
        needsPlanning: parseBoolean(input.needsPlanning),
        needsDesign: parseBoolean(input.needsDesign),
        branchName: ''
      },
      result: {
        executionProgress: buildExecutionProgress({
          phase: 'queued',
          label: '작업 시작 대기',
          currentStep: 0
        })
      },
      sourceUrl: workspace.git.remoteUrl || null,
      summary: `${workspace.git.repoSlug || path.basename(workspace.git.root)}에서 실행 대기 중입니다`
    });

    storeArtifact(task.id, 'workspace_snapshot', '작업공간 스냅샷', {
      root: workspace.git.root,
      repoSlug: workspace.git.repoSlug,
      baseBranch: workspace.git.baseBranch,
      currentBranch: workspace.git.currentBranch,
      remoteUrl: workspace.git.remoteUrl,
      recommendedChecks: workspace.recommendedChecks,
      scripts: workspace.scripts,
      statusLines: workspace.git.statusLines,
      fileSample: workspace.fileSample.slice(0, 40)
    });

    repo.logExecution(task.id, 'create_code_task', 'success', {
      request: {
        command,
        projectId: project.id,
        workdir: workspace.git.root
      },
      response: {
        repoSlug: workspace.git.repoSlug,
        baseBranch: workspace.git.baseBranch,
        agentProvider: selectedAgent.provider
      }
    });

    return task;
  }

  async function runPromptPlanning(task, workspace) {
    const promptPlan = await codeTaskPlanner.createPromptPlan({ task, workspace });
    storeArtifact(task.id, 'prompt_plan', '프롬프트 계획', promptPlan);
    repo.logExecution(task.id, 'generate_prompt', 'success', {
      response: promptPlan
    });

    let productPlan = null;
    if (task.payload?.needsPlanning) {
      productPlan = await codeTaskPlanner.createProductPlan({ task, promptPlan, workspace });
      storeArtifact(task.id, 'product_plan', '기획안', productPlan);
      repo.logExecution(task.id, 'run_planning_agent', 'success', {
        response: productPlan
      });
    }

    let designSpec = null;
    if (task.payload?.needsDesign) {
      designSpec = await codeTaskPlanner.createDesignSpec({ task, promptPlan, workspace });
      storeArtifact(task.id, 'design_spec', '디자인 명세', designSpec);
      repo.logExecution(task.id, 'run_design_agent', 'success', {
        response: designSpec
      });
    }

    return {
      promptPlan,
      productPlan,
      designSpec
    };
  }

  async function runCodingRound(task, workspace, plans) {
    const agent = getAgentRunner(task.payload?.agentProvider);
    const prompt = buildCodingPrompt({
      task,
      workspace,
      promptPlan: plans.promptPlan,
      productPlan: plans.productPlan,
      designSpec: plans.designSpec
    });
    storeArtifact(task.id, 'coding_prompt', '코딩 프롬프트', {
      branchName: task.payload?.branchName,
      prompt
    });

    const responseWithProvider = await agent.runner.runExec({
      workdir: workspace.git.root,
      prompt,
      sandboxMode: 'workspace-write',
      schema: codingAgentSchema
    });
    const autoCommitResult = await autoCommitWorktreeIfDirty(task.id, workspace.git.root, {
      action: 'auto_commit_coding_changes',
      phase: 'coding',
      commitMessage: 'chore: auto-commit coding agent workspace changes',
      dirtyErrorMessage: '코딩 에이전트가 작업 트리에 커밋되지 않은 변경을 남겼습니다'
    });
    await assertCleanWorktree(workspace.git.root, '코딩 에이전트가 작업 트리에 커밋되지 않은 변경을 남겼습니다');

    repo.logExecution(task.id, 'run_coding_agent', 'success', {
      response: {
        ...responseWithProvider.parsed,
        agentProvider: agent.provider,
        autoCommit: autoCommitResult,
        stdout: responseWithProvider.stdout,
        stderr: responseWithProvider.stderr,
        durationMs: responseWithProvider.durationMs
      }
    });

    return responseWithProvider.parsed;
  }

  async function runReviewLoop(taskId, workspace, plans, { existingReviewRounds = [] } = {}) {
    const reviewRounds = safeArray(existingReviewRounds).map((round) => ({ ...round }));
    let previousCommitCount = (await listCommitsSince(workspace.git.root, workspace.git.baseBranch)).length;

    for (let round = reviewRounds.length + 1; round <= CODE_REVIEW_ROUNDS; round += 1) {
      const currentTask = repo.getTask(taskId);
      updateExecutionProgress(taskId, `리뷰 라운드 ${round}/${CODE_REVIEW_ROUNDS} 실행 중`, {
        phase: 'review',
        label: `리뷰/수정 라운드 ${round}/${CODE_REVIEW_ROUNDS}`,
        currentStep: 3 + round,
        reviewRound: round
      }, {
        reviewRounds
      });

      const reviewPrompt = buildReviewPrompt({
        task: currentTask,
        workspace,
        promptPlan: plans.promptPlan,
        productPlan: plans.productPlan,
        designSpec: plans.designSpec,
        round
      });

      const agent = getAgentRunner(currentTask.payload?.agentProvider);
      const reviewResponse = await agent.runner.runExec({
        workdir: workspace.git.root,
        prompt: reviewPrompt,
        sandboxMode: 'read-only',
        schema: reviewAgentSchema
      });

      const reviewData = reviewArtifactData(round, reviewResponse.parsed);
      storeArtifact(taskId, 'review_round', `리뷰 라운드 ${round}`, reviewData);
      repo.logExecution(taskId, 'run_review_agent', 'success', {
        response: {
          ...reviewData,
          agentProvider: agent.provider,
          stdout: reviewResponse.stdout,
          stderr: reviewResponse.stderr,
          durationMs: reviewResponse.durationMs
        }
      });

      let patchData = {
        round,
        summary: '이번 라운드에서는 수정이 필요하지 않았습니다.',
        resolvedFindings: [],
        declinedFindings: [],
        testsRun: [],
        notes: [],
        newCommits: []
      };

      if (reviewData.findings.length > 0) {
        const patchPrompt = buildPatchPrompt({
          task: currentTask,
          workspace,
          reviewRound: reviewData,
          round
        });

        const patchResponse = await agent.runner.runExec({
          workdir: workspace.git.root,
          prompt: patchPrompt,
          sandboxMode: 'workspace-write',
          schema: patchAgentSchema
        });
        const autoCommitResult = await autoCommitWorktreeIfDirty(taskId, workspace.git.root, {
          action: 'auto_commit_patch_changes',
          phase: 'patch',
          commitMessage: `fix: auto-commit patch round ${round} changes`,
          dirtyErrorMessage: `패치 라운드 ${round}에서 커밋되지 않은 변경이 남았습니다`
        });
        await assertCleanWorktree(workspace.git.root, `패치 라운드 ${round}에서 커밋되지 않은 변경이 남았습니다`);
        const newCommits = await listCommitSubjects(workspace.git.root, workspace.git.baseBranch, previousCommitCount);
        patchData = patchArtifactData(round, patchResponse.parsed, newCommits);
        storeArtifact(taskId, 'patch_round', `패치 라운드 ${round}`, patchData);
        repo.logExecution(taskId, 'apply_review_fixes', 'success', {
          response: {
            ...patchData,
            agentProvider: agent.provider,
            autoCommit: autoCommitResult,
            stdout: patchResponse.stdout,
            stderr: patchResponse.stderr,
            durationMs: patchResponse.durationMs
          }
        });
      } else {
        storeArtifact(taskId, 'patch_round', `패치 라운드 ${round}`, patchData);
        repo.logExecution(taskId, 'apply_review_fixes', 'success', {
          response: patchData
        });
      }

      previousCommitCount = (await listCommitsSince(workspace.git.root, workspace.git.baseBranch)).length;
      reviewRounds.push({
        round,
        review: reviewData,
        patch: patchData
      });
    }

    return reviewRounds;
  }

  async function runTask(taskId, options = {}) {
    const resumeFromCheckpoint = Boolean(options.resumeFromCheckpoint);
    if (activeRuns.has(taskId)) {
      return { started: false };
    }

    activeRuns.add(taskId);

    const runPromise = (async () => {
      const task = repo.getTask(taskId);
      if (!task || task.domain !== 'code_execution') {
        throw new Error(`작업을 찾을 수 없습니다: ${taskId}`);
      }

      const initialPlans = loadStoredPlans(taskId, task);
      const resumeStartStep = resolveResumeStartStep(task, initialPlans, resumeFromCheckpoint);
      const resumeApplied = resumeFromCheckpoint && resumeStartStep > 1;

      if (resumeApplied) {
        updateExecutionProgress(taskId, `${resumeStartStep}단계부터 작업을 재개하는 중입니다`, {
          phase: 'resume',
          label: `${resumeStartStep}단계부터 재개`,
          currentStep: Math.max(1, resumeStartStep - 1)
        });
        repo.logExecution(taskId, 'resume_from_checkpoint', 'success', {
          response: {
            resumeStartStep
          }
        });
      } else {
        updateExecutionProgress(taskId, '작업 환경을 점검하고 브랜치를 준비하는 중입니다', {
          phase: 'workspace',
          label: '작업 환경 점검 및 브랜치 준비',
          currentStep: 1
        });
      }

      const workspace = await inspectWorkspace(task.payload?.workdir, task.payload?.baseBranch);
      const branchName = await ensureBranch(task, workspace);

      let plans = loadStoredPlans(taskId, repo.getTask(taskId));
      if (resumeStartStep <= 2 || !plans.promptPlan) {
        updateExecutionProgress(taskId, '프롬프트 계획을 만들고 코딩 워크플로를 준비하는 중입니다', {
          phase: 'planning',
          label: '프롬프트/기획/디자인 계획 생성',
          currentStep: 2
        }, {
          branch: branchName,
          baseBranch: workspace.git.baseBranch
        });

        const latestTask = repo.getTask(taskId);
        plans = await runPromptPlanning(latestTask, workspace);
      } else {
        updateTaskProgress(taskId, `${resumeStartStep}단계 재개 준비가 완료되었습니다`, {
          branch: branchName,
          baseBranch: workspace.git.baseBranch,
          promptPlan: plans.promptPlan
        });
      }

      let codingSummary = normalizeWhitespace(repo.getTask(taskId)?.result?.codingSummary);
      if (resumeStartStep <= 3) {
        updateExecutionProgress(taskId, '코딩 에이전트를 실행하는 중입니다', {
          phase: 'coding',
          label: '코딩 에이전트 실행',
          currentStep: 3
        }, {
          promptPlan: plans.promptPlan
        });

        const codingResult = await runCodingRound(repo.getTask(taskId), workspace, plans);
        codingSummary = normalizeWhitespace(codingResult.summary);
        updateTaskProgress(taskId, '코딩 결과를 정리하는 중입니다', {
          codingSummary: codingSummary || null
        });
      }

      const existingReviewRounds = resumeStartStep >= 4
        ? safeArray(repo.getTask(taskId)?.result?.reviewRounds)
        : [];
      const reviewRounds = existingReviewRounds.length >= CODE_REVIEW_ROUNDS
        ? existingReviewRounds
        : await runReviewLoop(taskId, workspace, plans, {
            existingReviewRounds
          });
      const commits = await listCommitsSince(workspace.git.root, workspace.git.baseBranch);
      const commitSummary = commits.map((commit) => `${commit.subject} (${commit.sha.slice(0, 7)})`);
      updateExecutionProgress(taskId, 'PR 초안을 준비하는 중입니다', {
        phase: 'pr_draft',
        label: 'PR 초안 정리',
        currentStep: CODE_EXECUTION_TOTAL_STEPS - 1
      }, {
        codingSummary: codingSummary || '이전 실행의 코딩 결과를 재사용했습니다.',
        commits,
        reviewRounds
      });
      const pullRequest = await codeTaskPlanner.createPullRequestDraft({
        task: repo.getTask(taskId),
        workspace,
        reviewRounds,
        commitSummary
      });
      storeArtifact(taskId, 'pr_summary', 'PR 초안', pullRequest);
      repo.logExecution(taskId, 'prepare_pr', 'success', {
        response: pullRequest
      });

      repo.updateTask(taskId, {
        status: 'awaiting_approval',
        approvalState: 'pending',
        summary: `${branchName} 브랜치에서 구현을 마쳤습니다. PR 생성 준비가 되었습니다.`,
        result: {
          branch: branchName,
          baseBranch: workspace.git.baseBranch,
          repoSlug: workspace.git.repoSlug,
          promptPlan: plans.promptPlan,
          codingSummary: codingSummary || '이전 실행의 코딩 결과를 재사용했습니다.',
          commits,
          reviewRounds,
          pullRequest,
          executionProgress: buildExecutionProgress({
            phase: 'completed',
            label: '코드 작업 완료',
            currentStep: CODE_EXECUTION_TOTAL_STEPS,
            reviewRound: CODE_REVIEW_ROUNDS
          })
        },
        lastError: null
      });
    })();

    runPromise.catch((error) => {
      const formattedError = formatExecutionError(error);
      const currentTask = repo.getTask(taskId);
      const currentResult = currentTask?.result && typeof currentTask.result === 'object'
        ? currentTask.result
        : {};
      const previousProgress = currentResult.executionProgress && typeof currentResult.executionProgress === 'object'
        ? currentResult.executionProgress
        : {};
      repo.updateTask(taskId, {
        status: 'failed',
        summary: '코드 작업 실행 중 오류가 발생했습니다. 오류를 확인한 뒤 다시 실행해 주세요.',
        result: {
          ...currentResult,
          executionProgress: buildExecutionProgress({
            phase: 'failed',
            label: '코드 작업 실행 중 오류가 발생했습니다.',
            currentStep: previousProgress.currentStep,
            totalSteps: previousProgress.totalSteps,
            reviewRound: previousProgress.reviewRound,
            reviewTotalRounds: previousProgress.reviewTotalRounds
          })
        },
        lastError: formattedError
      });
      repo.logExecution(taskId, 'run_code_execution', 'failed', {
        error: formattedError
      });
    }).finally(() => {
      activeRuns.delete(taskId);
    });

    return { started: true };
  }

  async function createPullRequest(taskId) {
    if (activeRuns.has(taskId)) {
      throw new Error('작업이 아직 실행 중입니다');
    }

    const task = repo.getTask(taskId);
    if (!task || task.domain !== 'code_execution') {
      throw new Error(`작업을 찾을 수 없습니다: ${taskId}`);
    }

    const branch = normalizeWhitespace(task.result?.branch || task.payload?.branchName);
    if (!branch) {
      throw new Error('이 작업에 기록된 작업 브랜치가 없습니다');
    }

    const workspace = await inspectWorkspace(task.payload?.workdir, task.payload?.baseBranch);
    await runGit(workspace.git.root, ['checkout', branch]);
    await assertCleanWorktree(workspace.git.root, 'PR 생성 전에 작업 트리가 깨끗해야 합니다');
    await runGit(workspace.git.root, ['push', '-u', 'origin', branch]);

    const pullRequestDraft = task.result?.pullRequest || buildPullRequestDraft({
      task,
      workspace,
      reviewRounds: task.result?.reviewRounds || [],
      commitSummary: safeArray(task.result?.commits).map((commit) => `${commit.subject} (${commit.sha.slice(0, 7)})`)
    });
    const owner = task.payload?.repoOwner || workspace.git.owner || config.github.owner;
    const repoName = task.payload?.repoName || workspace.git.name;
    if (!owner || !repoName) {
      throw new Error('PR 생성을 위한 GitHub 저장소 정보를 확인할 수 없습니다');
    }

    const prResponse = await githubClient.createPullRequest({
      owner,
      repo: repoName,
      head: branch,
      base: task.result?.baseBranch || workspace.git.baseBranch,
      title: pullRequestDraft.title,
      body: pullRequestDraft.body
    });

    repo.updateTask(taskId, {
      status: 'done',
      approvalState: 'approved',
      summary: `PR을 생성했습니다: #${prResponse.number}`,
      result: {
        ...(task.result || {}),
        pullRequest: {
          ...pullRequestDraft,
          number: prResponse.number,
          url: prResponse.html_url
        }
      },
      lastError: null
    });
    repo.logExecution(taskId, 'create_pr', 'success', {
      response: prResponse
    });

    return repo.getTask(taskId);
  }

  return {
    id: 'code_execution',
    label: '코드 작업',
    implemented: true,
    capabilities: {
      polling: false,
      drafting: false,
      execution: true
    },
    listProjects,
    createTask,
    start: runTask,
    createPullRequest
  };
}
