# Residual security review — 2026-10-07

## Scope and disposition

Reviewed published Zeko Labs `main` at `1444ac377ce2ea700bebdb1a2ed6c4a2141a12a1`.
Remote tips were checked directly during this review. Evan's `main` is
`5652592dd6b55fbc3312b3961d7d9e9312643872`; its additional delta is the separate
Runner recovery/version/Fly release work, not missing security hardening.
Zeko already includes the earlier tenant/accounting, hosted-browser SSRF, preview
XSS and persisted-protocol enforcement fixes.

Local review worktree:
`/Users/evankereiakes/Documents/Codex/agent-verification-residual-security-20261007`

**Three residual issues were reproduced and patched locally:** production relay
credential validation, payload-key file permissions, and model-provider redirect
leakage. README production and privacy claims were corrected. No commit, push,
deployment, key rotation, production-state inspection, purchase or chain
transaction was performed. This is a scoped review, not a certification that the
repository or its deployments have no remaining vulnerabilities.

## Original ten claims

| Claim | Classification | Evidence / remaining qualification |
| --- | --- | --- |
| 1. Default tokens, weak salt, environment keys | Partly already mitigated; confirmed residual fixed locally | `src/deploymentSecurity.js:29` enforces the web production profile, strong independent secrets and signing-key configuration. Standalone relayer lacked equivalent token-strength validation; optional web relay tokens escaped the list. New guards reject placeholders. Environment variables are not themselves proof of disclosure; secret-manager/host isolation still matter. |
| 2. Weak admin endpoints / insecure mode | Already mitigated in strict production; deployment hardening remains | Production forbids insecure/local-IP admin, uses provisioned account IDs, separate service credentials, shared PostgreSQL limiting on protected routes and canonical-origin checks. Static bearer credentials still require operator lifecycle controls; this is not per-request MFA or universal rate limiting. |
| 3. Unauthenticated plugin registration / arbitrary endpoint RCE | Original exploit claim not supported; adjacent redirect gap confirmed | `src/server.js:21887` authenticates and scopes registration; claim/fulfill bind assigned plugin/device/session. Plugin endpoint fields are persisted metadata, not fetched by registration/claim. `src/providers.js:1129` resolves operator-configured providers, not arbitrary plugin endpoints. No plugin-to-RCE or registration-to-SSRF execution path was reproduced. A separate model HTTP redirect did leak synthetic data; fixed below. |
| 4. JSON state has no concurrency control / credit doublespend | Already mitigated for required production profile; development limitation remains | `src/store.js:443` acquires a PostgreSQL single-writer advisory lock; revision-specific durable acknowledgements reject database failure. Production rejects file fallback. Real PostgreSQL concurrency, restart and outage tests passed. File mode is not a multi-process production database; `CREDIT_SCALE` must not change without migration. |
| 5. Rotate requester hash to farm credits / cash out | Claimed identity bypass mitigated; Sybil risk remains | `src/server.js:26414` requires authenticated identity and rejects a different supplied requester. Eight simultaneous requests yielded one grant and seven conflicts, in HTTP and PostgreSQL fixtures. `grantRewardCredits` deduplicates ledger event keys. Reward spending did not mint provider balances or allow payout. Multiple genuine accounts can still consume promotional resources; no KYC/captcha/global subsidy-budget guarantee is implied. |
| 6. Privacy is only weak hashing / unknown vault crypto | Documentation-only overclaims corrected; key-file issue fixed | `src/privacy.js` implements salted pseudonyms and optional AES-GCM payload copies, not anonymity. The optional key previously used default filesystem permissions. Vault uses AES-GCM and IndexedDB CryptoKeys; WebAuthn gates UI unlock, not a hardware-derived encryption key. Same-origin malicious JS remains in its trust boundary. General chat sends prompt/context to the configured provider. |
| 7. Supply-chain risk / no SBOM / image hardening | Unproven exploit; documented hardening opportunity | `npm ci` uses the lockfile. Current `npm audit --omit=dev --json` returned zero listed vulnerabilities. Generated CycloneDX SBOM contains 55 components. Docker images use a version tag, not a digest, and no non-root USER is declared. No OS-image vulnerability scan or least-privilege container migration was performed. Repository popularity is not exploit evidence. |
| 8. Predictable connector IDs permit hijacking | Already mitigated | SDK/connector access is owner-, service-key-, plugin- and device-bound. Anonymous reads and another tenant's mutations fail; general API keys cannot impersonate scoped plugins. Exact HTTP and real-PostgreSQL isolation tests passed. Predictability alone does not bypass these checks. |
| 9. Relayer compromise means arbitrary signing | Threat-model limitation plus credential fix | Compromise of a process holding signing keys is a real trust boundary, not proof that compromise has occurred. The standalone Fly config has no public services stanza; actual live networking was not inspected. Constant-time bearer checks and submission reservation/reconciliation already existed. New startup validation closes weak-token configuration. No HSM or external signer was added. |
| 10. No prompt sanitization means trivial authority bypass | Unproven exploit; architectural risk remains | Prompts/model outputs are untrusted. Safety depends on signed mission/action enforcement, independent candidate/price/fulfillment checks and human handoff, not a text sanitizer. Model privacy, mission-boundary and packaged selection tests passed. This is not proof of immunity to every prompt-injection technique. |

## Reproduced residual findings and patches

### R1 — production relay credentials bypassed strength checks

Before: the separate relayer opened its listener with missing, `change-me`, or
repeated-character credentials under `NODE_ENV=production`. Missing credentials
still rejected authenticated routes with 503; this was **not** anonymous signing.
A weak configured token, however, was accepted by the same bearer check protecting
submission. The web production validator also accepted `RELAYER_TOKEN=change-me`.

Patch: `src/relayerSecurity.js`, imported before relayer persistence modules,
rejects missing/weak effective credentials in either production setting.
`src/deploymentSecurity.js` validates configured optional relay credentials and
separates them from other secret roles. The legacy outbound submitter alias is
retained, including when both aliases contain the same token. Unconfigured web
receipt import remains disabled rather than forcing a new credential.

Tests: strong random token starts successfully; anonymous/wrong-token submission
fails; eight concurrent identical record-mode submissions create exactly one
record (one 201, seven 409). Existing mocked relayer health and reconciliation
tests also pass. No real signing/broadcast test was performed.

Impact: a misconfigured deployment now refuses startup. Run configuration checks
before rollout and coordinate any needed credential replacement; do not rotate
valid existing keys blindly. Exposure severity depends on reachability and the
privileges behind the weak credential.

### R2 — optional payload key inherited broad filesystem permissions

Before: a new `data/privacy.key` was `0644` under a normal `022` umask, readable
by other local users if parent-directory permissions allowed access.

Patch: `src/privacy.js:11` creates the file exclusively at `0600`, opens it without
following a final symlink, checks for a regular file, and repairs broad permissions
without changing existing bytes. Already-secure read-only files avoid chmod.

Tests: key permissions are `0600`; deliberately weakened legacy permissions are
repaired; key bytes remain identical; ciphertext decrypts with the original key.
This does not protect against the service UID/root or encrypt arbitrary metadata.
Operators using a symlink or an unowned/read-only broad-permission key must prepare
an owned, regular, securely permissioned key before enabling payload storage.

### R3 — model HTTP redirects forwarded prompt and custom secret header

Before: a local provider fixture returned HTTP 307 to a second endpoint. The
second endpoint received both a synthetic private prompt and `x-provider-secret`.
The prerequisite is control/compromise of a configured provider's response, not
anonymous plugin registration. Standard Authorization handling does not protect
arbitrary custom credential headers or POST bodies.

Patch: all four model fetch paths in `src/providers.js` specify `redirect: 'error'`.
No ranking, extraction schema, candidate checks or checkout behavior changed.
Operator-configured local model URLs remain permitted.

Tests: direct model response succeeds; redirected chat, streaming, mission
extraction and candidate ranking make zero downstream requests. The fixture
asserts all five upstream calls occurred. Existing ranking and extraction suites
pass, including bounded output, deadlines, candidate identity and budget checks.

Impact: even same-origin redirecting model URLs now fail; configure the canonical
final API endpoint. This is not DNS pinning for operator-controlled model endpoints.
Network egress restrictions remain an operator responsibility.

## Verification

Passed in disposable local fixtures:

- `test-residual-security.mjs`: before/after failures, unchanged key bytes,
  authenticated relayer concurrency and promotional credits without provider payout.
- `test-provider-redirect-security.mjs`: before/after synthetic leakage and all
  four provider request modes.
- `test-deployment-security.mjs`: strict config, origin/proxy, limiter and privacy.
- `test-security-boundary-http.mjs`, `security-boundary-cases.mjs`:
  SDK tenants, dedicated plugin scopes, provider binding, evidence-only receipts,
  email-admin denial and concurrent daily grants.
- `test-account-payment-security-http.mjs`, `test-account-payment-security.mjs`,
  `test-credit-settlement-refund.mjs`, `test-release-security.mjs`.
- `test-mba-relayer-health.mjs`, `test-mission-auth-relayer-reconciliation.mjs`.
- `test-custom-helper-privacy-controls.mjs`, `test-custom-helper-model-adapter.mjs`,
  `test-amazon-selection-intelligence-provider.mjs`,
  `test-magic-internet-agent-extraction.mjs`.
- Preview URL/persistence XSS and hosted-browser network security suites.
- Native Runner pairing/security, mission boundary, final-review and terminal suites.
- Extracted Runner package: **41/41 checkout scenarios**, payment-card fixtures,
  dropped-response/no-replay, terminal, rejected-claim and selection-recovery tests.

Real PostgreSQL suite: `test-production-security-integration.mjs` passed in a
disposable `node:20-bookworm` Linux container with PostgreSQL 15 and lockfile-installed
dependencies. Covers production HTTP, tenant/key/plugin isolation, concurrent
limiter/grant behavior, persistence/restart and database outage. The first attempt
failed because host dependency symlinks did not resolve in Linux; clean Linux
`npm ci` fixed the harness, not application code.

The new concurrent-grant test initially expected 201; the existing success contract
is 200. That test expectation was corrected without changing the route.

`npm audit --omit=dev --json`: zero reported advisories. This is not an OS/container
scan or proof that every dependency is safe. SBOM: [sbom.cdx.json](sbom.cdx.json).

`git diff --check` passes. No application data, funds, sessions or credentials were
migrated. Runner source and version are unchanged. The package test's existing
archive behavior recopied the primary checkout's 0.5.19 ZIP; its SHA-256 still
matches the published bytes:
`35f3824aaad20b047a3fc782f22eee7692ad06503e6293fc506bc512a04e62f2`.

## Rollout prerequisites and limits

1. Review this local patch. It is uncommitted and not on either remote.
2. Preflight actual deployment credentials privately. No live secret values,
   networking, persistence flags or image posture were audited here.
3. Confirm configured model APIs use their final URLs and optional payload keys
   are owned regular files with the documented permissions.
4. Preserve the separate Runner recovery release; this patch requires no new Runner.
5. For enterprise deployment, follow up with an OS-image scan, digest pinning,
   non-root/read-only filesystem and writable-directory tests, egress limits,
   managed signer/secret lifecycle, and an operator-funded promotional-abuse budget.
   These were not silently added as an untested hosting migration.

No currently reproduced high/critical exploit in this review remains deliberately
unpatched locally. That statement is limited to the tested findings above; it is
not clearance of unreviewed paths or of the currently deployed environment.
