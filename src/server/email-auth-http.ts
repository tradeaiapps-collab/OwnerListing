import { NextResponse } from "next/server";
import type { EmailAuthResult } from "./email-auth";

const STATUS = { invalid: 400, bad_credentials: 401, link_invalid: 400, account_exists: 409, rate_limited: 429, not_configured: 503 } as const;

/** The failure as a JSON error with its code, so the page can show the message and react to the code. */
export const emailAuthFailure = (r: Exclude<EmailAuthResult, { ok: true }>) => NextResponse.json({ error: r.message, code: r.code }, { status: STATUS[r.code] });
export const notConfigured = () => NextResponse.json({ error: "Sign-in is not configured.", code: "not_configured" }, { status: 503 });
