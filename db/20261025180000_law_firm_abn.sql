-- Optional ABN for a law firm, stored as 11 digits only. The checksum (weights 10,1,3,...,19; first digit minus 1; total divisible by 89)
-- is also enforced here, so a bad value cannot get in by any route. Format validity is not register confirmation.
CREATE FUNCTION abn_checksum_ok(a TEXT) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN a ~ '^[0-9]{11}$' THEN
    (SELECT sum((substr(a, t.i::int, 1)::int - CASE WHEN t.i = 1 THEN 1 ELSE 0 END) * t.w)
       FROM unnest(ARRAY[10,1,3,5,7,9,11,13,15,17,19]) WITH ORDINALITY AS t(w, i)) % 89 = 0
  ELSE false END
$$;

ALTER TABLE law_firm ADD COLUMN abn CHAR(11) CHECK (abn IS NULL OR abn_checksum_ok(abn));
