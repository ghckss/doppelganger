import fs from 'node:fs';
import path from 'node:path';
import {
  buildChunkExecutorPrompt,
  buildFinalValidationPrompt,
  buildMergeReviewPrompt,
  buildPatchPrompt,
  buildPullRequestDraft,
  buildRefinementInspectionPrompt,
  buildReviewerPrompt,
  buildSpecPrompt,
  buildTechLeadPrompt,
  codingAgentSchema,
  finalValidationSchema,
  implementationPlanSchema,
  mergeReviewSchema,
  patchAgentSchema,
  refinementDecisionSchema,
  renderArtifactContent,
  requirementContractSchema,
  reviewAgentSchema
} from '../modules/code-execution/code-task-prompts.ts';
import { normalizeWhitespace, safeArray, truncateText } from '../core/utils.ts';

// runner 스킬 워크플로 고정 단계 수: 1 환경준비 · 2 요구사항계약(Gate1) · 3 구현계획(Gate2) · 4 chunk구현 · 5 최종검증 · 6 완료
const CODE_EXECUTION_TOTAL_STEPS = 6;
const MAX_REVIEW_ITERATIONS = 2;
const MAX_SELF_REPAIR_ATTEMPTS = 2;
// 완료 후 개선 루프(Refinement Loop) 최대 반복. 무한 polish 금지(runner 스킬 규칙).
const MAX_REFINEMENT_ITERATIONS = 2;
const CONTINUATION_ALLOWED_STATUSES = new Set(['done', 'awaiting_approval', 'failed']);

// runner 리뷰 스웜: 도메인별 독립 리뷰어(diff 한정). 비용을 위해 핵심 4개 도메인으로 제한.
const REVIEWER_DOMAINS: Array<{ key: string; label: string; guidance: string }> = [
  { key: 'correctness', label: 'Correctness', guidance: 'requirement fit, edge cases, state mismatch, async/race issues, null/undefined flows' },
  { key: 'security', label: 'Security', guidance: 'XSS, SSRF, injection, auth bypass, secret leakage, unsafe trust boundaries' },
  { key: 'type_safety', label: 'Type Safety', guidance: 'type soundness, generic inference, unsafe casts, runtime type risks' },
  { key: 'testing', label: 'Testing', guidance: 'missing tests, flaky tests, uncovered edge cases, weak assertions' }
];

type RunnerStage = 'workspace' | 'spec' | 'plan' | 'execution' | 'validation';
// spec/plan = Gate 1/2(구현 전 승인). risk = Gate 3(autopilot 중 위험 변경 승인). plan_patch = 계획 불일치 재계획 승인.
type RunnerGate = '' | 'spec' | 'plan' | 'risk' | 'plan_patch';
const GATE_VALUES: RunnerGate[] = ['spec', 'plan', 'risk', 'plan_patch'];

interface ExecutionProgressInput {
  phase?: string;
  label?: string;
  currentStep?: number;
  totalSteps?: number;
  gate?: RunnerGate;
  chunkIndex?: number;
  chunkTotal?: number;
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

// 스키마 강제(--json-schema)를 쓰지 않으므로 모델이 문자열 배열 자리에 객체를 줄 수 있다.
// 객체가 오면 String() 결과 "[object Object]" 대신 의미 있는 텍스트 필드를 뽑아낸다.
function coerceText(value) {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return normalizeWhitespace(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const candidate = record.text ?? record.description ?? record.risk ?? record.detail
      ?? record.message ?? record.title ?? record.summary ?? record.criterion ?? record.note ?? record.item;
    if (typeof candidate === 'string' && normalizeWhitespace(candidate)) {
      return normalizeWhitespace(candidate);
    }
    try {
      return normalizeWhitespace(JSON.stringify(value));
    } catch {
      return '';
    }
  }
  return normalizeWhitespace(value);
}

function coerceTextList(value) {
  return safeArray(value).map((entry) => coerceText(entry)).filter(Boolean);
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
  gate = '',
  chunkIndex = 0,
  chunkTotal = 0
}: ExecutionProgressInput = {}) {
  const normalizedTotalSteps = Math.max(1, toInteger(totalSteps, CODE_EXECUTION_TOTAL_STEPS));
  const normalizedCurrentStep = Math.max(0, Math.min(normalizedTotalSteps, toInteger(currentStep, 0)));
  const normalizedChunkTotal = Math.max(0, toInteger(chunkTotal, 0));
  const normalizedChunkIndex = Math.max(0, Math.min(normalizedChunkTotal, toInteger(chunkIndex, 0)));
  return {
    phase: normalizeWhitespace(phase) || 'unknown',
    label: normalizeWhitespace(label),
    currentStep: normalizedCurrentStep,
    totalSteps: normalizedTotalSteps,
    percent: Math.round((normalizedCurrentStep / normalizedTotalSteps) * 100),
    gate: GATE_VALUES.includes(gate as RunnerGate) ? gate : '',
    chunkIndex: normalizedChunkIndex,
    chunkTotal: normalizedChunkTotal
  };
}

function reviewFindingData(finding) {
  return {
    id: coerceText(finding.id),
    severity: normalizeWhitespace(finding.severity),
    category: normalizeWhitespace(finding.category),
    title: coerceText(finding.title),
    description: coerceText(finding.description),
    fileRefs: coerceTextList(finding.fileRefs),
    suggestedFix: coerceText(finding.suggestedFix),
    mustFix: Boolean(finding.mustFix)
  };
}

function mergeFindingData(finding) {
  return {
    id: coerceText(finding.id),
    severity: normalizeWhitespace(finding.severity),
    title: coerceText(finding.title),
    description: coerceText(finding.description),
    fileRefs: coerceTextList(finding.fileRefs),
    action: coerceText(finding.action)
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

  async function repositoryHasHeadCommit(workdir) {
    return gitRevisionExists(workdir, 'HEAD^{commit}');
  }

  async function branchRefExists(workdir, branchName) {
    const normalized = normalizeWhitespace(branchName);
    if (!normalized) {
      return false;
    }

    return gitRevisionExists(workdir, `refs/heads/${normalized}^{commit}`);
  }

  async function resolveBaseBranch(workdir, requestedBaseBranch = '', currentBranch = '') {
    const requested = normalizeWhitespace(requestedBaseBranch);
    const normalizedCurrent = normalizeWhitespace(currentBranch);
    const hasHeadCommit = await repositoryHasHeadCommit(workdir);
    if (!hasHeadCommit) {
      if (requested && normalizedCurrent && requested === normalizedCurrent) {
        return requested;
      }
      if (normalizedCurrent) {
        return normalizedCurrent;
      }
      if (requested) {
        return requested;
      }
      return 'main';
    }

    const fallbackCandidates = Array.from(new Set([
      normalizedCurrent,
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
    const hasCommits = await repositoryHasHeadCommit(root);
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
        hasCommits,
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
        if (baseExists) {
          await runGit(workspace.git.root, ['checkout', normalizedBaseBranch]);
          await runGit(workspace.git.root, ['merge', '--ff-only', normalizedWorkBranch]);
        } else {
          const workExists = await localBranchExists(workspace.git.root, normalizedWorkBranch);
          if (!workExists) {
            throw new Error(`병합할 작업 브랜치를 찾을 수 없습니다: ${normalizedWorkBranch}`);
          }
          await runGit(workspace.git.root, ['checkout', '-B', normalizedBaseBranch, normalizedWorkBranch]);
        }
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

    if (!workspace.git.hasCommits) {
      if (workspace.git.currentBranch !== branchName) {
        await runGit(workspace.git.root, ['checkout', '-B', branchName]);
      }
      const branchManagedWithoutHistory = branchName !== restoreBranch;
      repo.updateTask(task.id, {
        payload: {
          ...currentTask.payload,
          branchName,
          restoreBranch,
          branchManaged: branchManagedWithoutHistory
        }
      });
      return {
        branchName,
        restoreBranch,
        branchManaged: branchManagedWithoutHistory
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
    const hasHeadCommit = await repositoryHasHeadCommit(workdir);
    if (!hasHeadCommit) {
      return [];
    }

    const normalizedBaseBranch = normalizeWhitespace(baseBranch);
    const baseExists = normalizedBaseBranch
      ? await branchRefExists(workdir, normalizedBaseBranch)
      : false;
    const result = baseExists
      ? await runGit(workdir, ['log', '--reverse', '--format=%H%x1f%s', `${normalizedBaseBranch}..HEAD`])
      : await runGit(workdir, ['log', '--reverse', '--format=%H%x1f%s', 'HEAD']);
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

  // runner State Store: 요구사항 계약/구현 계획/chunk 진행 상태를 task.result.runner에 저장한다.
  function loadRunnerState(taskId, task) {
    const result = asRecord(task?.result);
    const runner = asRecord(result.runner);
    const contract = asRecord(runner.requirementContract).summary !== undefined || Object.keys(asRecord(runner.requirementContract)).length > 0
      ? asRecord(runner.requirementContract)
      : latestArtifactMetadata(taskId, 'requirement_contract');
    const plan = Object.keys(asRecord(runner.implementationPlan)).length > 0
      ? asRecord(runner.implementationPlan)
      : latestArtifactMetadata(taskId, 'implementation_plan');
    return {
      requirementContract: contract && Object.keys(asRecord(contract)).length > 0 ? asRecord(contract) : null,
      implementationPlan: plan && Object.keys(asRecord(plan)).length > 0 ? asRecord(plan) : null,
      chunks: safeArray(runner.chunks).map((entry) => asRecord(entry)),
      remainingKnownIssues: safeArray(runner.remainingKnownIssues),
      finalValidation: asRecord(runner.finalValidation)
    };
  }

  function patchRunnerState(taskId, partial) {
    const task = repo.getTask(taskId);
    const result = asRecord(task?.result);
    const runner = asRecord(result.runner);
    repo.updateTask(taskId, {
      result: {
        ...result,
        runner: {
          ...runner,
          ...partial
        }
      }
    });
  }

  // 재개 시 다시 진입할 stage 결정. 승인 게이트(spec/plan) 통과 여부 + 진행 단계 기준.
  function resolveResumeStage(task): RunnerStage {
    const result = asRecord(task?.result);
    const runner = loadRunnerState(task?.id, task);
    const progress = asRecord(result.executionProgress);
    const phase = normalizeWhitespace(progress.phase).toLowerCase();
    const currentStep = Math.max(0, toInteger(progress.currentStep, 0));

    if (phase === 'validation' || phase === 'completed' || currentStep >= 5) {
      return 'validation';
    }
    if (phase === 'execution' || currentStep >= 4) {
      return runner.implementationPlan ? 'execution' : 'plan';
    }
    if (phase === 'plan' || currentStep >= 3) {
      return runner.requirementContract ? 'plan' : 'spec';
    }
    if (phase === 'spec' || currentStep >= 2) {
      return 'spec';
    }
    return 'workspace';
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
    const hasCommitHistory = await repositoryHasHeadCommit(project.path);
    if (requestedBaseBranch && !requestedBranchName && hasCommitHistory) {
      const looksLikeExistingBase = await branchRefExists(project.path, requestedBaseBranch);
      if (!looksLikeExistingBase) {
        requestedBranchName = requestedBaseBranch;
        requestedBaseBranch = '';
      }
    }
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
          totalSteps: CODE_EXECUTION_TOTAL_STEPS
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

  function normalizeRequirementContract(parsed) {
    const source = asRecord(parsed);
    return {
      summary: normalizeWhitespace(source.summary),
      goals: coerceTextList(source.goals),
      nonGoals: coerceTextList(source.nonGoals),
      constraints: coerceTextList(source.constraints),
      acceptanceCriteria: coerceTextList(source.acceptanceCriteria),
      edgeCases: coerceTextList(source.edgeCases),
      openQuestions: coerceTextList(source.openQuestions)
    };
  }

  function normalizeChunk(entry, index) {
    const source = asRecord(entry);
    const title = normalizeWhitespace(source.title) || `구현 단위 ${index + 1}`;
    const id = normalizeWhitespace(source.id) || `chunk_${index + 1}`;
    return {
      id,
      title,
      acceptanceCriteria: coerceTextList(source.acceptanceCriteria)
    };
  }

  function normalizeImplementationPlan(parsed, fallbackTitle = '') {
    const source = asRecord(parsed);
    const taskBreakdown = safeArray(source.taskBreakdown).map((entry, index) => normalizeChunk(entry, index));
    if (taskBreakdown.length === 0) {
      taskBreakdown.push({
        id: 'chunk_1',
        title: normalizeWhitespace(fallbackTitle) || '요청 구현',
        acceptanceCriteria: []
      });
    }
    return {
      summary: normalizeWhitespace(source.summary),
      implementationSteps: coerceTextList(source.implementationSteps),
      filesLikelyToChange: coerceTextList(source.filesLikelyToChange),
      architectureImpact: coerceTextList(source.architectureImpact),
      risks: coerceTextList(source.risks),
      rolloutConcerns: coerceTextList(source.rolloutConcerns),
      validationStrategy: coerceTextList(source.validationStrategy),
      chunkCommitBoundaries: coerceTextList(source.chunkCommitBoundaries),
      taskBreakdown
    };
  }

  function normalizeMergeReview(parsed) {
    const source = asRecord(parsed);
    return {
      mustFix: safeArray(source.mustFix).map(mergeFindingData).filter((finding) => finding.title),
      shouldFix: safeArray(source.shouldFix).map(mergeFindingData).filter((finding) => finding.title),
      advisory: safeArray(source.advisory).map(mergeFindingData).filter((finding) => finding.title),
      duplicates: compactStrings(source.duplicates),
      discarded: compactStrings(source.discarded)
    };
  }

  function normalizeFinalValidation(parsed) {
    const source = asRecord(parsed);
    return {
      contractMet: Boolean(source.contractMet),
      regression: coerceText(source.regression),
      summary: coerceText(source.summary),
      residualRisks: coerceTextList(source.residualRisks),
      acceptanceResults: safeArray(source.acceptanceResults).map((entry) => {
        const record = asRecord(entry);
        return {
          criterion: coerceText(record.criterion),
          status: normalizeWhitespace(record.status) || 'partial',
          evidence: coerceText(record.evidence)
        };
      })
    };
  }

  function mergeFindingToReviewFinding(finding) {
    return {
      id: normalizeWhitespace(finding.id),
      severity: normalizeWhitespace(finding.severity),
      category: 'bug',
      title: normalizeWhitespace(finding.title),
      description: normalizeWhitespace(finding.description),
      fileRefs: compactStrings(finding.fileRefs),
      suggestedFix: normalizeWhitespace(finding.action),
      mustFix: true
    };
  }

  function applyGate(taskId, gate) {
    const task = repo.getTask(taskId);
    const result = asRecord(task?.result);
    const isSpec = gate === 'spec';
    repo.updateTask(taskId, {
      status: 'awaiting_approval',
      approvalState: 'pending',
      summary: isSpec
        ? '요구사항 계약을 검토하고 승인해 주세요. 승인하면 구현 계획을 수립합니다.'
        : '구현 계획을 검토하고 승인해 주세요. 승인하면 chunk 단위 구현을 시작합니다.',
      result: {
        ...result,
        executionProgress: buildExecutionProgress({
          phase: gate,
          label: isSpec ? '요구사항 계약 승인 대기 (Gate 1)' : '구현 계획 승인 대기 (Gate 2)',
          currentStep: isSpec ? 2 : 3,
          gate
        })
      },
      lastError: null
    });
    repo.logExecution(taskId, isSpec ? 'await_requirement_contract' : 'await_implementation_plan', 'success');
  }

  // Gate 3: autopilot 중 위험 가능성이 있는 변경(파일 삭제, 의존성/lockfile 변경, .env 등)을 감지하기 위한 휴리스틱.
  async function detectRiskSignals(workspace) {
    const base = normalizeWhitespace(workspace.git.baseBranch);
    const empty = { deletions: [], dependencyChanges: [], envChanges: [], risky: false };
    if (!base || !(await branchRefExists(workspace.git.root, base))) {
      return empty;
    }
    let output = '';
    try {
      output = await runGit(workspace.git.root, ['diff', '--name-status', `${base}...HEAD`]);
    } catch {
      return empty;
    }
    const deletions = [];
    const dependencyChanges = [];
    const envChanges = [];
    const dependencyPattern = /(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|requirements\.txt|Pipfile(\.lock)?|Gemfile(\.lock)?|go\.(mod|sum)|Cargo\.(toml|lock)|composer\.(json|lock))$/;
    const envPattern = /(^|\/)\.env(\.[A-Za-z0-9_.-]+)?$/;
    for (const line of output.split(/\r?\n/).filter(Boolean)) {
      const parts = line.split(/\t/);
      const status = normalizeWhitespace(parts[0]);
      const file = normalizeWhitespace(parts[parts.length - 1]);
      if (!file) {
        continue;
      }
      if (status.startsWith('D')) {
        deletions.push(file);
      }
      if (dependencyPattern.test(file)) {
        dependencyChanges.push(file);
      }
      if (envPattern.test(file)) {
        envChanges.push(file);
      }
    }
    return {
      deletions,
      dependencyChanges,
      envChanges,
      risky: deletions.length > 0 || dependencyChanges.length > 0 || envChanges.length > 0
    };
  }

  function pauseForRiskGate(taskId, riskReview) {
    patchRunnerState(taskId, { riskReview });
    const result = asRecord(repo.getTask(taskId)?.result);
    repo.updateTask(taskId, {
      status: 'awaiting_approval',
      approvalState: 'pending',
      summary: '위험 가능성이 있는 변경이 감지되었습니다(Gate 3). 검토 후 계속 진행할지 승인해 주세요.',
      result: {
        ...result,
        executionProgress: buildExecutionProgress({
          phase: 'execution',
          label: '위험 변경 승인 대기 (Gate 3)',
          currentStep: 4,
          gate: 'risk'
        })
      },
      lastError: null
    });
    repo.logExecution(taskId, 'await_risk_approval', 'success', { response: riskReview });
  }

  function pauseForPlanPatchGate(taskId, planPatchRequest) {
    patchRunnerState(taskId, { planPatchRequest });
    const result = asRecord(repo.getTask(taskId)?.result);
    repo.updateTask(taskId, {
      status: 'awaiting_approval',
      approvalState: 'pending',
      summary: '실행 중 계획 불일치가 보고되었습니다. 계획을 갱신할지 승인해 주세요.',
      result: {
        ...result,
        executionProgress: buildExecutionProgress({
          phase: 'execution',
          label: '계획 패치 승인 대기',
          currentStep: 4,
          gate: 'plan_patch'
        })
      },
      lastError: null
    });
    repo.logExecution(taskId, 'await_plan_patch_approval', 'success', { response: planPatchRequest });
  }

  async function prepareWorkspaceStage(taskId) {
    updateExecutionProgress(taskId, '작업 환경을 점검하는 중입니다', {
      phase: 'workspace',
      label: '작업 환경 점검 및 브랜치 준비',
      currentStep: 1
    });
    const task = repo.getTask(taskId);
    const workspace = await inspectWorkspace(task.payload?.workdir, task.payload?.baseBranch);
    updateTaskProgress(taskId, '작업 환경 점검을 완료했습니다', {
      baseBranch: workspace.git.baseBranch
    });
  }

  async function runSpecStage(taskId) {
    updateExecutionProgress(taskId, '요구사항 계약(Requirement Contract)을 작성하는 중입니다', {
      phase: 'spec',
      label: '요구사항 계약 작성',
      currentStep: 2
    });
    const task = repo.getTask(taskId);
    const runner = loadRunnerState(taskId, task);
    const revisionFeedback = normalizeWhitespace(asRecord(task.payload?.gateFeedback).spec);
    const workspace = await inspectWorkspace(task.payload?.workdir, task.payload?.baseBranch);
    const agent = getAgentRunner(task.payload?.agentProvider);
    const prompt = buildSpecPrompt({
      task,
      workspace,
      revisionFeedback,
      previousContract: revisionFeedback ? runner.requirementContract : null
    });
    const response = await agent.runner.runExec({
      workdir: workspace.git.root,
      prompt,
      sandboxMode: 'read-only',
      schema: requirementContractSchema
    });
    const contract = normalizeRequirementContract(response.parsed);
    storeArtifact(taskId, 'requirement_contract', '요구사항 계약', contract);
    patchRunnerState(taskId, { requirementContract: contract });
    repo.logExecution(taskId, 'run_spec_agent', 'success', {
      response: {
        ...contract,
        agentProvider: agent.provider,
        stdout: response.stdout,
        stderr: response.stderr,
        durationMs: response.durationMs
      }
    });
    return contract;
  }

  async function runPlanStage(taskId) {
    updateExecutionProgress(taskId, '구현 계획(Implementation Plan)을 수립하는 중입니다', {
      phase: 'plan',
      label: '구현 계획 수립',
      currentStep: 3
    });
    const task = repo.getTask(taskId);
    const runner = loadRunnerState(taskId, task);
    if (!runner.requirementContract) {
      throw new Error('요구사항 계약이 없어 구현 계획을 수립할 수 없습니다');
    }
    const revisionFeedback = normalizeWhitespace(asRecord(task.payload?.gateFeedback).plan);
    const workspace = await inspectWorkspace(task.payload?.workdir, task.payload?.baseBranch);
    const agent = getAgentRunner(task.payload?.agentProvider);
    const prompt = buildTechLeadPrompt({
      task,
      workspace,
      contract: runner.requirementContract,
      revisionFeedback,
      previousPlan: revisionFeedback ? runner.implementationPlan : null
    });
    const response = await agent.runner.runExec({
      workdir: workspace.git.root,
      prompt,
      sandboxMode: 'read-only',
      schema: implementationPlanSchema
    });
    const plan = normalizeImplementationPlan(response.parsed, task.payload?.command || task.title);
    storeArtifact(taskId, 'implementation_plan', '구현 계획', plan);
    patchRunnerState(taskId, { implementationPlan: plan });
    repo.logExecution(taskId, 'run_tech_lead_agent', 'success', {
      response: {
        ...plan,
        agentProvider: agent.provider,
        stdout: response.stdout,
        stderr: response.stderr,
        durationMs: response.durationMs
      }
    });
    return plan;
  }

  async function runReviewLoopForChunk(taskId, workspace, contract, chunk, chunkIndex) {
    let mergedReview = { mustFix: [], shouldFix: [], advisory: [], duplicates: [], discarded: [] };
    const commitSubjects = [];
    const remaining = [];

    for (let iteration = 1; iteration <= MAX_REVIEW_ITERATIONS; iteration += 1) {
      const reviewerResults = await Promise.all(REVIEWER_DOMAINS.map(async (domain) => {
        const reviewerAgent = getAgentRunner(repo.getTask(taskId)?.payload?.agentProvider);
        const reviewerPrompt = buildReviewerPrompt({
          task: repo.getTask(taskId),
          workspace,
          contract,
          domain: domain.label,
          domainGuidance: domain.guidance,
          chunk
        });
        const reviewerResponse = await reviewerAgent.runner.runExec({
          workdir: workspace.git.root,
          prompt: reviewerPrompt,
          sandboxMode: 'read-only',
          schema: reviewAgentSchema
        });
        return {
          domain: domain.label,
          findings: safeArray(reviewerResponse.parsed?.findings).map(reviewFindingData)
        };
      }));

      storeArtifact(taskId, 'review_round', `chunk ${chunkIndex + 1} 리뷰 스웜 ${iteration}`, {
        chunkId: chunk.id,
        iteration,
        reviewers: reviewerResults
      });
      repo.logExecution(taskId, 'run_reviewer_swarm', 'success', {
        response: {
          chunkId: chunk.id,
          iteration,
          findingsCount: reviewerResults.reduce((total, entry) => total + entry.findings.length, 0)
        }
      });

      const totalFindings = reviewerResults.reduce((total, entry) => total + entry.findings.length, 0);
      if (totalFindings === 0) {
        mergedReview = { mustFix: [], shouldFix: [], advisory: [], duplicates: [], discarded: [] };
        storeArtifact(taskId, 'merge_review', `chunk ${chunkIndex + 1} 병합 리뷰 ${iteration}`, {
          chunkId: chunk.id,
          iteration,
          ...mergedReview
        });
        break;
      }

      const mergeAgent = getAgentRunner(repo.getTask(taskId)?.payload?.agentProvider);
      const mergePrompt = buildMergeReviewPrompt({
        task: repo.getTask(taskId),
        contract,
        reviewerFindings: reviewerResults
      });
      const mergeResponse = await mergeAgent.runner.runExec({
        workdir: workspace.git.root,
        prompt: mergePrompt,
        sandboxMode: 'read-only',
        schema: mergeReviewSchema
      });
      mergedReview = normalizeMergeReview(mergeResponse.parsed);
      storeArtifact(taskId, 'merge_review', `chunk ${chunkIndex + 1} 병합 리뷰 ${iteration}`, {
        chunkId: chunk.id,
        iteration,
        ...mergedReview
      });
      repo.logExecution(taskId, 'run_merge_reviewer', 'success', {
        response: {
          chunkId: chunk.id,
          iteration,
          mustFix: mergedReview.mustFix.length,
          shouldFix: mergedReview.shouldFix.length,
          advisory: mergedReview.advisory.length
        }
      });

      if (mergedReview.mustFix.length === 0) {
        remaining.push(...mergedReview.shouldFix, ...mergedReview.advisory);
        break;
      }

      const baseBranch = workspace.git.baseBranch;
      const previousCommitCount = (await listCommitsSince(workspace.git.root, baseBranch)).length;
      const patchAgent = getAgentRunner(repo.getTask(taskId)?.payload?.agentProvider);
      const patchPrompt = buildPatchPrompt({
        task: repo.getTask(taskId),
        workspace,
        mustFix: mergedReview.mustFix.map(mergeFindingToReviewFinding),
        chunk
      });
      // 패치도 무거운 workspace-write 단계이므로 구조화 출력을 강제하지 않고 텍스트로 받는다.
      const patchResponse = await patchAgent.runner.runExec({
        workdir: workspace.git.root,
        prompt: patchPrompt,
        sandboxMode: 'workspace-write'
      });
      const autoCommitResult = await autoCommitWorktreeIfDirty(taskId, workspace.git.root, {
        action: 'auto_commit_patch_changes',
        phase: 'patch',
        commitMessage: `runner chunk ${chunkIndex + 1} fix: resolve review findings (iteration ${iteration})`,
        dirtyErrorMessage: `chunk ${chunkIndex + 1} 수정 라운드 ${iteration}에서 커밋되지 않은 변경이 남았습니다`
      });
      await assertCleanWorktree(workspace.git.root, `chunk ${chunkIndex + 1} 수정 라운드 ${iteration}에서 커밋되지 않은 변경이 남았습니다`);
      const newCommits = await listCommitSubjects(workspace.git.root, baseBranch, previousCommitCount);
      const patchParsed = asRecord(patchResponse.parsed);
      if (!normalizeWhitespace(patchParsed.summary)) {
        patchParsed.summary = normalizeWhitespace(patchResponse.lastMessage || patchResponse.stdout) || '리뷰 지적사항을 수정했습니다.';
      }
      const patchData = patchArtifactData(iteration, patchParsed, newCommits);
      storeArtifact(taskId, 'patch_round', `chunk ${chunkIndex + 1} 수정 ${iteration}`, patchData);
      repo.logExecution(taskId, 'apply_review_fixes', 'success', {
        response: {
          ...patchData,
          agentProvider: patchAgent.provider,
          autoCommit: autoCommitResult,
          stdout: patchResponse.stdout,
          stderr: patchResponse.stderr,
          durationMs: patchResponse.durationMs
        }
      });
      commitSubjects.push(...newCommits);

      if (iteration >= MAX_REVIEW_ITERATIONS && mergedReview.mustFix.length > 0) {
        remaining.push(...mergedReview.mustFix.map((finding) => ({
          ...finding,
          action: `${finding.action} (max review iterations reached)`
        })));
      }
    }

    return {
      merged: mergedReview,
      commitSubjects,
      remaining
    };
  }

  async function runChunk(taskId, workspace, contract, plan, chunk, chunkIndex, chunkTotal) {
    const agent = getAgentRunner(repo.getTask(taskId)?.payload?.agentProvider);
    const codebaseSnapshot = [
      `Base branch: ${workspace.git.baseBranch}`,
      `Work branch: ${repo.getTask(taskId)?.payload?.branchName || ''}`,
      `Files sampled: ${workspace.fileSample.slice(0, 16).join(', ') || 'none'}`
    ].join('\n');
    const prompt = buildChunkExecutorPrompt({
      task: repo.getTask(taskId),
      workspace,
      contract,
      plan,
      chunk,
      chunkIndex,
      chunkTotal,
      codebaseSnapshot
    });
    storeArtifact(taskId, 'coding_prompt', `chunk ${chunkIndex + 1} 코딩 프롬프트`, {
      chunkId: chunk.id,
      branchName: repo.getTask(taskId)?.payload?.branchName,
      prompt
    });

    // 무거운 코딩 단계는 강제 JSON 구조화 출력이 긴 도구 사용 세션에서 자주 실패하므로 스키마 없이 텍스트로 받는다.
    const response = await agent.runner.runExec({
      workdir: workspace.git.root,
      prompt,
      sandboxMode: 'workspace-write'
    });
    const responseText = normalizeWhitespace(response.lastMessage || response.stdout);

    // 계획 불일치 감지: 구조화 필드(테스트 fake) 또는 텍스트 마커(실제 실행) 둘 다 지원.
    const planPatchSource = asRecord(asRecord(response.parsed).planPatchRequest);
    let planPatchReason = normalizeWhitespace(planPatchSource.reason);
    let planPatchProposed = normalizeWhitespace(planPatchSource.proposedChange);
    if (!planPatchReason) {
      const marker = responseText.match(/PLAN_PATCH_REQUEST:\s*([\s\S]+)/i);
      if (marker) {
        const [reasonPart, proposedPart] = marker[1].split('|||');
        planPatchReason = normalizeWhitespace(reasonPart);
        planPatchProposed = normalizeWhitespace(proposedPart) || planPatchReason;
      }
    }
    if (planPatchReason && planPatchProposed) {
      await autoCommitWorktreeIfDirty(taskId, workspace.git.root, {
        action: 'auto_commit_coding_changes',
        phase: 'coding',
        commitMessage: `chore: snapshot before plan patch (chunk ${chunkIndex + 1})`,
        dirtyErrorMessage: `chunk ${chunkIndex + 1} 계획 패치 전 변경 정리에 실패했습니다`
      });
      await assertCleanWorktree(workspace.git.root, `chunk ${chunkIndex + 1} 계획 패치 전 작업 트리가 깨끗해야 합니다`);
      repo.logExecution(taskId, 'plan_patch_requested', 'success', {
        response: { chunkId: chunk.id, reason: planPatchReason, proposedChange: planPatchProposed }
      });
      return {
        id: chunk.id,
        title: chunk.title,
        acceptanceCriteria: chunk.acceptanceCriteria,
        status: 'plan_patch_requested',
        planPatchRequest: { reason: planPatchReason, proposedChange: planPatchProposed }
      };
    }

    const autoCommitResult = await autoCommitWorktreeIfDirty(taskId, workspace.git.root, {
      action: 'auto_commit_coding_changes',
      phase: 'coding',
      commitMessage: `runner chunk ${chunkIndex + 1}: ${slugify(chunk.title)}`,
      dirtyErrorMessage: `chunk ${chunkIndex + 1} 구현에서 커밋되지 않은 변경이 남았습니다`
    });
    await assertCleanWorktree(workspace.git.root, `chunk ${chunkIndex + 1} 구현에서 커밋되지 않은 변경이 남았습니다`);

    const executorSummary = normalizeWhitespace(asRecord(response.parsed).summary) || responseText || '코딩 단계를 완료했습니다.';
    const testsRun = compactStrings(asRecord(response.parsed).testsRun);
    const notes = compactStrings(asRecord(response.parsed).notes);
    storeArtifact(taskId, 'validation_log', `chunk ${chunkIndex + 1} 자체검증`, {
      chunkId: chunk.id,
      testsRun,
      notes,
      note: '검증 명령은 실행자 에이전트가 샌드박스에서 실행하고 testsRun에 기록합니다.'
    });
    repo.logExecution(taskId, 'run_executor_agent', 'success', {
      response: {
        chunkId: chunk.id,
        summary: executorSummary,
        testsRun,
        notes,
        agentProvider: agent.provider,
        autoCommit: autoCommitResult,
        stdout: response.stdout,
        stderr: response.stderr,
        durationMs: response.durationMs
      }
    });

    const reviewOutcome = await runReviewLoopForChunk(taskId, workspace, contract, chunk, chunkIndex);

    return {
      id: chunk.id,
      title: chunk.title,
      acceptanceCriteria: chunk.acceptanceCriteria,
      status: 'committed',
      executorSummary,
      testsRun,
      mergedReview: reviewOutcome.merged,
      patchCommits: reviewOutcome.commitSubjects,
      remainingKnownIssues: reviewOutcome.remaining
    };
  }

  async function runExecutionStage(taskId, workspace) {
    const task = repo.getTask(taskId);
    const runner = loadRunnerState(taskId, task);
    if (!runner.requirementContract) {
      throw new Error('요구사항 계약이 없어 구현을 시작할 수 없습니다');
    }
    if (!runner.implementationPlan) {
      throw new Error('구현 계획이 없어 구현을 시작할 수 없습니다');
    }

    const branchState = await ensureBranch(repo.getTask(taskId), workspace);
    const branchName = branchState.branchName;
    updateTaskProgress(taskId, '구현 브랜치를 준비했습니다', {
      branch: branchName,
      baseBranch: workspace.git.baseBranch,
      restoreBranch: branchState.restoreBranch
    });

    const chunks = runner.implementationPlan.taskBreakdown.map((entry, index) => normalizeChunk(entry, index));
    const chunkTotal = chunks.length;
    // 이미 완료(committed)된 chunk는 id로 매칭해 보존한다(계획 패치로 chunk 수가 바뀌어도 재구현하지 않도록).
    const chunkStates = chunks.map((chunk) => {
      const prior = runner.chunks.find((entry) => normalizeWhitespace(asRecord(entry).id) === chunk.id);
      if (prior && normalizeWhitespace(asRecord(prior).status) === 'committed') {
        return prior;
      }
      return { id: chunk.id, title: chunk.title, status: 'pending' };
    });

    for (let index = 0; index < chunkTotal; index += 1) {
      if (normalizeWhitespace(chunkStates[index]?.status) === 'committed') {
        continue;
      }
      const chunk = chunks[index];
      updateExecutionProgress(taskId, `chunk ${index + 1}/${chunkTotal}을 구현하는 중입니다`, {
        phase: 'execution',
        label: `구현 chunk ${index + 1}/${chunkTotal}: ${chunk.title}`,
        currentStep: 4,
        chunkIndex: index + 1,
        chunkTotal
      }, {
        branch: branchName
      });
      const chunkResult = await runChunk(taskId, workspace, runner.requirementContract, runner.implementationPlan, chunk, index, chunkTotal);
      chunkStates[index] = chunkResult;
      patchRunnerState(taskId, { chunks: chunkStates });

      // Plan Patch Loop: 실행자가 계획 불일치를 보고하면 계획 패치 게이트에서 멈춘다.
      if (normalizeWhitespace(chunkResult.status) === 'plan_patch_requested') {
        pauseForPlanPatchGate(taskId, chunkResult.planPatchRequest);
        return { paused: true };
      }

      // Gate 3: 위험 변경이 감지되고 아직 승인되지 않았다면 멈춘다.
      if (repo.getTask(taskId)?.payload?.riskApproved !== true) {
        const risk = await detectRiskSignals(workspace);
        if (risk.risky) {
          pauseForRiskGate(taskId, risk);
          return { paused: true };
        }
      }
    }

    const remainingKnownIssues = chunkStates.flatMap((state) => safeArray(state?.remainingKnownIssues));
    patchRunnerState(taskId, {
      chunks: chunkStates,
      remainingKnownIssues
    });
    return { paused: false };
  }

  async function runFinalValidation(taskId, workspace) {
    const task = repo.getTask(taskId);
    const runner = loadRunnerState(taskId, task);
    const commits = await listCommitsSince(workspace.git.root, workspace.git.baseBranch);
    const commitSummary = commits.map((commit) => `${commit.subject} (${commit.sha.slice(0, 7)})`);

    updateExecutionProgress(taskId, '최종 검증을 진행하는 중입니다', {
      phase: 'validation',
      label: '최종 검증',
      currentStep: 5
    }, {
      commits
    });

    const agent = getAgentRunner(task.payload?.agentProvider);
    const validationPrompt = buildFinalValidationPrompt({
      task,
      workspace,
      contract: runner.requirementContract,
      commitSummary
    });
    const validationResponse = await agent.runner.runExec({
      workdir: workspace.git.root,
      prompt: validationPrompt,
      sandboxMode: 'read-only',
      schema: finalValidationSchema
    });
    const finalValidation = normalizeFinalValidation(validationResponse.parsed);
    storeArtifact(taskId, 'final_validation', '최종 검증', finalValidation);
    patchRunnerState(taskId, { finalValidation });
    repo.logExecution(taskId, 'run_final_validation', 'success', {
      response: {
        ...finalValidation,
        agentProvider: agent.provider,
        durationMs: validationResponse.durationMs
      }
    });
    return finalValidation;
  }

  function knownIssuesToStrings(issues) {
    return compactStrings(safeArray(issues).map((issue) => {
      if (typeof issue === 'string') {
        return issue;
      }
      const record = asRecord(issue);
      return normalizeWhitespace(record.title || record.action || record.description);
    }));
  }

  // 완료 후 개선 루프(Refinement Loop): 승인된 계약/계획 프레임 안의 개선점을 최대 MAX_REFINEMENT_ITERATIONS회 자동 반영.
  // 승인 게이트 없이(autopilot) 진행하되, 프레임 초과/진행 없음/개선 없음에서 즉시 종료한다.
  async function runRefinementLoop(taskId, workspace, initialValidation) {
    let finalValidation = initialValidation;
    let previousUnresolved = Number.POSITIVE_INFINITY;
    const refinements = [];

    for (let iteration = 1; iteration <= MAX_REFINEMENT_ITERATIONS; iteration += 1) {
      const task = repo.getTask(taskId);
      const runner = loadRunnerState(taskId, task);
      if (!runner.requirementContract || !runner.implementationPlan) {
        break;
      }

      updateExecutionProgress(taskId, `완료 후 개선 루프 ${iteration}/${MAX_REFINEMENT_ITERATIONS} 결과를 점검하는 중입니다`, {
        phase: 'refinement',
        label: `개선 루프 ${iteration}/${MAX_REFINEMENT_ITERATIONS}: 결과 점검`,
        currentStep: 5
      });

      const inspectAgent = getAgentRunner(task.payload?.agentProvider);
      const inspectPrompt = buildRefinementInspectionPrompt({
        task,
        workspace,
        contract: runner.requirementContract,
        plan: runner.implementationPlan,
        finalValidation,
        remainingKnownIssues: knownIssuesToStrings(runner.remainingKnownIssues),
        iteration,
        maxIterations: MAX_REFINEMENT_ITERATIONS
      });
      const inspectResponse = await inspectAgent.runner.runExec({
        workdir: workspace.git.root,
        prompt: inspectPrompt,
        sandboxMode: 'read-only',
        schema: refinementDecisionSchema
      });
      const decision = asRecord(inspectResponse.parsed);
      const improvementFound = Boolean(decision.improvementFound);
      const inFrame = Boolean(decision.inFrame);
      const unresolvedCount = toInteger(decision.unresolvedCount, 0);
      const rationale = normalizeWhitespace(decision.rationale);
      const chunkSource = asRecord(decision.chunk);

      storeArtifact(taskId, 'refinement_round', `개선 루프 ${iteration} 점검`, {
        iteration,
        improvementFound,
        inFrame,
        unresolvedCount,
        rationale
      });
      repo.logExecution(taskId, 'run_refinement_inspection', 'success', {
        response: { iteration, improvementFound, inFrame, unresolvedCount }
      });

      if (!improvementFound) {
        refinements.push({ iteration, status: 'no_improvement', rationale });
        break;
      }
      if (!inFrame) {
        // 프레임 초과 개선은 자율 루프 대상이 아니다 → 남은 이슈로 기록하고 종료(escalation_exit).
        refinements.push({ iteration, status: 'frame_exceeding', rationale });
        const known = safeArray(loadRunnerState(taskId, repo.getTask(taskId)).remainingKnownIssues);
        patchRunnerState(taskId, {
          remainingKnownIssues: [...known, {
            severity: 'P2',
            title: '프레임 초과 개선 제안',
            description: rationale,
            fileRefs: [],
            action: '사용자 승인 후 별도 작업으로 진행 권장'
          }]
        });
        break;
      }
      if (unresolvedCount >= previousUnresolved) {
        // no_progress_exit: 미해결 개선 수가 줄지 않으면 한도 전이라도 종료.
        refinements.push({ iteration, status: 'no_progress', rationale });
        break;
      }
      previousUnresolved = unresolvedCount;

      const chunk = normalizeChunk({
        id: normalizeWhitespace(chunkSource.id) || `refine_${iteration}`,
        title: `[개선] ${normalizeWhitespace(chunkSource.title) || rationale || '추가 개선'}`,
        acceptanceCriteria: chunkSource.acceptanceCriteria
      }, iteration - 1);

      const existingChunks = loadRunnerState(taskId, repo.getTask(taskId)).chunks.slice();
      updateExecutionProgress(taskId, `개선 루프 ${iteration}/${MAX_REFINEMENT_ITERATIONS}를 구현하는 중입니다`, {
        phase: 'refinement',
        label: `개선 루프 ${iteration}/${MAX_REFINEMENT_ITERATIONS}: ${chunk.title}`,
        currentStep: 5,
        chunkIndex: existingChunks.length + 1,
        chunkTotal: existingChunks.length + 1
      });

      const chunkResult = await runChunk(
        taskId,
        workspace,
        runner.requirementContract,
        runner.implementationPlan,
        chunk,
        existingChunks.length,
        existingChunks.length + 1
      );
      patchRunnerState(taskId, { chunks: [...existingChunks, chunkResult] });
      refinements.push({ iteration, status: 'applied', rationale, chunkId: chunk.id, title: chunk.title });

      // 개선 반영 후 최종 검증을 재실행하고 다시 점검(loop).
      finalValidation = await runFinalValidation(taskId, workspace);
    }

    patchRunnerState(taskId, { refinements });
    return finalValidation;
  }

  async function completeTask(taskId, workspace, finalValidation) {
    const task = repo.getTask(taskId);
    const runner = loadRunnerState(taskId, task);
    const result = asRecord(task.result);
    const branchName = normalizeWhitespace(result.branch || task.payload?.branchName);
    const commits = await listCommitsSince(workspace.git.root, workspace.git.baseBranch);
    const commitSummary = commits.map((commit) => `${commit.subject} (${commit.sha.slice(0, 7)})`);

    const pullRequest = await codeTaskPlanner.createPullRequestDraft({
      task: repo.getTask(taskId),
      workspace,
      commitSummary,
      contract: runner.requirementContract
    });
    storeArtifact(taskId, 'pr_summary', 'PR 초안', pullRequest);
    repo.logExecution(taskId, 'prepare_pr', 'success', {
      response: pullRequest
    });

    const sourceCommit = normalizeWhitespace(await runGit(workspace.git.root, ['rev-parse', 'HEAD']));
    const hasRemote = Boolean(normalizeWhitespace(workspace.git.remoteUrl));
    const workspaceCleanup = await cleanupTaskWorkspaceBranch(taskId, workspace, {
      workBranch: branchName,
      preferredRestoreBranch: normalizeWhitespace(result.restoreBranch) || workspace.git.baseBranch,
      deleteWorkBranch: false
    });
    const completionSummary = hasRemote
      ? `${branchName} 브랜치에서 runner 워크플로가 완료되었습니다. 작업 브랜치는 유지되며 PR 생성을 진행할 수 있습니다.`
      : `${branchName} 브랜치에서 runner 워크플로가 완료되었습니다. 원격 저장소(origin)가 없어 PR 생성 단계 없이 종료합니다.`;

    repo.updateTask(taskId, {
      status: hasRemote ? 'awaiting_approval' : 'done',
      approvalState: hasRemote ? 'pending' : 'approved',
      summary: completionSummary,
      result: {
        ...asRecord(repo.getTask(taskId)?.result),
        branch: branchName,
        baseBranch: workspace.git.baseBranch,
        sourceCommit,
        restoreBranch: workspaceCleanup.restoreBranch || normalizeWhitespace(result.restoreBranch) || workspace.git.baseBranch,
        branchCleanup: workspaceCleanup,
        repoSlug: workspace.git.repoSlug,
        remoteUrl: workspace.git.remoteUrl,
        hasRemote,
        canCreatePullRequest: hasRemote,
        commits,
        pullRequest,
        finalValidation,
        executionProgress: buildExecutionProgress({
          phase: 'completed',
          label: 'runner 워크플로 완료',
          currentStep: CODE_EXECUTION_TOTAL_STEPS
        })
      },
      lastError: null
    });
  }

  async function runFromStage(taskId, fromStage: RunnerStage) {
    let stage: RunnerStage = fromStage;

    if (stage === 'workspace') {
      await prepareWorkspaceStage(taskId);
      stage = 'spec';
    }

    if (stage === 'spec') {
      await runSpecStage(taskId);
      applyGate(taskId, 'spec');
      return;
    }

    if (stage === 'plan') {
      await runPlanStage(taskId);
      applyGate(taskId, 'plan');
      return;
    }

    if (stage === 'execution' || stage === 'validation') {
      // 작업공간은 이 구간에서 한 번만 점검한다. chunk 커밋 이후 재점검하면 미커밋 base 브랜치에서 resolveBaseBranch가 실패할 수 있다.
      const task = repo.getTask(taskId);
      const workspace = await inspectWorkspace(task.payload?.workdir, task.payload?.baseBranch);
      if (stage === 'execution') {
        const outcome = await runExecutionStage(taskId, workspace);
        if (outcome?.paused) {
          // 위험/계획패치 게이트에서 승인 대기 중 → 검증/완료로 진행하지 않는다.
          return;
        }
      }
      let finalValidation = await runFinalValidation(taskId, workspace);
      finalValidation = await runRefinementLoop(taskId, workspace, finalValidation);
      await completeTask(taskId, workspace, finalValidation);
    }
  }

  function launchRun(taskId, fromStage: RunnerStage) {
    if (activeRuns.has(taskId)) {
      return { started: false };
    }
    activeRuns.add(taskId);

    const runPromise = runFromStage(taskId, fromStage);

    runPromise.catch((error) => {
      const formattedError = formatExecutionError(error);
      const currentTask = repo.getTask(taskId);
      const currentResult = asRecord(currentTask?.result);
      const previousProgress = asRecord(currentResult.executionProgress);
      repo.updateTask(taskId, {
        status: 'failed',
        summary: 'runner 워크플로 실행 중 오류가 발생했습니다. 오류를 확인한 뒤 다시 실행해 주세요.',
        result: {
          ...currentResult,
          executionProgress: buildExecutionProgress({
            phase: 'failed',
            label: 'runner 워크플로 실행 중 오류가 발생했습니다.',
            currentStep: toInteger(previousProgress.currentStep, 0),
            totalSteps: toInteger(previousProgress.totalSteps, CODE_EXECUTION_TOTAL_STEPS),
            gate: GATE_VALUES.includes(previousProgress.gate as RunnerGate) ? previousProgress.gate : '',
            chunkIndex: toInteger(previousProgress.chunkIndex, 0),
            chunkTotal: toInteger(previousProgress.chunkTotal, 0)
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

  async function runTask(taskId, options: { resumeFromCheckpoint?: boolean } = {}) {
    const task = repo.getTask(taskId);
    if (!task || task.domain !== 'code_execution') {
      throw new Error(`작업을 찾을 수 없습니다: ${taskId}`);
    }
    const fromStage: RunnerStage = options.resumeFromCheckpoint ? resolveResumeStage(task) : 'workspace';
    return launchRun(taskId, fromStage);
  }

  async function approveGate(taskId, options: { gate?: string; decision?: string; feedback?: string } = {}) {
    const task = repo.getTask(taskId);
    if (!task || task.domain !== 'code_execution') {
      throw new Error(`작업을 찾을 수 없습니다: ${taskId}`);
    }
    const currentGate = normalizeWhitespace(asRecord(asRecord(task.result).executionProgress).gate);
    const requestedGate = normalizeWhitespace(options.gate) || currentGate;
    if (normalizeTaskStatus(task.status) !== 'awaiting_approval' || !GATE_VALUES.includes(currentGate as RunnerGate)) {
      throw new Error('현재 승인 가능한 게이트가 없습니다');
    }
    if (requestedGate !== currentGate) {
      throw new Error(`현재 대기 중인 게이트가 아닙니다: ${requestedGate}`);
    }

    const decision = normalizeWhitespace(options.decision).toLowerCase() || 'approve';

    // Gate 3(위험 변경 승인): 승인 시 위험 승인 플래그를 세우고 실행 재개, 거부 시 중단.
    if (currentGate === 'risk') {
      if (decision === 'reject') {
        repo.updateTask(taskId, {
          status: 'failed',
          summary: '위험 변경이 거부되어 작업을 중단했습니다. 작업 브랜치를 확인한 뒤 다시 진행해 주세요.',
          lastError: '위험 변경 거부로 중단됨'
        });
        repo.logExecution(taskId, 'reject_risk_gate', 'success');
        return { started: false };
      }
      repo.updateTask(taskId, {
        payload: { ...asRecord(task.payload), riskApproved: true }
      });
      repo.logExecution(taskId, 'approve_risk_gate', 'success');
      return launchRun(taskId, 'execution');
    }

    // 계획 패치 승인: 승인 시 패치 요청을 계획 재생성 피드백으로 넣고 계획 게이트(Gate 2)로 되돌린다.
    if (currentGate === 'plan_patch') {
      if (decision === 'reject') {
        repo.updateTask(taskId, {
          status: 'failed',
          summary: '계획 패치가 거부되어 작업을 중단했습니다.',
          lastError: '계획 패치 거부로 중단됨'
        });
        repo.logExecution(taskId, 'reject_plan_patch', 'success');
        return { started: false };
      }
      const runnerRaw = asRecord(asRecord(task.result).runner);
      const patch = asRecord(runnerRaw.planPatchRequest);
      const committedChunks = safeArray(runnerRaw.chunks)
        .filter((entry) => normalizeWhitespace(asRecord(entry).status) === 'committed')
        .map((entry) => `${normalizeWhitespace(asRecord(entry).id)}: ${normalizeWhitespace(asRecord(entry).title)}`);
      const feedback = [
        '실행 중 계획 불일치가 보고되어 구현 계획을 갱신합니다. 아래 패치 요청을 반영해 계획을 다시 작성하세요.',
        `불일치 사유: ${normalizeWhitespace(patch.reason)}`,
        `제안된 변경: ${normalizeWhitespace(patch.proposedChange)}`,
        committedChunks.length > 0
          ? `이미 완료(committed)된 chunk는 동일한 id와 title을 그대로 유지하고, 미완료 부분만 조정하세요: ${committedChunks.join(' | ')}`
          : ''
      ].filter(Boolean).join('\n');
      repo.updateTask(taskId, {
        payload: {
          ...asRecord(task.payload),
          gateFeedback: {
            ...asRecord(asRecord(task.payload).gateFeedback),
            plan: feedback
          }
        }
      });
      storeArtifact(taskId, 'plan_patch_history', '계획 패치 요청', {
        ...patch,
        committedChunks
      });
      repo.logExecution(taskId, 'approve_plan_patch', 'success', { request: { patch } });
      return launchRun(taskId, 'plan');
    }

    if (decision === 'regenerate') {
      // 사용자가 입력한 수정 요청을 payload에 저장해 다음 재생성 프롬프트에 반영한다.
      const feedback = normalizeWhitespace(options.feedback);
      repo.updateTask(taskId, {
        payload: {
          ...asRecord(task.payload),
          gateFeedback: {
            ...asRecord(asRecord(task.payload).gateFeedback),
            [currentGate]: feedback
          }
        }
      });
      repo.logExecution(taskId, 'regenerate_gate', 'success', { request: { gate: currentGate, feedback } });
      return launchRun(taskId, currentGate as RunnerStage);
    }

    repo.logExecution(taskId, 'approve_gate', 'success', { request: { gate: currentGate } });
    if (currentGate === 'spec') {
      return launchRun(taskId, 'plan');
    }
    return launchRun(taskId, 'execution');
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
      if (!normalizeWhitespace(workspace.git.remoteUrl)) {
        throw new Error('원격 저장소(origin)가 연결되지 않아 PR을 생성할 수 없습니다.');
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
        commitSummary: safeArray(task.result?.commits).map((commit) => `${commit.subject} (${commit.sha.slice(0, 7)})`),
        contract: asRecord(asRecord(task.result).runner).requirementContract || null
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
        deleteWorkBranch: false
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
    approveGate,
    start: runTask,
    createPullRequest
  };
}
