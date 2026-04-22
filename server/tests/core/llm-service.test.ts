import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFallbackSlackDraft, LlmService } from '../../src/llm-service.ts';

const GITHUB_REVIEW_DISCLAIMER = '해당 리뷰는, pr의 diff 만 확인하여 작성된 리뷰입니다. 코드 작성자의 판단하에 수정 여부를 결정해주세요.';

test('buildFallbackSlackDraft summarizes context and creates a decision-focused Korean reply', () => {
  const result = buildFallbackSlackDraft({
    task: {
      payload: {
        text: '<@U123> 이건 어떻게 진행하면 될까요?'
      }
    },
    threadMessages: [
      {
        content: '<@U123> 이건 어떻게 진행하면 될까요?',
        metadata: { user: 'U999' }
      },
      {
        content: '지금은 API 응답 구조부터 정리하는 중입니다.',
        metadata: { user: 'U555' }
      },
      {
        content: '<@U123> 오늘 안에 방향만 정해주면 됩니다.',
        metadata: { user: 'U999' }
      }
    ]
  });

  assert.equal(result.replyCategory, 'decision_request');
  assert.equal(result.replyCategoryLabel, '의사결정 요청');
  assert.equal(result.reactionName, '');
  assert.match(result.summary, /API 응답 구조부터 정리하는 중/);
  assert.match(result.summary, /요청이 들어온 상태|답해야 합니다/);
  assert.match(result.replyIntent, /진행 판단 확정/);
  assert.match(result.suggestedReply, /판단이 필요한 포인트로 이해했습니다/);
  assert.match(result.suggestedReply, /확인 후 의견 드리겠습니다/);
  assert.doesNotMatch(result.suggestedReply, /정리해서 바로 다시 말씀드릴게요/i);
});

test('buildFallbackSlackDraft writes a contextual reply for restart-style mentions', () => {
  const result = buildFallbackSlackDraft({
    task: {
      payload: {
        text: '자 다시해보자'
      }
    },
    threadMessages: [
      {
        content: '자 다시해보자',
        metadata: { user: 'U999' }
      }
    ]
  });

  assert.equal(result.replyCategory, 'action_request');
  assert.match(result.suggestedReply, /다시 맞춰서 확인해 보겠습니다/);
  assert.match(result.suggestedReply, /어디부터 다시 보면 될지/);
  assert.doesNotMatch(result.suggestedReply, /내용 확인했습니다|정리해서/i);
});

test('buildFallbackSlackDraft classifies incident mentions and replies with ownership/impact intent', () => {
  const result = buildFallbackSlackDraft({
    task: {
      payload: {
        text: '<@U123> 장애 난 것 같은데 owner 확인 가능할까요?'
      }
    },
    threadMessages: [
      {
        content: '배포 이후 결제가 안 됩니다.',
        metadata: { user: 'U777' }
      },
      {
        content: '<@U123> 장애 난 것 같은데 owner 확인 가능할까요?',
        metadata: { user: 'U999' }
      }
    ]
  });

  assert.equal(result.replyCategory, 'owner_incident');
  assert.equal(result.reactionName, '');
  assert.match(result.summary, /이슈가 보고됐고 담당 대응 요청/);
  assert.match(result.suggestedReply, /이슈 인지했고/);
  assert.match(result.suggestedReply, /확인하겠습니다/);
});

test('buildFallbackSlackDraft classifies reminder mentions and avoids generic meta-only response', () => {
  const result = buildFallbackSlackDraft({
    task: {
      payload: {
        text: '<@U123> 혹시 이거 언제쯤 확인 가능하실까요?'
      }
    },
    threadMessages: [
      {
        content: '어제 드린 요청 다시 핑 드립니다.',
        metadata: { user: 'U777' }
      },
      {
        content: '<@U123> 혹시 이거 언제쯤 확인 가능하실까요?',
        metadata: { user: 'U999' }
      }
    ]
  });

  assert.equal(result.replyCategory, 'reminder_ping');
  assert.match(result.summary, /요청이 들어온 상태|답해야 합니다/);
  assert.match(result.suggestedReply, /놓치지 않고 확인 중입니다/);
  assert.match(result.suggestedReply, /공유드리겠습니다/);
});

test('buildFallbackSlackDraft keeps reaction recommendation for information-sharing flow', () => {
  const result = buildFallbackSlackDraft({
    task: {
      payload: {
        text: '<@U123> 공유드립니다. 확인만 부탁드려요.'
      }
    },
    threadMessages: [
      {
        content: '신규 정책 초안 공유드립니다.',
        metadata: { user: 'U777' }
      },
      {
        content: '<@U123> 공유드립니다. 확인만 부탁드려요.',
        metadata: { user: 'U999' }
      }
    ]
  });

  assert.equal(result.replyCategory, 'info_share_confirmation');
  assert.equal(result.reactionName, 'white_check_mark');
  assert.match(result.summary, /요청이 들어온 상태/);
  assert.match(result.suggestedReply, /공유 주신/);
});

test('buildFallbackSlackDraft includes element definitions for share/confirm requests', () => {
  const result = buildFallbackSlackDraft({
    task: {
      payload: {
        text: '<@U123> 공유드립니다. 범위랑 우선순위 확인 부탁드려요.'
      }
    },
    threadMessages: [
      {
        content: '이번 작업 초안 공유드립니다.',
        metadata: { user: 'U777' }
      },
      {
        content: '<@U123> 공유드립니다. 범위랑 우선순위 확인 부탁드려요.',
        metadata: { user: 'U999' }
      }
    ]
  });

  assert.equal(result.replyCategory, 'info_share_confirmation');
  assert.match(result.suggestedReply, /범위는/);
  assert.match(result.suggestedReply, /우선순위는/);
  assert.doesNotMatch(result.suggestedReply, /요청\s*기준에서/);
  assert.doesNotMatch(result.suggestedReply, /기준으로|바탕으로|기반으로/);
});

test('buildFallbackSlackDraft does not append code path details in suggested reply', () => {
  const result = buildFallbackSlackDraft({
    task: {
      payload: {
        text: '<@U123> 로그인 오류 확인 부탁드립니다.'
      }
    },
    threadMessages: [
      {
        content: '<@U123> 로그인 오류 확인 부탁드립니다.',
        metadata: { user: 'U999' }
      }
    ],
    codeReviewContext: {
      enabled: true,
      analysisStatus: 'completed',
      selectedRepo: 'fromm-web',
      summary: 'fromm-web 저장소에서 auth/login 관련 코드 근거를 확인했습니다.',
      replyHints: ['우선 src/auth/login.ts:42 라인을 기준으로 영향 범위를 확인 중입니다.'],
      findings: [
        {
          path: 'src/auth/login.ts',
          line: 42,
          excerpt: 'const loginError = "auth_failed";',
          term: 'login'
        }
      ]
    }
  });

  assert.match(result.summary, /auth\/login 관련 코드 근거/);
  assert.doesNotMatch(result.suggestedReply, /src\/auth\/login\.ts:42/);
  assert.doesNotMatch(result.suggestedReply, /관련\s*코드/);
});

test('LlmService includes code-review context in model input when available', async () => {
  let capturedInput = '';
  const service = new LlmService({
    getMode: () => 'cli',
    isConfigured: () => true,
    createTextResponse: async ({ input }) => {
      capturedInput = input;
      return JSON.stringify({
        category: 'action_request',
        summary: '로그인 오류 요청이 들어와 코드 근거와 함께 답변이 필요한 상황입니다.',
        requestedAction: '봤고, 처리에 들어간다는 점과 다음 업데이트 시점을 분명하게 답변',
        replyIntent: '코드 근거를 바탕으로 처리 착수와 공유 시점을 전달',
        suggestedReply: '로그인 관련 코드 기준으로 우선 확인 중이며, 확인되는 내용부터 공유드리겠습니다.',
        suggestedReaction: ''
      });
    }
  });

  const result = await service.generateSlackDraft({
    task: {
      title: 'Slack task',
      payload: {
        text: '<@U123> 로그인 오류 확인 부탁드립니다.'
      }
    },
    threadMessages: [
      {
        content: '<@U123> 로그인 오류 확인 부탁드립니다.',
        metadata: { user: 'U999' }
      }
    ],
    codeReviewContext: {
      enabled: true,
      analysisStatus: 'completed',
      selectedRepo: 'fromm-web',
      summary: 'fromm-web 저장소에서 auth/login 관련 코드 근거를 확인했습니다.',
      selectionReason: '로그인 키워드 매칭',
      replyHints: ['src/auth/login.ts:42 라인 기준으로 영향 범위를 확인 중입니다.'],
      findings: [
        {
          path: 'src/auth/login.ts',
          line: 42,
          excerpt: 'const loginError = "auth_failed";'
        }
      ]
    }
  });

  assert.match(capturedInput, /Code review context:/);
  assert.match(capturedInput, /Repository: fromm-web/);
  assert.match(capturedInput, /src\/auth\/login\.ts:42/);
  assert.doesNotMatch(result.suggestedReply, /기준으로|바탕으로|기반으로/);
  assert.doesNotMatch(result.suggestedReply, /[A-Za-z0-9_./-]+\.[A-Za-z0-9]+:\d+/);
});

test('LlmService includes user style guide context in Slack draft generation input', async () => {
  let capturedInstructions = '';
  let capturedInput = '';
  const service = new LlmService({
    getMode: () => 'cli',
    isConfigured: () => true,
    createTextResponse: async ({ instructions, input }) => {
      capturedInstructions = instructions;
      capturedInput = input;
      return JSON.stringify({
        category: 'action_request',
        summary: '공유 요청이 들어왔고 확인 답변이 필요한 상황입니다.',
        requestedAction: '읽었고 필요한 경우 의견을 더하겠다는 점을 짧게 답변',
        replyIntent: '확인 사실과 공유 시점을 전달',
        suggestedReply: '확인했습니다. 오늘 중으로 정리해서 전달드리겠습니다.',
        suggestedReaction: 'white_check_mark'
      });
    }
  });

  await service.generateSlackDraft({
    task: {
      title: 'Slack task',
      payload: {
        text: '<@U123> 공유 부탁드립니다.'
      }
    },
    threadMessages: [
      {
        content: '<@U123> 공유 부탁드립니다.',
        metadata: { user: 'U999' }
      }
    ],
    styleGuide: {
      sampleCount: 8,
      editedSampleCount: 5,
      recentAverageLength: 72,
      multilineRate: 60,
      directives: [
        '문장 끝맺음은 "~합니다/~드립니다" 형태의 정중한 업무 톤을 유지합니다.',
        '답변 길이는 짧게 유지하고 핵심 사실만 먼저 전달합니다.'
      ],
      commonKeywordHints: ['확인', '공유'],
      examples: [
        {
          prompt: '<@U123> 일정 공유 부탁',
          generatedReply: '확인했습니다. 정리해서 공유하겠습니다.',
          finalReply: '확인했습니다. 오늘 일정 정리해서 전달드리겠습니다.',
          changed: true
        }
      ]
    }
  });

  assert.match(capturedInstructions, /사용자 실제 전송 답변 어투/);
  assert.match(capturedInput, /User reply style profile:/);
  assert.match(capturedInput, /Style directives:/);
  assert.match(capturedInput, /User-approved reply examples:/);
  assert.match(capturedInput, /generated:/);
  assert.match(capturedInput, /final:/);
  assert.match(capturedInput, /Multiline usage rate: 60%/);
  assert.match(capturedInstructions, /줄바꿈해 2~3줄/);
});

test('LlmService uses model-proposed contextual reply when it is usable', async () => {
  const service = new LlmService({
    isConfigured: () => true,
    createTextResponse: async () => JSON.stringify({
      category: 'owner_incident',
      summary: '결제 장애가 보고됐고 owner 확인과 영향 범위 파악이 필요한 상황입니다.',
      requestedAction: 'owner를 확인하고 상황 파악 및 대응 시작 상태를 분명하게 답변',
      replyIntent: '장애 대응 시작을 명확히 알리고 영향 범위 확인 계획을 전달',
      suggestedReply: '장애 상황 인지했습니다. owner와 영향 범위부터 바로 확인하겠습니다.\n확인되는 내용부터 즉시 공유드리겠습니다.',
      suggestedReaction: ''
    })
  });

  const result = await service.generateSlackDraft({
    task: {
      title: 'Slack task',
      payload: {
        text: '<@U123> 결제 장애 같아요. owner 확인 가능할까요?'
      }
    },
    threadMessages: [
      {
        content: '결제가 실패하고 있습니다.',
        metadata: { user: 'U777' }
      },
      {
        content: '<@U123> 결제 장애 같아요. owner 확인 가능할까요?',
        metadata: { user: 'U999' }
      }
    ]
  });

  assert.equal(result.provider, 'openai');
  assert.equal(result.replyCategory, 'owner_incident');
  assert.match(result.summary, /영향 범위 파악이 필요한 상황/);
  assert.match(result.replyIntent, /영향 범위 확인 계획/);
  assert.equal(result.suggestedReply, '장애 상황 인지했습니다. owner와 영향 범위부터 바로 확인하겠습니다.\n확인되는 내용부터 즉시 공유드리겠습니다.');
});

test('LlmService replaces model reply when output is meta-only', async () => {
  const service = new LlmService({
    isConfigured: () => true,
    createTextResponse: async () => JSON.stringify({
      category: 'action_request',
      summary: '리뷰 요청이 들어왔고 처리 착수 안내가 필요한 상황입니다.',
      requestedAction: '봤고, 처리에 들어간다는 점과 다음 업데이트 시점을 분명하게 답변',
      replyIntent: '리뷰 착수와 공유 시점을 전달',
      suggestedReply: '확인했습니다. 정리해서 공유드리겠습니다.',
      suggestedReaction: 'white_check_mark'
    })
  });

  const result = await service.generateSlackDraft({
    task: {
      title: 'Slack task',
      payload: {
        text: '<@U123> PR 리뷰 부탁드립니다.'
      }
    },
    threadMessages: [
      {
        content: '이번 배포 전에 확인 필요합니다.',
        metadata: { user: 'U777' }
      },
      {
        content: '<@U123> PR 리뷰 부탁드립니다.',
        metadata: { user: 'U999' }
      }
    ]
  });

  assert.equal(result.provider, 'openai');
  assert.equal(result.replyCategory, 'action_request');
  assert.doesNotMatch(result.suggestedReply, /정리해서 공유드리겠습니다/);
  assert.match(result.suggestedReply, /코멘트|확인|진행/);
});

test('LlmService falls back to the Korean heuristic when OpenAI is not configured', async () => {
  const service = new LlmService({
    isConfigured: () => false
  });

  const result = await service.generateSlackDraft({
    task: {
      title: 'Slack task',
      payload: {
        text: '<@U123> 검토 가능할까요?'
      }
    },
    threadMessages: [
      {
        content: '<@U123> 검토 가능할까요?',
        metadata: { user: 'U999' }
      }
    ]
  });

  assert.equal(result.provider, 'fallback');
  assert.match(result.summary, /검토 요청|요청이 들어온 상태/);
  assert.match(result.suggestedReply, /확인|코멘트|진행/);
  assert.ok(result.replyIntent);
});

test('LlmService keeps CLI provider metadata when generation client returns structured response', async () => {
  const service = new LlmService({
    getMode: () => 'cli',
    isConfigured: () => true,
    createTextResponse: async () => ({
      text: JSON.stringify({
        category: 'action_request',
        summary: '코드 리뷰 요청이 들어왔고 착수 여부를 알려줘야 합니다.',
        requestedAction: '봤고, 처리에 들어간다는 점과 다음 업데이트 시점을 분명하게 답변',
        replyIntent: '착수 사실과 공유 시점 전달',
        suggestedReply: '확인했습니다. 리뷰 확인 후 코멘트 남기겠습니다.',
        suggestedReaction: 'white_check_mark'
      }),
      provider: 'cli:claude',
      agentProvider: 'claude'
    })
  });

  const result = await service.generateSlackDraft({
    task: {
      title: 'Slack task',
      payload: {
        text: '<@U123> PR 리뷰 부탁드립니다.'
      }
    },
    threadMessages: [
      {
        content: '<@U123> PR 리뷰 부탁드립니다.',
        metadata: { user: 'U999' }
      }
    ]
  });

  assert.equal(result.provider, 'cli:claude');
  assert.equal(result.agentProvider, 'claude');
  assert.match(result.suggestedReply, /코멘트 남기겠습니다/);
});

test('LlmService rewrites technical wording and includes element definitions for share confirmation', async () => {
  const service = new LlmService({
    getMode: () => 'cli',
    isConfigured: () => true,
    createTextResponse: async () => ({
      text: JSON.stringify({
        category: 'info_share_confirmation',
        summary: '스키마 확인 요청이 들어왔습니다.',
        requestedAction: '공유된 내용을 확인하고 정리합니다.',
        replyIntent: '확인 사실과 정리 기준을 전달',
        suggestedReply: '공유 내용 확인했습니다. 스키마 기준으로 정리해서 공유드리겠습니다.',
        suggestedReaction: 'white_check_mark'
      }),
      provider: 'cli:codex',
      agentProvider: 'codex'
    })
  });

  const result = await service.generateSlackDraft({
    task: {
      title: 'Slack task',
      payload: {
        text: '<@U123> 범위랑 일정 요소 확인 부탁드립니다.'
      }
    },
    threadMessages: [
      {
        content: '<@U123> 범위랑 일정 요소 확인 부탁드립니다.',
        metadata: { user: 'U999' }
      }
    ]
  });

  assert.equal(result.replyCategory, 'info_share_confirmation');
  assert.doesNotMatch(result.suggestedReply, /스키마/);
  assert.match(result.suggestedReply, /범위는/);
  assert.match(result.suggestedReply, /일정은/);
  assert.doesNotMatch(result.suggestedReply, /요청\s*기준에서/);
  assert.doesNotMatch(result.suggestedReply, /기준으로|바탕으로|기반으로/);
});

test('LlmService removes AI-like 기준 공유 문구 from suggested reply', async () => {
  const service = new LlmService({
    getMode: () => 'cli',
    isConfigured: () => true,
    createTextResponse: async () => ({
      text: JSON.stringify({
        category: 'info_share_confirmation',
        summary: '요소 확인 요청입니다.',
        requestedAction: '확인 후 공유',
        replyIntent: '요청 요소 정리 전달',
        suggestedReply: '범위는 이번 요청에서 다룰 내용과 제외할 내용을 나눈 기준입니다. 이 기준으로 공유하면 됩니다.',
        suggestedReaction: ''
      }),
      provider: 'cli:codex',
      agentProvider: 'codex'
    })
  });

  const result = await service.generateSlackDraft({
    task: {
      title: 'Slack task',
      payload: {
        text: '<@U123> 범위 요소 정리 부탁드립니다.'
      }
    },
    threadMessages: [
      {
        content: '<@U123> 범위 요소 정리 부탁드립니다.',
        metadata: { user: 'U999' }
      }
    ]
  });

  assert.doesNotMatch(result.suggestedReply, /이\s*기준으로\s*공유(?:하|드)면\s*됩니다/);
  assert.doesNotMatch(result.suggestedReply, /요청\s*기준에서/);
  assert.doesNotMatch(result.suggestedReply, /기준으로|바탕으로|기반으로/);
});

test('LlmService corrects drifted API-centric reply for product-information request', async () => {
  const service = new LlmService({
    getMode: () => 'cli',
    isConfigured: () => true,
    createTextResponse: async () => ({
      text: JSON.stringify({
        category: 'action_request',
        summary: '상품 정보 요청입니다.',
        requestedAction: '확인 후 공유',
        replyIntent: '요청에 맞는 확인 계획 전달',
        suggestedReply: 'API 엔드포인트를 먼저 확인하고 서비스 레이어를 정리하겠습니다.',
        suggestedReaction: ''
      }),
      provider: 'cli:codex',
      agentProvider: 'codex'
    })
  });

  const result = await service.generateSlackDraft({
    task: {
      title: 'Slack task',
      source_url: 'https://example.slack.com/archives/C123/p1710000000000100',
      payload: {
        text: '<@U123> 스토어 상품 정보 파악 부탁드립니다.'
      }
    },
    threadMessages: [
      {
        content: '<@U123> 스토어 상품 정보 파악 부탁드립니다.',
        metadata: { user: 'U999' }
      }
    ]
  });

  assert.equal(result.driftGuard?.detected, true);
  assert.doesNotMatch(result.suggestedReply, /API|엔드포인트/i);
  assert.ok(Array.isArray(result.evidenceLinks));
  assert.match(result.evidenceLinks[0] || '', /example\.slack\.com/);
});

test('LlmService returns GitHub fallback review when generation mode is fallback', async () => {
  const service = new LlmService({
    getMode: () => 'fallback',
    isConfigured: () => true
  });

  const result = await service.generateGitHubReview({
    task: {
      title: 'GitHub review task',
      payload: {
        repoSlug: 'acme/demo',
        pullNumber: 11
      }
    },
    pullRequest: {
      repoSlug: 'acme/demo',
      number: 11,
      title: 'Refactor API handler'
    },
    files: [
      {
        path: 'src/api.js',
        status: 'modified',
        additions: 10,
        deletions: 5,
        patch: '@@ -1 +1 @@'
      }
    ]
  });

  assert.match(result.provider, /fallback/);
  assert.equal(result.approval, 'approved_with_no_changes');
  assert.ok(Array.isArray(result.findings));
  assert.equal(result.findings.length, 0);
  assert.match(result.summary, /리뷰를 생성했습니다/);
});

test('LlmService stores raw external-agent review output as GitHub review body', async () => {
  const externalReviewBody = [
    '## 요약',
    '- 결제 API 리팩터링에서 실패 응답 메시지 일관성이 일부 약화되었습니다.',
    '',
    '## 리뷰 의견',
    '- 🔴 [버그] 검증 실패 시 사용자 메시지가 비어 있는 케이스가 있습니다.'
  ].join('\n');

  const service = new LlmService({
    getMode: () => 'external',
    isConfigured: () => true,
    createTextResponse: async () => ({
      text: externalReviewBody,
      provider: 'external_agent',
      agentProvider: ''
    })
  });

  const result = await service.generateGitHubReview({
    task: {
      title: 'GitHub review task',
      payload: {
        repoSlug: 'acme/demo',
        pullNumber: 22,
        sourceUrl: 'https://github.com/acme/demo/pull/22'
      }
    },
    pullRequest: {
      repoSlug: 'acme/demo',
      number: 22,
      title: 'Payment flow refactor',
      htmlUrl: 'https://github.com/acme/demo/pull/22'
    },
    files: []
  });

  assert.equal(result.provider, 'external_agent');
  assert.match(result.reviewBody, /^해당 리뷰는, pr의 diff 만 확인하여 작성된 리뷰입니다\./);
  assert.match(result.reviewBody, /코드 작성자의 판단하에 수정 여부를 결정해주세요\./);
  assert.match(result.reviewBody, /## 요약/);
  assert.match(result.reviewBody, /## 리뷰 의견/);
  assert.match(result.reviewBody, /결제 API 리팩터링에서 실패 응답 메시지 일관성이 일부 약화되었습니다/);
  assert.equal(Array.isArray(result.evidenceLinks), true);
  assert.equal(result.evidenceLinks.length, 0);
  assert.match(result.summary, /결제 API 리팩터링/);
  assert.equal(result.approval, 'approved_with_no_changes');
  assert.equal(result.findings.length, 0);
});

test('LlmService falls back to cli codex review generation when external github review fails', async () => {
  let externalCallCount = 0;
  let cliCallCount = 0;
  const service = new LlmService({
    getMode: () => 'external',
    isConfigured: () => true,
    createTextResponse: async () => {
      externalCallCount += 1;
      throw new Error('external provider failed');
    },
    cliClient: {
      isConfigured: () => true,
      createTextResponse: async ({ agentProvider, scope }) => {
        cliCallCount += 1;
        assert.equal(agentProvider, 'codex');
        assert.equal(scope, 'github_review');
        return {
          text: JSON.stringify({
            summary: '외부 제공자 실패 후 Codex로 리뷰를 생성했습니다.',
            approval: 'approved_with_no_changes',
            findings: []
          }),
          provider: 'codex'
        };
      }
    }
  });

  const result = await service.generateGitHubReview({
    task: {
      title: 'GitHub review task',
      payload: {
        repoSlug: 'acme/demo',
        pullNumber: 23,
        sourceUrl: 'https://github.com/acme/demo/pull/23'
      }
    },
    pullRequest: {
      repoSlug: 'acme/demo',
      number: 23,
      title: 'Payment flow refactor',
      author: 'author',
      baseRef: 'main',
      headRef: 'feature',
      headSha: 'abc123',
      htmlUrl: 'https://github.com/acme/demo/pull/23'
    },
    files: [
      {
        path: 'src/payment.ts',
        status: 'modified',
        additions: 4,
        deletions: 2,
        patch: '@@ -1 +1 @@\n-const a = 1;\n+const a = 2;'
      }
    ]
  });

  assert.equal(externalCallCount, 1);
  assert.equal(cliCallCount, 1);
  assert.equal(result.provider, 'cli:codex');
  assert.equal(result.agentProvider, 'codex');
  assert.equal(result.approval, 'approved_with_no_changes');
  assert.equal(result.findings.length, 0);
  assert.match(result.summary, /Codex/);
});

test('LlmService retries GitHub review generation with compact context on timeout', async () => {
  let callCount = 0;
  const service = new LlmService({
    getMode: () => 'cli',
    isConfigured: () => true,
    createTextResponse: async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error('codex 생성 CLI 호출이 90초 제한 시간을 초과했습니다');
      }
      return {
        text: JSON.stringify({
          summary: '핵심 회귀 이슈는 발견되지 않았고 보완 코멘트만 남길 수 있습니다.',
          approval: 'approved_with_no_changes',
          findings: []
        }),
        provider: 'cli:codex',
        agentProvider: 'codex'
      };
    }
  });

  const files = Array.from({ length: 12 }, (_, index) => ({
    path: `src/file-${index + 1}.js`,
    status: 'modified',
    additions: 5,
    deletions: 2,
    patch: '@@ -1 +1 @@\n-const a = 1;\n+const a = 2;'
  }));

  const result = await service.generateGitHubReview({
    task: {
      title: 'GitHub review task',
      payload: {
        repoSlug: 'acme/demo',
        pullNumber: 33
      }
    },
    pullRequest: {
      repoSlug: 'acme/demo',
      number: 33,
      title: 'Refactor modules',
      author: 'author',
      baseRef: 'main',
      headRef: 'feature',
      headSha: 'abc123'
    },
    files
  });

  assert.equal(callCount, 2);
  assert.equal(result.provider, 'cli:codex');
  assert.equal(result.agentProvider, 'codex');
  assert.equal(result.approval, 'approved_with_no_changes');
});

test('LlmService formats GitHub review body with summary and severity-separated findings', async () => {
  const service = new LlmService({
    getMode: () => 'cli',
    isConfigured: () => true,
    createTextResponse: async () => ({
      text: JSON.stringify({
        summary: '결제 플로우 리팩터링이며 검증 분기 일부가 변경되었습니다.',
        approval: 'changes_requested',
        findings: [
          {
            id: 'f-1',
            severity: 'high',
            category: 'bug',
            title: '실패 분기에서 상태 코드가 500으로 고정됨',
            description: '검증 실패도 500으로 응답되어 클라이언트 재시도 정책이 왜곡됩니다.',
            fileRefs: ['src/payment/controller.ts'],
            suggestedFix: '검증 실패는 4xx로 분리하고 테스트를 추가하세요.',
            mustFix: true
          }
        ]
      }),
      provider: 'cli:codex',
      agentProvider: 'codex'
    })
  });

  const result = await service.generateGitHubReview({
    task: {
      title: 'GitHub review task',
      payload: {
        repoSlug: 'acme/demo',
        pullNumber: 41
      }
    },
    pullRequest: {
      repoSlug: 'acme/demo',
      number: 41,
      title: 'Payment refactor',
      author: 'author',
      baseRef: 'main',
      headRef: 'feature/payment',
      headSha: 'abc123'
    },
    files: [
      {
        path: 'src/payment/service.ts',
        status: 'modified',
        additions: 20,
        deletions: 10,
        patch: '@@ -1 +1 @@'
      }
    ]
  });

  assert.equal(result.provider, 'cli:codex');
  assert.equal(result.approval, 'changes_requested');
  assert.equal(result.reviewBody.startsWith(GITHUB_REVIEW_DISCLAIMER), true);
  assert.match(result.reviewBody, /## 요약/);
  assert.match(result.reviewBody, /## 리뷰 의견/);
  assert.doesNotMatch(result.reviewBody, /## 근거 링크/);
  assert.equal(Array.isArray(result.evidenceLinks), true);
  assert.match(result.evidenceLinks[0] || '', /https:\/\/github\.com\/acme\/demo\/blob\/abc123\/src\/payment\/controller\.ts/);
  assert.match(result.reviewBody, /🔴 \[버그\]/);
  assert.doesNotMatch(result.reviewBody, /## 주요 변경사항/);
  assert.doesNotMatch(result.reviewBody, /## 잔여 리스크/);
});

test('LlmService generates Confluence-ready meeting document from transcript', async () => {
  const service = new LlmService({
    getMode: () => 'cli',
    isConfigured: () => true,
    createTextResponse: async () => ({
      text: JSON.stringify({
        title: '2026-04-17 주간 운영 회의',
        summary: '신규 결제 화면 일정과 QA 일정 조정이 핵심 안건이었습니다.',
        transcriptPolished: '결제 화면 일정은 4월 24일까지로 공유했습니다.\nQA 시작일은 4월 26일로 조정했습니다.',
        keyPoints: [
          '결제 화면 개발은 4월 24일까지 완료 목표로 공유됨',
          'QA 시작일은 4월 26일로 조정하기로 논의됨'
        ],
        decisions: [
          '결제 화면 디자인 반영 범위를 이번 주 안에 확정한다'
        ],
        actionItems: [
          {
            task: '결제 화면 QA 테스트 케이스 정리',
            owner: '지민',
            due: '2026-04-23',
            status: '진행 예정'
          }
        ],
        openIssues: [
          '모바일 결제 예외 케이스 범위는 추가 확인 필요'
        ],
        notes: [
          '원문 기준으로 일정 관련 발언이 가장 빈도가 높았습니다.'
        ]
      }),
      provider: 'cli:codex',
      agentProvider: 'codex'
    })
  });

  const result = await service.generateMeetingSummary({
    transcript: '회의 원문',
    startedAt: '2026-04-17T10:00:00.000Z',
    endedAt: '2026-04-17T10:40:00.000Z',
    language: 'ko-KR'
  });

  assert.equal(result.provider, 'cli:codex');
  assert.equal(result.agentProvider, 'codex');
  assert.match(result.summary, /핵심 안건/);
  assert.match(result.polishedTranscript, /결제 화면 일정은 4월 24일까지로 공유했습니다/);
  assert.match(result.document, /^# 2026-04-17 주간 운영 회의/m);
  assert.match(result.document, /## 액션 아이템/);
  assert.match(result.document, /\| 액션 \| 담당자 \| 기한 \| 상태 \|/);
  assert.match(result.document, /\| 결제 화면 QA 테스트 케이스 정리 \| 지민 \| 2026-04-23 \| 진행 예정 \|/);
});

test('LlmService keeps original transcript lines when transcriptPolished is summarized too aggressively', async () => {
  const service = new LlmService({
    getMode: () => 'cli',
    isConfigured: () => true,
    createTextResponse: async () => ({
      text: JSON.stringify({
        title: '회의 기록',
        summary: '핵심 안건 요약입니다.',
        transcriptPolished: '핵심 안건은 일정 조정과 QA 준비입니다.',
        keyPoints: [],
        decisions: [],
        actionItems: [],
        openIssues: [],
        notes: []
      }),
      provider: 'cli:codex',
      agentProvider: 'codex'
    })
  });

  const sourceTranscript = [
    '[09:00:01] 결제 화면 일정은 다음 주로 조정합니다.',
    '[09:00:12] QA 시작일은 수요일로 확정할까요?',
    '[09:00:25] 네, 수요일 시작으로 진행하겠습니다.',
    '[09:00:37] 예외 케이스는 내일까지 공유드립니다.'
  ].join('\n');

  const result = await service.generateMeetingSummary({
    transcript: sourceTranscript,
    startedAt: '2026-04-21T01:00:00.000Z',
    endedAt: '2026-04-21T01:20:00.000Z',
    language: 'ko-KR'
  });

  assert.equal(result.provider, 'cli:codex');
  assert.equal(result.polishedTranscript, sourceTranscript);
});

test('LlmService falls back to deterministic meeting document on generation error', async () => {
  const service = new LlmService({
    getMode: () => 'cli',
    isConfigured: () => true,
    createTextResponse: async () => {
      throw new Error('generation failed');
    }
  });

  const result = await service.generateMeetingSummary({
    transcript: '결제 일정은 다음 주로 조정합니다.\nQA 담당은 확정이 필요합니다.',
    startedAt: '2026-04-17T10:00:00.000Z',
    endedAt: '2026-04-17T10:20:00.000Z',
    language: 'ko-KR'
  });

  assert.match(result.provider, /^fallback:/);
  assert.match(result.polishedTranscript, /결제 일정은 다음 주로 조정합니다/);
  assert.match(result.document, /## 회의 개요/);
  assert.match(result.document, /## 핵심 논의/);
  assert.match(result.document, /## 결정 사항/);
  assert.match(result.document, /## 액션 아이템/);
  assert.match(result.document, /## 미해결 이슈/);
  assert.match(result.document, /## 원문 기반 참고 메모/);
});
