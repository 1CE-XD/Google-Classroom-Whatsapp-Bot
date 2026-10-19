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
 * Get all upcoming assignments sorted by nearest due date
 */
export async function getUpcomingAssignments() {
  const classroom = getClassroomClient();
  const courses = await getCourses();
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
 */
export async function getRecentCourseMaterials(hoursBack = 720) {
  const classroom = getClassroomClient();
  const courses = await getCourses();
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
            type: 'material',
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
            type: 'announcement',
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
            type: 'assignment',
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

  const mimeType = meta.data.mimeType || 'application/octet-stream';
  let fileName = meta.data.name || preferredTitle || 'document';

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
