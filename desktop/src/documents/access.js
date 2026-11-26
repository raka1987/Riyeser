// Riyeser Documents: who can see and change which folders (phase 1, kept with the library so every PC agrees).
//
// Levels, lowest to highest:
//   none  - the folder is hidden (a lock shows for people who can see it is locked)
//   view  - open, preview and print
//   add   - also put new documents in (upload, scan, file from the Inbox)
//   edit  - also move, rename and delete
//   full  - also change who has access
// The library's owner always has Full access everywhere. Everyone else gets the closest folder rule above the
// document (Accounts › Suppliers uses the Accounts rule unless Suppliers has its own). In one rule, a person's own
// entry beats their groups, and their best group beats "Everyone". With no rule at all, the default applies.
//
// Phase 1 is enforced by this program. On a shared network folder, Windows' own folder permissions are the hard
// boundary: someone with Windows access can still open the folder in File Explorer. The app says so in Settings.
// The model is ready for company-wide Riyeser logins: a person's id is "u:<email>" when they're signed in to Riyeser.

const LEVELS = ['none', 'view', 'add', 'edit', 'full'];
const rank = (l) => Math.max(0, LEVELS.indexOf(l));
const LABEL = { none: 'No access', view: 'View', add: 'Add', edit: 'Edit', full: 'Full' };
// What each action needs
const NEEDS = { view: 'view', open: 'view', print: 'view', add: 'add', upload: 'add', file: 'add', move: 'edit', rename: 'edit', delete: 'edit', restore: 'edit', private: 'edit', permissions: 'full' };

const EVERYONE = 'everyone';
const personKey = (id) => `p:${id}`;
const groupKey = (id) => `g:${id}`;

/** A fresh access list: owner (may be null until someone opens the library), everyone can edit, Payroll & HR locked. */
function defaultAccess(ownerId = null) {
  return {
    owner: ownerId,
    people: [],
    groups: [{ id: 'managers', name: 'Managers' }, { id: 'accounts', name: 'Accounts team' }, { id: 'payroll', name: 'Payroll & HR team' }],
    rules: { 'Payroll & HR': { [EVERYONE]: 'none', [groupKey('payroll')]: 'edit', [groupKey('managers')]: 'view' } },
    everyone: 'edit',
  };
}

const parentOf = (rel) => { const i = rel.lastIndexOf('/'); return i < 0 ? '' : rel.slice(0, i); };
const normRel = (rel) => String(rel || '').replace(/\\/g, '/').split('/').filter(Boolean).join('/');

/** The person's level for a folder ('' = the library root). person: { id, groups? } */
function levelFor(access, person, folderRel) {
  if (!person) return 'none';
  if (access.owner && person.id === access.owner) return 'full';
  const rec = (access.people || []).find((p) => p.id === person.id) || person;
  const groups = rec.groups || [];
  let rel = normRel(folderRel);
  for (;;) {
    const rule = (access.rules || {})[rel];
    if (rule) {
      if (rule[personKey(person.id)]) return rule[personKey(person.id)];
      const fromGroups = groups.map((g) => rule[groupKey(g)]).filter(Boolean);
      if (fromGroups.length) return fromGroups.sort((a, b) => rank(b) - rank(a))[0];
      if (rule[EVERYONE]) return rule[EVERYONE];
    }
    if (!rel) break;
    rel = parentOf(rel);
  }
  return access.everyone || 'edit';
}

const can = (access, person, action, folderRel) => rank(levelFor(access, person, folderRel)) >= rank(NEEDS[action] || action);

/** Locked: Everyone (people with no rule of their own) can't open it. */
function isLocked(access, folderRel) {
  return rank(levelFor(access, { id: '\u0000nobody', groups: [] }, folderRel)) === 0;
}

/** Can this person see this document at all? Private documents: the person who added it, the owner and Full access. */
function canSeeDoc(access, person, doc, folderRel) {
  if (!can(access, person, 'view', folderRel)) return false;
  if (!doc.private) return true;
  return doc.addedBy === person.id || levelFor(access, person, folderRel) === 'full';
}

/** Change one folder's rule for a person, group or everyone (level '' removes that entry). Only Full access may. */
function setRule(access, by, folderRel, who, level) {
  const rel = normRel(folderRel);
  if (!can(access, by, 'permissions', rel)) throw new Error('Only the owner, or someone with Full access to this folder, can change who sees it.');
  if (level && !LEVELS.includes(level)) throw new Error('Unknown access level.');
  const rules = { ...(access.rules || {}) };
  const rule = { ...(rules[rel] || {}) };
  if (level) rule[who] = level; else delete rule[who];
  if (Object.keys(rule).length) rules[rel] = rule; else delete rules[rel];
  return { ...access, rules };
}

/** Add someone to the people list (or update them). Initials are worked out from the name. */
function upsertPerson(access, person) {
  const people = [...(access.people || [])];
  const i = people.findIndex((p) => p.id === person.id);
  const clean = { id: person.id, name: String(person.name || person.email || 'Someone').trim().slice(0, 80), email: person.email || '', groups: person.groups || (i >= 0 ? people[i].groups : []) || [] };
  clean.initials = initials(clean.name);
  if (i >= 0) people[i] = { ...people[i], ...clean }; else people.push(clean);
  return { ...access, people };
}

function initials(name) {
  const w = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!w.length) return '?';
  return (w.length === 1 ? w[0].slice(0, 2) : w[0][0] + w[w.length - 1][0]).toUpperCase();
}

module.exports = { LEVELS, LABEL, NEEDS, EVERYONE, personKey, groupKey, defaultAccess, levelFor, can, isLocked, canSeeDoc, setRule, upsertPerson, initials, rank, normRel };
