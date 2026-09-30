-- Snapshot releases (specs/002-snapshot-distribution/data-model.md).

CREATE TABLE snapshot_release (
  id                bigserial PRIMARY KEY,
  version           text NOT NULL UNIQUE,
  kind              text NOT NULL CHECK (kind IN ('full', 'delta')),
  base_version      text,
  data_version_id   bigint NOT NULL REFERENCES data_version (id),
  algorithm_version text NOT NULL,
  config_sha256     text NOT NULL,
  built_at          timestamptz NOT NULL,
  status            text NOT NULL CHECK (status IN ('building', 'validated', 'held', 'published', 'rejected')),
  valid_from        timestamptz,
  valid_to          timestamptz,
  file_path         text,
  sha256            text,
  size_bytes        bigint,
  signing_key_id    text,
  record_count      integer,
  range_count       integer,
  sources           text[] NOT NULL DEFAULT '{}',  -- contributing sources (licence notices)
  report_path       text,
  release_note      text,
  error             text,
  CHECK ((kind = 'delta') = (base_version IS NOT NULL))
);

CREATE INDEX snapshot_release_current ON snapshot_release (kind, valid_from DESC) WHERE status = 'published';
