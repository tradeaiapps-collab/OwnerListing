import { describe, expect, it } from "vitest";
import { LEGAL_DRAFT_NOTICE, PRIVACY, SUPPORT_TOPICS, TERMS, supportEmail } from "../src/domain/legal-pages";
import { RECOVERY_DAYS, RETENTION_YEARS } from "../src/domain/account-deletion";
import { isAllowed } from "../src/config/app-mode";
import { buildConfig } from "../mobile/app.config";

const text = (d: typeof PRIVACY) => [d.intro, ...d.sections.flatMap(s => [s.heading, ...s.paragraphs, ...(s.bullets ?? [])])].join("\n");

describe("legal pages", () => {
  it("have unique section ids and non-empty text", () => {
    for (const d of [PRIVACY, TERMS]) {
      const ids = d.sections.map(s => s.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const s of d.sections) expect(s.paragraphs.length).toBeGreaterThan(0);
    }
  });
  it("are marked as needing legal review", () => {
    expect(LEGAL_DRAFT_NOTICE).toMatch(/legal review/i);
  });
  it("privacy covers the Privacy Act, APPs, access, deletion windows and the OAIC", () => {
    const t = text(PRIVACY);
    expect(t).toMatch(/Privacy Act 1988/);
    expect(t).toMatch(/Australian Privacy Principles/);
    expect(t).toMatch(/oaic\.gov\.au/);
    expect(t).toContain(`${RECOVERY_DAYS} days`);
    expect(t).toContain(`${RETENTION_YEARS} years`);
  });
  it("terms state the platform rules: one licence per user, no held money, owner-only acceptance, permanent messages", () => {
    const t = text(TERMS);
    expect(t).toMatch(/One licence covers one user/);
    expect(t).toMatch(/holds no money/);
    expect(t).toMatch(/AI never accepts/);
    expect(t).toMatch(/cannot be deleted/);
  });
  it("support topics have unique ids", () => {
    const ids = SUPPORT_TOPICS.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("support email uses SUPPORT_EMAIL when set", () => {
    expect(supportEmail({ SUPPORT_EMAIL: " help@example.com " })).toBe("help@example.com");
    expect(supportEmail({})).toMatch(/@/);
  });
  it("are served by the public site", () => {
    for (const p of ["/privacy", "/terms", "/support"]) {
      expect(isAllowed("public", p, null, undefined)).toBe(true);
      expect(isAllowed("admin", p, null, undefined)).toBe(false);
    }
  });
  it("mobile store config defaults to the privacy and support pages", () => {
    const cfg = buildConfig({ OWNERLISTING_API_URL: "https://example.com.au" } as never);
    expect(JSON.stringify(cfg)).toContain("https://example.com.au/privacy");
    expect(JSON.stringify(cfg)).toContain("https://example.com.au/support");
  });
});
