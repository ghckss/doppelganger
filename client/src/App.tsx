import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchMeta,
  fetchTaskDetail,
  fetchTasks,
  pollGitHubReviews,
  pollSlackMentions
} from './api';
import { CodeExecutionPanel } from './components/CodeExecutionPanel';
import { GitHubPanel } from './components/GitHubPanel';
import { MeetingPanel } from './components/MeetingPanel';
import { SlackPanel } from './components/SlackPanel';
import { BUTTON_CLASS } from './components/common';
import type { TaskDetail } from './types';
import {
  asText,
  type CollapsibleSectionId,
  type CollapsibleState,
  DOMAIN_IDS,
  type DomainId,
  type DraftEditorState,
  findDomain,
  formatDateTime,
  getCodeReviewStatus,
  toDraftEditor
} from './task-view';

const REFRESH_INTERVAL_MS = 10_000;

export default function App() {
  const queryClient = useQueryClient();
  const autoBatchUpdateRunningRef = useRef(false);
  const [selectedTaskIdByDomain, setSelectedTaskIdByDomain] = useState<Record<DomainId, string>>({
    slack_mention: '',
    github_review: '',
    code_execution: ''
  });
  const [draftEditorsByTaskId, setDraftEditorsByTaskId] = useState<Record<string, DraftEditorState>>({});
  const [busyAction, setBusyAction] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [lastBatchUpdateAt, setLastBatchUpdateAt] = useState('');
  const [lastBatchUpdateSummary, setLastBatchUpdateSummary] = useState('');

  const [command, setCommand] = useState('');
  const [projectId, setProjectId] = useState('');
  const [baseBranch, setBaseBranch] = useState('master');
  const [branchName, setBranchName] = useState('');
  const [agentProvider, setAgentProvider] = useState('codex');
  const [executionMode, setExecutionMode] = useState<'full' | 'plan'>('full');
  const [needsPlanning, setNeedsPlanning] = useState(false);
  const [needsDesign, setNeedsDesign] = useState(false);
  const [metaInitialized, setMetaInitialized] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<CollapsibleState>({
    panel_meeting: false,
    meeting_transcript: false,
    meeting_document: false,
    panel_slack: false,
    panel_github: false,
    panel_code: false,
    slack_analysis: false,
    slack_draft: false,
    slack_artifacts: true,
    slack_timeline: true,
    github_draft: false,
    github_timeline: true,
    code_create: false,
    code_tasks: true,
    code_timeline: true
  });

  const metaQuery = useQuery({
    queryKey: ['meta'],
    queryFn: fetchMeta,
    refetchInterval: REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: true
  });

  const tasksQuery = useQuery({
    queryKey: ['tasks', false],
    queryFn: () => fetchTasks(false),
    refetchInterval: REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: true
  });
  const codeTasksQuery = useQuery({
    queryKey: ['tasks', true],
    queryFn: () => fetchTasks(true),
    refetchInterval: REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: true
  });

  const tasks = tasksQuery.data?.tasks || [];
  const codeTasks = codeTasksQuery.data?.tasks || tasks;
  const slackTasks = tasks.filter((task) => task.domain === 'slack_mention');
  const githubReviewTasks = tasks.filter((task) => task.domain === 'github_review');
  const codeExecutionTasks = codeTasks.filter((task) => task.domain === 'code_execution');
  const runningCodeTaskIds = useMemo(
    () => codeExecutionTasks
      .filter((task) => String(task.status || '').toLowerCase() === 'running')
      .map((task) => task.id),
    [codeExecutionTasks]
  );
  const planSelectionTaskIds = useMemo(
    () => codeExecutionTasks
      .filter((task) => {
        const executionModeValue = String(task.payload?.executionMode || '').toLowerCase();
        const status = String(task.status || '').toLowerCase();
        return executionModeValue === 'plan' && (status === 'awaiting_approval' || status === 'running');
      })
      .map((task) => task.id),
    [codeExecutionTasks]
  );

  const selectedSlackTaskId = selectedTaskIdByDomain.slack_mention || '';
  const selectedGitHubTaskId = selectedTaskIdByDomain.github_review || '';
  const selectedDetailTaskIds = useMemo(
    () => Array.from(new Set([
      selectedSlackTaskId,
      selectedGitHubTaskId,
      ...runningCodeTaskIds,
      ...planSelectionTaskIds
    ].filter(Boolean))),
    [planSelectionTaskIds, runningCodeTaskIds, selectedGitHubTaskId, selectedSlackTaskId]
  );

  const detailQueries = useQueries({
    queries: selectedDetailTaskIds.map((taskId) => ({
      queryKey: ['taskDetail', taskId],
      queryFn: () => fetchTaskDetail(taskId),
      refetchInterval: REFRESH_INTERVAL_MS,
      refetchIntervalInBackground: true
    }))
  });

  const detailMap = useMemo(() => {
    const next: Record<string, TaskDetail> = {};
    selectedDetailTaskIds.forEach((taskId, index) => {
      const detail = detailQueries[index]?.data;
      if (detail) {
        next[taskId] = detail;
      }
    });
    return next;
  }, [detailQueries, selectedDetailTaskIds]);

  const slackDetail = selectedSlackTaskId ? detailMap[selectedSlackTaskId] || null : null;
  const githubDetail = selectedGitHubTaskId ? detailMap[selectedGitHubTaskId] || null : null;
  const codeTaskDetails = useMemo(
    () => Array.from(new Set([...runningCodeTaskIds, ...planSelectionTaskIds]))
      .map((taskId) => detailMap[taskId])
      .filter((detail): detail is TaskDetail => Boolean(detail)),
    [detailMap, planSelectionTaskIds, runningCodeTaskIds]
  );

  const slackEditor = slackDetail ? draftEditorsByTaskId[slackDetail.task.id] : null;
  const githubEditor = githubDetail ? draftEditorsByTaskId[githubDetail.task.id] : null;

  const slackDomain = slackDetail ? findDomain(tasksQuery.data?.domains, slackDetail.task.domain) : null;
  const githubDomain = githubDetail ? findDomain(tasksQuery.data?.domains, githubDetail.task.domain) : null;

  const slackCodeReview = slackDetail ? getCodeReviewStatus(slackDetail.task) : null;
  const showSlackCodeReviewSection = Boolean(slackDetail);

  const loadingTasks = tasksQuery.isFetching || codeTasksQuery.isFetching;
  const anyDetailLoading = detailQueries.some((query) => query.isFetching);
  const queryErrorMessage = asText((metaQuery.error as Error | undefined)?.message)
    || asText((tasksQuery.error as Error | undefined)?.message)
    || asText((codeTasksQuery.error as Error | undefined)?.message)
    || asText((detailQueries.find((query) => query.error)?.error as Error | undefined)?.message);
  const displayError = error || queryErrorMessage;

  function summarizePollResult(label: string, payload: unknown): string {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return `${label}: 완료`;
    }
    const record = payload as Record<string, unknown>;
    const metrics = [
      ['matchesFound', '매치'],
      ['pullRequestsFound', 'PR'],
      ['tasksProcessed', '처리'],
      ['draftsGenerated', '초안'],
      ['alreadyReviewedSkipped', '기검토']
    ]
      .map(([key, text]) => {
        const value = Number(record[key]);
        return Number.isFinite(value) ? `${text} ${Math.max(0, Math.trunc(value))}` : '';
      })
      .filter(Boolean);
    return metrics.length > 0 ? `${label}: ${metrics.join(', ')}` : `${label}: 완료`;
  }

  async function runBatchUpdate() {
    const results = await Promise.allSettled([
      pollSlackMentions(),
      pollGitHubReviews()
    ]);

    const summaryParts: string[] = [];
    const errors: string[] = [];
    const [slackResult, githubResult] = results;

    if (slackResult.status === 'fulfilled') {
      summaryParts.push(summarizePollResult('Slack', slackResult.value));
    } else {
      errors.push(`Slack 업데이트 실패: ${asText(slackResult.reason?.message || slackResult.reason || '알 수 없는 오류')}`);
    }

    if (githubResult.status === 'fulfilled') {
      summaryParts.push(summarizePollResult('GitHub', githubResult.value));
    } else {
      errors.push(`GitHub 업데이트 실패: ${asText(githubResult.reason?.message || githubResult.reason || '알 수 없는 오류')}`);
    }

    setLastBatchUpdateAt(new Date().toISOString());
    setLastBatchUpdateSummary(summaryParts.join(' | ') || '변경 내역 없음');

    await queryClient.invalidateQueries({ queryKey: ['tasks', false] });
    await queryClient.invalidateQueries({ queryKey: ['tasks', true] });
    await queryClient.invalidateQueries({ queryKey: ['meta'] });
    await queryClient.invalidateQueries({ queryKey: ['taskDetail'] });

    if (errors.length > 0) {
      throw new Error(errors.join(' / '));
    }
  }

  async function runAction(label: string, action: () => Promise<string | string[] | void>) {
    setBusyAction(label);
    setNotice('');
    setError('');

    try {
      const result = await action();
      const resultTaskIds = Array.isArray(result)
        ? result.filter(Boolean)
        : result
          ? [result]
          : [];

      await queryClient.invalidateQueries({ queryKey: ['tasks', false] });
      await queryClient.invalidateQueries({ queryKey: ['tasks', true] });
      await queryClient.invalidateQueries({ queryKey: ['meta'] });

      const selectedTaskIds = Object.values(selectedTaskIdByDomain).filter(Boolean);
      const detailTaskIds = Array.from(new Set([...selectedTaskIds, ...resultTaskIds]));
      const detailResults = await Promise.all(detailTaskIds.map(async (taskId) => {
        try {
          return await queryClient.fetchQuery({
            queryKey: ['taskDetail', taskId],
            queryFn: () => fetchTaskDetail(taskId)
          });
        } catch {
          return null;
        }
      }));
      const byTaskId = new Map(detailResults.filter((detail): detail is TaskDetail => Boolean(detail)).map((detail) => [detail.task.id, detail]));
      const shouldSyncDraftEditors = ['초안 생성', '코드 기반 초안 생성', '초안 저장', '새로고침'].includes(label);
      if (shouldSyncDraftEditors) {
        setDraftEditorsByTaskId((current) => {
          const next = { ...current };
          let changed = false;
          for (const taskId of detailTaskIds) {
            const detail = byTaskId.get(taskId);
            if (!detail || !detail.domain?.capabilities?.drafting) {
              continue;
            }
            next[detail.task.id] = toDraftEditor(detail);
            changed = true;
          }
          return changed ? next : current;
        });
      }

      if (resultTaskIds.length > 0) {
        const shouldOpenCodePanel = resultTaskIds.some((taskId) => {
          const detail = byTaskId.get(taskId);
          return detail?.task.domain === 'code_execution';
        });

        setSelectedTaskIdByDomain((current) => {
          const next = { ...current };
          for (const taskId of resultTaskIds) {
            const detail = byTaskId.get(taskId);
            if (!detail) {
              continue;
            }
            const domain = detail.task.domain as DomainId;
            if (DOMAIN_IDS.includes(domain)) {
              next[domain] = taskId;
            }
          }
          return next;
        });

        if (shouldOpenCodePanel) {
          setCollapsedSections((current) => ({
            ...current,
            panel_code: false,
            code_tasks: false
          }));
        }
      }

      setNotice(`${label} 완료`);
    } catch (caught) {
      setError(asText((caught as Error).message, `${label} 처리에 실패했습니다.`));
    } finally {
      setBusyAction('');
    }
  }

  function updateDraftEditor(taskId: string, patch: Partial<DraftEditorState>) {
    setDraftEditorsByTaskId((current) => ({
      ...current,
      [taskId]: {
        ...(current[taskId] || {
          content: '',
          summary: '',
          sendMode: 'reply',
          reactionName: ''
        }),
        ...patch
      }
    }));
  }

  function toggleSection(sectionId: CollapsibleSectionId) {
    setCollapsedSections((current) => ({
      ...current,
      [sectionId]: !current[sectionId]
    }));
  }

  useEffect(() => {
    const payload = metaQuery.data;
    if (!payload || metaInitialized) {
      return;
    }
    setAgentProvider(payload.defaultAgentProvider || 'codex');
    setProjectId((current) => current || payload.projects[0]?.id || '');
    setMetaInitialized(true);
  }, [metaInitialized, metaQuery.data]);

  useEffect(() => {
    setSelectedTaskIdByDomain((current) => {
      const next: Record<DomainId, string> = { ...current };

      const domainTaskMap: Record<DomainId, typeof tasks> = {
        slack_mention: slackTasks,
        github_review: githubReviewTasks,
        code_execution: codeExecutionTasks
      };

      for (const domain of DOMAIN_IDS) {
        const domainTasks = domainTaskMap[domain];
        const exists = domainTasks.some((task) => task.id === current[domain]);
        next[domain] = exists ? current[domain] : domainTasks[0]?.id || '';
      }

      if (
        current.slack_mention === next.slack_mention
        && current.github_review === next.github_review
        && current.code_execution === next.code_execution
      ) {
        return current;
      }

      return next;
    });
  }, [slackTasks, githubReviewTasks, codeExecutionTasks]);

  useEffect(() => {
    const details = [slackDetail, githubDetail].filter((detail): detail is TaskDetail => Boolean(detail));
    if (details.length === 0) {
      return;
    }

    setDraftEditorsByTaskId((current) => {
      const next = { ...current };
      let changed = false;
      for (const detail of details) {
        if (!next[detail.task.id]) {
          next[detail.task.id] = toDraftEditor(detail);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [githubDetail, slackDetail]);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (autoBatchUpdateRunningRef.current || busyAction) {
        return;
      }

      autoBatchUpdateRunningRef.current = true;
      void (async () => {
        try {
          await runBatchUpdate();
        } catch (caught) {
          if (!cancelled) {
            setError(asText((caught as Error).message, '일괄 업데이트 처리에 실패했습니다.'));
          }
        } finally {
          autoBatchUpdateRunningRef.current = false;
        }
      })();
    };
    tick();
    const intervalId = setInterval(tick, 60 * 1000);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [busyAction]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-950 to-slate-900">
      <div className="mx-auto grid min-h-screen w-full max-w-[1200px] grid-rows-[auto,1fr,auto] px-4 pb-4 sm:px-6">
        <header className="flex flex-col gap-4 py-5 text-slate-100 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.08em] text-slate-300">작업 관제 콘솔</p>
            <h1 className="mt-1 text-2xl font-bold">Doppelgänger</h1>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={BUTTON_CLASS} onClick={() => void runAction('일괄 업데이트', runBatchUpdate)} disabled={Boolean(busyAction)}>
              일괄 업데이트
            </button>
            <button type="button" className={BUTTON_CLASS} onClick={() => void runAction('새로고침', async () => { })} disabled={Boolean(busyAction) || loadingTasks}>
              새로고침
            </button>
          </div>
        </header>

        <main className="flex flex-col gap-5 pb-4">
          <SlackPanel
            tasks={slackTasks}
            selectedTaskId={selectedSlackTaskId}
            detail={slackDetail}
            editor={slackEditor}
            domain={slackDomain}
            codeReview={slackCodeReview}
            showCodeReviewSection={showSlackCodeReviewSection}
            collapsedSections={collapsedSections}
            busyAction={busyAction}
            onToggleSection={toggleSection}
            onSelectTask={(taskId) => {
              setSelectedTaskIdByDomain((current) => ({
                ...current,
                slack_mention: taskId
              }));
            }}
            onUpdateEditor={updateDraftEditor}
            onRunAction={(label, action) => {
              void runAction(label, action);
            }}
            onSetError={setError}
          />

          <GitHubPanel
            tasks={githubReviewTasks}
            selectedTaskId={selectedGitHubTaskId}
            detail={githubDetail}
            editor={githubEditor}
            domain={githubDomain}
            collapsedSections={collapsedSections}
            busyAction={busyAction}
            onToggleSection={toggleSection}
            onSelectTask={(taskId) => {
              setSelectedTaskIdByDomain((current) => ({
                ...current,
                github_review: taskId
              }));
            }}
            onUpdateEditor={updateDraftEditor}
            onRunAction={(label, action) => {
              void runAction(label, action);
            }}
          />

          <MeetingPanel
            collapsedSections={collapsedSections}
            onToggleSection={toggleSection}
          />

          <CodeExecutionPanel
            meta={metaQuery.data || null}
            tasks={codeExecutionTasks}
            taskDetails={codeTaskDetails}
            collapsedSections={collapsedSections}
            busyAction={busyAction}
            command={command}
            projectId={projectId}
            baseBranch={baseBranch}
            branchName={branchName}
            agentProvider={agentProvider}
            executionMode={executionMode}
            needsPlanning={needsPlanning}
            needsDesign={needsDesign}
            onToggleSection={toggleSection}
            onSetCommand={setCommand}
            onSetProjectId={setProjectId}
            onSetBaseBranch={setBaseBranch}
            onSetBranchName={setBranchName}
            onSetAgentProvider={setAgentProvider}
            onSetExecutionMode={setExecutionMode}
            onSetNeedsPlanning={setNeedsPlanning}
            onSetNeedsDesign={setNeedsDesign}
            onRunAction={(label, action) => {
              void runAction(label, action);
            }}
          />
        </main>

        <footer className="flex flex-wrap items-center gap-4 border-t border-slate-700/60 py-3 text-sm text-slate-200">
          {loadingTasks || anyDetailLoading ? <span>데이터 동기화 중…</span> : <span>동기화 완료</span>}
          {busyAction && <span>실행 중: {busyAction}</span>}
          {lastBatchUpdateAt && (
            <span>
              마지막 일괄 업데이트: {formatDateTime(lastBatchUpdateAt)}
              {lastBatchUpdateSummary ? ` · ${lastBatchUpdateSummary}` : ''}
            </span>
          )}
          {notice && <span className="text-emerald-300">{notice}</span>}
          {displayError && <span className="text-rose-300">{displayError}</span>}
        </footer>
      </div>
    </div>
  );
}
