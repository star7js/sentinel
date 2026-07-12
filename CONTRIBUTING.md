# Contributing

## Setup

```bash
npm install
npm test        # engine/decoder/escalator tests always run;
                # live-node suites need `anvil` on PATH (https://getfoundry.sh)
npm run build
npm run demo    # the router-injection attack, replayed and blocked
```

No anvil? Point the live-node suites at any hardhat/anvil-compatible node:

```bash
npx hardhat node --port 8549 &   # in a scratch project with chainId 8453
SENTINEL_TEST_RPC=http://127.0.0.1:8549 npm test
```

Test files run serially (`vitest.config.ts`) because live-node suites share
one RPC and snapshot/revert is global node state — don't re-enable file
parallelism without giving each suite its own node.

## Invariants — PRs that break these will not merge

1. **No failure path may degrade to ALLOW.** Errors, timeouts, unknown
   formats, missing simulation: escalate or block, never sign.
2. **The engine stays pure.** `evaluate()` does no I/O; simulation, intel,
   and time arrive as inputs. If your rule needs data, thread it in.
3. **Decoders are strict.** A typed-data decoder that half-understands a
   format must return `null` (undecodable), never a partial effect list.
4. **Deps stay near zero.** viem/yaml/zod, currently. Adapters use structural
   typing instead of importing frameworks; the MCP server is hand-rolled.

## Common tasks

- **Add a threat-feed source**: implement `FeedSource` in
  `src/intel/feeds.ts` (name, url, strict `parse`) + a test with a local HTTP
  server (see `test/feeds.test.ts`).
- **Add a typed-data format**: extend `decodeTypedData` in
  `src/signatures/typed-data.ts`. Model unknowable counterparties as the zero
  address so they can never satisfy an allowlist. Add both a decode test and
  an `evaluateTypedData` verdict test.
- **Add a policy rule**: implement the `Rule` type in
  `src/policy/engine.ts`, append to `RULES`, document it in `docs/SPEC.md` §4,
  and cover ALLOW/BLOCK/ESCALATE paths in `test/policy.test.ts`.
- **Regenerate contract fixtures**: the `.sol` sources live in
  `test/fixtures/`; compile with solc 0.8.28 (optimizer runs=200) and write
  `{ bytecode }` JSON next to them. Fixture headers say exactly this.

## Reporting security issues

Not here — see [SECURITY.md](SECURITY.md). Anything that could make Sentinel
sign something it shouldn't goes through a private advisory.
