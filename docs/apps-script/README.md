# Tartan → Google

Tartan cannot be awake at 9am the day a pset is due. Google can. So Tartan POSTs the semester to
an Apps Script web app that runs as you and writes real events carrying real reminders; everything
that has to happen while the laptop is shut happens on Google's side.

- `Code.gs` — the whole script. Paste it over the default `Code.gs`.
- `appsscript.json` — optional. Carries the timezone, the Tasks service and the deploy settings,
  so pasting it saves a few of the clicks below.

Deadlines and classes go to **Google Calendar**. Todos go to **Google Tasks**, one way — ticking
something off on the phone does not come back, and the next sync re-opens it. Tartan is the source
of truth.

## Setup

Generate the secret first: Tartan → Settings → Google Calendar → **Generate**, and copy it.

**Create the script**

1. Sign in to Google as the account whose calendar you want Tartan to write to, and check the avatar
   top-right — landing in the wrong account is the most common way this goes sideways. Use a personal
   account rather than a university one: a personal account survives graduation, and a university
   admin can switch off the anonymous-access deploy option this needs.
2. `script.google.com` → **New project**.
3. Click "Untitled project", rename it **Tartan sync**.
4. Select everything in the editor, delete it, paste all of `Code.gs`, `Ctrl+S`.

**Settings**

5. Left rail → **Project Settings** (gear) → **Time zone** → set it to the one your computer uses.
   `appsscript.json` ships with `America/New_York`, so if you use that file, change it to match.
   Skip this and every class time lands wrong; the default follows the account, not the data.
6. Same page → **Script Properties** → **Add script property**. Property `TARTAN_SECRET`, value =
   the secret you copied → **Save script properties**.
   Add a second property in the same place if you want the phone page: `TARTAN_VIEW_KEY`, value = any
   long random string you invent. Without it the web app answers one flat line and never renders the
   page — that is the door, so treat it like the secret: never commit it, never screenshot it.

**Tasks service**

7. Left rail → **Editor** → **Services** → **+**. The entry is called **Google Tasks API** — it is
   filed under **G**, not under T with the other "… API" names. Version **v1**, identifier `Tasks`
   (the script calls that symbol by name). → **Add**.

**Authorise**

8. Function dropdown at the top → **authorise** → **Run**.
9. **Review permissions** → pick the personal account → "Google hasn't verified this app" →
   **Advanced** → **Go to Tartan sync (unsafe)** → **Allow**. Expected, not an error.

**Deploy**

10. **Deploy** → **New deployment** → gear beside "Select type" → **Web app**.
11. Execute as **Me**, Who has access **Anyone** → **Deploy**.
12. Copy the **Web app URL**. It ends in `/exec`.
13. Paste it into a browser tab. It should print `Tartan sync is alive.` and the time. It says nothing
    else on purpose, because anyone with the URL can load that page.
    Add `?k=<your TARTAN_VIEW_KEY>` to that URL to get the phone page instead — that link is the
    password, so keep it out of anywhere public and add it to your phone's home screen directly.

**Wire it up**

14. Tartan → Settings → Google Calendar → paste the `/exec` URL → check the secret matches → **Save**
    → **Sync now**.

## What this does to your calendar

Every sync sends the semester as a whole, not a list of changes. The script writes each deadline as
an event stamped `TartanSync id=<row>` in its description, and an event carrying that stamp which is
no longer in the payload is **deleted** — that is how deleting a deadline in Tartan removes it from
your phone. It can only ever touch events it created: anything without the stamp is left alone, so
the rest of your calendar is not at risk. Two guards matter. An empty payload is refused once
anything has synced before, because "the data folder briefly isn't there" and "delete my whole
semester" look identical over the wire. And pointing two different Tartan installs at one deployment
means each sync deletes the other's events, so give every install its own script.

## Afterwards

Editing the script: **Deploy → Manage deployments → pencil → Version: New version → Deploy.** The
`/exec` URL survives. Adding a service after authorising needs `authorise` run again for the new
scope, then a new version.

Reminders live in two constants at the top of `Code.gs`. Timed deadlines fire a day, an hour, 30
and 15 minutes ahead. All-day deadlines start at midnight, so those numbers would land while you
are asleep — they fire at 9am and 8pm the day before instead. Give a deadline a time in Tartan if
you want the closing sequence on it. Classes are silent by design.

Todos need the Google Tasks **app**, or the Tasks tab in the Google Calendar app. Apple Reminders
does not show Google Tasks.

## When it looks broken but isn't

- **Events land but nothing buzzes.** An event with no explicit reminders inherits the calendar's
  default list, and an empty default list alerts nobody. The script sets reminders explicitly on
  every event for exactly this reason — if you see this, something stripped them.
- **Nothing appears on the phone.** The script writes to the **primary** calendar deliberately. A
  new secondary calendar would be off by default on iOS and would need ticking at
  `calendar.google.com/calendar/syncselect`.
- **Todos say `skipped` or `failed`.** The Tasks half degrades on its own; deadlines and classes
  keep syncing. Re-check step 7.
- **Duplicated events.** The script indexes ±400 days and matches on the `TartanSync id=…` line in
  each description. Deleting that line from an event orphans it.
