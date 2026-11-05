import { describe, expect, it } from "vitest";
import { DEFAULT_BRAND_NAME } from "../src/config/brand";
import { SCRIPTS, clipSources, findScript, pickVoice, planSpeech } from "../app/presenter/presenter-core";

const on = { clips: true, tts: true, muted: false };

describe("presenter speech planning", () => {
  it("finds a scripted line by id or by exact text, ignoring case and punctuation", () => {
    expect(findScript({ script: "help" })?.id).toBe("help");
    expect(findScript({ text: SCRIPTS[0]!.text.replace("{brand}", DEFAULT_BRAND_NAME).toUpperCase().replace(/,/g, "") })?.id).toBe("intro");
    expect(findScript({ text: "Something else entirely" })).toBeNull();
    expect(findScript({})).toBeNull();
  });
  it("plays the lip-synced clip for a scripted line, even when muted (the clip's own audio is muted by the player)", () => {
    expect(planSpeech({ script: "services" }, { ...on, muted: true }).kind).toBe("clip");
  });
  it("reads other text with the browser voice and keeps walking", () => {
    expect(planSpeech({ text: "Your listing has two new enquiries." }, on)).toEqual({ kind: "tts", text: "Your listing has two new enquiries." });
  });
  it("stays silent when muted, when there is no voice, or when there is nothing to say", () => {
    expect(planSpeech({ text: "Hi" }, { ...on, muted: true }).kind).toBe("none");
    expect(planSpeech({ text: "Hi" }, { ...on, tts: false }).kind).toBe("none");
    expect(planSpeech({ text: "   " }, on).kind).toBe("none");
  });
  it("falls back to the voice when clips are off (reduced motion)", () => {
    expect(planSpeech({ script: "intro" }, { ...on, clips: false })).toEqual({ kind: "tts", text: SCRIPTS[0]!.text.replace("{brand}", DEFAULT_BRAND_NAME) });
    expect(planSpeech({ script: "intro" }, { ...on, clips: false }).kind).toBe("tts");
  });
  it("does not play a clip that says the old brand name once the brand is renamed, and reads the new name instead", () => {
    const p = planSpeech({ script: "intro" }, { ...on, brand: "Acme Homes" });
    expect(p.kind === "tts" && p.text).toContain("Welcome to Acme Homes");
    expect(planSpeech({ script: "services" }, { ...on, brand: "Acme Homes" }).kind).toBe("clip");
  });
  it("caps very long text", () => {
    const p = planSpeech({ text: "a ".repeat(1000) }, on);
    expect(p.kind === "tts" && p.text.length).toBeLessThanOrEqual(600);
  });
});

describe("presenter media", () => {
  it("lists transparent WebM first, then the MP4 for the theme", () => {
    expect(clipSources("walk", false).map((s) => s.src)).toEqual(["/assistant/elena-presenter-walk-alpha.webm", "/assistant/elena-presenter-walk.mp4"]);
    expect(clipSources("intro", true)[1]!.src).toBe("/assistant/elena-presenter-intro-dark.mp4");
  });
  it("prefers a female Australian English voice", () => {
    const v = [{ lang: "en-US", name: "Alex" }, { lang: "en-AU", name: "Natasha" }, { lang: "fr-FR", name: "Amelie" }];
    expect(pickVoice(v)?.name).toBe("Natasha");
    expect(pickVoice([{ lang: "de-DE", name: "Hans" }])).toBeUndefined();
  });
});
