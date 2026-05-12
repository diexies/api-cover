import { useEffect, useState } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'apicover.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

function readSystem(): ResolvedTheme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

function readStoredChoice(): ThemeChoice {
  if (typeof window === 'undefined') return 'system';
  const v = window.localStorage?.getItem(STORAGE_KEY);
  if (v === 'light' || v === 'dark' || v === 'system') return v;
  return 'system';
}

/**
 * Reactive theme hook. Persists user override to localStorage; falls back to system preference
 * via prefers-color-scheme and updates live when the OS preference flips.
 *
 * Side effect: writes <html data-theme="..."> so CSS rules can target either explicit theme or
 * legacy @media prefers-color-scheme (now we treat data-theme as the source of truth).
 */
export function useTheme() {
  const [choice, setChoiceState] = useState<ThemeChoice>(readStoredChoice);
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(readSystem);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(DARK_QUERY);
    const handler = (e: MediaQueryListEvent) => setSystemTheme(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const resolved: ResolvedTheme = choice === 'system' ? systemTheme : choice;

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolved);
  }, [resolved]);

  const setChoice = (c: ThemeChoice) => {
    setChoiceState(c);
    try { window.localStorage?.setItem(STORAGE_KEY, c); } catch { /* storage disabled */ }
  };

  return { choice, setChoice, resolved };
}
