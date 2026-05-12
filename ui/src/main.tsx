import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { I18nContext, useI18nState } from './i18n';
import { registerLocalStorageBearerInterceptor } from './apiClient';
import { useTheme } from './hooks/useTheme';
import './styles.css';

registerLocalStorageBearerInterceptor();

function Root() {
  const i18n = useI18nState();
  useTheme(); // applies data-theme attribute reactively
  return (
    <I18nContext.Provider value={i18n}>
      <App />
    </I18nContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>
);
