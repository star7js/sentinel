# Sentinel Policy Engine — Technical Specification (v0.1)

## 1. Overview

The policy engine is a pure, deterministic function:

```
evaluate(request: TxRequest, effects: SimulatedEffects | null, policy: Policy, state: SessionState)
  → Verdict { decision: ALLOW | BLOCK | ESCALATE, reasons: RuleResult[] }
```

Design constraints:

- **Pure and synchronous.** No I/O inside evaluation. Simulation and threat intel run *before* evaluation and feed in as inputs. This makes the engine trivially testable and auditable.
- **Deny-unknown-by-default is configurable, deny-on-error is not.** If simulation fails or a rule throws, the verdict is ESCALATE, never ALLOW.
- **Effects over intent.** When simulated effects are available, rules evaluate against effects (what the tx *does*), falling back to calldata decoding only when simulation is unavailable.

## 2. Data model

```ts
interface TxRequest {
  chainId: number;
  from: Address;
  to: Address | null;          // null = contract creation
  value: bigint;               // wei
  data: Hex;
  nonce?: number;
  authorizationList?: Eip7702Authorization[];  // 7702 delegations are first-class
}

interface SimulatedEffects {
  balanceDiffs: { address: Address; token: Address | 'native'; delta: bigint }[];
  approvals: { token: Address; spender: Address; amount: bigint }[];   // amount = 2^256-1 → infinite
  approvalsForAll: { token: Address; operator: Address; approved: boolean }[]; // ERC-721/1155 setApprovalForAll
  delegations: { authority: Address; delegate: Address }[];           // EIP-7702
  contractsTouched: Address[];
  reverted: boolean;
}

interface SessionState {
  sessionStart: number;         // unix seconds
  spentBySession: bigint;       // native, wei, cumulative ALLOWed value
  spentByToken: Map<Address, bigint>;
  txCount: number;
}
```

## 3. Policy schema

Policies are YAML/JSON, versioned with a `schemaVersion` field. Example:

```yaml
schemaVersion: 1
defaults:
  unknownContract: escalate     # allow | block | escalate
  onSimulationFailure: escalate # block | escalate (allow is invalid)
  contractCreation: escalate    # block | escalate (allow is invalid); applies when to === null

chains:
  allowed: [8453]               # Base only for v1

contracts:
  allow:
    - address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"  # USDC on Base
      label: usdc
  block: []

spend:
  perTx:
    native: "0.05 ether"
    erc20:
      usdc: "250"
  perSession:
    native: "0.2 ether"
    erc20:
      usdc: "1000"
  sessionDuration: 3600         # seconds

approvals:
  maxAmount:
    usdc: "500"
  infinite: block               # infinite approvals always blocked

delegations:                     # EIP-7702
  allow: []                      # empty = all delegations escalate
  default: escalate

time:
  activeHours: null              # or { start: "09:00", end: "18:00", tz: "UTC" }

escalation:
  channel: webhook               # webhook | telegram | stdin (dev)
  timeoutSeconds: 300
  onTimeout: block
```

Amount strings are parsed with token decimals resolved at load time (decimals fetched once and pinned in the compiled policy, not at eval time).

## 4. Rule pipeline

Rules run in fixed order; **first BLOCK wins immediately; ESCALATE accumulates; ALLOW requires all rules to pass.**

1. `chain-allowed` — chainId in policy.chains.allowed
2. `intel-blocklist` — `to` and all `contractsTouched` absent from threat feeds (feed data injected as input)
3. `contract-allowlist` — every touched contract allowed, or handled per `defaults.unknownContract`
4. `contract-creation` — `to === null` handled per `defaults.contractCreation` (block/escalate; never silently allowed)
5. `revert-check` — simulated tx must not revert (revert → BLOCK; agents retrying reverts is a known failure/attack amplifier)
6. `spend-per-tx` — net negative balance diffs on `from` within per-tx caps (native and per-token)
7. `spend-per-session` — cumulative including this tx within session caps
8. `approval-limits` — every approval in effects within `approvals.maxAmount`; infinite approvals per `approvals.infinite`
9. `operator-approvals` — `setApprovalForAll` grants (ERC-721/1155 collection-wide operator control) treated like infinite approvals, per `approvals.infinite`; revocations allowed
10. `delegation-check` — any 7702 authorization or delegation effect must match `delegations.allow`
11. `time-window` — current time (in `activeHours.tz`) within the window if set; outside → BLOCK; overnight windows (start > end) wrap midnight; an invalid tz escalates

Evaluation takes an optional `nowMs` parameter (default `Date.now()`) so time-dependent rules stay deterministic under test.

Each rule returns `{ ruleId, decision, humanSummary }`. `humanSummary` is mandatory: it is what the escalation message shows the human (e.g. "This transaction grants unlimited USDC spending to 0xabc… (unrecognized contract)").

## 5. Session accounting

- Session state is updated **only after a tx is signed and broadcast**, not at ALLOW time, to avoid counting txs the caller drops.
- Sessions roll over after `sessionDuration`; state resets.
- State persistence is pluggable (in-memory default; JSON file adapter shipped) so the library has zero required infra.

## 6. Failure semantics

| Condition | Verdict |
|---|---|
| Rule throws | ESCALATE (with error attached) |
| Simulation unavailable | per `defaults.onSimulationFailure` |
| Policy fails schema validation at load | refuse to start |
| Escalation channel unreachable | `onTimeout` behavior applies immediately |

## 7. Signature guarding (v0.2)

EIP-712 typed data is a drain path that never produces a transaction from the
victim: a signed permit is redeemed by the attacker at their own expense.
`evaluateTypedData(request, policy, intel)` closes it by decoding known
shapes into the §2 effects model and reusing the §4 pipeline verbatim:

- **Decoded shapes**: ERC-2612 `Permit`, DAI-style `Permit` (`allowed: true` →
  infinite), Permit2 `PermitSingle`/`PermitBatch` (max-uint160 → infinite),
  Permit2 `PermitTransferFrom`/`PermitBatchTransferFrom` (the redeemer is not
  in the payload, so the spender is modeled as the zero address and can never
  satisfy an allowlist), and Seaport `OrderComponents`/`BulkOrder` (offer items
  decode as approvals to an unknowable counterparty — a signed order always at
  least escalates).
- **Domain checks**: a missing `chainId` → BLOCK (the signature would replay on
  every chain); a chainId outside `chains.allowed` → BLOCK via `chain-allowed`.
- **Unrecognized or malformed typed data** → treated exactly like a failed
  simulation: `defaults.onSimulationFailure` applies. Never a silent ALLOW.

`SentinelTypedDataSigner` wraps any `signTypedData` implementation the same
way `SentinelSigner` wraps the transaction signer. Signed permits do not count
toward session spend (nothing has moved yet); approval caps are the binding
control, as with transaction-borne approvals.

## 7a. ERC-4337 smart accounts (v0.3)

A userOperation executes as EntryPoint → smart account → target, so the
transaction sender is not the account at stake. `TxRequest.onBehalfOf` carries
the policy subject: simulation impersonates the EntryPoint calling the
account's `callData` (exactly what execution does on-chain) while spend caps,
session accounting, and the contract allowlist attribute to — and exempt —
the smart account itself. `SentinelUserOpSender` wraps a bundler client the
same way `SentinelSigner` wraps a signer. Accounts must already be deployed on
the fork; initCode deployments fail simulation → `onSimulationFailure`.

## 8. Out of scope for v0.3

- LLM-based intent-vs-effect comparison
- `personal_sign` / raw `eth_sign` guarding (recommendation: do not expose
  these to agents at all)
- Multi-chain sessions
- Solana / non-EVM
- Hosted anything

## 9. Threat model summary

Assumed attacker: can inject or mutate tool calls upstream of the signer (compromised router, prompt injection, malicious MCP server), including requests for typed-data signatures. Cannot: modify Sentinel's process, policy file, or the fork node. Sentinel's guarantee: no transaction is signed whose *simulated effects* violate the policy, no recognized permit is signed whose decoded approval violates the policy, and no failure path degrades to silent ALLOW.
