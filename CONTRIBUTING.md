# Contributing to Tartan

Thanks for helping. Bug reports, fixes and small focused features are all welcome.

## Setting up

You need [Node.js](https://nodejs.org) 22.12 or newer.

```bash
git clone https://github.com/Manraj10/tartan.git
cd tartan
npm install
npm run dev
```

`npm run dev` starts the app with hot reload for the interface. Changes to `src/main` need a restart.

On Ubuntu 24.04 and later, give Electron's sandbox helper root ownership once after `npm install`,
or Electron refuses to start:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

## Before you open a pull request

```bash
npm run typecheck
npm test
npm run build && npm run test:ui
```

All three must pass. `npm test` covers the parsers, planners and data-file logic without a window.
`npm run test:ui` drives the built app in a temporary profile. CI runs the same checks on Windows,
macOS and Linux for every pull request.

To try a change against a separate profile instead of your own, set `TARTAN_USER_DATA` to an empty
folder before launching. Put a `config.json` there containing `{"dataDir": "<another folder>"}` and
your real data folder is never touched either.

## How the code is laid out

| Folder | What lives there |
| --- | --- |
| `src/main` | The Electron main process: files on disk, calendar feeds, recurring rules, Google sync, the tray |
| `src/preload` | The bridge that exposes `window.api` to the interface |
| `src/renderer` | The React interface |
| `src/shared` | Pure logic used by both sides: the quick-add parser, day planning, grades, the LeetCode ladder |
| `tests` | Plain Node scripts, one per area, that bundle the code under test with esbuild |
| `docs/apps-script` | The optional Google Apps Script for calendar sync and the phone page |

## Ground rules

- **The data folder is the database.** Everything a user owns stays as plain, hand-editable JSON and
  Markdown in that folder. No database, account or server.
- **Writes go through `writeJson`** in `src/main/store.ts`. It writes a temporary file and renames
  it, queues writes to the same file, and refuses to overwrite a file it cannot read.
- **Network calls live in the main process.** The interface's content security policy blocks
  scripts and requests to other origins on purpose. The one exception is images over https.
- **Keep dependencies few.** The installed app has no runtime dependencies at all; everything is
  bundled. A new dependency needs a reason in the pull request.
- **Never touch real data in tests.** Use a temporary folder, as the existing tests do.
- **Behaviour changes come with a test** whenever the logic can run without a window.

## Commit messages

Write the subject as a plain sentence about what changes for the person using the app, for
example "A typo in grades.json can no longer wipe it". Keep it under about 72 characters, and use
the body for the reason.

## Releasing (maintainers)

1. Update `version` in `package.json` and add a section to `CHANGELOG.md`.
2. Optional: run the release workflow by hand (Actions → Release → Run workflow) for a dry run.
3. Push the commit, then the tag: `git push origin main`, `git tag v0.2.0`, `git push origin v0.2.0`.
4. The release workflow builds the Windows, macOS and Linux installers and launches them before it
   publishes the release with checksums. A tag that does not match `package.json` stops it.
