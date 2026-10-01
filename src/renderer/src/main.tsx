import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import Capture from './Capture'
import { StoreProvider } from './store'
import './styles.css'
import 'katex/dist/katex.min.css'

// The quick-capture window loads the same bundle with #capture, so it needs no second build.
const isCapture = window.location.hash === '#capture'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isCapture ? (
      <Capture />
    ) : (
      <StoreProvider>
        <App />
      </StoreProvider>
    )}
  </React.StrictMode>,
)
