export const APP_LOCALES = ['zh-CN', 'en', 'th', 'ja', 'ko', 'es', 'pt'] as const;

export type AppLocale = (typeof APP_LOCALES)[number];

export const DEFAULT_LOCALE: AppLocale = 'zh-CN';

export const LOCALE_NATIVE_NAMES: Record<AppLocale, string> = {
  'zh-CN': '中文',
  en: 'English',
  th: 'ไทย',
  ja: '日本語',
  ko: '한국어',
  es: 'Español',
  pt: 'Português',
};

export function normalizeLocale(value: unknown): AppLocale {
  if (typeof value === 'string' && (APP_LOCALES as readonly string[]).includes(value)) {
    return value as AppLocale;
  }
  return DEFAULT_LOCALE;
}

export function isAppLocale(value: unknown): value is AppLocale {
  return typeof value === 'string' && (APP_LOCALES as readonly string[]).includes(value);
}
