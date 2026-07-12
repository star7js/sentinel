import { createInterface } from 'node:readline';
import { Address, Hex, TxRequest } from '../types.js';
import { SentinelBlockedError, UnderlyingSigner } from '../signer/proxy.js';
import { UnderlyingTypedDataSigner } from '../signatures/signer.js';
import { TypedDataRequest } from '../signatures/typed-data.js';

/**
 * A minimal MCP (Model Context Protocol) server that exposes a Sentinel-
 * guarded wallet as agent tools. The motivating attack for this project is a
 * malicious or compromised tool layer — so the wallet tool itself enforces
 * policy: a blocked transaction returns the human-readable rule summaries to
 * the model as a tool error instead of signing.
 *
 * Implements the stdio transport (newline-delimited JSON-RPC) by hand to
 * keep the library dependency-free. Wire any MCP client at it:
 *
 *   { "mcpServers": { "wallet": { "command": "npx", "args": ["sentinel-mcp"] } } }
 */

export interface McpWalletOptions {
  /** A guarded signer — pass a SentinelSigner (or anything UnderlyingSigner). */
  signer: UnderlyingSigner;
  /** Optional guarded typed-data signer; omit to not expose sign_typed_data. */
  typedDataSigner?: UnderlyingTypedDataSigner;
  /** Chain and account the send_transaction tool operates as. */
  chainId: number;
  from: Address;
  serverName?: string;
}

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS = (opts: McpWalletOptions): ToolDef[] => {
  const tools: ToolDef[] = [
    {
      name: 'send_transaction',
      description:
        'Send a transaction from the agent wallet. Guarded by Sentinel: transactions that violate policy, fail simulation, or touch known-malicious addresses are refused with an explanation.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: '0x-prefixed recipient address' },
          value: { type: 'string', description: 'Native value in wei (decimal string). Default "0".' },
          data: { type: 'string', description: '0x-prefixed calldata. Default "0x".' },
        },
        required: ['to'],
      },
    },
  ];
  if (opts.typedDataSigner) {
    tools.push({
      name: 'sign_typed_data',
      description:
        'Sign an EIP-712 typed-data payload with the agent wallet. Guarded by Sentinel: permits and orders that violate policy are refused with an explanation.',
      inputSchema: {
        type: 'object',
        properties: {
          domain: { type: 'object' },
          types: { type: 'object' },
          primaryType: { type: 'string' },
          message: { type: 'object' },
        },
        required: ['domain', 'types', 'primaryType', 'message'],
      },
    });
  }
  return tools;
};

const toolText = (text: string, isError = false) => ({
  content: [{ type: 'text', text }],
  isError,
});

async function callTool(
  opts: McpWalletOptions,
  name: string,
  args: Record<string, unknown>
): Promise<{ content: { type: string; text: string }[]; isError: boolean }> {
  try {
    if (name === 'send_transaction') {
      if (typeof args.to !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(args.to)) {
        return toolText('Invalid "to": expected a 0x-prefixed address.', true);
      }
      const tx: TxRequest = {
        chainId: opts.chainId,
        from: opts.from,
        to: args.to as Address,
        value: BigInt((args.value as string) ?? '0'),
        data: (typeof args.data === 'string' ? args.data : '0x') as Hex,
      };
      const hash = await opts.signer.signAndSend(tx);
      return toolText(`Transaction sent: ${hash}`);
    }
    if (name === 'sign_typed_data' && opts.typedDataSigner) {
      const signature = await opts.typedDataSigner.signTypedData(
        args as unknown as TypedDataRequest
      );
      return toolText(`Signed: ${signature}`);
    }
    return toolText(`Unknown tool: ${name}`, true);
  } catch (err) {
    if (err instanceof SentinelBlockedError) {
      return toolText(
        `REFUSED by Sentinel policy firewall:\n${err.verdict.reasons
          .filter((r) => r.decision !== 'ALLOW')
          .map((r) => `- [${r.ruleId}] ${r.humanSummary}`)
          .join('\n')}`,
        true
      );
    }
    return toolText(`Error: ${(err as Error).message}`, true);
  }
}

/**
 * Pure protocol handler (exported for tests): takes one JSON-RPC message,
 * returns the response message or null for notifications.
 */
export async function handleMcpMessage(
  opts: McpWalletOptions,
  msg: JsonRpcMessage
): Promise<JsonRpcMessage | null> {
  const respond = (result: unknown): JsonRpcMessage =>
    ({ jsonrpc: '2.0', id: msg.id ?? null, result }) as JsonRpcMessage;

  switch (msg.method) {
    case 'initialize':
      return respond({
        protocolVersion: (msg.params?.protocolVersion as string) ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: opts.serverName ?? 'sentinel-wallet', version: '0.3.0' },
      });
    case 'notifications/initialized':
      return null;
    case 'tools/list':
      return respond({ tools: TOOLS(opts) });
    case 'tools/call': {
      const name = msg.params?.name as string;
      const args = (msg.params?.arguments as Record<string, unknown>) ?? {};
      return respond(await callTool(opts, name, args));
    }
    case 'ping':
      return respond({});
    default:
      if (msg.id === undefined) return null; // unknown notification: ignore
      return {
        jsonrpc: '2.0',
        id: msg.id,
        // @ts-expect-error error responses carry no result member
        error: { code: -32601, message: `Method not found: ${msg.method}` },
      };
  }
}

/** Serve the wallet over stdio until stdin closes. */
export function runMcpWallet(opts: McpWalletOptions): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin });
    let queue: Promise<void> = Promise.resolve();
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // not JSON: ignore per stdio transport spec
      }
      queue = queue.then(async () => {
        const res = await handleMcpMessage(opts, msg);
        if (res) process.stdout.write(JSON.stringify(res) + '\n');
      });
    });
    rl.on('close', () => queue.then(resolve));
  });
}
