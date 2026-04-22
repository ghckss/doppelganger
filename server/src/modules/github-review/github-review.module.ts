import { createGitHubReviewDomain } from '../../domains/github-review-domain.ts';

export type GitHubReviewModuleDependencies = Parameters<typeof createGitHubReviewDomain>[0];

export function createGitHubReviewModule(dependencies: GitHubReviewModuleDependencies) {
  return createGitHubReviewDomain(dependencies);
}
