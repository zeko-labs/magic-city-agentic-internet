import assert from 'node:assert/strict';

// Both the disposable compatibility server and real-Postgres production harness
// run these exact HTTP assertions. No live target URL or credentials accepted.
export async function testSecurityBoundaries({ request, env, ownerCookie }) {
  const post = (route, body, headers = {}) => request(route, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const expect = async (r, status) => { assert.equal(r.status, status, await r.clone().text()); return r.json(); };
  const owner = { cookie: ownerCookie };
  await expect(await post('/billing/credits/bootstrap', { requesterId: 'rotating-anonymous-identity' }), 401);
  await expect(await post('/billing/credits/bootstrap', { requesterId: 'different-user' }, owner), 409);
  const creditClaims = await Promise.all(Array.from({ length: 8 }, () => post('/billing/credits/bootstrap', {}, owner)));
  assert.equal(creditClaims.filter(r => r.status === 200).length, 1, 'one daily grant despite concurrent requests');
  assert.equal(creditClaims.filter(r => r.status === 409).length, 7, 'duplicate grants rejected');
  const otherResponse = await post('/auth/register', { email: 'boundary-other@example.test', passphrase: 'synthetic-only-password' });
  await expect(otherResponse, 201);
  const other = { cookie: otherResponse.headers.get('set-cookie').split(';')[0] };
  const admin = { 'x-admin-token': env.ADMIN_TOKEN };
  const [key, secondKey] = env.PUBLIC_API_KEYS.split(',');
  const service = { 'x-api-key': key };
  const plugin = { 'x-api-key': env.MAGIC_CITY_PLUGIN_API_KEY };
  const mission = (await expect(await post('/agent-sdk/v1/missions', { goal: 'Private mission', agentId: 'shared-label' }, owner), 201)).mission;
  await expect(await request('/agent-sdk/v1/missions'), 401);
  for (const headers of [{}, other, service]) {
    await expect(await request(`/agent-sdk/v1/missions/${mission.id}?agentId=shared-label`, { headers }), 404);
    await expect(await request(`/agent-sdk/v1/missions/${mission.id}/receipts?agentId=shared-label`, { headers }), 404);
  }
  for (const route of ['options', 'artifacts', 'browser-worker']) {
    const r = await post(`/agent-sdk/v1/missions/${mission.id}/${route}`, { agentId: 'shared-label', options: [{ title: 'malicious' }], content: 'bad', targetUrl: 'https://www.amazon.com' }, other);
    assert.ok([403, 404].includes(r.status), `${route}: ${r.status} ${await r.text()}`);
  }
  const filtered = await expect(await request('/agent-sdk/v1/missions?agentId=shared-label', { headers: other }), 200);
  assert.equal(filtered.missions.length, 0);
  await expect(await post(`/agent-sdk/v1/missions/${mission.id}/options`, { options: [{ title: 'Owner option' }] }, owner), 200);
  const keyed = (await expect(await post('/agent-sdk/v1/missions', { goal: 'Service mission', agentId: 'shared-label' }, service), 201)).mission;
  await expect(await request(`/agent-sdk/v1/missions/${keyed.id}`, { headers: service }), 200);
  assert.equal(keyed.credentialHash, undefined, 'credential binding must not be serialized');
  if (secondKey) await expect(await request(`/agent-sdk/v1/missions/${keyed.id}?agentId=shared-label`, { headers: { 'x-api-key': secondKey } }), 404);

  const agent = { agentId: 'boundary-provider', owner: 'operator-provisioned', publicKey: 'synthetic-public-key' };
  for (const headers of [{}, service, other]) await expect(await post('/agents/register', agent, headers), 401);
  await expect(await post('/agents/register', agent, admin), 201);
  for (const headers of [{}, service, other]) await expect(await post('/agents/register', { ...agent, owner: 'attacker', publicKey: 'replacement' }, headers), 401);
  const receipt = { agentId: agent.agentId, taskId: 'unfunded-replay', outcome: 'success', payment: { amount: 100 } };
  for (const headers of [{}, service, other]) await expect(await post('/receipts', receipt, headers), 401);
  for (let i = 0; i < 2; i++) {
    const evidence = await expect(await post('/receipts', receipt, admin), 201);
    assert.equal(evidence.agent.balance, 0, 'even authorized evidence imports must not mint earnings');
    assert.equal(evidence.agent.owner, agent.owner);
    assert.equal(evidence.agent.publicKey, agent.publicKey);
  }
  const intent = (await expect(await post('/integrations/acp/intent-sync', { externalRequestId: 'boundary-intent', providerAgentId: agent.agentId, paymentMode: 'credits' }, admin), 201)).intent;
  await expect(await post('/receipts', { ...receipt, intentId: intent.id }, admin), 201);
  await expect(await post('/agents/register', { ...agent, agentId: 'boundary-wrong-provider' }, admin), 201);
  await expect(await post('/receipts', { ...receipt, agentId: 'boundary-wrong-provider', intentId: intent.id }, admin), 409);
  await expect(await post('/integrations/acp/fulfill-sync', { externalRequestId: 'boundary-intent', serviceId: 'boundary-wrong-provider', status: 'completed' }, admin), 409);
  await expect(await post('/relayer/receipts/submit', { ...receipt, agentId: 'boundary-wrong-provider', intentId: intent.id }, { 'x-relayer-token': env.RELAYER_TOKEN }), 409);
  await expect(await post('/payouts/request', { agentId: agent.agentId, amount: 100, rail: 'bank', requestId: 'boundary-payout' }, admin), 400);

  const registration = { pluginId: 'boundary-plugin', ownerAgentId: 'boundary-plugin', kind: 'test', endpoint: 'http://127.0.0.1:1' };
  for (const headers of [{}, service, other]) await expect(await post('/plugins/register', registration, headers), 401);
  await expect(await post('/plugins/register', registration, plugin), 201);
  await expect(await post('/plugins/register', { ...registration, pluginId: 'unpermitted' }, plugin), 403);
  await expect(await post('/plugins/register', { ...registration, ownerAgentId: 'other-owner' }, plugin), 403);
  // A supplied email cannot provision admin access, regardless of profile.
  const adminClaim = await post('/auth/register', { email: 'boundary-admin@example.test', passphrase: 'synthetic-only-password' });
  assert.equal((await expect(adminClaim, 201)).user.adminAccount, false);
  await expect(await request('/billing/platform', { headers: { cookie: adminClaim.headers.get('set-cookie').split(';')[0] } }), 403);
  console.log('SDK tenant/key isolation, registry provisioning, evidence-only receipts, provider binding, scoped plugins and email-admin denial passed');
}
