import fs from 'fs';
import path from 'path';
import net from 'net';
import { CREDENTIALS_PATH, TOKEN_PATH } from './google/auth.js';
import { initWhatsAppBot } from './whatsapp/bot.js';
import { startScheduler } from './scheduler/reminders.js';

// Global error handlers to prevent unhandled socket disconnect crashes
process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason);
  if (msg.includes('Connection Closed') || msg.includes('Bad MAC')) {
    // Normal transient WhatsApp connection events; already handled in bot.js
    return;
  }
  console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  const msg = err?.message || String(err);
  if (msg.includes('Connection Closed') || msg.includes('Bad MAC')) {
    return;
  }
  console.error('Uncaught Exception:', err);
});

/**
 * Ensures only ONE instance of the bot runs at a time.
 * If another instance is already running, this immediately notifies the user and exits cleanly.
 */
function acquireSingleInstanceLock(port = 48591) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error('\n====================================================');
        console.error('⚠️  ANOTHER BOT INSTANCE IS ALREADY RUNNING!');
        console.error('====================================================');
        console.error('Another window or background process is already running this bot.');
        console.error('Running two instances at once causes WhatsApp connection conflict (Status 440).');
        console.error('👉 Please close your other terminal window before starting a new one.\n');
        process.exit(0);
      }
      resolve(server);
    });
    server.once('listening', () => {
      resolve(server);
    });
    server.listen(port, '127.0.0.1');
  });
}

async function main() {
  // 1. Check for single instance
  await acquireSingleInstanceLock();

  console.log('====================================================');
  console.log('    🚀 Starting WhatsApp Classroom Assistant 🚀     ');
  console.log('====================================================\n');

  // 2. Verify Google Credentials
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error('❌ Missing "credentials.json" in root directory.');
    console.log('👉 Please download your OAuth 2.0 Client credentials from Google Cloud Console and place it as "credentials.json".');
    console.log('👉 Refer to README.md for step-by-step instructions.\n');
    process.exit(1);
  }

  if (!fs.existsSync(TOKEN_PATH)) {
    console.error('❌ Missing "token.json" (Authorization required).');
    console.log('👉 Please run "npm run auth" to link your Google Classroom account first.\n');
    process.exit(1);
  }

  // 3. Initialize WhatsApp Bot
  console.log('📲 Initializing WhatsApp connection...');
  await initWhatsAppBot();

  // 4. Start silent background reminder scheduler
  startScheduler();

  console.log('🤖 Bot is online! Automated deadline reminders are active.');
  console.log('👉 Type !help, !due, or !recent in WhatsApp to interact.\n');
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
});
