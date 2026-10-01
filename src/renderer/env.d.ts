/// <reference types="vite/client" />

import type { Api } from '../preload/index'

declare global {
  interface Window {
    api: Api
  }
}

// React 19 moved IntrinsicElements under the React.JSX namespace.
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string
        partition?: string
        allowpopups?: string
        useragent?: string
      }
    }
  }
}

export {}
