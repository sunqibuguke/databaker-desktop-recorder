import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { installDevRecorderMock } from './dev-recorder-mock';
import { captureRendererException } from './sentry';
import './styles.css';

if (import.meta.env.DEV) installDevRecorderMock();

createRoot(document.getElementById('root')!, {
  onUncaughtError(error) {
    captureRendererException(error, 'uncaught');
  },
  onCaughtError(error) {
    captureRendererException(error, 'error-boundary');
  },
  onRecoverableError(error) {
    captureRendererException(error, 'recoverable');
  },
}).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
