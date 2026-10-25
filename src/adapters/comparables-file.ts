import { readFile } from "node:fs/promises";
import { parseComparables, type Comparable, type ComparablesSource } from "../domain/price-guidance";

/**
 * Comparables from a JSON file (an array of Comparable rows), for local testing or a licensed provider's export.
 * Use only data the platform is licensed to use (spec 5.2: "needs a licensed property data provider").
 * The file is read once and cached; a missing or bad file gives no comparables, so the card says "Estimate unavailable".
 */
export function createFileComparablesSource(path: string): ComparablesSource {
  let cache: Promise<Comparable[]> | undefined;
  const load = () => (cache ??= readFile(path, "utf8").then(t => parseComparables(JSON.parse(t)), () => []));
  return {
    id: "file",
    async find() {
      try { return await load(); } catch { return []; }
    }
  };
}
