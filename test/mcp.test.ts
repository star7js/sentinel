import { describe, it, expect } from 'vitest';
import { handleMcpMessage, McpWalletOptions } from '../src/mcp/server.js';
import { SentinelBlockedError } from '../src/signer/proxy.js';
import { Address, Hex, TxRequest, Verdict } from '../src/types.js';

const AGENT = '0x1111111111111111111111111111111111111111' as Address;
const BOB = '0x2222222222222222222222222222222222222222' as Address;

const blockedVerdict: Verdict = {
  decision: 'BLOCK',
  reasons: [
    {
      ruleId: 'approval-limits',
      decision: 'BLOCK',
      humanSummary: 'Grants UNLIMITED spending of tokens to a drainer.',
    },
  ],
};

function walletOpts(over: Partial<McpWalletOptions> = {}): McpWalletOptions {
  return {
    signer: { signAndSend: async () => ('0x' + 'ab'.repeat(32)) as Hex },
    typedDataSigner: { signTypedData: async () => ('0x' + 'cd'.repeat(65)) as Hex },
    chainId: 8453,
    from: AGENT,
    ...over,
  };
}

const call = (opts: McpWalletOptions, method: string, params?: Record<string, unknown>) =>
  handleMcpMessage(opts, { jsonrpc: '2.0', id: 1, method, params });

describe('MCP wallet server', () => {
  it('answers initialize with tool capabilities', async () => {
    const res = (await call(walletOpts(), 'initialize', { protocolVersion: '2024-11-05' })) as {
      result: { serverInfo: { name: string }; capabilities: { tools: object } };
    };
    expect(res.result.serverInfo.name).toBe('sentinel-wallet');
    expect(res.result.capabilities.tools).toBeDefined();
  });

  it('lists send_transaction and sign_typed_data tools', async () => {
    const res = (await call(walletOpts(), 'tools/list')) as {
      result: { tools: { name: string }[] };
    };
    expect(res.result.tools.map((t) => t.name)).toEqual(['send_transaction', 'sign_typed_data']);
  });

  it('omits sign_typed_data when no typed-data signer is configured', async () => {
    const res = (await call(walletOpts({ typedDataSigner: undefined }), 'tools/list')) as {
      result: { tools: { name: string }[] };
    };
    expect(res.result.tools.map((t) => t.name)).toEqual(['send_transaction']);
  });

  it('sends a transaction through the guarded signer', async () => {
    let seen: TxRequest | null = null;
    const opts = walletOpts({
      signer: {
        signAndSend: async (tx) => {
          seen = tx;
          return ('0x' + 'ab'.repeat(32)) as Hex;
        },
      },
    });
    const res = (await call(opts, 'tools/call', {
      name: 'send_transaction',
      arguments: { to: BOB, value: '1000', data: '0x' },
    })) as { result: { content: { text: string }[]; isError: boolean } };
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toContain('Transaction sent: 0xabab');
    expect(seen!.to).toBe(BOB);
    expect(seen!.value).toBe(1000n);
    expect(seen!.from).toBe(AGENT);
  });

  it('returns the policy explanation to the model when blocked', async () => {
    const opts = walletOpts({
      signer: {
        signAndSend: async () => {
          throw new SentinelBlockedError(blockedVerdict);
        },
      },
    });
    const res = (await call(opts, 'tools/call', {
      name: 'send_transaction',
      arguments: { to: BOB },
    })) as { result: { content: { text: string }[]; isError: boolean } };
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('REFUSED by Sentinel');
    expect(res.result.content[0].text).toContain('UNLIMITED');
  });

  it('rejects malformed addresses without calling the signer', async () => {
    let called = 0;
    const opts = walletOpts({
      signer: {
        signAndSend: async () => {
          called += 1;
          return '0x00' as Hex;
        },
      },
    });
    const res = (await call(opts, 'tools/call', {
      name: 'send_transaction',
      arguments: { to: 'bob.eth' },
    })) as { result: { isError: boolean } };
    expect(res.result.isError).toBe(true);
    expect(called).toBe(0);
  });

  it('signs typed data through the guarded typed-data signer', async () => {
    const res = (await call(walletOpts(), 'tools/call', {
      name: 'sign_typed_data',
      arguments: { domain: { chainId: 8453 }, types: {}, primaryType: 'Permit', message: {} },
    })) as { result: { content: { text: string }[]; isError: boolean } };
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toContain('Signed: 0xcdcd');
  });

  it('ignores notifications and errors on unknown methods', async () => {
    expect(await call(walletOpts(), 'notifications/initialized')).toBeNull();
    const res = (await call(walletOpts(), 'no/such/method')) as { error: { code: number } };
    expect(res.error.code).toBe(-32601);
  });
});
