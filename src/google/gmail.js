import { google } from 'googleapis';
import { getOAuth2Client } from './auth.js';

export function getGmailClient() {
  const auth = getOAuth2Client();
  return google.gmail({ version: 'v1', auth });
}

/**
 * Fetch recent emails matching a search query
 * Defaults to searching recent unread emails or classroom-related notifications
 */
export async function getRecentEmails(options = {}) {
  const {
    query = 'is:unread OR from:classroom.google.com',
    maxResults = 5
  } = options;

  const gmail = getGmailClient();
  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults
  });

  const messages = listRes.data.messages || [];
  const parsedEmails = [];

  for (const msg of messages) {
    try {
      const detail = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Date']
      });

      const headers = detail.data.payload?.headers || [];
      const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

      const from = getHeader('From');
      const subject = getHeader('Subject') || '(No Subject)';
      const date = getHeader('Date');
      const snippet = detail.data.snippet || '';

      parsedEmails.push({
        id: msg.id,
        threadId: msg.threadId,
        from,
        subject,
        date: date ? new Date(date) : new Date(Number(detail.data.internalDate)),
        snippet
      });
    } catch (err) {
      console.error(`Failed to retrieve email ${msg.id}:`, err.message);
    }
  }

  return parsedEmails;
}
