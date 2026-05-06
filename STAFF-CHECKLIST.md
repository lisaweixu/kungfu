# KungFu Front Desk Checklist

Print this page and keep it near the front desk.

---

## Start / Stop the App

Use these steps on the club computer.

### Start (normal use)

1. Open **PowerShell** in the `kungfu` folder.
2. Run:

```powershell
npm start
```

3. Wait for the "listening" message.
4. Open browser to: `http://localhost:3000`

### Stop

1. Go to the PowerShell window where the app is running.
2. Press `Ctrl + C`.
3. If asked "Terminate batch job (Y/N)?", press `Y`.

### If first run on this computer

Run once before `npm start`:

```powershell
npm install
npm run build
```

### If the app won't start

Try these in order:

1. Make sure PowerShell is in the `kungfu` folder (the one with `package.json`).
2. Run:

```powershell
npm install
```

3. Then run again:

```powershell
npm start
```

4. If you see a message that port `3000` is already in use:
   - close other old app windows/terminals,
   - then run `npm start` again.
5. If `npm` is not recognized, Node.js is missing on this computer. Ask the owner/admin to install Node LTS.

---

## Start of Day

- Open KungFu in your browser.
- Check that student list loads.
- If needed, click **Refresh**.
- If there is an error, tell the owner before class starts.

---

## Add a New Student

1. Click **New member**.
2. Fill at least **Name**.
3. Add phone/email if available.
4. Click **Save**.
5. Open the student profile and add credits if they paid.

---

## Add Prepaid Credits

1. Open the student.
2. In **Credits**, click **+ Add**.
3. Select class type.
4. Enter number of credits.
5. Select validity (or never expires).
6. Click **Add credits**.

---

## Record Attendance (Subtract Credits)

1. Open the student.
2. In **Take class (attendance)**:
   - choose class type,
   - choose how many credits to subtract (usually 1).
3. Click **Subtract from this class**.
4. If blocked, student may not have enough credits in that class.

---

## Send Message to One Class

1. Go to **Summary**.
2. Find the class column.
3. Click **Email** for that class.
4. Check recipient count.
5. Edit subject/message.
6. Click **Send**.

Notes:

- Email is sent with **BCC** for privacy.
- Members without email addresses will not receive it.

---

## End of Day

- Confirm attendance was entered for all classes.
- Confirm new payments were added as credits.
- Check important notices were sent (if needed).
- Ask owner to confirm backup ran (or run backup process if assigned).

---

## Common Problems (Quick)

- **Student not found:** use search by name/phone.
- **Cannot subtract credit:** wrong class selected or no credits left.
- **Email send failed:** ask owner to check Settings (SMTP / App Password).
- **Page not loading:** refresh browser; if still broken, restart app and tell owner.

---

## Weekly Owner Check (Recommended)

- Review **Summary** for unusual balances.
- Review **Class email history**.
- Send a **test email** from Settings.
- Confirm daily backups are running.
