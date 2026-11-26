CREATE TABLE payments (
  id                 uuid PRIMARY KEY,
  order_id           uuid UNIQUE NOT NULL,
  user_id            text NOT NULL,
  amount_cents       integer NOT NULL,
  currency           text NOT NULL DEFAULT 'USD',
  status             text NOT NULL,          -- pending | succeeded | failed | refunded
  provider_charge_id text UNIQUE,
  failure_reason     text,
  trace_context      jsonb NOT NULL DEFAULT '{}',  -- W3C context of the checkout, used for span links
  resolved_by        text,                   -- create | webhook | reconciler
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_pending_idx ON payments (created_at) WHERE status = 'pending';

-- Webhook event ids already processed (providers deliver "at least once").
CREATE TABLE webhook_events (
  event_id    text PRIMARY KEY,
  charge_id   text NOT NULL,
  type        text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE outbox (
  id           bigserial PRIMARY KEY,
  topic        text NOT NULL,
  key          text NOT NULL,
  payload      jsonb NOT NULL,
  headers      jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX outbox_pending_idx ON outbox (id) WHERE published_at IS NULL;
