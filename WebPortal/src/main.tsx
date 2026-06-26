import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './app/App';
import { configureAmplify } from './auth/amplify';
import './styles/global.css';

// Configure Cognito (Amplify) before anything renders or queries run.
configureAmplify();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found in index.html');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
