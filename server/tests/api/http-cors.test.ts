import assert from 'node:assert/strict';
import type http from 'node:http';
import test from 'node:test';
import { applyCorsHeaders, buildAllowedCorsOrigins } from '../../src/api/http-cors.ts';

function createResponseMock(headers: Record<string, string>): http.ServerResponse {
  return {
    setHeader(name: string, value: string | string[]) {
      headers[name] = Array.isArray(value) ? value.join(',') : String(value);
      return this;
    }
  } as unknown as http.ServerResponse;
}

test('applyCorsHeaders includes DELETE for allowed origins', () => {
  const allowedOrigins = buildAllowedCorsOrigins({
    app: {
      baseUrl: 'http://127.0.0.1:4318',
      corsOrigins: []
    }
  });
  const headers: Record<string, string> = {};
  const request = {
    headers: {
      origin: 'http://127.0.0.1:5173'
    }
  } as unknown as http.IncomingMessage;
  const response = createResponseMock(headers);

  const applied = applyCorsHeaders(request, response, allowedOrigins);
  assert.equal(applied, true);
  assert.equal(headers['Access-Control-Allow-Methods'], 'GET,POST,DELETE,OPTIONS');
});
