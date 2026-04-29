import type { TaskExecution } from '../types';
import { formatDateTime, mapStatusLabel } from '../task-view';
import { SUB_BUTTON_CLASS } from './common';

const ACTION_LABELS: Record<string, string> = {
  task_transition: '상태 변경',
  create_code_task: '코드 작업 생성',
  run_code_execution: '코드 작업 실행',
  complete_plan_mode: '플랜 모드 완료',
  save_plan_selections: '플랜 선택 저장',
  start_from_plan_mode: '플랜 확정 실행',
  resume_code_execution: '코드 작업 재개',
  generate_draft: '초안 생성',
  run_slack_code_review: '코드 검토 실행',
  create_pr: 'PR 생성',
  execute: '전송 실행'
};

function actionLabel(action: string): string {
  return ACTION_LABELS[action] || action;
}

function summarizeExecution(execution: TaskExecution): string {
  if (execution.action === 'task_transition' && execution.request) {
    const request = execution.request as Record<string, unknown>;
    const from = request.from as Record<string, unknown> | undefined;
    const to = request.to as Record<string, unknown> | undefined;
    if (from && to) {
      const fromStatus = String(from.status || '-');
      const toStatus = String(to.status || '-');
      const fromApproval = String(from.approvalState || '-');
      const toApproval = String(to.approvalState || '-');
      const fromError = String(from.lastError || '');
      const toError = String(to.lastError || '');
      const errorChanged = fromError !== toError;
      return errorChanged
        ? `상태 ${fromStatus} → ${toStatus}, 승인 ${fromApproval} → ${toApproval}, 오류 갱신됨`
        : `상태 ${fromStatus} → ${toStatus}, 승인 ${fromApproval} → ${toApproval}`;
    }
  }

  if (execution.error) {
    return execution.error;
  }

  if (execution.request && typeof execution.request === 'object') {
    const request = execution.request as Record<string, unknown>;
    const command = String(request.command || '').trim();
    const args = Array.isArray(request.args) ? request.args.map((arg) => String(arg || '').trim()).filter(Boolean) : [];
    if (command) {
      return args.length > 0
        ? `명령 실행: ${command} ${args.join(' ')}`
        : `명령 실행: ${command}`;
    }
  }

  if (execution.response && typeof execution.response === 'object') {
    const response = execution.response as Record<string, unknown>;
    const summary = String(response.summary || response.message || response.phase || '').trim();
    if (summary) {
      return summary;
    }
  }

  return '세부 정보를 확인하세요.';
}

function renderJson(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

type TaskTimelineProps = {
  executions: TaskExecution[];
  collapsed: boolean;
  onToggle: () => void;
  title?: string;
};

export function TaskTimeline({
  executions,
  collapsed,
  onToggle,
  title = '작업 타임라인'
}: TaskTimelineProps) {
  const timeline = [...executions].sort((left, right) => {
    const leftMs = Date.parse(left.created_at);
    const rightMs = Date.parse(right.created_at);
    if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) {
      return leftMs - rightMs;
    }
    return String(left.created_at).localeCompare(String(right.created_at));
  });

  return (
    <section className="min-w-0 rounded-xl border border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-slate-900">{title}</h4>
        <button type="button" className={SUB_BUTTON_CLASS} onClick={onToggle}>
          {collapsed ? '펼치기' : '접기'}
        </button>
      </div>

      {!collapsed && (
        <>
          {timeline.length === 0 ? (
            <p className="text-xs text-slate-600">아직 기록된 실행 로그가 없습니다.</p>
          ) : (
            <div className="grid max-h-80 gap-2 overflow-y-auto pr-1">
              {timeline.map((execution) => (
                <details key={execution.id} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                  <summary className="cursor-pointer break-words text-sm font-medium text-slate-900">
                    {actionLabel(execution.action)} · {mapStatusLabel(execution.status)} · {formatDateTime(execution.created_at)}
                  </summary>
                  <div className="mt-2 grid gap-2">
                    <p className="text-xs text-slate-700">{summarizeExecution(execution)}</p>
                    {execution.request && (
                      <div>
                        <p className="text-[11px] font-semibold text-slate-600">요청</p>
                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-slate-200 bg-white p-2 text-[11px] text-slate-700">{renderJson(execution.request)}</pre>
                      </div>
                    )}
                    {execution.response && (
                      <div>
                        <p className="text-[11px] font-semibold text-slate-600">응답</p>
                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-slate-200 bg-white p-2 text-[11px] text-slate-700">{renderJson(execution.response)}</pre>
                      </div>
                    )}
                    {execution.error && (
                      <div>
                        <p className="text-[11px] font-semibold text-rose-700">오류</p>
                        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-rose-200 bg-rose-50 p-2 text-[11px] text-rose-800">{execution.error}</pre>
                      </div>
                    )}
                  </div>
                </details>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
