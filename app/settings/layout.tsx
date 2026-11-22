import type { ReactNode } from "react";
import AccountShell from "./account-shell";

export const metadata = { title: "Account" };

export default function Layout({ children }: { children: ReactNode }) {
  return <AccountShell>{children}</AccountShell>;
}
