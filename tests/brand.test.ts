import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readBrand } from "../src/config/brand";
import { smsConsentText } from "../src/domain/phone-verification";

const root = path.join(__dirname, "..");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return name === "node_modules" || name === ".next" ? [] : files(p);
    return /\.(ts|tsx|css)$/.test(name) ? [p] : [];
  });

describe("brand config", () => {
  it("defaults to OwnerListing and reads NEXT_PUBLIC_SITE_NAME before SITE_NAME", () => {
    expect(readBrand({}).name).toBe("OwnerListing");
    expect(readBrand({ SITE_NAME: "Acme Homes" }).name).toBe("Acme Homes");
    expect(readBrand({ NEXT_PUBLIC_SITE_NAME: " Pub ", SITE_NAME: "Acme" }).name).toBe("Pub");
    expect(readBrand({ NEXT_PUBLIC_SITE_NAME: "   " }).name).toBe("OwnerListing");
    expect(readBrand({ SITE_TAGLINE: "Own it" }).tagline).toBe("Own it");
  });
  it("feeds user-facing text", () => {
    expect(smsConsentText("Acme Homes")).toContain("Acme Homes may send");
  });
  it("no user-facing 'OwnerListing' literal remains in app/ or src/ outside src/config/brand.ts", () => {
    const hits: string[] = [];
    for (const dir of ["app", "src"]) {
      for (const f of files(path.join(root, dir))) {
        if (f.endsWith(path.join("config", "brand.ts"))) continue;
        readFileSync(f, "utf8").split("\n").forEach((line, i) => {
          if (/\bOwner ?Listing\b/i.test(line)) hits.push(`${path.relative(root, f)}:${i + 1}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });
});
