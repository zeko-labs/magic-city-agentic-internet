import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

import { amazonProductIdentityMatches } from '../public/native-runner/extension/amazon-selection.js';

import {
  isAmazonCandidateRankerConfigured,
  rankAmazonCandidatesWithProvider
} from '../src/providers.js';

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const candidate = (overrides = {}) => ({
  id: 'candidate-1',
  asin: 'B000FRUIT1',
  title: 'Nature Valley Mixed Berry Crunchy Granola Bars',
  packageFacts: { status: 'unspecified', unit: null, total: null, per: null, outer: null, configuration: null },
  price: 3.79,
  primeEligible: true,
  freeShipping: true,
  conditionalShipping: false,
  sponsored: false,
  hardEligible: true,
  ...overrides
});

const port = await availablePort();
let mode = 'select';
let calls = 0;
let lastRequest = null;
const server = http.createServer(async (req, res) => {
  calls += 1;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  lastRequest = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  res.writeHead(200, { 'content-type': 'application/json' });
  if (mode === 'slow-body') {
    res.flushHeaders();
    setTimeout(() => res.end(JSON.stringify({
      model: 'selection-test',
      choices: [{ message: { content: JSON.stringify({ decision: 'select', selectedId: 'candidate-1' }) } }]
    })), 1300);
    return;
  }
  if (mode === 'oversized') {
    res.end(JSON.stringify({ choices: [{ message: { content: 'x'.repeat(17 * 1024) } }] }));
    return;
  }
  const content = mode === 'request-user'
    ? { decision: 'request_user', selectedId: null, reason: 'Preference is ambiguous.' }
    : mode === 'invented'
      ? { decision: 'select', selectedId: 'candidate-99', reason: 'Invented.' }
      : { decision: 'select', selectedId: 'candidate-1', reason: 'Observed semantic match.' };
  res.end(JSON.stringify({
    model: 'selection-test',
    choices: [{ message: { content: JSON.stringify(content) } }]
  }));
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', resolve);
});

const previous = {
  AI_PROVIDER_CONFIG: process.env.AI_PROVIDER_CONFIG,
  TEST_OPENROUTER_API_KEY: process.env.TEST_OPENROUTER_API_KEY,
  MAGIC_CITY_BROWSER_RANK_MODEL: process.env.MAGIC_CITY_BROWSER_RANK_MODEL
};
process.env.TEST_OPENROUTER_API_KEY = 'test-only-key';
process.env.AI_PROVIDER_CONFIG = JSON.stringify([{
  id: 'openrouter-selection-test',
  label: 'OpenRouter selection test',
  type: 'openai_compat',
  baseUrl: `http://127.0.0.1:${port}`,
  apiKeyEnv: 'TEST_OPENROUTER_API_KEY',
  model: 'selection-test',
  path: '/chat/completions',
  lanes: ['general-chat']
}]);

try {
  assert.equal(
    amazonProductIdentityMatches('fruit and nut Nature Valley granola bars', 'Nature Valley Fruit & Nut Granola Bars'),
    true,
    'product-page identity matching is independent of brand word order'
  );
  assert.equal(
    amazonProductIdentityMatches('Nature Valley Strawberry granola bars', 'Nature Valley Peanut Butter Granola Bars'),
    false,
    'product-page verification preserves explicit flavor identity'
  );
  assert.equal(
    amazonProductIdentityMatches('Nature Valley Strawberry granola bars', 'Great Value Strawberry Granola Bars'),
    false,
    'product-page verification preserves explicit brand identity'
  );
  assert.equal(
    amazonProductIdentityMatches('HERSHEY\'S S\'mores Kit Box, 14 oz', 'HERSHEY\'S S\'mores Kit Box, 10 oz'),
    false,
    'product-page verification preserves explicit package identity'
  );
  assert.equal(
    amazonProductIdentityMatches('Nature Valley granola bars, 4 oz', 'Nature Valley granola bars, 8 oz'),
    false,
    'product-page verification rejects a different single-digit weight'
  );
  assert.equal(
    amazonProductIdentityMatches('Nature Valley granola bars, 6 count', 'Nature Valley granola bars, 9 count'),
    false,
    'product-page verification rejects a different single-digit count'
  );
  assert.equal(
    amazonProductIdentityMatches('HERSHEY\'S S\'mores Kit Box, 14 oz', 'HERSHEY\'S S\'mores Kit Box, 14 oz, pack of 2'),
    false,
    'product-page verification rejects an unrequested multipack'
  );
  assert.equal(
    amazonProductIdentityMatches('Nature Valley granola bars 2-pack', 'Nature Valley granola bars 6-pack'),
    false,
    'product-page verification compares explicit standalone pack counts'
  );
  assert.equal(
    amazonProductIdentityMatches(
      'HERSHEY\'S S\'mores Kit Box, 14 oz',
      'HERSHEY\'S S\'mores Kit Box, 14 oz',
      'Number of Items: 2'
    ),
    false,
    'product-page verification binds structured item-count evidence to the package'
  );
  assert.equal(
    amazonProductIdentityMatches('Nature Valley granola bars 2-pack', 'Nature Valley granola bars', 'Package Quantity: 2-6'),
    false,
    'a package-quantity range is conflicting rather than its first integer'
  );
  assert.equal(
    amazonProductIdentityMatches('Nature Valley granola bars 2-pack', 'Nature Valley granola bars', 'Number of Items: 2 or 6'),
    false,
    'alternative structured item counts are conflicting'
  );
  assert.equal(
    amazonProductIdentityMatches(
      'Nature Valley granola bars 2-pack',
      'Nature Valley granola bars',
      'Item Package Quantity: 2 | Number of Items: unknown'
    ),
    false,
    'unreadable structured package evidence cannot be ignored beside a matching field'
  );
  assert.equal(
    amazonProductIdentityMatches('dryer sheets', 'fabric softener sheets'),
    true,
    'product-page verification preserves the established dryer-sheet equivalence'
  );
  assert.equal(
    amazonProductIdentityMatches('laundry detergent PODS', 'laundry detergent pacs'),
    true,
    'product-page verification preserves the established detergent-capsule equivalence'
  );
  assert.equal(
    amazonProductIdentityMatches('laundry detergent, 50-54 oz', 'laundry detergent, 51.5 oz'),
    true,
    'product-page verification preserves an allowed package range'
  );

  assert.equal(isAmazonCandidateRankerConfigured(), true, 'ranker readiness uses the configured provider without a health-check request');
  assert.equal(calls, 0, 'readiness makes no provider request');

  const valid = await rankAmazonCandidatesWithProvider({
    request: 'fruity Nature Valley granola bars',
    query: 'fruity Nature Valley granola bars',
    maxPrice: null,
    primeRequired: true,
    candidates: [{
      ...candidate(),
      url: 'https://www.amazon.com/dp/B000FRUIT1?token=TEST_SECRET#private',
      account: 'private@example.com',
      paymentLast4: '6383'
    }],
    timeoutMs: 1000
  });
  assert.equal(valid?.decision, 'select');
  assert.equal(valid?.selectedCandidateId, 'candidate-1');
  const providerInput = JSON.parse(lastRequest.messages?.[1]?.content || '{}');
  assert.equal(providerInput.candidates.length, 1);
  assert.equal(lastRequest.max_tokens, 100, 'the title-selection response stays tiny');
  assert.equal(lastRequest.include_reasoning, false, 'the fallback does not request reasoning output');
  assert.deepEqual(
    Object.keys(providerInput.candidates[0]).sort(),
    ['id', 'title'],
    'only candidate IDs and titles leave the server'
  );
  assert.equal(JSON.stringify(providerInput).includes('TEST_SECRET'), false);
  assert.equal(JSON.stringify(providerInput).includes('private@example.com'), false);
  assert.equal(JSON.stringify(providerInput).includes('6383'), false);

  const callsBeforeDuplicate = calls;
  const duplicate = await rankAmazonCandidatesWithProvider({
    request: 'fruity granola bars',
    candidates: [candidate(), candidate({ asin: 'B000FRUIT2' })],
    timeoutMs: 1000
  });
  assert.equal(duplicate, null, 'duplicate candidate IDs are rejected');
  assert.equal(calls, callsBeforeDuplicate, 'duplicate candidates never reach the provider');

  const unknownPrice = await rankAmazonCandidatesWithProvider({
    request: 'fruity granola bars',
    candidates: [candidate({ price: null })],
    timeoutMs: 1000
  });
  assert.equal(unknownPrice?.decision, 'abstain', 'unknown price is never normalized to zero or selected');
  assert.equal(unknownPrice?.selectedCandidateId, null);

  const provisionalUnknownPrice = await rankAmazonCandidatesWithProvider({
    request: "HERSHEY'S S'mores Kit Box, 14 oz",
    maxPrice: 8,
    primeRequired: true,
    candidates: [candidate({
      title: 'HERSHEY\'S mores Kit Box, 14 oz',
      price: null,
      primeEligible: false,
      freeShipping: false,
      requiresProductPageVerification: true,
      identityStatus: 'provisional'
    })],
    timeoutMs: 1000
  });
  assert.equal(provisionalUnknownPrice?.decision, 'select', 'the model may rank a provisional observed title for read-only product-page verification');
  assert.equal(provisionalUnknownPrice?.selectedCandidateId, 'candidate-1');

  const overBudget = await rankAmazonCandidatesWithProvider({
    request: 'fruity granola bars',
    maxPrice: 3,
    candidates: [candidate()],
    timeoutMs: 1000
  });
  assert.equal(overBudget?.decision, 'abstain', 'provider output cannot override the signed cap');

  const missingPrime = await rankAmazonCandidatesWithProvider({
    request: 'fruity granola bars',
    primeRequired: true,
    candidates: [candidate({ primeEligible: false })],
    timeoutMs: 1000
  });
  assert.equal(missingPrime?.decision, 'abstain', 'provider output cannot override required fulfillment');

  mode = 'invented';
  const invented = await rankAmazonCandidatesWithProvider({ request: 'fruity granola bars', candidates: [candidate()], timeoutMs: 1000 });
  assert.equal(invented?.decision, 'abstain', 'invented candidate IDs are ignored');
  assert.equal(invented?.selectedCandidateId, null);

  mode = 'request-user';
  const clarification = await rankAmazonCandidatesWithProvider({ request: 'fruity granola bars', candidates: [candidate()], timeoutMs: 1000 });
  assert.equal(clarification?.decision, 'request_user');
  assert.equal(clarification?.selectedCandidateId, null);

  mode = 'oversized';
  const oversized = await rankAmazonCandidatesWithProvider({ request: 'fruity granola bars', candidates: [candidate()], timeoutMs: 1000 });
  assert.equal(oversized, null, 'oversized provider responses fail closed');

  mode = 'slow-body';
  const slowStartedAt = performance.now();
  const slow = await rankAmazonCandidatesWithProvider({ request: 'fruity granola bars', candidates: [candidate()], timeoutMs: 1000 });
  const slowElapsedMs = performance.now() - slowStartedAt;
  assert.equal(slow, null, 'the deadline remains active while reading the body');
  assert.ok(slowElapsedMs < 1250, `slow response exceeded bounded deadline: ${slowElapsedMs.toFixed(1)}ms`);

  console.log(JSON.stringify({
    amazonSelectionIntelligenceProvider: 'passed',
    providerCalls: calls,
    slowBodyDeadlineMs: Number(slowElapsedMs.toFixed(1)),
    responseLimitBytes: 4 * 1024
  }));
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await new Promise((resolve) => server.close(resolve));
}
