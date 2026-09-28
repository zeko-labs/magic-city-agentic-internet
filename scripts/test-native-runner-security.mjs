import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const apiKey = 'native-runner-security-test-key';

async function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function request(baseUrl, pathName, { method = 'GET', body = null, key = '', cookie = '', bearer = '', headers = {} } = {}) {
  let response;
  try {
    response = await fetch(`${baseUrl}${pathName}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(key ? { 'x-api-key': key } : {}),
        ...(cookie ? { cookie } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...headers
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (error) {
    throw new Error(`request_failed:${method}:${pathName}:${error?.message || String(error)}`);
  }
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  const setCookie = response.headers.get('set-cookie') || '';
  return { response, data, cookie: setCookie.split(';')[0] || '' };
}

async function waitForServer(baseUrl) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15000) {
    try {
      const { response } = await request(baseUrl, '/.well-known/magic-city-mission-auth');
      if (response.ok) return;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('server_start_timeout');
}

async function stopChildProcess(child) {
  if (child.exitCode !== null || child.signalCode) return;
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
}

async function registerUser(baseUrl, email) {
  const result = await request(baseUrl, '/auth/register', {
    method: 'POST',
    body: {
      email,
      passphrase: 'runner-test-passphrase',
      displayName: email.split('@')[0]
    }
  });
  if (!result.response.ok) throw new Error(`register_failed:${email}:${result.response.status}:${JSON.stringify(result.data)}`);
  if (!result.cookie) throw new Error(`missing_auth_cookie:${email}`);
  return { cookie: result.cookie, user: result.data.user };
}

async function mintRunner(baseUrl, cookie, { trustMode = 'local_runner' } = {}) {
  const result = await request(baseUrl, '/native-runner/setup', {
    method: 'POST',
    cookie,
    body: { trustMode, setupMode: 'security_test' }
  });
  if (!result.response.ok) throw new Error(`setup_failed:${result.response.status}:${JSON.stringify(result.data)}`);
  return result.data;
}

async function registerNativePlugin(baseUrl, token, overrides = {}, requestOptions = {}) {
  return request(baseUrl, '/plugins/register', {
    method: 'POST',
    bearer: token,
    ...requestOptions,
    body: {
      pluginId: 'local-authenticated-browser-plugin',
      ownerAgentId: 'local-authenticated-browser-agent',
      kind: 'browser',
      endpoint: `${baseUrl}/plugins/local-authenticated-browser-plugin`,
      capabilities: ['browser-worker-agent', 'browser.local_authenticated_profile', 'browser.prepare_handoff'],
      tools: ['browser.open_local_profile', 'browser.inspect', 'browser.prepare_handoff'],
      ...overrides
    }
  });
}

async function startBrowserSession(baseUrl, cookie, prompt = 'Open https://example.com and stop after reading the page.') {
  const started = await request(baseUrl, '/connectors/sessions/start', {
    method: 'POST',
    cookie,
    body: {
      connectorId: 'browser-worker-demo-v1',
      preferredExecutionAgentId: 'local-authenticated-browser-plugin',
      prompt
    }
  });
  if (!started.response.ok) throw new Error(`session_start_failed:${started.response.status}:${JSON.stringify(started.data)}`);
  const session = started.data.session;
  const mode = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(session.id)}/completion-mode`, {
    method: 'POST',
    cookie,
    body: { mode: 'agent_checkout' }
  });
  if (!mode.response.ok) throw new Error(`completion_mode_failed:${mode.response.status}:${JSON.stringify(mode.data)}`);
  return mode.data.session || session;
}

async function expectStatus(label, promise, expectedStatuses) {
  const result = await promise;
  const statuses = Array.isArray(expectedStatuses) ? expectedStatuses : [expectedStatuses];
  if (!statuses.includes(result.response.status)) {
    throw new Error(`${label}:expected_${statuses.join('_or_')}:got_${result.response.status}:${JSON.stringify(result.data)}`);
  }
  return result;
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magic-city-native-runner-security-'));
  const port = await getAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(rootDir, 'src/server.js')], {
    cwd: tmpDir,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(port),
      PUBLIC_API_KEYS: apiKey,
      MAGIC_CITY_NATIVE_RUNNER_TOKEN_TTL_MS: '1000',
      MAGIC_CITY_SAFE_HTTP_STARTUP: 'true',
      SANTACLAWZ_SAFE_START_DELAY_MS: '600000',
      AUTO_START_LOCAL_EXECUTION_AGENTS: 'false',
      AUTO_SEED_DEFAULT_AGENTS: 'false',
      EXECUTION_WATCHDOG_ENABLED: 'false',
      ETHEREUM_CONFIRMATION_INDEXER_ENABLED: 'false',
      ETHEREUM_SHADOW_RELAYER_ENABLED: 'false',
      MISSION_BOUND_AUTH_SECRET: 'native-runner-security-test-secret'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForServer(baseUrl);
    const userA = await registerUser(baseUrl, `runner-a-${crypto.randomBytes(4).toString('hex')}@example.com`);
    const userB = await registerUser(baseUrl, `runner-b-${crypto.randomBytes(4).toString('hex')}@example.com`);
    const setupA = await mintRunner(baseUrl, userA.cookie);
    const tokenA = setupA.setup.deviceToken;
    const registered = await registerNativePlugin(baseUrl, tokenA);
    if (!registered.response.ok) throw new Error(`native_plugin_register_failed:${registered.response.status}:${JSON.stringify(registered.data)}`);

    const extensionHeaders = {
      origin: 'chrome-extension://security-test-runner',
      'sec-fetch-site': 'cross-site',
      'x-magic-city-runner-surface': 'chrome-extension',
      'x-magic-city-runner-protocol': 'declarative-v1'
    };
    const cookieBoundExtensionRegistration = await registerNativePlugin(baseUrl, tokenA, {}, {
      cookie: userA.cookie,
      headers: extensionHeaders
    });
    if (!cookieBoundExtensionRegistration.response.ok) {
      throw new Error(`cookie_bound_extension_register_failed:${cookieBoundExtensionRegistration.response.status}:${JSON.stringify(cookieBoundExtensionRegistration.data)}`);
    }
    const spoofedExtensionRegistration = await registerNativePlugin(baseUrl, 'invalid-runner-token', {}, {
      cookie: userA.cookie,
      headers: extensionHeaders
    });
    if (spoofedExtensionRegistration.response.status !== 403 || spoofedExtensionRegistration.data.error !== 'cross_origin_mutation_rejected') {
      throw new Error(`spoofed_extension_origin_not_rejected:${spoofedExtensionRegistration.response.status}:${JSON.stringify(spoofedExtensionRegistration.data)}`);
    }
    const cookieBoundNonExtensionRegistration = await registerNativePlugin(baseUrl, tokenA, {}, {
      cookie: userA.cookie,
      headers: {
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site'
      }
    });
    if (cookieBoundNonExtensionRegistration.response.status !== 403 || cookieBoundNonExtensionRegistration.data.error !== 'cross_origin_mutation_rejected') {
      throw new Error(`non_extension_cross_origin_not_rejected:${cookieBoundNonExtensionRegistration.response.status}:${JSON.stringify(cookieBoundNonExtensionRegistration.data)}`);
    }

    const sessionA = await startBrowserSession(baseUrl, userA.cookie, 'Open https://example.com for user A.');
    const sessionB = await startBrowserSession(baseUrl, userB.cookie, 'Open https://example.org for user B.');

    const visible = await request(baseUrl, '/connectors/sessions', { bearer: tokenA });
    if (!visible.response.ok) throw new Error(`native_session_list_failed:${visible.response.status}:${JSON.stringify(visible.data)}`);
    const visibleIds = new Set((visible.data.sessions || []).map((session) => session.id));
    if (!visibleIds.has(sessionA.id)) throw new Error('native_runner_cannot_see_own_session');
    if (visibleIds.has(sessionB.id)) throw new Error('native_runner_leaked_other_user_session');

    await expectStatus('register_different_plugin_denied', registerNativePlugin(baseUrl, tokenA, {
      pluginId: 'local-food-plugin',
      ownerAgentId: 'food-delivery-agent',
      kind: 'food'
    }), 403);

    try {
      await expectStatus('claim_other_user_session_denied', request(baseUrl, `/connectors/sessions/${encodeURIComponent(sessionB.id)}/claim`, {
        method: 'POST',
        bearer: tokenA,
        body: {
          pluginId: 'local-authenticated-browser-plugin'
        }
      }), 404);
    } catch (error) {
      throw new Error(`${error?.message || String(error)}\nchild_stderr:\n${stderr || '(none)'}`);
    }

    const cookieBoundExtensionClaim = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(sessionA.id)}/claim`, {
      method: 'POST',
      cookie: userA.cookie,
      bearer: tokenA,
      headers: extensionHeaders,
      body: {
        pluginId: 'local-authenticated-browser-plugin'
      }
    });
    if (cookieBoundExtensionClaim.response.status !== 409 || cookieBoundExtensionClaim.data.error !== 'execution_protocol_not_allowed') {
      throw new Error(`cookie_bound_extension_claim_protocol_conflict_not_rejected:${cookieBoundExtensionClaim.response.status}:${JSON.stringify(cookieBoundExtensionClaim.data)}`);
    }

    const claim = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(sessionA.id)}/claim`, {
      method: 'POST',
      bearer: tokenA,
      body: {
        pluginId: 'local-authenticated-browser-plugin',
        holderPublicKeyJwk: crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' })
      }
    });
    if (!claim.response.ok) throw new Error(`claim_own_session_failed:${claim.response.status}:${JSON.stringify(claim.data)}`);

    await expectStatus('unsigned_checkpoint_denied', request(baseUrl, `/connectors/sessions/${encodeURIComponent(sessionA.id)}/checkpoint`, {
      method: 'POST',
      bearer: tokenA,
      body: {
        pluginId: 'local-authenticated-browser-plugin',
        label: 'Unsigned checkpoint',
        missionAction: 'read_public_page',
        targetUrl: 'https://example.com',
        browser: { url: 'https://example.com' }
      }
    }), 401);

    const setupRevoke = await mintRunner(baseUrl, userA.cookie);
    const tokenRevoke = setupRevoke.setup.deviceToken;
    await expectStatus('revoked_token_before_revoke_works', registerNativePlugin(baseUrl, tokenRevoke), 201);
    const revoked = await request(baseUrl, '/native-runner/revoke', {
      method: 'POST',
      cookie: userA.cookie,
      body: { deviceId: setupRevoke.device.id, reason: 'security_test' }
    });
    if (!revoked.response.ok) throw new Error(`revoke_failed:${revoked.response.status}:${JSON.stringify(revoked.data)}`);
    await expectStatus('revoked_token_denied', request(baseUrl, '/connectors/sessions', { bearer: tokenRevoke }), 401);

    const setupExpire = await mintRunner(baseUrl, userA.cookie);
    const tokenExpire = setupExpire.setup.deviceToken;
    await new Promise((resolve) => setTimeout(resolve, 1300));
    await expectStatus('expired_token_denied', request(baseUrl, '/connectors/sessions', { bearer: tokenExpire }), 401);

    console.log('native-runner security regression passed');
  } finally {
    await stopChildProcess(child);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  if (stderr && /fatal|syntaxerror|unhandled/i.test(stderr)) {
    throw new Error(stderr);
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
});
