CREATE TABLE products (
  id          text PRIMARY KEY,            -- p001..p024, shared with inventory seed data
  sku         text UNIQUE NOT NULL,
  name        text NOT NULL,
  description text NOT NULL,
  category    text NOT NULL,
  emoji       text NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX products_category_idx ON products (category);

CREATE TABLE product_reviews (
  id         bigserial PRIMARY KEY,
  product_id text NOT NULL REFERENCES products(id),
  rating     smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Intentionally NO index on product_reviews(product_id): a lab finds this slow query.

INSERT INTO products (id, sku, name, description, category, emoji, price_cents) VALUES
  ('p001', 'EL-HEAD-01', 'Wireless Headphones',  'Over-ear headphones with active noise cancelling.',        'electronics', '🎧', 12990),
  ('p002', 'EL-KEYB-01', 'Mechanical Keyboard',  'Hot-swappable switches, RGB backlight.',                    'electronics', '⌨️', 8990),
  ('p003', 'EL-MOUS-01', 'Ergonomic Mouse',      'Vertical mouse that is easy on the wrist.',                 'electronics', '🖱️', 3490),
  ('p004', 'EL-WTCH-01', 'Smart Watch',          'Heart-rate, GPS and a week of battery.',                    'electronics', '⌚', 24990),
  ('p005', 'EL-CAM-01',  'Action Camera',        '4K60 waterproof camera for adventures.',                    'electronics', '📷', 31990),
  ('p006', 'EL-SPKR-01', 'Bluetooth Speaker',    'Pocket-sized speaker with deep bass.',                      'electronics', '🔊', 5990),
  ('p007', 'BK-CLD-01',  'Cloud Architecture Patterns', 'Designing scalable distributed systems.',           'books',       '📘', 4500),
  ('p008', 'BK-OBS-01',  'Observability in Practice',   'Traces, metrics and logs for real systems.',        'books',       '📗', 4200),
  ('p009', 'BK-K8S-01',  'Kubernetes Up and Running',   'From pods to production clusters.',                 'books',       '📙', 4800),
  ('p010', 'BK-SRE-01',  'Site Reliability Basics',     'SLOs, error budgets and on-call.',                  'books',       '📕', 3900),
  ('p011', 'HM-MUG-01',  'Developer Coffee Mug', 'Holds enough coffee for one incident.',                     'home',        '☕', 1200),
  ('p012', 'HM-LAMP-01', 'Desk Lamp',            'Warm light with adjustable arm.',                           'home',        '💡', 2790),
  ('p013', 'HM-PLNT-01', 'Desk Plant',           'Low-maintenance succulent in a pot.',                       'home',        '🪴', 990),
  ('p014', 'HM-CHR-01',  'Office Chair',         'Mesh back with lumbar support.',                            'home',        '🪑', 28990),
  ('p015', 'HM-CLK-01',  'Wall Clock',           'Silent sweep movement.',                                    'home',        '🕰️', 1890),
  ('p016', 'FS-TSHT-01', 'Logo T-Shirt',         '100% cotton, says "it works on my machine".',               'fashion',     '👕', 1590),
  ('p017', 'FS-HOOD-01', 'Hoodie',               'Warm hoodie for cold server rooms.',                        'fashion',     '🧥', 3990),
  ('p018', 'FS-CAP-01',  'Baseball Cap',         'One size fits most.',                                       'fashion',     '🧢', 1290),
  ('p019', 'FS-SNKR-01', 'Running Sneakers',     'Lightweight with good grip.',                               'fashion',     '👟', 8990),
  ('p020', 'FS-BAG-01',  'Laptop Backpack',      'Fits a 16-inch laptop, water resistant.',                   'fashion',     '🎒', 5490),
  ('p021', 'SP-BALL-01', 'Football',             'Match-quality size 5 ball.',                                'sports',      '⚽', 2490),
  ('p022', 'SP-RCKT-01', 'Badminton Racket',     'Carbon frame, pre-strung.',                                 'sports',      '🏸', 4590),
  ('p023', 'SP-BTL-01',  'Water Bottle',         'Keeps drinks cold for 24 hours.',                           'sports',      '🧴', 1490),
  ('p024', 'SP-YOGA-01', 'Yoga Mat',             'Non-slip 6 mm mat.',                                        'sports',      '🧘', 2990);

-- 40 reviews per product
INSERT INTO product_reviews (product_id, rating, comment)
SELECT p.id,
       1 + floor(random() * 5)::int,
       'pending'  -- replaced with a comment that fits the rating by 002_review_comments_match_rating.sql
FROM products p, generate_series(1, 40);
