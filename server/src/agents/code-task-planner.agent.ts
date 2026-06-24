import {
  buildPullRequestDraft,
  type CodeTaskInput,
  type RequirementContract,
  type WorkspaceSnapshot
} from '../modules/code-execution/code-task-prompts.ts';
import { normalizeWhitespace } from '../core/utils.ts';

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

function describeWorkspace(workspace: WorkspaceSnapshot): string {
  return [
    `Repository root: ${workspace.git.root}`,
    `Repo slug: ${workspace.git.repoSlug || 'unknown'}`,
    `Base branch: ${workspace.git.baseBranch}`,
    `Current branch: ${workspace.git.currentBranch}`,
    `Remote URL: ${workspace.git.remoteUrl || 'not configured'}`,
    `Scripts: ${JSON.stringify(workspace.scripts)}`,
    `Recommended checks: ${workspace.recommendedChecks.join(', ') || 'none'}`
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

  async createPullRequestDraft({
    task,
    workspace,
    commitSummary,
    contract
  }: {
    task: CodeTaskInput;
    workspace: WorkspaceSnapshot;
    commitSummary: string[];
    contract?: RequirementContract | null;
  }): Promise<{ title: string; body: string }> {
    const fallback = buildPullRequestDraft({ task, workspace, commitSummary, contract });
    if (!this.canUseModel('code_planning')) {
      return fallback;
    }

    const instructions = [
      'You write concise GitHub pull request titles and bodies.',
      'Return valid JSON only.',
      'Use this shape:',
      '{"title":"string","body":"string"}',
      'Mention the implemented change, validation, and remaining risks succinctly.'
    ].join(' ');

    const input = [
      `User command: ${task.payload?.command || task.title}`,
      `Requirement contract: ${JSON.stringify(contract || {})}`,
      `Commit summary: ${JSON.stringify(commitSummary)}`,
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
