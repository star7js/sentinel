import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { compilePolicy } from '../src/policy/loader.js';
import { emptyIntel, intelFromAddresses } from '../src/intel/blocklist.js';
import { evaluateTypedData, TypedDataRequest } from '../src/signatures/typed-data.js';
import { SentinelTypedDataSigner } from '../src/signatures/signer.js';
import { SentinelBlockedError, RejectingEscalator } from '../src/signer/proxy.js';
import { Address, Hex, INFINITE_APPROVAL } from '../src/types.js';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as Address;
const AGENT = '0x1111111111111111111111111111111111111111' as Address;
const PAYMENTS = '0x3333333333333333333333333333333333333333' as Address;
const DRAINER = '0xdead00000000000000000000000000000000beef' as Address;

// Example policy + allow the payments processor as a legitimate spender.
const policy = compilePolicy(
  readFileSync(new URL('../policies/example.policy.yaml', import.meta.url), 'utf8').replace(
    'label: usdc',
    `label: usdc\n    - address: "${PAYMENTS}"\n      label: payments`
  ),
  { usdc: { address: USDC, decimals: 6 } }
);

const erc2612 = (spender: Address, value: bigint, over: Partial<TypedDataRequest> = {}): TypedDataRequest => ({
  domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC },
  types: {
    Permit: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
  },
  primaryType: 'Permit',
  message: { owner: AGENT, spender, value: value.toString(), nonce: 0, deadline: 9999999999 },
  ...over,
});

describe('evaluateTypedData', () => {
  it('allows an in-policy ERC-2612 permit to a known spender', () => {
    const v = evaluateTypedData(erc2612(PAYMENTS, 100_000_000n), policy, emptyIntel());
    expect(v.decision).toBe('ALLOW');
  });

  it('blocks an infinite permit — the gasless drain', () => {
    const v = evaluateTypedData(erc2612(PAYMENTS, INFINITE_APPROVAL), policy, emptyIntel());
    expect(v.decision).toBe('BLOCK');
    expect(v.reasons.some((r) => r.humanSummary.includes('UNLIMITED'))).toBe(true);
  });

  it('blocks a permit above the approval cap', () => {
    // cap is 500 USDC in the example policy
    const v = evaluateTypedData(erc2612(PAYMENTS, 600_000_000n), policy, emptyIntel());
    expect(v.decision).toBe('BLOCK');
  });

  it('escalates a permit to an unknown spender even within the cap', () => {
    const v = evaluateTypedData(erc2612(DRAINER, 100_000_000n), policy, emptyIntel());
    expect(v.decision).toBe('ESCALATE');
  });

  it('blocks a permit to a spender on threat feeds', () => {
    const v = evaluateTypedData(
      erc2612(DRAINER, 100_000_000n),
      policy,
      intelFromAddresses([DRAINER])
    );
    expect(v.decision).toBe('BLOCK');
    expect(v.reasons.some((r) => r.ruleId === 'intel-blocklist' && r.decision === 'BLOCK')).toBe(true);
  });

  it('blocks DAI-style permits that flip allowed=true (always infinite)', () => {
    const req: TypedDataRequest = {
      domain: { name: 'Dai', version: '1', chainId: 8453, verifyingContract: USDC },
      types: {},
      primaryType: 'Permit',
      message: { holder: AGENT, spender: DRAINER, nonce: 0, expiry: 0, allowed: true },
    };
    expect(evaluateTypedData(req, policy, emptyIntel()).decision).toBe('BLOCK');
  });

  it('handles Permit2 PermitSingle, treating max-uint160 as infinite', () => {
    const req: TypedDataRequest = {
      domain: { name: 'Permit2', chainId: 8453, verifyingContract: PERMIT2 },
      types: {},
      primaryType: 'PermitSingle',
      message: {
        details: { token: USDC, amount: ((1n << 160n) - 1n).toString(), expiration: 0, nonce: 0 },
        spender: DRAINER,
        sigDeadline: 0,
      },
    };
    const v = evaluateTypedData(req, policy, emptyIntel());
    expect(v.decision).toBe('BLOCK');
    expect(v.reasons.some((r) => r.humanSummary.includes('UNLIMITED'))).toBe(true);
  });

  it('never allowlists Permit2 SignatureTransfer (redeemer is unknowable)', () => {
    const req: TypedDataRequest = {
      domain: { name: 'Permit2', chainId: 8453, verifyingContract: PERMIT2 },
      types: {},
      primaryType: 'PermitTransferFrom',
      message: { permitted: { token: USDC, amount: '100000000' }, nonce: 0, deadline: 0 },
    };
    const v = evaluateTypedData(req, policy, emptyIntel());
    expect(v.decision).not.toBe('ALLOW');
  });

  it('escalates unrecognized typed data (effects unverifiable)', () => {
    const req: TypedDataRequest = {
      domain: { name: 'CoolMarket', chainId: 8453, verifyingContract: USDC },
      types: {},
      primaryType: 'Order',
      message: { maker: AGENT, stuff: 1 },
    };
    const v = evaluateTypedData(req, policy, emptyIntel());
    expect(v.decision).toBe('ESCALATE');
    expect(v.reasons[0].ruleId).toBe('typed-data-decode');
  });

  it('blocks typed data whose domain has no chainId (cross-chain replay)', () => {
    const req = erc2612(PAYMENTS, 1n, { domain: { name: 'USD Coin', verifyingContract: USDC } });
    const v = evaluateTypedData(req, policy, emptyIntel());
    expect(v.decision).toBe('BLOCK');
    expect(v.reasons[0].ruleId).toBe('typed-data-domain');
  });

  it('blocks permits for chains outside the policy', () => {
    const req = erc2612(PAYMENTS, 1n, {
      domain: { name: 'USD Coin', chainId: 1, verifyingContract: USDC },
    });
    expect(evaluateTypedData(req, policy, emptyIntel()).decision).toBe('BLOCK');
  });

  it('treats malformed permit fields as undecodable, not harmless', () => {
    const req = erc2612(PAYMENTS, 1n);
    req.message.value = { sneaky: 'object' };
    const v = evaluateTypedData(req, policy, emptyIntel());
    expect(v.decision).not.toBe('ALLOW');
    expect(v.reasons[0].ruleId).toBe('typed-data-decode');
  });
});

describe('SentinelTypedDataSigner', () => {
  it('signs in-policy permits, blocks the drain before the signer', async () => {
    let signed = 0;
    const inner = {
      signTypedData: async () => {
        signed += 1;
        return ('0x' + 'cd'.repeat(65)) as Hex;
      },
    };
    const guarded = new SentinelTypedDataSigner(inner, policy, emptyIntel(), new RejectingEscalator());

    await guarded.signTypedData(erc2612(PAYMENTS, 100_000_000n));
    expect(signed).toBe(1);

    await expect(guarded.signTypedData(erc2612(DRAINER, INFINITE_APPROVAL))).rejects.toThrow(
      SentinelBlockedError
    );
    expect(signed).toBe(1);
  });
});
