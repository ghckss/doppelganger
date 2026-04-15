import { approveTask, generateDraft, ignoreTask, saveDraft, sendTask } from '../api';
import type { Task, TaskDetail, TaskDomainCatalog } from '../types';
import type { CollapsibleSectionId, CollapsibleState, DraftEditorState } from '../task-view';
import { mapDomainLabel, mapStatusLabel } from '../task-view';
import {
  BUTTON_CLASS,
  DomainBadge,
  EMPTY_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  PANEL_CLASS,
  SECTION_COUNT_CLASS,
  SECTION_HEADER_CLASS,
  StatusBadge,
  SUB_BUTTON_CLASS
} from './common';

type GitHubPanelProps = {
  tasks: Task[];
  selectedTaskId: string;
  detail: TaskDetail | null;
  editor: DraftEditorState | null;
  domain: TaskDomainCatalog | null;
  collapsedSections: CollapsibleState;
  busyAction: string;
  onToggleSection: (sectionId: CollapsibleSectionId) => void;
  onSelectTask: (taskId: string) => void;
  onUpdateEditor: (taskId: string, patch: Partial<DraftEditorState>) => void;
  onRunAction: (label: string, action: () => Promise<string | string[] | void>) => void;
};

export function GitHubPanel({
  tasks,
  selectedTaskId,
  detail,
  editor,
  domain,
  collapsedSections,
  busyAction,
  onToggleSection,
  onSelectTask,
  onUpdateEditor,
  onRunAction
}: GitHubPanelProps) {
  return (
    <section className={`${PANEL_CLASS} border-emerald-200 bg-emerald-50/60`}>
      <div className={`${SECTION_HEADER_CLASS} border-emerald-200 bg-emerald-100/80`}>
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold text-slate-800">GitHub PR</h2>
          <span className={`${SECTION_COUNT_CLASS} border-emerald-200`}>{tasks.length}건</span>
        </div>
        <button type="button" className={SUB_BUTTON_CLASS} onClick={() => onToggleSection('panel_github')}>
          {collapsedSections.panel_github ? '펼치기' : '접기'}
        </button>
      </div>

      {!collapsedSections.panel_github && (
        <>
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

          {!selectedTaskId && <p className={EMPTY_CLASS}>GitHub PR 작업이 없습니다.</p>}
          {selectedTaskId && !detail && <p className={EMPTY_CLASS}>GitHub PR 상세를 불러오는 중입니다.</p>}

          {selectedTaskId && detail && editor && (
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

              <section className="flex flex-wrap gap-2 justify-end">
                {domain?.capabilities?.drafting && (
                  <button
                    type="button"
                    className={BUTTON_CLASS}
                    onClick={() => onRunAction('초안 생성', async () => {
                      await generateDraft(detail.task.id, false);
                      return detail.task.id;
                    })}
                    disabled={Boolean(busyAction)}
                  >
                    초안 생성
                  </button>
                )}
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

              <section className="grid gap-3 border-t border-dashed border-slate-300 pt-4">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-sm font-semibold text-slate-900">초안/요약 편집</h4>
                  <button type="button" className={SUB_BUTTON_CLASS} onClick={() => onToggleSection('github_draft')}>
                    {collapsedSections.github_draft ? '펼치기' : '접기'}
                  </button>
                </div>
                {!collapsedSections.github_draft && (
                  <>
                    <label className={LABEL_CLASS}>
                      요약
                      <input className={INPUT_CLASS} value={editor.summary} onChange={(event) => onUpdateEditor(detail.task.id, { summary: event.target.value })} />
                    </label>
                    <label className={LABEL_CLASS}>
                      본문
                      <textarea className={INPUT_CLASS} value={editor.content} onChange={(event) => onUpdateEditor(detail.task.id, { content: event.target.value })} rows={8} />
                    </label>
                    <div className="flex flex-wrap gap-2 justify-end">
                      <button
                        type="button"
                        className={BUTTON_CLASS}
                        onClick={() => onRunAction('초안 저장', async () => {
                          await saveDraft(detail.task.id, {
                            draft: editor.content,
                            summary: editor.summary,
                            sendMode: 'reply',
                            reactionName: ''
                          });
                          return detail.task.id;
                        })}
                        disabled={Boolean(busyAction)}
                      >
                        초안 저장
                      </button>
                      <button
                        type="button"
                        className={BUTTON_CLASS}
                        onClick={() => onRunAction('작업 전송', async () => {
                          await sendTask(detail.task.id, {
                            draft: editor.content,
                            summary: editor.summary,
                            sendMode: 'reply',
                            reactionName: ''
                          });
                          return detail.task.id;
                        })}
                        disabled={Boolean(busyAction)}
                      >
                        전송
                      </button>
                    </div>
                  </>
                )}
              </section>
            </article>
          )}
        </>
      )}
    </section>
  );
}
