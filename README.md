# IT Priorities Tracker

A lightweight web app that replaces the *IT Priorities* spreadsheet: strategic areas → projects → actions, with status, owners, next action dates and an agenda view.

No build step and no dependencies. It runs on Node 18+ and plain HTML/JS.

## Features

- **Hierarchy you already use.** Strategic areas contain projects, and projects contain actions. Each level collapses with its chevron, and *Collapse all* gives a one-screen portfolio overview.
- **Project status.** Active, Planned, On hold or Done, shown as a colored pill you can change inline. The status chips filter the view.
- **Owners.** Projects and actions each have an owner field, with autocomplete from names already in use.
- **Next action date.** Actions get a native date picker. Overdue dates turn red and dates due within 7 days turn amber. Each project shows its earliest open action date.
- **Agenda view.** All open actions grouped by Overdue, Next 7 days, 8–14 days, Later and No date, each linked back to its project. Use it for weekly reviews.
- **Summary bar.** Counts for active and planned projects, open actions, overdue, due in 7 days, and **active projects with no next action**. That last one flags projects that have stalled. Click any card to filter.
- **Priority flag** (High/Medium/Low) per project. Click the square to cycle it.
- **Notes** on any project or action, in the details panel (⋯).
- **Drag and drop.** Reorder areas, projects and actions, or move an action to another project by dropping it on that project's header.
- **Search** across titles, owners and notes. **Undo** with Ctrl+Z. Completed actions are hidden unless *Show completed* is on.
- **Excel in and out.** Import the existing workbook directly, and export back to .xlsx in the same layout plus Owner/Status/Priority/Notes columns. Exports re-import losslessly.
- **Automatic backups.** The server snapshots the data at most every 10 minutes while you edit, and always before an import or restore. It keeps the last 100. Restore from *Data → Restore from server backup*.
- Light and dark mode. Works on a phone.

## Quick start

```bash
npm start            # http://127.0.0.1:3000
```

1. Download the current workbook from OneDrive (*File → Save as → Download a copy*).
2. In the app, choose **Data → Import from Excel / CSV / JSON…** and pick the file.
3. Review project statuses. The spreadsheet has no status column, so the import marks projects that have at least one dated action as **Active** and everything else as **Planned**.

### Spreadsheet layout the importer expects

The importer reads the sheet named *Priorities* (or the first sheet if there is none):

| Column A | Column B | Column C |
|---|---|---|
| Strategic area name | | |
| `P: Project name` | | |
| | Action text | Next action date |

Blank rows are ignored. Other sheets (Accountability, org charts) are not imported.

## Data storage

- Data lives in `data/tracker.json` and snapshots in `data/backups/`. Set `DATA_DIR` to store it elsewhere.
- **`data/` is git-ignored. Never commit real tracker data: this repository is public.** The only data in the repo is fictional demo content (`public/demo-data.json`).
- If you open the app without the server (for example from a static host), it falls back to saving in that browser's local storage. That is fine for a trial, but it has no backups and no sharing.

## Hosting (recommended: Azure App Service + Entra ID)

The app has **no login of its own**, so don't expose it to the internet without an authentication layer in front of it. The simplest setup in a Microsoft shop:

1. Create an Azure App Service (Linux, Node 20 LTS) and deploy this repo (GitHub Actions or `az webapp up`).
2. Set the app settings `HOST=0.0.0.0` and `DATA_DIR=/home/data`. `/home` is persistent storage on App Service.
3. Turn on **Authentication** with Microsoft as the identity provider, set to *require authentication*. Restrict the Entra app registration to assigned users only.

Optimistic concurrency is built in: if two tabs or two people edit at once, the second save is rejected and you choose which version to keep. The app is still designed for one owner or a small team, not many simultaneous editors.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address (use `0.0.0.0` when hosted) |
| `DATA_DIR` | `./data` | Where `tracker.json` and `backups/` are stored |

## Development

```bash
npm test
```

| File | Role |
|---|---|
| `server.js` | Static file server + JSON API (`GET/PUT /api/data`, `GET /api/backups`) |
| `public/model.js` | Data model, spreadsheet import/export mapping, date helpers |
| `public/xlsx.js` | Dependency-free .xlsx reader/writer (uses the browser's built-in `DecompressionStream`) |
| `public/app.js` | UI |
| `public/styles.css` | Styles (light/dark) |
