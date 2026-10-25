# GGBP-1 / Ghost Gate integration handoff

**Status: proposed, disabled-by-default L1 wallet capability.** This is a handoff for review,
not an instruction to expose a key, seed, mask, generic signature, or transaction builder to a
dApp. No proof from this proposal authorizes access until independent cryptographic and
trusted-chain verification is implemented.

## Base reviewed

- Repository: `https://github.com/chironbuilds/tari-l1-wallet-ui`
- Base revision: `f8fcedc79b8272c952c15627c1fba10f6bcec969`
- Review branch: `codex/ggbp1-wallet-handoff`
- Network target: Esmeralda Minotari L1 only (network byte and genesis hash are both mandatory)

## Why a new wallet-owned operation is needed

The existing app keeps L1 `WasmWalletOutput` handles in the in-memory map in
`src/store.tsx`; normal send and burn flows pass those handles to `WasmTxBuilder` or
`WasmBurnBuilder`. The public bindings in `vendor/tari-l1-wasm/tari_l1_wasm.d.ts` also expose
generic `WasmSchnorrSignature`, key export, commitments, and output values. Those are **not** a
dApp proof API and must not be used for GGBP-1.

The existing iframe bridge (`src/lib/dappBridge.ts`, `src/components/DappFrame.tsx`) already
checks exact origin/source and displays wallet-chrome approval. That is the right user-consent
model to extend, but it currently describes the Ootle `window.tari` API, not Minotari output
authority. A GGBP-1 method must remain distinct from every transaction, burn, Ootle ownership
proof, and generic-signing method.

## Proposed public capability and call

Until the Rust/WASM implementation exists, the wallet must report this capability as `false`:

```ts
interface WalletCapabilities {
  // Existing fields omitted.
  ggbp1BalanceProof: false | {
    protocolVersion: 2;
    network: "esmeralda";
    maxOutputs: 16;
    maxProofBytes: 8192;
  };
}

type Ggbp1Request = {
  protocol: "ggbp1";
  version: 2;
  // Exact canonical binary challenge supplied by Ghost Gate, URL-safe base64 without padding.
  challenge: string;
};

type Ggbp1Response = {
  protocol: "ggbp1";
  version: 2;
  // Exact canonical `GGBP1R` binary response, URL-safe base64 without padding.
  response: string;
};

await window.tari.request({ method: "tari_requestBalanceProof", params: request });
```

The transport envelope is intentionally tiny: the canonical binary payload is the protocol.
There are no dApp-selected output IDs, callback URLs, scripts, keys, masks, values, proof
options, or boolean approval fields. A wallet without the feature rejects the method as
unsupported; Ghost Gate must not fall back to an Ootle proof, wallet-address signature, a browser
balance, or a synthetic response.

## Canonical GGBP-1 v2 fixture compatibility

Ghost Gate's current **synthetic-only** v2 fixture defines a fixed-width challenge whose selected
output hashes are appended in strict ascending order to its canonical message:

```text
"GGBP1" || 0x02 || network:u8 || genesis:32 || origin_hash:32 || gate_id:16 ||
gate_configuration_version:le-u64 || subject_id:16 || subject_authentication_public_key:32 ||
threshold_micro_xtm:le-u64 || nonce:32 || expires_at:le-u64 || generator_fingerprint:32 ||
output_count:u8 || output_hashes:32*
```

The response is `"GGBP1R" || 0x02 || challenge fields || output_count ||` ordered output records
`|| subject signature || aggregate commitment || proof_length:le-u16 || aggregate proof`. Its
maximum is 16 outputs and 8192 aggregate-proof bytes. Version 1 is refused because it did not bind
the full selected-output records. The current source of truth is Ghost Gate's
`crates/ghost-gate-minotari/src/ggbp1.rs` (`Ggbp1Challenge` and `Ggbp1WireProof`).

This is a compatibility target and a synthetic test-vector grammar, **not a claim that the current
Web TU WASM can produce a valid Esmeralda response**. The upstream review must freeze the request
encoding and confirm the exact Tari dependency/proof compatibility before exposing the capability.

## Wallet-owned sequence

1. Accept the request only from the currently framed exact HTTPS origin; canonicalize it and compare
   its hash with the challenge's `origin_hash`.
2. Reject if disconnected, backgrounded, expired, malformed, wrong network/genesis, zero threshold,
   duplicate/non-canonical output list, unsupported wire version, or request size limit violation.
3. Read current wallet-owned outputs internally. Select at most 16 confirmed, mature, unspent,
   unencumbered outputs with supported script/features and checked total arithmetic. Reserve them
   atomically under a short lease separate from transaction encumbrance.
4. Show a foreground wallet-owned approval view: origin, Esmeralda + genesis fingerprint, gate,
   subject, threshold, expiry, selected public output references/count, and a request fingerprint.
   It must state that the operation sends, burns, locks, and exports nothing.
5. On approval, re-check lease, output state, maturity, chain tip/canonicality, and all bindings;
   derive output authority and aggregate witness only inside reviewed Rust/WASM code.
6. Produce only the bounded canonical response. Release the lease on rejection, expiry, error, or
   cancellation. Never persist an approval token or grant a reusable signing authority.

## Required wallet-internal contract

The public JS layer needs one high-level call only. The Rust/WASM side needs a non-exporting
internal boundary equivalent to:

```rust
authenticate_ggbp1_request(frame_origin, canonical_request) -> AuthenticatedGgbp1Request
prepare_ggbp1_proof(request, trusted_chain_view) -> ApprovalPreview
approve_and_create_ggbp1_proof(prepared, foreground_decision) -> CanonicalGgbp1Response
```

It must use a GGBP-1-specific output-authority domain, not a transaction, script, node-identity,
or generic message-signature domain. Aggregate opening material, private keys, seeds, view keys,
and masks remain wholly inside the wallet.

## File-level implementation plan

| Area | Files | Required change |
| --- | --- | --- |
| Capability/transport | `src/lib/dappBridge.ts`, `public/tari-connector.js`, `docs/dapp-api.md` | Add `ggbp1BalanceProof: false` now; enable and add `tari_requestBalanceProof` only with the reviewed backend. |
| Origin and foreground approval | `src/components/DappFrame.tsx`, `src/lib/dappRequests.ts` | Reuse exact-origin/source checks and wallet-chrome queue; do not reuse transaction submission. |
| L1 output ownership/reservation | `src/store.tsx` plus a new L1-owned reservation module | Keep handles and selected outputs internal; lease/revalidate rather than call `addInput` or mutate send state. |
| WASM boundary | `vendor/tari-l1-wasm` source and generated bindings | Add one constrained operation; do not export raw keys, mask material, or a generic GGBP signer. |
| Ghost Gate adapter | Ghost Gate's capability/proof verifier | Feature-detect; enforce issued challenge/session/network/genesis binding; parse bounded response; obtain independent chain evidence; reject synthetic source for live authorization. |

## Test vectors and acceptance tests

The initial shared suite should carry these deterministic fixture cases from Ghost Gate, marked
synthetic throughout:

- **Positive:** two ordered outputs (45 + 55 micro-tXTM) prove threshold 100; canonical wire
  response parses and independently verifies.
- **Negative:** threshold 101, zero threshold, v1 response, trailing byte, malformed length,
  output count 0 or 17, duplicate/out-of-order hashes, changed origin/network/genesis/gate/subject/
  nonce/expiry/generator fingerprint, expired challenge, rejected foreground approval, and changed
  output state after approval.
- **Reservation:** two simultaneous requests cannot reserve the same output; reject/cancel/expiry
  releases it; restart recovery does not retain an approval.
- **Boundary:** no wallet API returns seed, private key, view key, mask, opening, generic signature,
  arbitrary script, or unsigned/signed transaction.

Reference fixture tests: `ggbp1.rs::canonical_wire_response_round_trips_without_witness_material`,
`ggbp1.rs::aggregate_proof_is_verified_against_the_sum_of_public_commitments`, and
`ggbp1_wallet_adapter.rs::wallet_owned_approval_returns_only_a_bound_verifiable_response`.

## Evidence required before any live disposable-wallet test

1. A reviewed implementation matching the frozen v2 grammar and dependency compatibility.
2. Exact Esmeralda genesis/network validation, authenticated canonical tip, output inclusion,
   supported-script validation, maturity/confirmation rules, and unspent-state checks by an
   independent verifier.
3. Passing positive and adversarial vectors in both implementations; synthetic fixtures remain
   non-authorizing.
4. A user-operated, explicit foreground approval from a disposable Esmeralda wallet.

Until all four are complete, the honest result is `UnavailableUpstreamProofApi`; no L1 access
session may be issued.

## Local validation after implementation

```powershell
npm ci
npm run typecheck
npm run build
```

Add focused unit tests for the parser, origin binding, approval cancellation, reservation, and
feature detection before a live test. Do not use a real wallet key, export, transaction, burn, or
network submission as part of this handoff.
