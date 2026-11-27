// What each Riyeser program's backup holds: the same data folders as Central's "Fresh start" list (central/freshstart.js)
// and each program's own code. Used by each program's own Back up / Restore, and by Central's "Back up everything".
//
//   Accounting (Basics, Plus, Invoices, POS, Bookings): its company files, RIYESER_HOME or %USERPROFILE%\.riyeser
//     (company.db and companies\*.db), as in riyeser/cli.py. Its own backups (riyeser/backups.py) are in
//     Documents\Riyeser\Accounting\Backups and stay there.
//   Payroll: %APPDATA%\Riyeser Payroll\payroll (payroll.db; not the demo records). Its own backups are in
//     Documents\Riyeser\Payroll\Backups.
//   Desk Assistant: %APPDATA%\Desk Assistant\data (settings, rules, to-dos, file list, undo history).
//   PDF: %APPDATA%\Desk PDF\data (saved signatures, recent files).
//   Link Office: %APPDATA%\Riyeser Link Office\data (settings, phones, extensions; desk phone passwords stay encrypted
//     for this Windows account, so on a new PC the phones are set up again).
//   As Built: %APPDATA%\Riyeser Services (its projects, kept by the app window in Local Storage / IndexedDB).
//   Central: %APPDATA%\Riyeser Central\data (settings, checklist, set-up) and the business details (company.json).
// Sign-ins and this PC's id are never in a backup (backup.js NEVER): a new PC signs in and is linked by itself.
const path = require('path');
const os = require('os');

const accountingHome = (env = process.env, home = os.homedir()) => env.RIYESER_HOME || path.join(home, '.riyeser');

function parts({ appData, env = process.env, home = os.homedir() }) {
  return {
    central: [
      { id: 'central', label: 'Riyeser Central settings', dir: path.join(appData, 'Riyeser Central', 'data') },
      { id: 'shared', label: 'Your business details', dir: path.join(appData, 'Riyeser'), mode: 'merge', skip: /^(?!company\.json$)/ },
    ],
    accounting: [{ id: 'accounting', label: 'Accounting company files', dir: accountingHome(env, home), mode: 'merge',
      skip: /^(?!company\.db(-wal)?$|companies(\/[^/]+\.db(-wal)?)?$)/ }],
    payroll: [{ id: 'payroll', label: 'Payroll records', dir: path.join(appData, 'Riyeser Payroll', 'payroll'), skip: /^demo(\/|$)/ }],
    desk: [{ id: 'desk', label: 'Desk Assistant settings, to-dos and undo history', dir: path.join(appData, 'Desk Assistant', 'data') }],
    pdf: [{ id: 'pdf', label: 'PDF signatures and recent files', dir: path.join(appData, 'Desk PDF', 'data') }],
    linkoffice: [{ id: 'linkoffice', label: 'Link Office settings, phones and extensions', dir: path.join(appData, 'Riyeser Link Office', 'data') }],
    services: [{ id: 'services', label: 'As Built projects', dir: path.join(appData, 'Riyeser Services'),
      skip: /^(?!(Local Storage|IndexedDB)(\/|$)|window\.json$)/ }],
  };
}
const NAMES = { central: 'Central', accounting: 'Accounting', payroll: 'Payroll', desk: 'Desk Assistant', pdf: 'PDF', linkoffice: 'Link Office', services: 'As Built' };

/** One program's own backup spec (Desk Assistant, Link Office, As Built, PDF). It also takes Central's all-in-one. */
function programSpec(id, opts) {
  return { program: NAMES[id], parts: parts(opts)[id], accepts: ['Everything'] };
}
/**
 * Central's "Back up everything": Central, and each Riyeser program installed on this PC (installed: Central's
 * program ids; Accounting Basics/Plus, Invoices, POS and Bookings share Accounting's company files).
 */
function everythingSpec(opts, installed = null) {
  const p = parts(opts);
  const has = (id) => !installed || installed.includes(id);
  const acc = !installed || ['accounting', 'accounting-basics', 'invoices', 'pos', 'bookings', 'estimate'].some((x) => installed.includes(x));
  return { program: 'Everything', title: 'Riyeser backup', accepts: Object.values(NAMES),
    parts: [...p.central, ...(acc ? p.accounting : []), ...(has('payroll') ? p.payroll : []), ...(has('desk') ? p.desk : []),
      ...(has('pdf') ? p.pdf : []), ...(has('linkoffice') ? p.linkoffice : []), ...(has('services') ? p.services : [])] };
}

module.exports = { parts, programSpec, everythingSpec, accountingHome, NAMES };
