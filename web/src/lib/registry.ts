// Wallet-signed write path for the mandate registry.
//
// register_mandate is #[payable] and requires ≥ 0.01 NEAR attached. It is
// signed by the user's connected wallet (near-wallet-selector) and records
// their mandate under their own account. Read helpers live in near.ts
// (live.myMandate / live.registeredCount).

import { REGISTRY_ID } from "./near";
import type {
  FunctionCallAction,
  SignedTxOutcome,
} from "@/components/wallet/WalletProvider";

// 30 TGas — ample for a single storage write.
const REGISTER_GAS = BigInt("30000000000000");
// 0.01 NEAR, the contract's minimum attached deposit.
const REGISTER_DEPOSIT = BigInt("10000000000000000000000");

export interface RegisterMandateArgs {
  mandate_json: string;
  label: string;
}

// The signer surface we need from the wallet provider.
type Signer = (opts: {
  receiverId: string;
  actions: FunctionCallAction[];
}) => Promise<SignedTxOutcome>;

export interface RegisterResult {
  hash: string | null;
  outcome: SignedTxOutcome;
}

// Sign + send register_mandate with the connected wallet. Resolves with the
// final tx hash (for an explorer link); rejects on user-rejection / RPC error.
export async function registerMandate(
  signAndSendTransaction: Signer,
  _accountId: string,
  { mandate_json, label }: RegisterMandateArgs
): Promise<RegisterResult> {
  // NAJ action (what wallet-selector v10 expects); args are JSON-encoded by near-api-js.
  const { transactions } = await import("near-api-js");
  const outcome = await signAndSendTransaction({
    receiverId: REGISTRY_ID,
    actions: [
      transactions.functionCall(
        "register_mandate",
        { mandate_json, label },
        REGISTER_GAS as never,
        REGISTER_DEPOSIT as never,
      ),
    ],
  });

  const hash =
    outcome?.transaction?.hash ??
    outcome?.transaction_outcome?.id ??
    null;
  return { hash, outcome };
}

// NEAR testnet explorer link for a transaction hash (nearblocks is the live one).
export function txExplorerUrl(hash: string): string {
  return `https://testnet.nearblocks.io/txns/${hash}`;
}
