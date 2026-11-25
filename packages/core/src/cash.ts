/**
 * CASH SCALE. BNB Chain USDT counts in 18 decimals, and every spot "usdg"
 * bigint in this repo is in those base units. This file is the only place the
 * conversion to and from human or micro figures is written.
 *
 * ROUNDING IS PART OF THE CONTRACT:
 *   - a balance, value or cap shown or stored as a number truncates toward zero
 *     to a millionth of a USDT, so it is never overstated;
 *   - money counted AGAINST a limit rounds away from zero (cashSpendNumber), so
 *     recorded spend can never come out under what moved.
 *
 * A number holds micro-USDT exactly up to about 9e9 USDT. Base units do not fit
 * in a number or in a 64-bit integer column (int64 ends near 9.2 USDT): raw
 * amounts are bigint in memory and TEXT at rest.
 *
 * Perps keep their own 6dp micro units and never pass through here.
 */
import { CASH_DECIMALS } from "./tokens";

/** One whole USDT in base units. */
export const CASH_UNIT = 10n ** BigInt(CASH_DECIMALS);
/** Base units in one millionth of a USDT. */
export const CASH_PER_MICRO = CASH_UNIT / 1_000_000n;
/** One cent in base units. */
export const CASH_CENT = CASH_UNIT / 100n;

/** Micro-USDT to base units. Exact. */
export const cashFromMicro = (micro: bigint): bigint => micro * CASH_PER_MICRO;

/** Base units to micro-USDT, truncated toward zero. */
export const cashToMicro = (raw: bigint): bigint => raw / CASH_PER_MICRO;

/** Base units to micro-USDT, rounded away from zero. For money counted against a limit. */
export function cashToMicroUp(raw: bigint): bigint {
  const q = raw / CASH_PER_MICRO;
  return raw % CASH_PER_MICRO === 0n ? q : q + (raw > 0n ? 1n : -1n);
}

/** Base units to a human number, truncated toward zero at a millionth. */
export const cashNumber = (raw: bigint): number => Number(cashToMicro(raw)) / 1e6;

/** As cashNumber, rounded away from zero: a recorded spend. */
export const cashSpendNumber = (raw: bigint): number => Number(cashToMicroUp(raw)) / 1e6;

/** A human figure to base units, rounded DOWN to a millionth: a ceiling that never grows. */
export function cashFloorUnits(value: number): bigint {
  const micro = Math.floor(value * 1e6);
  if (!Number.isSafeInteger(micro)) throw new RangeError("USDT amount is not representable");
  return cashFromMicro(BigInt(micro));
}

/** Base units as an exact six-decimal string, truncated toward zero. */
export function formatCash6(raw: bigint): string {
  const neg = raw < 0n;
  const micro = cashToMicro(neg ? -raw : raw);
  return `${neg && micro !== 0n ? "-" : ""}${micro / 1_000_000n}.${(micro % 1_000_000n).toString().padStart(6, "0")}`;
}

/**
 * A difference under a millionth of a USDT: below what the book records, so it
 * is not a movement. On-chain USDT carries 18 places and dust is routine.
 */
export const isSubMicro = (raw: bigint): boolean => raw > -CASH_PER_MICRO && raw < CASH_PER_MICRO;

/** TrencherVault.PER_BUY and DAILY_BUYS, in base units: exactly $5 and $25. */
export const TRENCHER_PER_BUY_UNITS = 5n * CASH_UNIT;
export const TRENCHER_DAILY_UNITS = 25n * CASH_UNIT;
