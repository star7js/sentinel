import { parse } from 'yaml';
import { z } from 'zod';
import { parseEther, parseUnits } from 'viem';
import { CompiledPolicy, Decision } from '../types.js';

const decision = z.enum(['allow', 'block', 'escalate']);
const nonAllow = z.enum(['block', 'escalate']);

const schema = z.object({
  schemaVersion: z.literal(1),
  defaults: z.object({
    unknownContract: decision,
    onSimulationFailure: nonAllow,
    contractCreation: nonAllow.default('escalate'),
  }),
  chains: z.object({ allowed: z.array(z.number()) }),
  contracts: z.object({
    allow: z.array(z.object({ address: z.string(), label: z.string() })).default([]),
    block: z.array(z.string()).default([]),
  }),
  spend: z.object({
    perTx: z.object({ native: z.string(), erc20: z.record(z.string()).default({}) }),
    perSession: z.object({ native: z.string(), erc20: z.record(z.string()).default({}) }),
    sessionDuration: z.number(),
  }),
  approvals: z.object({
    maxAmount: z.record(z.string()).default({}),
    infinite: nonAllow,
  }),
  delegations: z.object({
    allow: z.array(z.string()).default([]),
    default: nonAllow,
  }),
  time: z
    .object({
      activeHours: z
        .object({
          start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM'),
          end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM'),
          tz: z.string().min(1),
        })
        .nullable(),
    })
    .default({ activeHours: null }),
});

const toDecision = (d: string): Decision => d.toUpperCase() as Decision;

function parseNative(s: string): bigint {
  const m = s.trim().match(/^([\d.]+)\s*ether$/i);
  return m ? parseEther(m[1]) : BigInt(s);
}

/**
 * Compile a raw YAML policy. `tokenMeta` maps label → { address, decimals },
 * resolved once at startup (decimals pinned, never fetched at eval time).
 */
export function compilePolicy(
  yamlText: string,
  tokenMeta: Record<string, { address: string; decimals: number }>
): CompiledPolicy {
  const raw = schema.parse(parse(yamlText));

  const tokenAmounts = (rec: Record<string, string>) => {
    const m = new Map<string, bigint>();
    for (const [label, amount] of Object.entries(rec)) {
      const meta = tokenMeta[label];
      if (!meta) throw new Error(`Policy references token label "${label}" with no metadata provided.`);
      m.set(meta.address.toLowerCase(), parseUnits(amount, meta.decimals));
    }
    return m;
  };

  return {
    schemaVersion: 1,
    defaults: {
      unknownContract: toDecision(raw.defaults.unknownContract),
      onSimulationFailure: toDecision(raw.defaults.onSimulationFailure) as 'BLOCK' | 'ESCALATE',
      contractCreation: toDecision(raw.defaults.contractCreation) as 'BLOCK' | 'ESCALATE',
    },
    chainsAllowed: raw.chains.allowed,
    contractAllow: new Map(raw.contracts.allow.map((c) => [c.address.toLowerCase(), c.label])),
    contractBlock: new Set(raw.contracts.block.map((a) => a.toLowerCase())),
    spend: {
      perTxNative: parseNative(raw.spend.perTx.native),
      perTxToken: tokenAmounts(raw.spend.perTx.erc20),
      perSessionNative: parseNative(raw.spend.perSession.native),
      perSessionToken: tokenAmounts(raw.spend.perSession.erc20),
      sessionDuration: raw.spend.sessionDuration,
    },
    approvals: {
      maxAmount: tokenAmounts(raw.approvals.maxAmount),
      infinite: toDecision(raw.approvals.infinite) as 'BLOCK' | 'ESCALATE',
    },
    delegations: {
      allow: new Set(raw.delegations.allow.map((a) => a.toLowerCase())),
      defaultDecision: toDecision(raw.delegations.default) as 'BLOCK' | 'ESCALATE',
    },
    activeHours: raw.time.activeHours,
  };
}
