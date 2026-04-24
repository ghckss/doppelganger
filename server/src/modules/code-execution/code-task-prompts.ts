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

export interface PromptPlan {
  summary: string;
  goal: string;
  taskType: string;
  successCriteria: string[];
  deliverables: string[];
  constraints: string[];
  relevantContext: string[];
  confirmationRequests?: PlanConfirmationRequest[];
}

export interface ProductPlan {
  summary: string;
  problem: string;
  userScenarios: string[];
  acceptanceCriteria: string[];
  outOfScope: string[];
  risks: string[];
}

export interface DesignSpec {
  summary: string;
  targets: string[];
  layoutChanges: string[];
  visualRules: string[];
  interactionStates: string[];
  accessibilityChecks: string[];
  responsiveNotes: string[];
}

export interface PlanConfirmationOption {
  id: string;
  label: string;
  description: string;
  recommended: boolean;
}

export interface PlanConfirmationRequest {
  id: string;
  title: string;
  question: string;
  options: PlanConfirmationOption[];
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

export interface ReviewRound {
  round: number;
  findings: ReviewFinding[];
}

function sentenceList(values: Array<string | null | undefined> = []): string {
  return values
    .filter((value): value is string => Boolean(value))
    .map((value) => `- ${value}`)
    .join('\n');
}

function yesNo(value: unknown): string {
  return value ? 'yes' : 'no';
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

function normalizeIdentifier(value: unknown, fallback: string): string {
  const normalized = normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

function defaultConfirmationRequests(taskType: string, command: string): PlanConfirmationRequest[] {
  const normalizedTaskType = normalizeWhitespace(taskType).toLowerCase();
  const scopeRecommended = normalizedTaskType === 'bugfix' ? 'minimal_change' : 'balanced_change';
  const verificationRecommended = normalizedTaskType === 'bugfix' ? 'focused_validation' : 'core_validation';

  return [
    {
      id: 'scope_preference',
      title: '변경 범위',
      question: `요청(${truncateText(command, 60)})을 어떤 범위로 반영할까요?`,
      options: [
        {
          id: 'minimal_change',
          label: '최소 변경',
          description: '요청 범위만 정확히 반영하고 연관 수정은 최소화합니다.',
          recommended: scopeRecommended === 'minimal_change'
        },
        {
          id: 'balanced_change',
          label: '균형 변경',
          description: '요청 범위 중심으로 진행하되, 인접한 안정성 이슈는 함께 정리합니다.',
          recommended: scopeRecommended === 'balanced_change'
        },
        {
          id: 'wide_cleanup',
          label: '확장 정리',
          description: '요청과 연관된 구조/가독성 개선까지 함께 반영합니다.',
          recommended: false
        }
      ]
    },
    {
      id: 'verification_level',
      title: '검증 강도',
      question: '어느 수준까지 검증할까요?',
      options: [
        {
          id: 'core_validation',
          label: '핵심 검증',
          description: '요청 기능 경로 중심으로 빠르게 확인합니다.',
          recommended: verificationRecommended === 'core_validation'
        },
        {
          id: 'focused_validation',
          label: '집중 검증',
          description: '영향 범위의 주요 테스트/시나리오를 우선 확인합니다.',
          recommended: verificationRecommended === 'focused_validation'
        },
        {
          id: 'full_validation',
          label: '전체 검증',
          description: '가능한 전체 테스트/빌드 검증까지 수행합니다.',
          recommended: false
        }
      ]
    },
    {
      id: 'delivery_priority',
      title: '우선순위',
      question: '작업의 우선순위를 선택해 주세요.',
      options: [
        {
          id: 'stability_first',
          label: '안정성 우선',
          description: '보수적으로 구현하고 리스크를 줄이는 방향으로 진행합니다.',
          recommended: true
        },
        {
          id: 'speed_first',
          label: '속도 우선',
          description: '핵심 요구사항 충족을 빠르게 완료하는 방향으로 진행합니다.',
          recommended: false
        }
      ]
    }
  ];
}

function continuationContextLines(payload: CodeTaskPayload = {}): string[] {
  const context = payload.continuationContext;
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    return [];
  }

  const source = context as Record<string, unknown>;
  const lines = sentenceList([
    normalizeWhitespace(source.previousCommand) ? `Previous command: ${normalizeWhitespace(source.previousCommand)}` : '',
    normalizeWhitespace(source.previousSummary) ? `Previous summary: ${normalizeWhitespace(source.previousSummary)}` : '',
    normalizeWhitespace(source.previousBaseBranch) ? `Previous base branch: ${normalizeWhitespace(source.previousBaseBranch)}` : '',
    normalizeWhitespace(source.previousBranch) ? `Previous work branch: ${normalizeWhitespace(source.previousBranch)}` : '',
    normalizeWhitespace(source.previousStatus) ? `Previous status: ${normalizeWhitespace(source.previousStatus)}` : '',
    normalizeWhitespace(source.previousPromptPlanSummary)
      ? `Previous prompt-plan summary: ${normalizeWhitespace(source.previousPromptPlanSummary)}`
      : '',
    normalizeWhitespace(source.parentTaskId) && normalizeWhitespace(source.rootTaskId)
      ? `Task chain: parent=${normalizeWhitespace(source.parentTaskId)}, root=${normalizeWhitespace(source.rootTaskId)}`
      : normalizeWhitespace(source.parentTaskId)
        ? `Task chain: parent=${normalizeWhitespace(source.parentTaskId)}`
        : ''
  ]);
  const commits = normalizeTextList(source.previousCommits, 10);
  const review = normalizeTextList(source.previousReview, 6);

  return [
    ...lines.split('\n').map((line) => normalizeWhitespace(line.replace(/^- /, ''))).filter(Boolean),
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

export function buildFallbackPromptPlan(
  { task, workspace }: { task: CodeTaskInput; workspace: WorkspaceSnapshot }
): PromptPlan {
  const command = normalizeWhitespace(task.payload?.command || task.title);
  const taskType = classifyTask(command);
  const continuationLines = continuationContextLines(task.payload || {});

  return {
    summary: `Implement the requested repository change for: ${truncateText(command, 180)}`,
    goal: command,
    taskType,
    successCriteria: [
      'The requested code and supporting files are updated in the target repository.',
      'Relevant validation commands are run and captured in the task record.',
      'The working tree is clean after each automated coding round.'
    ],
    deliverables: [
      'Code changes in the target repository',
      'Tests or verification updates when needed',
      'A pull request draft summary'
    ],
    constraints: [
      'Do not revert unrelated user changes.',
      'Keep commits separated by logical work unit.',
      'Use the repository tooling already present in the workspace.'
    ],
    relevantContext: [
      `Current branch: ${workspace.git.currentBranch}`,
      `Base branch: ${workspace.git.baseBranch}`,
      `Dirty worktree before start: ${yesNo(workspace.git.isDirty)}`,
      `Top-level files sampled: ${workspace.fileSample.slice(0, 12).join(', ') || 'none'}`,
      ...continuationLines
    ],
    confirmationRequests: defaultConfirmationRequests(taskType, command)
  };
}

function selectedPlanPreferenceLines(payload: CodeTaskPayload, promptPlan: PromptPlan): string[] {
  const requestList = Array.isArray(promptPlan.confirmationRequests)
    ? promptPlan.confirmationRequests
    : [];
  if (requestList.length === 0) {
    return [];
  }

  const selectionsRaw = payload.planSelections;
  const selections = selectionsRaw && typeof selectionsRaw === 'object' && !Array.isArray(selectionsRaw)
    ? selectionsRaw as Record<string, unknown>
    : {};
  const lines: string[] = [];

  for (const request of requestList) {
    const requestId = normalizeIdentifier(request.id, '');
    if (!requestId) {
      continue;
    }

    const selectedOptionId = normalizeIdentifier(selections[requestId], '');
    const selectedOption = request.options.find((option) => normalizeIdentifier(option.id, '') === selectedOptionId);
    const recommendedOption = request.options.find((option) => option.recommended);
    const fallbackOption = recommendedOption || request.options[0];

    if (selectedOption) {
      lines.push(`${request.title || requestId}: ${selectedOption.label} (${selectedOption.description})`);
      continue;
    }

    if (fallbackOption) {
      lines.push(`${request.title || requestId}: 선택 미입력 → 기본 ${fallbackOption.label} (${fallbackOption.description})`);
    }
  }

  return lines;
}

export function buildFallbackProductPlan(
  { task, promptPlan, workspace }: { task: CodeTaskInput; promptPlan: PromptPlan; workspace: WorkspaceSnapshot }
): ProductPlan {
  const command = normalizeWhitespace(task.payload?.command || task.title);

  return {
    summary: `Implementation plan for ${truncateText(command, 140)}`,
    problem: command,
    userScenarios: [
      'The requested change should be completed without manual repo bookkeeping.',
      'The final branch should be reviewable and ready for PR creation.'
    ],
    acceptanceCriteria: [
      ...promptPlan.successCriteria,
      'No unresolved critical issues remain after the review loop.'
    ],
    outOfScope: [
      'New product behavior not implied by the command',
      'Repository-wide refactors unrelated to the requested change'
    ],
    risks: [
      workspace.git.isDirty ? 'Existing uncommitted changes may block automation.' : 'No pre-existing worktree risk detected.',
      'Automated review may still leave low-severity residual risks.'
    ]
  };
}

export function buildFallbackDesignSpec(
  { task, workspace }: { task: CodeTaskInput; workspace: WorkspaceSnapshot }
): DesignSpec {
  const command = normalizeWhitespace(task.payload?.command || task.title);

  return {
    summary: `Design guidance for ${truncateText(command, 140)}`,
    targets: [
      'Only the screens and components directly touched by the request'
    ],
    layoutChanges: [
      'Preserve the existing information architecture unless the command explicitly asks for a layout change.'
    ],
    visualRules: [
      'Match the existing visual language of the repository.',
      'Keep spacing, hierarchy, and affordances consistent across affected screens.'
    ],
    interactionStates: [
      'Cover loading, error, empty, and success states when the UI already supports them.'
    ],
    accessibilityChecks: [
      'Maintain readable contrast, labels, and keyboard-reachable controls.'
    ],
    responsiveNotes: [
      `Repository scripts available for validation: ${Object.keys(workspace.scripts).join(', ') || 'none'}`
    ]
  };
}

export function buildCodingPrompt({
  task,
  workspace,
  promptPlan,
  productPlan,
  designSpec
}: {
  task: CodeTaskInput;
  workspace: WorkspaceSnapshot;
  promptPlan: PromptPlan;
  productPlan?: ProductPlan | null;
  designSpec?: DesignSpec | null;
}): string {
  const payload = task.payload || {};
  const continuationLines = continuationContextLines(payload);
  const planSelectionLines = selectedPlanPreferenceLines(payload, promptPlan);
  const sections = [
    joinSection('Goal', [
      `Implement the requested change in \`${workspace.git.root}\`.`,
      `User command: ${payload.command}`,
      `Task type: ${promptPlan.taskType}`
    ].join('\n')),
    ...(continuationLines.length > 0
      ? [joinSection('Continuation Context', sentenceList(continuationLines))]
      : []),
    joinSection('Hard Constraints', sentenceList([
      ...promptPlan.constraints,
      `Base branch: ${workspace.git.baseBranch}`,
      `Working branch: ${payload.branchName}`,
      'Make logical commits as you go. Do not leave changes uncommitted.',
      'Do not create WIP commits.',
      'Do not push or open a pull request.'
    ])),
    ...(planSelectionLines.length > 0
      ? [joinSection('User Plan Selections', sentenceList(planSelectionLines))]
      : []),
    joinSection('Harness Self-Check Loop', sentenceList([
      'After implementing the requested change, self-check the diff against the Execution Harness (global + coding rules).',
      'If a harness mismatch is safe and in scope, fix it in this coding stage before final response.',
      'Do not defer harness-only cleanup to review/patch unless the change is unsafe or out of scope.',
      'If an item cannot be safely fixed now, leave a concise reason in notes.'
    ])),
    joinSection('Workspace Context', [
      `Repository: ${workspace.git.repoSlug || 'unknown'}`,
      `Remote: ${workspace.git.remoteUrl || 'not configured'}`,
      `Scripts:`,
      describeScripts(workspace.scripts),
      `File sample: ${workspace.fileSample.slice(0, 24).join(', ') || 'none'}`
    ].join('\n')),
    joinSection('Implementation Brief', sentenceList([
      promptPlan.summary,
      productPlan?.summary,
      productPlan?.problem
    ])),
    joinSection('Acceptance Criteria', sentenceList(productPlan?.acceptanceCriteria || promptPlan.successCriteria)),
    joinSection('Design Guidance', sentenceList(designSpec ? [
      designSpec.summary,
      ...designSpec.layoutChanges,
      ...designSpec.visualRules,
      ...designSpec.accessibilityChecks
    ] : ['No dedicated design phase was requested. Preserve the repository’s existing UI patterns.'])),
    joinSection('Verification', sentenceList([
      ...workspace.recommendedChecks,
      'Run the most relevant available checks and report exactly what you ran.',
      'If a check cannot run, say why.'
    ])),
    joinSection('Final Response Format', [
      'Return valid JSON only.',
      'Include: summary, testsRun, notes.'
    ].join('\n'))
  ];

  return applyCodeTaskHarnessPrompt('coding', sections.join('\n\n'));
}

export function buildReviewPrompt({
  task,
  workspace,
  promptPlan,
  productPlan,
  designSpec,
  round
}: {
  task: CodeTaskInput;
  workspace: WorkspaceSnapshot;
  promptPlan: PromptPlan;
  productPlan?: ProductPlan | null;
  designSpec?: DesignSpec | null;
  round: number;
}): string {
  const payload = task.payload || {};
  const continuationLines = continuationContextLines(payload);
  const sections = [
    joinSection('Review Goal', [
      `Review round ${round} for the branch \`${payload.branchName}\` against \`${workspace.git.baseBranch}\`.`,
      'Focus on bugs, behavioral regressions, missing tests, design mismatches, and important code quality issues.'
    ].join('\n')),
    ...(continuationLines.length > 0
      ? [joinSection('Continuation Context', sentenceList(continuationLines))]
      : []),
    joinSection('Requested Change', sentenceList([
      promptPlan.summary,
      productPlan?.problem,
      designSpec?.summary
    ])),
    joinSection('Repository Context', [
      `Repo: ${workspace.git.repoSlug || 'unknown'}`,
      `Base branch: ${workspace.git.baseBranch}`,
      `Current branch: ${payload.branchName}`,
      `Scripts:`,
      describeScripts(workspace.scripts)
    ].join('\n')),
    joinSection('Review Output Rules', sentenceList([
      'Return valid JSON only.',
      'Use findings ordered by severity.',
      'Each finding must include id, severity, category, title, description, fileRefs, suggestedFix, and mustFix.',
      'Focus findings on behavioral regressions, structural risks, and policy/safety issues.',
      'Do not raise purely cosmetic/style harness-compliance items that belong to coding-stage self-check.',
      'If there are no findings, return an empty findings array and explain residual risks if any.'
    ]))
  ];

  return applyCodeTaskHarnessPrompt('review', sections.join('\n\n'));
}

export function buildPatchPrompt({
  task,
  workspace,
  reviewRound,
  round
}: {
  task: CodeTaskInput;
  workspace: WorkspaceSnapshot;
  reviewRound: { findings?: ReviewFinding[] };
  round: number;
}): string {
  const payload = task.payload || {};
  const findings = reviewRound.findings || [];
  const sections = [
    joinSection('Patch Goal', [
      `Apply fixes for review round ${round} on branch \`${payload.branchName}\`.`,
      `User command: ${payload.command}`
    ].join('\n')),
    joinSection('Must Address', findings.length > 0 ? sentenceList(findings.map((finding: ReviewFinding) => {
      const refs = (finding.fileRefs || []).join(', ') || 'no file refs';
      return `[${finding.id}] (${finding.severity}/${finding.category}) ${finding.title} | ${refs} | ${finding.description} | Suggested fix: ${finding.suggestedFix}`;
    })) : '- No findings were raised in this round.'),
    joinSection('Constraints', sentenceList([
      `Base branch remains ${workspace.git.baseBranch}.`,
      'Commit the review fixes as a dedicated commit for this round.',
      'Leave the working tree clean at the end.',
      'Do not push or open a pull request.'
    ])),
    joinSection('Verification', sentenceList([
      ...workspace.recommendedChecks,
      'Run the most relevant checks after the fixes and report them.'
    ])),
    joinSection('Final Response Format', [
      'Return valid JSON only.',
      'Include: summary, resolvedFindingIds, declinedFindingIds, testsRun, notes.'
    ].join('\n'))
  ];

  return applyCodeTaskHarnessPrompt('patch', sections.join('\n\n'));
}

export function buildPullRequestDraft({
  task,
  workspace,
  reviewRounds,
  commitSummary
}: {
  task: CodeTaskInput;
  workspace: WorkspaceSnapshot;
  reviewRounds: ReviewRound[];
  commitSummary: string[];
}): { title: string; body: string } {
  const command = normalizeWhitespace(task.payload?.command || task.title);
  const continuationLines = continuationContextLines(task.payload || {});
  const resolvedCounts = reviewRounds
    .map((round: ReviewRound) => `Round ${round.round}: ${(round.findings || []).length} finding(s) reviewed`)
    .join('\n');

  const title = truncateText(command, 72);
  const body = [
    '## Summary',
    `- ${command}`,
    `- Repository: ${workspace.git.repoSlug || 'unknown'}`,
    '',
    '## Commits',
    ...commitSummary.map((item) => `- ${item}`),
    '',
    '## Review Loop',
    ...(resolvedCounts ? resolvedCounts.split('\n') : ['- No review rounds recorded.']),
    ...(continuationLines.length > 0
      ? [
          '',
          '## Continuation Context',
          ...continuationLines.map((line) => `- ${line}`)
        ]
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

export const codingAgentSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'testsRun', 'notes'],
  properties: {
    summary: { type: 'string' },
    testsRun: {
      type: 'array',
      items: { type: 'string' }
    },
    notes: {
      type: 'array',
      items: { type: 'string' }
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
    residualRisks: {
      type: 'array',
      items: { type: 'string' }
    },
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
          fileRefs: {
            type: 'array',
            items: { type: 'string' }
          },
          suggestedFix: { type: 'string' },
          mustFix: { type: 'boolean' }
        }
      }
    }
  }
};

export const patchAgentSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'resolvedFindingIds', 'declinedFindingIds', 'testsRun', 'notes'],
  properties: {
    summary: { type: 'string' },
    resolvedFindingIds: {
      type: 'array',
      items: { type: 'string' }
    },
    declinedFindingIds: {
      type: 'array',
      items: { type: 'string' }
    },
    testsRun: {
      type: 'array',
      items: { type: 'string' }
    },
    notes: {
      type: 'array',
      items: { type: 'string' }
    }
  }
};
