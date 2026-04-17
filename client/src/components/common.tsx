const BADGE_BASE_CLASS = 'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium';

export const INPUT_CLASS = 'mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-200';
export const BUTTON_CLASS = 'inline-flex items-center justify-center rounded-xl border border-transparent bg-emerald-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50';
export const SUB_BUTTON_CLASS = 'inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-100';
export const PANEL_CLASS = 'rounded-2xl border bg-slate-50 p-4 shadow-sm';
export const SECTION_HEADER_CLASS = 'mb-3 flex items-center justify-between gap-3 rounded-lg border px-3 py-2';
export const SECTION_COUNT_CLASS = 'rounded-full border bg-white px-2 py-0.5 text-xs font-semibold text-slate-600';
export const LABEL_CLASS = 'grid gap-1.5 text-sm text-slate-700';
export const EMPTY_CLASS = 'text-sm text-slate-500';

export function modeButtonClass(active: boolean): string {
  return `inline-flex items-center justify-center rounded-lg border px-3 py-1.5 text-sm font-semibold transition ${active
    ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
    : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100'}`;
}

function statusBadgeTone(status: string): string {
  const normalized = status.toLowerCase();
  if (normalized === 'running') return 'border-emerald-200 bg-emerald-50 text-emerald-800';
  if (normalized === 'failed') return 'border-rose-200 bg-rose-50 text-rose-800';
  if (normalized === 'done') return 'border-green-200 bg-green-50 text-green-800';
  if (normalized === 'approved') return 'border-green-200 bg-green-50 text-green-800';
  if (normalized === 'awaiting_approval') return 'border-amber-200 bg-amber-50 text-amber-800';
  if (normalized === 'ignored') return 'border-slate-200 bg-slate-100 text-slate-700';
  if (normalized === 'pending') return 'border-slate-200 bg-slate-100 text-slate-700';
  return 'border-slate-200 bg-slate-100 text-slate-700';
}

export function StatusBadge({ status, label }: { status: string; label: string }) {
  return (
    <span className={`${BADGE_BASE_CLASS} ${statusBadgeTone(status)}`}>
      {label}
    </span>
  );
}

export function DomainBadge({ label }: { label: string }) {
  return (
    <span className={`${BADGE_BASE_CLASS} border-amber-200 bg-amber-50 text-amber-800`}>
      {label}
    </span>
  );
}

export function ProgressBar({ percent }: { percent: number }) {
  const safePercent = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
      <div className="h-full rounded-full bg-emerald-500 transition-all duration-300" style={{ width: `${safePercent}%` }} />
    </div>
  );
}
