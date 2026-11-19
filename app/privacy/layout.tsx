import type { ReactNode } from "react";
import { readBrand } from "../../src/config/brand";

export const metadata = { title: "Privacy policy", description: `How ${readBrand().name} collects, uses and protects personal information under the Australian Privacy Principles.` };

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
