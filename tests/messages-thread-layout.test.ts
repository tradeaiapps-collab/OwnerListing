import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const css = readFileSync(path.join(root, "app/styles/messages.css"), "utf8");
const page = readFileSync(path.join(root, "app/messages/[id]/page.tsx"), "utf8");

describe("message thread layout and reply flow", () => {
  it("keeps grid columns shrinkable so long text can never widen the page", () => {
    for (const sel of [".msg-thread", ".msg", ".msg-composer"]) {
      const rule = css.split("\n").find(l => l.startsWith(`${sel} {`)) ?? "";
      expect(rule, sel).toContain("grid-template-columns: minmax(0, 1fr)");
    }
    expect(css).toMatch(/\.msg-replying-text \{[^}]*min-width: 0/);
  });
  it("lets the person choose a message to answer and see which one is chosen", () => {
    expect(page).toContain("is-replying");
    expect(page).toContain("aria-pressed");
    expect(page).toContain("Replying to");
    expect(page).toContain("press Reply under it");
    expect(page).not.toContain("reply.body.slice(0, 80)");
  });
  it("cancels the reply with Escape or the Cancel button", () => {
    expect(page).toContain('e.key === "Escape"');
    expect(page).toContain("msg-cancel");
  });
});
