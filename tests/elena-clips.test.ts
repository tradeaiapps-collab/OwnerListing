import { describe, expect, it } from "vitest";
import { clipFor } from "../app/enquiries/elena-stage";

describe("Elena body language", () => {
  it("rests with hands down when silent and idle, including after a tablet answer", () => {
    expect(clipFor({ pose: "wave", status: "welcome" }, false)).toBe("idle");
    expect(clipFor({ pose: "tablet", status: "presenting" }, false)).toBe("idle");
  });
  it("leans in while someone types or she thinks", () => {
    expect(clipFor({ pose: "listening", status: "listening" }, false)).toBe("listen");
    expect(clipFor({ pose: "listening", status: "thinking" }, false)).toBe("listen");
  });
  it("matches speech to the moment", () => {
    expect(clipFor({ pose: "tablet", status: "presenting" }, true)).toBe("presenting");
    expect(clipFor({ pose: "three-quarter", status: "careful" }, true)).toBe("talking");
    expect(clipFor({ pose: "front", status: "explaining", mood: "agree" }, true)).toBe("agree");
    expect(clipFor({ pose: "front", status: "explaining" }, true)).toBe("explain");
  });
});
