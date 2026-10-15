import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/barlow-semi-condensed/500.css';
import '@fontsource/barlow-semi-condensed/600.css';
import './styles.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// The service worker caches only the app shell. Browsers allow it on HTTPS or localhost.
if ('serviceWorker' in navigator && import.meta.env.PROD && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* non-fatal */
    });
  });
}

// iOS Safari: suppress pinch-zoom and double-tap zoom on the control surface.
document.addEventListener('gesturestart', (e) => e.preventDefault());
