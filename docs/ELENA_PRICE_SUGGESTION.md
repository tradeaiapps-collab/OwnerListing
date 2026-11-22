# Elena asking-price suggestion

Shown on the owner's approve screen (`/listings/<id>/approve`) and the last step of the edit page. API: `GET /api/listings/<id>/price-suggestion` (owner or appointed agent only, never public, `no-store`, each view audited as `listing.price_suggestion_shown`).
Code: `src/domain/price-suggestion.ts` (pure rules), `src/server/price-suggestion.ts` (data loading, provider hook), `app/listings/elena-price-suggestion.tsx`.

## What it uses (in order)
1. A licensed provider valuation, if a provider is plugged in (none today).
2. Sold or leased results: platform `property_event` rows (not voided) plus `PRICE_DATA_SOURCE=file` rows, via the existing `getIntelligenceSource`. Same type group, same suburb/postcode, 6 months (12 if few). Adjusted for beds, baths, parking (existing `estimatePrice`) and scaled gently for land size ((area ratio)^0.2, capped +/-15%).
3. Other published listings in the suburb or postcode (asking prices, last 12 months). Confidence is always low and the screen says they are not sales. Street addresses are never shown, only the suburb.
4. One or two comparables: +/-15% around them, low confidence.
5. Suburb median from `suburb_profile` (house or unit median, or weekly rent): +/-20%, low confidence, names its source and date.
6. Otherwise "not enough data" with the reasons. No number is invented.

Confidence: high >= 0.7, medium >= 0.5, otherwise low; fewer than 3 comparables is always low.
Never priced in (stated on screen): condition, renovations, views, street, photos, amenities, and inspection/pest report findings (the screen notes when reports exist).
The owner's current price is compared with the range in neutral words. There is no button that sets the price.

## Plugging in a real data source
Implement `PriceProvider` (`src/domain/price-suggestion.ts`): `sales()` returns `Comparable[]` (joins the platform's sold results) and/or `valuation()` returns a range (wins when present). Return it from `getPriceProvider()` in `src/server/price-suggestion.ts`. Must never throw. Check the licence allows showing rows to owners and storing them. Candidates: PriceFinder, CoreLogic, Domain/REA data APIs, or a state valuer open dataset loaded as `PRICE_DATA_FILE` JSON today.
