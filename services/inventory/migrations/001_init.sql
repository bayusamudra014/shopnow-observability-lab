CREATE TABLE stock (
  product_id text PRIMARY KEY,
  available  integer NOT NULL CHECK (available >= 0),
  reserved   integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reservations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id   uuid NOT NULL,
  product_id text NOT NULL REFERENCES stock(product_id),
  quantity   integer NOT NULL CHECK (quantity > 0),
  status     text NOT NULL DEFAULT 'reserved',   -- reserved | committed | released
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, product_id)
);
CREATE INDEX reservations_order_idx ON reservations (order_id);

INSERT INTO stock (product_id, available)
SELECT 'p' || lpad(i::text, 3, '0'), 50 + floor(random() * 100)::int
FROM generate_series(1, 24) AS i;
