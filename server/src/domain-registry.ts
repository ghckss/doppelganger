import { createCodeExecutionDomain } from './domains/code-execution-domain.js';
import { createGitHubReviewDomain } from './domains/github-review-domain.js';
import { createSlackMentionDomain } from './domains/slack-mention-domain.js';

export interface DomainRegistry {
  slack_mention: unknown;
  github_review: unknown;
  code_execution: unknown;
}

export type SlackMentionDomainDependencies = Parameters<typeof createSlackMentionDomain>[0];
export type GitHubReviewDomainDependencies = Parameters<typeof createGitHubReviewDomain>[0];
export type CodeExecutionDomainDependencies = Parameters<typeof createCodeExecutionDomain>[0];
export type DomainDependencies =
  & SlackMentionDomainDependencies
  & GitHubReviewDomainDependencies
  & CodeExecutionDomainDependencies
  & Record<string, unknown>;

export function createDomainRegistry(dependencies: DomainDependencies): DomainRegistry {
  const registry = {
    slack_mention: createSlackMentionDomain(dependencies),
    github_review: createGitHubReviewDomain(dependencies),
    code_execution: createCodeExecutionDomain(dependencies)
  };

  return registry;
}
