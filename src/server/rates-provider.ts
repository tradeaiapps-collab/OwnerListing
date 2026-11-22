import type { RatesProvider } from "../domain/rates-provider";
import type { Queryable } from "./db";
import { findAddressRatesPg } from "./address-rates-db";

/** The only provider today: the address_rates table staff fill from CSV at /staff/rates-data. */
export function tableRatesProvider(db: Queryable): RatesProvider {
  return { name: "Imported file", lookup: ({ state, address }) => findAddressRatesPg(db, state, address) };
}

/**
 * Where a real provider plugs in. Return an object implementing RatesProvider (docs/RATES_PROVIDERS.md); wrap it so the table is
 * still consulted first if staff overrides should win. No provider is licensed yet, so this is the table.
 */
export function getRatesProvider(db: Queryable): RatesProvider {
  return tableRatesProvider(db);
}
