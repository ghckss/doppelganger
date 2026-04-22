import { createRuntimeContainer } from './runtime-container.ts';
import { createDomainRegistry } from './domain-registry.ts';
import { TaskService } from '../modules/tasks/task.service.ts';
import { createHttpServer } from '../api/http-server.ts';

interface CreateApplicationOptions {
  cwd?: string;
}

export function createApplication({ cwd = process.cwd() }: CreateApplicationOptions = {}) {
  const runtime = createRuntimeContainer({ cwd });
  const { config, repo, domainDependencies, llmService } = runtime;

  const domains = createDomainRegistry(domainDependencies);

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
