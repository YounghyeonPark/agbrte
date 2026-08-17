/**
 * A real MCP server, four verbs long — the deterministic stand-in for a web one.
 *
 * The e2e test that drives §17 Q20's creation form needs a server that behaves
 * like the real thing and does not depend on somebody's network being up. This
 * speaks the actual stdio transport — JSON-RPC 2.0, one message per line —
 * because framing and the handshake are exactly the parts a mock would vouch for
 * rather than exercise. `tests/mcp.test.ts` writes an equivalent inline; this one
 * is a file so a *form* can name it in a command field, which is the thing under
 * test.
 *
 * `.cjs` deliberately: it is spawned by absolute path from a temp directory that
 * has no `package.json`, so `require` is the only module system guaranteed to be
 * in force.
 *
 * `lookup` echoes its key and the value of `AGBRTE_E2E_TOKEN`, which is how a
 * test can show an env value reached the *process* while the log and the screen
 * only ever carry its name (§13).
 */

const readline = require('node:readline');

const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');

rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'agbrte-e2e-fixture', version: '1.0.0' },
      },
    });
  } else if (msg.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: [
          {
            name: 'lookup',
            description: 'Look a value up by key',
            inputSchema: {
              type: 'object',
              properties: { key: { type: 'string' } },
              required: ['key'],
            },
          },
        ],
      },
    });
  } else if (msg.method === 'tools/call') {
    const key = (msg.params.arguments || {}).key;
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        content: [
          {
            type: 'text',
            text: 'value-for-' + key + ' token=' + (process.env.AGBRTE_E2E_TOKEN || 'unset'),
          },
        ],
      },
    });
  } else if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not implemented' } });
  }
});
