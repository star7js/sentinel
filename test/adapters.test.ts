import { describe, it, expect } from 'vitest';
import { fromViemWalletClient, fromViemTypedDataSigner } from '../src/adapters/viem.js';
import { fromEthersSigner, fromEthersTypedDataSigner } from '../src/adapters/ethers.js';
import { decodeTypedData, TypedDataRequest } from '../src/signatures/typed-data.js';
import { Address, Hex, INFINITE_APPROVAL } from '../src/types.js';

const BOB = '0x2222222222222222222222222222222222222222' as Address;
const SEAPORT = '0x0000000000000068F116a894984e2DB1123eB395' as Address;
const NFT = '0x4444444444444444444444444444444444444444' as Address;
const WETH = '0x5555555555555555555555555555555555555555' as Address;

describe('viem adapter', () => {
  it('maps TxRequest onto sendTransaction', async () => {
    let seen: Record<string, unknown> | null = null;
    const signer = fromViemWalletClient({
      sendTransaction: async (args) => {
        seen = args;
        return '0xhash' as Hex;
      },
    });
    await signer.signAndSend({ chainId: 8453, from: BOB, to: BOB, value: 5n, data: '0xaa' });
    expect(seen).toMatchObject({ to: BOB, value: 5n, data: '0xaa' });
  });

  it('passes typed data through and requires signTypedData support', async () => {
    const req = { domain: {}, types: {}, primaryType: 'Permit', message: {} };
    const ok = fromViemTypedDataSigner({
      sendTransaction: async () => '0x' as Hex,
      signTypedData: async (args) => (args.primaryType === 'Permit' ? '0xsig' : '0xno') as Hex,
    });
    expect(await ok.signTypedData(req)).toBe('0xsig');

    const missing = fromViemTypedDataSigner({ sendTransaction: async () => '0x' as Hex });
    await expect(missing.signTypedData(req)).rejects.toThrow(/signTypedData/);
  });
});

describe('ethers adapter', () => {
  it('maps TxRequest onto sendTransaction and returns the hash', async () => {
    let seen: Record<string, unknown> | null = null;
    const signer = fromEthersSigner({
      sendTransaction: async (tx) => {
        seen = tx;
        return { hash: '0xhash' };
      },
    });
    const hash = await signer.signAndSend({
      chainId: 8453, from: BOB, to: BOB, value: 5n, data: '0xaa',
    });
    expect(hash).toBe('0xhash');
    expect(seen).toMatchObject({ to: BOB, value: 5n, data: '0xaa' });
  });

  it('refuses 7702 authorization lists instead of dropping them', async () => {
    const signer = fromEthersSigner({ sendTransaction: async () => ({ hash: '0x' }) });
    await expect(
      signer.signAndSend({
        chainId: 8453, from: BOB, to: BOB, value: 0n, data: '0x',
        authorizationList: [{ chainId: 8453, address: BOB, nonce: 0 }],
      })
    ).rejects.toThrow(/7702/);
  });

  it('strips EIP712Domain from the types for signTypedData', async () => {
    let seenTypes: Record<string, unknown> | null = null;
    const signer = fromEthersTypedDataSigner({
      sendTransaction: async () => ({ hash: '0x' }),
      signTypedData: async (_d, types) => {
        seenTypes = types;
        return '0xsig';
      },
    });
    await signer.signTypedData({
      domain: {},
      types: { EIP712Domain: [], Permit: [{ name: 'owner', type: 'address' }] },
      primaryType: 'Permit',
      message: {},
    });
    expect(seenTypes).toEqual({ Permit: [{ name: 'owner', type: 'address' }] });
  });
});

describe('Seaport order decoding', () => {
  const order = (offer: unknown[]): TypedDataRequest => ({
    domain: { name: 'Seaport', version: '1.6', chainId: 8453, verifyingContract: SEAPORT },
    types: {},
    primaryType: 'OrderComponents',
    message: {
      offerer: BOB,
      offer,
      consideration: [],
      startTime: 0,
      endTime: 9999999999,
      counter: 0,
    },
  });

  it('models offer items as approvals to an unknowable counterparty', () => {
    const decoded = decodeTypedData(
      order([
        { itemType: 2, token: NFT, identifierOrCriteria: 7, startAmount: '1', endAmount: '1' },
        { itemType: 1, token: WETH, identifierOrCriteria: 0, startAmount: '100', endAmount: '250' },
      ])
    );
    expect(decoded).not.toBeNull();
    expect(decoded!.owner).toBe(BOB);
    expect(decoded!.approvals).toContainEqual({
      token: NFT.toLowerCase(),
      spender: '0x0000000000000000000000000000000000000000',
      amount: 1n,
    });
    // Ascending-amount items decode at their maximum.
    expect(decoded!.approvals).toContainEqual({
      token: WETH.toLowerCase(),
      spender: '0x0000000000000000000000000000000000000000',
      amount: 250n,
    });
  });

  it('treats malformed offers as undecodable, huge amounts as data', () => {
    expect(decodeTypedData(order([{ token: 'not-an-address', startAmount: '1' }]))).toBeNull();
    expect(decodeTypedData(order([{ token: NFT, startAmount: '1' }]))).toBeNull(); // no endAmount
    const huge = order([
      { token: NFT, startAmount: INFINITE_APPROVAL.toString(), endAmount: INFINITE_APPROVAL.toString() },
    ]);
    expect(decodeTypedData(huge)!.approvals[0].amount).toBe(INFINITE_APPROVAL);
  });
});
