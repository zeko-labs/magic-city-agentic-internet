import crypto from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { readMissionKeyTransition } from './missionKeyTransition.js';
import { isStrongRelayerCredential } from './relayerSecurity.js';

const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const enabled = (value) => String(value).toLowerCase() === 'true';
const list = (value) => String(value || '').split(',').map((v) => v.trim()).filter(Boolean);

export function deploymentIsProduction(env = process.env) {
  return String(env.DEPLOYMENT_PROFILE || '').trim().toLowerCase() === 'production';
}

export function productionAdminAccount(authUser, env = process.env) {
  // Grant only an operator-provisioned existing account ID. Public signup
  // accepts email strings, so an email/requester allowlist is not proof of ownership.
  return Boolean(authUser?.id && list(env.AUTH_ADMIN_USER_IDS).includes(authUser.id));
}

export function canonicalOrigin(env = process.env) {
  const raw = env.MAGIC_CITY_CANONICAL_ORIGIN;
  if (!raw) return '';
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw fail('invalid_canonical_origin');
  }
  return url.origin;
}

export function validateDeployment(env = process.env) {
  readMissionKeyTransition(env);
  if (env.MAGIC_CITY_PLUGIN_OWNER_AGENT_IDS) {
    let owners;
    try { owners = JSON.parse(env.MAGIC_CITY_PLUGIN_OWNER_AGENT_IDS); } catch { throw fail('invalid_plugin_owner_mapping'); }
    if (!owners || Array.isArray(owners) || typeof owners !== 'object'
      || Object.entries(owners).some(([id, owner]) => !id.trim() || typeof owner !== 'string' || !owner.trim())) throw fail('invalid_plugin_owner_mapping');
  }
  const deploymentProfile = String(env.DEPLOYMENT_PROFILE || '').trim().toLowerCase();
  const nodeEnv = String(env.NODE_ENV || '').trim().toLowerCase();
  if (deploymentProfile && !['development', 'production'].includes(deploymentProfile)) throw fail('invalid_deployment_profile');
  if (nodeEnv === 'production' && !deploymentProfile) throw fail('production_requires_deployment_profile');
  if (nodeEnv === 'production' && deploymentProfile !== 'production') throw fail('production_deployment_profile_conflict');
  const origin = canonicalOrigin(env);
  if (!deploymentIsProduction(env)) return;
  for (const name of ['ETHEREUM_CONFIRMATION_INDEXER_AUTO_CONFIRM', 'ETHEREUM_SHADOW_RELAYER_LIVE_EXECUTION']) {
    if (['true', '1', 'yes'].includes(String(env[name] || '').toLowerCase())) throw fail(`production_disallows_${name}`);
  }
  if (!origin.startsWith('https://')) throw fail('production_requires_https_canonical_origin');
  if (!/^postgres(?:ql)?:\/\//.test(env.DATABASE_URL || '')) throw fail('production_requires_postgres');
  for (const name of ['MAGIC_CITY_REQUIRE_PRODUCTION_PERSISTENCE', 'MAGIC_CITY_REQUIRE_STATE_ENCRYPTION', 'MAGIC_CITY_REQUIRE_ARTIFACT_ENCRYPTION', 'MAGIC_CITY_POSTGRES_SINGLE_WRITER']) {
    if (!enabled(env[name])) throw fail(`production_requires_${name}`);
  }
  for (const name of ['ALLOW_INSECURE_ADMIN', 'MAGIC_CITY_ALLOW_LOCAL_IP_ADMIN', 'AUTH_PASSWORD_RESET_DEV_LINKS', 'AUTO_TOPUP_LOCAL_FREE', 'MAGIC_CITY_ALLOW_STATE_RESET_ON_READ_ERROR']) {
    if (enabled(env[name])) throw fail(`production_disallows_${name}`);
  }
  if (env.MAGIC_CITY_RATE_LIMIT_STORE !== 'postgres') throw fail('production_requires_postgres_rate_limits');
  if (!list(env.PUBLIC_API_KEYS).length || list(env.PUBLIC_API_KEYS).some((key) => key.length < 32 || /change[-_ ]?me/i.test(key))) throw fail('production_requires_strong_public_api_keys');
  const secrets = ['ADMIN_TOKEN', 'PRIVACY_SALT', 'MISSION_BOUND_AUTH_SECRET', 'MCP_OAUTH_SECRET', 'MAGIC_CITY_STATE_ENCRYPTION_KEY'];
  // Optional relay integrations stay disabled when absent; configured credentials
  // must not inherit development placeholders or another service's privilege.
  for (const name of ['RELAYER_TOKEN', 'ZEKO_RELAYER_TOKEN', 'ZEKO_SUBMITTER_TOKEN']) {
    if (!env[name]) continue;
    // The submitter name is a legacy alias for the same outbound capability.
    if (name === 'ZEKO_SUBMITTER_TOKEN' && env[name] === env.ZEKO_RELAYER_TOKEN) continue;
    if (!isStrongRelayerCredential(env[name])) throw fail(`production_requires_strong_${name}`);
    secrets.push(name);
  }
  if (env.MAGIC_CITY_PLUGIN_API_KEY) {
    secrets.push('MAGIC_CITY_PLUGIN_API_KEY');
    if (list(env.PUBLIC_API_KEYS).includes(env.MAGIC_CITY_PLUGIN_API_KEY)) throw fail('production_plugin_credential_reused');
    if (!list(env.MAGIC_CITY_PLUGIN_ALLOWED_IDS).length) throw fail('production_requires_plugin_scope');
  }
  for (const provider of ['GOOGLE', 'GITHUB']) {
    if (env[`${provider}_CLIENT_ID`] || env[`${provider}_CLIENT_SECRET`] || env[`${provider}_CONNECTOR_SECRET`]) secrets.push(`${provider}_CONNECTOR_SECRET`);
  }
  for (const name of secrets) {
    const value = String(env[name] || '');
    if (value.length < 32 || /change[-_ ]?me|placeholder|staging-oauth-secret/i.test(value)) throw fail(`production_requires_strong_${name}`);
  }
  const stateKey = env.MAGIC_CITY_STATE_ENCRYPTION_KEY;
  if (!(/^[a-f\d]{64}$/i.test(stateKey) || Buffer.from(stateKey, 'base64').length === 32)) throw fail('invalid_state_encryption_key');
  if (new Set(secrets.map((name) => env[name])).size !== secrets.length) throw fail('production_requires_distinct_secrets');
  for (const name of secrets.filter((name) => name.endsWith('CONNECTOR_SECRET'))) {
    if ([env.STRIPE_SECRET_KEY, env.GOOGLE_CLIENT_SECRET, env.GITHUB_CLIENT_SECRET, env.AUTH_CONNECTOR_SECRET].filter(Boolean).includes(env[name])) throw fail('production_connector_secret_reused');
  }
  try {
    const raw = String(env.MISSION_BOUND_AUTH_ED25519_PRIVATE_KEY || '');
    const pem = raw.includes('-----BEGIN') ? raw.replace(/\\n/g, '\n') : Buffer.from(raw, 'base64').toString('utf8');
    if (crypto.createPrivateKey(pem).asymmetricKeyType !== 'ed25519') throw new Error();
  } catch { throw fail('production_requires_ed25519_signing_key'); }
}

export function createRequestSecurity(env = process.env) {
  const origin = canonicalOrigin(env);
  const proxies = new BlockList();
  for (const cidr of list(env.MAGIC_CITY_TRUSTED_PROXY_CIDRS)) {
    const [address, bits, extra] = cidr.split('/');
    const version = isIP(address);
    if (!version || extra !== undefined || (bits !== undefined && (!/^\d+$/.test(bits) || Number(bits) < 1 || Number(bits) > (version === 4 ? 32 : 128)))) throw fail('invalid_trusted_proxy_cidr');
    const family = version === 4 ? 'ipv4' : 'ipv6';
    if (bits === undefined) proxies.addAddress(address, family);
    else proxies.addSubnet(address, Number(bits), family);
  }
  const normalizeIp = (ip) => String(ip || '').replace(/^::ffff:/, '');
  const trusted = (ip) => {
    ip = normalizeIp(ip);
    return isIP(ip) ? proxies.check(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6') : false;
  };
  const allowedHosts = new Set([...(origin ? [new URL(origin).host] : []), ...list(env.MAGIC_CITY_ALLOWED_HOSTS)].map((s) => s.toLowerCase()));
  const frames = list(env.MAGIC_CITY_FRAME_ANCESTORS).map((entry) => {
    const parsed = new URL(entry);
    if (parsed.protocol !== 'https:' || parsed.origin !== entry || entry.includes('*')) throw fail('invalid_frame_ancestor');
    return parsed.origin;
  });
  function validateHost(req) {
    const host = String(req.headers.host || '');
    if (!host || /[\s\/@?#\\]/.test(host)) throw fail('invalid_request_host');
    try { new URL(`http://${host}`); } catch { throw fail('invalid_request_host'); }
    if (allowedHosts.size && !allowedHosts.has(host.toLowerCase())) throw fail('unexpected_request_host', 421);
  }
  function secure(req) {
    return Boolean(req.socket?.encrypted || (trusted(req.socket?.remoteAddress) && req.headers['x-forwarded-proto'] === 'https'));
  }
  function baseUrl(req) {
    validateHost(req);
    return origin || `${secure(req) ? 'https' : 'http'}://${req.headers.host}`;
  }
  function clientIp(req) {
    const peer = normalizeIp(req.socket?.remoteAddress);
    if (!trusted(peer)) return peer;
    const chain = String(req.headers['x-forwarded-for'] || '').split(',').map((ip) => normalizeIp(ip.trim()));
    // Walk from the trusted peer towards the client. Never trust the leftmost
    // address supplied by an arbitrary caller through a proxy.
    let current = peer;
    for (let i = chain.length - 1; i >= 0 && trusted(current); i -= 1) {
      if (!isIP(chain[i])) break;
      current = chain[i];
    }
    return current;
  }
  function setHeaders(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', `frame-ancestors 'self'${frames.length ? ` ${frames.join(' ')}` : ''}; object-src 'none'; base-uri 'self'`);
    if (!frames.length) res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    // Report-only rollout keeps existing inline UI, OAuth, Stripe and Spotify
    // integrations working while an operator inventories required sources.
    res.setHeader('Content-Security-Policy-Report-Only', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'");
    res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), publickey-credentials-get=(self), publickey-credentials-create=(self)');
    if (origin.startsWith('https://') || secure(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  function validateBrowserMutation(req, { authenticatedRunnerMutation = false } = {}) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !req.headers.cookie) return;
    if (authenticatedRunnerMutation) return;
    const expected = origin || baseUrl(req);
    if (req.headers.origin && req.headers.origin !== expected) throw fail('cross_origin_mutation_rejected', 403);
    if (req.headers['sec-fetch-site'] === 'cross-site') throw fail('cross_origin_mutation_rejected', 403);
  }
  return { baseUrl, clientIp, validateHost, setHeaders, validateBrowserMutation, secure: (req) => origin ? origin.startsWith('https://') : secure(req) };
}
