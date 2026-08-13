import { loader } from '@monaco-editor/react';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// Point Monaco's AMD loader at the locally served min/vs directory.
// In dev mode viteStaticCopy serves it at /vs via middleware.
// In production it is copied to dist/vs by the same plugin.
// This avoids bundling the 3.5 MB monaco-editor package in the main JS chunk,
// which caused the main thread to freeze while typing.
loader.config({ paths: { vs: '/vs' } });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
