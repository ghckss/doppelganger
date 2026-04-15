import { loadConfig } from './config.js';
import { createRepository } from './db.js';
import { createDomainRegistry } from './domain-registry.js';
import { LlmService } from './llm-service.js';
import { CodeTaskPlanner } from './code-task-planner.js';
import { TaskService } from './task-service.js';
import { CliGenerationClient } from './connectors/cli-generation-client.js';
import { ClaudeCliRunner, CodexCliRunner } from './connectors/codex-cli.js';
import { GitHubClient } from './connectors/github-client.js';
import { OpenAIClient } from './connectors/openai-client.js';
import { HovisReviewClient } from './connectors/hovis-review-client.js';
import { GenerationClient } from './generation-client.js';
import { SlackClient } from './connectors/slack-client.js';
import { WorkspaceRunner } from './connectors/workspace-runner.js';
import { createHttpServer } from './server.js';

export function createApplication({ cwd = process.cwd() } = {}) {
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
    externalAgentClient: externalAgentReviewClient
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
    cwd,
    taskService
  });

  return {
    config,
    repo,
    domains,
    taskService,
    server
  };
}
