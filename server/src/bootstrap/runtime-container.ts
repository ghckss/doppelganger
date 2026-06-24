import { CodeTaskPlanner } from '../agents/code-task-planner.agent.ts';
import { CliGenerationClient } from '../agents/cli-generation.agent.ts';
import { ClaudeCliRunner, CodexCliRunner } from '../agents/cli-runner.agent.ts';
import { HovisReviewClient } from '../agents/external-review.agent.ts';
import { loadConfig } from '../core/config.ts';
import { GitHubClient } from '../connectors/github-client.ts';
import { OpenAIClient } from '../connectors/openai-client.ts';
import { SlackClient } from '../connectors/slack-client.ts';
import { WorkspaceRunner } from '../connectors/workspace-runner.ts';
import { createRepository } from '../infra/db.ts';
import { GenerationClient } from '../services/generation-client.ts';
import { LlmService } from '../services/llm-service.ts';
import type { AppConfig, Repository } from '../contracts/runtime-contracts.ts';

interface CreateRuntimeContainerOptions {
  cwd?: string;
}

export interface RuntimeContainer {
  config: AppConfig;
  repo: Repository;
  domainDependencies: {
    config: AppConfig;
    repo: Repository;
    serverStartedAtUnixSeconds: number;
    slackClient: SlackClient;
    openaiClient: OpenAIClient;
    githubClient: GitHubClient;
    workspaceRunner: WorkspaceRunner;
    llmService: LlmService;
    codexCliRunner: CodexCliRunner;
    claudeCliRunner: ClaudeCliRunner;
    codeTaskPlanner: CodeTaskPlanner;
  };
  llmService: LlmService;
}

export function createRuntimeContainer({ cwd = process.cwd() }: CreateRuntimeContainerOptions = {}): RuntimeContainer {
  const config = loadConfig({ cwd });
  // 서버 프로세스가 열린 시점. 슬랙 수집은 이 시각 이후 데이터만 대상으로 하며,
  // 서버가 닫혀 있던 동안 쌓인 메시지는 무시한다.
  const serverStartedAtUnixSeconds = Math.floor(Date.now() / 1000);
  const repo = createRepository(config.app.databasePath) as Repository;
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

  return {
    config,
    repo,
    domainDependencies: {
      config,
      repo,
      serverStartedAtUnixSeconds,
      slackClient,
      openaiClient,
      githubClient,
      workspaceRunner,
      llmService,
      codexCliRunner,
      claudeCliRunner,
      codeTaskPlanner
    },
    llmService
  };
}
