import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  normalizeExecutionPreviewUrl,
  sanitizeExecutionPreviewMetadata
} from '../src/executionPreviewSecurity.js';

assert.equal(normalizeExecutionPreviewUrl('javascript:alert(1)'), '');
assert.equal(normalizeExecutionPreviewUrl('https://user:secret@example.test/preview.png'), '');
assert.equal(normalizeExecutionPreviewUrl('/not-an-artifact.png'), '');
assert.equal(normalizeExecutionPreviewUrl('/artifacts/preview.png'), '/artifacts/preview.png');
assert.equal(normalizeExecutionPreviewUrl('https://images.example.test/preview.png'), 'https://images.example.test/preview.png');
const recursive = sanitizeExecutionPreviewMetadata({
  browserExecution: {
    previewArtifact: { url: 'javascript:alert(1)', label: 'unsafe' },
    currentBrowser: { previewArtifact: { url: '/artifacts/valid.png', label: 'valid' } }
  }
});
assert.equal(recursive.browserExecution.previewArtifact, null);
assert.equal(recursive.browserExecution.currentBrowser.previewArtifact.url, '/artifacts/valid.png');

const root = path.resolve(new URL('..', import.meta.url).pathname);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'magic-city-preview-security-'));
const originalCwd = process.cwd();
process.chdir(dir);
const store = await import('../src/store.js');
const session = store.createConnectorSession({
  status: 'executing',
  preferredExecutionAgentId: 'preview-security-plugin',
  handoffData: { kind: 'fixture' },
  completionMode: 'agent_checkout'
});
await store.flushPersistence();
process.chdir(originalCwd);

const port = await new Promise((resolve, reject) => {
  const socket = net.createServer();
  socket.once('error', reject);
  socket.listen(0, '127.0.0.1', () => {
    const address = socket.address();
    socket.close(() => resolve(address.port));
  });
});
const env = {
  ...process.env,
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: String(port),
  MAGIC_CITY_PLUGIN_API_KEY: 'preview-security-service-key',
  MAGIC_CITY_PLUGIN_ALLOWED_IDS: 'preview-security-plugin',
  MAGIC_CITY_SAFE_HTTP_STARTUP: 'true',
  AUTO_START_LOCAL_EXECUTION_AGENTS: 'false',
  AUTO_SEED_DEFAULT_AGENTS: 'false',
  AUTO_PREPARE_EXECUTION_PROOFS: 'false',
  AUTO_DRAIN_SPONSORED_PROOF_QUEUE: 'false',
  AUTO_RECOVER_SPONSORED_PROOF_QUEUE: 'false',
  ETHEREUM_CONFIRMATION_INDEXER_ENABLED: 'false',
  ETHEREUM_SHADOW_RELAYER_ENABLED: 'false'
};
delete env.DATABASE_URL;
const child = spawn(process.execPath, [path.join(root, 'src/server.js')], {
  cwd: dir,
  env,
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });
const baseUrl = `http://127.0.0.1:${port}`;

async function request(route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, { ...options, signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  return { response, data: text ? JSON.parse(text) : {} };
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await request('/health')).response.ok) {
        ready = true;
        break;
      }
    } catch {}
    if (child.exitCode != null) throw new Error(output.slice(-3000));
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, output.slice(-3000));

  const payload = '/artifacts/missing.png" onerror="window.__previewExecuted=1" data-fixture="';
  const checkpoint = await request(`/connectors/sessions/${session.id}/checkpoint`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.MAGIC_CITY_PLUGIN_API_KEY
    },
    body: JSON.stringify({
      pluginId: 'preview-security-plugin',
      label: 'Preview security fixture',
      state: 'running',
      browser: {
        url: 'https://example.test/',
        title: 'Preview security fixture',
        previewArtifact: { url: payload }
      }
    })
  });
  assert.equal(checkpoint.response.status, 200, JSON.stringify(checkpoint.data));
  const storedUrl = checkpoint.data.session.executionTrace.at(-1).browser.previewArtifact.url;
  assert.match(storedUrl, /^\/artifacts\/missing\.png%22%20onerror=/);
  assert.doesNotMatch(storedUrl, /"|\sonerror=/i);
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'data/state.json'), 'utf8'));
  const persistedUrl = persisted.connectorSessions
    .find((entry) => entry.id === session.id)
    .executionTrace.at(-1).browser.previewArtifact.url;
  assert.equal(persistedUrl, storedUrl);
  console.log('execution preview persistence security regressions passed');
} finally {
  if (child.exitCode == null) {
    const stopped = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await stopped;
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
