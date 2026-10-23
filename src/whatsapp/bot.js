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
import {
  getUpcomingAssignments,
  getRecentCourseMaterials,
  getAllCourseDocuments,
  downloadDriveFile,
  formatDateTime,
  getCoursesList,
  findCourseByQuery,
  getClassroomContextSummary
} from '../google/classroom.js';
import { askGemini, clearChatHistory, getModelsListText, setPreferredModel, getPreferredModel } from '../ai/gemini.js';

let sock = null;
let botJid = null;
let cachedFiles = []; // Fallback in-memory cache of recent files
const chatCachedFiles = new Map(); // Per-chat document cache: Map<remoteJid, Array<{ index, id, title, courseName }>>

function setChatFiles(jid, files) {
  chatCachedFiles.set(jid, files);
  cachedFiles = files;
}

function getChatFiles(jid) {
  return chatCachedFiles.get(jid) || cachedFiles || [];
}

const unactivatedGroupWarned = new Set(); // Tracks unactivated groups that received the one-time warning

// Rolling in-memory message buffer for group chats (tracks recent messages for !summarize)
const groupChatBuffers = new Map(); // Map<groupJid, Array<{ sender: string, text: string, time: string }>>
const MAX_GROUP_BUFFER = 100;

function bufferGroupMessage(groupJid, msgObj) {
  if (!groupChatBuffers.has(groupJid)) {
    groupChatBuffers.set(groupJid, []);
  }
  const buffer = groupChatBuffers.get(groupJid);
  buffer.push(msgObj);
  if (buffer.length > MAX_GROUP_BUFFER) {
    buffer.shift();
  }
}

export function getGroupMessages(groupJid, limit = 100) {
  const buffer = groupChatBuffers.get(groupJid) || [];
  return buffer.slice(-limit);
}

// Anti-Spam / Rate Limiting per user (5 commands per 15s window)
const userCooldowns = new Map();
const RATE_LIMIT_WINDOW_MS = 15000;
const MAX_COMMANDS_PER_WINDOW = 5;

/**
 * Checks if the message sender is the bot owner
 */
export function isOwner(msg) {
  if (!msg) return false;
  if (msg.key?.fromMe) return true;

  // Bot's own session ID and LID
  const botNumber = sock?.user?.id?.replace(/[^0-9]/g, '') || 'REDACTED_NUMBER';
  const botLid = sock?.user?.lid?.replace(/[^0-9]/g, '') || 'REDACTED_LID';

  // Configured owner numbers from .env (supports comma-separated list)
  const envOwners = (process.env.OWNER_NUMBER || 'REDACTED_NUMBER')
    .split(',')
    .map(n => n.replace(/[^0-9]/g, ''))
    .filter(Boolean);

  const allowedIds = new Set([botNumber, botLid, ...envOwners]);

  const senderJid = msg.key?.participant || msg.key?.remoteJid || '';
  const cleanSender = senderJid.replace(/[^0-9]/g, '');

  if (cleanSender) {
    for (const id of allowedIds) {
      if (cleanSender.includes(id) || id.includes(cleanSender)) return true;
    }
  }
  return false;
}

/**
 * In-memory rate limiter to prevent spam attacks and chat flooding
 */
function checkRateLimit(senderJid, isOwnerUser) {
  if (isOwnerUser) return { allowed: true }; // Owner is never throttled

  const now = Date.now();
  let record = userCooldowns.get(senderJid);

  if (!record || now > record.resetTime) {
    record = { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS, warned: false };
    userCooldowns.set(senderJid, record);
    return { allowed: true };
  }

  record.count++;
  if (record.count > MAX_COMMANDS_PER_WINDOW) {
    const shouldWarn = !record.warned;
    record.warned = true;
    return { allowed: false, shouldWarn };
  }

  return { allowed: true };
}

/**
 * Redact internal file paths, API keys, and secrets from user-facing error messages
 */
export function sanitizeError(err) {
  if (!err) return 'An unexpected error occurred.';
  const msg = typeof err === 'string' ? err : err.message || String(err);
  return msg
    .replace(/key=[A-Za-z0-9_\-]+/gi, 'key=[REDACTED]')
    .replace(/AQ\.[A-Za-z0-9_\-]+/g, '[REDACTED]')
    .replace(/[a-zA-Z0-9_\-]{35,}/g, '[REDACTED]')
    .replace(/[A-Za-z]:\\[^\s]+/g, '[REDACTED_PATH]')
    .replace(/\/[a-zA-Z0-9_.\-\/]+\/[a-zA-Z0-9_.\-]+/g, '[REDACTED_PATH]');
}

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
      const isReplaced = statusCode === DisconnectReason.connectionReplaced;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      const shouldReconnect = !isLoggedOut && !isReplaced;

      console.log(`🔌 WhatsApp Connection closed (status: ${statusCode}). Reconnecting: ${shouldReconnect}`);

      if (isReplaced) {
        console.warn('⚠️ Connection replaced by another session/device. Reconnection halted to prevent loop.');
      } else if (isLoggedOut) {
        console.error('⚠️ Device logged out. Please remove auth_info_baileys and scan QR again.');
      } else if (shouldReconnect) {
        setTimeout(() => {
          initWhatsAppBot().catch(err => console.error('Reconnection error:', err));
        }, 3000);
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

      // Commands MUST start with an explicit prefix (!, /, ., or #) to prevent triggering on normal conversation!
      const commandPattern = /^[!/.#](help|commands|menu|due|assignments|recent|files|materials|docs?|documents?|get|download|file|ai|ask|gemini|reset|clear|subscribe|unsubscribe|status|courses|classes|cls|autosync|sync|models?|summarize|summary)(\s+.*)?$/i;
      const hasCommandPrefix = commandPattern.test(text);

      console.log(`📩 [MSG] from: ${remoteJid} (isGroup: ${isGroup}, prefix: ${hasCommandPrefix}): "${text.slice(0, 50)}"`);

      // In subscribed groups, buffer non-command messages for !summarize (last 100 messages)
      if (isGroup && db.isSubscribed(remoteJid) && !hasCommandPrefix && !msg.key.fromMe) {
        const senderName = msg.pushName || (msg.key.participant ? msg.key.participant.replace(/[^0-9]/g, '').slice(-4) : 'Member');
        bufferGroupMessage(remoteJid, {
          sender: senderName,
          text: text,
          time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })
        });
      }

      // In groups, check if bot is mentioned
      const mentionedJids = messageContent.extendedTextMessage?.contextInfo?.mentionedJid || [];
      const isMentioned = botJid && mentionedJids.some(jid => jid.includes(botJid.split('@')[0]));

      const isSenderOwner = isOwner(msg);

      // 1. Direct Messages (1-on-1 personal chats):
      // Only commands starting with an explicit prefix (!help, !due, !cls, !docs, etc.) are answered.
      // Normal conversations ("hey", "hello", etc.) are 100% ignored so friends/contacts are never disturbed!
      if (!isGroup) {
        if (!hasCommandPrefix) {
          continue; // 100% silent during normal personal conversations
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

        if (!isPermitted) {
          // If group is not authorized yet, non-owners cannot use ANY command.
          // The bot replies ONLY ONCE per group to let them know the owner must activate it first.
          if (!isSenderOwner) {
            if (!unactivatedGroupWarned.has(remoteJid)) {
              unactivatedGroupWarned.add(remoteJid);
              await sendMessage(
                remoteJid,
                '🔒 *Bot Not Activated in this Group*\n\n' +
                'The bot owner must first activate the bot in this group by typing *!subscribe*.\n' +
                '_(Until the owner subscribes, all bot commands are disabled for members)_',
                msg
              );
            }
            continue; // Prior to owner subscription, non-owners cannot run commands!
          }
        }
      }

      // 3. Anti-Spam / Rate Limiting Check:
      const senderJid = msg.key.participant || remoteJid;
      const rateStatus = checkRateLimit(senderJid, isSenderOwner);
      if (!rateStatus.allowed) {
        if (rateStatus.shouldWarn) {
          await sendMessage(
            remoteJid,
            '⚠️ *Slow down:* You are sending requests too quickly. Please wait a few seconds.',
            msg
          );
        }
        continue;
      }

      console.log(`📩 Incoming command: "${text}" from ${isGroup ? 'Group ' + remoteJid : remoteJid} (Sender: ${senderJid}, isOwner: ${isSenderOwner})`);
      await handleCommand(remoteJid, text, isGroup, msg);
    }
  });

  return sock;
}

/**
 * Handle incoming bot commands
 */
async function handleCommand(remoteJid, rawText, isGroup, originalMsg) {
  // Normalize text and extract command & arguments cleanly
  const cleanText = rawText.replace(/@\d+/g, '').trim().toLowerCase();
  const parts = cleanText.split(/\s+/);
  const command = parts[0].replace(/^[!/.#]/, '');
  const commandArgs = parts.slice(1).join(' ').trim();

  try {
    switch (command) {
      case 'help':
      case 'commands':
      case 'menu': {
        const helpMessage = `📚 *Google Classroom & AI Study Assistant* 📚

Here are the available commands:

📚 *!courses* or *!cls*
List all enrolled classrooms. Type *!cls 1* to focus this chat on course 1, or *!cls all* to reset!

📌 *!due* or *!due <number>*
View upcoming assignments and deadlines (focused on active course, or all courses).

📁 *!recent* or *!recent <number>*
View recently posted materials, files, and announcements (focused on active course, or all courses).

📚 *!docs*
List all documents and notes for the selected course (requires *!cls <number>* first).

📥 *!get <number>* or *!get all*
Download documents directly into WhatsApp! Type *!get 1* or *!get all* to download all listed docs.

🔄 *!autosync <number>* or *!autosync all*
(Owner only) Automatically upload any new posts, announcements, and files from a classroom to this group!

🤖 *!ai <question>* or tag *@bot <question>*
Ask AI with conversational memory.

📋 *!summarize* or *!summarize <number>*
Summarize recent group chats and discussions (e.g. *!summarize 50* or *!summarize 100*)!

⚙️ *!models* or *!model <name>*
View & switch free AI models (auto, lite, flash, preview, r1, llama3).

🧹 *!clear* or *!reset*
Clear AI conversation memory to start a fresh topic.

🔔 *!subscribe* / 🔕 *!unsubscribe*
(Owner only) Enable or disable bot notifications in this group.

ℹ️ *!status*
Check bot connection and auto-sync status.`;

        await sendMessage(remoteJid, helpMessage, originalMsg);
        break;
      }

      case 'courses':
      case 'classes':
      case 'cls': {
        const arg = commandArgs;

        // 1. Reset / Clear Selection
        if (arg === 'all' || arg === 'reset' || arg === '0' || arg === 'clear' || arg === 'none') {
          db.clearSelectedCourse(remoteJid);
          await sendMessage(
            remoteJid,
            '🔄 *Classroom selection cleared.* Now *!recent* and *!due* will include all enrolled classrooms by default!',
            originalMsg
          );
          return;
        }

        // 2. Select a specific course if an argument is provided (e.g. !cls 1 or cls 2)
        if (arg) {
          await sendMessage(remoteJid, `⏳ Searching for classroom "${arg}"...`, originalMsg);
          const course = await findCourseByQuery(arg);

          if (!course) {
            await sendMessage(
              remoteJid,
              `❌ *Classroom not found for "${arg}".*\n👉 Type *!cls* or *!courses* to see the list of available classrooms and their numbers.`,
              originalMsg
            );
            return;
          }

          // Save selected course for this chat in db
          db.setSelectedCourse(remoteJid, course.id, course.name, course.index);

          // Fetch quick overview for this selected course
          const [assignments, recentItems] = await Promise.all([
            getUpcomingAssignments(course.id).catch(() => []),
            getRecentCourseMaterials(720, course.id).catch(() => [])
          ]);

          let reply = `✅ *Active Classroom Selected: [${course.index}] ${course.name}* 🎯\n`;
          if (course.section) reply += `_Section: ${course.section}_\n`;
          reply += `\n📌 *From now on in this chat:*\n` +
            `• *!recent* will automatically show uploads for *${course.name}*\n` +
            `• *!due* will automatically show assignments for *${course.name}*\n` +
            `• Type *!cls all* anytime to reset back to all classrooms.\n\n`;

          // Quick status summary for this course
          if (assignments.length > 0) {
            reply += `📝 *Upcoming Deadlines (${assignments.length})*:\n`;
            assignments.slice(0, 3).forEach((a, i) => {
              reply += `  ${i + 1}. ${a.title} (Due: ${formatDateTime(a.deadline)})\n`;
            });
            reply += `\n`;
          } else {
            reply += `🎉 *No upcoming assignments due right now!*\n\n`;
          }

          if (recentItems.length > 0) {
            reply += `📂 *Recent Uploads (${recentItems.length} found)*:\n`;
            recentItems.slice(0, 3).forEach((item) => {
              reply += `  • ${item.title}\n`;
            });
            reply += `\n👉 Type *!recent* to view full details and downloadable files!`;
          } else {
            reply += `📂 No files or posts from the past month for this course.`;
          }

          await sendMessage(remoteJid, reply.trim(), originalMsg);
          return;
        }

        // 3. No argument provided: List all enrolled classrooms
        await sendMessage(remoteJid, '⏳ Fetching enrolled Google Classrooms...', originalMsg);
        const courses = await getCoursesList();

        if (courses.length === 0) {
          await sendMessage(remoteJid, '📂 No active Google Classrooms found for your account.', originalMsg);
          return;
        }

        const currentSelected = db.getSelectedCourse(remoteJid);

        let reply = `📚 *Enrolled Google Classrooms (${courses.length})*:\n\n`;
        courses.forEach((c) => {
          const isSelected = currentSelected && currentSelected.id === c.id;
          reply += `*[${c.index}] ${c.name}* ${isSelected ? '🎯 *(Active in this chat)*' : ''}\n`;
          if (c.section) reply += `   _Section: ${c.section}_\n`;
        });

        if (currentSelected) {
          reply += `\n🎯 *Currently Active:* [${currentSelected.index}] ${currentSelected.name}\n` +
            `_(Commands !recent and !due currently focus on this classroom)_\n`;
        }

        reply += `\n💡 *Classroom Selection & Commands:*\n` +
          `👉 *!cls 1* — Focus this chat on classroom [1] (so *!recent* and *!due* show its updates)\n` +
          `👉 *!cls all* — Clear selection and show all classrooms\n` +
          `👉 *!autosync 1* — (Owner) Auto-upload new posts & files from [1] directly into this group\n` +
          `👉 *!autosync all* — Auto-upload from ALL classrooms to this group`;

        await sendMessage(remoteJid, reply.trim(), originalMsg);
        break;
      }

      case 'due':
      case 'assignments': {
        const query = commandArgs;
        let targetCourse = null;

        if (query) {
          targetCourse = await findCourseByQuery(query);
          if (!targetCourse) {
            await sendMessage(
              remoteJid,
              `❌ *Classroom not found for "${query}".*\n👉 Type *!courses* to see all enrolled classrooms and their numbers.`,
              originalMsg
            );
            return;
          }
        } else {
          // If no query passed, check if there is an active classroom selected for this chat
          const selected = db.getSelectedCourse(remoteJid);
          if (selected) {
            targetCourse = { id: selected.id, name: selected.name, index: selected.index };
          }
        }

        await sendMessage(
          remoteJid,
          targetCourse
            ? `⏳ Fetching upcoming assignments for *${targetCourse.name}*...`
            : '⏳ Fetching upcoming assignments from Google Classroom...',
          originalMsg
        );

        const assignments = await getUpcomingAssignments(targetCourse?.id || null);

        if (assignments.length === 0) {
          await sendMessage(
            remoteJid,
            targetCourse
              ? `🎉 *No upcoming assignments for "${targetCourse.name}"!*`
              : '🎉 *No upcoming assignments found!* Everything is clear.',
            originalMsg
          );
          return;
        }

        let reply = targetCourse
          ? `📝 *Upcoming Assignments for ${targetCourse.name} (${assignments.length})*:\n\n`
          : `📝 *Upcoming Assignments (${assignments.length})*:\n\n`;
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

        if (!targetCourse) {
          reply += `💡 *Tip:* Type *!due 1* or *!due <name>* to filter by a specific classroom!`;
        }

        await sendMessage(remoteJid, reply.trim(), originalMsg);
        break;
      }

      case 'recent':
      case 'files':
      case 'materials': {
        const query = commandArgs;
        let targetCourse = null;

        if (query) {
          targetCourse = await findCourseByQuery(query);
          if (!targetCourse) {
            await sendMessage(
              remoteJid,
              `❌ *Classroom not found for "${query}".*\n👉 Type *!courses* to see all enrolled classrooms and their numbers.`,
              originalMsg
            );
            return;
          }
        } else {
          // If no query passed, check if there is an active classroom selected for this chat
          const selected = db.getSelectedCourse(remoteJid);
          if (selected) {
            targetCourse = { id: selected.id, name: selected.name, index: selected.index };
          }
        }

        await sendMessage(
          remoteJid,
          targetCourse
            ? `⏳ Checking uploads for *${targetCourse.name}* (past month)...`
            : '⏳ Checking uploads from the past 1 month in Classroom...',
          originalMsg
        );

        const recentItems = await getRecentCourseMaterials(720, targetCourse?.id || null);

        if (recentItems.length === 0) {
          await sendMessage(
            remoteJid,
            targetCourse
              ? `📂 No recent uploads found for *${targetCourse.name}*.`
              : '📂 No files or announcements found from the past month.',
            originalMsg
          );
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

        setChatFiles(remoteJid, cachedFiles);

        let reply = targetCourse
          ? `📂 *Uploads for [${targetCourse.index}] ${targetCourse.name}*:\n\n`
          : `📂 *Classroom Uploads & Materials (Past 1 Month)*:\n\n`;

        recentItems.slice(0, 10).forEach((item) => {
          if (!targetCourse) {
            reply += `📖 *Course:* ${item.courseName}\n`;
          }
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
            `👉 Type *!get 1* (using the [number] above) or *!get all* to download everything!\n\n`;
        }

        if (!targetCourse) {
          reply += `💡 *Tip:* Type *!recent 1* or *!recent <name>* to filter by a specific classroom!`;
        }

        await sendMessage(remoteJid, reply.trim(), originalMsg);
        break;
      }

      case 'docs':
      case 'doc':
      case 'documents': {
        const selectedCourse = db.getSelectedCourse(remoteJid);
        if (!selectedCourse) {
          await sendMessage(
            remoteJid,
            '⚠️ *No Classroom Selected!*\n\n' +
            'The *!docs* command lists all documents for a specific course.\n\n' +
            '👉 *Step 1:* Type *!cls* to see all enrolled classrooms with numbers.\n' +
            '👉 *Step 2:* Type *!cls <number>* (e.g. *!cls 1*) to select your course.\n' +
            '👉 *Step 3:* Type *!docs* to list all documents for that course!\n\n' +
            '_(Then use *!get <number>* or *!get all* to download them directly into WhatsApp)_',
            originalMsg
          );
          break;
        }

        await sendMessage(
          remoteJid,
          `⏳ *Fetching all documents for [${selectedCourse.index}] ${selectedCourse.name}...* Please wait.`,
          originalMsg
        );

        try {
          const docs = await getAllCourseDocuments(selectedCourse.id);

          if (!docs || docs.length === 0) {
            await sendMessage(
              remoteJid,
              `📁 *Documents: [${selectedCourse.index}] ${selectedCourse.name}*\n\n` +
              `ℹ️ No downloadable documents found in this classroom.`,
              originalMsg
            );
            break;
          }

          const fileList = docs.map((d, i) => ({
            index: i + 1,
            id: d.id,
            title: d.title,
            courseName: selectedCourse.name,
            category: d.category,
            sourceTitle: d.sourceTitle,
            date: d.date
          }));

          setChatFiles(remoteJid, fileList);

          let reply = `📚 *Documents for [${selectedCourse.index}] ${selectedCourse.name}*\n` +
            `Total documents found: *${fileList.length}*\n\n`;

          fileList.forEach(f => {
            const dateStr = f.date
              ? f.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
              : '';
            reply += `[${f.index}] 📄 *${f.title}*\n`;
            if (f.sourceTitle) {
              reply += `    📌 ${f.category}: ${f.sourceTitle}\n`;
            }
            if (dateStr) {
              reply += `    📅 ${dateStr}\n`;
            }
            reply += `\n`;
          });

          reply += `──────────────────────────────\n` +
            `📥 *How to download:*\n` +
            `👉 Type *!get 1* to download document [1]\n` +
            `👉 Type *!get all* to download ALL ${fileList.length} documents!`;

          await sendMessage(remoteJid, reply.trim(), originalMsg);
        } catch (err) {
          console.error(`Error fetching docs for course ${selectedCourse.name}:`, err);
          await sendMessage(
            remoteJid,
            `❌ *Failed to fetch documents:* ${sanitizeError(err.message)}`,
            originalMsg
          );
        }
        break;
      }

      case 'autosync':
      case 'sync': {
        if (!isGroup) {
          await sendMessage(remoteJid, 'ℹ️ The *!autosync* command is intended for WhatsApp groups.', originalMsg);
          return;
        }

        if (!isOwner(originalMsg)) {
          await sendMessage(remoteJid, '🔒 *Permission Denied:* Only the bot owner can configure auto-sync for groups.', originalMsg);
          return;
        }

        const arg = commandArgs;

        // 1. If no argument provided, display current status
        if (!arg) {
          const currentConfig = db.getGroupAutoSync(remoteJid);
          let statusMsg = `🔄 *Classroom Live Auto-Sync Status*\n\n`;
          if (currentConfig && currentConfig.enabled) {
            statusMsg += `• Status: 🟢 *ACTIVE*\n` +
              `• Target Classroom: *${currentConfig.courseName}*\n` +
              `• Direct File Uploads: ${currentConfig.autoUploadFiles !== false ? '✅ Enabled' : '❌ Disabled'}\n\n` +
              `💡 *To change:* Type *!autosync off* to disable, or *!autosync <number>* to change course.`;
          } else {
            statusMsg += `• Status: 🔴 *DISABLED*\n\n` +
              `💡 *How to activate auto-sync for this group:*\n` +
              `👉 *!autosync all* — Auto-upload updates & files from ALL classrooms\n` +
              `👉 *!autosync 1* — Dedicate this group to classroom [1] (Type *!courses* to see numbers)\n` +
              `👉 *!autosync off* — Turn off auto-sync in this group`;
          }
          await sendMessage(remoteJid, statusMsg, originalMsg);
          return;
        }

        // 2. Turn off auto-sync
        if (arg === 'off' || arg === 'disable' || arg === 'stop') {
          db.removeGroupAutoSync(remoteJid);
          await sendMessage(remoteJid, '🔕 *Live Auto-Sync disabled for this group.*', originalMsg);
          return;
        }

        // 3. Sync all courses
        if (arg === 'all' || arg === 'on' || arg === 'enable') {
          db.addSubscriber(remoteJid);
          db.setGroupAutoSync(remoteJid, {
            enabled: true,
            courseId: null,
            courseName: 'All Classrooms',
            autoUploadFiles: true
          });
          await sendMessage(
            remoteJid,
            '✅ *Auto-Sync Activated for ALL Google Classrooms!* 🚀\n\n' +
            'Whenever teachers post new announcements, texts, assignments, or upload documents/PDFs in any course, the bot will automatically notify and upload the files directly into this WhatsApp group!',
            originalMsg
          );
          return;
        }

        // 4. Sync specific course by number or name
        const course = await findCourseByQuery(arg);
        if (!course) {
          await sendMessage(
            remoteJid,
            `❌ *Classroom not found for "${arg}".*\n👉 Type *!courses* to see all enrolled classrooms and their numbers, then run *!autosync <number>*.`,
            originalMsg
          );
          return;
        }

        db.addSubscriber(remoteJid);
        db.setGroupAutoSync(remoteJid, {
          enabled: true,
          courseId: course.id,
          courseName: `[${course.index}] ${course.name}`,
          autoUploadFiles: true
        });

        await sendMessage(
          remoteJid,
          `✅ *Auto-Sync Dedicated to [${course.index}] ${course.name}!* 🎯\n\n` +
          `Whenever the teacher posts new announcements, homework, or uploads files in *${course.name}*, the bot will automatically post updates and upload the documents directly into this WhatsApp chat!`,
          originalMsg
        );
        break;
      }

      case 'get':
      case 'download':
      case 'file': {
        const query = (commandArgs || '').trim();

        if (!query) {
          await sendMessage(
            remoteJid,
            '❓ Please specify which document number to download, or type *!get all*.\n\n' +
            '👉 *!get 1* — Download document [1]\n' +
            '👉 *!get all* — Download ALL listed documents!\n\n' +
            '*(Type !docs or !recent first to see available documents)*',
            originalMsg
          );
          return;
        }

        const files = getChatFiles(remoteJid);

        // 1. Handle "!get all"
        if (query.toLowerCase() === 'all') {
          if (files.length === 0) {
            await sendMessage(
              remoteJid,
              '⏳ No documents are currently loaded in this chat!\n\n' +
              '👉 *Step 1:* Type *!cls 1* (or your course number) to select a classroom.\n' +
              '👉 *Step 2:* Type *!docs* to list all documents.\n' +
              '👉 *Step 3:* Type *!get all* to download all of them!',
              originalMsg
            );
            return;
          }

          await sendMessage(
            remoteJid,
            `⏳ *Downloading and sending all ${files.length} document(s)... Please wait.*\n` +
            `_(Sending them one by one into this chat)_`,
            originalMsg
          );

          let successCount = 0;
          let failCount = 0;

          for (const targetFile of files) {
            try {
              console.log(`📥 Downloading [${targetFile.index}/${files.length}] "${targetFile.title}"...`);
              const fileData = await downloadDriveFile(targetFile.id, targetFile.title);

              await sock.sendMessage(
                remoteJid,
                {
                  document: fileData.buffer,
                  fileName: fileData.fileName,
                  mimetype: fileData.mimeType,
                  caption: `📄 *[${targetFile.index}] ${fileData.fileName}*\n📖 Course: ${targetFile.courseName || 'Classroom'}`
                },
                { quoted: originalMsg }
              );

              successCount++;
              // Delay 1.2s between sends to prevent WhatsApp rate limits
              await new Promise(r => setTimeout(r, 1200));
            } catch (fileErr) {
              console.error(`Failed to download/send [${targetFile.index}] "${targetFile.title}":`, fileErr.message);
              failCount++;
            }
          }

          await sendMessage(
            remoteJid,
            `✅ *Download Complete!*\nSent *${successCount}* of *${files.length}* document(s) successfully.${failCount > 0 ? ` (${failCount} failed to download)` : ''}`,
            originalMsg
          );
          return;
        }

        // 2. Handle single or multiple numbers (e.g. "!get 1" or "!get 1, 2")
        const matchedNums = query.match(/\d+/g);
        if (matchedNums && matchedNums.length > 0) {
          if (files.length === 0) {
            await sendMessage(
              remoteJid,
              '⏳ Please type *!docs* or *!recent* first to fetch the documents list, then type *!get <number>*.',
              originalMsg
            );
            return;
          }

          const targetIndices = matchedNums.map(n => parseInt(n, 10));
          const targetFiles = targetIndices
            .map(num => files.find(f => f.index === num))
            .filter(Boolean);

          if (targetFiles.length === 0) {
            await sendMessage(
              remoteJid,
              `❌ Document number [${query}] not found.\n👉 Type *!docs* or *!recent* to see available numbers (1 to ${files.length}).`,
              originalMsg
            );
            return;
          }

          for (const targetFile of targetFiles) {
            await sendMessage(
              remoteJid,
              `⏳ Downloading "*${targetFile.title}*" from Google Drive... Please wait.`,
              originalMsg
            );

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

            if (targetFiles.length > 1) {
              await new Promise(r => setTimeout(r, 1200));
            }
          }
          return;
        }

        // 3. Or if user provided a Google Drive link or file ID
        const match = query.match(/\/d\/([a-zA-Z0-9_-]+)/) || query.match(/id=([a-zA-Z0-9_-]+)/);
        const fileId = match ? match[1] : (query.length > 20 && !query.includes(' ') ? query : null);
        if (fileId) {
          const targetFile = { id: fileId, title: 'Classroom Document', courseName: 'Classroom' };
          await sendMessage(remoteJid, `⏳ Downloading document from Google Drive... Please wait.`, originalMsg);
          try {
            const fileData = await downloadDriveFile(targetFile.id, targetFile.title);
            await sock.sendMessage(
              remoteJid,
              {
                document: fileData.buffer,
                fileName: fileData.fileName,
                mimetype: fileData.mimeType,
                caption: `📄 *${fileData.fileName}*`
              },
              { quoted: originalMsg }
            );
          } catch (downloadErr) {
            await sendMessage(remoteJid, `❌ Failed to download file: ${downloadErr.message}`, originalMsg);
          }
          return;
        }

        await sendMessage(
          remoteJid,
          `❌ Could not find document [${query}]. Type *!docs* or *!recent* to see available numbers, or type *!get all*.`,
          originalMsg
        );
        break;
      }


      case 'subscribe': {
        if (!isGroup) {
          await sendMessage(remoteJid, 'ℹ️ The *!subscribe* command is intended for WhatsApp groups.', originalMsg);
          return;
        }
        if (!isOwner(originalMsg)) {
          await sendMessage(remoteJid, '🔒 *Permission Denied:* Only the bot owner can activate the bot in this group.', originalMsg);
          return;
        }
        const added = db.addSubscriber(remoteJid);
        unactivatedGroupWarned.delete(remoteJid);
        if (added) {
          await sendMessage(remoteJid, '✅ *Bot activated in this group!* Group members can now use !due, !recent, !get, !courses, and !ai.', originalMsg);
        } else {
          await sendMessage(remoteJid, 'ℹ️ This group is already activated.', originalMsg);
        }
        break;
      }

      case 'unsubscribe': {
        if (!isOwner(originalMsg)) {
          await sendMessage(remoteJid, '🔒 *Permission Denied:* Only the bot owner can deactivate the bot in this group.', originalMsg);
          return;
        }
        const removed = db.removeSubscriber(remoteJid);
        unactivatedGroupWarned.delete(remoteJid);
        if (removed) {
          await sendMessage(remoteJid, '🔕 *Bot deactivated in this group.*', originalMsg);
        } else {
          await sendMessage(remoteJid, 'ℹ️ This group was not active.', originalMsg);
        }
        break;
      }

      case 'status': {
        const subscribed = isGroup ? db.isSubscribed(remoteJid) : null;
        const autoSync = isGroup ? db.getGroupAutoSync(remoteJid) : null;
        const selected = db.getSelectedCourse(remoteJid);
        let reply = `🤖 *Bot Status*\n` +
          `• Connection: ✅ Active & Ready\n`;
        if (isGroup) {
          reply += `• Group Permissions: ${subscribed ? '🟢 Activated' : '🔴 Deactivated (owner must type !subscribe)'}\n`;
          reply += `• Live Auto-Sync: ${autoSync && autoSync.enabled ? `🟢 Active (${autoSync.courseName})` : '🔴 Inactive (type !autosync)'}\n`;
        }
        reply += `• Active Classroom: ${selected ? `🎯 [${selected.index}] ${selected.name}` : '🌐 All Classrooms (type !cls <num> to focus)'}\n`;
        await sendMessage(remoteJid, reply.trim(), originalMsg);
        break;
      }

      case 'reset':
      case 'clear': {
        clearChatHistory(remoteJid);
        await sendMessage(remoteJid, '🧹 *AI conversation memory cleared!* You can now start a fresh topic.', originalMsg);
        break;
      }

      case 'summarize':
      case 'summary': {
        if (!isGroup) {
          await sendMessage(remoteJid, 'ℹ️ The *!summarize* command is intended for WhatsApp groups to summarize discussions!', originalMsg);
          break;
        }

        let count = 50;
        if (commandArgs) {
          const parsed = parseInt(commandArgs, 10);
          if (!isNaN(parsed) && parsed > 0) {
            count = Math.min(parsed, 100);
          }
        }

        const messages = getGroupMessages(remoteJid, count);
        if (messages.length < 3) {
          await sendMessage(
            remoteJid,
            `⏳ *Not enough messages recorded yet!*\n\n` +
            `I have buffered ${messages.length} message(s) in this group so far.\n` +
            `As members chat, I maintain a rolling log of the last 100 messages. Type *!summarize* anytime once people have had a conversation!`,
            originalMsg
          );
          break;
        }

        await sendMessage(remoteJid, `📋 *Analyzing the last ${messages.length} group messages...*`, originalMsg);

        const formattedLog = messages
          .map(m => `[${m.time}] ${m.sender}: ${m.text}`)
          .join('\n');

        const prompt =
          `You are an AI assistant summarizing recent messages from a student WhatsApp group chat.\n\n` +
          `Here is the chronological transcript of the last ${messages.length} messages:\n` +
          `--- BEGIN CHAT LOG ---\n` +
          `${formattedLog}\n` +
          `--- END CHAT LOG ---\n\n` +
          `Please provide a structured, easy-to-read summary with markdown bullet points:\n` +
          `1. 📌 *Main Topics Discussed*\n` +
          `2. 🎯 *Decisions or Conclusions* (if any)\n` +
          `3. ❓ *Key Questions or Doubts Raised* (if any)\n` +
          `4. 📝 *Action Items or Announcements* (if any)\n\n` +
          `Tone: Clear, objective, and friendly. Match the language of the conversation (if the chat was in Hinglish, respond in natural Hinglish; if English, respond in English).`;

        const summary = await askGemini(prompt, remoteJid, '');
        await sendMessage(
          remoteJid,
          `📋 *Group Chat Summary (${messages.length} Messages)*\n\n${summary}`,
          originalMsg
        );
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

        // Check if user is asking to analyze or summarize past group chats
        const isGroupSummaryRequest = isGroup && /\b(past|recent|group|grp)\b.*\b(chat|chats|conversation|msgs?|messages)\b/i.test(question);
        if (isGroupSummaryRequest) {
          const messages = getGroupMessages(remoteJid, 100);
          if (messages.length < 3) {
            await sendMessage(
              remoteJid,
              `⏳ *Not enough messages recorded yet!*\n\n` +
              `I only have ${messages.length} message(s) buffered in this group so far.\n` +
              `As members chat in this group, I continuously log the last 100 messages. You can type *!summarize* or *!ai summarize* anytime!`,
              originalMsg
            );
            return;
          }

          await sendMessage(remoteJid, `🤖 *Analyzing recent group conversation (${messages.length} messages)...*`, originalMsg);
          const formattedLog = messages
            .map(m => `[${m.time}] ${m.sender}: ${m.text}`)
            .join('\n');

          const prompt =
            `The user asked: "${question}"\n\n` +
            `Below is the chronological transcript of the last ${messages.length} messages from this group chat:\n` +
            `--- BEGIN CHAT LOG ---\n` +
            `${formattedLog}\n` +
            `--- END CHAT LOG ---\n\n` +
            `Please answer their question by analyzing the chat log above. Provide a structured, helpful summary with key points, decisions, and highlights. Match the language tone (English or Hinglish) of the users.`;

          const reply = await askGemini(prompt, remoteJid, '');
          await sendMessage(remoteJid, reply, originalMsg);
          break;
        }

        await sendMessage(remoteJid, '🤖 *Thinking...*', originalMsg);
        const classroomContext = await getClassroomContextSummary();
        const reply = await askGemini(question, remoteJid, classroomContext);
        await sendMessage(remoteJid, reply, originalMsg);
        break;
      }

      case 'model':
      case 'models': {
        const arg = commandArgs;

        if (!arg) {
          const listText = getModelsListText(remoteJid);
          await sendMessage(remoteJid, listText, originalMsg);
          return;
        }

        const switched = setPreferredModel(remoteJid, arg);
        if (switched) {
          await sendMessage(
            remoteJid,
            `✅ *AI model set to ${switched.name}!* 🎯\n_${switched.description}_`,
            originalMsg
          );
        } else {
          await sendMessage(
            remoteJid,
            `❌ *Unrecognized model "${arg}".*\n👉 Type *!models* to see all available model names (e.g. *!model lite*, *!model flash*, *!model auto*).`,
            originalMsg
          );
        }
        break;
      }

      default: {
        // If explicitly @mentioned in a group with a natural question, ask Gemini!
        if (isMentioned) {
          const question = rawText.replace(/@\d+/g, '').replace(/^[!/.#]/, '').trim();
          if (question.length > 3) {
            await sendMessage(remoteJid, '🤖 *Thinking...*', originalMsg);
            const classroomContext = await getClassroomContextSummary();
            const reply = await askGemini(question, remoteJid, classroomContext);
            await sendMessage(remoteJid, reply, originalMsg);
          }
        }
        // Do NOT reply to unrecognized messages or normal chatting!
        break;
      }
    }
  } catch (err) {
    console.error(`Error processing command "${command}":`, err);
    await sendMessage(remoteJid, `❌ *Error:* ${sanitizeError(err.message)}`, originalMsg);
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
