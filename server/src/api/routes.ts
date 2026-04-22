import http from 'node:http';
import { type LlmServiceApi, type TaskServiceApi } from './http-types.ts';
import { handleMeetingRoutes } from './routes/meeting.routes.ts';
import { handleMetaRoutes } from './routes/meta.routes.ts';
import { handleTaskRoutes } from './routes/task.routes.ts';

export async function handleApplicationRoute({
  request,
  response,
  url,
  service,
  summarizer
}: {
  request: http.IncomingMessage;
  response: http.ServerResponse;
  url: URL;
  service: TaskServiceApi;
  summarizer: LlmServiceApi;
}): Promise<boolean> {
  const pathname = url.pathname;

  if (await handleMeetingRoutes({
    request,
    response,
    pathname,
    summarizer
  })) {
    return true;
  }

  if (await handleMetaRoutes({
    request,
    response,
    pathname,
    url,
    service
  })) {
    return true;
  }

  if (await handleTaskRoutes({
    request,
    response,
    pathname,
    service
  })) {
    return true;
  }

  return false;
}
