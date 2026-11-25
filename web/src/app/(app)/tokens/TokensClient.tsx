"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/shell/PageHeader";
import { MarketCard } from "@/components/TokenCards";
import type { Payload } from "@/lib/read-discoveries";

/**
 * What is trading.
 *
 * A client component because /api/discoveries is `force-dynamic` behind an
 * in-process single-flight memo — it does live index reads, and the page must
 * not block a server render on them.
 */

export function TokensClient() {
  const [disc, setDisc] = useState<Payload | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    let first = true;
    const load = async () => {
      // Gate the poll, never the first load — a tab opened in the background
      // would otherwise sit on its placeholder forever.
      if (!first && document.visibilityState !== "visible") return;
      first = false;
      try {
        const r = await fetch("/api/discoveries");
        const d = (await r.json()) as Payload;
        if (alive) {
          setDisc(d);
          setFailed(false);
        }
      } catch {
        if (alive && !disc) setFailed(true);
      }
    };
    void load();
    // Two minutes: every render costs live index reads and, when a model is
    // configured, one scout call. This is not a ticker.
    const id = setInterval(load, 120_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <PageHeader
        title="Tokens"
        sub="Read live from the index — never from an agent's own ledger."
      />

      <div className="mm-wrap">
        {failed && !disc ? (
          <div className="mm-empty">
            <h2>Couldn&rsquo;t read the market just now</h2>
            <p>So this is what we don&rsquo;t know, not an empty market. It retries on its own.</p>
          </div>
        ) : !disc ? (
          <div className="mm-cards">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="mm-card skel" />
            ))}
          </div>
        ) : (
          <MarketList disc={disc} />
        )}
      </div>
    </>
  );
}

function MarketList({ disc }: { disc: Payload }) {
  if (disc.indexUnreachable) {
    return (
      <div className="mm-empty">
        <h2>The index didn&rsquo;t answer</h2>
        <p>
          Prices, depth and volume all come from it, so there is nothing to show — which is not the
          same as nothing trading.
        </p>
      </div>
    );
  }
  if (disc.rows.length === 0) {
    return (
      <div className="mm-empty">
        <h2>Nothing cleared the screen</h2>
        <p>Scanned {disc.scanned} pools. None of them had enough behind it to be worth a card.</p>
      </div>
    );
  }
  return (
    <div className="mm-cards">
      {disc.rows.map((r) => (
        <MarketCard key={r.token} r={r} />
      ))}
    </div>
  );
}
