import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import './mobile.css';
import { installMobileTables } from './mobile';
import { registerServiceWorker } from './pwa/register';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Tables become labelled cards on a phone (src/mobile.ts, src/mobile.css).
installMobileTables();

// Installable: the module opens as an app of its own (src/pwa/sw.js).
registerServiceWorker();
