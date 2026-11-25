// Riyeser prices for the desktop programs: US dollars a month, per business (not per person). F3: one price list.
// This is a copy of riyeser.com's list (website/prices.mjs). test/prices.test.js fails if the two ever differ, so
// change website/prices.mjs first, then this file. Central's licence window and the "trial ended" messages read
// their prices from here, never from text of their own. Pricing v2: Riyeser Link (module 'calls') is a paid program.
const PRICE = Object.freeze({
  basic: 25,      // Accounting Basics
  plus: 39,       // Accounting Plus (includes everything in Basics; never charged with Basics)
  bookings: 25,   // 3 staff calendars included
  calls: 20,      // Riyeser Link: chat, calls, desk phones, Riyeser Link Office, 20 GB of chat files
  payroll: 25,    // 3 office users included; unlimited employees
  pos: 29,        // 1 till included, unlimited cashiers
  as_built: 29,
  users_included: 3,
  extra_user: 7,
  tills_included: 1,
  extra_till: 15,
  extra_company: 10,
});
// The paid programs, in the order they're listed (the same as website/prices.mjs PAID).
const PAID = [['basic', 'Accounting Basics'], ['plus', 'Accounting Plus'], ['bookings', 'Bookings'], ['calls', 'Riyeser Link'], ['payroll', 'Payroll'], ['pos', 'POS'], ['as_built', 'As Built']];
// The bundles (the same as website/prices.mjs BUNDLES): one price for the programs together.
const BUNDLES = [['Shop', ['basic', 'pos', 'calls'], 59], ['Office', ['basic', 'payroll', 'calls'], 59], ['Business', ['plus', 'bookings', 'calls', 'payroll', 'pos'], 99]];
const usd = (n) => `US$${n % 1 ? n.toFixed(2) : n}`;
const monthly = (id) => `${usd(PRICE[id])}/month`;

/** Everything the licence window says about prices, in one paragraph. */
function summary() {
  const list = PAID.map(([id, name]) => `${name} ${usd(PRICE[id])}${id === 'plus' ? ' (it includes Basics)' : ''}`);
  return 'All prices in US dollars, per business per month. Central, Desk Assistant, Invoices and PDF are free forever. '
    + `Every paid program is free for 90 days, no card, then: ${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}. `
    + `Each includes ${PRICE.users_included} users; each extra user is ${usd(PRICE.extra_user)} a month for that program (POS: 1 till and unlimited cashiers, each extra till ${usd(PRICE.extra_till)}). Your accountant signs in free. `
    + `Bundles: ${BUNDLES.map(([n, , p]) => `${n} ${usd(p)}`).join(', ')}. Pay yearly and get 2 months free. `
    + '🐣 Early bird: 50% off your first 12 months for the first 100 businesses. '
    + `Extra companies in Accounting: ${usd(PRICE.extra_company)} a month each.`;
}
/** What the renderer needs (it can't load this file itself). */
function forWindow() {
  return { summary: summary(), monthly: Object.fromEntries(PAID.map(([id]) => [id, monthly(id)])), extraUser: usd(PRICE.extra_user) };
}

module.exports = { PRICE, PAID, BUNDLES, usd, monthly, summary, forWindow };
