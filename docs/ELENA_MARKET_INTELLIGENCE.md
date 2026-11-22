# Elena market intelligence

Pure maths in `src/domain/property-intelligence.ts` (AVM, market, comparables, trend; `avm-v1`) and `src/domain/market-forecast.ts` (this layer). Elena explains the numbers; she cannot change them, never gives advice, and says "unavailable" instead of guessing. Everything is advisory, not a valuation.

| Feature | Function | Route (signed-in, 240/hour per user, fails closed) | Model |
|---|---|---|---|
| Valuation breakdown | `valuationBreakdown` | `GET /api/intelligence/valuation` (`breakdown`) | steps always sum to the estimate |
| Comparable finder + similarity | `findComparableProperties` | `GET /api/intelligence/comparables` | similarity 0-100 from weight (recency, distance, features) |
| Neighbourhood trends | `valueTrend`, `marketInsights` | `/trends`, `/market` | rolling 3-month median, pace, days on market |
| Trend forecast | `forecastTrend` | `GET /api/intelligence/forecast` | `forecast-v1`: weighted log-linear fit, damped 0.92/month, 80% range |
| Fundamentals score | `investmentScore` | `GET /api/intelligence/investment` | `fundamentals-v1`: growth 30, yield 25, time to sell 20, momentum 15, consistency 10 (missing parts re-weighted) |
| Buyer demand | `demandOutlook` | `GET /api/intelligence/demand` | `demand-v1`: 8 weeks of saves (1), enquiries (3), offers (8); hidden under 12 weighted points |
| Market-shift alerts | `detectMarketShifts` | daily job `POST /api/internal/market-shifts/run` | notable at 5% price move, activity flip, 20% and 7 days on market, 40% buyer interest swing |
| Ask Elena | `extendedAnswer` | `POST /api/intelligence/ask` | topic match; declines "should I", "will prices", "good investment" |

Data: the platform's own sold/rented events, licensed feeds with `comparables_licensed`, and `PRICE_DATA_SOURCE` (see `src/server/property-intelligence.ts`). Buyer demand uses counts only from `saved_listing`, `enquiry` and `formal_offer`; no buyer or owner data leaves the database.

Limits: forecast is an extrapolation (needs 6+ months with 3+ results each); demand covers this platform only; yield compares median rent with median price (different property mix, before costs). Thresholds and weights are constants at the top of each section so the AI/ML lead can tune them with a version bump.

Deploy: apply migration `20261105200000_market_shift_alerts.sql`, set `MARKET_SHIFT_CRON_SECRET` and the repository secrets (docs/DEPLOYMENT.md 4e). Rollback: disable the workflow; routes are read-only.
