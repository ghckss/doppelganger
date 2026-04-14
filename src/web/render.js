import { escapeHtml, formatDateTime, normalizeWhitespace } from '../utils.js';

const STATUS_LABELS = {
  total: '전체',
  new: '신규',
  drafted: '초안 작성됨',
  awaiting_approval: '승인 대기',
  approved: '승인됨',
  pending: '대기',
  rejected: '거절됨',
  ignored: '무시됨',
  done: '완료',
  failed: '실패',
  running: '실행 중',
  success: '성공',
  approved_with_no_changes: '승인(변경 없음)',
  changes_requested: '수정 요청'
};

const CONNECTOR_LABELS = {
  slack: 'Slack',
  openai: 'OpenAI',
  github: 'GitHub',
  workspace: '작업공간'
};

const EXECUTION_ACTION_LABELS = {
  generate_draft: '초안 생성',
  save_draft: '초안 저장',
  approve: '작업 승인',
  ignore: '작업 무시',
  execute: '작업 실행',
  create_code_task: '코드 작업 생성',
  generate_prompt: '프롬프트 생성',
  run_planning_agent: '기획 에이전트 실행',
  run_design_agent: '디자인 에이전트 실행',
  run_coding_agent: '코딩 에이전트 실행',
  run_review_agent: '리뷰 에이전트 실행',
  apply_review_fixes: '리뷰 반영',
  prepare_pr: 'PR 초안 준비',
  create_pr: 'PR 생성',
  run_code_execution: '코드 작업 실행',
  run_slack_code_review: '슬랙 코드 검토 실행',
  recover_code_execution_run: '중단 코드 작업 복구',
  recover_slack_code_review: '중단 코드 검토 복구'
};

const ARTIFACT_TYPE_LABELS = {
  slack_message: 'Slack 메시지',
  slack_code_analysis: '코드 검토 결과',
  github_pull_request: 'Pull Request',
  github_pull_request_file: '변경 파일',
  github_review_analysis: '리뷰 분석',
  workspace_snapshot: '작업공간 스냅샷',
  prompt_plan: '프롬프트 계획',
  product_plan: '기획안',
  design_spec: '디자인 명세',
  coding_prompt: '코딩 프롬프트',
  review_round: '리뷰 라운드',
  patch_round: '패치 라운드',
  pr_summary: 'PR 초안'
};

function badgeClass(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function translateLabel(value, labels) {
  const normalized = String(value || '');
  return labels[normalized] || normalized || '알 수 없음';
}

function translateBoolean(value) {
  return value ? '예' : '아니오';
}

function translateCodeReviewStatus(value) {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'not_candidate') return '후보 아님';
  if (normalized === 'not_requested') return '실행 대기';
  if (normalized === 'running') return '실행 중';
  if (normalized === 'completed') return '완료';
  if (normalized === 'failed') return '실패';
  return normalized || '-';
}

function translateProvider(provider) {
  const normalized = String(provider || '');
  if (!normalized) {
    return '알 수 없음';
  }
  if (normalized === 'openai') {
    return 'OpenAI';
  }
  if (normalized === 'manual') {
    return '수동';
  }
  if (normalized === 'hovis') {
    return 'Hovis';
  }
  if (normalized === 'fallback') {
    return '규칙 기반';
  }
  if (normalized.startsWith('fallback:')) {
    return `규칙 기반 (${normalized.slice('fallback:'.length)})`;
  }
  return normalized;
}

function translateAgentProvider(provider) {
  const normalized = String(provider || '').toLowerCase();
  if (normalized === 'claude') {
    return 'Claude';
  }
  return 'Codex';
}

function translateCodeExecutionPhase(phase) {
  const normalized = String(phase || '').toLowerCase();
  if (normalized === 'queued') return '실행 대기';
  if (normalized === 'workspace') return '작업 환경 점검';
  if (normalized === 'planning') return '프롬프트/기획/디자인 계획';
  if (normalized === 'coding') return '코딩';
  if (normalized === 'review') return '리뷰 및 수정';
  if (normalized === 'pr_draft') return 'PR 초안 정리';
  if (normalized === 'completed') return '완료';
  if (normalized === 'failed') return '실패';
  return normalized || '알 수 없음';
}

function translateTaskTitle(title) {
  return String(title || '')
    .replace(/^\[Slack\]/, '[슬랙]')
    .replace(/^\[Code\]/, '[코드]')
    .replace(/^\[GitHub Review\]/, '[깃허브 리뷰]');
}

function translateArtifactTitle(title, type) {
  const normalized = String(title || '');
  if (!normalized) {
    return translateLabel(type, ARTIFACT_TYPE_LABELS);
  }

  if (normalized === 'Workspace Snapshot') {
    return '작업공간 스냅샷';
  }
  if (normalized === 'Prompt Plan') {
    return '프롬프트 계획';
  }
  if (normalized === 'Product Plan') {
    return '기획안';
  }
  if (normalized === 'Design Spec') {
    return '디자인 명세';
  }
  if (normalized === 'Coding Prompt') {
    return '코딩 프롬프트';
  }
  if (normalized === 'Pull Request Draft') {
    return 'PR 초안';
  }
  if (normalized === 'Pull Request') {
    return 'Pull Request';
  }
  if (normalized === 'Parent message') {
    return '원본 메시지';
  }
  if (/^Reply \d+$/.test(normalized)) {
    return normalized.replace(/^Reply (\d+)$/, '답글 $1');
  }
  if (/^Review Round \d+$/.test(normalized)) {
    return normalized.replace(/^Review Round (\d+)$/, '리뷰 라운드 $1');
  }
  if (/^Patch Round \d+$/.test(normalized)) {
    return normalized.replace(/^Patch Round (\d+)$/, '패치 라운드 $1');
  }

  return normalized;
}

function renderFlash(query) {
  const parts = [];
  if (query.message) {
    parts.push(`<div class="flash flash-ok">${escapeHtml(query.message)}</div>`);
  }
  if (query.error) {
    parts.push(`<div class="flash flash-error">${escapeHtml(query.error)}</div>`);
  }
  return parts.join('');
}

function renderConnectorCards(readiness) {
  return Object.entries(readiness)
    .map(([name, status]) => {
      const title = CONNECTOR_LABELS[name] || name.replaceAll('_', ' ');
      const detail = status.ready
        ? '준비됨'
        : `누락: ${status.missing.join(', ')}`;
      return `
        <article class="connector-card ${status.ready ? 'is-ready' : 'is-missing'}">
          <div class="eyebrow">연결</div>
          <h3>${escapeHtml(title)}</h3>
          <p>${escapeHtml(detail)}</p>
        </article>
      `;
    })
    .join('');
}

function renderDomainCards(domains) {
  return domains
    .map((domain) => `
      <article class="domain-card">
        <div class="eyebrow">도메인</div>
        <h3>${escapeHtml(domain.label)}</h3>
        <p>${domain.implemented ? '현재 구현됨' : '다음 단계 구현 예정'}</p>
        <div class="mini-list">
          <span>수집: ${translateBoolean(domain.capabilities.polling)}</span>
          <span>초안: ${translateBoolean(domain.capabilities.drafting)}</span>
          <span>실행: ${translateBoolean(domain.capabilities.execution)}</span>
        </div>
      </article>
    `)
    .join('');
}

function renderGitHubCandidateList(tasks = []) {
  const candidates = tasks
    .filter((task) => task.domain === 'github_review' && task.status !== 'done' && task.status !== 'ignored');

  if (candidates.length === 0) {
    return '<p class="empty-state">아직 수집된 GitHub 리뷰 후보가 없습니다. 먼저 "GitHub PR 후보 가져오기"를 실행하세요.</p>';
  }

  return `
    <div class="task-list">
      ${candidates.map((task) => {
    const payload = task.payload || {};
    const pullNumber = payload.pullNumber ? `#${payload.pullNumber}` : '-';
    const summary = normalizeWhitespace(task.summary || '리뷰 후보로 수집되었습니다.');
    return `
          <a class="task-row" href="/tasks/${encodeURIComponent(task.id)}">
            <div class="task-row-main">
              <div class="task-row-title">${escapeHtml(translateTaskTitle(task.title))}</div>
              <div class="task-row-meta">
                <span>${escapeHtml(payload.repoSlug || '-')}</span>
                <span>${escapeHtml(pullNumber)}</span>
                <span>${escapeHtml(payload.author || '-')}</span>
                <span>${escapeHtml(formatDateTime(task.updated_at))}</span>
              </div>
              <p>${escapeHtml(summary)}</p>
            </div>
            <div class="task-row-side">
              <span class="badge badge-${badgeClass(task.status)}">${escapeHtml(translateLabel(task.status, STATUS_LABELS))}</span>
              <span class="badge badge-${badgeClass(task.approval_state)}">${escapeHtml(translateLabel(task.approval_state, STATUS_LABELS))}</span>
            </div>
          </a>
        `;
  }).join('')}
    </div>
  `;
}

function renderSlackMentionList(tasks = []) {
  const mentions = tasks
    .filter((task) => task.domain === 'slack_mention' && task.status !== 'done' && task.status !== 'ignored');

  if (mentions.length === 0) {
    return '<p class="empty-state">현재 검토할 Slack 멘션이 없습니다. "Slack 멘션 업데이트"를 실행해 새 멘션을 가져오세요.</p>';
  }

  return `
    <div class="task-list">
      ${mentions.map((task) => {
    const payload = task.payload || {};
    const channelLabel = payload.channelName ? `#${payload.channelName}` : (payload.channelId || '-');
    const summarySource = normalizeWhitespace(task.summary || payload.text || 'Slack 멘션이 수집되었습니다.');
    const summary = summarySource.length > 220 ? `${summarySource.slice(0, 219)}…` : summarySource;
    return `
          <a class="task-row" href="/tasks/${encodeURIComponent(task.id)}">
            <div class="task-row-main">
              <div class="task-row-title">${escapeHtml(translateTaskTitle(task.title))}</div>
              <div class="task-row-meta">
                <span>${escapeHtml(channelLabel)}</span>
                <span>${escapeHtml(payload.user || '-')}</span>
                <span>${escapeHtml(formatDateTime(task.updated_at))}</span>
              </div>
              <p>${escapeHtml(summary)}</p>
            </div>
            <div class="task-row-side">
              <span class="badge badge-${badgeClass(task.status)}">${escapeHtml(translateLabel(task.status, STATUS_LABELS))}</span>
              <span class="badge badge-${badgeClass(task.approval_state)}">${escapeHtml(translateLabel(task.approval_state, STATUS_LABELS))}</span>
            </div>
          </a>
        `;
  }).join('')}
    </div>
  `;
}

function renderThreadMessages(artifacts) {
  return artifacts
    .filter((artifact) => artifact.type === 'slack_message')
    .map((artifact) => `
      <article class="thread-message">
        <header>
          <strong>${escapeHtml(artifact.metadata.userName || artifact.metadata.user || '알 수 없음')}</strong>
          <time>${escapeHtml(formatDateTime(artifact.created_at || artifact.createdAt))}</time>
        </header>
        <div class="thread-body">${escapeHtml(artifact.content || '(빈 메시지)')}</div>
      </article>
    `)
    .join('');
}

function renderDraftHistory(drafts) {
  if (drafts.length === 0) {
    return '<p class="empty-state">초안 이력이 아직 없습니다.</p>';
  }

  return drafts
    .map((draft) => {
      const metadata = draft.metadata || {};
      const details = [
        metadata.replyCategoryLabel ? `응답 분류: ${metadata.replyCategoryLabel}` : '',
        metadata.reactionName ? `권장 반응: :${metadata.reactionName}:` : ''
      ].filter(Boolean);

      return `
      <article class="history-entry">
        <header>
          <strong>${escapeHtml(translateProvider(draft.metadata.provider))}</strong>
          <div class="mini-list">
            ${details.map((detail) => `<span>${escapeHtml(detail)}</span>`).join('')}
            <time>${escapeHtml(formatDateTime(draft.created_at))}</time>
          </div>
        </header>
        <pre>${escapeHtml(draft.content)}</pre>
      </article>
    `;
    })
    .join('');
}

function renderExecutions(executions) {
  if (executions.length === 0) {
    return '<p class="empty-state">실행 이력이 아직 없습니다.</p>';
  }

  return executions
    .map((execution) => `
      <article class="history-entry">
        <header>
          <strong>${escapeHtml(translateLabel(execution.action, EXECUTION_ACTION_LABELS))}</strong>
          <span class="badge badge-${badgeClass(execution.status)}">${escapeHtml(translateLabel(execution.status, STATUS_LABELS))}</span>
          <time>${escapeHtml(formatDateTime(execution.created_at))}</time>
        </header>
        <pre>${escapeHtml(JSON.stringify({
      요청: execution.request,
      응답: execution.response,
      오류: execution.error
    }, null, 2))}</pre>
      </article>
    `)
    .join('');
}

function renderArtifactHistory(artifacts) {
  const relevantArtifacts = artifacts.filter((artifact) => artifact.type !== 'slack_message');
  if (relevantArtifacts.length === 0) {
    return '<p class="empty-state">구조화된 산출물이 아직 없습니다.</p>';
  }

  return relevantArtifacts
    .map((artifact) => `
      <article class="history-entry" style="margin-top: 1rem">
        <header>
          <strong>${escapeHtml(translateArtifactTitle(artifact.title, artifact.type))}</strong>
          <div class="mini-list">
            <span>${escapeHtml(translateLabel(artifact.type, ARTIFACT_TYPE_LABELS))}</span>
            <time>${escapeHtml(formatDateTime(artifact.created_at || artifact.createdAt))}</time>
          </div>
        </header>
        <pre>${escapeHtml(artifact.content || JSON.stringify(artifact.metadata || {}, null, 2))}</pre>
      </article>
    `)
    .join('');
}

function renderCodeTaskForm(projects, projectsRoot, defaultAgentProvider = 'codex') {
  const options = projects.length > 0
    ? projects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}</option>`).join('')
    : '<option value="">선택 가능한 Git 프로젝트가 없습니다</option>';
  const selectedProvider = String(defaultAgentProvider || 'codex').toLowerCase() === 'claude'
    ? 'claude'
    : 'codex';

  return `
    <form method="POST" action="/tasks/code-execution/create" class="compose-form">
      <label>
        <span>작업 지시</span>
        <textarea name="command" rows="5" placeholder="원하는 변경 사항을 적어주세요. 필요하면 기획/디자인 요구도 함께 적습니다"></textarea>
      </label>
      <label>
        <span>프로젝트</span>
        <select name="projectId" ${projects.length === 0 ? 'disabled' : ''}>
          ${options}
        </select>
      </label>
      <p class="form-help">${escapeHtml(projectsRoot)} 경로에서 프로젝트를 찾습니다.</p>
      <label>
        <span>기준 브랜치</span>
        <input name="baseBranch" placeholder="main" />
      </label>
      <label>
        <span>에이전트</span>
        <select name="agentProvider">
          <option value="codex" ${selectedProvider === 'codex' ? 'selected' : ''}>Codex</option>
          <option value="claude" ${selectedProvider === 'claude' ? 'selected' : ''}>Claude</option>
        </select>
      </label>
      <label class="checkbox-row">
        <input type="checkbox" name="needsPlanning" value="true" />
        <span>기획 에이전트를 먼저 실행</span>
      </label>
      <label class="checkbox-row">
        <input type="checkbox" name="needsDesign" value="true" />
        <span>디자인 에이전트를 먼저 실행</span>
      </label>
      <div class="button-row single-button-row">
        <button type="submit" ${projects.length === 0 ? 'disabled' : ''}>코드 작업 생성</button>
      </div>
    </form>
  `;
}

function renderReviewRounds(result) {
  const rounds = result?.reviewRounds || [];
  if (rounds.length === 0) {
    return '<p class="empty-state">코딩이 시작되면 리뷰 라운드가 표시됩니다.</p>';
  }

  return rounds
    .map((round) => `
      <article class="history-entry">
        <header>
          <strong>라운드 ${escapeHtml(String(round.round))}</strong>
          <div class="mini-list">
            <span class="badge badge-${badgeClass(round.review?.approval)}">${escapeHtml(translateLabel(round.review?.approval, STATUS_LABELS))}</span>
            <span>발견사항 ${escapeHtml(String((round.review?.findings || []).length))}건</span>
          </div>
        </header>
        <pre>${escapeHtml(JSON.stringify(round, null, 2))}</pre>
      </article>
    `)
    .join('');
}

function renderCommitList(result) {
  const commits = result?.commits || [];
  if (commits.length === 0) {
    return '<p class="empty-state">기록된 커밋이 아직 없습니다.</p>';
  }

  return `
    <div class="commit-list">
      ${commits.map((commit) => `
        <article class="history-entry compact-entry">
          <strong>${escapeHtml(commit.subject)}</strong>
          <div class="mini-list"><span>${escapeHtml(commit.sha)}</span></div>
        </article>
      `).join('')}
    </div>
  `;
}

function renderCodeExecutionProgress(task, result) {
  const progress = result?.executionProgress || {};
  const totalStepsRaw = Number(progress.totalSteps || 0);
  const totalSteps = Number.isFinite(totalStepsRaw) ? Math.max(0, Math.trunc(totalStepsRaw)) : 0;
  const currentStepRaw = Number(progress.currentStep || 0);
  const currentStep = totalSteps > 0
    ? Math.max(0, Math.min(totalSteps, Number.isFinite(currentStepRaw) ? Math.trunc(currentStepRaw) : 0))
    : 0;
  const inferredPercent = totalSteps > 0 ? Math.round((currentStep / totalSteps) * 100) : 0;
  const percentRaw = Number(progress.percent ?? inferredPercent);
  const percentClamped = Number.isFinite(percentRaw) ? Math.max(0, Math.min(100, Math.round(percentRaw))) : inferredPercent;
  const percent = task.status === 'running' ? Math.min(percentClamped, 99) : percentClamped;
  const shouldRender = task.status === 'running' || totalSteps > 0 || Boolean(progress.phase);
  if (!shouldRender) {
    return '';
  }

  const label = normalizeWhitespace(progress.label) || (task.status === 'running'
    ? '코드 작업을 실행 중입니다.'
    : '코드 작업이 완료되었습니다.');
  const reviewRoundRaw = Number(progress.reviewRound || 0);
  const reviewTotalRaw = Number(progress.reviewTotalRounds || 0);
  const reviewRound = Number.isFinite(reviewRoundRaw) ? Math.max(0, Math.trunc(reviewRoundRaw)) : 0;
  const reviewTotalRounds = Number.isFinite(reviewTotalRaw) ? Math.max(1, Math.trunc(reviewTotalRaw)) : 0;
  const reviewSuffix = reviewRound > 0 && reviewTotalRounds > 0 ? ` / 리뷰 ${reviewRound}/${reviewTotalRounds}` : '';
  const stepSuffix = totalSteps > 0 ? ` (${currentStep}/${totalSteps})` : '';
  const detailLine = `${label}${reviewSuffix}${stepSuffix}`;

  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <div class="eyebrow">진행률</div>
          <h3>코드 작업 진행률</h3>
        </div>
      </div>
      <div class="analysis-progress" role="status" aria-live="polite">
        <div class="analysis-progress-head">
          <strong>실행 상태</strong>
          <span>${escapeHtml(String(percent))}%</span>
        </div>
        <div class="analysis-progress-track">
          <span class="analysis-progress-fill" style="width: ${escapeHtml(String(percent))}%"></span>
        </div>
        <p>${escapeHtml(detailLine)}</p>
        <p class="form-help">현재 단계: ${escapeHtml(translateCodeExecutionPhase(progress.phase))}</p>
      </div>
    </section>
  `;
}

function renderGitHubReviewContext({ task, artifacts }) {
  const payload = task.payload || {};
  const pullRequest = artifacts.find((artifact) => artifact.type === 'github_pull_request');
  const files = artifacts.filter((artifact) => artifact.type === 'github_pull_request_file');
  const body = pullRequest?.metadata?.body || pullRequest?.content || '(본문 없음)';

  return `
    <div class="facts-grid">
      <div><strong>저장소</strong><p>${escapeHtml(payload.repoSlug || '-')}</p></div>
      <div><strong>PR 번호</strong><p>${escapeHtml(payload.pullNumber ? `#${payload.pullNumber}` : '-')}</p></div>
      <div><strong>작성자</strong><p>${escapeHtml(payload.author || '-')}</p></div>
      <div><strong>브랜치</strong><p>${escapeHtml(payload.headRef && payload.baseRef ? `${payload.headRef} -> ${payload.baseRef}` : '-')}</p></div>
    </div>
    <article class="history-entry">
      <header>
        <strong>PR 설명</strong>
      </header>
      <pre>${escapeHtml(body)}</pre>
    </article>
    ${files.length === 0 ? '<p class="empty-state">가져온 변경 파일이 없습니다.</p>' : `
      <div class="thread-list">
        ${files.map((artifact) => `
          <article class="history-entry">
            <header>
              <strong>${escapeHtml(artifact.title || artifact.metadata.path || '변경 파일')}</strong>
              <div class="mini-list">
                <span>${escapeHtml(artifact.metadata.status || '-')}</span>
                <span>+${escapeHtml(String(artifact.metadata.additions || 0))}/-${escapeHtml(String(artifact.metadata.deletions || 0))}</span>
              </div>
            </header>
            <pre>${escapeHtml(artifact.content || '(patch unavailable)')}</pre>
          </article>
        `).join('')}
      </div>
    `}
  `;
}

function renderSlackCodeReviewSection({ task, repositories = [] }) {
  const codeReview = task.payload?.codeReview || {};
  const findings = Array.isArray(codeReview.findings) ? codeReview.findings : [];
  const configuredRepos = Array.isArray(repositories) ? repositories.filter(Boolean) : [];
  const selectedRepo = codeReview.selectedRepo || configuredRepos[0] || '';
  const selectedFolder = codeReview.selectedFolder || '';
  const selectedAgent = String(codeReview.analysisAgentProvider || 'codex').toLowerCase() === 'claude'
    ? 'claude'
    : 'codex';
  const progressStep = Number(codeReview.progressStep || 0);
  const progressTotal = Number(codeReview.progressTotalSteps || 0);
  const inferredPercent = progressTotal > 0
    ? Math.round((Math.max(0, Math.min(progressStep, progressTotal)) / progressTotal) * 100)
    : 0;
  const progressPercentRaw = Math.max(0, Math.min(100, Number(codeReview.progressPercent ?? inferredPercent) || inferredPercent));
  const isLikelyStalled = codeReview.analysisStatus === 'running' && progressTotal > 0 && progressStep >= progressTotal;
  const canRun = codeReview.analysisStatus !== 'running' || isLikelyStalled;
  const progressPercent = codeReview.analysisStatus === 'running'
    ? Math.min(progressPercentRaw, 99)
    : progressPercentRaw;
  const progressLabel = codeReview.progressLabel || '분석 준비 중입니다.';
  const selectionHint = codeReview.selectionReason
    || '코드 검토 실행 시 에이전트가 스레드 문맥으로 저장소와 폴더를 자동 선택합니다.';
  const rerunLabel = isLikelyStalled
    ? '코드 검토 다시 실행 (정체 복구)'
    : (codeReview.analysisStatus === 'completed' || codeReview.analysisStatus === 'failed')
      ? '코드 검토 다시 실행'
      : '코드 검토 실행';

  return `
    <article class="history-entry" style="margin-top: 1rem">
      <header>
        <strong>저장소 조회 기반 상세 답변</strong>
      </header>
      <div class="facts-grid">
        <div><strong>분석 상태</strong><p>${escapeHtml(translateCodeReviewStatus(codeReview.analysisStatus))}</p></div>
        <div><strong>선택 저장소</strong><p>${escapeHtml(selectedRepo || '-')}</p></div>
        <div><strong>선택 폴더</strong><p>${escapeHtml(selectedFolder || '(저장소 루트)')}</p></div>
        <div><strong>분석 에이전트</strong><p>${escapeHtml(selectedAgent === 'claude' ? 'Claude' : 'Codex')}</p></div>
        <div><strong>분석 시각</strong><p>${escapeHtml(codeReview.analyzedAt ? formatDateTime(codeReview.analyzedAt) : '-')}</p></div>
      </div>
      ${codeReview.analysisStatus === 'running' ? `
        <div class="analysis-progress" role="status" aria-live="polite">
          <div class="analysis-progress-head">
            <strong>분석 진행률</strong>
            <span>${escapeHtml(String(progressPercent))}%</span>
          </div>
          <div class="analysis-progress-track">
            <span class="analysis-progress-fill" style="width: ${escapeHtml(String(progressPercent))}%"></span>
          </div>
          <p>${escapeHtml(progressLabel)}${progressTotal > 0 ? ` (${progressStep}/${progressTotal})` : ''}</p>
          ${isLikelyStalled ? '<p class="form-help">진행률은 완료 단계에 도달했지만 상태 갱신이 지연되고 있습니다. 코드 검토를 다시 실행해 복구할 수 있습니다.</p>' : ''}
        </div>
      ` : ''}
      <p class="form-help">${escapeHtml(selectionHint)}</p>
      ${codeReview.summary ? `<pre>${escapeHtml(codeReview.summary)}</pre>` : ''}
      ${findings.length > 0 ? `
        <pre>${escapeHtml(findings
    .slice(0, 8)
    .map((finding, index) => `${index + 1}. ${finding.path}:${finding.line}\n   ${finding.excerpt || ''}`)
    .join('\n'))}</pre>
      ` : ''}
      ${codeReview.error ? `<pre class="error-copy">코드 검토 오류\n${escapeHtml(codeReview.error)}</pre>` : ''}
      ${canRun ? `
        <form method="POST" action="/tasks/${encodeURIComponent(task.id)}/code-review" class="compose-form">
          <p class="form-help">저장소/에이전트 선택 없이 자동 분석을 실행합니다.</p>
          <button type="submit" class="secondary" ${configuredRepos.length === 0 ? 'disabled' : ''}>${rerunLabel}</button>
        </form>
      ` : ''}
    </article>
  `;
}

function renderSlackTaskDetail({ detail, query, slackCodeReviewRepos = [] }) {
  const { task, artifacts, latestDraft, domain } = detail;
  const payload = task.payload || {};
  const editableDraft = latestDraft?.content || '';
  const summary = task.summary || '';
  const draftMetadata = latestDraft?.metadata || {};
  const sendMode = draftMetadata.sendMode || (draftMetadata.reactionName && !editableDraft ? 'reaction' : 'reply');
  const isReplyMode = sendMode !== 'reaction';
  const replyCategory = draftMetadata.replyCategory || '';
  const replyCategoryLabel = draftMetadata.replyCategoryLabel || '';
  const requestedAction = draftMetadata.requestedAction || '';
  const reactionName = draftMetadata.reactionName || '';
  const hasCompletedCodeReview = String(payload.codeReview?.analysisStatus || '').toLowerCase() === 'completed';
  const sourceLink = task.source_url ? `<a href="${escapeHtml(task.source_url)}" target="_blank" rel="noreferrer">Slack에서 열기</a>` : '';

  const body = `
    <section class="hero-panel detail-hero">
      <div>
        <div class="eyebrow">${escapeHtml(domain?.label || task.domain)}</div>
        <h2>${escapeHtml(translateTaskTitle(task.title))}</h2>
        <div class="mini-list">
          <span class="badge badge-${badgeClass(task.status)}">${escapeHtml(translateLabel(task.status, STATUS_LABELS))}</span>
          <span class="badge badge-${badgeClass(task.approval_state)}">${escapeHtml(translateLabel(task.approval_state, STATUS_LABELS))}</span>
          <span>${escapeHtml(payload.channelName || payload.channelId || task.domain)}</span>
          <span>${escapeHtml(formatDateTime(task.updated_at))}</span>
          ${sourceLink}
        </div>
        ${task.last_error ? `<p class="error-copy">최근 오류: ${escapeHtml(task.last_error)}</p>` : ''}
      </div>
      <div class="hero-actions stacked-actions" style="min-width: 12rem">
        <form method="POST" action="/tasks/${encodeURIComponent(task.id)}/draft" class="generate-draft-form" data-task-id="${escapeHtml(task.id)}">
          <input type="hidden" name="mode" value="generate" />
          <input type="hidden" name="includeCodeReviewContext" value="false" />
          <button type="submit">초안 다시 생성</button>
        </form>
        ${hasCompletedCodeReview ? `
          <form method="POST" action="/tasks/${encodeURIComponent(task.id)}/draft" class="generate-draft-form">
            <input type="hidden" name="mode" value="generate" />
            <input type="hidden" name="includeCodeReviewContext" value="true" />
            <button type="submit" class="secondary">코드검토 반영 초안 생성</button>
          </form>
        ` : ''}
        <form method="POST" action="/tasks/${encodeURIComponent(task.id)}/approve">
          <button type="submit" class="secondary">승인</button>
        </form>
        <form method="POST" action="/tasks/${encodeURIComponent(task.id)}/ignore">
          <button type="submit" class="ghost">무시</button>
        </form>
      </div>
    </section>

    <section class="panel-grid detail-grid">
      <section class="panel">
        <div class="panel-header">
          <div>
            <div class="eyebrow">스레드</div>
            <h3>Slack 문맥</h3>
          </div>
        </div>
        <div class="thread-list">${renderThreadMessages(artifacts)}</div>
        ${renderSlackCodeReviewSection({ task, repositories: slackCodeReviewRepos })}
      </section>

      <section class="panel">
        <div class="panel-header">
          <div>
            <div class="eyebrow">작성</div>
            <h3>요약 및 답변</h3>
          </div>
        </div>
        <form method="POST" action="/tasks/${encodeURIComponent(task.id)}/draft" class="compose-form slack-send-form">
          <input type="hidden" name="mode" value="save" />
          <input type="hidden" name="replyCategory" value="${escapeHtml(replyCategory)}" />
          <input type="hidden" name="replyCategoryLabel" value="${escapeHtml(replyCategoryLabel)}" />
          <input type="hidden" name="requestedAction" value="${escapeHtml(requestedAction)}" />
          <label>
            <span>요약</span>
            <textarea name="summary" rows="6" placeholder="스레드 요약">${escapeHtml(summary)}</textarea>
          </label>
          <div class="facts-grid">
            <div><strong>응답 분류</strong><p>${escapeHtml(replyCategoryLabel || '-')}</p></div>
            <div><strong>권장 반응</strong><p>${escapeHtml(reactionName ? `:${reactionName}:` : '없음')}</p></div>
          </div>
          <fieldset class="mode-selector">
            <legend>전송 방식</legend>
            <div class="segmented-control">
              <label class="segmented-option">
                <input type="radio" name="sendMode" value="reply" ${isReplyMode ? 'checked' : ''} />
                <span>답변 전송</span>
              </label>
              <label class="segmented-option">
                <input type="radio" name="sendMode" value="reaction" ${!isReplyMode ? 'checked' : ''} />
                <span>이모지 전송</span>
              </label>
            </div>
          </fieldset>
          <label data-send-field="reply" ${!isReplyMode ? 'hidden' : ''}>
            <span>답변 초안</span>
            <textarea name="draft" rows="12" placeholder="답변을 작성하거나 수정하세요" ${!isReplyMode ? 'disabled' : ''}>${escapeHtml(editableDraft)}</textarea>
          </label>
          <label data-send-field="reaction" ${isReplyMode ? 'hidden' : ''}>
            <span>반응 이모지</span>
            <input name="reactionName" placeholder="white_check_mark" value="${escapeHtml(reactionName)}" ${isReplyMode ? 'disabled' : ''} />
          </label>
          <p class="form-help" data-send-help="reply" ${!isReplyMode ? 'hidden' : ''}>답변 전송을 선택하면 스레드에 답변만 전송합니다.</p>
          <p class="form-help" data-send-help="reaction" ${isReplyMode ? 'hidden' : ''}>이모지 전송을 선택하면 멘션이 달린 원본 메시지에 반응 이모지만 추가합니다. Slack 토큰에 reactions:write 권한이 있어야 합니다.</p>
          <div class="button-row">
            <button type="submit" class="secondary">초안 저장</button>
            <button type="submit" formaction="/tasks/${encodeURIComponent(task.id)}/send">전송</button>
          </div>
        </form>
      </section>
    </section>
    <script>
      (() => {
        const form = document.querySelector('form.slack-send-form');
        if (!form) return;

        const replyField = form.querySelector('[data-send-field="reply"]');
        const reactionField = form.querySelector('[data-send-field="reaction"]');
        const replyHelp = form.querySelector('[data-send-help="reply"]');
        const reactionHelp = form.querySelector('[data-send-help="reaction"]');
        const draftInput = form.querySelector('textarea[name="draft"]');
        const reactionInput = form.querySelector('input[name="reactionName"]');

        function syncMode() {
          const selected = form.querySelector('input[name="sendMode"]:checked')?.value || 'reply';
          const isReply = selected === 'reply';

          if (replyField) replyField.hidden = !isReply;
          if (reactionField) reactionField.hidden = isReply;
          if (replyHelp) replyHelp.hidden = !isReply;
          if (reactionHelp) reactionHelp.hidden = isReply;
          if (draftInput) draftInput.disabled = !isReply;
          if (reactionInput) reactionInput.disabled = isReply;
        }

        form.querySelectorAll('input[name="sendMode"]').forEach((input) => {
          input.addEventListener('change', syncMode);
        });

        syncMode();
      })();
    </script>
  `;

  return renderLayout({
    title: translateTaskTitle(task.title),
    body,
    query,
    metaRefreshSeconds: task.payload?.codeReview?.analysisStatus === 'running' ? 3 : null
  });
}

function renderGitHubReviewDetail({ detail, query }) {
  const { task, artifacts, latestDraft, drafts, executions, domain } = detail;
  const payload = task.payload || {};
  const draftMetadata = latestDraft?.metadata || {};
  const editableDraft = latestDraft?.content || '';
  const summary = task.summary || '';
  const selectedGenerationAgentProvider = String(
    draftMetadata.generationAgentProvider || payload.generationAgentProvider || 'codex'
  ).toLowerCase() === 'claude'
    ? 'claude'
    : 'codex';
  const sourceLink = task.source_url ? `<a href="${escapeHtml(task.source_url)}" target="_blank" rel="noreferrer">GitHub에서 열기</a>` : '';

  const body = `
    <section class="hero-panel detail-hero">
      <div>
        <div class="eyebrow">${escapeHtml(domain?.label || task.domain)}</div>
        <h2>${escapeHtml(translateTaskTitle(task.title))}</h2>
        <div class="mini-list">
          <span class="badge badge-${badgeClass(task.status)}">${escapeHtml(translateLabel(task.status, STATUS_LABELS))}</span>
          <span class="badge badge-${badgeClass(task.approval_state)}">${escapeHtml(translateLabel(task.approval_state, STATUS_LABELS))}</span>
          <span>${escapeHtml(payload.repoSlug || task.domain)}</span>
          <span>${escapeHtml(payload.pullNumber ? `#${payload.pullNumber}` : '-')}</span>
          <span>${escapeHtml(formatDateTime(task.updated_at))}</span>
          ${sourceLink}
        </div>
        ${task.last_error ? `<p class="error-copy">최근 오류: ${escapeHtml(task.last_error)}</p>` : ''}
      </div>
      <div class="hero-actions stacked-actions">
        <form method="POST" action="/tasks/${encodeURIComponent(task.id)}/draft" class="generate-draft-form" data-task-id="${escapeHtml(task.id)}">
          <input type="hidden" name="mode" value="generate" />
          <label>
            <span>생성 에이전트</span>
            <select name="generationAgentProvider">
              <option value="codex" ${selectedGenerationAgentProvider === 'codex' ? 'selected' : ''}>Codex</option>
              <option value="claude" ${selectedGenerationAgentProvider === 'claude' ? 'selected' : ''}>Claude</option>
            </select>
          </label>
          <button type="submit">리뷰 다시 생성</button>
          <p class="form-help generation-status" data-generate-status aria-live="polite"></p>
        </form>
        <form method="POST" action="/tasks/${encodeURIComponent(task.id)}/ignore">
          <button type="submit" class="ghost">무시</button>
        </form>
      </div>
    </section>

    <section class="panel-grid detail-grid">
      <section class="panel">
        <div class="panel-header">
          <div>
            <div class="eyebrow">컨텍스트</div>
            <h3>PR 변경 내용</h3>
          </div>
        </div>
        ${renderGitHubReviewContext({ task, artifacts })}
      </section>

      <section class="panel">
        <div class="panel-header">
          <div>
            <div class="eyebrow">리뷰</div>
            <h3>요약 및 게시 본문</h3>
          </div>
        </div>
        <form method="POST" action="/tasks/${encodeURIComponent(task.id)}/draft" class="compose-form">
          <input type="hidden" name="mode" value="save" />
          <label>
            <span>요약</span>
            <textarea name="summary" rows="6" placeholder="리뷰 요약">${escapeHtml(summary)}</textarea>
          </label>
          <label>
            <span>리뷰 본문</span>
            <textarea name="draft" rows="14" placeholder="GitHub에 게시할 리뷰를 작성하거나 수정하세요">${escapeHtml(editableDraft)}</textarea>
          </label>
          <div class="button-row">
            <button type="submit" class="secondary">초안 저장</button>
            ${task.status !== 'done' ? `<button type="submit" formaction="/tasks/${encodeURIComponent(task.id)}/send">리뷰 코멘트 게시</button>` : ''}
          </div>
        </form>
      </section>
    </section>

    <section class="panel-grid two-up">
      <section class="panel">
        <div class="panel-header">
          <div>
            <div class="eyebrow">이력</div>
            <h3>리뷰 초안 이력</h3>
          </div>
        </div>
        ${renderDraftHistory(drafts)}
      </section>

      <section class="panel">
        <div class="panel-header">
          <div>
            <div class="eyebrow">이력</div>
            <h3>실행 이력</h3>
          </div>
        </div>
        ${renderExecutions(executions)}
      </section>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <div class="eyebrow">산출물</div>
          <h3>구조화된 산출물</h3>
        </div>
      </div>
      ${renderArtifactHistory(artifacts)}
    </section>
    <script>
      (() => {
        const form = document.querySelector('form.generate-draft-form');
        if (!form) return;

        const status = form.querySelector('[data-generate-status]');
        const submitButton = form.querySelector('button[type="submit"]');
        const agentSelect = form.querySelector('select[name="generationAgentProvider"]');
        const taskId = form.getAttribute('data-task-id');
        let timer = null;
        let startedAt = 0;

        function clearStatusClass() {
          if (!status) return;
          status.classList.remove('is-running', 'is-success', 'is-error');
        }

        function setStatus(text, mode) {
          if (!status) return;
          clearStatusClass();
          if (mode) {
            status.classList.add(mode);
          }
          status.textContent = text || '';
        }

        function setBusy(isBusy) {
          if (submitButton) submitButton.disabled = isBusy;
          if (agentSelect) agentSelect.disabled = isBusy;
        }

        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          if (form.dataset.running === '1') {
            return;
          }

          form.dataset.running = '1';
          startedAt = Date.now();
          setBusy(true);

          const selectedAgentLabel = agentSelect?.selectedOptions?.[0]?.textContent?.trim() || '기본';
          setStatus('리뷰 초안을 생성 중입니다... (0초 경과)', 'is-running');

          timer = window.setInterval(() => {
            const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
            setStatus('리뷰 초안을 생성 중입니다... (' + elapsed + '초 경과, ' + selectedAgentLabel + ')', 'is-running');
          }, 10000);

          try {
            const formData = new URLSearchParams(new FormData(form));
            const response = await fetch(form.action, {
              method: 'POST',
              headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
              },
              body: formData.toString()
            });

            const payload = await response.json().catch(() => ({}));
            if (!response.ok || payload.ok === false) {
              throw new Error(payload.error || '초안 생성 요청에 실패했습니다.');
            }

            const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
            const provider = payload.provider ? ' / ' + payload.provider : '';
            setStatus('생성 완료 (' + elapsed + '초)' + provider + '. 화면을 갱신합니다.', 'is-success');
            window.clearInterval(timer);
            timer = null;

            const target = payload.redirectUrl || ('/tasks/' + encodeURIComponent(taskId) + '?message=' + encodeURIComponent('초안을 생성했습니다'));
            window.setTimeout(() => {
              window.location.assign(target);
            }, 250);
          } catch (error) {
            const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
            setStatus('생성 실패 (' + elapsed + '초): ' + (error?.message || '알 수 없는 오류'), 'is-error');
            window.clearInterval(timer);
            timer = null;
            setBusy(false);
            form.dataset.running = '0';
          }
        });
      })();
    </script>
  `;

  return renderLayout({
    title: translateTaskTitle(task.title),
    body,
    query
  });
}

function renderCodeExecutionDetail({ detail, query }) {
  const { task, artifacts, executions, domain } = detail;
  const payload = task.payload || {};
  const result = task.result || {};
  const pullRequestUrl = result.pullRequest?.url || '';
  const canCreatePr = task.status === 'awaiting_approval' && !pullRequestUrl;
  const canRun = task.status === 'new' || task.status === 'failed';

  const body = `
    <section class="hero-panel detail-hero">
      <div>
        <div class="eyebrow">${escapeHtml(domain?.label || task.domain)}</div>
        <h2>${escapeHtml(translateTaskTitle(task.title))}</h2>
        <div class="mini-list">
          <span class="badge badge-${badgeClass(task.status)}">${escapeHtml(translateLabel(task.status, STATUS_LABELS))}</span>
          <span class="badge badge-${badgeClass(task.approval_state)}">${escapeHtml(translateLabel(task.approval_state, STATUS_LABELS))}</span>
          <span>${escapeHtml(payload.projectName || payload.repoSlug || payload.workdir || task.domain)}</span>
          <span>${escapeHtml(result.branch || payload.branchName || payload.baseBranch || '-')}</span>
          <span>${escapeHtml(formatDateTime(task.updated_at))}</span>
        </div>
        <p>${escapeHtml(task.summary || '실행 대기 중입니다.')}</p>
        ${task.last_error ? `<p class="error-copy">최근 오류: ${escapeHtml(task.last_error)}</p>` : ''}
      </div>
      <div class="hero-actions stacked-actions" style="min-width: 14rem">
        ${canRun ? `
          <form method="POST" action="/tasks/${encodeURIComponent(task.id)}/run">
            <button type="submit">작업 시작</button>
          </form>
        ` : ''}
        ${canCreatePr ? `
          <form method="POST" action="/tasks/${encodeURIComponent(task.id)}/create-pr">
            <button type="submit" class="secondary">PR 생성</button>
          </form>
        ` : ''}
        ${pullRequestUrl ? `
          <a class="inline-link-button" href="${escapeHtml(pullRequestUrl)}" target="_blank" rel="noreferrer">Pull Request 열기</a>
        ` : ''}
      </div>
    </section>

    ${renderCodeExecutionProgress(task, result)}

    <section class="panel-grid detail-grid" style="margin-top: 1rem">
      <section class="panel">
        <div class="panel-header">
          <div>
            <div class="eyebrow">입력</div>
            <h3>실행 요청</h3>
          </div>
        </div>
        <div class="facts-grid">
          <div><strong>작업 지시</strong><p>${escapeHtml(payload.command || '-')}</p></div>
          <div><strong>프로젝트</strong><p>${escapeHtml(payload.projectName || '-')}</p></div>
          <div><strong>경로</strong><p>${escapeHtml(payload.workdir || '-')}</p></div>
          <div><strong>기준 브랜치</strong><p>${escapeHtml(payload.baseBranch || '-')}</p></div>
          <div><strong>에이전트</strong><p>${escapeHtml(translateAgentProvider(payload.agentProvider))}</p></div>
          <div><strong>기획</strong><p>${escapeHtml(translateBoolean(payload.needsPlanning))}</p></div>
          <div><strong>디자인</strong><p>${escapeHtml(translateBoolean(payload.needsDesign))}</p></div>
          <div><strong>PR 상태</strong><p>${escapeHtml(pullRequestUrl ? '생성됨' : '아직 생성되지 않음')}</p></div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-header">
          <div>
            <div class="eyebrow">결과</div>
            <h3>커밋 요약</h3>
          </div>
        </div>
        ${renderCommitList(result)}
      </section>
    </section>

    <section class="panel-grid two-up">
      <section class="panel">
        <div class="panel-header">
          <div>
            <div class="eyebrow">리뷰</div>
            <h3>리뷰 라운드</h3>
          </div>
        </div>
        ${renderReviewRounds(result)}
      </section>

      <section class="panel">
        <div class="panel-header">
          <div>
            <div class="eyebrow">이력</div>
            <h3>실행 이력</h3>
          </div>
        </div>
        ${renderExecutions(executions)}
      </section>
    </section>

    <section class="panel">
      <div class="panel-header">
        <div>
          <div class="eyebrow">산출물</div>
          <h3>에이전트 산출물</h3>
        </div>
      </div>
      ${renderArtifactHistory(artifacts)}
    </section>
  `;

  return renderLayout({
    title: translateTaskTitle(task.title),
    body,
    query,
    metaRefreshSeconds: task.status === 'running' ? 5 : null
  });
}

export function renderLayout({ title, body, query = {}, metaRefreshSeconds = null }) {
  return `<!DOCTYPE html>
<html lang="ko">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    ${metaRefreshSeconds ? `<meta http-equiv="refresh" content="${metaRefreshSeconds}" />` : ''}
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="/static/styles.css" />
  </head>
  <body>
    <div class="page-shell">
      <header class="topbar">
        <div>
          <div class="topbar-subtitle">회사 업무 에이전트 서버</div>
          <h1>Doppelganger</h1>
        </div>
        <nav>
          <a href="/tasks">작업</a>
          <a href="/api/tasks">JSON</a>
          <a href="/healthz">상태</a>
        </nav>
      </header>
      ${renderFlash(query)}
      ${body}
    </div>
  </body>
</html>`;
}

export function renderTaskListPage({ tasks = [], projects, projectsRoot, defaultAgentProvider = 'codex', readiness, domains, query }) {
  const pendingSlackMentions = tasks
    .filter((task) => task.domain === 'slack_mention' && task.status !== 'done' && task.status !== 'ignored');
  const firstSlackMentionTaskId = pendingSlackMentions[0]?.id || null;
  const body = `


    <section class="panel">
      <div class="panel-header">
        <div>
          <div class="eyebrow">Slack</div>
          <h3>멘션</h3>
          <div class="mini-list">
            <span>대기 ${escapeHtml(String(pendingSlackMentions.length))}건</span>
          </div>
        </div>
        <div class="hero-actions">
          <form method="POST" action="/internal/poll/slack-mentions">
            <button type="submit" class="secondary">Slack 멘션 업데이트</button>
          </form>
          ${firstSlackMentionTaskId
      ? `<a class="inline-link-button" href="/tasks/${encodeURIComponent(firstSlackMentionTaskId)}">검토하기</a>`
      : ''}
        </div>
      </div>
      ${renderSlackMentionList(tasks)}
    </section>

    <section class="panel" style="margin-top: 1rem">
      <div class="panel-header">
        <div>
          <div class="eyebrow">GitHub</div>
          <h3>리뷰 후보 PR</h3>
        </div>
        <div class="hero-actions">
          <form method="POST" action="/internal/poll/github-reviews">
            <button type="submit">GitHub PR 후보 가져오기</button>
          </form>
        </div>
      </div>
      ${renderGitHubCandidateList(tasks)}
    </section>

    <section class="panel code-task-panel">
      <div class="panel-header">
        <div>
          <div class="eyebrow">새 작업</div>
          <h3>코드 작업 생성</h3>
        </div>
      </div>
      ${renderCodeTaskForm(projects, projectsRoot, defaultAgentProvider)}
    </section>
  `;

  return renderLayout({
    title: '작업',
    body,
    query
  });
}

export function renderTaskDetailPage({ detail, query, slackCodeReviewRepos = [] }) {
  if (detail.task.domain === 'code_execution') {
    return renderCodeExecutionDetail({ detail, query });
  }

  if (detail.task.domain === 'github_review') {
    return renderGitHubReviewDetail({ detail, query });
  }

  return renderSlackTaskDetail({ detail, query, slackCodeReviewRepos });
}

export function renderErrorPage({ title = '오류', message, query }) {
  const body = `
    <section class="panel error-panel">
      <div class="eyebrow">오류</div>
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(normalizeWhitespace(message || '요청을 처리하는 중 문제가 발생했습니다.'))}</p>
      <a href="/tasks">작업 목록으로 돌아가기</a>
    </section>
  `;

  return renderLayout({ title, body, query });
}
