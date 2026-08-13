import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import {
  APP_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_NATIVE_NAMES,
  getLocale,
  normalizeLocale,
  setLocale,
  subscribeLocale,
  t,
  type AppLocale,
} from '../shared/i18n/index.ts';

type I18nContextValue = {
  locale: AppLocale;
  t: typeof t;
  setLocale: (locale: AppLocale) => Promise<void>;
};

const I18nContext = createContext<I18nContextValue>({
  locale: DEFAULT_LOCALE,
  t,
  setLocale: async (locale) => {
    setLocale(locale);
  },
});

async function persistLocale(locale: AppLocale): Promise<AppLocale> {
  if (typeof window === 'undefined' || !window.recorder.getLocale) {
    return setLocale(locale);
  }
  if (window.recorder.setLocale) {
    const next = normalizeLocale(await window.recorder.setLocale(locale));
    setLocale(next);
    return next;
  }
  return setLocale(locale);
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const locale = useSyncExternalStore(subscribeLocale, getLocale, getLocale);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stored = await window.recorder.getLocale?.();
        if (!cancelled && stored) setLocale(stored);
      } catch {
        if (!cancelled) setLocale(DEFAULT_LOCALE);
      }
    })();
    const unsubscribe = window.recorder.onLocaleChanged?.((next) => {
      setLocale(next);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    const prompter = new URLSearchParams(window.location.search).get('view') === 'prompter';
    document.title = prompter ? t('chrome.prompterWindowTitle') : t('chrome.windowTitle');
  }, [locale]);

  const changeLocale = useCallback(async (next: AppLocale) => {
    await persistLocale(next);
  }, []);

  const value = useMemo<I18nContextValue>(() => ({
    locale,
    t,
    setLocale: changeLocale,
  }), [changeLocale, locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

export { APP_LOCALES, LOCALE_NATIVE_NAMES, getLocale, t };
export type { AppLocale };
