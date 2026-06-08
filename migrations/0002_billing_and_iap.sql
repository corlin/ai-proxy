CREATE TABLE IF NOT EXISTS user_wallets (
  tenant_id TEXT PRIMARY KEY,
  tier TEXT NOT NULL DEFAULT 'free',
  balance INTEGER NOT NULL DEFAULT 10000,
  apple_original_transaction_id TEXT,
  subscription_expires_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS iap_transactions (
  transaction_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

ALTER TABLE usage_events ADD COLUMN tokens_used INTEGER;
ALTER TABLE usage_events ADD COLUMN credits_used INTEGER;
