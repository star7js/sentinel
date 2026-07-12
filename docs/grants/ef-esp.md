# EF Ecosystem Support Program — Application Draft

> Tailored from `docs/GRANT_PROPOSAL.md`. ESP funds prospective public-goods work
> benefiting the Ethereum ecosystem broadly; emphasis here is neutrality,
> standards alignment, and ecosystem-wide benefit. Submit at esp.ethereum.foundation.
> Sections marked ⚠️ TODO need your input before submitting.

## Project name

Sentinel — an open source signing firewall for AI agent wallets

## One-liner

A self-hostable, wallet-agnostic policy and simulation layer that sits between AI
agents and their signers, blocking malicious or out-of-policy transactions before
they are signed.

## Problem

AI agents transact on-chain autonomously at scale, but the security layer has not
kept pace with the wallet infrastructure shipped for them. In April 2026,
researchers from UC Santa Barbara, UC San Diego, Fuzzland, and World Liberty
Financial documented a live attack class targeting the connective tissue between
models and wallets: compromised LLM routers injecting malicious tool calls between
user intent and agent execution — 26 routers observed secretly injecting tool
calls, at least one wallet drained of $500,000.

The core vulnerability: the transaction an agent *intends* and the transaction that
*arrives at the signer* can differ, and nothing independent verifies them against
each other. Proprietary guardrails exist inside closed platforms; there is no open,
self-hostable, wallet-agnostic equivalent.

## Why this matters to Ethereum specifically

- Account abstraction and agent identity (ERC-4337, EIP-7702, ERC-8004) define how
  agents hold and delegate authority — but they assume an enforcement layer that
  none of them provides. Sentinel is that layer, as a neutral reference
  implementation.
- EIP-7702 delegations are first-class in Sentinel's policy model: an injected
  authorization that hands account control to attacker code is caught and
  escalated, not silently signed. This closes the most severe new failure mode
  7702 introduces for agent wallets.
- An open safety layer keeps agent security from consolidating into
  platform-locked, proprietary screening — the credible-neutrality argument that
  ESP exists to fund.

## Current state (proof of execution)

The core roadmap (M1–M4, v0.2, v0.3) is complete and public at
github.com/star7js/sentinel:

- **M1** — policy engine (chain allowlists, contract allow/blocklists, per-tx and
  per-session spend caps, approval limits, 7702 delegation checks), YAML policy
  compiler with schema validation, signer proxy with human-escalation flow, and
  threat-intel injection points.
- **M2** — fork simulation via Anvil with effect decoding: every candidate
  transaction is executed on a local fork (snapshot → run → revert) and policy is
  evaluated against its decoded effects — balance diffs, approvals granted,
  operator approvals (ERC-721/1155 setApprovalForAll), EIP-7702 delegations,
  contracts touched — not calldata claims. The test suite runs against a live
  node in CI and includes the router-injection scenario end-to-end: an in-policy
  payment signs; the injected unlimited approval is blocked before the signer is
  reached.
- **M3** — open threat-feed ingestion (ScamSniffer, pluggable sources; disk
  cache, hourly refresh, last-known-good retention) and human escalation over
  Telegram and webhooks, deny-safe on timeout or channel failure. Session spend
  caps persist across process restarts; time-of-day policy windows enforced.
- **M4** — reproducible demo: the documented router-injection attack replayed
  against a local chain and blocked live (`npm run demo`); self-checking and
  run in CI on every commit.
- **v0.2 signature guarding** — EIP-712 permits (ERC-2612, DAI-style, Permit2
  single/batch/transfer) and Seaport orders decoded into approval effects and
  policed by the same rule pipeline, closing the gasless-drain path that
  bypasses transaction-level firewalls; replayable (chainId-less) and
  unrecognized payloads never sign silently.
- **v0.3 adoption surface** — viem/ethers adapters, ERC-4337 userOperation
  guarding (spend caps attribute to the smart account, not the EntryPoint),
  and `sentinel-mcp`: the guarded wallet served as an MCP tool, so a blocked
  transaction returns its policy explanation to the model instead of signing.

MIT licensed, zero required infrastructure, one-line integration (wrap the signer).

Design invariants: the engine is pure and synchronous (simulation and intel are
inputs, making every decision auditable and reproducible), and **no failure path
degrades to a silent ALLOW** — errors and missing simulation escalate or block.

## Scope of this grant

The build is done; what a solo unfunded developer cannot provide is assurance,
sustained maintenance, and ecosystem integration. That is the ask:

| Milestone | Deliverable | Timeline |
|---|---|---|
| A1 | **Independent security audit** of the signer proxy, simulation, and typed-data decode paths — the components agents' funds depend on — with findings published and fixed | Weeks 1–4 |
| A2 | **Integration program**: working examples merged into ≥2 agent frameworks / wallet SDKs (not just published on our side); policy schema RFC with community iteration | Weeks 2–6 |
| A3 | **Intent-vs-effect layer (v0.4)**: compare the agent's stated intent with the simulated effects using an LLM judge as an additional escalation signal — the research-grade piece of the original proposal | Weeks 5–10 |
| A4 | **Maintenance commitment**: threat-feed operations, decoder registry for community-contributed formats, dependency/security response for 12 months | ongoing |

## Success metrics

- Audit completed, findings published and remediated
- ≥2 upstream framework integrations merged, not just documented
- Policy schema RFC with external contributors
- v0.4 intent-vs-effect layer shipped with a reproducible evaluation
- 12-month maintenance track record (feeds uptime, response SLAs)

## Ask

⚠️ TODO — confirm amount. Suggested: **$36,000** — **$12,000** for the
independent security audit (A1), **$18,000** for ~10 weeks of part-time
development and integration work (A2–A3), and **$6,000** retainer for the
12-month maintenance commitment (A4).

## About me

⚠️ TODO — this section carries the most weight for a solo applicant. Include:
your name/handle, security background or relevant interest, links to shipped
repos (this one first), anything deployed on-chain, and how reviewers can verify
your commit history. Link commits, not claims.

## Verify our claims (2 minutes)

Every claim above is mechanically checkable — nothing requires trusting this
document:

```bash
git clone https://github.com/star7js/sentinel && cd sentinel
npm install && npm test && npm run demo
```

`npm run demo` replays the documented router-injection attack and exits
non-zero unless the legitimate payment signs AND both injected transactions
are stopped. CI runs it against real anvil on every commit (see the Actions
tab). Known residual risks are documented in SPEC §10 rather than omitted.

## Sustainability

Post-grant: Optimism Retro Funding eligibility once adoption is demonstrable. A
paid hosted tier (managed threat feeds) was explicitly considered and rejected
for v1 to keep the core credibly neutral.
