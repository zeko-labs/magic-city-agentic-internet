import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const manifestPath = path.join(rootDir, 'public/native-runner/extension/manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const zipPath = path.join(rootDir, 'dist/native-runner-extension', `magic-city-runner-${manifest.version}.zip`);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magic-city-extension-package-'));
const unpackedDir = path.join(tmpDir, 'unpacked');

function fail(message) {
  console.error(`native runner extension package smoke failed: ${message}`);
  process.exit(1);
}

try {
  const packageResult = spawnSync(process.execPath, ['scripts/package-native-runner-extension.mjs'], {
    cwd: rootDir,
    stdio: 'inherit'
  });
  if (packageResult.error) fail(packageResult.error.message);
  if (packageResult.status !== 0) fail(`package script exited with ${packageResult.status}`);
  if (!fs.existsSync(zipPath)) fail(`missing release zip ${zipPath}`);

  fs.mkdirSync(unpackedDir, { recursive: true });
  const unzip = spawnSync('unzip', ['-q', zipPath, '-d', unpackedDir], {
    cwd: rootDir,
    stdio: 'inherit'
  });
  if (unzip.error) fail(unzip.error.message);
  if (unzip.status !== 0) fail(`unzip exited with ${unzip.status}`);

  const packagedManifestPath = path.join(unpackedDir, 'manifest.json');
  if (!fs.existsSync(packagedManifestPath)) fail('unpacked package is missing manifest.json');
const packagedManifest = JSON.parse(fs.readFileSync(packagedManifestPath, 'utf8'));
  if (packagedManifest.version !== manifest.version) {
  fail(`manifest version mismatch: source ${manifest.version}, package ${packagedManifest.version}`);
}

const packagedBackground = fs.readFileSync(path.join(unpackedDir, 'background.js'), 'utf8');
if (!/import\s+\*\s+as\s+legacyController\s+from\s+['"]\.\/background-v0\.2\.js['"]/.test(packagedBackground)) {
  fail('v0.3 gateway must use the verified legacy controller module');
}
if (/onInstalled[\s\S]*pollAndExecute\(\)/.test(packagedBackground)) {
  fail('extension install must not auto-run browser missions');
}
const packagedLegacyBackgroundPath = path.join(unpackedDir, 'background-v0.2.js');
if (!fs.existsSync(packagedLegacyBackgroundPath)) fail('package is missing the local 0.2.x compatibility controller');
const packagedLegacyBackground = fs.readFileSync(packagedLegacyBackgroundPath, 'utf8');
const packagedAmazonSelectionPath = path.join(unpackedDir, 'amazon-selection.js');
if (!fs.existsSync(packagedAmazonSelectionPath)) fail('package is missing the bounded Amazon selection policy');
const packagedAmazonSelection = fs.readFileSync(packagedAmazonSelectionPath, 'utf8');
if (!/export function selectAmazonSearchCard/.test(packagedAmazonSelection)
  || !/rawScanned > 96 \|\| cards\.length >= 48/.test(packagedAmazonSelection)
  || !/bestExact \? 'exact' : 'size_alternative'/.test(packagedAmazonSelection)
  || !/amazon_search_card_closest_size/.test(packagedAmazonSelection)
  || !/rawAction\.allowSizeSubstitution === true/.test(packagedAmazonSelection)
  || !/requiresProductPageVerification: true/.test(packagedAmazonSelection)
  || !/exact_product_page_verification/.test(packagedAmazonSelection)
  || !/requiresApproval: true/.test(packagedAmazonSelection)) {
  fail('Amazon selection must remain exact-first and bounded, with signed opt-in required for automatic closest-size fallbacks');
}
if (!/async function completeAmazonSelectionOutcome/.test(packagedLegacyBackground)
  || !/outcome\.requiresProductPageVerification !== true/.test(packagedLegacyBackground)
  || !/amazonProductIdentityMatches/.test(packagedLegacyBackground)
  || !/summary\.productShippingKnown === true/.test(packagedLegacyBackground)
  || !/selectionKind: 'no_verified_candidate'/.test(packagedLegacyBackground)) {
  fail('Amazon selection must verify inconclusive matching offers on one product page before continuing');
}
if (!/export\s*\{[^}]*pollOnly/.test(packagedLegacyBackground)) {
  fail('legacy controller must expose pollOnly for the lean heartbeat');
}
if (/startsWith\('v0\.3\.0'\)/.test(packagedLegacyBackground)) {
  fail('active mission recovery must not be disabled for the v0.3 runtime');
}
if (!/scheduleRunnerResume\(\);[\s\S]{0,240}return data\.session \|\| session/.test(packagedLegacyBackground)) {
  fail('each persisted browser checkpoint must arm active-mission recovery');
}
if (!/activeRun:\s*null/.test(packagedLegacyBackground)
  || !/async function saveActiveRun/.test(packagedLegacyBackground)
  || !/async function clearActiveRun/.test(packagedLegacyBackground)
  || !/phase:\s*'waiting_for_payment_autofill'/.test(packagedLegacyBackground)) {
  fail('payment handoff must persist a durable active run for automatic recovery');
}
if (!/function actionWasSatisfiedBeforeRestart/.test(packagedLegacyBackground)
  || !/recoveredFromInterruption:\s*true/.test(packagedLegacyBackground)) {
  fail('interrupted browser steps must re-observe verified merchant state before repeating an action');
}
if (!/function normalizeActiveRunCandidate/.test(packagedLegacyBackground)
  || !/selectedCandidate:\s*normalizeActiveRunCandidate\(entry\?\.selectedCandidate\)/.test(packagedLegacyBackground)
  || !/selectedCandidate:\s*progress\.selectedCandidate/.test(packagedLegacyBackground)) {
  fail('interrupted cart actions must retain a compact selected-product identity for replay protection');
}
if (!/function normalizeActiveRunCartEvidence/.test(packagedLegacyBackground)
  || !/function verifiedCartEvidenceFor/.test(packagedLegacyBackground)
  || !/boundCartEvidence:\s*normalizeActiveRunCartEvidence/.test(packagedLegacyBackground)) {
  fail('pending-order continuation must use session-bound evidence from the verified one-item cart');
}
if (!/safeFieldsFilled:\s*normalizeActiveRunEvidenceLabels\(entry\?\.safeFieldsFilled\)/.test(packagedLegacyBackground)
  || !/checkoutSelections:\s*normalizeActiveRunEvidenceLabels\(entry\?\.checkoutSelections\)/.test(packagedLegacyBackground)) {
  fail('inline checkpoint recovery must retain accumulated checkout evidence');
}
if (!/Array\.isArray\(dispatches\[tabKey\]\)/.test(packagedLegacyBackground)
  || !/receipts\.find\(\(receipt\) => receipt\?\.receiptScope/.test(packagedLegacyBackground)
  || !/priorPendingOrderDispatchReceipt = await finalOrderDispatchReceiptFor/.test(packagedLegacyBackground)) {
  fail('first-submit and continuation dispatch receipts must remain independently durable by action scope');
}
if (!/const persistedActiveRun = await getActiveRun\(\);[\s\S]{0,600}phase: 'claiming'[\s\S]{0,1400}phase: 'claimed'/.test(packagedLegacyBackground)) {
  fail('the runner must persist recovery before its remote claim and retain it after claiming');
}
if (!/recordWake\('wake_received'\)/.test(packagedLegacyBackground)
  || !/recordWake\('wake_rejected'/.test(packagedLegacyBackground)
  || !/requested_session_not_runnable/.test(packagedLegacyBackground)
  || !/'claim_failed'/.test(packagedLegacyBackground)) {
  fail('the runner must persist and return an exact-session wake or claim failure instead of silently leaving it queued');
}
const startupCheckpointStart = packagedLegacyBackground.indexOf('async function checkpointRunnerStartup(');
const startupCheckpointSection = startupCheckpointStart >= 0
  ? packagedLegacyBackground.slice(startupCheckpointStart, startupCheckpointStart + 1_200)
  : '';
if (!startupCheckpointSection.includes("planActionStatus: 'waiting'")
  || !packagedLegacyBackground.includes('session = await checkpointRunnerStartup(session, plan, nextAction, startupTiming);')) {
  fail('the runner must report a non-advancing startup checkpoint before browser work');
}
if (!/const isCartMutation = action\.type === 'click_intent' && action\.intent === 'add_to_cart';[\s\S]{0,500}cartStateVerifiesCandidateSelection\(report, action\)/.test(packagedLegacyBackground)) {
  fail('a recovered cart mutation must verify the selected product before skipping a retry');
}
if (!/finalSubmitRequested: action\.type === 'final_submit' && Boolean\(recoveredState\?\.orderSubmitted/.test(packagedLegacyBackground)) {
  fail('a recovered merchant order confirmation must retain final-submit evidence');
}
if (!/async function reconcileCompletedPlan\(/.test(packagedLegacyBackground)
  || !/if \(!nextAction\) return reconcileCompletedPlan\(session, plan, planState, checkoutProfile\);/.test(packagedLegacyBackground)
  || !/Recovered a completed signed plan from verified merchant confirmation/.test(packagedLegacyBackground)) {
  fail('an exhausted signed plan must reconcile durable merchant confirmation without replaying a browser action');
}
if (!/runnerTiming:\s*\{[\s\S]{0,300}workerStartedAt:[\s\S]{0,300}checkpointRequestedAt\b/.test(packagedLegacyBackground)) {
  fail('runner checkpoints must include worker and checkpoint timing for recovery diagnostics');
}
const packagedExecutorPath = path.join(unpackedDir, 'executor.js');
if (!fs.existsSync(packagedExecutorPath)) fail('package is missing executor.js');
const packagedExecutor = fs.readFileSync(packagedExecutorPath, 'utf8');
if (!/function isAmazonPostAddCartConfirmationPath\(path = ''\)/.test(packagedExecutor)
  || !/\/cart\\\/smart-wagon/.test(packagedExecutor)
  || !/'post_add_confirmation'/.test(packagedExecutor)) {
  fail('Amazon smart-wagon must remain a non-authoritative post-add confirmation surface');
}
if (!/function scheduleFinalOrderClick\(control\)/.test(packagedExecutor)
  || !/function currentBrowserActionReceipts\(\)/.test(packagedExecutor)
  || !/validatedLabel/.test(packagedExecutor)
  || !/phase: 'final_submit_intent'/.test(packagedExecutor)
  || !/phase: 'click_dispatched'/.test(packagedExecutor)
  || !/type: 'MAGIC_CITY_FINAL_ORDER_DISPATCHED'/.test(packagedExecutor)
  || !/EXECUTOR_MESSAGE_LISTENER_KEY/.test(packagedExecutor)
  || !/function priorFinalOrderReceipt/.test(packagedExecutor)) {
  fail('final order dispatch must retain wrapper validation, durable receipts, and a single current executor listener');
}
if (!/function visibleProductPrice\(\)/.test(packagedExecutor)
  || !/oneTime:/.test(packagedExecutor)
  || !/subscription:/.test(packagedExecutor)
  || !/visibleLegacyCorePrice/.test(packagedExecutor)
  || !/if \(!visible\(container\) && !visibleLegacyCorePrice\(container\)\) return null/.test(packagedExecutor)) {
  fail('product-page verification must bind the one-time price through a visible offer container');
}
if (!/function singlePaymentCardContext\(/.test(packagedExecutor)
  || !/function amazonPaymentVisualRowContext\(/.test(packagedExecutor)
  || !/return matches\.length === 1 \? matches\[0\] : null/.test(packagedExecutor)
  || !/paymentConfirmationAlreadyRequested:\s*true/.test(packagedExecutor)) {
  fail('payment selection must bind one unique card row and avoid repeated confirmation clicks');
}
if (!/function activeCartItemEvidence\(\)/.test(packagedExecutor)
  || !/function pendingOrderMatchEvidence\(action/.test(packagedExecutor)
  || !/function canonicalProductTitle\(value = ''\)/.test(packagedExecutor)
  || !/productTitleFromRow\(row, link\)/.test(packagedExecutor)
  || !/identitySource:\s*asinRow \? 'asin'/.test(packagedExecutor)
  || !/quantitySource:\s*quantityMatches \? 'verified_cart'/.test(packagedExecutor)
  || !/quantityContradiction/.test(packagedExecutor)
  || !/merchandisePriceContradiction/.test(packagedExecutor)
  || !/action\.priorPendingOrderDispatchReceipt/.test(packagedExecutor)) {
  fail('pending-order continuation must require exact product identity and previously verified cart quantity');
}
if (!/pendingOrderContinuationStep[\s\S]{0,1200}pending_order_verification_required/.test(packagedLegacyBackground)) {
  fail('a sparse pending-order identity mismatch must remain a manual pending-order boundary');
}
if (/if \(globalThis\.__magicCityExecutorInstalled\) return;/.test(packagedExecutor)
  || !/priorFinalOrderReceipt\([\s\S]{0,220}'click_dispatched'/.test(packagedExecutor)
  || !/Final order dispatch was interrupted before the native merchant click/.test(packagedExecutor)) {
  fail('executor reinjection must replace the current handler and intent-only final submits must not count as dispatched');
}
if (!/if \(message\?\.type === 'MAGIC_CITY_FINAL_ORDER_DISPATCHED'\)/.test(packagedLegacyBackground)
  || !/saveFinalOrderDispatchReceipt\(sender\?\.tab\?\.id, message\.receipt\)/.test(packagedLegacyBackground)) {
  fail('the background must persist the dispatched final-order receipt before page navigation can unload the content script');
}
if (!/outcome\.finalSubmitReceipt\?\.kind === 'final_order'[\s\S]{0,160}outcome\.finalSubmitReceipt\?\.phase === 'click_dispatched'/.test(packagedLegacyBackground)
  || !/nextActionIndex: finalSubmitReceiptRecorded \? index \+ 1 : index/.test(packagedLegacyBackground)) {
  fail('a failed final submit must retain its signed action cursor');
}
const checkoutNavigationMarker = 'Opening checkout is navigation only.';
const checkoutNavigationIndex = packagedLegacyBackground.indexOf(checkoutNavigationMarker);
const checkoutNavigationSection = checkoutNavigationIndex >= 0
  ? packagedLegacyBackground.slice(Math.max(0, checkoutNavigationIndex - 900), checkoutNavigationIndex + 900)
  : '';
if (!checkoutNavigationSection || /runCheckoutProfileReconcile/.test(checkoutNavigationSection)) {
  fail('open-checkout must remain a navigation primitive, without hidden profile reconciliation');
}
if (!/ACTIVE_MISSION_RECOVERY_DELAY_MS\s*=\s*30_000/.test(packagedBackground)
  || !/result\?\.status === 'already_running'/.test(packagedBackground)) {
  fail('lean gateway must keep an active mission recoverable across MV3 suspension');
}
if (!/async function reconcileCommittedCheckpoint\(result\)/.test(packagedBackground)
  || !/open-site\|\(\?:prepare\|open\|inspect\)-cart\|continue-checkout\|reconcile-payment-profile\|inspect-review\|submit-final-order\|confirm-pending-order\|confirm-merchant-order/.test(packagedBackground)
  || !/MAX_INLINE_CHECKPOINT_RECONCILIATIONS\s*=\s*8/.test(packagedBackground)) {
  fail('committed checkout checkpoints must reconcile inline only for the reviewed action allowlist');
}
if (!/let finalSubmitAuthorityLease = normalizeFinalSubmitAuthorityLease/.test(packagedLegacyBackground)
  || !/const leaseScopeChangedAfterCheckpoint =/.test(packagedLegacyBackground)
  || !/recoverMissingFinalSubmitAuthorityLease\(session, plan, action\)/.test(packagedLegacyBackground)) {
  fail('a recovered final-submit cursor must obtain authority scoped to its current signed action');
}
if (!/if \(hasConfirmedMerchantOrder\(report\)\) \{[\s\S]{0,240}return reportAndStop\(/.test(packagedLegacyBackground)) {
  fail('durably checkpointed merchant confirmation must terminate before later tab-dependent actions');
}
if (!/onConnectExternal/.test(packagedBackground)
  || !/magic-city-active-run-v1/.test(packagedBackground)
  || !/RUNNER_PROGRESS/.test(packagedBackground)
  || !/RUNNER_RESULT/.test(packagedBackground)
  || !/chrome\.storage\.onChanged\?\.addListener/.test(packagedBackground)) {
  fail('normal mission execution must use a live progress channel instead of alarm-paced continuation');
}
if (/EXPLICIT_WAKE_ALARM|queueExplicitMissionWake|dispatchExplicitMissionWake/.test(packagedBackground)
  || !/return dispatch\(message, externalSenderContext\(sender, origin\)\);/.test(packagedBackground)
  || !/dispatch\(message, externalSenderContext\(port\.sender, origin\)\)/.test(packagedBackground)
  || !/Keep the external message open through the exact-session claim/.test(packagedBackground)) {
  fail('external runner wake must run through the direct exact-session claim path, without detached MV3 work');
}
if (!/function externalSenderContext\(sender = null, origin = ''\)/.test(packagedBackground)
  || !/preferredWindowId: sender\?\.tab\?\.windowId/.test(packagedLegacyBackground)
  || !/chrome\.tabs\.move\(tab\.id, \{ windowId: requestedWindowId, index: -1 \}\)/.test(packagedLegacyBackground)
  || !/sameWindow: hasRequestedWindow && focusWindowId === requestedWindowId/.test(packagedLegacyBackground)) {
  fail('an external focus request must move the exact mission tab into the trusted Magic City sender window');
}
if (!/async function pollAndExecute\(requestedSessionId = '', requestedDispatchNonce = '', clientRunStartedAt = ''\)/.test(packagedLegacyBackground)
  || !/String\(session\?\.id \|\| ''\) === normalizedSessionId/.test(packagedLegacyBackground)
  || !/directClaim:\s*true/.test(packagedLegacyBackground)
  || !/extensionRunDispatch:\s*\{ nonce: normalizedDispatchNonce \}/.test(packagedLegacyBackground)) {
  fail('runner execution must select the exact session requested by Magic City');
}
if (!/async function pollOnly\(\)[\s\S]*extensionRunDispatch\?\.expiresAt[\s\S]*pollAndExecute\(dispatchedSession\.id, dispatchedSession\.extensionRunDispatch\?\.nonce/.test(packagedLegacyBackground)) {
  fail('heartbeat fallback must execute only a still-valid user-dispatched browser mission');
}
if (!/EXECUTOR_REGISTRATION_REUSE_MS\s*=\s*30_000/.test(packagedLegacyBackground)
  || !/executorRegistrationInFlight/.test(packagedLegacyBackground)
  || !/registrationReused:\s*true/.test(packagedLegacyBackground)) {
  fail('startup must reuse or share a recent executor registration');
}
if (!/outcome\.alreadyInCart === true[\s\S]{0,500}amazon cart was already open/i.test(packagedLegacyBackground)) {
  fail('an already-open cart must bypass navigation waits and fallback reloads');
}
if (!/navigationTargetMatches\(beforeUrl, targetUrl\)/.test(packagedLegacyBackground)
  || !/const navigation = waitForTabNavigation\(tabId, beforeUrl, timeoutMs\);[\s\S]*const updatedTab = await withTimeout/.test(packagedLegacyBackground)) {
  fail('navigation readiness must be idempotent and subscribe before the tab update');
}
if ((packagedLegacyBackground.match(/injectImmediately:\s*true/g) || []).length < 2
  || !/browser_\(\?:navigation\|script_injection\|content_script/.test(packagedLegacyBackground)) {
  fail('page executor installation must start before document_idle and treat injection timeouts as recoverable browser interruptions');
}
if (!/browserActionIndeterminate:\s*true/.test(packagedLegacyBackground)
  || !/if \(Array\.isArray\(result\)\) return result\[0\]\?\.result \|\| null;/.test(packagedLegacyBackground)
  || !/planActionStatus:\s*'waiting'[\s\S]{0,900}browser_action_outcome_unknown/.test(packagedLegacyBackground)) {
  fail('a timed-out selection fast path must preserve the unknown outcome and stop without advancing its milestone');
}
if (!/retryingRecoverableExecution/.test(packagedBackground)
  || !/retrying_browser_step/.test(packagedBackground)
  || !/\^select-match/.test(packagedBackground)) {
  fail('select-match executor injection recovery must remain inside the active mission connection');
}
if (!/onClaimAccepted/.test(packagedLegacyBackground)
  || !/directClaimAccepted/.test(packagedLegacyBackground)
  || !/const status = claimRejected[\s\S]{0,180}\? 'claim_failed'/.test(packagedLegacyBackground)) {
  fail('direct-start failures must distinguish a rejected claim from an accepted mission execution');
}

  const smoke = spawnSync(process.execPath, ['scripts/smoke-native-runner-extension-browser.mjs'], {
    cwd: rootDir,
    env: {
      ...process.env,
      MAGIC_CITY_EXTENSION_SOURCE: unpackedDir
    },
    stdio: 'inherit'
  });
  if (smoke.error) fail(smoke.error.message);
  if (smoke.status !== 0) fail(`browser smoke exited with ${smoke.status}`);

  const cardReconciliationSmoke = spawnSync(process.execPath, ['scripts/test-native-runner-card-reconciliation.mjs'], {
    cwd: rootDir,
    env: {
      ...process.env,
      MAGIC_CITY_EXTENSION_SOURCE: unpackedDir
    },
    stdio: 'inherit'
  });
  if (cardReconciliationSmoke.error) fail(cardReconciliationSmoke.error.message);
  if (cardReconciliationSmoke.status !== 0) fail(`card reconciliation smoke exited with ${cardReconciliationSmoke.status}`);

  const connectionDropSmoke = spawnSync(process.execPath, ['scripts/smoke-native-runner-extension-browser.mjs'], {
    cwd: rootDir,
    env: {
      ...process.env,
      MAGIC_CITY_EXTENSION_SOURCE: unpackedDir,
      MAGIC_CITY_BROWSER_SMOKE_FOCUS: 'cart-checkpoint-connection-drop'
    },
    stdio: 'inherit'
  });
  if (connectionDropSmoke.error) fail(connectionDropSmoke.error.message);
  if (connectionDropSmoke.status !== 0) fail(`cart checkpoint connection-drop smoke exited with ${connectionDropSmoke.status}`);

  const checkoutResponseLossSmoke = spawnSync(process.execPath, ['scripts/smoke-native-runner-extension-browser.mjs'], {
    cwd: rootDir,
    env: {
      ...process.env,
      MAGIC_CITY_EXTENSION_SOURCE: unpackedDir,
      MAGIC_CITY_BROWSER_SMOKE_FOCUS: 'checkout-checkpoint-response-loss'
    },
    stdio: 'inherit'
  });
  if (checkoutResponseLossSmoke.error) fail(checkoutResponseLossSmoke.error.message);
  if (checkoutResponseLossSmoke.status !== 0) fail(`checkout checkpoint response-loss smoke exited with ${checkoutResponseLossSmoke.status}`);

  const confirmedOrderTerminalSmoke = spawnSync(process.execPath, ['scripts/smoke-native-runner-extension-browser.mjs'], {
    cwd: rootDir,
    env: {
      ...process.env,
      MAGIC_CITY_EXTENSION_SOURCE: unpackedDir,
      MAGIC_CITY_BROWSER_SMOKE_FOCUS: 'confirmed-order-terminal'
    },
    stdio: 'inherit'
  });
  if (confirmedOrderTerminalSmoke.error) fail(confirmedOrderTerminalSmoke.error.message);
  if (confirmedOrderTerminalSmoke.status !== 0) fail(`confirmed order terminal smoke exited with ${confirmedOrderTerminalSmoke.status}`);

  for (const focus of [
    'claim-rejection',
    'selection-injection-recovery',
    'selection-delayed-page-load',
    'selection-fast-path-timeout',
    'selection-product-verification-failure'
  ]) {
    const selectionSmoke = spawnSync(process.execPath, ['scripts/smoke-native-runner-extension-browser.mjs'], {
      cwd: rootDir,
      env: {
        ...process.env,
        MAGIC_CITY_EXTENSION_SOURCE: unpackedDir,
        MAGIC_CITY_BROWSER_SMOKE_FOCUS: focus
      },
      stdio: 'inherit'
    });
    if (selectionSmoke.error) fail(selectionSmoke.error.message);
    if (selectionSmoke.status !== 0) fail(`${focus} smoke exited with ${selectionSmoke.status}`);
  }

  console.log(`native-runner extension release package smoke passed: ${zipPath}`);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
