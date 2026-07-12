# Sentinel — project guide for AI-assisted development

An open source signing firewall for AI agent wallets. TypeScript, ESM,
strict tsc; deps are viem + yaml + zod only, and it stays that way.

## Commands

- `npm test` — vitest; live-node suites (simulator, userop) auto-skip without
  `anvil` on PATH or `SENTINEL_TEST_RPC=<url>` pointing at a
  hardhat/anvil-compatible node (chainId 8453 preferred)
- `npm run build` — tsc to `dist/`
- `npm run demo` — self-checking replay of the router-injection attack;
  exits non-zero on any failed check; runs in CI

## Architecture (src/)

- `policy/engine.ts` — pure rule pipeline; first BLOCK wins, ESCALATE
  accumulates. `evaluate(tx, effects, policy, state, intel, nowMs?)`.
- `policy/loader.ts` — YAML → CompiledPolicy via zod; token decimals pinned
  at compile time.
- `simulation/anvil.ts` — snapshot → impersonated send → decode effects →
  revert. Serialized internally; returns null on ANY failure (deny-safe).
- `signatures/typed-data.ts` — EIP-712 decoders (permits, Permit2, Seaport)
  → same engine. Strict: malformed field ⇒ undecodable ⇒ onSimulationFailure.
- `signer/proxy.ts` — SentinelSigner wraps any signer; session accounting
  after successful send only. `aa/userop.ts` composes it for 4337
  (TxRequest.onBehalfOf = the policed smart account).
- `mcp/` — hand-rolled MCP stdio server + env-configured CLI (`sentinel-mcp`).
- `intel/feeds.ts` — feed loading, disk cache, last-known-good retention.

## Non-negotiable invariants

1. No failure path degrades to ALLOW — errors/timeouts/unknowns escalate or block.
2. Engine does no I/O; everything arrives as inputs.
3. Decoders return null rather than partial effects.
4. Structural typing for framework adapters; no new runtime deps.

## Gotchas learned the hard way

1. Test files run **serially** (`vitest.config.ts`): live-node suites share
   one RPC and snapshot/revert is global state. Don't re-parallelize.
2. Fixed tx gas is `0xe4e1c0` (15M): above hardhat's 2^24 tx cap fails, and
   explicit gas is required so reverting txs are *mined* (status 0) instead
   of rejected at estimation.
3. The simulator's `hardhat_stopImpersonatingAccount` cleanup un-impersonates
   globally — anything else impersonating the same account must re-impersonate
   before sending (see demo's rawSigner).
4. ERC-20 transfer *recipients* are not "touched contracts" — the allowlist
   does not fire on them; spend caps are the control (SPEC §10.3).
5. Contract fixtures: `.sol` in `test/fixtures/`, compiled with solc 0.8.28
   runs=200 into `{ bytecode }` JSON. MiniAccount takes an abi-encoded
   entryPoint constructor arg appended to the bytecode.
6. GitHub Actions on a **private** repo dies with runner-never-assigned
   (billing); the repo must stay public for CI.

## Process conventions

- Branch: work on `claude/make-this-y7d6c5`; restart it from `origin/main`
  after each squash-merge (`git checkout -B <branch> origin/main`).
- Every substantive PR: run the full suite against a live node AND the demo
  before pushing; CI re-verifies against real anvil including the demo step.
- Keep `docs/SPEC.md`, `CHANGELOG.md`, and `docs/grants/` truthful in the
  same PR as the code they describe — the grant drafts must never claim
  shipped work as future scope or vice versa.
