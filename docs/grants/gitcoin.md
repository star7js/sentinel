# Gitcoin Round — Project Listing Draft

> Tailored from `docs/GRANT_PROPOSAL.md`. Gitcoin is quadratic funding: the
> audience is many small individual donors, not a review committee. The pitch
> must land in ~30 seconds and explain why *everyone* benefits. Check which round
> fits (GG OSS / dev tooling rounds are the natural home) and adapt the header
> fields to the round's application form. Sections marked ⚠️ TODO need your input.

## Project name

Sentinel — the open source signing firewall for AI agent wallets

## Short description (~280 chars, for cards)

AI agents hold keys and sign transactions autonomously. Compromised LLM routers
have already drained real wallets by injecting tool calls. Sentinel is an MIT,
self-hostable firewall that blocks bad transactions *before* they're signed. No
token, no hosted dependency.

## Full description

**The problem in one sentence:** the transaction your agent *means* to send and
the transaction that *reaches the signer* can be different — and today, nothing
open-source checks.

In April 2026 researchers documented compromised LLM routers injecting malicious
tool calls into agent pipelines: 26 routers caught doing it, at least one wallet
drained of $500,000. Every agent framework that holds keys has this attack
surface. The only defenses today live inside closed platforms.

**Sentinel** wraps your agent's signer in one line of code. Before anything gets
signed it:

1. **Simulates** the transaction on a local fork and decodes what it *actually
   does* — balance changes, approvals granted, account delegations
2. **Evaluates policy** against those effects: spend caps, contract allowlists,
   approval limits, EIP-7702 delegation rules
3. **Checks threat feeds** for known drainer addresses
4. **Blocks or escalates to a human** with a plain-language summary — never a
   silent failure

The classic drainer move — a tool call that "looks like" a $10 payment but grants
unlimited USDC approval — is caught by what it does, not what it claims.

**Why fund it here:** Sentinel is a pure public good. MIT licensed, no token, no
hosted service, works with any wallet and any framework. Every project in this
round that touches agent wallets benefits; none is disadvantaged. The engine,
fork simulation, open threat feeds, and Telegram/webhook escalation are already
built and tested against a live node (github.com/star7js/sentinel); your funding
accelerates the public attack-replay demo, framework integrations, and
signature guarding (EIP-712 permits — the drain path that skips transactions
entirely).

## Funding use

- Reproducible attack demo + integration examples + v0.1 npm release
- Signature guarding: EIP-712 permit/order decoding through the same policy

## Links & verification

- Repo (working code, CI, tests): https://github.com/star7js/sentinel
- npm: https://www.npmjs.com/package/sentinel-firewall

## Team

⚠️ TODO — handle, background, links. Gitcoin donors check that the repo is alive:
recent commits matter more than prose here.
