import { cache } from "react";
import { headers } from "next/headers";
import { resolveTheme } from "./site-theme";

/** Theme for the current request (published, or the draft when a valid preview token came with it). Computed once per request. */
export const getRequestTheme = cache(async () => resolveTheme((await headers()).get("x-theme-preview")));
