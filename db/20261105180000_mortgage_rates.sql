-- Published home-loan rates (RBA table F5), one row per series and month. Public data: no personal information.
CREATE TABLE mortgage_rate (
  series      TEXT NOT NULL CHECK (series ~ '^[a-z_]{1,40}$'),
  rate_date   DATE NOT NULL,
  rate_pct    NUMERIC(6,3) NOT NULL CHECK (rate_pct > 0 AND rate_pct <= 25),
  source      TEXT NOT NULL DEFAULT 'rba_f5',
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (series, rate_date)
);
