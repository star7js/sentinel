import { evaluate } from '../policy/engine.js';
import { Simulator } from '../simulation/simulator.js';
import {
  CompiledPolicy,
  SessionState,
  ThreatIntel,
  TxRequest,
  Verdict,
} from '../types.js';

export interface Escalator {
  /** Present the verdict to a human; resolve true to approve, false to reject. */
  requestApproval(tx: TxRequest, verdict: Verdict): Promise<boolean>;
}

/** Dev-mode escalator: logs and rejects. Replace with Telegram/webhook in M3. */
export class RejectingEscalator implements Escalator {
  async requestApproval(_tx: TxRequest, verdict: Verdict): Promise<boolean> {
    console.warn('[sentinel] ESCALATE (auto-rejected in dev mode):');
    for (const r of verdict.reasons.filter((x) => x.decision !== 'ALLOW')) {
      console.warn(`  - [${r.ruleId}] ${r.humanSummary}`);
    }
    return false;
  }
}

export class SentinelBlockedError extends Error {
  constructor(public verdict: Verdict) {
    super(
      'Transaction blocked by Sentinel: ' +
        verdict.reasons
          .filter((r) => r.decision !== 'ALLOW')
          .map((r) => r.humanSummary)
          .join(' | ')
    );
  }
}

export interface UnderlyingSigner {
  signAndSend(tx: TxRequest): Promise<`0x${string}`>; // returns tx hash
}

/**
 * The integration surface. Wrap any signer:
 *
 *   const guarded = new SentinelSigner(rawSigner, policy, simulator, intel, escalator);
 *   await guarded.signAndSend(tx); // throws SentinelBlockedError on violation
 */
export class SentinelSigner implements UnderlyingSigner {
  private state: SessionState;

  constructor(
    private inner: UnderlyingSigner,
    private policy: CompiledPolicy,
    private simulator: Simulator,
    private intel: ThreatIntel,
    private escalator: Escalator
  ) {
    this.state = this.freshSession();
  }

  private freshSession(): SessionState {
    return {
      sessionStart: Math.floor(Date.now() / 1000),
      spentBySession: 0n,
      spentByToken: new Map(),
      txCount: 0,
    };
  }

  private rollSessionIfExpired() {
    const now = Math.floor(Date.now() / 1000);
    if (now - this.state.sessionStart > this.policy.spend.sessionDuration) {
      this.state = this.freshSession();
    }
  }

  async signAndSend(tx: TxRequest): Promise<`0x${string}`> {
    this.rollSessionIfExpired();

    const effects = await this.simulator.simulate(tx);
    const verdict = evaluate(tx, effects, this.policy, this.state, this.intel);

    if (verdict.decision === 'BLOCK') throw new SentinelBlockedError(verdict);

    if (verdict.decision === 'ESCALATE') {
      const approved = await this.escalator.requestApproval(tx, verdict);
      if (!approved) throw new SentinelBlockedError(verdict);
    }

    const hash = await this.inner.signAndSend(tx);

    // Session accounting only after a successful send (see SPEC §5).
    this.state.txCount += 1;
    if (effects) {
      for (const d of effects.balanceDiffs) {
        if (d.address.toLowerCase() !== tx.from.toLowerCase() || d.delta >= 0n) continue;
        if (d.token === 'native') this.state.spentBySession += -d.delta;
        else {
          const k = d.token.toLowerCase() as `0x${string}`;
          this.state.spentByToken.set(k, (this.state.spentByToken.get(k) ?? 0n) + -d.delta);
        }
      }
    } else {
      this.state.spentBySession += tx.value;
    }

    return hash;
  }
}
