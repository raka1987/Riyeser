// Riyeser prices (pricing v2): US dollars a month, per business (not per person). Change them here and every page follows.
// Each paid program includes 3 users; each extra user is US$7 a month for that program. POS has unlimited cashiers
// instead: 1 till included, US$15 a month for each extra till. Yearly = 10 months (2 months free).
// The database keeps the same list in riyeser_price() and riyeser_plan() (website/team/team-chat.sql) for billing and
// HQ's estimates, and team.js / hq.js have the same numbers: change them all.
export const PRICE = {
  basic: 25,      // Accounting Basics
  plus: 39,       // Accounting Plus (includes everything in Basics; never charged with Basics)
  bookings: 25,   // 3 staff calendars included
  calls: 20,      // Riyeser Link: chat, calls, desk phones, Riyeser Link Office, 20 GB of chat files (module id 'calls')
  payroll: 25,    // 3 office users included (who run pay or approve timesheets); unlimited employees
  pos: 29,        // 1 till included, unlimited cashiers
  as_built: 29,
  users_included: 3,
  extra_user: 7,
  tills_included: 1,
  extra_till: 15,
  extra_company: 10,
};
// The paid programs, in the order they're listed (A to Z): [module id, name].
export const PAID = [['basic', 'Accounting Basics'], ['plus', 'Accounting Plus'], ['bookings', 'Bookings'], ['calls', 'Riyeser Link'], ['payroll', 'Payroll'], ['pos', 'POS'], ['as_built', 'As Built']];
export const LOWEST = Math.min(...PAID.map(([m]) => PRICE[m]));
// Bundles: one price for the programs together. Each program in a bundle still includes 3 users (extra users US$7,
// extra tills US$15). Billing picks the bundle by itself when the programs chosen contain one.
export const BUNDLES = [
  { id: 'shop', name: 'Shop', mods: ['basic', 'pos', 'calls'], price: 59, who: 'For shops, cafes and takeaways' },
  { id: 'office', name: 'Office', mods: ['basic', 'payroll', 'calls'], price: 59, who: 'For offices with staff to pay' },
  { id: 'business', name: 'Business', mods: ['plus', 'bookings', 'calls', 'payroll', 'pos'], price: 99, who: 'Everything, for the whole business', popular: true },
];
/** What a bundle's programs cost one by one. */
export const separately = (b) => b.mods.reduce((n, m) => n + PRICE[m], 0);
// Riyeser Link file storage per business, in GB (space for files shared in chat; not hosting).
export const STORAGE_GB = { link: 20 };
/** 25 -> "US$25", 12.5 -> "US$12.50" */
export const usd = (n) => `US$${n % 1 ? n.toFixed(2) : n}`;

/** A plan's monthly price at list prices, the same sums as riyeser_plan() in the database.
 *  P = PRICE, B = BUNDLES, mods = module ids, users = {module: users} (missing: 3), tills = POS tills.
 *  Returns { mods, bundle, lines: [{ name, mods, price, extraUsers, extraTills, monthly }], total }.
 *  Written without anything from outside it, so the website's calculator can carry a copy of it. */
export function planPrice(P, B, mods, users, tills) {
  var ORDER = ['basic', 'plus', 'bookings', 'calls', 'payroll', 'pos', 'as_built'];
  var m = ORDER.filter(function (x) { return mods.indexOf(x) >= 0 && !(x === 'basic' && mods.indexOf('plus') >= 0); });
  var u = function (x) { var n = users && users[x] != null ? Math.round(Number(users[x])) : P.users_included; return Math.max(1, isFinite(n) ? n : P.users_included); };
  var t = Math.max(1, Math.round(Number(tills) || 1));
  var best = null, save = 0;
  B.forEach(function (b) {
    if (!b.mods.every(function (x) { return m.indexOf(x) >= 0; })) return;
    var s = b.mods.reduce(function (n, x) { return n + P[x]; }, 0) - b.price;
    if (s > save) { save = s; best = b; }
  });
  var lines = [], total = 0;
  var extras = function (list) {
    var eu = 0, et = 0;
    list.forEach(function (x) { if (x === 'pos') et = t - P.tills_included; else eu += Math.max(0, u(x) - P.users_included); });
    return [eu, Math.max(0, et)];
  };
  if (best) {
    var e = extras(best.mods), v = best.price + e[0] * P.extra_user + e[1] * P.extra_till;
    lines.push({ bundle: best.id, name: best.name + ' bundle', mods: best.mods.slice(), price: best.price, extraUsers: e[0], extraTills: e[1], monthly: v });
    total += v;
  }
  m.filter(function (x) { return !best || best.mods.indexOf(x) < 0; }).forEach(function (x) {
    var e2 = extras([x]), v2 = P[x] + e2[0] * P.extra_user + e2[1] * P.extra_till;
    lines.push({ module: x, mods: [x], price: P[x], extraUsers: e2[0], extraTills: e2[1], monthly: v2 });
    total += v2;
  });
  return { mods: m, bundle: best ? best.id : null, saves: save, lines: lines, total: total };
}
