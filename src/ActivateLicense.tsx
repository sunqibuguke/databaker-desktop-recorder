import { useEffect, useRef, useState, type ReactNode } from 'react';
import appLogo from '../assets/brand/databaker-recorder-logo.png';
import { Icon } from './studio-chrome';
import { APP_LOCALES, LOCALE_NATIVE_NAMES, t, useI18n } from './i18n';
import type { LicenseReason, LicenseStatus, PendingLicenseSeal } from './types';

function reasonTitle(reason: LicenseReason | null): string {
  switch (reason) {
    case 'state_invalid': return t('license.titleState');
    case 'expired': return t('license.titleExpired');
    case 'wrong_machine': return t('license.titleWrongMachine');
    case 'clock_rollback': return t('license.titleClock');
    case 'fingerprint_unavailable': return t('license.titleUnavailable');
    default: return t('license.title');
  }
}

function activateErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/本地授权记录|安全存储|state_invalid/.test(message)) return t('license.errorState');
  if (/已过期|expired/.test(message)) return t('license.errorExpired');
  if (/不匹配|wrong_machine/.test(message)) return t('license.errorMachine');
  if (/时间|clock/.test(message)) return t('license.errorClock');
  if (/无法识别|fingerprint/.test(message)) return t('license.errorUnavailable');
  if (/不受支持|unknown_kid/.test(message)) return t('license.errorKid');
  if (/格式|malformed/.test(message)) return t('license.errorMalformed');
  if (/无效|bad_signature/.test(message)) return t('license.errorSignature');
  return message || t('license.errorSignature');
}

export function LicenseGate({ children }: { children: (license: LicenseStatus) => ReactNode }) {
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const lastValid = useRef<LicenseStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const apply = (next: LicenseStatus) => {
      if (!cancelled) setStatus((current) => (current?.transitionRevision ?? -1) > (next.transitionRevision ?? -1) ? current : next);
    };
    if (!window.recorder.getLicenseStatus) {
      apply({
        state: 'valid',
        reason: null,
        machineCode: 'PREV-VIEW-ONLY',
        licensee: 'preview',
        expiresAt: null,
        daysRemaining: null,
        issuedAt: null,
        kid: 'preview',
      });
      return () => {
        cancelled = true;
      };
    }
    void window.recorder.getLicenseStatus().then(apply, () => apply({
      state: 'invalid',
      reason: 'unlicensed',
      machineCode: '',
      licensee: null,
      expiresAt: null,
      daysRemaining: null,
      issuedAt: null,
      kid: null,
    }));
    const stop = window.recorder.onLicenseChanged?.(apply);
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  useEffect(() => {
    if (!status?.captureStopPending) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const retryButton = document.querySelector<HTMLButtonElement>('.license-transition button');
    retryButton?.focus();
    const blockShortcuts = (event: KeyboardEvent) => {
      if (event.key === 'Tab') { event.preventDefault(); event.stopImmediatePropagation(); retryButton?.focus(); return; }
      if ((event.target as Element | null)?.closest('.license-transition')) return;
      event.preventDefault(); event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', blockShortcuts, true);
    return () => { window.removeEventListener('keydown', blockShortcuts, true); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [status?.captureStopPending]);

  if (!status) {
    return <div className="license-gate license-gate-loading" data-testid="license-loading" />;
  }
  if (status.state === 'valid') lastValid.current = status;
  if (status.captureStopPending) {
    return <>{lastValid.current && children(lastValid.current)}<div className="license-transition" onKeyDown={(event) => event.stopPropagation()} role="alertdialog" aria-modal="true" aria-label={t('license.sealing')}>
      <div><strong>{t('license.sealing')}</strong><p>{status.captureStopError || t('license.sealingDetail')}</p>
        <button className="button" onClick={() => void window.recorder.getLicenseStatus?.().then((next) => setStatus((current) => (current?.transitionRevision ?? -1) > (next.transitionRevision ?? -1) ? current : next)).catch(() => undefined)}>{t('license.retrySeal')}</button>
      </div>
    </div></>;
  }
  if (status.state !== 'valid') {
    return <ActivateLicense status={status} onActivated={setStatus} />;
  }
  return <>{children(status)}</>;
}

export function ActivateLicense({
  status,
  onActivated,
}: {
  status: LicenseStatus;
  onActivated: (status: LicenseStatus) => void;
}) {
  const { locale, setLocale } = useI18n();
  const [ticket, setTicket] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<PendingLicenseSeal[]>([]);
  const [sealing, setSealing] = useState('');

  useEffect(() => {
    if (!window.recorder.listPendingLicenseSeals) return;
    void window.recorder.listPendingLicenseSeals()
      .then((result) => { setPending(result.recordings ?? []); if (result.warning) setError(result.warning); })
      .catch((error) => { setPending([]); setError(error instanceof Error ? error.message : String(error)); });
  }, []);

  async function copyMachineCode() {
    if (!status.machineCode) return;
    try {
      await navigator.clipboard.writeText(status.machineCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setError(t('license.copyFailed'));
    }
  }

  async function activate() {
    if (!window.recorder.activateLicense || busy) return;
    setBusy(true);
    setError('');
    try {
      const next = await window.recorder.activateLicense(ticket);
      onActivated(next);
    } catch (caught) {
      setError(activateErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  }

  async function sealPending(recording: PendingLicenseSeal) {
    if (!window.recorder.emergencySealRecording || sealing) return;
    setSealing(recording.session_id);
    setError('');
    try {
      await window.recorder.emergencySealRecording(recording.session_dir, recording.session_id);
      setPending((current) => current.filter((item) => item.session_dir !== recording.session_dir));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSealing('');
    }
  }

  return <div className="license-gate" data-testid="license-gate">
    <header className="home-header">
      <a className="skip-link" href="#main">{t('chrome.skipToContent')}</a>
      <div className="home-brand">
        <span className="home-brand-mark"><img src={appLogo} alt={t('chrome.productName')} /></span>
        <div>
          <strong>{t('chrome.productName')}</strong>
          <small>{t('chrome.appSubtitle')}</small>
        </div>
      </div>
      <select
        className="settings-locale license-locale"
        aria-label={t('settings.language')}
        value={locale}
        onChange={(event) => void setLocale(event.target.value as typeof locale)}
      >
        {APP_LOCALES.map((code) => (
          <option key={code} value={code}>{LOCALE_NATIVE_NAMES[code]}</option>
        ))}
      </select>
    </header>
    <main id="main" className="license-stage">
      <section className="license-card" aria-labelledby="license-title">
        <h1 id="license-title">{reasonTitle(status.reason)}</h1>
        <p>{t(status.reason === 'state_invalid' ? 'license.errorState' : 'license.body')}</p>
        <label className="license-machine">
          <span>{t('license.machineCode')}</span>
          <div>
            <code data-testid="license-machine-code">{status.machineCode || t('license.machineUnavailable')}</code>
            <button
              className="button"
              type="button"
              disabled={!status.machineCode}
              onClick={() => void copyMachineCode()}
            >
              <Icon name="copy" size={14} />
              {copied ? t('license.copied') : t('license.copy')}
            </button>
          </div>
        </label>
        <label className="license-ticket">
          <span>{t('license.ticketLabel')}</span>
          <textarea
            data-testid="license-ticket"
            rows={4}
            value={ticket}
            placeholder={t('license.ticketPlaceholder')}
            onChange={(event) => setTicket(event.target.value)}
          />
        </label>
        {error && <div className="dialog-warning danger">{error}</div>}
        <button
          className="button primary"
          type="button"
          data-testid="license-activate"
          disabled={busy || !ticket.trim() || !status.machineCode}
          onClick={() => void activate()}
        >
          {busy ? t('license.activating') : t('license.activate')}
        </button>
        {pending.length > 0 && <section className="license-pending">
          <strong>{t('license.pendingSealTitle')}</strong>
          <p>{t('license.pendingSealBody')}</p>
          {pending.map((recording) => (
            <div key={recording.session_dir}>
              <code>{recording.session_id}</code>
              <button
                className="button"
                type="button"
                disabled={Boolean(sealing)}
                onClick={() => void sealPending(recording)}
              >
                {sealing === recording.session_id ? t('license.pendingSealWorking') : t('license.pendingSealAction')}
              </button>
            </div>
          ))}
        </section>}
      </section>
    </main>
  </div>;
}

export function licenseSummary(status: LicenseStatus): string {
  if (status.expiresAt === null) return t('settings.licensePerpetual');
  const date = new Date((status.expiresAt - 1) * 1_000).toISOString().slice(0, 10);
  if (status.daysRemaining !== null && status.daysRemaining <= 7) {
    return t('settings.licenseDays', { days: String(status.daysRemaining), date });
  }
  return t('settings.licenseExpires', { date });
}
