const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const sources = require('../src/central/sources');

test('usage counts: invoices (not till sales), till sales, pay runs; missing files count nothing', async () => {
  const SQL = await require('sql.js')();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'use-'));
  const acc = new SQL.Database();
  acc.run(`CREATE TABLE documents (id INTEGER PRIMARY KEY, side TEXT, status TEXT); CREATE TABLE pos_sales (id INTEGER PRIMARY KEY, document_id INT, voided INT);
    INSERT INTO documents (side, status) VALUES ('sale','open'),('sale','paid'),('sale','void'),('purchase','open'),('sale','paid'),('sale','draft');
    INSERT INTO pos_sales (document_id, voided) VALUES (5, 0), (NULL, 1);`);
  fs.writeFileSync(path.join(dir, 'company.db'), Buffer.from(acc.export()));
  const pay = new SQL.Database(); pay.run('CREATE TABLE payroll_runs (id INTEGER PRIMARY KEY); INSERT INTO payroll_runs DEFAULT VALUES; INSERT INTO payroll_runs DEFAULT VALUES;');
  fs.writeFileSync(path.join(dir, 'payroll.db'), Buffer.from(pay.export()));
  assert.deepEqual(await sources.usageCounts({ accountingDb: path.join(dir, 'company.db'), payrollDb: path.join(dir, 'payroll.db') }), { invoices: 2, pos_sales: 1, pay_runs: 2 });
  assert.deepEqual(await sources.usageCounts({ accountingDb: path.join(dir, 'none.db') }), {});
});
