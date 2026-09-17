-- BookBin schema. All CREATE statements are idempotent so this can be
-- executed on every app launch.

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  company_name TEXT NOT NULL DEFAULT '',
  company_address TEXT NOT NULL DEFAULT '',
  company_logo_path TEXT,
  incoming_prefix TEXT NOT NULL DEFAULT 'BILL-',
  incoming_next_number INTEGER NOT NULL DEFAULT 1,
  outgoing_prefix TEXT NOT NULL DEFAULT 'INV-',
  outgoing_next_number INTEGER NOT NULL DEFAULT 1,
  low_stock_threshold REAL NOT NULL DEFAULT 5
);
INSERT OR IGNORE INTO settings (id) VALUES (1);

CREATE TABLE IF NOT EXISTS vendors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku TEXT,
  name TEXT NOT NULL,
  description TEXT,
  unit TEXT NOT NULL DEFAULT 'ea',
  is_inventory INTEGER NOT NULL DEFAULT 1,
  quantity_on_hand REAL NOT NULL DEFAULT 0,
  default_cost REAL NOT NULL DEFAULT 0,
  default_price REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS incoming_invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vendor_id INTEGER REFERENCES vendors(id) ON DELETE SET NULL,
  invoice_number TEXT NOT NULL,
  invoice_date TEXT NOT NULL,
  notes TEXT,
  total REAL NOT NULL DEFAULT 0,
  paid INTEGER NOT NULL DEFAULT 0,
  received INTEGER NOT NULL DEFAULT 0,
  attachment_path TEXT,
  attachment_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS incoming_invoice_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES incoming_invoices(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 0,
  unit_cost REAL NOT NULL DEFAULT 0,
  line_total REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS outgoing_invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  invoice_number TEXT NOT NULL,
  invoice_date TEXT NOT NULL,
  notes TEXT,
  total REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  attachment_path TEXT,
  attachment_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS outgoing_invoice_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES outgoing_invoices(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES items(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 0,
  unit_price REAL NOT NULL DEFAULT 0,
  line_total REAL NOT NULL DEFAULT 0
);

-- Audit log of every stock change, so on-hand quantities are always
-- explainable and invoice edits/deletes can correctly reverse prior effects.
CREATE TABLE IF NOT EXISTS inventory_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  delta REAL NOT NULL,
  reason TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_incoming_lines_invoice ON incoming_invoice_lines(invoice_id);
CREATE INDEX IF NOT EXISTS idx_outgoing_lines_invoice ON outgoing_invoice_lines(invoice_id);
CREATE INDEX IF NOT EXISTS idx_adjustments_item ON inventory_adjustments(item_id);
CREATE INDEX IF NOT EXISTS idx_adjustments_source ON inventory_adjustments(source_type, source_id);
