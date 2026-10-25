import { describe, expect, it } from "vitest";
import { exifOrientation, stripImageMetadata } from "../src/domain/image-meta";
import { has, jpeg, png, pngChunk, webp } from "./helpers/image-fixtures";

const ok = (r: ReturnType<typeof stripImageMetadata>) => {
  if (!r.ok) throw new Error(r.reason);
  return r;
};

describe("JPEG metadata strip", () => {
  it("removes EXIF (GPS, serial), XMP, IPTC, MPF, comments and trailing bytes; keeps JFIF, ICC, tables and scan data", () => {
    const src = jpeg({ trailing: "<script>alert(1)</script>" });
    const r = ok(stripImageMetadata(src, "image/jpeg"));
    for (const secret of ["GPS-LAT", "SERIAL-CAM", "GPS-XMP-SECRET", "IPTC-BYLINE", "COMMENT-SECRET", "second-picture", "<script>"]) {
      expect(has(src, secret)).toBe(true);
      expect(has(r.bytes, secret)).toBe(false);
    }
    expect(has(r.bytes, "JFIF")).toBe(true);
    expect(has(r.bytes, "ICC_PROFILE")).toBe(true);
    expect(Array.from(r.bytes.slice(-2))).toEqual([0xff, 0xd9]);
    // Entropy data with byte stuffing and a restart marker is copied unchanged.
    expect(Buffer.from(r.bytes).includes(Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78]))).toBe(true);
    expect(r.info).toEqual({ mime: "image/jpeg", width: 800, height: 600 });
  });

  it("keeps only the orientation, as a fresh one-tag EXIF block, and reports the displayed size", () => {
    const r = ok(stripImageMetadata(jpeg({ orientation: 6 }), "image/jpeg"));
    expect(r.info).toMatchObject({ width: 600, height: 800 });
    const at = Buffer.from(r.bytes).indexOf(Buffer.from("Exif\0\0", "latin1"));
    expect(at).toBeGreaterThan(0);
    expect(exifOrientation(r.bytes.subarray(at))).toBe(6);
    expect(has(r.bytes, "GPS")).toBe(false);
    // Orientation 1 needs no EXIF block at all.
    expect(has(ok(stripImageMetadata(jpeg({ orientation: 1 }), "image/jpeg")).bytes, "Exif")).toBe(false);
  });

  it("strips metadata between the scans of a progressive JPEG", () => {
    const r = ok(stripImageMetadata(jpeg({ progressive: true }), "image/jpeg"));
    expect(has(r.bytes, "GPS-LAT")).toBe(false);
    expect(Buffer.from(r.bytes).includes(Buffer.from([0x9a, 0xbc, 0xff, 0xd9]))).toBe(true);
  });

  it("refuses damaged files instead of passing them through", () => {
    const good = jpeg();
    expect(stripImageMetadata(good.subarray(0, good.length - 40), "image/jpeg").ok).toBe(false);
    expect(stripImageMetadata(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), "image/jpeg").ok).toBe(false);
    const bad = new Uint8Array(good); bad[22] = 0xff; bad[23] = 0xff; // a segment length past the end
    expect(stripImageMetadata(bad, "image/jpeg").ok).toBe(false);
    expect(stripImageMetadata(Uint8Array.from([1, 2, 3]), "image/jpeg").ok).toBe(false);
  });
});

describe("PNG metadata strip", () => {
  it("drops text, EXIF and time chunks and bytes after IEND; keeps IHDR, sRGB and IDAT with valid CRCs", () => {
    const src = png({ extra: [["tEXt", "GPS\0-27.46,153.02"], ["iTXt", "XML:com.adobe.xmp\0\0\0\0\0GPS-XMP-SECRET"], ["eXIf", "MM\0*SERIAL-CAM"], ["tIME", "\x07\xea\x0a\x19\x0c\0\0"]], trailing: "PK\x03\x04zip" });
    const r = ok(stripImageMetadata(src, "image/png"));
    for (const s of ["tEXt", "iTXt", "eXIf", "tIME", "GPS-XMP-SECRET", "SERIAL-CAM", "PK\x03\x04"]) expect(has(r.bytes, s)).toBe(false);
    for (const s of ["IHDR", "sRGB", "IDAT", "IEND"]) expect(has(r.bytes, s)).toBe(true);
    expect(r.info).toEqual({ mime: "image/png", width: 300, height: 200 });
    expect(has(r.bytes.subarray(r.bytes.length - 8), "IEND")).toBe(true);
  });

  it("refuses an unknown critical chunk and a file without image data", () => {
    const withCritical = png({ extra: [["ZZZZ", "x"]] });
    expect(stripImageMetadata(withCritical, "image/png").ok).toBe(false);
    const sig = png().subarray(0, 8);
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(10, 0); ihdr.writeUInt32BE(10, 4);
    expect(stripImageMetadata(Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IEND", new Uint8Array())]), "image/png").ok).toBe(false);
  });
});

describe("WebP metadata strip", () => {
  it("drops EXIF and XMP chunks, clears their VP8X flags, fixes the RIFF size and drops trailing bytes", () => {
    const src = webp({ trailing: "TRAILER" });
    const r = ok(stripImageMetadata(src, "image/webp"));
    for (const s of ["EXIF", "XMP ", "GPS-XMP-SECRET", "GPS-LAT", "TRAILER"]) expect(has(r.bytes, s)).toBe(false);
    const b = Buffer.from(r.bytes);
    expect(b.readUInt32LE(4)).toBe(b.length - 8);
    expect(b[20]! & 0x0c).toBe(0);
    expect(r.info).toEqual({ mime: "image/webp", width: 640, height: 480 });
  });

  it("reads lossless (VP8L) sizes", () => {
    expect(ok(stripImageMetadata(webp({ lossless: true, width: 1000, height: 750 }), "image/webp")).info).toMatchObject({ width: 1000, height: 750 });
  });

  it("refuses a truncated RIFF", () => {
    const src = webp();
    expect(stripImageMetadata(src.subarray(0, 30), "image/webp").ok).toBe(false);
  });
});

// Real camera-style files, when the image library Next.js installs is present: the stripped file must still decode.
let sharp: ((b: Uint8Array) => any) | null = null;
try { const name = "sharp"; sharp = (await import(name)).default; } catch { sharp = null; }

describe.skipIf(!sharp)("round trip with a real encoder", () => {
  it("a real JPEG with EXIF GPS still decodes after the strip, with no EXIF left except orientation", async () => {
    const src = new Uint8Array(await sharp!(png({ width: 320, height: 240 }))
      .jpeg().withMetadata({ orientation: 6 }).withExif({ IFD0: { Make: "SecretCam" }, IFD3: { GPSLatitudeRef: "S", GPSLatitude: "27/1 28/1 0/1" } }).toBuffer());
    expect(has(src, "SecretCam")).toBe(true);
    expect((await sharp!(src).metadata()).orientation).toBe(6);
    const r = ok(stripImageMetadata(src, "image/jpeg"));
    expect(has(r.bytes, "SecretCam")).toBe(false);
    const meta = await sharp!(r.bytes).metadata();
    expect(meta.format).toBe("jpeg");
    expect([meta.width, meta.height]).toEqual([320, 240]);
    expect(meta.orientation).toBe(6);
    expect(r.info).toMatchObject({ width: 240, height: 320 });
    await sharp!(r.bytes).raw().toBuffer();
  });

  it("real PNG and WebP files still decode after the strip", async () => {
    const p = ok(stripImageMetadata(png({ extra: [["tEXt", "Comment\0secret"]] }), "image/png"));
    expect((await sharp!(p.bytes).metadata()).format).toBe("png");
    const w = new Uint8Array(await sharp!(png({ width: 300, height: 200 })).webp().withExif({ IFD0: { Make: "SecretCam" } }).toBuffer());
    const s = ok(stripImageMetadata(w, "image/webp"));
    expect(has(s.bytes, "SecretCam")).toBe(false);
    const meta = await sharp!(s.bytes).metadata();
    expect([meta.format, meta.width, meta.height, meta.exif]).toEqual(["webp", 300, 200, undefined]);
  });
});

describe("hidden data and size tricks (security review)", () => {
  const splice = (b: Uint8Array, at: number, ins: number[]) => Uint8Array.from([...b.subarray(0, at), ...ins, ...b.subarray(at)]);
  const withChunk = (b: Uint8Array, type: string, data: string) => {
    const d = Array.from(Buffer.from(data, "latin1"));
    const n = d.length;
    const out = Buffer.from([...b, ...Buffer.from(type, "latin1"), n & 0xff, (n >> 8) & 0xff, 0, 0, ...d, ...(n & 1 ? [0] : [])]);
    out.writeUInt32LE(out.length - 8, 4);
    return new Uint8Array(out);
  };

  it("JPEG: refuses reserved/extension segments that could carry hidden data", () => {
    const src = splice(jpeg(), 2, [0xff, 0xf0, 0, 8, ...Buffer.from("SECRET", "latin1")]);
    expect(stripImageMetadata(src, "image/jpeg").ok).toBe(false);
  });

  it("JPEG: refuses a second frame header (declared size must be the decoded size)", () => {
    const tiny = [8, 0, 10, 0, 10, 1, 1, 0x11, 0];
    const src = splice(jpeg({ width: 8000, height: 7000 }), 2, [0xff, 0xc0, 0, tiny.length + 2, ...tiny]);
    expect(stripImageMetadata(src, "image/jpeg").ok).toBe(false);
  });

  it("PNG: refuses a second IHDR", () => {
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(300, 0); ihdr.writeUInt32BE(200, 4); ihdr[8] = 8; ihdr[9] = 2;
    expect(stripImageMetadata(png({ extra: [["IHDR", ihdr.toString("latin1")]] }), "image/png").ok).toBe(false);
  });

  it("WebP: drops unknown chunks", () => {
    const r = ok(stripImageMetadata(withChunk(webp(), "ABCD", "HIDDEN-SECRET"), "image/webp"));
    expect(has(r.bytes, "HIDDEN-SECRET")).toBe(false);
    expect(Buffer.from(r.bytes).readUInt32LE(4)).toBe(r.bytes.length - 8);
  });

  it("WebP: refuses animation (flag or ANIM/ANMF chunks)", () => {
    const flagged = new Uint8Array(webp()); flagged[20] = flagged[20]! | 0x02;
    expect(stripImageMetadata(flagged, "image/webp")).toEqual({ ok: false, reason: "Animated images cannot be added." });
    expect(stripImageMetadata(withChunk(webp(), "ANMF", "x".repeat(16)), "image/webp").ok).toBe(false);
  });

  it("WebP: refuses a canvas size that differs from the frame size", () => {
    const src = new Uint8Array(webp({ lossless: true, width: 1000, height: 750 }));
    src[24] = 199; src[25] = 0; src[26] = 0; // canvas width 200
    expect(stripImageMetadata(src, "image/webp").ok).toBe(false);
  });
});
