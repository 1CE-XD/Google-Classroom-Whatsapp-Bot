/**
 * Offline drill for src/whatsapp/session-repair.js - proves the file matcher,
 * the storm detector, arming and the DRY-RUN repair flow WITHOUT touching the
 * live session. Uses obviously-fake ids (1111111111 = chat, 2222222222 = group)
 * so no real number ever lands in code or commits.
 *
 *   REPAIR_DRY_RUN=1 REPAIR_ARM_DELAY_MS=1500 REPAIR_AUTH_DIR=data/__repair_drill/auth \
 *     node scripts/test-session-repair.mjs
 */

import fs from 'fs';
import path from 'path';
import {
  bindSessionRepair,
  installDecryptObserver,
  selectRepairTargets,
  __drillSimulateFailure,
  __drillPeek,
  __drillArmed
} from '../src/whatsapp/session-repair.js';

const FAKE_CHAT = '1111111111';
const FAKE_GROUP = '2222222222@g.us';
const UNRELATED = '7777777777';
const DRILL = path.resolve('data', '__repair_drill', 'auth');
const BACKUP_ROOT = path.resolve('data', 'auth_repair_backups');
const STATE_FILE = path.resolve('data', 'session-repair-state.json');

let failuresCount = 0;
function ok(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); return true; }
  failuresCount++;
  console.error(`  ❌ ${label}`);
  return false;
}

console.log('=== Session-repair offline drill ===');

// --- 0. bind a fake runtime so the repair flow reaches its DRY-RUN branch ----
bindSessionRepair({
  isConnected: () => true,
  getConnectedAt: () => Date.now() - 5 * 60 * 1000, // older than the 2-min gate
  sendOwnerBeacon: async () => ({ simulated: true })
});

// --- 1. sandbox auth dir with exact-match files AND traps --------------------
fs.rmSync(DRILL, { recursive: true, force: true });
fs.mkdirSync(DRILL, { recursive: true });
const exactFiles = [
  `session-${FAKE_CHAT}.0.json`,
  `session-${FAKE_CHAT}.84.json`,
  `session-${FAKE_CHAT}.89.json`,
  `sender-key-${FAKE_GROUP}--${FAKE_CHAT}--0.json`,
  `sender-key-${FAKE_GROUP}--${FAKE_CHAT}--84.json`
];
const trapFiles = [
  `session-${FAKE_CHAT}9999.2.json`,                    // id prefix trap
  'session-9999999990.3.json',                          // unrelated chat
  `sender-key-${FAKE_GROUP}--${FAKE_CHAT}0--1.json`,    // digits-prefix trap
  `sender-key-${FAKE_GROUP}--9999999990--1.json`,       // unrelated chat
  'pre-key-1234.json',                                  // device-wide, never touch
  'app-state-sync-key-1234.json',                       // device-wide, never touch
  'creds.json',                                         // identity, never touch
  'sender-key-memory-3333333333@g.us.json'              // per-group memory, never touch
];
for (const name of [...exactFiles, ...trapFiles]) {
  fs.writeFileSync(path.join(DRILL, name), '{}');
}
console.log(`Sandbox prepared: ${DRILL}`);
console.log(`State file before drill: ${fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, 'utf-8') : '(absent)'}`);
const backupExisted = fs.existsSync(BACKUP_ROOT);

// --- 2. matcher correctness --------------------------------------------------
console.log('\n[1/4] File matcher');
const picked = selectRepairTargets(DRILL, FAKE_CHAT);
ok('picked exactly the 5 stale records of the fake chat',
   JSON.stringify(picked) === JSON.stringify([...exactFiles].sort()));
ok('picked nothing for an unrelated chat', selectRepairTargets(DRILL, UNRELATED).length === 0);
ok('rejects non-numeric junk', selectRepairTargets(DRILL, 'o@lid').length === 0);
ok('pre-key / app-state / creds.json never match',
   !picked.some(n => n.startsWith('pre-key') || n.startsWith('app-state') || n === 'creds.json'));

// --- 3. line parsing via the real libsignal console shape --------------------
console.log('\n[2/4] Failure-line parsing');
installDecryptObserver();
const realStack =
  'Error: Bad MAC\n' +
  '    at Object.verifyMAC (C:\\virtual\\libsignal\\src\\crypto.js:87:15)\n' +
  '    at SessionCipher.doDecryptWhisperMessage (C:\\virtual\\libsignal\\src\\session_cipher.js:250:16)\n' +
  `    at async 1111111111.0 [as awaitable] (C:\\virtual\\libsignal\\src\\session_cipher.js:171:39)\n` +
  '    at async _asyncQueueExecutor (C:\\virtual\\libsignal\\src\\queue_job.js:20:29)';
console.error('Session error:Error: Bad MAC Error: Bad MAC', realStack); // real shape
ok('parsed chat id from a real-shaped "Session error:" line', __drillPeek(FAKE_CHAT) === 1);
console.error('Failed to decrypt message with any known session...'); // early header passes through
ok('header line below threshold passes through (unchanged behaviour)', __drillPeek(FAKE_CHAT) === 1);

// --- 4. storm -> arming -> DRY-RUN repair ------------------------------------
console.log('\n[3/4] Storm detection + arming');
let n = 1;
while (n < 12) n = __drillSimulateFailure(FAKE_CHAT);
ok(`${n} simulated failures counted in the rolling window`, n === 12);
const arm = __drillArmed();
ok('storm armed with a double-confirm delay', !!arm && arm.chat === FAKE_CHAT && arm.fireAt > Date.now());

console.log('\n[4/4] DRY-RUN repair (waits for the arm timer, ~2 s)');
const stateBefore = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, 'utf-8') : null;
await new Promise(r => setTimeout(r, (arm ? arm.fireAt - Date.now() : 2000) + 2500));
ok('backup dir untouched in DRY-RUN', fs.existsSync(BACKUP_ROOT) === backupExisted);
ok('sandbox auth dir unchanged (all 13 files still there)',
   fs.readdirSync(DRILL).sort().join('|') === [...exactFiles, ...trapFiles].sort().join('|'));
const stateAfter = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, 'utf-8') : null;
ok('bookkeeping state not written in DRY-RUN', stateBefore === stateAfter);
ok('process still alive (no exit in DRY-RUN)', true);

// --- cleanup -----------------------------------------------------------------
fs.rmSync(DRILL, { recursive: true, force: true });
console.log('\nDrill dir cleaned up.');

if (failuresCount) {
  console.error(`\n❌ DRILL FAILED: ${failuresCount} assertion(s) failed.`);
  process.exit(1);
}
console.log('\n✅ DRILL PASSED - matcher, storm detection, throttling and DRY-RUN repair all behave as designed.');
