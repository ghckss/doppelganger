import { loadConfig } from './config.ts';
import { createRepository } from './db.ts';
import { createDomainRegistry } from './domain-registry.ts';
import { LlmService } from './llm-service.ts';
import { CodeTaskPlanner } from './code-task-planner.ts';
import { TaskService } from './task-service.ts';
import { CliGenerationClient } from './connectors/cli-generation-client.ts';
import { ClaudeCliRunner, CodexCliRunner } from './connectors/codex-cli.ts';
import { GitHubClient } from './connectors/github-client.ts';
import { OpenAIClient } from './connectors/openai-client.ts';
import { HovisReviewClient } from './connectors/hovis-review-client.ts';
import { GenerationClient } from './generation-client.ts';
import { SlackClient } from './connectors/slack-client.ts';
import { WorkspaceRunner } from './connectors/workspace-runner.ts';
import { createHttpServer } from './server.ts';

interface CreateApplicationOptions {
  cwd?: string;
}

export function createApplication({ cwd = process.cwd() }: CreateApplicationOptions = {}) {
  const config = loadConfig({ cwd });
  const repo = createRepository(config.app.databasePath);
  const slackClient = new SlackClient(config);
  const openaiClient = new OpenAIClient(config);
  const githubClient = new GitHubClient(config);
  const externalAgentReviewClient = new HovisReviewClient(config);
  const workspaceRunner = new WorkspaceRunner(config);
  const codexCliRunner = new CodexCliRunner({ config, workspaceRunner });
  const claudeCliRunner = new ClaudeCliRunner({ config, workspaceRunner });
  const cliGenerationClient = new CliGenerationClient(config);
  const generationClient = new GenerationClient({
    config,
    openaiClient,
    cliClient: cliGenerationClient,
    externalAgentClient: externalAgentReviewClient,
    hovisClient: externalAgentReviewClient
  });
  const llmService = new LlmService(generationClient);
  const codeTaskPlanner = new CodeTaskPlanner(generationClient);

  const domains = createDomainRegistry({
    config,
    repo,
    slackClient,
    openaiClient,
    githubClient,
    workspaceRunner,
    llmService,
    codexCliRunner,
    claudeCliRunner,
    codeTaskPlanner
  });

  const taskService = new TaskService({
    config,
    repo,
    domains
  });

  const server = createHttpServer({
    taskService,
    llmService
  });

  return {
    config,
    repo,
    domains,
    taskService,
    server
  };
}
