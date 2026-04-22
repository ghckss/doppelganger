import crypto from 'node:crypto';

export function nowIso(): string {
  return new Date().toISOString();
}

export function createId(prefix: string = 'id'): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function readJson<T = any>(value: string | null | undefined, fallback?: T): T {
  if (!value) {
    return (fallback ?? ({} as T));
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return (fallback ?? ({} as T));
  }
}

export function writeJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function normalizeWhitespace(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function truncateText(value: unknown, maxLength: number = 120): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}…`;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function formatDateTime(value: string | number | Date | null | undefined): string {
  if (!value) {
    return '-';
  }

  const date = typeof value === 'number' ? new Date(value) : new Date(String(value));
  if (Number.isNaN(date.valueOf())) {
    return String(value);
  }

  return new Intl.DateTimeFormat('ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    hour12: false
  }).format(date);
}

export function formatSlackTimestamp(ts: string | number | null | undefined): string | null {
  const seconds = Number(ts);
  if (!Number.isFinite(seconds)) {
    return null;
  }

  return new Date(seconds * 1000).toISOString();
}

export function toSlackText(value: unknown): string {
  return String(value ?? '').trim();
}

export function listMissing(requiredPairs: Array<[string, unknown]>): string[] {
  return requiredPairs.filter(([, value]) => !value).map(([key]) => key);
}

export function safeArray<T = any>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : ([] as T[]);
}
