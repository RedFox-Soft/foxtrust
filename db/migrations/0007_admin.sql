-- Operator admin panel (specs/011-admin-panel/data-model.md): sessions, requests the scheduler
-- carries out (it alone holds the signing key), and the audit trail of every change.

CREATE TABLE admin_session (
  id_sha256   bytea PRIMARY KEY CHECK (octet_length(id_sha256) = 32),  -- the cookie holds the id, never stored
  subject     text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 255),
  name        text NOT NULL CHECK (char_length(name) <= 200),
  csrf        text NOT NULL,
  id_token    text NOT NULL CHECK (char_length(id_token) <= 8192),       -- only for id_token_hint at sign-out
  created_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL                                        -- created_at + 8 h, never extended
);

CREATE INDEX admin_session_by_expiry ON admin_session (expires_at);

CREATE TABLE operator_request (
  id                    bigserial PRIMARY KEY,
  kind                  text NOT NULL CHECK (kind IN ('release', 'confirm_run')),
  target                text NOT NULL,                                     -- release version or feed run id
  note                  text CHECK (note IS NULL OR char_length(note) <= 1000),
  requested_by_subject  text NOT NULL,
  requested_by_name     text NOT NULL,
  requested_at          timestamptz NOT NULL,
  state                 text NOT NULL DEFAULT 'requested' CHECK (state IN ('requested', 'done', 'failed')),
  result                text CHECK (char_length(result) <= 2000),
  done_at               timestamptz,
  CHECK (kind <> 'release' OR char_length(note) BETWEEN 10 AND 1000)
);

-- One pending request per item.
CREATE UNIQUE INDEX operator_request_pending ON operator_request (kind, target) WHERE state = 'requested';
CREATE INDEX operator_request_by_state ON operator_request (state, requested_at);

CREATE TABLE admin_audit (
  id       bigserial PRIMARY KEY,
  at       timestamptz NOT NULL,
  subject  text NOT NULL,
  name     text NOT NULL,
  action   text NOT NULL,
  item     text,
  note     text,
  details  jsonb NOT NULL DEFAULT '{}'                                     -- never a secret, cookie or token
);

CREATE INDEX admin_audit_by_time ON admin_audit (at DESC);
