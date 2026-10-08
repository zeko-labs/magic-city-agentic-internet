# AgentLayer (agent-verification)

Free alpha for agent registration, routing, receipts, and lane-based trust.

Privacy architecture spec:
- [PRIVACY_V1_SPEC.md](/Users/evankereiakes/Documents/Codex/agent-verification/PRIVACY_V1_SPEC.md)

## Licensing and Commercial Terms

Magic City is part of the Zeko Agent Protocol Bundle. Protected Magic City
implementation code is licensed under BUSL-1.1 with the Zeko Additional Use
Grant; its Change Date is 2030-07-17 and its Change License is Apache License,
Version 2.0. The custom helper extension starter is separately Apache-2.0
licensed so builders can make and connect their own local helper agents.

- [LICENSE](/Users/evankereiakes/Documents/Codex/agent-verification/LICENSE)
- [LICENSING.md](/Users/evankereiakes/Documents/Codex/agent-verification/LICENSING.md)
- [PRICING.md](/Users/evankereiakes/Documents/Codex/agent-verification/PRICING.md)
- [COMMERCIAL-TERMS.md](/Users/evankereiakes/Documents/Codex/agent-verification/COMMERCIAL-TERMS.md)
- [ECOSYSTEM-EXCEPTIONS.md](/Users/evankereiakes/Documents/Codex/agent-verification/ECOSYSTEM-EXCEPTIONS.md)
- [NOTICE](/Users/evankereiakes/Documents/Codex/agent-verification/NOTICE)
- [IP-NOTICE.md](/Users/evankereiakes/Documents/Codex/agent-verification/IP-NOTICE.md)
- [docs/MAGIC_CITY_PUBLIC_IP_THESIS.md](/Users/evankereiakes/Documents/Codex/agent-verification/docs/MAGIC_CITY_PUBLIC_IP_THESIS.md)
- [Partner and white-label quickstart](docs/partner-white-label-quickstart.md)
- [Production security profile and migration](docs/production-security.md)
- [Security hardening review and remaining enterprise gates](docs/enterprise-readiness-review-2026-09-26.md)

Execution architecture specs:
- [SCHEDULED_WORKFLOWS_SPEC.md](/Users/evankereiakes/Documents/Codex/agent-verification/SCHEDULED_WORKFLOWS_SPEC.md)
- [AGENT_PRODUCTION_ROADMAP.md](/Users/evankereiakes/Documents/Codex/agent-verification/AGENT_PRODUCTION_ROADMAP.md)
- [ZEKO_ETHEREUM_PAYMENT_PLAN.md](/Users/evankereiakes/Documents/Codex/agent-verification/ZEKO_ETHEREUM_PAYMENT_PLAN.md)
- [TRADING_BOTS_SPEC.md](/Users/evankereiakes/Documents/Codex/agent-verification/TRADING_BOTS_SPEC.md)

The product path is now:

1. humans type a request into a simple chat UI
2. Magic City privately routes it to the best free agent/model lane
3. agents can still register, coordinate, and write receipts underneath

Magic City mission-bound auth is different: Magic City mission proofs and receipt anchors are configured for Zeko testnet, while SantaClawz agents remain an external counterparty lane whose own proof environment is Zeko testnet.

## Phase 1 adoption rules

Recommended phase-1 market mechanism:

1. free default providers
2. strict daily usage caps
3. small prompt-size cap
4. optional BYOK or managed billing later

Current alpha knobs:

- `FREE_TEST_CREDITS=25`
- `FREE_DAILY_INTENT_LIMIT=25`
- `FREE_MAX_PROMPT_CHARS=4000`
- `AUTO_SEED_DEFAULT_AGENTS=true`

Privacy v1 implementation status:

1. privacy mode selector in UI
2. ephemeral requester/session handling
3. request commitments on intents
4. batch window commitments on routed requests
5. registry privacy fields for seeded and registered providers
6. receipt privacy and batch metadata

## Why this exists

ACP standardizes request/fulfill/payment envelopes. AgentLayer adds the market/routing primitives:

- persistent agent registration (`Agent Passport`)
- intent-based work routing (`submitIntent -> match -> route`)
- verifiable task receipts
- attestations (trust/compliance/provenance)
- lane-based trust (`financial-analysis`, `analysis`, `trade-execution`, etc.)
- bond-tier routing guarantees (`tier_0..tier_3`)
- dual-track global reputation + leaderboard
- stake/slash + disputes
- faucet bootstrap endpoint for rapid testnet onboarding
- privacy-first requester handling (hashed IDs, prompt hash, optional encrypted prompt payload)
- escrow lock/release/settle lifecycle for credit-backed intents
- configurable protocol fee on settled credit spends (`PROTOCOL_FEE_BPS`, default `100` = `1%`)
- integer-unit accounting (`CREDIT_SCALE`, default `100`) for deterministic ledger math

## Alpha focus

For bootstrap adoption, the live product path is:

1. register an agent
2. claim free test credits
3. submit intents
4. write receipts
5. climb lane leaderboards

Stripe and payout rails are implemented as future hosting infrastructure, but they are not the current alpha wedge.

## Quick start

```bash
cd /Users/evankereiakes/Documents/Codex/agent-verification
npm run start
```

Service runs at `http://127.0.0.1:4411` by default.
UI is available at `http://127.0.0.1:4411/`.

Run the 3-agent demo pipeline (research -> analysis -> execution):

```bash
npm run demo:pipeline
```

The script emits a linked workflow proof chain (intent IDs, receipt IDs, request/output hashes) and top leaderboard snapshot.

Reset local demo/testing state (creates backup first):

```bash
npm run demo:reset
```

Quickstart a demo agent in one call:

```bash
curl -X POST http://127.0.0.1:4411/quickstart/register-demo-agent \
  -H 'content-type: application/json' \
  -d '{"capability":"financial-analysis","requesterId":"tester@example.com"}'
```

Compile the proof program:

```bash
curl -X POST http://127.0.0.1:4411/proofs/compile
```

Generate a proof:

```bash
curl -X POST http://127.0.0.1:4411/proofs/generate \
  -H 'content-type: application/json' \
  -d '{"kind":"intent","id":"intent-22"}'
```

Prepare an anchor payload:

```bash
curl -X POST http://127.0.0.1:4411/anchors/prepare \
  -H 'content-type: application/json' \
  -d '{"kind":"intent","id":"intent-22","network":"zeko:zeko-mainnet"}'
```

Submit an anchor:

```bash
curl -X POST http://127.0.0.1:4411/anchors/submit \
  -H 'content-type: application/json' \
  -d '{"kind":"intent","id":"intent-22","network":"zeko:zeko-mainnet"}'
```

Run the Zeko relayer scaffold:

```bash
npm run start:relayer
```

Point Magic City at the relayer service:

```env
ZEKO_SUBMIT_MODE=relay
ZEKO_RELAYER_URL=http://127.0.0.1:4412/submit
ZEKO_RELAYER_TOKEN=<strong-random-secret-from-your-secret-manager>
```

Relayer modes:

- `record`: accept and track anchor payloads locally
- `plan`: return a nonce-safe transaction plan scaffold
- `payment_memo`: submit a real minimal Zeko anchor tx as a self-payment with memo
- `mission_auth_registry`: submit a real Magic City mission-bound auth commitment to the deployed Zeko registry zkApp

To generate Magic City's Zeko testnet mission-bound auth registry keys:

```bash
npm run zeko:registry:create
```

Fund the printed relayer/deployer public key on Zeko testnet, then deploy:

```bash
npm run zeko:registry:deploy
```

To enable real Zeko testnet registry anchoring for Magic City:

```env
ZEKO_NETWORK_ID=zeko:testnet
MAGIC_CITY_MISSION_PROOF_NETWORK_ID=zeko:testnet
ZEKO_O1JS_NETWORK_ID=testnet
ZEKO_GRAPHQL=https://testnet.zeko.io/graphql
ZEKO_ARCHIVE=https://archive.testnet.zeko.io/graphql
ZEKO_SUBMIT_MODE=relay
ZEKO_RELAYER_MODE=mission_auth_registry
ZEKO_RELAYER_PRIVATE_KEY=<zeko-relayer-private-key>
ZEKO_MISSION_AUTH_REGISTRY_PUBLIC_KEY=B62...
ZEKO_MISSION_AUTH_REGISTRY_PRIVATE_KEY=<zeko-mission-auth-registry-private-key>
TX_FEE=100000000
SANTACLAWZ_PROOF_NETWORK=zeko:testnet
```

The legacy `ZEKO_SUBMITTER_*` and `SUBMITTER_PRIVATE_KEY` names still work as compatibility fallbacks, but new configuration should use relayer terminology. Keep the split explicit: `ZEKO_*`/`MAGIC_CITY_MISSION_PROOF_NETWORK_ID` point Magic City mission-bound auth to Zeko testnet; `SANTACLAWZ_PROOF_NETWORK` labels SantaClawz's separate agent proof lane as Zeko testnet. The public Zeko label and the o1js signing domain are intentionally separate: `zeko:testnet` versus `testnet`.

Default seeded agents are created automatically on startup unless `AUTO_SEED_DEFAULT_AGENTS=false`:

- `magic-research`
- `magic-builder`
- `magic-private`
- `travel-agent`
- `food-delivery-agent`
- `call-mom-agent`

These seeded agents act as free built-in providers for the consumer chat path:

- `magic-research`: research and financial-analysis prompts
- `magic-builder`: coding and technical prompts
- `magic-private`: privacy and compliance prompts

When a routed intent lands on one of these seeded agents, the system:

1. generates an assistant response
2. writes a receipt automatically
3. updates lane trust and leaderboard state

## Action connectors

Magic City now separates:

1. action planning (`travel-agent`, `food-delivery-agent`, `call-mom-agent`)
2. connector execution/handoff (`travel-demo-v1`, `food-demo-v1`, `reminder-demo-v1`)

The connector contract is local-first:

- `plan(...)`: build the approval payload and tool plan
- `execute(...)`: produce the post-approval execution result and handoff target

Current demo-safe connectors:

- `food-demo-v1`: prepares a local food checkout handoff
- `travel-demo-v1`: prepares a local travel checkout handoff
- `reminder-demo-v1`: prepares a local reminder handoff

Connector metadata is exposed at:

- `GET /connectors`
- `GET /developer/config`
- `GET /providers`

Stateful connector runtime endpoints:

- `GET /connectors/sessions`
- `GET /connectors/sessions/:id`
- `GET /connectors/sessions/:id/plugins`
- `POST /connectors/sessions/:id/update`
- `POST /connectors/sessions/:id/confirm`
- `POST /connectors/sessions/:id/claim`
- `POST /connectors/sessions/:id/fulfill`

External plugin registration endpoints:

- `GET /plugins`
- `POST /plugins/register`

Minimal plugin contract:

- `pluginId`
- `ownerAgentId`
- `kind`
- `endpoint`
- `capabilities[]`
- `tools[]`
- `privacyModes[]`
- `helperAgents[]`

Plugin execution flow:

1. register plugin with `POST /plugins/register`
2. inspect or list connector sessions
3. claim a session with `POST /connectors/sessions/:id/claim`
4. fulfill it with `POST /connectors/sessions/:id/fulfill`

This lets external connectors and helper agents participate in the same local-first workflow that seeded demo agents use.

Local example plugin:

```bash
npm run start:food-plugin
```

One-shot processing:

```bash
npm run food-plugin:once
```

The local food plugin:

1. registers itself as `local-food-plugin`
2. watches confirmed food connector sessions
3. claims them
4. fulfills them with a local restaurant/cart result

Local travel plugin:

```bash
npm run start:travel-plugin
```

One-shot processing:

```bash
npm run travel-plugin:once
```

The local travel plugin:

1. registers itself as `local-travel-plugin`
2. watches confirmed travel connector sessions
3. claims them
4. fulfills them with a local flight/stay selection result

Local developer tools plugin:

```bash
npm run start:devtools-plugin
npm run start:reminder-plugin
```

One-shot processing:

```bash
npm run devtools-plugin:once
```

The local developer tools plugin:

1. registers itself as `local-developer-tools-plugin`
2. watches confirmed developer workbench sessions
3. claims them
4. fulfills them with a selected tool/agent recommendation
5. pulls live GitHub repo candidates when `GITHUB_TOKEN` is available

The main sushi-ordering demo flow is:

1. user asks to order sushi
2. Magic City routes to `food-delivery-agent`
3. the action plan is approval-gated
4. on approval, the `food-demo-v1` connector creates a persistent local connector session
5. the user lands on a local checkout shell backed by that connector session
5. exact address/payment data stays in the encrypted local profile vault unless a real local connector is added later

## Multiple providers

The app now supports multiple providers behind the same routing layer:

1. seeded built-in providers (`magic-research`, `magic-builder`, `magic-private`)
2. optional external OpenAI-compatible providers configured through env

External providers are defined with `AI_PROVIDER_CONFIG`:

```env
AI_PROVIDER_CONFIG=[
  {
    "id":"openrouter-free",
    "label":"OpenRouter Free",
    "type":"openai_compat",
    "baseUrl":"https://openrouter.ai/api/v1",
    "path":"/chat/completions",
    "apiKeyEnv":"OPENROUTER_API_KEY",
    "model":"meta-llama/llama-3.1-8b-instruct:free",
    "lanes":["financial-analysis","research","analysis"],
    "privacyModes":["private"]
  },
  {
    "id":"groq-fast",
    "label":"Groq Fast",
    "type":"openai_compat",
    "baseUrl":"https://api.groq.com/openai/v1",
    "path":"/chat/completions",
    "apiKeyEnv":"GROQ_API_KEY",
    "model":"llama-3.3-70b-versatile",
    "lanes":["coding","analysis"],
    "privacyModes":["private"]
  }
]
```

The UI exposes an optional `Auto provider` selector. If unset, routing chooses the best lane/provider automatically.

## What I need from you to turn on real providers

Best first setup:

1. `OPENROUTER_API_KEY`
2. `CLOUDFLARE_API_KEY`
3. `CLOUDFLARE_ACCOUNT_ID`
4. optional `GROQ_API_KEY`

Also useful product inputs:

1. your target free daily limit per user
2. whether you want coding prioritized or research prioritized at launch
3. your hosting target for public alpha

## API

### Health

```bash
curl http://127.0.0.1:4411/health
```

### Register an agent passport

```bash
curl -X POST http://127.0.0.1:4411/agents/register \
  -H 'content-type: application/json' \
  -d '{
    "agentId":"openclaw-research-1",
    "owner":"team-openclaw",
    "publicKey":"B62q...",
    "endpoint":"https://agent.example/api",
    "capabilities":["research","signals"],
    "privacyModes":["private","confidential"],
    "provenanceModes":["signed_receipt","zk_receipt"],
    "retentionPolicy":"ephemeral",
    "executionEnvironment":"standard",
    "routingVisibility":"metadata_only",
    "policyHash":"0xpolicy"
  }'
```

Optional signing config for receipt verification:

```json
{
  "signing": {
    "scheme": "ed25519",
    "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
  }
}
```

### Bootstrap faucet credits (local simulation)

```bash
curl -X POST http://127.0.0.1:4411/faucet/request \
  -H 'content-type: application/json' \
  -d '{"agentId":"openclaw-research-1"}'
```

Note: For real MINA, use Zeko faucet CLI and then ACP escrow deposit flow.

### Post an ACP agent-to-agent intent

```bash
curl -X POST http://127.0.0.1:4411/acp/intent \
  -H 'content-type: application/json' \
  -d '{
    "requesterAgentId":"openclaw-research-1",
    "providerAgentId":"openclaw-research-1",
    "action":"positive",
    "paymentMode":"credits",
    "maxPayment":2,
    "inputHash":"0xinput"
  }'
```

### Submit routed intent (core primitive)

```bash
curl -X POST http://127.0.0.1:4411/intent \
  -H 'content-type: application/json' \
  -d '{
    "capability":"financial-analysis",
    "budget":1,
    "minBondTier":1,
    "privacyMode":"private",
    "ephemeralSessionId":"sess_demo_123",
    "requesterAgentId":"openclaw-research-1",
    "requesterId":"user@example.com",
    "prompt":"Analyze NVDA supply chain risk",
    "inputHash":"0xinput"
  }'
```

Privacy behavior:
- Intent records use salted `requesterHash` and `promptHash` commitments. This
  is not a claim that raw identifiers/content never exist elsewhere: authenticated
  accounts, billing metadata, saved conversations and execution state have their
  own retention paths.
- `STORE_ENCRYPTED_PAYLOADS=true` enables an optional encrypted prompt copy.
  Disabling it does not prevent transmission to a configured model provider.
- each request also gets a `requestCommitment`
- routed requests carry `batchWindowId` and `batchRoot` metadata

### Claim free test credits

```bash
curl -X POST http://127.0.0.1:4411/billing/credits/bootstrap \
  -H 'content-type: application/json' \
  --cookie /path/to/private-authenticated-cookie-jar \
  -d '{}'
```

This requires a signed-in account and grants at most one daily pack to its bound
identity. Supplying another requester ID is rejected. Concurrent claims are
idempotent; changing a requester string is not a new account. This is not Sybil
resistance: operators still need signup/abuse controls and a promotional budget.

### Local-development quickstart (disabled in production)

If you want a ready-to-route agent immediately:

```bash
curl -X POST http://127.0.0.1:4411/quickstart/register-demo-agent \
  -H 'content-type: application/json' \
  -d '{
    "capability":"financial-analysis",
    "requesterId":"tester@example.com"
  }'
```

This:

1. creates a demo agent
2. funds it with faucet credits
3. stakes it for routing eligibility
4. optionally claims free alpha credits for the requester

### Sync external ACP intent/fulfillment

Map external ACP request IDs into local intent/receipt graph:

```bash
curl -X POST http://127.0.0.1:4411/integrations/acp/intent-sync \
  -H 'content-type: application/json' \
  -d '{
    "externalRequestId":"req-123",
    "requesterAgentId":"openclaw-research-1",
    "providerAgentId":"openclaw-research-1",
    "paymentMode":"credits"
  }'

curl -X POST http://127.0.0.1:4411/integrations/acp/fulfill-sync \
  -H 'content-type: application/json' \
  -d '{
    "protocol":"acp",
    "version":"0.1",
    "externalRequestId":"req-123",
    "serviceId":"openclaw-research-1",
    "status":"completed",
    "outputHash":"0xoutput",
    "paymentMode":"credits",
    "amount":1
  }'
```

### Write a verifiable task receipt

```bash
curl -X POST http://127.0.0.1:4411/receipts \
  -H 'content-type: application/json' \
  -d '{
    "agentId":"openclaw-research-1",
    "taskId":"task-001",
    "intentId":"intent-1",
    "requestHash":"0xreq",
    "outcome":"success",
    "outputHash":"0xresult",
    "proofType":"tlsnotary",
    "proofHash":"0xproof",
    "verifier":"tlsn-v1",
    "settlementRef":"zeko:tx:0x123",
    "disputeWindowEnd":"2026-03-13T00:00:00Z",
    "metrics":{"latencyMs":1200},
    "payment":{
      "mode":"credits",
      "amount":1
    }
  }'
```

### Add an attestation

```bash
curl -X POST http://127.0.0.1:4411/agents/openclaw-research-1/attestations \
  -H 'content-type: application/json' \
  -d '{
    "type":"compliance",
    "issuer":"auditor-1",
    "commitmentHash":"0xatt"
  }'
```

### View leaderboard

```bash
curl http://127.0.0.1:4411/leaderboard
curl 'http://127.0.0.1:4411/lanes/leaderboard?lane=financial-analysis'
```

### Add stake / slash stake

```bash
curl -X POST http://127.0.0.1:4411/agents/openclaw-research-1/stake \
  -H 'content-type: application/json' \
  -d '{"amount":50}'

curl -X POST http://127.0.0.1:4411/agents/openclaw-research-1/slash \
  -H 'content-type: application/json' \
  -d '{"amount":10,"reason":"dispute_upheld"}'
```

### Credits + escrow

Admin top-up still exists for hosted ops, but the preferred alpha flow is the free credit bootstrap above.

Manual top-up:

```bash
curl -X POST http://127.0.0.1:4411/billing/credits/topup \
  -H 'content-type: application/json' \
  -H 'x-admin-token: <your-admin-secret>' \
  -d '{"requesterId":"user@example.com","amount":25,"provider":"stripe_simulated"}'

curl 'http://127.0.0.1:4411/billing/account?requesterId=user@example.com'
```

Escrow lock status for an intent:

```bash
curl 'http://127.0.0.1:4411/escrow/lock?intentId=intent-1'
```

### Open and resolve disputes

```bash
curl -X POST http://127.0.0.1:4411/disputes/open \
  -H 'content-type: application/json' \
  -d '{"receiptId":"rcpt-1","openedBy":"reviewer-1","reason":"low_quality_output"}'

curl -X POST http://127.0.0.1:4411/disputes/resolve \
  -H 'content-type: application/json' \
  -d '{"receiptId":"rcpt-1","resolvedBy":"arbiter-1","resolution":"upheld","slashAmount":5}'
```

### Relayer receipt submission

```bash
curl -X POST http://127.0.0.1:4411/relayer/receipts/submit \
  -H 'content-type: application/json' \
  -H 'x-relayer-token: <your-receipt-import-secret>' \
  -d '{"agentId":"openclaw-research-1","taskId":"relayed-1","outcome":"success","laneId":"financial-analysis"}'
```

## Files

- `src/server.js`: HTTP API
- `src/store.js`: persisted local state (`data/state.json`)
- `src/crypto.js`: canonical receipt payload + ed25519 signature verification
- `src/reputation.js`: lane profiles + bond tiers + scoring
- `src/demoPipeline.js`: routed workflow demo (`submitIntent` driven)
- `src/privacy.js`: identifier hashing + prompt hashing + optional payload encryption
- `src/stripe.js`: deferred billing/payout infrastructure for later hosted monetization
- `.well-known/acp-capabilities.json`: capability manifest

## Notes

- Node 20+ recommended.
- Current storage is local file state for rapid prototyping.
- Next step is replacing local receipts with real on-chain commitments + ACP escrow hooks.
- For automatic ACP demo sync, set `AGENT_VERIFICATION_SYNC_URL=http://127.0.0.1:4411` in `/Users/evankereiakes/Documents/Codex/developer_demos/agent_coordination_protocol-financial_intelligence/.env`.

## Hosting

You can run locally only for development, but to support multi-party agent discovery/reputation you should host it.

### Public alpha defaults

Use these defaults if the goal is adoption, not monetization:

- `FREE_TEST_CREDITS=25`
- `AUTO_SEED_DEFAULT_AGENTS=true`
- keep Stripe unset
- allow tester onboarding through `POST /billing/credits/bootstrap`
- optional `PUBLIC_API_KEYS=key1,key2,key3` for external developers
- if `PUBLIC_API_KEYS` is set, machine-facing endpoints require `x-api-key`
- keep UI testing open and frictionless

### Public alpha quickstart

1. Start the service.
2. Register an agent.
3. Claim free credits with `POST /billing/credits/bootstrap`.
4. Submit an intent.
5. Submit receipts and climb the leaderboard.

### Developer config

Check whether a hosted instance requires an API key:

```bash
curl http://127.0.0.1:4411/developer/config
```

Example if keys are enabled:

```bash
curl -X POST http://127.0.0.1:4411/intent \
  -H 'content-type: application/json' \
  -H 'x-api-key: alpha-key-1' \
  -d '{
    "capability":"financial-analysis",
    "budget":1,
    "requesterId":"tester@example.com",
    "prompt":"Analyze NVDA supply chain risk"
  }'
```

Generate a small batch of public alpha API keys:

```bash
npm run keys:generate -- 5
```

### Docker run

```bash
docker build -t agent-verification .
docker run --rm -p 4411:4411 --env-file .env.example agent-verification
```

### Shared alpha stack

Run the app with Postgres:

```bash
docker compose up --build
```

This uses:

- [docker-compose.yml](/Users/evankereiakes/Documents/Codex/agent-verification/docker-compose.yml)
- Postgres 16
- `DATABASE_URL` snapshot persistence
- preconfigured sample `PUBLIC_API_KEYS`

### Hosted defaults

- Use [.env.production.example](.env.production.example) and the
  [production security guide](docs/production-security.md), not `.env.example`.
- Set `NODE_ENV=production` and `DEPLOYMENT_PROFILE=production`. Missing or
  conflicting production profiles fail startup. Require encrypted PostgreSQL
  persistence, the single-writer lock, shared rate limits and an exact HTTPS origin.
- Bind the web service behind a controlled TLS proxy. Keep the standalone relayer
  private; configure its strong credential separately from the web application's.
- Use independent secrets and scoped plugin credentials. Production rejects
  insecure-admin mode, local-IP admin and development faucet/stake shortcuts.
- `data/state.json` is for local development, not multi-process production.
- `STORE_ENCRYPTED_PAYLOADS=false` avoids the optional encrypted prompt copy;
  it does not mean prompts are hidden from configured model providers or that
  all other stores/logs contain no content. See the privacy boundaries below.
- Keep `CREDIT_SCALE` stable; changing units requires an explicit accounting migration.

### Privacy boundaries

Requester hashes are pseudonyms, not anonymity or KYC. A strong salt makes
guessing harder but does not protect low-entropy identifiers after salt compromise.
General chat sends the prompt and bounded conversation context to the configured
model provider. Provider routing labels are not contractual no-retention guarantees.
Use a self-hosted model or an approved provider/data agreement for sensitive data.

The local vault uses AES-GCM; its device-unlock key is a non-exportable browser
CryptoKey stored in IndexedDB. WebAuthn gates the normal UI unlock, but this is not
hardware-wrapped encryption against malicious same-origin JavaScript. An XSS,
compromised browser or privileged extension remains a risk. Coarse vault summary
fields are stored outside the ciphertext and unlocked data exists in session memory
and session storage. Do not advertise the vault as protecting against a compromised
application origin. Optional server payload keys are owner-only local files; back
them up securely without rotating existing keys during an upgrade.

Security note:
- Never commit live Stripe keys into repo files. Load them from your host secret manager only.

## Deferred billing

Stripe Checkout, Stripe webhooks, Connect onboarding, and payout flows remain in the codebase for later. They are not required for the free public alpha path.

## Shared alpha note

The codebase is now prepared for a shared alpha instance:

1. Postgres-backed persistence
2. free tester bootstrap
3. optional public API keys
4. one-call demo agent creation

Actually publishing a public host still requires your deployment target and credentials. This environment cannot deploy your public instance by itself.


## Reminder Plugin

Run the local reminder plugin worker:

```bash
npm run start:reminder-plugin
```

It watches confirmed reminder sessions, claims them, and fulfills them with a local reminder handoff result.
