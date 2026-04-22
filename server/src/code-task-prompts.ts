import { normalizeWhitespace, truncateText } from './utils.ts';

function sentenceList(values = []) {
  return values.filter(Boolean).map((value) => `- ${value}`).join('\n');
}

function yesNo(value) {
  return value ? 'yes' : 'no';
}

function describeScripts(scripts = {}) {
  const entries = Object.entries(scripts).filter(([, value]) => value);
  if (entries.length === 0) {
    return '- no package scripts detected';
  }

  return entries.map(([name, command]) => `- ${name}: ${command}`).join('\n');
}

function joinSection(title, body) {
  return [`## ${title}`, body || '- none'].join('\n');
}

export function classifyTask(command) {
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

export function buildFallbackPromptPlan({ task, workspace }) {
  const command = normalizeWhitespace(task.payload?.command || task.title);
  const taskType = classifyTask(command);

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
      `Top-level files sampled: ${workspace.fileSample.slice(0, 12).join(', ') || 'none'}`
    ]
  };
}

export function buildFallbackProductPlan({ task, promptPlan, workspace }) {
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

export function buildFallbackDesignSpec({ task, workspace }) {
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

export function buildCodingPrompt({ task, workspace, promptPlan, productPlan, designSpec }) {
  const payload = task.payload || {};
  const sections = [
    joinSection('Goal', [
      `Implement the requested change in \`${workspace.git.root}\`.`,
      `User command: ${payload.command}`,
      `Task type: ${promptPlan.taskType}`
    ].join('\n')),
    joinSection('Hard Constraints', sentenceList([
      ...promptPlan.constraints,
      `Base branch: ${workspace.git.baseBranch}`,
      `Working branch: ${payload.branchName}`,
      'Make logical commits as you go. Do not leave changes uncommitted.',
      'Do not create WIP commits.',
      'Do not push or open a pull request.'
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

  return sections.join('\n\n');
}

export function buildReviewPrompt({ task, workspace, promptPlan, productPlan, designSpec, round }) {
  const payload = task.payload || {};
  const sections = [
    joinSection('Review Goal', [
      `Review round ${round} for the branch \`${payload.branchName}\` against \`${workspace.git.baseBranch}\`.`,
      'Focus on bugs, behavioral regressions, missing tests, design mismatches, and important code quality issues.'
    ].join('\n')),
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
      'If there are no findings, return an empty findings array and explain residual risks if any.'
    ]))
  ];

  return sections.join('\n\n');
}

export function buildPatchPrompt({ task, workspace, reviewRound, round }) {
  const payload = task.payload || {};
  const findings = reviewRound.findings || [];
  const sections = [
    joinSection('Patch Goal', [
      `Apply fixes for review round ${round} on branch \`${payload.branchName}\`.`,
      `User command: ${payload.command}`
    ].join('\n')),
    joinSection('Must Address', findings.length > 0 ? sentenceList(findings.map((finding) => {
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

  return sections.join('\n\n');
}

export function buildPullRequestDraft({ task, workspace, reviewRounds, commitSummary }) {
  const command = normalizeWhitespace(task.payload?.command || task.title);
  const resolvedCounts = reviewRounds
    .map((round) => `Round ${round.round}: ${(round.findings || []).length} finding(s) reviewed`)
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
    '',
    '## Validation',
    '- Validation details are attached in the task history.'
  ].join('\n');

  return { title, body };
}

export function renderArtifactContent(title, data) {
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
