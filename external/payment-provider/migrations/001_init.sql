CREATE TABLE charges (
  id                 text PRIMARY KEY,                 -- ch_...
  idempotency_key    text UNIQUE,
  merchant_reference text NOT NULL,
  amount_cents       integer NOT NULL,
  currency           text NOT NULL,
  description        text,
  status             text NOT NULL,                    -- pending | succeeded | failed | refunded
  failure_code       text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX charges_ref_idx ON charges (merchant_reference);

CREATE TABLE refunds (
  id              text PRIMARY KEY,                    -- re_...
  charge_id       text NOT NULL REFERENCES charges(id),
  idempotency_key text UNIQUE,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_deliveries (
  id          bigserial PRIMARY KEY,
  event_id    text NOT NULL,
  charge_id   text NOT NULL,
  type        text NOT NULL,
  attempt     integer NOT NULL,
  status_code integer,
  error       text,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
