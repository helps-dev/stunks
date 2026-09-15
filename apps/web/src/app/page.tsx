import { formatUnitsExact, ratioBps } from "@stunks/utils";
import { BLOCK_TIME_SECONDS, BLOCKS_PER_DAY } from "@stunks/config";
import { readChainSnapshot } from "@/lib/read-chain";

/**
 * Phase 1 proof-of-read.
 *
 * Every row on this page is a value read from Robinhood Chain at request time, with
 * the source of the value stated next to it. There are deliberately no token cards,
 * no charts, no volume figures and no placeholder statistics: none of that data
 * exists yet, and inventing it is exactly what this project forbids.
 */

// Always read fresh. Caching a chain read would undermine the whole point.
export const dynamic = "force-dynamic";
export const revalidate = 0;

function bpsToPercent(bps: bigint | number): string {
  const value = typeof bps === "bigint" ? bps : BigInt(bps);
  const whole = value / 100n;
  const fraction = value % 100n;
  return fraction === 0n
    ? `${whole}%`
    : `${whole}.${fraction.toString().padStart(2, "0")}%`;
}

interface Row {
  label: string;
  value: string;
  source: string;
}

function Table({ rows }: { rows: readonly Row[] }) {
  return (
    <div className="panel">
      <table>
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">Value</th>
            <th scope="col">Source</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              <td className="value">{row.value}</td>
              <td className="source">{row.source}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function Page() {
  const snapshot = await readChainSnapshot();

  if (!snapshot.ok) {
    return (
      <main>
        <h1>STUNKS.FUN</h1>
        <p>Phase 1 foundation — live read of Pons V2 on Robinhood Chain.</p>

        <h2>Chain unreachable</h2>
        <div className="error">
          <p style={{ color: "var(--text)", marginBottom: 10 }}>
            No RPC endpoint answered, so this page has nothing truthful to show.
          </p>
          <p className="mono" style={{ marginBottom: 10 }}>
            {snapshot.message}
          </p>
          <p style={{ margin: 0 }}>
            Endpoints tried: {snapshot.endpointsTried.join(", ")}
          </p>
        </div>
        <p className="note">
          This is the intended behaviour. The page reports the failure rather than
          rendering plausible-looking numbers from a cache or a fixture.
        </p>
      </main>
    );
  }

  const { parameters, feePolicy, addresses, configs } = snapshot;

  const chainRows: Row[] = [
    { label: "Chain ID", value: String(snapshot.chainId), source: "eth_chainId" },
    {
      label: "Head block",
      value: snapshot.blockNumber.toString(),
      source: "eth_blockNumber",
    },
    {
      label: "Head timestamp",
      // eslint-disable-next-line no-restricted-syntax -- a unix timestamp is not money; Date requires a number
      value: new Date(Number(snapshot.blockTimestamp) * 1000).toISOString(),
      source: "eth_getBlockByNumber",
    },
    {
      label: "Block time",
      value: `~${BLOCK_TIME_SECONDS}s (~${BLOCKS_PER_DAY.toLocaleString("en-US")} blocks/day)`,
      source: "measured in Phase 0 audit",
    },
    { label: "RPC endpoint", value: snapshot.endpoint, source: "configuration" },
  ];

  const addressRows: Row[] = [
    {
      label: "V2 factory",
      value: addresses.factory,
      source: "configuration (the only one)",
    },
    {
      label: "Factory deploy block",
      value: snapshot.factoryDeployBlock.toString(),
      source: "binary search over eth_getCode",
    },
    {
      label: "Meme hook / fee policy",
      value: addresses.memeHook,
      source: "factory.memeHook()",
    },
    {
      label: "Launch + buy router",
      value: addresses.launchAndBuyRouter,
      source: "factory.launchForwarder()",
    },
    {
      label: "Graduation executor",
      value: addresses.graduationExecutor,
      source: "factory.graduationExecutor()",
    },
    {
      label: "Launch deployer",
      value: addresses.launchDeployer,
      source: "factory.launchDeployer()",
    },
    { label: "Launch locker", value: addresses.locker, source: "factory.locker()" },
    {
      label: "Buyback vault",
      value: addresses.buybackVault,
      source: "factory.buybackVault()",
    },
    {
      label: "Graduation guard",
      value: addresses.graduationGuard,
      source: "factory.graduationGuard()",
    },
    {
      label: "Uniswap V4 PoolManager",
      value: addresses.poolManager,
      source: "factory.poolManager()",
    },
    {
      label: "Uniswap V4 PositionManager",
      value: addresses.positionManager,
      source: "factory.positionManager()",
    },
    { label: "Fee escrow", value: addresses.feeEscrow, source: "memeHook.feeEscrow()" },
  ];

  const parameterRows: Row[] = [
    {
      label: "Launch fee",
      value: `${formatUnitsExact(parameters.launchFee, 18)} ETH`,
      source: "factory.launchFee()",
    },
    {
      label: "Launches enabled",
      value: parameters.launchEnabled ? "yes" : "no",
      source: "factory.launchEnabled()",
    },
    {
      label: "Max creator tax",
      value: bpsToPercent(parameters.maxCreatorTaxBps),
      source: "factory.maxCreatorTaxBps()",
    },
    {
      label: "Anti-snipe start",
      value: bpsToPercent(parameters.snipeTaxStartBps),
      source: "factory.snipeTaxStartBps()",
    },
    {
      label: "Anti-snipe window",
      value: `${parameters.snipeTaxSeconds}s`,
      source: "factory.snipeTaxSeconds()",
    },
    { label: "Protocol owner", value: parameters.owner, source: "factory.owner()" },
  ];

  const feeRows: Row[] = [
    {
      label: "Protocol share of trade fee",
      value: bpsToPercent(feePolicy.protocolFeeShareBps),
      source: "memeHook.currentFeePolicy()",
    },
    {
      label: "Buyback earmark",
      value: bpsToPercent(feePolicy.buybackBurnBps),
      source: "memeHook.currentFeePolicy()",
    },
    {
      label: "Graduated-pool hook fee",
      value: bpsToPercent(feePolicy.hookFeeBps),
      source: "memeHook.currentFeePolicy()",
    },
    {
      label: "Max internal price impact",
      value: bpsToPercent(feePolicy.maxInternalPriceImpactBps),
      source: "memeHook.currentFeePolicy()",
    },
    {
      label: "Protocol fee recipient",
      value: feePolicy.protocolFeeRecipient,
      source: "memeHook.currentFeePolicy()",
    },
    {
      label: "STUNKS platform revenue",
      value: `${snapshot.platformRevenue.amount} — none`,
      source: "verified: no fee route exists",
    },
  ];

  return (
    <main>
      <h1>STUNKS.FUN</h1>
      <p>
        Phase 1 foundation. Everything below was read from Robinhood Chain when this page
        was requested, and each row states where its value came from. There is no trading,
        no launching, and no indexed data yet — so there are no token lists, charts, or
        volume figures on this page.
      </p>
      <p>
        <span className="badge ok">live read</span>{" "}
        <span className="mono" style={{ color: "var(--muted)" }}>
          {snapshot.readAt}
        </span>
      </p>

      <h2>Chain</h2>
      <Table rows={chainRows} />

      <h2>Pons V2 address graph</h2>
      <p>
        Only the factory address is configured. Every other address is resolved by calling
        the factory, because the protocol owner can rotate several of them and a hardcoded
        list would go stale silently.
      </p>
      <Table rows={addressRows} />

      <h2>Factory parameters</h2>
      <p>
        All of these are owner-mutable, so they are read live rather than cached as
        constants. The anti-snipe window in particular differs between Pons&apos;s
        published source and its deployment.
      </p>
      <Table rows={parameterRows} />

      <h2>Launch configuration</h2>
      {configs.length === 0 ? (
        <p>The factory reports no launch configurations.</p>
      ) : (
        configs.map((config, index) => {
          const reserved = snapshot.reservedTokensByConfig[index] ?? 0n;
          const reservedBps = ratioBps(reserved, config.supply);
          const rows: Row[] = [
            {
              label: "Supply",
              value: formatUnitsExact(config.supply, 18),
              source: "getLaunchConfig().supply",
            },
            {
              label: "Curve fee",
              value: bpsToPercent(config.curveFeeBps),
              source: "getLaunchConfig().curveFeeBps",
            },
            {
              label: "Phantom quote reserve",
              value: `${formatUnitsExact(config.phantomQuote, 18)} ETH`,
              source: "getLaunchConfig().phantomQuote",
            },
            {
              label: "Graduation threshold",
              value: `${formatUnitsExact(config.graduationThreshold, 18)} ETH`,
              source: "getLaunchConfig().graduationThreshold",
            },
            {
              label: "Pool fee / tick spacing",
              value: `${config.poolFee} / ${config.tickSpacing}`,
              source: "getLaunchConfig()",
            },
            {
              label: "Reserved for pool",
              value: `${formatUnitsExact(reserved, 18)} (${bpsToPercent(reservedBps)} of supply)`,
              source: "derived: supply x phantom / (phantom + threshold)",
            },
            {
              label: "Sellable on curve",
              value: bpsToPercent(10_000n - reservedBps),
              source: "derived",
            },
            {
              label: "Enabled",
              value: config.enabled ? "yes" : "no",
              source: "getLaunchConfig().enabled",
            },
          ];
          return (
            <div key={config.id.toString()} style={{ marginBottom: 20 }}>
              <p style={{ marginBottom: 8 }}>
                Config <span className="mono">#{config.id.toString()}</span>
              </p>
              <Table rows={rows} />
            </div>
          );
        })
      )}

      <h2>Fee policy</h2>
      <p>
        Read from the meme hook, which is itself the protocol&apos;s fee policy — the
        factory has no separate fee-policy getter.
      </p>
      <Table rows={feeRows} />
      <p className="note">{snapshot.platformRevenue.reason}</p>

      <h2>What is not here</h2>
      <p>
        No tokens, trades, holders, volume, market caps, charts or leaderboards. That data
        comes from the indexer, which is Phase 3. Until it exists, this application will
        not display it — not even as a placeholder.
      </p>
    </main>
  );
}
