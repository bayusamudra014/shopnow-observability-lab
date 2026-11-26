-- A popular shop has thousands of reviews per product, not 40. With ~100k rows a rating
-- lookup without an index on product_id is a sequential scan that shows up in traces.
INSERT INTO product_reviews (product_id, rating, comment, created_at)
SELECT p.id, r.rating,
       (CASE r.rating
          WHEN 1 THEN ARRAY['Broke after two days', 'Not as described', 'Very disappointed', 'Would not recommend']
          WHEN 2 THEN ARRAY['Could be better', 'Arrived late and scratched', 'Below expectations', 'Meh, returned it']
          WHEN 3 THEN ARRAY['Okay for the price', 'Works as described', 'Average quality', 'Does the job']
          WHEN 4 THEN ARRAY['Great value', 'Very good, minor flaws', 'Happy with it', 'Arrived late but works great']
          ELSE        ARRAY['Love it', 'Would buy again', 'Excellent quality', 'Exactly what I needed']
        END)[1 + (g * 7) % 4],
       now() - (g || ' minutes')::interval
FROM products p
CROSS JOIN generate_series(1, 3960) AS g
CROSS JOIN LATERAL (SELECT 1 + ((hashtext(p.id || g::text) & 2147483647) % 5) AS rating) r;
ANALYZE product_reviews;
