CREATE TABLE cart_items (
  user_id          text NOT NULL,
  product_id       text NOT NULL,
  name             text NOT NULL,
  emoji            text NOT NULL DEFAULT '',
  unit_price_cents integer NOT NULL,
  quantity         integer NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  added_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, product_id)
);
