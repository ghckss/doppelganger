import http from 'node:http';
import { type RequestBody } from './http-types.ts';

export function toRequestBody(value: unknown): RequestBody {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as RequestBody;
}

export function readStringField(body: RequestBody, key: string): string {
  return String(body[key] ?? '').trim();
}

export function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8'
  });
  response.end(JSON.stringify(payload, null, 2));
}

export async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function parseRequestBody(request: http.IncomingMessage): Promise<RequestBody> {
  const rawBody = await readBody(request);
  const contentType = request.headers['content-type'] || '';

  if (contentType.includes('application/json')) {
    const parsed = rawBody ? JSON.parse(rawBody) : {};
    return toRequestBody(parsed);
  }

  const params = new URLSearchParams(rawBody);
  return Object.fromEntries(params.entries()) as RequestBody;
}
