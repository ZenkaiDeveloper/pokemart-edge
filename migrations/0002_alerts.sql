-- M2.1 / PM-175 — Alerts engine (email, Discord webhook, RSS)
-- Sold-evidence changes on followed cards; at most daily delivery.

CREATE TABLE alert_rule (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  print_id TEXT NOT NULL,
  grade_label TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- median_above|median_below|pct_move_7d|new_comp|passport_change
  threshold INTEGER,                  -- cents for median_*; basis points for pct_move_7d
  channel TEXT NOT NULL,              -- email|discord_webhook|rss
  webhook_url TEXT,                   -- AES-GCM ciphertext (never plaintext at rest)
  created_at TEXT NOT NULL,
  disabled_at TEXT
);

CREATE INDEX idx_alert_rule_user ON alert_rule(user_id);
CREATE INDEX idx_alert_rule_active ON alert_rule(disabled_at, print_id, grade_label);

CREATE TABLE alert_event (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (rule_id, snapshot_date)
);

CREATE INDEX idx_alert_event_rule ON alert_event(rule_id);

CREATE TABLE delivery (
  event_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,               -- pending|sent|skipped|failed
  provider_id TEXT,
  attempted_at TEXT,
  error TEXT,
  PRIMARY KEY (event_id, channel)
);

CREATE TABLE email_prefs (
  user_id TEXT PRIMARY KEY,
  digest_hour_utc INTEGER,
  double_opt_in_at TEXT,
  unsubscribed_at TEXT,
  unsubscribe_token_hash TEXT UNIQUE
);

CREATE TABLE rss_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_rss_tokens_user ON rss_tokens(user_id);

-- Per-user daily delivery counters (UTC day).
CREATE TABLE alert_delivery_budget (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,                   -- YYYY-MM-DD UTC
  digest_sent INTEGER NOT NULL DEFAULT 0,
  immediate_sent INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- Enrich history so new_comp / passport_change can compare nights without a live prior dump.
ALTER TABLE ladder_history_90d ADD COLUMN passport_grade TEXT;
ALTER TABLE ladder_history_90d ADD COLUMN newest_sold_at TEXT;
