import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Bridge } from './bridge.ts';
import { startBrowserServer } from './http.ts';
import { createMcpServer } from './mcp.ts';
import { MAX_BYTES, PORT } from './protocol.ts';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const origins = (process.env.BRIDGE_ORIGINS ?? '').split(',').filter(Boolean);
    const port = Number(process.env.BRIDGE_PORT ?? PORT);
    const bridge = new Bridge(origins);
    const http = await startBrowserServer(bridge, origins, port);
    const mcp = createMcpServer(bridge);
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      bridge.clear(); http.closeAllConnections(); http.close(); void mcp.close();
    };
    mcp.server.onclose = stop;
    mcp.server.onerror = stop;
    process.stdin.once('end', stop);
    process.stdin.once('error', stop);
    process.stdout.once('error', stop);
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    await mcp.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: MAX_BYTES }));
  } catch {
    // Never log exceptions, requests, tokens, data, or SDK diagnostics.
    process.stderr.write('Bridge could not start.\n');
    process.exitCode = 1;
  }
}
