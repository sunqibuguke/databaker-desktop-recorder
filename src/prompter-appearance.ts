export const PROMPTER_APPEARANCE_KEY = 'databaker-prompter-appearance';
export const DEFAULT_PROMPTER_FONT_SIZE = 36;
export const MIN_PROMPTER_FONT_SIZE = 22;
export const MAX_PROMPTER_FONT_SIZE = 72;
export const DEFAULT_PROMPTER_LIVE_COLOR = '#3dcc7a';
export const PROMPTER_LIVE_COLOR_PRESETS = ['#3dcc7a', '#f3f4f3', '#f4d35e', '#5ec8f4', '#ff8a4c'] as const;

export type PrompterAppearance = {
  fontSize: number;
  liveColor: string;
};

export type AppearanceStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

const HEX_COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function defaultPrompterAppearance(): PrompterAppearance {
  return {
    fontSize: DEFAULT_PROMPTER_FONT_SIZE,
    liveColor: DEFAULT_PROMPTER_LIVE_COLOR,
  };
}

export function normalizePrompterFontSize(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_PROMPTER_FONT_SIZE;
  return Math.min(MAX_PROMPTER_FONT_SIZE, Math.max(MIN_PROMPTER_FONT_SIZE, Math.round(numeric)));
}

export function normalizePrompterLiveColor(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_PROMPTER_LIVE_COLOR;
  const trimmed = value.trim();
  if (!HEX_COLOR.test(trimmed)) return DEFAULT_PROMPTER_LIVE_COLOR;
  const hex = trimmed.toLowerCase();
  if (hex.length === 4) {
    return `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  }
  return hex;
}

export function parsePrompterAppearance(raw: unknown): PrompterAppearance {
  const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return {
    fontSize: normalizePrompterFontSize(source.fontSize),
    liveColor: normalizePrompterLiveColor(source.liveColor),
  };
}

export function loadPrompterAppearance(storage?: AppearanceStorage | null): PrompterAppearance {
  if (!storage) return defaultPrompterAppearance();
  try {
    const serialized = storage.getItem(PROMPTER_APPEARANCE_KEY);
    return serialized ? parsePrompterAppearance(JSON.parse(serialized)) : defaultPrompterAppearance();
  } catch {
    return defaultPrompterAppearance();
  }
}

export function savePrompterAppearance(
  appearance: PrompterAppearance,
  storage?: AppearanceStorage | null,
): PrompterAppearance {
  const next = parsePrompterAppearance(appearance);
  if (!storage) return next;
  try {
    storage.setItem(PROMPTER_APPEARANCE_KEY, JSON.stringify(next));
  } catch {
    // Quota or private-mode storage should not block the live preview.
  }
  return next;
}
