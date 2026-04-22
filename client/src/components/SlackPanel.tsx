import { generateDraft, ignoreTask, sendTask, startCodeReview } from '../api';
import type { Task, TaskDetail, TaskDomainCatalog } from '../types';
import {
  type CodeReviewStatus,
  type CollapsibleSectionId,
  type CollapsibleState,
  type DraftEditorState,
  EMOJI_PRESET_OPTIONS,
  formatDateTime,
  mapCodeReviewStatus,
  mapDomainLabel,
  mapStatusLabel,
  normalizeReactionName,
  resolveReactionGlyph
} from '../task-view';
import {
  BUTTON_CLASS,
  DomainBadge,
  EMPTY_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  modeButtonClass,
  PANEL_CLASS,
  ProgressBar,
  SECTION_COUNT_CLASS,
  SECTION_HEADER_CLASS,
  StatusBadge,
  SUB_BUTTON_CLASS
} from './common';
import { TaskTimeline } from './TaskTimeline';

function toText(value: unknown): string {
  return String(value || '').trim();
}

function normalizeSlackTsForPermalink(value: unknown): string {
  const raw = toText(value);
  const match = raw.match(/^(\d+)\.(\d+)$/);
  if (!match) {
    return '';
  }
  const seconds = match[1];
  const micros = String(match[2] || '').padEnd(6, '0').slice(0, 6);
  return `${seconds}${micros}`;
}

function resolveSlackChannelId(sourceUrl: string, payloadChannelId: unknown): string {
  const payloadValue = toText(payloadChannelId);
  if (payloadValue) {
    return payloadValue;
  }

  const raw = toText(sourceUrl);
  if (!raw) {
    return '';
  }
  try {
    const parsed = new URL(raw);
    const match = parsed.pathname.match(/\/archives\/([^/]+)/);
    return toText(match?.[1]);
  } catch {
    return '';
  }
}

function buildSlackArtifactLink({
  taskSourceUrl,
  channelId,
  ts,
  threadTs
}: {
  taskSourceUrl: string;
  channelId: string;
  ts: unknown;
  threadTs: unknown;
}): string {
  const baseUrl = toText(taskSourceUrl);
  if (!baseUrl) {
    return '';
  }
  const normalizedTs = normalizeSlackTsForPermalink(ts);
  if (!normalizedTs) {
    return baseUrl;
  }

  try {
    const base = new URL(baseUrl);
    const resolvedChannelId = resolveSlackChannelId(baseUrl, channelId);
    if (!resolvedChannelId) {
      return baseUrl;
    }

    const permalink = new URL(`/archives/${resolvedChannelId}/p${normalizedTs}`, `${base.protocol}//${base.host}`);
    const normalizedThreadTs = toText(threadTs);
    if (normalizedThreadTs) {
      permalink.searchParams.set('thread_ts', normalizedThreadTs);
      permalink.searchParams.set('cid', resolvedChannelId);
    }
    return permalink.toString();
  } catch {
    return baseUrl;
  }
}

type SlackPanelProps = {
  tasks: Task[];
  selectedTaskId: string;
  detail: TaskDetail | null;
  editor: DraftEditorState | null;
  domain: TaskDomainCatalog | null;
  codeReview: CodeReviewStatus | null;
  showCodeReviewSection: boolean;
  collapsedSections: CollapsibleState;
  busyAction: string;
  onToggleSection: (sectionId: CollapsibleSectionId) => void;
  onSelectTask: (taskId: string) => void;
  onUpdateEditor: (taskId: string, patch: Partial<DraftEditorState>) => void;
  onRunAction: (label: string, action: () => Promise<string | string[] | void>) => void;
  onSetError: (message: string) => void;
};

export function SlackPanel({
  tasks,
  selectedTaskId,
  detail,
  editor,
  domain,
  codeReview,
  showCodeReviewSection,
  collapsedSections,
  busyAction,
  onToggleSection,
  onSelectTask,
  onUpdateEditor,
  onRunAction,
  onSetError
}: SlackPanelProps) {
  const messageArtifacts = detail
    ? detail.artifacts.filter((artifact) => artifact.type === 'slack_message')
    : [];
  const latestDraftMetadata = detail?.latestDraft?.metadata || {};
  const qualityScore = Number(latestDraftMetadata.qualityScore);
  const qualityWarnings = Array.isArray(latestDraftMetadata.qualityWarnings)
    ? latestDraftMetadata.qualityWarnings.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const evidenceLinks = Array.isArray(latestDraftMetadata.evidenceLinks)
    ? latestDraftMetadata.evidenceLinks.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const driftDetected = Boolean(latestDraftMetadata.requestDriftDetected);
  const driftReason = String(latestDraftMetadata.requestDriftReason || '').trim();
  const normalizedReactionName = normalizeReactionName(editor?.reactionName || '');
  const reactionGlyph = resolveReactionGlyph(normalizedReactionName);
  const isCodeReviewRunning = toText(codeReview?.analysisStatus).toLowerCase() === 'running';

  return (
    <section className={`${PANEL_CLASS} border-sky-200 bg-sky-50/70`}>
      <div className={`${SECTION_HEADER_CLASS} border-sky-200 bg-sky-100/80`}>
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold text-slate-800">Slack</h2>
          <span className={`${SECTION_COUNT_CLASS} border-sky-200`}>{tasks.length}건</span>
        </div>
        <button type="button" className={SUB_BUTTON_CLASS} onClick={() => onToggleSection('panel_slack')}>
          {collapsedSections.panel_slack ? '펼치기' : '접기'}
        </button>
      </div>

      {!collapsedSections.panel_slack && (
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

          {!selectedTaskId && <p className={EMPTY_CLASS}>Slack 작업이 없습니다.</p>}
          {selectedTaskId && !detail && <p className={EMPTY_CLASS}>Slack 상세를 불러오는 중입니다.</p>}

          {selectedTaskId && detail && editor && (
            <article className="grid gap-4 border-t border-slate-200 pt-4">
              <header className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                <h3 className="text-lg font-semibold text-slate-900">
                  {toText(detail.task.source_url)
                    ? (
                      <a
                        className="underline decoration-slate-300 underline-offset-4 transition hover:text-sky-700 hover:decoration-sky-400"
                        href={toText(detail.task.source_url)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {detail.task.title}
                      </a>
                    )
                    : detail.task.title}
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  <StatusBadge status={detail.task.status} label={mapStatusLabel(detail.task.status)} />
                  <StatusBadge status={detail.task.approval_state} label={mapStatusLabel(detail.task.approval_state)} />
                  <DomainBadge label={mapDomainLabel(detail.task.domain)} />
                </div>
              </header>

              <p className="text-sm text-slate-600">{detail.task.summary || '요약이 아직 없습니다.'}</p>
              {detail.task.last_error && <p className="text-sm text-rose-700">오류: {detail.task.last_error}</p>}
              {(Number.isFinite(qualityScore) || qualityWarnings.length > 0 || evidenceLinks.length > 0 || driftDetected) && (
                <section className="rounded-xl border border-slate-200 bg-white p-3">
                  <h4 className="text-sm font-semibold text-slate-900">슬랙 답변 품질</h4>
                  <p className="mt-1 text-xs text-slate-700">
                    품질 점수: {Number.isFinite(qualityScore) ? `${Math.max(0, Math.min(100, Math.round(qualityScore)))}/100` : '-'}
                  </p>
                  {qualityWarnings.length > 0 && (
                    <p className="mt-1 text-xs text-amber-700">주의: {qualityWarnings.join(' / ')}</p>
                  )}
                  {driftDetected && (
                    <p className="mt-1 text-xs text-rose-700">요청 이탈 감지: {driftReason || '요청과 다른 방향이 감지되어 보정했습니다.'}</p>
                  )}
                </section>
              )}

              {showCodeReviewSection && (
                <section className="grid gap-3 rounded-xl border border-slate-200 bg-white p-3">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="text-sm font-semibold text-slate-900">코드 분석 진행</h4>
                    <button type="button" className={SUB_BUTTON_CLASS} onClick={() => onToggleSection('slack_analysis')}>
                      {collapsedSections.slack_analysis ? '펼치기' : '접기'}
                    </button>
                  </div>
                  {!collapsedSections.slack_analysis && (
                    <>
                      {codeReview && (
                        <>
                          <p className="text-sm text-slate-700">{mapCodeReviewStatus(codeReview.analysisStatus)}</p>
                          <div>
                            <ProgressBar percent={codeReview.progressPercent} />
                          </div>
                          <p className="text-xs text-slate-500">
                            {codeReview.progressStep}/{codeReview.progressTotalSteps} · {codeReview.progressLabel || '진행 상태 없음'}
                          </p>
                        </>
                      )}

                      <section className="flex flex-wrap gap-2 justify-end">
                        <button
                          type="button"
                          className={BUTTON_CLASS}
                          onClick={() => onRunAction('코드 검토 실행', async () => {
                            await startCodeReview(detail.task.id);
                            return detail.task.id;
                          })}
                          disabled={Boolean(busyAction)}
                        >
                          코드 검토 실행
                        </button>
                        {domain?.capabilities?.drafting && (
                          <>
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
                            <button
                              type="button"
                              className={BUTTON_CLASS}
                              onClick={() => onRunAction('코드 기반 초안 생성', async () => {
                                await generateDraft(detail.task.id, true);
                                return detail.task.id;
                              })}
                              disabled={Boolean(busyAction) || isCodeReviewRunning}
                            >
                              코드 기반 초안 생성
                            </button>
                          </>
                        )}
                      </section>
                    </>
                  )}
                </section>
              )}

              <section className="grid gap-3 border-t border-dashed border-slate-300 pt-4">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-sm font-semibold text-slate-900">초안/요약 편집</h4>
                  <button type="button" className={SUB_BUTTON_CLASS} onClick={() => onToggleSection('slack_draft')}>
                    {collapsedSections.slack_draft ? '펼치기' : '접기'}
                  </button>
                </div>
                {!collapsedSections.slack_draft && (
                  <>
                    <label className={LABEL_CLASS}>
                      요약
                      <input className={INPUT_CLASS} value={editor.summary} onChange={(event) => onUpdateEditor(detail.task.id, { summary: event.target.value })} />
                    </label>
                    <div className={LABEL_CLASS}>
                      <span>전송 방식</span>
                      <div className="mt-1 flex flex-wrap gap-2">
                        <button type="button" className={modeButtonClass(editor.sendMode === 'reply')} onClick={() => onUpdateEditor(detail.task.id, { sendMode: 'reply' })}>
                          답글
                        </button>
                        <button type="button" className={modeButtonClass(editor.sendMode === 'reaction')} onClick={() => onUpdateEditor(detail.task.id, { sendMode: 'reaction' })}>
                          이모지
                        </button>
                      </div>
                    </div>
                    {editor.sendMode === 'reaction' && (
                      <>
                        <label className={LABEL_CLASS}>
                          이모지 이름
                          <input className={INPUT_CLASS} value={editor.reactionName} onChange={(event) => onUpdateEditor(detail.task.id, { reactionName: normalizeReactionName(event.target.value) })} placeholder="eyes" />
                        </label>
                        <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                          <span className="text-2xl" aria-hidden>{reactionGlyph || '🙂'}</span>
                          <div className="text-sm">
                            <p className="font-semibold text-slate-800">이모지 미리보기</p>
                            <p className="text-slate-600">{normalizedReactionName ? `:${normalizedReactionName}:` : '리액션 이름을 입력하세요'}</p>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {EMOJI_PRESET_OPTIONS.map((emoji) => (
                            <button key={emoji.name} type="button" className={modeButtonClass(normalizedReactionName === emoji.name)} onClick={() => onUpdateEditor(detail.task.id, { reactionName: emoji.name })}>
                              <span aria-hidden>{emoji.glyph}</span> :{emoji.name}:
                            </button>
                          ))}
                        </div>
                        <p className="text-xs text-slate-500">이모지 모드에서는 본문 없이 전송할 수 있습니다.</p>
                      </>
                    )}
                    {editor.sendMode !== 'reaction' && (
                      <>
                        <label className={LABEL_CLASS}>
                          본문
                          <textarea className={INPUT_CLASS} value={editor.content} onChange={(event) => onUpdateEditor(detail.task.id, { content: event.target.value })} rows={8} />
                        </label>
                        <section className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                          <h5 className="text-xs font-semibold text-slate-900">근거 링크</h5>
                          {evidenceLinks.length > 0 ? (
                            <ul className="mt-2 grid gap-1">
                              {evidenceLinks.map((link) => (
                                <li key={link} className="text-xs">
                                  <a
                                    className="break-all text-sky-700 underline underline-offset-2"
                                    href={link}
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    {link}
                                  </a>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="mt-1 text-xs text-slate-500">표시할 근거 링크가 없습니다.</p>
                          )}
                        </section>
                      </>
                    )}
                    <div className="flex flex-wrap justify-end gap-2">
                      <button
                        type="button"
                        className={BUTTON_CLASS}
                        onClick={() => {
                          const reactionNameToSend = normalizeReactionName(editor.reactionName);
                          if (editor.sendMode === 'reaction' && !reactionNameToSend) {
                            onSetError('이모지 전송에는 리액션 이름이 필요합니다.');
                            return;
                          }
                          onRunAction('작업 전송', async () => {
                            await sendTask(detail.task.id, {
                              draft: editor.content,
                              summary: editor.summary,
                              sendMode: editor.sendMode,
                              reactionName: reactionNameToSend
                            });
                            return detail.task.id;
                          });
                        }}
                        disabled={Boolean(busyAction)}
                      >
                        전송
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
                    </div>
                  </>
                )}
              </section>

              <section className="grid gap-2">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-sm font-semibold text-slate-900">메시지 / 답글</h4>
                  <button type="button" className={SUB_BUTTON_CLASS} onClick={() => onToggleSection('slack_artifacts')}>
                    {collapsedSections.slack_artifacts ? '펼치기' : '접기'}
                  </button>
                </div>
                {!collapsedSections.slack_artifacts && (
                  <ul className="grid gap-2">
                    {messageArtifacts.map((artifact) => {
                      const artifactLink = buildSlackArtifactLink({
                        taskSourceUrl: toText(detail.task.source_url),
                        channelId: resolveSlackChannelId(
                          toText(detail.task.source_url),
                          detail.task.payload?.channelId
                        ),
                        ts: artifact.metadata?.ts,
                        threadTs: artifact.metadata?.threadTs || detail.task.payload?.threadTs
                      });

                      return (
                        <li key={artifact.id} className="grid gap-2 rounded-lg border border-slate-200 bg-white p-3">
                          <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                            {artifactLink
                              ? (
                                <a
                                  className="font-semibold text-slate-900 underline decoration-slate-300 underline-offset-4 transition hover:text-sky-700 hover:decoration-sky-400"
                                  href={artifactLink}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {artifact.title || '메시지'}
                                </a>
                              )
                              : <strong className="text-slate-900">{artifact.title || '메시지'}</strong>}
                            <span className="text-xs text-slate-500">{formatDateTime(artifact.created_at)}</span>
                          </div>
                          <pre className="m-0 whitespace-pre-wrap break-words rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">{artifact.content || '(내용 없음)'}</pre>
                        </li>
                      );
                    })}
                    {messageArtifacts.length === 0 && <li className={EMPTY_CLASS}>표시할 메시지/답글 아티팩트가 없습니다.</li>}
                  </ul>
                )}
              </section>

              <TaskTimeline
                executions={detail.executions}
                collapsed={collapsedSections.slack_timeline}
                onToggle={() => onToggleSection('slack_timeline')}
              />
            </article>
          )}
        </>
      )}
    </section>
  );
}
