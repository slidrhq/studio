import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerLibraryFonts } from './fonts';
import { I18n } from './i18n';
import { Studio } from './Studio';
import './styles.css';

// The designs are drawn in the library's fonts, as the app draws them.
void registerLibraryFonts().catch(() => undefined);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18n>
      <Studio />
    </I18n>
  </StrictMode>,
);
