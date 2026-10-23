// Applies db/*.sql in filename order, once each, each in its own transaction. Usage: DATABASE_URL=... npm run migrate
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "db");
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is required."); process.exit(1); }

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query("CREATE TABLE IF NOT EXISTS schema_migration (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const done = new Set((await client.query("SELECT name FROM schema_migration")).rows.map(r => r.name));
  const files = (await readdir(dir)).filter(f => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    await client.query("BEGIN");
    try {
      await client.query(await readFile(path.join(dir, f), "utf8"));
      await client.query("INSERT INTO schema_migration (name) VALUES ($1)", [f]);
      await client.query("COMMIT");
      console.log(`applied ${f}`);
    } catch (e) {
      await client.query("ROLLBACK");
      console.error(`failed ${f}: ${e.message}`);
      process.exitCode = 1;
      break;
    }
  }
} finally {
  await client.end();
}
