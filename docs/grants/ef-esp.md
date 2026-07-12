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

Milestones 1 and 2 are complete and public at github.com/star7js/sentinel:

- **M1** — policy engine (chain allowlists, contract allow/blocklists, per-tx and
  per-session spend caps, approval limits, 7702 delegation checks), YAML policy
  compiler with schema validation, signer proxy with human-escalation flow, and
  threat-intel injection points.
- **M2** — fork simulation via Anvil with effect decoding: every candidate
  transaction is executed on a local fork (snapshot → run → revert) and policy is
  evaluated against its decoded effects — balance diffs, approvals granted,
  EIP-7702 delegations, contracts touched — not calldata claims. The test suite
  runs against a live node in CI and includes the router-injection scenario
  end-to-end: an in-policy payment signs; the injected unlimited approval is
  blocked before the signer is reached.

MIT licensed, zero required infrastructure, one-line integration (wrap the signer).

Design invariants: the engine is pure and synchronous (simulation and intel are
inputs, making every decision auditable and reproducible), and **no failure path
degrades to a silent ALLOW** — errors and missing simulation escalate or block.

## Scope of this grant

| Milestone | Deliverable | Timeline |
|---|---|---|
| M3 | Open threat-feed ingestion (ScamSniffer, eth-phishing-detect) + Telegram/webhook escalation | Weeks 1–2 |
| M4 | Public reproducible demo: the documented router-injection attack replayed and blocked live; docs; v0.1 npm release | Weeks 3–4 |
| M5 | Integration examples for ≥2 agent frameworks / wallet SDKs; policy schema RFC for community iteration | Weeks 5–6 |

## Success metrics

- v0.1 on npm under MIT, reproducible attack-blocked demo
- ≥2 working framework/SDK integration examples
- Policy schema published for community iteration
- Independent security review of the signer proxy path completed and published

## Ask

⚠️ TODO — confirm amount. Suggested: **$24,000** — 6 weeks of full-time solo
development (M3–M5) at a rate consistent with ESP small-grant norms, plus
**$6,000** earmarked for an independent review of the signer proxy and
simulation paths (the components whose failure would be catastrophic).
Total: **$30,000**.

## About me

⚠️ TODO — this section carries the most weight for a solo applicant. Include:
your name/handle, security background or relevant interest, links to shipped
repos (this one first), anything deployed on-chain, and how reviewers can verify
your commit history. Link commits, not claims.

## Sustainability

Post-grant: Optimism Retro Funding eligibility once adoption is demonstrable. A
paid hosted tier (managed threat feeds) was explicitly considered and rejected
for v1 to keep the core credibly neutral.
