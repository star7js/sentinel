import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { evaluate } from '../src/policy/engine.js';
import { compilePolicy } from '../src/policy/loader.js';
import { intelFromAddresses, emptyIntel } from '../src/intel/blocklist.js';
import { SessionState, SimulatedEffects, TxRequest, INFINITE_APPROVAL, Address } from '../src/types.js';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;
const AGENT = '0x1111111111111111111111111111111111111111' as Address;
const DRAINER = '0xdead00000000000000000000000000000000beef' as Address;

const policy = compilePolicy(
  readFileSync(new URL('../policies/example.policy.yaml', import.meta.url), 'utf8'),
  { usdc: { address: USDC, decimals: 6 } }
);

const freshState = (): SessionState => ({
  sessionStart: Math.floor(Date.now() / 1000),
  spentBySession: 0n,
  spentByToken: new Map(),
  txCount: 0,
});

const baseTx: TxRequest = {
  chainId: 8453,
  from: AGENT,
  to: USDC,
  value: 0n,
  data: '0x',
};

const cleanEffects = (over: Partial<SimulatedEffects> = {}): SimulatedEffects => ({
  balanceDiffs: [],
  approvals: [],
  approvalsForAll: [],
  delegations: [],
  contractsTouched: [USDC],
  reverted: false,
  ...over,
});

describe('policy engine', () => {
  it('allows a clean, in-policy USDC transfer', () => {
    const effects = cleanEffects({
      balanceDiffs: [{ address: AGENT, token: USDC, delta: -100_000_000n }], // 100 USDC out
    });
    const v = evaluate(baseTx, effects, policy, freshState(), emptyIntel());
    expect(v.decision).toBe('ALLOW');
  });

  it('blocks wrong chain', () => {
    const v = evaluate({ ...baseTx, chainId: 1 }, cleanEffects(), policy, freshState(), emptyIntel());
    expect(v.decision).toBe('BLOCK');
    expect(v.reasons[0].ruleId).toBe('chain-allowed');
  });

  it('blocks known drainer addresses via threat intel', () => {
    const v = evaluate(
      { ...baseTx, to: DRAINER },
      cleanEffects({ contractsTouched: [DRAINER] }),
      policy,
      freshState(),
      intelFromAddresses([DRAINER])
    );
    expect(v.decision).toBe('BLOCK');
    expect(v.reasons.some((r) => r.ruleId === 'intel-blocklist' && r.decision === 'BLOCK')).toBe(true);
  });

  it('blocks per-tx overspend', () => {
    const effects = cleanEffects({
      balanceDiffs: [{ address: AGENT, token: USDC, delta: -300_000_000n }], // 300 > 250 cap
    });
    const v = evaluate(baseTx, effects, policy, freshState(), emptyIntel());
    expect(v.decision).toBe('BLOCK');
  });

  it('blocks session cap exhaustion', () => {
    const state = freshState();
    state.spentByToken.set(USDC.toLowerCase() as Address, 900_000_000n); // 900 already spent
    const effects = cleanEffects({
      balanceDiffs: [{ address: AGENT, token: USDC, delta: -200_000_000n }], // 900+200 > 1000
    });
    const v = evaluate(baseTx, effects, policy, state, emptyIntel());
    expect(v.decision).toBe('BLOCK');
  });

  it('blocks infinite approvals — the classic drainer move', () => {
    const effects = cleanEffects({
      approvals: [{ token: USDC, spender: DRAINER, amount: INFINITE_APPROVAL }],
    });
    const v = evaluate(baseTx, effects, policy, freshState(), emptyIntel());
    expect(v.decision).toBe('BLOCK');
    expect(v.reasons.some((r) => r.humanSummary.includes('UNLIMITED'))).toBe(true);
  });

  it('escalates unapproved EIP-7702 delegation', () => {
    const v = evaluate(
      { ...baseTx, authorizationList: [{ chainId: 8453, address: DRAINER, nonce: 0 }] },
      cleanEffects(),
      policy,
      freshState(),
      emptyIntel()
    );
    expect(v.decision).toBe('ESCALATE');
  });

  it('router-injection scenario: agent meant a 10 USDC payment, injected call drains to unknown contract', () => {
    // The agent's framework was told "pay 10 USDC to the API". A compromised
    // router swapped the tool call for a transfer to an unlisted contract.
    const injected: TxRequest = { ...baseTx, to: DRAINER };
    const effects: SimulatedEffects = cleanEffects({
      contractsTouched: [DRAINER],
      balanceDiffs: [{ address: AGENT, token: USDC, delta: -240_000_000n }], // under per-tx cap!
    });
    // Even without threat intel and under spend caps, unknown contract → not silently allowed.
    const v = evaluate(injected, effects, policy, freshState(), emptyIntel());
    expect(v.decision).toBe('ESCALATE'); // defense in depth: human sees it before it signs
  });

  it('never allows when simulation is unavailable', () => {
    const v = evaluate(baseTx, null, policy, freshState(), emptyIntel());
    expect(v.decision).not.toBe('ALLOW');
  });

  it('blocks setApprovalForAll grants — the NFT drain move', () => {
    const effects = cleanEffects({
      approvalsForAll: [{ token: USDC, operator: DRAINER, approved: true }],
    });
    const v = evaluate(baseTx, effects, policy, freshState(), emptyIntel());
    expect(v.decision).toBe('BLOCK');
    expect(v.reasons.some((r) => r.ruleId === 'operator-approvals' && r.decision === 'BLOCK')).toBe(
      true
    );
  });

  it('allows operator approval revocations', () => {
    const effects = cleanEffects({
      approvalsForAll: [{ token: USDC, operator: DRAINER, approved: false }],
    });
    const v = evaluate(baseTx, effects, policy, freshState(), emptyIntel());
    expect(v.decision).toBe('ALLOW');
  });

  it('escalates contract creation by default', () => {
    const v = evaluate(
      { ...baseTx, to: null },
      cleanEffects({ contractsTouched: [] }),
      policy,
      freshState(),
      emptyIntel()
    );
    expect(v.decision).toBe('ESCALATE');
    expect(v.reasons.some((r) => r.ruleId === 'contract-creation')).toBe(true);
  });
});

describe('time-window rule', () => {
  const withHours = (start: string, end: string, tz: string) =>
    compilePolicy(
      readFileSync(new URL('../policies/example.policy.yaml', import.meta.url), 'utf8').replace(
        /activeHours: null.*/,
        `activeHours: { start: "${start}", end: "${end}", tz: "${tz}" }`
      ),
      { usdc: { address: USDC, decimals: 6 } }
    );

  const NOON_UTC = Date.UTC(2026, 0, 15, 12, 0, 0);
  const THREE_AM_UTC = Date.UTC(2026, 0, 15, 3, 0, 0);

  it('allows inside the window, blocks outside it', () => {
    const p = withHours('09:00', '18:00', 'UTC');
    expect(evaluate(baseTx, cleanEffects(), p, freshState(), emptyIntel(), NOON_UTC).decision).toBe(
      'ALLOW'
    );
    const v = evaluate(baseTx, cleanEffects(), p, freshState(), emptyIntel(), THREE_AM_UTC);
    expect(v.decision).toBe('BLOCK');
    expect(v.reasons.some((r) => r.ruleId === 'time-window' && r.decision === 'BLOCK')).toBe(true);
  });

  it('handles overnight windows that wrap midnight', () => {
    const p = withHours('22:00', '06:00', 'UTC');
    expect(
      evaluate(baseTx, cleanEffects(), p, freshState(), emptyIntel(), THREE_AM_UTC).decision
    ).toBe('ALLOW');
    expect(evaluate(baseTx, cleanEffects(), p, freshState(), emptyIntel(), NOON_UTC).decision).toBe(
      'BLOCK'
    );
  });

  it('escalates (never allows) on an invalid time zone', () => {
    const p = withHours('09:00', '18:00', 'Not/AZone');
    const v = evaluate(baseTx, cleanEffects(), p, freshState(), emptyIntel(), NOON_UTC);
    expect(v.decision).toBe('ESCALATE');
    expect(v.reasons.some((r) => r.ruleId === 'internal-error')).toBe(true);
  });

  it('rejects malformed activeHours at policy load', () => {
    expect(() => withHours('9am', '18:00', 'UTC')).toThrow();
  });
});
