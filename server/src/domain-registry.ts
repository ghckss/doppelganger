import { createCodeExecutionModule } from './modules/code-execution/code-execution.module.ts';
import { createGitHubReviewModule } from './modules/github-review/github-review.module.ts';
import { createSlackMentionModule } from './modules/slack/slack-mention.module.ts';
import type { DomainRegistry as DomainRegistryContract } from './runtime-contracts.ts';

export type DomainRegistry = DomainRegistryContract;

export type SlackMentionDomainDependencies = Parameters<typeof createSlackMentionModule>[0];
export type GitHubReviewDomainDependencies = Parameters<typeof createGitHubReviewModule>[0];
export type CodeExecutionDomainDependencies = Parameters<typeof createCodeExecutionModule>[0];
export type DomainDependencies =
  & SlackMentionDomainDependencies
  & GitHubReviewDomainDependencies
  & CodeExecutionDomainDependencies
  & Record<string, unknown>;

export function createDomainRegistry(dependencies: DomainDependencies): DomainRegistry {
  const registry: DomainRegistry = {
    slack_mention: createSlackMentionModule(dependencies),
    github_review: createGitHubReviewModule(dependencies),
    code_execution: createCodeExecutionModule(dependencies)
  };

  return registry;
}
