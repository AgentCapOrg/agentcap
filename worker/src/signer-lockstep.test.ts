import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * TWO SIGNERS, ONE WALL — pinned as source, because signer orchestration has
 * no seams to test through.
 *
 * The failure family this guards is the repo's oldest scar, three times over:
 * a marker minted without its permission (the transfer saga — 24 days of
 * grants claiming a capability the wall never emitted), a permission granted
 * without its marker (the exactInput reverts — routes quoted, submitted, and
 * refused on-chain every tick), and two signers drifting until the phone and
 * the dashboard sealed different walls under the same name.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const WEB = readFileSync(`${HERE}../../web/src/lib/session.ts`, "utf8");
const MOBILE = readFileSync(`${HERE}../../mobile/src/crypto/signGrant.ts`, "utf8");

test("neither signer can seal a removed route", () => {
  for (const [name, src] of [
    ["web/src/lib/session.ts", WEB],
    ["mobile/src/crypto/signGrant.ts", MOBILE],
  ] as const) {
    assert.doesNotMatch(src, /allowUniswapV4|allowRialto|v4AdapterAddress|GRANT_V4|PERMIT2_ABI|ponsAdapterAddress|ponsClassVault|energyBuy|GRANT_PONS|GRANT_ENERGY/, name);
  }
});

test("both signers seal the platform's official coins, so a listing is reachable", () => {
  // The token list is baked into the call policy at SIGNING time. A listing the
  // worker watches, prices and treats as a tradable leg, but which no signer
  // seals, produces refusals naming a coin the owner never chose and cannot
  // remove — the worst version of this failure, because the owner has no action
  // available to them.
  //
  // Pinned in BOTH signers for the same reason every rule in this file is: the
  // phone is a separate seam with no /settings fetch, and it has already been
  // the one that silently carried nothing.
  for (const [name, src] of [
    ["web/src/lib/session.ts", WEB],
    ["mobile/src/crypto/signGrant.ts", MOBILE],
  ] as const) {
    assert.ok(src.includes("officialCoinTokens"), `${name} must merge the official listings`);
    // Listings FIRST, so usableExtraTokens' de-duplication keeps the verified
    // address when an owner has separately typed the same coin in by hand.
    assert.match(
      src,
      /\[\s*\.\.\.officialCoinTokens\([^)]*\)\s*,\s*\.\.\.\(?\s*(args\.)?extraTokens/,
      `${name} must put official listings BEFORE the owner's own tokens`,
    );
    // And the merged list — not the raw parameter — is what reaches the policy.
    const merged = /const\s+(sealedTokens)\b/.exec(src);
    assert.ok(merged, `${name} must name the merged token list`);
    assert.match(
      src,
      new RegExp(`grantTokens:\\s*usableExtraTokens\\(${merged[1]}\\)`),
      `${name} must record the MERGED list as covered, or the grant and the wall disagree`,
    );
    assert.match(
      src,
      new RegExp(`extraTokens:\\s*${merged[1]}`),
      `${name} must build the wall from the MERGED list`,
    );
  }
});

test("a class route is never implied by another venue's opt-in", () => {
  // THREE venues, three decisions. Class is the one that most invites being
  // folded into Pons — it trades the same curves — and folding it in would give
  // every bonding-curve grant a custodial contract holding its positions,
  // without the owner ever choosing that.
  for (const [name, src] of [
    ["web/src/lib/session.ts", WEB],
    ["mobile/src/crypto/signGrant.ts", MOBILE],
  ] as const) {
    assert.ok(
      !/ponsAdapterAddress\s*\?\s*\[[^\]]*GRANT_PONS_CLASS/.test(src),
      `${name} must not mint the class marker off the Pons adapter address`,
    );
    assert.ok(
      !/ponsClassVaultAddress\s*\?\s*\[[^\]]*GRANT_PONS_ADAPTER/.test(src),
      `${name} must not mint the Pons adapter marker off the class vault`,
    );
  }
});

test("both signers seal the SCOPED wall and mint its marker from the same field", () => {
  // GRANT_SCOPED_SPENDERS tells the server's byte comparison and the executor's
  // first-enable sizing which wall shape was signed. A signer that scoped the
  // wall without the marker would be refused by the server (it rebuilds the
  // unscoped wall); one that minted the marker over an unscoped wall would be
  // refused too, and sized wrong by the executor. One field decides both.
  for (const [name, src] of [
    ["web/src/lib/session.ts", WEB],
    ["mobile/src/crypto/signGrant.ts", MOBILE],
  ] as const) {
    // Always on Spot. The web signer's Perps wall names no Spot spender to
    // scope, so it carries neither the shape nor the marker (the server
    // refuses a Perps grant that declares it): the field is the purpose test.
    assert.match(src, /scopedSpenders:\s*(?:true as boolean|purpose === "spot")/, `${name} must seal the scoped wall`);
    assert.match(
      src,
      /wallOpts\.scopedSpenders\s*\?\s*\[GRANT_SCOPED_SPENDERS\]\s*:\s*\[\]/,
      `${name} must mint GRANT_SCOPED_SPENDERS from the field that scoped the wall`,
    );
    assert.equal([...src.matchAll(/\[GRANT_SCOPED_SPENDERS\]/g)].length, 1, `${name} must mint it in exactly one place`);
  }
});

test("both signers seal perps, mint its marker and write grant.perp from ONE value", () => {
  // The lockstep rule a sixth time, for the permission whose miss costs most.
  // `perp-lighter-v1` is three things that must describe one decision: the
  // wall option (proxy in the USDG approve, deposit, changePubKey pinned to one
  // key, the claim), the marker the worker reads, and `grant.perp` — the key
  // the worker loads and the server joins to its private half. A marker over a
  // wall without the key registration is an onboarding the chain refuses; a
  // block naming a key the wall did not pin is a key that can never register;
  // a wall with the permission and no marker is a key the worker never arms.
  //
  // And ONE ORDER: perps are decided (and fit-checked) after the deployment
  // read and before the wall is checked and sealed. When they do not fit they
  // are REFUSED, never dropped.
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  for (const [name, raw] of [
    ["web/src/lib/session.ts", WEB],
    ["mobile/src/crypto/signGrant.ts", MOBILE],
  ] as const) {
    const src = strip(raw);

    // IN THE ONE LITERAL, from a value built with the ROUTE'S key index.
    const literal = /const wallOpts = \{([\s\S]*?)\};/.exec(src);
    assert.ok(literal, `${name} must collect its wall options in one literal`);
    assert.match(literal[1]!, /\bperpLighter\b/, `${name} must put perpLighter into the wallOpts literal`);
    assert.match(
      src,
      /const perpLighter = [^;]*\{\s*apiKeyIndex:\s*LIGHTER_ROUTE_V1\.apiKeyIndex,\s*apiPublicKey:/,
      `${name} must seal the route's key index, never a stored or caller-supplied one`,
    );
    assert.equal(
      (src.match(/wallOpts\.perpLighter\s*=(?!=)/g) ?? []).length,
      0,
      `${name} must never reassign wallOpts.perpLighter after the literal — one decision, one wall`,
    );

    // FIT-CHECKED, BY REFUSAL, over the real deployment state and its own options.
    assert.match(
      src,
      /if\s*\(\s*wallOpts\.perpLighter\s*&&\s*!perpFits\([^;]*!alreadyDeployed[^;]*wallOpts\)\s*\)\s*\{?\s*throw/,
      `${name} must REFUSE (throw) when perps do not fit — never drop them`,
    );

    // THE MARKER, from that same value, in exactly one place.
    assert.match(
      src,
      /wallOpts\.perpLighter\s*\?\s*\[GRANT_PERP_LIGHTER\]\s*:\s*\[\]/,
      `${name} must mint GRANT_PERP_LIGHTER only from wallOpts.perpLighter`,
    );
    assert.equal((src.match(/\[GRANT_PERP_LIGHTER\]/g) ?? []).length, 1, `${name} must mint GRANT_PERP_LIGHTER in exactly one place`);
    assert.ok(/import\s*\{[^}]*\bGRANT_PERP_LIGHTER\b[^}]*\}\s*from\s*"@agentcap\/core"/.test(src), `${name} must import the marker from core`);

    // THE BLOCK, from that same value: the public key LOWERCASED (the bytes the
    // wall pinned), the value's own index, and no private key of any kind.
    const at = src.search(/wallOpts\.perpLighter\s*\?\s*\{\s*perp:\s*\{/);
    assert.ok(at >= 0, `${name} must write grant.perp only under wallOpts.perpLighter`);
    const block = src.slice(at, at + 600);
    assert.match(block, /route:\s*GRANT_PERP_LIGHTER/, `${name}: grant.perp names the route`);
    assert.match(block, /apiKeyIndex:\s*wallOpts\.perpLighter\.apiKeyIndex/, `${name}: grant.perp's index is the sealed one`);
    assert.match(
      block,
      /apiPublicKey:\s*wallOpts\.perpLighter\.apiPublicKey\.toLowerCase\(\)/,
      `${name} must persist the sealed public key, lowercased`,
    );
    assert.equal((src.match(/route:\s*GRANT_PERP_LIGHTER/g) ?? []).length, 1, `${name} must write grant.perp in exactly one place`);
    assert.doesNotMatch(src, /apiPrivateKey/, `${name} must never handle a Lighter private key — signers see the public half only`);

    // ORDER: deployment read → perps decided and fit-checked → signable → sealed.
    const deployedAt = src.indexOf("alreadyDeployed = code");
    const perpAt = src.indexOf("const perpLighter =");
    const fitAt = src.indexOf("!perpFits(");
    const signableAt = src.indexOf("wallSignable(");
    const sealedAt = src.indexOf("buildWallPolicies(");
    for (const [what, i] of [["deploy", deployedAt], ["perp", perpAt], ["fit", fitAt], ["signable", signableAt], ["seal", sealedAt]] as const) {
      assert.ok(i >= 0, `${name}: the scan must find the ${what} site`);
    }
    assert.ok(deployedAt < perpAt, `${name} must read the deployment state BEFORE deciding perps`);
    assert.ok(perpAt < fitAt && fitAt < signableAt, `${name} must settle perps before the wall is checked`);
    assert.ok(signableAt < sealedAt, `${name} must decide both before the wall is checked and sealed`);
  }
});

test("the phone carries perps forward and nothing else: no opt-in, no drop", () => {
  // The dashboard is where perps are turned on (a keygen call and a consent)
  // and where they are turned off (a flat-venue check). The phone only mirrors
  // carry-forward, so a phone re-sign can never be the path that strands a
  // live Lighter account without its key — and cannot seal a new one either.
  const src = MOBILE.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  assert.doesNotMatch(src, /\/api\/perps\/keygen|perpDrop|venueFlat/, "the phone offers no perps opt-in and no drop");
  assert.doesNotMatch(src, /args\.perp\b/, "the phone takes no new perps key from its caller");
  assert.match(src, /readGrant\(/, "the phone reads its own stored grant, so no caller can forget to carry the key");
});

/**
 * Comments out, code kept. The prose in these files names every marker and
 * entry point freely, so a scan of the raw text would count the explanation
 * as the thing explained. A `//` right after a colon is a URL scheme, not a
 * comment, and eating it would take the rest of that line of code with it.
 */
const code = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

/** The marker identifiers inside the one `<opener> [ ... ]` literal, in order. */
function markersIn(src: string, opener: RegExp, name: string): string[] {
  const found = [...src.matchAll(opener)];
  assert.equal(found.length, 1, `${name} must build this marker list in exactly one literal`);
  const open = found[0]!.index! + found[0]![0].length - 1;
  let depth = 0;
  let close = open;
  for (; close < src.length; close++) {
    if (src[close] === "[") depth++;
    else if (src[close] === "]" && --depth === 0) break;
  }
  assert.ok(close < src.length, `${name}: the marker list must close`);
  return [...src.slice(open + 1, close).matchAll(/\b(GRANT_[A-Z0-9_]+|TRADEABLE_V2)\b/g)].map((m) => m[1]!);
}

/**
 * A top-level function, from its declaration to the column-0 brace that closes
 * it. Found by layout rather than by counting braces: a parameter typed
 * `0x${string}` opens a brace that is not the body's.
 */
function topLevelFunction(src: string, fn: string): string {
  const decl = new RegExp(`^(?:export )?(?:async )?function ${fn}\\b`, "m").exec(src);
  assert.ok(decl, `session.ts must still declare ${fn}`);
  const end = src.indexOf("\n}", decl.index);
  assert.ok(end > decl.index, `${fn} must close`);
  return src.slice(decl.index, end + 2);
}

/** Which top-level function the code at `at` sits inside, or null. */
function enclosingFunction(src: string, at: number): string | null {
  const last = [...src.matchAll(/^(?:export )?(?:async )?function (\w+)/gm)].filter((m) => m.index! < at).at(-1);
  if (!last) return null;
  return at < src.indexOf("\n}", last.index!) ? last[1]! : null;
}

/** A call, not the declaration of the thing called. */
const isCall = (src: string, at: number) => !/function\s+$/.test(src.slice(Math.max(0, at - 20), at));

test("both signers list their markers in ONE order, and perps come last", () => {
  // The order carries no meaning to the worker — it reads the list as a set —
  // and that is exactly why it is pinned. Two lists kept in the same order
  // differ only where the signers really differ (the phone offers no Trencher),
  // so a marker added to one signer and not the other is a visible break here
  // instead of a grant one signer mints and the other silently never does.
  //
  // GRANT_PERP_LIGHTER goes on the END, after everything main already mints: a
  // perps grant is main's list plus one trailing entry, nothing main lists
  // moved, and a bare grant is main's list exactly — its spread yields nothing.
  const WEB_ORDER = [
    "GRANT_TRENCHER",
    "TRADEABLE_V2",
    "GRANT_SCOPED_SPENDERS",
    "GRANT_PERP_LIGHTER",
  ];
  const web = markersIn(code(WEB), /grantFeatures:\s*\[/g, "web/src/lib/session.ts");
  const mobile = markersIn(code(MOBILE), /grantFeatures:\s*\[/g, "mobile/src/crypto/signGrant.ts");
  assert.deepEqual(web, WEB_ORDER, "web/src/lib/session.ts mints its markers in the pinned order");
  assert.deepEqual(
    mobile,
    WEB_ORDER.filter((m) => m !== "GRANT_TRENCHER"),
    "mobile/src/crypto/signGrant.ts mints the web's markers, in the web's order, less the Trencher it does not offer",
  );
});

test("the server accepts exactly the markers the dashboard can mint, perps appended", () => {
  // CANONICAL_GRANT_FEATURES is the allowlist POST /api/grants checks. A marker
  // a signer can mint and the list lacks is a fresh grant refused at handoff
  // ("declares features the AgentCap wall does not grant"); one the list has
  // and no signer mints is a route nothing could ever have sealed.
  const CANONICAL = code(readFileSync(`${HERE}../../web/src/lib/canonical-wall.ts`, "utf8"));
  const listed = markersIn(CANONICAL, /CANONICAL_GRANT_FEATURES:\s*readonly string\[\]\s*=\s*\[/g, "web/src/lib/canonical-wall.ts");
  // Main's list, untouched and in main's order, with perps appended — so the
  // perps diff to the allowlist is one added line and nothing main accepts
  // changed position or meaning.
  assert.deepEqual(listed, [
    "TRADEABLE_V2",
    "GRANT_TRENCHER",
    "GRANT_SCOPED_SPENDERS",
    "GRANT_PERP_LIGHTER",
  ]);
  assert.deepEqual(listed.slice(-2), ["GRANT_SCOPED_SPENDERS", "GRANT_PERP_LIGHTER"], "perps are appended after main's last marker");

  const minted = markersIn(code(WEB), /grantFeatures:\s*\[/g, "web/src/lib/session.ts");
  assert.deepEqual([...minted].sort(), [...listed].sort(), "the server's allowlist and the dashboard's mint are one set");
});

test("every signer entry point forwards the perps fields through perpInput(o)", () => {
  // perpInput exists so a new entry point cannot thread three of the perps
  // fields and forget the fourth — and the field it is most likely to forget
  // is the drop guard. An entry point that skips it entirely is worse: its
  // re-sign carries no previous grant, so a live Lighter key is silently left
  // out of the new wall while the account at the venue still holds positions.
  //
  // So every caller of the preparation core (prepareGrantCore directly, or
  // mintGrant, which wraps it with the browser's stored copies) is found by
  // scanning, and each must hand perpInput(o) to it as its last argument. A
  // new entry point fails the set comparison until it is added here, which is
  // the moment to check it forwards perps like the rest.
  const src = code(WEB);
  const ENTRY_POINTS = [
    "preflightAgentGrant",
    "prepareAgentGrant",
    "createAgentWallet",
    "createPrivyOwnedWallet",
    "restoreAgentWallet",
  ];
  const callers = new Set<string>();
  for (const m of src.matchAll(/\b(prepareGrantCore|mintGrant)\(/g)) {
    if (!isCall(src, m.index!)) continue;
    const fn = enclosingFunction(src, m.index!);
    assert.ok(fn, `a call to ${m[1]} at offset ${m.index} sits outside any top-level function`);
    // mintGrant's own call to the core is the wrapper, not an entry point.
    if (fn !== "mintGrant") callers.add(fn);
  }
  assert.deepEqual([...callers].sort(), [...ENTRY_POINTS].sort(), "the entry points into the signer are exactly these");
  assert.equal(
    (src.match(/\bperpInput\(o\)/g) ?? []).length,
    ENTRY_POINTS.length,
    "perpInput(o) is forwarded once per entry point, and nowhere else",
  );
  for (const fn of ENTRY_POINTS) {
    const body = topLevelFunction(src, fn);
    assert.match(body, /\b(prepareGrantCore|mintGrant)\(/, `${fn}: the scan must find its call into the core`);
    assert.equal((body.match(/\bperpInput\(o\)/g) ?? []).length, 1, `${fn} must forward perpInput(o) exactly once`);
    assert.match(body, /\bperpInput\(o\),?\s*\)/, `${fn} must hand perpInput(o) to the core as its last argument`);
  }
});

test("the renewal preflight decides perps without touching browser storage", () => {
  // The preflight runs BEFORE the old key is revoked, so it must make the same
  // perps decision the mint will — and grant-preflight.test.ts runs it with a
  // localStorage that throws on any touch. The browser's stored grants are read
  // in one place, localGrantsSnapshot, called by mintGrant; the preflight gets
  // the previous grant from its caller instead. Calling either here would turn
  // a storage-free check into one that throws in an embedded wallet, or
  // quietly decides against a different previous grant than the mint is given.
  const src = code(WEB);
  for (const fn of ["preflightAgentGrant", "prepareAgentGrant"]) {
    // prepareAgentGrant promises the same in its docstring: its callers (the
    // iOS engine, a partner's server) hand over the previous grant themselves.
    const body = topLevelFunction(src, fn);
    assert.doesNotMatch(body, /\blocalGrantsSnapshot\b/, `${fn} must not read the browser's stored grants`);
    assert.doesNotMatch(body, /\bmintGrant\(/, `${fn} must not go through mintGrant, which reads them`);
    assert.doesNotMatch(body, /\blocalStorage\b/, `${fn} must not touch browser storage`);
  }
  // One wallet's grants since perps slice 5b (localGrantsSnapshot(wallet)),
  // still read in exactly one place.
  const reads = [...src.matchAll(/\blocalGrantsSnapshot\(/g)].filter((m) => isCall(src, m.index!));
  assert.equal(reads.length, 1, "the browser's stored grants are read in exactly one place");
  assert.equal(enclosingFunction(src, reads[0]!.index!), "mintGrant", "and that place is mintGrant");
});
