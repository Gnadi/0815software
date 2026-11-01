import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { registerServiceWorker } from './pwa/register';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Installable: the shell opens as an app of its own (src/pwa/sw.js).
registerServiceWorker();
