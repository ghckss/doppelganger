import { normalizeWhitespace, truncateText } from '../../core/utils.ts';
import { applyCodeTaskHarnessPrompt } from './code-task-harness.ts';

export interface CodeTaskPayload {
  command?: string;
  branchName?: string;
  [key: string]: unknown;
}

export interface CodeTaskInput {
  title?: string;
  payload?: CodeTaskPayload;
  result?: Record<string, unknown>;
}

export interface WorkspaceGitSnapshot {
  root: string;
  repoSlug?: string;
  baseBranch: string;
  currentBranch: string;
  remoteUrl?: string;
  isDirty: boolean;
}

export interface WorkspaceSnapshot {
  git: WorkspaceGitSnapshot;
  fileSample: string[];
  scripts: Record<string, string>;
  recommendedChecks: string[];
}

/**
 * runner 스킬 Gate 1 산출물(요구사항 계약).
 */
export interface RequirementContract {
  summary: string;
  goals: string[];
  nonGoals: string[];
  constraints: string[];
  acceptanceCriteria: string[];
  edgeCases: string[];
  openQuestions: string[];
}

export interface ImplementationPlanChunk {
  id: string;
  title: string;
  acceptanceCriteria: string[];
}

/**
 * runner 스킬 Gate 2 산출물(구현 계획).
 */
export interface ImplementationPlan {
  summary: string;
  implementationSteps: string[];
  filesLikelyToChange: string[];
  architectureImpact: string[];
  risks: string[];
  rolloutConcerns: string[];
  validationStrategy: string[];
  taskBreakdown: ImplementationPlanChunk[];
  chunkCommitBoundaries: string[];
}

export interface ReviewFinding {
  id: string;
  severity: string;
  category: string;
  title: string;
  description: string;
  fileRefs: string[];
  suggestedFix: string;
  mustFix: boolean;
}

// 이 서버가 runner 워크플로 전체(게이트/단계/리뷰 루프)를 오케스트레이션한다. 각 CLI 호출은 그 워크플로의
// "한 단계"만 수행하는 하위 작업이다. 따라서 단일 호출 안에서 전체 워크플로를 다시 돌리거나 승인 대기로 멈추면 안 되고,
// 결과는 반드시 스키마에 맞는 JSON으로만 반환해야 한다. (이 지시가 없으면 에이전트가 전체 워크플로를 재실행하며
// 산문 응답/승인 대기로 빠져 구조화 출력이 깨진다.)
const STRUCTURED_OUTPUT_DIRECTIVE = [
  '## Step Output Contract (highest priority)',
  '- This call performs ONLY the single role/step described below. The overall multi-stage workflow, approval gates, and review loop are orchestrated by the calling system — do NOT re-run the full workflow inside this call.',
  '- Do NOT pause, stop, or wait for human approval. Finish this one step now and return.',
  '- Respond with EXACTLY ONE JSON object that conforms to the provided output schema. Output JSON only — no prose, no explanation, and no markdown code fences before or after the JSON.'
].join('\n');

function withStructuredOutput(body: string): string {
  return [STRUCTURED_OUTPUT_DIRECTIVE, '', body].join('\n');
}

// 무거운 에이전트 단계(executor/patch)는 긴 도구 사용 세션이라 강제 JSON 구조화 출력이 자주 실패한다.
// 이 단계는 자유 텍스트로 응답받고 결과는 git 커밋으로 확인하므로, JSON 강제 없이 단일 단계 지시만 둔다.
const STEP_TEXT_DIRECTIVE = [
  '## Step Contract (highest priority)',
  '- This call performs ONLY the single role/step described below. The overall multi-stage workflow, approval gates, and review loop are orchestrated by the calling system — do NOT re-run the full workflow inside this call.',
  '- Do NOT pause or wait for human approval. Do the work for this one step and finish.'
].join('\n');

function withStepDirective(body: string): string {
  return [STEP_TEXT_DIRECTIVE, '', body].join('\n');
}

function sentenceList(values: Array<string | null | undefined> = []): string {
  return values
    .filter((value): value is string => Boolean(value))
    .map((value) => `- ${value}`)
    .join('\n');
}

function describeScripts(scripts: Record<string, string | null | undefined> = {}): string {
  const entries = Object.entries(scripts).filter(([, value]) => value);
  if (entries.length === 0) {
    return '- no package scripts detected';
  }

  return entries.map(([name, command]) => `- ${name}: ${command}`).join('\n');
}

function joinSection(title: string, body?: string): string {
  return [`## ${title}`, body || '- none'].join('\n');
}

function normalizeTextList(value: unknown, limit = 8): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => normalizeWhitespace(item))
    .filter(Boolean)
    .slice(0, limit);
}

function continuationContextLines(payload: CodeTaskPayload = {}): string[] {
  const context = payload.continuationContext;
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    return [];
  }

  const source = context as Record<string, unknown>;
  const lines = [
    normalizeWhitespace(source.previousCommand) ? `Previous command: ${normalizeWhitespace(source.previousCommand)}` : '',
    normalizeWhitespace(source.previousSummary) ? `Previous summary: ${normalizeWhitespace(source.previousSummary)}` : '',
    normalizeWhitespace(source.previousBaseBranch) ? `Previous base branch: ${normalizeWhitespace(source.previousBaseBranch)}` : '',
    normalizeWhitespace(source.previousBranch) ? `Previous work branch: ${normalizeWhitespace(source.previousBranch)}` : '',
    normalizeWhitespace(source.previousStatus) ? `Previous status: ${normalizeWhitespace(source.previousStatus)}` : '',
    normalizeWhitespace(source.parentTaskId) && normalizeWhitespace(source.rootTaskId)
      ? `Task chain: parent=${normalizeWhitespace(source.parentTaskId)}, root=${normalizeWhitespace(source.rootTaskId)}`
      : normalizeWhitespace(source.parentTaskId)
        ? `Task chain: parent=${normalizeWhitespace(source.parentTaskId)}`
        : ''
  ].filter(Boolean);
  const commits = normalizeTextList(source.previousCommits, 10);
  const review = normalizeTextList(source.previousReview, 6);

  return [
    ...lines,
    ...(commits.length > 0 ? [`Previous commits: ${commits.join(' | ')}`] : []),
    ...(review.length > 0 ? [`Previous review summary: ${review.join(' | ')}`] : [])
  ];
}

export function classifyTask(command: unknown): string {
  const text = String(command || '').toLowerCase();
  if (/design|layout|ui|ux|screen|page|style/.test(text)) {
    return 'ui_change';
  }
  if (/fix|bug|error|broken|issue|regression/.test(text)) {
    return 'bugfix';
  }
  if (/refactor|cleanup|rename|simplify/.test(text)) {
    return 'refactor';
  }
  return 'feature';
}

function describeWorkspace(workspace: WorkspaceSnapshot): string {
  return [
    `Repository: ${workspace.git.repoSlug || 'unknown'}`,
    `Repository root: ${workspace.git.root}`,
    `Base branch: ${workspace.git.baseBranch}`,
    `Current branch: ${workspace.git.currentBranch}`,
    `Remote: ${workspace.git.remoteUrl || 'not configured'}`,
    'Scripts:',
    describeScripts(workspace.scripts),
    `Recommended checks: ${workspace.recommendedChecks.join(', ') || 'none'}`,
    `File sample: ${workspace.fileSample.slice(0, 24).join(', ') || 'none'}`
  ].join('\n');
}

function describeContract(contract?: RequirementContract | null): string {
  if (!contract) {
    return '- requirement contract unavailable';
  }
  return [
    `Summary: ${contract.summary || '-'}`,
    'Goals:',
    sentenceList(contract.goals) || '- none',
    'Non-goals:',
    sentenceList(contract.nonGoals) || '- none',
    'Constraints:',
    sentenceList(contract.constraints) || '- none',
    'Acceptance criteria:',
    sentenceList(contract.acceptanceCriteria) || '- none',
    'Edge cases:',
    sentenceList(contract.edgeCases) || '- none'
  ].join('\n');
}

function describePlan(plan?: ImplementationPlan | null): string {
  if (!plan) {
    return '- implementation plan unavailable';
  }
  return [
    `Summary: ${plan.summary || '-'}`,
    'Implementation steps:',
    sentenceList(plan.implementationSteps) || '- none',
    'Files likely to change:',
    sentenceList(plan.filesLikelyToChange) || '- none',
    'Validation strategy:',
    sentenceList(plan.validationStrategy) || '- none',
    'Risks:',
    sentenceList(plan.risks) || '- none'
  ].join('\n');
}

function describeChunk(chunk: ImplementationPlanChunk, index: number, total: number): string {
  return [
    `Chunk ${index + 1}/${total} (id: ${chunk.id}): ${chunk.title}`,
    'Acceptance criteria for this chunk:',
    sentenceList(chunk.acceptanceCriteria) || '- (covered by overall contract)'
  ].join('\n');
}

/**
 * Spec Agent — 사용자 요청을 요구사항 계약으로 번역(Gate 1). 구현/계획/파일 수정 금지.
 */
export function buildSpecPrompt({
  task,
  workspace,
  revisionFeedback,
  previousContract
}: {
  task: CodeTaskInput;
  workspace: WorkspaceSnapshot;
  revisionFeedback?: string;
  previousContract?: RequirementContract | null;
}): string {
  const payload = task.payload || {};
  const continuationLines = continuationContextLines(payload);
  const feedback = normalizeWhitespace(revisionFeedback);
  return withStructuredOutput([
    joinSection('Task: Requirements Spec Author (single automated step)', sentenceList([
      'Translate the user request into a precise Requirement Contract.',
      'Forbidden: implementation planning, code generation, architecture decisions, file modification.',
      'Inspect the repository read-only only as needed to ground constraints and edge cases.'
    ])),
    joinSection('User Request', [
      `Command: ${payload.command || task.title}`,
      `Task type: ${classifyTask(payload.command || task.title)}`
    ].join('\n')),
    ...(feedback
      ? [joinSection('Revision Request (highest priority)', [
        'You are revising the previous Requirement Contract. Apply the following user feedback and regenerate the full contract:',
        feedback,
        ...(previousContract ? ['', 'Previous contract for reference:', describeContract(previousContract)] : [])
      ].join('\n'))]
      : []),
    ...(continuationLines.length > 0 ? [joinSection('Continuation Context', sentenceList(continuationLines))] : []),
    joinSection('Workspace Context', describeWorkspace(workspace)),
    joinSection('Output Rules', sentenceList([
      'Return valid JSON only.',
      'Include: summary, goals, nonGoals, constraints, acceptanceCriteria, edgeCases, openQuestions.',
      'Keep each item concrete and verifiable. Do not invent requirements not implied by the request.',
      'List genuine ambiguities in openQuestions instead of guessing.'
    ]))
  ].join('\n\n'));
}

/**
 * Tech Lead Agent — 승인된 계약 기반 구현 계획 수립(Gate 2). 코드 수정 금지.
 */
export function buildTechLeadPrompt({
  task,
  workspace,
  contract,
  revisionFeedback,
  previousPlan
}: {
  task: CodeTaskInput;
  workspace: WorkspaceSnapshot;
  contract: RequirementContract;
  revisionFeedback?: string;
  previousPlan?: ImplementationPlan | null;
}): string {
  const payload = task.payload || {};
  const feedback = normalizeWhitespace(revisionFeedback);
  return withStructuredOutput([
    joinSection('Task: Technical Planner (single automated step)', sentenceList([
      'Inspect the repository and design an incremental Implementation Plan for the approved contract.',
      'Forbidden: code modification, patch generation, executing the implementation.',
      'Break work into small chunks; each chunk is a default git commit boundary tied to acceptance criteria.'
    ])),
    joinSection('User Request', `Command: ${payload.command || task.title}`),
    joinSection('Approved Requirement Contract', describeContract(contract)),
    ...(feedback
      ? [joinSection('Revision Request (highest priority)', [
        'You are revising the previous Implementation Plan. Apply the following user feedback and regenerate the full plan:',
        feedback,
        ...(previousPlan ? ['', 'Previous plan for reference:', describePlan(previousPlan)] : [])
      ].join('\n'))]
      : []),
    joinSection('Workspace Context', describeWorkspace(workspace)),
    joinSection('Output Rules', sentenceList([
      'Return valid JSON only.',
      'Include: summary, implementationSteps, filesLikelyToChange, architectureImpact, risks, rolloutConcerns, validationStrategy, taskBreakdown, chunkCommitBoundaries.',
      'taskBreakdown is an ordered array of chunks; each chunk has id, title, and acceptanceCriteria.',
      'Prefer 1-5 small chunks. Each chunk must be independently implementable and committable.',
      'validationStrategy must reference the repository checks that actually exist.'
    ]))
  ].join('\n\n'));
}

/**
 * Executor Agent — 승인된 계획의 chunk 하나를 증분 구현.
 */
export function buildChunkExecutorPrompt({
  task,
  workspace,
  contract,
  plan,
  chunk,
  chunkIndex,
  chunkTotal,
  codebaseSnapshot
}: {
  task: CodeTaskInput;
  workspace: WorkspaceSnapshot;
  contract: RequirementContract;
  plan: ImplementationPlan;
  chunk: ImplementationPlanChunk;
  chunkIndex: number;
  chunkTotal: number;
  codebaseSnapshot?: string;
}): string {
  const payload = task.payload || {};
  const continuationLines = continuationContextLines(payload);
  const sections = [
    joinSection('Task: Code Implementer (single automated step)', sentenceList([
      `Implement ONLY chunk ${chunkIndex + 1}/${chunkTotal} of the approved plan. Do not implement other chunks.`,
      'Forbidden: large one-shot implementation, uncontrolled replanning, architecture changes beyond the approved plan.',
      'Make logical commits. Leave the working tree clean. Do not push or open a pull request.'
    ])),
    joinSection('Goal', [
      `Implement the requested change in \`${workspace.git.root}\` on branch \`${payload.branchName}\`.`,
      `User command: ${payload.command}`
    ].join('\n')),
    joinSection('Current Chunk', describeChunk(chunk, chunkIndex, chunkTotal)),
    joinSection('Requirement Contract', describeContract(contract)),
    joinSection('Implementation Plan', describePlan(plan)),
    ...(codebaseSnapshot ? [joinSection('Current Codebase Snapshot', codebaseSnapshot)] : []),
    ...(continuationLines.length > 0 ? [joinSection('Continuation Context', sentenceList(continuationLines))] : []),
    joinSection('Workspace Context', describeWorkspace(workspace)),
    joinSection('Verification', sentenceList([
      ...workspace.recommendedChecks,
      'Run the most relevant available checks for this chunk and report exactly what you ran.',
      'If a check cannot run, say why in notes.'
    ])),
    joinSection('Plan Patch', sentenceList([
      'If repo reality invalidates the approved plan for THIS chunk (missing files, wrong assumptions, an impossible or conflicting step), do NOT force-implement.',
      'Instead make no file changes and output, as your FINAL message, a single line exactly in this form:',
      'PLAN_PATCH_REQUEST: <reason> ||| <minimal proposed plan change>',
      'Otherwise implement the chunk normally.'
    ])),
    joinSection('Final Response', sentenceList([
      'When you implemented the chunk: end with a short plain-text summary of what you changed and which checks you ran.',
      'When a plan patch is needed instead: output only the PLAN_PATCH_REQUEST line and make no file changes.'
    ]))
  ];

  return applyCodeTaskHarnessPrompt('coding', withStepDirective(sections.join('\n\n')));
}

/**
 * Reviewer Swarm — 단일 도메인 관점에서 diff만 독립 리뷰.
 */
export function buildReviewerPrompt({
  task,
  workspace,
  contract,
  domain,
  domainGuidance,
  chunk
}: {
  task: CodeTaskInput;
  workspace: WorkspaceSnapshot;
  contract: RequirementContract;
  domain: string;
  domainGuidance: string;
  chunk: ImplementationPlanChunk;
}): string {
  const payload = task.payload || {};
  const sections = [
    joinSection(`Role: ${domain} Reviewer (single-domain code review step)`, sentenceList([
      `Review ONLY the diff for the current chunk against \`${workspace.git.baseBranch}\` from the ${domain} perspective.`,
      domainGuidance,
      'Forbidden: implementation, architecture redesign, unrelated issue hunting.',
      'Tie every finding to file, line when available, impact, and a concrete action.'
    ])),
    joinSection('Chunk Under Review', `${chunk.title}\n${sentenceList(chunk.acceptanceCriteria)}`),
    joinSection('Requirement Contract', describeContract(contract)),
    joinSection('Repository Context', describeWorkspace(workspace)),
    joinSection('Review Output Rules', sentenceList([
      'Return valid JSON only.',
      'Each finding must include id, severity, category, title, description, fileRefs, suggestedFix, and mustFix.',
      `Only raise findings relevant to the ${domain} domain.`,
      'Set mustFix=true for correctness/security (P0) and runtime/type-stability (P1) issues.',
      'If there are no findings, return an empty findings array and note residual risks if any.'
    ]))
  ];

  return applyCodeTaskHarnessPrompt('review', withStructuredOutput(sections.join('\n\n')));
}

/**
 * Merge Reviewer — 여러 리뷰어 결과를 우선순위화된 actionable 리포트로 병합.
 */
export function buildMergeReviewPrompt({
  task,
  contract,
  reviewerFindings
}: {
  task: CodeTaskInput;
  contract: RequirementContract;
  reviewerFindings: Array<{ domain: string; findings: ReviewFinding[] }>;
}): string {
  const payload = task.payload || {};
  const findingsText = reviewerFindings
    .map((entry) => {
      const lines = entry.findings.length > 0
        ? entry.findings.map((finding) => `[${finding.id}] (${finding.severity}/${finding.category}) ${finding.title} | ${(finding.fileRefs || []).join(', ') || 'no refs'} | ${finding.description} | mustFix=${finding.mustFix}`)
        : ['(no findings)'];
      return [`### ${entry.domain}`, ...lines.map((line) => `- ${line}`)].join('\n');
    })
    .join('\n');

  return withStructuredOutput([
    joinSection('Task: Review Consolidator (single automated step)', sentenceList([
      'Deduplicate, normalize severity, resolve conflicts, filter hallucinations, extract actionable items.',
      'Forbidden: new domain review, implementation.',
      'Resolve conflicts using the Requirement Contract and code evidence.'
    ])),
    joinSection('User Command', `${payload.command || task.title}`),
    joinSection('Requirement Contract', describeContract(contract)),
    joinSection('Reviewer Findings', findingsText || '- none'),
    joinSection('Output Rules', sentenceList([
      'Return valid JSON only.',
      'Include: mustFix, shouldFix, advisory, duplicates, discarded.',
      'mustFix = P0 (security/correctness) and P1 (runtime/type stability) issues only.',
      'shouldFix = P2 (performance) impactful items. advisory = P3/P4.',
      'Each item must include id, severity, title, description, fileRefs, action.'
    ]))
  ].join('\n\n'));
}

/**
 * Patch — Merge Reviewer의 mustFix 항목을 최소 diff로 수정.
 */
export function buildPatchPrompt({
  task,
  workspace,
  mustFix,
  chunk
}: {
  task: CodeTaskInput;
  workspace: WorkspaceSnapshot;
  mustFix: ReviewFinding[];
  chunk: ImplementationPlanChunk;
}): string {
  const payload = task.payload || {};
  const sections = [
    joinSection('Task: Targeted Fix (single automated step)', [
      `Apply fixes for the merged must-fix findings on branch \`${payload.branchName}\` (chunk: ${chunk.title}).`,
      `User command: ${payload.command}`
    ].join('\n')),
    joinSection('Must Address', mustFix.length > 0
      ? sentenceList(mustFix.map((finding) => {
        const refs = (finding.fileRefs || []).join(', ') || 'no file refs';
        return `[${finding.id}] (${finding.severity}/${finding.category}) ${finding.title} | ${refs} | ${finding.description} | Suggested fix: ${finding.suggestedFix}`;
      }))
      : '- No must-fix findings were raised.'),
    joinSection('Constraints', sentenceList([
      `Base branch remains ${workspace.git.baseBranch}.`,
      'Fix only the listed findings with minimal diff. Do not widen scope.',
      'Leave the working tree clean at the end. Do not push or open a pull request.'
    ])),
    joinSection('Verification', sentenceList([
      ...workspace.recommendedChecks,
      'Run the most relevant checks after the fixes and report them.'
    ])),
    joinSection('Final Response', 'End with a short plain-text summary of the fixes you applied, which findings you resolved or declined, and which checks you ran.')
  ];

  return applyCodeTaskHarnessPrompt('patch', withStepDirective(sections.join('\n\n')));
}

/**
 * Final Validation Agent — 최종 결과를 승인된 계약 대비 검증.
 */
export function buildFinalValidationPrompt({
  task,
  workspace,
  contract,
  commitSummary
}: {
  task: CodeTaskInput;
  workspace: WorkspaceSnapshot;
  contract: RequirementContract;
  commitSummary: string[];
}): string {
  const payload = task.payload || {};
  return withStructuredOutput([
    joinSection('Task: Final Verifier (single automated step)', sentenceList([
      'Verify the final result against the approved Requirement Contract and acceptance criteria.',
      'Forbidden: new feature scope, unapproved architectural change.',
      'Run regression/runtime checks read-only where possible; if a command cannot run, record why and the residual risk.'
    ])),
    joinSection('User Command', `${payload.command || task.title}`),
    joinSection('Requirement Contract', describeContract(contract)),
    joinSection('Commits On Branch', sentenceList(commitSummary) || '- none'),
    joinSection('Repository Context', describeWorkspace(workspace)),
    joinSection('Output Rules', sentenceList([
      'Return valid JSON only.',
      'Include: contractMet, acceptanceResults, regression, residualRisks, summary.',
      'acceptanceResults is an array of { criterion, status, evidence } where status is met|partial|unmet.',
      'contractMet is true only when no acceptance criterion is unmet.'
    ]))
  ].join('\n\n'));
}

/**
 * Refinement Loop 검사자 — 완료된 결과를 점검해, 승인된 계약/계획 "프레임 안"의 개선점 1개를 식별한다.
 * 프레임을 벗어나는 개선이면 inFrame=false로 표시(자율 루프 중단). 개선이 없으면 improvementFound=false.
 */
export function buildRefinementInspectionPrompt({
  task,
  workspace,
  contract,
  plan,
  finalValidation,
  remainingKnownIssues,
  iteration,
  maxIterations
}: {
  task: CodeTaskInput;
  workspace: WorkspaceSnapshot;
  contract: RequirementContract;
  plan: ImplementationPlan;
  finalValidation: Record<string, unknown>;
  remainingKnownIssues: string[];
  iteration: number;
  maxIterations: number;
}): string {
  const payload = task.payload || {};
  return withStructuredOutput([
    joinSection('Task: Refinement Inspector (single automated step)', sentenceList([
      `Post-completion refinement iteration ${iteration}/${maxIterations}. The full workflow already completed and Final Validation ran.`,
      'Inspect the result and identify AT MOST ONE concrete improvement that stays strictly INSIDE the approved Requirement Contract and Implementation Plan (the frozen frame).',
      'Sources: acceptance criteria only weakly satisfied, remaining known issues, residual risks, structural/maintainability gaps already in scope.',
      'If an improvement would change scope, contradict a non-goal, or alter public API/architecture beyond the approved plan, it is frame-exceeding → set inFrame=false.',
      'If no worthwhile in-frame improvement remains, set improvementFound=false.'
    ])),
    joinSection('User Command', `${payload.command || task.title}`),
    joinSection('Approved Requirement Contract', describeContract(contract)),
    joinSection('Approved Implementation Plan', describePlan(plan)),
    joinSection('Latest Final Validation', sentenceList([
      `contractMet: ${Boolean(finalValidation?.contractMet)}`,
      `summary: ${normalizeWhitespace(finalValidation?.summary)}`,
      ...normalizeTextList(finalValidation?.residualRisks, 8)
    ])),
    joinSection('Remaining Known Issues', sentenceList(remainingKnownIssues) || '- none'),
    joinSection('Repository Context', describeWorkspace(workspace)),
    joinSection('Output Rules', sentenceList([
      'Return valid JSON only.',
      'Include: improvementFound, inFrame, unresolvedCount, rationale, chunk.',
      'unresolvedCount = number of remaining in-frame improvement points you still see (used to detect no-progress).',
      'chunk describes the single improvement to implement next: { id, title, acceptanceCriteria }. When improvementFound is false, return empty strings/array for chunk.',
      'Be conservative: prefer improvementFound=false over speculative polish.'
    ]))
  ].join('\n\n'));
}

export function buildPullRequestDraft({
  task,
  workspace,
  commitSummary,
  contract
}: {
  task: CodeTaskInput;
  workspace: WorkspaceSnapshot;
  commitSummary: string[];
  contract?: RequirementContract | null;
}): { title: string; body: string } {
  const command = normalizeWhitespace(task.payload?.command || task.title);
  const continuationLines = continuationContextLines(task.payload || {});

  const title = truncateText(command, 72);
  const body = [
    '## Summary',
    `- ${command}`,
    `- Repository: ${workspace.git.repoSlug || 'unknown'}`,
    ...(contract?.goals?.length ? ['', '## Goals', ...contract.goals.map((goal) => `- ${goal}`)] : []),
    '',
    '## Commits',
    ...(commitSummary.length > 0 ? commitSummary.map((item) => `- ${item}`) : ['- No commits recorded.']),
    ...(continuationLines.length > 0
      ? ['', '## Continuation Context', ...continuationLines.map((line) => `- ${line}`)]
      : []),
    '',
    '## Validation',
    '- Validation details are attached in the task history.'
  ].join('\n');

  return { title, body };
}

export function renderArtifactContent(title: string, data: unknown): string {
  return [`# ${title}`, '', '```json', JSON.stringify(data, null, 2), '```'].join('\n');
}

const stringArray = { type: 'array', items: { type: 'string' } };

export const requirementContractSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'goals', 'nonGoals', 'constraints', 'acceptanceCriteria', 'edgeCases', 'openQuestions'],
  properties: {
    summary: { type: 'string' },
    goals: stringArray,
    nonGoals: stringArray,
    constraints: stringArray,
    acceptanceCriteria: stringArray,
    edgeCases: stringArray,
    openQuestions: stringArray
  }
};

export const implementationPlanSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'summary',
    'implementationSteps',
    'filesLikelyToChange',
    'architectureImpact',
    'risks',
    'rolloutConcerns',
    'validationStrategy',
    'taskBreakdown',
    'chunkCommitBoundaries'
  ],
  properties: {
    summary: { type: 'string' },
    implementationSteps: stringArray,
    filesLikelyToChange: stringArray,
    architectureImpact: stringArray,
    risks: stringArray,
    rolloutConcerns: stringArray,
    validationStrategy: stringArray,
    chunkCommitBoundaries: stringArray,
    taskBreakdown: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'acceptanceCriteria'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          acceptanceCriteria: stringArray
        }
      }
    }
  }
};

export const codingAgentSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'testsRun', 'notes'],
  properties: {
    summary: { type: 'string' },
    testsRun: stringArray,
    notes: stringArray,
    // 계획 불일치를 발견하면 구현 대신 이 필드를 채워 계획 패치를 요청한다(파일은 변경하지 않는다).
    // 패치가 필요 없을 때 모델이 빈/누락/null로 두어도 구조화 출력이 실패하지 않도록 필수/추가속성 제약을 두지 않는다.
    planPatchRequest: {
      type: ['object', 'null'],
      properties: {
        reason: { type: 'string' },
        proposedChange: { type: 'string' }
      }
    }
  }
};

export const reviewAgentSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'findings', 'approval', 'residualRisks'],
  properties: {
    summary: { type: 'string' },
    approval: {
      type: 'string',
      enum: ['approved_with_no_changes', 'changes_requested']
    },
    residualRisks: stringArray,
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'severity', 'category', 'title', 'description', 'fileRefs', 'suggestedFix', 'mustFix'],
        properties: {
          id: { type: 'string' },
          severity: {
            type: 'string',
            enum: ['critical', 'high', 'medium', 'low']
          },
          category: {
            type: 'string',
            enum: ['bug', 'regression', 'missing_test', 'design_gap', 'spec_mismatch', 'code_quality']
          },
          title: { type: 'string' },
          description: { type: 'string' },
          fileRefs: stringArray,
          suggestedFix: { type: 'string' },
          mustFix: { type: 'boolean' }
        }
      }
    }
  }
};

const mergeFindingSchema = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'severity', 'title', 'description', 'fileRefs', 'action'],
    properties: {
      id: { type: 'string' },
      severity: {
        type: 'string',
        enum: ['P0', 'P1', 'P2', 'P3', 'P4']
      },
      title: { type: 'string' },
      description: { type: 'string' },
      fileRefs: stringArray,
      action: { type: 'string' }
    }
  }
};

export const mergeReviewSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['mustFix', 'shouldFix', 'advisory', 'duplicates', 'discarded'],
  properties: {
    mustFix: mergeFindingSchema,
    shouldFix: mergeFindingSchema,
    advisory: mergeFindingSchema,
    duplicates: stringArray,
    discarded: stringArray
  }
};

export const patchAgentSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'resolvedFindingIds', 'declinedFindingIds', 'testsRun', 'notes'],
  properties: {
    summary: { type: 'string' },
    resolvedFindingIds: stringArray,
    declinedFindingIds: stringArray,
    testsRun: stringArray,
    notes: stringArray
  }
};

export const refinementDecisionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['improvementFound', 'inFrame', 'unresolvedCount', 'rationale', 'chunk'],
  properties: {
    improvementFound: { type: 'boolean' },
    inFrame: { type: 'boolean' },
    unresolvedCount: { type: 'number' },
    rationale: { type: 'string' },
    chunk: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'title', 'acceptanceCriteria'],
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        acceptanceCriteria: stringArray
      }
    }
  }
};

export const finalValidationSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['contractMet', 'acceptanceResults', 'regression', 'residualRisks', 'summary'],
  properties: {
    contractMet: { type: 'boolean' },
    regression: { type: 'string' },
    summary: { type: 'string' },
    residualRisks: stringArray,
    acceptanceResults: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['criterion', 'status', 'evidence'],
        properties: {
          criterion: { type: 'string' },
          status: {
            type: 'string',
            enum: ['met', 'partial', 'unmet']
          },
          evidence: { type: 'string' }
        }
      }
    }
  }
};
