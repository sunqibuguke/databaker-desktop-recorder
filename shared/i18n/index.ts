import en from './catalogs/en.ts';
import es from './catalogs/es.ts';
import ja from './catalogs/ja.ts';
import ko from './catalogs/ko.ts';
import pt from './catalogs/pt.ts';
import th from './catalogs/th.ts';
import zhCN from './catalogs/zh-CN.ts';
import {
  APP_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_NATIVE_NAMES,
  normalizeLocale,
  type AppLocale,
} from './locale.ts';
import type { MessageTree } from './types.ts';

export {
  APP_LOCALES,
  DEFAULT_LOCALE,
  LOCALE_NATIVE_NAMES,
  isAppLocale,
  normalizeLocale,
  type AppLocale,
} from './locale.ts';
export type { MessageTree } from './types.ts';

export const catalogs: Record<AppLocale, MessageTree> = {
  'zh-CN': zhCN,
  en,
  th,
  ja,
  ko,
  es,
  pt,
};

export type MessageKey = string;

type Nested = { [key: string]: string | Nested };

function lookup(tree: Nested, path: string): string | undefined {
  let current: string | Nested | undefined = tree;
  for (const part of path.split('.')) {
    if (!current || typeof current === 'string') return undefined;
    current = current[part];
  }
  return typeof current === 'string' ? current : undefined;
}

export function flattenKeys(tree: Nested, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [name, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${name}` : name;
    if (typeof value === 'string') keys.push(path);
    else keys.push(...flattenKeys(value, path));
  }
  return keys;
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (match, name: string) => (
    params[name] === undefined ? match : String(params[name])
  ));
}

let currentLocale: AppLocale = DEFAULT_LOCALE;
const listeners = new Set<() => void>();

export function getLocale(): AppLocale {
  return currentLocale;
}

export function setLocale(locale: unknown): AppLocale {
  const next = normalizeLocale(locale);
  if (next === currentLocale) return currentLocale;
  currentLocale = next;
  if (typeof document !== 'undefined') document.documentElement.lang = next;
  for (const listener of listeners) listener();
  return currentLocale;
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function t(key: string, params?: Record<string, string | number>): string {
  const localized = lookup(catalogs[currentLocale] as Nested, key);
  const fallback = lookup(catalogs[DEFAULT_LOCALE] as Nested, key);
  return interpolate(localized ?? fallback ?? key, params);
}
