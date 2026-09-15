"use client";

import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createWagmiConfig } from "@/lib/wagmi";

/**
 * Client providers.
 *
 * The config and query client are created once inside state rather than at module
 * scope: on the server a module-level singleton would be shared across requests, and
 * in dev hot reload it would leak a new connection set on every edit.
 */
export function Providers({ children }: { children: ReactNode }) {
  const [config] = useState(() => createWagmiConfig());
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Chain data goes stale fast at ~10 blocks/second, but refetching every
            // render would hammer a rate-limited endpoint. Five seconds is a
            // compromise; anything a user is about to sign is re-read explicitly.
            staleTime: 5_000,
            retry: 2,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
