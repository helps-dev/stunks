import type { Address, PublicClient } from "viem";
import type { PonsAddresses } from "@stunks/types";
import { ponsV2FactoryAbi } from "../abi/factory.js";
import { ponsV2MemeHookAbi } from "../abi/hook.js";

/**
 * Resolve the Pons address graph from the factory.
 *
 * Only the factory address is configured. Everything else is read here, because:
 *
 *  - the protocol owner can rotate the graduation executor, launch deployer and
 *    launch forwarder at any time, so a hardcoded list goes stale silently
 *  - none of these addresses appear in Pons's published README, so there is no
 *    authoritative document to copy them from anyway
 *  - the audit found the published source out of sync with the deployment, so the
 *    chain is the only trustworthy description of the system
 *
 * Naming traps encoded below, all confirmed on-chain: the locker getter is
 * `locker()` (not `launchLocker()`), the hook getter is `memeHook()` (not `hook()`),
 * and the factory has no `feePolicy()` at all because the meme hook *is* the fee
 * policy. The fee escrow therefore comes from the hook, not the factory.
 */

export async function resolvePonsAddresses(
  client: PublicClient,
  factory: Address,
): Promise<PonsAddresses> {
  const read = <T>(functionName: string) =>
    client.readContract({
      address: factory,
      abi: ponsV2FactoryAbi,
      functionName: functionName as never,
    }) as Promise<T>;

  const [
    memeHook,
    graduationExecutor,
    launchDeployer,
    locker,
    buybackVault,
    graduationGuard,
    launchAndBuyRouter,
    poolManager,
    positionManager,
  ] = await Promise.all([
    read<Address>("memeHook"),
    read<Address>("graduationExecutor"),
    read<Address>("launchDeployer"),
    read<Address>("locker"),
    read<Address>("buybackVault"),
    read<Address>("graduationGuard"),
    read<Address>("launchForwarder"),
    read<Address>("poolManager"),
    read<Address>("positionManager"),
  ]);

  // The escrow lives on the fee policy, which is the hook.
  const feeEscrow = (await client.readContract({
    address: memeHook,
    abi: ponsV2MemeHookAbi,
    functionName: "feeEscrow",
  })) as Address;

  return {
    factory,
    memeHook,
    graduationExecutor,
    launchDeployer,
    locker,
    buybackVault,
    graduationGuard,
    launchAndBuyRouter,
    poolManager,
    positionManager,
    feeEscrow,
  };
}

/**
 * Cache resolved addresses per chain, with a TTL because several entries are
 * owner-mutable. The TTL is deliberately short enough that a rotation is picked up
 * within a deploy cycle rather than requiring a restart.
 */
export class PonsAddressCache {
  private cached: { addresses: PonsAddresses; resolvedAt: number } | null = null;

  constructor(
    private readonly client: PublicClient,
    private readonly factory: Address,
    private readonly ttlMs = 10 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<PonsAddresses> {
    if (this.cached && this.now() - this.cached.resolvedAt < this.ttlMs) {
      return this.cached.addresses;
    }
    const addresses = await resolvePonsAddresses(this.client, this.factory);
    this.cached = { addresses, resolvedAt: this.now() };
    return addresses;
  }

  invalidate(): void {
    this.cached = null;
  }
}

/**
 * Assert every resolved address actually has code. A zero-code address means the
 * factory is pointing somewhere unexpected, and reads against it would return
 * empty results that look like legitimate answers.
 */
export async function assertAddressesHaveCode(
  client: PublicClient,
  addresses: PonsAddresses,
): Promise<void> {
  const entries = Object.entries(addresses) as [keyof PonsAddresses, Address][];
  const results = await Promise.all(
    entries.map(async ([name, address]) => {
      const code = await client.getCode({ address });
      return { name, address, hasCode: code !== undefined && code !== "0x" };
    }),
  );
  const missing = results.filter((result) => !result.hasCode);
  if (missing.length > 0) {
    throw new Error(
      `Pons addresses resolved to accounts with no code:\n` +
        missing.map((m) => `  ${m.name}: ${m.address}`).join("\n"),
    );
  }
}
