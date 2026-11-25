/**
 * THE ORCHESTRATOR'S FLOW SERVICE — Bitquery lane in, flow facts out.
 *
 * Kept beside orchestrator.ts, as orchestrator-xpost.ts and orchestrator-fomo.ts
 * are, so the orchestrator's own diff is a handful of lines: build the runtime
 * once, export `flowFor`, attach the broker to each child it spawns.
 *
 * WHO ASKS, AND ON WHOSE BUDGET.
 *
 *   flowFor(token)          the orchestrator's own answers (X replies). Spends
 *                           from the whole day's points.
 *   a child, over IPC       decision evidence for a review. Spends from the
 *                           evidence share only (bitquery-lane.ts), and only a
 *                           child whose smart account the operator listed in
 *                           AGENTCAP_DECISION_RESEARCH_ACCOUNTS may ask at all.
 *
 * THE LAUNCHER IS NOT DERIVABLE. Whether a coin's launcher sold needs the
 * launcher's address, and nothing a caller or the token itself reports may
 * supply it: a caller could point the lane at any wallet, and a rug that names
 * a decoy would read as "the creator did not sell". With no launch record this
 * build can trust, the answer is "not-derivable", never "did not sell".
 *
 * ONE DEADLINE PER READING. The flow query spends from FLOW_DEADLINE_MS, which
 * sits under the broker's ceiling on one child answer (flow-broker.ts
 * serveMaxCallMs): a reading that succeeded is never thrown away by that
 * ceiling, and nothing is still spending after the child has been answered.
 */

import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { decisionResearchEnabledFor } from "./decision-research";
import { childProcessFlowPort, serveFlowRequests } from "./flow-broker";
import type { CreatorFlow, FlowResult } from "./flow-facts";
import { agentcapHome } from "./home";
import { BITQUERY_LANE_DEFAULTS, BitqueryLane, LANE_POINTS, bitqueryLaneSetup, type BitqueryLaneSetup, type LanePurpose } from "./venues/bitquery-lane";

export interface FlowService {
  /**
   * Flow facts for a token, or the word for why not. Never throws; done within
   * FLOW_DEADLINE_MS, or within `timeoutMs` when a caller that is waiting on
   * less (an X answer's research share) says so. Never longer.
   */
  flowFor(token: string, opts?: { purpose?: LanePurpose; timeoutMs?: number }): Promise<FlowResult>;
}

/**
 * One reading's whole budget of time. Under FLOW_BROKER_LIMITS.serveMaxCallMs
 * (22 s), with room for the IPC hop (orchestrator-flow.test.ts pins the order).
 */
export const FLOW_DEADLINE_MS = 18_000;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
export function makeFlowService(deps: {
  lane: Pick<BitqueryLane, "tokenFlow">;
  now?: () => number;
  /** Test seam: the reading's budget. */
  deadlineMs?: number;
}): FlowService {
  const now = deps.now ?? Date.now;
  const deadlineMs = deps.deadlineMs ?? FLOW_DEADLINE_MS;

  return {
    async flowFor(raw, opts = {}) {
      try {
        if (typeof raw !== "string" || !ADDRESS.test(raw) || /^0x0{40}$/i.test(raw)) return { ok: false, failure: "invalid-request" };
        const token = raw.toLowerCase() as `0x${string}`;
        const purpose = opts.purpose ?? "answer";
        // A caller's own, shorter wait shortens the reading: the lane then sends
        // nothing it could not finish in time (minRequestMs), and nothing is
        // still spending after that caller has moved on.
        const budget = typeof opts.timeoutMs === "number" && opts.timeoutMs > 0 ? Math.min(deadlineMs, opts.timeoutMs) : deadlineMs;
        const deadline = now() + budget;
        const flow = await deps.lane.tokenFlow(token, { purpose, deadline });
        if (!flow.ok) return { ok: false, failure: flow.failure };
        const creator: CreatorFlow = { state: "not-derivable" };
        return { ok: true, facts: { token, observedAt: flow.observedAt, ...flow.data, creator } };
      } catch {
        return { ok: false, failure: "unavailable" };
      }
    },
  };
}

export interface FlowRuntime {
  setup: BitqueryLaneSetup;
  /** Null while the lane is off: every flow question then answers "unavailable". */
  service: FlowService | null;
}

/**
 * Read the switches and build the lane, once. Off — no key, or
 * AGENTCAP_BITQUERY_LANE=0 — there is no SQLite file and no
 * request. A lane whose file cannot be opened is off too, and says why.
 */
export function startFlowRuntime(o: { env: Record<string, string | undefined>; home: string; log: (line: string) => void }): FlowRuntime {
  const setup = bitqueryLaneSetup(o.env);
  for (const line of setup.lines) o.log(line);
  if (setup.off || !setup.config) return { setup, service: null };
  try {
    const lane = new BitqueryLane({ dir: path.join(o.home, "bitquery-lane"), config: setup.config, log: o.log });
    return { setup, service: makeFlowService({ lane }) };
  } catch (e) {
    o.log(`bitquery lane: off — its store could not be opened (${e instanceof Error ? e.name : "error"})`);
    return { setup, service: null };
  }
}

/**
 * THE PROCESS'S ONE RUNTIME, held here rather than in orchestrator.ts so the
 * passes that answer on X (orchestrator-xpost.ts and its kin, which
 * orchestrator.ts imports) can import `flowFor` from this file without a
 * cycle. Built on first use; the orchestrator builds it at boot so its line
 * lands in the boot log, with the orchestrator's own log prefix.
 *
 * Reads process.env, which is safe for the reason CHILD_SECRET_STRIP exists:
 * in a child the key is gone, so the lane is off and every answer is
 * "unavailable". A child has no reason to import this file, and
 * orchestrator-flow.test.ts pins that index.ts does not.
 */
let runtime: FlowRuntime | null = null;

export function flowRuntimeNow(o: { log?: (line: string) => void } = {}): FlowRuntime {
  runtime ??= startFlowRuntime({
    env: process.env,
    home: agentcapHome(),
    log: o.log ?? ((line) => console.log(`[orchestrator] ${line}`)),
  });
  return runtime;
}

/** Test seam: forget the runtime so the next use reads the environment again. */
export function resetFlowRuntimeForTest(): void {
  runtime = null;
}

/**
 * FLOW FACTS FOR A TOKEN, for the orchestrator's own answers (X replies): DEX
 * buys and sells over 5/15/60 minutes, the venue split, the largest sells, and
 * whether the address the launchpad recorded as launching the coin sold — or
 * the word for why not (flow-facts.ts). Spends from the lane's whole day;
 * never throws, and answers within FLOW_DEADLINE_MS, or `timeoutMs` when that
 * is shorter. For X, flowXLines() turns a result into digit-free banded lines
 * that pass the writer's clean() and the X gate unchanged; renderFlowLens()
 * keeps the numbers, for a Brain lens.
 */
export async function flowFor(token: string, opts: { timeoutMs?: number } = {}): Promise<FlowResult> {
  const service = flowRuntimeNow().service;
  return service ? service.flowFor(token, { purpose: "answer", ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) }) : { ok: false, failure: "unavailable" };
}

/**
 * HOW MANY READINGS X ANSWERS MAY ASK FOR IN A UTC DAY: the part of the lane's
 * day that child evidence can never spend (1 − evidenceShare), at a whole
 * reading's price (the flow query and the launcher's). Answers spend from the
 * whole day, so without this a run of strangers' tags — public, and polled
 * every minute — could eat into the share the trading reviews rely on: the
 * lane weighs evidence against its own spend and the day's total, so answers
 * kept to the rest leave evidence its whole share. With the defaults,
 * 25,000 × 0.2 / 25 = 200 readings a day. Zero with the lane off.
 */
export function answerReadingsPerDay(setup: BitqueryLaneSetup): number {
  if (setup.off || !setup.config) return 0;
  const reading = LANE_POINTS.tokenFlow + LANE_POINTS.creatorFlow;
  // The evidence cap exactly as the lane computes it (bitquery-lane.ts reserve).
  const day = setup.config.pointsPerDay;
  return Math.max(0, Math.floor((day - Math.floor(day * BITQUERY_LANE_DEFAULTS.evidenceShare)) / reading));
}

/**
 * Answer one child's flow questions on its IPC channel, as decision evidence.
 * A no-op with the lane off or without a connected channel (the channel exists
 * while the Fomo pass is on). The allowlist is read on every request, by the
 * smart account THIS process spawned the child for. Released when it exits.
 */
export function attachFlowBroker(
  service: FlowService | null,
  tenant: string,
  proc: ChildProcess,
  smartAccount: string,
  log: (line: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): (() => void) | null {
  if (!service || proc.connected !== true) return null;
  try {
    // The child's own wait, carried on the request, bounds the reading: nothing is still spending after it gave up.
    const release = serveFlowRequests(childProcessFlowPort(proc), tenant.toLowerCase(), (t, timeoutMs) => service.flowFor(t, { purpose: "evidence", ...(timeoutMs !== undefined ? { timeoutMs } : {}) }), {
      allowed: () => decisionResearchEnabledFor(smartAccount, env),
      log,
    });
    proc.once("exit", release);
    return release;
  } catch (e) {
    log(`bitquery lane: flow broker not attached (${e instanceof Error ? e.name : "error"})`);
    return null;
  }
}
