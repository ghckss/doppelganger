// @ts-nocheck
import { createCodeExecutionDomain } from './domains/code-execution-domain.js';
import { createGitHubReviewDomain } from './domains/github-review-domain.js';
import { createSlackMentionDomain } from './domains/slack-mention-domain.js';

export function createDomainRegistry(dependencies) {
  const registry = {
    slack_mention: createSlackMentionDomain(dependencies),
    github_review: createGitHubReviewDomain(dependencies),
    code_execution: createCodeExecutionDomain(dependencies)
  };

  return registry;
}
