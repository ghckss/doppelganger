import { createSlackMentionDomain } from '../../domains/slack-mention-domain.ts';

export type SlackMentionModuleDependencies = Parameters<typeof createSlackMentionDomain>[0];

export function createSlackMentionModule(dependencies: SlackMentionModuleDependencies) {
  return createSlackMentionDomain(dependencies);
}
