"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BrandMark } from "./brand-mark";
import { ConnectWallet } from "./wallet";

const navigation = [
  { href: "/", label: "Home" },
  { href: "/explore", label: "Explore" },
  { href: "/launch", label: "Launch" },
] as const;

/**
 * Persistent site chrome.
 *
 * The header deliberately routes generic trade intent to Explore rather than claiming
 * that every token is tradeable. Actual trading eligibility remains decided by the
 * live on-chain venue check on each token page.
 */
export function SiteHeader() {
  const pathname = usePathname();

  return (
    <header className="site-header">
      <div className="site-header-inner">
        <Link className="site-brand" href="/" aria-label="STUNKS.FUN home">
          <BrandMark size="sm" />
          <span className="site-brand-wordmark">
            STUNKS<span>.FUN</span>
          </span>
        </Link>

        <nav className="site-nav" aria-label="Primary navigation">
          {navigation.map((item) => {
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={active ? "site-nav-link active" : "site-nav-link"}
                aria-current={active ? "page" : undefined}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <form className="site-search" action="/explore" method="get">
          <input type="hidden" name="sort" value="NEW" />
          <label>
            <span className="sr-only">Search tokens</span>
            <span aria-hidden="true">⌕</span>
            <input
              type="search"
              name="q"
              placeholder="Search token, address, or creator…"
              autoComplete="off"
            />
          </label>
        </form>

        <div className="site-header-actions">
          <span className="network-chip" title="Robinhood Chain (4663)">
            <span className="status-dot" /> Robinhood Chain
          </span>
          <ConnectWallet compact />
        </div>
      </div>
    </header>
  );
}
