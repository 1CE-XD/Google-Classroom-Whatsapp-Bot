import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import path from 'path';
import { db } from '../storage/db.js';
import { getUpcomingAssignments, getRecentCourseMaterials, downloadDriveFile, formatDateTime } from '../google/classroom.js';
import { askGemini, clearChatHistory } from '../ai/gemini.js';

let sock = null;
let botJid = null;
let cachedFiles = []; // In-memory cache of recent files for !get <number>

export async function initWhatsAppBot() {
  const authDir = path.resolve('auth_info_baileys');
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }), // Set to 'info' for debugging
    printQRInTerminal: false,
    generateHighQualityLinkPreview: true
  });

  // Handle credentials updates
  sock.ev.on('creds.update', saveCreds);

  // Handle connection updates
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n📱 Scan this QR code in WhatsApp (Linked Devices > Link a Device):\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`🔌 WhatsApp Connection closed (status: ${statusCode}). Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) {
        initWhatsAppBot();
      }
    } else if (connection === 'open') {
      botJid = sock.user.id.replace(/:.*@/, '@'); // Normalize bot JID
      console.log(`\n✅ WhatsApp Bot connected successfully as ${sock.user.name || sock.user.id}!`);
      console.log(`🤖 Bot JID: ${botJid}\n`);
    }
  });

  // Handle incoming messages
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;

      // Unwrap ephemeral or view-once messages
      const messageContent =
        msg.message.ephemeralMessage?.message ||
        msg.message.viewOnceMessage?.message ||
        msg.message.viewOnceMessageV2?.message ||
        msg.message;

      // Extract text content
      const text = (
        messageContent.conversation ||
        messageContent.extendedTextMessage?.text ||
        messageContent.imageMessage?.caption ||
        ''
      ).trim();

      if (!text) continue;

      const remoteJid = msg.key.remoteJid;
      const isGroup = remoteJid.endsWith('@g.us');

      // Check if command starts with a supported prefix
      const hasCommandPrefix = /^[!/.#](help|commands|menu|due|assignments|recent|files|materials|get|download|file|ai|ask|gemini|reset|clear|subscribe|unsubscribe|status)/i.test(text);

      // In groups, check if bot is mentioned
      const mentionedJids = messageContent.extendedTextMessage?.contextInfo?.mentionedJid || [];
      const isMentioned = botJid && mentionedJids.some(jid => jid.includes(botJid.split('@')[0]));

      // 1. Direct Messages (1-on-1 personal chats):
      // NEVER reply to personal chats, friends, or anyone else in DMs!
      // Only the bot owner testing with their own number using a command prefix is allowed.
      if (!isGroup) {
        if (!msg.key.fromMe || !hasCommandPrefix) {
          continue; // 100% silent to all incoming messages from friends/contacts!
        }
      }

      // 2. Groups:
      // Must have an explicit command prefix (!due, !recent, !ai) OR the bot must be explicitly @tagged
      if (isGroup) {
        if (!isMentioned && !hasCommandPrefix) {
          continue; // 100% silent during normal group conversations!
        }

        // Group Permission Check:
        // Group members can only use the bot if the owner has authorized the group using !subscribe
        const isPermitted = db.isSubscribed(remoteJid);
        const isActivating = /^[!/.#](subscribe)/i.test(text);

        if (!isPermitted && !isActivating) {
          // If group is not authorized yet, stay silent (only owner can activate)
          if (!msg.key.fromMe) {
            continue; // Ignore completely until owner runs !subscribe
          }
        }
      }

      console.log(`📩 Incoming command: "${text}" from ${isGroup ? 'Group ' + remoteJid : remoteJid}`);
      await handleCommand(remoteJid, text, isGroup, msg);
    }
  });

  return sock;
}

/**
 * Handle incoming bot commands
 */
async function handleCommand(remoteJid, rawText, isGroup, originalMsg) {
  // Normalize text by removing bot mention tags
  const cleanText = rawText.replace(/@\d+/g, '').trim().toLowerCase();
  const command = cleanText.split(/\s+/)[0].replace(/^[!/.#]/, '');

  try {
    switch (command) {
      case 'help':
      case 'commands':
      case 'menu': {
        const helpMessage = `📚 *Google Classroom & AI Study Assistant* 📚

Here are the available commands:

📌 *!due* or *!assignments*
View upcoming assignments, deadlines, and direct submission links.

📁 *!recent* or *!files*
View recently uploaded materials, lecture files, and announcements.

📥 *!get <number>* or *!download <number>*
Download and send the actual PDF/document directly into this WhatsApp chat!

🤖 *!ai <question>* or tag *@bot <question>*
Ask Gemini AI with conversational memory (it remembers previous context!).

🧹 *!clear* or *!reset*
Clear AI conversation memory to start a fresh topic.

🔔 *!subscribe*
Enable deadline reminders in this group (alerted only at 24h & 2h before due time).

🔕 *!unsubscribe*
Disable deadline reminders in this group.

ℹ️ *!status*
Check bot connection status.`;

        await sendMessage(remoteJid, helpMessage, originalMsg);
        break;
      }

      case 'due':
      case 'assignments': {
        await sendMessage(remoteJid, '⏳ Fetching upcoming assignments from Google Classroom...', originalMsg);
        const assignments = await getUpcomingAssignments();

        if (assignments.length === 0) {
          await sendMessage(remoteJid, '🎉 *No upcoming assignments found!* Everything is clear.', originalMsg);
          return;
        }

        let reply = `📝 *Upcoming Assignments (${assignments.length})*:\n\n`;
        const now = new Date();

        assignments.slice(0, 8).forEach((a, index) => {
          const diffMs = a.deadline - now;
          const diffHours = Math.round(diffMs / (1000 * 60 * 60));
          const diffDays = Math.floor(diffHours / 24);

          let timeLeft = '';
          if (diffDays > 1) {
            timeLeft = `(in ${diffDays} days)`;
          } else if (diffHours > 0) {
            timeLeft = `(in ${diffHours} hours)`;
          } else {
            timeLeft = `(⚠️ Due very soon!)`;
          }

          reply += `*${index + 1}. ${a.title}*\n`;
          reply += `📖 *Course:* ${a.courseName}\n`;
          if (a.postedAt) {
            reply += `📅 *Posted:* ${formatDateTime(a.postedAt)}\n`;
          }
          reply += `⏰ *Due:* ${formatDateTime(a.deadline)} ${timeLeft}\n`;
          if (a.description) {
            reply += `💬 _${a.description.trim()}_\n`;
          }
          if (a.alternateLink) {
            reply += `🔗 *Link:* ${a.alternateLink}\n`;
          }
          if (a.materials && a.materials.length > 0) {
            reply += `📎 *Files:* ${a.materials.map(m => m.title).join(', ')}\n`;
          }
          reply += `\n`;
        });

        await sendMessage(remoteJid, reply.trim(), originalMsg);
        break;
      }

      case 'recent':
      case 'files':
      case 'materials': {
        await sendMessage(remoteJid, '⏳ Checking uploads from the past 1 month in Classroom...', originalMsg);
        const recentItems = await getRecentCourseMaterials(720); // Last 30 days (1 month)

        if (recentItems.length === 0) {
          await sendMessage(remoteJid, '📂 No files or announcements found from the past month.', originalMsg);
          return;
        }

        cachedFiles = [];
        let fileCounter = 1;

        // Build numbered cache of downloadable files
        recentItems.forEach((item) => {
          if (item.files && item.files.length > 0) {
            item.files.forEach(f => {
              if (f.id && !cachedFiles.some(c => c.id === f.id)) {
                cachedFiles.push({
                  index: fileCounter++,
                  id: f.id,
                  title: f.title,
                  courseName: item.courseName,
                  url: f.url
                });
              }
            });
          }
        });

        let reply = `📂 *Classroom Uploads & Materials (Past 1 Month)*:\n\n`;
        recentItems.slice(0, 10).forEach((item) => {
          reply += `📖 *Course:* ${item.courseName}\n`;
          reply += `📌 *${item.title}*\n`;
          if (item.time) {
            reply += `📅 *Posted:* ${formatDateTime(item.time)}\n`;
          }
          if (item.deadline) {
            reply += `⏰ *Due:* ${formatDateTime(item.deadline)}\n`;
          }
          if (item.description) {
            reply += `💬 _${item.description.trim()}_\n`;
          }
          if (item.alternateLink) {
            reply += `🔗 *Link:* ${item.alternateLink}\n`;
          }
          if (item.files && item.files.length > 0) {
            reply += `📎 *Files:*\n`;
            item.files.forEach(f => {
              const cached = cachedFiles.find(c => c.id === f.id);
              if (cached) {
                reply += `   [${cached.index}] 📄 *${f.title}*\n`;
              } else {
                reply += `   • 🔗 ${f.title}\n`;
              }
            });
          }
          reply += `\n`;
        });

        if (cachedFiles.length > 0) {
          reply += `💡 *To receive any file directly here in WhatsApp:*\n` +
            `👉 Type *!get 1* or *!get 2* (using the [number] above)!`;
        }

        await sendMessage(remoteJid, reply.trim(), originalMsg);
        break;
      }

      case 'get':
      case 'download':
      case 'file': {
        const query = cleanText.replace(/^[!/.#]?(get|download|file)\s*/i, '').trim();

        if (!query) {
          await sendMessage(
            remoteJid,
            '❓ Please specify which file number to download. Example:\n👉 *!get 1*\n*(Type !recent first to see available file numbers)*',
            originalMsg
          );
          return;
        }

        let targetFile = null;

        // Check if user specified a file number (e.g. !get 1 or !get [1])
        const matchNum = query.match(/\d+/);
        if (matchNum) {
          const fileNum = parseInt(matchNum[0], 10);
          targetFile = cachedFiles.find(f => f.index === fileNum);
          if (!targetFile && cachedFiles.length === 0) {
            await sendMessage(remoteJid, '⏳ Please type *!recent* first to fetch the file list, then type *!get <number>*.', originalMsg);
            return;
          }
        }

        // Or if user provided a Google Drive link or file ID
        if (!targetFile) {
          const match = query.match(/\/d\/([a-zA-Z0-9_-]+)/) || query.match(/id=([a-zA-Z0-9_-]+)/);
          const fileId = match ? match[1] : (query.length > 20 && !query.includes(' ') ? query : null);
          if (fileId) {
            targetFile = { id: fileId, title: 'Classroom Document', courseName: 'Classroom' };
          }
        }

        if (!targetFile) {
          await sendMessage(remoteJid, `❌ Could not find file [${query}]. Type *!recent* to see available files and their numbers.`, originalMsg);
          return;
        }

        await sendMessage(remoteJid, `⏳ Downloading "*${targetFile.title}*" from Google Drive... Please wait.`, originalMsg);

        try {
          const fileData = await downloadDriveFile(targetFile.id, targetFile.title);

          console.log(`📤 Sending document "${fileData.fileName}" (${Math.round(fileData.size / 1024)} KB) to ${remoteJid}...`);

          await sock.sendMessage(
            remoteJid,
            {
              document: fileData.buffer,
              fileName: fileData.fileName,
              mimetype: fileData.mimeType,
              caption: `📄 *${fileData.fileName}*\n📖 Course: ${targetFile.courseName || 'Classroom'}`
            },
            { quoted: originalMsg }
          );
        } catch (downloadErr) {
          console.error('File download failed:', downloadErr);
          if (downloadErr.message?.includes('insufficient') || downloadErr.message?.includes('Permission')) {
            await sendMessage(
              remoteJid,
              `⚠️ *Drive Access Required:* To download files, the bot needs Google Drive access.\n👉 Please run *npm run auth* in your terminal once to authorize Drive download.`,
              originalMsg
            );
          } else {
            await sendMessage(remoteJid, `❌ Failed to download file: ${downloadErr.message}`, originalMsg);
          }
        }
        break;
      }


      case 'subscribe': {
        if (!isGroup) {
          await sendMessage(remoteJid, 'ℹ️ The *!subscribe* command is intended for WhatsApp groups.', originalMsg);
          return;
        }
        if (!originalMsg.key.fromMe) {
          await sendMessage(remoteJid, '🔒 *Permission Denied:* Only the bot owner can activate the bot in this group.', originalMsg);
          return;
        }
        const added = db.addSubscriber(remoteJid);
        if (added) {
          await sendMessage(remoteJid, '✅ *Bot activated in this group!* Group members can now use !due, !recent, !get, and !ai.', originalMsg);
        } else {
          await sendMessage(remoteJid, 'ℹ️ This group is already activated.', originalMsg);
        }
        break;
      }

      case 'unsubscribe': {
        if (!originalMsg.key.fromMe) {
          await sendMessage(remoteJid, '🔒 *Permission Denied:* Only the bot owner can deactivate the bot in this group.', originalMsg);
          return;
        }
        const removed = db.removeSubscriber(remoteJid);
        if (removed) {
          await sendMessage(remoteJid, '🔕 *Bot deactivated in this group.*', originalMsg);
        } else {
          await sendMessage(remoteJid, 'ℹ️ This group was not active.', originalMsg);
        }
        break;
      }

      case 'status': {
        const subscribed = isGroup ? db.isSubscribed(remoteJid) : null;
        let reply = `🤖 *Bot Status*\n` +
          `• Connection: ✅ Active & Ready\n`;
        if (isGroup) {
          reply += `• Group Permissions: ${subscribed ? '🟢 Activated' : '🔴 Deactivated (owner must type !subscribe)'}`;
        }
        await sendMessage(remoteJid, reply, originalMsg);
        break;
      }

      case 'reset':
      case 'clear': {
        clearChatHistory(remoteJid);
        await sendMessage(remoteJid, '🧹 *AI conversation memory cleared!* You can now start a fresh topic.', originalMsg);
        break;
      }

      case 'ai':
      case 'ask':
      case 'gemini': {
        const question = rawText.replace(/^[!/.#]?(ai|ask|gemini)\s*/i, '').trim();
        if (!question) {
          await sendMessage(
            remoteJid,
            '❓ Please provide a question! Example:\n👉 *!ai How do I implement AVL tree deletion in C++?*',
            originalMsg
          );
          return;
        }

        await sendMessage(remoteJid, '🤖 *Gemini is thinking...*', originalMsg);
        const reply = await askGemini(question, remoteJid);
        await sendMessage(remoteJid, reply, originalMsg);
        break;
      }

      default: {
        // If explicitly @mentioned in a group with a natural question, ask Gemini!
        if (isMentioned) {
          const question = rawText.replace(/@\d+/g, '').replace(/^[!/.#]/, '').trim();
          if (question.length > 3) {
            await sendMessage(remoteJid, '🤖 *Gemini is thinking...*', originalMsg);
            const reply = await askGemini(question, remoteJid);
            await sendMessage(remoteJid, reply, originalMsg);
          }
        }
        // Do NOT reply to unrecognized messages or normal chatting!
        break;
      }
    }
  } catch (err) {
    console.error(`Error processing command "${command}":`, err);
    await sendMessage(remoteJid, `❌ *Error:* ${err.message}`, originalMsg);
  }
}

/**
 * Send a WhatsApp text message (optionally quoting original)
 */
export async function sendMessage(jid, text, quoteMsg = null) {
  if (!sock) {
    console.error('Cannot send message: WhatsApp socket is not initialized');
    return;
  }
  try {
    const shouldQuote = quoteMsg && !quoteMsg.key?.fromMe;
    return await sock.sendMessage(jid, { text }, shouldQuote ? { quoted: quoteMsg } : {});
  } catch (err) {
    console.warn('Quoted send failed, falling back to plain message:', err.message);
    return await sock.sendMessage(jid, { text });
  }
}

export function getSocket() {
  return sock;
}
