import { describe, expect, it } from "vitest";
import { createPgListingRepository, type Queryable } from "../src/server/db";

describe("listing repository ids", () => {
  it("answers 'no such listing' for a malformed id without querying (routes return 404, not 500)", async () => {
    let queried = false;
    const db: Queryable = { async query() { queried = true; return { rows: [] }; } };
    expect(await createPgListingRepository(db).get("1; DROP TABLE property_listing")).toBeUndefined();
    expect(queried).toBe(false);
  });
});
