import {
  buildFallbackDesignSpec,
  buildFallbackProductPlan,
  buildFallbackPromptPlan,
  buildPullRequestDraft,
  type CodeTaskInput,
  type DesignSpec,
  type PlanConfirmationOption,
  type PlanConfirmationRequest,
  type ProductPlan,
  type PromptPlan,
  type ReviewRound,
  type WorkspaceSnapshot
} from '../modules/code-execution/code-task-prompts.ts';
import { normalizeWhitespace, safeArray } from '../core/utils.ts';

interface PlannerGenerationClient {
  getMode?: (scope?: string) => string;
  isConfigured?: (scope?: string) => boolean;
  createTextResponse: (input: {
    instructions: string;
    input: string;
    scope: string;
  }) => Promise<string | { text?: string }>;
}

function extractJsonObject(text: unknown): Record<string, unknown> {
  const trimmed = String(text || '').trim();
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error('Model response did not contain JSON');
  }

  return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
}

function compactArray(value: unknown): string[] {
  return safeArray(value).map((item) => normalizeWhitespace(item)).filter(Boolean);
}

function normalizeIdentifier(value: unknown, fallback: string): string {
  const normalized = normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || fallback;
}

function compactConfirmationOptions(value: unknown, requestId: string): PlanConfirmationOption[] {
  const options = safeArray(value).map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return null;
    }
    const source = entry as Record<string, unknown>;
    const id = normalizeIdentifier(source.id, `${requestId}_option_${index + 1}`);
    const label = normalizeWhitespace(source.label) || `옵션 ${index + 1}`;
    const description = normalizeWhitespace(source.description) || label;
    return {
      id,
      label,
      description,
      recommended: Boolean(source.recommended)
    };
  }).filter((option): option is PlanConfirmationOption => Boolean(option));

  if (options.length === 0) {
    return [
      {
        id: `${requestId}_default`,
        label: '기본안',
        description: '기본 권장 방식으로 진행합니다.',
        recommended: true
      }
    ];
  }

  if (!options.some((option) => option.recommended)) {
    options[0] = {
      ...options[0],
      recommended: true
    };
  }

  return options.slice(0, 3);
}

function compactConfirmationRequests(
  value: unknown,
  fallback: PlanConfirmationRequest[] = []
): PlanConfirmationRequest[] {
  const requests = safeArray(value).map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return null;
    }
    const source = entry as Record<string, unknown>;
    const id = normalizeIdentifier(source.id, `confirm_${index + 1}`);
    const title = normalizeWhitespace(source.title) || `확인 항목 ${index + 1}`;
    const question = normalizeWhitespace(source.question) || `${title}에 대한 선택이 필요합니다.`;
    return {
      id,
      title,
      question,
      options: compactConfirmationOptions(source.options, id)
    };
  }).filter((request): request is PlanConfirmationRequest => Boolean(request));

  if (requests.length > 0) {
    return requests.slice(0, 5);
  }

  return safeArray(fallback).slice(0, 5).map((request, index) => ({
    id: normalizeIdentifier(request.id, `confirm_${index + 1}`),
    title: normalizeWhitespace(request.title) || `확인 항목 ${index + 1}`,
    question: normalizeWhitespace(request.question) || '작업 진행 전에 선택이 필요합니다.',
    options: compactConfirmationOptions(request.options, normalizeIdentifier(request.id, `confirm_${index + 1}`))
  }));
}

function describeWorkspace(workspace: WorkspaceSnapshot): string {
  return [
    `Repository root: ${workspace.git.root}`,
    `Repo slug: ${workspace.git.repoSlug || 'unknown'}`,
    `Base branch: ${workspace.git.baseBranch}`,
    `Current branch: ${workspace.git.currentBranch}`,
    `Remote URL: ${workspace.git.remoteUrl || 'not configured'}`,
    `Scripts: ${JSON.stringify(workspace.scripts)}`,
    `Recommended checks: ${workspace.recommendedChecks.join(', ') || 'none'}`,
    `File sample: ${workspace.fileSample.slice(0, 32).join(', ') || 'none'}`
  ].join('\n');
}

function describeContinuation(task: CodeTaskInput): string {
  const payload = task.payload && typeof task.payload === 'object'
    ? task.payload
    : {};
  const context = payload.continuationContext;
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    return '';
  }

  const source = context as Record<string, unknown>;
  const previousCommand = normalizeWhitespace(source.previousCommand);
  const previousSummary = normalizeWhitespace(source.previousSummary);
  const parentTaskId = normalizeWhitespace(source.parentTaskId);
  const previousStatus = normalizeWhitespace(source.previousStatus);
  const previousReview = compactArray(source.previousReview);
  const previousCommits = compactArray(source.previousCommits);

  const lines = [
    previousCommand ? `Previous command: ${previousCommand}` : '',
    previousSummary ? `Previous summary: ${previousSummary}` : '',
    parentTaskId ? `Parent task id: ${parentTaskId}` : '',
    previousStatus ? `Previous status: ${previousStatus}` : '',
    previousReview.length > 0 ? `Previous review: ${previousReview.join(' | ')}` : '',
    previousCommits.length > 0 ? `Previous commits: ${previousCommits.join(' | ')}` : ''
  ].filter(Boolean);
  if (lines.length === 0) {
    return '';
  }

  return ['Continuation context:', ...lines].join('\n');
}

export class CodeTaskPlanner {
  generationClient: PlannerGenerationClient | null;

  constructor(generationClient: PlannerGenerationClient | null = null) {
    this.generationClient = generationClient;
  }

  canUseModel(scope: string = 'code_planning'): boolean {
    if (!this.generationClient) {
      return false;
    }
    if (typeof this.generationClient.getMode === 'function' && this.generationClient.getMode(scope) === 'fallback') {
      return false;
    }
    if (typeof this.generationClient.isConfigured === 'function') {
      return this.generationClient.isConfigured(scope);
    }
    return true;
  }

  async generateText({
    instructions,
    input,
    scope = 'code_planning'
  }: {
    instructions: string;
    input: string;
    scope?: string;
  }): Promise<string> {
    if (!this.generationClient) {
      throw new Error('Generation client is not configured');
    }
    const response = await this.generationClient.createTextResponse({
      instructions,
      input,
      scope
    });
    return typeof response === 'string' ? response : String(response?.text || '');
  }

  async createPromptPlan({
    task,
    workspace
  }: {
    task: CodeTaskInput;
    workspace: WorkspaceSnapshot;
  }): Promise<PromptPlan> {
    const fallback = buildFallbackPromptPlan({ task, workspace });
    if (!this.canUseModel('code_planning')) {
      return fallback;
    }

    const instructions = [
      'You are the prompt planner for an autonomous coding workflow.',
      'Return valid JSON only.',
      'Use this shape:',
      '{"summary":"string","goal":"string","taskType":"string","successCriteria":["string"],"deliverables":["string"],"constraints":["string"],"relevantContext":["string"],"confirmationRequests":[{"id":"string","title":"string","question":"string","options":[{"id":"string","label":"string","description":"string","recommended":true}]}]}',
      'Be concrete, implementation-focused, and avoid inventing requirements.'
    ].join(' ');

    const input = [
      `User command: ${task.payload?.command || task.title}`,
      describeContinuation(task),
      describeWorkspace(workspace)
    ].filter(Boolean).join('\n\n');

    try {
      const text = await this.generateText({ instructions, input, scope: 'code_planning' });
      const parsed = extractJsonObject(text);
      return {
        summary: normalizeWhitespace(parsed.summary) || fallback.summary,
        goal: normalizeWhitespace(parsed.goal) || fallback.goal,
        taskType: normalizeWhitespace(parsed.taskType) || fallback.taskType,
        successCriteria: compactArray(parsed.successCriteria).slice(0, 8).concat(fallback.successCriteria).slice(0, 8),
        deliverables: compactArray(parsed.deliverables).slice(0, 8).concat(fallback.deliverables).slice(0, 8),
        constraints: compactArray(parsed.constraints).slice(0, 8).concat(fallback.constraints).slice(0, 8),
        relevantContext: compactArray(parsed.relevantContext).slice(0, 8).concat(fallback.relevantContext).slice(0, 8),
        confirmationRequests: compactConfirmationRequests(parsed.confirmationRequests, fallback.confirmationRequests || [])
      };
    } catch {
      return fallback;
    }
  }

  async createProductPlan({
    task,
    promptPlan,
    workspace
  }: {
    task: CodeTaskInput;
    promptPlan: PromptPlan;
    workspace: WorkspaceSnapshot;
  }): Promise<ProductPlan> {
    const fallback = buildFallbackProductPlan({ task, promptPlan, workspace });
    if (!this.canUseModel('code_planning')) {
      return fallback;
    }

    const instructions = [
      'You are a product planning agent supporting a coding workflow.',
      'Return valid JSON only.',
      'Use this shape:',
      '{"summary":"string","problem":"string","userScenarios":["string"],"acceptanceCriteria":["string"],"outOfScope":["string"],"risks":["string"]}',
      'Keep it implementable and concise.'
    ].join(' ');

    const input = [
      `User command: ${task.payload?.command || task.title}`,
      describeContinuation(task),
      `Prompt plan: ${JSON.stringify(promptPlan)}`,
      describeWorkspace(workspace)
    ].filter(Boolean).join('\n\n');

    try {
      const text = await this.generateText({ instructions, input, scope: 'code_planning' });
      const parsed = extractJsonObject(text);
      return {
        summary: normalizeWhitespace(parsed.summary) || fallback.summary,
        problem: normalizeWhitespace(parsed.problem) || fallback.problem,
        userScenarios: compactArray(parsed.userScenarios).slice(0, 8).concat(fallback.userScenarios).slice(0, 8),
        acceptanceCriteria: compactArray(parsed.acceptanceCriteria).slice(0, 10).concat(fallback.acceptanceCriteria).slice(0, 10),
        outOfScope: compactArray(parsed.outOfScope).slice(0, 8).concat(fallback.outOfScope).slice(0, 8),
        risks: compactArray(parsed.risks).slice(0, 8).concat(fallback.risks).slice(0, 8)
      };
    } catch {
      return fallback;
    }
  }

  async createDesignSpec({
    task,
    promptPlan,
    workspace
  }: {
    task: CodeTaskInput;
    promptPlan: PromptPlan;
    workspace: WorkspaceSnapshot;
  }): Promise<DesignSpec> {
    const fallback = buildFallbackDesignSpec({ task, workspace });
    if (!this.canUseModel('code_planning')) {
      return fallback;
    }

    const instructions = [
      'You are a UI design planning agent for implementation-ready engineering specs.',
      'Return valid JSON only.',
      'Use this shape:',
      '{"summary":"string","targets":["string"],"layoutChanges":["string"],"visualRules":["string"],"interactionStates":["string"],"accessibilityChecks":["string"],"responsiveNotes":["string"]}',
      'Do not produce mockups; produce code-oriented design guidance.'
    ].join(' ');

    const input = [
      `User command: ${task.payload?.command || task.title}`,
      describeContinuation(task),
      `Prompt plan: ${JSON.stringify(promptPlan)}`,
      describeWorkspace(workspace)
    ].filter(Boolean).join('\n\n');

    try {
      const text = await this.generateText({ instructions, input, scope: 'code_planning' });
      const parsed = extractJsonObject(text);
      return {
        summary: normalizeWhitespace(parsed.summary) || fallback.summary,
        targets: compactArray(parsed.targets).slice(0, 8).concat(fallback.targets).slice(0, 8),
        layoutChanges: compactArray(parsed.layoutChanges).slice(0, 8).concat(fallback.layoutChanges).slice(0, 8),
        visualRules: compactArray(parsed.visualRules).slice(0, 8).concat(fallback.visualRules).slice(0, 8),
        interactionStates: compactArray(parsed.interactionStates).slice(0, 8).concat(fallback.interactionStates).slice(0, 8),
        accessibilityChecks: compactArray(parsed.accessibilityChecks).slice(0, 8).concat(fallback.accessibilityChecks).slice(0, 8),
        responsiveNotes: compactArray(parsed.responsiveNotes).slice(0, 8).concat(fallback.responsiveNotes).slice(0, 8)
      };
    } catch {
      return fallback;
    }
  }

  async createPullRequestDraft({
    task,
    workspace,
    reviewRounds,
    commitSummary
  }: {
    task: CodeTaskInput;
    workspace: WorkspaceSnapshot;
    reviewRounds: ReviewRound[];
    commitSummary: string[];
  }): Promise<{ title: string; body: string }> {
    const fallback = buildPullRequestDraft({ task, workspace, reviewRounds, commitSummary });
    if (!this.canUseModel('code_planning')) {
      return fallback;
    }

    const instructions = [
      'You write concise GitHub pull request titles and bodies.',
      'Return valid JSON only.',
      'Use this shape:',
      '{"title":"string","body":"string"}',
      'Mention the implemented change, review loop, and validation succinctly.'
    ].join(' ');

    const input = [
      `User command: ${task.payload?.command || task.title}`,
      describeContinuation(task),
      `Prompt plan: ${JSON.stringify(task.result?.promptPlan || {})}`,
      `Commit summary: ${JSON.stringify(commitSummary)}`,
      `Review rounds: ${JSON.stringify(reviewRounds)}`,
      describeWorkspace(workspace)
    ].filter(Boolean).join('\n\n');

    try {
      const text = await this.generateText({ instructions, input, scope: 'code_planning' });
      const parsed = extractJsonObject(text);
      return {
        title: normalizeWhitespace(parsed.title) || fallback.title,
        body: String(parsed.body || '').trim() || fallback.body
      };
    } catch {
      return fallback;
    }
  }
}
