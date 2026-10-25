import { deflateSync } from "node:zlib";

/** Synthetic image files for the photo tests. Headers are real; pixel data is only as real as each test needs. */
const seg = (marker: number, data: number[] | Uint8Array) => {
  const len = data.length + 2;
  return [0xff, marker, len >> 8, len & 0xff, ...data];
};
const text = (s: string) => Array.from(Buffer.from(s, "latin1"));

/** EXIF APP1 payload: Orientation plus a GPS-looking tag and a camera serial string. */
export function exifPayload(orientation: number): number[] {
  const tiff = [
    0x49, 0x49, 0x2a, 0, 8, 0, 0, 0,
    2, 0,
    0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0,
    0x25, 0x88, 4, 0, 1, 0, 0, 0, 0, 0, 0, 0, // GPSInfo pointer
    0, 0, 0, 0
  ];
  return [...text("Exif\0\0"), ...tiff, ...text("GPS-LAT-27.4698-LON-153.0251 SERIAL-CAM-12345")];
}

export function jpeg(opts: { width?: number; height?: number; orientation?: number; trailing?: string; progressive?: boolean } = {}): Uint8Array {
  const w = opts.width ?? 800, h = opts.height ?? 600;
  const sof = [8, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  const scanData = [0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78]; // stuffed FF00 and a restart marker
  const parts = [
    0xff, 0xd8,
    ...seg(0xe0, text("JFIF\0\x01\x01\0\0\x01\0\x01\0\0")),
    ...seg(0xe1, exifPayload(opts.orientation ?? 1)),
    ...seg(0xe1, text("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>GPS-XMP-SECRET</x:xmpmeta>")),
    ...seg(0xe2, text("ICC_PROFILE\0\x01\x01profile-bytes")),
    ...seg(0xe2, text("MPF\0second-picture")),
    ...seg(0xed, text("Photoshop 3.0\0IPTC-BYLINE-SECRET")),
    ...seg(0xfe, text("COMMENT-SECRET")),
    ...seg(0xdb, new Array(65).fill(1)),
    ...seg(opts.progressive ? 0xc2 : 0xc0, sof),
    ...seg(0xc4, new Array(20).fill(0)),
    ...seg(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]),
    ...scanData,
    ...(opts.progressive
      ? [...seg(0xe1, exifPayload(3)), ...seg(0xc4, new Array(20).fill(0)), ...seg(0xda, [1, 1, 0, 1, 5, 0]), 0x9a, 0xbc]
      : []),
    0xff, 0xd9,
    ...text(opts.trailing ?? "")
  ];
  return Uint8Array.from(parts);
}

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Real, decodable RGB PNG (solid colour) with optional extra chunks before IDAT and bytes after IEND. */
export function png(opts: { width?: number; height?: number; extra?: [string, string][]; trailing?: string } = {}): Uint8Array {
  const w = opts.width ?? 300, h = opts.height ?? 200;
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x80);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("sRGB", Uint8Array.from([0])),
    ...(opts.extra ?? []).map(([t, d]) => pngChunk(t, Buffer.from(d, "latin1"))),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", new Uint8Array()),
    Buffer.from(opts.trailing ?? "", "latin1")
  ]);
}

const riffChunk = (type: string, data: number[]) => {
  const len = data.length;
  return [...text(type), len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >>> 24) & 0xff, ...data, ...(len & 1 ? [0] : [])];
};

/** WebP: VP8X (flags EXIF+XMP) + lossy VP8 frame header + EXIF + XMP chunks. */
export function webp(opts: { width?: number; height?: number; lossless?: boolean; trailing?: string } = {}): Uint8Array {
  const w = opts.width ?? 640, h = opts.height ?? 480;
  const vp8x = [0x08 | 0x04, 0, 0, 0, (w - 1) & 0xff, ((w - 1) >> 8) & 0xff, 0, (h - 1) & 0xff, ((h - 1) >> 8) & 0xff, 0];
  const frame = opts.lossless
    ? riffChunk("VP8L", (() => { const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14); return [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff, 0, 0]; })())
    : riffChunk("VP8 ", [0x10, 0x02, 0, 0x9d, 0x01, 0x2a, w & 0xff, (w >> 8) & 0x3f, h & 0xff, (h >> 8) & 0x3f, 1, 2, 3]);
  const body = [...text("WEBP"), ...riffChunk("VP8X", vp8x), ...frame, ...riffChunk("EXIF", exifPayload(1).slice(6)), ...riffChunk("XMP ", text("<x:xmpmeta>GPS-XMP-SECRET</x:xmpmeta>"))];
  const size = body.length;
  return Uint8Array.from([...text("RIFF"), size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >>> 24) & 0xff, ...body, ...text(opts.trailing ?? "")]);
}

export const has = (b: Uint8Array, s: string) => Buffer.from(b).includes(Buffer.from(s, "latin1"));
