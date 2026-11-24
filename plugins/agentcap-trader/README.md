# AgentCap Day Trader

The day-trader skill pack for Claude Code, trading through your own AgentCap
agent instead of Alpaca. Eleven skills: scan the charts, track the news, time
the entry, plan the exit, replay the odds, size the trade to your max loss and
to the agent's signed limits, check it against your rules, then propose it for
you to approve in AgentCap.

Claude never moves your money on its own. Every trade is one proposal you say
yes to in the chat, allow on Claude's own permission card, and approve again in
AgentCap, and the agent's signed limits still apply after that. Paper
(practice) is the default.

Built on [Jake Schincariol's day-trader-skill](https://github.com/Jakeschincariol/day-trader-skill)
(MIT), vendored at commit `3d0f4ef6986f4984b7c6bd46f7ff4f87744c3abd`. The
signal side (scanner, news, entry, exit, time machine, analyst, Pelosi tracker)
is his and unchanged; the broker, budget, risk and alerts skills are rewired to
AgentCap. What changed is listed below.

## Install

Inside Claude Code, one at a time:

```text
/plugin marketplace add https://github.com/millw14/agentcap.git
/plugin install agentcap@agentcap
/plugin install agentcap-trader@agentcap
```

The `agentcap` plugin carries the AgentCap connection (its MCP server); this
one carries the skills. Then sign in once: `/mcp`, choose
`plugin:agentcap:agentcap`, Authenticate, and on the AgentCap page tick
**Suggest trades for you to approve** (it starts unticked) before you click
Allow. The connector listed in Claude's directory does not carry the trade
tools, so use the plugin's server.

The tools need Python 3.8 or newer. Nothing to pip install.

## The eleven

| command | job | on AgentCap |
| --- | --- | --- |
| `/agentcap-trader:trader-scanner` | Chart Scanner | Scans AgentCap's stock tokens (or any list) for opening-range breakouts, flags, oversold bounces. |
| `/agentcap-trader:trader-news` | News Monitor | Breaking headlines and 8-Ks for what you watch. |
| `/agentcap-trader:trader-entry` | Entry Timer | Watches a setup bar by bar and says the moment to get in. |
| `/agentcap-trader:trader-exit` | Exit Planner | Sets the stop and the target before the entry. |
| `/agentcap-trader:trader-timemachine` | Time Machine | Replays the rest of the session 10,000 times and every past time the setup fired. |
| `/agentcap-trader:trader-budget` | Budget Manager | Sizes a USDG amount to your max loss and the agent's per-trade limit and 24-hour budget. |
| `/agentcap-trader:trader-risk` | Risk Manager | PASS or BLOCK against your rules and the agent's: book, permission expiry, signed limits, quote. |
| `/agentcap-trader:trader-broker` | Order Executor | One `propose_trade` per yes; you approve it in AgentCap; follows it to the fill. |
| `/agentcap-trader:trader-alerts` | Price Alerts | Rings on the stop, the target and the flat-by time. |
| `/agentcap-trader:trader-analyst` | Earnings Analyst | Reads earnings filings and sums up what changed. |
| `/agentcap-trader:trader-pelosi` | Pelosi Tracker | Reads Congress's stock-trade disclosures as they are filed. |

## One trade

Everything lands in a `trader/` folder in your project, and each skill reads
what the last one wrote. The AgentCap tool results Claude saves go in
`trader/agentcap/`.

```
broker step 1: list_agents, get_agent_status + get_agent_controls, discover_tokens  (the link)
scanner -> news -> entry -> exit -> timemachine -> budget                             (the plan)
quote_trade -> risk -> broker: your yes, Claude's card, propose_trade                 (the proposal)
you approve in AgentCap -> get_proposal -> the fill                                   (the trade)
alerts: stop, target, flat by the close -> broker flatten -> the same gates           (the exit)
```

The reel's trade, TSLA on Monday 2026-10-19, on a paper agent with a 25 USDG
per-trade limit: entry 364.18 at 10:15, stop 358.32, target 370.04. The
budget sizes 23.75 USDG: the agent's per-trade limit binds, less 5% so the
sell that closes it still fits under that limit (your $2 max loss would allow
$124.29). The quote puts the token at 364.90, 0.20% over the stock.
trader-risk measures the loss from that price with fees and gas both ways
($0.48, under your $2) and passes it. You say yes, allow the card,
AgentCap returns an approval link, you approve, and `get_proposal` reports
`paper_filled`.

## What changed from the upstream pack

- **The broker is your AgentCap agent.** `trader-broker` calls `propose_trade`
  instead of Alpaca's `place_stock_order`, with one idempotency key per yes, and
  records `proposed`, then `confirmed`, `paper_filled`, `refused`, `failed`,
  `expired`, `cancelled` or `rejected`. A proposal waiting for you counts
  against today's limits. A `propose_trade` call that timed out may have made
  a proposal, so it counts too and is retried only with the same idempotency
  key. A proposal that failed may still have traded: it keeps counting and is
  never proposed again blind. A fill is applied to the portfolio once per
  proposal id, and recording it can be resumed after a crash.
- **Dollar amounts, not shares.** `trader-budget` sizes a USDG amount to the
  cent. Its limits include the agent's signed per-trade limit and the
  owner-order cap, each less 5% (AgentCap applies them to the closing sell
  too, which is worth more if the price rose), and half of what is left of
  the 24-hour budget; AgentCap counts sells in that figure, so the other half
  is kept for the sell.
- **AgentCap's checks in trader-risk.** These block an order: the wrong agent,
  a limits snapshot over 10 minutes old, a paper config meeting a live agent,
  a stopped agent, a permission that expires before the flat-by time, the
  signed limits, a token that is not the registry's address, and a missing,
  stale or refused quote. The token's quoted price must also be within 1% of
  the stock price on the chart.
- **No resting stop.** AgentCap holds no stop-loss or take-profit order. The
  stop and the target are a plan that trader-alerts watches. Getting out is a
  sell you approve, so it can fill well past the stop.
- **Only AgentCap's stock tokens.** `agentcap.py universe` writes them as a
  scanner universe. A setup on any other chart is research only.
- Upstream's Alpaca paths are still in the code (`"broker": "alpaca"`) and
  their tests still run. The docs, the example config and the defaults are AgentCap's.

## Fine print

**Not financial advice.** This is software that reads public data and does
arithmetic. It does not know your situation and it cannot see the future.
Most people who day trade lose money. You can lose money.

**Paper first.** `"paper": true` is the default, and trader-risk blocks every
order unless the agent is in practice mode. Going live is your decision, made
in AgentCap and in your own config, never by Claude.

**Stock tokens are not the stocks.** The charts are the stocks' own Yahoo
bars; the trade is in a token priced against the stock through Chainlink.
They can drift apart, above all outside market hours or when a token is
paused, which is why the quote must be within 1% of the chart. A paused token
is never bought.

**A stop is a plan.** Between the alert, your yes and your approval in
AgentCap, the price keeps moving. The max loss shown is the loss at the stop
price, plus fees and gas.

**The free data is unofficial.** Yahoo's chart endpoint can lag, change or
rate-limit. The token's quoted price is the one that fills.

## Tests

```bash
cd plugins/agentcap-trader
python3 -m unittest discover -s tests
```

They run offline: upstream's fixtures cut from real data, plus
`tests/test_agentcap.py`, built on the shapes the AgentCap tools return.

## License

MIT. The original pack is copyright 2026 Jake Schincariol (`LICENSE`); the
AgentCap changes are released under the same license.
