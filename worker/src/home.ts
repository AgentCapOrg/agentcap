/**
 * ~/.agentcap — the user's home for everything that is THEIRS: settings,
 * grant, ledger, heartbeat, and their strategies. The install location
 * (npm global dir or a checkout) is disposable; upgrades and reinstalls
 * never touch user data. Override with AGENTCAP_HOME for tests/multi-agent.
 *
 * THE SINGLE DEFINITION. The web tier imports this exact module via the
 * `@agentcap/home` tsconfig alias — there is no second copy under web/src/lib.
 * There used to be, and it had drifted: it lacked the telegram/virtuals/paused/
 * scratch paths and mkdir'd eagerly on every agentcapHome() call. Two copies of
 * "where the grant lives" means the web tier can read a path the worker never
 * wrote, which under multi-tenant hosting strands a funded account. So both
 * sides derive every path from the one map below.
 *
 * Legacy migration: early versions kept data in <repo>/.data. If that exists
 * and the home file doesn't, files are copied over once, so nothing is lost.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isGrantPurpose, type GrantPurpose } from "../../packages/core/src/grant";

export function agentcapHome(): string {
  return process.env.AGENTCAP_HOME ?? path.join(os.homedir(), ".agentcap");
}

/**
 * A wallet's own home on a self-hosted install. Spot's is the home itself,
 * where grant.json has always been. A Perps wallet's is `accounts/perps`
 * inside it: a complete home of its own (grant.json, its archive, its pause
 * marker, later its settings and ledger), so nothing it writes can land in a
 * Spot file. No default, like the stores: a caller names the wallet it means.
 */
export function purposeHome(wallet: GrantPurpose): string {
  if (!isGrantPurpose(wallet)) throw new Error("Unrecognised wallet purpose");
  return wallet === "perps" ? path.join(agentcapHome(), "accounts", "perps") : agentcapHome();
}

export const homePaths = {
  settings: () => path.join(agentcapHome(), "settings.json"),
  grant: () => path.join(agentcapHome(), "grant.json"),
  heartbeat: () => path.join(agentcapHome(), "heartbeat.json"),
  db: () => path.join(agentcapHome(), "agentcap.db"),
  strategies: () => path.join(agentcapHome(), "strategies"),
  /** Telegram runtime state: update offset, link code, owner id. */
  telegram: () => path.join(agentcapHome(), "telegram.json"),
  /** Virtuals Terminal streamer cursor: last-streamed trade id + last report date. */
  virtuals: () => path.join(agentcapHome(), "virtuals.json"),
  /** Pause marker — present = trading halted (toggled from Telegram/dashboard). */
  paused: () => path.join(agentcapHome(), "paused"),
  /** Scratch dir for transient PC-control artifacts (screenshots, voice notes). */
  scratch: () => path.join(agentcapHome(), "scratch"),
  /**
   * Where a grant is kept BEFORE anything destroys it.
   *
   * grant.json is single-slot, and for a grant that has never been replaced it
   * is the only on-disk copy of the owner key — the key that `agentcap recover`
   * needs to sweep funds out of a smart account. The CLI and the web API both
   * archive here before deleting; the worker had no such path at all, so its
   * own kill switch was the one destructive route with no copy taken.
   */
  grantsArchive: () => path.join(agentcapHome(), "grants"),
};

let ensured = false;

/** Create the home tree and migrate legacy <repo>/.data files once. */
export function ensureHome(): string {
  const home = agentcapHome();
  if (ensured) return home;
  mkdirSync(home, { recursive: true });
  mkdirSync(homePaths.strategies(), { recursive: true });
  mkdirSync(homePaths.scratch(), { recursive: true });

  // Legacy checkout layouts: worker ran with cwd=worker/ (../.data) or cwd=root (.data).
  for (const legacyDir of [path.join(process.cwd(), "..", ".data"), path.join(process.cwd(), ".data")]) {
    if (!existsSync(legacyDir)) continue;
    for (const name of ["settings.json", "grant.json", "agentcap.db", "heartbeat.json"]) {
      const from = path.join(legacyDir, name);
      const to = path.join(home, name);
      if (existsSync(from) && !existsSync(to)) {
        try {
          copyFileSync(from, to);
          console.log(`[home] migrated legacy ${name} → ${to}`);
        } catch {
          // best-effort; the worst case is starting fresh
        }
      }
    }
  }
  ensured = true;
  return home;
}

/**
 * What the pause marker holds when a KILL set it. A kill that could not archive
 * the owner key keeps grant.json — deleting it would lose that key for good —
 * and pauses instead (Telegram /kill, the web kill switch, `agentcap kill`, which
 * keeps its own copy of this sentence). A marker holding anything else is a
 * pause somebody asked for, and nothing here touches it.
 */
export const KILL_PAUSE_NOTE = "paused by a kill that could not archive the owner key, so it kept the grant";

/**
 * Pause for a kill that kept the grant. A pause already in place — the owner's,
 * or an earlier kill's — is left exactly as it is. Returns whether trading is
 * paused now. `home` is another wallet's home (purposeHome); the default is
 * this process's own.
 */
export function pauseForKeptGrant(home?: string): boolean {
  const file = home === undefined ? homePaths.paused() : path.join(home, "paused");
  if (existsSync(file)) return true;
  try {
    writeFileSync(file, KILL_PAUSE_NOTE, "utf8");
    return true;
  } catch {
    return existsSync(file);
  }
}

/**
 * After a kill that DID go through: lift the pause a refused kill left, and
 * only that one. Otherwise it outlived the grant it stood in for, and the next
 * grant armed paused with nothing saying why.
 */
export function liftKillPause(home?: string): void {
  const file = home === undefined ? homePaths.paused() : path.join(home, "paused");
  try {
    if (readFileSync(file, "utf8") === KILL_PAUSE_NOTE) rmSync(file, { force: true });
  } catch {
    /* no marker, or unreadable: leave it */
  }
}
