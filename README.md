# KungFu

Small **Node** web app for a martial-arts club: track **prepaid class credits** per member, **add** credits when they pay, and **subtract** when they attend. Data lives in **SQLite** on disk (`data/kungfu.db`).

Uses the built-in **`node:sqlite`** module (Node **22.5+**), so you do **not** need Visual Studio / `node-gyp` to install dependencies on Windows.

## Quick start (development)

From this folder:

```powershell
npm install
npm run dev
```

- **API:** http://127.0.0.1:3000  
- **UI (Vite):** http://localhost:5173 (or your PC’s LAN IP on port **5173** — Vite is started with `--host` so phones on the same Wi‑Fi can open it)

The dev UI proxies `/api` to the API server.

## Production-style run (single port)

Build the UI, then start the server (serves API + static files on **one** port):

```powershell
npm install
npm run build
$env:NODE_ENV = 'production'
npm start
```

Then open `http://YOUR_PC_LAN_IP:3000` on the owner’s PC or phone (same network). The server listens on **0.0.0.0** so LAN devices can reach it.

**Backup (recommended):** use the SQLite online backup script so the copy is consistent even with WAL and while the app is running:

```powershell
npm run backup-db -- "D:\Backups\KungFu"
```

That folder can be on **another drive**, **OneDrive**, a **USB stick**, or a **network path**. You can also set `KUNGFU_BACKUP_DIR` to that folder and run `npm run backup-db` with no arguments. For a fixed filename, pass a full path ending in `.db`.

**Manual:** you can still copy `data/kungfu.db` (ideally stop the server first, or copy `kungfu.db` plus `-wal`/`-shm` if present—online backup avoids that guesswork).

### Windows: run backup every day

1. Edit **`scripts/register-daily-backup-task.ps1`**: set **`$BackupDir`** to a folder on **another drive**, **OneDrive**, or a **network share**, and **`$DailyAt`** (local time, 24 h).
2. Open **PowerShell as Administrator**, `cd` to this repo, run:
   ```powershell
   .\scripts\register-daily-backup-task.ps1
   ```
3. Confirm in **Task Scheduler** (`taskschd.msc`) under **Task Scheduler Library** — task name **KungFu daily DB backup**.

The task runs **`scripts/backup-daily.ps1`**, which calls **`backup-db.mjs`** and appends to **`logs/backup-daily.log`**. Test once without the scheduler:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\backup-daily.ps1 -BackupDir "D:\Backups\KungFu"
```

The task uses your Windows account and **runs when you are logged in** (typical for a club PC left on). To run when logged off, recreate the task in Task Scheduler and choose **Run whether user is logged on or not** (Windows will prompt for your password).

## Stack

- **Express** + **`node:sqlite`** (`DatabaseSync`)
- **React** + **Vite**

## API (summary)

| Method | Path | Purpose |
|--------|------|--------|
| `GET` | `/api/summary` | Club-wide snapshot: all members with `balanceTotal`, `phone`, and `byClass` (`balance`, `visits` per class) plus `classTypes` |
| `GET` | `/api/class-types` | All class types (`id`, `name`, `sortOrder`), ordered |
| `POST` | `/api/class-types` | Owner: add type `{ name }` (max 120 chars); `sortOrder` is auto (append) |
| `DELETE` | `/api/class-types/:id` | Owner: remove type **only if** it has **no** ledger rows and **not** the last type (`204` or `400`/`404`) |
| `GET` | `/api/members` | List members with total balance (sum over all classes) |
| `POST` | `/api/members` | Create member `{ name, age?, phone?, email?, notes? }` |
| `GET` | `/api/members/:id` | Member + total balance + `balancesByClass` + ledger (with class name) |
| `PATCH` | `/api/members/:id` | Update `{ name?, age?, phone?, email?, notes?, active? }` |
| `POST` | `/api/members/:id/purchase` | Add credits `{ classId, classes: n, note? }` |
| `POST` | `/api/members/:id/attend` | Subtract `{ classId, count?` default 1`, note? }` |

Balances are the **sum** of `ledger.delta` per member (total) and per `class_id` (each of the ten class types). Legacy rows get `class_id = 1` after upgrade.

## Security note

There is **no login** yet — fine for trusted LAN use. Before exposing to the internet, add authentication (and HTTPS).
