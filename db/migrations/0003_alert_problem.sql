-- Operator alerts (spec 004): one row per problem subject; messages are composed from the rows
-- whose state differs from the last state told to the operator (research R2).
CREATE TABLE alert_problem (
  key             text PRIMARY KEY,                -- feed:<id>, release:full|delta, job:<name>
  kind            text NOT NULL CHECK (kind IN ('feed', 'release', 'job')),
  subject         text NOT NULL,
  state           text NOT NULL CHECK (state IN ('open', 'closed')),
  opened_at       timestamptz NOT NULL,
  changed_at      timestamptz NOT NULL,            -- last change of state; orders message lines
  closed_at       timestamptz,
  details         jsonb NOT NULL DEFAULT '{}',     -- facts for the message; never a secret
  notified_state  text NOT NULL DEFAULT 'none' CHECK (notified_state IN ('none', 'open', 'closed')),
  notified_at     timestamptz
);

CREATE INDEX alert_problem_by_state ON alert_problem (state);
