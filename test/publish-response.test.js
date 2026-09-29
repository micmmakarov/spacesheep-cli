const { test } = require('node:test');
const assert = require('node:assert/strict');
const { McpClient } = require('../lib/mcp');

test('progress is requested but never mistaken for a completed publish', async () => {
  const original = global.fetch;
  const client = new McpClient('https://example.invalid', 'test-key');
  client.ready = Promise.resolve();
  global.fetch = async (_, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.params._meta.progressToken, body.id);
    return new Response('data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":15}}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  };
  try { await assert.rejects(client.call('deploy'), /completion is unconfirmed; check publish_log/); }
  finally { global.fetch = original; }
});

test('structured publish error retains the reason and retry instruction', async () => {
  const client = new McpClient('https://example.invalid', 'test-key');
  client.ready = Promise.resolve();
  client._post = async () => ({ result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: 'publish_timeout', message: 'Check list_versions. Reuse staged shas.' }) }] } });
  await assert.rejects(client.call('deploy'), /publish_timeout: Check list_versions. Reuse staged shas/);
});
