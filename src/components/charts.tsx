import { useId, useState, type ReactNode } from 'react';
import { formatDate } from '../lib/format.ts';
import { cn } from '../lib/util.ts';

export interface Series {
  key: string;
  label: string;
  color: string; // CSS colour, e.g. var(--series-1)
}

export interface BarDatum {
  date: string;
  values: Record<string, number>;
  /** Extra lines shown in the tooltip and table. */
  extra?: Record<string, ReactNode>;
}

function niceMax(v: number): number {
  if (v <= 4) return Math.max(1, v);
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * pow;
}

/** Stacked (or single) daily bar chart with hover tooltip, legend and table view. */
export function DailyBarChart({
  data,
  series,
  height = 180,
  title,
  valueLabel = 'attempts',
  extraColumns = [],
}: {
  data: BarDatum[];
  series: Series[];
  height?: number;
  title: string;
  valueLabel?: string;
  extraColumns?: { key: string; label: string }[];
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const id = useId();
  const totals = data.map((d) => series.reduce((n, s) => n + (d.values[s.key] ?? 0), 0));
  const max = niceMax(Math.max(0, ...totals));
  const gap = data.length > 60 ? 1 : data.length > 31 ? 2 : 4;
  const labelEvery = Math.max(1, Math.ceil(data.length / 7));
  const h = hover !== null ? data[hover] : null;

  return (
    <figure className="min-w-0" aria-labelledby={`${id}-cap`}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <figcaption id={`${id}-cap`} className="text-sm font-medium text-text-2">
          {title}
        </figcaption>
        <div className="flex flex-wrap items-center gap-3">
          {series.length > 1 && (
            <ul className="flex flex-wrap gap-3 text-xs text-text-2" aria-label="Legend">
              {series.map((s) => (
                <li key={s.key} className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-[3px]" style={{ background: s.color }} aria-hidden />
                  {s.label}
                </li>
              ))}
            </ul>
          )}
          <button className="text-xs font-medium text-primary-text underline-offset-2 hover:underline" onClick={() => setTable(!table)} aria-expanded={table}>
            {table ? 'Show chart' : 'Show table'}
          </button>
        </div>
      </div>
      {table ? (
        <div className="max-h-72 overflow-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface-2 text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Date</th>
                {series.map((s) => (
                  <th key={s.key} className="px-3 py-2 text-right font-medium">
                    {s.label}
                  </th>
                ))}
                {extraColumns.map((c) => (
                  <th key={c.key} className="px-3 py-2 text-right font-medium">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {data.map((d) => (
                <tr key={d.date} className="border-t border-border">
                  <td className="px-3 py-1.5">{formatDate(d.date)}</td>
                  {series.map((s) => (
                    <td key={s.key} className="px-3 py-1.5 text-right">
                      {d.values[s.key] ?? 0}
                    </td>
                  ))}
                  {extraColumns.map((c) => (
                    <td key={c.key} className="px-3 py-1.5 text-right">
                      {d.extra?.[c.key]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative" aria-hidden="true">
          <div className="flex gap-2">
            <div className="flex w-7 flex-col justify-between text-right text-[11px] text-muted tabular-nums" style={{ height }}>
              <span>{max}</span>
              <span>{max / 2 === Math.floor(max / 2) ? max / 2 : ''}</span>
              <span>0</span>
            </div>
            <div className="relative min-w-0 flex-1">
              <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed border-border" />
              <div className="pointer-events-none absolute inset-x-0 border-t border-dashed border-border" style={{ top: height / 2 }} />
              <div className="flex items-end border-b border-border-strong" style={{ height, gap }} onMouseLeave={() => setHover(null)}>
                {data.map((d, i) => (
                  <div key={d.date} className="group relative flex h-full min-w-0 flex-1 flex-col justify-end" onMouseEnter={() => setHover(i)}>
                    <div className={cn('absolute inset-0 -mx-px rounded-md', hover === i && 'bg-surface-2')} />
                    <div className="relative flex flex-col-reverse gap-[2px]">
                      {series.map((s, si) => {
                        const v = d.values[s.key] ?? 0;
                        if (!v) return null;
                        const topmost = series.slice(si + 1).every((x) => !(d.values[x.key] ?? 0));
                        return (
                          <div
                            key={s.key}
                            style={{ height: Math.max(2, (v / max) * height - 2), background: s.color }}
                            className={cn(topmost ? 'rounded-t-[4px]' : '', 'transition-[height] duration-200')}
                          />
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-1.5 flex text-[11px] text-muted" style={{ gap }}>
                {data.map((d, i) => (
                  <span key={d.date} className="min-w-0 flex-1 overflow-visible text-center whitespace-nowrap">
                    {i % labelEvery === 0 ? formatDate(d.date, { day: 'numeric', month: 'short' }) : ''}
                  </span>
                ))}
              </div>
              {h && hover !== null && (
                <div
                  className="pointer-events-none absolute -top-2 z-10 w-max min-w-36 -translate-y-full rounded-xl border border-border bg-surface px-3 py-2 text-xs shadow-pop"
                  style={{ left: `clamp(0px, calc(${((hover + 0.5) / data.length) * 100}% - 72px), calc(100% - 150px))` }}
                >
                  <p className="mb-1 font-semibold text-text">{formatDate(h.date, { weekday: 'short', day: 'numeric', month: 'short' })}</p>
                  {series.map((s) => (
                    <p key={s.key} className="flex items-center justify-between gap-4 text-text-2">
                      <span className="flex items-center gap-1.5">
                        <span className="size-2 rounded-[2px]" style={{ background: s.color }} />
                        {s.label}
                      </span>
                      <span className="font-medium text-text tabular-nums">{h.values[s.key] ?? 0}</span>
                    </p>
                  ))}
                  {extraColumns.map((c) => (
                    <p key={c.key} className="flex justify-between gap-4 text-text-2">
                      {c.label}
                      <span className="font-medium text-text tabular-nums">{h.extra?.[c.key]}</span>
                    </p>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      <p className="sr-only">
        {title}: {totals.reduce((a, b) => a + b, 0)} {valueLabel} over {data.length} days. Use “Show table” for the daily values.
      </p>
    </figure>
  );
}

/** Calendar heatmap (weeks × weekdays), one-hue sequential steps. */
export function Heatmap({ data, label }: { data: { date: string; attempts: number }[]; label: string }) {
  const [hover, setHover] = useState<{ date: string; attempts: number } | null>(null);
  const max = Math.max(1, ...data.map((d) => d.attempts));
  const step = (n: number) => (n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4)));
  // Pad so the first column starts on Monday.
  const first = new Date(`${data[0]?.date ?? '2026-01-01'}T00:00:00Z`).getUTCDay();
  const pad = (first + 6) % 7;
  const cells = [...Array(pad).fill(null), ...data];
  const weeks: ({ date: string; attempts: number } | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return (
    <figure className="min-w-0">
      <div className="overflow-x-auto pb-1">
        <div className="flex w-max gap-[3px]" role="img" aria-label={label} onMouseLeave={() => setHover(null)}>
          {weeks.map((w, wi) => (
            <div key={wi} className="flex flex-col gap-[3px]">
              {w.map((c, di) =>
                c ? (
                  <div
                    key={c.date}
                    onMouseEnter={() => setHover(c)}
                    className="size-[13px] rounded-[3px]"
                    style={{ background: `var(--heat-${step(c.attempts)})` }}
                    title={`${formatDate(c.date)}: ${c.attempts} attempts`}
                  />
                ) : (
                  <div key={`pad-${di}`} className="size-[13px]" />
                ),
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span className="min-h-4 tabular-nums" aria-live="polite">
          {hover ? `${formatDate(hover.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}: ${hover.attempts} attempts` : 'Hover a day for details'}
        </span>
        <span className="flex items-center gap-1">
          Less
          {[0, 1, 2, 3, 4].map((s) => (
            <span key={s} className="size-[11px] rounded-[3px]" style={{ background: `var(--heat-${s})` }} />
          ))}
          More
        </span>
      </div>
    </figure>
  );
}

/** Horizontal 100% bar for rating distributions; every segment is labelled in the legend. */
export function DistributionBar({ parts, total, label }: { parts: { key: string; label: string; value: number; color: string }[]; total: number; label: string }) {
  return (
    <div className="min-w-0">
      <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-full bg-surface-3" role="img" aria-label={`${label}: ${parts.map((p) => `${p.label} ${p.value}`).join(', ')} of ${total}`}>
        {total > 0 &&
          parts.map((p) =>
            p.value ? <div key={p.key} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} className="h-full first:rounded-l-full last:rounded-r-full" title={`${p.label}: ${p.value}`} /> : null,
          )}
      </div>
      <ul className="mt-2.5 grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
        {parts.map((p) => (
          <li key={p.key} className="flex items-center gap-2">
            <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: p.color }} aria-hidden />
            <span className="whitespace-nowrap text-text-2">{p.label}</span>
            <span className="ml-auto font-medium whitespace-nowrap tabular-nums">
              {p.value}
              <span className="ml-1 font-normal text-muted">{total ? `${Math.round((p.value / total) * 100)}%` : ''}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
