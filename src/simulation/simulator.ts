import { SimulatedEffects, TxRequest } from '../types.js';

/**
 * A simulator executes the transaction ahead of signing and reports what it
 * would actually do. `AnvilSimulator` (./anvil.ts) is the real implementation:
 * fork simulation with effect decoding.
 *
 * Contract: never let a simulation error surface as effects; return null and
 * let the engine's onSimulationFailure default apply.
 */
export interface Simulator {
  simulate(tx: TxRequest): Promise<SimulatedEffects | null>;
}

/** No-op fallback: reports simulation as unavailable, so the engine's
 * onSimulationFailure default (block/escalate) applies to every tx. */
export class NoopSimulator implements Simulator {
  async simulate(_tx: TxRequest): Promise<SimulatedEffects | null> {
    return null;
  }
}
