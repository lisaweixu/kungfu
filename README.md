# KungFu

KungFu is a simple app for club staff to:

- keep member credits by class,
- subtract credits when students attend,
- send class emails,
- and send automatic reminders for low/expiring credits.

---

## Daily Use (Staff)

1. Open the app in your browser.
2. Add new students with **New member**.
3. Open a student and click **+ Add** to add prepaid credits.
4. In **Take class (attendance)**, subtract credits when they attend.
5. Use **Summary** to see all students and all class balances.
6. Use **Settings** to manage email and reminders.

Printable front-desk version: `STAFF-CHECKLIST.md`

---

## First-Time Setup (Owner/Staff)

### 1) Install and run

In this folder:

```powershell
npm install
npm run dev
```

Then open:

- App: `http://localhost:5173`
- API: `http://127.0.0.1:3000`

### 2) Configure owner + email

In the app, open **Settings** and fill:

- **Owner name**
- **Owner email** (used as From address)
- **SMTP host/port/user/password**

For Gmail:

- Host: `smtp.gmail.com`
- Port: `465`
- SSL/TLS: ON
- Password: Gmail **App Password** (not normal Gmail password)

Click **Save**, then click **Send test email**.

### 3) Enable reminders (optional but recommended)

In **Settings**:

- turn on **Send automatic reminders**,
- click **Save**.

The server will run reminders every day at about 9:00 AM local time.

---

## Sending Class Emails

From **Summary**:

1. Click **Email** on a class column.
2. Review recipient count.
3. Edit subject/body.
4. Send.

The app sends with **BCC** for privacy.

---

## Backups (Very Important)

Create a backup anytime:

```powershell
npm run backup-db -- "D:\Backups\KungFu"
```

Recommended: backup to another drive, OneDrive, or network folder.

You can verify a backup file:

```powershell
npm run verify-backup -- "D:\Backups\KungFu\kungfu-backup.db"
```

### Schedule daily backup on Windows

1. Edit `scripts/register-daily-backup-task.ps1`:
   - set `$BackupDir`
   - set `$DailyAt`
2. Run PowerShell as Administrator:
   ```powershell
   .\scripts\register-daily-backup-task.ps1
   ```
3. Confirm task: `KungFu daily DB backup`.

---

## Run in Production (One Port)

Use this on the main club PC:

```powershell
npm install
npm run build
$env:NODE_ENV = 'production'
npm start
```

Then open `http://YOUR_PC_IP:3000` on devices in the same network.

---

## Quick Technical Reference

- Node requirement: `>= 22.5.0`
- Main DB file: `data/kungfu.db`
- Important scripts:
  - `npm run dev`
  - `npm run build`
  - `npm start`
  - `npm run backup-db`
  - `npm run verify-backup`
  - `npm test`

### API endpoints

- Health: `GET /api/health`
- Members: `GET/POST /api/members`, `GET/PATCH /api/members/:id`
- Credits: `POST /api/members/:id/purchase`, `POST /api/members/:id/attend`
- Class types: `GET/POST /api/class-types`, `DELETE /api/class-types/:id`
- Summary: `GET /api/summary`
- Class email:
  - `GET /api/class-types/:id/email-recipients`
  - `POST /api/class-types/:id/email`
  - `GET /api/class-messages`
- Settings/email:
  - `GET/PATCH /api/settings`
  - `POST /api/settings/test-email`
  - `POST /api/reminders/run`

---

## Security Note

This app has no login yet. Use it only on a trusted local network unless you add authentication and HTTPS.
