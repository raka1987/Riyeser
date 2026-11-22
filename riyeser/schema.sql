-- Riyeser Accounting schema. All money is stored as INTEGER cents.
PRAGMA foreign_keys = ON;

CREATE TABLE company (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL,
    abn TEXT,
    address TEXT,
    phone TEXT,
    email TEXT,
    fy_start_month INTEGER NOT NULL DEFAULT 7,   -- July (Australian FY)
    lock_date TEXT,                              -- no postings on/before this date
    gst_registered INTEGER NOT NULL DEFAULT 1,
    invoice_prefix TEXT NOT NULL DEFAULT 'INV',
    bill_prefix TEXT NOT NULL DEFAULT 'PO',
    next_invoice_no INTEGER NOT NULL DEFAULT 1,
    next_bill_no INTEGER NOT NULL DEFAULT 1,
    default_terms_days INTEGER NOT NULL DEFAULT 30
);

CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT,
    role TEXT NOT NULL CHECK (role IN ('admin','accountant','viewer')),
    perms TEXT,                  -- per-area levels as JSON (riyeser/perms.py); empty = follow the role
    active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('asset','liability','equity','income',
                                       'cost_of_sales','expense','other_income','other_expense')),
    is_bank INTEGER NOT NULL DEFAULT 0,
    tax_code_id INTEGER REFERENCES tax_codes(id),
    description TEXT,
    active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE tax_codes (
    id INTEGER PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    rate REAL NOT NULL DEFAULT 0,
    kind TEXT NOT NULL CHECK (kind IN ('gst','gst_free','export','input_taxed','capital','not_reportable')),
    collected_account_id INTEGER REFERENCES accounts(id),
    paid_account_id INTEGER REFERENCES accounts(id)
);

-- Control accounts used automatically by each kind of transaction
CREATE TABLE linked_accounts (
    key TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id)
);

CREATE TABLE jobs (
    id INTEGER PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    contact_id INTEGER REFERENCES contacts(id),
    active INTEGER NOT NULL DEFAULT 1
);

-- Card file: customers and suppliers
CREATE TABLE contacts (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('customer','supplier')),
    name TEXT NOT NULL,
    abn TEXT,
    contact_person TEXT,
    email TEXT,
    phone TEXT,
    address TEXT,
    terms_days INTEGER,
    credit_limit INTEGER,
    default_account_id INTEGER REFERENCES accounts(id),
    tax_code_id INTEGER REFERENCES tax_codes(id),
    notes TEXT,
    active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE items (
    id INTEGER PRIMARY KEY,
    sku TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    is_sold INTEGER NOT NULL DEFAULT 1,
    is_bought INTEGER NOT NULL DEFAULT 1,
    is_inventoried INTEGER NOT NULL DEFAULT 0,
    sell_price INTEGER NOT NULL DEFAULT 0,
    buy_price INTEGER NOT NULL DEFAULT 0,
    income_account_id INTEGER REFERENCES accounts(id),
    expense_account_id INTEGER REFERENCES accounts(id),  -- COGS when inventoried
    asset_account_id INTEGER REFERENCES accounts(id),
    sale_tax_code_id INTEGER REFERENCES tax_codes(id),
    purchase_tax_code_id INTEGER REFERENCES tax_codes(id),
    qty_on_hand REAL NOT NULL DEFAULT 0,
    avg_cost REAL NOT NULL DEFAULT 0,            -- cents per unit
    reorder_level REAL NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE stock_movements (
    id INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES items(id),
    date TEXT NOT NULL,
    qty REAL NOT NULL,
    unit_cost REAL NOT NULL,
    source_type TEXT NOT NULL,
    source_id INTEGER,
    memo TEXT
);

-- General ledger
CREATE TABLE journal_entries (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL,
    memo TEXT,
    reference TEXT,
    source_type TEXT NOT NULL,   -- journal, invoice, bill, receipt, payment, spend, receive, transfer, payrun, stock_adj, reversal
    source_id INTEGER,
    contact_id INTEGER REFERENCES contacts(id),
    reverses_id INTEGER REFERENCES journal_entries(id),
    voided INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE journal_lines (
    id INTEGER PRIMARY KEY,
    entry_id INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    debit INTEGER NOT NULL DEFAULT 0,
    credit INTEGER NOT NULL DEFAULT 0,
    tax_code_id INTEGER REFERENCES tax_codes(id),
    job_id INTEGER REFERENCES jobs(id),
    memo TEXT,
    reconciliation_id INTEGER REFERENCES reconciliations(id)
);
CREATE INDEX idx_lines_account ON journal_lines(account_id);
CREATE INDEX idx_lines_entry ON journal_lines(entry_id);
CREATE INDEX idx_entries_date ON journal_entries(date);

-- Sales & purchase documents (quotes, orders, invoices, bills)
CREATE TABLE documents (
    id INTEGER PRIMARY KEY,
    side TEXT NOT NULL CHECK (side IN ('sale','purchase')),
    status TEXT NOT NULL CHECK (status IN ('quote','order','open','paid','void')),
    number TEXT NOT NULL,
    contact_id INTEGER NOT NULL REFERENCES contacts(id),
    date TEXT NOT NULL,
    due_date TEXT,
    reference TEXT,           -- customer PO / supplier invoice number
    notes TEXT,
    tax_inclusive INTEGER NOT NULL DEFAULT 0,
    subtotal INTEGER NOT NULL DEFAULT 0,
    tax_total INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    amount_paid INTEGER NOT NULL DEFAULT 0,
    entry_id INTEGER REFERENCES journal_entries(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE document_lines (
    id INTEGER PRIMARY KEY,
    document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    item_id INTEGER REFERENCES items(id),
    description TEXT,
    qty REAL NOT NULL DEFAULT 1,
    unit_price INTEGER NOT NULL DEFAULT 0,
    discount_pct REAL NOT NULL DEFAULT 0,
    account_id INTEGER REFERENCES accounts(id),
    tax_code_id INTEGER REFERENCES tax_codes(id),
    job_id INTEGER REFERENCES jobs(id),
    net_amount INTEGER NOT NULL DEFAULT 0,
    tax_amount INTEGER NOT NULL DEFAULT 0
);

-- Customer receipts / supplier payments
CREATE TABLE payments (
    id INTEGER PRIMARY KEY,
    direction TEXT NOT NULL CHECK (direction IN ('in','out')),
    contact_id INTEGER NOT NULL REFERENCES contacts(id),
    bank_account_id INTEGER NOT NULL REFERENCES accounts(id),
    date TEXT NOT NULL,
    amount INTEGER NOT NULL,
    reference TEXT,
    memo TEXT,
    voided INTEGER NOT NULL DEFAULT 0,
    entry_id INTEGER REFERENCES journal_entries(id)
);

CREATE TABLE payment_allocations (
    id INTEGER PRIMARY KEY,
    payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
    document_id INTEGER NOT NULL REFERENCES documents(id),
    amount INTEGER NOT NULL
);

-- Banking
CREATE TABLE reconciliations (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    statement_date TEXT NOT NULL,
    statement_balance INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE bank_feed_lines (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    date TEXT NOT NULL,
    description TEXT,
    amount INTEGER NOT NULL,          -- +ve deposit, -ve withdrawal
    entry_id INTEGER REFERENCES journal_entries(id),
    imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Payroll
CREATE TABLE employees (
    id INTEGER PRIMARY KEY,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT,
    tfn TEXT,
    start_date TEXT,
    pay_basis TEXT NOT NULL CHECK (pay_basis IN ('hourly','salary')),
    hourly_rate INTEGER NOT NULL DEFAULT 0,
    annual_salary INTEGER NOT NULL DEFAULT 0,
    std_hours REAL NOT NULL DEFAULT 38,
    pay_frequency TEXT NOT NULL DEFAULT 'weekly' CHECK (pay_frequency IN ('weekly','fortnightly','monthly')),
    tax_free_threshold INTEGER NOT NULL DEFAULT 1,
    super_rate REAL NOT NULL DEFAULT 12.0,
    super_fund TEXT,
    bank_bsb TEXT,
    bank_account TEXT,
    leave_hours REAL NOT NULL DEFAULT 0,
    job_id INTEGER REFERENCES jobs(id),
    active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE payruns (
    id INTEGER PRIMARY KEY,
    pay_date TEXT NOT NULL,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    frequency TEXT NOT NULL,
    bank_account_id INTEGER NOT NULL REFERENCES accounts(id),
    entry_id INTEGER REFERENCES journal_entries(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE payslips (
    id INTEGER PRIMARY KEY,
    payrun_id INTEGER NOT NULL REFERENCES payruns(id) ON DELETE CASCADE,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    hours REAL NOT NULL DEFAULT 0,
    gross INTEGER NOT NULL,
    tax INTEGER NOT NULL,
    super INTEGER NOT NULL,
    net INTEGER NOT NULL,
    leave_accrued REAL NOT NULL DEFAULT 0
);

-- Budgets (per account per month)
CREATE TABLE budgets (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    month TEXT NOT NULL,          -- YYYY-MM
    amount INTEGER NOT NULL,
    UNIQUE(account_id, month)
);

CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    user_id INTEGER REFERENCES users(id),
    action TEXT NOT NULL,
    details TEXT
);
