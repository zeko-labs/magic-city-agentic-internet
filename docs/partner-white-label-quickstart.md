# Partner and White-Label Quickstart

Partners can reuse Magic City's existing boundaries without changing the
default Magic Internet Agent flow. There are three distinct integration paths.
Choose one; they are not successive setup steps.

## Hosted Retail Beta And Extensible Protocol

The hosted Magic Internet Agent on `magic-city.ai` currently completes retail
purchases through Amazon. A request that names another retailer is offered an
explicit Amazon reroute before a session starts. This launch restriction keeps
the verified Amazon flow narrow; it is not a restriction on partner-built
deployments or the mission protocol.

Partners can self-host Magic City, ship their own frontend and implement
site-specific browser behavior in a custom helper. A helper may also consult a
local or cloud model for bounded judgment, then revalidate the model's advisory
response against the current page and signed mission before acting. Model
output never expands merchant, budget, substitution or purchase authority. See
`docs/custom-helper-partner-deployment.md` and
`docs/custom-helper-model-access.md` for the implementation path.

## 1. Custom Helper Extension

Use this when the partner wants its own Chrome extension and browser logic but
will keep Magic City's control plane, mission authorization, policy checks and
receipts.

Start from `examples/custom-helper-extension-starter/`, which is separately
licensed under Apache-2.0. Copy its example build configuration and set:

| Setting | Location | Partner value |
| --- | --- | --- |
| Control-plane URL | `controlPlaneOrigin` | Partner or Magic City HTTPS origin |
| Helper identity | `helperPluginId`, `helperOwnerAgentId` | Stable, unique, non-reserved IDs |
| Extension identity | `extensionName`, `extensionDescription` | Partner branding |
| Approved page targets | `launchOrigins` | Exact origins this helper implementation accepts |
| Page access | `optionalMerchantOrigins` | Matching exact patterns granted by the user |
| Optional model judgment | `modelAdapter` | Disabled, or an authenticated relative control-plane adapter path |

The existing handshake is:

1. A signed-in user requests `POST /native-runner/helper/pairing/start` with the
   helper IDs.
2. The extension redeems the one-use pairing code and stores its device-scoped
   token locally.
3. The helper registers its identity and capabilities.
4. The user starts a mission. Magic City explicitly dispatches it to the paired
   device and returns a short-lived `extensionRunDispatch.nonce` in the scoped
   queue response.
5. The helper claims that exact session with the nonce and its runtime holder
   public key.
6. The helper follows the signed declarative plan, emits holder-signed
   checkpoints and fulfills or pauses the existing session.

The starter implements one harmless action: it opens the first signed
`browser_open` action on an allow-listed origin and returns a compact page
summary in a signed checkpoint. It then stops before the next unsupported
shopping action. Extend only the local execution behavior while keeping the
dispatch nonce, plan hash, ordered action IDs, holder signatures, cancellation
checks, single-submit receipts and sensitive-data boundaries.

Package and test the actual artifact:

```bash
node scripts/package-custom-helper-extension.mjs \
  --config path/to/partner.config.json \
  --profile release
npm run test:custom-helper-extension-packaging
npm run smoke:custom-helper-extension-package
```

Passing these tests proves config isolation, pairing, explicit dispatch, claim,
an actual allow-listed page read, signed result and terminal handoff. It does
not prove that custom merchant automation is complete.

### Production Runner reference map

The built-in Runner is a concrete implementation reference for teams building
their own `executeSession()`. Its license remains separate from the Apache
starter; use these locations to understand the required behavior and verify an
independent helper against the same protocol boundaries.

| Concern | Reference implementation | Evidence to reproduce |
| --- | --- | --- |
| Plan validation | `validatePlanForSession()` in `public/native-runner/extension/background-v0.2.js` | Reject wrong schema/protocol, hash, domain, action type, duplicate action ID and capability scope |
| Local authority | `assertLocalMissionAuthority()` in the same file | Reject cancelled or expired missions before browser work |
| Dispatch claim | `claimSession()` in the same file | Present the current device-scoped dispatch nonce and runtime holder key |
| Signed checkpoints | `missionCheckpoint()` and `buildProofOfPossession()` in the same file | Bind session, action, target domain, plan action and previous boundary hash |
| Ordered execution | `executePlanAction()` and `runSession()` in the same file | Execute only the next signed action and resume from the server cursor |
| Browser adapter | `executePlanStep()` in `public/native-runner/extension/executor.js` | Keep selectors and page interpretation local; return redacted structured state |
| Irreversible actions | `submitFinalOrder()`, `recordBrowserClick()` and `priorFinalOrderReceipt()` in `executor.js` | Record action-scoped intent and dispatch receipts; never replay an ambiguous click |
| Completion recovery | `reconcileCompletedPlan()` in `background-v0.2.js` | Treat verified merchant completion as terminal without another browser mutation |
| Lost checkpoint response | `reconcileCommittedCheckpoint()` in `public/native-runner/extension/background.js` | Read the durable cursor before retrying any completed step |

Do not copy merchant selectors blindly. A partner adapter should implement only
the merchants and action types it can verify, and pause when evidence is
missing or contradictory.

For model-assisted browser judgment, use the bounded adapter in
`examples/custom-helper-extension-starter/model-adapter.js` and follow
`docs/custom-helper-model-access.md`. A self-hosted control plane can route the
same authenticated request to a local model or a hosted provider without
putting provider keys in the extension. The model returns advisory structured
data referencing observed candidates; the helper retains every authority and
policy check.

### Partner implementation sequence

1. Keep the starter unchanged through pairing, registration, dispatch, claim
   and signed checkpoint generation.
2. Implement one reversible action, such as opening a harmless product page,
   behind `executeSession()`.
3. Add deterministic fixtures for success, missing controls, changed content,
   cancellation and worker restart.
4. Add cart or order preparation only after the earlier action and recovery
   tests pass.
5. Add an irreversible order action only with a bounded authorization, exact
   price/item/quantity checks, durable intent and dispatch receipts, and a
   no-replay test for every interruption boundary.
6. Test the packaged extension against an isolated control plane and harmless
   merchant fixture before a controlled canary.

### Definition of done for a custom shopping helper

- It cannot see or claim another helper's mission.
- Every action is covered by the signed plan and current mission authority.
- Cancellation and expiry stop execution before the next browser mutation.
- Login, CAPTCHA, payment authentication and unverifiable checkout evidence
  pause locally with a usable handoff.
- Sensitive browser and payment data stay local; checkpoints are redacted.
- Restarting at any action boundary resumes from durable state.
- Losing a checkpoint response does not repeat the browser action.
- An irreversible action has one intent, at most one native dispatch and one
  terminal merchant result for its action scope.
- The final ZIP, not just the source directory, passes its browser and protocol
  tests.

## 2. Independently Hosted Magic City

Use this when the partner needs its own domain, database, users, signing keys,
branding and deployment. This is possible today, but it is an advanced source
deployment rather than a one-command white-label product. The partner website
talks to its own authenticated backend/control plane, while its extension polls
and executes sessions from that same origin. No dependency on the
`magic-city.ai` hostname is required.

Create new infrastructure and credentials. Never copy production users,
database contents, pairing tokens, extension tokens or private keys.

Use [the production security profile](production-security.md) and
`.env.production.example` before exposing a self-hosted deployment. Run
`npm run check:deployment-security` with its intended environment. This validates
configuration, not enterprise certification or runtime readiness. Existing
deployments must follow the staged key/admin/proxy migration in that guide.

| Concern | Existing configuration point |
| --- | --- |
| Public service origin | `MAGIC_CITY_CANONICAL_ORIGIN`, `MAGIC_CITY_ALLOWED_HOSTS`, `HOST`, `PORT`; worker clients still use `MAGIC_CITY_BASE_URL` |
| Durable state | `DATABASE_URL`, database TLS settings, `MAGIC_CITY_REQUIRE_PRODUCTION_PERSISTENCE` |
| State encryption | `MAGIC_CITY_REQUIRE_STATE_ENCRYPTION`, `MAGIC_CITY_STATE_ENCRYPTION_KEY` |
| Mission authorization | `MISSION_BOUND_AUTH_SECRET`, `MISSION_BOUND_AUTH_PUBLIC_KEY_ID`, `MISSION_BOUND_AUTH_ED25519_PRIVATE_KEY` |
| Administrative/API access | `ADMIN_TOKEN`, `PUBLIC_API_KEYS`, `PRIVACY_SALT` |
| Production UI administrators | `AUTH_ADMIN_USER_IDS`: operator-verified existing account IDs; no email-based grants |
| Shared request limits | `MAGIC_CITY_RATE_LIMIT_STORE=postgres`, exact trusted proxy CIDRs |
| Login/session scope | `AUTH_SESSION_COOKIE_DOMAIN`, public URL and provider callback settings |
| Extension origins | `manifest.json` host permissions, `externally_connectable`, and allowed origins in the extension controller |
| Branding | `public/index.html`, static assets, extension manifest, popup and icons |
| Optional services | SantaClawz, payment, proof and relayer feature flags and credentials |
| Zeko | GraphQL URL, network IDs, registry identity, isolated relayer URL and token |

Start optional integrations disabled. Enable only those with independently
provisioned credentials and passing health/capability checks. The current state
store requires a single writer; preserve that deployment constraint until the
documented persistence migration is complete.

Minimum clean-install acceptance:

- New domain, database, encryption key and signing namespace.
- New extension identity with only the new domain allow-listed.
- Pairing and registration use fresh credentials.
- Explicit dispatch, claim and first signed checkpoint succeed.
- Cancellation, terminal recovery and duplicate-submit protections pass.
- A deterministic harmless merchant fixture completes with no production API
  calls and no secrets in logs or returned session data.
- The packaged extension matches its tested source and has its own privacy and
  Chrome Web Store disclosures.
- The helper popup lists revocable granted page origins. Optional model access
  requires consent to the configured local/cloud route and public-catalog field
  policy; see `docs/custom-helper-model-access.md`.

## 3. Embedded Merchant Integration

Use this when a merchant wants a branded shopping experience on its existing
website. The simplest long-term form is a frontend widget plus a merchant
backend adapter for catalog search, authoritative quotes, cart changes,
mission verification, idempotent order submission and receipts. A browser
extension is unnecessary when the merchant exposes those server APIs.

This repository contains useful mission schemas, SDK and verifier foundations,
but does not yet contain a turnkey drop-in merchant widget. Treat this as a
future integration product, not a documented production quickstart.

## What Stays Unchanged

None of these paths requires modifying Magic City's built-in Runner or Amazon
checkout flow. Partner helpers receive only sessions explicitly assigned to
their own plugin identity. The default Magic Internet Agent continues using its
existing pairing, dispatch, plan, proof and receipt contract.

## Licensing

The custom helper starter and the rest of the Zeko-authored repository are
licensed under Apache-2.0. See `LICENSE` and `LICENSING.md`. White-label
branding and independent deployment should be reviewed separately with Zeko
Labs because the Apache license does not grant trademark rights.

## Related Documentation

- `docs/custom-helper-partner-deployment.md`
- `docs/bring-your-own-helper-agent.md`
- `docs/custom-helper-hello-walkthrough.md`
- `docs/custom-helper-model-access.md`
- `docs/custom-helper-release-checklist.md`
- `docs/custom-helper-privacy-template.md`
- `docs/local-authenticated-browser-runner.md`
- `docs/production-persistence.md`
