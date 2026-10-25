import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { objectStorageFromEnv } from "../../../../../src/adapters/object-storage";
import { getDb } from "../../../../../src/server/context";
import { runIdImageRetention } from "../../../../../src/server/id-image";
import { createPgIdImageStore } from "../../../../../src/server/id-image-db";
import { withApi } from "../../../../../src/server/api/with-api";

/**
 * Deletes ID images whose retention period is over (7 days after approval, 30 after rejection; counsel to confirm).
 * Called by a scheduler, or by staff tooling, with header x-cron-secret. Safe to call repeatedly.
 * FAILS CLOSED: 503 while ID_RETENTION_CRON_SECRET is unset or under 32 characters, or storage cannot delete; 401 on any mismatch.
 */
const digest = (s: string) => createHash("sha256").update(s).digest();

async function handlePost(req: Request) {
  const secret = process.env["ID_RETENTION_CRON_SECRET"];
  if (!secret || secret.length < 32) return NextResponse.json({ error: "ID image retention is not configured." }, { status: 503 });
  if (!timingSafeEqual(digest(req.headers.get("x-cron-secret") ?? ""), digest(secret))) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  const storage = objectStorageFromEnv(process.env);
  if (!storage.configured || typeof storage.remove !== "function") return NextResponse.json({ error: "Storage is not configured." }, { status: 503 });
  const counts = await runIdImageRetention({ store: createPgIdImageStore(getDb()), storage }, new Date().toISOString());
  return NextResponse.json({ counts });
}

export const POST = withApi(handlePost);
