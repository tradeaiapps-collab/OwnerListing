import type { SendResult } from "../adapters/messaging";
import { SMS_NOTIFY_RATE, priceToMicros, statusAdvances, type SmsStatus } from "../domain/sms";
import type { Queryable } from "./db";

/** One text sent for a notification, with its segment count and estimated cost. Nothing about the text or the number is stored. */
export async function recordSmsMessage(
  db: Queryable, p: { userId: string; template: string; result: SendResult; segments: number; estMicros: number }
): Promise<void> {
  if (p.result.status === "not_configured") return;
  const r = p.result;
  try {
    await db.query(
      `INSERT INTO sms_message (user_id, template, provider_ref, status, error_code, segments, est_cost_micros)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7) ON CONFLICT (provider_ref) DO NOTHING`,
      [p.userId, p.template, r.status === "sent" ? (r.providerRef ?? null) : null, r.status === "sent" ? "queued" : "failed",
        r.status === "failed" ? r.errorCode : null, p.segments, r.status === "sent" ? p.estMicros : 0]);
  } catch {
    // The text may already have gone; a logging failure must not look like a send failure.
  }
}

/** True while the user is under the hourly and daily limit for notification texts. Fails open only on "no data": a query error skips the text. */
export async function smsWithinRate(db: Queryable, userId: string): Promise<boolean> {
  try {
    const r = await db.query(
      `SELECT count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS hour, count(*)::int AS day
         FROM sms_message WHERE user_id = $1::uuid AND status <> 'failed' AND created_at > now() - interval '1 day'`, [userId]);
    const x = r.rows[0];
    return Number(x?.["hour"] ?? 0) < SMS_NOTIFY_RATE.perHour && Number(x?.["day"] ?? 0) < SMS_NOTIFY_RATE.perDay;
  } catch {
    return false;
  }
}

export interface StatusReport { ref: string; status: SmsStatus; errorCode: string | null; price?: string | undefined; priceUnit?: string | undefined }

/**
 * Applies one provider status report. Every report for a known message is logged in the audit trail; the message row only moves forward
 * (a late "sent" never replaces "delivered"). "unknown" for a reference we did not send (a verification code, or another system).
 */
export async function applySmsStatus(db: Queryable, rep: StatusReport): Promise<"updated" | "logged" | "unknown"> {
  const run = async (tx: Queryable) => {
    const cur = await tx.query("SELECT status FROM sms_message WHERE provider_ref = $1 FOR UPDATE", [rep.ref]);
    const row = cur.rows[0];
    if (!row) return "unknown" as const;
    await tx.query("INSERT INTO sms_status_event (provider_ref, status, error_code) VALUES ($1,$2,$3)", [rep.ref, rep.status, rep.errorCode]);
    const price = priceToMicros(rep.price);
    const unit = typeof rep.priceUnit === "string" && /^[A-Za-z]{3}$/.test(rep.priceUnit) ? rep.priceUnit.toUpperCase() : null;
    const advance = statusAdvances(String(row["status"]) as SmsStatus, rep.status);
    if (!advance && price === null) return "logged" as const;
    await tx.query(
      `UPDATE sms_message SET status = CASE WHEN $2::boolean THEN $3::text ELSE status END,
              error_code = CASE WHEN $2::boolean THEN $4::text ELSE error_code END,
              delivered_at = CASE WHEN $2::boolean AND $3::text = 'delivered' THEN now() ELSE delivered_at END,
              price_micros = COALESCE($5::bigint, price_micros), price_unit = COALESCE($6::text, price_unit), updated_at = now()
        WHERE provider_ref = $1`, [rep.ref, advance, rep.status, rep.errorCode, price, price === null ? null : unit]);
    return advance ? "updated" as const : "logged" as const;
  };
  return db.transaction ? db.transaction(run) : run(db);
}

/**
 * A person replied STOP: every user holding this verified number gets texts switched off in every category, and each change goes in the
 * consent log. Returns how many users were changed.
 */
export async function applySmsStop(db: Queryable, phoneE164: string): Promise<number> {
  const run = async (tx: Queryable) => {
    const users = await tx.query("SELECT user_id FROM buyer_verification WHERE phone_e164 = $1 AND phone_verified_at IS NOT NULL", [phoneE164]);
    let changed = 0;
    for (const u of users.rows) {
      const off = await tx.query(
        "UPDATE notification_preference SET sms = false, updated_at = now() WHERE user_id = $1::uuid AND sms RETURNING category", [String(u["user_id"])]);
      for (const c of off.rows)
        await tx.query("INSERT INTO notification_consent_log (user_id, channel, category, granted, source) VALUES ($1::uuid,'sms',$2,false,'sms_stop')", [String(u["user_id"]), String(c["category"])]);
      if (off.rows.length > 0) changed++;
    }
    return changed;
  };
  return db.transaction ? db.transaction(run) : run(db);
}

export interface UsageRow { month: string; template: string; messages: number; segments: number; delivered: number; failed: number; estMicros: number; priceMicros: number }

/** Texts, segments and cost per month and template for the last `months` months (newest first): the lines an invoice or cost review needs. */
export async function smsUsage(db: Queryable, months: number): Promise<UsageRow[]> {
  const n = Math.min(Math.max(Math.trunc(months) || 1, 1), 24);
  const r = await db.query(
    `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month, template, count(*)::int AS messages, sum(segments)::int AS segments,
            count(*) FILTER (WHERE status = 'delivered')::int AS delivered, count(*) FILTER (WHERE status IN ('failed','undelivered'))::int AS failed,
            COALESCE(sum(est_cost_micros), 0)::bigint AS est, COALESCE(sum(price_micros), 0)::bigint AS price
       FROM sms_message WHERE created_at >= date_trunc('month', now()) - make_interval(months => $1::int - 1)
      GROUP BY 1, 2 ORDER BY 1 DESC, 2`, [n]);
  return r.rows.map(x => ({
    month: String(x["month"]), template: String(x["template"]), messages: Number(x["messages"]), segments: Number(x["segments"]),
    delivered: Number(x["delivered"]), failed: Number(x["failed"]), estMicros: Number(x["est"]), priceMicros: Number(x["price"])
  }));
}
