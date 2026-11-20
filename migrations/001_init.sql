-- ShopCall initial schema (SQLite via better-sqlite3). UUIDs as TEXT, timestamps as UTC ISO-8601 TEXT.

CREATE TABLE owners (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE, -- HMAC-SHA256(SESSION_SECRET, token); raw token only lives in the cookie
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE businesses (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  hero_title TEXT,
  hero_subtitle TEXT,
  primary_color TEXT,
  contact_email TEXT,
  public_catalog_url TEXT,
  published_url TEXT,
  catalog_revision INTEGER NOT NULL DEFAULT 0 CHECK (catalog_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  storage_key TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  name TEXT NOT NULL,
  description TEXT,
  category TEXT,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  inventory_count INTEGER NOT NULL CHECK (inventory_count >= 0),
  image_asset_id TEXT REFERENCES assets(id),
  is_published INTEGER NOT NULL DEFAULT 0 CHECK (is_published IN (0, 1)),
  is_featured INTEGER NOT NULL DEFAULT 0 CHECK (is_featured IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX products_business ON products(business_id, is_published);

CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  operation TEXT NOT NULL,
  target_id TEXT,
  previous_values TEXT, -- JSON
  proposed_values TEXT NOT NULL, -- JSON ProductChange, exactly as submitted after validation
  expected_revision INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX drafts_business ON drafts(business_id, status);

CREATE TABLE build_jobs (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  provider TEXT NOT NULL,
  provider_job_id TEXT,
  build_status TEXT NOT NULL CHECK (build_status IN ('queued', 'running', 'completed', 'failed')),
  publication_status TEXT NOT NULL CHECK (publication_status IN ('pending', 'completed', 'failed')),
  public_url TEXT CHECK (public_url IS NULL OR publication_status = 'completed'),
  error_message TEXT,
  spec TEXT NOT NULL, -- JSON BuildSpec frozen at request time
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX build_jobs_queue ON build_jobs(build_status, created_at);
