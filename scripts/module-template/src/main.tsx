import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import './mobile.css';
import { installMobileTables } from './mobile';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Tables become labelled cards on a phone (src/mobile.ts, src/mobile.css).
installMobileTables();
