import { Address, Hex, TxRequest } from '../types.js';
import { UnderlyingSigner } from '../signer/proxy.js';
import { UnderlyingTypedDataSigner } from '../signatures/signer.js';
import { TypedDataRequest } from '../signatures/typed-data.js';

/**
 * viem adapters. Structurally typed: any viem WalletClient (with account and
 * chain set) satisfies these shapes, and nothing here imports viem, so the
 * adapter works across viem versions.
 */

export interface ViemWalletClientLike {
  // authorizationList is typed loosely so real viem clients (whose parameter
  // types are stricter) remain structurally assignable across versions.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendTransaction(args: any): Promise<Hex>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  signTypedData?(args: any): Promise<Hex>;
}

/** Wrap a viem WalletClient as the transaction signer Sentinel guards. */
export function fromViemWalletClient(client: ViemWalletClientLike): UnderlyingSigner {
  return {
    async signAndSend(tx: TxRequest): Promise<Hex> {
      return client.sendTransaction({
        to: tx.to ?? undefined,
        value: tx.value,
        data: tx.data,
        nonce: tx.nonce,
        authorizationList: tx.authorizationList,
      });
    },
  };
}

/** Wrap a viem WalletClient's signTypedData for SentinelTypedDataSigner. */
export function fromViemTypedDataSigner(client: ViemWalletClientLike): UnderlyingTypedDataSigner {
  return {
    async signTypedData(req: TypedDataRequest): Promise<Hex> {
      if (!client.signTypedData) {
        throw new Error('This viem client does not implement signTypedData.');
      }
      return client.signTypedData({
        domain: req.domain,
        types: req.types,
        primaryType: req.primaryType,
        message: req.message,
      });
    },
  };
}
