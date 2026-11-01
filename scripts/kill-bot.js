import { execSync } from 'child_process';

const port = 48591;

export function stopRunningBot() {
  let stopped = false;

  // 1. Kill process by port 48591
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
      const lines = out.trim().split('\n');
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && pid !== '0' && Number(pid) !== process.pid) {
          try {
            execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
            stopped = true;
          } catch {}
        }
      }
    } else {
      execSync(`lsof -t -i:${port} | xargs kill -9`, { stdio: 'ignore' });
      stopped = true;
    }
  } catch {}

  // 2. Kill any lingering process matching src/index.js or tee.mjs on Windows
  try {
    if (process.platform === 'win32') {
      const psCmd = `Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { ($_.CommandLine -like "*src/index.js*" -or $_.CommandLine -like "*tee.mjs*") -and $_.ProcessId -ne ${process.pid} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
      execSync(`powershell -NoProfile -Command "${psCmd}"`, { stdio: 'ignore' });
      stopped = true;
    }
  } catch {}

  if (stopped) {
    console.log('🛑 Stopped lingering bot process.');
  } else {
    console.log('ℹ️ No active bot process found.');
  }
}

// If executed directly (e.g. node scripts/kill-bot.js or npm run stop)
if (process.argv[1] && process.argv[1].endsWith('kill-bot.js')) {
  stopRunningBot();
}
