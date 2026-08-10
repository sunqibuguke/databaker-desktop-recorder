import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { installDevRecorderMock } from './dev-recorder-mock';
import './styles.css';

if (import.meta.env.DEV) installDevRecorderMock();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
