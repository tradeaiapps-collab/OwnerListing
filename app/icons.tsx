import type { IconName, IconStyle } from "../src/domain/site-theme";

/** Small inline SVG icon set (24x24, closed shapes so both styles work). The admin picks outline or solid in Site appearance. */
const PATHS: Record<IconName, string> = {
  search: "M10.5 3a7.5 7.5 0 1 0 4.6 13.4l4.7 4.7 1.4-1.4-4.7-4.7A7.5 7.5 0 0 0 10.5 3zm0 3a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z",
  tag: "M3 4a1 1 0 0 1 1-1h8.2a1 1 0 0 1 .7.3l8 8a1 1 0 0 1 0 1.4l-8.2 8.2a1 1 0 0 1-1.4 0l-8-8a1 1 0 0 1-.3-.7zm4.5 2a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z",
  plus: "M10.5 3h3v7.5H21v3h-7.5V21h-3v-7.5H3v-3h7.5z",
  home: "M12 3 2.5 11.5H5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-8.5h2.5z",
  inbox: "M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 9v5h14v-5h-4a3 3 0 0 1-6 0z",
  bookmark: "M6 3h12a1 1 0 0 1 1 1v17l-7-4.5L5 21V4a1 1 0 0 1 1-1z",
  heart: "M12 21s-8-5.2-8-11a4.6 4.6 0 0 1 8-3 4.6 4.6 0 0 1 8 3c0 5.8-8 11-8 11z",
  shield: "M12 2.5 4 5.5v6c0 5 3.4 8.5 8 10 4.6-1.5 8-5 8-10v-6z",
  gauge: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  briefcase: "M9 5V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm1.5 0h3V4.5h-3z",
  building: "M5 21V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v6h3a1 1 0 0 1 1 1v10zm3-14v2h4V7zm0 4v2h4v-2zm0 4v2h4v-2zm8.5-3v2h1.5v-2zm0 4v2h1.5v-2z",
  login: "M12 3h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7v-2.5h6.5v-13H12zM10.5 7.5 15 12l-4.5 4.5-1.8-1.8 1.7-1.7H3v-2.5h6.4L8.7 9.3z"
};

export function Icon({ name, style, size = 18 }: { name: IconName; style: IconStyle; size?: number }) {
  const common = { className: "icon", width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": true, focusable: false } as const;
  return style === "solid"
    ? <svg {...common} fill="currentColor" fillRule="evenodd"><path d={PATHS[name]} /></svg>
    : <svg {...common} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" fillRule="evenodd"><path d={PATHS[name]} /></svg>;
}
