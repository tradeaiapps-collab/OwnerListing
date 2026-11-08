import type { ReactNode } from "react";
import "../../styles/client-portal.css";

export const metadata = { title: "My portal" };

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
