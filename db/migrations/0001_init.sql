-- Core IP Lookup schema (specs/001-core-ip-lookup/data-model.md).
-- Addresses and prefixes are cidr; history is tstzrange; lookups use GiST inet_ops.

CREATE TABLE scoring_config (
  id                serial PRIMARY KEY,
  version           text NOT NULL UNIQUE,
  algorithm_version text NOT NULL,
  body              jsonb NOT NULL,
  sha256            text NOT NULL UNIQUE,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE feed (
  id               text PRIMARY KEY,
  licence_status   text NOT NULL DEFAULT 'missing'
                   CHECK (licence_status IN ('shippable', 'local-only', 'missing')),
  licence_checked  date,
  last_attempt_at  timestamptz,
  last_success_at  timestamptz,
  entry_count      integer,
  stale            boolean NOT NULL DEFAULT false,
  last_error       text
);

CREATE TABLE feed_run (
  id                   bigserial PRIMARY KEY,
  feed_id              text NOT NULL REFERENCES feed (id),
  started_at           timestamptz NOT NULL,
  finished_at          timestamptz,
  status               text NOT NULL
                       CHECK (status IN ('started', 'licence_missing', 'failed', 'held', 'unchanged', 'applied')),
  -- Transaction timestamp of the data version a successful run created; lastSeen values use it.
  committed_at         timestamptz,
  content_sha256       text,
  entry_count          integer,
  previous_entry_count integer,
  invalid_lines        integer,
  artifact_path        text,
  error                text,
  confirmed_at         timestamptz,
  data_version_id      bigint
);

CREATE INDEX feed_run_by_feed ON feed_run (feed_id, started_at DESC);
CREATE INDEX feed_run_success ON feed_run (feed_id, committed_at)
  WHERE status IN ('applied', 'unchanged');

CREATE TABLE data_version (
  id                bigserial PRIMARY KEY,
  label             text NOT NULL UNIQUE,
  committed_at      timestamptz NOT NULL,
  scoring_config_id integer NOT NULL REFERENCES scoring_config (id),
  cause             text NOT NULL CHECK (cause IN ('feed_run', 'retention', 'config')),
  feed_run_id       bigint REFERENCES feed_run (id)
);

CREATE INDEX data_version_by_time ON data_version (committed_at DESC, id DESC);

ALTER TABLE feed_run
  ADD CONSTRAINT feed_run_data_version_fk FOREIGN KEY (data_version_id) REFERENCES data_version (id);

CREATE TABLE network_interval (
  id            bigserial PRIMARY KEY,
  prefix        cidr NOT NULL,
  asn           bigint,
  org           text,
  country       char(2),
  source        text NOT NULL,
  valid         tstzrange NOT NULL,
  opened_run_id bigint REFERENCES feed_run (id),
  closed_run_id bigint REFERENCES feed_run (id)
);

CREATE INDEX network_interval_lookup ON network_interval USING gist (prefix inet_ops, valid);
CREATE UNIQUE INDEX network_interval_open ON network_interval (prefix, source) WHERE upper_inf(valid);

CREATE TABLE category_interval (
  id            bigserial PRIMARY KEY,
  prefix        cidr NOT NULL,
  code          text NOT NULL,
  source        text NOT NULL,
  valid         tstzrange NOT NULL,
  last_seen     timestamptz NOT NULL,
  opened_run_id bigint REFERENCES feed_run (id),
  closed_run_id bigint REFERENCES feed_run (id),
  shippable     boolean NOT NULL
);

CREATE INDEX category_interval_lookup ON category_interval USING gist (prefix inet_ops, valid);
CREATE UNIQUE INDEX category_interval_open ON category_interval (prefix, code, source)
  WHERE upper_inf(valid);

-- Raw behavior observations (90 days): listing episodes, or one row per feed-provided time.
CREATE TABLE behavior_sighting (
  id           bigserial PRIMARY KEY,
  prefix       cidr NOT NULL,
  code         text NOT NULL,
  source       text NOT NULL,
  first_seen   timestamptz NOT NULL,
  last_seen    timestamptz NOT NULL,
  -- Commit time of the run that first stored this row; a lookup at T ignores rows recorded later.
  recorded_at  timestamptz NOT NULL,
  sightings    integer NOT NULL DEFAULT 1,
  first_run_id bigint NOT NULL REFERENCES feed_run (id),
  last_run_id  bigint NOT NULL REFERENCES feed_run (id),
  open         boolean NOT NULL,
  -- true when first_seen/last_seen are feed-provided observation times (timestamps: feed)
  feed_time    boolean NOT NULL DEFAULT false,
  confidence   real,
  shippable    boolean NOT NULL
);

CREATE INDEX behavior_sighting_lookup ON behavior_sighting USING gist (prefix inet_ops);
CREATE UNIQUE INDEX behavior_sighting_open ON behavior_sighting (source, code, prefix) WHERE open;
CREATE UNIQUE INDEX behavior_sighting_key ON behavior_sighting (source, code, prefix, first_seen);
CREATE INDEX behavior_sighting_retention ON behavior_sighting (last_seen);

-- Daily aggregates (kept 365 days after the raw window).
CREATE TABLE behavior_daily (
  prefix     cidr NOT NULL,
  code       text NOT NULL,
  source     text NOT NULL,
  day        date NOT NULL,
  count      integer NOT NULL,
  first_seen timestamptz NOT NULL,
  last_seen  timestamptz NOT NULL,
  confidence real,
  shippable  boolean NOT NULL,
  PRIMARY KEY (prefix, code, source, day)
);

CREATE INDEX behavior_daily_lookup ON behavior_daily USING gist (prefix inet_ops);
CREATE INDEX behavior_daily_retention ON behavior_daily (day);
