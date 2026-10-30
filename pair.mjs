// pair.mjs - log out the current session or show a QR for a NEW WhatsApp number
//
// Usage:
//   node pair.mjs logout   -> best-effort server-side unlink of the current session
//   node pair.mjs qr       -> print QR for a new number and save its session
//
// The main bot MUST be stopped first (Pair-New-Number.bat does this for you).
// The socket config mirrors src/whatsapp/bot.js exactly (same fingerprint),
// so the session this tool pairs behaves identically when the real bot starts.
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from '@whiskeysockets/baileys';
import pino from 'pino';
import path from 'node:path';
import fs from 'node:fs';
import qrcode from 'qrcode-terminal';

const mode = process.argv[2] || 'qr';
const authDir = path.resolve('auth_info_baileys');

// ---- restore: put the newest healthy session snapshot back into place ----
if (mode === 'restore') {
  const SNAP_ROOT = path.resolve('data', 'auth_snapshots');
  const CUR = path.resolve('auth_info_baileys');
  const snaps = fs.existsSync(SNAP_ROOT)
    ? fs.readdirSync(SNAP_ROOT).filter(n => n.startsWith('session-')).sort()
    : [];
  const latest = snaps[snaps.length - 1];
  if (!latest) {
    console.log('ℹ️  No session snapshots found - nothing to restore.');
    console.log('   Snapshots are created automatically each time the bot connects.');
    process.exit(1);
  }
  if (fs.existsSync(CUR)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.renameSync(CUR, `${CUR}_broken_${stamp}`);
    console.log(`📦 Current session folder moved aside (auth_info_baileys_broken_${stamp}).`);
  }
  fs.cpSync(path.join(SNAP_ROOT, latest), CUR, { recursive: true });
  console.log(`✅ Restored the newest healthy snapshot (${latest}) into auth_info_baileys.`);
  console.log('👉 Start the bot now with Start-Classroom-Bot.bat - it should');
  console.log('   reconnect WITHOUT any QR scan (no re-login needed).');
  process.exit(0);
}

const { state, saveCreds } = await useMultiFileAuthState(authDir);
const { version } = await fetchLatestBaileysVersion();

const sock = makeWASocket({
  version,
  auth: state,
  logger: pino({ level: 'silent' }),
  printQRInTerminal: false
});

sock.ev.on('creds.update', saveCreds);

let finished = false;
const finish = (code = 0) => {
  if (finished) return;
  finished = true;
  try { sock.end?.(undefined); } catch { /* socket may already be dead */ }
  setTimeout(() => process.exit(code), 800);
};

// Safety timer: never orphan this tool waiting for a scan forever
setTimeout(() => {
  if (!finished) {
    console.log('\n⏱️  No scan / no connection within 3 minutes. Exiting (nothing broken).');
    console.log('   The QR refreshes on its own - just re-run the bat and try again.');
    finish(0);
  }
}, 180000);

sock.ev.on('connection.update', async (update) => {
  const { connection, lastDisconnect, qr } = update;

  if (qr) {
    console.log('\n📱 On the NEW phone: WhatsApp > Settings > Linked devices > Link a device;\n   then scan this QR:\n');
    qrcode.generate(qr, { small: true });
  }

  if (connection === 'open') {
    const me = sock.user?.id || 'unknown';
    console.log(`\n✅ Linked successfully as ${me}`);
    if (mode === 'logout') {
      console.log('🚪 Logging THIS session out (unlinking from the old account)...');
      try {
        await sock.logout();
        console.log('✅ Old session unlinked server-side.');
      } catch (e) {
        console.log(`ℹ️  Could not complete server-side unlink: ${e?.message || e}`);
        console.log('   If the old phone still shows the PC entry under Linked devices,');
        console.log('   remove it there manually: WhatsApp > Settings > Linked devices.');
      }
      finish(0);
      return;
    }
    console.log('👉 Session saved. You can now start the bot with Start-Classroom-Bot.bat');
    finish(0);
    return;
  }

  if (connection === 'close') {
    const statusCode = lastDisconnect?.error?.output?.statusCode;

    if (mode === 'logout' && (statusCode === DisconnectReason.loggedOut || statusCode === 401)) {
      console.log('ℹ️  Stored session is already dead server-side - nothing left to unlink.');
      console.log('   If the OLD phone still lists this PC under WhatsApp > Linked devices,');
      console.log('   open it there and log that entry out manually.');
      finish(0);
      return;
    }
    if (mode === 'qr') {
      console.log(`🔌 Connection closed (status ${statusCode}). Exiting - run the bat again if needed.`);
      console.log('💡 Tip: if the QR keeps failing or the bot later goes silent,');
      console.log('   try: node pair.mjs restore   (brings back the last healthy session).');
      finish(0);
      return;
    }
  }
});
