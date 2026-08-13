import { LicenseGate } from './ActivateLicense';
import { I18nProvider } from './i18n';
import { PrompterView } from './Prompter';
import { RecorderApp } from './Recorder';

export default function App() {
  return <I18nProvider>
    {new URLSearchParams(window.location.search).get('view') === 'prompter'
      ? <PrompterView />
      : <LicenseGate>{(license) => <RecorderApp license={license} />}</LicenseGate>}
  </I18nProvider>;
}
