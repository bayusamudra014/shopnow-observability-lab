#!/usr/bin/env python3
"""Add products (with reviews and stock) to a running ShopNow.

    ./add-products.py 300                       # 300 new products after the highest existing id
    ./add-products.py 50 --context minikube     # kubectl context (minikube profile)
    ./add-products.py 100 --reviews 20 500      # 20..500 reviews per new product
    ./add-products.py 10 --dry-run              # print the SQL, change nothing

Writes to catalog_db (products, product_reviews) and inventory_db (stock) through
`kubectl exec` into the Postgres pod, so it needs only python3 and kubectl.
Product ids continue from the highest existing one (p025, p026, ...); running it again
adds more. The shop's catalog cache shows new products within about a minute.

Note: every review row makes un-indexed rating lookups slower (ticket 1 of the challenges).
"""
import argparse
import random
import subprocess
import sys

# category -> (noun, emoji, base price in cents)
ITEMS = {
    "electronics": [("Wireless Earbuds", "🎧", 7990), ("USB-C Hub", "🔌", 3490), ("Portable SSD", "💾", 11990),
                    ("Webcam", "📹", 6990), ("Power Bank", "🔋", 4490), ("Smart Speaker", "🔊", 9990),
                    ("Mechanical Keyboard", "⌨️", 8990), ("Gaming Mouse", "🖱️", 4990)],
    "books": [("Cloud Native Handbook", "📘", 4900), ("Distributed Systems Notes", "📗", 5500),
              ("Kafka in Depth", "📙", 4700), ("Practical SQL", "📕", 3900), ("Incident Response Guide", "📓", 4200),
              ("Kubernetes Patterns", "📘", 5200), ("The SRE Workbook", "📗", 4800)],
    "home": [("Ceramic Mug", "☕", 1490), ("LED Desk Lamp", "💡", 3290), ("Throw Blanket", "🛋️", 4590),
             ("Kitchen Knife Set", "🔪", 8990), ("Scented Candle", "🕯️", 1890), ("Wall Clock", "🕰️", 2490),
             ("Bath Towel Set", "🛁", 3990)],
    "fashion": [("Denim Jacket", "🧥", 7990), ("Canvas Sneakers", "👟", 6490), ("Wool Beanie", "🧢", 1990),
                ("Leather Wallet", "👛", 3990), ("Sunglasses", "🕶️", 5490), ("Cotton T-Shirt", "👕", 1990),
                ("Rain Jacket", "🧥", 8990)],
    "sports": [("Running Shorts", "🩳", 2990), ("Dumbbell Set", "🏋️", 9990), ("Bicycle Helmet", "🚴", 6990),
               ("Tennis Racket", "🎾", 8490), ("Hiking Backpack", "🎒", 10990), ("Yoga Block", "🧘", 1490),
               ("Football", "⚽", 2490)],
    "beauty": [("Face Moisturizer", "🧴", 2490), ("Lip Balm", "💄", 790), ("Hair Dryer", "💨", 5990),
               ("Perfume", "🌸", 8990), ("Sunscreen SPF 50", "☀️", 1990), ("Shampoo", "🧴", 1290)],
    "toys": [("Building Blocks", "🧱", 3990), ("Puzzle 1000 pcs", "🧩", 2290), ("Plush Bear", "🧸", 1990),
             ("RC Car", "🏎️", 5990), ("Board Game", "🎲", 3490), ("Kite", "🪁", 1590)],
    "grocery": [("Arabica Coffee Beans", "🫘", 1890), ("Green Tea", "🍵", 990), ("Dark Chocolate", "🍫", 590),
                ("Olive Oil", "🫒", 1490), ("Honey", "🍯", 1290), ("Granola", "🥣", 790)],
    "garden": [("Plant Pot", "🪴", 1590), ("Garden Hose", "🚿", 3490), ("Pruning Shears", "✂️", 2490),
               ("Seed Starter Kit", "🌱", 1990), ("Solar Garden Light", "🔆", 2990), ("Watering Can", "🪣", 1790)],
    "office": [("Notebook A5", "📒", 890), ("Gel Pen Pack", "🖊️", 690), ("Monitor Stand", "🖥️", 4990),
               ("Desk Organizer", "🗂️", 2490), ("Ergonomic Chair Cushion", "🪑", 3990), ("Whiteboard", "📋", 3490)],
}
STYLES = [  # name prefix, price factor, description
    ("Classic", 1.00, "The dependable everyday choice."),
    ("Mini", 0.70, "Compact and light, made to travel."),
    ("Eco", 0.90, "Made from recycled materials."),
    ("Plus", 1.25, "More of everything you liked about the classic."),
    ("Pro", 1.60, "Built for heavy daily use."),
    ("Max", 1.90, "Our top model, no compromises."),
]
EDITIONS = ["", "Midnight", "Sand", "Forest", "Ocean", "Coral", "Graphite", "Arctic"]
COMMENTS = {
    1: ["Broke after two days", "Not as described", "Very disappointed", "Would not recommend"],
    2: ["Could be better", "Arrived late and scratched", "Below expectations", "Meh, returned it"],
    3: ["Okay for the price", "Works as described", "Average quality", "Does the job"],
    4: ["Great value", "Very good, minor flaws", "Happy with it", "Arrived late but works great"],
    5: ["Love it", "Would buy again", "Excellent quality", "Exactly what I needed"],
}


def q(s: str) -> str:
    """SQL string literal."""
    return "'" + s.replace("'", "''") + "'"


def psql(args, db: str, sql: str, capture: bool = False) -> str:
    cmd = ["kubectl"] + (["--context", args.context] if args.context else []) + [
        "-n", args.namespace, "exec", "-i", args.pod, "--",
        "psql", "-U", args.user, "-d", db, "-v", "ON_ERROR_STOP=1", "-q", "-X"] + (["-At"] if capture else [])
    res = subprocess.run(cmd, input=sql.encode(), stdout=subprocess.PIPE if capture else None)
    if res.returncode != 0:
        sys.exit(f"psql on {db} failed (exit {res.returncode})")
    return res.stdout.decode().strip() if capture else ""


def catalog(count: int, offset: int = 0):
    """Yield (category, name, emoji, price_cents, description), unique names, mixed categories.
    offset: products this script added before, so a later run continues the sequence."""
    combos = [(cat, noun, emoji, base, style, factor, blurb, edition)
              for edition in EDITIONS
              for style, factor, blurb in STYLES
              for cat, items in ITEMS.items()
              for noun, emoji, base in items]
    for i in range(offset, offset + count):
        cat, noun, emoji, base, style, factor, blurb, edition = combos[i % len(combos)]
        name = f"{style} {noun}" + (f" {edition}" if edition else "")
        if i >= len(combos):
            name += f" #{i // len(combos) + 1}"
        price = max(190, int(round(base * factor / 100.0)) * 100 - 10)
        desc = blurb + (f" {edition} edition." if edition else "")
        yield cat, name, emoji, price, desc


def main():
    p = argparse.ArgumentParser(description="Add products (with reviews and stock) to a running ShopNow.")
    p.add_argument("count", type=int, help="how many products to add")
    p.add_argument("--reviews", nargs=2, type=int, default=[50, 3000], metavar=("MIN", "MAX"),
                   help="reviews per new product (default 50 3000)")
    p.add_argument("--stock", nargs=2, type=int, default=[20, 200], metavar=("MIN", "MAX"),
                   help="units in stock per new product (default 20 200)")
    p.add_argument("--context", help="kubectl context (e.g. minikube or shopnow)")
    p.add_argument("--namespace", default="infra")
    p.add_argument("--pod", default="postgres-0")
    p.add_argument("--user", default="shop")
    p.add_argument("--seed", type=int, help="random seed (repeatable prices and reviews)")
    p.add_argument("--dry-run", action="store_true", help="print the SQL instead of running it")
    args = p.parse_args()
    if args.count < 1 or args.count > 20000:
        sys.exit("count must be between 1 and 20000")
    if not (0 <= args.reviews[0] <= args.reviews[1] <= 20000) or not (0 <= args.stock[0] <= args.stock[1]):
        sys.exit("--reviews / --stock: MIN must be <= MAX (reviews at most 20000)")
    rnd = random.Random(args.seed)

    if args.dry_run:
        start = 25
    else:
        top = psql(args, "catalog_db", "SELECT coalesce(max(substring(id from 2)::int), 0) FROM products WHERE id ~ '^p[0-9]+$';", capture=True)
        start = int(top or 0) + 1
    width = max(3, len(str(start + args.count - 1)))
    rows = []
    # The shop ships p001..p024; the generated sequence continues after earlier runs.
    for k, (cat, name, emoji, price, desc) in enumerate(catalog(args.count, max(0, start - 25))):
        n = start + k
        pid = f"p{n:0{width}d}"
        sku = f"{cat[:2].upper()}-{n:05d}"
        rows.append((pid, sku, name, desc, cat, emoji, price, rnd.randint(*args.reviews), rnd.randint(*args.stock)))

    products_sql = ",\n".join(f"  ({q(r[0])}, {q(r[1])}, {q(r[2])}, {q(r[3])}, {q(r[4])}, {q(r[5])}, {r[6]})" for r in rows)
    counts_sql = ",\n".join(f"  ({q(r[0])}, {r[7]})" for r in rows)
    case = "\n".join(f"      WHEN {s} THEN ARRAY[{', '.join(q(c) for c in COMMENTS[s])}]" for s in (1, 2, 3, 4)) + \
        f"\n      ELSE ARRAY[{', '.join(q(c) for c in COMMENTS[5])}]"
    catalog_sql = f"""BEGIN;
INSERT INTO products (id, sku, name, description, category, emoji, price_cents) VALUES
{products_sql}
ON CONFLICT DO NOTHING;
-- Reviews: each product leans good or bad (its "quality"), comments match the stars.
WITH wanted(product_id, n) AS (VALUES
{counts_sql}
)
INSERT INTO product_reviews (product_id, rating, comment, created_at)
SELECT w.product_id, r.rating,
       (CASE r.rating
{case}
       END)[1 + (g * 7) % 4],
       now() - make_interval(mins => g * 3 + (hashtext(w.product_id) & 1023))
FROM wanted w
CROSS JOIN LATERAL generate_series(1, w.n) AS g
CROSS JOIN LATERAL (SELECT greatest(1, least(5,
    1 + ((hashtext(w.product_id || g::text) & 2147483647) % 5)
      + CASE hashtext(w.product_id) & 3 WHEN 0 THEN -1 WHEN 3 THEN 1 ELSE 0 END)) AS rating) r
WHERE NOT EXISTS (SELECT 1 FROM product_reviews x WHERE x.product_id = w.product_id);
COMMIT;
ANALYZE product_reviews;
"""
    stock_sql = "INSERT INTO stock (product_id, available) VALUES\n" + \
        ",\n".join(f"  ({q(r[0])}, {r[8]})" for r in rows) + "\nON CONFLICT (product_id) DO NOTHING;\n"

    if args.dry_run:
        print("-- catalog_db\n" + catalog_sql + "\n-- inventory_db\n" + stock_sql)
        return
    total_reviews = sum(r[7] for r in rows)
    print(f"adding {len(rows)} products ({rows[0][0]} .. {rows[-1][0]}) with {total_reviews} reviews ...", flush=True)
    psql(args, "catalog_db", catalog_sql)
    psql(args, "inventory_db", stock_sql)
    products = psql(args, "catalog_db", "SELECT count(*) FROM products;", capture=True)
    reviews = psql(args, "catalog_db", "SELECT count(*) FROM product_reviews;", capture=True)
    stock = psql(args, "inventory_db", "SELECT count(*) FROM stock;", capture=True)
    print(f"done: {products} products, {reviews} reviews, {stock} stock rows")
    print("the shop shows the new products within about a minute (catalog cache)")


if __name__ == "__main__":
    main()
