import { normalizeWhitespace, safeArray } from './utils.js';

export const SLACK_STYLE_MEMORY_STATE_KEY = 'slack_reply_style_memory_v1';
const SLACK_STYLE_MEMORY_VERSION = 1;

function toInteger(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.trunc(parsed);
}

function readMemoryObject(rawValue) {
  if (!rawValue) {
    return {};
  }
  try {
    const parsed = JSON.parse(String(rawValue));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function truncatePreservingLines(value, maxLength = 400) {
  const text = String(value || '');
  if (text.length <= maxLength) {
    return text;
  }
  if (maxLength <= 1) {
    return '…';
  }
  return `${text.slice(0, maxLength - 1)}…`;
}

function normalizeMultilineText(value, maxLength = 400) {
  const compacted = String(value || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => normalizeWhitespace(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return truncatePreservingLines(compacted, maxLength);
}

function normalizeSingleLineText(value, maxLength = 400) {
  const compacted = normalizeWhitespace(value);
  return truncatePreservingLines(compacted, maxLength);
}

function normalizeEntry(entry, fallbackCreatedAt) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const finalReply = normalizeMultilineText(entry.finalReply, 700);
  if (!finalReply) {
    return null;
  }

  const generatedReply = normalizeMultilineText(entry.generatedReply, 700);
  const createdAt = normalizeWhitespace(entry.createdAt) || fallbackCreatedAt;
  const finalFlat = normalizeWhitespace(finalReply);
  const generatedFlat = normalizeWhitespace(generatedReply);

  return {
    taskId: normalizeWhitespace(entry.taskId),
    prompt: normalizeSingleLineText(entry.prompt, 320),
    generatedReply,
    finalReply,
    changed: Boolean(entry.changed || (generatedFlat && generatedFlat !== finalFlat)),
    createdAt
  };
}

function buildDefaultMemory() {
  return {
    version: SLACK_STYLE_MEMORY_VERSION,
    updatedAt: '',
    entries: []
  };
}

export function parseSlackStyleMemory(rawValue) {
  const parsed = readMemoryObject(rawValue);
  const fallbackCreatedAt = new Date(0).toISOString();
  const normalizedEntries = safeArray(parsed.entries)
    .map((entry) => normalizeEntry(entry, fallbackCreatedAt))
    .filter(Boolean)
    .slice(0, 200);

  const memory = buildDefaultMemory();
  memory.updatedAt = normalizeWhitespace(parsed.updatedAt);
  memory.entries = normalizedEntries;
  return memory;
}

export function appendSlackStyleMemory(rawValue, entry, { maxEntries = 60 } = {}) {
  const previous = parseSlackStyleMemory(rawValue);
  const next = buildDefaultMemory();
  const safeNow = new Date().toISOString();
  const normalizedEntry = normalizeEntry(entry, safeNow);
  next.updatedAt = safeNow;
  if (!normalizedEntry) {
    next.entries = previous.entries;
    return next;
  }

  const dedupeKey = `${normalizedEntry.taskId}:${normalizeWhitespace(normalizedEntry.finalReply)}`;
  const existing = previous.entries.filter((item) => {
    const itemKey = `${normalizeWhitespace(item.taskId)}:${normalizeWhitespace(item.finalReply)}`;
    return itemKey !== dedupeKey;
  });

  const safeMaxEntries = Math.max(1, Math.min(200, toInteger(maxEntries, 60)));
  next.entries = [normalizedEntry, ...existing].slice(0, safeMaxEntries);
  return next;
}

export function stringifySlackStyleMemory(memory) {
  return JSON.stringify(parseSlackStyleMemory(JSON.stringify(memory || {})));
}

function splitSentences(text) {
  return String(text || '')
    .split(/[\n.!?]+/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);
}

function countRegex(text, pattern) {
  const matches = String(text || '').match(pattern);
  return matches ? matches.length : 0;
}

function buildToneDirective(replies) {
  const sentences = replies.flatMap((reply) => splitSentences(reply));
  if (sentences.length === 0) {
    return '';
  }

  const formalCount = sentences.filter((line) => /(합니다|드립니다|겠습니다|입니다|됩니다)$/.test(line)).length;
  const yoCount = sentences.filter((line) => /요$/.test(line)).length;
  if (formalCount >= Math.max(2, yoCount)) {
    return '문장 끝맺음은 "~합니다/~드립니다" 형태의 정중한 업무 톤을 유지합니다.';
  }
  if (yoCount >= 2) {
    return '문장 끝맺음은 "~해요/~해드립니다" 계열의 부드러운 존댓말 톤을 유지합니다.';
  }
  return '문장 끝맺음은 한국어 존댓말을 유지하되 과한 수식은 줄입니다.';
}

function buildLengthDirective(replies) {
  if (replies.length === 0) {
    return '';
  }

  const averageLength = Math.round(replies.reduce((sum, item) => sum + String(item).length, 0) / replies.length);
  if (averageLength <= 65) {
    return '답변 길이는 짧게 유지하고 핵심 사실만 먼저 전달합니다.';
  }
  if (averageLength >= 180) {
    return '답변은 2~4문장으로 설명하되 불필요한 배경 설명은 생략합니다.';
  }
  return '답변은 1~3문장으로 요약하고 바로 실행/공유 포인트를 포함합니다.';
}

function buildLineBreakDirective(replies) {
  if (replies.length === 0) {
    return '';
  }

  const multilineRate = replies.filter((reply) => String(reply).includes('\n')).length / replies.length;
  if (multilineRate >= 0.35) {
    return '답변은 핵심 항목별로 줄바꿈해 2~3줄로 작성합니다.';
  }
  if (multilineRate >= 0.15) {
    return '긴 문장은 1회 이상 줄바꿈해 읽기 쉽게 정리합니다.';
  }
  return '가능하면 한 문단으로 간결하게 답변합니다.';
}

function buildEmojiDirective(replies) {
  if (replies.length === 0) {
    return '';
  }

  const emojiLikeCount = replies.filter((reply) => /:[a-z0-9_+-]+:|[\u{1F300}-\u{1FAFF}]/u.test(String(reply))).length;
  if (emojiLikeCount === 0) {
    return '본문에는 이모지 사용을 피하고 텍스트 중심으로 답변합니다.';
  }
  if (emojiLikeCount / replies.length < 0.3) {
    return '이모지는 꼭 필요한 경우에만 최소한으로 사용합니다.';
  }
  return '이모지는 기존 사용 패턴과 비슷한 수준으로만 제한적으로 사용합니다.';
}

export function buildSlackStyleGuide(rawValue, { maxExamples = 3 } = {}) {
  const memory = parseSlackStyleMemory(rawValue);
  if (memory.entries.length === 0) {
    return null;
  }

  const sortedEntries = [...memory.entries].sort((a, b) => {
    if (a.changed !== b.changed) {
      return a.changed ? -1 : 1;
    }
    return String(b.createdAt).localeCompare(String(a.createdAt));
  });
  const recentReplies = sortedEntries
    .slice(0, 20)
    .map((entry) => entry.finalReply)
    .filter(Boolean);
  if (recentReplies.length === 0) {
    return null;
  }

  const directives = [
    buildToneDirective(recentReplies),
    buildLengthDirective(recentReplies),
    buildLineBreakDirective(recentReplies),
    buildEmojiDirective(recentReplies)
  ].filter(Boolean);

  const safeMaxExamples = Math.max(1, Math.min(5, toInteger(maxExamples, 3)));
  const examples = sortedEntries
    .filter((entry) => entry.finalReply)
    .slice(0, safeMaxExamples)
    .map((entry) => ({
      prompt: entry.prompt,
      generatedReply: entry.generatedReply,
      finalReply: entry.finalReply,
      changed: Boolean(entry.changed),
      createdAt: entry.createdAt
    }));

  return {
    sampleCount: memory.entries.length,
    editedSampleCount: memory.entries.filter((entry) => Boolean(entry.changed)).length,
    recentAverageLength: Math.round(recentReplies.reduce((sum, reply) => sum + String(reply).length, 0) / recentReplies.length),
    multilineRate: Math.round((recentReplies.filter((reply) => String(reply).includes('\n')).length / recentReplies.length) * 100),
    commonKeywordHints: [
      ['확인', /확인/g],
      ['공유', /공유/g],
      ['진행', /진행/g],
      ['정리', /정리/g],
      ['전달', /전달/g]
    ]
      .map(([term, pattern]) => ({ term, count: countRegex(recentReplies.join('\n'), pattern) }))
      .filter((item) => item.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 3)
      .map((item) => item.term),
    directives,
    examples
  };
}
