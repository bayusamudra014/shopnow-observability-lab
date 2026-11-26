-- The first seed picked review comments at random, so a 1-star review could say "Love it".
-- Give every review a comment that fits its star rating. ((id * 7) % 4) picks one of the
-- four comments per rating deterministically, so re-seeding gives the same text.
UPDATE product_reviews
SET comment = (CASE rating
  WHEN 1 THEN ARRAY['Broke after two days', 'Not as described', 'Very disappointed', 'Would not recommend']
  WHEN 2 THEN ARRAY['Could be better', 'Arrived late and scratched', 'Below expectations', 'Meh, returned it']
  WHEN 3 THEN ARRAY['Okay for the price', 'Works as described', 'Average quality', 'Does the job']
  WHEN 4 THEN ARRAY['Great value', 'Very good, minor flaws', 'Happy with it', 'Arrived late but works great']
  ELSE        ARRAY['Love it', 'Would buy again', 'Excellent quality', 'Exactly what I needed']
END)[1 + (id * 7) % 4];
