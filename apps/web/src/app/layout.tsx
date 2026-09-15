import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "STUNKS.FUN — Phase 1 foundation",
  description:
    "Live read of Pons V2 state on Robinhood Chain. Phase 1 foundation: no trading, no launching, no indexed data yet.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
