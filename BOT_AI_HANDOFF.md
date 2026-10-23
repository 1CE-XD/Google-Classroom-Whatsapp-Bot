# Google Classroom & AI Study Assistant - WhatsApp Bot
## Complete AI Handoff & Architecture Blueprint

> **Purpose of this document:**  
> This file contains 100% of the project context, technical architecture, active feature set, design decisions, and codebase status. Any new AI assistant or developer can read this document and continue development immediately without losing context.

---

## 1. Project Overview & Tech Stack

* **Repository:** [https://github.com/1CE-XD/Google-Classroom-Whatsapp-Bot.git](https://github.com/1CE-XD/Google-Classroom-Whatsapp-Bot.git)
* **Local Path:** `C:\Users\Yash\.gemini\antigravity\scratch\whatsapp-classroom-bot`
* **Current Branch:** `main`
* **Runtime:** Node.js (ES Module: `"type": "module"`)
* **Core Libraries:**
  * **WhatsApp:** `@whiskeysockets/baileys` (Multi-file auth, socket connection, media stream decoding)
  * **AI Client:** `@google/genai` (Official Google GenAI SDK for Gemini 3.5, 3.6, 3.7, 3.8 models)
  * **Bonus LLM / Failover:** Native `fetch` to Groq Cloud API (`deepseek-r1-distill-llama-70b`, `llama-3.3-70b-versatile`)
  * **Google APIs:** `googleapis` (Google Classroom v1 & Google Drive v3)
  * **Image Processing:** `sharp` (EXIF orientation normalization, vertical multi-crop zooming)
  * **Storage:** Lightweight disk-persisted JSON databases in `data/`

---

## 2. Project Directory Structure

```text
whatsapp-classroom-bot/
├── auth_info_baileys/        # ⚠️ CRITICAL: WhatsApp session files. NEVER delete or modify!
├── data/
│   ├── store.json            # Subscribed groups, auto-sync mappings, selected courses, seen posts
│   ├── chat_buffers.json     # Persistent rolling 100-message logs per group for !summarize
│   └── ai_histories.json     # Multi-turn AI conversation memory and user preferred models
├── src/
│   ├── index.js              # Bot entry point & auto-sync background polling worker
│   ├── ai/
│   │   └── gemini.js         # Multi-model AI router, vision optimizer, LaTeX cleaner, persona prompts
│   ├── google/
│   │   ├── auth.js           # Google OAuth2 client credentials & token refresher
│   │   └── classroom.js      # Google Classroom & Drive API client (fetch assignments, docs, files)
│   ├── storage/
│   │   └── db.js             # JSON persistence helper for store.json
│   └── whatsapp/
│       └── bot.js            # Baileys WhatsApp client, message listeners, command dispatcher
├── Start-Classroom-Bot.bat   # Windows launcher batch script
├── package.json
└── .env                      # API keys: GEMINI_API_KEY, GROQ_API_KEY, OWNER_NUMBER
```

---

## 3. Active Features & How They Work

### A. WhatsApp Connection & Session Preservation
* Handled by `@whiskeysockets/baileys` with `useMultiFileAuthState('auth_info_baileys')`.
* Contains 60+ active session credential files.
* **Strict Rule:** Never delete or wipe `auth_info_baileys`. The bot reconnects in ~2 seconds upon restart using existing credentials without requiring any QR code rescan.
* Starts via `Start-Classroom-Bot.bat` on the Desktop.

### B. Google Classroom Integration
* **`!courses` / `!cls`**: Lists all enrolled Google Classrooms with index numbers.
* **`!cls <number>`**: Focuses the chat on a specific classroom (e.g. `!cls 1` selects Course 1).
* **`!cls all`**: Resets focus to all classrooms.
* **`!due` / `!due <number>`**: Displays upcoming assignments, deadlines, and submission links.
* **`!recent` / `!recent <number>`**: Displays latest posted materials, slides, announcements, and attachments.
* **`!docs`**: Lists all downloadable documents/PDFs for the selected course (requires `!cls <n>`).
* **`!get <number>`**: Downloads the selected document from Google Drive and sends the PDF directly into WhatsApp.
* **`!get all`**: Sequentially downloads and delivers all documents found in `!docs`.
* **`!get <number|all> [true/false]`**: Optional trailing DM flag. `true` = the file(s) are downloaded and delivered privately into the requester's DM instead of the group chat (also `yes`/`on`/`enable` accepted; `false`/`no`/`off` = this chat, which is the default). In groups the DM target is `originalMsg.key.participant`; in DM chats the flag is a no-op. DM delivery seeds the DM's `chatCachedFiles` via `setChatFiles(deliveryJid, files)` so `!get <number>` works inside the DM afterwards, re-uses the shared `sendAllDocuments()` helper with a 1.2s anti-rate-limit gap and conditional quoting (quote only when the target chat is the origin chat), and reports all errors (incl. the Drive-permission hint) back in the origin chat.
* **`!autosync <number>` / `!autosync all` / `!autosync off`**: (Owner only) Dedicated background watcher that automatically posts new announcements and uploads files into WhatsApp groups.

### C. AI Study Buddy & Multimodal Vision/Doc Reader (`!ai`)
* **Commands:** `!ai <question>` or `@mention <question>`.
* **Multimodal Vision (`sharp` + Gemini):**
  * Supports photos of handwritten notes, question papers, code screenshots, whiteboards, and textbook pages.
  * **Vertical High-Res Multi-Crop Zooming:** If an image is tall/vertical (A4 sheet or phone photo), `sharp` automatically auto-rotates it and extracts a 55% top crop and 55% bottom crop (with 10% center overlap). Both full view and high-res zooms are sent to Gemini, completely eliminating the standard 768px downscaling blur!
  * **Document / PDF Reader:** PDFs (`application/pdf`) and code/text files (`.py`, `.cpp`, `.txt`) are passed directly to Gemini.
  * **Direct or Quoted Media:** Works whether attached with caption `!ai` or by replying to an existing image/PDF with `!ai explain`.
* **Uncensored Persona:**
  * Raw, bold, street-smart college senior persona (hostel senior / backbencher vibe).
  * Has zero filter on language, banter, and roasts.
  * **Bilingual Switcher:** Automatically responds in street-smart Hindi/Hinglish when addressed in Hindi or when asked `"talk in hindi"` / `"hindi me bolo"`.
* **WhatsApp Mathematical Notation Cleaner (`cleanWhatsAppMath`):**
  * WhatsApp cannot render raw LaTeX (`$...$`, `$$...$$`, `/$`, `\$`, `\[...\]`, `\frac{...}`, `\sqrt{...}`).
  * `cleanWhatsAppMath()` automatically converts all formulas into clean WhatsApp Unicode (e.g. `x²`, `x³`, `√x`, `±`, `×`, `÷`, `(a / b)`, `θ`, `π`, `°`, `Δ`).
  * System prompts strictly forbid raw LaTeX.
* **Model Pool & Failover Order:**
  * `gemini-3.5-flash` (Primary fast vision & reasoning)
  * `gemini-3-flash-preview` (~1.1s instant fallback)
  * `gemini-3.6-flash`
  * `gemini-3.8-flash`
  * `gemini-3.5-flash-lite`
  * `r1` (DeepSeek R1 via Groq - text only)
  * `llama3` (Llama 3.3 70B via Groq - text only)
  * Switching: User can switch models anytime using `!model <name>` (e.g. `!model lite`, `!model flash`).

### D. Group Chat Summarizer (`!summarize`)
* **Command:** `!summarize` or `!summarize <count>` (e.g. `!summarize 50`).
* **Continuous Buffering:** Rolling FIFO buffer of the last 100 messages per group.
* **Disk Persistence (`data/chat_buffers.json`):** Buffers survive bot restarts and computer reboots.
* **WhatsApp History Sync:** Listens to Baileys `messaging-history.set` to absorb recent message history from WhatsApp servers on startup.
* **Owner Included:** Messages sent from the owner's phone are included as `You (Owner): ...`.
* **Summary Structure:** Main topics, decisions, open questions, and action items formatted with bullet points.

---

## 4. Commands Quick Reference

| Command | Usage | Description |
| :--- | :--- | :--- |
| `!help` | `!help` | Displays user command manual |
| `!courses` / `!cls` | `!cls` or `!cls 1` | List classrooms or set active course focus |
| `!due` | `!due` or `!due 1` | Upcoming assignments and submission deadlines |
| `!recent` | `!recent` or `!recent 1` | Recent classroom posts, announcements & files |
| `!docs` | `!docs` | List all downloadable documents for selected course |
| `!get` | `!get 1` / `!get all` / `!get all true` | Download document(s) directly into WhatsApp; add `true` as last arg to receive the files in your DM instead |
| `!autosync` | `!autosync 1` / `all` / `off` | (Owner) Auto-upload new posts & files to group |
| `!ai` | `!ai <question>` | Ask AI with conversational memory |
| `!ai` + Image/PDF | Photo with caption `!ai` | Full-page OCR, diagram & assignment solver |
| `!summarize` | `!summarize 50` | Summarize recent group chat conversations |
| `!models` | `!models` or `!model lite` | View or switch active AI model |
| `!clear` / `!reset`| `!clear` | Reset AI conversation history |
| `!subscribe` | `!subscribe` | (Owner) Enable group commands for all members |
| `!unsubscribe` | `!unsubscribe` | (Owner) Disable bot in group |
| `!status` | `!status` | Check connection and auto-sync status |

---

## 5. Environment Variables (`.env`)

```env
# Google Gemini API Key (Required for AI and Vision)
GEMINI_API_KEY=AIzaSy...

# Groq Cloud API Key (Optional for DeepSeek R1 & Llama 3.3)
GROQ_API_KEY=gsk_...

# Owner WhatsApp Number (Digits only with country code, supports comma-separated list)
OWNER_NUMBER=REDACTED_NUMBER
```

---

## 6. Recent Commits History & Evolution

* `7e2e5f5`: **fix(summary):** buffer in all groups, include owner messages, and sync past history on connect
* `00bfb2f`: **feat(storage):** persist group chat buffers (`data/chat_buffers.json`) and AI history (`data/ai_histories.json`) across bot restarts
* `ed68827`: **fix(math):** eliminate raw LaTeX and slash-dollar delimiters (`/$`, `\$`) with clean WhatsApp Unicode mathematical notation
* `01c0139`: **fix(vision):** enhance full-page resolution with `sharp` multi-crop zoom (top & bottom half slices) and exhaustive full-page OCR
* `d588c64`: **feat(multimodal):** add image and document reader support for `!ai`
* `59d957b`: **fix(language):** ensure explicit Hindi/Hinglish requests switch language persona immediately
* `e4a6beb`: **feat(persona):** uncensored language, banter, and witty street-smart college senior persona
* `a83d340`: **feat(docs):** add `!docs` document browser and `!get all` bulk downloader

---

## 7. Critical Technical Guidelines for Next AI

1. **NO RESCAN:** Never touch, clear, or corrupt the `auth_info_baileys` folder. Preserving the authenticated WhatsApp session is a hard requirement.
2. **DM Privacy:** In Direct Messages (1-on-1 personal chats), the bot MUST only reply to explicit commands starting with prefixes (`!`, `/`, `.`, `#`). Casual chatting must remain 100% ignored so friends/contacts are never disturbed.
3. **No Raw LaTeX in WhatsApp:** Always route mathematical AI text through `cleanWhatsAppMath()` to prevent ugly slash-dollar syntax (`/$`, `\$`, `\frac`).
4. **Multimodal Payload Limit:** Keep base64 payloads under 20MB. Multi-crop zoom is used for vertical images (aspect ratio >= 1.25) to prevent tile downscaling blur.
5. **Failover Safety:** `gemini-3.5-flash` and `gemini-3-flash-preview` are primary. `gemini-2.5-pro` and `gemini-2.5-flash` are deprecated by Google (404 NOT_FOUND). Do not re-add them.
