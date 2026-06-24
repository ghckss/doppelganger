import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeWhitespace, safeArray, truncateText } from '../core/utils.ts';
import { buildSlackStyleGuide, SLACK_STYLE_MEMORY_STATE_KEY } from '../modules/slack/slack-style-memory.ts';

const CODE_REVIEW_STATUS = {
  NOT_CANDIDATE: 'not_candidate',
  NOT_REQUESTED: 'not_requested',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed'
};
const CODE_ANALYSIS_BASE_BRANCH = 'master';
const CODE_REVIEW_PROGRESS_TOTAL_STEPS = 6;
const SLACK_DRAFT_AGENT_PROVIDER = 'claude';
const SLACK_DRAFT_MODEL = 'claude-haiku';
const SLACK_DRAFT_PROVIDER_BACKOFF_MS = 10 * 60 * 1000;
const SERVICE_REFERENCE_DOC_GROUPS = {
  fromm: [
    'backoffice.md',
    'partner.md',
    'channel.md',
    'store.md'
  ],
  kiwee: [
    'README.md',
    'api-reference.md',
    'architecture.md',
    'kiwee-admin.md',
    'kiwee-app.md',
    'kiwee-web.md'
  ]
};

const SLACK_CODE_REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'replyHints', 'findings'],
  properties: {
    summary: {
      type: 'string'
    },
    replyHints: {
      type: 'array',
      items: {
        type: 'string'
      }
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'line', 'excerpt', 'reason'],
        properties: {
          path: {
            type: 'string'
          },
          line: {
            type: 'number'
          },
          excerpt: {
            type: 'string'
          },
          reason: {
            type: 'string'
          }
        }
      }
    }
  }
};

const SLACK_CODE_SCOPE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['selectedFolder', 'rationale', 'investigationPlan'],
  properties: {
    selectedFolder: {
      type: 'string'
    },
    rationale: {
      type: 'string'
    },
    investigationPlan: {
      type: 'string'
    }
  }
};

function buildThreadFingerprint(messages) {
  const payload = messages.map((message) => ({
    externalId: message.externalId,
    content: message.content,
    user: message.metadata?.user || ''
  }));

  return crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex');
}

function compactStrings(values, limit = 20) {
  return [...new Set(
    safeArray(values)
      .map((item) => normalizeWhitespace(item))
      .filter(Boolean)
  )].slice(0, limit);
}

function normalizeRepoName(value) {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return '';
  }
  const parts = normalized.split('/').filter(Boolean);
  return parts.at(-1) || normalized;
}

function normalizeChannelToken(value) {
  return normalizeWhitespace(value)
    .replace(/^#/, '')
    .toLowerCase();
}

function buildIgnoredChannelSet(config) {
  return new Set(
    compactStrings(config.slack?.ignoreChannels || [], 200)
      .map((item) => normalizeChannelToken(item))
      .filter(Boolean)
  );
}

function shouldIgnoreMentionChannel(match, ignoredChannels) {
  if (!ignoredChannels || ignoredChannels.size === 0) {
    return false;
  }

  const candidates = [
    match.channelId,
    match.channelName
  ]
    .map((value) => normalizeChannelToken(value))
    .filter(Boolean);

  return candidates.some((candidate) => ignoredChannels.has(candidate));
}

function normalizeCodeReviewState(previousState, threadFingerprint) {
  const previous = previousState && typeof previousState === 'object' ? previousState : null;
  if (!previous) {
    return {
      enabled: false,
      analysisStatus: CODE_REVIEW_STATUS.NOT_REQUESTED,
      progressStep: 0,
      progressTotalSteps: 0,
      progressPercent: 0,
      progressLabel: '',
      selectedRepo: '',
      selectedRepoSlug: '',
      selectedFolder: '',
      candidateRepos: [],
      matchedKeywords: [],
      matchedRules: [],
      scoreReasons: [],
      selectionReason: '코드 검토를 실행하면 에이전트가 스레드 문맥으로 저장소/폴더를 자동 선택합니다.',
      scopeRationale: '',
      scopeInvestigationPlan: '',
      scopeSource: '',
      threadFingerprint,
      summary: '',
      replyHints: [],
      findings: [],
      analysisAgentProvider: '',
      analysisBaseBranch: CODE_ANALYSIS_BASE_BRANCH,
      requestDriftGuard: {
        retried: false,
        retryCount: 0,
        detected: false,
        reason: ''
      },
      analyzedAt: '',
      workspacePath: '',
      error: ''
    };
  }

  if (previous.threadFingerprint === threadFingerprint) {
    return {
      ...previous,
      threadFingerprint
    };
  }

  return {
    ...previous,
    analysisStatus: CODE_REVIEW_STATUS.NOT_REQUESTED,
    progressStep: 0,
    progressTotalSteps: 0,
    progressPercent: 0,
    progressLabel: '',
    threadFingerprint,
    selectedFolder: '',
    selectedRepoSlug: '',
    scopeRationale: '',
    scopeInvestigationPlan: '',
    scopeSource: '',
    summary: '',
    replyHints: [],
    findings: [],
    analysisAgentProvider: '',
    analysisBaseBranch: CODE_ANALYSIS_BASE_BRANCH,
    requestDriftGuard: {
      retried: false,
      retryCount: 0,
      detected: false,
      reason: ''
    },
    analyzedAt: '',
    workspacePath: '',
    error: ''
  };
}

const IGNORED_REPOSITORY_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.yarn',
  '.pnpm-store',
  'coverage'
]);

function normalizeRelativeFolder(value) {
  const normalized = normalizeWhitespace(value)
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^\.\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/\/+$/, '');
  if (!normalized || normalized === '.') {
    return '';
  }

  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return '';
  }
  return segments.join('/');
}

function normalizeSearchableText(value) {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizeSearchToken(value) {
  return normalizeSearchableText(value).replace(/[^a-z0-9가-힣]+/g, '');
}

function createCodeReviewProgress({ step = 0, total = 0, label = '' }: { step?: number; total?: number; label?: string } = {}) {
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  const safeStepRaw = Number.isFinite(step) ? Math.floor(step) : 0;
  const safeStep = safeTotal > 0
    ? Math.max(0, Math.min(safeStepRaw, safeTotal))
    : Math.max(0, safeStepRaw);
  const percent = safeTotal > 0
    ? Math.round((safeStep / safeTotal) * 100)
    : 0;
  return {
    progressStep: safeStep,
    progressTotalSteps: safeTotal,
    progressPercent: Math.max(0, Math.min(percent, 100)),
    progressLabel: normalizeWhitespace(label)
  };
}

function resolveCodeReviewTimeoutSeconds(config) {
  const raw = Number(config?.slack?.codeReviewTimeoutSeconds);
  if (!Number.isFinite(raw)) {
    return 0;
  }
  if (raw <= 0) {
    return 0;
  }
  return Math.max(1, Math.floor(raw));
}

function autoSelectCodeReviewRepository({
  task,
  threadMessages,
  configuredRepos,
  previousSelectedRepo = ''
}) {
  const normalizedRepos = compactStrings(configuredRepos, 100)
    .map((repoName) => normalizeRepoName(repoName))
    .filter(Boolean);
  if (normalizedRepos.length === 0) {
    return {
      selectedRepo: '',
      candidateRepos: [],
      matchedKeywords: [],
      matchedRules: [],
      scoreReasons: [],
      selectionReason: '자동 선택할 저장소가 없습니다. GITHUB_REPOSITORIES 설정을 확인하세요.'
    };
  }

  const corpus = normalizeSearchableText([
    task.payload?.channelName,
    task.payload?.text,
    ...safeArray(threadMessages).map((message) => message.content)
  ].join(' '));
  const compactCorpus = normalizeSearchToken(corpus);

  const scored = normalizedRepos.map((repoName, index) => {
    const lowerRepo = repoName.toLowerCase();
    const repoToken = normalizeSearchToken(repoName);
    const reasons = [];
    const matchedRules = [];
    const matchedKeywords = [];
    let score = Math.max(1, normalizedRepos.length - index);

    if (repoToken && compactCorpus.includes(repoToken)) {
      score += 10;
      reasons.push('스레드/멘션 본문에 저장소명이 직접 언급되었습니다.');
      matchedRules.push('repo_name_direct');
      matchedKeywords.push(repoName);
    }
    if (lowerRepo.includes('fromm') && (corpus.includes('fromm') || corpus.includes('프롬'))) {
      score += 6;
      reasons.push('스레드에 fromm/프롬 맥락이 있어 fromm 계열 저장소 점수가 높습니다.');
      matchedRules.push('family_fromm');
      matchedKeywords.push('fromm');
    }
    if (lowerRepo.includes('kiwee') && (corpus.includes('kiwee') || corpus.includes('키위'))) {
      score += 6;
      reasons.push('스레드에 kiwee/키위 맥락이 있어 kiwee 계열 저장소 점수가 높습니다.');
      matchedRules.push('family_kiwee');
      matchedKeywords.push('kiwee');
    }
    if (normalizeRepoName(previousSelectedRepo) === repoName) {
      score += 2;
      reasons.push('직전 분석에서 선택된 저장소와 동일하여 우선순위를 약간 높였습니다.');
      matchedRules.push('previous_selection');
    }

    return {
      repo: repoName,
      score,
      reasons: compactStrings(reasons, 4),
      matchedRules: compactStrings(matchedRules, 6),
      matchedKeywords: compactStrings(matchedKeywords, 6),
      index
    };
  });

  scored.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.index - right.index;
  });

  const selected = scored[0];
  const selectionReason = selected.reasons.length > 0
    ? `${selected.repo} 저장소를 자동 선택했습니다. 근거: ${selected.reasons.join(' ')}`
    : `${selected.repo} 저장소를 자동 선택했습니다. 문맥 단서가 뚜렷하지 않아 설정 순서를 우선 적용했습니다.`;

  return {
    selectedRepo: selected.repo,
    candidateRepos: scored.map((candidate) => ({
      repo: candidate.repo,
      score: candidate.score
    })),
    matchedKeywords: selected.matchedKeywords,
    matchedRules: selected.matchedRules,
    scoreReasons: selected.reasons,
    selectionReason
  };
}

function readTextFileSnippet(filePath, maxChars = 900) {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return '';
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const normalized = String(raw || '')
      .replace(/\r/g, '')
      .replace(/\t/g, '  ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!normalized) {
      return '';
    }
    return truncateText(normalized, maxChars);
  } catch {
    return '';
  }
}

function listTopLevelDirectories(repoRoot, limit = 20) {
  try {
    const entries = fs.readdirSync(repoRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    return entries.slice(0, limit);
  } catch {
    return [];
  }
}

function readWorkspaceGlobsFromPackageJson(repoRoot) {
  const packageJsonPath = path.join(repoRoot, 'package.json');
  try {
    if (!fs.existsSync(packageJsonPath)) {
      return [];
    }
    const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const workspaces = parsed?.workspaces;
    if (Array.isArray(workspaces)) {
      return compactStrings(workspaces, 20);
    }
    if (workspaces && Array.isArray(workspaces.packages)) {
      return compactStrings(workspaces.packages, 20);
    }
    return [];
  } catch {
    return [];
  }
}

function readWorkspaceGlobsFromPnpm(repoRoot) {
  const pnpmWorkspacePath = path.join(repoRoot, 'pnpm-workspace.yaml');
  try {
    if (!fs.existsSync(pnpmWorkspacePath)) {
      return [];
    }
    const lines = fs.readFileSync(pnpmWorkspacePath, 'utf8').split(/\r?\n/);
    const patterns = [];
    for (const line of lines) {
      const match = line.match(/^\s*-\s*['"]?([^'"]+)['"]?\s*$/);
      if (!match) {
        continue;
      }
      patterns.push(match[1]);
    }
    return compactStrings(patterns, 20);
  } catch {
    return [];
  }
}

function resolveServiceReferenceDocGroup(selectedRepo) {
  const normalizedRepo = normalizeRepoName(selectedRepo).toLowerCase();
  if (normalizedRepo.includes('fromm')) {
    return 'fromm';
  }
  if (normalizedRepo.includes('kiwee')) {
    return 'kiwee';
  }
  return '';
}

function buildRepositoryContextSnapshot(repoRoot, { config, selectedRepo }) {
  const lines = [];
  const topDirectories = listTopLevelDirectories(repoRoot, 24);
  if (topDirectories.length > 0) {
    lines.push(`상위 디렉터리: ${topDirectories.join(', ')}`);
  } else {
    lines.push('상위 디렉터리: (확인 불가)');
  }

  const workspaceGlobs = compactStrings([
    ...readWorkspaceGlobsFromPackageJson(repoRoot),
    ...readWorkspaceGlobsFromPnpm(repoRoot)
  ], 20);
  if (workspaceGlobs.length > 0) {
    lines.push(`워크스페이스 패턴: ${workspaceGlobs.join(', ')}`);
  } else {
    lines.push('워크스페이스 패턴: (없음)');
  }

  const docGroup = resolveServiceReferenceDocGroup(selectedRepo);
  const serviceDocFiles = SERVICE_REFERENCE_DOC_GROUPS[docGroup] || [];
  const docsRoot = path.join(path.resolve(config?.cwd || process.cwd()), 'docs');
  const docsDir = docGroup ? path.join(docsRoot, docGroup) : docsRoot;

  if (!docGroup) {
    lines.push('서비스 기준 문서: (저장소명 기준 문서 그룹을 찾지 못했습니다. fromm/kiwee 규칙을 확인하세요)');
    return truncateText(lines.join('\n'), 9000);
  }

  lines.push(`서비스 기준 문서 그룹: ${docGroup}`);
  for (const docName of serviceDocFiles) {
    const docPath = path.join(docsDir, docName);
    const snippet = readTextFileSnippet(docPath, 1500);
    const relativeDocPath = path.posix.join('docs', docGroup, docName);
    if (!snippet) {
      lines.push(`- ${relativeDocPath} (문서를 읽지 못했거나 비어 있습니다)`);
      continue;
    }
    lines.push(`- ${relativeDocPath}`);
    lines.push(snippet);
  }

  return truncateText(lines.join('\n'), 9000);
}

function resolveRepositoryWorkdir({ config, workspaceRunner, selectedRepo, selectedFolder = '' }) {
  if (!workspaceRunner?.assertAllowed) {
    throw new Error('작업공간 실행기가 설정되지 않아 코드 검토를 실행할 수 없습니다');
  }

  const repoName = normalizeRepoName(selectedRepo);
  if (!repoName) {
    throw new Error('자동 선택된 저장소가 없습니다');
  }

  const candidates = [];
  if (path.isAbsolute(selectedRepo)) {
    candidates.push(selectedRepo);
  }

  const projectsRoot = normalizeWhitespace(config.workspace?.projectsRoot || '');
  if (projectsRoot) {
    candidates.push(path.join(projectsRoot, repoName));
  }

  for (const allowRoot of safeArray(config.workspace?.allowlist)) {
    const resolvedRoot = path.resolve(allowRoot);
    candidates.push(path.join(resolvedRoot, repoName));
    if (path.basename(resolvedRoot) === repoName) {
      candidates.push(resolvedRoot);
    }
  }

  const uniqueCandidates = [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
  for (const candidate of uniqueCandidates) {
    if (!fs.existsSync(candidate)) {
      continue;
    }
    if (!fs.existsSync(path.join(candidate, '.git'))) {
      continue;
    }
    const repoRoot = workspaceRunner.assertAllowed(candidate);
    const folder = normalizeWhitespace(selectedFolder);
    if (!folder) {
      return repoRoot;
    }

    const folderPath = path.isAbsolute(folder)
      ? path.resolve(folder)
      : path.resolve(repoRoot, folder);
    if (!fs.existsSync(folderPath)) {
      throw new Error(`설정된 코드 검토 폴더를 찾지 못했습니다: ${folder}`);
    }
    if (!fs.statSync(folderPath).isDirectory()) {
      throw new Error(`설정된 코드 검토 폴더가 디렉터리가 아닙니다: ${folder}`);
    }
    return workspaceRunner.assertAllowed(folderPath);
  }

  throw new Error(`선택된 저장소 경로를 찾지 못했습니다: ${repoName}`);
}

async function createMasterAnalysisWorkspace({
  workspaceRunner,
  repoRoot,
  baseBranch = CODE_ANALYSIS_BASE_BRANCH
}) {
  if (!workspaceRunner?.run) {
    return {
      analysisRoot: repoRoot,
      cleanup: async () => {}
    };
  }

  try {
    await workspaceRunner.run('git', ['rev-parse', '--verify', `${baseBranch}^{commit}`], {
      workdir: repoRoot
    });
  } catch {
    throw new Error(`분석 기준 브랜치(${baseBranch})를 찾지 못했습니다. 저장소에 ${baseBranch} 브랜치가 있는지 확인해주세요.`);
  }

  const workspaceDir = path.join(
    repoRoot,
    '.doppelganger-analysis-worktrees',
    `${baseBranch}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
  );
  fs.mkdirSync(path.dirname(workspaceDir), { recursive: true });
  await workspaceRunner.run('git', ['worktree', 'add', '--detach', workspaceDir, baseBranch], {
    workdir: repoRoot
  });

  const analysisRoot = workspaceRunner.assertAllowed(workspaceDir);
  return {
    analysisRoot,
    cleanup: async () => {
      try {
        await workspaceRunner.run('git', ['worktree', 'remove', '--force', workspaceDir], {
          workdir: repoRoot
        });
      } catch {
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      }
    }
  };
}

function resolveAnalysisFolderWorkdir({ workspaceRunner, analysisRoot, selectedFolder }) {
  if (!selectedFolder) {
    return analysisRoot;
  }

  const folderPath = path.resolve(analysisRoot, selectedFolder);
  if (!fs.existsSync(folderPath)) {
    throw new Error(`설정된 코드 검토 폴더를 찾지 못했습니다: ${selectedFolder}`);
  }
  if (!fs.statSync(folderPath).isDirectory()) {
    throw new Error(`설정된 코드 검토 폴더가 디렉터리가 아닙니다: ${selectedFolder}`);
  }

  return workspaceRunner.assertAllowed(folderPath);
}

function normalizeAgentProvider(value, fallback = 'codex') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'codex' || normalized === 'claude') {
    return normalized;
  }
  return fallback;
}

function buildSlackThreadTranscript(messages) {
  return safeArray(messages)
    .map((message, index) => {
      const author = message.metadata?.userName || message.metadata?.user || 'unknown';
      return `${index + 1}. [${author}] ${normalizeWhitespace(message.content)}`;
    })
    .join('\n');
}

function buildAgentCodeScopePrompt({ task, threadMessages, selectedRepo, repositorySnapshot }) {
  const targetMention = normalizeWhitespace(task.payload?.text || '');
  const channel = normalizeWhitespace(task.payload?.channelName || task.payload?.channelId || 'unknown');

  return [
    '당신은 Slack 멘션 대응을 위한 코드 조회 범위 선정 에이전트다.',
    '스레드 대화와 저장소 문서를 읽고, 지금 확인할 서비스/폴더 범위를 추론한다.',
    '고정 키워드 매핑 규칙(slack-code-keywords) 없이 문맥과 문서만으로 판단한다.',
    '질문이 "무엇이 있는지/어떤 상품인지/정책이 무엇인지" 같은 정보 파악 요청이면 API 호출 경로보다 도메인 정의/상품 데이터/정책 문서를 우선 조사한다.',
    '불확실하면 잘못된 폴더를 추측하지 말고 selectedFolder를 빈 문자열로 두어 저장소 루트를 선택한다.',
    '',
    '## 작업 정보',
    `- 저장소: ${selectedRepo}`,
    `- 분석 기준 브랜치: ${CODE_ANALYSIS_BASE_BRANCH}`,
    `- 채널: ${channel}`,
    `- 대상 멘션: ${targetMention || '(없음)'}`,
    '',
    '## 스레드',
    buildSlackThreadTranscript(threadMessages),
    '',
    '## 저장소 구조 + 서비스 기준 문서 그룹(fromm 또는 kiwee)',
    repositorySnapshot || '(문서 스냅샷 없음)',
    '',
    '## 출력 규칙',
    '- JSON만 출력한다.',
    '- selectedFolder: 저장소 루트 기준 상대 경로(예: apps/channel). 루트가 적절하면 빈 문자열',
    '- rationale: 왜 그 폴더(또는 루트)인지 근거를 1~2문장',
    '- investigationPlan: 실제 코드 확인 순서를 1~3문장',
    '- selectedFolder에는 절대경로를 넣지 않는다.'
  ].join('\n');
}

function buildAgentCodeReviewPrompt({
  task,
  threadMessages,
  selectedRepo,
  selectedFolder,
  scopeRationale,
  scopeInvestigationPlan
}) {
  const targetMention = normalizeWhitespace(task.payload?.text || '');
  const channel = normalizeWhitespace(task.payload?.channelName || task.payload?.channelId || 'unknown');

  return [
    '당신은 Slack 멘션 대응을 위한 코드 분석 에이전트다.',
    '현재 저장소를 직접 읽어 관련 코드 근거를 찾아야 한다.',
    '반드시 멘션/스레드 문맥을 먼저 이해하고, 그 문맥과 연결되는 파일/라인만 제시한다.',
    '요청이 "스토어 상품/가격/정책/도메인 정보 파악"이면 API 사용 예시보다 실제 상품/도메인 정의와 정책 근거를 우선 제시한다.',
    '질문의 의도가 정보 파악인데 API 사용 방식만 설명하는 응답은 피한다.',
    '저장소 구조와 코드 흐름을 탐색해 스스로 근거를 찾고, 불필요한 추측은 피한다.',
    '결과는 한국어로 작성한다.',
    '',
    '## 작업 정보',
    `- 저장소: ${selectedRepo}`,
    `- 분석 기준 브랜치: ${CODE_ANALYSIS_BASE_BRANCH}`,
    `- 대상 폴더: ${selectedFolder || '(저장소 루트)'}`,
    `- 채널: ${channel}`,
    `- 대상 멘션: ${targetMention || '(없음)'}`,
    `- 범위 선정 근거: ${normalizeWhitespace(scopeRationale) || '(없음)'}`,
    `- 조사 계획: ${normalizeWhitespace(scopeInvestigationPlan) || '(없음)'}`,
    '',
    '## 스레드',
    buildSlackThreadTranscript(threadMessages),
    '',
    '## 출력 규칙',
    '- JSON만 출력한다.',
    '- summary: 현재 코드 근거 기반으로 상황을 1~2문장 요약',
    '- replyHints: 슬랙 답변에 바로 반영 가능한 짧은 문장 1~3개',
    '- findings: 근거 코드 목록(최대 12개). path는 상대경로, line은 1 이상 정수',
    '- excerpt는 해당 라인 핵심 코드 일부, reason은 왜 이 코드가 관련 있는지 한 문장',
    '- 근거를 찾지 못하면 findings를 빈 배열로 두고 summary/replyHints에 그 사실을 명확히 적는다.'
  ].join('\n');
}

function chooseCodeReviewAgent({ config, codexCliRunner, claudeCliRunner, preferredProvider }) {
  const defaultProvider = normalizeAgentProvider(config.agent?.defaultProvider || 'codex');
  const preferred = normalizeAgentProvider(
    preferredProvider || config.generation?.scopeAgentProviders?.slack || defaultProvider,
    defaultProvider
  );
  const runners = {
    codex: codexCliRunner || null,
    claude: claudeCliRunner || null
  };

  if (runners[preferred]) {
    return {
      provider: preferred,
      runner: runners[preferred],
      fallback: preferred === 'codex' ? 'claude' : 'codex',
      runners
    };
  }

  if (runners.codex) {
    return {
      provider: 'codex',
      runner: runners.codex,
      fallback: 'claude',
      runners
    };
  }

  if (runners.claude) {
    return {
      provider: 'claude',
      runner: runners.claude,
      fallback: 'codex',
      runners
    };
  }

  throw new Error('코드 검토 실행에 사용할 수 있는 에이전트(Codex/Claude)가 없습니다');
}

async function getAvailableCodeReviewAgent(selection, workdir) {
  try {
    await selection.runner.assertAvailable(workdir);
    return {
      provider: selection.provider,
      runner: selection.runner
    };
  } catch {
    const fallbackRunner = selection.runners[selection.fallback];
    if (!fallbackRunner) {
      throw new Error(`코드 검토 에이전트(${selection.provider})를 사용할 수 없습니다`);
    }

    await fallbackRunner.assertAvailable(workdir);
    return {
      provider: selection.fallback,
      runner: fallbackRunner
    };
  }
}

function normalizeCodeReviewFindings(rawFindings, maxFindings = 12) {
  const normalized = safeArray(rawFindings)
    .map((finding) => ({
      path: normalizeWhitespace(finding.path),
      line: Math.floor(Number(finding.line)),
      excerpt: normalizeWhitespace(finding.excerpt),
      reason: normalizeWhitespace(finding.reason)
    }))
    .filter((finding) => finding.path && Number.isFinite(finding.line) && finding.line > 0)
    .slice(0, maxFindings);

  return normalized;
}

function buildAnalysisSummary({ selectedRepo, summary, findings }) {
  const repo = normalizeRepoName(selectedRepo) || selectedRepo || 'unknown';
  const normalizedSummary = normalizeWhitespace(summary);
  if (normalizedSummary) {
    return normalizedSummary;
  }

  if (findings.length === 0) {
    return `${repo} 저장소를 확인했지만 현재 멘션과 직접 연결되는 코드 근거를 특정하지 못했습니다.`;
  }

  const majorFiles = compactStrings(findings.map((item) => item.path), 3);
  return `${repo} 저장소에서 멘션 문맥과 관련된 코드 근거 ${findings.length}건을 확인했습니다. 주요 파일: ${majorFiles.join(', ')}.`;
}

function buildReplyHints(replyHints, findings) {
  const normalizedHints = compactStrings(replyHints || [], 6);
  if (normalizedHints.length > 0) {
    return normalizedHints.slice(0, 3);
  }

  if (findings.length === 0) {
    return [
      '현재 코드 근거만으로는 원인 확정이 어려워, 재현 조건 또는 영향 범위를 추가로 확인한 뒤 업데이트드리겠습니다.'
    ];
  }

  const top = findings[0];
  const hints = [`우선 ${top.path}:${top.line} 기준으로 영향 범위를 확인 중입니다.`];
  if (findings[1]) {
    hints.push(`추가로 ${findings[1].path}:${findings[1].line} 주변 로직도 함께 점검하겠습니다.`);
  }
  return hints;
}

function shouldPrioritizeDomainInformation(task, threadMessages) {
  const corpus = normalizeWhitespace([
    task?.payload?.text || '',
    ...safeArray(threadMessages).map((message) => normalizeWhitespace(message.content))
  ].join(' ')).toLowerCase();
  if (!corpus) {
    return false;
  }

  const asksDomainInfo = /(상품|스토어\s*상품|상품\s*정보|가격|정책|번들|bundle|catalog|카탈로그|구성|판매)/i.test(corpus);
  const explicitlyAsksApi = /\bapi\b|endpoint|엔드포인트|graphql|rest|호출/i.test(corpus);
  return asksDomainInfo && !explicitlyAsksApi;
}

function detectCodeReviewRequestDrift({ task, threadMessages, summary, replyHints, findings }) {
  if (!shouldPrioritizeDomainInformation(task, threadMessages)) {
    return {
      detected: false,
      reason: ''
    };
  }

  const responseCorpus = normalizeWhitespace([
    summary,
    ...safeArray(replyHints),
    ...safeArray(findings).map((finding) => `${finding.path || ''} ${finding.reason || ''} ${finding.excerpt || ''}`)
  ].join(' ')).toLowerCase();
  if (!responseCorpus) {
    return {
      detected: false,
      reason: ''
    };
  }

  const hasDomainSignals = /(상품|가격|정책|번들|bundle|catalog|카탈로그|구성|판매|plan|sku)/i.test(responseCorpus);
  const hasApiSignals = /\bapi\b|endpoint|엔드포인트|graphql|rest|controller|service|axios|fetch/i.test(responseCorpus);
  if (hasApiSignals && !hasDomainSignals) {
    return {
      detected: true,
      reason: '상품/정책 정보 파악 요청인데 API 사용 방식 중심으로 분석되었습니다.'
    };
  }

  return {
    detected: false,
    reason: ''
  };
}

function buildScopeSelectionReason({
  selectedRepo,
  selectedFolder,
  scopeSource,
  rationale,
  investigationPlan,
  note = ''
}) {
  const repoLabel = normalizeRepoName(selectedRepo) || selectedRepo || '저장소';
  const folderLabel = selectedFolder || '(저장소 루트)';
  const head = scopeSource === 'manual_folder'
    ? `${repoLabel}의 ${folderLabel} 경로를 수동 지정해 코드 검토를 실행했습니다.`
    : `${repoLabel} 문서/스레드 문맥을 바탕으로 ${folderLabel} 범위를 선택했습니다.`;
  const reasonText = normalizeWhitespace(rationale);
  const planText = normalizeWhitespace(investigationPlan);
  return [
    head,
    reasonText ? `근거: ${reasonText}` : '',
    planText ? `계획: ${planText}` : '',
    note ? `참고: ${note}` : ''
  ].filter(Boolean).join(' ');
}

function normalizeShellCommandPreview(command, args) {
  const commandText = normalizeWhitespace(command);
  const argList = safeArray(args).map((item) => normalizeWhitespace(item)).filter(Boolean);
  if (!commandText) {
    return '';
  }
  if (argList.length === 0) {
    return commandText;
  }
  return [commandText, ...argList].join(' ');
}

function formatCodeReviewError(
  error,
  { stage = '', selectedRepo = '' }: { stage?: string; selectedRepo?: string } = {}
) {
  const details = error && typeof error === 'object' && error.details && typeof error.details === 'object'
    ? error.details
    : {};
  const baseMessage = normalizeWhitespace(error?.message || '알 수 없는 오류');
  const commandPreview = normalizeShellCommandPreview(details.command, details.args);
  const lines = [baseMessage];
  if (stage) {
    lines.push(`실패 단계: ${stage}`);
  }
  if (selectedRepo) {
    lines.push(`대상 저장소: ${selectedRepo}`);
  }
  if (details.cwd) {
    lines.push(`작업 경로: ${normalizeWhitespace(details.cwd)}`);
  }
  if (commandPreview) {
    lines.push(`실행 명령: ${commandPreview}`);
  }
  if (details.parseSourceOrigin) {
    lines.push(`파싱 소스: ${normalizeWhitespace(details.parseSourceOrigin)}`);
  }

  const stderr = normalizeWhitespace(details.stderr);
  const stdout = normalizeWhitespace(details.stdout);
  const parseSource = normalizeWhitespace(details.parseSource);
  const lastMessage = normalizeWhitespace(details.lastMessage);

  if (stderr) {
    lines.push(`stderr: ${truncateText(stderr, 800)}`);
  }
  if (stdout) {
    lines.push(`stdout: ${truncateText(stdout, 800)}`);
  }
  if (parseSource) {
    lines.push(`파싱 원문: ${truncateText(parseSource, 800)}`);
  } else if (lastMessage) {
    lines.push(`마지막 메시지: ${truncateText(lastMessage, 800)}`);
  }

  return truncateText(lines.join('\n'), 4000);
}

async function inferCodeReviewScope({
  config,
  agent,
  repoRoot,
  task,
  threadMessages,
  selectedRepo,
  timeoutSeconds = 0
}) {
  const repositorySnapshot = buildRepositoryContextSnapshot(repoRoot, {
    config,
    selectedRepo
  });
  const prompt = buildAgentCodeScopePrompt({
    task,
    threadMessages,
    selectedRepo,
    repositorySnapshot
  });

  const response = await agent.runner.runExec({
    workdir: repoRoot,
    prompt,
    sandboxMode: 'read-only',
    schema: SLACK_CODE_SCOPE_SCHEMA,
    timeoutSeconds
  });

  return {
    selectedFolder: normalizeRelativeFolder(response.parsed?.selectedFolder || ''),
    rationale: normalizeWhitespace(response.parsed?.rationale || ''),
    investigationPlan: normalizeWhitespace(response.parsed?.investigationPlan || '')
  };
}

function formatCodeAnalysisArtifact(analysis) {
  const lines = [
    `저장소: ${analysis.selectedRepo || '-'}`,
    `선택 폴더: ${analysis.selectedFolder || '(저장소 루트)'}`,
    `분석 상태: ${analysis.analysisStatus || '-'}`,
    `진행률: ${analysis.progressPercent || 0}% (${analysis.progressStep || 0}/${analysis.progressTotalSteps || 0})`,
    `진행 단계: ${analysis.progressLabel || '-'}`,
    `분석 기준 브랜치: ${analysis.analysisBaseBranch || CODE_ANALYSIS_BASE_BRANCH}`,
    `분석 에이전트: ${analysis.analysisAgentProvider || '-'}`,
    `선정 근거: ${analysis.selectionReason || '-'}`,
    `범위 추론 근거: ${analysis.scopeRationale || '-'}`,
    `범위 조사 계획: ${analysis.scopeInvestigationPlan || '-'}`,
    `요약: ${analysis.summary || '-'}`,
    '',
    '근거 코드'
  ];

  const findings = safeArray(analysis.findings);
  if (findings.length === 0) {
    lines.push('- (근거 없음)');
  } else {
    findings.forEach((finding, index) => {
      lines.push(`${index + 1}. ${finding.path}:${finding.line}`);
      lines.push(`   ${finding.excerpt}`);
      if (finding.reason) {
        lines.push(`   근거: ${finding.reason}`);
      }
    });
  }

  if (safeArray(analysis.replyHints).length > 0) {
    lines.push('', '답변 가이드');
    safeArray(analysis.replyHints).forEach((hint, index) => {
      lines.push(`${index + 1}. ${hint}`);
    });
  }

  return lines.join('\n');
}

function createCodeAnalysisArtifactPayload(analysis) {
  return {
    externalId: analysis.analyzedAt || new Date().toISOString(),
    title: '코드 검토 결과',
    content: formatCodeAnalysisArtifact(analysis),
    sortOrder: 0,
    createdAt: analysis.analyzedAt || new Date().toISOString(),
    metadata: analysis
  };
}

export function createSlackMentionDomain({
  config,
  repo,
  serverStartedAtUnixSeconds,
  slackClient,
  llmService,
  workspaceRunner,
  codexCliRunner,
  claudeCliRunner
}: {
  config: any;
  repo: any;
  serverStartedAtUnixSeconds?: number;
  slackClient: any;
  llmService: any;
  workspaceRunner?: any;
  codexCliRunner?: any;
  claudeCliRunner?: any;
}) {
  const stateKey = 'slack_mentions.last_success_at';
  const overlapSeconds = 120;
  // 서버가 열린 시점. 이 시각 이전(서버가 닫혀 있던 동안)의 메시지는 수집 대상에서 제외한다.
  const collectionFloorUnixSeconds = Number.isFinite(serverStartedAtUnixSeconds)
    ? Number(serverStartedAtUnixSeconds)
    : 0;
  const resolvedStatuses = new Set(['done', 'ignored']);
  const draftProviderBackoff = {
    [SLACK_DRAFT_AGENT_PROVIDER]: {
      until: 0,
      reason: ''
    }
  };

  function markDraftProviderBackoff(provider, reason = '') {
    if (provider !== SLACK_DRAFT_AGENT_PROVIDER) {
      return;
    }
    draftProviderBackoff[provider] = {
      until: Date.now() + SLACK_DRAFT_PROVIDER_BACKOFF_MS,
      reason: normalizeWhitespace(reason)
    };
  }

  function clearDraftProviderBackoff(provider) {
    if (provider !== SLACK_DRAFT_AGENT_PROVIDER) {
      return;
    }
    draftProviderBackoff[provider] = {
      until: 0,
      reason: ''
    };
  }

  function resolveDraftProviderCandidates() {
    const candidates = [...new Set([SLACK_DRAFT_AGENT_PROVIDER, 'codex'])];
    const claudeBackoff = draftProviderBackoff[SLACK_DRAFT_AGENT_PROVIDER];
    if (!claudeBackoff || claudeBackoff.until <= Date.now()) {
      return candidates;
    }
    return candidates.filter((provider) => provider !== SLACK_DRAFT_AGENT_PROVIDER);
  }

  async function poll() {
    if (!slackClient.isConfigured()) {
      throw new Error('Slack 연결이 설정되지 않았습니다');
    }

    const lastSuccessAt = repo.getState(stateKey, null);
    const fallbackCutoff = Math.floor(Date.now() / 1000) - config.slack.initialLookbackMinutes * 60;
    const computedCutoff = lastSuccessAt
      ? Math.max(0, Math.floor(new Date(lastSuccessAt).valueOf() / 1000) - overlapSeconds)
      : fallbackCutoff;
    // 서버가 닫혀 있던 동안의 데이터는 무시: 수집 기준 시각이 서버 시작 시각보다 앞설 수 없도록 floor 처리한다.
    const cutoffUnixSeconds = Math.max(computedCutoff, collectionFloorUnixSeconds);

    const matches = await slackClient.searchMentionsSince({ cutoffUnixSeconds });
    const ignoredChannels = buildIgnoredChannelSet(config);
    let processed = 0;
    let drafted = 0;
    let ignored = 0;

    for (const match of matches) {
      if (shouldIgnoreMentionChannel(match, ignoredChannels)) {
        ignored += 1;
        continue;
      }

      const existingTask = repo.getTaskByExternalId('slack_mention', `${match.channelId}:${match.ts}`);
      if (existingTask && resolvedStatuses.has(existingTask.status)) {
        continue;
      }

      let task = repo.upsertTask({
        domain: 'slack_mention',
        kind: 'reply',
        externalId: `${match.channelId}:${match.ts}`,
        title: `[슬랙] #${match.channelName} ${truncateText(match.text, 80)}`,
        sourceUrl: match.permalink,
        payload: {
          channelId: match.channelId,
          channelName: match.channelName,
          ts: match.ts,
          threadTs: match.threadTs,
          text: match.text,
          user: match.user,
          createdAt: match.createdAt
        }
      });
      let threadArtifacts = [];

      try {
        threadArtifacts = await slackClient.getThread({
          channelId: match.channelId,
          threadTs: match.threadTs
        });

        repo.replaceArtifacts(task.id, 'slack_message', threadArtifacts);
        task = repo.updateTask(task.id, {
          lastError: null
        });
      } catch (error) {
        threadArtifacts = [
          {
            externalId: match.ts,
            title: '원본 메시지',
            content: match.text,
            sortOrder: 0,
            createdAt: match.createdAt,
            metadata: {
              user: match.user,
              threadTs: match.threadTs,
              ts: match.ts,
              warning: 'Thread hydration failed'
            }
          }
        ];
        repo.replaceArtifacts(task.id, 'slack_message', threadArtifacts);
        task = repo.updateTask(task.id, {
          lastError: error.message
        });
      }

      const nextFingerprint = buildThreadFingerprint(threadArtifacts);
      const latestDraft = repo.getLatestDraft(task.id);
      const summaryMissing = !String(task.summary || '').trim();
      const draftMissing = !String(latestDraft?.content || '').trim() && !String(latestDraft?.metadata?.reactionName || '').trim();
      const fingerprintChanged = task.payload?.threadFingerprint !== nextFingerprint;
      const codeReview = normalizeCodeReviewState(task.payload?.codeReview, nextFingerprint);

      task = repo.updateTask(task.id, {
        payload: {
          ...task.payload,
          threadFingerprint: nextFingerprint,
          codeReview
        }
      });

      if (summaryMissing || draftMissing || fingerprintChanged) {
        await generateDraft(task);
        drafted += 1;
      }

      processed += 1;
    }

    repo.setState(stateKey, new Date().toISOString());

    return {
      domain: 'slack_mention',
      cutoffUnixSeconds,
      matchesFound: matches.length,
      ignoredChannelsSkipped: ignored,
      tasksProcessed: processed,
      draftsGenerated: drafted
    };
  }

  async function generateDraft(task, options: { includeCodeReviewContext?: boolean } = {}) {
    const threadMessages = repo.listArtifacts(task.id, 'slack_message');
    const includeCodeReviewContext = Boolean(options.includeCodeReviewContext);
    const codeReviewContext = includeCodeReviewContext ? (task.payload?.codeReview || null) : null;
    const styleGuide = buildSlackStyleGuide(repo.getState(SLACK_STYLE_MEMORY_STATE_KEY, ''), {
      maxExamples: 3
    });
    const preferredProviders = resolveDraftProviderCandidates();

    let generated = null;
    let resolvedAgentProvider = '';
    let lastErrorMessage = '';
    for (const candidateProvider of preferredProviders) {
      try {
        const candidate = await llmService.generateSlackDraft({
          task,
          threadMessages,
          codeReviewContext,
          styleGuide,
          agentProvider: candidateProvider,
          model: candidateProvider === 'claude' ? SLACK_DRAFT_MODEL : ''
        });
        const providerLabel = String(candidate.provider || '').toLowerCase();
        const shouldTryFallbackProvider = candidateProvider === SLACK_DRAFT_AGENT_PROVIDER
          && preferredProviders.length > 1
          && providerLabel.startsWith('fallback:');
        if (shouldTryFallbackProvider) {
          lastErrorMessage = normalizeWhitespace(candidate.provider).replace(/^fallback:/i, '');
          markDraftProviderBackoff(candidateProvider, lastErrorMessage);
          continue;
        }
        generated = candidate;
        resolvedAgentProvider = candidate.agentProvider || candidateProvider;
        clearDraftProviderBackoff(candidateProvider);
        break;
      } catch (error) {
        lastErrorMessage = normalizeWhitespace(error?.message || '슬랙 답변 생성 실패');
        markDraftProviderBackoff(candidateProvider, lastErrorMessage);
      }
    }

    if (!generated) {
      throw new Error(lastErrorMessage || '슬랙 답변 생성에 실패했습니다');
    }
    const qualityScore = Number(generated.qualityScore);
    const qualityWarnings = compactStrings(generated.qualityWarnings || [], 6);
    const evidenceLinks = compactStrings(generated.evidenceLinks || [], 6);
    const driftDetected = Boolean(generated.driftGuard?.detected);
    const driftReason = normalizeWhitespace(generated.driftGuard?.reason);
    const generationModel = resolvedAgentProvider === 'claude' ? SLACK_DRAFT_MODEL : '';
    const draft = repo.createDraft(task.id, generated.suggestedReply, {
      provider: generated.provider,
      generationAgentProvider: resolvedAgentProvider,
      generationModel,
      includeCodeReviewContext,
      requestedAction: generated.requestedAction,
      replyIntent: generated.replyIntent || '',
      replyCategory: generated.replyCategory,
      replyCategoryLabel: generated.replyCategoryLabel,
      reactionName: generated.reactionName || '',
      qualityScore: Number.isFinite(qualityScore) ? Math.max(0, Math.min(100, Math.round(qualityScore))) : undefined,
      qualityWarnings,
      evidenceLinks,
      requestDriftDetected: driftDetected,
      requestDriftReason: driftReason || ''
    });

    repo.replaceArtifacts(task.id, 'slack_draft_quality', [
      {
        externalId: `quality:${task.id}`,
        title: '초안 품질 점검',
        content: [
          `품질 점수: ${Number.isFinite(qualityScore) ? Math.max(0, Math.min(100, Math.round(qualityScore))) : '-'}`,
          qualityWarnings.length > 0 ? `경고: ${qualityWarnings.join(' / ')}` : '경고: 없음',
          evidenceLinks.length > 0 ? `근거 링크: ${evidenceLinks.join(' | ')}` : '근거 링크: 없음',
          driftDetected ? `요청 이탈 감지: ${driftReason || '감지됨'}` : '요청 이탈 감지: 없음'
        ].join('\n'),
        sortOrder: 0,
        metadata: {
          qualityScore: Number.isFinite(qualityScore) ? Math.max(0, Math.min(100, Math.round(qualityScore))) : null,
          qualityWarnings,
          evidenceLinks,
          driftDetected,
          driftReason
        }
      }
    ]);

    const latestTask = repo.getTask(task.id) || task;
    const nextPayload = {
      ...(latestTask.payload || {}),
      generationAgentProvider: resolvedAgentProvider
    };
    if (generationModel) {
      nextPayload.generationModel = generationModel;
    } else {
      delete nextPayload.generationModel;
    }

    const updatedTask = repo.updateTask(task.id, {
      status: 'drafted',
      approvalState: 'pending',
      summary: generated.summary,
      payload: nextPayload,
      lastError: null
    });

    return {
      task: updatedTask,
      draft,
      generated
    };
  }

  async function runCodeReview(task, options: { analysisAgentProvider?: string; selectedRepo?: string } = {}) {
    const currentTask = repo.getTask(task.id) || task;
    const threadMessages = repo.listArtifacts(currentTask.id, 'slack_message');
    const threadFingerprint = buildThreadFingerprint(threadMessages);
    const configuredRepos = compactStrings(config.github?.repositories || [], 100)
      .map((repoName) => normalizeRepoName(repoName))
      .filter(Boolean);
    const previousSelectedRepo = normalizeRepoName(currentTask.payload?.codeReview?.selectedRepo);
    const repositorySelection = autoSelectCodeReviewRepository({
      task: currentTask,
      threadMessages,
      configuredRepos,
      previousSelectedRepo
    });
    const selectedRepo = normalizeRepoName(options.selectedRepo) || repositorySelection.selectedRepo;
    if (!selectedRepo) {
      throw new Error('코드 검토를 실행할 저장소를 자동 선택하지 못했습니다. GITHUB_REPOSITORIES 설정을 확인해주세요.');
    }
    const scopeSource = 'agent_inferred';
    const progressTotalSteps = CODE_REVIEW_PROGRESS_TOTAL_STEPS;
    const codeReviewTimeoutSeconds = resolveCodeReviewTimeoutSeconds(config);

    const mergedState = {
      ...normalizeCodeReviewState(currentTask.payload?.codeReview, threadFingerprint),
      enabled: true,
      selectedRepo,
      selectedRepoSlug: normalizeWhitespace(config.github?.owner)
        ? `${normalizeWhitespace(config.github?.owner)}/${selectedRepo}`
        : selectedRepo,
      selectedFolder: '',
      candidateRepos: repositorySelection.candidateRepos,
      selectionReason: repositorySelection.selectionReason,
      scopeRationale: '',
      scopeInvestigationPlan: '',
      scopeSource,
      matchedKeywords: repositorySelection.matchedKeywords,
      matchedRules: repositorySelection.matchedRules,
      scoreReasons: repositorySelection.scoreReasons
    };

    const startedAt = new Date().toISOString();
    const runningState = {
      ...mergedState,
      ...createCodeReviewProgress({
        step: 0,
        total: progressTotalSteps,
        label: '코드 검토를 준비 중입니다.'
      }),
      analysisStatus: CODE_REVIEW_STATUS.RUNNING,
      analysisBaseBranch: CODE_ANALYSIS_BASE_BRANCH,
      analyzedAt: startedAt,
      error: ''
    };

    const runningTask = repo.updateTask(currentTask.id, {
      payload: {
        ...currentTask.payload,
        threadFingerprint,
        codeReview: runningState
      },
      lastError: null
    });

    const updateRunningProgress = ({ step, label, patch = {} }: {
      step: number;
      label: string;
      patch?: Record<string, unknown>;
    }) => {
      const latestTask = repo.getTask(currentTask.id) || runningTask;
      const latestPayload = latestTask.payload || {};
      const latestCodeReview = latestPayload.codeReview || runningState;
      const nextCodeReview = {
        ...latestCodeReview,
        ...patch,
        ...createCodeReviewProgress({
          step,
          total: progressTotalSteps,
          label
        }),
        analysisStatus: CODE_REVIEW_STATUS.RUNNING,
        error: ''
      };
      return repo.updateTask(currentTask.id, {
        payload: {
          ...latestPayload,
          codeReview: nextCodeReview
        },
        lastError: null
      });
    };

    let failureStage = '코드 검토 준비';
    try {
      failureStage = '저장소 경로 확인';
      updateRunningProgress({
        step: 1,
        label: '자동 선택한 저장소 경로를 확인하고 있습니다.'
      });
      const repoRoot = resolveRepositoryWorkdir({
        config,
        workspaceRunner,
        selectedRepo: runningState.selectedRepo,
        selectedFolder: ''
      });

      failureStage = '기준 브랜치 작업공간 준비';
      updateRunningProgress({
        step: 2,
        label: `${CODE_ANALYSIS_BASE_BRANCH} 브랜치 기준 분석 작업공간을 준비하고 있습니다.`
      });
      const masterWorkspace = await createMasterAnalysisWorkspace({
        workspaceRunner,
        repoRoot,
        baseBranch: CODE_ANALYSIS_BASE_BRANCH
      });

      try {
        const analysisRoot = masterWorkspace.analysisRoot;
        const maxFindings = Number(config.slack?.codeAnalysisMaxFindings || 12);

        failureStage = '분석 에이전트 준비';
        updateRunningProgress({
          step: 3,
          label: '코드 분석 에이전트를 준비하고 있습니다.'
        });
        const runnerSelection = chooseCodeReviewAgent({
          config,
          codexCliRunner,
          claudeCliRunner,
          preferredProvider: options.analysisAgentProvider
        });
        const agent = await getAvailableCodeReviewAgent(runnerSelection, analysisRoot);

        failureStage = '조회 범위 추론';
        updateRunningProgress({
          step: 4,
          label: '스레드 문맥과 문서를 바탕으로 조회 범위를 추론하고 있습니다.'
        });
        const inferredScope = await inferCodeReviewScope({
          config,
          agent,
          repoRoot: analysisRoot,
          task: runningTask,
          threadMessages,
          selectedRepo: runningState.selectedRepo,
          timeoutSeconds: codeReviewTimeoutSeconds
        });
        let selectedFolder = inferredScope.selectedFolder || '';
        const scopeRationale = inferredScope.rationale;
        const scopeInvestigationPlan = inferredScope.investigationPlan;
        let scopeNote = '';

        let workdir = analysisRoot;
        if (selectedFolder) {
          try {
            workdir = resolveAnalysisFolderWorkdir({
              workspaceRunner,
              analysisRoot,
              selectedFolder
            });
          } catch {
            scopeNote = `추론 폴더(${selectedFolder})를 찾지 못해 저장소 루트로 대체했습니다.`;
            selectedFolder = '';
            workdir = analysisRoot;
          }
        }

        const selectionReason = buildScopeSelectionReason({
          selectedRepo: runningState.selectedRepo,
          selectedFolder,
          scopeSource,
          rationale: scopeRationale,
          investigationPlan: scopeInvestigationPlan,
          note: [`${CODE_ANALYSIS_BASE_BRANCH} 브랜치 기준으로 코드 근거를 확인했습니다.`, scopeNote]
            .filter(Boolean)
            .join(' ')
        });

        const prompt = buildAgentCodeReviewPrompt({
          task: runningTask,
          threadMessages,
          selectedRepo: runningState.selectedRepo,
          selectedFolder,
          scopeRationale,
          scopeInvestigationPlan
        });
        failureStage = '코드 근거 분석';
        const analyzingLabel = codeReviewTimeoutSeconds > 0
          ? `선택한 범위에서 코드 근거를 분석하고 있습니다. (최대 ${codeReviewTimeoutSeconds}초)`
          : '선택한 범위에서 코드 근거를 분석하고 있습니다.';
        updateRunningProgress({
          step: progressTotalSteps - 1,
          label: analyzingLabel
        });
        const runAnalysisOnce = async (analysisPrompt) => {
          const reviewResponse = await agent.runner.runExec({
            workdir,
            prompt: analysisPrompt,
            sandboxMode: 'read-only',
            schema: SLACK_CODE_REVIEW_SCHEMA,
            timeoutSeconds: codeReviewTimeoutSeconds
          });
          const findings = normalizeCodeReviewFindings(reviewResponse.parsed?.findings, maxFindings);
          const summary = buildAnalysisSummary({
            selectedRepo: runningState.selectedRepo,
            summary: reviewResponse.parsed?.summary,
            findings
          });
          const replyHints = buildReplyHints(reviewResponse.parsed?.replyHints, findings);
          return {
            findings,
            summary,
            replyHints
          };
        };

        let analysisResult = await runAnalysisOnce(prompt);
        let requestDrift = detectCodeReviewRequestDrift({
          task: runningTask,
          threadMessages,
          summary: analysisResult.summary,
          replyHints: analysisResult.replyHints,
          findings: analysisResult.findings
        });
        let driftRetryCount = 0;
        if (requestDrift.detected) {
          driftRetryCount = 1;
          updateRunningProgress({
            step: progressTotalSteps - 1,
            label: '요청 이탈을 감지해 분석을 다시 검증하고 있습니다.'
          });
          const remediationPrompt = [
            prompt,
            '',
            '## 요청 이탈 재검증 지시',
            `- 직전 결과 이슈: ${requestDrift.reason}`,
            '- 이번 답변은 API 호출 경로 나열이 아니라 상품/정책/도메인 정의 근거 중심으로 작성한다.',
            '- summary/replyHints/findings 모두 질문 의도와 직접 연결된 근거만 남긴다.'
          ].join('\n');
          analysisResult = await runAnalysisOnce(remediationPrompt);
          requestDrift = detectCodeReviewRequestDrift({
            task: runningTask,
            threadMessages,
            summary: analysisResult.summary,
            replyHints: analysisResult.replyHints,
            findings: analysisResult.findings
          });
          if (requestDrift.detected) {
            throw new Error(`요청 이탈 감지: ${requestDrift.reason}`);
          }
        }

        const findings = analysisResult.findings;
        const summary = analysisResult.summary;
        const replyHints = analysisResult.replyHints;
        const completedAt = new Date().toISOString();
        const repoOwner = normalizeWhitespace(config.github?.owner);
        const selectedRepoSlug = repoOwner
          ? `${repoOwner}/${runningState.selectedRepo}`
          : runningState.selectedRepo;
        const completedState = {
          ...(repo.getTask(currentTask.id)?.payload?.codeReview || runningState),
          ...createCodeReviewProgress({
            step: progressTotalSteps,
            total: progressTotalSteps,
            label: '코드 근거 분석이 완료되었습니다.'
          }),
          analysisStatus: CODE_REVIEW_STATUS.COMPLETED,
          analysisAgentProvider: agent.provider,
          workspacePath: repoRoot,
          analysisBaseBranch: CODE_ANALYSIS_BASE_BRANCH,
          selectedRepoSlug,
          selectedFolder,
          selectionReason,
          scopeRationale,
          scopeInvestigationPlan,
          scopeSource,
          findings,
          summary,
          replyHints,
          requestDriftGuard: {
            retried: driftRetryCount > 0,
            retryCount: driftRetryCount,
            detected: false,
            reason: ''
          },
          analyzedAt: completedAt,
          error: ''
        };

        repo.replaceArtifacts(currentTask.id, 'slack_code_analysis', [
          createCodeAnalysisArtifactPayload(completedState)
        ]);

        const latestTask = repo.getTask(currentTask.id) || runningTask;
        const updatedTask = repo.updateTask(currentTask.id, {
          payload: {
            ...latestTask.payload,
            codeReview: completedState
          },
          lastError: null
        });

        return {
          task: updatedTask,
          analysis: completedState
        };
      } finally {
        try {
          await masterWorkspace.cleanup();
        } catch {
          // Cleanup failure should not hide main analysis error/success result.
        }
      }
    } catch (error) {
      const formattedError = formatCodeReviewError(error, {
        stage: failureStage,
        selectedRepo: runningState.selectedRepo
      });
      const latestCodeReview = repo.getTask(currentTask.id)?.payload?.codeReview || runningState;
      const failedState = {
        ...latestCodeReview,
        ...createCodeReviewProgress({
          step: latestCodeReview.progressStep || 0,
          total: latestCodeReview.progressTotalSteps || progressTotalSteps,
          label: `${failureStage} 단계에서 실패했습니다.`
        }),
        analysisStatus: CODE_REVIEW_STATUS.FAILED,
        error: formattedError,
        analyzedAt: new Date().toISOString()
      };
      repo.replaceArtifacts(currentTask.id, 'slack_code_analysis', [
        createCodeAnalysisArtifactPayload(failedState)
      ]);
      const latestTask = repo.getTask(currentTask.id) || runningTask;
      repo.updateTask(currentTask.id, {
        payload: {
          ...latestTask.payload,
          codeReview: failedState
        },
        lastError: formattedError
      });
      throw new Error(formattedError);
    }
  }

  async function execute(task, { message, reactionName, addReaction }) {
    const payload = task.payload;
    if (!payload?.channelId || !payload?.threadTs) {
      throw new Error('Slack 작업 payload가 완전하지 않습니다');
    }

    const text = String(message || '').trim();
    const normalizedReactionName = String(reactionName || '').trim();
    const shouldAddReaction = Boolean(addReaction && normalizedReactionName && payload.ts);
    if (!text && !shouldAddReaction) {
      throw new Error('답변 내용 또는 반응 이모지가 필요합니다');
    }

    let response = null;
    if (text) {
      response = await slackClient.postReply({
        channelId: payload.channelId,
        threadTs: payload.threadTs,
        text
      });
    }

    let reaction = null;
    if (shouldAddReaction) {
      try {
        reaction = await slackClient.addReaction({
          channelId: payload.channelId,
          ts: payload.ts,
          name: normalizedReactionName
        });
      } catch (error) {
        reaction = {
          ok: false,
          error: error.message,
          name: normalizedReactionName
        };
      }
    }

    return {
      provider: 'slack',
      response: response ? {
        channel: response.channel,
        ts: response.ts,
        message: response.message
      } : null,
      reaction
    };
  }

  return {
    id: 'slack_mention',
    label: '슬랙 멘션',
    implemented: true,
    capabilities: {
      polling: true,
      drafting: true,
      execution: true,
      codeReview: true
    },
    poll,
    generateDraft,
    runCodeReview,
    execute
  };
}
