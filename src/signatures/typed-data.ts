import { evaluate } from '../policy/engine.js';
import {
  Address,
  ApprovalEffect,
  CompiledPolicy,
  INFINITE_APPROVAL,
  SessionState,
  SimulatedEffects,
  ThreatIntel,
  TxRequest,
  Verdict,
} from '../types.js';

/**
 * v0.2: signature guarding.
 *
 * Most real-world wallet drains never need a transaction from the victim:
 * the attacker obtains a signed EIP-712 message — an ERC-2612 permit, a
 * Permit2 grant, a marketplace order — and submits it themselves, paying the
 * gas. An agent framework that exposes signTypedData to the model has a
 * back door around any transaction-level firewall.
 *
 * This module closes it by decoding known permit shapes into the same
 * ApprovalEffect model the engine already polices, then reusing the exact
 * rule pipeline (chain, intel, allowlist, approval limits, time window).
 * Anything it cannot confidently decode is treated like a failed simulation:
 * the policy's onSimulationFailure default applies — never a silent ALLOW.
 */

export interface TypedDataDomain {
  name?: string;
  version?: string;
  chainId?: number | bigint | string;
  verifyingContract?: string;
  salt?: string;
}

export interface TypedDataRequest {
  domain: TypedDataDomain;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

const isAddress = (v: unknown): v is Address =>
  typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);

function toBigInt(v: unknown): bigint | null {
  try {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
    if (typeof v === 'string' && v !== '') return BigInt(v);
    return null;
  } catch {
    return null;
  }
}

export interface DecodedTypedData {
  /** Who is granting authority (permit owner/holder), if identifiable. */
  owner: Address;
  /** Contracts whose allow-listing this signature depends on. */
  contractsInvolved: Address[];
  approvals: ApprovalEffect[];
}

/**
 * Decode known drain-capable typed-data shapes into approval effects.
 * Returns null for anything unrecognized or malformed — the caller treats
 * that as unverifiable (deny-safe), never as harmless.
 */
export function decodeTypedData(req: TypedDataRequest): DecodedTypedData | null {
  const m = req.message;
  const verifying = isAddress(req.domain.verifyingContract)
    ? (req.domain.verifyingContract.toLowerCase() as Address)
    : null;

  // ERC-2612 permit: approval on the token that verifies the signature.
  if (req.primaryType === 'Permit' && isAddress(m.owner) && isAddress(m.spender)) {
    const value = toBigInt(m.value);
    if (value === null || !verifying) return null;
    return {
      owner: m.owner,
      contractsInvolved: [verifying, m.spender],
      approvals: [{ token: verifying, spender: m.spender, amount: value }],
    };
  }

  // DAI-style permit: boolean `allowed` is an all-or-nothing approval.
  if (req.primaryType === 'Permit' && isAddress(m.holder) && isAddress(m.spender)) {
    if (typeof m.allowed !== 'boolean' || !verifying) return null;
    return {
      owner: m.holder,
      contractsInvolved: [verifying, m.spender],
      approvals: [
        { token: verifying, spender: m.spender, amount: m.allowed ? INFINITE_APPROVAL : 0n },
      ],
    };
  }

  // Permit2 AllowanceTransfer: single and batch grants.
  if (req.primaryType === 'PermitSingle' || req.primaryType === 'PermitBatch') {
    if (!isAddress(m.spender)) return null;
    const details = req.primaryType === 'PermitSingle' ? [m.details] : m.details;
    if (!Array.isArray(details)) return null;
    const approvals: ApprovalEffect[] = [];
    const contracts: Address[] = verifying ? [verifying, m.spender] : [m.spender];
    for (const d of details) {
      const entry = d as { token?: unknown; amount?: unknown };
      const amount = toBigInt(entry.amount);
      if (!isAddress(entry.token) || amount === null) return null;
      // Permit2 amounts are uint160; its max value is "unlimited" in practice.
      const MAX_UINT160 = (1n << 160n) - 1n;
      approvals.push({
        token: entry.token.toLowerCase() as Address,
        spender: m.spender,
        amount: amount === MAX_UINT160 ? INFINITE_APPROVAL : amount,
      });
      contracts.push(entry.token.toLowerCase() as Address);
    }
    return { owner: ZERO_ADDRESS, contractsInvolved: contracts, approvals };
  }

  // Permit2 SignatureTransfer: authorizes whoever redeems it — the spender is
  // not in the payload, so it can never be verified against an allowlist.
  if (req.primaryType === 'PermitTransferFrom' || req.primaryType === 'PermitBatchTransferFrom') {
    const permitted =
      req.primaryType === 'PermitTransferFrom' ? [m.permitted] : m.permitted;
    if (!Array.isArray(permitted)) return null;
    const approvals: ApprovalEffect[] = [];
    const contracts: Address[] = verifying ? [verifying, ZERO_ADDRESS] : [ZERO_ADDRESS];
    for (const p of permitted) {
      const entry = p as { token?: unknown; amount?: unknown };
      const amount = toBigInt(entry.amount);
      if (!isAddress(entry.token) || amount === null) return null;
      approvals.push({
        token: entry.token.toLowerCase() as Address,
        spender: ZERO_ADDRESS, // unknowable redeemer → fails every allowlist
        amount,
      });
      contracts.push(entry.token.toLowerCase() as Address);
    }
    return { owner: ZERO_ADDRESS, contractsInvolved: contracts, approvals };
  }

  return null;
}

const zeroState = (): SessionState => ({
  sessionStart: 0,
  spentBySession: 0n,
  spentByToken: new Map(),
  txCount: 0,
});

/**
 * Evaluate a typed-data signing request against the policy, reusing the
 * transaction rule pipeline on the decoded effects. Verdict semantics match
 * evaluate(): first BLOCK wins, ESCALATE accumulates.
 */
export function evaluateTypedData(
  req: TypedDataRequest,
  policy: CompiledPolicy,
  intel: ThreatIntel,
  nowMs: number = Date.now()
): Verdict {
  const chainId = toBigInt(req.domain.chainId ?? null);
  if (chainId === null) {
    return {
      decision: 'BLOCK',
      reasons: [
        {
          ruleId: 'typed-data-domain',
          decision: 'BLOCK',
          humanSummary:
            'Typed data has no chainId in its domain — the signature would be replayable on every chain.',
        },
      ],
    };
  }

  const decoded = decodeTypedData(req);
  if (decoded === null) {
    return {
      decision: policy.defaults.onSimulationFailure === 'BLOCK' ? 'BLOCK' : 'ESCALATE',
      reasons: [
        {
          ruleId: 'typed-data-decode',
          decision: policy.defaults.onSimulationFailure,
          humanSummary: `Unrecognized typed data "${req.primaryType}" — its effects cannot be verified.`,
        },
      ],
    };
  }

  const syntheticTx: TxRequest = {
    chainId: Number(chainId),
    from: decoded.owner,
    to: decoded.contractsInvolved[0] ?? ZERO_ADDRESS,
    value: 0n,
    data: '0x',
  };
  const effects: SimulatedEffects = {
    balanceDiffs: [],
    approvals: decoded.approvals,
    approvalsForAll: [],
    delegations: [],
    contractsTouched: decoded.contractsInvolved,
    reverted: false,
  };
  return evaluate(syntheticTx, effects, policy, zeroState(), intel, nowMs);
}
