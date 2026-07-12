# Grant Proposal: Sentinel — An Open Source Signing Firewall for AI Agent Wallets

> Target programs: Ethereum Foundation ESP, Base Builder Grants, Optimism Retro Funding (retroactively), Gitcoin rounds. Adapt the "Ask" section per program.

## One-liner

Sentinel is an open source, self-hostable policy and simulation layer that sits between AI agents and their signers, blocking malicious or out-of-policy transactions before they are signed.

## Problem

AI agents are now transacting on-chain autonomously at scale. Wallet infrastructure for agents shipped in early 2026 from multiple major providers, but the security layer has not kept pace.

In April 2026, researchers from UC Santa Barbara, UC San Diego, Fuzzland, and World Liberty Financial documented a live attack class targeting the connective tissue between AI models and wallets: compromised "LLM routers" injecting malicious tool calls between the user's intent and the agent's execution. Documented real-world abuse included 26 routers secretly injecting tool calls and at least one wallet drained of $500,000.

The core vulnerability: the transaction an agent *intends* to make and the transaction that *arrives at the signer* can differ, and today nothing independent verifies them against each other. Proprietary guardrails exist inside closed platforms; there is no open, self-hostable, wallet-agnostic equivalent.

## Solution

A TypeScript library that wraps any agent's signer. Every signing request passes three checks:

1. **Policy engine** — declarative rules: contract allowlists, spend caps per transaction and per session, approval limits, chain and time restrictions.
2. **Simulation** — every transaction is executed against a local fork before signing; Sentinel decodes the *actual effects* (balance changes, approvals granted, delegations set) and evaluates policy against effects, not calldata claims.
3. **Threat intelligence** — destination and interacted addresses checked against open drainer/scam feeds.

Anything blocked or borderline escalates to a human with a plain-language summary of what the transaction would actually do.

Integration cost for an adopter is one line of code (wrap the signer). Sentinel is a public good: MIT licensed, no token, no hosted dependency.

## Why this is a public good

- Every agent framework and wallet provider benefits; none is disadvantaged.
- The alternative today is proprietary, platform-locked screening. An open reference keeps the safety layer neutral and auditable.
- Aligns with Ethereum's account abstraction and agent identity direction (ERC-4337, EIP-7702, EIP-8004): Sentinel is the enforcement layer those standards assume but do not provide.

## Deliverables and milestones

| Milestone | Deliverable | Timeline |
|---|---|---|
| M1 | Signer proxy + policy engine (rules DSL, evaluation, tests) | Weeks 1–2 |
| M2 | Fork simulation via Anvil; effect decoding (balance diffs, approvals, 7702 delegations) | Weeks 3–4 |
| M3 | Open blocklist integration + human escalation flow (Telegram/webhook) | Weeks 5–6 |
| M4 | Public demo: replay of the router injection attack pattern, caught live by Sentinel; docs; v0.1 release | Weeks 7–8 |

## Success metrics

- v0.1 published to npm under MIT license
- Reproducible demo of the documented attack class being blocked
- ≥2 agent frameworks or wallet SDKs with working integration examples
- Policy schema published for community iteration

## Ask

[Adjust per program] Requesting $X to fund N months of full-time solo development covering milestones M1–M4, plus audit budget for the signer proxy path.

## About me

[Your background: security interest, relevant repos, anything on-chain you've shipped. Grant committees fund people as much as ideas — link commits, not claims.]

## Sustainability

Post-grant: Optimism Retro Funding eligibility once adoption is demonstrable; optional paid hosted tier (managed threat feeds) has been explicitly considered and rejected for v1 to keep the core credibly neutral — revisit only if maintenance funding requires it.
