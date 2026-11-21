# Council and water rates per address

Sale listings carry seller-stated rates (`listing_rates`, PR #326). This adds where a figure came from and an address-keyed source.

- **Source** (`listing_rates.source_kind`): `owner` (default), `staff`, `import`, `provider`. Buyers see it on the listing's "Rates and charges" card. An owner who edits and saves figures becomes the source, since they have reviewed them.
- **Import table** `address_rates`: staff load a CSV at `/staff/rates-data` (feeds.manage). Columns: address, state, council_amount, council_period, water_amount, water_period, water_usage_billed_separately. Match key = `addressKey()` in `src/domain/rates-provider.ts` (case, punctuation, street types, trailing state/postcode ignored).
- **Owner**: the rates form offers matching figures ("Use these figures"); nothing is saved until the owner saves. **Staff**: `PUT /api/staff/listings/:id/rates` with a named source, or `{ "fromImport": true }`.
- **Provider interface**: `RatesProvider.lookup({ state, address })` in `src/domain/rates-provider.ts`; wire a real one in `getRatesProvider()` (`src/server/rates-provider.ts`). Only licensed data may be loaded.
