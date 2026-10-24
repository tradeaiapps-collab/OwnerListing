// NEXT_DIST_DIR is used only by the local test kit so the public (3005) and admin (3006) dev servers do not share one build folder.
/** @type {import('next').NextConfig} */
export default { distDir: process.env.NEXT_DIST_DIR || ".next" };
