import { useColorScheme } from "react-native";

/** Design tokens for the app, matching the website's navy and gold. Spacing follows a 4-point scale. */
const light = {
  bg: "#f7f6f2", surface: "#ffffff", text: "#1b2233", muted: "#5b6476", border: "#e2e0d8",
  primary: "#1f2a44", onPrimary: "#ffffff", accent: "#b8892d", danger: "#b3261e", success: "#1e7a46", unread: "#eef1f8"
};
const dark: typeof light = {
  bg: "#11151f", surface: "#1a2030", text: "#eef0f5", muted: "#a3aabb", border: "#2c3446",
  primary: "#d6b25e", onPrimary: "#11151f", accent: "#d6b25e", danger: "#f2b8b5", success: "#7fd3a1", unread: "#232b3f"
};

export type Colors = typeof light;
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 6, md: 10, lg: 16 } as const;
export const font = { small: 13, body: 15, title: 17, heading: 22 } as const;
/** Smallest comfortable tap target (Apple and Google guidance). */
export const TAP = 44;

export function useColors(): Colors {
  return useColorScheme() === "dark" ? dark : light;
}
