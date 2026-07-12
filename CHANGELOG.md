# Changelog

## 0.3.0 — 2026-07-12

### Adoption surface
- **viem/ethers adapters** (`fromViemWalletClient`, `fromEthersSigner`, typed-
  data variants): structurally typed, no new dependencies; the ethers adapter
  refuses 7702 authorization lists rather than dropping them.
- **`sentinel-mcp`**: a policy-guarded wallet served over the Model Context
  Protocol (stdio, zero-dependency implementation). Blocked transactions
  return the human-readable rule summaries to the model as tool errors.
- **ERC-4337 guarding**: `SentinelUserOpSender` wraps any bundler client;
  simulation impersonates the EntryPoint executing the account's callData and
  `TxRequest.onBehalfOf` attributes spend caps and session accounting to the
  smart account.
- **Seaport order decoding**: `OrderComponents`/`BulkOrder` offers decode as
  approvals to an unknowable counterparty — signed orders always at least
  escalate.
- Test files now run serially (`vitest.config.ts`) so live-node suites can
  share one RPC without snapshot races.

## 0.2.0 — 2026-07-12

### Signature guarding
- `SentinelTypedDataSigner` + `evaluateTypedData`: EIP-712 signing requests
  policed by the same rule pipeline as transactions. Decodes ERC-2612 permits,
  DAI-style permits (`allowed: true` → infinite), and Permit2
  single/batch/transfer grants (max-uint160 → infinite; SignatureTransfer's
  unknowable redeemer can never satisfy an allowlist).
- Deny-safe domain rules: typed data without a `chainId` is blocked
  (cross-chain replay); unrecognized or malformed payloads follow
  `defaults.onSimulationFailure` — never a silent ALLOW.

## 0.1.0 — 2026-07-12

First feature-complete release of the core firewall (milestones M1–M4).

### Policy engine (M1)
- Pure, deterministic rule pipeline: chain allowlist, threat-intel blocklist,
  contract allow/blocklist, contract-creation policy, revert check, per-tx and
  per-session spend caps (native + ERC-20), approval limits, operator-approval
  (`setApprovalForAll`) limits, EIP-7702 delegation checks, time windows.
- Deny-on-error throughout: a throwing rule, missing simulation, or invalid
  timezone can never produce a silent ALLOW.
- YAML policies validated with zod at load; token decimals pinned at compile.

### Fork simulation (M2)
- `AnvilSimulator`: snapshot → impersonated execution → effect decoding →
  revert against any anvil/hardhat-compatible node. Policy evaluates decoded
  balance diffs, approvals, operator approvals, delegations, and touched
  contracts — not calldata claims.
- Chain-id mismatch, node failure, or decode error → simulation unavailable →
  policy's `onSimulationFailure` applies.

### Threat intel + escalation (M3)
- Open feed ingestion (ScamSniffer built in, sources pluggable) with disk
  cache, hourly refresh, and per-source last-known-good retention.
- Human escalation via Telegram (inline Approve/Reject) or webhook; timeout,
  transport error, or malformed response rejects — deny-safe.

### Hardening
- Session spend caps persist across process restarts (`JsonFileStore`,
  atomic writes; corrupt state refuses to start).

### Demo (M4)
- `npm run demo`: the documented LLM-router injection attack replayed against
  a local chain and blocked live; self-checking and run in CI.
