export type Address = `0x${string}`;
export type Hex = `0x${string}`;

export type Decision = 'ALLOW' | 'BLOCK' | 'ESCALATE';

export interface Eip7702Authorization {
  chainId: number;
  address: Address; // delegate
  nonce: number;
}

export interface TxRequest {
  chainId: number;
  from: Address;
  to: Address | null;
  value: bigint;
  data: Hex;
  nonce?: number;
  authorizationList?: Eip7702Authorization[];
}

export interface BalanceDiff {
  address: Address;
  token: Address | 'native';
  delta: bigint;
}

export interface ApprovalEffect {
  token: Address;
  spender: Address;
  amount: bigint;
}

export interface DelegationEffect {
  authority: Address;
  delegate: Address;
}

/** ERC-721/1155 setApprovalForAll: operator control over an entire collection. */
export interface OperatorApprovalEffect {
  token: Address;
  operator: Address;
  approved: boolean;
}

export interface SimulatedEffects {
  balanceDiffs: BalanceDiff[];
  approvals: ApprovalEffect[];
  approvalsForAll: OperatorApprovalEffect[];
  delegations: DelegationEffect[];
  contractsTouched: Address[];
  reverted: boolean;
}

export interface SessionState {
  sessionStart: number;
  spentBySession: bigint;
  spentByToken: Map<Address, bigint>;
  txCount: number;
}

export interface RuleResult {
  ruleId: string;
  decision: Decision;
  humanSummary: string;
}

export interface Verdict {
  decision: Decision;
  reasons: RuleResult[];
}

export interface ThreatIntel {
  /** Addresses known-malicious. Injected as data; the engine does no I/O. */
  blocked: Set<string>; // lowercase addresses
}

export interface CompiledPolicy {
  schemaVersion: 1;
  defaults: {
    unknownContract: Decision;
    onSimulationFailure: Exclude<Decision, 'ALLOW'>;
    contractCreation: Exclude<Decision, 'ALLOW'>;
  };
  chainsAllowed: number[];
  contractAllow: Map<string, string>; // lowercase address → label
  contractBlock: Set<string>;
  spend: {
    perTxNative: bigint;
    perTxToken: Map<string, bigint>; // lowercase token address → raw amount
    perSessionNative: bigint;
    perSessionToken: Map<string, bigint>;
    sessionDuration: number;
  };
  approvals: {
    maxAmount: Map<string, bigint>;
    infinite: Exclude<Decision, 'ALLOW'>;
  };
  delegations: {
    allow: Set<string>; // lowercase delegate addresses
    defaultDecision: Exclude<Decision, 'ALLOW'>;
  };
  activeHours: { start: string; end: string; tz: string } | null;
}

export const INFINITE_APPROVAL = (1n << 256n) - 1n;
