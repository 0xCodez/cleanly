import '@fontsource-variable/onest';
import '@fontsource-variable/unbounded';
import '@fontsource-variable/jetbrains-mono';
import './styles/app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initialTheme } from './state';

// set before the first paint so the window never flashes the wrong theme
document.documentElement.dataset.theme = initialTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
