// Read-only migration plan. Lists db/*.sql in the exact order `npm run migrate` applies them and checks the set is safe to run.
// Offline: checks names, order and duplicate names. With DATABASE_URL set it also compares with schema_migration (SELECT only, never writes).
// Usage: npm run migrate:plan
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "db");
const files = (await readdir(dir)).filter(f => f.endsWith(".sql")).sort();
let problems = 0;
const bad = m => { problems++; console.error(`PROBLEM: ${m}`); };

if (new Set(files).size !== files.length) bad("duplicate file names");
for (const f of files) if (!/^(\d{3}|\d{14})_[a-z0-9_]+\.sql$/.test(f)) bad(`unexpected name: ${f}`);
// Numbered files (NNN_) must all sort before timestamped files (14 digits), or order of application changes.
const firstStamp = files.findIndex(f => /^\d{14}_/.test(f));
if (firstStamp >= 0 && files.slice(firstStamp).some(f => /^\d{3}_/.test(f))) bad("a numbered file sorts after a timestamped one");
console.log(`${files.length} migration files, first ${files[0]}, last ${files.at(-1)}`);

if (process.env.DATABASE_URL) {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    const t = await c.query("SELECT to_regclass('public.schema_migration') AS t");
    const done = new Set(t.rows[0].t ? (await c.query("SELECT name FROM schema_migration")).rows.map(r => r.name) : []);
    const pending = files.filter(f => !done.has(f));
    const unknown = [...done].filter(f => !files.includes(f));
    console.log(`database: ${done.size} applied, ${pending.length} pending`);
    for (const f of pending) console.log(`  pending ${f}`);
    if (unknown.length) bad(`applied in the database but missing from db/: ${unknown.join(", ")}`);
  } finally { await c.end(); }
} else console.log("DATABASE_URL not set: offline check only.");
process.exit(problems ? 1 : 0);
