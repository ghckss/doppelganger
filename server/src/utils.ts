// @ts-nocheck
import crypto from 'node:crypto';

export function nowIso() {
  return new Date().toISOString();
}

export function createId(prefix = 'id') {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function readJson(value, fallback = null) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function writeJson(value) {
  return JSON.stringify(value ?? null);
}

export function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function truncateText(value, maxLength = 120) {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}…`;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function formatDateTime(value) {
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

export function formatSlackTimestamp(ts) {
  const seconds = Number(ts);
  if (!Number.isFinite(seconds)) {
    return null;
  }

  return new Date(seconds * 1000).toISOString();
}

export function toSlackText(value) {
  return String(value ?? '').trim();
}

export function listMissing(requiredPairs) {
  return requiredPairs.filter(([, value]) => !value).map(([key]) => key);
}

export function safeArray(value) {
  return Array.isArray(value) ? value : [];
}
