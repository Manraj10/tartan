/**
 * What the app window may do with a navigation it did not start itself. Kept free of electron
 * imports so the tests can run it: this is the one decision that stops a link in a note from
 * carrying the window (and its preload bridge) to a website.
 */
export function navDecision(url: string, currentUrl: string): 'allow' | 'block' | 'external' {
  // A same-page reload or a hash-only change is the app itself.
  if (url.split('#')[0] === currentUrl.split('#')[0]) return 'allow'
  return /^https?:\/\//.test(url) ? 'external' : 'block'
}
