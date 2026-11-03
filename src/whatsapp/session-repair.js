/**
 * session-repair.js - permanent, self-healing fix for the one-chat decrypt storm
 * ("Error: Bad MAC" / "MessageCounterError: Key used already or never filled").
 *
 * What happens: WhatsApp rotates the Signal sessions / sender-keys of one chat;
 * the local copy of that chat's keys goes stale, so EVERY message from it dies
 * during decryption ("Failed to decrypt message with any known session...").
 * libsignal prints the failure with raw console.error (which bypasses our
 * silent pino logger), and the stack trace names the failing session record, e.g:
 *     at 123456789012345.0 [as awaitable] (...\libsignal\src\session_cipher.js:171:39)
 *
 * What this module does (reversible - it NEVER deletes anything):
 *   1. installDecryptObserver() wraps console.error and feeds every decrypt
 *      failure into a per-chat counter (rolling 10-minute window).
 *        - below STORM_THRESHOLD: behaviour is 100% unchanged (lines print).
 *        - at/above STORM_THRESHOLD ("storm"): repeated stacks are throttled
 *          to one summary line per 90 s instead of flooding the log.
 *   2. A confirmed storm arms, then performRepair() moves ONLY the stale key
 *      files of that one chat (session-<id>*.json + sender-key-*--<id>--*.json)
 *      into data/auth_repair_backups/<id>-<stamp>/, verifies the move, DMs the
 *      owner and restarts the process. The launcher (Start-Classroom-Bot.bat)
 *      brings the bot back in ~2 min; on the fresh boot the moved records are
 *      gone, so WhatsApp re-distributes fresh keys and the chat decrypts again.
 *
 * Safety rules baked in:
 *   - max PER_DAY_CAP repairs per day, PER_CHAT_COOLDOWN_MS per chat
 *   - boot grace: a fixed uptime window after process start (BOOT_GRACE_MS)
 *     during which failures are ignored - cold-start / reconnect backlog can
 *     mimic a storm but can NEVER be repaired (those messages are unreadable)
 *   - churn-proof: the gate keys off PROCESS UPTIME, never off the latest
 *     'open' event (a churning connection must not reset the grace window)
 *   - on ANY skip (cap/cooldown/boot-grace/not-connected/locked), that chat's
 *     failure window is cleared - only a FRESH 12-failure burst can re-arm;
 *     stale backlog flooding can never keep a repair spinning
 *   - only that chat's own session/sender-key records are moved; never
 *     creds.json, pre-key-*, app-state-* files, never other chats
 *   - the running bot's state (auth_info_baileys and its *backup/*corrupted/
 *     *stale siblings) is never deleted, cleared or corrupted
 *
 * Offline drill (no live session required, moves nothing):
 *   REPAIR_DRY_RUN=1 REPAIR_ARM_DELAY_MS=1500 REPAIR_AUTH_DIR=data/__repair_drill/auth \
 *     node scripts/test-session-repair.mjs
 */

import fs from 'fs';
import path from 'path';

// ---- Tuning constants (REPAIR_* env vars exist only for the offline drill) --
const WINDOW_MS = 10 * 60 * 1000;              // rolling failure window
const STORM_THRESHOLD = 12;                    // failures in window = storm
const RESTART_GRACE_MS = 8 * 1000;             // let logs/DMs flush before exit
const THROTTLE_MS = 90 * 1000;                 // one summary per chat per this
const ARM_DELAY_MS =
  Number(process.env.REPAIR_ARM_DELAY_MS) || 45 * 1000; // double-confirm beat
const PER_CHAT_COOLDOWN_MS = 30 * 60 * 1000;   // min spacing per chat
const PER_DAY_CAP = 3;                         // repairs per day (all chats)
const BOOT_GRACE_MS =
  Number(process.env.REPAIR_BOOT_GRACE_MS) || 2 * 60 * 1000; // uptime gate
const PROCESS_BOOT_MS = Date.now();
let bootAnchor = PROCESS_BOOT_MS;              // drill can shift this

function inBootGrace() {
  return Date.now() - bootAnchor < BOOT_GRACE_MS;
}
const DRY_RUN = process.env.REPAIR_DRY_RUN === '1';

const STATE_FILE = path.resolve('data', 'session-repair-state.json');
const BACKUP_DIRNAME = path.join('data', 'auth_repair_backups');

// runtime hooks, bound by bot.js (getters so reconnects are always current)
const runtime = {
  isConnected: () => false,
  sendOwnerBeacon: null
};

// module-level capture of the ORIGINAL console.error for our own summaries
let origError = console.error;
let installed = false;

// ---- persisted day-cap / per-chat cooldown bookkeeping ----------------------
let state = { day: today(), count: 0, chats: {} };

function today(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    const chats = raw && typeof raw.chats === 'object' ? raw.chats : {};
    if (raw && raw.day === today()) {
      state = { day: today(), count: Number(raw.count) || 0, chats };
    } else {
      state = { day: today(), count: 0, chats }; // cooldowns survive; cap resets
    }
  } catch { /* no file yet - fresh start is fine */ }
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    return true;
  } catch (err) {
    origError('[SESSION-REPAIR] could not persist repair bookkeeping (non-fatal):', err?.message || err);
    return false;
  }
}

loadState();

export function bindSessionRepair(binding) {
  if (!binding) return;
  if (typeof binding.isConnected === 'function') runtime.isConnected = binding.isConnected;
  if (typeof binding.sendOwnerBeacon === 'function') runtime.sendOwnerBeacon = binding.sendOwnerBeacon;
}

// ---- per-chat failure window ------------------------------------------------
const failures = new Map();      // chatId -> timestamp[]
const lastSummaryAt = new Map(); // chatId -> epoch ms
let lastStormChat = null;        // chatId of the most recent open storm
let armed = null;                // { chat, fireAt } single slot
let repairInFlight = false;
let shuttingDown = false;

function pushFailure(chatId) {
  const now = Date.now();
  let list = failures.get(chatId);
  if (!list) { list = []; failures.set(chatId, list); }
  list.push(now);
  while (list.length && now - list[0] > WINDOW_MS) list.shift();
}

function failuresInWindow(chatId) {
  const list = failures.get(chatId);
  if (!list) return 0;
  const now = Date.now();
  while (list.length && now - list[0] > WINDOW_MS) list.shift();
  return list.length;
}

// ---- detection --------------------------------------------------------------
// libsignal prints:  console.error("Session error:" + e, e.stack)
// The stack always contains  "at <chatId>.<deviceId> [as awaitable]"  which
// names exactly which session record failed to decrypt.
function parseFailureLine(args) {
  const joined = args
    .map(a => (typeof a === 'string' ? a : (a && typeof a === 'object' ? (a.stack || String(a)) : String(a))))
    .join('\n');
  const m = /([0-9]{6,})\.(\d+)\s+\[as awaitable\]/.exec(joined);
  if (!m) return null;
  let kind = 'session error';
  if (/MessageCounterError|Key used already or never filled/i.test(joined)) kind = 'key-counter error (MessageCounterError)';
  else if (/Bad MAC/i.test(joined)) kind = 'Bad MAC';
  return { chat: m[1], kind };
}

function observeConsoleError(args) {
  if (!args.length) return false;
  const text0 = typeof args[0] === 'string' ? args[0] : '';

  if (text0.startsWith('Session error:')) {
    const info = parseFailureLine(args);
    if (!info) return false; // unrecognised shape: leave the line untouched
    if (inBootGrace()) return false; // boot/reconnect backlog is not countable
    pushFailure(info.chat);
    const n = failuresInWindow(info.chat);
    if (n < STORM_THRESHOLD) return false; // quiet failures keep old behaviour

    // storm mode: throttle the flood, arm the auto-repair
    lastStormChat = info.chat;
    maybeArm(info.chat);
    if (Date.now() - (lastSummaryAt.get(info.chat) || 0) >= THROTTLE_MS) {
      lastSummaryAt.set(info.chat, Date.now());
      report(
        `[SESSION-REPAIR] chat ${info.chat} cannot decrypt: ${n} failures in the last 10 min (${info.kind}). ` +
        `Reaction lines throttled. ${armed && armed.chat === info.chat ? 'Auto-repair armed.' : 'Auto-repair rules pending.'}`
      );
    }
    return true; // consume the original libsignal line
  }

  if (text0 === 'Failed to decrypt message with any known session...') {
    // header line of the same failing message; silence it only while a storm
    // for a known chat is open, otherwise print like before
    return !!(lastStormChat && failuresInWindow(lastStormChat) >= STORM_THRESHOLD);
  }

  return false;
}

function report(...args) {
  try { origError(...args); } catch { /* never fatal */ }
}

function maybeArm(chat) {
  if (shuttingDown || repairInFlight || inBootGrace()) return;
  if (armed && armed.chat === chat) return; // already armed for this chat
  armed = { chat, fireAt: Date.now() + ARM_DELAY_MS };
  setTimeout(() => { maybeFire(chat); }, ARM_DELAY_MS + 250);
}

function maybeFire(chat) {
  if (!armed || armed.chat !== chat) return;
  armed = null;
  if (shuttingDown || repairInFlight) return;
  if (failuresInWindow(chat) < STORM_THRESHOLD) return; // storm stopped on its own
  performRepair(chat).catch(err => report('[SESSION-REPAIR] repair error (non-fatal):', err?.message || err));
}

// ---- the repair itself ------------------------------------------------------
/**
 * Selects EXACTLY the stale records of one chat:
 *   session-<chat>.json / session-<chat>.<device>.json
 *   sender-key-<anything>--<chat>--<device>.json  (+ optional device tail)
 * Never matches creds.json, pre-key-*, app-state-*, sender-key-memory-* or
 * any other chat (id boundaries are enforced by the '.'/'--' delimiters).
 * Exported for the offline drill.
 */
export function selectRepairTargets(dir, chat) {
  const safe = String(chat).replace(/[^0-9]/g, '');
  if (!safe || safe.length < 6) return [];
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  const reSession = new RegExp(`^session-${safe}(?:\\.\\d+)?\\.json$`);
  const reSenderKey = new RegExp(`^sender-key-.+--${safe}--\\d+\\.json$`);
  return names.filter(n => reSession.test(n) || reSenderKey.test(n)).sort();
}

function resolveAuthDir() {
  return process.env.REPAIR_AUTH_DIR
    ? path.resolve(process.env.REPAIR_AUTH_DIR)
    : path.resolve('auth_info_baileys');
}

/** Every skip resets that chat's window: only a FRESH storm may re-arm.
 * This is what guarantees backlog floods / connection churn can never spin the
 * repair loop without end. */
function skipRepair(chat, why) {
  failures.delete(chat);
  report(`[SESSION-REPAIR] repair skipped for chat ${chat}: ${why} (failure window reset; a fresh storm re-arms).`);
  return { skipped: why };
}

async function performRepair(chat) {
  const now = Date.now();
  repairInFlight = true;
  try {
    if (state.day !== today(now)) state = { day: today(now), count: 0, chats: state.chats };

    if (inBootGrace()) {
      skipRepair(chat, 'boot grace period not over (backlog-failure protection)');
      return { skipped: 'boot-grace' };
    }
    if (state.count >= PER_DAY_CAP) {
      return skipRepair(chat, `daily repair cap (${PER_DAY_CAP}/day) reached`);
    }
    const last = Number(state.chats[chat]) || 0;
    if (now - last < PER_CHAT_COOLDOWN_MS) {
      return skipRepair(chat, `repaired ${Math.round((now - last) / 60000)} min ago (cooldown active)`);
    }
    if (!runtime.isConnected()) {
      return skipRepair(chat, 'not connected right now');
    }

    const dir = resolveAuthDir();
    const targets = selectRepairTargets(dir, chat);
    if (!targets.length) {
      return skipRepair(chat, 'no stale key files matched this chat');
    }

    // ---- drill mode: describe, but touch nothing ---------------------------
    if (DRY_RUN) {
      report(`[SESSION-REPAIR] DRY-RUN would move ${targets.length} file(s) for chat ${chat}:\n  ${targets.join('\n  ')}`);
      report('[SESSION-REPAIR] DRY-RUN: would DM the owner and exit (live runs only). Nothing was moved.');
      return { dryRun: true, targets };
    }

    // ---- real repair: move (never delete) -> backup dir --------------------
    const stamp = new Date(now).toISOString().replace(/[:T]/g, '-').slice(0, 19);
    const dest = path.join(BACKUP_DIRNAME, `${chat}-${stamp}`);
    fs.mkdirSync(dest, { recursive: true });

    const moved = [];
    const locked = [];
    for (const name of targets) {
      try {
        fs.renameSync(path.join(dir, name), path.join(dest, name));
        moved.push(name);
      } catch { locked.push(name); }
    }
    if (locked.length) {
      skipRepair(chat, `file-locked: ${locked.join(', ')}`);
      return { skipped: 'file-locked', locked };
    }

    // verify: gone from the auth dir, present in the backup dir
    const verified =
      moved.every(n => !fs.existsSync(path.join(dir, n))) &&
      fs.readdirSync(dest).length === moved.length;
    if (!verified) {
      report('[SESSION-REPAIR] warning: move verification mismatch (the live session may have re-created a file).');
    }

    // bookkeeping BEFORE the restart so caps survive the reboot
    state.count += 1;
    state.chats[chat] = now;
    saveState();

    report(`[SESSION-REPAIR] stale session repaired for one chat (${chat}): moved ${moved.length} key file(s) into ${BACKUP_DIRNAME}/${path.basename(dest)} (backup kept, nothing deleted).`);

    const dmOk = await notifyOwner(chat, moved, kindForTargets(moved));

    report(`[SESSION-REPAIR] restarting in ${RESTART_GRACE_MS / 1000} s to reload the session fresh (auto-restart brings the bot back in ~2 min; its beacon DM will confirm).`);
    shuttingDown = true;
    setTimeout(() => process.exit(0), RESTART_GRACE_MS);
    return { moved, backupDir: dest, dmOk, verified };
  } finally {
    repairInFlight = false;
  }
}

function kindForTargets() {
  return 'Bad MAC / key-counter decryption failures';
}

async function notifyOwner(chat, moved, kind) {
  if (typeof runtime.sendOwnerBeacon !== 'function') return false;
  const text =
    '🛠️ *Auto session repair performed*\n\n' +
    `One chat (id ${chat}) could not be decrypted: repeated ${kind} ` +
    `(${STORM_THRESHOLD}+ in 10 minutes) - its locally stored session keys were stale.\n\n` +
    'What I did (reversible - nothing was deleted):\n' +
    `• Moved ${moved.length} stale key file(s) for that chat into ${BACKUP_DIRNAME}/ (kept as backup)\n` +
    '• Restarting now to load fresh session keys - back online in ~2 minutes.\n\n' +
    'If this repeats on different days, it is WhatsApp rotating keys faster than an unofficial client can track:\n' +
    '👉 node pair.mjs restore  (brings back the last healthy session)\n' +
    'or relink the device once with a fresh QR scan.';
  try {
    await runtime.sendOwnerBeacon(text, true); // force: bypass the beacon throttle
    return true;
  } catch (err) {
    report('[SESSION-REPAIR] owner DM failed (non-fatal):', err?.message || err);
    return false;
  }
}

// ---- install ----------------------------------------------------------------
/** Wraps console.error so libsignal decrypt failures feed the detector.
 * Idempotent; everything else passes through unchanged. */
export function installDecryptObserver() {
  if (installed) return;
  installed = true;
  origError = console.error;
  console.error = function patchedError(...args) {
    try {
      if (observeConsoleError(args)) return;
    } catch { /* fall through and print the original line */ }
    origError(...args);
  };
  if (DRY_RUN) {
    report('[SESSION-REPAIR] module active (DRY-RUN drill: simulations only, nothing moves).');
  } else {
    report(`[SESSION-REPAIR] decrypt-failure watch active - boot grace ${Math.round(BOOT_GRACE_MS / 60000)} min; storms repair themselves automatically.`);
    // one-time gate close: drop any pre-grace backlog echoes so a stale
    // window can never arm on its own after the grace
    setTimeout(() => {
      failures.clear();
      report('[SESSION-REPAIR] boot grace over - live decrypt failures are counted from now on.');
    }, BOOT_GRACE_MS + 1000);
  }
}

// ---- offline drill hooks ----------------------------------------------------
export function __drillSimulateFailure(chat) {
  if (process.env.REPAIR_DRY_RUN !== '1') {
    throw new Error('simulation requires REPAIR_DRY_RUN=1');
  }
  pushFailure(chat);
  const n = failuresInWindow(chat);
  if (n >= STORM_THRESHOLD) maybeArm(chat);
  return n;
}

export function __drillOverrideBoot(offsetMs) {
  if (process.env.REPAIR_DRY_RUN !== '1') {
    throw new Error('boot override requires REPAIR_DRY_RUN=1');
  }
  bootAnchor = Date.now() + offsetMs;
}

export function __drillPeek(chat) {
  return failuresInWindow(chat);
}

export function __drillArmed() {
  return armed;
}
