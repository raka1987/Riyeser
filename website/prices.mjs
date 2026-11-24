// Riyeser prices: US dollars a month, per business (not per person). Change them here and every page follows.
// Each paid program includes 3 users; each extra user is US$5 a month for that program.
// The database keeps the same list in riyeser_price() (website/team/team-chat.sql) for HQ's estimates: change both.
export const PRICE = {
  basic: 25,      // Accounting Basics
  plus: 39,       // Accounting Plus (includes everything in Basics; never charged with Basics)
  payroll: 25,
  pos: 29,
  bookings: 25,
  calls: 39,      // Riyeser Link Plus: calls, desk phones, Riyeser Link Office
  as_built: 29,
  users_included: 3,
  extra_user: 5,
  extra_company: 10,
};
// The paid programs, in the order they're listed: [module id, name].
export const PAID = [['basic', 'Accounting Basics'], ['plus', 'Accounting Plus'], ['pos', 'POS'], ['bookings', 'Bookings'], ['payroll', 'Payroll'], ['calls', 'Riyeser Link Plus'], ['as_built', 'As Built']];
export const LOWEST = Math.min(...PAID.map(([m]) => PRICE[m]));
// Riyeser Link file storage per business, in GB.
export const STORAGE_GB = { free: 2, plus: 20 };
/** 25 -> "US$25", 12.5 -> "US$12.50" */
export const usd = (n) => `US$${n % 1 ? n.toFixed(2) : n}`;
