import { useEffect, useState, type ReactNode } from 'react';
import appLogo from '../assets/brand/databaker-recorder-logo.png';
import { Icon } from './studio-chrome';
import { APP_LOCALES, LOCALE_NATIVE_NAMES, t, useI18n } from './i18n';
import type { LicenseReason, LicenseStatus, PendingLicenseSeal } from './types';

function reasonTitle(reason: LicenseReason | null): string {
  switch (reason) {
    case 'expired': return t('license.titleExpired');
    case 'wrong_machine': return t('license.titleWrongMachine');
    case 'clock_rollback': return t('license.titleClock');
    case 'fingerprint_unavailable': return t('license.titleUnavailable');
    default: return t('license.title');
  }
}

function activateErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
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

  useEffect(() => {
    let cancelled = false;
    const apply = (next: LicenseStatus) => {
      if (!cancelled) setStatus(next);
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

  if (!status) {
    return <div className="license-gate license-gate-loading" data-testid="license-loading" />;
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
      .then((result) => setPending(result.recordings ?? []))
      .catch(() => setPending([]));
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
      <div className="home-brand">
        <span className="home-brand-mark"><img src={appLogo} alt="DataBaker" /></span>
        <div>
          <strong>DataBaker Recorder</strong>
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
    <main className="license-card">
      <small>{t('license.eyebrow')}</small>
      <h1>{reasonTitle(status.reason)}</h1>
      <p>{t('license.body')}</p>
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
          rows={5}
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
    </main>
  </div>;
}

export function licenseSummary(status: LicenseStatus): string {
  if (status.expiresAt === null) return t('settings.licensePerpetual');
  const date = new Date(status.expiresAt * 1_000).toISOString().slice(0, 10);
  if (status.daysRemaining !== null && status.daysRemaining <= 7) {
    return t('settings.licenseDays', { days: String(status.daysRemaining), date });
  }
  return t('settings.licenseExpires', { date });
}
