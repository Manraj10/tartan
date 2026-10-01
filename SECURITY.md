# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue. On the repository page, open the
**Security** tab and choose **Report a vulnerability**. Only the maintainer can see the report.

## Supported versions

Fixes go into the latest release only.

## What Tartan holds that is worth protecting

- **Calendar feed URLs.** A Canvas feed URL contains a personal access token. Tartan stores feed URLs
  in `subscriptions.json` in your data folder.
- **The Google sync secret**, if you set one up, in `config.json` in Electron's user-data folder.
- **Sign-ins inside site tabs.** Canvas, Gradescope and other sites you open in a space keep their
  cookies in Tartan's own browser profile.

Tartan makes no network requests of its own beyond the calendar feeds you add, the course lookup at
`course.apis.scottylabs.org` when you paste a CMU schedule, and the Google address you configure.
Reports about any of these, about the separation between site tabs and the app, or about a way for a
note or feed to run code, are especially welcome.
