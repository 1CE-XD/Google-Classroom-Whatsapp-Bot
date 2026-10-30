# 🎓 WhatsApp Google Classroom & Gmail Bot

An on-demand WhatsApp assistant that:
1. **Tracks Google Classroom Assignments**: Fetches upcoming deadlines, assignment details, and direct submission links when asked.
2. **Detects Recent Uploads & Announcements**: Fetches recently posted study materials, lecture slides, and notes.
3. **Monitors Gmail**: Catches latest unread notification emails from professors or Google Classroom.
4. **Group Integration**: Can be added to any WhatsApp group and responds only when mentioned or via prefix commands (`!due`, `!recent`, `!mail`, etc.) without spamming the chat.

---

## ⚠️ Read First: The Bot Runs on Your PC (Important Limitation)

This bot is **not a cloud service**. It is a local Node.js process running on your computer, with no hosting and no server. It only works while:

1. The **launch window is open** (the dark console from `Start-Classroom-Bot.bat`), **and**
2. Your **computer is on and awake**.

| Situation | What happens to the bot |
| :--- | :--- |
| You close the launcher window | The bot **stops immediately** — no replies, no reminders, no auto-sync. |
| Computer restart, shutdown, sleep or logout | The bot **stops**. Messages sent while it is down are not answered. |
| The bot crashes on its own | **Auto-recovered** after a few seconds: the launcher restarts it automatically and logs the crash to `data\bot.log`. |

**What is never lost:** the WhatsApp session (`auth_info_baileys/`), chat memory (`data/`) and the Google token (`token.json`) all survive restarts. Deadline reminders that were missed while the bot was off are simply picked up again on the next check cycle after it starts.

**To get the bot back after closing it or restarting the PC:**

1. Double-click **`Start-Classroom-Bot.bat`** (copies live in Desktop, Documents and Downloads).
2. The boot is silent for **1–2 minutes** (module loading) — that is normal, not frozen.
3. It reconnects automatically. **No QR re-scan is needed** unless you logged the device out on your phone.

> Tip: for a bot you can rely on daily, either leave the PC on with the window open, or start the launcher once after every logon. Windows Task Scheduler or the Startup folder can do this for you (optional).

**Good news: you do NOT re-scan a QR on every start.** The WhatsApp session persists in `auth_info_baileys/` across restarts, so restarting the PC or the window reconnects on its own. A QR only appears if the session was truly invalidated (device logged out on the phone, or WhatsApp invalidates a stale device) — and the bot has safety nets for exactly that:

- **Startup beacon** — every successful start DMs the owner ("🟢 Bot is back online…"). Instant, visible proof that the bot is up and can send.
- **Inbound-silence watchdog** — the historical failure mode was a session that looked connected but received nothing. If 12 hours pass with zero incoming messages, the bot DMs you a warning with the exact re-pair steps (at most once per day, no spam).
- **Session snapshots** — the session folder is copied to `data/auth_snapshots/` at every start (newest 3 kept). If a session ever dies for real, run `node pair.mjs restore` to put the last healthy snapshot back — usually rescuing you from a re-scan entirely.

---

## 🛠️ Prerequisites

- **Node.js** v18+ (tested with Node v24)
- A **Google Account** enrolled in your Google Classroom courses.
- A **WhatsApp Account** (a dedicated secondary phone number is recommended).

---

## 🚀 Setup & Installation

### Step 1: Install Dependencies
Open a terminal in this directory:
```bash
npm install
```

---

### Step 2: Google Cloud Console Setup (OAuth 2.0)

1. Open the [Google Cloud Console](https://console.cloud.google.com/).
2. Click **Select a project** > **New Project** (e.g., name it `Classroom WhatsApp Bot`).
3. In the left menu, navigate to **APIs & Services > Library**, search for and **Enable** the following two APIs:
   - **Google Classroom API**
   - **Google Drive API**
4. Configure the **OAuth Consent Screen**:
   - Go to **APIs & Services > OAuth consent screen**.
   - Choose **External** and click **Create**.
   - Fill in the required app details (App name, support email).
   - Under **Test Users**, add your Gmail address (the one with Google Classroom).
   - Save and continue.
5. Create OAuth Credentials:
   - Go to **APIs & Services > Credentials**.
   - Click **+ Create Credentials** > **OAuth client ID**.
   - Application Type: **Desktop app**.
   - Name: `WhatsApp Classroom Bot`.
   - Click **Create**, then click **Download JSON**.
6. Rename the downloaded file to **`credentials.json`** and place it in the root of this project folder:
   ```
   whatsapp-classroom-bot/
   ├── credentials.json  <-- Place here
   ├── package.json
   └── src/
   ```

---

### Step 3: Authorize Google Classroom & Gmail

Run the interactive authorization CLI:
```bash
npm run auth
```

1. It will output a Google OAuth URL. Copy and open it in your browser.
2. Sign in with your school / personal Gmail account.
   *(If prompted with "Google hasn't verified this app", click **Advanced** -> **Go to Classroom WhatsApp Bot (unsafe)**).*
3. Grant permission to view Classroom coursework, materials, and Gmail.
4. After approval, you will be redirected to `http://localhost/?code=...`.
5. Copy the full redirected URL (or the `code=` value) from your browser address bar and paste it into the terminal prompt.
6. A `token.json` file will be generated automatically.

---

### Step 4: Start the WhatsApp Bot

**Recommended on Windows:** double-click **`Start-Classroom-Bot.bat`** instead of running `npm start` — it clears stale lock ports, auto-restarts the bot if it crashes, and mirrors every console line to `data\bot.log`.

Manual alternative (any OS):
```bash
npm start
```

1. A QR code will display in your terminal.
2. Open WhatsApp on your phone:
   - Go to **Settings** > **Linked Devices** > **Link a Device**.
   - Scan the terminal QR code.
3. The bot will establish a session and save authentication tokens to `auth_info_baileys/` (subsequent starts will connect automatically without re-scanning).

---

## 💬 WhatsApp Group Usage

1. **Add the bot's phone number to your WhatsApp group.**
2. Type **`!subscribe`** in the group:
   - The bot will register the group ID and begin automatically posting deadline reminders (at **24 hours** and **2 hours** before due time).
3. Any member can interact with the bot using `@mention` or commands:

| Command | Description |
| :--- | :--- |
| `!help` or `@bot help` | Display available commands and instructions. |
| `!due` or `@bot due` | List all upcoming assignments sorted by deadline with direct links and attachments. |
| `!recent` or `@bot recent` | List course materials, lecture files, and announcements with file numbers `[1]`, `[2]`. |
| `!get <number>` / `!get all` (alias `!download <num>`) | **Download and send the actual PDF/doc file directly into the WhatsApp chat!** Add a trailing flag to deliver by DM instead: `!get all true` or `!get 3 true` — in groups, files arrive privately in the DM of whoever typed the command (`false` = this chat). |
| `!ai <question>` or `@bot <question>` | **Ask Google Gemini AI** questions about your courses, lab questions, or code! |
| `!subscribe` | Enable automated 24h & 2h deadline reminders in this group. |
| `!unsubscribe` | Disable automated reminders in this group. |
| `!status` | Check bot connection and group reminder status. |

---

## ⚙️ How Automated Reminders Work

- A background cron scheduler runs every **15 minutes**.
- It queries Google Classroom API for coursework deadlines:
  - **24-Hour Notice:** Triggered between 2 and 24 hours before the deadline.
  - **2-Hour Notice:** Triggered when less than 2 hours remain.
- The bot remembers which assignments have already been alerted in `data/store.json` so you never get spammed with duplicate notifications.
- It also watches for new unread Classroom announcement emails in Gmail and pushes them directly to the group.

---

## 🔒 Security & Privacy Notice
- Never commit `credentials.json`, `token.json`, or the `auth_info_baileys/` directory to public repositories. They are already added to `.gitignore`.
