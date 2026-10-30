import fs from 'fs';
import path from 'path';

const DB_PATH = path.resolve('data', 'store.json');

// Ensure data folder exists
if (!fs.existsSync(path.dirname(DB_PATH))) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const defaultData = {
  subscribedGroups: [], // JIDs of groups where reminders should be posted
  blacklistedUsers: [], // JIDs or clean phone numbers of blocked users
  autoSyncGroups: {}, // { [groupJid]: { enabled: true, courseId: null, courseName: 'All', autoUploadFiles: true } }
  selectedCourses: {}, // { [chatJid]: { id, name, index } } - active classroom selected per chat
  seenClassroomItems: [], // [itemId] of materials/announcements/coursework already processed
  classroomSeeded: false, // true once initial history is indexed to avoid spamming old items
  alertedAssignments: {}, // { assignmentId: [reminderStages: '24h', '2h', etc.] }
  alertedEmails: [], // [messageId]
  settings: {
    checkIntervalMinutes: 15,
    reminderHours: [24, 2]
  }
};

function readDb() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      fs.writeFileSync(DB_PATH, JSON.stringify(defaultData, null, 2));
      return defaultData;
    }
    const raw = fs.readFileSync(DB_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error reading database file:', err);
    return defaultData;
  }
}

function writeDb(data) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error writing database file:', err);
  }
}

export const db = {
  get() {
    return readDb();
  },

  addSubscriber(jid) {
    const data = readDb();
    if (!data.subscribedGroups.includes(jid)) {
      data.subscribedGroups.push(jid);
      writeDb(data);
      return true;
    }
    return false;
  },

  removeSubscriber(jid) {
    const data = readDb();
    const index = data.subscribedGroups.indexOf(jid);
    if (index !== -1) {
      data.subscribedGroups.splice(index, 1);
      writeDb(data);
      return true;
    }
    return false;
  },

  isSubscribed(jid) {
    const data = readDb();
    return data.subscribedGroups.includes(jid);
  },

  hasAlertedAssignment(id, stage) {
    const data = readDb();
    const stages = data.alertedAssignments[id] || [];
    return stages.includes(stage);
  },

  markAssignmentAlerted(id, stage) {
    const data = readDb();
    if (!data.alertedAssignments[id]) {
      data.alertedAssignments[id] = [];
    }
    if (!data.alertedAssignments[id].includes(stage)) {
      data.alertedAssignments[id].push(stage);
      writeDb(data);
    }
  },

  hasAlertedEmail(messageId) {
    const data = readDb();
    return data.alertedEmails.includes(messageId);
  },

  markEmailAlerted(messageId) {
    const data = readDb();
    if (!data.alertedEmails.includes(messageId)) {
      data.alertedEmails.push(messageId);
      // Keep only last 200 emails to keep db small
      if (data.alertedEmails.length > 200) {
        data.alertedEmails.shift();
      }
      writeDb(data);
    }
  },

  setGroupAutoSync(jid, config) {
    const data = readDb();
    if (!data.autoSyncGroups) data.autoSyncGroups = {};
    data.autoSyncGroups[jid] = config;
    writeDb(data);
  },

  getGroupAutoSync(jid) {
    const data = readDb();
    return data.autoSyncGroups?.[jid] || null;
  },

  removeGroupAutoSync(jid) {
    const data = readDb();
    if (data.autoSyncGroups && data.autoSyncGroups[jid]) {
      delete data.autoSyncGroups[jid];
      writeDb(data);
      return true;
    }
    return false;
  },

  getAllAutoSyncGroups() {
    const data = readDb();
    return data.autoSyncGroups || {};
  },

  hasSeenClassroomItem(id) {
    const data = readDb();
    const seen = data.seenClassroomItems || [];
    return seen.includes(id);
  },

  markClassroomItemSeen(id) {
    const data = readDb();
    if (!data.seenClassroomItems) data.seenClassroomItems = [];
    if (!data.seenClassroomItems.includes(id)) {
      data.seenClassroomItems.push(id);
      if (data.seenClassroomItems.length > 500) {
        data.seenClassroomItems = data.seenClassroomItems.slice(-500);
      }
      writeDb(data);
    }
  },

  isClassroomSeeded() {
    const data = readDb();
    return Boolean(data.classroomSeeded);
  },

  setClassroomSeeded(seeded = true) {
    const data = readDb();
    data.classroomSeeded = seeded;
    writeDb(data);
  },

  setSelectedCourse(jid, courseId, courseName, courseIndex) {
    const data = readDb();
    if (!data.selectedCourses) data.selectedCourses = {};
    data.selectedCourses[jid] = {
      id: courseId,
      name: courseName,
      index: courseIndex,
      updatedAt: new Date().toISOString()
    };
    writeDb(data);
  },

  getSelectedCourse(jid) {
    const data = readDb();
    return data.selectedCourses?.[jid] || null;
  },

  clearSelectedCourse(jid) {
    const data = readDb();
    if (data.selectedCourses && data.selectedCourses[jid]) {
      delete data.selectedCourses[jid];
      writeDb(data);
      return true;
    }
    return false;
  },

  isBlacklisted(identifier) {
    if (!identifier) return false;
    const data = readDb();
    const list = data.blacklistedUsers || [];
    const clean = String(identifier).replace(/[^0-9]/g, '');
    const cleanJid = String(identifier).toLowerCase().trim();

    return list.some(item => {
      const itemClean = String(item).replace(/[^0-9]/g, '');
      const itemJid = String(item).toLowerCase().trim();
      if (cleanJid === itemJid) return true;
      if (clean && itemClean && (clean === itemClean || clean.includes(itemClean) || itemClean.includes(clean))) return true;
      return false;
    });
  },

  addBlacklist(identifier) {
    if (!identifier) return false;
    const data = readDb();
    if (!data.blacklistedUsers) data.blacklistedUsers = [];
    const cleanJid = String(identifier).trim();
    if (!this.isBlacklisted(cleanJid)) {
      data.blacklistedUsers.push(cleanJid);
      writeDb(data);
      return true;
    }
    return false;
  },

  removeBlacklist(identifier) {
    if (!identifier) return false;
    const data = readDb();
    if (!data.blacklistedUsers || data.blacklistedUsers.length === 0) return false;
    const clean = String(identifier).replace(/[^0-9]/g, '');
    const cleanJid = String(identifier).toLowerCase().trim();

    const originalLength = data.blacklistedUsers.length;
    data.blacklistedUsers = data.blacklistedUsers.filter(item => {
      const itemClean = String(item).replace(/[^0-9]/g, '');
      const itemJid = String(item).toLowerCase().trim();
      if (cleanJid === itemJid) return false;
      if (clean && itemClean && (clean === itemClean || clean.includes(itemClean) || itemClean.includes(clean))) return false;
      return true;
    });

    if (data.blacklistedUsers.length !== originalLength) {
      writeDb(data);
      return true;
    }
    return false;
  },

  getBlacklist() {
    const data = readDb();
    return data.blacklistedUsers || [];
  }
};
