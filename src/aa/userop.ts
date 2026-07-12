import { Address, CompiledPolicy, Hex, ThreatIntel, TxRequest } from '../types.js';
import { Escalator, SentinelSigner, UnderlyingSigner } from '../signer/proxy.js';
import { Simulator } from '../simulation/simulator.js';
import { SessionStore } from '../state/store.js';

/**
 * ERC-4337 guarding.
 *
 * A userOperation executes as EntryPoint → smart account → target, so the
 * transaction sender (EntryPoint) is not the account whose funds are at
 * stake. Sentinel models this with TxRequest.onBehalfOf: the fork simulation
 * impersonates the EntryPoint calling the account's callData — exactly what
 * execution does on-chain — while spend caps and session accounting attribute
 * to the smart account.
 *
 * Note: the account contract must exist on the fork (deployed accounts).
 * initCode/factory deployments decode to nothing verifiable and therefore
 * fail simulation → the policy's onSimulationFailure default applies.
 */

/** EntryPoint v0.7 (same address on all major chains). */
export const ENTRYPOINT_V07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Address;
/** EntryPoint v0.6. */
export const ENTRYPOINT_V06 = '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789' as Address;

/** The fields Sentinel needs; pass your full userOp, extras are ignored. */
export interface UserOperationLike {
  sender: Address;
  callData: Hex;
  [key: string]: unknown;
}

export interface UserOpContext {
  chainId: number;
  /** Default: EntryPoint v0.7. */
  entryPoint?: Address;
}

/** Build the simulation request for a userOp's execution phase. */
export function userOpToTxRequest(userOp: UserOperationLike, ctx: UserOpContext): TxRequest {
  return {
    chainId: ctx.chainId,
    from: ctx.entryPoint ?? ENTRYPOINT_V07,
    to: userOp.sender,
    value: 0n,
    data: userOp.callData,
    onBehalfOf: userOp.sender,
  };
}

export interface UnderlyingUserOpSender {
  /** Submit to your bundler; return the userOpHash. */
  sendUserOperation(userOp: UserOperationLike): Promise<Hex>;
}

/**
 * Wrap your bundler client the same one-line way SentinelSigner wraps a
 * signer:
 *
 *   const guarded = new SentinelUserOpSender(bundler, { chainId: 8453 },
 *                                            policy, simulator, intel, escalator);
 *   await guarded.sendUserOperation(userOp); // throws SentinelBlockedError on violation
 */
export class SentinelUserOpSender implements UnderlyingUserOpSender {
  private guard: SentinelSigner;
  private pending: UserOperationLike | null = null;

  constructor(
    inner: UnderlyingUserOpSender,
    private ctx: UserOpContext,
    policy: CompiledPolicy,
    simulator: Simulator,
    intel: ThreatIntel,
    escalator: Escalator,
    store?: SessionStore
  ) {
    // Compose with SentinelSigner so simulation, evaluation, escalation, and
    // post-send session accounting are shared, not duplicated.
    const adapter: UnderlyingSigner = {
      signAndSend: async (): Promise<Hex> => inner.sendUserOperation(this.pending!),
    };
    this.guard = new SentinelSigner(adapter, policy, simulator, intel, escalator, store);
  }

  async sendUserOperation(userOp: UserOperationLike): Promise<Hex> {
    this.pending = userOp;
    try {
      return await this.guard.signAndSend(userOpToTxRequest(userOp, this.ctx));
    } finally {
      this.pending = null;
    }
  }
}
