import assert from 'node:assert/strict';
import http from 'node:http';
import { executeProvider, executeProviderStream, extractBrowserMissionSchemaWithProvider, rankAmazonCandidatesWithProvider } from '../src/providers.js';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
let downstream = 0;
let leakedHeader = false;
let leakedPrompt = false;
let upstreamRequests = 0;
const sink = http.createServer(async (req, res) => {
  downstream++;
  let body = ''; for await (const chunk of req) body += chunk;
  leakedHeader ||= req.headers['x-provider-secret'] === 'synthetic-only';
  leakedPrompt ||= body.includes('synthetic-private-prompt');
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { content: 'fixture response' } }] }));
});
const sinkUrl = await listen(sink);
const upstream = http.createServer(async (req, res) => {
  upstreamRequests++;
  for await (const chunk of req) { /* consume synthetic body */ }
  if (req.url === '/redirect') { res.writeHead(307, { location: `${sinkUrl}/collect` }); res.end(); return; }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ choices: [{ message: { content: 'fixture response' } }] }));
});
const upstreamUrl = await listen(upstream);
process.env.MIA_FIXTURE_MODEL_KEY = 'fixture-only';
const configure = route => { process.env.AI_PROVIDER_CONFIG = JSON.stringify([{ id: 'openrouter-fixture', type: 'openai_compat', baseUrl: upstreamUrl, path: route, model: 'fixture', apiKeyEnv: 'MIA_FIXTURE_MODEL_KEY', headers: { 'x-provider-secret': 'synthetic-only' } }]); };
const input = { agent: { metadata: { providerId: 'openrouter-fixture', providerType: 'openai_compat' } }, capability: 'general-chat', prompt: 'synthetic-private-prompt' };
try {
  configure('/ok');
  assert.equal((await executeProvider(input)).content, 'fixture response');
  configure('/redirect');
  await executeProvider(input).catch(() => {});
  console.log(JSON.stringify({ downstream, leakedHeader, leakedPrompt }));
  assert.equal(downstream, 0, 'provider redirect must not forward credentials/prompts or reach another destination');
  await assert.rejects(async () => { for await (const chunk of executeProviderStream(input)) {} });
  await extractBrowserMissionSchemaWithProvider({ prompt: 'buy fixture' });
  await rankAmazonCandidatesWithProvider({ request: 'fixture', maxPrice: 4, candidates: [{ id: 'one', asin: 'B000000001', title: 'fixture', price: 2, prime: true, freeShipping: true }] });
  assert.equal(downstream, 0, 'all provider request modes block redirects');
  assert.equal(upstreamRequests, 5, 'direct chat plus redirected chat, stream, extraction and ranking were actually exercised');
  console.log('Provider direct response passes; redirect receives zero downstream requests');
} finally {
  upstream.closeAllConnections(); sink.closeAllConnections();
  await Promise.all([new Promise(r => upstream.close(r)), new Promise(r => sink.close(r))]);
}
