# Base Builder Grants — Application Draft

> Tailored from `docs/GRANT_PROPOSAL.md`. Base grants are small, fast, and
> retroactive-leaning — they reward things that already work on Base. Lead with
> the working code and the Base-native framing, keep it short. Sections marked
> ⚠️ TODO need your input before submitting.

## What is Sentinel?

An open source signing firewall for AI agent wallets. It wraps any signer in one
line of code and refuses to sign transactions that violate policy, fail
simulation, or touch known drainer addresses. MIT, self-hostable, no token.

```
agent → tool call → [ SENTINEL ] → signer → Base
```

## Why Base

Base is where autonomous agent commerce is actually happening — agent wallets
transacting USDC on Base is the canonical use case, and it's exactly the setup
Sentinel ships with today: the example policy is **Base-only (chain 8453) with
native USDC spend caps**. v1 is deliberately scoped to Base before any other
chain.

Every agent framework settling USDC on Base inherits the same risk: a compromised
router or injected tool call between the model and the signer. This drained real
wallets in the wild in April 2026 ($500k+ documented). Sentinel is the open
enforcement layer that stops it — policy is evaluated against a transaction's
*simulated effects on a Base fork*, not what the calldata claims.

## What works today

Live at github.com/star7js/sentinel, tested, CI green:

- Policy engine: contract allowlists, per-tx / per-session USDC + ETH spend caps,
  approval limits (infinite approvals blocked by default), EIP-7702 delegation
  checks
- **Fork simulation via Anvil** — the core "effects over intent" differentiator:
  transactions run on a Base fork before signing, and policy judges the decoded
  effects (balance diffs, approvals, delegations), not what the calldata claims
- Signer proxy with human escalation over **Telegram or webhook** — deny-safe on
  timeout; out-of-policy transactions throw instead of signing
- **Open threat feeds**: known drainer addresses (ScamSniffer, pluggable
  sources) checked before anything signs; disk-cached, refreshed hourly
- Test suite runs against a live node in CI, including the router-injection
  scenario end-to-end: the in-policy payment signs, the injected unlimited
  approval is blocked before the signer

- **Signature guarding**: EIP-712 permits (ERC-2612, DAI, Permit2) decoded and
  policed by the same policy — the gasless-drain path that skips transactions
  entirely is closed
- **Reproducible attack demo** (`npm run demo`): the documented router-injection
  pattern replayed and blocked live; self-checking, runs in CI on every commit

## What this grant funds

1. **Integration examples** for agent frameworks building on Base (viem/ethers
   adapters, an MCP-server wallet wrapper) + npm release
2. **ERC-4337 smart-account support**: guard userOperations so Base agents
   behind smart wallets get the same protection as EOA agents
3. **Base-fork demo hosting + docs** so any Base builder can reproduce the
   attack-blocked demo in one command

Timeline: 4–6 weeks.

## Ask

⚠️ TODO — confirm amount against the current program tier. Suggested: **2–5 ETH**
(align with the standard Base Builder Grant size at time of submission).

## Team

⚠️ TODO — name/handle, links to shipped work, this repo's commit history.

## Links

- Repo: https://github.com/star7js/sentinel
- Spec: https://github.com/star7js/sentinel/blob/main/docs/SPEC.md
- npm: https://www.npmjs.com/package/sentinel-firewall (v0.0.1)
