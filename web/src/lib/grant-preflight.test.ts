import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { decodeFunctionData, type Hex, type LocalAccount } from "viem";
import { KernelV3_3AccountAbi } from "@zerodev/sdk";
import { buildCallPermissions, firstEnableEnvelope, wallShape } from "@agentcap/core";
import {
  TRENCHER_FACTORY,
  TEST_CAPS, withStubChain, type KernelState,
} from "./canonical-wall-fixture";

const ACCOUNT = "0x000000000000000000000000000000000000a110" as const;
const ownerKey = `0x${"17".repeat(32)}` as Hex;
const options = { caps: TEST_CAPS, chainId: 56, expectAccount: ACCOUNT, onStatus: () => {} };

function ownerThatMustNotSign() {
  let calls = 0;
  const refuse = async (): Promise<never> => { calls++; throw new Error("preflight requested an owner signature"); };
  const owner: LocalAccount = {
    ...privateKeyToAccount(ownerKey),
    signMessage: refuse,
    signTypedData: refuse,
    signTransaction: refuse,
  };
  return { owner, calls: () => calls };
}

describe("read-only grant renewal preflight", () => {
  it("checks the real SDK wall without signing, storage, auth, handoff or a nonce read", async () => {
    const { preflightAgentGrant } = await import("./session");
    const signer = ownerThatMustNotSign();
    const priorStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    let storageCalls = 0;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() {
      storageCalls++;
      throw new Error("preflight touched browser storage");
    } });
    try {
      // All app fetches are rejected by the fixture. An unreadable nonce must
      // not matter: preflight is not allowed to prepare an enable signature.
      const result = await withStubChain(ACCOUNT, () => preflightAgentGrant(signer.owner, options), {
        currentNonce: "unreadable", installedNonce: "unreadable",
      });
      assert.equal(result, undefined, "no cached grant or signature crosses revocation");
      assert.equal(signer.calls(), 0);
      assert.equal(storageCalls, 0);
    } finally {
      if (priorStorage) Object.defineProperty(globalThis, "localStorage", priorStorage);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  it("still refuses a wall past the maximum, and says how many coins fit", async () => {
    // The 14M ceiling did not move; the wall got smaller (the removed routes,
    // and no official listings on BNB Chain yet). This account is deployed, so
    // it carries eleven coins beside Trencher and not twelve; thirteen are over
    // it, and the owner is told the number.
    const { preflightAgentGrant } = await import("./session");
    const signer = ownerThatMustNotSign();
    const extraTokens = Array.from({ length: 13 }, (_, i) => ({
      symbol: `TEST${i}`, address: `0x${(100 + i).toString(16).padStart(40, "0")}` as Hex, decimals: 18,
    }));
    await withStubChain(ACCOUNT, async () => {
      await assert.rejects(preflightAgentGrant(signer.owner, {
        ...options, extraTokens, trencherFactory: TRENCHER_FACTORY,
      }), error => {
        assert.ok(error instanceof Error);
        // The 14,000,000 maximum, less room for the operation that installs
        // the key (core first-enable-gas.ts KEY_INSTALL_RESERVE_BOUNDED).
        assert.match(error.message, /against a limit of 13,850,000 \(14,000,000, less room for the operation that installs it\)/);
        assert.match(error.message, /the most that fits with the features you have enabled is 11\. Remove at least 2 custom tokens/);
        return true;
      });
    }, { currentNonce: 8 });
    assert.equal(signer.calls(), 0);
  });

  it("refuses a different derived owner account before asking for a signature", async () => {
    const { preflightAgentGrant } = await import("./session");
    const signer = ownerThatMustNotSign();
    await withStubChain(ACCOUNT, () => assert.rejects(preflightAgentGrant(signer.owner, {
      ...options, expectAccount: "0x000000000000000000000000000000000000b110",
    }), /refusing to sign: this owner derives/));
    assert.equal(signer.calls(), 0);
  });

  it("signs only the fresh generation after preflight and confirmed revocation", async () => {
    const { preflightAgentGrant, prepareAgentGrant } = await import("./session");
    const original = privateKeyToAccount(ownerKey);
    const signed: { nonce: number; signature: Hex }[] = [];
    const owner: LocalAccount = { ...original, async signTypedData(data) {
      const signature = await original.signTypedData(data);
      signed.push({ nonce: (data.message as { nonce: number }).nonce, signature });
      return signature;
    } };
    const kernel: KernelState = { currentNonce: 8, installedNonce: 0 };
    await withStubChain(ACCOUNT, async () => {
      await preflightAgentGrant(owner, options);
      assert.equal(signed.length, 0);
      // Model the already-confirmed invalidateNonce receipt, then invoke the
      // real signer afresh. No account/signature from preflight is reused.
      kernel.currentNonce = 9;
      const grant = await prepareAgentGrant(owner, options);
      assert.equal(signed.length, 1);
      assert.equal(signed[0]!.nonce, 9);
      const serialized = JSON.parse(Buffer.from(grant.serialized, "base64").toString("utf8"));
      assert.equal(serialized.enableSignature, signed[0]!.signature);
    }, kernel);
  });

  it("pins renewed signing reads to one head and carries the confirmed revocation cutoff", async () => {
    const { prepareAgentGrant } = await import("./session");
    const original = privateKeyToAccount(ownerKey);
    const signed: number[] = [];
    const owner: LocalAccount = { ...original, async signTypedData(data) {
      signed.push((data.message as { nonce: number }).nonce);
      return original.signTypedData(data);
    } };
    const reads: NonNullable<KernelState["reads"]> = [];
    await withStubChain(ACCOUNT, () => prepareAgentGrant(owner, { ...options, minimumValidationNonce: 9 }), {
      currentNonce: 9, installedNonce: 0, validNonceFrom: 9, blockNumber: 100n, reads,
    });
    assert.deepEqual(signed, [9]);
    const nonceReads = reads.filter(({ method, params }) => {
      if (method !== "eth_call") return false;
      const { to, data } = params[0] as { to: string; data: Hex };
      if (to.toLowerCase() !== ACCOUNT.toLowerCase()) return false;
      try {
        return ["currentNonce", "validationConfig", "validNonceFrom"].includes(decodeFunctionData({ abi: KernelV3_3AccountAbi, data }).functionName);
      } catch { return false; }
    });
    assert.equal(nonceReads.length, 3);
    assert.ok(nonceReads.every(({ params }) => params[1] === "0x64"), "every nonce read uses the same block");
    assert.ok(reads.some(({ method, params }) => method === "eth_getCode" && String(params[0]).toLowerCase() === ACCOUNT.toLowerCase() && params[1] === "0x64"));
  });

  it("does not sign when a later renewal read is older than the confirmed revocation", async () => {
    const { prepareAgentGrant } = await import("./session");
    for (const kernel of [
      { currentNonce: 8, validNonceFrom: 8 },
      { currentNonce: 9, validNonceFrom: 8 },
      { currentNonce: 8, validNonceFrom: 9 },
      { currentNonce: 9, validNonceFrom: 9, undeployed: true },
    ] satisfies KernelState[]) {
      const signer = ownerThatMustNotSign();
      await withStubChain(ACCOUNT, () => assert.rejects(prepareAgentGrant(signer.owner, {
        ...options, minimumValidationNonce: 9,
      }), /not caught up with the confirmed revocation.*Nothing was signed/), kernel);
      assert.equal(signer.calls(), 0);
    }
  });

  it("rejects an invalid or unbound revocation cutoff before requesting a signature", async () => {
    const { prepareAgentGrant } = await import("./session");
    const signer = ownerThatMustNotSign();
    for (const minimumValidationNonce of [-1, 0, 1, 1.5, NaN, Infinity, 0x1_0000_0000]) {
      await assert.rejects(prepareAgentGrant(signer.owner, { ...options, minimumValidationNonce }), /confirmed revocation boundary/);
    }
    await assert.rejects(prepareAgentGrant(signer.owner, { ...options, expectAccount: undefined, minimumValidationNonce: 2 }), /confirmed revocation boundary/);
    assert.equal(signer.calls(), 0);
  });
});

describe("the renewal preflight decides perps exactly as the mint will", () => {
  const KEY = `0x${"1a".repeat(40)}` as `0x${string}`;
  const carried = {
    // A grant signed on Lighter's own chain: the only place a key was ever sealed.
    smartAccount: ACCOUNT, chainId: 4663, grantFeatures: ["tradeable-v2", "perp-lighter-v1"],
    perp: { route: "perp-lighter-v1", apiKeyIndex: 16, apiPublicKey: KEY },
  };
  it("a carried Lighter key is refused on BNB Chain BEFORE revocation, with no signature and no storage", async () => {
    const { preflightAgentGrant, PerpSigningRefusal } = await import("./session");
    const signer = ownerThatMustNotSign();
    await withStubChain(ACCOUNT, () => assert.rejects(
      preflightAgentGrant(signer.owner, { ...options, previousGrant: carried }),
      (e: unknown) => e instanceof PerpSigningRefusal && e.code === "perp-off-mainnet",
    ), { currentNonce: 8 });
    assert.equal(signer.calls(), 0);
  });
  it("given ONE browser snapshot, the preflight and the mint reach the same verdict", async () => {
    // The renewal case the preflight exists for: the server answers that it
    // holds no grant (a kill, a wiped row) while this browser still holds the
    // armed grant that carries a Lighter key. The preflight is storage-free, so
    // the snapshot rides in the options BOTH calls get. Before it did, the
    // preflight passed and the mint refused, after the old permission had
    // already been revoked.
    const { preflightAgentGrant, restoreAgentWallet, PerpSigningRefusal } = await import("./session");
    const shared = { ...options, previousGrant: null, localGrants: { current: carried } };
    const signer = ownerThatMustNotSign();
    const refused = (e: unknown) => e instanceof PerpSigningRefusal && e.code === "perp-off-mainnet";
    await withStubChain(ACCOUNT, () => assert.rejects(preflightAgentGrant(signer.owner, shared), refused), { currentNonce: 8 });
    assert.equal(signer.calls(), 0);
    // The mint decides from the snapshot it is handed: this browser's store is
    // EMPTY, so a mint that read storage instead would carry no key and could
    // not refuse for it.
    const priorStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() {
      return { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 };
    } });
    try {
      await withStubChain(ACCOUNT, () => assert.rejects(restoreAgentWallet(ownerKey, shared), refused), { currentNonce: 8 });
    } finally {
      if (priorStorage) Object.defineProperty(globalThis, "localStorage", priorStorage);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
});
