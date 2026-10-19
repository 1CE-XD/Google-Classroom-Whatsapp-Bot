import { google } from 'googleapis';
import { getOAuth2Client } from './auth.js';

/**
 * Returns an authorized Google Classroom client
 */
export function getClassroomClient() {
  const auth = getOAuth2Client();
  return google.classroom({ version: 'v1', auth });
}

/**
 * Fetch all active enrolled courses
 */
export async function getCourses() {
  const classroom = getClassroomClient();
  const res = await classroom.courses.list({
    courseStates: ['ACTIVE'],
    pageSize: 30
  });
  return res.data.courses || [];
}

/**
 * Parse dueDate & dueTime from Google Classroom format into JavaScript Date
 */
export function parseDueDate(dueDate, dueTime) {
  if (!dueDate || !dueDate.year) return null;
  const year = dueDate.year;
  const month = (dueDate.month || 1) - 1;
  const day = dueDate.day || 1;
  const hours = dueTime?.hours !== undefined ? dueTime.hours : 23;
  const minutes = dueTime?.minutes !== undefined ? dueTime.minutes : 59;

  // Google Classroom returns due dates in UTC
  return new Date(Date.UTC(year, month, day, hours, minutes));
}

/**
 * Format a Date object into human-friendly Date and Time
 * e.g. "Oct 19, 2026 at 2:30 PM"
 */
export function formatDateTime(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }) + ' at ' + d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
}

/**
 * Extract attachment links and names
 */
export function extractMaterials(materials = []) {
  const list = [];
  for (const m of materials) {
    if (m.driveFile?.driveFile) {
      list.push({
        type: 'drive',
        id: m.driveFile.driveFile.id,
        title: m.driveFile.driveFile.title || 'Drive Attachment',
        url: m.driveFile.driveFile.alternateLink
      });
    } else if (m.link) {
      list.push({
        type: 'link',
        title: m.link.title || 'External Link',
        url: m.link.url
      });
    } else if (m.youtubeVideo) {
      list.push({
        type: 'youtube',
        title: m.youtubeVideo.title || 'YouTube Video',
        url: m.youtubeVideo.alternateLink
      });
    } else if (m.form) {
      list.push({
        type: 'form',
        title: m.form.title || 'Google Form',
        url: m.form.formUrl
      });
    }
  }
  return list;
}

/**
 * Fetch formatted course list with index numbers
 */
export async function getCoursesList() {
  const courses = await getCourses();
  return courses.map((c, i) => ({
    index: i + 1,
    id: c.id,
    name: c.name,
    section: c.section || '',
    alternateLink: c.alternateLink
  }));
}

/**
 * Resolve user query (number "1", "cls 1", or partial course name) to a course
 */
export async function findCourseByQuery(query) {
  if (!query) return null;
  const clean = query.trim().toLowerCase().replace(/^cls\s*/i, '').replace(/^[#]/, '');
  const courses = await getCoursesList();

  // 1. Try matching numeric index (e.g., 1, 2, 3...)
  const num = parseInt(clean, 10);
  if (!isNaN(num) && num >= 1 && num <= courses.length) {
    return courses[num - 1];
  }

  // 2. Try partial course name match
  const found = courses.find(c => c.name.toLowerCase().includes(clean));
  return found || null;
}

/**
 * Get all upcoming assignments sorted by nearest due date
 * Optionally filtered by targetCourseId
 */
export async function getUpcomingAssignments(targetCourseId = null) {
  const classroom = getClassroomClient();
  let courses = await getCourses();
  if (targetCourseId) {
    courses = courses.filter(c => c.id === targetCourseId);
  }
  const allAssignments = [];

  for (const course of courses) {
    try {
      const res = await classroom.courses.courseWork.list({
        courseId: course.id,
        courseWorkStates: ['PUBLISHED'],
        pageSize: 20
      });

      const courseworkList = res.data.courseWork || [];

      for (const item of courseworkList) {
        if (!item.dueDate) continue; // Skip assignments with no due date

        const deadline = parseDueDate(item.dueDate, item.dueTime);
        const now = new Date();

        // Only include future assignments
        if (deadline && deadline > now) {
          const postedAt = item.creationTime
            ? new Date(item.creationTime)
            : (item.updateTime ? new Date(item.updateTime) : null);

          allAssignments.push({
            id: item.id,
            courseId: course.id,
            courseName: course.name,
            title: item.title,
            description: item.description || '',
            alternateLink: item.alternateLink,
            deadline: deadline,
            postedAt: postedAt,
            materials: extractMaterials(item.materials)
          });
        }
      }
    } catch (err) {
      console.error(`Failed to fetch coursework for course "${course.name}":`, err.message);
    }
  }

  // Sort upcoming assignments chronologically
  return allAssignments.sort((a, b) => a.deadline - b.deadline);
}

/**
 * Get recently uploaded materials and announcements across all courses
 * Optionally filtered by targetCourseId
 */
export async function getRecentCourseMaterials(hoursBack = 720, targetCourseId = null) {
  const classroom = getClassroomClient();
  let courses = await getCourses();
  if (targetCourseId) {
    courses = courses.filter(c => c.id === targetCourseId);
  }
  const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000);
  const recentItems = [];

  for (const course of courses) {
    try {
      // 1. Check Course Work Materials (files, slides, reading material)
      const matRes = await classroom.courses.courseWorkMaterials.list({
        courseId: course.id,
        courseWorkMaterialStates: ['PUBLISHED'],
        pageSize: 25
      });
      const materials = matRes.data.courseWorkMaterial || [];
      for (const m of materials) {
        const updateTime = new Date(m.creationTime || m.updateTime);
        if (updateTime >= cutoff) {
          recentItems.push({
            id: m.id,
            type: 'material',
            courseId: course.id,
            courseName: course.name,
            title: m.title,
            description: m.description,
            time: updateTime,
            alternateLink: m.alternateLink,
            files: extractMaterials(m.materials)
          });
        }
      }

      // 2. Check Announcements
      const annRes = await classroom.courses.announcements.list({
        courseId: course.id,
        announcementStates: ['PUBLISHED'],
        pageSize: 25
      });
      const announcements = annRes.data.announcements || [];
      for (const a of announcements) {
        const updateTime = new Date(a.creationTime || a.updateTime);
        if (updateTime >= cutoff) {
          recentItems.push({
            id: a.id,
            type: 'announcement',
            courseId: course.id,
            courseName: course.name,
            title: '📢 Announcement',
            description: a.text,
            time: updateTime,
            alternateLink: a.alternateLink,
            files: extractMaterials(a.materials)
          });
        }
      }

      // 3. Check Course Work (Assignments and Questions posted)
      const workRes = await classroom.courses.courseWork.list({
        courseId: course.id,
        courseWorkStates: ['PUBLISHED'],
        pageSize: 25
      });
      const coursework = workRes.data.courseWork || [];
      for (const w of coursework) {
        const postTime = new Date(w.creationTime || w.updateTime);
        if (postTime >= cutoff) {
          recentItems.push({
            id: w.id,
            type: 'assignment',
            courseId: course.id,
            courseName: course.name,
            title: `📝 ${w.title}`,
            description: w.description || '',
            time: postTime,
            deadline: parseDueDate(w.dueDate, w.dueTime),
            alternateLink: w.alternateLink,
            files: extractMaterials(w.materials)
          });
        }
      }
    } catch (err) {
      console.error(`Failed to fetch materials/announcements for course "${course.name}":`, err.message);
    }
  }

  return recentItems.sort((a, b) => b.time - a.time);
}

/**
 * Download a file from Google Drive by fileId
 * Converts native Google Docs/Slides into PDFs so they can be viewed directly on WhatsApp
 */
export async function downloadDriveFile(fileId, preferredTitle = '') {
  const auth = getOAuth2Client();
  const drive = google.drive({ version: 'v3', auth });

  // 1. Fetch metadata
  const meta = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType, size'
  });

  const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB (WhatsApp document limit)
  if (meta.data.size && parseInt(meta.data.size, 10) > MAX_FILE_SIZE) {
    throw new Error(`File is too large (${Math.round(meta.data.size / (1024 * 1024))}MB). Maximum downloadable size is 50MB.`);
  }

  const mimeType = meta.data.mimeType || 'application/octet-stream';
  let rawName = meta.data.name || preferredTitle || 'document';
  // Sanitize filename to avoid control characters or path traversal attempts
  let fileName = rawName.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim();

  let buffer;

  // 2. Export Google Docs / Slides / Sheets to PDF
  if (
    mimeType === 'application/vnd.google-apps.document' ||
    mimeType === 'application/vnd.google-apps.presentation' ||
    mimeType === 'application/vnd.google-apps.spreadsheet'
  ) {
    const exportRes = await drive.files.export(
      { fileId, mimeType: 'application/pdf' },
      { responseType: 'arraybuffer' }
    );
    buffer = Buffer.from(exportRes.data);
    if (!fileName.toLowerCase().endsWith('.pdf')) {
      fileName += '.pdf';
    }
    return {
      buffer,
      fileName,
      mimeType: 'application/pdf',
      size: buffer.length
    };
  }

  // 3. Regular binary files (PDF, docx, pptx, zip, images, code)
  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'arraybuffer' }
  );

  buffer = Buffer.from(res.data);
  return {
    buffer,
    fileName,
    mimeType,
    size: buffer.length
  };
}

let cachedClassroomContext = {
  data: '',
  timestamp: 0
};

/**
 * Builds a structured, real-time context summary of Google Classroom
 * for the AI model (upcoming assignments, recent posts, enrolled courses, bot commands)
 * Cached for 2 minutes to ensure fast response times
 */
export async function getClassroomContextSummary(forceFresh = false) {
  const now = Date.now();
  if (!forceFresh && cachedClassroomContext.data && (now - cachedClassroomContext.timestamp < 120000)) {
    return cachedClassroomContext.data;
  }

  try {
    const [courses, assignments, recent] = await Promise.all([
      getCoursesList().catch(() => []),
      getUpcomingAssignments().catch(() => []),
      getRecentCourseMaterials(168).catch(() => []) // past 7 days
    ]);

    const currentTimeStr = new Date().toLocaleString('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });

    let summary = `[CURRENT REAL-WORLD DATE & TIME]: ${currentTimeStr}\n\n`;

    summary += `[BOT CAPABILITIES & WHATSAPP COMMANDS]:\n` +
      `- !courses or !cls: List all enrolled Google Classrooms with numbers\n` +
      `- !due or !due <number>: View upcoming assignment deadlines (e.g. !due 1)\n` +
      `- !recent or !recent <number>: View recently uploaded study materials, files, and announcements\n` +
      `- !get <number>: Download and receive PDFs/documents directly in WhatsApp (e.g. !get 1)\n` +
      `- !autosync <number>: Automatically send new classroom updates & files to this group\n` +
      `- !models or !model <name>: View and switch AI models (auto, lite, flash, preview)\n` +
      `- !clear or !reset: Clear conversation memory\n` +
      `- !subscribe / !unsubscribe: Enable/disable group deadline reminders (alerted at 24h & 2h before due time)\n\n`;

    summary += `[ENROLLED GOOGLE CLASSROOMS (${courses.length})]:\n`;
    courses.forEach(c => {
      summary += `- [${c.index}] ${c.name}${c.section ? ` (${c.section})` : ''}\n`;
    });
    summary += `\n`;

    summary += `[UPCOMING ASSIGNMENTS & DEADLINES (${assignments.length})]:\n`;
    if (assignments.length === 0) {
      summary += `No upcoming assignments due at this time.\n`;
    } else {
      assignments.forEach((a, i) => {
        summary += `${i + 1}. "${a.title}" in course "${a.courseName}"\n`;
        if (a.postedAt) summary += `   Posted: ${formatDateTime(a.postedAt)}\n`;
        summary += `   Due Date: ${formatDateTime(a.deadline)}\n`;
        if (a.description) summary += `   Instructions: ${a.description.slice(0, 300)}\n`;
        if (a.materials?.length) summary += `   Files: ${a.materials.map(m => m.title).join(', ')}\n`;
        if (a.alternateLink) summary += `   Submission Link: ${a.alternateLink}\n`;
      });
    }
    summary += `\n`;

    summary += `[RECENT CLASSROOM POSTS & ANNOUNCEMENTS (Past 7 Days)]:\n`;
    if (recent.length === 0) {
      summary += `No materials or announcements posted in the past 7 days.\n`;
    } else {
      recent.slice(0, 8).forEach((r, i) => {
        summary += `${i + 1}. [${r.type.toUpperCase()}] "${r.title}" in "${r.courseName}"\n`;
        if (r.time) summary += `   Posted: ${formatDateTime(r.time)}\n`;
        if (r.description) summary += `   Content: ${r.description.slice(0, 200)}\n`;
        if (r.files?.length) summary += `   Attachments: ${r.files.map(f => f.title).join(', ')}\n`;
      });
    }

    cachedClassroomContext = {
      data: summary.trim(),
      timestamp: now
    };

    return cachedClassroomContext.data;
  } catch (err) {
    console.error('Failed to build classroom context summary:', err.message);
    return cachedClassroomContext.data || '';
  }
}
