import { SimulatedEffects, TxRequest } from '../types.js';

/**
 * M2: Fork simulation via Anvil.
 *
 * Plan:
 *  - Spawn/attach to `anvil --fork-url <rpc>` for the target chain.
 *  - Use anvil_impersonateAccount + eth_call/debug_traceCall with state overrides.
 *  - Decode effects:
 *      balanceDiffs: pre/post eth_getBalance + ERC20 balanceOf via trace state diffs
 *      approvals:    Approval(address,address,uint256) logs
 *      delegations:  EIP-7702 authorization outcomes / code changes on `from`
 *      contractsTouched: unique `to` addresses in the call trace
 *  - Never let a simulation error surface as effects; return null and let
 *    the engine's onSimulationFailure default apply.
 */
export interface Simulator {
  simulate(tx: TxRequest): Promise<SimulatedEffects | null>;
}

/** Placeholder so the pipeline runs end-to-end before M2 lands. */
export class NoopSimulator implements Simulator {
  async simulate(_tx: TxRequest): Promise<SimulatedEffects | null> {
    return null; // engine treats this per policy.defaults.onSimulationFailure
  }
}
