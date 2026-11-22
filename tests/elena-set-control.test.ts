import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// No DOM in this test environment: a tiny stand-in for the parts setControl touches.
class FakeInput { declare value: string; events: string[] = []; dispatchEvent(e: { type: string }) { this.events.push(e.type); return true; } }
beforeAll(() => {
  Object.defineProperty(FakeInput.prototype, "value", { set(this: { _v: string }, v: string) { this._v = v; }, get(this: { _v?: string }) { return this._v ?? ""; }, configurable: true });
  vi.stubGlobal("HTMLInputElement", FakeInput);
  vi.stubGlobal("HTMLSelectElement", class {});
  vi.stubGlobal("HTMLTextAreaElement", class {});
  vi.stubGlobal("Event", class { constructor(readonly type: string) {} });
});
afterEach(() => vi.unstubAllGlobals());

describe("Elena answer fills the form on the first click", () => {
  it("sets every control that shares the name (quick setup and full form) and fires input and change", async () => {
    const { setControl } = await import("../app/listings/elena-listing-assistant");
    const a = new FakeInput(), b = new FakeInput();
    const form = { querySelectorAll: (sel: string) => (sel.includes('name="bedrooms"') ? [a, b] : []) } as unknown as HTMLFormElement;
    setControl(form, "bedrooms", "4");
    expect(a.value).toBe("4"); expect(b.value).toBe("4");
    expect(a.events).toEqual(["input", "change"]);
  });
});
