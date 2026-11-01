-- M2.0 / PM-174 — Edge foundation schema (D1)
-- Derived price tables + user/auth only. Mac remains ledger of record.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  email_verified_at TEXT,
  created_at TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'free',
  locale TEXT,
  deleted_at TEXT
);

CREATE TABLE login_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE sessions (
  session_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ua_hash TEXT
);

CREATE TABLE consents (
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (user_id, kind, granted_at)
);

CREATE TABLE ladder_latest (
  print_id TEXT NOT NULL,
  grade_label TEXT NOT NULL,
  p25 INTEGER,
  p50 INTEGER,
  p75 INTEGER,
  n INTEGER NOT NULL,
  passport_grade TEXT NOT NULL,
  newest_sold_at TEXT,
  snapshot_date TEXT NOT NULL,
  PRIMARY KEY (print_id, grade_label)
);

CREATE TABLE ladder_history_90d (
  print_id TEXT NOT NULL,
  grade_label TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  p50 INTEGER,
  n INTEGER,
  PRIMARY KEY (print_id, grade_label, snapshot_date)
);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL
);

CREATE TABLE export_log (
  id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  ladder_latest_n INTEGER NOT NULL,
  history_n INTEGER NOT NULL,
  writes INTEGER NOT NULL
);
