"use client";

import { useEffect, useState } from "react";
import { toHex } from "viem";
import { findInjectedProvider, requestAccount } from "@/lib/wallet";
import { RecoverPanel } from "@/components/RecoverPanel";
import { loadGrant, type GrantPermissionView } from "@/lib/session";
import { X } from "lucide-react";
import { PrivySignIn } from "@/terminal/PrivySignIn";
import { announceSignedIn } from "@/lib/resign-anchor";
import { privyEnabled } from "@/lib/privy-client";
import { blockerAdvice } from "@/lib/live-blocker";
import { RISK_LEVELS, RISK_PROFILES, levelOf, type RiskLevel } from "@agentcap/core";
import { usd } from "@/lib/format";
import type { GrantBalances } from "@/lib/grant-balances";
import { requestJson } from "./request-json";
import { SkeletonRows } from "./Skeleton";
import type { ReadState } from "./live";
import type { FleetRecoveryView } from "../../../worker/src/fleet-recovery";
import { RecoveryNotice } from "./RecoveryNotice";
import { pausedRecovery, recoveryFunds } from "./recovery-view";
import { GloamFunding } from "./GloamFunding";
import { GloamWithdrawal } from "./GloamWithdrawal";
import { DepositWays } from "./DepositWays";
import type { OwnBookRead, StoppedOwner } from "./owner-state";
import { StoppedAgentCard } from "./StoppedAgent";

export interface AccountState {
  session: {hosted: boolean; address: string | null};
  /**
   * `mode` is the published rail, and it is the THREE the worker publishes —
   * not `string`. It was widened here and the widening reached `autonomyOf`,
   * which switches on it: a fourth value would have fallen out of every arm as
   * "idle" and rendered a blocked agent as merely quiet.
   *
   * `balances` is the CHAIN's answer (a multicall in /api/grants), and it is
   * the only figure that may decide whether real money exists. The book's cash
   * is the simulated balance in paper mode, which is the whole confusion. Each
   * field is null when that read failed — never "0", which is an empty account.
   */
  /**
   * `workerAliveAt` and `grant.grantedAt` travel together for ONE comparison:
   * whether the blocker on this row was resolved against a key the owner has
   * since replaced. Both were already on the wire from /api/grants and were
   * simply not declared here, so the shell could not see them.
   *
   * They come from the same response but not the same source — `grantedAt` from
   * the grant store the POST writes synchronously, `workerAliveAt` from the
   * mirrored `agents` row that also carries `liveBlocker`. That pairing is what
   * makes the comparison sound: the blocker and the beat are the same row.
   */
  status: {exists: boolean; /** Authenticated tenant bound to hosted /api/grants responses. */ tenant?: string | null; /** Hosted, with `exists` false: the record is held, stopped for a renewal (grants/route.ts AgentStatus). */ stored?: true; recovery?: FleetRecoveryView | null; mode?: "paper" | "live" | "idle" | null; liveBlocker?: string | null; workerAliveAt?: number | null; workerStale?: boolean | null; heartbeatUnread?: true; gasSponsored?: boolean | null; balances?: GrantBalances; grant?: GrantPermissionView & {smartAccount: string; chainId:number; caps:{perTradeUsdg:number; dailyUsdg:number}}};
}
// Moved to its own module so it can be executed in a test; re-exported so no import moves.
export { requestJson } from "./request-json";
/**
 * WHICH SIGN-IN THE DEPLOYMENT OFFERS.
 *
 * Inlined at build time by Next. Present means Privy is configured, and X is
 * the primary route; absent means this deployment falls back to the injected
 * wallet login exactly as before. One flag, one fork, and the legacy path is
 * never removed — it is what an existing owner still uses to prove possession
 * of their tenant before linking a DID to it.
 */
export const PRIVY_BETA = privyEnabled();

export function SignIn({onDone}:{onDone:()=>void}) {
  // Announced as well as reported: a screen that loaded signed-out (the grant
  // page, reached from a "Sign now" link) reloads as the owner — see
  // resign-anchor.ts.
  const done=()=>{announceSignedIn();onDone();};
  if (PRIVY_BETA) return <PrivySignIn onDone={done}/>;
  return <WalletSignIn onDone={done}/>;
}

/** The original injected-wallet login. Still the ONLY way an existing owner proves their tenant. */
export function WalletSignIn({onDone}:{onDone:()=>void}) {
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  async function signIn() {
    setBusy(true);setError("");
    try {
      const provider=findInjectedProvider();
      if (!provider) throw new Error("Open this page in your wallet’s browser, or enable your browser wallet.");
      const address=await requestAccount(provider);
      const challenge=await requestJson<{nonce:string;message:string}>("/api/auth/challenge");
      const signature=await provider.request({method:"personal_sign",params:[toHex(challenge.message),address]});
      await requestJson("/api/auth/verify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({nonce:challenge.nonce,signature})});
      onDone();
    } catch(e) {setError(e instanceof Error ? e.message : "Sign-in failed. Try again.");}
    finally {setBusy(false);}
  }
  return <div className="hosted-auth"><button className="flow-primary" disabled={busy} onClick={()=>void signIn()}>{busy ? "Waiting for wallet…" : "Sign in with wallet"}</button>{error && <p role="alert" className="flow-error">{error}</p>}</div>;
}
/**
 * WHERE THE OWNER'S OWN AGENT WOULD BE, before there is one to show.
 *
 * THREE ANSWERS PER READ, NOT ONE. `account` is null both while the first read
 * is in flight and after it failed, and both said "Loading your account…" — so
 * a failed read said loading for ever, with nothing to press. And an owner whose
 * book was still in flight was told "Your portfolio data is not available yet",
 * a verdict about a request that had not answered. Loading draws a skeleton,
 * which claims nothing; failed says so and offers Try again; only a read that
 * succeeded may say what it found.
 *
 * `portfolio` is `live.reads.mine` — the feed read that carries the book.
 *
 * `retrying` is a pass already running. The failure stays true until a read
 * succeeds, so without it "We couldn't load your account" stood unchanged
 * through the retry the reader had just asked for, and Try again looked broken.
 *
 * A STOPPED AGENT IS NOT "YOUR AGENT STARTS HERE" (owner-state.ts): `stoppedAgent`
 * says so, with the owner's own value (`stoppedBook`) and the way back, and
 * `checking` claims neither while the read that tells them apart is out.
 */
export function AccountEntry({account,accountFailed=false,portfolio="ok",retrying=false,onRefresh,onSignedIn,stoppedAgent=null,stoppedBook,checking=false}:{account:AccountState|null;accountFailed?:boolean;portfolio?:ReadState;retrying?:boolean;onRefresh:()=>void;onSignedIn:()=>void;stoppedAgent?:StoppedOwner|null;stoppedBook?:OwnBookRead;checking?:boolean}) {
  if(account?.status.exists) {
    if (pausedRecovery(account.status.recovery)) return <section className="hosted-entry"><h2>Your agent</h2><RecoveryNotice recovery={account.status.recovery} funds={recoveryFunds(account.status)}/><RetryButton retrying={retrying} onRetry={onRefresh}/></section>;
    if(portfolio==="unread") return <section className="hosted-entry"><h2>Your agent</h2><SkeletonRows rows={2} label="Loading your portfolio"/></section>;
    if(portfolio==="unreadable") return <section className="hosted-entry"><h2>Your agent</h2><p role="status">{retrying ? "Trying to load your portfolio again…" : <>We couldn&apos;t load your portfolio. It will retry on its own.</>}</p><RetryButton retrying={retrying} onRetry={onRefresh}/></section>;
    return <section className="hosted-entry"><h2>Your agent</h2><p>Your portfolio data is not available yet.</p><button className="flow-primary" onClick={onRefresh}>Refresh portfolio</button></section>;
  }
  if(!account || (accountFailed && !account.status.exists)) return accountFailed
    ? <section className="hosted-entry"><h2>Your agent</h2><p role="status">{retrying ? "Trying to load your account again…" : <>We couldn&apos;t load your account. It will retry on its own.</>}</p><RetryButton retrying={retrying} onRetry={onRefresh}/></section>
    : <section className="hosted-entry"><SkeletonRows rows={2} label="Loading your account"/></section>;
  if(stoppedAgent) return <StoppedAgentCard stopped={stoppedAgent} book={stoppedBook}/>;
  if(checking) return <section className="hosted-entry"><SkeletonRows rows={2} label="Loading your account"/></section>;
  return <section className="hosted-entry"><h2>Your agent starts here</h2><p>Create an agent to manage your portfolio and follow its trades here.</p>{account.session.hosted && !account.session.address ? <SignIn onDone={onSignedIn}/> : <a className="flow-primary" href="/create">Create an agent</a>}</section>;
}
export function FundingPanel({mode,account,onClose}:{mode:"deposit"|"withdraw";account:AccountState;onClose:()=>void}) {
  const [ownerKey]=useState(()=>{const grant=loadGrant("spot");return grant?.smartAccount.toLowerCase()===account.status.grant?.smartAccount.toLowerCase() ? grant?.demoOwnerPrivateKey ?? "" : "";});
  const grant=account.status.grant;
  return <section className="hosted-funding"><header className="flow-top"><span>{mode==="deposit" ? "Add money" : "Withdraw"}</span><button aria-label="Close funding" onClick={onClose}><X size={18}/></button></header>{mode==="withdraw" ? <>{grant && <GloamWithdrawal account={grant.smartAccount as `0x${string}`} chainId={grant.chainId} ownerKey={ownerKey ? ownerKey as `0x${string}` : undefined}/>}<RecoverPanel initialOwnerKey={ownerKey}/></> : grant ? <>
    {/* THE ADDRESS FIRST. This panel used to open with a paragraph about
        stuck funds, then blocker advice, and only then the one thing a person
        came here to do. Now it is the
        address and its copy button, the network warning in the same breath
        right under it, anything this agent is actually short of, and the
        other ways in folded away. Nothing was removed. */}
    <h2>Add money</h2>
    {(() => {
      // WHEN MONEY IS NOT THE FIX, THAT COMES FIRST. A recovery hold, or a
      // blocker that USDG cannot clear (a dead policy, the wrong network, real
      // trading switched off), is said above the address and its copy button,
      // because of what was measured after the fleet stopped being killed
      // mid-tick: no-gas 12, wrong-chain 9, dead-policy 6, no-cash 2. Twelve
      // owners sent USDG exactly as told and got no trades, because the thing
      // missing was ETH for fees. The verdict is the child's
      // (`AgentStatus.liveBlocker`, resolved every tick); this only says what
      // to do about it. Where money IS the fix (no ETH, no USDG) the advice
      // sits just under the address it refers to.
      const held = pausedRecovery(account.status.recovery);
      const advice = blockerAdvice(account?.status.liveBlocker);
      const first = held
        ? <RecoveryNotice recovery={account.status.recovery} funds={recoveryFunds(account.status)}/>
        : advice && !advice.funding ? <p className="fund-blocker not-money" role="status">{advice.say}</p> : null;
      const after = !held && advice?.funding ? <p className="fund-blocker" role="status">{advice.say}</p> : null;
      return <>
        {first}
        <p className="fund-lead">Add dollars (USDG) to your agentcapavatar&apos;s account: send USDG, or convert ETH or SOL on the way in. You can withdraw any time.</p>
        {/* The address, its QR code and copy button, and the network warning
            are the Send USDG way, which is what shows first. ETH and SOL
            price through Relay and are signed on relay.link (DepositWays). */}
        <DepositWays agent={grant.smartAccount} chainId={grant.chainId} balances={account.status.balances}
          gasSponsored={account.status.gasSponsored} ownerAddress={account.session.address}/>
        {after}
      </>;
    })()}
    <details className="fund-more"><summary>More ways to add money</summary>{!pausedRecovery(account.status.recovery) && <GloamFunding address={grant.smartAccount} chainId={grant.chainId}/>}<a className="flow-secondary" href="/grant">Wallet setup and funding details</a></details>
  </> : <a href="/grant">Set up an agent wallet</a>}</section>;
}

/**
 * HOW MUCH RISK, AS ONE QUESTION.
 *
 * From the beta: "would it be helpful for beginners to have risk level bar or
 * options rather than setting trade limit or trades per day". Right — nobody
 * arriving here has a view on 300 basis points of price impact. They have a
 * view on how much they mind losing money, and this turns that into the six
 * settings dials that follow from it.
 *
 * THE TWO CAPS BELOW ARE NOT AMONG THEM, and the panel says so rather than
 * quietly stopping at the boundary. `perTradeUsdg` and `dailyUsdg` live in the
 * signature and are enforced on-chain; no settings write can move them, which
 * is exactly why they are the limits worth having.
 */
function RiskBar({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState<RiskLevel | null>(null);
  const [busy, setBusy] = useState<RiskLevel | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<RiskLevel | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((s: { values?: Record<string, unknown> } | null) => {
        // `levelOf` returns null for a hand-tuned book, and null is rendered as
        // nothing selected — never rounded to the nearest level, or opening this
        // screen and touching nothing would move five dials on the next save.
        if (alive) setCurrent(levelOf((s?.values ?? {}) as never));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const choose = async (level: RiskLevel) => {
    setBusy(level); setError(""); setSaved(null);
    try {
      const put = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(RISK_PROFILES[level].settings),
      });
      if (!put.ok) {
        const j = (await put.json().catch(() => null)) as { errors?: string[] } | null;
        throw new Error(j?.errors?.join(" ") ?? `that was refused (${put.status})`);
      }
      setCurrent(level); setSaved(level); onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="risk-bar">
      <h3>How much risk?</h3>
      <div className="risk-options" role="group" aria-label="Risk level">
        {RISK_LEVELS.map((l) => (
          <button
            key={l}
            type="button"
            className={`risk-option${current === l ? " on" : ""}`}
            aria-pressed={current === l}
            disabled={busy !== null}
            onClick={() => choose(l)}
          >
            <b>{RISK_PROFILES[l].name}</b>
            <span>{RISK_PROFILES[l].blurb}</span>
          </button>
        ))}
      </div>
      {current === null && !saved && (
        <p className="risk-note">Your dials are set by hand right now — picking a level replaces them.</p>
      )}
      {saved && <p className="risk-note" role="status">Saved. {RISK_PROFILES[saved].blurb}</p>}
      {error && <p className="risk-note" role="alert">{error}</p>}
      {/* NAMED, NOT WRITTEN. See risk-level.ts. */}
      <p className="risk-note">
        This sets how I size and when I sell. The two caps below are sealed into my key and only a
        new signature can change them.
      </p>
    </div>
  );
}

export function LimitsPanel({account,onClose}:{account:AccountState|null;onClose:()=>void}) {
  const caps=account?.status.grant?.caps;
  return <section className="hosted-entry money-flow"><header className="flow-top"><h2>Trading limits</h2><button aria-label="Close limits" onClick={onClose}><X size={18}/></button></header><RiskBar onDone={()=>{}}/><dl className="fund-breakdown"><div><dt>Per trade</dt><dd>{caps ? usd(caps.perTradeUsdg) : "—"}</dd></div><div><dt>Per day</dt><dd>{caps ? usd(caps.dailyUsdg) : "—"}</dd></div></dl><p>Changing these limits requires a new signature for your agent’s trading permission.</p><a className="flow-primary" href="/grant">Edit signed limits</a><a className="flow-secondary" href="/settings">Strategy and account settings</a></section>;
}

/** Try again — and, while that retry is running, a button that says so and cannot be pressed twice. */
export function RetryButton({retrying,onRetry}:{retrying:boolean;onRetry:()=>void}) {
  return <button className="flow-primary" onClick={onRetry} disabled={retrying}>{retrying ? "Trying again…" : "Try again"}</button>;
}
