-- Cross-feature view over Elena's suggestions: one row per feature and A/B arm, with reactions and how linked deals ended.
-- A suggestion's arm and experiment are already stored on elena_suggestion (arm, experiment_key); deals are linked through offer_id.
CREATE VIEW elena_feature_analytics AS
SELECT s.feature,
       COALESCE(s.experiment_key, '') AS experiment_key,
       COALESCE(s.arm, '') AS arm,
       count(*) AS suggestions,
       count(f.action) AS reacted,
       count(*) FILTER (WHERE f.action IN ('accepted','modified')) AS accepted,
       count(*) FILTER (WHERE (s.context->>'weighted') = 'true') AS used_learned_weights,
       avg(f.rating)::numeric(4,2) AS mean_rating,
       count(so.outcome) FILTER (WHERE so.outcome = 'settled') AS deals_settled,
       count(so.outcome) FILTER (WHERE so.outcome = 'fell_through') AS deals_fell_through,
       avg(so.time_to_settlement_days) FILTER (WHERE so.outcome = 'settled')::numeric(8,1) AS avg_days_to_settle
  FROM elena_suggestion s
  LEFT JOIN LATERAL (SELECT action, rating FROM elena_feedback WHERE suggestion_id = s.id ORDER BY (source = 'user') DESC, created_at DESC, id DESC LIMIT 1) f ON true
  LEFT JOIN settlement_timeline st ON st.offer_id = s.offer_id
  LEFT JOIN settlement_outcomes so ON so.settlement_id = st.id
 GROUP BY s.feature, COALESCE(s.experiment_key, ''), COALESCE(s.arm, '');
