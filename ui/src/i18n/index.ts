import { createContext, useContext, useEffect, useState } from 'react';
import en from './locales/en';
import tr from './locales/tr';

export type Locale = 'en' | 'tr';
export type Dict = Record<string, string>;

const dictionaries: Record<Locale, Dict> = { en, tr };

const STORAGE_KEY = 'apicover.locale';

function detectInitial(): Locale {
  if (typeof window === 'undefined') return 'en';
  const stored = window.localStorage?.getItem(STORAGE_KEY);
  if (stored === 'en' || stored === 'tr') return stored;
  const nav = window.navigator?.language?.toLowerCase() ?? '';
  if (nav.startsWith('tr')) return 'tr';
  return 'en';
}

export interface I18nContextValue {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string, fallback?: string) => string;
}

export const I18nContext = createContext<I18nContextValue>({
  locale: 'en',
  setLocale: () => {},
  t: (_key, fallback) => fallback ?? _key,
});

export function useI18n() {
  return useContext(I18nContext);
}

/** Hook-only state holder; wire up via <I18nContext.Provider> in main.tsx. */
export function useI18nState(): I18nContextValue {
  const [locale, setLocaleState] = useState<Locale>(detectInitial);

  useEffect(() => {
    document.documentElement.setAttribute('lang', locale);
  }, [locale]);

  const setLocale = (l: Locale) => {
    setLocaleState(l);
    try { window.localStorage?.setItem(STORAGE_KEY, l); } catch { /* storage disabled */ }
  };

  const t = (key: string, fallback?: string): string => {
    return dictionaries[locale][key] ?? dictionaries.en[key] ?? fallback ?? key;
  };

  return { locale, setLocale, t };
}
