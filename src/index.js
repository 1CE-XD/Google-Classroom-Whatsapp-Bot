import fs from 'fs';
import path from 'path';
import { CREDENTIALS_PATH, TOKEN_PATH } from './google/auth.js';
import { initWhatsAppBot } from './whatsapp/bot.js';
import { startScheduler } from './scheduler/reminders.js';

async function main() {
  console.log('====================================================');
  console.log('    🚀 Starting WhatsApp Classroom Assistant 🚀     ');
  console.log('====================================================\n');

  // 1. Verify Google Credentials
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

  // 2. Initialize WhatsApp Bot
  console.log('📲 Initializing WhatsApp connection...');
  await initWhatsAppBot();

  // 3. Start silent background reminder scheduler
  startScheduler();

  console.log('🤖 Bot is online! Automated deadline reminders are active.');
  console.log('👉 Type !help, !due, or !recent in WhatsApp to interact.\n');
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
});
