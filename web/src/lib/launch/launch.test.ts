// Run: pnpm test   (node:test via tsx; `react-server` condition lets server-only modules load)
import test from "node:test";
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";
import {
  assembleSignedTx, deriveEvmAddress, parseMpcSignature, recoverAddress, unsignedPayload, VAULT_PATH,
  type VaultEvmTx,
} from "./evm";
import { buildReport, canonicalJson, deviationBps, sha256Hex, unavailableReport, type CrossChainTemplate } from "./guardian";
import { liveLegs, SLICE_USDC, MPC_ROOT_KEY } from "./engine";

// ---- evm ----
test("unsignedPayload matches the Rust known-answer vector (contracts/vault/src/evm.rs)", () => {
  const tx: VaultEvmTx = {
    to: "0x1111111111111111111111111111111111111111", chain_id: 11155111, nonce: 0,
    max_priority_fee_per_gas: "1000000000", max_fee_per_gas: "20000000000", gas_limit: 100000,
    data: "0x617ba037", value: "0",
  };
  assert.equal(unsignedPayload(tx), "dd9c9192c0c310eddd20b2eaa00bc243f9b22d19fb134256c9f621d5ead798e3");
});

test("MPC address derivation reproduces the already-mined proof address", () => {
  const a = deriveEvmAddress(MPC_ROOT_KEY, "demo.vaults.mandate-arthur.testnet", VAULT_PATH).address;
  assert.equal(a, "0x3919100a2079a5447f2514baf6abc81e15d179d7");
});

test("signature round trip: recovered address == signer, low-s enforced, raw tx is type-2", () => {
  const priv = secp256k1.utils.randomPrivateKey();
  const address = "0x" + bytesToHex(keccak_256(secp256k1.getPublicKey(priv, false).slice(1)).slice(12));
  const tx: VaultEvmTx = {
    to: "0x000000000000000000000000000000000000dEaD", chain_id: 11155111, nonce: 3,
    max_priority_fee_per_gas: "1000000000", max_fee_per_gas: "3000000000", gas_limit: 60000,
    data: "0x617ba037", value: "0",
  };
  const payload = unsignedPayload(tx);
  const s = secp256k1.sign(payload, priv, { lowS: false });
  // Present it in the MPC response shape, with a HIGH s to exercise normalisation.
  const highS = secp256k1.CURVE.n - s.s;
  const flipped = s.addRecoveryBit(s.recovery!).s > secp256k1.CURVE.n / 2n ? s.s : highS;
  const rec = flipped === s.s ? s.recovery! : s.recovery! ^ 1;
  const raw = JSON.stringify({
    scheme: "Secp256k1",
    big_r: { affine_point: (rec % 2 ? "03" : "02") + s.r.toString(16).padStart(64, "0") },
    s: { scalar: flipped.toString(16).padStart(64, "0") },
    recovery_id: rec,
  });
  const sig = parseMpcSignature(raw);
  assert.equal(recoverAddress(payload, sig), address);
  const signed = assembleSignedTx(tx, sig);
  assert.ok(signed.startsWith("0x02"));
  // legacy ["Ok", {...}] wrapper is accepted too
  assert.equal(parseMpcSignature(JSON.stringify(["Ok", JSON.parse(raw)])).recoveryId, rec);
});

test("parseMpcSignature rejects garbage", () => {
  assert.throws(() => parseMpcSignature(JSON.stringify({ nope: 1 })));
});

// ---- guardian ----
const T: CrossChainTemplate = {
  kind: "AllocateCrossChain", chain: "ethereum-sepolia", protocol: "morpho-sepolia",
  market: "0x000000000000000000000000000000000000dEaD", amount: "10000000", max_slippage_bps: 50,
};
const facts = (o: Partial<{ price_usdc: number; observed_slippage_bps: number; protocol_paused: boolean }> = {}) => ({
  price_usdc: 999_766, price_block: 12_135_610, observed_slippage_bps: 0, protocol_paused: false, sources: [], ...o,
});

test("guardian approves a clean market", () => {
  const r = buildReport("a1", T, facts());
  assert.equal(r.approve, true);
  assert.deepEqual(r.reason_codes, ["PRICE_OK", "SLIPPAGE_OK", "PROTOCOL_LIVE", "CROSSCHAIN_STATE_OK"]);
});
test("guardian refuses a depeg, paused market and high slippage", () => {
  assert.equal(deviationBps(1_020_000), 200);
  const depeg = buildReport("a1", T, facts({ price_usdc: 1_020_000 }));
  assert.equal(depeg.approve, false);
  assert.ok(depeg.reason_codes.includes("DEPEG"));
  assert.ok(buildReport("a1", T, facts({ protocol_paused: true })).reason_codes.includes("PROTOCOL_PAUSED"));
  // template ceiling (50) is tighter than the global guard (100)
  const slip = buildReport("a1", T, facts({ observed_slippage_bps: 60 }));
  assert.equal(slip.approve, false);
  assert.ok(slip.reason_codes.includes("SLIPPAGE_HIGH"));
});
test("fail closed when facts are unavailable", () => {
  const r = unavailableReport("a1");
  assert.equal(r.approve, false);
  assert.deepEqual(r.reason_codes, ["DATA_UNAVAILABLE"]);
});
test("canonical JSON sorts keys deeply; commit is sha256 of exactly that string", () => {
  const c = canonicalJson({ b: 1, a: { z: 2, y: [{ d: 1, c: 2 }] } });
  assert.equal(c, '{"a":{"y":[{"c":2,"d":1}],"z":2},"b":1}');
  assert.equal(sha256Hex(c), sha256Hex('{"a":{"y":[{"c":2,"d":1}],"z":2},"b":1}'));
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
test("report JSON has the fields the coordinator parses (approve, facts.*)", () => {
  const o = JSON.parse(canonicalJson(buildReport("v:a1", T, facts())));
  assert.equal(typeof o.approve, "boolean");
  assert.equal(typeof o.facts.price_usdc, "string"); // tally_facts parses string or int
  assert.equal(typeof o.facts.observed_slippage_bps, "number");
  assert.equal(typeof o.facts.protocol_paused, "boolean");
});

// ---- engine mapping ----
test("liveLegs splits the 20 USDC slice by weight over live venues only", () => {
  const l = liveLegs({ Rhea: 60, Morpho: 40, Lombard: 99 });
  assert.equal(l.rhea + l.morpho, SLICE_USDC);
  assert.equal(l.rhea, 12_000_000n);
  assert.equal(l.morpho, 8_000_000n);
});
test("liveLegs: no live venue => nothing to execute", () => {
  const l = liveLegs({ Aave: 50, Lombard: 50 });
  assert.equal(l.rhea, 0n);
  assert.equal(l.morpho, 0n);
});
test("liveLegs: a single live venue takes the whole slice", () => {
  assert.equal(liveLegs({ Rhea: 10 }).rhea, SLICE_USDC);
  assert.equal(liveLegs({ "Morpho (Base)": 5 }).morpho, SLICE_USDC);
});
