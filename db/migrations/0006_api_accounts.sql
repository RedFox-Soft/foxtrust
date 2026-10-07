-- Public API accounts, keys and usage (specs/010-public-api/data-model.md). Verdicts are not stored
-- here: the API answers from the published snapshot. No table holds a queried address (FR-013).

CREATE TABLE account (
  id           text PRIMARY KEY,                 -- acc_ + 12 base64url characters
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  contact      text NOT NULL CHECK (char_length(contact) BETWEEN 1 AND 320),
  created_at   timestamptz NOT NULL,
  disabled_at  timestamptz
);

CREATE TABLE api_key (
  id             text PRIMARY KEY,               -- the public part of ftk_<id>_<secret>
  account_id     text NOT NULL REFERENCES account (id),
  label          text NOT NULL DEFAULT '' CHECK (char_length(label) <= 100),
  secret_sha256  bytea NOT NULL CHECK (octet_length(secret_sha256) = 32),  -- never the secret itself
  tier           text NOT NULL DEFAULT 'free' CHECK (tier IN ('free')),
  daily_quota    integer CHECK (daily_quota BETWEEN 1 AND 10000000),       -- null: tier default
  burst          integer CHECK (burst BETWEEN 1 AND 1000),                 -- null: tier default
  created_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  last_used_at   timestamptz
);

CREATE INDEX api_key_by_account ON api_key (account_id);

CREATE TABLE api_usage_daily (
  key_id    text NOT NULL REFERENCES api_key (id),
  day       date NOT NULL,                       -- UTC day
  answered  integer NOT NULL DEFAULT 0,
  invalid   integer NOT NULL DEFAULT 0,
  limited   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, day)
);
