import { createContext, useContext, useEffect } from 'react';
import en from './locales/en';
import tr from './locales/tr';
import { usePrefs } from '../stores/prefs';

export type Locale = 'en' | 'tr';
export type Dict = Record<string, string>;

const dictionaries: Record<Locale, Dict> = { en, tr };

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
  const locale = usePrefs((s) => s.locale);
  const setLocaleInStore = usePrefs((s) => s.set);

  useEffect(() => {
    document.documentElement.setAttribute('lang', locale);
  }, [locale]);

  const setLocale = (l: Locale) => setLocaleInStore('locale', l);

  const t = (key: string, fallback?: string): string => {
    return dictionaries[locale][key] ?? dictionaries.en[key] ?? fallback ?? key;
  };

  return { locale, setLocale, t };
}
