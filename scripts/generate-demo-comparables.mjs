// Writes a SYNTHETIC comparables file for local testing of property intelligence. Not real sales data.
// Usage: node scripts/generate-demo-comparables.mjs [out.json]
//   then in .env.local: PRICE_DATA_SOURCE=file  PRICE_DATA_FILE=/full/path/out.json
// Real use needs a licensed property data provider or the platform's own recorded sales (property_event).
import { writeFileSync } from "node:fs";

const out = process.argv[2] ?? "demo-comparables.json";
let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const areas = [
  { suburb: "Paddington", postcode: "4064", base: 1_450_000, growth: 0.07 },
  { suburb: "Chermside", postcode: "4032", base: 980_000, growth: 0.05 },
  { suburb: "Indooroopilly", postcode: "4068", base: 1_250_000, growth: 0.06 }
];
const rows = [];
const now = Date.now();
for (const a of areas) {
  for (let i = 0; i < 160; i++) {
    const monthsAgo = rnd() * 25;
    const beds = 2 + Math.floor(rnd() * 4);
    const price = a.base * (1 + (beds - 3) * 0.08) * (1 - a.growth * (monthsAgo / 12)) * (0.9 + rnd() * 0.2);
    const sold = new Date(now - monthsAgo * 30.44 * 86_400_000);
    rows.push({
      id: `demo-${a.postcode}-${i}`, transactionType: "sale", propertyType: rnd() < 0.8 ? "house" : "townhouse",
      priceCents: Math.round(price / 1000) * 1000 * 100, date: sold.toISOString(), suburb: a.suburb, postcode: a.postcode,
      bedrooms: beds, bathrooms: 1 + Math.floor(rnd() * 3), parking: Math.floor(rnd() * 3), areaSqm: Math.round(300 + rnd() * 500),
      daysOnMarket: Math.round(18 + rnd() * 50)
    });
    rows.push({
      id: `demo-rent-${a.postcode}-${i}`, transactionType: "rent", propertyType: "house", priceCents: Math.round((price * 0.0004) / 5) * 5 * 100,
      date: sold.toISOString(), suburb: a.suburb, postcode: a.postcode, bedrooms: beds, bathrooms: 2, parking: 1, daysOnMarket: Math.round(7 + rnd() * 25)
    });
  }
}
writeFileSync(out, JSON.stringify(rows));
console.log(`Wrote ${rows.length} synthetic rows to ${out}`);
