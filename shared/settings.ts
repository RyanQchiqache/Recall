import { isValidTimeZone } from './dates.ts';
import { clampMaxAttempts, DEFAULT_MAX_ATTEMPTS } from './queue.ts';
import { DEFAULT_SCHEDULER_SETTINGS, normalizeSchedulerSettings, type SchedulerSettings } from './scheduler.ts';

export type ThemePreference = 'system' | 'light' | 'dark';

export interface BackupSettings {
  enabled: boolean;
  /** Absolute directory for automatic snapshots. `null` = `<data dir>/backups`. */
  directory: string | null;
  retention: number;
  intervalHours: number;
}

export interface AppSettings {
  appName: string;
  theme: ThemePreference;
  timeZone: string;
  scheduler: SchedulerSettings;
  defaultSessionSize: number;
  defaultMaxAttempts: number;
  includeNewByDefault: boolean;
  currentSemesterId: string | null;
  showStreak: boolean;
  showHeatmap: boolean;
  ratingIntroSeen: boolean;
  backup: BackupSettings;
}

export const DEFAULT_SETTINGS: AppSettings = {
  appName: 'Recall',
  theme: 'system',
  timeZone: 'Europe/Berlin',
  scheduler: DEFAULT_SCHEDULER_SETTINGS,
  defaultSessionSize: 30,
  defaultMaxAttempts: DEFAULT_MAX_ATTEMPTS,
  includeNewByDefault: true,
  currentSemesterId: null,
  showStreak: true,
  showHeatmap: true,
  ratingIntroSeen: false,
  backup: { enabled: true, directory: null, retention: 10, intervalHours: 24 },
};

export const SESSION_SIZE_PRESETS = [10, 20, 30, 40, 50] as const;
export const MAX_SESSION_SIZE = 1000;

function clampInt(v: unknown, min: number, max: number, def: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

/** Merge a partial, possibly invalid settings object onto defaults. */
export function normalizeSettings(input: unknown): AppSettings {
  const s = (input && typeof input === 'object' ? input : {}) as Partial<AppSettings>;
  const d = DEFAULT_SETTINGS;
  const b = (s.backup ?? {}) as Partial<BackupSettings>;
  const name = typeof s.appName === 'string' ? s.appName.trim().slice(0, 40) : '';
  return {
    appName: name || d.appName,
    theme: s.theme === 'light' || s.theme === 'dark' || s.theme === 'system' ? s.theme : d.theme,
    timeZone: typeof s.timeZone === 'string' && isValidTimeZone(s.timeZone) ? s.timeZone : d.timeZone,
    scheduler: normalizeSchedulerSettings(s.scheduler ?? d.scheduler),
    defaultSessionSize: clampInt(s.defaultSessionSize, 1, MAX_SESSION_SIZE, d.defaultSessionSize),
    defaultMaxAttempts: clampMaxAttempts(s.defaultMaxAttempts ?? d.defaultMaxAttempts),
    includeNewByDefault: typeof s.includeNewByDefault === 'boolean' ? s.includeNewByDefault : d.includeNewByDefault,
    currentSemesterId: typeof s.currentSemesterId === 'string' ? s.currentSemesterId : null,
    showStreak: typeof s.showStreak === 'boolean' ? s.showStreak : d.showStreak,
    showHeatmap: typeof s.showHeatmap === 'boolean' ? s.showHeatmap : d.showHeatmap,
    ratingIntroSeen: typeof s.ratingIntroSeen === 'boolean' ? s.ratingIntroSeen : d.ratingIntroSeen,
    backup: {
      enabled: typeof b.enabled === 'boolean' ? b.enabled : d.backup.enabled,
      directory: typeof b.directory === 'string' && b.directory.trim() ? b.directory.trim() : null,
      retention: clampInt(b.retention, 1, 200, d.backup.retention),
      intervalHours: clampInt(b.intervalHours, 1, 24 * 30, d.backup.intervalHours),
    },
  };
}
