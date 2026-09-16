import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Providers } from "@/components/providers";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "STUNKS.FUN — Launch. Trade. Grow Together.",
    template: "%s | STUNKS.FUN",
  },
  description:
    "A non-custodial Pons V2 token launchpad and trading interface on Robinhood Chain. STUNKS charges zero platform fee.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <SiteHeader />
          {children}
          <footer className="site-footer">
            <div className="site-footer-inner">
              <div className="site-footer-brand">
                <span className="footer-mark">S</span>
                <span>STUNKS.FUN</span>
              </div>
              <p>
                Non-custodial. Built on Pons V2. Zero STUNKS platform fee. Always verify
                on-chain before you trade.
              </p>
              <div className="site-footer-links">
                <a href="/explore">Explore</a>
                <a href="/launch">Launch</a>
                <a href="https://robinhoodchain.blockscout.com" target="_blank" rel="noreferrer">
                  Explorer ↗
                </a>
              </div>
            </div>
          </footer>
        </Providers>
      </body>
    </html>
  );
}
