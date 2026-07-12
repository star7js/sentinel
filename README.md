# Sentinel

[![CI](https://github.com/star7js/sentinel/actions/workflows/ci.yml/badge.svg)](https://github.com/star7js/sentinel/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/sentinel-firewall)](https://www.npmjs.com/package/sentinel-firewall)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**An open source signing firewall for AI agent wallets.**

AI agents now hold keys and transact autonomously. The weakest link is the connective tissue between the model and the signer: compromised LLM routers and injected tool calls have already drained real wallets. Sentinel sits between your agent and its signer and refuses to sign anything that violates policy, fails simulation, or touches known-malicious addresses.

## How it works

```
agent → tool call → [ SENTINEL ] → signer → chain
                       │
                       ├─ 1. simulate on a local fork → decode ACTUAL effects
                       ├─ 2. evaluate policy (spend caps, allowlists, approvals, 7702 delegations)
                       ├─ 3. check threat feeds
                       └─ 4. ALLOW / BLOCK / escalate to a human with a plain-language summary
```

The key idea: policy is evaluated against a transaction's **simulated effects**, not what the calldata claims. A malicious tool call that "looks like" a payment but grants an unlimited approval gets caught by what it actually does.

## Quick start

```ts
import { SentinelSigner, compilePolicy, NoopSimulator, emptyIntel, RejectingEscalator } from 'sentinel-firewall';
import { readFileSync } from 'node:fs';

const policy = compilePolicy(readFileSync('policies/example.policy.yaml', 'utf8'), {
  usdc: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
});

const guarded = new SentinelSigner(myRawSigner, policy, new NoopSimulator(), emptyIntel(), new RejectingEscalator());

// Use `guarded` wherever your agent framework expects a signer.
// Out-of-policy transactions throw SentinelBlockedError instead of signing.
```

### With fork simulation (recommended)

`NoopSimulator` escalates everything because effects can't be verified. To judge
transactions by what they *actually do*, point Sentinel at a local fork of your
chain (requires [foundry](https://getfoundry.sh)'s `anvil`; a Hardhat node works too):

```ts
import { AnvilSimulator, startAnvil } from 'sentinel-firewall';

const anvil = await startAnvil({ forkUrl: 'https://mainnet.base.org', chainId: 8453 });
const guarded = new SentinelSigner(myRawSigner, policy, new AnvilSimulator(anvil.rpcUrl), emptyIntel(), new RejectingEscalator());
```

Each candidate transaction is executed on the fork (snapshot → run → revert) and
its decoded effects — balance diffs, approvals granted, EIP-7702 delegations,
contracts touched — are what the policy engine evaluates. A tool call that "looks
like" a $10 payment but grants an unlimited approval is blocked for what it does.

### Threat feeds and human escalation

```ts
import { startThreatFeeds, scamSnifferAddresses, TelegramEscalator, WebhookEscalator } from 'sentinel-firewall';

// Open drainer blocklists, refreshed hourly, disk-cached, injected as data.
const feeds = await startThreatFeeds([scamSnifferAddresses], { cacheDir: '.sentinel-cache' });

// Borderline transactions go to a human with a plain-language summary.
const escalator = new TelegramEscalator({ botToken: process.env.TG_TOKEN!, chatId: 123456 });
// ...or POST to your own service: new WebhookEscalator('https://ops.example.com/approve')

const guarded = new SentinelSigner(myRawSigner, policy, simulator, feeds.intel, escalator);
```

Escalation is deny-safe: a timeout, transport error, or malformed response
rejects the transaction — the channel being down never means "approved".

### Signature guarding

Most real drains never send a transaction from the victim: the attacker gets a
signed EIP-712 message — an ERC-2612 permit, a Permit2 grant — and submits it
themselves. Guard the signing surface too:

```ts
import { SentinelTypedDataSigner } from 'sentinel-firewall';

const guardedSigner = new SentinelTypedDataSigner(myTypedDataSigner, policy, feeds.intel, escalator);
await guardedSigner.signTypedData(request); // throws SentinelBlockedError on violation
```

Known permit shapes (ERC-2612, DAI-style, Permit2 single/batch/transfer,
Seaport orders) are decoded into approval effects and run through the same
rule pipeline — intel, allowlists, approval caps, time windows. Typed data
with no `chainId` is blocked (cross-chain replay); anything unrecognized is
treated like a failed simulation and escalates rather than signing silently.

### Plug into your stack

```ts
import { fromViemWalletClient, fromEthersSigner, SentinelUserOpSender } from 'sentinel-firewall';

// viem or ethers — wrap what you already have:
const guarded = new SentinelSigner(fromViemWalletClient(walletClient), policy, sim, intel, esc);
const guarded2 = new SentinelSigner(fromEthersSigner(ethersSigner), policy, sim, intel, esc);

// ERC-4337 smart accounts — guard the bundler the same way; spend caps and
// session accounting attribute to the smart account, not the EntryPoint:
const bundlerGuard = new SentinelUserOpSender(bundler, { chainId: 8453 }, policy, sim, intel, esc);
```

### The safe wallet tool for agents (MCP)

The motivating attack is a malicious tool layer — so the wallet tool itself
enforces policy. `sentinel-mcp` serves a guarded wallet over the Model Context
Protocol; a blocked transaction returns the rule summaries to the model as a
tool error instead of signing:

```jsonc
// e.g. in your agent's MCP config
{ "mcpServers": { "wallet": { "command": "npx", "args": ["sentinel-mcp"], "env": {
  "SENTINEL_POLICY": "policies/example.policy.yaml",
  "SENTINEL_RPC_URL": "https://mainnet.base.org",
  "SENTINEL_FORK_RPC": "http://127.0.0.1:8545",   // anvil --fork-url ...
  "SENTINEL_PRIVATE_KEY": "0x…",
  "SENTINEL_CHAIN_ID": "8453"
} } } }
```

## Status / roadmap

- [x] **M1** Policy engine + signer proxy (this repo, tested)
- [x] **M2** Anvil fork simulation with effect decoding (`src/simulation/anvil.ts`, tested against a live node)
- [x] **M3** Open threat feed ingestion (`src/intel/feeds.ts`) + Telegram/webhook escalation (`src/signer/escalators.ts`)
- [x] **M4** Live demo: router-injection attack replayed and blocked (`npm run demo`, runs in CI); v0.1.0
- [x] **v0.2** Signature guarding: EIP-712 permits through the same policy (`src/signatures/`) — the drain path that skips transactions entirely
- [x] **v0.3** Adoption surface: viem/ethers adapters, `sentinel-mcp` wallet server, ERC-4337 userOp guarding, Seaport order decoding
- [ ] npm publish · independent security audit · Solana / intent-vs-effect (future scope)

## See the attack die

```bash
npm install && npm run demo    # needs `anvil` on PATH (https://getfoundry.sh)
```

The demo replays the documented router-injection pattern on a local chain:
the agent's legitimate 10 mUSD payment signs; the injected
`approve(drainer, 2^256-1)` — indistinguishable on calldata alone — is
simulated, decoded, and blocked before the signer; the under-the-caps
redirect to an unknown address escalates to a human. Self-checking, runs in
CI on every commit.

## Develop

```bash
npm install
npm test
npm run build
```

See `docs/SPEC.md` for the policy engine specification (including §10, known
residual risks — stated plainly, because a security tool that hides its limits
is worse than none), `SECURITY.md` for reporting and deployment guidance, and
`docs/GRANT_PROPOSAL.md` for the funding pitch.

## Verify every claim yourself

```bash
git clone https://github.com/star7js/sentinel && cd sentinel
npm install
npm test        # 80 tests incl. live-node simulation (needs anvil: getfoundry.sh)
npm run demo    # the documented attack, replayed and blocked, self-checking
```

CI runs exactly this — tests plus the attack demo against real anvil — on
every commit: https://github.com/star7js/sentinel/actions

## Design principles

1. **Deny on error.** No failure path ever degrades to a silent ALLOW.
2. **Pure engine.** Evaluation does no I/O; simulation and intel are inputs. Trivially testable, trivially auditable.
3. **Effects over intent.** Judge transactions by what they do on a fork, not what they claim.
4. **One-line adoption.** Wrap the signer, done. No hosted dependency, no token, MIT.
