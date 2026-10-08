import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-residual-security-'));
const baseEnv = { PATH: process.env.PATH, HOME: dir, DATABASE_URL: '', ZEKO_RELAYER_MODE: 'record', ZEKO_RELAYER_HOST: '127.0.0.1', ZEKO_RELAYER_PORT: '0', MAGIC_CITY_REQUIRE_PRODUCTION_PERSISTENCE: 'false' };
const findings = [];
for (const token of ['', 'change-me', 'a'.repeat(32)]) {
  const child = spawn(process.execPath, [path.join(root, 'src/zekoRelayerServer.js')], { cwd: dir, env: { ...baseEnv, NODE_ENV: 'production', ZEKO_RELAYER_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', b => { output += b; });
  child.stderr.on('data', b => { output += b; });
  const outcome = await Promise.race([
    once(child, 'exit').then(() => 'exited'),
    new Promise(resolve => {
      child.stdout.on('data', () => { if (output.includes('listening on')) resolve('listening'); });
      const timer = setTimeout(() => resolve('timeout'), 12000); timer.unref();
    })
  ]);
  if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
  findings.push({ test: `production relayer rejects ${token ? 'weak' : 'missing'} token`, passed: outcome === 'exited' && /relayer_requires_strong_token/.test(output) });
}

const privacyScript = `import { sealPayload } from ${JSON.stringify(new URL('../src/privacy.js', import.meta.url).href)}; process.umask(0o022); console.log(JSON.stringify(sealPayload({fixture:'unchanged-key'})));`;
const env = { PATH: process.env.PATH, STORE_ENCRYPTED_PAYLOADS: 'true' };
const first = spawnSync(process.execPath, ['--input-type=module', '-e', privacyScript], { cwd: dir, env, encoding: 'utf8' });
assert.equal(first.status, 0, first.stderr);
const keyPath = path.join(dir, 'data/privacy.key');
const original = fs.readFileSync(keyPath);
findings.push({ test: 'new privacy key owner-only', passed: (fs.statSync(keyPath).mode & 0o777) === 0o600 });
fs.chmodSync(keyPath, 0o644);
const second = spawnSync(process.execPath, ['--input-type=module', '-e', privacyScript], { cwd: dir, env, encoding: 'utf8' });
assert.equal(second.status, 0, second.stderr);
assert.deepEqual(fs.readFileSync(keyPath), original, 'existing key must never rotate');
const sealed = JSON.parse(second.stdout);
const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(original.toString().trim(), 'base64'), Buffer.from(sealed.iv, 'base64'));
decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
assert.equal(JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64')), decipher.final()])).fixture, 'unchanged-key');
findings.push({ test: 'legacy key permissions repaired without rotation', passed: (fs.statSync(keyPath).mode & 0o777) === 0o600 });
fs.chmodSync(keyPath, 0o400);
const readOnly = spawnSync(process.execPath, ['--input-type=module', '-e', privacyScript], { cwd: dir, env, encoding: 'utf8' });
assert.equal(readOnly.status, 0, readOnly.stderr);
assert.deepEqual(fs.readFileSync(keyPath), original, 'read-only key bytes must remain unchanged');
findings.push({ test: 'secure read-only key mount preserved', passed: (fs.statSync(keyPath).mode & 0o777) === 0o400 });
const symlinkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-privacy-symlink-'));
fs.mkdirSync(path.join(symlinkDir, 'data'));
fs.symlinkSync(keyPath, path.join(symlinkDir, 'data/privacy.key'));
const linked = spawnSync(process.execPath, ['--input-type=module', '-e', privacyScript], { cwd: symlinkDir, env, encoding: 'utf8' });
findings.push({ test: 'symlink key rejected without altering target', passed: linked.status !== 0 && fs.readFileSync(keyPath).equals(original) });
console.log(JSON.stringify(findings, null, 2));
assert.ok(findings.every(x => x.passed), 'residual security regressions');

const port = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
const token = crypto.randomBytes(32).toString('hex');
const child = spawn(process.execPath, [path.join(root, 'src/zekoRelayerServer.js')], { cwd: dir, env: { ...baseEnv, NODE_ENV: 'production', ZEKO_RELAYER_PORT: String(port), ZEKO_RELAYER_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
const request = (route, options = {}) => fetch(`http://127.0.0.1:${port}${route}`, { ...options, signal: AbortSignal.timeout(5000) });
try {
  let ready = false;
  for (let i = 0; i < 50; i++) { try { if ((await request('/submissions')).status === 401) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 50)); }
  assert.equal(ready, true, 'strong production token allows startup, anonymous requests denied');
  const body = JSON.stringify({ anchorPayload: { schema: 'magic-city-anchor-v1', sourceId: 'fixture-only', statementHash: 's', requestCommitment: 'r', batchRoot: 'b' } });
  assert.equal((await request('/submit', { method: 'POST', headers: { authorization: 'Bearer incorrect' }, body })).status, 401);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const submissions = await Promise.all(Array.from({ length: 8 }, () => request('/submit', { method: 'POST', headers, body })));
  assert.equal(submissions.filter(r => r.status === 201).length, 1);
  assert.equal(submissions.filter(r => r.status === 409).length, 7);
  const records = await (await request('/submissions', { headers })).json();
  assert.equal(records.submissions.length, 1, 'one durable record for concurrent replay');
  console.log('Strong relayer credential, unauthorized denial and concurrent record-only replay passed (no chain transaction)');
} finally { child.kill('SIGTERM'); await once(child, 'exit'); }

// Reward credits can fund a service budget, but cannot mint provider cash balances.
const rewardScript = `import assert from 'node:assert/strict'; import * as s from ${JSON.stringify(new URL('../src/store.js', import.meta.url).href)};
s.registerAgent({agentId:'reward-provider'});
await Promise.all(Array.from({length:8}, () => Promise.resolve().then(() => s.grantRewardCredits('reward-user',100,'daily',{eventKey:'one-day'}))));
assert.equal(s.getUserAccount('reward-user').available,100);
assert.equal(s.lockUserCreditsForIntent('reward-user',100,'reward-intent').ok,true);
assert.equal(s.settleLockedCredits('reward-intent','reward-provider').ok,true);
assert.equal(s.createPayoutRequest({agentId:'reward-provider',amount:1,rail:'fixture'}).ok,false);
await s.flushPersistence();`;
const rewards = spawnSync(process.execPath, ['--input-type=module', '-e', rewardScript], { cwd: dir, env: { PATH: process.env.PATH }, encoding: 'utf8' });
assert.equal(rewards.status, 0, rewards.stderr);
console.log('Idempotent promotional grant and zero provider cash-out passed');
