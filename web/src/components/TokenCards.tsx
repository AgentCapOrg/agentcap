"use client";

import Link from "@/terminal/Link";
import { compactUsd } from "@/lib/format";
import type { DiscoveryRow } from "@/lib/read-discoveries";

/**
 * The token cards, lifted out of the console.
 *
 * EVERY HONESTY PROPERTY HERE WAS ARGUED FOR ONCE AND IS PINNED BY
 * api/discoveries/honesty.test.ts. They look like small wording choices and
 * each of them is a claim the page would otherwise be making falsely. Read the
 * comments before changing a line.
 */

const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");

export function shortAge(sec: number | null): string {
  if (sec === null) return "—";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86_400) return `${Math.round(sec / 3600)}h`;
  return `${Math.round(sec / 86_400)}d`;
}

// Moved to lib/format so the token page's SERVER-rendered stat strip can use
// it without pulling this client module into its bundle. Re-exported because
// the name is used across the coins view.
export { compactUsd };

/**
 * A coin's picture: the first letters of its ticker. The index publishes no logo,
 * and a card with a shattered icon reads as a broken page.
 */
function CoinArt({ symbol }: { symbol: string }) {
  const initials =
    (symbol || "?")
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 2)
      .toUpperCase() || "?";
  return <span className="mm-art fallback">{initials}</span>;
}

/** Trading now: the index's numbers. */
export function MarketCard({ r }: { r: DiscoveryRow }) {
  const up = (r.change24hPct ?? 0) >= 0;
  return (
    <article className="mm-card">
      <header>
        <CoinArt symbol={r.name.split(/[\s/]/)[0] ?? ""} />
        <div className="idc">
          <div className="tick">
            <b>{r.name}</b>
          </div>
          <div className="meta mono">
            <span>{r.ageDays === null ? "—" : shortAge(Math.round(r.ageDays * 86_400))} old</span>
            <span>{r.buyers24h === null ? "—" : `${r.buyers24h} buyers`}</span>
            <span>{compactUsd(r.volume24hUsd)} vol</span>
          </div>
        </div>
        <span className={`chg mono ${up ? "up" : "down"}`}>
          {r.change24hPct === null ? "—" : `${up ? "+" : ""}${r.change24hPct.toFixed(1)}%`}
        </span>
      </header>

      <div className="mm-figs mono">
        <span>
          <i>Price</i>
          {r.priceUsd === null
            ? "—"
            : `$${r.priceUsd < 0.01 ? r.priceUsd.toPrecision(2) : r.priceUsd.toFixed(4)}`}
        </span>
        <span>
          {/* FDV, and it says FDV. The index substitutes fully-diluted value
              for market cap whenever it lacks a circulating supply, and calling
              that "market cap" systematically makes a token look bigger and
              safer than it is. */}
          <i>FDV</i>
          {compactUsd(r.fdvUsd)}
        </span>
        <span>
          <i>Depth</i>
          {compactUsd(r.reserveUsd)}
        </span>
      </div>

      {/* THE AGENT'S OWN LINE, on the coin it is about. Conviction is an
          ORDERING — "look here first" — never a size and never a permission, so
          it renders as marks rather than a score out of five that would read
          like a rating. A coin with no verdict was passed over or never judged;
          saying nothing is the honest rendering of that. */}
      {r.verdict && (
        <div className="mm-verdict">
          <span className="pips" aria-label={`conviction ${r.verdict.conviction} of 5`}>
            {"▮".repeat(Math.max(1, Math.min(5, r.verdict.conviction)))}
          </span>
          <span className="vsay">{r.verdict.reason}</span>
        </div>
      )}

      <footer>
        <span className="soc mute">{r.venue}</span>
        <Link className="soc go" href={`/t/${r.token}`}>
          who&rsquo;s in it →
        </Link>
      </footer>
    </article>
  );
}
