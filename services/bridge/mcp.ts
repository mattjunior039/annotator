import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Bridge, BridgeError } from './bridge.ts';
import { pairingSchema, proposalSchema } from './protocol.ts';

export function createMcpServer(bridge: Bridge) {
  const server = new McpServer({ name: 'bounded-annotation-bridge', version: '0.1.0' });
  const result = (action: () => unknown) => {
    try {
      bridge.limit('tool', 120);
      return { content: [{ type: 'text' as const, text: JSON.stringify(action()) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const,
        text: error instanceof BridgeError ? error.code : 'invalid' }] };
    }
  };
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  server.registerTool('bridge_pair', {
    description: 'Request single-use browser approval. Present token to user; never include it in a URL.',
    inputSchema: pairingSchema, annotations: { destructiveHint: false, openWorldHint: false },
  }, args => result(() => bridge.beginPair(args)));
  server.registerTool('bridge_status', {
    description: 'Authorization and approved-data lease only; cannot observe actual dataset file visibility.',
    inputSchema: z.strictObject({}), annotations: readOnly,
  }, () => result(() => bridge.status()));
  server.registerTool('bridge_revoke', {
    description: 'Immediately discard pairing, authorization, approved data and proposals.',
    inputSchema: z.strictObject({}), annotations: { destructiveHint: false, openWorldHint: false },
  }, () => result(() => { bridge.clear(); return { cleared: true }; }));
  server.registerTool('annotation_metadata', {
    description: 'Browser-approved opaque IDs, dimensions, boxes and review enums only. No file or media access.',
    inputSchema: z.strictObject({}), annotations: readOnly,
  }, () => result(() => bridge.metadata()));
  server.registerTool('annotation_counts', {
    description: 'Counts for browser-approved data only, not an inventory of files on disk.',
    inputSchema: z.strictObject({}), annotations: readOnly,
  }, () => result(() => bridge.counts()));
  server.registerTool('propose_annotation_patch', {
    description: 'Queue a revision-bound proposal only. Browser must confirm and use domain validation, transaction and undo.',
    inputSchema: proposalSchema, annotations: { destructiveHint: false, openWorldHint: false },
  }, args => result(() => bridge.propose(args)));
  return server;
}
