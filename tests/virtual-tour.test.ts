import { describe, expect, it } from "vitest";
import { chatAnswer, matchChatTopic, type ChatFacts } from "../src/domain/chat-assistant";
import { cardPhoto, coverOf, EMPTY_LAYOUT, PHOTO_LIMITS, roomFor, type PhotoRecord } from "../src/domain/listing-photos";
import { classifyTour, looks360, tourSummary } from "../src/domain/virtual-tour";

describe("classifyTour", () => {
  it.each([
    ["https://my.matterport.com/show/?m=SxQL3iGyoDo", "matterport", "3d", "https://my.matterport.com/show/?m=SxQL3iGyoDo"],
    ["https://kuula.co/share/7abc12", "kuula", "360", "https://kuula.co/share/7abc12"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "youtube", "video", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ", "youtube", "video", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["https://vimeo.com/123456789", "vimeo", "video", "https://player.vimeo.com/video/123456789"]
  ])("embeds %s", (url, provider, kind, embed) => {
    expect(classifyTour(url)).toMatchObject({ provider, kind, embedUrl: embed });
  });

  it("rebuilds the embed from the id only, so extra parts of a pasted link never reach the frame", () => {
    expect(classifyTour("https://my.matterport.com/show/?m=abcDEF123&play=1&evil=x")?.embedUrl).toBe("https://my.matterport.com/show/?m=abcDEF123");
  });

  it("shows unknown hosts and look-alikes as a plain link, never a frame", () => {
    for (const url of ["https://example.com/tour", "https://my.matterport.com.evil.example/show/?m=abcd1234", "https://evil.example/my.matterport.com/show/?m=abcd1234", "https://my.matterport.com/show/"]) {
      const t = classifyTour(url);
      expect(t?.kind).toBe("link");
      expect(t?.embedUrl).toBeUndefined();
    }
  });

  it("rejects non-https, credentials and junk", () => {
    for (const url of ["http://my.matterport.com/show/?m=abcd1234", "javascript:alert(1)", "https://u:p@kuula.co/share/abcd12", "not a url", "", null, undefined])
      expect(classifyTour(url)).toBeUndefined();
  });
});

describe("360 photos", () => {
  it("accepts 2:1 panoramas only", () => {
    expect(looks360(6000, 3000)).toBe(true);
    expect(looks360(4096, 2048)).toBe(true);
    expect(looks360(4000, 3000)).toBe(false);
    expect(looks360(3000, 6000)).toBe(false);
  });

  const rec = (id: string, kind: PhotoRecord["kind"]): PhotoRecord => ({ id, listingId: "l", kind, uploadedBy: "u", contentType: "image/jpeg", width: 4000, height: 2000, variants: [] });
  const photos = new Map([["p", rec("p", "photo")], ["a", rec("a", "photo360")]]);
  const layout = (tourUrl: string | null, hidden = false) => ({ version: 1, tourUrl, entries: [{ photoId: "p", caption: "", alt: "", hidden: false }, { photoId: "a", caption: "Kitchen", alt: "", hidden }] });

  it("limits how many a listing can show", () => {
    const many = new Map(photos);
    const entries = Array.from({ length: PHOTO_LIMITS.max360 }, (_, i) => { many.set(`x${i}`, rec(`x${i}`, "photo360")); return { photoId: `x${i}`, caption: "", alt: "", hidden: false }; });
    expect(roomFor({ version: 1, tourUrl: null, entries }, many, "photo360")).toMatch(/360 photos/);
    expect(roomFor(layout(null), photos, "photo360")).toBeNull();
  });

  it("marks cards: tour link wins, else visible 360 photos, else nothing; 360 photos are never the cover or counted", () => {
    expect(coverOf(layout("https://my.matterport.com/show/?m=abcd1234"), photos)).toMatchObject({ photoCount: 1, tour: "3d" });
    expect(coverOf(layout(null), photos)).toMatchObject({ photoCount: 1, tour: "360" });
    expect(coverOf(layout(null, true), photos).tour).toBeUndefined();
    expect(coverOf(EMPTY_LAYOUT, new Map()).tour).toBeUndefined();
    expect(cardPhoto(coverOf(layout(null), photos)).tour).toBe("360");
    expect(cardPhoto(undefined)).toEqual({ photoCount: 0 });
  });
});

describe("Elena on tours", () => {
  const base: ChatFacts = { listing: { title: "Banksia home", address: "14 Banksia St", transactionType: "sale", propertyType: "house", bedrooms: 4, bathrooms: 2, parking: 2, verifiedDisclosures: 0 } };
  const withTour: ChatFacts = { ...base, tour: { tour: classifyTour("https://my.matterport.com/show/?m=abcd1234"), rooms: ["Kitchen", "Living room"], panoramas: 2 } };

  it("routes tour questions to the listing topic", () => {
    for (const q of ["Is there a virtual tour?", "Can I see a 3D walkthrough?", "Is there a Matterport?"]) expect(matchChatTopic(q)).toBe("listing");
  });

  it("describes only what the owner supplied, plus listing facts, and admits she cannot see inside", () => {
    const a = chatAnswer(withTour, "buyer", "Is there a virtual tour?");
    expect(a.text).toContain("a 3D tour");
    expect(a.text).toContain("Kitchen and Living room");
    expect(a.text).toContain("4 bedrooms");
    expect(a.text).toContain("can't see inside the tour");
  });

  it("says plainly when there is no tour", () => {
    expect(chatAnswer(base, "buyer", "Is there a 360 tour?").text).toContain("doesn't have a virtual tour");
    expect(tourSummary({ title: "X", rooms: [], panoramas: 0 })).toContain("doesn't have");
  });
});
