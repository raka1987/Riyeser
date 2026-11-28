// Windows CI (desk-assistant-windows.yml): the free trial's date with the real registry (HKCU\Software\Riyeser\Trial).
//   node scripts/trial-guard-check.js start         -> starts (or reads) the trial the way Central does; prints its date
//   node scripts/trial-guard-check.js check <date>  -> after uninstalling, wiping %APPDATA% and reinstalling: still <date>?
// Uses this PC's real MachineGuid only to make the one-way PC code (nothing is sent anywhere).
const guard = require('../src/core/trial-guard');
const licence = require('../src/core/licence');
const [mode, want] = process.argv.slice(2);
if (!guard.useWindowsDefaults()) { console.error('Windows only'); process.exit(1); }
const appData = process.env.APPDATA;
const s = licence.status(appData);
const reg = guard.windowsRegistry().read();
console.log(JSON.stringify({ mode: s.mode, trialStart: s.trialStart, daysLeft: s.daysLeft, registry: reg, pcCode: guard.pcId() ? 'made' : 'none' }));
if (!guard.pcId()) { console.error('No one-way PC code (MachineGuid not readable)'); process.exit(1); }
if (Date.parse(reg.suite) !== Date.parse(s.trialStart)) { console.error(`The registry has ${reg.suite}, the trial says ${s.trialStart}`); process.exit(1); }
if (mode === 'check' && Date.parse(s.trialStart) !== Date.parse(want)) { console.error(`The trial restarted: was ${want}, now ${s.trialStart}`); process.exit(1); }
process.stdout.write(`TRIAL_START=${s.trialStart}\n`);
