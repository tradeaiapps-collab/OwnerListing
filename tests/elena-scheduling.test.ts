import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEMPLATES, MESSAGE_KINDS, VARIABLES, VOICES, formatAppointment, parseDecision, parseTemplateInput, pickTemplate, planMessages, renderTemplate
} from "../src/domain/elena-scheduling";
import { renderNotification } from "../src/domain/notifications";

const vars = { buyer_name: "Sam", agent_name: "Sound Checks", property_address: "12 Wattle St, Newtown NSW", appointment_time: "Saturday 14 November, 10:00 am", listing_title: "Cottage", buyer_notes: "" };

describe("Elena scheduling messages (pure)", () => {
  it("every built-in template renders with all variables filled and no stray [brackets]", () => {
    for (const k of MESSAGE_KINDS) for (const v of VOICES) {
      const text = renderTemplate(DEFAULT_TEMPLATES[k][v], vars);
      expect(text, `${k}/${v}`).not.toMatch(/\[[a-z_]+\]/);
      expect(text).toContain("Sam");
      expect(text).toContain("12 Wattle St");
      expect(text).toContain("Saturday 14 November");
      // Valid as an admin-saved template too.
      expect(parseTemplateInput({ kind: k, voice: v, body: DEFAULT_TEMPLATES[k][v] }).ok).toBe(true);
    }
  });

  it("confirmations tell the buyer what to bring and how to reach the agent in the app", () => {
    for (const v of VOICES) {
      const t = renderTemplate(DEFAULT_TEMPLATES.booking_confirmation[v], vars).toLowerCase();
      expect(t).toMatch(/id/);
      expect(t).toMatch(/pre-approval|pre-approval|finance/);
      expect(t).toMatch(/message/);
    }
  });

  it("drops a line that holds only an empty variable, keeps it when filled, and leaves unknown words alone", () => {
    const body = "Hi [buyer_name].\n[buyer_notes]\nSee you at [property_address]. [not_a_variable]";
    expect(renderTemplate(body, vars)).toBe("Hi Sam.\nSee you at 12 Wattle St, Newtown NSW. [not_a_variable]");
    expect(renderTemplate(body, { ...vars, buyer_notes: 'You mentioned: "roof"' })).toContain('You mentioned: "roof"');
  });

  it("rejects unknown variables, too-short and too-long bodies, bad kinds and voices", () => {
    expect(parseTemplateInput({ kind: "reminder_24h", voice: "casual", body: "Hi [buyer_nam], see you [appointment_time]." })).toMatchObject({ ok: false, error: expect.stringContaining("[buyer_nam]") });
    expect(parseTemplateInput({ kind: "reminder_24h", voice: "casual", body: "short" }).ok).toBe(false);
    expect(parseTemplateInput({ kind: "reminder_24h", voice: "casual", body: "x".repeat(1501) }).ok).toBe(false);
    expect(parseTemplateInput({ kind: "nope", voice: "casual", body: "x".repeat(30) }).ok).toBe(false);
    expect(parseTemplateInput({ kind: "reminder_24h", voice: "loud", body: "x".repeat(30) }).ok).toBe(false);
    expect(parseTemplateInput(null).ok).toBe(false);
    expect(VARIABLES).toContain("appointment_time");
  });

  it("picks the agent's template, then the platform's, then the built-in friendly text", () => {
    const own = { voice: "formal" as const, body: "own" }, global = { voice: "casual" as const, body: "global" };
    expect(pickTemplate("reminder_24h", own, global)).toMatchObject({ body: "own", source: "agent" });
    expect(pickTemplate("reminder_24h", undefined, global)).toMatchObject({ body: "global", source: "platform" });
    expect(pickTemplate("reminder_24h")).toMatchObject({ source: "default", voice: "friendly", body: DEFAULT_TEMPLATES.reminder_24h.friendly });
  });

  it("formats the time in the property's own zone", () => {
    expect(formatAppointment("2026-11-13T23:00:00.000Z", "NSW")).toBe("Saturday 14 November, 10:00 am");
    expect(formatAppointment("2026-11-13T23:00:00.000Z", "QLD")).toBe("Saturday 14 November, 9:00 am");
    expect(formatAppointment("2026-11-13T23:00:00.000Z", "WA")).toBe("Saturday 14 November, 7:00 am");
  });

  it("offers the confirmation now and the reminder 24 hours before, or only the confirmation when the visit is under 24 hours away", () => {
    const now = "2026-11-10T00:00:00.000Z";
    expect(planMessages("2026-11-14T01:00:00.000Z", now)).toEqual([
      { kind: "booking_confirmation", status: "suggested", dueAt: now },
      { kind: "reminder_24h", status: "scheduled", dueAt: "2026-11-13T01:00:00.000Z" }
    ]);
    expect(planMessages("2026-11-10T20:00:00.000Z", now)).toEqual([{ kind: "booking_confirmation", status: "suggested", dueAt: now }]);
  });

  it("parses the agent's decision: send as drafted, send edited, skip, and refuses empty, long or unknown", () => {
    expect(parseDecision({ action: "send" }, "Hello")).toEqual({ ok: true, action: "send", body: "Hello", edited: false });
    expect(parseDecision({ action: "send", body: "  Hello  " }, "Hello")).toMatchObject({ edited: false });
    expect(parseDecision({ action: "send", body: "Hello there" }, "Hello")).toEqual({ ok: true, action: "send", body: "Hello there", edited: true });
    expect(parseDecision({ action: "skip" }, "Hello")).toEqual({ ok: true, action: "skip" });
    expect(parseDecision({ action: "send", body: "   " }, "Hello").ok).toBe(false);
    expect(parseDecision({ action: "send", body: "x".repeat(1501) }, "Hello").ok).toBe(false);
    expect(parseDecision({ action: "send", body: 5 }, "Hello").ok).toBe(false);
    expect(parseDecision({ action: "maybe" }, "Hello").ok).toBe(false);
    expect(parseDecision("send", "Hello").ok).toBe(false);
  });

  it("notification kinds render in the messages category", () => {
    expect(renderNotification("scheduling_message", { title: "Hi", text: "Body" })).toMatchObject({ category: "messages", title: "Hi", body: "Body" });
    expect(renderNotification("scheduling_suggestion", {})).toMatchObject({ category: "messages" });
  });
});
