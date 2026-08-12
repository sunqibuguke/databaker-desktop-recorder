import { promises as fs } from 'node:fs';
import path from 'node:path';

export const APP_LOCALES = ['zh-CN', 'en', 'th', 'ja', 'ko', 'es', 'pt'] as const;
export type AppLocale = (typeof APP_LOCALES)[number];
export const DEFAULT_APP_LOCALE: AppLocale = 'zh-CN';

export function normalizeAppLocale(value: unknown): AppLocale {
  if (typeof value === 'string' && (APP_LOCALES as readonly string[]).includes(value)) {
    return value as AppLocale;
  }
  return DEFAULT_APP_LOCALE;
}

export class AppLocaleRepository {
  constructor(private readonly filePath: string) {}

  async load(): Promise<AppLocale> {
    try {
      const serialized = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(serialized) as { locale?: unknown };
      return normalizeAppLocale(parsed?.locale);
    } catch {
      return DEFAULT_APP_LOCALE;
    }
  }

  async save(locale: unknown): Promise<AppLocale> {
    const normalized = normalizeAppLocale(locale);
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(temporaryPath, `${JSON.stringify({ locale: normalized }, null, 2)}\n`, 'utf8');
    await fs.rename(temporaryPath, this.filePath);
    return normalized;
  }
}
