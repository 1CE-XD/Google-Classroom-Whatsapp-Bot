import cron from 'node-cron';
import { db } from '../storage/db.js';
import { getUpcomingAssignments } from '../google/classroom.js';
import { sendMessage, getSocket } from '../whatsapp/bot.js';

export function startScheduler() {
  console.log('⏰ Background assignment reminder scheduler started.');
  console.log('👉 Silent hourly checks enabled. Only sends a message when an assignment deadline is near.\n');

  // Check silently every 30 minutes: "*/30 * * * *"
  cron.schedule('*/30 * * * *', async () => {
    await checkAssignmentReminders();
  });
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
          `⏰ *Due Time:* ${a.deadline.toLocaleString('en-US', { timeZoneName: 'short' })}\n` +
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
