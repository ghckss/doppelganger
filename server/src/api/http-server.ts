import http from 'node:http';
import { applyCorsHeaders, buildAllowedCorsOrigins } from './http-cors.ts';
import { handleApplicationRoute } from './routes.ts';
import { sendJson } from './http-utils.ts';
import { type LlmServiceApi, type TaskServiceApi } from './http-types.ts';

export function createHttpServer({
  taskService,
  llmService
}: {
  taskService: unknown;
  llmService: unknown;
}): http.Server {
  const service = taskService as TaskServiceApi;
  const summarizer = llmService as LlmServiceApi;
  const allowedCorsOrigins = buildAllowedCorsOrigins(service?.config || {});

  return http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    try {
      const corsApplied = applyCorsHeaders(request, response, allowedCorsOrigins);
      if (request.method === 'OPTIONS') {
        if (corsApplied) {
          response.writeHead(204);
          response.end();
          return;
        }
        response.writeHead(404);
        response.end();
        return;
      }

      const handled = await handleApplicationRoute({
        request,
        response,
        url,
        service,
        summarizer
      });

      if (!handled) {
        sendJson(response, 404, {
          ok: false,
          error: '요청한 경로가 존재하지 않습니다.'
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, {
        ok: false,
        error: message
      });
    }
  });
}
