import {
  CompiledPolicy,
  Decision,
  RuleResult,
  SessionState,
  SimulatedEffects,
  ThreatIntel,
  TxRequest,
  Verdict,
  INFINITE_APPROVAL,
} from '../types.js';

type Rule = (
  tx: TxRequest,
  effects: SimulatedEffects | null,
  policy: CompiledPolicy,
  state: SessionState,
  intel: ThreatIntel
) => RuleResult;

const lc = (a: string) => a.toLowerCase();

const chainAllowed: Rule = (tx, _e, p) => ({
  ruleId: 'chain-allowed',
  decision: p.chainsAllowed.includes(tx.chainId) ? 'ALLOW' : 'BLOCK',
  humanSummary: p.chainsAllowed.includes(tx.chainId)
    ? `Chain ${tx.chainId} is permitted.`
    : `Chain ${tx.chainId} is not in the allowed list.`,
});

const intelBlocklist: Rule = (tx, effects, _p, _s, intel) => {
  const touched = new Set<string>();
  if (tx.to) touched.add(lc(tx.to));
  effects?.contractsTouched.forEach((a) => touched.add(lc(a)));
  const hit = [...touched].find((a) => intel.blocked.has(a));
  return {
    ruleId: 'intel-blocklist',
    decision: hit ? 'BLOCK' : 'ALLOW',
    humanSummary: hit
      ? `Address ${hit} appears on a known drainer/scam blocklist.`
      : 'No touched address appears on threat feeds.',
  };
};

const contractAllowlist: Rule = (tx, effects, p) => {
  const touched = new Set<string>();
  if (tx.to) touched.add(lc(tx.to));
  effects?.contractsTouched.forEach((a) => touched.add(lc(a)));
  const blocked = [...touched].find((a) => p.contractBlock.has(a));
  if (blocked) {
    return {
      ruleId: 'contract-allowlist',
      decision: 'BLOCK',
      humanSummary: `Contract ${blocked} is explicitly blocked by policy.`,
    };
  }
  const unknown = [...touched].filter((a) => !p.contractAllow.has(a));
  if (unknown.length > 0) {
    return {
      ruleId: 'contract-allowlist',
      decision: p.defaults.unknownContract,
      humanSummary: `Unrecognized contract(s): ${unknown.join(', ')}.`,
    };
  }
  return {
    ruleId: 'contract-allowlist',
    decision: 'ALLOW',
    humanSummary: 'All touched contracts are on the allowlist.',
  };
};

const revertCheck: Rule = (_tx, effects) => {
  if (effects === null) {
    return { ruleId: 'revert-check', decision: 'ALLOW', humanSummary: 'No simulation available (handled by simulation-failure default).' };
  }
  return {
    ruleId: 'revert-check',
    decision: effects.reverted ? 'BLOCK' : 'ALLOW',
    humanSummary: effects.reverted
      ? 'Simulation shows this transaction would revert.'
      : 'Simulation succeeded without revert.',
  };
};

/** Net outflows from `from` per token, from simulated effects; falls back to tx.value. */
function outflows(tx: TxRequest, effects: SimulatedEffects | null): Map<string, bigint> {
  const out = new Map<string, bigint>();
  if (effects) {
    for (const d of effects.balanceDiffs) {
      if (lc(d.address) !== lc(tx.from) || d.delta >= 0n) continue;
      const key = d.token === 'native' ? 'native' : lc(d.token);
      out.set(key, (out.get(key) ?? 0n) + -d.delta);
    }
  } else {
    out.set('native', tx.value);
  }
  return out;
}

const spendPerTx: Rule = (tx, effects, p) => {
  for (const [token, amount] of outflows(tx, effects)) {
    const cap = token === 'native' ? p.spend.perTxNative : p.spend.perTxToken.get(token);
    if (cap !== undefined && amount > cap) {
      return {
        ruleId: 'spend-per-tx',
        decision: 'BLOCK',
        humanSummary: `Spends ${amount} of ${token}, above the per-transaction cap of ${cap}.`,
      };
    }
  }
  return { ruleId: 'spend-per-tx', decision: 'ALLOW', humanSummary: 'Within per-transaction spend caps.' };
};

const spendPerSession: Rule = (tx, effects, p, state) => {
  for (const [token, amount] of outflows(tx, effects)) {
    if (token === 'native') {
      if (state.spentBySession + amount > p.spend.perSessionNative) {
        return {
          ruleId: 'spend-per-session',
          decision: 'BLOCK',
          humanSummary: `Would exceed the native session cap (${p.spend.perSessionNative}).`,
        };
      }
    } else {
      const cap = p.spend.perSessionToken.get(token);
      const spent = state.spentByToken.get(token as `0x${string}`) ?? 0n;
      if (cap !== undefined && spent + amount > cap) {
        return {
          ruleId: 'spend-per-session',
          decision: 'BLOCK',
          humanSummary: `Would exceed the session cap for token ${token} (${cap}).`,
        };
      }
    }
  }
  return { ruleId: 'spend-per-session', decision: 'ALLOW', humanSummary: 'Within session spend caps.' };
};

const approvalLimits: Rule = (_tx, effects, p) => {
  if (!effects) return { ruleId: 'approval-limits', decision: 'ALLOW', humanSummary: 'No simulation; no approvals decoded.' };
  for (const a of effects.approvals) {
    if (a.amount === INFINITE_APPROVAL) {
      return {
        ruleId: 'approval-limits',
        decision: p.approvals.infinite,
        humanSummary: `Grants UNLIMITED spending of ${a.token} to ${a.spender}.`,
      };
    }
    const cap = p.approvals.maxAmount.get(lc(a.token));
    if (cap !== undefined && a.amount > cap) {
      return {
        ruleId: 'approval-limits',
        decision: 'BLOCK',
        humanSummary: `Approval of ${a.amount} on ${a.token} exceeds the cap of ${cap}.`,
      };
    }
  }
  return { ruleId: 'approval-limits', decision: 'ALLOW', humanSummary: 'Approvals within limits.' };
};

const delegationCheck: Rule = (tx, effects, p) => {
  const delegates = new Set<string>();
  tx.authorizationList?.forEach((a) => delegates.add(lc(a.address)));
  effects?.delegations.forEach((d) => delegates.add(lc(d.delegate)));
  const bad = [...delegates].find((d) => !p.delegations.allow.has(d));
  if (bad) {
    return {
      ruleId: 'delegation-check',
      decision: p.delegations.defaultDecision,
      humanSummary: `Sets an EIP-7702 delegation to unapproved contract ${bad}. This hands account control to that code.`,
    };
  }
  return { ruleId: 'delegation-check', decision: 'ALLOW', humanSummary: 'No unapproved delegations.' };
};

const RULES: Rule[] = [
  chainAllowed,
  intelBlocklist,
  contractAllowlist,
  revertCheck,
  spendPerTx,
  spendPerSession,
  approvalLimits,
  delegationCheck,
];

export function evaluate(
  tx: TxRequest,
  effects: SimulatedEffects | null,
  policy: CompiledPolicy,
  state: SessionState,
  intel: ThreatIntel
): Verdict {
  const reasons: RuleResult[] = [];

  // Simulation-failure default applies before rules that depend on effects.
  if (effects === null && policy.defaults.onSimulationFailure) {
    reasons.push({
      ruleId: 'simulation-availability',
      decision: policy.defaults.onSimulationFailure,
      humanSummary: 'Simulation was unavailable; effects could not be verified.',
    });
  }

  for (const rule of RULES) {
    let result: RuleResult;
    try {
      result = rule(tx, effects, policy, state, intel);
    } catch (err) {
      // Deny-on-error is non-negotiable: a throwing rule can never degrade to ALLOW.
      result = {
        ruleId: 'internal-error',
        decision: 'ESCALATE',
        humanSummary: `A policy rule failed to execute: ${(err as Error).message}`,
      };
    }
    reasons.push(result);
    if (result.decision === 'BLOCK') {
      return { decision: 'BLOCK', reasons };
    }
  }

  const decision: Decision = reasons.some((r) => r.decision === 'ESCALATE') ? 'ESCALATE' : 'ALLOW';
  return { decision, reasons };
}
