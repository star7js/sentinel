import { Hex, TxRequest } from '../types.js';
import { UnderlyingSigner } from '../signer/proxy.js';
import { UnderlyingTypedDataSigner } from '../signatures/signer.js';
import { TypedDataRequest } from '../signatures/typed-data.js';

/**
 * ethers v6 adapters. Structurally typed — nothing here imports ethers, so
 * there is no hard dependency; any ethers Signer connected to a provider
 * satisfies the shape.
 */

export interface EthersSignerLike {
  sendTransaction(tx: {
    to?: string;
    value?: bigint;
    data?: string;
    nonce?: number;
  }): Promise<{ hash: string }>;
  signTypedData?(
    domain: TypedDataRequest['domain'],
    types: Record<string, { name: string; type: string }[]>,
    message: Record<string, unknown>
  ): Promise<string>;
}

/** Wrap an ethers v6 Signer as the transaction signer Sentinel guards. */
export function fromEthersSigner(signer: EthersSignerLike): UnderlyingSigner {
  return {
    async signAndSend(tx: TxRequest): Promise<Hex> {
      if (tx.authorizationList?.length) {
        // ethers v6 has no first-class 7702 support; refusing beats dropping
        // the authorization list silently (which would change tx semantics).
        throw new Error('EIP-7702 authorization lists are not supported by the ethers adapter.');
      }
      const sent = await signer.sendTransaction({
        to: tx.to ?? undefined,
        value: tx.value,
        data: tx.data,
        nonce: tx.nonce,
      });
      return sent.hash as Hex;
    },
  };
}

/**
 * Wrap an ethers v6 Signer's signTypedData for SentinelTypedDataSigner.
 * Note: ethers derives the primary type from the types object and rejects
 * an EIP712Domain entry, so it is stripped here.
 */
export function fromEthersTypedDataSigner(signer: EthersSignerLike): UnderlyingTypedDataSigner {
  return {
    async signTypedData(req: TypedDataRequest): Promise<Hex> {
      if (!signer.signTypedData) {
        throw new Error('This ethers signer does not implement signTypedData.');
      }
      const { EIP712Domain: _stripped, ...types } = req.types;
      return (await signer.signTypedData(req.domain, types, req.message)) as Hex;
    },
  };
}
