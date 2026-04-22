import http from 'node:http';
import { sendJson } from '../http-utils.ts';
import { type TaskServiceApi } from '../http-types.ts';

export async function handleMetaRoutes({
  request,
  response,
  pathname,
  url,
  service
}: {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  pathname: string;
  url: URL;
  service: TaskServiceApi;
}): Promise<boolean> {
  if (request.method === 'GET' && pathname === '/') {
    sendJson(response, 200, {
      ok: true,
      message: 'API 서버가 실행 중입니다. React UI는 별도 클라이언트 서버에서 제공합니다.',
      endpoints: {
        health: '/healthz',
        meta: '/api/meta',
        tasks: '/api/tasks'
      }
    });
    return true;
  }

  if (request.method === 'GET' && pathname === '/healthz') {
    sendJson(response, 200, {
      ok: true,
      uptimeSeconds: Math.round(process.uptime())
    });
    return true;
  }

  if (request.method === 'GET' && pathname === '/api/tasks') {
    sendJson(response, 200, {
      tasks: service.listTasks({
        includeResolved: url.searchParams.get('includeResolved') === '1'
      }),
      projects: service.getCodeExecutionProjects(),
      readiness: service.getConnectorReadiness(),
      domains: service.getDomainCatalog()
    });
    return true;
  }

  if (request.method === 'GET' && pathname === '/api/meta') {
    sendJson(response, 200, {
      projects: service.getCodeExecutionProjects(),
      readiness: service.getConnectorReadiness(),
      domains: service.getDomainCatalog(),
      projectsRoot: service.config.workspace.projectsRoot,
      defaultAgentProvider: service.config.agent?.defaultProvider || 'codex'
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/internal/poll/slack-mentions') {
    const result = await service.pollSlackMentions();
    sendJson(response, 200, result);
    return true;
  }

  if (request.method === 'POST' && pathname === '/internal/poll/github-reviews') {
    const result = await service.pollGitHubReviews();
    sendJson(response, 200, result);
    return true;
  }

  return false;
}
