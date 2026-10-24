import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.join(__dirname, "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return name === "node_modules" || name === ".next" ? [] : files(p);
    return /\.(ts|tsx|mjs)$/.test(name) ? [p] : [];
  });
}

describe(".env.example", () => {
  it("lists every environment key read in src/, app/ and scripts/", () => {
    const re = /\benv(?:\.([A-Z][A-Z0-9_]+)|\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\])/g;
    const used = new Set<string>();
    for (const dir of ["src", "app", "scripts"]) {
      for (const f of files(path.join(root, dir))) {
        for (const m of readFileSync(f, "utf8").matchAll(re)) used.add((m[1] ?? m[2])!);
      }
    }
    const example = readFileSync(path.join(root, ".env.example"), "utf8");
    const listed = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map(m => m[1]!));
    expect(used.size).toBeGreaterThan(5);
    expect([...used].filter(k => !listed.has(k))).toEqual([]);
  });
});
