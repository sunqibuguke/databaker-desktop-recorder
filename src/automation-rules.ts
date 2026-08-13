export type AutomationRules = {
  autoStartNext: boolean;
  headTailSilence: boolean;
  discardEmpty: boolean;
  envCheck: boolean;
  almostSilent: boolean;
  peakHigh: boolean;
};

export const DEFAULT_AUTOMATION_RULES: AutomationRules = {
  autoStartNext: true,
  headTailSilence: true,
  discardEmpty: true,
  envCheck: true,
  almostSilent: false,
  peakHigh: false,
};

const RULES_STORAGE_PREFIX = 'databaker:automation-rules:';
const POST_TAKE_STORAGE_PREFIX = 'databaker:post-take-silence:';

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function normalizeAutomationRules(value: unknown): AutomationRules {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    autoStartNext: asBoolean(source.autoStartNext, DEFAULT_AUTOMATION_RULES.autoStartNext),
    headTailSilence: asBoolean(source.headTailSilence, DEFAULT_AUTOMATION_RULES.headTailSilence),
    discardEmpty: asBoolean(source.discardEmpty, DEFAULT_AUTOMATION_RULES.discardEmpty),
    envCheck: asBoolean(source.envCheck, DEFAULT_AUTOMATION_RULES.envCheck),
    almostSilent: asBoolean(source.almostSilent, DEFAULT_AUTOMATION_RULES.almostSilent),
    peakHigh: asBoolean(source.peakHigh, DEFAULT_AUTOMATION_RULES.peakHigh),
  };
}

export function showsPostTakeQualityBill(rules: AutomationRules): boolean {
  return rules.headTailSilence || rules.almostSilent || rules.peakHigh;
}

function readLegacyHeadTailSilence(sessionDir: string): boolean | null {
  if (!sessionDir) return null;
  try {
    const stored = localStorage.getItem(`${POST_TAKE_STORAGE_PREFIX}${sessionDir}`);
    if (stored === '0') return false;
    if (stored === '1') return true;
  } catch {
    return null;
  }
  return null;
}

export function loadAutomationRules(sessionDir: string): AutomationRules {
  if (!sessionDir) return { ...DEFAULT_AUTOMATION_RULES };
  try {
    const stored = localStorage.getItem(`${RULES_STORAGE_PREFIX}${sessionDir}`);
    if (stored) return normalizeAutomationRules(JSON.parse(stored));
  } catch {
    // Fall through to the previous single-toggle key, then defaults.
  }
  const legacyHeadTail = readLegacyHeadTailSilence(sessionDir);
  if (legacyHeadTail === null) return { ...DEFAULT_AUTOMATION_RULES };
  return { ...DEFAULT_AUTOMATION_RULES, headTailSilence: legacyHeadTail };
}

export function saveAutomationRules(sessionDir: string, rules: AutomationRules): void {
  if (!sessionDir) return;
  const normalized = normalizeAutomationRules(rules);
  try {
    localStorage.setItem(`${RULES_STORAGE_PREFIX}${sessionDir}`, JSON.stringify(normalized));
    localStorage.setItem(
      `${POST_TAKE_STORAGE_PREFIX}${sessionDir}`,
      normalized.headTailSilence ? '1' : '0',
    );
  } catch {
    // Preference is workstation-local; a blocked store must not stop capture.
  }
}
