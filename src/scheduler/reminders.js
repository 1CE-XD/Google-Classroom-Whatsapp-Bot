import cron from 'node-cron';
import { db } from '../storage/db.js';
import { getUpcomingAssignments, getRecentCourseMaterials, downloadDriveFile, formatDateTime } from '../google/classroom.js';
import { sendMessage, getSocket } from '../whatsapp/bot.js';

export function startScheduler() {
  console.log('⏰ Background assignment reminder and live auto-sync scheduler started.');
  console.log('👉 Silent checks active: Deadlines checked every 30m, new classroom uploads checked every 10m.\n');

  // Check assignment deadlines every 30 minutes
  cron.schedule('*/30 * * * *', async () => {
    await checkAssignmentReminders();
  });

  // Check new classroom materials and announcements every 10 minutes
  cron.schedule('*/10 * * * *', async () => {
    await checkClassroomAutoSync();
  });
}

/**
 * Automatically detects and uploads new classroom posts, texts, and files to groups with auto-sync enabled
 */
export async function checkClassroomAutoSync() {
  const sock = getSocket();
  if (!sock) return;

  const autoSyncGroups = db.getAllAutoSyncGroups();
  const groupJids = Object.keys(autoSyncGroups);
  if (groupJids.length === 0) return; // No groups configured for auto-sync

  try {
    // Fetch materials, announcements, and assignments from the past 48 hours
    const recentItems = await getRecentCourseMaterials(48);

    // If this is the initial run, index existing items to avoid spamming old history
    if (!db.isClassroomSeeded()) {
      for (const item of recentItems) {
        if (item.id) db.markClassroomItemSeen(item.id);
      }
      db.setClassroomSeeded(true);
      console.log(`📦 Classroom initial state indexed (${recentItems.length} items). Live auto-sync is listening.`);
      return;
    }

    // Process items in chronological order (oldest to newest)
    const reversed = [...recentItems].reverse();

    for (const item of reversed) {
      if (!item.id || db.hasSeenClassroomItem(item.id)) {
        continue;
      }

      // Check which groups should receive this item
      for (const jid of groupJids) {
        const config = autoSyncGroups[jid];
        if (!config || !config.enabled) continue;

        // If configured for a specific classroom, check courseId match
        if (config.courseId && config.courseId !== item.courseId) {
          continue;
        }

        let typeEmoji = '📌';
        let typeName = 'Classroom Update';
        if (item.type === 'assignment') {
          typeEmoji = '📝';
          typeName = 'New Assignment';
        } else if (item.type === 'announcement') {
          typeEmoji = '📢';
          typeName = 'New Announcement';
        } else if (item.type === 'material') {
          typeEmoji = '📂';
          typeName = 'New Study Material';
        }

        let msg = `${typeEmoji} *${typeName.toUpperCase()}* ${typeEmoji}\n\n` +
          `📖 *Course:* ${item.courseName}\n` +
          `📌 *Title:* ${item.title.replace(/^[📝📢\s]+/, '')}\n` +
          (item.time ? `📅 *Posted:* ${formatDateTime(item.time)}\n` : '') +
          (item.deadline ? `⏰ *Due Date:* ${formatDateTime(item.deadline)}\n` : '');

        if (item.description && item.description.trim()) {
          msg += `\n💬 *Content:*\n${item.description.trim()}\n`;
        }

        if (item.alternateLink) {
          msg += `\n🔗 *Classroom Link:* ${item.alternateLink}\n`;
        }

        // Send text announcement/update first
        await sendMessage(jid, msg.trim());

        // Auto-upload attached files if enabled
        if (config.autoUploadFiles !== false && item.files && item.files.length > 0) {
          for (const file of item.files) {
            if (file.id && file.type === 'drive') {
              try {
                const fileData = await downloadDriveFile(file.id, file.title);
                await sock.sendMessage(jid, {
                  document: fileData.buffer,
                  fileName: fileData.fileName,
                  mimetype: fileData.mimeType,
                  caption: `📄 *${fileData.fileName}*\n📖 Course: ${item.courseName}`
                });
                console.log(`📤 Auto-uploaded file "${fileData.fileName}" to group ${jid}`);
              } catch (err) {
                console.warn(`Could not auto-download file "${file.title}" for group ${jid}:`, err.message);
              }
            }
          }
        }
      }

      // Mark as seen so it is never re-sent
      db.markClassroomItemSeen(item.id);
    }
  } catch (err) {
    console.error('Error during classroom auto-sync check:', err.message);
  }
}

/**
 * Check upcoming assignments and send reminders for 24h and 2h windows
 * Never repeats: an assignment only gets notified once per window
 */
export async function checkAssignmentReminders() {
  const sock = getSocket();
  if (!sock) return;

  const data = db.get();
  const subscribedGroups = data.subscribedGroups;
  if (!subscribedGroups || subscribedGroups.length === 0) {
    return; // No groups subscribed to reminders
  }

  try {
    const assignments = await getUpcomingAssignments();
    const now = new Date();

    for (const a of assignments) {
      const diffMs = a.deadline - now;
      const diffHours = diffMs / (1000 * 60 * 60);

      let reminderStage = null;
      let reminderHeader = '';

      // Stage 1: ~24 hours notice (between 2 and 24 hours remaining)
      // Only fires ONCE for this assignment
      if (diffHours <= 24 && diffHours > 2) {
        if (!db.hasAlertedAssignment(a.id, '24h')) {
          reminderStage = '24h';
          reminderHeader = '⚠️ *ASSIGNMENT REMINDER (DUE IN 24 HOURS)* ⚠️';
        }
      }
      // Stage 2: ~2 hours notice (less than 2 hours remaining)
      // Only fires ONCE for this assignment
      else if (diffHours <= 2 && diffHours > 0) {
        if (!db.hasAlertedAssignment(a.id, '2h')) {
          reminderStage = '2h';
          reminderHeader = '🚨 *URGENT DEADLINE: DUE IN UNDER 2 HOURS!* 🚨';
        }
      }

      if (reminderStage) {
        const message = `${reminderHeader}\n\n` +
          `📖 *Course:* ${a.courseName}\n` +
          `📝 *Assignment:* ${a.title}\n` +
          (a.postedAt ? `📅 *Posted:* ${formatDateTime(a.postedAt)}\n` : '') +
          `⏰ *Due Time:* ${formatDateTime(a.deadline)}\n` +
          (a.description ? `💬 _${a.description.trim()}_\n` : '') +
          (a.alternateLink ? `🔗 *Submission Link:* ${a.alternateLink}\n` : '') +
          (a.materials?.length ? `📎 *Materials:* ${a.materials.map(m => m.title).join(', ')}\n` : '');

        // Broadcast to all subscribed groups
        for (const groupJid of subscribedGroups) {
          try {
            await sendMessage(groupJid, message.trim());
            console.log(`📢 Dispatched ${reminderStage} alert for "${a.title}" to group ${groupJid}`);
          } catch (err) {
            console.error(`Failed to send alert to group ${groupJid}:`, err.message);
          }
        }

        // Mark in database so it is NEVER sent again
        db.markAssignmentAlerted(a.id, reminderStage);
      }
    }
  } catch (err) {
    console.error('Error during scheduled assignment check:', err.message);
  }
}
