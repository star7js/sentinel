import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore } from '../src/state/store.js';
import { compilePolicy } from '../src/policy/loader.js';
import { emptyIntel } from '../src/intel/blocklist.js';
import { SentinelSigner, SentinelBlockedError, RejectingEscalator } from '../src/signer/proxy.js';
import { Simulator } from '../src/simulation/simulator.js';
import { Address, Hex, SessionState, SimulatedEffects, TxRequest } from '../src/types.js';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;
const AGENT = '0x1111111111111111111111111111111111111111' as Address;

const policy = compilePolicy(
  readFileSync(new URL('../policies/example.policy.yaml', import.meta.url), 'utf8'),
  { usdc: { address: USDC, decimals: 6 } }
);

const statePath = () => join(mkdtempSync(join(tmpdir(), 'sentinel-')), 'session.json');

describe('JsonFileStore', () => {
  it('round-trips session state including bigints', () => {
    const store = new JsonFileStore(statePath());
    const state: SessionState = {
      sessionStart: 1_700_000_000,
      spentBySession: 123_456_789_000_000_000_000n,
      spentByToken: new Map([[USDC.toLowerCase() as Address, 900_000_000n]]),
      txCount: 7,
    };
    store.save(state);
    expect(store.load()).toEqual(state);
  });

  it('returns null when no state file exists', () => {
    expect(new JsonFileStore(statePath()).load()).toBeNull();
  });

  it('throws on a corrupt state file instead of resetting caps', () => {
    const path = statePath();
    writeFileSync(path, '{"garbage": true}');
    expect(() => new JsonFileStore(path).load()).toThrow(/malformed/);
  });
});

describe('session persistence across restarts', () => {
  // 250 USDC per tx / 1000 USDC per session, per the example policy.
  const spend250: SimulatedEffects = {
    balanceDiffs: [{ address: AGENT, token: USDC.toLowerCase() as Address, delta: -250_000_000n }],
    approvals: [],
    approvalsForAll: [],
    delegations: [],
    contractsTouched: [USDC],
    reverted: false,
  };
  const sim: Simulator = { simulate: async () => spend250 };
  const tx: TxRequest = { chainId: 8453, from: AGENT, to: USDC, value: 0n, data: '0x' };
  const inner = { signAndSend: async () => ('0x' + 'ab'.repeat(32)) as Hex };

  it('carries session spend through a process restart', async () => {
    const path = statePath();

    const first = new SentinelSigner(
      inner, policy, sim, emptyIntel(), new RejectingEscalator(), new JsonFileStore(path)
    );
    await first.signAndSend(tx); // 250
    await first.signAndSend(tx); // 500

    // "Restart": a brand-new signer reading the same store.
    const second = new SentinelSigner(
      inner, policy, sim, emptyIntel(), new RejectingEscalator(), new JsonFileStore(path)
    );
    await second.signAndSend(tx); // 750
    await second.signAndSend(tx); // 1000 — at the session cap
    await expect(second.signAndSend(tx)).rejects.toThrow(SentinelBlockedError); // 1250 > 1000
  });

  it('refuses to start on a corrupt state file', () => {
    const path = statePath();
    writeFileSync(path, 'not json at all');
    expect(
      () =>
        new SentinelSigner(
          inner, policy, sim, emptyIntel(), new RejectingEscalator(), new JsonFileStore(path)
        )
    ).toThrow();
  });
});
