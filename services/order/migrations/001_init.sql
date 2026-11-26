CREATE TABLE orders (
  id              uuid PRIMARY KEY,
  user_id         text NOT NULL,
  user_email      text NOT NULL,
  status          text NOT NULL,           -- created | awaiting_payment | confirmed | cancelled
  total_cents     integer NOT NULL,
  items           jsonb NOT NULL,
  payment_id      uuid,
  failure_reason  text,
  idempotency_key text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX orders_user_idx ON orders (user_id, created_at DESC);
CREATE INDEX orders_open_idx ON orders (created_at) WHERE status IN ('created', 'awaiting_payment');

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
