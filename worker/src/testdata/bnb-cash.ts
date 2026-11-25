/**
 * The recorded receipts in this directory are Robinhood Chain's, where cash was
 * USDG at six decimals. A test that reads them as BNB Chain books moves those
 * logs to USDT's address and restates their amounts at eighteen, so every
 * figure in the books is the one the recording shows.
 */
import { CASH } from "../../../packages/core/src/index";

const RECORDED_CASH = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";

/** A recorded six-decimal figure in USDT base units. */
export const usdt = (micro: bigint): bigint => micro * 10n ** 12n;

type Log = [address: string, topics: string[], data: string, logIndex: string];

export function bnbCashLog<L extends Log>(log: L): L {
  const [address, topics, data, logIndex] = log;
  if (address.toLowerCase() !== RECORDED_CASH) return log;
  const topic = topics[0]?.toLowerCase();
  // An unlimited approval stays as recorded: it is not an amount.
  const restated = (topic === TRANSFER || topic === APPROVAL) && BigInt(data) < 1n << 128n
    ? `0x${usdt(BigInt(data)).toString(16).padStart(64, "0")}`
    : data;
  return [CASH.USDT.toLowerCase(), topics, restated, logIndex] as L;
}

export const bnbCashTx = <T extends { logs: Log[]; to?: string | null }>(tx: T): T => ({
  ...tx,
  ...(tx.to?.toLowerCase() === RECORDED_CASH ? { to: CASH.USDT.toLowerCase() } : {}),
  logs: tx.logs.map((l) => bnbCashLog(l)),
});
