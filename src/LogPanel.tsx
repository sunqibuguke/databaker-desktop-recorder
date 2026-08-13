import { useEffect, useMemo, useRef, useState } from 'react';
import { formatDebugLogText, type DebugLogEntry, type DebugLogSnapshot } from './debug-log';
import { useI18n } from './i18n';
import { Icon } from './studio-chrome';

type LevelFilter = 'all' | 'warn' | 'error';

const emptySnapshot: DebugLogSnapshot = {
  entries: [],
  dropped: 0,
  capacity: 2_000,
  bound_session_id: '',
  bound_session_dir: '',
  app_log_path: '',
  session_log_path: '',
};

function matchesFilter(entry: DebugLogEntry, filter: LevelFilter, query: string): boolean {
  if (filter === 'error' && entry.level !== 'error') return false;
  if (filter === 'warn' && entry.level !== 'warn' && entry.level !== 'error') return false;
  if (!query) return true;
  const haystack = [
    entry.ts,
    entry.level,
    entry.source,
    entry.category,
    entry.event,
    entry.message,
    entry.session_id ?? '',
    entry.data ? JSON.stringify(entry.data) : '',
  ].join(' ').toLowerCase();
  return haystack.includes(query);
}

function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function LogPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [snapshot, setSnapshot] = useState<DebugLogSnapshot>(emptySnapshot);
  const [filter, setFilter] = useState<LevelFilter>('all');
  const [query, setQuery] = useState('');
  const [copyState, setCopyState] = useState('');
  const [saveState, setSaveState] = useState('');
  const { t } = useI18n();
  const [follow, setFollow] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const copyTimerRef = useRef(0);

  useEffect(() => {
    if (!open) return undefined;
    let active = true;
    void window.recorder.getDebugLog?.().then((next) => {
      if (active && next) setSnapshot(next);
    }).catch(() => undefined);
    const unsubscribe = window.recorder.onDebugLog?.((entry) => {
      setSnapshot((current) => {
        const entries = [...current.entries, entry];
        const overflow = Math.max(0, entries.length - current.capacity);
        return {
          ...current,
          entries: overflow ? entries.slice(overflow) : entries,
          dropped: current.dropped + overflow,
          bound_session_id: entry.session_id || current.bound_session_id,
          bound_session_dir: entry.session_dir || current.bound_session_dir,
        };
      });
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open || !follow) return;
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [follow, open, snapshot.entries.length]);

  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return snapshot.entries.filter((entry) => matchesFilter(entry, filter, normalized));
  }, [filter, query, snapshot.entries]);

  if (!open) return null;

  const exported = formatDebugLogText(visible.length === snapshot.entries.length ? snapshot.entries : visible, {
    bound_session_id: snapshot.bound_session_id,
    bound_session_dir: snapshot.bound_session_dir,
  });
  const filename = `databaker-debug-${snapshot.bound_session_id || 'app'}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;

  async function copyLog() {
    try {
      await navigator.clipboard.writeText(exported);
      setCopyState(t('logs.copied'));
    } catch {
      setCopyState(t('logs.copyFailed'));
    }
    window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => setCopyState(''), 2_000);
  }

  async function saveLog() {
    setSaveState('');
    try {
      if (window.recorder.saveDebugLog) {
        const saved = await window.recorder.saveDebugLog(exported, filename);
        setSaveState(saved ? t('logs.savedTo', { path: saved }) : '');
        return;
      }
      downloadText(filename, exported);
      setSaveState(t('logs.downloadStarted'));
    } catch (error) {
      setSaveState(`${t('logs.saveFailedPrefix')}${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function onListScroll() {
    const node = listRef.current;
    if (!node) return;
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
    setFollow(nearBottom);
  }

  const scope = snapshot.bound_session_id
    ? t('logs.taskScope', { id: snapshot.bound_session_id })
    : t('logs.appScope');

  return <div className="dialog-backdrop log-panel-backdrop" role="presentation">
    <section className="studio-dialog log-panel-dialog" role="dialog" aria-modal="true" aria-labelledby="log-panel-title">
      <header>
        <span className="dialog-icon"><Icon name="log" size={19} /></span>
        <div>
          <h2 id="log-panel-title">{t('logs.title')}</h2>
        </div>
      </header>
      <div className="log-panel-toolbar">
        <p>
          {scope}
          <span>{snapshot.entries.length}/{snapshot.capacity}{snapshot.dropped ? t('logs.dropped', { count: snapshot.dropped }) : ''}</span>
        </p>
        <div className="log-panel-filters" role="tablist" aria-label={t('logs.levelsAria')}>
          {([['all', t('logs.filterAll')], ['warn', t('logs.filterWarn')], ['error', t('logs.filterError')]] as const).map(([id, label]) => (
            <button key={id} className={filter === id ? 'active' : ''} onClick={() => setFilter(id)}>{label}</button>
          ))}
        </div>
        <input
          data-testid="debug-log-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('logs.searchPlaceholder')}
          aria-label={t('logs.searchAria')}
        />
      </div>
      <div
        ref={listRef}
        className="log-panel-list"
        data-testid="debug-log-list"
        onScroll={onListScroll}
      >
        {!visible.length && <div className="log-panel-empty">{t('logs.empty')}</div>}
        {visible.map((entry) => (
          <article key={entry.seq} className={`log-line level-${entry.level}`} data-level={entry.level}>
            <time>{entry.ts.slice(11, 23)}</time>
            <em>{entry.level}</em>
            <span>{entry.source}/{entry.category}</span>
            <strong>{entry.event}</strong>
            <p>{entry.message}</p>
            {entry.data && <code>{JSON.stringify(entry.data)}</code>}
          </article>
        ))}
      </div>
      <footer>
        <small className="log-panel-status">{copyState || saveState || (follow ? t('logs.following') : t('logs.paused'))}</small>
        <button className="button" onClick={() => void copyLog()} data-testid="debug-log-copy">
          <Icon name="copy" size={14} />{t('logs.copy')}
        </button>
        <button className="button" onClick={() => void saveLog()} data-testid="debug-log-download">
          <Icon name="export" size={14} />{t('logs.download')}
        </button>
        <button className="button primary" onClick={onClose}>{t('common.close')}</button>
      </footer>
    </section>
  </div>;
}
