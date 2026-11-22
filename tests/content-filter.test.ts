import { describe, expect, it } from "vitest";
import { blockMessage, scanContent, scanFields } from "../src/domain/content-filter";
import { guardContent } from "../src/server/content-guard";
import type { ContentFlagInput } from "../src/domain/content-filter";

const act = (t: string, hosts: string[] = []) => scanContent(t, { allowedHosts: hosts }).action;

describe("content filter: contact details", () => {
  it.each([
    "Call me on 0412 345 678", "my number is 04-1234-5678", "ring +61 412 345 678", "0412345678", "(02) 9999 8888", "07 3333 4444",
    "email me at jo@example.com", "jo at gmail dot com", "jo(at)gmail(dot)com", "see www.myagency.com.au", "https://bit.ly/abc", "visit myagency.com",
    "add me on whatsapp", "my insta: @house_guy", "DM me", "text me zero four one two three four five six seven eight",
    "telegram @dealsguy"
  ])("blocks %s", t => expect(act(t), t).toBe("block"));
  it.each([
    "The asking price is $1,200,000 and the land is 650 sqm", "Inspection at 10:30 on 12/11/2026", "Built in 1998, 4 bed 2 bath 2 car",
    "Is it near the station? Thanks.", "Council rates are about $2,400.50 a year", "Unit 5, 12 Smith St", "Contract 0412 is not a number here, it is a ref"
  ])("allows %s", t => expect(act(t), t).not.toBe("block"));
  it("allows links to the platform's own host and its subdomains", () => {
    expect(act("See https://www.ownerlisting.com.au/listings/1", ["ownerlisting.com.au"])).toBe("allow");
    expect(act("See app.ownerlisting.com.au/x", ["ownerlisting.com.au"])).toBe("allow");
    expect(act("See https://evil-ownerlisting.com.au/x", ["ownerlisting.com.au"])).toBe("block");
  });
  it("does not count the domain of an email twice", () => {
    expect(scanContent("jo@example.com").hits.filter(h => h.category === "contact_details")).toHaveLength(1);
  });
});

describe("content filter: abuse and spam", () => {
  it("blocks swearing and threats", () => {
    expect(act("what the fuck")).toBe("block");
    expect(act("I will kill you")).toBe("block");
    expect(scanContent("you idiot").hits[0]).toMatchObject({ category: "abuse", action: "block" });
  });
  it("only flags mild words", () => {
    const s = scanContent("this is crap, damn");
    expect(s.action).toBe("flag");
    expect(s.hits.every(h => h.category === "abuse" && h.action === "flag")).toBe(true);
  });
  it("flags spam wording, shouting and repeated words", () => {
    expect(act("Make money fast with our crypto signals")).toBe("flag");
    expect(act("THIS HOUSE IS AMAZING AND YOU MUST BUY IT RIGHT NOW TODAY")).toBe("flag");
    expect(act("buy buy buy buy buy buy buy buy buy now")).toBe("flag");
    expect(act("Hello!!!!!!!!")).toBe("flag");
  });
  it("lets ordinary text through", () => {
    for (const t of ["Hi, is the house still available? We would love an inspection on Saturday.", "Class A building, Scunthorpe Street", ""])
      expect(act(t), t).toBe("allow");
  });
  it("the strongest action wins across fields and names the field", () => {
    const r = scanFields({ a: "fine", b: "crap", c: "0412 345 678" });
    expect(r.action).toBe("block");
    expect(r.byField["a"]!.action).toBe("allow");
    expect(r.byField["b"]!.action).toBe("flag");
  });
  it("explains a refusal without quoting the text", () => {
    const m = blockMessage(scanContent("0412 345 678"), "message");
    expect(m).toMatch(/contact details/);
    expect(m).not.toMatch(/0412/);
    expect(blockMessage(scanContent("fuck"), "profile")).toMatch(/abusive/);
  });
});

describe("guardContent", () => {
  const mk = () => { const rows: ContentFlagInput[] = []; return { rows, store: { record: async (f: ContentFlagInput) => { rows.push(f); } } }; };
  it("records blocked text without a subject id and refuses", async () => {
    const { rows, store } = mk();
    const r = await guardContent(store, { source: "message", subjectType: "enquiry_message", userId: "u1", fields: { body: "call 0412 345 678" }, allowedHosts: [] });
    expect(r.ok).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "block", field: "body", userId: "u1" });
    expect(rows[0]!.subjectId).toBeUndefined();
  });
  it("records flagged text only after it is stored, with its id", async () => {
    const { rows, store } = mk();
    const r = await guardContent(store, { source: "profile", subjectType: "agent_profile", userId: "u1", fields: { bio: "this is crap" }, allowedHosts: [] });
    expect(r.ok).toBe(true);
    expect(rows).toHaveLength(0);
    if (r.ok) await r.after("row-1");
    expect(rows[0]).toMatchObject({ action: "flag", subjectId: "row-1" });
  });
  it("records nothing for clean text and never fails the user when the store fails", async () => {
    const { rows, store } = mk();
    const clean = await guardContent(store, { source: "message", subjectType: "x", userId: "u", fields: { body: "Lovely home" }, allowedHosts: [] });
    expect(clean.ok).toBe(true); if (clean.ok) await clean.after("id");
    expect(rows).toHaveLength(0);
    const bad = { record: async () => { throw new Error("db down"); } };
    const r = await guardContent(bad, { source: "message", subjectType: "x", userId: "u", fields: { body: "fuck" }, allowedHosts: [] });
    expect(r.ok).toBe(false);
  });
});

describe("ignore option", () => {
  it("skips the named categories only", () => {
    expect(scanContent("call 0412 345 678", { ignore: ["contact_details"] }).action).toBe("allow");
    expect(scanContent("call 0412 345 678 you fucking idiot", { ignore: ["contact_details"] }).action).toBe("block");
    expect(scanContent("click here for guaranteed returns", { ignore: ["spam"] }).action).toBe("allow");
  });
  it("is passed through guardContent", async () => {
    const rows: ContentFlagInput[] = [];
    const r = await guardContent({ record: async f => { rows.push(f); } }, { source: "message", subjectType: "deal_message", userId: "u", fields: { body: "ring 0412 345 678" }, allowedHosts: [], ignore: ["contact_details"] });
    expect(r.ok).toBe(true);
    expect(rows).toHaveLength(0);
  });
});
