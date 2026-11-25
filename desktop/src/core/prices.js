// Riyeser prices for the desktop programs: US dollars a month, per business (not per person). F3: one price list.
// This is a copy of riyeser.com's list (website/prices.mjs). test/prices.test.js fails if the two ever differ, so
// change website/prices.mjs first, then this file. Central's licence window, the "trial ended" messages and the
// Link Plus pill all read their prices from here, never from text of their own.
const PRICE = Object.freeze({
  basic: 25,      // Accounting Basics
  plus: 39,       // Accounting Plus (includes everything in Basics; never charged with Basics)
  payroll: 25,
  pos: 29,
  bookings: 25,
  calls: 39,      // Riyeser Link Plus: calls, desk phones, Riyeser Link Office
  as_built: 29,
  users_included: 3,
  extra_user: 7,
  extra_company: 10,
});
// The paid programs, in the order they're listed (the same as website/prices.mjs PAID).
const PAID = [['basic', 'Accounting Basics'], ['plus', 'Accounting Plus'], ['pos', 'POS'], ['bookings', 'Bookings'], ['payroll', 'Payroll'], ['calls', 'Riyeser Link Plus'], ['as_built', 'As Built']];
const usd = (n) => `US$${n % 1 ? n.toFixed(2) : n}`;
const monthly = (id) => `${usd(PRICE[id])}/month`;

/** Everything the licence window says about prices, in one paragraph. */
function summary() {
  const list = PAID.map(([id, name]) => `${name} ${usd(PRICE[id])}${id === 'plus' ? ' (it includes Basics)' : ''}`);
  return 'All prices in US dollars, per business per month. Central, Invoices, PDF, Desk Assistant and Riyeser Link chat are free forever. '
    + `Every paid program is free for 90 days, no card, then: ${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}. `
    + `Each includes ${PRICE.users_included} users; each extra user is ${usd(PRICE.extra_user)} a month for that program. `
    + '🐣 Early bird: 50% off your first 12 months for the first 100 businesses. '
    + `Extra companies in Accounting: ${usd(PRICE.extra_company)} a month each.`;
}
/** What the renderer needs (it can't load this file itself). */
function forWindow() {
  return { summary: summary(), monthly: Object.fromEntries(PAID.map(([id]) => [id, monthly(id)])), extraUser: usd(PRICE.extra_user) };
}

module.exports = { PRICE, PAID, usd, monthly, summary, forWindow };
