import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequestSecurity, validateDeployment, productionAdminAccount } from '../src/deploymentSecurity.js';
import { createRequestLimiter } from '../src/requestRateLimits.js';
import { consultPartnerModel } from '../examples/custom-helper-extension-starter/model-adapter.js';
import { modelConsentKey } from '../examples/custom-helper-extension-starter/model-privacy.js';

const req = (headers = {}, ip = '203.0.113.8') => ({ headers: { host: 'app.example', ...headers }, socket: { remoteAddress: ip } });
const security = createRequestSecurity({ MAGIC_CITY_CANONICAL_ORIGIN: 'https://app.example', MAGIC_CITY_TRUSTED_PROXY_CIDRS: '127.0.0.1/32,10.0.0.0/8' });
assert.equal(security.baseUrl(req({ 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http' })), 'https://app.example');
assert.throws(() => security.baseUrl(req({ host: 'evil.example' })), /unexpected_request_host/);
assert.throws(() => security.baseUrl(req({ host: 'good.example@evil.example' })), /invalid_request_host/);
assert.equal(security.clientIp(req({ 'x-forwarded-for': '127.0.0.1' })), '203.0.113.8');
assert.equal(security.clientIp(req({ 'x-forwarded-for': '127.0.0.1, 203.0.113.8, 10.0.0.2' }, '127.0.0.1')), '203.0.113.8');
assert.equal(security.clientIp(req({ 'x-forwarded-for': 'malformed' }, '127.0.0.1')), '127.0.0.1');
assert.equal(createRequestSecurity({}).secure(req({ 'x-forwarded-proto': 'https' })), false);
const headers = {};
security.setHeaders(req(), { setHeader: (key, value) => { headers[key] = value; } });
assert.match(headers['Content-Security-Policy'], /frame-ancestors 'self'/);
assert.equal(headers['X-Frame-Options'], 'SAMEORIGIN');
assert.match(headers['Strict-Transport-Security'], /31536000/);
assert.match(headers['Permissions-Policy'], /publickey-credentials-get=\(self\)/);
const framed = {};
createRequestSecurity({ MAGIC_CITY_FRAME_ANCESTORS: 'https://portal.example' }).setHeaders(req(), { setHeader: (k, v) => { framed[k] = v; } });
assert.equal(framed['X-Frame-Options'], undefined);
assert.match(framed['Content-Security-Policy'], /https:\/\/portal.example/);
assert.throws(() => createRequestSecurity({ MAGIC_CITY_FRAME_ANCESTORS: 'https://*.example' }), /invalid_frame_ancestor/);
for (const cidr of ['0.0.0.0/0', '::/0', '127.0.0.1/', '127.0.0.1/32/extra']) assert.throws(() => createRequestSecurity({ MAGIC_CITY_TRUSTED_PROXY_CIDRS: cidr }), /invalid_trusted_proxy_cidr/);
assert.equal(productionAdminAccount({ id: 'auth-2', email: 'admin@example.test', requesterId: 'admin@example.test' }, { LOCAL_ADMIN_EMAILS: 'admin@example.test', AUTH_ADMIN_USER_IDS: 'auth-1' }), false);
assert.equal(productionAdminAccount({ id: 'auth-1' }, { AUTH_ADMIN_USER_IDS: 'auth-1' }), true);

const production = {
  NODE_ENV: 'production', DEPLOYMENT_PROFILE: 'production', MAGIC_CITY_CANONICAL_ORIGIN: 'https://app.example',
  DATABASE_URL: 'postgres://test:unused@localhost/test', MAGIC_CITY_RATE_LIMIT_STORE: 'postgres',
  PUBLIC_API_KEYS: crypto.randomBytes(32).toString('hex'),
  MAGIC_CITY_REQUIRE_PRODUCTION_PERSISTENCE: 'true', MAGIC_CITY_REQUIRE_STATE_ENCRYPTION: 'true',
  MAGIC_CITY_REQUIRE_ARTIFACT_ENCRYPTION: 'true', MAGIC_CITY_POSTGRES_SINGLE_WRITER: 'true',
  MISSION_BOUND_AUTH_ED25519_PRIVATE_KEY: crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' })
};
for (const key of ['ADMIN_TOKEN', 'PRIVACY_SALT', 'MISSION_BOUND_AUTH_SECRET', 'MCP_OAUTH_SECRET', 'MAGIC_CITY_STATE_ENCRYPTION_KEY']) production[key] = crypto.randomBytes(32).toString('hex');
validateDeployment(production);
assert.throws(
  () => validateDeployment({ ...production, DEPLOYMENT_PROFILE: '', NODE_ENV: 'production' }),
  /production_requires_deployment_profile/
);
assert.throws(
  () => validateDeployment({ ...production, DEPLOYMENT_PROFILE: 'development', NODE_ENV: 'production' }),
  /production_deployment_profile_conflict/
);
validateDeployment({ NODE_ENV: 'development' });
validateDeployment({ NODE_ENV: 'test' });
const retainedConnectorKey = crypto.randomBytes(32).toString('hex');
const transitionConfig = { ...production, GOOGLE_CONNECTOR_SECRET: retainedConnectorKey,
  MISSION_BOUND_AUTH_LEGACY_SECRET: retainedConnectorKey,
  MISSION_BOUND_AUTH_LEGACY_TOKEN_SHA256: 'a'.repeat(64),
  MISSION_BOUND_AUTH_LEGACY_CUTOVER_AT: new Date(Date.now() - 1000).toISOString(),
  MISSION_BOUND_AUTH_LEGACY_ACCEPT_UNTIL: new Date(Date.now() + 60000).toISOString() };
validateDeployment(transitionConfig);
assert.throws(() => validateDeployment({ ...transitionConfig, MISSION_BOUND_AUTH_SECRET: retainedConnectorKey }), /transition_invalid_secret|distinct_secrets/);
assert.throws(() => validateDeployment({ ...transitionConfig, MCP_OAUTH_SECRET: retainedConnectorKey }), /distinct_secrets/);
for (const flag of ['ETHEREUM_CONFIRMATION_INDEXER_AUTO_CONFIRM', 'ETHEREUM_SHADOW_RELAYER_LIVE_EXECUTION']) assert.throws(() => validateDeployment({ ...production, [flag]: 'true' }));
for (const key of ['ADMIN_TOKEN', 'PRIVACY_SALT', 'MISSION_BOUND_AUTH_SECRET', 'MCP_OAUTH_SECRET', 'MAGIC_CITY_STATE_ENCRYPTION_KEY', 'MISSION_BOUND_AUTH_ED25519_PRIVATE_KEY', 'DATABASE_URL', 'MAGIC_CITY_CANONICAL_ORIGIN', 'MAGIC_CITY_REQUIRE_PRODUCTION_PERSISTENCE', 'MAGIC_CITY_REQUIRE_STATE_ENCRYPTION', 'MAGIC_CITY_REQUIRE_ARTIFACT_ENCRYPTION', 'MAGIC_CITY_POSTGRES_SINGLE_WRITER', 'MAGIC_CITY_RATE_LIMIT_STORE']) {
  assert.throws(() => validateDeployment({ ...production, [key]: '' }), undefined, `missing ${key}`);
}
for (const key of ['ALLOW_INSECURE_ADMIN', 'MAGIC_CITY_ALLOW_LOCAL_IP_ADMIN', 'AUTH_PASSWORD_RESET_DEV_LINKS', 'AUTO_TOPUP_LOCAL_FREE', 'MAGIC_CITY_ALLOW_STATE_RESET_ON_READ_ERROR']) assert.throws(() => validateDeployment({ ...production, [key]: 'true' }));
assert.throws(() => validateDeployment({ ...production, ADMIN_TOKEN: 'change-me' }));
assert.throws(() => validateDeployment({ ...production, GOOGLE_CLIENT_ID: 'configured' }));
assert.throws(() => validateDeployment({ ...production, GOOGLE_CONNECTOR_SECRET: production.ADMIN_TOKEN }));
validateDeployment({});
assert.throws(() => validateDeployment({ MAGIC_CITY_PLUGIN_OWNER_AGENT_IDS: 'null' }), /invalid_plugin_owner_mapping/);
assert.throws(() => validateDeployment({ MAGIC_CITY_PLUGIN_OWNER_AGENT_IDS: '{bad' }), /invalid_plugin_owner_mapping/);
assert.throws(() => validateDeployment({ MAGIC_CITY_PLUGIN_OWNER_AGENT_IDS: '{"worker":42}' }), /invalid_plugin_owner_mapping/);
assert.throws(() => validateDeployment({ ...production, MAGIC_CITY_PLUGIN_API_KEY: production.PUBLIC_API_KEYS, MAGIC_CITY_PLUGIN_ALLOWED_IDS: 'worker' }), /plugin_credential_reused/);
const pluginKey = crypto.randomBytes(32).toString('hex');
assert.throws(() => validateDeployment({ ...production, MAGIC_CITY_PLUGIN_API_KEY: pluginKey }), /requires_plugin_scope/);
validateDeployment({ ...production, MAGIC_CITY_PLUGIN_API_KEY: pluginKey, MAGIC_CITY_PLUGIN_ALLOWED_IDS: 'worker', MAGIC_CITY_PLUGIN_OWNER_AGENT_IDS: '{"worker":"provider"}' });

let now = 100;
const limits = createRequestLimiter({ env: {}, clock: () => now, maxEntries: 2 });
assert.equal((await limits.consume('alice', { windowMs: 100, max: 2 })).allowed, true);
assert.equal((await limits.consume('alice', { windowMs: 100, max: 2 })).allowed, true);
assert.equal((await limits.consume('alice', { windowMs: 100, max: 2 })).allowed, false);
await limits.consume('bob', { windowMs: 100, max: 2 });
await assert.rejects(limits.consume('charlie', { windowMs: 100, max: 2 }), /capacity/);
now = 201;
assert.equal((await limits.consume('charlie', { windowMs: 100, max: 2 })).allowed, true);
const outage = createRequestLimiter({ env: { MAGIC_CITY_RATE_LIMIT_STORE: 'postgres' }, pool: { connect: async () => { throw new Error('db down'); } } });
await assert.rejects(outage.consume('alice', { windowMs: 100, max: 2 }), /db down/);

const config = { mode: 'control_plane', path: '/model', modelId: 'local-catalog', dataRouting: 'local', observationPolicy: { allowedOrigins: ['https://shop.example'] } };
const args = { config, bearer: 'fake-test-token', controlPlaneOrigin: 'https://app.example', session: { id: 'cs-test', extensionMissionPlan: { planHash: 'hash' } }, planAction: { id: 'select' }, observation: { page: { url: 'https://shop.example/search', kind: 'search', containsSensitiveData: false, description: 'secret omitted' }, candidates: [{ id: '1', title: 'Item', attributes: ['private omitted'] }] } };
args.modelConsent = modelConsentKey({ ...config, controlPlaneOrigin: args.controlPlaneOrigin });
let calls = 0;
args.fetchImpl = async (_url, options) => {
  calls++;
  const body = JSON.parse(options.body);
  assert.equal(options.redirect, 'error');
  assert.equal(JSON.stringify(body).includes('omitted'), false);
  return new Response(JSON.stringify({ ...body, schema: 'magic-city-helper-model-response-v1', decision: { kind: 'abstain' } }));
};
await consultPartnerModel(args);
assert.equal(calls, 1);
for (const path of ['/checkout', '/ap/signin', '/pay/payment', '/account', '/wallet', '/%63heckout']) {
  await assert.rejects(consultPartnerModel({ ...args, observation: { ...args.observation, page: { ...args.observation.page, url: `https://shop.example${path}` } } }), /sensitive_page/);
}
await assert.rejects(consultPartnerModel({ ...args, modelConsent: '' }), /consent_required/);
await assert.rejects(consultPartnerModel({ ...args, config: { ...config, dataRouting: 'cloud' } }), /consent_required/);
await assert.rejects(consultPartnerModel({ ...args, controlPlaneOrigin: 'https://other.example' }), /consent_required/);
await assert.rejects(consultPartnerModel({ ...args, observation: { ...args.observation, page: { ...args.observation.page, containsSensitiveData: true } } }), /sensitive_page/);
assert.equal(calls, 1, 'blocked observations never reach model');
console.log('deployment, proxy, headers, rate-limit and model privacy regressions passed');
