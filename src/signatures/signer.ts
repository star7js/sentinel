import { CompiledPolicy, Hex, ThreatIntel, TxRequest } from '../types.js';
import { Escalator, SentinelBlockedError } from '../signer/proxy.js';
import { evaluateTypedData, TypedDataRequest } from './typed-data.js';

export interface UnderlyingTypedDataSigner {
  signTypedData(req: TypedDataRequest): Promise<Hex>;
}

/**
 * Wrap whatever your framework uses to sign EIP-712 typed data, exactly like
 * SentinelSigner wraps the transaction signer:
 *
 *   const guarded = new SentinelTypedDataSigner(rawSigner, policy, intel, escalator);
 *   await guarded.signTypedData(request); // throws SentinelBlockedError on violation
 *
 * Escalations reuse the Escalator interface; the TxRequest handed to it is
 * synthetic (typed data has no transaction), but the rule summaries carry
 * the real story — "grants UNLIMITED spending of … to …".
 */
export class SentinelTypedDataSigner implements UnderlyingTypedDataSigner {
  constructor(
    private inner: UnderlyingTypedDataSigner,
    private policy: CompiledPolicy,
    private intel: ThreatIntel,
    private escalator: Escalator
  ) {}

  async signTypedData(req: TypedDataRequest): Promise<Hex> {
    const verdict = evaluateTypedData(req, this.policy, this.intel);

    if (verdict.decision === 'BLOCK') throw new SentinelBlockedError(verdict);

    if (verdict.decision === 'ESCALATE') {
      const syntheticTx: TxRequest = {
        chainId: Number(req.domain.chainId ?? 0),
        from: '0x0000000000000000000000000000000000000000',
        to: (req.domain.verifyingContract as TxRequest['to']) ?? null,
        value: 0n,
        data: '0x',
      };
      const approved = await this.escalator.requestApproval(syntheticTx, verdict);
      if (!approved) throw new SentinelBlockedError(verdict);
    }

    return this.inner.signTypedData(req);
  }
}
