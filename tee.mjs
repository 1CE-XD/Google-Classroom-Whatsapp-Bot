// tee.mjs - run the bot while mirroring its console output to data\bot.log
// Replaces the PowerShell "npm start | Tee-Object" approach (which caused
// NativeCommandError spooling). Pure Node: stdout/stderr go to the console
// AND are appended to data\bot.log with start/exit banners.
// Usage: node tee.mjs src/index.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const target = process.argv[2] || 'src/index.js';
const extraArgs = process.argv.slice(3);
const LOG = path.resolve('data', 'bot.log');

fs.mkdirSync(path.dirname(LOG), { recursive: true });
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const writeLog = (s) => {
  try { fs.appendFileSync(LOG, s); } catch { /* keep going even if the file is locked */ }
};

const startLine = `[${stamp()}] ===== bot starting (console + data\\bot.log via tee.mjs) =====`;
console.log(startLine);
writeLog(`\n${startLine}\n`);

const child = spawn(process.execPath, [target, ...extraArgs], { stdio: ['inherit', 'pipe', 'pipe'] });
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
const mirror = (stream) => {
  stream.on('data', (chunk) => {
    process.stdout.write(chunk);
    writeLog(chunk);
  });
};
mirror(child.stdout);
mirror(child.stderr);

child.on('exit', (code, signal) => {
  const line = `[${stamp()}] bot exited (code=${code ?? '-'}, signal=${signal ?? '-'})`;
  console.log(`\n${line}`);
  writeLog(`\n${line}\n`);
});

// Ctrl+C: on Windows the whole console group receives it; stop the child too.
process.on('SIGINT', () => {
  child.kill();
  process.exit(130);
});
