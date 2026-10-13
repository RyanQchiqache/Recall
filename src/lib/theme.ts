import { useSyncExternalStore } from 'react';
import type { AppSettings, ThemePreference } from '../../shared/settings.ts';
import { api } from './api.ts';
import { queryClient } from './queries.ts';

const KEY = 'recall.theme';
const darkQuery = () => window.matchMedia('(prefers-color-scheme: dark)');

export function resolvesToDark(pref: ThemePreference | string): boolean {
  return pref === 'dark' || (pref === 'system' && darkQuery().matches);
}

/**
 * Switch the theme in the same frame. Colour transitions are suspended for that frame,
 * otherwise every element fades separately and the switch feels sluggish.
 */
export function applyTheme(pref: ThemePreference | string) {
  const root = document.documentElement;
  const dark = resolvesToDark(pref);
  if (root.classList.contains('dark') === dark) return;
  const style = document.createElement('style');
  style.textContent = '*,*::before,*::after{transition:none!important}';
  document.head.appendChild(style);
  root.classList.toggle('dark', dark);
  void window.getComputedStyle(root).color; // flush styles before transitions come back
  requestAnimationFrame(() => style.remove());
}

export function cachedPreference(): ThemePreference {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function rememberPreference(pref: ThemePreference) {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* disposable preference only */
  }
}

/** Change the theme immediately and persist it in the background; rolls back if saving fails. */
export function setThemePreference(pref: ThemePreference) {
  const previous = queryClient.getQueryData<AppSettings>(['settings'])?.theme ?? cachedPreference();
  applyTheme(pref);
  rememberPreference(pref);
  queryClient.setQueryData<AppSettings>(['settings'], (old) => (old ? { ...old, theme: pref } : old));
  api.patch('/api/settings', { theme: pref }).catch(() => {
    applyTheme(previous);
    rememberPreference(previous);
    queryClient.setQueryData<AppSettings>(['settings'], (old) => (old ? { ...old, theme: previous } : old));
  });
}

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

/** Whether dark mode is currently showing; re-renders the instant it changes. */
export function useIsDark(): boolean {
  return useSyncExternalStore(subscribe, () => document.documentElement.classList.contains('dark'));
}
