import { approveTask, createCodeTask, createPullRequest, ignoreTask, resumeCodeTask, runTask } from '../api';
import type { MetaResponse, Task, TaskDetail } from '../types';
import type {
  CollapsibleSectionId,
  CollapsibleState,
  ExecutionProgress
} from '../task-view';
import { mapDomainLabel, mapStatusLabel } from '../task-view';
import {
  BUTTON_CLASS,
  DomainBadge,
  EMPTY_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  PANEL_CLASS,
  ProgressBar,
  SECTION_COUNT_CLASS,
  SECTION_HEADER_CLASS,
  StatusBadge,
  SUB_BUTTON_CLASS
} from './common';

type CodeExecutionPanelProps = {
  meta: MetaResponse | null;
  tasks: Task[];
  selectedTaskId: string;
  detail: TaskDetail | null;
  executionProgress: ExecutionProgress | null;
  collapsedSections: CollapsibleState;
  busyAction: string;
  command: string;
  projectId: string;
  baseBranch: string;
  agentProvider: string;
  needsPlanning: boolean;
  needsDesign: boolean;
  onToggleSection: (sectionId: CollapsibleSectionId) => void;
  onSelectTask: (taskId: string) => void;
  onSetCommand: (value: string) => void;
  onSetProjectId: (value: string) => void;
  onSetBaseBranch: (value: string) => void;
  onSetAgentProvider: (value: string) => void;
  onSetNeedsPlanning: (value: boolean) => void;
  onSetNeedsDesign: (value: boolean) => void;
  onRunAction: (label: string, action: () => Promise<string | string[] | void>) => void;
};

export function CodeExecutionPanel({
  meta,
  tasks,
  selectedTaskId,
  detail,
  executionProgress,
  collapsedSections,
  busyAction,
  command,
  projectId,
  baseBranch,
  agentProvider,
  needsPlanning,
  needsDesign,
  onToggleSection,
  onSelectTask,
  onSetCommand,
  onSetProjectId,
  onSetBaseBranch,
  onSetAgentProvider,
  onSetNeedsPlanning,
  onSetNeedsDesign,
  onRunAction
}: CodeExecutionPanelProps) {
  const canResumeSelectedTask = Boolean(
    detail
    && ['failed', 'running'].includes(String(detail.task.status || '').toLowerCase())
  );
  const hasTokenOrAuthError = Boolean(
    detail
    && /token|auth|unauthorized|forbidden|401|403|인증/i.test(String(detail.task.last_error || ''))
  );

  return (
    <section className={`${PANEL_CLASS} border-amber-200 bg-amber-50/70`}>
      <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-100/80 px-3 py-2">
        <h2 className="text-base font-semibold text-slate-800">코드 작업</h2>
        <button type="button" className={SUB_BUTTON_CLASS} onClick={() => onToggleSection('panel_code')}>
          {collapsedSections.panel_code ? '펼치기' : '접기'}
        </button>
      </div>

      {!collapsedSections.panel_code && (
        <>
          <section className="grid gap-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-900">코드 작업 생성</h3>
              <button type="button" className={SUB_BUTTON_CLASS} onClick={() => onToggleSection('code_create')}>
                {collapsedSections.code_create ? '펼치기' : '접기'}
              </button>
            </div>
            {!collapsedSections.code_create && (
              <form
                className="grid gap-3 md:grid-cols-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  onRunAction('코드 작업 생성', async () => {
                    const created = await createCodeTask({
                      command,
                      projectId,
                      baseBranch,
                      agentProvider,
                      needsPlanning,
                      needsDesign
                    });
                    return created.task.id;
                  });
                }}
              >
                <label className={LABEL_CLASS}>
                  프로젝트
                  <select className={INPUT_CLASS} value={projectId} onChange={(event) => onSetProjectId(event.target.value)} required>
                    {(meta?.projects || []).map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={LABEL_CLASS}>
                  기준 브랜치
                  <input className={INPUT_CLASS} value={baseBranch} onChange={(event) => onSetBaseBranch(event.target.value)} />
                </label>
                <label className={LABEL_CLASS}>
                  에이전트
                  <select className={INPUT_CLASS} value={agentProvider} onChange={(event) => onSetAgentProvider(event.target.value)}>
                    <option value="codex">Codex</option>
                    <option value="claude">Claude</option>
                  </select>
                </label>
                <label className={`${LABEL_CLASS} md:col-span-3`}>
                  명령
                  <textarea
                    className={INPUT_CLASS}
                    value={command}
                    onChange={(event) => onSetCommand(event.target.value)}
                    rows={3}
                    placeholder="예: Slack 멘션 답변 생성 실패 시 로깅 원인 분석"
                    required
                  />
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={needsPlanning} onChange={(event) => onSetNeedsPlanning(event.target.checked)} />
                  기획 단계 실행
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input type="checkbox" checked={needsDesign} onChange={(event) => onSetNeedsDesign(event.target.checked)} />
                  디자인 단계 실행
                </label>
                <div className="md:col-span-3 flex justify-end">
                  <button type="submit" className={BUTTON_CLASS} disabled={Boolean(busyAction)}>실행</button>
                </div>
              </form>
            )}
          </section>

          <section className="mt-4 border-t border-slate-200 pt-4">
            <div className="mb-4 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-900">코드 작업 목록</h3>
              <button type="button" className={SUB_BUTTON_CLASS} onClick={() => onToggleSection('code_tasks')}>
                {collapsedSections.code_tasks ? '펼치기' : '접기'}
              </button>
            </div>
            {!collapsedSections.code_tasks && (
              <>
                <div className={`${SECTION_HEADER_CLASS} border-amber-200 bg-amber-100/80`}>
                  <h2 className="text-base font-semibold text-slate-800">코드 작업</h2>
                  <span className={`${SECTION_COUNT_CLASS} border-amber-200`}>{tasks.length}건</span>
                </div>

                <div className="mb-4">
                  <label className={LABEL_CLASS}>
                    작업 선택
                    <select
                      className={INPUT_CLASS}
                      value={selectedTaskId}
                      onChange={(event) => onSelectTask(event.target.value)}
                      disabled={tasks.length === 0}
                    >
                      {tasks.length === 0 && (
                        <option value="">선택 가능한 작업이 없습니다</option>
                      )}
                      {tasks.map((task) => (
                        <option key={task.id} value={task.id}>
                          {`${mapStatusLabel(task.status)} · ${task.title}`}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                {!selectedTaskId && <p className={EMPTY_CLASS}>코드 작업이 없습니다.</p>}
                {selectedTaskId && !detail && <p className={EMPTY_CLASS}>코드 작업 상세를 불러오는 중입니다.</p>}

                {selectedTaskId && detail && (
                  <article className="grid gap-4 border-t border-slate-200 pt-4">
                    <header className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                      <h3 className="text-lg font-semibold text-slate-900">{detail.task.title}</h3>
                      <div className="flex flex-wrap gap-1.5">
                        <StatusBadge status={detail.task.status} label={mapStatusLabel(detail.task.status)} />
                        <StatusBadge status={detail.task.approval_state} label={mapStatusLabel(detail.task.approval_state)} />
                        <DomainBadge label={mapDomainLabel(detail.task.domain)} />
                      </div>
                    </header>

                    <p className="text-sm text-slate-600">{detail.task.summary || '요약이 아직 없습니다.'}</p>
                    {detail.task.last_error && <p className="text-sm text-rose-700">오류: {detail.task.last_error}</p>}

                    {executionProgress && (
                      <section className="rounded-xl border border-slate-200 bg-white p-3">
                        <h4 className="text-sm font-semibold text-slate-900">코드 작업 진행</h4>
                        <p className="mt-1 text-sm text-slate-700">{executionProgress.phase || '-'}</p>
                        <div className="mt-2">
                          <ProgressBar percent={executionProgress.percent} />
                        </div>
                        <p className="mt-2 text-xs text-slate-500">
                          {executionProgress.currentStep}/{executionProgress.totalSteps}
                          {executionProgress.reviewTotalRounds > 0 && ` · 리뷰 ${executionProgress.reviewRound}/${executionProgress.reviewTotalRounds}`}
                          {executionProgress.label ? ` · ${executionProgress.label}` : ''}
                        </p>
                      </section>
                    )}

                    <section className="flex flex-wrap gap-2 justify-end">
                      <button
                        type="button"
                        className={BUTTON_CLASS}
                        onClick={() => onRunAction('코드 작업 실행', async () => {
                          await runTask(detail.task.id);
                          return detail.task.id;
                        })}
                        disabled={Boolean(busyAction)}
                      >
                        코드 작업 실행
                      </button>
                      {canResumeSelectedTask && (
                        <button
                          type="button"
                          className={BUTTON_CLASS}
                          onClick={() => onRunAction('코드 작업 재개', async () => {
                            await resumeCodeTask(detail.task.id);
                            return detail.task.id;
                          })}
                          disabled={Boolean(busyAction)}
                        >
                          코드 작업 재개
                        </button>
                      )}
                      <button
                        type="button"
                        className={BUTTON_CLASS}
                        onClick={() => onRunAction('PR 생성', async () => {
                          await createPullRequest(detail.task.id);
                          return detail.task.id;
                        })}
                        disabled={Boolean(busyAction)}
                      >
                        PR 생성
                      </button>
                    </section>
                    <section className="flex flex-wrap gap-2 justify-end">
                      <button
                        type="button"
                        className={BUTTON_CLASS}
                        onClick={() => onRunAction('작업 승인', async () => {
                          await approveTask(detail.task.id);
                          return detail.task.id;
                        })}
                        disabled={Boolean(busyAction)}
                      >
                        승인
                      </button>
                      <button
                        type="button"
                        className={BUTTON_CLASS}
                        onClick={() => onRunAction('작업 무시', async () => {
                          await ignoreTask(detail.task.id);
                          return detail.task.id;
                        })}
                        disabled={Boolean(busyAction)}
                      >
                        무시
                      </button>
                    </section>
                    {canResumeSelectedTask && (
                      <p className="text-xs text-slate-600">
                        실행 중 중단/오류가 발생한 작업은 <strong>코드 작업 재개</strong>로 이어서 진행할 수 있습니다.
                        {hasTokenOrAuthError ? ' 토큰/인증 오류가 원인이면 토큰 갱신 후 재개하세요.' : ''}
                      </p>
                    )}
                  </article>
                )}
              </>
            )}
          </section>
        </>
      )}
    </section>
  );
}
