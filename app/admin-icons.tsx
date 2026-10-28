import type { AdminIcon as Name } from "../src/domain/admin-nav";

/** Outline icons for the admin sidebar and section cards (24x24, stroked). */
const PATHS: Record<Name | "menu" | "close" | "logout" | "external" | "arrow", string> = {
  overview: "M4 5h7v6H4zM13 5h7v3h-7zM13 10h7v9h-7zM4 13h7v6H4z",
  dashboard: "M4 19h16M6 16v-5M10 16V8M14 16v-3M18 16V6",
  listing: "M3.5 11 12 4l8.5 7M6 9.5V20h12V9.5M10 20v-5h4v5",
  users: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.3a3.5 3.5 0 0 1 0 6.4M18.5 14a6.5 6.5 0 0 1 3 6",
  building: "M4 20V6l8-3v17M12 9h8v11M7 8h2M7 12h2M7 16h2M15 13h2M15 16h2M2.5 20h19",
  toggle: "M8 7h8a5 5 0 0 1 0 10H8A5 5 0 0 1 8 7zM16 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  case: "M4 7h16v12H4zM9 7V5h6v2M4 12h16",
  safety: "M12 3 4.5 6v5.5c0 4.6 3.1 8 7.5 9.5 4.4-1.5 7.5-4.9 7.5-9.5V6zM9 12l2 2 4-4",
  bank: "M3 9 12 4l9 5M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18",
  id: "M3.5 6h17v12h-17zM9 13a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6 16.5a3 3 0 0 1 6 0M14.5 10h3.5M14.5 13.5h3.5",
  wording: "M4 5h16v11H9l-5 4zM8 9h8M8 12h5",
  disclosure: "M6 3h9l4 4v14H6zM14.5 3v4.5H19M9 12h7M9 15.5h7",
  evidence: "M6 3h9l4 4v14H6zM14.5 3v4.5H19M9 14l2 2 4-4.5",
  audit: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3.5 2",
  chart: "M4 19 9.5 12l4 3.5L20 7M15 7h5v5",
  builder: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM16.5 13v7M13 16.5h7",
  report: "M5 3h14v18H5zM9 8h6M9 12h6M9 16h3",
  price: "M3.5 12.5 12 4h8v8l-8.5 8.5zM16 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  message: "M4 5h16v11H8l-4 3.5zM8 10h.01M12 10h.01M16 10h.01",
  palette: "M12 3a9 9 0 0 0 0 18c1.5 0 2-1 2-2s-.8-1.5-.8-2.5S14 15 15 15h2a4 4 0 0 0 4-4c0-4.4-4-8-9-8zM7.5 11.5h.01M10 7.5h.01M15 7.5h.01",
  assistant: "M12 3a7 7 0 0 0-7 7c0 2.6 1.4 4.6 3.5 5.8V20l3.5-2.2h0a7 7 0 1 0 0-14.8zM9 10h.01M12 10h.01M15 10h.01",
  ai: "M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4M10 10h4v4h-4z",
  team: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0M18 4v5M15.5 6.5h5",
  key: "M8 14a4.5 4.5 0 1 1 3.9-6.75L21 7.25V11h-2.5v2.5H16L14.4 11.7A4.5 4.5 0 0 1 8 14zM7 9.5h.01",
  menu: "M4 6h16M4 12h16M4 18h16",
  close: "M6 6l12 12M18 6 6 18",
  logout: "M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10",
  external: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  arrow: "M5 12h14M13 6l6 6-6 6"
};

export type AdminIconName = keyof typeof PATHS;

export function AdminIcon({ name, size = 20 }: { name: AdminIconName; size?: number }) {
  return (
    <svg className="a-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={PATHS[name]} /></svg>
  );
}
