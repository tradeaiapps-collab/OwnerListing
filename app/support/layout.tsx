import type { ReactNode } from "react";
import { readBrand } from "../../src/config/brand";

export const metadata = { title: "Support", description: `Help with your ${readBrand().name} account, listings, offers, reports and data requests.` };

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
