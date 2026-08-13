import appLogo from '../assets/brand/databaker-recorder-logo.png';
import { useI18n } from './i18n';

export type Phase = 'home' | 'setup' | 'running';
export type EngineStatus = 'connecting' | 'ready' | 'offline';
export type IconName = 'check' | 'chevron-left' | 'chevron-right' | 'close' | 'copy' | 'export' | 'file' | 'folder' | 'history' | 'home' | 'headphones' | 'log' | 'meter' | 'microphone' | 'more' | 'pause' | 'play' | 'plus' | 'record' | 'refresh' | 'retake' | 'settings' | 'skip' | 'sliders' | 'stop' | 'trash';

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  switch (name) {
    case 'check': return <svg {...common}><path d="m5 12 4 4L19 6" /></svg>;
    case 'close': return <svg {...common}><path d="M6 6l12 12M18 6 6 18" /></svg>;
    case 'chevron-left': return <svg {...common}><path d="m15 18-6-6 6-6" /></svg>;
    case 'chevron-right': return <svg {...common}><path d="m9 18 6-6-6-6" /></svg>;
    case 'copy': return <svg {...common}><rect x="9" y="9" width="11" height="11" rx="1.5" /><path d="M5 15V5h10" /></svg>;
    case 'export': return <svg {...common}><path d="M12 3v12m0 0 4-4m-4 4-4-4" /><path d="M5 15v4h14v-4" /></svg>;
    case 'file': return <svg {...common}><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></svg>;
    case 'folder': return <svg {...common}><path d="M3 6h7l2 2h9v11H3z" /></svg>;
    case 'history': return <svg {...common}><path d="M4 5v5h5" /><path d="M5.2 16a8 8 0 1 0 .1-8.2L4 10" /><path d="M12 7v5l3 2" /></svg>;
    case 'log': return <svg {...common}><path d="M6 4h9l3 3v13H6z" /><path d="M9 11h6M9 15h6M9 7h3" /></svg>;
    case 'trash': return <svg {...common}><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="m6 7 1 13h10l1-13" /><path d="M10 11v5M14 11v5" /></svg>;
    case 'home': return <svg {...common}><path d="m3 11 9-8 9 8" /><path d="M5 10v10h14V10M9 20v-6h6v6" /></svg>;
    case 'headphones': return <svg {...common}><path d="M4 15v-3a8 8 0 0 1 16 0v3" /><path d="M4 14h4v7H5a1 1 0 0 1-1-1zm16 0h-4v7h3a1 1 0 0 0 1-1z" /></svg>;
    case 'meter': return <svg {...common}><path d="M4 18V9m5 9V5m6 13v-7m5 7V3" /></svg>;
    case 'microphone': return <svg {...common}><rect x="8" y="3" width="8" height="12" rx="4" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" /></svg>;
    case 'more': return <svg {...common}><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></svg>;
    case 'pause': return <svg {...common}><path d="M8 5v14M16 5v14" /></svg>;
    case 'play': return <svg {...common}><path d="m8 5 11 7-11 7z" /></svg>;
    case 'plus': return <svg {...common}><path d="M12 5v14M5 12h14" /></svg>;
    case 'record': return <svg {...common}><circle cx="12" cy="12" r="6" fill="currentColor" stroke="none" /></svg>;
    case 'refresh': return <svg {...common}><path d="M20 6v5h-5" /><path d="M18.5 15a7 7 0 1 1-.4-6.5L20 11" /></svg>;
    case 'retake': return <svg {...common}><path d="M3 7v5h5" /><path d="M5.5 16a8 8 0 1 0 .4-8.5L3 12" /></svg>;
    case 'settings': return <svg {...common}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H3v-4h.2a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6V3h4v.2a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1H21v4h-.2a1.7 1.7 0 0 0-1.4 1Z" /></svg>;
    case 'skip': return <svg {...common}><path d="m5 5 10 7L5 19zM19 5v14" /></svg>;
    case 'sliders': return <svg {...common}><path d="M4 6h7m4 0h5M11 3v6M4 18h5m4 0h7M9 15v6M4 12h11m4 0h1M15 9v6" /></svg>;
    case 'stop': return <svg {...common}><rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none" /></svg>;
  }
}

export function StudioChrome({ phase, title, onBack, onOpenSettings, backTitle, activityLabel }: { phase: Exclude<Phase, 'home'>; title: string; onBack?: () => void; onOpenSettings: () => void; backTitle?: string; activityLabel?: string }) {
  const { t } = useI18n();
  const resolvedBackTitle = backTitle ?? t('chrome.backToTasks');
  return <header className="workflow-header">
    <div className="workflow-identity"><span><img src={appLogo} alt={t('chrome.productName')} /></span>{onBack && <button title={resolvedBackTitle} aria-label={resolvedBackTitle} onClick={onBack}><Icon name="chevron-left" size={16} /></button>}<div><small>{activityLabel ?? (phase === 'setup' ? t('chrome.newTask') : t('chrome.capturing'))}</small><strong title={title}>{title}</strong></div></div>
    <button className="global-settings-button" title={t('chrome.settingsTitle')} aria-label={t('chrome.settingsAria')} onClick={onOpenSettings}><Icon name="settings" size={17} /></button>
  </header>;
}

export function StudioStatus({ engineStatus, message, isError = false }: { engineStatus: EngineStatus; message: string; isError?: boolean }) {
  const { t } = useI18n();
  return <footer className="studio-status">
    <span className={`status-engine ${engineStatus}`}><i />{engineStatus === 'ready' ? t('chrome.engineReady') : engineStatus === 'connecting' ? t('chrome.engineConnecting') : t('chrome.engineOffline')}</span>
    <span className={isError ? 'status-message error' : 'status-message'}>{message}</span>
  </footer>;
}

export function HomeHeader({ preview, onOpenSettings }: { preview: boolean; onOpenSettings: () => void }) {
  const { t } = useI18n();
  return <header className="home-header">
    <div className="home-brand"><span className="home-brand-mark"><img src={appLogo} alt={t('chrome.productName')} /></span><div><strong>{t('chrome.productName')}</strong><small>{t('chrome.appSubtitle')}</small></div>{preview && <em className="preview-badge">{t('chrome.previewBadge')}</em>}</div>
    <button className="global-settings-button" title={t('chrome.settingsTitle')} aria-label={t('chrome.settingsAria')} onClick={onOpenSettings}><Icon name="settings" size={17} /></button>
  </header>;
}
