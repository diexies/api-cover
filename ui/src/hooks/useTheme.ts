import { useEffect, useState } from 'react';
import { usePrefs } from '../stores/prefs';

export type ThemeChoice = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function readSystem(): ResolvedTheme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light';
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

/**
 * Reactive theme hook. Reads user override from the central prefs store; falls back to
 * system preference via prefers-color-scheme and updates live when the OS preference flips.
 *
 * Side effect: writes <html data-theme="..."> so CSS rules can target either explicit theme
 * or legacy @media prefers-color-scheme (now we treat data-theme as the source of truth).
 */
export function useTheme() {
  const choice = usePrefs((s) => s.theme);
  const setChoiceInStore = usePrefs((s) => s.set);
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

  const setChoice = (c: ThemeChoice) => setChoiceInStore('theme', c);

  return { choice, setChoice, resolved };
}
