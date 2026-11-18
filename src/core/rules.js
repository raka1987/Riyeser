// Your own filing rules: "Dynamix timesheets go in Staff > Timesheets > (year)".
// A rule has conditions (all must match) and a destination folder. Rules beat the app's own guesses.
const path = require('path');
const { templateFor, folderFromTemplate } = require('./learn');

/** Plain-English file kind, used as a rule condition. */
function kindOf(ext) {
  const e = (ext || '').toLowerCase();
  if (e === '.pdf') return 'PDF';
  if (/^\.(docx?|odt|rtf|pages)$/.test(e)) return 'Word';
  if (/^\.(xlsx?|xlsm|ods|csv|numbers)$/.test(e)) return 'Excel';
  if (/^\.(pptx?|odp|key)$/.test(e)) return 'PowerPoint';
  if (/^\.(jpe?g|png|heic|heif|webp|gif|bmp|tiff?)$/.test(e)) return 'Picture';
  if (/^\.(mp4|mov|avi|mkv|webm|m4v)$/.test(e)) return 'Video';
  if (/^\.(eml|msg)$/.test(e)) return 'Email';
  if (/^\.(txt|md)$/.test(e)) return 'Text';
  return null;
}

const wordRe = (w) => new RegExp(`(^|[^a-z0-9])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');

/** Does this file match the rule? item: { name, text?, preview?, textTokens?, company, docType, ext } */
function ruleMatches(rule, item) {
  if (!rule || rule.enabled === false || item.isFolder) return false;
  const c = rule.conditions || {};
  let any = false;
  if (c.company) { any = true; if (!item.company || item.company.toLowerCase() !== c.company.toLowerCase()) return false; }
  if (c.docType) { any = true; if (item.docType !== c.docType) return false; }
  if (c.kind) { any = true; if (kindOf(item.ext || path.extname(item.name || '')) !== c.kind) return false; }
  if (c.words && c.words.length) {
    any = true;
    const hay = `${item.name || ''}\n${item.text || item.preview || ''}\n${(item.textTokens || []).join(' ')}`;
    if (!c.words.every((w) => wordRe(w).test(hay))) return false;
  }
  return any;
}

/** The folder a matching file should go to (with this year's folder if the rule uses years). */
function ruleFolder(rule, item, root) {
  const year = (item.details?.date || item.fileDate || '').slice(0, 4) || String(new Date().getFullYear());
  return folderFromTemplate(rule.dest, root, year);
}

/** First enabled rule that matches. */
const firstMatch = (rules, item) => (rules || []).find((r) => ruleMatches(r, item)) || null;

/** Build a rule from a chosen folder and conditions. useYear: file into a sub-folder per year. */
function makeRule({ folder, root, conditions, useYear, name }) {
  const dest = templateFor(folder, root);
  if (useYear && !dest.template.split('/').includes('{year}')) dest.template = `${dest.template}/{year}`;
  if (!useYear) dest.template = dest.template.split('/').filter((p) => p !== '{year}').join('/') || dest.template;
  const c = conditions || {};
  const auto = [c.docType, c.company && `from ${c.company}`, c.kind && `(${c.kind})`, c.words && c.words.length && `“${c.words.join(' ')}”`].filter(Boolean).join(' ');
  return { id: `r${Date.now().toString(36)}`, name: name || auto || 'Rule', conditions: c, dest, enabled: true, created: new Date().toISOString() };
}

/** Human summary of where a rule sends files. */
const describeDest = (rule) => (rule.dest.inRoot ? 'Organised/' : '') + rule.dest.template.replace('{year}', '(year)');

module.exports = { kindOf, ruleMatches, ruleFolder, firstMatch, makeRule, describeDest };
