import { defineConfig } from "vitest/config";

// tsconfig keeps jsx "preserve" for Next; tests that render server components need the JSX compiled.
export default defineConfig({ oxc: { jsx: { runtime: "automatic" } } });
