-- Public site and self-service accounts (specs/012-public-site/data-model.md). An account becomes a
-- foxauth user (issuer + subject); FoxTrust stores no name or email any more. Only adds or relaxes,
-- so the previous image keeps working on a rollback; name and contact are dropped later.

ALTER TABLE account
  ADD COLUMN issuer          text CHECK (issuer IS NULL OR char_length(issuer) BETWEEN 1 AND 255),
  ADD COLUMN subject         text CHECK (subject IS NULL OR char_length(subject) BETWEEN 1 AND 255),
  ADD COLUMN last_signin_at  timestamptz,
  ADD CONSTRAINT account_identity_whole CHECK ((issuer IS NULL) = (subject IS NULL)),
  ADD CONSTRAINT account_identity_unique UNIQUE (issuer, subject),
  ALTER COLUMN name DROP NOT NULL,
  ALTER COLUMN contact DROP NOT NULL;

CREATE TABLE site_session (
  id_sha256       bytea PRIMARY KEY CHECK (octet_length(id_sha256) = 32),  -- the cookie holds the id, never stored
  account_id      text NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  subject         text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 255),
  name            text NOT NULL CHECK (char_length(name) <= 200),          -- for display while the session lives
  email           text NOT NULL DEFAULT '' CHECK (char_length(email) <= 320),
  email_verified  boolean NOT NULL DEFAULT false,
  csrf            text NOT NULL,
  id_token        text NOT NULL CHECK (char_length(id_token) <= 8192),     -- only for id_token_hint at sign-out
  created_at      timestamptz NOT NULL,
  expires_at      timestamptz NOT NULL                                      -- created_at + 12 h, never extended
);

CREATE INDEX site_session_by_expiry ON site_session (expires_at);
