import fs from 'fs';
import readline from 'readline';
import { google } from 'googleapis';
import { SCOPES, CREDENTIALS_PATH, TOKEN_PATH, getCredentials } from './auth.js';

async function runAuthSetup() {
  console.log('\n=============================================');
  console.log('   Google Classroom & Gmail Bot Setup');
  console.log('=============================================\n');

  let credentials;
  try {
    credentials = getCredentials();
  } catch (err) {
    console.error('❌ Error:', err.message);
    console.log('\n💡 Steps to get credentials.json:');
    console.log('1. Go to https://console.cloud.google.com/');
    console.log('2. Create a project and enable:');
    console.log('   - Google Classroom API');
    console.log('   - Gmail API');
    console.log('3. Go to APIs & Services > OAuth consent screen (Set to External / Test user with your Gmail)');
    console.log('4. Go to APIs & Services > Credentials > Create Credentials > OAuth client ID');
    console.log('   - Application type: Desktop app');
    console.log('5. Download the JSON file and save it as "credentials.json" in this bot folder.\n');
    process.exit(1);
  }

  const { client_secret, client_id, redirect_uris } = credentials;
  const redirectUri = (redirect_uris && redirect_uris[0]) || 'http://localhost';
  
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });

  console.log('🔗 1. Open this URL in your browser to authorize access to Classroom & Gmail:\n');
  console.log(authUrl);
  console.log('\n------------------------------------------------------------');
  console.log('🔗 2. Sign in with your school / personal Gmail account.');
  console.log('   (If you get a "Google hasn\'t verified this app" screen, click "Advanced" -> "Go to ... (unsafe)")');
  console.log('🔗 3. After approving, you will be redirected to localhost (which might show connection refused).');
  console.log('   Copy the URL from your browser address bar (or the "code=..." value) and paste it below.\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.question('Paste authorization code or full redirected URL here: ', async (codeOrUrl) => {
    rl.close();
    let code = codeOrUrl.trim();
    if (code.includes('code=')) {
      try {
        const parsed = new URL(code);
        code = parsed.searchParams.get('code') || code;
      } catch (e) {
        const match = code.match(/code=([^&]+)/);
        if (match) code = match[1];
      }
    }

    try {
      console.log('\n⏳ Exchanging authorization code for tokens...');
      const { tokens } = await oAuth2Client.getToken(code);
      oAuth2Client.setCredentials(tokens);
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
      console.log(`✅ Success! Token saved to ${TOKEN_PATH}\n`);

      // Test Classroom API
      console.log('🧪 Verifying Google Classroom access...');
      const classroom = google.classroom({ version: 'v1', auth: oAuth2Client });
      const coursesRes = await classroom.courses.list({ pageSize: 5 });
      const courses = coursesRes.data.courses || [];
      console.log(`📚 Found ${courses.length} active course(s):`);
      courses.forEach(c => console.log(`   - ${c.name} (ID: ${c.id})`));

      console.log('\n🎉 Setup complete! You can now start the bot with: npm start\n');
    } catch (err) {
      console.error('\n❌ Failed to retrieve tokens:', err.message);
    }
  });
}

runAuthSetup();
