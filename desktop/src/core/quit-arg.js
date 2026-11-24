// "--quit" for the Riyeser programs that stay running by the clock (Riyeser Link, Riyeser Link Office): starting a
// second copy with --quit tells the running copy to quit properly (Riyeser Central's Fresh start uses it), and a copy
// started with --quit when none is running just closes again. Anything else brings the running copy's window forward.
const QUIT_ARG = '--quit';
const wantsQuit = (argv) => Array.isArray(argv) && argv.includes(QUIT_ARG);
/** The single-instance 'second-instance' handler: quit() for --quit, else show(). Returns which it did. */
function onSecondInstance(argv, { quit, show }) {
  if (wantsQuit(argv)) { quit(); return 'quit'; }
  show(); return 'show';
}
module.exports = { QUIT_ARG, wantsQuit, onSecondInstance };
