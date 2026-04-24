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
} from '../modules/code-execution/code-task-prompts.ts';
import { normalizeWhitespace, safeArray, truncateText } from '../core/utils.ts';

const CODE_REVIEW_ROUNDS = 1;
const CODE_EXECUTION_TOTAL_STEPS = CODE_REVIEW_ROUNDS + 5;
const PLAN_MODE_TOTAL_STEPS = 3;
const CONTINUATION_ALLOWED_STATUSES = new Set(['done', 'awaiting_approval', 'failed']);

interface ExecutionProgressInput {
  phase?: string;
  label?: string;
  currentStep?: number;
  totalSteps?: number;
  reviewRound?: number;
  reviewTotalRounds?: number;
}

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

function asRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function normalizeTaskStatus(value) {
  return normalizeWhitespace(value).toLowerCase();
}

function normalizeExecutionMode(value, fallback = 'full') {
  const normalized = normalizeWhitespace(value).toLowerCase();
  if (normalized === 'plan' || normalized === 'plan_only') {
    return 'plan';
  }
  if (normalized === 'full') {
    return 'full';
  }
  return fallback;
}

function normalizeIdentifier(value, fallback = '') {
  const normalized = normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

function normalizeConfirmationRequestList(value) {
  return safeArray(value).map((entry, index) => {
    const source = asRecord(entry);
    const requestId = normalizeIdentifier(source.id, `confirm_${index + 1}`);
    const options = safeArray(source.options).map((option, optionIndex) => {
      const optionSource = asRecord(option);
      return {
        id: normalizeIdentifier(optionSource.id, `${requestId}_option_${optionIndex + 1}`),
        label: normalizeWhitespace(optionSource.label) || `옵션 ${optionIndex + 1}`,
        description: normalizeWhitespace(optionSource.description),
        recommended: Boolean(optionSource.recommended)
      };
    }).filter((option) => option.id);

    if (options.length === 0) {
      options.push({
        id: `${requestId}_default`,
        label: '기본안',
        description: '기본 권장안으로 진행합니다.',
        recommended: true
      });
    }
    if (!options.some((option) => option.recommended)) {
      options[0].recommended = true;
    }

    return {
      id: requestId,
      title: normalizeWhitespace(source.title) || `확인 항목 ${index + 1}`,
      question: normalizeWhitespace(source.question) || '작업 진행 전에 선택이 필요합니다.',
      options
    };
  }).filter((request) => request.id);
}

function parsePlanSelections(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return Object.entries(value).reduce((accumulator, [key, optionId]) => {
    const requestId = normalizeIdentifier(key);
    const normalizedOptionId = normalizeIdentifier(optionId);
    if (!requestId || !normalizedOptionId) {
      return accumulator;
    }
    accumulator[requestId] = normalizedOptionId;
    return accumulator;
  }, {} as Record<string, string>);
}

function normalizePlanSelectionsForRequests(selections, requests) {
  const safeSelections = parsePlanSelections(selections);
  return safeArray(requests).reduce((accumulator, request) => {
    const requestId = normalizeIdentifier(request?.id);
    if (!requestId) {
      return accumulator;
    }

    const selectedOptionId = normalizeIdentifier(safeSelections[requestId]);
    const hasOption = safeArray(request?.options).some((option) => normalizeIdentifier(option?.id) === selectedOptionId);
    if (!selectedOptionId || !hasOption) {
      return accumulator;
    }

    accumulator[requestId] = selectedOptionId;
    return accumulator;
  }, {} as Record<string, string>);
}

function unresolvedPlanRequestIds(requests, selections) {
  return safeArray(requests).map((request) => normalizeIdentifier(request?.id)).filter((requestId) => {
    if (!requestId) {
      return false;
    }
    return !normalizeIdentifier(selections[requestId]);
  });
}

function resolvePromptPlanConfirmationRequests(promptPlan, fallback = []) {
  const promptPlanRecord = asRecord(promptPlan);
  const fromPrompt = normalizeConfirmationRequestList(promptPlanRecord.confirmationRequests);
  if (fromPrompt.length > 0) {
    return fromPrompt;
  }
  return normalizeConfirmationRequestList(fallback);
}

function compactCommitSummaries(commits) {
  return safeArray(commits).map((entry) => {
    const record = asRecord(entry);
    const subject = normalizeWhitespace(record.subject || entry);
    const sha = normalizeWhitespace(record.sha);
    if (!subject) {
      return '';
    }
    return sha ? `${subject} (${sha.slice(0, 7)})` : subject;
  }).filter(Boolean).slice(0, 12);
}

function compactReviewRoundSummaries(reviewRounds) {
  return safeArray(reviewRounds).map((entry, index) => {
    const record = asRecord(entry);
    const review = asRecord(record.review);
    const roundRaw = Number(record.round);
    const round = Number.isFinite(roundRaw) && roundRaw > 0 ? Math.trunc(roundRaw) : index + 1;
    const findingsCount = safeArray(review.findings || record.findings).length;
    const approval = normalizeWhitespace(review.approval || record.approval);
    const suffix = approval ? `, ${approval}` : '';
    return `round ${round}: findings ${findingsCount}${suffix}`;
  }).filter(Boolean).slice(0, 6);
}

function buildContinuationContext(previousTask) {
  const previousPayload = asRecord(previousTask.payload);
  const previousResult = asRecord(previousTask.result);
  const previousPromptPlan = asRecord(previousResult.promptPlan);
  const parentTaskId = normalizeWhitespace(previousTask.id);
  const rootTaskId = normalizeWhitespace(previousPayload.rootTaskId || parentTaskId);

  return {
    continueFromTaskId: parentTaskId,
    parentTaskId,
    rootTaskId,
    previousStatus: normalizeTaskStatus(previousTask.status),
    previousTitle: normalizeWhitespace(previousTask.title),
    previousCommand: normalizeWhitespace(previousPayload.command || previousTask.title),
    previousSummary: normalizeWhitespace(previousTask.summary),
    previousBaseBranch: normalizeWhitespace(previousPayload.baseBranch || previousResult.baseBranch),
    previousBranch: normalizeWhitespace(previousResult.branch || previousPayload.branchName),
    previousPromptPlanSummary: normalizeWhitespace(previousPromptPlan.summary),
    previousCommits: compactCommitSummaries(previousResult.commits),
    previousReview: compactReviewRoundSummaries(previousResult.reviewRounds)
  };
}

function toSimpleSummary(value) {
  const normalized = normalizeWhitespace(value);
  const withoutConventionalPrefix = normalized.replace(/^[a-z]+(?:\([^)]+\))?(?:!)?:\s*/i, '');
  const withoutBracketPrefix = withoutConventionalPrefix.replace(/^(?:\[[^\]]+\]\s*)+/, '');
  return truncateText(withoutBracketPrefix || withoutConventionalPrefix || normalized || '작업 변경사항 반영', 72);
}

function isGitHubUnprocessableError(error) {
  if (Number(error?.status) === 422) {
    return true;
  }
  return /unprocessable entity|validation failed/i.test(String(error?.message || ''));
}

function extractGitHubValidationDetails(error) {
  const payload = error?.payload && typeof error.payload === 'object'
    ? error.payload
    : {};
  const detailMessages = safeArray(payload.errors)
    .map((entry) => {
      if (typeof entry === 'string') {
        return normalizeWhitespace(entry);
      }

      if (!entry || typeof entry !== 'object') {
        return '';
      }

      const directMessage = normalizeWhitespace(entry.message);
      if (directMessage) {
        return directMessage;
      }

      const parts = [
        normalizeWhitespace(entry.resource),
        normalizeWhitespace(entry.field),
        normalizeWhitespace(entry.code)
      ].filter(Boolean);
      return parts.join('/');
    })
    .filter(Boolean);

  if (detailMessages.length === 0) {
    return '';
  }

  return truncateText(detailMessages.join(' | '), 700);
}

function isAlreadyExistsPullRequestError(error) {
  if (!isGitHubUnprocessableError(error)) {
    return false;
  }

  const merged = [
    normalizeWhitespace(error?.message),
    extractGitHubValidationDetails(error)
  ].filter(Boolean).join(' | ').toLowerCase();
  return merged.includes('pull request') && merged.includes('already exists');
}

function formatPullRequestCreateError(error) {
  const base = normalizeWhitespace(error?.message || 'PR 생성에 실패했습니다');
  const details = extractGitHubValidationDetails(error);
  if (!details || base.includes(details)) {
    return base;
  }
  return `${base}: ${details}`;
}

function isNotAllRefsReadableError(error) {
  const combined = [
    normalizeWhitespace(error?.message),
    extractGitHubValidationDetails(error)
  ].filter(Boolean).join(' | ').toLowerCase();
  return combined.includes('not all refs are readable');
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
}: ExecutionProgressInput = {}) {
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
  const normalizedGitHubRepositoryAllowlist = new Set(
    compactStrings(config.github?.repositories || []).map((name) => name.toLowerCase())
  );

  function isGitHubRepositoryAllowed(repoName) {
    if (normalizedGitHubRepositoryAllowlist.size === 0) {
      return true;
    }
    const normalizedRepoName = normalizeWhitespace(repoName).toLowerCase();
    if (!normalizedRepoName) {
      return false;
    }
    return normalizedGitHubRepositoryAllowlist.has(normalizedRepoName);
  }

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

  async function gitRevisionExists(workdir, revision) {
    const normalizedRevision = normalizeWhitespace(revision);
    if (!normalizedRevision) {
      return false;
    }

    try {
      await runGit(workdir, ['rev-parse', '--verify', normalizedRevision]);
      return true;
    } catch {
      return false;
    }
  }

  async function branchRefExists(workdir, branchName) {
    const normalized = normalizeWhitespace(branchName);
    if (!normalized) {
      return false;
    }

    const candidates = [
      `refs/heads/${normalized}^{commit}`,
      `refs/remotes/origin/${normalized}^{commit}`,
      `${normalized}^{commit}`
    ];
    for (const candidate of candidates) {
      if (await gitRevisionExists(workdir, candidate)) {
        return true;
      }
    }

    return false;
  }

  async function resolveBaseBranch(workdir, requestedBaseBranch = '', currentBranch = '') {
    const requested = normalizeWhitespace(requestedBaseBranch);
    const fallbackCandidates = Array.from(new Set([
      normalizeWhitespace(currentBranch),
      'master',
      'main'
    ].filter(Boolean)));
    const candidates = requested ? [requested] : fallbackCandidates;

    for (const candidate of candidates) {
      if (await branchRefExists(workdir, candidate)) {
        return candidate;
      }
    }

    if (requested) {
      throw new Error(
        `기준 브랜치를 찾지 못했습니다: ${requested}. `
        + '기준 브랜치에는 기존 브랜치(main/master 등)를 입력하고, 새 작업 브랜치는 작업 브랜치명에 입력해 주세요.'
      );
    }

    throw new Error('기준 브랜치를 찾지 못했습니다. main/master 브랜치가 존재하는지 확인해 주세요.');
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
    const baseBranch = await resolveBaseBranch(root, requestedBaseBranch, currentBranch);

    let remoteUrl = '';
    try {
      remoteUrl = await runGit(root, ['remote', 'get-url', 'origin']);
    } catch {
      remoteUrl = '';
    }

    const parsedRemote = parseRemoteUrl(remoteUrl);

    const statusOutput = await runGit(root, ['status', '--porcelain']);
    const scripts = readScripts(root);
    const fileSample = await listWorkspaceFiles(root);
    const githubRepositoryAllowed = isGitHubRepositoryAllowed(parsedRemote.name);

    return {
      git: {
        root,
        currentBranch: currentBranch || baseBranch,
        baseBranch,
        remoteUrl,
        owner: parsedRemote.owner,
        name: parsedRemote.name,
        repoSlug: parsedRemote.repoSlug,
        githubRepositoryAllowed,
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

  async function localBranchExists(workdir, branchName) {
    const normalized = normalizeWhitespace(branchName);
    if (!normalized) {
      return false;
    }

    try {
      await runGit(workdir, ['rev-parse', '--verify', `refs/heads/${normalized}`]);
      return true;
    } catch {
      return false;
    }
  }

  async function checkoutTaskBranchFromSourceCommit(task, workspace, branchName) {
    const normalizedBranch = normalizeWhitespace(branchName);
    if (!normalizedBranch) {
      throw new Error('작업 브랜치 정보가 없습니다');
    }

    const branchExists = await localBranchExists(workspace.git.root, normalizedBranch);
    if (branchExists) {
      await runGit(workspace.git.root, ['checkout', normalizedBranch]);
      return {
        recreatedFromSourceCommit: false,
        sourceCommit: ''
      };
    }

    const sourceCommit = normalizeWhitespace(task?.result?.sourceCommit);
    if (!sourceCommit) {
      throw new Error(`작업 브랜치를 찾을 수 없습니다: ${normalizedBranch}`);
    }

    await runGit(workspace.git.root, ['checkout', '-B', normalizedBranch, sourceCommit]);
    if (task?.id) {
      repo.logExecution(task.id, 'restore_task_branch', 'success', {
        response: {
          branchName: normalizedBranch,
          sourceCommit
        }
      });
    }
    return {
      recreatedFromSourceCommit: true,
      sourceCommit
    };
  }

  async function cleanupTaskWorkspaceBranch(taskId, workspace, {
    workBranch,
    preferredRestoreBranch,
    deleteWorkBranch
  }: {
    workBranch?: string;
    preferredRestoreBranch?: string;
    deleteWorkBranch?: boolean;
  } = {}) {
    const latestTask = repo.getTask(taskId);
    const payload = latestTask?.payload && typeof latestTask.payload === 'object'
      ? latestTask.payload
      : {};
    const normalizedWorkBranch = normalizeWhitespace(workBranch || payload.branchName);
    const restoreCandidates = Array.from(new Set([
      normalizeWhitespace(preferredRestoreBranch),
      normalizeWhitespace(payload.restoreBranch),
      normalizeWhitespace(workspace.git.baseBranch)
    ].filter(Boolean)));

    let restoredBranch = normalizeWhitespace(await runGit(workspace.git.root, ['branch', '--show-current']));
    let switched = false;
    let switchError = '';

    for (const candidate of restoreCandidates) {
      if (!candidate) {
        continue;
      }
      if (candidate === restoredBranch) {
        restoredBranch = candidate;
        break;
      }

      const exists = await localBranchExists(workspace.git.root, candidate);
      if (!exists) {
        continue;
      }

      try {
        await runGit(workspace.git.root, ['checkout', candidate]);
        restoredBranch = candidate;
        switched = true;
        switchError = '';
        break;
      } catch (error) {
        switchError = formatExecutionError(error);
      }
    }

    let deleted = false;
    let deleteError = '';
    if (deleteWorkBranch && normalizedWorkBranch && restoredBranch !== normalizedWorkBranch) {
      const exists = await localBranchExists(workspace.git.root, normalizedWorkBranch);
      if (exists) {
        try {
          await runGit(workspace.git.root, ['branch', '-D', normalizedWorkBranch]);
          deleted = true;
        } catch (error) {
          deleteError = formatExecutionError(error);
        }
      }
    }

    const mergedError = [switchError, deleteError].filter(Boolean).join(' | ');
    repo.logExecution(taskId, 'cleanup_task_branch', mergedError ? 'failed' : 'success', {
      response: {
        workBranch: normalizedWorkBranch || null,
        restoreBranch: restoredBranch || null,
        switched,
        deleted
      },
      error: mergedError || null
    });

    return {
      restoreBranch: restoredBranch,
      switched,
      deleted,
      error: mergedError
    };
  }

  async function mergeTaskBranchIntoBase(taskId, workspace, {
    workBranch,
    baseBranch
  }: {
    workBranch?: string;
    baseBranch?: string;
  } = {}) {
    const normalizedWorkBranch = normalizeWhitespace(workBranch);
    const normalizedBaseBranch = normalizeWhitespace(baseBranch || workspace.git.baseBranch);
    if (!normalizedWorkBranch || !normalizedBaseBranch) {
      return {
        merged: false,
        workBranch: normalizedWorkBranch || null,
        baseBranch: normalizedBaseBranch || null,
        head: ''
      };
    }

    try {
      await assertCleanWorktree(workspace.git.root, '작업 브랜치 병합 전에 작업 트리가 깨끗해야 합니다');
      await checkoutTaskBranchFromSourceCommit(repo.getTask(taskId), workspace, normalizedWorkBranch);
      await assertCleanWorktree(workspace.git.root, '작업 브랜치 병합 전에 작업 트리가 깨끗해야 합니다');

      if (normalizedBaseBranch !== normalizedWorkBranch) {
        const baseExists = await localBranchExists(workspace.git.root, normalizedBaseBranch);
        if (!baseExists) {
          throw new Error(`기준 브랜치를 찾을 수 없습니다: ${normalizedBaseBranch}`);
        }

        await runGit(workspace.git.root, ['checkout', normalizedBaseBranch]);
        await runGit(workspace.git.root, ['merge', '--ff-only', normalizedWorkBranch]);
      }

      const head = normalizeWhitespace(await runGit(workspace.git.root, ['rev-parse', 'HEAD']));
      repo.logExecution(taskId, 'merge_task_branch', 'success', {
        response: {
          workBranch: normalizedWorkBranch,
          baseBranch: normalizedBaseBranch,
          head
        }
      });
      return {
        merged: true,
        workBranch: normalizedWorkBranch,
        baseBranch: normalizedBaseBranch,
        head
      };
    } catch (error) {
      const formattedError = formatExecutionError(error);
      repo.logExecution(taskId, 'merge_task_branch', 'failed', {
        response: {
          workBranch: normalizedWorkBranch,
          baseBranch: normalizedBaseBranch
        },
        error: formattedError
      });
      throw new Error(`기준 브랜치(${normalizedBaseBranch}) 병합에 실패했습니다: ${formattedError}`);
    }
  }

  async function ensureBranch(task, workspace) {
    const currentTask = repo.getTask(task.id);
    const existingBranch = normalizeWhitespace(currentTask.payload?.branchName);
    const requestedBranchName = normalizeWhitespace(currentTask.payload?.requestedBranchName);
    const restoreBranch = normalizeWhitespace(
      currentTask.payload?.restoreBranch || workspace.git.currentBranch || workspace.git.baseBranch
    );
    const branchManaged = Boolean(currentTask.payload?.branchManaged);
    if (existingBranch) {
      await checkoutTaskBranchFromSourceCommit(currentTask, workspace, existingBranch);
      if (!normalizeWhitespace(currentTask.payload?.restoreBranch)) {
        repo.updateTask(task.id, {
          payload: {
            ...currentTask.payload,
            restoreBranch
          }
        });
      }
      return {
        branchName: existingBranch,
        restoreBranch,
        branchManaged
      };
    }

    if (workspace.git.isDirty) {
      throw new Error(buildDirtyWorkspaceError(workspace.git.statusLines));
    }

    if (requestedBranchName && requestedBranchName === workspace.git.baseBranch) {
      throw new Error('작업 브랜치는 기준 브랜치와 다르게 입력해 주세요');
    }

    const branchName = requestedBranchName
      ? await assertBranchNameValid(workspace.git.root, requestedBranchName)
      : `doppelganger/${slugify(currentTask.payload?.command)}-${Date.now().toString(36)}`;
    const branchExists = requestedBranchName
      ? await localBranchExists(workspace.git.root, branchName)
      : false;

    if (branchExists) {
      await runGit(workspace.git.root, ['checkout', branchName]);
      repo.updateTask(task.id, {
        payload: {
          ...currentTask.payload,
          branchName,
          restoreBranch,
          branchManaged: false
        }
      });
      return {
        branchName,
        restoreBranch,
        branchManaged: false
      };
    }

    await runGit(workspace.git.root, ['checkout', '-b', branchName, workspace.git.baseBranch]);
    repo.updateTask(task.id, {
      payload: {
        ...currentTask.payload,
        branchName,
        restoreBranch,
        branchManaged: true
      }
    });
    return {
      branchName,
      restoreBranch,
      branchManaged: true
    };
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

  function buildPlanModeState({
    promptPlan,
    requestedSelections,
    fallbackRequests = []
  }: {
    promptPlan: Record<string, unknown>;
    requestedSelections: Record<string, string>;
    fallbackRequests?: Array<Record<string, unknown>>;
  }) {
    const confirmationRequests = resolvePromptPlanConfirmationRequests(promptPlan, fallbackRequests);
    const selections = normalizePlanSelectionsForRequests(requestedSelections, confirmationRequests);
    const unresolvedRequestIds = unresolvedPlanRequestIds(confirmationRequests, selections);
    return {
      confirmationRequests,
      selections,
      unresolvedRequestIds,
      status: unresolvedRequestIds.length === 0 ? 'ready_for_execution' : 'awaiting_confirmation'
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
    const reviewStartStep = 4;
    const prDraftStep = CODE_EXECUTION_TOTAL_STEPS - 1;

    if (phase === 'pr_draft' || currentStep >= prDraftStep) {
      return prDraftStep;
    }
    if (phase === 'review' || (currentStep >= reviewStartStep && currentStep < prDraftStep) || reviewRoundsCount > 0) {
      return reviewStartStep;
    }
    if ((phase === 'coding' || currentStep >= 3) && hasPromptPlan) {
      return 3;
    }
    if (phase === 'planning' || currentStep >= 2) {
      return 2;
    }

    return 1;
  }

  function resolveServicePrefix(task, workspace) {
    const candidates = [
      normalizeWhitespace(task?.payload?.repoName),
      normalizeWhitespace(workspace?.git?.name),
      normalizeWhitespace(task?.payload?.projectId),
      normalizeWhitespace(task?.payload?.projectName),
      normalizeWhitespace(task?.payload?.repoSlug)
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (/fromm/i.test(candidate)) {
        return 'FRM';
      }
    }

    for (const candidate of candidates) {
      const tail = candidate.split('/').filter(Boolean).at(-1) || '';
      const firstToken = tail.split(/[-_]/).filter(Boolean)[0] || tail;
      const prefix = firstToken.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (prefix) {
        return prefix;
      }
    }

    return 'SERVICE';
  }

  async function readPullRequestTemplate(workdir) {
    const templatePaths = [
      path.join(workdir, '.github', 'PULL_REQUEST_TEMPLATE.md'),
      path.join(workdir, '.github', 'pull_request_template.md'),
      path.join(workdir, '.github', 'PULL_REQUEST_TEMPLATE', 'pull_request_template.md')
    ];

    for (const templatePath of templatePaths) {
      if (!fs.existsSync(templatePath)) {
        continue;
      }
      return fs.readFileSync(templatePath, 'utf8');
    }

    return '';
  }

  function toBranchTitleToken(branchName) {
    const normalized = normalizeWhitespace(branchName);
    if (!normalized) {
      return 'BRANCH';
    }

    const tokens = normalized.split('/').map((token) => normalizeWhitespace(token)).filter(Boolean);
    if (tokens.length === 0) {
      return normalized;
    }

    return tokens[tokens.length - 1];
  }

  function buildPullRequestBodyFromTemplate(templateBody, generatedBody, simpleSummary) {
    const template = String(templateBody || '').trim();
    const summaryBody = String(generatedBody || '').trim() || `- ${simpleSummary}`;
    if (!template) {
      return summaryBody;
    }

    const replaced = template
      .replaceAll('{{PR_SIMPLE_SUMMARY}}', simpleSummary)
      .replaceAll('{{PR_SUMMARY}}', summaryBody)
      .replaceAll('{{DOPPELGANGER_PR_SUMMARY}}', summaryBody);
    if (replaced !== template) {
      return replaced;
    }

    return `${template}\n\n---\n\n## 자동 생성 요약\n${summaryBody}`;
  }

  async function assertBranchNameValid(workdir, branchName) {
    const normalized = normalizeWhitespace(branchName);
    if (!normalized) {
      throw new Error('브랜치명이 필요합니다');
    }
    await runGit(workdir, ['check-ref-format', '--branch', normalized]);
    return normalized;
  }

  async function findOpenPullRequestByHead({ owner, repoName, headRef, baseRef }) {
    if (!githubClient?.listOpenPullRequests) {
      return null;
    }

    const targetHeadRef = normalizeWhitespace(headRef);
    const targetBaseRef = normalizeWhitespace(baseRef);
    const pullRequests = await githubClient.listOpenPullRequests({
      owner,
      repo: repoName
    });

    return safeArray(pullRequests).find((pullRequest) => {
      const head = normalizeWhitespace(pullRequest?.head?.ref);
      const base = normalizeWhitespace(pullRequest?.base?.ref);
      if (!head || head !== targetHeadRef) {
        return false;
      }
      if (!targetBaseRef) {
        return true;
      }
      return base === targetBaseRef;
    }) || null;
  }

  async function createPullRequestOnGitHub({
    owner,
    repoName,
    remoteBranch,
    baseBranch,
    title,
    body
  }) {
    const candidateHeads = Array.from(new Set([
      normalizeWhitespace(remoteBranch),
      normalizeWhitespace(owner) && normalizeWhitespace(remoteBranch)
        ? `${normalizeWhitespace(owner)}:${normalizeWhitespace(remoteBranch)}`
        : ''
    ].filter(Boolean)));

    let lastError = null;
    let lastHead = candidateHeads[0] || normalizeWhitespace(remoteBranch);

    for (const head of candidateHeads) {
      lastHead = head;
      const maxAttempts = head.includes(':') ? 3 : 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          const response = await githubClient.createPullRequest({
            owner,
            repo: repoName,
            head,
            base: baseBranch,
            title,
            body
          });
          return {
            response,
            usedHead: head
          };
        } catch (error) {
          lastError = error;
          if (isAlreadyExistsPullRequestError(error)) {
            throw error;
          }

          if (!isNotAllRefsReadableError(error)) {
            throw error;
          }

          if (attempt < maxAttempts) {
            await sleep(1000 * attempt);
            continue;
          }
        }
      }
    }

    const fallbackError = lastError || new Error('PR 생성 요청에 실패했습니다');
    if (isNotAllRefsReadableError(fallbackError)) {
      throw new Error([
        formatPullRequestCreateError(fallbackError),
        `head 후보: ${candidateHeads.join(', ') || lastHead}`,
        '브랜치 push 계정과 GitHub 토큰 계정 권한(동일 저장소 read 권한)을 확인해 주세요.'
      ].join(' | '));
    }
    throw fallbackError;
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

  function resolveContinuationSource(input) {
    const continueFromTaskId = normalizeWhitespace(input.continueFromTaskId);
    if (!continueFromTaskId) {
      return null;
    }

    const previousTask = repo.getTask(continueFromTaskId);
    if (!previousTask) {
      throw new Error(`이전 코드 작업을 찾을 수 없습니다: ${continueFromTaskId}`);
    }
    if (previousTask.domain !== 'code_execution') {
      throw new Error(`코드 작업만 이어서 실행할 수 있습니다: ${continueFromTaskId}`);
    }

    const previousStatus = normalizeTaskStatus(previousTask.status);
    if (!CONTINUATION_ALLOWED_STATUSES.has(previousStatus)) {
      throw new Error(`현재 상태에서는 이어서 실행할 수 없습니다: ${previousTask.status}`);
    }

    const previousPayload = asRecord(previousTask.payload);
    const previousWorkdir = normalizeWhitespace(previousPayload.workdir);
    if (!previousWorkdir) {
      throw new Error(`이전 작업의 작업공간 정보를 찾을 수 없습니다: ${continueFromTaskId}`);
    }

    return {
      previousTask,
      previousPayload,
      previousWorkdir,
      continuationContext: buildContinuationContext(previousTask)
    };
  }

  async function createTask(input) {
    const command = normalizeWhitespace(input.command);
    if (!command) {
      throw new Error('작업 지시가 필요합니다');
    }

    const continuationSource = resolveContinuationSource(input);
    const project = continuationSource
      ? resolveProjectInput({ workdir: continuationSource.previousWorkdir })
      : resolveProjectInput(input);
    let requestedBranchName = normalizeWhitespace(input.branchName);
    let requestedBaseBranch = normalizeWhitespace(
      input.baseBranch || continuationSource?.previousPayload?.baseBranch
    );
    if (requestedBaseBranch && !requestedBranchName) {
      const looksLikeExistingBase = await branchRefExists(project.path, requestedBaseBranch);
      if (!looksLikeExistingBase) {
        requestedBranchName = requestedBaseBranch;
        requestedBaseBranch = '';
      }
    }
    const executionMode = normalizeExecutionMode(
      input.executionMode || continuationSource?.previousPayload?.executionMode,
      'full'
    );
    const requestedPlanSelections = parsePlanSelections(
      input.planSelections || continuationSource?.previousPayload?.planSelections
    );
    const workspace = await inspectWorkspace(project.path, requestedBaseBranch);
    const selectedAgent = await getAvailableAgentRunner(
      input.agentProvider || continuationSource?.previousPayload?.agentProvider,
      workspace.git.root
    );
    const continuationContext = continuationSource?.continuationContext || null;

    let task = repo.upsertTask({
      domain: 'code_execution',
      kind: 'implementation',
      title: `[코드] ${command}`,
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
        githubRepositoryAllowed: workspace.git.githubRepositoryAllowed,
        remoteUrl: workspace.git.remoteUrl,
        agentProvider: selectedAgent.provider,
        executionMode,
        planSelections: requestedPlanSelections,
        needsPlanning: parseBoolean(input.needsPlanning),
        needsDesign: parseBoolean(input.needsDesign),
        requestedBranchName,
        branchName: '',
        restoreBranch: workspace.git.currentBranch || workspace.git.baseBranch,
        branchManaged: false,
        ...(continuationContext
          ? {
              continueFromTaskId: continuationContext.continueFromTaskId,
              parentTaskId: continuationContext.parentTaskId,
              rootTaskId: continuationContext.rootTaskId,
              continuationContext
            }
          : {})
      },
      result: {
        executionProgress: buildExecutionProgress({
          phase: 'queued',
          label: '작업 시작 대기',
          currentStep: 0,
          totalSteps: executionMode === 'plan' ? PLAN_MODE_TOTAL_STEPS : CODE_EXECUTION_TOTAL_STEPS
        })
      },
      sourceUrl: workspace.git.remoteUrl || null,
      summary: continuationContext
        ? `${workspace.git.repoSlug || path.basename(workspace.git.root)}에서 이전 작업을 이어 실행 대기 중입니다`
        : `${workspace.git.repoSlug || path.basename(workspace.git.root)}에서 실행 대기 중입니다`
    });
    if (!continuationContext) {
      const updatedTask = repo.updateTask(task.id, {
        payload: {
          ...asRecord(task.payload),
          rootTaskId: task.id
        }
      });
      if (updatedTask) {
        task = updatedTask;
      }
    }

    storeArtifact(task.id, 'workspace_snapshot', '작업공간 스냅샷', {
      root: workspace.git.root,
      repoSlug: workspace.git.repoSlug,
      baseBranch: workspace.git.baseBranch,
      currentBranch: workspace.git.currentBranch,
      executionMode,
      remoteUrl: workspace.git.remoteUrl,
      githubRepositoryAllowed: workspace.git.githubRepositoryAllowed,
      recommendedChecks: workspace.recommendedChecks,
      scripts: workspace.scripts,
      statusLines: workspace.git.statusLines,
      fileSample: workspace.fileSample.slice(0, 40),
      continuedFrom: continuationContext || null
    });

    repo.logExecution(task.id, 'create_code_task', 'success', {
      request: {
        command,
        projectId: project.id,
        workdir: workspace.git.root,
        branchName: requestedBranchName,
        executionMode,
        continueFromTaskId: continuationContext?.continueFromTaskId || ''
      },
      response: {
        repoSlug: workspace.git.repoSlug,
        baseBranch: workspace.git.baseBranch,
        githubRepositoryAllowed: workspace.git.githubRepositoryAllowed,
        agentProvider: selectedAgent.provider,
        rootTaskId: normalizeWhitespace(task.payload?.rootTaskId),
        parentTaskId: normalizeWhitespace(task.payload?.parentTaskId)
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

  function savePlanSelections(taskId, options: { selections?: Record<string, unknown> } = {}) {
    const task = repo.getTask(taskId);
    if (!task || task.domain !== 'code_execution') {
      throw new Error(`작업을 찾을 수 없습니다: ${taskId}`);
    }

    const executionMode = normalizeExecutionMode(task.payload?.executionMode, 'full');
    if (executionMode !== 'plan') {
      throw new Error('플랜 모드 작업에서만 확인 항목을 저장할 수 있습니다');
    }

    const plans = loadStoredPlans(taskId, task);
    const promptPlan = asRecord(plans.promptPlan);
    if (Object.keys(promptPlan).length === 0) {
      throw new Error('플랜이 아직 생성되지 않았습니다. 잠시 후 다시 시도해 주세요.');
    }

    const existingResult = asRecord(task.result);
    const existingPlanMode = asRecord(existingResult.planMode);
    const requestedSelections = {
      ...parsePlanSelections(task.payload?.planSelections),
      ...parsePlanSelections(options.selections)
    };
    const planModeState = buildPlanModeState({
      promptPlan,
      requestedSelections,
      fallbackRequests: safeArray(existingPlanMode.confirmationRequests).map((entry) => asRecord(entry))
    });

    const updated = repo.updateTask(taskId, {
      payload: {
        ...asRecord(task.payload),
        executionMode: 'plan',
        planSelections: planModeState.selections
      },
      result: {
        ...existingResult,
        planMode: {
          enabled: true,
          ...planModeState
        }
      },
      summary: planModeState.unresolvedRequestIds.length === 0
        ? '플랜 확인 항목이 모두 선택되었습니다. 코드 실행을 시작할 수 있습니다.'
        : '플랜 확인 항목 선택 대기 중입니다.',
      lastError: null
    });

    repo.logExecution(taskId, 'save_plan_selections', 'success', {
      request: {
        selections: options.selections || {}
      },
      response: {
        selections: planModeState.selections,
        unresolvedRequestIds: planModeState.unresolvedRequestIds
      }
    });

    return updated || repo.getTask(taskId);
  }

  async function runTask(taskId, options: { resumeFromCheckpoint?: boolean; startFromPlan?: boolean } = {}) {
    const resumeFromCheckpoint = Boolean(options.resumeFromCheckpoint);
    const startFromPlan = Boolean(options.startFromPlan);
    if (activeRuns.has(taskId)) {
      return { started: false };
    }

    activeRuns.add(taskId);

    const runPromise = (async () => {
      const task = repo.getTask(taskId);
      if (!task || task.domain !== 'code_execution') {
        throw new Error(`작업을 찾을 수 없습니다: ${taskId}`);
      }

      const initialExecutionMode = normalizeExecutionMode(task.payload?.executionMode, 'full');
      const initialPlans = loadStoredPlans(taskId, task);

      if (initialExecutionMode === 'plan' && !startFromPlan) {
        updateExecutionProgress(taskId, '플랜 모드 실행을 위해 작업 환경을 점검하는 중입니다', {
          phase: 'plan_workspace',
          label: '플랜 모드: 작업 환경 점검',
          currentStep: 1,
          totalSteps: PLAN_MODE_TOTAL_STEPS
        });

        const workspace = await inspectWorkspace(task.payload?.workdir, task.payload?.baseBranch);
        updateExecutionProgress(taskId, '플랜을 생성하고 확인 요청 항목을 정리하는 중입니다', {
          phase: 'plan_generation',
          label: '플랜 모드: 계획 생성',
          currentStep: 2,
          totalSteps: PLAN_MODE_TOTAL_STEPS
        }, {
          baseBranch: workspace.git.baseBranch
        });

        const latestTask = repo.getTask(taskId);
        const plans = await runPromptPlanning(latestTask, workspace);
        const currentTask = repo.getTask(taskId);
        const currentResult = asRecord(currentTask?.result);
        const existingPlanMode = asRecord(currentResult.planMode);
        const requestedSelections = parsePlanSelections(currentTask?.payload?.planSelections);
        const planModeState = buildPlanModeState({
          promptPlan: asRecord(plans.promptPlan),
          requestedSelections,
          fallbackRequests: safeArray(existingPlanMode.confirmationRequests).map((entry) => asRecord(entry))
        });

        storeArtifact(taskId, 'plan_confirmation_requests', '플랜 확인 요청', {
          ...planModeState,
          generatedAt: new Date().toISOString()
        });
        repo.logExecution(taskId, 'complete_plan_mode', 'success', {
          response: {
            selections: planModeState.selections,
            unresolvedRequestIds: planModeState.unresolvedRequestIds
          }
        });

        repo.updateTask(taskId, {
          status: 'awaiting_approval',
          approvalState: 'pending',
          summary: planModeState.unresolvedRequestIds.length === 0
            ? '플랜 모드가 완료되었습니다. 코드 실행을 시작할 수 있습니다.'
            : '플랜 모드가 완료되었습니다. 확인 항목을 선택한 뒤 코드 실행을 시작해 주세요.',
          payload: {
            ...asRecord(currentTask?.payload),
            executionMode: 'plan',
            planSelections: planModeState.selections
          },
          result: {
            ...currentResult,
            promptPlan: plans.promptPlan,
            planMode: {
              enabled: true,
              ...planModeState
            },
            executionProgress: buildExecutionProgress({
              phase: 'plan_completed',
              label: '플랜 모드 완료',
              currentStep: PLAN_MODE_TOTAL_STEPS,
              totalSteps: PLAN_MODE_TOTAL_STEPS
            })
          },
          lastError: null
        });
        return;
      }

      if (initialExecutionMode === 'plan' && startFromPlan) {
        const promptPlan = asRecord(initialPlans.promptPlan);
        if (Object.keys(promptPlan).length === 0) {
          throw new Error('플랜 정보가 없어 코드 실행을 시작할 수 없습니다. 플랜 모드를 먼저 완료해 주세요.');
        }

        const existingPlanMode = asRecord(asRecord(task.result).planMode);
        const planModeState = buildPlanModeState({
          promptPlan,
          requestedSelections: parsePlanSelections(task.payload?.planSelections),
          fallbackRequests: safeArray(existingPlanMode.confirmationRequests).map((entry) => asRecord(entry))
        });
        if (planModeState.unresolvedRequestIds.length > 0) {
          throw new Error(
            `플랜 확인 항목 선택이 필요합니다: ${planModeState.unresolvedRequestIds.join(', ')}`
          );
        }

        repo.updateTask(taskId, {
          payload: {
            ...asRecord(task.payload),
            executionMode: 'full',
            planSelections: planModeState.selections
          },
          result: {
            ...asRecord(task.result),
            planMode: {
              enabled: true,
              ...planModeState,
              status: 'confirmed'
            }
          },
          summary: '플랜 선택을 반영해 코드 작업 실행을 시작합니다.',
          lastError: null
        });
        repo.logExecution(taskId, 'start_from_plan_mode', 'success', {
          response: {
            selections: planModeState.selections
          }
        });
      }

      let plans = loadStoredPlans(taskId, repo.getTask(taskId));
      let resumeStartStep = resolveResumeStartStep(repo.getTask(taskId), plans, resumeFromCheckpoint);
      if (startFromPlan && initialExecutionMode === 'plan') {
        resumeStartStep = 3;
      }

      const resumeApplied = (resumeFromCheckpoint && resumeStartStep > 1)
        || (startFromPlan && initialExecutionMode === 'plan');
      if (resumeApplied) {
        const resumeLabel = startFromPlan && initialExecutionMode === 'plan'
          ? '플랜 확정 후 코드 실행 재개'
          : `${resumeStartStep}단계부터 재개`;
        updateExecutionProgress(taskId, `${resumeLabel}를 준비하는 중입니다`, {
          phase: 'resume',
          label: resumeLabel,
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
      const branchState = await ensureBranch(repo.getTask(taskId), workspace);
      const branchName = branchState.branchName;

      plans = loadStoredPlans(taskId, repo.getTask(taskId));
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
      const sourceCommit = normalizeWhitespace(await runGit(workspace.git.root, ['rev-parse', 'HEAD']));
      const mergeResult = await mergeTaskBranchIntoBase(taskId, workspace, {
        workBranch: branchName,
        baseBranch: workspace.git.baseBranch
      });
      const workspaceCleanup = await cleanupTaskWorkspaceBranch(taskId, workspace, {
        workBranch: branchName,
        preferredRestoreBranch: workspace.git.baseBranch,
        deleteWorkBranch: branchState.branchManaged
      });
      const completionSummary = `${branchName} 브랜치 커밋을 ${mergeResult.baseBranch || workspace.git.baseBranch}에 병합했고 `
        + `${workspaceCleanup.restoreBranch || workspace.git.baseBranch} 브랜치로 복귀 후 작업 브랜치를 정리했습니다. `
        + 'PR 생성 준비가 되었습니다.';

      repo.updateTask(taskId, {
        status: 'awaiting_approval',
        approvalState: 'pending',
        summary: completionSummary,
        result: {
          ...asRecord(repo.getTask(taskId)?.result),
          branch: branchName,
          baseBranch: workspace.git.baseBranch,
          sourceCommit,
          restoreBranch: workspaceCleanup.restoreBranch || branchState.restoreBranch || workspace.git.baseBranch,
          merge: mergeResult,
          branchCleanup: workspaceCleanup,
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

  async function createPullRequest(taskId, options: { branchName?: string } = {}) {
    if (activeRuns.has(taskId)) {
      throw new Error('작업이 아직 실행 중입니다');
    }

    const task = repo.getTask(taskId);
    if (!task || task.domain !== 'code_execution') {
      throw new Error(`작업을 찾을 수 없습니다: ${taskId}`);
    }

    const sourceBranch = normalizeWhitespace(task.result?.branch || task.payload?.branchName);
    if (!sourceBranch) {
      throw new Error('이 작업에 기록된 작업 브랜치가 없습니다');
    }

    const workspace = await inspectWorkspace(task.payload?.workdir, task.payload?.baseBranch);
    const remoteBranch = await assertBranchNameValid(
      workspace.git.root,
      normalizeWhitespace(options.branchName) || sourceBranch
    );
    const owner = task.payload?.repoOwner || workspace.git.owner || config.github.owner;
    const repoName = task.payload?.repoName || workspace.git.name;
    const baseBranch = task.result?.baseBranch || workspace.git.baseBranch;
    const requestInfo = {
      sourceBranch,
      remoteBranch,
      baseBranch,
      owner: normalizeWhitespace(owner),
      repoName: normalizeWhitespace(repoName)
    };

    try {
      if (!isGitHubRepositoryAllowed(repoName)) {
        const repoDisplay = normalizeWhitespace(repoName)
          || normalizeWhitespace(task.payload?.repoSlug)
          || workspace.git.repoSlug
          || path.basename(workspace.git.root);
        throw new Error(
          `현재 저장소는 GITHUB_REPOSITORIES 허용 목록에 없어 PR 생성을 지원하지 않습니다: ${repoDisplay}. `
          + 'WORKSPACE_ALLOWLIST 기준 코드 작업 실행은 계속 가능합니다.'
        );
      }

      const branchRestoreResult = await checkoutTaskBranchFromSourceCommit(task, workspace, sourceBranch);
      await assertCleanWorktree(workspace.git.root, 'PR 생성 전에 작업 트리가 깨끗해야 합니다');
      if (sourceBranch === remoteBranch) {
        await runGit(workspace.git.root, ['push', '-u', 'origin', sourceBranch]);
      } else {
        await runGit(workspace.git.root, ['push', '-u', 'origin', `${sourceBranch}:${remoteBranch}`]);
      }

      const pullRequestDraft = task.result?.pullRequest || buildPullRequestDraft({
        task,
        workspace,
        reviewRounds: task.result?.reviewRounds || [],
        commitSummary: safeArray(task.result?.commits).map((commit) => `${commit.subject} (${commit.sha.slice(0, 7)})`)
      });
      const servicePrefix = resolveServicePrefix(task, workspace);
      const branchTitleToken = toBranchTitleToken(remoteBranch);
      const simpleSummary = toSimpleSummary(pullRequestDraft.title || task.payload?.command || task.title);
      const title = `[${servicePrefix}/${branchTitleToken}] ${simpleSummary}`;
      const templateBody = await readPullRequestTemplate(workspace.git.root);
      const body = buildPullRequestBodyFromTemplate(templateBody, pullRequestDraft.body, simpleSummary);
      if (!owner || !repoName) {
        throw new Error('PR 생성을 위한 GitHub 저장소 정보를 확인할 수 없습니다');
      }

      let prResponse = null;
      let reusedExistingPullRequest = false;
      let usedHead = remoteBranch;
      try {
        const createResult = await createPullRequestOnGitHub({
          owner,
          repoName,
          remoteBranch,
          baseBranch,
          title,
          body
        });
        prResponse = createResult.response;
        usedHead = createResult.usedHead;
      } catch (error) {
        if (!isAlreadyExistsPullRequestError(error)) {
          throw error;
        }

        const existingPullRequest = await findOpenPullRequestByHead({
          owner,
          repoName,
          headRef: remoteBranch,
          baseRef: baseBranch
        });
        if (!existingPullRequest) {
          throw error;
        }

        prResponse = {
          number: existingPullRequest.number,
          html_url: existingPullRequest.html_url,
          title: existingPullRequest.title || title
        };
        reusedExistingPullRequest = true;
      }

      if (reusedExistingPullRequest && githubClient?.updatePullRequest) {
        await githubClient.updatePullRequest({
          owner,
          repo: repoName,
          pullNumber: prResponse.number,
          title,
          body,
          base: baseBranch
        });
      }
      const workspaceCleanup = await cleanupTaskWorkspaceBranch(taskId, workspace, {
        workBranch: sourceBranch,
        preferredRestoreBranch: normalizeWhitespace(task.result?.restoreBranch || task.payload?.restoreBranch),
        deleteWorkBranch: Boolean(task.payload?.branchManaged)
      });

      repo.updateTask(taskId, {
        status: 'done',
        approvalState: 'approved',
        summary: `${reusedExistingPullRequest ? '기존 PR을 확인했습니다' : 'PR을 생성했습니다'}: #${prResponse.number}`,
        result: {
          ...(task.result || {}),
          restoreBranch: workspaceCleanup.restoreBranch || normalizeWhitespace(task.payload?.restoreBranch) || workspace.git.baseBranch,
          branchCleanup: workspaceCleanup,
          pullRequest: {
            ...pullRequestDraft,
            title,
            body,
            servicePrefix,
            head: remoteBranch,
            sourceBranch,
            templateUsed: Boolean(templateBody.trim()),
            number: prResponse.number,
            url: prResponse.html_url
          }
        },
        lastError: null
      });
      repo.logExecution(taskId, 'create_pr', 'success', {
        request: requestInfo,
        response: {
          ...prResponse,
          reusedExistingPullRequest,
          usedHead,
          branchRestoreResult,
          workspaceCleanup
        }
      });

      return repo.getTask(taskId);
    } catch (error) {
      const formattedError = formatPullRequestCreateError(error);
      repo.updateTask(taskId, {
        summary: 'PR 생성 중 오류가 발생했습니다. 입력값과 저장소 상태를 확인한 뒤 다시 시도해 주세요.',
        lastError: formattedError
      });
      repo.logExecution(taskId, 'create_pr', 'failed', {
        request: requestInfo,
        error: formattedError
      });
      throw new Error(formattedError);
    }
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
    savePlanSelections,
    start: runTask,
    createPullRequest
  };
}
