# Sentinel

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

## Status / roadmap

- [x] **M1** Policy engine + signer proxy (this repo, tested)
- [ ] **M2** Anvil fork simulation with effect decoding (`src/simulation/simulator.ts` has the plan)
- [ ] **M3** Open threat feed ingestion + Telegram/webhook escalation
- [ ] **M4** Live demo: router-injection attack replayed and blocked

## Develop

```bash
npm install
npm test
npm run build
```

See `docs/SPEC.md` for the policy engine specification and `docs/GRANT_PROPOSAL.md` for the funding pitch.

## Design principles

1. **Deny on error.** No failure path ever degrades to a silent ALLOW.
2. **Pure engine.** Evaluation does no I/O; simulation and intel are inputs. Trivially testable, trivially auditable.
3. **Effects over intent.** Judge transactions by what they do on a fork, not what they claim.
4. **One-line adoption.** Wrap the signer, done. No hosted dependency, no token, MIT.
