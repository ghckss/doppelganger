import {
  buildFallbackDesignSpec,
  buildFallbackProductPlan,
  buildFallbackPromptPlan,
  buildPullRequestDraft,
  type CodeTaskInput,
  type DesignSpec,
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
      '{"summary":"string","goal":"string","taskType":"string","successCriteria":["string"],"deliverables":["string"],"constraints":["string"],"relevantContext":["string"]}',
      'Be concrete, implementation-focused, and avoid inventing requirements.'
    ].join(' ');

    const input = [
      `User command: ${task.payload?.command || task.title}`,
      describeWorkspace(workspace)
    ].join('\n\n');

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
        relevantContext: compactArray(parsed.relevantContext).slice(0, 8).concat(fallback.relevantContext).slice(0, 8)
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
      `Prompt plan: ${JSON.stringify(promptPlan)}`,
      describeWorkspace(workspace)
    ].join('\n\n');

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
      `Prompt plan: ${JSON.stringify(promptPlan)}`,
      describeWorkspace(workspace)
    ].join('\n\n');

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
      `Prompt plan: ${JSON.stringify(task.result?.promptPlan || {})}`,
      `Commit summary: ${JSON.stringify(commitSummary)}`,
      `Review rounds: ${JSON.stringify(reviewRounds)}`,
      describeWorkspace(workspace)
    ].join('\n\n');

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
