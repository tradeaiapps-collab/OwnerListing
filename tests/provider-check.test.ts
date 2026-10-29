import { describe, expect, it } from "vitest";
import { checkProviders, formatReport, isPlaceholder, type ProviderId, type ProviderResult } from "../src/config/provider-check.mjs";
import { readAuthEnv } from "../src/server/auth/config";
import { mfaKeyUsable } from "../src/domain/mfa";
import { resolveMessaging } from "../src/domain/messaging-settings";

const FULL: Record<string, string> = {
  APP_URL: "https://www.example.com.au",
  SESSION_SECRET: "a".repeat(48),
  GOOGLE_CLIENT_ID: "123-abc.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "GOCSPX-realLookingSecret",
  MFA_SECRET_KEY: Buffer.alloc(32, 7).toString("base64"),
  PAYWAY_MERCHANT_ID: "TEST123",
  PAYWAY_API_KEY: "Q12345_SEC_abcdefgh",
  PAYWAY_WEBHOOK_SECRET: "w".repeat(40),
  SMTP_HOST: "smtp.mailprovider.com",
  SMTP_PORT: "587",
  SMTP_FROM: "no-reply@example.com.au",
  SMTP_USER: "apikey",
  SMTP_PASSWORD: "s3cr3t-pass",
  SMS_PROVIDER: "twilio",
  SMS_ACCOUNT_SID: `AC${"0".repeat(32)}`,
  SMS_AUTH_TOKEN: "t".repeat(32),
  SMS_SENDER: "+61400000000",
  SMS_CODE_SECRET: "c".repeat(40),
  ABN_LOOKUP_GUID: "12345678-90ab-cdef-1234-567890abcdef",
  NEXT_PUBLIC_MAP_TILE_URL: "https://tiles.example.com/{z}/{x}/{y}.png",
  NEXT_PUBLIC_MAP_ATTRIBUTION: "© Example Maps"
};
const by = (env: Record<string, string | undefined>, production = true) =>
  Object.fromEntries(checkProviders(env, { production }).map(r => [r.id, r])) as Record<ProviderId, ProviderResult>;

describe("provider readiness check", () => {
  it("reports every provider ready with a full set of real-looking keys", () => {
    const r = checkProviders(FULL, { production: true });
    expect(r.map(x => x.id)).toEqual(["google", "mfa", "payway", "smtp", "sms", "abn", "maptiles"]);
    expect(r.filter(x => x.status !== "ready")).toEqual([]);
    expect(r.some(x => x.blocking)).toBe(false);
  });

  it("an empty production env blocks on the required providers only", () => {
    const r = by({});
    expect(Object.values(r).every(x => x.status === "off")).toBe(true);
    expect(Object.values(r).filter(x => x.blocking).map(x => x.id)).toEqual(["google", "mfa", "maptiles"]);
    expect(Object.values(by({}, false)).some(x => x.blocking)).toBe(false);
  });

  it("refuses placeholder values and never prints a value", () => {
    for (const v of ["changeme", "your-client-id", "<paste here>", "xxxx", "REPLACE with key", "TODO"]) expect(isPlaceholder(v)).toBe(true);
    expect(isPlaceholder(FULL.GOOGLE_CLIENT_SECRET!)).toBe(false);
    const r = by({ ...FULL, PAYWAY_API_KEY: "changeme", SMTP_PASSWORD: "your-password" });
    expect(r.payway.status).toBe("invalid");
    expect(r.payway.blocking).toBe(true);
    expect(r.smtp.status).toBe("invalid");
    const text = formatReport(Object.values(r));
    expect(text).toContain("PAYWAY_API_KEY looks like a placeholder");
    for (const v of Object.values(FULL)) expect(text).not.toContain(v);
  });

  it("a half-set PayWay blocks; half-set SMS/SMTP does not (the rest can be saved in /staff/messaging)", () => {
    const r = by({ ...FULL, PAYWAY_API_KEY: "", SMTP_FROM: "", SMS_SENDER: undefined });
    expect([r.payway.status, r.payway.blocking]).toEqual(["incomplete", true]);
    expect([r.smtp.status, r.smtp.blocking]).toEqual(["incomplete", false]);
    expect([r.sms.status, r.sms.blocking]).toEqual(["incomplete", false]);
  });

  it("checks formats: https origin in production, tile template, ABN GUID, SMTP pair", () => {
    const r = by({ ...FULL, APP_URL: "http://www.example.com.au", NEXT_PUBLIC_MAP_TILE_URL: "https://tiles.example.com/map.png",
      ABN_LOOKUP_GUID: "not-a-guid", SMTP_PASSWORD: "" });
    expect(r.google.problems.join()).toContain("https://");
    expect(r.maptiles.problems.join()).toContain("{z}");
    expect(r.abn.status).toBe("invalid");
    expect(r.smtp.problems.join()).toContain("set together");
    expect(by({ ...FULL, APP_URL: "http://localhost:3004" }, false).google.status).toBe("ready");
  });

  it("uses ADMIN_APP_URL on the admin deployment", () => {
    const admin = { ...FULL, APP_MODE: "admin", APP_URL: "" };
    expect(by(admin).google.missing).toEqual(["ADMIN_APP_URL"]);
    expect(by({ ...admin, ADMIN_APP_URL: "https://admin.example.com.au" }).google.status).toBe("ready");
  });

  it("agrees with the real readers", () => {
    const cases: Record<string, string | undefined>[] = [FULL, {}, { ...FULL, SESSION_SECRET: "short" }, { ...FULL, GOOGLE_CLIENT_SECRET: "" },
      { ...FULL, APP_MODE: "admin" }, { ...FULL, APP_MODE: "admin", ADMIN_APP_URL: "https://admin.example.com.au" },
      { ...FULL, MFA_SECRET_KEY: "abc" }, { ...FULL, SMS_ACCOUNT_SID: "AC123" }, { ...FULL, SMS_PROVIDER: "other" },
      { ...FULL, SMTP_PORT: "2526" }, { ...FULL, SMTP_FROM: "nobody" }, { ...FULL, SMTP_USER: "" }];
    for (const env of cases) {
      const r = by(env, false);
      expect(r.google.status === "ready", JSON.stringify(env)).toBe(readAuthEnv(env) !== null);
      expect(r.mfa.status === "ready").toBe(mfaKeyUsable(env.MFA_SECRET_KEY));
      const m = resolveMessaging({}, env);
      // SMS_CODE_SECRET is checked here too, so ready implies the SMS settings resolve.
      if (r.sms.status === "ready") expect(m.sms).not.toBeNull();
      if (m.sms === null) expect(r.sms.status).not.toBe("ready");
      expect(r.smtp.status === "ready").toBe(m.email !== null);
    }
  });
});
