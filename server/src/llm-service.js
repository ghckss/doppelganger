import { normalizeWhitespace, safeArray, truncateText } from './utils.js';

const SLACK_REPLY_CATEGORIES = {
  action_request: {
    label: '액션 요청',
    requestedAction: '봤고, 처리에 들어간다는 점과 다음 업데이트 시점을 분명하게 답변',
    reactionName: 'white_check_mark'
  },
  owner_incident: {
    label: '책임자 호출 / 장애 상황',
    requestedAction: 'owner를 확인하고 상황 파악 및 대응 시작 상태를 분명하게 답변',
    reactionName: ''
  },
  info_share_confirmation: {
    label: '정보 공유 + 확인 요청',
    requestedAction: '읽었고 필요한 경우 의견을 더하겠다는 점을 짧게 답변',
    reactionName: 'white_check_mark'
  },
  decision_request: {
    label: '의사결정 요청',
    requestedAction: '판단 또는 판단 시점을 분명하게 답변',
    reactionName: ''
  },
  conversation_participation: {
    label: '대화 참여 유도',
    requestedAction: '컨텍스트를 이해했고 필요한 시점에 참여하겠다는 점을 답변',
    reactionName: ''
  },
  reminder_ping: {
    label: '리마인드 / 핑',
    requestedAction: '놓치지 않았고 곧 처리한다는 점을 답변',
    reactionName: ''
  }
};

const DEFAULT_SLACK_REPLY_CATEGORY = 'action_request';
const GITHUB_REVIEW_DISCLAIMER = '해당 리뷰는, pr의 diff 만 확인하여 작성된 리뷰입니다. 코드 작성자의 판단하에 수정 여부를 결정해주세요.';
const NON_DEVELOPER_TERM_RULES = [
  { pattern: /스키마/gi, replacement: '항목 구조' },
  { pattern: /엔드포인트/gi, replacement: '연결 주소' },
  { pattern: /리팩터링/gi, replacement: '구조 정리' },
  { pattern: /트러블슈팅/gi, replacement: '문제 해결' },
  { pattern: /디버깅/gi, replacement: '원인 확인' }
];
const REQUESTED_ELEMENT_DEFINITION_RULES = [
  {
    key: '범위',
    patterns: [/범위/, /\bscope\b/i],
    definition: '이번 요청에서 다룰 내용과 제외할 내용을 나눈 범위'
  },
  {
    key: '우선순위',
    patterns: [/우선순위/, /\bpriority\b/i],
    definition: '무엇을 먼저 처리할지 정한 순서'
  },
  {
    key: '일정',
    patterns: [/일정|마감|시점|언제까지|ETA/i, /\btimeline\b/i],
    definition: '언제 어떤 결과를 공유할지 정한 시간 계획'
  },
  {
    key: '요구사항',
    patterns: [/요구사항|요건/i, /\brequirement/i],
    definition: '완료로 판단하기 위한 필수 조건'
  },
  {
    key: '지표',
    patterns: [/지표|성과|KPI/i, /\bmetric/i],
    definition: '결과를 판단하는 수치'
  },
  {
    key: '정책',
    patterns: [/정책|룰|규칙/i, /\bpolicy/i],
    definition: '운영 판단과 예외 처리 규칙'
  },
  {
    key: '플로우',
    patterns: [/플로우|흐름/i, /\bflow/i],
    definition: '사용자가 목적에 도달하는 단계 순서'
  },
  {
    key: '사용자 시나리오',
    patterns: [/사용자\s*시나리오|유저\s*시나리오/i, /\buser\s*scenario/i],
    definition: '사용자가 실제로 겪는 상황과 행동 순서'
  },
  {
    key: '와이어프레임',
    patterns: [/와이어프레임/i, /\bwireframe/i],
    definition: '화면 구조를 빠르게 표현한 설계안'
  },
  {
    key: '상품',
    patterns: [/상품|product/i],
    definition: '사용자에게 제공되는 판매 단위'
  },
  {
    key: '번들',
    patterns: [/번들|bundle/i],
    definition: '여러 상품을 묶어 하나처럼 제공하는 구성'
  }
];
const REQUEST_DRIFT_RULES = [
  {
    id: 'product_info',
    requestPatterns: [/상품|스토어\s*상품|가격|번들|bundle|catalog|카탈로그|구성|정책|price|pricing/i],
    responseMustInclude: [/상품|가격|번들|bundle|catalog|카탈로그|구성|정책|price|pricing/i],
    responseDriftPatterns: [/\bapi\b|endpoint|엔드포인트|graphql|rest|axios|fetch|controller|service/i],
    reason: '상품/정책 정보 확인 요청인데 API 사용 방식 설명으로 이탈했습니다.'
  }
];

function humanizeSlackText(value) {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return '';
  }

  return normalized
    .replace(/<@[^>]+>/g, '')
    .replace(/<#[^|>]+\|([^>]+)>/g, '#$1')
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<([^>]+)>/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildThreadTranscript(messages) {
  return safeArray(messages)
    .map((message, index) => {
      const author = message.metadata?.userName || message.metadata?.user || 'unknown';
      return `${index + 1}. [${author}] ${normalizeWhitespace(message.content)}`;
    })
    .join('\n');
}

function normalizeMultilineText(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean)
    .join('\n')
    .trim();
}

function normalizeSlackStyleGuide(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const directives = safeArray(value.directives)
    .map((item) => normalizeWhitespace(item))
    .filter(Boolean)
    .slice(0, 8);
  const keywords = safeArray(value.commonKeywordHints)
    .map((item) => normalizeWhitespace(item))
    .filter(Boolean)
    .slice(0, 5);
  const examples = safeArray(value.examples)
    .map((item) => {
      const prompt = normalizeWhitespace(item?.prompt);
      const generatedReply = normalizeMultilineText(item?.generatedReply);
      const finalReply = normalizeMultilineText(item?.finalReply);
      if (!finalReply) {
        return null;
      }
      return {
        prompt: truncateText(prompt, 140),
        generatedReply: truncateText(generatedReply, 220),
        finalReply: truncateText(finalReply, 220),
        changed: Boolean(item?.changed)
      };
    })
    .filter(Boolean)
    .slice(0, 3);

  if (directives.length === 0 && keywords.length === 0 && examples.length === 0) {
    return null;
  }

  return {
    sampleCount: Number.isFinite(Number(value.sampleCount))
      ? Math.max(0, Math.min(500, Math.trunc(Number(value.sampleCount))))
      : 0,
    editedSampleCount: Number.isFinite(Number(value.editedSampleCount))
      ? Math.max(0, Math.min(500, Math.trunc(Number(value.editedSampleCount))))
      : 0,
    recentAverageLength: Number.isFinite(Number(value.recentAverageLength))
      ? Math.max(0, Math.min(1000, Math.trunc(Number(value.recentAverageLength))))
      : 0,
    multilineRate: Number.isFinite(Number(value.multilineRate))
      ? Math.max(0, Math.min(100, Math.trunc(Number(value.multilineRate))))
      : 0,
    directives,
    keywords,
    examples
  };
}

function buildSlackStyleGuideTranscript(styleGuide) {
  if (!styleGuide) {
    return '';
  }

  const lines = [
    'User reply style profile:'
  ];
  if (styleGuide.sampleCount > 0) {
    lines.push(`Samples: ${styleGuide.sampleCount}`);
  }
  if (styleGuide.editedSampleCount > 0) {
    lines.push(`Edited samples: ${styleGuide.editedSampleCount}`);
  }
  if (styleGuide.recentAverageLength > 0) {
    lines.push(`Average reply length: ${styleGuide.recentAverageLength} chars`);
  }
  if (styleGuide.multilineRate > 0) {
    lines.push(`Multiline usage rate: ${styleGuide.multilineRate}%`);
  }
  if (styleGuide.directives.length > 0) {
    lines.push('Style directives:');
    styleGuide.directives.forEach((directive, index) => {
      lines.push(`${index + 1}. ${directive}`);
    });
  }
  if (styleGuide.keywords.length > 0) {
    lines.push(`Common wording hints: ${styleGuide.keywords.join(', ')}`);
  }
  if (styleGuide.examples.length > 0) {
    lines.push('User-approved reply examples:');
    styleGuide.examples.forEach((example, index) => {
      lines.push(`${index + 1}. prompt: ${example.prompt || '(prompt unavailable)'}`);
      if (example.changed && example.generatedReply) {
        lines.push(`   generated: ${example.generatedReply}`);
      }
      lines.push(`   final: ${example.finalReply}`);
    });
  }
  return lines.join('\n');
}

function sanitizeSlackTonePhrases(value) {
  const stripped = String(value || '')
    .replace(/이\s*기준으로\s*공유(?:하|드)면\s*됩니다\.?/gi, '')
    .replace(/이\s*기준으로\s*진행(?:하|해)면\s*됩니다\.?/gi, '')
    .replace(/요청\s*기준에서\s*/gi, '')
    .replace(/코드\s*검토\s*기준으로(?:는)?\s*/gi, '')
    .replace(/코드\s*기준으로(?:는)?\s*/gi, '')
    .replace(/기준으로(?:는)?\s*/gi, '')
    .replace(/바탕으로\s*/gi, '')
    .replace(/기반으로\s*/gi, '')
    .replace(/우선\s*확인\s*중(?:이며)?[,，]?\s*/gi, '')
    .replace(/먼저\s*확인(?:하고)?[,，]?\s*/gi, '')
    .replace(/관련\s*코드\s*[:：]?\s*[A-Za-z0-9_./-]+\.[A-Za-z0-9]+:\d+/gi, '')
    .replace(/\b[A-Za-z0-9_./-]+\.[A-Za-z0-9]+:\d+\b/g, '')
    .replace(/\s{2,}/g, ' ');

  return normalizeMultilineText(stripped);
}

function stripSlackEvidenceText(value) {
  const lines = String(value || '')
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean)
    .filter((line) => !/^근거\s*링크\s*[:：]/i.test(line))
    .filter((line) => !/https?:\/\//i.test(line));
  return lines.join('\n').trim();
}

function stripGitHubEvidenceSection(value) {
  const rawLines = String(value || '').split(/\r?\n/);
  const output = [];
  let droppingEvidenceSection = false;

  for (const rawLine of rawLines) {
    const line = String(rawLine || '');
    const normalized = normalizeWhitespace(line);
    if (/^##\s*근거\s*링크/i.test(normalized)) {
      droppingEvidenceSection = true;
      continue;
    }
    if (droppingEvidenceSection && /^##\s+/.test(normalized)) {
      droppingEvidenceSection = false;
    }
    if (droppingEvidenceSection) {
      continue;
    }
    if (/^근거\s*링크\s*[:：]/i.test(normalized)) {
      continue;
    }
    output.push(line);
  }

  return normalizeMultilineText(output.join('\n'));
}

function toNonDeveloperWording(value) {
  let text = String(value || '');
  for (const rule of NON_DEVELOPER_TERM_RULES) {
    text = text.replace(rule.pattern, rule.replacement);
  }
  return normalizeMultilineText(text);
}

function isStructuredSlackSummary(value) {
  const normalized = String(value || '');
  return /(응답 분류|핵심 내용|대화 흐름|마지막 멘션 의도|권장 대응|권장 반응):/.test(normalized);
}

function truncatePatch(patch, maxLength = 1400) {
  const normalized = String(patch || '').trim();
  if (!normalized) {
    return '(patch unavailable)';
  }

  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1)}…`
    : normalized;
}

function buildPullRequestTranscript(files, { maxFiles = 20, patchMaxLength = 1400 } = {}) {
  return safeArray(files)
    .slice(0, maxFiles)
    .map((file, index) => [
      `${index + 1}. ${file.path} [${file.status}] +${file.additions}/-${file.deletions}`,
      truncatePatch(file.patch, patchMaxLength)
    ].join('\n'))
    .join('\n\n');
}

function escapePathSegment(value) {
  return encodeURIComponent(String(value || '')).replace(/%2F/g, '/');
}

function normalizeGitRef(value) {
  return normalizeWhitespace(value).replace(/[^A-Za-z0-9._/-]/g, '');
}

function parseFileRef(value) {
  const raw = normalizeWhitespace(value);
  if (!raw) {
    return null;
  }

  const hashLine = raw.match(/^(.+?)#L(\d+)$/i);
  if (hashLine) {
    return {
      path: normalizeWhitespace(hashLine[1]),
      line: Number(hashLine[2]) || 0
    };
  }

  const colonLine = raw.match(/^(.+?):(\d+)$/);
  if (colonLine) {
    return {
      path: normalizeWhitespace(colonLine[1]),
      line: Number(colonLine[2]) || 0
    };
  }

  return {
    path: raw,
    line: 0
  };
}

function buildGitHubBlobLink({ repoSlug, ref, path, line = 0 }) {
  const normalizedRepoSlug = normalizeWhitespace(repoSlug);
  const normalizedRef = normalizeGitRef(ref);
  const normalizedPath = normalizeWhitespace(path).replace(/^\/+/, '');
  if (!normalizedRepoSlug || !normalizedRef || !normalizedPath) {
    return '';
  }

  const base = `https://github.com/${normalizedRepoSlug}/blob/${escapePathSegment(normalizedRef)}/${escapePathSegment(normalizedPath)}`;
  if (Number.isFinite(line) && Number(line) > 0) {
    return `${base}#L${Math.trunc(Number(line))}`;
  }
  return base;
}

function collectGitHubEvidenceLinksFromFindings(findings, { repoSlug, ref }) {
  const links = [];
  for (const finding of safeArray(findings)) {
    for (const fileRef of safeArray(finding.fileRefs)) {
      const parsed = parseFileRef(fileRef);
      if (!parsed?.path) {
        continue;
      }
      const link = buildGitHubBlobLink({
        repoSlug,
        ref,
        path: parsed.path,
        line: parsed.line
      });
      if (link) {
        links.push(link);
      }
    }
  }
  return [...new Set(links)];
}

function collectGitHubEvidenceLinksFromFiles(files, { repoSlug, ref, max = 5 } = {}) {
  const links = [];
  for (const file of safeArray(files)) {
    const normalizedPath = normalizeWhitespace(file.path || file.filename || '');
    if (!normalizedPath) {
      continue;
    }

    const link = buildGitHubBlobLink({
      repoSlug,
      ref,
      path: normalizedPath
    });
    if (link) {
      links.push(link);
    }
    if (links.length >= max) {
      break;
    }
  }

  return [...new Set(links)];
}

function resolveGitHubEvidenceLinks({ pullRequest, files, findings, max = 5 } = {}) {
  const repoSlug = pullRequest?.repoSlug || '';
  const ref = pullRequest?.headSha || pullRequest?.headRef || 'main';
  const findingLinks = collectGitHubEvidenceLinksFromFindings(findings, { repoSlug, ref });
  const fallbackLinks = findingLinks.length === 0
    ? collectGitHubEvidenceLinksFromFiles(files, { repoSlug, ref, max })
    : [];
  return (findingLinks.length > 0 ? findingLinks : fallbackLinks).slice(0, max);
}

function normalizeFinding(finding, index) {
  return {
    id: normalizeWhitespace(finding.id) || `finding-${index + 1}`,
    severity: normalizeWhitespace(finding.severity) || 'medium',
    category: normalizeWhitespace(finding.category) || 'code_quality',
    title: normalizeWhitespace(finding.title) || '검토 의견',
    description: normalizeWhitespace(finding.description) || '설명이 제공되지 않았습니다.',
    fileRefs: safeArray(finding.fileRefs).map((item) => normalizeWhitespace(item)).filter(Boolean),
    suggestedFix: normalizeWhitespace(finding.suggestedFix),
    mustFix: Boolean(finding.mustFix)
  };
}

function severityEmoji(severity) {
  const normalized = normalizeWhitespace(severity).toLowerCase();
  if (normalized === 'critical' || normalized === 'high') {
    return '🔴';
  }
  if (normalized === 'medium') {
    return '🟡';
  }
  return '🟢';
}

function categoryLabel(category) {
  const normalized = normalizeWhitespace(category).toLowerCase();
  if (normalized === 'bug') return '버그';
  if (normalized === 'regression') return '회귀 위험';
  if (normalized === 'missing_test') return '테스트 누락';
  if (normalized === 'spec_mismatch') return '명세 불일치';
  if (normalized === 'security') return '보안';
  if (normalized === 'performance') return '성능';
  if (normalized === 'maintainability') return '유지보수성';
  if (normalized === 'design_gap') return '설계 공백';
  return '코드 품질';
}

function severityRank(severity) {
  const normalized = normalizeWhitespace(severity).toLowerCase();
  if (normalized === 'critical') return 0;
  if (normalized === 'high') return 1;
  if (normalized === 'medium') return 2;
  return 3;
}

function formatGitHubReviewBody({ summary, findings }) {
  const sortedFindings = [...findings].sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
  const lines = [
    '## 요약',
    `- ${normalizeWhitespace(summary) || '요약을 생성하지 못했습니다.'}`
  ];

  lines.push('', '## 리뷰 의견');
  if (sortedFindings.length > 0) {
    for (const finding of sortedFindings) {
      const emoji = severityEmoji(finding.severity);
      const category = categoryLabel(finding.category);
      const refs = finding.fileRefs.length > 0 ? finding.fileRefs.join(', ') : '파일 참조 없음';
      lines.push(`- ${emoji} [${category}] ${finding.title}`);
      lines.push(`  파일: ${refs}`);
      lines.push(`  설명: ${finding.description}`);
      if (finding.suggestedFix) {
        lines.push(`  제안: ${finding.suggestedFix}`);
      }
    }
  } else {
    lines.push('- 이번 변경에서 즉시 수정이 필요한 이슈는 찾지 못했습니다.');
  }

  return prependGitHubReviewDisclaimer(lines.join('\n'));
}

function prependGitHubReviewDisclaimer(body) {
  const text = String(body || '').trim();
  if (!text) {
    return GITHUB_REVIEW_DISCLAIMER;
  }
  if (text.startsWith(GITHUB_REVIEW_DISCLAIMER)) {
    return text;
  }
  return `${GITHUB_REVIEW_DISCLAIMER}\n\n${text}`;
}

function resolveGenerationMode(generationClient, scope) {
  if (!generationClient) {
    return 'fallback';
  }
  if (typeof generationClient.getMode === 'function') {
    return generationClient.getMode(scope);
  }
  if (typeof generationClient.isConfigured === 'function') {
    return generationClient.isConfigured(scope) ? 'openai' : 'fallback';
  }
  return 'openai';
}

function extractTextResponse(response) {
  if (typeof response === 'string') {
    return {
      text: response,
      provider: 'openai',
      agentProvider: ''
    };
  }

  return {
    text: String(response?.text || ''),
    provider: String(response?.provider || 'openai'),
    agentProvider: String(response?.agentProvider || '')
  };
}

function extractJsonObject(text) {
  const trimmed = text.trim();
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error('Model response did not contain JSON');
  }

  return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
}

function buildFallbackGitHubReview({ task, pullRequest, files, errorMessage = '' }) {
  const changedFiles = safeArray(files).length;
  const repoSlug = pullRequest?.repoSlug || task.payload?.repoSlug || 'unknown';
  const pullNumber = pullRequest?.number || task.payload?.pullNumber || '';
  const summaryBase = `${repoSlug}#${pullNumber} 변경(${changedFiles}개 파일) 리뷰를 생성했습니다.`;
  const summary = errorMessage
    ? normalizeWhitespace(`${summaryBase} 자동 생성 실패가 발생해 최소 초안으로 남깁니다.`)
    : normalizeWhitespace(summaryBase);

  const findings = [];
  const approval = 'approved_with_no_changes';

  return {
    summary,
    approval,
    findings,
    reviewBody: formatGitHubReviewBody({
      summary,
      findings
    }),
    evidenceLinks: resolveGitHubEvidenceLinks({ pullRequest, files, findings }),
    provider: errorMessage ? `fallback:${errorMessage}` : 'fallback',
    agentProvider: ''
  };
}

function isGenerationTimeoutError(error) {
  return /(제한 시간을 초과|timeout|timed out)/i.test(String(error?.message || ''));
}

function buildExternalAgentReviewSummary(reviewBody, pullRequest) {
  const lines = String(reviewBody || '')
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);

  for (const line of lines) {
    const normalized = line
      .replace(/^#+\s*/, '')
      .replace(/^[-*+]\s+/, '')
      .replace(/^\d+\.\s+/, '')
      .trim();
    if (!normalized) {
      continue;
    }
    if (/^(요약|리뷰 의견|summary|review)$/i.test(normalized)) {
      continue;
    }
    return truncateText(normalized, 120);
  }

  const repoSlug = pullRequest?.repoSlug || 'unknown';
  const pullNumber = pullRequest?.number ? `#${pullRequest.number}` : '';
  return `${repoSlug}${pullNumber} 외부 에이전트 리뷰 결과를 생성했습니다.`;
}

function looksLikeRequestMessage(value) {
  const text = normalizeWhitespace(value);
  if (!text) {
    return false;
  }

  return /(확인|검토|리뷰|부탁|가능할까요|가능한가요|해주세요|해주실|언제쯤|핑|공유드립니다|의견|판단|진행해도|가도 될|될까요|할까요|해볼까요|해보죠|요청|필요합니다|정해주면 됩니다|어떻게 진행)/i.test(text);
}

function summarizeTopic(value) {
  return truncateText(
    String(value || '')
      .replace(/[?!.]+$/g, '')
      .trim(),
    90
  );
}

function inferGenericSlackTopic({ category, targetText, latestText }) {
  const focusText = `${targetText || ''} ${latestText || ''}`;

  switch (category) {
    case 'owner_incident':
      return '장애 대응';
    case 'info_share_confirmation':
      return '공유된 내용';
    case 'decision_request':
      return '진행 방향 결정';
    case 'conversation_participation':
      return '관련 논의';
    case 'reminder_ping':
      return '기존 요청';
    case 'action_request':
    default:
      if (/(리뷰|검토|봐주)/i.test(focusText)) {
        return '검토 요청';
      }
      if (/(수정|고쳐|반영|처리|조치|대응)/i.test(focusText)) {
        return '처리 요청';
      }
      if (/(언제|일정|시간|ETA|마감)/i.test(focusText)) {
        return '일정 확인 요청';
      }
      return '업무 요청';
  }
}

function selectSlackTopic({ targetText, firstText, latestText, threadMessages }) {
  const candidates = [
    ...safeArray(threadMessages).map((message) => humanizeSlackText(message.content)),
    latestText,
    firstText,
    targetText
  ]
    .map((item) => normalizeWhitespace(item))
    .filter(Boolean);

  const descriptive = candidates.find((item) => !looksLikeRequestMessage(item) && item.length >= 8);
  return descriptive ? summarizeTopic(descriptive) : '';
}

function normalizeReactionName(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/^:+|:+$/g, '')
    .replace(/\s+/g, '_')
    .toLowerCase();
  return normalized;
}

function getSlackReplyCategory(category) {
  return SLACK_REPLY_CATEGORIES[category] || SLACK_REPLY_CATEGORIES[DEFAULT_SLACK_REPLY_CATEGORY];
}

function normalizeSlackReplyCategory(value) {
  const normalized = normalizeWhitespace(value).toLowerCase();
  if (normalized in SLACK_REPLY_CATEGORIES) {
    return normalized;
  }
  return DEFAULT_SLACK_REPLY_CATEGORY;
}

function normalizeCodeReviewContext(context) {
  if (!context || typeof context !== 'object') {
    return null;
  }

  if (!context.enabled || context.analysisStatus !== 'completed') {
    return null;
  }

  return {
    enabled: true,
    analysisStatus: 'completed',
    repository: normalizeWhitespace(context.selectedRepo || context.repository),
    repoSlug: normalizeWhitespace(context.selectedRepoSlug || context.repoSlug),
    analysisBaseBranch: normalizeWhitespace(context.analysisBaseBranch || context.baseBranch || 'master'),
    summary: normalizeWhitespace(context.summary),
    selectionReason: normalizeWhitespace(context.selectionReason),
    replyHints: safeArray(context.replyHints).map((item) => normalizeWhitespace(item)).filter(Boolean).slice(0, 5),
    findings: safeArray(context.findings)
      .map((finding) => ({
        path: normalizeWhitespace(finding.path),
        line: Number(finding.line),
        excerpt: truncateText(normalizeWhitespace(finding.excerpt), 180),
        term: normalizeWhitespace(finding.term)
      }))
      .filter((finding) => finding.path && Number.isFinite(finding.line) && finding.line > 0)
      .slice(0, 8)
  };
}

function buildCodeReviewTranscript(context) {
  const normalized = normalizeCodeReviewContext(context);
  if (!normalized) {
    return '';
  }

  const lines = [
    'Code review context:',
    `- Repository: ${normalized.repository || 'unknown'}`,
    `- Summary: ${normalized.summary || '요약 없음'}`,
    `- Selection reason: ${normalized.selectionReason || '없음'}`
  ];
  if (normalized.replyHints.length > 0) {
    lines.push(`- Reply hints: ${normalized.replyHints.join(' | ')}`);
  }

  if (normalized.findings.length === 0) {
    lines.push('- Findings: (none)');
  } else {
    lines.push('- Findings:');
    normalized.findings.forEach((finding, index) => {
      lines.push(`${index + 1}. ${finding.path}:${finding.line} | ${finding.excerpt}`);
    });
  }

  return lines.join('\n');
}

function resolveSlackEvidenceLinks({ task, codeReviewContext }) {
  const links = [];
  const normalizedContext = normalizeCodeReviewContext(codeReviewContext);
  if (normalizedContext?.findings?.length) {
    const repoSlug = normalizedContext.repoSlug;
    const ref = normalizedContext.analysisBaseBranch || 'master';
    for (const finding of normalizedContext.findings) {
      const link = buildGitHubBlobLink({
        repoSlug,
        ref,
        path: finding.path,
        line: finding.line
      });
      if (link) {
        links.push(link);
      }
    }
  }

  const sourceUrl = normalizeWhitespace(task?.source_url || task?.sourceUrl || task?.payload?.permalink || '');
  if (links.length === 0 && sourceUrl) {
    links.push(sourceUrl);
  }

  return [...new Set(links)].slice(0, 2);
}

function detectSlackRequestDrift({ targetText, latestText, candidateReply, fallbackReply }) {
  const requestCorpus = normalizeWhitespace(`${targetText || ''} ${latestText || ''}`);
  const responseCorpus = normalizeWhitespace(`${candidateReply || ''}`);
  if (!requestCorpus || !responseCorpus) {
    return {
      detected: false,
      reason: '',
      correctedReply: trimSlackReplyLines(candidateReply || fallbackReply, 4)
    };
  }

  for (const rule of REQUEST_DRIFT_RULES) {
    if (!rule.requestPatterns.some((pattern) => pattern.test(requestCorpus))) {
      continue;
    }
    const hasExpected = rule.responseMustInclude.some((pattern) => pattern.test(responseCorpus));
    const hasDriftSignal = rule.responseDriftPatterns.some((pattern) => pattern.test(responseCorpus));
    if (!hasExpected && hasDriftSignal) {
      return {
        detected: true,
        reason: rule.reason,
        correctedReply: trimSlackReplyLines(fallbackReply, 4)
      };
    }
  }

  return {
    detected: false,
    reason: '',
    correctedReply: trimSlackReplyLines(candidateReply, 4)
  };
}

function buildSlackDraftQuality({ summary, suggestedReply, evidenceLinks, driftGuard }) {
  let score = 100;
  const warnings = [];

  if (!normalizeWhitespace(summary)) {
    score -= 10;
    warnings.push('요약이 비어 있습니다.');
  }
  if (looksLikeMetaOnlyReply(suggestedReply)) {
    score -= 25;
    warnings.push('답변이 메타 표현 위주로 보입니다.');
  }
  if (safeArray(evidenceLinks).length === 0) {
    score -= 20;
    warnings.push('근거 링크를 생성하지 못했습니다.');
  }
  if (driftGuard?.detected) {
    score -= 30;
    warnings.push('요청 이탈을 감지해 답변을 보정했습니다.');
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    warnings
  };
}

function classifySlackReplyFlow({ targetText, latestText, threadMessages }) {
  const focusText = [targetText, latestText].join(' ');
  const combined = [
    targetText,
    latestText,
    ...safeArray(threadMessages).map((message) => humanizeSlackText(message.content))
  ].join(' ');

  if (/(장애|incident|sev[0-9]?|에러|오류|원인|재현|영향\s*범위|장애상황|긴급|다운|터졌|망가졌|문제\s*생겼|문제입니다|owner|담당자)/i.test(combined)) {
    return 'owner_incident';
  }

  if (/(리마인드|핑|bump|follow up|follow-up|혹시\s*확인|언제쯤|업데이트\s*가능|아직\s*확인|다시\s*확인|재핑|nudge)/i.test(focusText)) {
    return 'reminder_ping';
  }

  if (/(결정|판단|방향|진행해도|가도\s*될|괜찮을지|승인|approve|선택|이대로|맞을지|문제없을지)/i.test(focusText)) {
    return 'decision_request';
  }

  if (/(같이\s*보|같이\s*얘기|같이\s*논의|참여|의견\s*주|의견\s*부탁|sync|후속|f\/u|follow up|들어와|함께)/i.test(focusText)) {
    return 'conversation_participation';
  }

  if (/(공유|참고|fyi|전달|알려드립|확인만|정보\s*공유|의견\s*있으면|보고용)/i.test(focusText)) {
    return 'info_share_confirmation';
  }

  return 'action_request';
}

function inferRequestedAction(category) {
  return getSlackReplyCategory(category).requestedAction;
}

function joinReplyLines(lines) {
  return lines.filter(Boolean).join('\n');
}

function extractDeadlineHint(value) {
  const text = normalizeWhitespace(value);
  if (!text) {
    return '';
  }

  const match = text.match(/(오늘\s*안|오늘\s*중|점심\s*전|오전\s*중|오후\s*중|금일|내일\s*오전|내일\s*중|이번주\s*중|이번\s*주\s*중|이번\s*주|ETA)/i);
  return match ? normalizeWhitespace(match[0]) : '';
}

function selectConfirmedContext(threadMessages, targetText, latestText) {
  const targetNormalized = normalizeWhitespace(targetText);
  const latestNormalized = normalizeWhitespace(latestText);
  const candidate = safeArray(threadMessages)
    .map((message) => humanizeSlackText(message.content))
    .map((value) => normalizeWhitespace(value))
    .find((value) => value && value !== targetNormalized && value !== latestNormalized && !looksLikeRequestMessage(value));

  return candidate ? summarizeTopic(candidate) : '';
}

function inferOpenPoint(category, latestText) {
  const text = normalizeWhitespace(latestText);
  if (category === 'decision_request') {
    return '진행 판단 확정';
  }
  if (/(언제|일정|ETA|마감|시점)/i.test(text)) {
    return '공유 가능한 시점 확인';
  }
  if (/(진행해도|가도\s*될|문제없을지|판단|결정)/i.test(text)) {
    return '진행 판단 확정';
  }
  if (/(owner|담당자|원인|영향)/i.test(text)) {
    return 'owner 및 영향 범위 확인';
  }

  switch (category) {
    case 'owner_incident':
      return '원인과 영향 범위 확인';
    case 'decision_request':
      return '진행 기준 확정';
    case 'reminder_ping':
      return '처리 상태 공유';
    default:
      return '다음 액션 정리';
  }
}

function shouldExplainRequestedElements({ category, targetText, latestText }) {
  const focus = normalizeWhitespace(`${targetText || ''} ${latestText || ''}`);
  if (!focus) {
    return false;
  }

  if (category === 'info_share_confirmation') {
    return true;
  }

  return /(공유|확인|정리|요소|항목|정의|기준|포인트)/i.test(focus)
    && /(요소|항목|정의|범위|우선순위|일정|정책|지표|가설|시나리오|와이어프레임|플로우|상품|번들)/i.test(focus);
}

function collectRequestedElementDefinitions({ targetText, latestText, threadMessages, max = 2 }) {
  const corpus = normalizeWhitespace([
    targetText,
    latestText,
    ...safeArray(threadMessages).map((message) => humanizeSlackText(message.content))
  ].join(' '));

  const collected = [];
  for (const rule of REQUESTED_ELEMENT_DEFINITION_RULES) {
    if (collected.length >= max) {
      break;
    }
    if (rule.patterns.some((pattern) => pattern.test(corpus))) {
      collected.push({
        key: rule.key,
        definition: rule.definition
      });
    }
  }
  return collected;
}

function buildRequestedElementDefinitionSentence({ category, targetText, latestText, threadMessages }) {
  if (!shouldExplainRequestedElements({ category, targetText, latestText })) {
    return '';
  }

  const definitions = collectRequestedElementDefinitions({
    targetText,
    latestText,
    threadMessages,
    max: 2
  });

  if (definitions.length === 0) {
    const combined = normalizeWhitespace(`${targetText || ''} ${latestText || ''}`);
    if (/(요소|항목|정의|포인트)/i.test(combined)) {
      return '요청하신 요소는 범위(무엇을 다루는지), 우선순위(무엇을 먼저 하는지), 일정(언제 공유하는지) 순서로 정리하겠습니다.';
    }
    return '';
  }

  const topicParticle = (word) => {
    const normalized = String(word || '').trim();
    const lastChar = normalized.charCodeAt(normalized.length - 1);
    const isHangul = lastChar >= 0xAC00 && lastChar <= 0xD7A3;
    if (!isHangul) {
      return '는';
    }
    const hasBatchim = (lastChar - 0xAC00) % 28 !== 0;
    return hasBatchim ? '은' : '는';
  };

  if (definitions.length === 1) {
    const item = definitions[0];
    return `${item.key}${topicParticle(item.key)} ${item.definition}입니다.`;
  }

  const first = definitions[0];
  const second = definitions[1];
  return `${first.key}${topicParticle(first.key)} ${first.definition}이고, ${second.key}${topicParticle(second.key)} ${second.definition}입니다.`;
}

function buildAudienceFriendlySlackReply({
  category,
  targetText,
  latestText,
  threadMessages,
  candidateReply,
  fallbackReply
}) {
  const baseReply = sanitizeSlackTonePhrases(finalizeSlackReply(candidateReply, fallbackReply));
  const plainReply = toNonDeveloperWording(baseReply);
  const definitionSentence = sanitizeSlackTonePhrases(buildRequestedElementDefinitionSentence({
    category,
    targetText,
    latestText,
    threadMessages
  }));

  if (!definitionSentence || plainReply.includes(definitionSentence)) {
    return trimSlackReplyLines(sanitizeSlackTonePhrases(plainReply));
  }

  const lines = plainReply
    .split('\n')
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);
  if (lines.length === 0) {
    return trimSlackReplyLines(sanitizeSlackTonePhrases(definitionSentence));
  }

  const enhancedLines = lines.length >= 2
    ? [lines[0], definitionSentence, ...lines.slice(1)]
    : [lines[0], definitionSentence];
  return trimSlackReplyLines(sanitizeSlackTonePhrases(enhancedLines.join('\n')));
}

function buildReplyIntent({ category, topic, openPoint, deadlineHint }) {
  const base = `${topic} 건에서 ${openPoint}를 분명하게 전달`;
  if (deadlineHint) {
    return `${base}하고 ${deadlineHint} 업데이트 시점을 함께 안내`;
  }
  if (category === 'decision_request') {
    return `${base}하며 판단 내용을 짧게 명시`;
  }
  return base;
}

function buildSlackUnderstanding({ category, targetText, firstText, latestText, threadMessages }) {
  const topic = selectSlackTopic({
    targetText,
    firstText,
    latestText,
    threadMessages
  }) || inferGenericSlackTopic({ category, targetText, latestText });
  const confirmedContext = selectConfirmedContext(threadMessages, targetText, latestText);
  const deadlineHint = extractDeadlineHint(`${targetText} ${latestText}`);
  const openPoint = inferOpenPoint(category, latestText);
  const latestRequest = summarizeTopic(latestText || targetText);

  return {
    topic,
    latestRequest,
    confirmedContext,
    openPoint,
    deadlineHint,
    replyIntent: buildReplyIntent({
      category,
      topic,
      openPoint,
      deadlineHint
    })
  };
}

function buildSlackSummary({ category, understanding, codeReviewContext }) {
  const firstSentence = `${understanding.topic} 건에서 ${understanding.latestRequest || understanding.openPoint} 요청이 들어온 상태입니다.`;
  const secondSentence = understanding.confirmedContext
    ? `현재까지 공유된 맥락은 ${understanding.confirmedContext}이며, 지금은 ${understanding.openPoint}를 답해야 합니다.`
    : `현재는 ${understanding.openPoint}를 명확히 답하는 것이 필요한 상황입니다.`;
  const codeReview = normalizeCodeReviewContext(codeReviewContext);
  const thirdSentence = codeReview?.summary
    ? `코드 관련 사실: ${sanitizeSlackTonePhrases(codeReview.summary)}`
    : '';

  if (category === 'owner_incident') {
    const incidentSummary = `${understanding.topic} 이슈가 보고됐고 담당 대응 요청이 들어온 상태입니다. 현재 공유된 맥락에서 원인과 영향 범위를 빠르게 정리해야 합니다.`;
    return [incidentSummary, thirdSentence].filter(Boolean).join(' ');
  }

  return [firstSentence, secondSentence, thirdSentence].filter(Boolean).join(' ');
}

function trimSlackReplyLines(value, maxLines = 3) {
  const lines = normalizeMultilineText(value)
    .split('\n')
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);
  return lines.slice(0, maxLines).join('\n');
}

function looksLikeMetaOnlyReply(value) {
  const text = normalizeWhitespace(value);
  if (!text) {
    return true;
  }

  if (text.length < 8) {
    return true;
  }

  if (/^(확인했습니다|내용 확인했습니다|흐름 확인했습니다)\.?$/.test(text)) {
    return true;
  }

  if (/^(확인했습니다|내용 확인했습니다)?[.!]?\s*정리해서\s*(말씀|공유)드리겠습니다[.!]?$/.test(text)) {
    return true;
  }

  if (/정리해서.*(말씀|공유)드리겠습니다/.test(text) && !/(검토|원인|영향|리스크|시점|코멘트|범위)/.test(text)) {
    return true;
  }

  return false;
}

function buildDirectReply({ category, targetText, latestContext, understanding }) {
  const combined = `${targetText || ''} ${latestContext || ''}`;
  const deadlineSuffix = understanding.deadlineHint
    ? `${understanding.deadlineHint} 전에 진행 상황 공유드리겠습니다.`
    : '확인되는 내용부터 바로 공유드리겠습니다.';

  switch (category) {
    case 'owner_incident':
      return joinReplyLines([
        `이슈 인지했고 ${understanding.openPoint}부터 바로 확인하겠습니다.`,
        deadlineSuffix
      ]);
    case 'info_share_confirmation':
      if (/(의견|생각|코멘트|확인\s*부탁)/i.test(combined)) {
        return joinReplyLines([
          `공유 주신 ${understanding.topic} 맥락 확인했습니다.`,
          '필요한 포인트 정리해서 의견 남기겠습니다.'
        ]);
      }
      return joinReplyLines([
        `공유 주신 ${understanding.topic} 내용 확인했습니다.`,
        '추가 확인이 필요한 부분이 있으면 이어서 보겠습니다.'
      ]);
    case 'decision_request':
      if (/(진행해도|가도\s*될|이대로|해도\s*될까요|문제없을지)/i.test(combined)) {
        return joinReplyLines([
          '현재 공유된 내용만 보면 제안하신 방향으로 진행해도 괜찮아 보입니다.',
          `진행 전 ${understanding.openPoint}만 한 번 더 확인하겠습니다.`
        ]);
      }
      return joinReplyLines([
        `판단이 필요한 포인트로 이해했습니다.`,
        `${understanding.openPoint} 확인 후 의견 드리겠습니다.`
      ]);
    case 'conversation_participation':
      return joinReplyLines([
        `${understanding.topic} 맥락 확인했습니다.`,
        `필요한 지점부터 같이 보겠습니다. ${deadlineSuffix}`
      ]);
    case 'reminder_ping':
      return joinReplyLines([
        '놓치지 않고 확인 중입니다.',
        deadlineSuffix
      ]);
    case 'action_request':
    default:
      if (/(다시(해보|해보자|시작|보자|정리)|처음부터|리셋)/.test(combined)) {
        return joinReplyLines([
          '좋습니다. 다시 맞춰서 확인해 보겠습니다.',
          '어디부터 다시 보면 될지 기준 주시면 그 순서대로 바로 진행하겠습니다.'
        ]);
      }
      if (/(리뷰|봐주|검토)/.test(combined)) {
        return joinReplyLines([
          `${understanding.topic} 범위 먼저 확인하고 코멘트 남기겠습니다.`,
          deadlineSuffix
        ]);
      }
      if (/(수정|고쳐|반영|처리|조치|대응)/.test(combined)) {
        return joinReplyLines([
          `요청하신 ${understanding.topic} 건 바로 진행하겠습니다.`,
          deadlineSuffix
        ]);
      }
      if (/(언제|일정|시간|오늘 안|ETA|마감)/i.test(combined)) {
        return joinReplyLines([
          `${understanding.openPoint} 먼저 확인하겠습니다.`,
          deadlineSuffix
        ]);
      }
      return joinReplyLines([
        `${understanding.topic} 요청 확인했습니다.`,
        deadlineSuffix
      ]);
  }
}

function finalizeSlackReply(candidateReply, fallbackReply) {
  const normalized = trimSlackReplyLines(candidateReply);
  if (!normalized || looksLikeMetaOnlyReply(normalized)) {
    return trimSlackReplyLines(fallbackReply);
  }
  return normalized;
}

export function buildFallbackSlackDraft({ task, threadMessages, codeReviewContext }) {
  const targetText = humanizeSlackText(task.payload?.text || '') || humanizeSlackText(threadMessages.at(-1)?.content || '');
  const first = humanizeSlackText(threadMessages[0]?.content || '') || targetText;
  const latest = humanizeSlackText(threadMessages.at(-1)?.content || '') || first;
  const replyCategory = classifySlackReplyFlow({
    targetText,
    latestText: latest,
    threadMessages
  });
  const replyCategoryLabel = getSlackReplyCategory(replyCategory).label;
  const requestedAction = inferRequestedAction(replyCategory);
  const reactionName = getSlackReplyCategory(replyCategory).reactionName;
  const understanding = buildSlackUnderstanding({
    category: replyCategory,
    targetText,
    firstText: first,
    latestText: latest,
    threadMessages
  });
  const summary = buildSlackSummary({
    category: replyCategory,
    understanding,
    codeReviewContext
  });
  const directReply = buildDirectReply({
    category: replyCategory,
    targetText: targetText || first,
    latestContext: latest,
    understanding
  });
  const audienceReply = buildAudienceFriendlySlackReply({
    category: replyCategory,
    targetText: targetText || first,
    latestText: latest,
    threadMessages,
    candidateReply: directReply,
    fallbackReply: '확인 중인 내용 정리해서 공유드리겠습니다.'
  });
  const driftGuard = detectSlackRequestDrift({
    targetText: targetText || first,
    latestText: latest,
    candidateReply: audienceReply,
    fallbackReply: directReply
  });
  const evidenceLinks = resolveSlackEvidenceLinks({
    task,
    codeReviewContext
  });
  const suggestedReply = trimSlackReplyLines(
    sanitizeSlackTonePhrases(stripSlackEvidenceText(driftGuard.correctedReply)),
    4
  );
  const normalizedSuggestedReply = sanitizeSlackTonePhrases(suggestedReply);
  const quality = buildSlackDraftQuality({
    summary,
    suggestedReply: normalizedSuggestedReply,
    evidenceLinks,
    driftGuard
  });

  return {
    summary: sanitizeSlackTonePhrases(toNonDeveloperWording(summary)),
    requestedAction,
    replyIntent: understanding.replyIntent,
    suggestedReply: normalizedSuggestedReply,
    replyCategory,
    replyCategoryLabel,
    reactionName,
    provider: 'fallback',
    qualityScore: quality.score,
    qualityWarnings: quality.warnings,
    evidenceLinks,
    driftGuard
  };
}

export class LlmService {
  constructor(generationClient) {
    this.generationClient = generationClient;
  }

  async generateSlackDraft({ task, threadMessages, agentProvider, codeReviewContext, styleGuide, model }) {
    const normalizedCodeReviewContext = normalizeCodeReviewContext(codeReviewContext);
    const normalizedStyleGuide = normalizeSlackStyleGuide(styleGuide);
    const fallbackDraft = buildFallbackSlackDraft({
      task,
      threadMessages,
      codeReviewContext: normalizedCodeReviewContext
    });
    if (resolveGenerationMode(this.generationClient, 'slack') === 'fallback') {
      return fallbackDraft;
    }

    const instructions = [
      '당신은 한국어로 Slack 업무 스레드를 정리하는 비서다.',
      '항상 한국어로만 작성한다.',
      '개발자가 아닌 기획/디자인/운영 담당자도 바로 이해할 수 있는 쉬운 표현을 사용한다.',
      '기술 용어(API/스키마/엔드포인트/리팩터링 등)는 꼭 필요한 경우에만 쓰고, 쓰면 짧게 풀어 설명한다.',
      '스레드 전체 흐름을 먼저 이해한 뒤, 현재 task가 가리키는 마지막 target mention에 답해야 한다.',
      '응답 유형은 아래 6개 중 하나만 고른다: action_request(액션 요청), owner_incident(책임자 호출/장애 상황), info_share_confirmation(정보 공유 + 확인 요청), decision_request(의사결정 요청), conversation_participation(대화 참여 유도), reminder_ping(리마인드 / 핑).',
      'summary는 스레드에서 이미 보이는 발화 순서를 다시 설명하지 말고, 핵심 상황을 1~2문장으로 압축한 요약이어야 한다.',
      'summary에는 무엇이 논의되는지와 지금 어떤 응답이 필요한지만 남기고, 카테고리 이름이나 대응 지침 문구를 그대로 넣지 않는다.',
      'replyIntent에는 "왜 이 답변이 적절한지"를 한 문장으로 적는다.',
      'suggestedReply는 Slack에 바로 전송 가능한 답변 본문이며 1~3문장으로 작성한다.',
      'suggestedReply는 마지막 멘션 질문이나 요청에 직접 답해야 하며, 메타 표현만 반복하면 안 된다.',
      'suggestedReply 본문에는 URL/근거 링크 문구를 넣지 않는다. 근거 링크는 별도 필드로 분리된다.',
      'suggestedReply에는 사실 자체만 간단히 적고, 사실을 어떻게 파악했는지(기준으로/바탕으로/기반으로/우선 확인)는 쓰지 않는다.',
      'suggestedReply 본문에는 파일 경로나 라인 번호(예: src/x.ts:12)를 쓰지 않는다.',
      '공유/확인 요청에 특정 요소(예: 범위, 우선순위, 일정, 정책, 지표 등)가 언급되면, suggestedReply에 각 요소 의미를 짧게 정의해 포함한다.',
      '코드 검토 결과가 함께 주어지면, 해당 근거를 반영해 답변하되 확인되지 않은 내용은 단정하지 않는다.',
      '요청이 상품/정책 정보 파악이면 API 사용 방식 설명으로 답변을 대체하지 않는다.',
      '메타 설명이나 추상적인 태도 설명으로 채우지 않는다.',
      normalizedStyleGuide ? '아래에 제공되는 사용자 실제 전송 답변 어투를 우선적으로 맞춘다.' : '',
      normalizedStyleGuide ? '사용자 어투 가이드를 반영하되, 예시 문장을 그대로 복사하지 않고 현재 스레드 사실에 맞게 재작성한다.' : '',
      normalizedStyleGuide?.multilineRate >= 35 ? 'suggestedReply는 핵심 항목을 줄바꿈해 2~3줄로 작성한다.' : '',
      '영어 표현, 불필요한 사과, 과장, 허위 추론을 피한다.',
      'suggestedReaction은 없으면 빈 문자열로 두고, 빠른 확인 표시가 적절한 경우에만 white_check_mark를 사용한다.',
      'Return valid JSON only.',
      'Use this JSON shape:',
      '{"category":"action_request|owner_incident|info_share_confirmation|decision_request|conversation_participation|reminder_ping","summary":"string","requestedAction":"string","replyIntent":"string","suggestedReply":"string","suggestedReaction":"string"}',
      'Do not include markdown fences or any extra prose.'
    ].join(' ');

    const input = [
      `Task title: ${task.title}`,
      `Channel: ${task.payload?.channelName || task.payload?.channelId || 'unknown'}`,
      `Target mention to answer: ${humanizeSlackText(task.payload?.text || '')}`,
      `Permalink: ${task.source_url || task.sourceUrl || ''}`,
      'Thread transcript:',
      buildThreadTranscript(threadMessages),
      normalizedStyleGuide ? buildSlackStyleGuideTranscript(normalizedStyleGuide) : '',
      normalizedCodeReviewContext ? buildCodeReviewTranscript(normalizedCodeReviewContext) : ''
    ].join('\n\n');

    try {
      const response = await this.generationClient.createTextResponse({
        instructions,
        input,
        scope: 'slack',
        model,
        agentProvider: agentProvider || task.payload?.generationAgentProvider || ''
      });
      const generated = extractTextResponse(response);
      const parsed = extractJsonObject(generated.text);
      const replyCategory = String(parsed.category || '').trim()
        ? normalizeSlackReplyCategory(parsed.category)
        : fallbackDraft.replyCategory;
      const categoryMeta = getSlackReplyCategory(replyCategory);
      const summary = normalizeMultilineText(parsed.summary);
      const modelReply = normalizeMultilineText(parsed.suggestedReply);
      const targetText = humanizeSlackText(task.payload?.text || '') || humanizeSlackText(threadMessages.at(-1)?.content || '');
      const latestText = humanizeSlackText(threadMessages.at(-1)?.content || '');
      const fallbackReply = buildDirectReply({
        category: replyCategory,
        targetText,
        latestContext: latestText,
        understanding: buildSlackUnderstanding({
          category: replyCategory,
          targetText,
          firstText: humanizeSlackText(threadMessages[0]?.content || ''),
          latestText,
          threadMessages
        })
      });
      const audienceReply = buildAudienceFriendlySlackReply({
        category: replyCategory,
        targetText,
        latestText,
        threadMessages,
        candidateReply: modelReply,
        fallbackReply: fallbackReply || fallbackDraft.suggestedReply
      });
      const driftGuard = detectSlackRequestDrift({
        targetText,
        latestText,
        candidateReply: audienceReply,
        fallbackReply: fallbackReply || fallbackDraft.suggestedReply
      });
      const evidenceLinks = resolveSlackEvidenceLinks({
        task,
        codeReviewContext: normalizedCodeReviewContext
      });
      const suggestedReply = trimSlackReplyLines(
        sanitizeSlackTonePhrases(stripSlackEvidenceText(driftGuard.correctedReply)),
        4
      );
      const normalizedSuggestedReply = sanitizeSlackTonePhrases(suggestedReply);
      const normalizedSummary = sanitizeSlackTonePhrases(
        summary && !isStructuredSlackSummary(summary) ? toNonDeveloperWording(summary) : fallbackDraft.summary
      );
      const quality = buildSlackDraftQuality({
        summary: normalizedSummary,
        suggestedReply: normalizedSuggestedReply,
        evidenceLinks,
        driftGuard
      });
      return {
        summary: normalizedSummary,
        requestedAction: normalizeWhitespace(parsed.requestedAction) || categoryMeta.requestedAction,
        replyIntent: normalizeWhitespace(parsed.replyIntent) || fallbackDraft.replyIntent,
        suggestedReply: normalizedSuggestedReply,
        replyCategory,
        replyCategoryLabel: categoryMeta.label,
        reactionName: normalizeReactionName(parsed.suggestedReaction) || categoryMeta.reactionName,
        provider: generated.provider,
        agentProvider: generated.agentProvider || '',
        qualityScore: quality.score,
        qualityWarnings: quality.warnings,
        evidenceLinks,
        driftGuard
      };
    } catch (error) {
      return {
        ...buildFallbackSlackDraft({
          task,
          threadMessages,
          codeReviewContext: normalizedCodeReviewContext
        }),
        provider: `fallback:${error.message}`,
        agentProvider: ''
      };
    }
  }

  async generateGitHubReview({ task, pullRequest, files, agentProvider }) {
    const generationMode = resolveGenerationMode(this.generationClient, 'github_review');

    if (generationMode === 'fallback') {
      return buildFallbackGitHubReview({ task, pullRequest, files });
    }

    if (generationMode === 'external' || generationMode === 'hovis') {
      try {
        const response = await this.generationClient.createTextResponse({
          instructions: '',
          input: '',
          scope: 'github_review',
          pullRequestUrl: pullRequest?.htmlUrl || task.payload?.sourceUrl || task.source_url || ''
        });
        const generated = extractTextResponse(response);
        const reviewBody = String(generated.text || '').trim();
        if (!reviewBody) {
          throw new Error('외부 에이전트 리뷰 결과가 비어 있습니다');
        }

        return {
          summary: buildExternalAgentReviewSummary(reviewBody, pullRequest),
          approval: 'approved_with_no_changes',
          findings: [],
          reviewBody: prependGitHubReviewDisclaimer(stripGitHubEvidenceSection(reviewBody)),
          evidenceLinks: resolveGitHubEvidenceLinks({
            pullRequest,
            files,
            findings: []
          }),
          provider: generated.provider || 'external_agent',
          agentProvider: ''
        };
      } catch (error) {
        return buildFallbackGitHubReview({
          task,
          pullRequest,
          files,
          errorMessage: error.message
        });
      }
    }

    const instructions = [
      '당신은 한국어로 GitHub Pull Request를 리뷰하는 시니어 엔지니어다.',
      '항상 한국어로만 작성한다.',
      '요약 나열이 아니라 실제 리뷰 판단을 내려야 한다.',
      '버그, 회귀, 누락된 테스트, 명세 불일치, 중요한 코드 품질 이슈만 지적한다.',
      '보안/성능/유지보수성 관점도 점검한다.',
      '사소한 스타일 취향은 제외한다.',
      'findings는 심각도 순으로 정리한다. (critical/high=🔴, medium=🟡, low=🟢)',
      '파일 근거가 없는 "확인 불가/수동 확인 필요" 류의 일반 문구는 금지한다.',
      '문제가 없으면 findings를 빈 배열로 두고 approval은 approved_with_no_changes로 둔다.',
      '문제가 있으면 approval은 changes_requested로 두고 mustFix를 정확히 표시한다.',
      'Return valid JSON only.',
      'Use this JSON shape:',
      '{"summary":"string","approval":"approved_with_no_changes|changes_requested","findings":[{"id":"string","severity":"critical|high|medium|low","category":"bug|regression|missing_test|design_gap|spec_mismatch|security|performance|maintainability|code_quality","title":"string","description":"string","fileRefs":["string"],"suggestedFix":"string","mustFix":true}]}',
      'Do not include markdown fences or any extra prose.'
    ].join(' ');

    const runReviewGeneration = async ({ compactContext = false } = {}) => {
      const contextFiles = compactContext ? safeArray(files).slice(0, 8) : safeArray(files);
      const input = [
        `Task title: ${task.title}`,
        `Repository: ${pullRequest.repoSlug}`,
        `Pull request: #${pullRequest.number} ${pullRequest.title}`,
        `Author: ${pullRequest.author}`,
        `Base: ${pullRequest.baseRef}`,
        `Head: ${pullRequest.headRef} (${pullRequest.headSha})`,
        `Changed files: ${files.length}`,
        `Review context files: ${contextFiles.length}`,
        compactContext ? 'Note: timeout 방지를 위해 변경 파일 일부와 축약 패치로 재시도 중입니다.' : '',
        `PR body: ${String(pullRequest.body || '').trim() || '(empty)'}`,
        'Changed file patches:',
        buildPullRequestTranscript(contextFiles, {
          maxFiles: compactContext ? 8 : 20,
          patchMaxLength: compactContext ? 700 : 1400
        })
      ].filter(Boolean).join('\n\n');

      const response = await this.generationClient.createTextResponse({
        instructions,
        input,
        scope: 'github_review',
        agentProvider: agentProvider || task.payload?.generationAgentProvider || ''
      });
      const generated = extractTextResponse(response);
      const parsed = extractJsonObject(generated.text);
      const findings = safeArray(parsed.findings).map(normalizeFinding);
      const approval = parsed.approval === 'changes_requested' ? 'changes_requested' : 'approved_with_no_changes';
      const summary = normalizeWhitespace(parsed.summary);

      return {
        summary,
        approval,
        findings,
        reviewBody: formatGitHubReviewBody({
          summary,
          findings
        }),
        evidenceLinks: resolveGitHubEvidenceLinks({
          pullRequest,
          files: contextFiles,
          findings
        }),
        provider: generated.provider,
        agentProvider: generated.agentProvider || '',
        usedCompactContext: compactContext
      };
    };

    try {
      const primary = await runReviewGeneration({ compactContext: false });
      return {
        ...primary,
        usedCompactContext: undefined
      };
    } catch (error) {
      if (isGenerationTimeoutError(error)) {
        try {
          const compact = await runReviewGeneration({ compactContext: true });
          return {
            ...compact,
            usedCompactContext: undefined
          };
        } catch (retryError) {
          return buildFallbackGitHubReview({
            task,
            pullRequest,
            files,
            errorMessage: retryError.message
          });
        }
      }

      return buildFallbackGitHubReview({
        task,
        pullRequest,
        files,
        errorMessage: error.message
      });
    }
  }
}
