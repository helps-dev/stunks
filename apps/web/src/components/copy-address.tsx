"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The contract address, with a copy button.
 *
 * THE ADDRESS IS SHOWN IN FULL, NEVER TRUNCATED. Everywhere else on the site an
 * address is shortened to fit a row, but this is the one people paste into a wallet
 * before spending money, and a shortened address cannot be checked against another
 * source. A visitor comparing this against the explorer needs every character.
 *
 * `navigator.clipboard` is unavailable on an insecure origin and can be refused by
 * permission policy, so the fallback path selects the text instead — leaving the
 * visitor able to copy it themselves rather than with a button that silently did
 * nothing.
 */

const CONFIRMATION_MS = 1_600;

export function CopyAddress({ address }: { readonly address: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const value = useRef<HTMLElement | null>(null);

  // A component unmounted mid-confirmation must not set state afterwards.
  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(address);
      setState("copied");
    } catch {
      // Leave the address selected so it can still be copied by hand.
      const node = value.current;
      const selection = window.getSelection();
      if (node !== null && selection !== null) {
        const range = document.createRange();
        range.selectNodeContents(node);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      setState("failed");
    }
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), CONFIRMATION_MS);
  }

  return (
    <div className="copy-address">
      <span className="copy-address-label">CA</span>
      <code className="copy-address-value mono" ref={value}>
        {address}
      </code>
      <button
        type="button"
        className="copy-address-button"
        onClick={() => void copy()}
        aria-label={`Copy contract address ${address}`}
      >
        {state === "copied" ? "Copied" : state === "failed" ? "Select it" : "Copy"}
      </button>
    </div>
  );
}
