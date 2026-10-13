import { diffDays, type LocalDate } from '../../shared/dates.ts';

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export function formatDate(d: LocalDate | null | undefined, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }): string {
  if (!d) return '';
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day)).toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });
}

export function formatDateTime(iso: string | null | undefined, timeZone?: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone });
}

/** "today", "tomorrow", "in 5 days", "3 days ago". */
export function relativeDay(d: LocalDate, today: LocalDate): string {
  const n = diffDays(today, d);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  if (n > 1) return n < 60 ? `in ${n} days` : `on ${formatDate(d)}`;
  return `${-n} days ago`;
}

export function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60000);
  if (ms > 0 && totalMin === 0) return '< 1 min';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function percent(part: number, whole: number): string {
  if (whole === 0) return '—';
  return `${Math.round((part / whole) * 100)}%`;
}

/** Plain-text preview of Markdown for compact lists. */
export function mdPreview(md: string, max = 180): string {
  const text = md
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' [equation] ')
    .replace(/\$([^$\n]+)\$/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt: string) => (alt ? ` [image: ${alt}] ` : ' [image] '))
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function greeting(now = new Date()): string {
  const h = now.getHours();
  if (h < 5) return 'Good evening';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}
