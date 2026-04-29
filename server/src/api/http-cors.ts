import http from 'node:http';

const DEFAULT_DEV_CORS_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173'
]);

function normalizeOrigin(value: unknown): string {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return '';
  }

  try {
    const parsed = new URL(normalized);
    if (!parsed.protocol || !parsed.host) {
      return '';
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
}

export function buildAllowedCorsOrigins(config: { app?: { baseUrl?: unknown; corsOrigins?: unknown[] } } | undefined): Set<string> {
  const allowed = new Set(DEFAULT_DEV_CORS_ORIGINS);
  const baseOrigin = normalizeOrigin(config?.app?.baseUrl);
  if (baseOrigin) {
    allowed.add(baseOrigin);
  }

  const configuredOrigins = Array.isArray(config?.app?.corsOrigins) ? config.app.corsOrigins : [];
  for (const origin of configuredOrigins) {
    const normalized = normalizeOrigin(origin);
    if (normalized) {
      allowed.add(normalized);
    }
  }

  return allowed;
}

export function applyCorsHeaders(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  allowedOrigins: Set<string>
): boolean {
  const origin = String(request.headers.origin || '').trim();
  if (!origin || !allowedOrigins.has(origin)) {
    return false;
  }

  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Vary', 'Origin');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  response.setHeader('Access-Control-Max-Age', '86400');
  return true;
}
