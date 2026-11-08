import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDevFileEmail, devFileEmailWanted } from "../src/adapters/email-dev";
import {
  adminAlertEmail, htmlFromText, passwordResetEmail, renderBrandedEmail,
  signupExistingEmail, signupVerifyEmail, staffInviteEmail
} from "../src/domain/account-emails";
import { escapeHtml } from "../src/domain/email-templates";

const LINK = "https://app.example.com/signup/verify?token=abc123";

describe("account email templates", () => {
  it("renders text and HTML with the link in both, as a button in HTML", () => {
    const m = signupVerifyEmail("OwnerListing", LINK, 24);
    expect(m.subject).toBe("Confirm your email for OwnerListing");
    expect(m.text).toContain(`Confirm my email: ${LINK}`);
    expect(m.text).toContain("expires in 24 hours");
    expect(m.html).toContain(`href="${LINK}"`);
    expect(m.html).toContain("Confirm my email</a>");
    expect(m.html.startsWith("<!doctype html>")).toBe(true);
  });

  it("escapes every variable in the HTML", () => {
    const evil = `<script>alert("x")</script> & 'Home'`;
    const m = adminAlertEmail("Brand<b>", "sign_in_lockout", evil, "https://app.example.com");
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain(escapeHtml(evil));
    expect(m.html).toContain("Brand&lt;b&gt;");
  });

  it("never makes a non-http link clickable", () => {
    const m = renderBrandedEmail("B", { subject: "S", heading: "H", paragraphs: ["p"], action: { label: "Go", url: "javascript:alert(1)" } });
    expect(m.html).not.toContain("javascript:alert(1)\"");
    expect(m.html).not.toContain("Go</a>");
  });

  it("covers each account, staff and admin message", () => {
    const all = [
      signupExistingEmail("B", "https://a.test"), passwordResetEmail("B", LINK, 30),
      staffInviteEmail("B", "super_admin", "https://a.test"),
      adminAlertEmail("B", "sign_in_lockout", "detail", "https://a.test"), adminAlertEmail("B", "staff_invite_created", "detail", "https://a.test")
    ];
    for (const m of all) {
      expect(m.subject.length).toBeGreaterThan(0);
      expect(m.subject).not.toMatch(/[\r\n]/);
      expect(m.html.length).toBeLessThan(100_000);
      expect(m.text.length).toBeLessThan(20_000);
    }
    expect(passwordResetEmail("B", LINK, 30).text).toContain("expires in 30 minutes");
    expect(staffInviteEmail("B", "super_admin", "https://a.test").text).toContain("as super admin");
  });

  it("wraps a plain-text notice in the same layout, keeping paragraphs and links", () => {
    const html = htmlFromText("B", "Account restored", "Your account is back.\n\nSign in: https://a.test/login\n");
    expect(html).toContain("Account restored</h1>");
    expect(html).toContain("<p style=\"margin:0 0 16px;\">Your account is back.</p>");
    expect(html).toContain('href="https://a.test/login"');
  });
});

describe("development email files", () => {
  it("writes the HTML and text to files instead of sending", async () => {
    const dir = await mkdtemp(join(tmpdir(), "devmail-"));
    const lines: string[] = [];
    const port = createDevFileEmail(dir, l => lines.push(l), () => new Date("2026-10-30T00:00:00Z"));
    const m = signupVerifyEmail("B", LINK, 24);
    expect(await port.send({ to: "ann@example.com", ...m })).toMatchObject({ status: "sent" });
    const files = (await readdir(dir)).sort();
    expect(files).toHaveLength(2);
    expect(await readFile(join(dir, files.find(f => f.endsWith(".html"))!), "utf8")).toBe(m.html);
    expect(await readFile(join(dir, files.find(f => f.endsWith(".txt"))!), "utf8")).toContain("To: ann@example.com");
    expect(lines[0]).toContain("DEV ONLY");
    expect(await port.send({ to: "not an address", ...m })).toMatchObject({ status: "failed", errorCode: "invalid_recipient" });
  });

  it("is never used in production", () => {
    expect(devFileEmailWanted({ EMAIL_DELIVERY: "dev_file" })).toBe(true);
    expect(devFileEmailWanted({ EMAIL_DELIVERY: "dev_file", NODE_ENV: "production" })).toBe(false);
    expect(devFileEmailWanted({})).toBe(false);
  });
});
