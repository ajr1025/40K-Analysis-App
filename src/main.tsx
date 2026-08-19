import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './app/App';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// Offline support. Registered after load so it never delays first paint, and
// only in a built app -- a service worker in front of the dev server caches
// modules that are about to change.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
  });
}
