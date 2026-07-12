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

- **ERC-4337 support**: userOperation guarding with spend caps attributed to
  the smart account — Base agents behind smart wallets get the same protection
  as EOA agents
- **Drop-in adoption**: viem/ethers adapters and `sentinel-mcp`, the guarded
  wallet as an MCP tool for agent frameworks

## What this grant funds

1. **Merged integrations with Base-native agent stacks** — working examples
   landed upstream in ≥2 frameworks building on Base, not just documented here
2. **Independent security review** of the signing paths Base agents would
   depend on, findings published
3. **Maintenance**: threat-feed operations and security response so the
   firewall Base builders adopt stays trustworthy

Timeline: 4–6 weeks of integration work; audit and maintenance in parallel.

## Ask

⚠️ TODO — confirm amount against the current program tier. Suggested: **2–5 ETH**
(align with the standard Base Builder Grant size at time of submission).

## Team

⚠️ TODO — name/handle, links to shipped work, this repo's commit history.

## Links

- Repo: https://github.com/star7js/sentinel
- Spec: https://github.com/star7js/sentinel/blob/main/docs/SPEC.md
- npm: https://www.npmjs.com/package/sentinel-firewall (v0.0.1)
