// NEXT_DIST_DIR is used only by the local test kit so the public (3005) and admin (3006) dev servers do not share one build folder.

/**
 * Site-wide security headers (security review 2026-10, medium finding). The page CSP keeps 'unsafe-inline' for scripts and styles because
 * Next.js inlines its bootstrap data; everything else is limited to this site. Map tiles and photos are https images; frames are refused.
 */
export function pageCsp(dev = false) {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    `connect-src 'self'${dev ? " ws: wss:" : ""} https:`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://accounts.google.com",
    "frame-ancestors 'self'"
  ].join("; ");
}

export const baseSecurityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" }
];

/** API routes send their own CSP (file routes use a sandbox policy), so the page CSP applies to everything except /api. */
export function securityHeaderRules(dev = process.env.NODE_ENV !== "production") {
  return [
    { source: "/:path*", headers: baseSecurityHeaders },
    { source: "/((?!api/).*)", headers: [{ key: "Content-Security-Policy", value: pageCsp(dev) }] }
  ];
}

/** @type {import('next').NextConfig} */
export default {
  distDir: process.env.NEXT_DIST_DIR || ".next",
  /** PDF page rendering (investor project documents) runs on the server and loads native code, so these stay outside the bundle. */
  serverExternalPackages: ["pdfjs-dist", "@napi-rs/canvas", "tesseract.js", "@tesseract.js-data/eng"],
  async headers() { return securityHeaderRules(); },
  /** The investor projects module lives at /investments; these are the names people type. */
  async redirects() {
    return [
      { source: "/investor/projects", destination: "/investments", permanent: false },
      { source: "/investor/projects/:id", destination: "/investments/:id", permanent: false },
      { source: "/investor/projects/:id/documents", destination: "/investments/:id/documents", permanent: false }
    ];
  }
};
