export function isStrongRelayerCredential(value) {
  const token = String(value || '');
  return token.length >= 32
    && token === token.trim()
    && !/change[-_ ]?me|placeholder/i.test(token)
    && !/^(.)\1+$/.test(token);
}

// The standalone relayer does not run the web application's bootstrap.
// Preserve development record-mode fixtures; fail before listening in production.
export function validateRelayerCredentials(env = process.env) {
  const profile = String(env.DEPLOYMENT_PROFILE || '').trim().toLowerCase();
  const production = profile === 'production' || String(env.NODE_ENV || '').trim().toLowerCase() === 'production';
  if (!production) return;
  const token = env.ZEKO_RELAYER_TOKEN || env.ZEKO_SUBMITTER_TOKEN || '';
  if (!isStrongRelayerCredential(token)) {
    throw new Error('production_relayer_requires_strong_token');
  }
}
