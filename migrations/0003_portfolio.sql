-- M2.2 / PM-176 — Portfolio with real cost basis
-- Values only Passport A–C cells; unpriced holdings listed with reason.

CREATE TABLE holding (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  print_id TEXT NOT NULL,
  grade_label TEXT NOT NULL,
  condition_tier TEXT,
  qty INTEGER NOT NULL DEFAULT 1,
  cost_cents INTEGER,                 -- per-unit cost; NULL = unknown
  acquired_on TEXT,                   -- YYYY-MM-DD
  notes TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX idx_holding_user ON holding(user_id);
CREATE INDEX idx_holding_user_active ON holding(user_id, deleted_at);
CREATE INDEX idx_holding_print ON holding(print_id, grade_label);

CREATE TABLE sale (
  id TEXT PRIMARY KEY,
  holding_id TEXT NOT NULL,
  qty INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,       -- total sale price for qty
  fees_cents INTEGER,                 -- total fees for qty (NULL → compute eBay table)
  sold_on TEXT NOT NULL               -- YYYY-MM-DD
);

CREATE INDEX idx_sale_holding ON sale(holding_id);

CREATE TABLE valuation_history (
  user_id TEXT NOT NULL,
  as_of TEXT NOT NULL,                -- YYYY-MM-DD UTC
  value_cents INTEGER NOT NULL,
  n_priced INTEGER NOT NULL,
  n_unpriced INTEGER NOT NULL,
  PRIMARY KEY (user_id, as_of)
);

CREATE TABLE share_link (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  show_cost INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX idx_share_link_user ON share_link(user_id);
