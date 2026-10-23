import type { ReactNode } from "react";

export const metadata = { title: "OwnerListing", description: "Internal build: not for public use" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-AU">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: "0 auto", maxWidth: 720, padding: 16 }}>
        {children}
      </body>
    </html>
  );
}
