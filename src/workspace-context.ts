import type { IssueFilter } from './p1-workflow';

export type WorkspacePanel = 'monitor' | 'detection' | 'task' | 'export' | 'issues';

export type WorkspaceContext = {
  sessionId: string;
  currentItemId: string | null;
  issueFilter: IssueFilter;
  panel: WorkspacePanel;
  updatedAt: number;
};

type ContextStore = { version: 1; entries: WorkspaceContext[] };
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const WORKSPACE_CONTEXT_KEY = 'databaker-workspace-context-v1';
export const MAX_WORKSPACE_CONTEXTS = 100;

function safeParse(storage: StorageLike): ContextStore {
  try {
    const parsed = JSON.parse(storage.getItem(WORKSPACE_CONTEXT_KEY) ?? '') as Partial<ContextStore>;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return { version: 1, entries: [] };
    const valid = parsed.entries.filter((entry): entry is WorkspaceContext => (
        Boolean(entry)
        && typeof entry.sessionId === 'string'
        && entry.sessionId.trim().length > 0
        && (entry.currentItemId === null || typeof entry.currentItemId === 'string')
        && typeof entry.updatedAt === 'number'
        && Number.isFinite(entry.updatedAt)
        && entry.updatedAt >= 0
        && ['all', 'blocker', 'warning'].includes(entry.issueFilter)
        && ['monitor', 'detection', 'task', 'export', 'issues'].includes(entry.panel)
      ))
      .sort((left, right) => right.updatedAt - left.updatedAt);
    const sessionIds = new Set<string>();
    const entries = valid.filter((entry) => {
      if (sessionIds.has(entry.sessionId)) return false;
      sessionIds.add(entry.sessionId);
      return true;
    }).slice(0, MAX_WORKSPACE_CONTEXTS);
    return { version: 1, entries };
  } catch {
    return { version: 1, entries: [] };
  }
}

export function loadWorkspaceContext(
  sessionId: string,
  storage: StorageLike = window.localStorage,
): WorkspaceContext | null {
  if (!sessionId) return null;
  return safeParse(storage).entries.find((entry) => entry.sessionId === sessionId) ?? null;
}

export function saveWorkspaceContext(
  context: Omit<WorkspaceContext, 'updatedAt'> & { updatedAt?: number },
  storage: StorageLike = window.localStorage,
): WorkspaceContext {
  const saved: WorkspaceContext = { ...context, updatedAt: context.updatedAt ?? Date.now() };
  const entries = safeParse(storage).entries
    .filter((entry) => entry.sessionId !== saved.sessionId)
    .concat(saved)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_WORKSPACE_CONTEXTS);
  storage.setItem(WORKSPACE_CONTEXT_KEY, JSON.stringify({ version: 1, entries } satisfies ContextStore));
  return saved;
}

export function removeWorkspaceContext(
  sessionId: string,
  storage: StorageLike = window.localStorage,
): void {
  const entries = safeParse(storage).entries.filter((entry) => entry.sessionId !== sessionId);
  if (entries.length === 0) storage.removeItem(WORKSPACE_CONTEXT_KEY);
  else storage.setItem(WORKSPACE_CONTEXT_KEY, JSON.stringify({ version: 1, entries } satisfies ContextStore));
}
