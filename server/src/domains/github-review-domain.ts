// @ts-nocheck
import crypto from 'node:crypto';
import { normalizeWhitespace, safeArray, truncateText } from '../utils.ts';

function buildReviewFingerprint(pullRequest, files) {
  return crypto.createHash('sha1').update(JSON.stringify({
    headSha: pullRequest.headSha,
    files: files.map((file) => ({
      path: file.path,
      status: file.status,
      patch: file.patch || ''
    }))
  })).digest('hex');
}

function formatPullRequestBody(body) {
  const text = String(body || '').trim();
  return text || '(본문 없음)';
}

function formatFileContent(file) {
  const header = `${file.path} [${file.status}] +${file.additions}/-${file.deletions}`;
  const patch = String(file.patch || '').trim();
  return [header, '', patch || '(patch unavailable)'].join('\n');
}

function buildPullRequestArtifact(pullRequest) {
  const content = [
    `PR #${pullRequest.number}: ${pullRequest.title}`,
    `작성자: ${pullRequest.author}`,
    `브랜치: ${pullRequest.headRef} -> ${pullRequest.baseRef}`,
    `변경 파일: ${pullRequest.changedFiles}`,
    '',
    formatPullRequestBody(pullRequest.body)
  ].join('\n');

  return {
    externalId: String(pullRequest.number),
    title: 'PR 개요',
    content,
    sortOrder: 0,
    metadata: pullRequest
  };
}

function buildFileArtifacts(files) {
  return files.map((file, index) => ({
    externalId: file.sha || `${file.path}:${index}`,
    title: file.path,
    content: formatFileContent(file),
    sortOrder: index,
    metadata: file
  }));
}

function buildAnalysisArtifact(generated) {
  return {
    externalId: generated.summary,
    title: '리뷰 분석',
    content: generated.reviewBody,
    sortOrder: 0,
    metadata: {
      approval: generated.approval,
      findings: generated.findings,
      evidenceLinks: safeArray(generated.evidenceLinks).map((item) => normalizeWhitespace(item)).filter(Boolean).slice(0, 10),
      provider: generated.provider,
      agentProvider: generated.agentProvider || ''
    }
  };
}

function isFallbackProvider(provider) {
  return String(provider || '').startsWith('fallback');
}

export function createGitHubReviewDomain({ config, repo, githubClient, llmService }) {
  const resolvedStatuses = new Set(['done', 'ignored']);

  function findReusableDraft(taskId) {
    const drafts = repo.listDrafts(taskId);
    for (const draft of drafts) {
      const provider = String(draft?.metadata?.provider || '');
      if (!String(draft?.content || '').trim()) {
        continue;
      }
      if (provider && !isFallbackProvider(provider)) {
        return draft;
      }
    }

    return null;
  }

  function getTargets() {
    if (!config.github.owner || config.github.repositories.length === 0) {
      throw new Error('GitHub 리뷰 대상 저장소가 설정되지 않았습니다');
    }

    return config.github.repositories.map((repository) => ({
      owner: config.github.owner,
      repo: repository,
      repoSlug: `${config.github.owner}/${repository}`
    }));
  }

  async function generateDraft(task, options = {}) {
    const pullRequestArtifact = repo.listArtifacts(task.id, 'github_pull_request')[0];
    const fileArtifacts = repo.listArtifacts(task.id, 'github_pull_request_file');
    if (!pullRequestArtifact) {
      throw new Error('PR 컨텍스트가 없어 리뷰 초안을 생성할 수 없습니다');
    }

    const selectedGenerationAgentProvider = String(options.generationAgentProvider || '').trim().toLowerCase();
    const generated = await llmService.generateGitHubReview({
      task,
      pullRequest: pullRequestArtifact.metadata,
      files: fileArtifacts.map((artifact) => artifact.metadata),
      agentProvider: selectedGenerationAgentProvider
    });

    const reusableDraft = findReusableDraft(task.id);
    if (isFallbackProvider(generated.provider) && reusableDraft) {
      const latestDraft = repo.getLatestDraft(task.id);
      const draftToKeep = latestDraft?.id === reusableDraft.id
        ? reusableDraft
        : repo.createDraft(task.id, reusableDraft.content, {
            ...(reusableDraft.metadata || {})
          });
      const updatedTask = repo.updateTask(task.id, {
        status: 'drafted',
        approvalState: 'approved',
        lastError: generated.provider
      });

      return {
        task: updatedTask,
        draft: draftToKeep,
        generated: {
          ...generated,
          reusedPreviousDraft: true
        }
      };
    }

    const draft = repo.createDraft(task.id, generated.reviewBody, {
      provider: generated.provider,
      generationAgentProvider: generated.agentProvider || selectedGenerationAgentProvider || '',
      approval: generated.approval,
      findingsCount: generated.findings.length,
      evidenceLinks: safeArray(generated.evidenceLinks).map((item) => normalizeWhitespace(item)).filter(Boolean).slice(0, 10)
    });
    repo.replaceArtifacts(task.id, 'github_review_analysis', [buildAnalysisArtifact(generated)]);

    const nextPayload = {
      ...(task.payload || {})
    };
    if (generated.agentProvider || selectedGenerationAgentProvider) {
      nextPayload.generationAgentProvider = generated.agentProvider || selectedGenerationAgentProvider;
    }

    const updatedTask = repo.updateTask(task.id, {
      status: 'drafted',
      approvalState: 'approved',
      summary: generated.summary,
      payload: nextPayload,
      result: {
        ...(task.result || {}),
        approval: generated.approval,
        findings: generated.findings,
        evidenceLinks: safeArray(generated.evidenceLinks).map((item) => normalizeWhitespace(item)).filter(Boolean).slice(0, 10)
      },
      lastError: null
    });

    return {
      task: updatedTask,
      draft,
      generated
    };
  }

  async function execute(task, { message }) {
    const payload = task.payload || {};
    if (!payload.owner || !payload.repo || !payload.pullNumber) {
      throw new Error('GitHub 리뷰 작업 payload가 완전하지 않습니다');
    }

    const body = String(message || '').trim();
    if (!body) {
      throw new Error('리뷰 본문이 필요합니다');
    }

    const response = await githubClient.createIssueComment({
      owner: payload.owner,
      repo: payload.repo,
      issueNumber: payload.pullNumber,
      body
    });

    return {
      provider: 'github',
      reviewMode: 'issue_comment',
      approval: task.result?.approval || 'approved_with_no_changes',
      response: {
        id: response.id,
        state: 'COMMENT_POSTED',
        submittedAt: response.created_at || response.updated_at || '',
        commitId: '',
        htmlUrl: response.html_url || payload.sourceUrl || task.source_url || ''
      }
    };
  }

  async function poll() {
    if (!githubClient.isConfigured()) {
      throw new Error('GitHub 연결이 설정되지 않았습니다');
    }

    const targets = getTargets();
    const reviewerLogin = await githubClient.getAuthenticatedUserLogin();
    const normalizedReviewerLogin = String(reviewerLogin || '').toLowerCase();
    let pullRequestsFound = 0;
    let tasksProcessed = 0;
    let draftsSkipped = 0;
    let selfAuthoredSkipped = 0;
    let alreadyReviewedSkipped = 0;
    let candidatesListed = 0;

    for (const target of targets) {
      const pullRequests = await githubClient.listOpenPullRequests(target);
      for (const pullRequest of pullRequests) {
        pullRequestsFound += 1;

        if (pullRequest.draft) {
          draftsSkipped += 1;
          continue;
        }

        const pullRequestAuthor = String(pullRequest.user?.login || '').toLowerCase();
        if (pullRequestAuthor && pullRequestAuthor === normalizedReviewerLogin) {
          selfAuthoredSkipped += 1;
          continue;
        }

        const externalId = `${target.repoSlug}#${pullRequest.number}`;
        const existingTask = repo.getTaskByExternalId('github_review', externalId);

        if (existingTask && resolvedStatuses.has(existingTask.status)) {
          continue;
        }

        const latestReview = await githubClient.findLatestSubmittedReviewByUser({
          owner: target.owner,
          repo: target.repo,
          pullNumber: pullRequest.number,
          login: reviewerLogin
        });

        if (latestReview) {
          if (existingTask && !resolvedStatuses.has(existingTask.status)) {
            repo.updateTask(existingTask.id, {
              status: 'done',
              approvalState: 'approved',
              summary: 'GitHub에 이미 리뷰가 등록되어 있습니다.',
              result: {
                ...(existingTask.result || {}),
                existingReview: {
                  id: latestReview.id,
                  state: latestReview.state,
                  submittedAt: latestReview.submitted_at
                }
              },
              lastError: null
            });
          }
          alreadyReviewedSkipped += 1;
          continue;
        }

        const normalizedPullRequest = {
          owner: target.owner,
          repo: target.repo,
          repoSlug: target.repoSlug,
          number: pullRequest.number,
          title: normalizeWhitespace(pullRequest.title),
          body: pullRequest.body || '',
          author: pullRequest.user?.login || 'unknown',
          baseRef: pullRequest.base?.ref || '',
          headRef: pullRequest.head?.ref || '',
          headSha: pullRequest.head?.sha || '',
          changedFiles: Number(pullRequest.changed_files || 0),
          htmlUrl: pullRequest.html_url || '',
          draft: Boolean(pullRequest.draft),
          updatedAt: pullRequest.updated_at || ''
        };
        const files = (await githubClient.listPullRequestFiles({
          owner: target.owner,
          repo: target.repo,
          pullNumber: pullRequest.number
        })).map((file) => ({
          sha: file.sha || '',
          path: file.filename,
          status: file.status,
          additions: Number(file.additions || 0),
          deletions: Number(file.deletions || 0),
          patch: file.patch || ''
        }));

        let task = repo.upsertTask({
          domain: 'github_review',
          kind: 'review',
          externalId,
          title: `[깃허브 리뷰] ${target.repo}#${pullRequest.number} ${truncateText(pullRequest.title, 80)}`,
          sourceUrl: normalizedPullRequest.htmlUrl,
          payload: {
            owner: target.owner,
            repo: target.repo,
            repoSlug: target.repoSlug,
            pullNumber: pullRequest.number,
            text: `#${pullRequest.number} ${normalizeWhitespace(pullRequest.title)}`,
            author: normalizedPullRequest.author,
            baseRef: normalizedPullRequest.baseRef,
            headRef: normalizedPullRequest.headRef,
            headSha: normalizedPullRequest.headSha,
            updatedAt: normalizedPullRequest.updatedAt,
            sourceUrl: normalizedPullRequest.htmlUrl
          }
        });

        repo.replaceArtifacts(task.id, 'github_pull_request', [buildPullRequestArtifact(normalizedPullRequest)]);
        repo.replaceArtifacts(task.id, 'github_pull_request_file', buildFileArtifacts(files));

        const nextFingerprint = buildReviewFingerprint(normalizedPullRequest, files);
        const latestDraft = repo.getLatestDraft(task.id);
        const summaryMissing = !String(task.summary || '').trim();
        const draftMissing = !String(latestDraft?.content || '').trim();
        const fingerprintChanged = task.payload?.reviewFingerprint !== nextFingerprint;

        task = repo.updateTask(task.id, {
          payload: {
            ...task.payload,
            reviewFingerprint: nextFingerprint
          }
        });

        if (summaryMissing || draftMissing || fingerprintChanged || task.status === 'failed') {
          task = repo.updateTask(task.id, {
            status: 'new',
            approvalState: 'pending',
            summary: '리뷰 후보로 수집되었습니다. PR 상세에서 원하는 항목을 선택해 리뷰하세요.',
            lastError: null
          });
        }

        tasksProcessed += 1;
        candidatesListed += 1;
      }
    }

    return {
      domain: 'github_review',
      targets: targets.map((target) => target.repoSlug),
      pullRequestsFound,
      draftsSkipped,
      selfAuthoredSkipped,
      alreadyReviewedSkipped,
      tasksProcessed,
      candidatesListed,
      draftsGenerated: 0,
      reviewsSubmitted: 0
    };
  }

  return {
    id: 'github_review',
    label: '깃허브 리뷰',
    implemented: true,
    capabilities: {
      polling: true,
      drafting: true,
      execution: true
    },
    setupKeys: ['GITHUB_TOKEN', 'GITHUB_OWNER', 'GITHUB_REPOSITORIES'],
    poll,
    generateDraft,
    execute
  };
}
