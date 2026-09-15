import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const apiKey = 'native-runner-extension-pairing-test-key';
const extensionVersion = JSON.parse(fs.readFileSync(
  path.join(rootDir, 'public/native-runner/extension/manifest.json'),
  'utf8'
)).version;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)])
    );
  }
  return value;
}

function protocolHash(value) {
  return `0x${crypto.createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex')}`;
}

function domainForUrl(value = '') {
  return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
}

function buildPopProof({ keyPair, session, action, targetUrl, nonce = '' }) {
  const proofNonce = nonce || crypto.randomBytes(24).toString('base64url');
  const signingInput = JSON.stringify(stableValue({
    schema: 'magic-city-mission-pop-v1',
    capabilityId: session.missionBoundAuth.capabilityId,
    capabilityHash: session.missionBoundAuth.tokenHash,
    action,
    targetDomain: domainForUrl(targetUrl),
    nonce: proofNonce,
    previousHash: session.missionBoundaryLatestHash || null,
    audience: session.missionBoundAuth.audience || null,
    sessionId: session.missionBoundAuth.subject?.sessionId || session.id
  }));
  return {
    nonce: proofNonce,
    previousHash: session.missionBoundaryLatestHash || null,
    publicKeyJwk: keyPair.publicKey.export({ format: 'jwk' }),
    signature: crypto.sign(null, Buffer.from(signingInput, 'utf8'), keyPair.privateKey).toString('base64url')
  };
}

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

async function request(baseUrl, pathName, {
  method = 'GET',
  body = null,
  cookie = '',
  bearer = '',
  runnerSurface = '',
  runnerProtocol = '',
  runnerExtensionVersion = '',
  runnerExtensionId = ''
} = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(runnerSurface ? { 'x-magic-city-runner-surface': runnerSurface } : {}),
      ...(runnerProtocol ? { 'x-magic-city-runner-protocol': runnerProtocol } : {}),
      ...(runnerExtensionVersion ? { 'x-magic-city-runner-extension-version': runnerExtensionVersion } : {}),
      ...(runnerExtensionId ? { 'x-magic-city-runner-extension-id': runnerExtensionId } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
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

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magic-city-native-runner-extension-'));
  const port = await getAvailablePort();
  const rankerPort = await getAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let rankerCalls = 0;
  let rankerDelayMs = 0;
  let rankerProviderInput = null;
  let rankerSawDurableAttempt = false;
  let expectedIntelligenceRequestId = null;
  const rankerServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const systemPrompt = String(payload.messages?.[0]?.content || '');
    const isSelectionRank = systemPrompt.includes('Choose the observed Amazon product title');
    if (isSelectionRank) {
      rankerCalls += 1;
      rankerProviderInput = JSON.parse(String(payload.messages?.[1]?.content || '{}'));
      const persistedState = JSON.parse(fs.readFileSync(path.join(tmpDir, 'data/state.json'), 'utf8'));
      rankerSawDurableAttempt = (persistedState.connectorSessions || []).some((candidateSession) =>
        (candidateSession.amazonSelectionIntelligenceAttempts || []).some((attempt) =>
          attempt?.status === 'pending' && attempt?.requestId === expectedIntelligenceRequestId
        )
      );
    }
    const content = isSelectionRank
      ? { decision: 'select', selectedId: 'candidate-1', reason: 'Observed semantic match.' }
      : {};
    if (isSelectionRank && rankerDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, rankerDelayMs));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'local-selection-test', choices: [{ message: { content: JSON.stringify(content) } }] }));
  });
  await new Promise((resolve, reject) => {
    rankerServer.once('error', reject);
    rankerServer.listen(rankerPort, '127.0.0.1', resolve);
  });
  const serverEnv = {
    ...process.env,
    NODE_ENV: 'test',
    HOST: '127.0.0.1',
    PORT: String(port),
    PUBLIC_API_KEYS: apiKey,
    MAGIC_CITY_NATIVE_RUNNER_TOKEN_TTL_MS: '600000',
    MAGIC_CITY_NATIVE_RUNNER_PAIRING_TTL_MS: '600000',
    MAGIC_CITY_FILE_PERSIST_MODE: 'async',
    MAGIC_CITY_NATIVE_RUNNER_MIN_EXTENSION_VERSION: '0.4.33',
    MAGIC_CITY_NATIVE_RUNNER_EXTENSION_INSTALL_URL: 'https://chromewebstore.google.com/detail/magic-city-runner/test-extension-id',
    MAGIC_CITY_SAFE_HTTP_STARTUP: 'true',
    SANTACLAWZ_SAFE_START_DELAY_MS: '600000',
    AUTO_START_LOCAL_EXECUTION_AGENTS: 'false',
    AUTO_SEED_DEFAULT_AGENTS: 'false',
    EXECUTION_WATCHDOG_ENABLED: 'true',
    ETHEREUM_CONFIRMATION_INDEXER_ENABLED: 'false',
    ETHEREUM_SHADOW_RELAYER_ENABLED: 'false',
    // Exercise the production-risk configuration without ever allowing the
    // test server to start an in-process MBA compile/prove task.
    ZEKO_SUBMIT_MODE: 'relay',
    ZEKO_RELAYER_MODE: 'mba_mission_registry',
    ZEKO_GRAPHQL: 'http://127.0.0.1:9/graphql',
    MAGIC_CITY_FINAL_SUBMIT_CHAIN_GATE_ENABLED: 'false',
    MISSION_BOUND_AUTH_SECRET: 'native-runner-extension-test-secret',
    MAGIC_CITY_AMAZON_SELECTION_INTELLIGENCE_ENABLED: 'true',
    MAGIC_CITY_BROWSER_RANK_TIMEOUT_MS: '3000',
    TEST_OPENROUTER_API_KEY: 'test-only-key',
    AI_PROVIDER_CONFIG: JSON.stringify([{
      id: 'openrouter-selection-test',
      label: 'OpenRouter selection test',
      type: 'openai_compat',
      baseUrl: `http://127.0.0.1:${rankerPort}`,
      apiKeyEnv: 'TEST_OPENROUTER_API_KEY',
      model: 'local-selection-test',
      path: '/chat/completions',
      lanes: ['general-chat']
    }])
  };
  let stderr = '';
  const startServer = () => {
    const server = spawn(process.execPath, [path.join(rootDir, 'src/server.js')], {
      cwd: tmpDir,
      env: serverEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    return server;
  };
  let child = startServer();
  const stopServer = async () => {
    const stoppingChild = child;
    if (!stoppingChild || stoppingChild.exitCode !== null) return;
    // Async file persistence coalesces ordinary test writes for 150 ms. Let
    // those fixtures settle before simulating a clean process restart.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 5000);
      stoppingChild.once('exit', finish);
      if (stoppingChild.exitCode !== null || !stoppingChild.kill('SIGTERM')) finish();
    });
  };

  try {
    await waitForServer(baseUrl);
    const email = `runner-extension-${crypto.randomBytes(4).toString('hex')}@example.com`;
    const auth = await request(baseUrl, '/auth/register', {
      method: 'POST',
      body: {
        email,
        passphrase: 'runner-extension-test-passphrase',
        displayName: 'Runner Extension Test'
      }
    });
    if (!auth.response.ok || !auth.cookie) throw new Error(`auth_failed:${auth.response.status}:${JSON.stringify(auth.data)}`);
    const bootstrapCredits = await request(baseUrl, '/billing/credits/bootstrap', {
      method: 'POST',
      cookie: auth.cookie,
      body: { requesterId: email }
    });
    if (!bootstrapCredits.response.ok && bootstrapCredits.data?.error !== 'daily_credits_already_claimed') {
      throw new Error(`credit_bootstrap_failed:${bootstrapCredits.response.status}:${JSON.stringify(bootstrapCredits.data)}`);
    }

    const start = await request(baseUrl, '/native-runner/extension/pairing/start', {
      method: 'POST',
      cookie: auth.cookie,
      body: {
        trustMode: 'trusted_under_cap',
        useExistingBrowser: true
      }
    });
    if (start.response.status !== 201) throw new Error(`pairing_start_failed:${start.response.status}:${JSON.stringify(start.data)}`);
    const pairing = start.data.pairing || {};
    if (!pairing.id || !pairing.code) throw new Error(`pairing_start_missing_code:${JSON.stringify(start.data)}`);
    if (JSON.stringify(start.data).includes('mcnr_')) throw new Error('pairing_start_leaked_device_token');

    const claim = await request(baseUrl, '/native-runner/extension/pairing/claim', {
      method: 'POST',
      body: {
        code: pairing.code,
        extensionVersion,
        extensionId: 'test-extension-id'
      }
    });
    if (claim.response.status !== 201) throw new Error(`pairing_claim_failed:${claim.response.status}:${JSON.stringify(claim.data)}`);
    const token = claim.data.setup?.deviceToken;
    if (!token?.startsWith('mcnr_')) throw new Error(`pairing_claim_missing_token:${JSON.stringify(claim.data)}`);
    if (claim.data.device?.trustMode !== 'trusted_under_cap') throw new Error('pairing_claim_lost_trust_mode');
    if (!claim.data.device?.useExistingBrowser) throw new Error('pairing_claim_lost_browser_profile_choice');

    const extensionRegistration = {
      pluginId: 'magic-city-runner-extension',
      ownerAgentId: 'magic-city-runner-extension',
      kind: 'browser',
      endpoint: 'chrome-extension://magic-city-runner-test',
      executionAgent: true,
      capabilities: ['browser-worker-agent', 'browser.extension_dom_executor', 'browser.prepare_cart'],
      tools: ['browser.open_local_profile', 'browser.inspect', 'browser.prepare_cart'],
      metadata: {
        extensionOnly: true,
        extensionExecutor: true,
        executionBackend: 'extension_dom_executor',
        browserPermissionReady: true
      }
    };
    const extensionRegister = await request(baseUrl, '/plugins/register', {
      method: 'POST',
      bearer: token,
      runnerSurface: 'chrome-extension',
      runnerProtocol: 'declarative-v1',
      runnerExtensionVersion: extensionVersion,
      runnerExtensionId: 'test-extension-id',
      body: extensionRegistration
    });
    if (extensionRegister.response.status !== 201) {
      throw new Error(`extension_plugin_register_failed:${extensionRegister.response.status}:${JSON.stringify(extensionRegister.data)}`);
    }
    if (extensionRegister.response.headers.get('x-magic-city-durability') === 'advisory') {
      throw new Error('initial_extension_registration_was_not_durable');
    }
    const repeatedRegistrationStartedAt = Date.now();
    const repeatedExtensionRegister = await request(baseUrl, '/plugins/register', {
      method: 'POST',
      bearer: token,
      runnerSurface: 'chrome-extension',
      runnerProtocol: 'declarative-v1',
      runnerExtensionVersion: extensionVersion,
      runnerExtensionId: 'test-extension-id',
      body: extensionRegistration
    });
    const repeatedRegistrationDurationMs = Date.now() - repeatedRegistrationStartedAt;
    if (repeatedExtensionRegister.response.status !== 200
      || repeatedExtensionRegister.data.registrationReused !== true
      || repeatedExtensionRegister.response.headers.get('x-magic-city-durability') !== 'advisory') {
      throw new Error(`extension_plugin_register_not_reused:${repeatedExtensionRegister.response.status}:${JSON.stringify(repeatedExtensionRegister.data)}`);
    }
    if (repeatedRegistrationDurationMs >= 1000) {
      throw new Error(`extension_plugin_register_reuse_slow:${repeatedRegistrationDurationMs}`);
    }
    const statusAfterExtensionRegister = await request(baseUrl, `/native-runner/status?deviceId=${encodeURIComponent(claim.data.device.id)}`, {
      cookie: auth.cookie
    });
    if (!statusAfterExtensionRegister.response.ok
      || !statusAfterExtensionRegister.data.device?.lastSeenAt
      || !statusAfterExtensionRegister.data.ready) {
      throw new Error(`extension_register_did_not_mark_runner_seen:${statusAfterExtensionRegister.response.status}:${JSON.stringify(statusAfterExtensionRegister.data)}`);
    }
    if (statusAfterExtensionRegister.data.readiness?.latestPublishedVersion !== '0.4.33'
      || statusAfterExtensionRegister.data.readiness?.minimumExtensionVersion !== '0.4.33'
      || statusAfterExtensionRegister.data.readiness?.extensionUpdateAvailable !== false
      || !statusAfterExtensionRegister.data.readiness?.extensionInstallUrl) {
      throw new Error(`runner_release_metadata_invalid:${JSON.stringify(statusAfterExtensionRegister.data.readiness)}`);
    }
    const staleDeviceStatus = await request(baseUrl, '/native-runner/status?deviceId=nrd-stale-local-cache', {
      cookie: auth.cookie
    });
    if (!staleDeviceStatus.response.ok
      || !staleDeviceStatus.data.requestedDeviceMissing
      || staleDeviceStatus.data.device?.id !== claim.data.device.id) {
      throw new Error(`stale_device_id_did_not_fall_back_to_owned_runner:${staleDeviceStatus.response.status}:${JSON.stringify(staleDeviceStatus.data)}`);
    }
    const versionedPollVersion = '0.4.99';
    const versionedPoll = await request(baseUrl, '/connectors/sessions', {
      bearer: token,
      runnerSurface: 'chrome-extension',
      runnerProtocol: 'declarative-v1',
      runnerExtensionVersion: versionedPollVersion,
      runnerExtensionId: 'test-extension-id'
    });
    if (!versionedPoll.response.ok) {
      throw new Error(`versioned_extension_poll_failed:${versionedPoll.response.status}:${JSON.stringify(versionedPoll.data)}`);
    }
    if (versionedPoll.response.headers.get('x-magic-city-durability') !== 'advisory') {
      throw new Error('versioned_extension_poll_waited_for_global_persistence');
    }
    const statusAfterVersionedPoll = await request(baseUrl, `/native-runner/status?deviceId=${encodeURIComponent(claim.data.device.id)}`, {
      cookie: auth.cookie
    });
    if (!statusAfterVersionedPoll.response.ok
      || statusAfterVersionedPoll.data.device?.extensionVersion !== versionedPollVersion) {
      throw new Error(`versioned_extension_poll_did_not_update_device:${statusAfterVersionedPoll.response.status}:${JSON.stringify(statusAfterVersionedPoll.data)}`);
    }
    if (statusAfterVersionedPoll.data.readiness?.extensionUpdateRequired
      || statusAfterVersionedPoll.data.readiness?.extensionUpdateAvailable
      || statusAfterVersionedPoll.data.readiness?.ready !== true) {
      throw new Error(`newer_runner_was_incorrectly_marked_outdated:${JSON.stringify(statusAfterVersionedPoll.data.readiness)}`);
    }

    const outdatedPollVersion = '0.4.32';
    const outdatedPoll = await request(baseUrl, '/connectors/sessions', {
      bearer: token,
      runnerSurface: 'chrome-extension',
      runnerProtocol: 'declarative-v1',
      runnerExtensionVersion: outdatedPollVersion,
      runnerExtensionId: 'test-extension-id'
    });
    if (!outdatedPoll.response.ok) {
      throw new Error(`outdated_extension_poll_failed:${outdatedPoll.response.status}:${JSON.stringify(outdatedPoll.data)}`);
    }
    const statusAfterOutdatedPoll = await request(baseUrl, `/native-runner/status?deviceId=${encodeURIComponent(claim.data.device.id)}`, {
      cookie: auth.cookie
    });
    if (statusAfterOutdatedPoll.data.readiness?.extensionUpdateRequired !== true
      || statusAfterOutdatedPoll.data.readiness?.extensionUpdateAvailable !== true
      || statusAfterOutdatedPoll.data.readiness?.ready !== false
      || statusAfterOutdatedPoll.data.readiness?.latestPublishedVersion !== statusAfterOutdatedPoll.data.readiness?.minimumExtensionVersion) {
      throw new Error(`outdated_runner_was_not_blocked:${JSON.stringify(statusAfterOutdatedPoll.data.readiness)}`);
    }
    const restoredPoll = await request(baseUrl, '/connectors/sessions', {
      bearer: token,
      runnerSurface: 'chrome-extension',
      runnerProtocol: 'declarative-v1',
      runnerExtensionVersion: extensionVersion,
      runnerExtensionId: 'test-extension-id'
    });
    if (!restoredPoll.response.ok) {
      throw new Error(`current_extension_restore_failed:${restoredPoll.response.status}:${JSON.stringify(restoredPoll.data)}`);
    }

    const customStart = await request(baseUrl, '/native-runner/helper/pairing/start', {
      method: 'POST',
      cookie: auth.cookie,
      body: {
        pluginId: 'helper-test-extension',
        ownerAgentId: 'helper-test-agent',
        label: 'Helper Test Extension',
        trustMode: 'trusted_under_cap',
        useExistingBrowser: true
      }
    });
    if (customStart.response.status !== 201) throw new Error(`custom_pairing_start_failed:${customStart.response.status}:${JSON.stringify(customStart.data)}`);
    const customPairing = customStart.data.pairing || {};
    if (customPairing.pluginId !== 'helper-test-extension' || customPairing.ownerAgentId !== 'helper-test-agent' || !customPairing.code) {
      throw new Error(`custom_pairing_scope_invalid:${JSON.stringify(customStart.data)}`);
    }
    const customClaim = await request(baseUrl, '/native-runner/extension/pairing/claim', {
      method: 'POST',
      body: {
        code: customPairing.code,
        extensionVersion: '0.1.0-test',
        extensionId: 'helper-test-extension-id'
      }
    });
    if (customClaim.response.status !== 201) throw new Error(`custom_pairing_claim_failed:${customClaim.response.status}:${JSON.stringify(customClaim.data)}`);
    const customToken = customClaim.data.setup?.deviceToken;
    if (!customToken?.startsWith('mcnr_')) throw new Error(`custom_pairing_claim_missing_token:${JSON.stringify(customClaim.data)}`);
    if (customClaim.data.setup?.pluginId !== 'helper-test-extension' || customClaim.data.setup?.ownerAgentId !== 'helper-test-agent') {
      throw new Error(`custom_pairing_claim_lost_scope:${JSON.stringify(customClaim.data.setup || {})}`);
    }
    const customCannotRegisterDefault = await request(baseUrl, '/plugins/register', {
      method: 'POST',
      bearer: customToken,
      body: {
        pluginId: 'magic-city-runner-extension',
        ownerAgentId: 'magic-city-runner-extension',
        kind: 'browser',
        endpoint: 'chrome-extension://helper-test-extension-id'
      }
    });
    if (customCannotRegisterDefault.response.status !== 403) {
      throw new Error(`custom_token_registered_default_runner:${customCannotRegisterDefault.response.status}:${JSON.stringify(customCannotRegisterDefault.data)}`);
    }
    const customRegister = await request(baseUrl, '/plugins/register', {
      method: 'POST',
      bearer: customToken,
      body: {
        pluginId: 'helper-test-extension',
        ownerAgentId: 'helper-test-agent',
        kind: 'browser',
        endpoint: 'chrome-extension://helper-test-extension-id',
        executionAgent: true,
        capabilities: ['browser-worker-agent', 'browser.extension_dom_executor', 'browser.prepare_cart'],
        tools: ['browser.open_local_profile', 'browser.inspect', 'browser.prepare_cart'],
        metadata: {
          customHelperAgent: true,
          executionBackend: 'extension_dom_executor',
          runnerProtocol: 'declarative-v1',
          proofMode: 'mission-bound-auth-holder-signatures'
        }
      }
    });
    if (customRegister.response.status !== 201) {
      throw new Error(`custom_helper_register_failed:${customRegister.response.status}:${JSON.stringify(customRegister.data)}`);
    }

    const replay = await request(baseUrl, '/native-runner/extension/pairing/claim', {
      method: 'POST',
      body: { code: pairing.code }
    });
    if (replay.response.status !== 409) throw new Error(`pairing_replay_not_rejected:${replay.response.status}:${JSON.stringify(replay.data)}`);

    const pairingStatus = await request(baseUrl, `/native-runner/extension/pairing/${encodeURIComponent(pairing.id)}`, {
      cookie: auth.cookie
    });
    if (!pairingStatus.response.ok) throw new Error(`pairing_status_failed:${pairingStatus.response.status}:${JSON.stringify(pairingStatus.data)}`);
    if (pairingStatus.data.pairing?.status !== 'claimed') throw new Error('pairing_status_not_claimed');

    const register = await request(baseUrl, '/plugins/register', {
      method: 'POST',
      bearer: token,
      body: {
        pluginId: 'local-authenticated-browser-plugin',
        ownerAgentId: 'local-authenticated-browser-agent',
        kind: 'browser',
        endpoint: 'chrome-extension://magic-city-runner-test',
        capabilities: ['browser-worker-agent', 'browser.local_authenticated_profile'],
        tools: ['browser.open_local_profile', 'browser.inspect'],
        metadata: {
          executionBackend: 'local_authenticated_browser_worker'
        }
      }
    });
    if (register.response.status !== 201) throw new Error(`plugin_register_failed:${register.response.status}:${JSON.stringify(register.data)}`);

    const sessionStart = await request(baseUrl, '/connectors/sessions/start', {
      method: 'POST',
      cookie: auth.cookie,
      body: {
        connectorId: 'browser-worker-demo-v1',
        preferredExecutionAgentId: 'magic-city-runner-extension',
        prompt: 'buy nature valley granola bars from amazon under $4',
        profileSummary: {}
      }
    });
    if (sessionStart.response.status !== 201) {
      throw new Error(`session_start_failed:${sessionStart.response.status}:${JSON.stringify(sessionStart.data)}`);
    }
    const browserRouteIgnoresUnrelatedAgent = await request(baseUrl, '/connectors/sessions/start', {
      method: 'POST',
      cookie: auth.cookie,
      body: {
        connectorId: 'browser-worker-demo-v1',
        preferredExecutionAgentId: 'alpha-ring',
        selectedAgent: {
          pluginId: 'alpha-ring',
          agentName: 'alpha ring'
        },
        prompt: 'buy nature valley granola bars from amazon under $4',
        profileSummary: {}
      }
    });
    if (browserRouteIgnoresUnrelatedAgent.response.status !== 201) {
      throw new Error(`browser_route_with_unrelated_agent_failed:${browserRouteIgnoresUnrelatedAgent.response.status}:${JSON.stringify(browserRouteIgnoresUnrelatedAgent.data)}`);
    }
    const browserRouteSession = browserRouteIgnoresUnrelatedAgent.data.session || {};
    if (browserRouteSession.handoffData?.kind !== 'browser') {
      throw new Error(`browser_route_became_generic_agent_execution:${JSON.stringify(browserRouteSession.handoffData || {})}`);
    }
    if (browserRouteSession.preferredExecutionAgentId === 'alpha-ring') {
      throw new Error('browser_route_preserved_unrelated_agent');
    }
    const sessionId = sessionStart.data.session?.id;
    const privateUpdate = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(sessionId)}/update`, {
      method: 'POST',
      cookie: auth.cookie,
      body: {
        localPrivateInputs: {
          contactEmail: 'private-runner-test@example.com',
          paymentCardLabel: 'Private runner test card'
        }
      }
    });
    if (!privateUpdate.response.ok) {
      throw new Error(`private_update_failed:${privateUpdate.response.status}:${JSON.stringify(privateUpdate.data)}`);
    }
    const ownerAfterPrivateUpdate = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(sessionId)}`, {
      cookie: auth.cookie
    });
    if (!ownerAfterPrivateUpdate.response.ok
      || JSON.stringify(ownerAfterPrivateUpdate.data.session || {}).includes('private-runner-test@example.com')
      || JSON.stringify(ownerAfterPrivateUpdate.data.session || {}).includes('Private runner test card')) {
      throw new Error('browser_session_persisted_local_checkout_profile');
    }
    const executionAgents = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(sessionId)}/execution-agents`, {
      cookie: auth.cookie
    });
    if (!executionAgents.response.ok) {
      throw new Error(`execution_agents_failed:${executionAgents.response.status}:${JSON.stringify(executionAgents.data)}`);
    }
    const agentIds = (executionAgents.data.executionAgents || []).map((agent) => agent.pluginId);
    if (!agentIds.includes('magic-city-runner-extension')) throw new Error(`extension_executor_missing_from_execution_agents:${agentIds.join(',')}`);
    if (!agentIds.includes('local-authenticated-browser-plugin')) throw new Error(`native_executor_missing_from_execution_agents:${agentIds.join(',')}`);
    if (!agentIds.includes('helper-test-extension')) throw new Error(`custom_helper_missing_from_execution_agents:${agentIds.join(',')}`);

    const sessions = await request(baseUrl, '/connectors/sessions', {
      bearer: token,
      runnerSurface: 'chrome-extension'
    });
    if (!sessions.response.ok) throw new Error(`session_poll_failed:${sessions.response.status}:${JSON.stringify(sessions.data)}`);
    if ((sessions.data.sessions || []).some((entry) => entry.id === sessionId)) {
      throw new Error('extension_poll_exposed_undispatched_mission');
    }

    const completionMode = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(sessionId)}/completion-mode`, {
      method: 'POST',
      cookie: auth.cookie,
      body: { mode: 'agent_checkout' }
    });
    if (!completionMode.response.ok) {
      throw new Error(`extension_completion_mode_failed:${completionMode.response.status}:${JSON.stringify(completionMode.data)}`);
    }
    const undispatchedClaim = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(sessionId)}/claim`, {
      method: 'POST',
      bearer: token,
      runnerSurface: 'chrome-extension',
      runnerProtocol: 'declarative-v1',
      body: { pluginId: 'magic-city-runner-extension' }
    });
    if (undispatchedClaim.response.status !== 409 || undispatchedClaim.data?.error !== 'extension_run_dispatch_required') {
      throw new Error(`undispatched_extension_claim_not_rejected:${undispatchedClaim.response.status}:${JSON.stringify(undispatchedClaim.data)}`);
    }
    const executionStart = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(sessionId)}/start-execution`, {
      method: 'POST',
      cookie: auth.cookie,
      body: { mode: 'agent_checkout', preferredExecutionAgentId: 'magic-city-runner-extension' }
    });
    if (!executionStart.response.ok || !executionStart.data.session?.extensionRunDispatch?.expiresAt) {
      throw new Error(`extension_dispatch_start_failed:${executionStart.response.status}:${JSON.stringify(executionStart.data)}`);
    }
    const dispatchedSessions = await request(baseUrl, '/connectors/sessions', {
      bearer: token,
      runnerSurface: 'chrome-extension'
    });
    if (!dispatchedSessions.response.ok) throw new Error(`dispatched_session_poll_failed:${dispatchedSessions.response.status}:${JSON.stringify(dispatchedSessions.data)}`);
    const extensionSession = (dispatchedSessions.data.sessions || []).find((entry) => entry.id === sessionId);
    if (!extensionSession?.missionBoundAuth?.token) throw new Error('extension_poll_missing_mission_capability_token');
    if (!extensionSession?.extensionRunDispatch?.expiresAt) {
      throw new Error('extension_poll_missing_explicit_user_dispatch');
    }
    const extensionPayload = JSON.stringify(extensionSession);
    if (extensionPayload.includes('private-runner-test@example.com') || extensionPayload.includes('Private runner test card')) {
      throw new Error('extension_poll_leaked_private_runner_data');
    }
    if (extensionSession.extensionMissionPlan?.schema !== 'magic-city-browser-plan-v1' || !extensionSession.extensionMissionPlan?.planHash) {
      throw new Error(`extension_poll_missing_declarative_plan:${JSON.stringify(extensionSession.extensionMissionPlan || {})}`);
    }
    const extensionPlanBeforeClaim = extensionSession.extensionMissionPlan;
    if (!extensionPlanBeforeClaim.startUrl.startsWith('https://www.amazon.com/s?')
      || !extensionPlanBeforeClaim.startUrl.includes('k=nature+valley+granola+bars')
      || !extensionPlanBeforeClaim.startUrl.includes('language=en_US')
      || !extensionPlanBeforeClaim.startUrl.includes('high-price=4')) {
      throw new Error(`extension_amazon_search_plan_invalid:${extensionPlanBeforeClaim.startUrl}`);
    }
    if (extensionPlanBeforeClaim.actions.some((action) => action.id === 'search-catalog')) {
      throw new Error('extension_amazon_plan_should_not_repeat_homepage_search');
    }
    if (!extensionPlanBeforeClaim.actions.some((action) => action.id === 'open-cart'
      && /\/gp\/cart\/view\.html(?:\?|$)/.test(String(action.url || ''))
      && String(action.url || '').includes('language=en_US'))) {
      throw new Error('extension_amazon_plan_should_open_cart_before_checkout');
    }
    if (!extensionPlanBeforeClaim.actions.some((action) => action.id === 'continue-checkout' && action.intent === 'checkout')) {
      throw new Error('extension_amazon_plan_should_continue_checkout_before_review');
    }

    const holderKey = crypto.generateKeyPairSync('ed25519');
    const claimStartedAt = Date.now();
    const claimedSession = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(sessionId)}/claim`, {
      method: 'POST',
      bearer: token,
      runnerSurface: 'chrome-extension',
      runnerProtocol: 'declarative-v1',
      body: {
        pluginId: 'magic-city-runner-extension',
        holderPublicKeyJwk: holderKey.publicKey.export({ format: 'jwk' }),
        extensionDispatchNonce: extensionSession.extensionRunDispatch.nonce
      }
    });
    const claimDurationMs = Date.now() - claimStartedAt;
    if (!claimedSession.response.ok) {
      throw new Error(`extension_claim_failed:${claimedSession.response.status}:${JSON.stringify(claimedSession.data)}`);
    }
    if (claimedSession.data.session?.localPrivateContext || !claimedSession.data.session?.missionBoundAuth?.token) {
      throw new Error('extension_claim_session_surface_invalid');
    }
    const extensionPlan = claimedSession.data.session?.extensionMissionPlan;
    if (!extensionPlan?.planHash || extensionPlan.actions?.[0]?.id !== 'open-site') {
      throw new Error(`extension_claim_missing_plan:${JSON.stringify(extensionPlan || {})}`);
    }
    const firstCheckpointStartedAt = Date.now();
    const permissionCheckpoint = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(sessionId)}/checkpoint`, {
      method: 'POST',
      bearer: token,
      runnerSurface: 'chrome-extension',
      runnerProtocol: 'declarative-v1',
      body: {
        pluginId: 'magic-city-runner-extension',
        label: 'Browser access needed',
        detail: 'Enable amazon.com in Magic City Runner before it can open this mission locally.',
        state: 'permission_required',
        missionAction: 'browser_open',
        targetUrl: 'https://www.amazon.com/s?k=nature+valley+granola+bars',
        planHash: extensionPlan.planHash,
        planActionId: 'open-site',
        planActionStatus: 'waiting',
        proofOfPossession: buildPopProof({
          keyPair: holderKey,
          session: claimedSession.data.session,
          action: 'browser_open',
          targetUrl: 'https://www.amazon.com/s?k=nature+valley+granola+bars'
        })
      }
    });
    const firstCheckpointDurationMs = Date.now() - firstCheckpointStartedAt;
    if (!permissionCheckpoint.response.ok) {
      throw new Error(`extension_permission_checkpoint_failed:${permissionCheckpoint.response.status}:${JSON.stringify(permissionCheckpoint.data)}`);
    }
    const permissionPausedSession = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(sessionId)}`, {
      cookie: auth.cookie
    });
    if (!permissionPausedSession.response.ok
      || permissionPausedSession.data.session?.status !== 'executing'
      || permissionPausedSession.data.session?.executionLive?.state !== 'permission_required') {
      throw new Error(`extension_permission_pause_not_preserved:${JSON.stringify(permissionPausedSession.data)}`);
    }
    const badPlanStep = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(sessionId)}/checkpoint`, {
      method: 'POST',
      bearer: token,
      runnerSurface: 'chrome-extension',
      runnerProtocol: 'declarative-v1',
      body: {
        pluginId: 'magic-city-runner-extension',
        label: 'Tampered plan step',
        missionAction: 'read_public_page',
        targetUrl: 'https://www.amazon.com/s?k=nature+valley+granola+bars',
        planHash: extensionPlan.planHash,
        planActionId: 'inspect-results',
        planActionStatus: 'completed',
        proofOfPossession: buildPopProof({
          keyPair: holderKey,
          session: permissionCheckpoint.data.session,
          action: 'read_public_page',
          targetUrl: 'https://www.amazon.com/s?k=nature+valley+granola+bars'
        })
      }
    });
    if (badPlanStep.response.status !== 409) {
      throw new Error(`extension_out_of_order_plan_step_not_rejected:${badPlanStep.response.status}:${JSON.stringify(badPlanStep.data)}`);
    }
    const openedCheckpointBody = {
      pluginId: 'magic-city-runner-extension',
      label: 'Opened Amazon',
      missionAction: 'browser_open',
      targetUrl: 'https://www.amazon.com/s?k=nature+valley+granola+bars',
      planHash: extensionPlan.planHash,
      planActionId: 'open-site',
      planActionStatus: 'completed',
      browser: { url: 'https://www.amazon.com/s?k=nature+valley+granola+bars', title: 'Amazon search' },
      runnerTiming: {
        workerStartedAt: '2026-09-10T17:00:00.000Z',
        checkpointRequestedAt: '2026-09-10T17:00:01.000Z'
      },
      proofOfPossession: buildPopProof({
        keyPair: holderKey,
        session: permissionCheckpoint.data.session,
        action: 'browser_open',
        targetUrl: 'https://www.amazon.com/s?k=nature+valley+granola+bars'
      })
    };
    const openedCheckpoint = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(sessionId)}/checkpoint`, {
      method: 'POST',
      bearer: token,
      runnerSurface: 'chrome-extension',
      runnerProtocol: 'declarative-v1',
      body: openedCheckpointBody
    });
    if (!openedCheckpoint.response.ok || openedCheckpoint.data.session?.extensionMissionPlanState?.nextActionIndex !== 1) {
      throw new Error(`extension_open_plan_step_failed:${openedCheckpoint.response.status}:${JSON.stringify(openedCheckpoint.data)}`);
    }
    const replayedOpenedCheckpoint = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(sessionId)}/checkpoint`, {
      method: 'POST',
      bearer: token,
      runnerSurface: 'chrome-extension',
      runnerProtocol: 'declarative-v1',
      body: openedCheckpointBody
    });
    if (!replayedOpenedCheckpoint.response.ok
      || replayedOpenedCheckpoint.data.replayed !== true
      || replayedOpenedCheckpoint.data.session?.extensionMissionPlanState?.nextActionIndex !== 1) {
      throw new Error(`extension_exact_checkpoint_replay_not_recovered:${replayedOpenedCheckpoint.response.status}:${JSON.stringify(replayedOpenedCheckpoint.data)}`);
    }
    const alteredCheckpointReplay = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(sessionId)}/checkpoint`, {
      method: 'POST',
      bearer: token,
      runnerSurface: 'chrome-extension',
      runnerProtocol: 'declarative-v1',
      body: { ...openedCheckpointBody, label: 'Altered replay must fail' }
    });
    if (alteredCheckpointReplay.response.status !== 409) {
      throw new Error(`extension_altered_checkpoint_replay_not_rejected:${alteredCheckpointReplay.response.status}:${JSON.stringify(alteredCheckpointReplay.data)}`);
    }
    const nextPlanAction = extensionPlan.actions?.[1];
    if (!nextPlanAction?.id || !nextPlanAction?.missionAction) {
      throw new Error(`extension_next_plan_step_missing:${JSON.stringify(extensionPlan.actions || [])}`);
    }
    if (nextPlanAction.type !== 'select_candidate') {
      throw new Error(`extension_selection_intelligence_action_missing:${JSON.stringify(nextPlanAction)}`);
    }
    const intelligenceCandidates = [{
      id: 'candidate-1',
      asin: 'B000FRUIT1',
      title: 'Nature Valley Mixed Berry Crunchy Granola Bars',
      packageFacts: null,
      price: 3.79,
      primeEligible: true,
      freeShipping: true,
      conditionalShipping: false,
      requiresProductPageVerification: false,
      identityStatus: 'verified',
      sponsored: false,
      hardEligible: true
    }];
    const observationHash = protocolHash({
      schema: 'magic-city-amazon-candidate-observation-v1',
      candidates: intelligenceCandidates
    });
    const intelligenceRequestId = protocolHash({
      schema: 'magic-city-amazon-selection-advice-request-v1',
      sessionId,
      planHash: extensionPlan.planHash,
      actionId: nextPlanAction.id,
      observationHash
    });
    expectedIntelligenceRequestId = intelligenceRequestId;
    const intelligenceBody = {
      pluginId: 'magic-city-runner-extension',
      planHash: extensionPlan.planHash,
      planActionId: nextPlanAction.id,
      requestId: intelligenceRequestId,
      observationHash,
      candidates: intelligenceCandidates
    };
    rankerDelayMs = 120;
    const intelligenceRequest = request(baseUrl, `/connectors/sessions/${encodeURIComponent(sessionId)}/rank-candidates`, {
      method: 'POST',
      bearer: token,
      runnerSurface: 'chrome-extension',
      runnerProtocol: 'declarative-v1',
      body: intelligenceBody
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const concurrentIntelligenceAdvice = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(sessionId)}/rank-candidates`, {
      method: 'POST',
      bearer: token,
      runnerSurface: 'chrome-extension',
      runnerProtocol: 'declarative-v1',
      body: intelligenceBody
    });
    const intelligenceAdvice = await intelligenceRequest;
    rankerDelayMs = 0;
    if (!intelligenceAdvice.response.ok
      || intelligenceAdvice.data?.decision !== 'select'
      || intelligenceAdvice.data?.selectedCandidateId !== 'candidate-1'
      || intelligenceAdvice.data?.requestId !== intelligenceRequestId
      || intelligenceAdvice.data?.observationHash !== observationHash
      || rankerProviderInput?.request !== (nextPlanAction.selectionBrief || nextPlanAction.query)
      || JSON.stringify(Object.keys(rankerProviderInput?.candidates?.[0] || {}).sort()) !== JSON.stringify(['id', 'title'])
      || rankerSawDurableAttempt !== true
      || rankerCalls !== 1) {
      throw new Error(`extension_selection_intelligence_failed:${intelligenceAdvice.response.status}:${JSON.stringify({ response: intelligenceAdvice.data, rankerProviderInput, rankerSawDurableAttempt, rankerCalls })}`);
    }
    if (concurrentIntelligenceAdvice.response.status !== 202
      || concurrentIntelligenceAdvice.data?.decision !== 'abstain'
      || rankerCalls !== 1) {
      throw new Error(`extension_selection_intelligence_concurrent_repeat_not_bounded:${concurrentIntelligenceAdvice.response.status}:${JSON.stringify(concurrentIntelligenceAdvice.data)}:${rankerCalls}`);
    }
    const replayedIntelligenceAdvice = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(sessionId)}/rank-candidates`, {
      method: 'POST',
      bearer: token,
      runnerSurface: 'chrome-extension',
      runnerProtocol: 'declarative-v1',
      body: intelligenceBody
    });
    if (!replayedIntelligenceAdvice.response.ok
      || replayedIntelligenceAdvice.data?.replayed !== true
      || replayedIntelligenceAdvice.data?.selectedCandidateId !== 'candidate-1'
      || rankerCalls !== 1) {
      throw new Error(`extension_selection_intelligence_replay_failed:${replayedIntelligenceAdvice.response.status}:${JSON.stringify(replayedIntelligenceAdvice.data)}:${rankerCalls}`);
    }
    const changedCandidates = intelligenceCandidates.map((candidate) => ({ ...candidate, price: 3.99 }));
    const changedObservationHash = protocolHash({
      schema: 'magic-city-amazon-candidate-observation-v1',
      candidates: changedCandidates
    });
    const changedIntelligenceAdvice = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(sessionId)}/rank-candidates`, {
      method: 'POST',
      bearer: token,
      runnerSurface: 'chrome-extension',
      runnerProtocol: 'declarative-v1',
      body: {
        ...intelligenceBody,
        candidates: changedCandidates,
        observationHash: changedObservationHash,
        requestId: protocolHash({
          schema: 'magic-city-amazon-selection-advice-request-v1',
          sessionId,
          planHash: extensionPlan.planHash,
          actionId: nextPlanAction.id,
          observationHash: changedObservationHash
        })
      }
    });
    if (changedIntelligenceAdvice.response.status !== 409
      || changedIntelligenceAdvice.data?.error !== 'amazon_candidate_ranker_action_already_attempted'
      || rankerCalls !== 1) {
      throw new Error(`extension_selection_intelligence_changed_replay_not_rejected:${changedIntelligenceAdvice.response.status}:${JSON.stringify(changedIntelligenceAdvice.data)}:${rankerCalls}`);
    }
    const signedCheckpoint = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(sessionId)}/checkpoint`, {
      method: 'POST',
      bearer: token,
      runnerSurface: 'chrome-extension',
      runnerProtocol: 'declarative-v1',
      body: {
        pluginId: 'magic-city-runner-extension',
        label: `Extension completed ${nextPlanAction.id}`,
        missionAction: nextPlanAction.missionAction,
        targetUrl: 'https://www.amazon.com/s?k=nature+valley+granola+bars',
        planHash: extensionPlan.planHash,
        planActionId: nextPlanAction.id,
        planActionStatus: 'completed',
        browser: { url: 'https://www.amazon.com/s?k=nature+valley+granola+bars', title: 'Amazon search' },
        proofOfPossession: buildPopProof({
          keyPair: holderKey,
          session: openedCheckpoint.data.session,
          action: nextPlanAction.missionAction,
          targetUrl: 'https://www.amazon.com/s?k=nature+valley+granola+bars'
        })
      }
    });
    if (!signedCheckpoint.response.ok) {
      throw new Error(`extension_signed_checkpoint_failed:${signedCheckpoint.response.status}:${JSON.stringify(signedCheckpoint.data)}`);
    }
    if (signedCheckpoint.data.session?.missionBoundaryEventCount < 2 || JSON.stringify(signedCheckpoint.data.session).includes('private-runner-test@example.com')) {
      throw new Error('extension_signed_checkpoint_surface_invalid');
    }

    const renewedMission = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(sessionId)}/renew-mission`, {
      method: 'POST',
      cookie: auth.cookie,
      body: { reason: 'user_retry' }
    });
    if (!renewedMission.response.ok || !renewedMission.data.renewed) {
      throw new Error(`extension_mission_renewal_failed:${renewedMission.response.status}:${JSON.stringify(renewedMission.data)}`);
    }
    const renewedSession = renewedMission.data.session || {};
    if (!renewedSession.missionBoundAuth?.token
      || renewedSession.missionBoundAuth.token === signedCheckpoint.data.session?.missionBoundAuth?.token
      || renewedSession.missionBoundAuth?.confirmation?.holderKeyThumbprint !== signedCheckpoint.data.session?.missionBoundAuth?.confirmation?.holderKeyThumbprint
      || JSON.stringify(renewedSession.missionBoundAuth?.policy || {}) !== JSON.stringify(signedCheckpoint.data.session?.missionBoundAuth?.policy || {})
      || renewedSession.missionCapabilityRenewal?.count !== 1) {
      throw new Error(`extension_mission_renewal_scope_or_holder_changed:${JSON.stringify({
        tokenRotated: Boolean(renewedSession.missionBoundAuth?.token && renewedSession.missionBoundAuth.token !== signedCheckpoint.data.session?.missionBoundAuth?.token),
        holderBefore: signedCheckpoint.data.session?.missionBoundAuth?.confirmation?.holderKeyThumbprint || null,
        holderAfter: renewedSession.missionBoundAuth?.confirmation?.holderKeyThumbprint || null,
        policyBefore: signedCheckpoint.data.session?.missionBoundAuth?.policy || null,
        policyAfter: renewedSession.missionBoundAuth?.policy || null,
        renewalCount: renewedSession.missionCapabilityRenewal?.count ?? null
      })}`);
    }
    const renewedNextAction = extensionPlan.actions?.[Number(renewedSession.extensionMissionPlanState?.nextActionIndex || 0)];
    if (!renewedNextAction?.id || !renewedNextAction?.missionAction) throw new Error('extension_renewed_next_plan_action_missing');
    const renewedCheckpoint = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(sessionId)}/checkpoint`, {
      method: 'POST',
      bearer: token,
      runnerSurface: 'chrome-extension',
      runnerProtocol: 'declarative-v1',
      body: {
        pluginId: 'magic-city-runner-extension',
        label: 'Extension resumed after renewal',
        missionAction: renewedNextAction.missionAction,
        targetUrl: 'https://www.amazon.com/s?k=nature+valley+granola+bars',
        planHash: extensionPlan.planHash,
        planActionId: renewedNextAction.id,
        planActionStatus: 'completed',
        proofOfPossession: buildPopProof({
          keyPair: holderKey,
          session: renewedSession,
          action: renewedNextAction.missionAction,
          targetUrl: 'https://www.amazon.com/s?k=nature+valley+granola+bars'
        })
      }
    });
    if (!renewedCheckpoint.response.ok) {
      throw new Error(`extension_renewed_checkpoint_failed:${renewedCheckpoint.response.status}:${JSON.stringify(renewedCheckpoint.data)}`);
    }

    const ownerTrace = await request(baseUrl, `/mission-auth/sessions/${encodeURIComponent(sessionId)}/trace`, {
      cookie: auth.cookie
    });
    if (!ownerTrace.response.ok || ownerTrace.response.headers.get('cache-control') !== 'no-store') {
      throw new Error(`owner_trace_privacy_headers_invalid:${ownerTrace.response.status}:${JSON.stringify(ownerTrace.data)}`);
    }
    const exportedTrace = JSON.stringify(ownerTrace.data);
    if (exportedTrace.includes('nature+valley+granola+bars') || exportedTrace.includes('Enable amazon.com')) {
      throw new Error('mission_trace_export_leaked_private_browser_or_detail_text');
    }

    const secondAuth = await request(baseUrl, '/auth/register', {
      method: 'POST',
      body: {
        email: `runner-extension-other-${crypto.randomBytes(4).toString('hex')}@example.com`,
        passphrase: 'runner-extension-test-passphrase',
        displayName: 'Other Runner Extension Test'
      }
    });
    if (!secondAuth.response.ok || !secondAuth.cookie) throw new Error('second_user_auth_failed');
    const crossAccountRenewal = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(sessionId)}/renew-mission`, {
      method: 'POST',
      cookie: secondAuth.cookie,
      body: { reason: 'user_retry' }
    });
    if (crossAccountRenewal.response.status !== 404) {
      throw new Error(`cross_account_mission_renewal_not_private:${crossAccountRenewal.response.status}:${JSON.stringify(crossAccountRenewal.data)}`);
    }
    const crossAccountTrace = await request(baseUrl, `/mission-auth/sessions/${encodeURIComponent(sessionId)}/trace`, {
      cookie: secondAuth.cookie
    });
    if (crossAccountTrace.response.status !== 404) {
      throw new Error(`cross_account_trace_not_private:${crossAccountTrace.response.status}:${JSON.stringify(crossAccountTrace.data)}`);
    }
    const artifactDirectory = path.join(tmpDir, 'data', 'execution-artifacts');
    fs.mkdirSync(artifactDirectory, { recursive: true });
    const privateArtifactFile = `${sessionId}-browser-private-search.md`;
    fs.writeFileSync(path.join(artifactDirectory, privateArtifactFile), 'nature valley granola bars private search details');
    const crossAccountArtifact = await request(baseUrl, `/artifacts/${encodeURIComponent(privateArtifactFile)}`, {
      cookie: secondAuth.cookie
    });
    if (crossAccountArtifact.response.status !== 404) {
      throw new Error(`cross_account_artifact_not_private:${crossAccountArtifact.response.status}`);
    }
    const ownerArtifact = await request(baseUrl, `/artifacts/${encodeURIComponent(privateArtifactFile)}`, {
      cookie: auth.cookie
    });
    if (!ownerArtifact.response.ok || ownerArtifact.response.headers.get('cache-control') !== 'no-store') {
      throw new Error(`owner_artifact_privacy_headers_invalid:${ownerArtifact.response.status}`);
    }
    const missionReceipt = await request(baseUrl, `/mission-auth/sessions/${encodeURIComponent(sessionId)}/receipts`, {
      method: 'POST',
      cookie: auth.cookie,
      body: {
        action: 'handoff',
        targetUrl: 'https://www.amazon.com/s?k=nature+valley+granola+bars',
        outcome: 'failure',
        note: 'Privacy regression receipt for private Magic Internet Agent run URLs.',
        proofOfPossession: buildPopProof({
          keyPair: holderKey,
          session: renewedCheckpoint.data.session,
          action: 'handoff',
          targetUrl: 'https://www.amazon.com/s?k=nature+valley+granola+bars'
        })
      }
    });
    if (missionReceipt.response.status !== 201 || !missionReceipt.data.receipt?.id) {
      throw new Error(`mission_receipt_privacy_fixture_failed:${missionReceipt.response.status}:${JSON.stringify(missionReceipt.data)}`);
    }
    const receiptId = missionReceipt.data.receipt.id;
    const crossAccountReceipt = await request(baseUrl, `/proofs/receipt/${encodeURIComponent(receiptId)}`, {
      cookie: secondAuth.cookie
    });
    if (crossAccountReceipt.response.status !== 404) {
      throw new Error(`cross_account_receipt_not_private:${crossAccountReceipt.response.status}`);
    }
    const sameAccountSecondSession = await request(baseUrl, '/auth/login', {
      method: 'POST',
      body: {
        email,
        passphrase: 'runner-extension-test-passphrase'
      }
    });
    if (!sameAccountSecondSession.response.ok || !sameAccountSecondSession.cookie) {
      throw new Error(`same_account_second_session_auth_failed:${sameAccountSecondSession.response.status}:${JSON.stringify(sameAccountSecondSession.data)}`);
    }
    const sameAccountOtherSessionArtifact = await request(baseUrl, `/artifacts/${encodeURIComponent(privateArtifactFile)}`, {
      cookie: sameAccountSecondSession.cookie
    });
    if (sameAccountOtherSessionArtifact.response.status !== 404) {
      throw new Error(`same_account_other_session_artifact_not_private:${sameAccountOtherSessionArtifact.response.status}`);
    }
    const unauthenticatedArtifact = await request(baseUrl, `/artifacts/${encodeURIComponent(privateArtifactFile)}`);
    if (unauthenticatedArtifact.response.status !== 404) {
      throw new Error(`unauthenticated_artifact_not_private:${unauthenticatedArtifact.response.status}`);
    }
    const sameAccountOtherSessionReceipt = await request(baseUrl, `/proofs/receipt/${encodeURIComponent(receiptId)}`, {
      cookie: sameAccountSecondSession.cookie
    });
    if (sameAccountOtherSessionReceipt.response.status !== 404) {
      throw new Error(`same_account_other_session_receipt_not_private:${sameAccountOtherSessionReceipt.response.status}`);
    }
    const unauthenticatedReceipt = await request(baseUrl, `/proofs/receipt/${encodeURIComponent(receiptId)}`);
    if (unauthenticatedReceipt.response.status !== 404) {
      throw new Error(`unauthenticated_receipt_not_private:${unauthenticatedReceipt.response.status}`);
    }
    const ownerReceipt = await request(baseUrl, `/proofs/receipt/${encodeURIComponent(receiptId)}`, {
      cookie: auth.cookie
    });
    if (!ownerReceipt.response.ok || ownerReceipt.response.headers.get('cache-control') !== 'no-store') {
      throw new Error(`owner_receipt_privacy_headers_invalid:${ownerReceipt.response.status}`);
    }
    const anchorSubmissionId = missionReceipt.data.executionVerification?.anchorSubmissionId || '';
    if (anchorSubmissionId) {
      const crossAccountAnchor = await request(baseUrl, `/anchors/status/${encodeURIComponent(anchorSubmissionId)}`, {
        cookie: secondAuth.cookie
      });
      if (crossAccountAnchor.response.status !== 404) {
        throw new Error(`cross_account_anchor_not_private:${crossAccountAnchor.response.status}`);
      }
      const sameAccountOtherSessionAnchor = await request(baseUrl, `/anchors/status/${encodeURIComponent(anchorSubmissionId)}`, {
        cookie: sameAccountSecondSession.cookie
      });
      if (sameAccountOtherSessionAnchor.response.status !== 404) {
        throw new Error(`same_account_other_session_anchor_not_private:${sameAccountOtherSessionAnchor.response.status}`);
      }
      const unauthenticatedAnchor = await request(baseUrl, `/anchors/status/${encodeURIComponent(anchorSubmissionId)}`);
      if (unauthenticatedAnchor.response.status !== 404) {
        throw new Error(`unauthenticated_anchor_not_private:${unauthenticatedAnchor.response.status}`);
      }
      const ownerAnchor = await request(baseUrl, `/anchors/status/${encodeURIComponent(anchorSubmissionId)}`, {
        cookie: auth.cookie
      });
      if (!ownerAnchor.response.ok || ownerAnchor.response.headers.get('cache-control') !== 'no-store') {
        throw new Error(`owner_anchor_privacy_headers_invalid:${ownerAnchor.response.status}`);
      }
    }

    const legacySessionStart = await request(baseUrl, '/connectors/sessions/start', {
      method: 'POST',
      cookie: auth.cookie,
      body: {
        connectorId: 'browser-worker-demo-v1',
        preferredExecutionAgentId: 'magic-city-runner-extension',
        prompt: 'buy nature valley granola bars from amazon under $4',
        profileSummary: {}
      }
    });
    if (legacySessionStart.response.status !== 201) {
      throw new Error(`legacy_extension_session_start_failed:${legacySessionStart.response.status}:${JSON.stringify(legacySessionStart.data)}`);
    }
    const legacySessionId = legacySessionStart.data.session?.id;
    const legacyCompletionMode = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(legacySessionId)}/completion-mode`, {
      method: 'POST',
      cookie: auth.cookie,
      body: { mode: 'agent_checkout' }
    });
    if (!legacyCompletionMode.response.ok) {
      throw new Error(`legacy_extension_completion_mode_failed:${legacyCompletionMode.response.status}:${JSON.stringify(legacyCompletionMode.data)}`);
    }
    const legacyExecutionStart = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(legacySessionId)}/start-execution`, {
      method: 'POST',
      cookie: auth.cookie,
      body: { mode: 'agent_checkout', preferredExecutionAgentId: 'magic-city-runner-extension' }
    });
    if (!legacyExecutionStart.response.ok || !legacyExecutionStart.data.session?.extensionRunDispatch?.expiresAt) {
      throw new Error(`legacy_extension_dispatch_start_failed:${legacyExecutionStart.response.status}:${JSON.stringify(legacyExecutionStart.data)}`);
    }
    const legacyPoll = await request(baseUrl, '/connectors/sessions', {
      bearer: token,
      runnerSurface: 'chrome-extension'
    });
    const legacySession = (legacyPoll.data.sessions || []).find((entry) => entry.id === legacySessionId);
    if (!legacySession?.missionBoundAuth?.token || legacySession?.localPrivateContext) {
      throw new Error('legacy_extension_poll_surface_invalid');
    }
    const legacyHolderKey = crypto.generateKeyPairSync('ed25519');
    const legacyClaim = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(legacySessionId)}/claim`, {
      method: 'POST',
      bearer: token,
      runnerSurface: 'chrome-extension',
      body: {
        pluginId: 'magic-city-runner-extension',
        holderPublicKeyJwk: legacyHolderKey.publicKey.export({ format: 'jwk' }),
        extensionDispatchNonce: legacySession.extensionRunDispatch?.nonce
      }
    });
    if (!legacyClaim.response.ok || !legacyClaim.data.session?.missionBoundAuth?.token) {
      throw new Error(`legacy_extension_claim_failed:${legacyClaim.response.status}:${JSON.stringify(legacyClaim.data)}`);
    }
    if (String(legacyClaim.data.session?.selections?.targetUrl || '').replace(/\/+$/, '') !== 'https://www.amazon.com') {
      throw new Error(`legacy_extension_target_url_not_preserved:${JSON.stringify(legacyClaim.data.session?.selections || {})}`);
    }
    const legacyPermissionCheckpoint = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(legacySessionId)}/checkpoint`, {
      method: 'POST',
      bearer: token,
      runnerSurface: 'chrome-extension',
      body: {
        pluginId: 'magic-city-runner-extension',
        label: 'Browser access needed',
        detail: 'Enable amazon.com in Magic City Runner before it can open this mission locally.',
        state: 'permission_required',
        missionAction: 'browser_open',
        targetUrl: 'https://www.amazon.com/s?k=nature+valley+granola+bars',
        proofOfPossession: buildPopProof({
          keyPair: legacyHolderKey,
          session: legacyClaim.data.session,
          action: 'browser_open',
          targetUrl: 'https://www.amazon.com/s?k=nature+valley+granola+bars'
        })
      }
    });
    if (!legacyPermissionCheckpoint.response.ok) {
      throw new Error(`legacy_extension_permission_checkpoint_failed:${legacyPermissionCheckpoint.response.status}:${JSON.stringify(legacyPermissionCheckpoint.data)}`);
    }
    const legacyPermissionPausedSession = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(legacySessionId)}`, {
      cookie: auth.cookie
    });
    if (!legacyPermissionPausedSession.response.ok || legacyPermissionPausedSession.data.session?.executionLive?.state !== 'permission_required') {
      throw new Error(`legacy_extension_permission_pause_not_preserved:${JSON.stringify(legacyPermissionPausedSession.data)}`);
    }

    const status = await request(baseUrl, '/native-runner/status', { cookie: auth.cookie });
    if (!status.response.ok) throw new Error(`runner_status_failed:${status.response.status}:${JSON.stringify(status.data)}`);
    if (!status.data.device?.id) throw new Error(`runner_status_missing_device:${JSON.stringify(status.data)}`);
    if (!status.data.checkoutReady || !status.data.executableReady) {
      throw new Error(`runner_status_missing_checkout_ready:${JSON.stringify(status.data)}`);
    }

    // The Magic City packaged executor has a release floor. A pairing created
    // by an older client can lack a version entirely, which must block only the
    // built-in runner rather than silently dispatching an unverified executor.
    await stopServer();
    const versionGateStatePath = path.join(tmpDir, 'data', 'state.json');
    const versionGateState = JSON.parse(fs.readFileSync(versionGateStatePath, 'utf8'));
    const versionGateDevice = versionGateState.nativeRunnerDevices.find((device) => device.id === claim.data.device?.id);
    if (!versionGateDevice) throw new Error('version_gate_fixture_device_missing');
    const expectedExtensionVersion = versionGateDevice.metadata?.extensionVersion;
    delete versionGateDevice.metadata.extensionVersion;
    fs.writeFileSync(versionGateStatePath, JSON.stringify(versionGateState));
    child = startServer();
    await waitForServer(baseUrl);
    const unversionedRunnerStatus = await request(baseUrl, `/native-runner/status?deviceId=${encodeURIComponent(versionGateDevice.id)}`, {
      cookie: auth.cookie
    });
    if (!unversionedRunnerStatus.response.ok
      || unversionedRunnerStatus.data.readiness?.extensionUpdateRequired !== true
      || unversionedRunnerStatus.data.readiness?.reason !== 'runner_extension_outdated'
      || unversionedRunnerStatus.data.ready !== false
      || unversionedRunnerStatus.data.checkoutReady !== false) {
      throw new Error(`unversioned_builtin_runner_not_blocked:${JSON.stringify(unversionedRunnerStatus.data)}`);
    }
    await stopServer();
    const restoredVersionGateState = JSON.parse(fs.readFileSync(versionGateStatePath, 'utf8'));
    const restoredVersionGateDevice = restoredVersionGateState.nativeRunnerDevices.find((device) => device.id === versionGateDevice.id);
    if (!restoredVersionGateDevice) throw new Error('version_gate_restore_device_missing');
    restoredVersionGateDevice.metadata = {
      ...(restoredVersionGateDevice.metadata || {}),
      extensionVersion: expectedExtensionVersion
    };
    fs.writeFileSync(versionGateStatePath, JSON.stringify(restoredVersionGateState));
    child = startServer();
    await waitForServer(baseUrl);

    // A watchdog failure can leave a persisted browser session with an expired capability.
    // An owner retry must create a fresh same-scope bearer capability and reset stale
    // declarative plan state without rebuilding the signed plan before the extension
    // binds its holder key again.
    const staleCapabilityToken = legacyClaim.data.session.missionBoundAuth.token;
    await stopServer();
    const statePath = path.join(tmpDir, 'data', 'state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const staleSession = state.connectorSessions.find((entry) => entry.id === legacySessionId);
    if (!staleSession?.missionBoundAuth?.token) throw new Error('expired_retry_fixture_session_missing');
    const stalePlanHash = staleSession.extensionMissionPlan?.planHash;
    if (!stalePlanHash) throw new Error('expired_retry_fixture_plan_missing');
    staleSession.status = 'failed';
    staleSession.fulfillment = { status: 'failed', result: { latestFailureReason: 'test fixture' } };
    staleSession.missionBoundAuth.expiresAt = new Date(0).toISOString();
    staleSession.extensionMissionPlanState = {
      ...(staleSession.extensionMissionPlanState || {}),
      nextActionIndex: 2
    };
    fs.writeFileSync(statePath, JSON.stringify(state));
    child = startServer();
    await waitForServer(baseUrl);

    const expiredRetry = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(legacySessionId)}/start-execution`, {
      method: 'POST',
      cookie: auth.cookie,
      body: { mode: 'agent_checkout' }
    });
    if (!expiredRetry.response.ok) {
      throw new Error(`expired_capability_retry_failed:${expiredRetry.response.status}:${JSON.stringify(expiredRetry.data)}`);
    }
    const retriedSession = expiredRetry.data.session || {};
    if (retriedSession.status !== 'queued'
      || !retriedSession.missionBoundAuth?.token
      || retriedSession.missionBoundAuth.token === staleCapabilityToken
      || retriedSession.missionBoundAuth.confirmation?.method !== 'bearer'
      || retriedSession.missionRuntimeHolder !== null
      || retriedSession.extensionMissionPlan?.planHash !== stalePlanHash
      || retriedSession.extensionMissionPlanState?.planHash !== stalePlanHash
      || Number(retriedSession.extensionMissionPlanState?.nextActionIndex) !== 0
      || retriedSession.fulfillment !== null
      || retriedSession.failedAt !== null
      || retriedSession.claimedByPluginId !== null) {
      throw new Error(`expired_capability_retry_did_not_reset_authority:${JSON.stringify(retriedSession)}`);
    }
    const retryPoll = await request(baseUrl, '/connectors/sessions', {
      bearer: token,
      runnerSurface: 'chrome-extension'
    });
    const retryExtensionSession = (retryPoll.data.sessions || []).find((entry) => entry.id === legacySessionId);
    if (!retryPoll.response.ok || retryExtensionSession?.missionBoundAuth?.token !== retriedSession.missionBoundAuth.token) {
      throw new Error(`expired_capability_retry_not_visible_to_extension:${JSON.stringify(retryPoll.data)}`);
    }
    const retryHolderKey = crypto.generateKeyPairSync('ed25519');
    const retryClaim = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(legacySessionId)}/claim`, {
      method: 'POST',
      bearer: token,
      runnerSurface: 'chrome-extension',
      runnerProtocol: 'declarative-v1',
      body: {
        pluginId: 'magic-city-runner-extension',
        holderPublicKeyJwk: retryHolderKey.publicKey.export({ format: 'jwk' }),
        extensionDispatchNonce: retryExtensionSession?.extensionRunDispatch?.nonce
      }
    });
    if (!retryClaim.response.ok
      || retryClaim.data.session?.missionBoundAuth?.confirmation?.method !== 'proof-of-possession'
      || Number(retryClaim.data.session?.extensionMissionPlanState?.nextActionIndex) !== 0) {
      throw new Error(`expired_capability_retry_claim_not_reset:${retryClaim.response.status}:${JSON.stringify(retryClaim.data)}`);
    }

    const cancelledRun = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(legacySessionId)}/cancel`, {
      method: 'POST',
      cookie: auth.cookie,
      body: { requesterId: email }
    });
    if (!cancelledRun.response.ok
      || cancelledRun.data.session?.status !== 'failed'
      || !cancelledRun.data.session?.executionCancellation?.cancelledAt
      || cancelledRun.data.session?.extensionRunDispatch !== null) {
      throw new Error(`execution_cancel_failed:${cancelledRun.response.status}:${JSON.stringify(cancelledRun.data)}`);
    }
    if (Number(cancelledRun.data.session?.creditReservation?.requiredCredits || 0) > 0
      && cancelledRun.data.session?.creditReservation?.status !== 'released') {
      throw new Error(`execution_cancel_did_not_release_locked_credits:${JSON.stringify(cancelledRun.data.session?.creditReservation || {})}`);
    }
    const cancelledRunnerStatus = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(legacySessionId)}/runner-status`, {
      method: 'POST',
      bearer: token,
      runnerSurface: 'chrome-extension',
      runnerProtocol: 'declarative-v1',
      body: { pluginId: 'magic-city-runner-extension' }
    });
    if (cancelledRunnerStatus.response.status !== 409 || cancelledRunnerStatus.data?.error !== 'execution_cancelled') {
      throw new Error(`cancelled_runner_status_was_accepted:${cancelledRunnerStatus.response.status}:${JSON.stringify(cancelledRunnerStatus.data)}`);
    }
    const cancelledPlan = retryClaim.data.session?.extensionMissionPlan;
    const cancelledAction = cancelledPlan?.actions?.[0];
    const cancelledCheckpoint = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(legacySessionId)}/checkpoint`, {
      method: 'POST',
      bearer: token,
      runnerSurface: 'chrome-extension',
      runnerProtocol: 'declarative-v1',
      body: {
        pluginId: 'magic-city-runner-extension',
        label: 'Stale runner checkpoint',
        state: 'running',
        missionAction: cancelledAction?.missionAction || 'inspect',
        targetUrl: cancelledPlan?.startUrl || 'https://www.amazon.com/',
        planHash: cancelledPlan?.planHash,
        planActionId: cancelledAction?.id,
        planActionStatus: 'waiting',
        proofOfPossession: buildPopProof({
          keyPair: retryHolderKey,
          session: retryClaim.data.session,
          action: cancelledAction?.missionAction || 'inspect',
          targetUrl: cancelledPlan?.startUrl || 'https://www.amazon.com/'
        })
      }
    });
    if (cancelledCheckpoint.response.status !== 409 || cancelledCheckpoint.data?.error !== 'execution_cancelled') {
      throw new Error(`cancelled_runner_checkpoint_was_accepted:${cancelledCheckpoint.response.status}:${JSON.stringify(cancelledCheckpoint.data)}`);
    }
    const cancelledFulfillment = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(legacySessionId)}/fulfill`, {
      method: 'POST',
      bearer: token,
      runnerSurface: 'chrome-extension',
      runnerProtocol: 'declarative-v1',
      body: {
        pluginId: 'magic-city-runner-extension',
        status: 'fulfilled',
        missionAction: 'handoff',
        planHash: cancelledPlan?.planHash,
        proofOfPossession: buildPopProof({
          keyPair: retryHolderKey,
          session: retryClaim.data.session,
          action: 'handoff',
          targetUrl: cancelledPlan?.startUrl || 'https://www.amazon.com/'
        })
      }
    });
    if (cancelledFulfillment.response.status !== 409 || cancelledFulfillment.data?.error !== 'execution_cancelled') {
      throw new Error(`cancelled_runner_fulfillment_was_accepted:${cancelledFulfillment.response.status}:${JSON.stringify(cancelledFulfillment.data)}`);
    }
    const cancelledPoll = await request(baseUrl, '/connectors/sessions', {
      bearer: token,
      runnerSurface: 'chrome-extension'
    });
    if (!cancelledPoll.response.ok || (cancelledPoll.data.sessions || []).some((entry) => entry.id === legacySessionId)) {
      throw new Error(`cancelled_execution_visible_to_runner:${JSON.stringify(cancelledPoll.data)}`);
    }
    const cancelledRestart = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(legacySessionId)}/start-execution`, {
      method: 'POST',
      cookie: auth.cookie,
      body: { mode: 'agent_checkout' }
    });
    if (cancelledRestart.response.status !== 409 || cancelledRestart.data?.error !== 'execution_cancelled') {
      throw new Error(`cancelled_execution_restarted:${cancelledRestart.response.status}:${JSON.stringify(cancelledRestart.data)}`);
    }

    // A fresh second device must not keep a run alive when the device that
    // actually claimed the browser mission stopped reporting. This prevents a
    // different Chrome profile from masking a dead owner in the watchdog.
    const watchdogStart = await request(baseUrl, '/connectors/sessions/start', {
      method: 'POST',
      cookie: auth.cookie,
      body: {
        connectorId: 'browser-worker-demo-v1',
        preferredExecutionAgentId: 'magic-city-runner-extension',
        prompt: 'buy nature valley granola bars from amazon under $4',
        profileSummary: {}
      }
    });
    const watchdogSessionId = watchdogStart.data.session?.id;
    if (!watchdogStart.response.ok || !watchdogSessionId) {
      throw new Error(`watchdog_fixture_start_failed:${watchdogStart.response.status}:${JSON.stringify(watchdogStart.data)}`);
    }
    const watchdogMode = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(watchdogSessionId)}/completion-mode`, {
      method: 'POST',
      cookie: auth.cookie,
      body: { mode: 'agent_checkout' }
    });
    if (!watchdogMode.response.ok) throw new Error(`watchdog_fixture_mode_failed:${watchdogMode.response.status}:${JSON.stringify(watchdogMode.data)}`);
    const watchdogExecution = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(watchdogSessionId)}/start-execution`, {
      method: 'POST',
      cookie: auth.cookie,
      body: { mode: 'agent_checkout', preferredExecutionAgentId: 'magic-city-runner-extension' }
    });
    if (!watchdogExecution.response.ok) throw new Error(`watchdog_fixture_execution_failed:${watchdogExecution.response.status}:${JSON.stringify(watchdogExecution.data)}`);
    const watchdogPoll = await request(baseUrl, '/connectors/sessions', {
      bearer: token,
      runnerSurface: 'chrome-extension',
      runnerProtocol: 'declarative-v1'
    });
    const watchdogExtensionSession = (watchdogPoll.data.sessions || []).find((entry) => entry.id === watchdogSessionId);
    const watchdogHolderKey = crypto.generateKeyPairSync('ed25519');
    const watchdogClaim = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(watchdogSessionId)}/claim`, {
      method: 'POST',
      bearer: token,
      runnerSurface: 'chrome-extension',
      runnerProtocol: 'declarative-v1',
      body: {
        pluginId: 'magic-city-runner-extension',
        holderPublicKeyJwk: watchdogHolderKey.publicKey.export({ format: 'jwk' }),
        extensionDispatchNonce: watchdogExtensionSession?.extensionRunDispatch?.nonce
      }
    });
    if (!watchdogClaim.response.ok || !watchdogClaim.data.claimed) {
      throw new Error(`watchdog_fixture_claim_failed:${watchdogClaim.response.status}:${JSON.stringify(watchdogClaim.data)}`);
    }
    const watchdogPlan = watchdogClaim.data.session?.extensionMissionPlan;
    const watchdogStartAction = watchdogPlan?.actions?.[0];
    if (!watchdogPlan?.planHash || watchdogStartAction?.id !== 'open-site') {
      throw new Error(`watchdog_fixture_plan_missing:${JSON.stringify(watchdogPlan || {})}`);
    }
    const watchdogCheckpoint = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(watchdogSessionId)}/checkpoint`, {
      method: 'POST',
      bearer: token,
      runnerSurface: 'chrome-extension',
      runnerProtocol: 'declarative-v1',
      body: {
        pluginId: 'magic-city-runner-extension',
        label: 'Watchdog fixture started',
        missionAction: watchdogStartAction.missionAction,
        targetUrl: watchdogPlan.startUrl,
        planHash: watchdogPlan.planHash,
        planActionId: watchdogStartAction.id,
        planActionStatus: 'completed',
        browser: { url: watchdogPlan.startUrl, title: 'Amazon search' },
        proofOfPossession: buildPopProof({
          keyPair: watchdogHolderKey,
          session: watchdogClaim.data.session,
          action: watchdogStartAction.missionAction,
          targetUrl: watchdogPlan.startUrl
        })
      }
    });
    if (!watchdogCheckpoint.response.ok || watchdogCheckpoint.data.session?.status !== 'executing') {
      throw new Error(`watchdog_fixture_checkpoint_failed:${watchdogCheckpoint.response.status}:${JSON.stringify(watchdogCheckpoint.data)}`);
    }

    await stopServer();
    const watchdogStatePath = path.join(tmpDir, 'data', 'state.json');
    const watchdogState = JSON.parse(fs.readFileSync(watchdogStatePath, 'utf8'));
    const staleAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const watchdogSession = watchdogState.connectorSessions.find((entry) => entry.id === watchdogSessionId);
    const watchdogClaimedDeviceId = String(watchdogSession?.claimedByNativeRunnerDeviceId || '');
    const claimedDevice = watchdogState.nativeRunnerDevices.find((device) => device.id === watchdogClaimedDeviceId);
    if (!claimedDevice || !watchdogSession) throw new Error('watchdog_fixture_state_missing');
    Object.assign(claimedDevice, { lastPollAt: staleAt, lastSeenAt: staleAt, updatedAt: staleAt });
    watchdogState.nativeRunnerDevices.push({
      ...claimedDevice,
      id: `${claimedDevice.id}-fresh-other`,
      tokenHash: `watchdog-fresh-${crypto.randomBytes(8).toString('hex')}`,
      tokenLast4: 'test',
      lastPollAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    Object.assign(watchdogSession, {
      status: 'executing',
      createdAt: staleAt,
      completionRequestedAt: staleAt,
      executionRequestedAt: staleAt,
      claimedAt: staleAt,
      updatedAt: staleAt,
      executionLive: { state: 'running', label: 'fixture', createdAt: staleAt },
      executionTrace: [{ pluginId: 'magic-city-runner-extension', label: 'fixture', state: 'running', createdAt: staleAt }]
    });
    fs.writeFileSync(watchdogStatePath, JSON.stringify(watchdogState));
    child = startServer();
    await waitForServer(baseUrl);
    const watchdogOutcome = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(watchdogSessionId)}`, { cookie: auth.cookie });
    if (!watchdogOutcome.response.ok || watchdogOutcome.data.session?.status !== 'failed'
      || watchdogOutcome.data.session?.executionWatchdog?.lastReason !== 'executing_timeout') {
      throw new Error(`watchdog_claimed_device_heartbeat_not_enforced:${watchdogOutcome.response.status}:${JSON.stringify(watchdogOutcome.data)}`);
    }

    // A false checkout-profile mismatch used to release the initial credit hold,
    // clear the runner context, then make the user-facing repair button attempt
    // a second full credit reservation. Reconciliation must instead issue a
    // fresh, checkout-only capability against the preserved Amazon tab with no
    // additional debit or hold.
    await stopServer();
    const reconciliationState = JSON.parse(fs.readFileSync(watchdogStatePath, 'utf8'));
    const reconciliationSession = reconciliationState.connectorSessions.find((entry) => entry.id === watchdogSessionId);
    const reconciliationLock = reconciliationState.escrowLocks?.[watchdogSessionId] || null;
    const reconciliationDevice = reconciliationState.nativeRunnerDevices.find((device) => device.id === watchdogClaimedDeviceId);
    if (!reconciliationSession || !reconciliationDevice || reconciliationLock?.status !== 'released') {
      throw new Error(`checkout_reconcile_fixture_missing_released_hold:${JSON.stringify({
        session: reconciliationSession?.id || null,
        device: reconciliationDevice?.id || null,
        lock: reconciliationLock?.status || null
      })}`);
    }
    const reconciliationUserHash = reconciliationLock.userHash;
    const availableBeforeReconcile = Number(reconciliationState.userAccounts?.[reconciliationUserHash]?.available || 0);
    const recoveryNow = new Date().toISOString();
    Object.assign(reconciliationDevice, {
      lastPollAt: recoveryNow,
      lastSeenAt: recoveryNow,
      updatedAt: recoveryNow
    });
    reconciliationState.nativeRunnerDevices = reconciliationState.nativeRunnerDevices
      .filter((device) => device.id !== `${watchdogClaimedDeviceId}-fresh-other`);
    Object.assign(reconciliationSession, {
      status: 'failed',
      failedAt: recoveryNow,
      claimedAt: null,
      claimedByPluginId: null,
      claimedByRegistrationId: null,
      claimedByNativeRunnerDeviceId: null,
      pluginEndpoint: null,
      missionRuntimeHolder: null,
      extensionMissionPlan: null,
      extensionMissionPlanState: null,
      extensionRunDispatch: null,
      executionLive: null,
      preferredExecutionAgentId: 'magic-city-runner-extension',
      selections: {
        ...(reconciliationSession.selections || {}),
        finalApprovalPolicy: 'auto_submit_after_verified_checkout'
      },
      finalSelections: {
        ...(reconciliationSession.finalSelections || reconciliationSession.selections || {}),
        finalApprovalPolicy: 'auto_submit_after_verified_checkout'
      },
      fulfillment: {
        status: 'failed',
        result: {
          browserExecution: {
            stopState: 'address_verification_required',
            finalUrl: 'https://www.amazon.com/checkout/p/p-reconcile/address?pipelineType=Chewbacca',
            checkoutSummary: {
              stage: 'checkout',
              addressVerification: 'unverified'
            }
          }
        }
      }
    });
    fs.writeFileSync(watchdogStatePath, JSON.stringify(reconciliationState));
    child = startServer();
    await waitForServer(baseUrl);

    const checkoutReconcileResume = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(watchdogSessionId)}/start-execution`, {
      method: 'POST',
      cookie: auth.cookie,
      body: {
        mode: 'agent_checkout',
        requesterId: email,
        preferredExecutionAgentId: 'magic-city-runner-extension',
        localCheckoutProfileReady: true,
        extensionCheckoutProfileEnabled: true,
        extensionFinalSubmitEnabled: true,
        resumeCheckoutReconcile: true
      }
    });
    const resumedCheckoutSession = checkoutReconcileResume.data.session || {};
    if (!checkoutReconcileResume.response.ok
      || resumedCheckoutSession.status !== 'queued'
      || resumedCheckoutSession.creditReservation?.status !== 'continuation_no_additional_hold'
      || resumedCheckoutSession.creditReservation?.amountUnits !== 0
      || resumedCheckoutSession.extensionCheckoutReconcileResume !== true
      || resumedCheckoutSession.extensionFinalSubmitEnabled !== true
      || !resumedCheckoutSession.extensionRunDispatch?.nonce
      || !resumedCheckoutSession.missionBoundAuth?.token) {
      throw new Error(`checkout_reconcile_resume_not_credit_idempotent:${checkoutReconcileResume.response.status}:${JSON.stringify(checkoutReconcileResume.data)}`);
    }
    const reconciliationStateAfterStart = JSON.parse(fs.readFileSync(watchdogStatePath, 'utf8'));
    const availableAfterReconcile = Number(reconciliationStateAfterStart.userAccounts?.[reconciliationUserHash]?.available || 0);
    if (availableAfterReconcile !== availableBeforeReconcile
      || reconciliationStateAfterStart.escrowLocks?.[watchdogSessionId]?.status === 'locked') {
      throw new Error(`checkout_reconcile_changed_credit_balance:${JSON.stringify({
        availableBeforeReconcile,
        availableAfterReconcile,
        lock: reconciliationStateAfterStart.escrowLocks?.[watchdogSessionId]?.status || null
      })}`);
    }
    const reconcilePoll = await request(baseUrl, '/connectors/sessions', {
      bearer: token,
      runnerSurface: 'chrome-extension'
    });
    const reconcileMission = (reconcilePoll.data.sessions || []).find((entry) => entry.id === watchdogSessionId);
    if (!reconcilePoll.response.ok || !reconcileMission?.extensionRunDispatch?.nonce) {
      throw new Error(`checkout_reconcile_not_visible_to_runner:${JSON.stringify(reconcilePoll.data)}`);
    }
    const reconcileHolderKey = crypto.generateKeyPairSync('ed25519');
    const reconcileClaim = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(watchdogSessionId)}/claim`, {
      method: 'POST',
      bearer: token,
      runnerSurface: 'chrome-extension',
      runnerProtocol: 'declarative-v1',
      body: {
        pluginId: 'magic-city-runner-extension',
        holderPublicKeyJwk: reconcileHolderKey.publicKey.export({ format: 'jwk' }),
        extensionDispatchNonce: reconcileMission.extensionRunDispatch.nonce
      }
    });
    const reconcilePlan = reconcileClaim.data.session?.extensionMissionPlan || {};
    if (!reconcileClaim.response.ok
      || reconcilePlan.resumeCheckoutReconcile !== true
      || reconcilePlan.resumeCheckoutAutoSubmit !== true
      || reconcilePlan.startUrl !== 'https://www.amazon.com/checkout/p/p-reconcile/address?pipelineType=Chewbacca'
      || reconcilePlan.actions?.map((action) => action.type).join(',') !== 'navigate,fill_checkout_profile,click_intent,fill_checkout_profile,inspect,final_submit,final_submit,inspect,pause'
      || reconcilePlan.actions?.[0]?.preserveExistingCheckout !== true
      || reconcilePlan.actions?.[6]?.pendingOrderContinuation !== true
      || reconcilePlan.actions?.[6]?.priorFinalSubmitActionId !== 'submit-final-order'
      || reconcilePlan.actions?.[6]?.chainAuthorizationActionId !== 'submit-final-order'
      || reconcilePlan.limits?.stopBeforeFinalSubmit !== false
      || reconcilePlan.actions?.some((action) => action.type === 'prepare_cart')) {
      throw new Error(`checkout_reconcile_auto_submit_plan_invalid:${reconcileClaim.response.status}:${JSON.stringify(reconcilePlan)}`);
    }

    // A fresh auto-submit mission must carry its one-order authority all the
    // way through a claimed plan. This guards the server/runner contract that
    // previously allowed the browser to reach final review, then rejected the
    // final_submit checkpoint because the approval was never persisted.
    const autoSubmitStart = await request(baseUrl, '/connectors/sessions/start', {
      method: 'POST',
      cookie: auth.cookie,
      body: {
        connectorId: 'browser-worker-demo-v1',
        preferredExecutionAgentId: 'magic-city-runner-extension',
        prompt: 'buy nature valley granola bars from amazon under $4',
        profileSummary: {}
      }
    });
    const autoSubmitSessionId = autoSubmitStart.data.session?.id;
    if (!autoSubmitStart.response.ok || !autoSubmitSessionId) {
      throw new Error(`auto_submit_fixture_start_failed:${autoSubmitStart.response.status}:${JSON.stringify(autoSubmitStart.data)}`);
    }
    const autoSubmitMode = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(autoSubmitSessionId)}/completion-mode`, {
      method: 'POST',
      cookie: auth.cookie,
      body: { mode: 'agent_checkout' }
    });
    if (!autoSubmitMode.response.ok) {
      throw new Error(`auto_submit_fixture_mode_failed:${autoSubmitMode.response.status}:${JSON.stringify(autoSubmitMode.data)}`);
    }
    const autoSubmitExecution = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(autoSubmitSessionId)}/start-execution`, {
      method: 'POST',
      cookie: auth.cookie,
      body: {
        mode: 'agent_checkout',
        preferredExecutionAgentId: 'magic-city-runner-extension',
        extensionCheckoutProfileEnabled: true,
        extensionFinalSubmitEnabled: true
      }
    });
    const autoSubmitSession = autoSubmitExecution.data.session || {};
    const autoApproval = autoSubmitSession.finalSubmitApproval || {};
    if (!autoSubmitExecution.response.ok
      || autoSubmitSession.extensionMissionPlan?.limits?.stopBeforeFinalSubmit !== false
      || autoSubmitSession.extensionFinalSubmitEnabled !== true
      || autoApproval.authorizationMode !== 'mission_auto_submit'
      || autoApproval.maxOrders !== 1
      || autoApproval.planHash !== autoSubmitSession.extensionMissionPlan?.planHash
      || !(autoSubmitSession.executionTrace || []).some((event) => (
        event?.state === 'final_submit_authorized'
        && event?.approval?.approvalHash === autoApproval.approvalHash
      ))) {
      throw new Error(`fresh_auto_submit_authority_not_persisted:${autoSubmitExecution.response.status}:${JSON.stringify(autoSubmitExecution.data)}`);
    }
    const autoSubmitPoll = await request(baseUrl, '/connectors/sessions', {
      bearer: token,
      runnerSurface: 'chrome-extension',
      runnerProtocol: 'declarative-v1'
    });
    const autoSubmitMission = (autoSubmitPoll.data.sessions || []).find((entry) => entry.id === autoSubmitSessionId);
    if (!autoSubmitPoll.response.ok || !autoSubmitMission?.extensionRunDispatch?.nonce) {
      throw new Error(`fresh_auto_submit_not_visible_to_runner:${JSON.stringify(autoSubmitPoll.data)}`);
    }
    const autoSubmitHolderKey = crypto.generateKeyPairSync('ed25519');
    const autoSubmitClaim = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(autoSubmitSessionId)}/claim`, {
      method: 'POST',
      bearer: token,
      runnerSurface: 'chrome-extension',
      runnerProtocol: 'declarative-v1',
      body: {
        pluginId: 'magic-city-runner-extension',
        holderPublicKeyJwk: autoSubmitHolderKey.publicKey.export({ format: 'jwk' }),
        extensionDispatchNonce: autoSubmitMission.extensionRunDispatch.nonce
      }
    });
    let autoSubmitClaimedSession = autoSubmitClaim.data.session || {};
    const autoSubmitPlan = autoSubmitClaimedSession.extensionMissionPlan || {};
    if (!autoSubmitClaim.response.ok
      || autoSubmitPlan.planHash !== autoApproval.planHash
      || autoSubmitPlan.limits?.stopBeforeFinalSubmit !== false) {
      throw new Error(`fresh_auto_submit_claim_missing_authority:${autoSubmitClaim.response.status}:${JSON.stringify(autoSubmitClaim.data)}`);
    }
    if (autoSubmitSession.finalSubmitChainAuthorization) {
      throw new Error(`disabled_chain_gate_started_background_work:${JSON.stringify(autoSubmitSession.finalSubmitChainAuthorization)}`);
    }
    const autoSubmitFinalAction = autoSubmitPlan.actions?.find((action) => action.type === 'final_submit');
    const disabledChainGate = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(autoSubmitSessionId)}/final-submit-chain-authorization`, {
      method: 'POST',
      bearer: token,
      runnerSurface: 'chrome-extension',
      runnerProtocol: 'declarative-v1',
      body: {
        pluginId: 'magic-city-runner-extension',
        planHash: autoSubmitPlan.planHash,
        actionId: autoSubmitFinalAction?.id
      }
    });
    if (!disabledChainGate.response.ok
      || disabledChainGate.data?.ready !== true
      || disabledChainGate.data?.bypassed !== true
      || disabledChainGate.data?.authorization?.bypassReason !== 'chain_gate_disabled') {
      throw new Error(`disabled_chain_gate_did_not_fail_open:${disabledChainGate.response.status}:${JSON.stringify(disabledChainGate.data)}`);
    }
    const verifiedMilestones = new Set();
    for (const action of autoSubmitPlan.actions || []) {
      if (action.expectedMilestone) verifiedMilestones.add(action.expectedMilestone);
      if (action.id === 'fill-checkout-profile' || action.id === 'reconcile-payment-profile') {
        ['address_confirmed', 'card_confirmed', 'delivery_confirmed'].forEach((milestone) => verifiedMilestones.add(milestone));
      }
      const targetUrl = String(action.url || (
        action.type === 'final_submit' || action.id === 'inspect-review' || action.id === 'reconcile-payment-profile'
          ? 'https://www.amazon.com/checkout/p/p-auto-submit/spc?pipelineType=Chewbacca'
          : autoSubmitPlan.startUrl
      ));
      const checkpoint = await request(baseUrl, `/connectors/sessions/${encodeURIComponent(autoSubmitSessionId)}/checkpoint`, {
        method: 'POST',
        bearer: token,
        runnerSurface: 'chrome-extension',
        runnerProtocol: 'declarative-v1',
        body: {
          pluginId: 'magic-city-runner-extension',
          label: `Auto-submit fixture completed ${action.id}`,
          missionAction: action.missionAction,
          targetUrl,
          planHash: autoSubmitPlan.planHash,
          planActionId: action.id,
          planActionStatus: 'completed',
          milestoneProtocol: 'verified-v1',
          verifiedMilestones: [...verifiedMilestones],
          userApproved: action.type === 'final_submit',
          browser: {
            url: targetUrl,
            currentUrl: targetUrl,
            finalUrl: targetUrl,
            title: action.type === 'final_submit' ? 'Amazon final review' : 'Amazon checkout',
            checkoutSummary: {
              stage: action.type === 'final_submit' || action.id === 'inspect-review' ? 'final_review' : 'checkout',
              addressMatches: true,
              cardMatches: true,
              deliveryConfirmed: true,
              expectedCardLast4: '6383',
              selectedCardLast4: '6383',
              merchandiseSubtotal: '$2.97',
              shippingTotal: '$0.00',
              taxTotal: '$0.00',
              likelyTotal: '$2.97',
              cartItemCount: 1
            }
          },
          proofOfPossession: buildPopProof({
            keyPair: autoSubmitHolderKey,
            session: autoSubmitClaimedSession,
            action: action.missionAction,
            targetUrl
          })
        }
      });
      if (!checkpoint.response.ok) {
        throw new Error(`fresh_auto_submit_checkpoint_rejected:${action.id}:${checkpoint.response.status}:${JSON.stringify(checkpoint.data)}`);
      }
      autoSubmitClaimedSession = checkpoint.data.session || autoSubmitClaimedSession;
      if (action.type === 'final_submit') {
        const trace = await request(baseUrl, `/mission-auth/sessions/${encodeURIComponent(autoSubmitSessionId)}/trace`, {
          cookie: auth.cookie
        });
        if (!trace.response.ok || !trace.data?.trace?.events?.some((event) => event?.action === 'final_submit')) {
          throw new Error(`fresh_auto_submit_boundary_missing:${trace.response.status}:${JSON.stringify(trace.data)}`);
        }
      }
    }

    console.log(JSON.stringify({
      nativeRunnerExtensionPairing: 'passed',
      repeatedRegistrationDurationMs,
      claimDurationMs,
      firstCheckpointDurationMs,
      claimToFirstCheckpointMs: claimDurationMs + firstCheckpointDurationMs,
      startupBoundary: 'claim_and_first_checkpoint'
    }));
  } finally {
    await stopServer();
    await new Promise((resolve) => rankerServer.close(resolve));
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
