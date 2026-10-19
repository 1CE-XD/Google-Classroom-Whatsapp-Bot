import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

export const SCOPES = [
  'https://www.googleapis.com/auth/classroom.courses.readonly',
  'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
  'https://www.googleapis.com/auth/classroom.coursework.students.readonly',
  'https://www.googleapis.com/auth/classroom.announcements.readonly',
  'https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly',
  'https://www.googleapis.com/auth/drive.readonly'
];

export const CREDENTIALS_PATH = path.resolve('credentials.json');
export const TOKEN_PATH = path.resolve('token.json');

/**
 * Loads client secrets from credentials.json
 */
export function getCredentials() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `credentials.json not found at ${CREDENTIALS_PATH}. Please download it from Google Cloud Console (OAuth 2.0 Client IDs).`
    );
  }
  const content = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
  const keys = JSON.parse(content);
  return keys.installed || keys.web;
}

/**
 * Creates an authorized OAuth2 client using saved token.json
 */
export function getOAuth2Client() {
  const credentials = getCredentials();
  const { client_secret, client_id, redirect_uris } = credentials;
  const redirectUri = (redirect_uris && redirect_uris[0]) || 'urn:ietf:wg:oauth:2.0:oob';
  
  const oauth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);

  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error(
      `token.json not found at ${TOKEN_PATH}. Run "npm run auth" to authorize Google Classroom & Gmail access first.`
    );
  }

  const token = fs.readFileSync(TOKEN_PATH, 'utf-8');
  oauth2Client.setCredentials(JSON.parse(token));

  // Automatically save refreshed tokens
  oauth2Client.on('tokens', (tokens) => {
    try {
      const currentToken = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
      const updated = { ...currentToken, ...tokens };
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(updated, null, 2));
      console.log('🔄 Google OAuth token refreshed and saved.');
    } catch (err) {
      console.error('Failed to save refreshed token:', err);
    }
  });

  return oauth2Client;
}
