/**
 * BOOKING A TRANSFER HOME THE STRANDED-OP RESOLVER SETTLES.
 *
 * The executor books a transfer when it hears the receipt; a transfer whose
 * receipt wait timed out would otherwise be booked by nobody — the peak keeps
 * the money that went home, and the breaker reads a drawdown.
 *
 * WHAT IT NEVER TOUCHES: the in-memory peaks and the cash baseline. It says
 * `booked`, and the caller sets capitalPeakDirty for the NEXT tick to re-read
 * the persisted peak before its book read.
 */

import { formatUnits } from "viem";
import { CASH, CASH_DECIMALS, classifyUsdgMovement } from "../../packages/core/src/index";
import { legsFromReceiptLogs, TRANSFER_TOPIC } from "./deposit-log";
import type { ReceiptLog } from "./fills";
import type { CapitalBooking, FlowRow } from "./store";

/** Everything a booking reads or writes, supplied by the caller (index.ts wires the store). */
export interface TransferSettleDeps {
  /** grant.smartAccount — EXACTLY the string the agents row was created with (bookCapitalFlow keys on it). */
  agentId: string;
  /** The account the cash left: the same smart account. */
  account: string;
  /** grant.chainId: the flow's chain identity. */
  chainId: number;
  /** The settled receipt's logs for a tx; null when the chain would not answer. */
  receiptLogs(txHash: `0x${string}`): Promise<readonly ReceiptLog[] | null>;
  /** store.bookCapitalFlow. Database errors throw, and must. */
  book(flow: FlowRow & { txHash: string; blockNumber: number; logIndex: number }): Promise<CapitalBooking>;
  /** addEvent for this agent. */
  event(level: "ok" | "warn" | "err", line: string): Promise<void>;
  /**
   * Is ANY flow on the books for this transaction (store.hasFlowForTx)? Null
   * when the ledger could not be asked. The executor books a transfer home with
   * no log index, so the identity index cannot catch a second booking of it.
   */
  flowBookedForTx?(txHash: string): Promise<boolean | null>;
}

/** Hex, decimal string, number or bigint to a non-negative safe integer, or null. */
function logPosition(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  try {
    const n = typeof v === "number" ? v : Number(BigInt(v as string | bigint));
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

export type TransferFlowRead =
  | { ok: true; amountUsdg6: bigint; logIndex: number; blockNumber: number }
  /** `unreadable`: the logs could not be decided on, so ask again; otherwise it is not a transfer home. */
  | { ok: false; unreadable: boolean; why: string };

/**
 * A TRANSFER HOME, read off its settled receipt: exactly one USDT Transfer out
 * of the account, keyed by its log index and block (so it books exactly once),
 * that the shared classifier calls `capital-out` — nothing came back in the
 * same transaction. The legs are read the way the deposit scanner reads them
 * (deposit-log.ts legsFromReceiptLogs), so the two cannot disagree about it.
 */
export function transferFlowFromReceipt(a: {
  account: string;
  usdgToken: string;
  logs: readonly ReceiptLog[] | null | undefined;
}): TransferFlowRead {
  const account = a.account.toLowerCase();
  const usdg = a.usdgToken.toLowerCase();
  const transfers = (a.logs ?? []).filter(
    (l) => (l.topics?.[0] ?? "").toLowerCase() === TRANSFER_TOPIC && l.topics.length === 3,
  );
  if (transfers.length === 0) {
    return { ok: false, unreadable: true, why: "the receipt carried no Transfer logs to read the transfer from" };
  }
  const out = transfers.filter(
    (l) => (l.address ?? "").toLowerCase() === usdg && `0x${l.topics[1]!.slice(-40)}`.toLowerCase() === account,
  );
  if (out.length !== 1) {
    return { ok: false, unreadable: false, why: `${out.length} USDT transfers left the account — a transfer home is exactly one` };
  }
  const log = out[0]!;
  const logIndex = logPosition(log.logIndex);
  const blockNumber = logPosition(log.blockNumber);
  if (logIndex === null || blockNumber === null || blockNumber === 0) {
    return { ok: false, unreadable: true, why: "the USDT log carries no log index or block, so it could not be booked exactly once" };
  }
  let amountUsdg6: bigint;
  let legs: ReturnType<typeof legsFromReceiptLogs>;
  try {
    amountUsdg6 = BigInt(log.data || "0x0");
    legs = legsFromReceiptLogs(a.logs ?? []);
  } catch {
    return { ok: false, unreadable: true, why: "the receipt's Transfer data could not be decoded" };
  }
  if (amountUsdg6 <= 0n) return { ok: false, unreadable: false, why: "the USDT leg moved nothing" };
  const v = classifyUsdgMovement({
    account,
    usdg: { token: usdg, from: account, to: `0x${log.topics[2]!.slice(-40)}`.toLowerCase(), amountRaw: amountUsdg6.toString() },
    txLegs: legs,
    usdgToken: usdg,
  });
  if (v.kind !== "capital-out") {
    return { ok: false, unreadable: false, why: `the transaction reads as ${v.kind}, not a transfer home — ${v.why}` };
  }
  return { ok: true, amountUsdg6, logIndex, blockNumber };
}

/**
 * THE RESOLVER'S FORM FOR A STRANDED TRANSFER HOME that landed: booked as the
 * executor books one — a 'transfer-intent' flow out, both peaks lowered with it
 * only if the flow landed — but through bookCapitalFlow, so the row and the
 * peaks are one transaction and a retry, or the deposit scan's own booking of
 * the same log, moves nothing twice. Before this, nothing booked it at all:
 * contributions and both peaks kept the money that went home, and the
 * drawdown breaker read the withdrawal as a loss.
 *
 * `proceed: false` — the receipt or the ledger could not be read or written —
 * leaves the row 'submitted' (still holding inference) for the next pass.
 * Every other outcome is a decision. `settled` is `booked` or `already` when
 * the transfer is on the books (the settlement then explains its cash);
 * `refused` and `not-a-transfer` leave its cash to inference, which books it
 * once as a withdrawal rather than never.
 */
export async function settleTransferLanding(
  d: TransferSettleDeps,
  txHash: `0x${string}`,
): Promise<{ proceed: boolean; settled: "booked" | "already" | "refused" | "not-a-transfer" | null; why?: string }> {
  try {
    const logs = await d.receiptLogs(txHash);
    if (logs === null) return { proceed: false, settled: null, why: "the receipt could not be read" };
    const r = transferFlowFromReceipt({ account: d.account, usdgToken: CASH.USDT as string, logs });
    if (!r.ok && r.unreadable) return { proceed: false, settled: null, why: r.why };
    if (!r.ok) {
      await d.event(
        "err",
        `a transfer the worker had lost track of landed (${txHash.slice(0, 10)}…) but its receipt does not read as ` +
          `one — ${r.why}. It is not booked as capital here; the cash it moved is left to the next balance check.`,
      );
      return { proceed: true, settled: "not-a-transfer" };
    }
    // THE EXECUTOR'S OWN BOOKING HAS NO LOG INDEX, so the identity index cannot
    // see it: a landed row whose write failed after the executor booked its
    // flow would otherwise be booked a second time here.
    const already = d.flowBookedForTx ? await d.flowBookedForTx(txHash) : false;
    if (already === null) return { proceed: false, settled: null, why: "the ledger could not say whether it was booked" };
    if (already) return { proceed: true, settled: "already" };
    const sent = formatUnits(r.amountUsdg6, CASH_DECIMALS);
    const booking = await d.book({
      agentId: d.agentId,
      direction: "out",
      amountUsdg: Number(sent),
      source: "transfer-intent",
      txHash,
      blockNumber: r.blockNumber,
      logIndex: r.logIndex,
      // EXPLICIT: a real on-chain transfer, whatever the heartbeat last wrote.
      mode: "live",
      chainId: d.chainId,
    });
    if (booking.kind === "booked") {
      await d.event(
        "ok",
        `📤 withdrawn ${sent} USDT (a transfer home the worker had lost track of, ${txHash.slice(0, 10)}…) — ` +
          `capital, not performance: the high-water mark moved with it`,
      );
      return { proceed: true, settled: "booked" };
    }
    if (booking.kind === "already") return { proceed: true, settled: "already" };
    await d.event("err", `a transfer home of ${sent} USDT landed but its booking was refused: ${booking.why}`);
    return { proceed: true, settled: "refused" };
  } catch (e) {
    return { proceed: false, settled: null, why: e instanceof Error ? e.message : String(e) };
  }
}
