# Project status & submission checklist

_Last updated: 2026-07-12 (v0.3.0)._ This file is the single place to see
where the project stands and what remains. Update it whenever either changes.

## Where we are

**The build is complete through v0.3.0** — every milestone from the original
proposal plus the v0.2/v0.3 stretch scope is shipped, tested against live
nodes, and re-verified by CI (tests + the self-checking attack demo against
real anvil) on every commit to the public repo.

Shipped: policy engine (11 rules, deny-safe throughout) · Anvil fork
simulation with effect decoding · open threat feeds (ScamSniffer, disk cache,
last-known-good) · Telegram/webhook human escalation · persistent session
caps · EIP-712 signature guarding (ERC-2612, DAI, Permit2, Seaport) ·
ERC-4337 userOp guarding · viem/ethers adapters · `sentinel-mcp` wallet
server · reproducible router-injection demo (`npm run demo`) · SECURITY.md,
CONTRIBUTING.md, SPEC with residual-risk disclosure (§10).

Details: `CHANGELOG.md` (what, by version) · `docs/SPEC.md` (how) ·
`README.md` (quick starts for every integration surface).

## Remaining — maintainer-only tasks

- [ ] **`npm login && npm publish`** — publishes `sentinel-firewall@0.3.0`
      with the `sentinel-mcp` bin; the package name is unclaimed and
      `prepublishOnly` runs the tests for you
- [x] **About me / Team sections** filled in (Josh Simnitt · jsimnitt@gmail.com
      · github.com/star7js); one optional background sentence remains in
      `ef-esp.md` if desired
- [ ] **Confirm ask amounts** against current program tiers (drafted: $36k
      ESP = $12k audit + $18k integrations/v0.4 + $6k maintenance; 2–5 ETH
      Base)
- [ ] **Submit**: Base Builder Grants first (fastest), EF ESP in parallel;
      Gitcoin when a fitting OSS round opens
- [ ] **Start the impact log** per `docs/grants/optimism-retro.md` (stars,
      npm downloads, integrations, saves) — retro funding needs evidence
      collected from day one
- [ ] Optional: tag `v0.3.0` and cut a GitHub release pointing at the
      CHANGELOG

## Next build scope (post-submission, any capable model can continue)

In priority order, matching what the grant drafts promise:

1. Upstream integration PRs into ≥2 agent frameworks (the drafts commit to
   *merged*, not just documented)
2. Coordinate the independent security audit (scope: signer proxy,
   simulation, typed-data decode paths)
3. v0.4 intent-vs-effect layer: LLM comparison of stated intent vs decoded
   effects as an extra escalation signal
4. Recipient-allowlist policy knob (SPEC §10.3)

Read `CLAUDE.md` and `CONTRIBUTING.md` before touching code — they encode the
invariants and the gotchas already paid for.
