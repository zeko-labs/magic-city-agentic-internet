import { amazonProductAsin, amazonProductIdentityMatches, amazonProductUrlMatches, selectAmazonSearchCard } from './amazon-selection.js';

const DEFAULT_BASE_URL = 'https://magic-city.ai';
const POLL_ALARM = 'magic-city-runner-poll';
const RESUME_ALARM = 'magic-city-runner-resume';
const POLL_PERIOD_MINUTES = 1;
const RUNNER_EXTENSION_PLUGIN_ID = 'magic-city-runner-extension';
const RUNNER_EXTENSION_OWNER_AGENT_ID = 'magic-city-runner-extension';
const PENDING_SITE_MISSION_MAX_AGE_MS = 15 * 60 * 1000;
const EXECUTOR_FILE = 'executor.js';
const RUNNER_PROTOCOL = 'declarative-v1';
const PLAN_SCHEMA = 'magic-city-browser-plan-v1';
const MAX_PLAN_ACTIONS = 64;
const MAX_PLANNED_BASKET_ITEMS = 12;
const API_TIMEOUT_MS = 20_000;
const RUNNER_STATUS_TIMEOUT_MS = 4_000;
const RUNNER_STATUS_LEASE_MS = 3_000;
// The final merchant click may use a verified local capability to avoid a
// control-plane timeout at the irreversible boundary, but only immediately
// after this runner has confirmed the session is still live.
const FINAL_SUBMIT_LOCAL_LEASE_MS = 45_000;
const RUNNER_RESUME_DELAY_MS = 5_000;
const MERCHANT_ORDER_CONFIRMATION_TIMEOUT_MS = 90_000;
const MIN_MERCHANT_ORDER_CONFIRMATION_TIMEOUT_MS = 30_000;
const MAX_MERCHANT_ORDER_CONFIRMATION_TIMEOUT_MS = 120_000;
// Keep exactly one recovery wake for an already approved mission. Chrome can
// suspend an MV3 worker between two valid checkpoints; this lets it resume the
// signed next action without turning the runner into a background crawler.
const RUNNER_CONTINUATION_DELAY_MS = 5_000;
const PAYMENT_WAIT_RESUME_DELAY_MS = 5_000;
const PAYMENT_WAIT_HEARTBEAT_MS = 60_000;
const PAYMENT_WAIT_TIMEOUT_MS = 7 * 60 * 1000;
const CHECKOUT_PROFILE_RECONCILE_TIMEOUT_MS = 24_000;
const TRANSIENT_CONTROL_PLANE_RETRY_DELAYS_MS = [200, 700];
const TAB_COMMAND_TIMEOUT_MS = 15_000;
const AMAZON_SEARCH_CARD_FAST_PATH_TIMEOUT_MS = 8_000;
const BROWSER_ACTION_TIMEOUT_MS = 45_000;
const EXECUTOR_REGISTRATION_REUSE_MS = 30_000;
const LOCAL_CHECKOUT_PROFILE_STORAGE_KEY = 'magicCityLocalCheckoutProfiles';
const SAFE_PLAN_ACTION_TYPES = new Set(['navigate', 'inspect', 'search', 'select_candidate', 'click_intent', 'fill_checkout_profile', 'final_submit', 'pause']);
const inFlightSessionIds = new Set();
const RUNNER_WORKER_STARTED_AT = new Date().toISOString();
const RUNNER_WORKER_ID = globalThis.crypto?.randomUUID?.() || `worker-${Date.now()}-${Math.random().toString(16).slice(2)}`;
let executorRegistrationCache = null;
let executorRegistrationInFlight = null;

function normalizeBaseUrl(value = '') {
  return String(value || DEFAULT_BASE_URL).trim().replace(/\/+$/, '') || DEFAULT_BASE_URL;
}

function normalizePairingCode(value = '') {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)])
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

async function hashPlan(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(value)));
  return `0x${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function base64Url(bytes) {
  const values = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const value of values) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function randomNonce() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function domainForUrl(value = '') {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return String(value || '').toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
  }
}

function isAmazonRetailShoppingUrl(value = '') {
  let url = null;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (domainForUrl(url.href) !== 'amazon.com') return true;
  const path = String(url.pathname || '').toLowerCase();
  const blockedPath = /^\/(?:alm|gp\/video|video|primevideo|music|amazon-music|kindle-dbs|hz\/audible|audible|photos|luna|customer-preferences|gp\/customer-preferences)(?:\/|$)/i.test(path);
  const department = String(url.searchParams.get('i') || '').toLowerCase();
  const blockedDepartment = /^(?:instant-video|movies-tv|digital-music|popular|stripbooks)$/.test(department);
  return !blockedPath && !blockedDepartment;
}

function withAmazonEnglishLocale(value = '') {
  try {
    const url = new URL(String(value || ''));
    if (domainForUrl(url.href) === 'amazon.com') url.searchParams.set('language', 'en_US');
    return url.toString();
  } catch {
    return String(value || '');
  }
}

function amazonCartRecoveryUrl(plan = {}) {
  const cartAction = Array.isArray(plan.actions)
    ? plan.actions.find((action) => action.id === 'open-cart' && action.type === 'navigate')
    : null;
  return withAmazonEnglishLocale(cartAction?.url || 'https://www.amazon.com/gp/cart/view.html');
}

function isAmazonCheckoutPreludeUrl(value = '', plan = {}) {
  try {
    const url = new URL(String(value || ''));
    const domain = domainForUrl(url.href);
    const fixtureHost = domain === '127.0.0.1' || domain === 'localhost';
    const targetDomain = String(plan.targetDomain || '').toLowerCase().replace(/^www\./, '');
    return ((targetDomain === 'amazon.com' && domain === 'amazon.com') || (fixtureHost && targetDomain === domain))
      && /^\/checkout\/byg(?:\/|$)/i.test(String(url.pathname || ''));
  } catch {
    return false;
  }
}

function isAmazonCheckoutResumeUrl(value = '', plan = {}) {
  try {
    const url = new URL(String(value || ''));
    const domain = domainForUrl(url.href);
    const fixtureHost = domain === '127.0.0.1' || domain === 'localhost';
    const targetDomain = String(plan.targetDomain || '').toLowerCase().replace(/^www\./, '');
    const trustedTarget = (targetDomain === 'amazon.com' && domain === 'amazon.com') || (fixtureHost && targetDomain === domain);
    return trustedTarget && /^(?:\/checkout(?:\/|$)|\/gp\/cart\/view|\/cart(?:\/|$)|\/alm\/(?:byg|substitution)(?:\/|$))/i.test(String(url.pathname || ''));
  } catch {
    return false;
  }
}

function amazonCheckoutPreludeRecoveryUrl(value = '') {
  let url = null;
  try {
    url = new URL(String(value || ''));
  } catch {
    return 'https://www.amazon.com/checkout/entry/cart?proceedToCheckout=1&pipelineType=Chewbacca&referrer=cart&language=en_US';
  }
  const sourceDomain = domainForUrl(url.href);
  const trustedSource = sourceDomain === 'amazon.com' || sourceDomain === '127.0.0.1' || sourceDomain === 'localhost';
  if (!trustedSource) {
    return 'https://www.amazon.com/checkout/entry/cart?proceedToCheckout=1&pipelineType=Chewbacca&referrer=cart&language=en_US';
  }
  const ingress = String(url.searchParams.get('tangoIngressUrl') || '').trim();
  if (ingress) {
    try {
      const recovery = new URL(ingress, url.origin);
      const path = String(recovery.pathname || '');
      if (domainForUrl(recovery.href) === sourceDomain
        && /^\/checkout(?:\/|$)/i.test(path)
        && !/^\/checkout\/byg(?:\/|$)/i.test(path)) {
        recovery.searchParams.set('language', 'en_US');
        return recovery.toString();
      }
    } catch {
      // Fall through to a stable checkout entry URL below.
    }
  }
  const fallback = new URL('/checkout/entry/cart', url.origin);
  for (const key of [
    'sessionID',
    'useDefaultCart',
    'oldCustomerId',
    'preInitiateCustomerId',
    'cartItemCount',
    'partialCheckoutCart',
    'tangoWeblabStatus',
    'pipelineType',
    'referrer',
    'ref_',
    'isEligibilityLogicDisabled',
    'isToBeGiftWrappedBefore',
    'rrid'
  ]) {
    const current = url.searchParams.get(key);
    if (current) fallback.searchParams.set(key, current);
  }
  fallback.searchParams.set('proceedToCheckout', '1');
  if (!fallback.searchParams.get('pipelineType')) fallback.searchParams.set('pipelineType', 'Chewbacca');
  if (!fallback.searchParams.get('referrer')) fallback.searchParams.set('referrer', 'cart');
  fallback.searchParams.set('language', 'en_US');
  return fallback.toString();
}

function amazonActionRecoveryUrl(plan = {}, action = {}) {
  const checkoutPhase = /^(?:open-cart|inspect-cart|open-checkout|fill-checkout-profile|continue-checkout|reconcile-payment-profile|inspect-review|reconcile-reviewed-checkout|verify-reviewed-checkout|submit-final-order|pause-for-user)$/.test(String(action.id || ''));
  return checkoutPhase
    ? amazonCartRecoveryUrl(plan)
    : withAmazonEnglishLocale(plan.startUrl || 'https://www.amazon.com/');
}

async function enforceAmazonRetailLane(tabId, action = {}, plan = {}, checkoutProfile = null, outcome = {}) {
  if (plan.targetDomain !== 'amazon.com') return outcome;
  const currentTab = await chrome.tabs.get(tabId).catch(() => ({ url: outcome?.state?.url || '' }));
  if (isAmazonRetailShoppingUrl(currentTab.url || outcome?.state?.url || '')) return outcome;
  const recoveryUrl = amazonActionRecoveryUrl(plan, action);
  await navigateMissionTab(tabId, recoveryUrl, { timeoutMs: 5_000 }).catch(() => null);
  await delay(300);
  const localMarketRoute = /^\/alm(?:\/|$)/i.test(String(new URL(currentTab.url || outcome?.state?.url || 'https://www.amazon.com/').pathname || ''));
  return {
    ...outcome,
    completed: false,
    localMarketBlocked: localMarketRoute,
    reason: localMarketRoute
      ? 'Amazon redirected this cart to Local Market. This mission is restricted to the Amazon catalog, so Magic City returned to the approved cart instead of entering a third-party fulfillment flow.'
      : 'Amazon left the retail checkout lane. Magic City restored the approved shopping tab instead of interacting with account preferences.',
    state: await tabBrowserState(tabId, checkoutProfile, { attempts: 3, delayMs: 180 }).catch(() => outcome?.state || null)
  };
}

function isAmazonRetailProductUrl(value = '') {
  let url = null;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (domainForUrl(url.href) !== 'amazon.com') return true;
  return isAmazonRetailShoppingUrl(url.href) && Boolean(amazonProductAsin(url.href));
}

function compactNavigationUrl(value = '') {
  try {
    const url = new URL(String(value || ''));
    return `${url.origin}${url.pathname}`.slice(0, 240);
  } catch {
    return String(value || '').slice(0, 240);
  }
}

function candidateSelectionFailureReason(action = {}, report = {}, outcome = {}) {
  if (String(action.type || '') !== 'select_candidate') return '';
  const explicitReason = String(outcome.reason || '').trim();
  if (explicitReason) return explicitReason;
  const observedUrl = String(report.url || report.finalUrl || outcome.observedNavigationUrl || '').trim();
  const requestedUrl = String(outcome.navigationUrl || '').trim();
  const surface = String(report.browserSurface || report.browserState || report.checkoutSummary?.stage || '').toLowerCase();
  if (surface === 'cart') {
    return cartStateVerifiesCandidateSelection(report, action)
      ? 'The selected item is verified in the cart.'
      : 'Amazon opened the cart, but Magic City could not verify the requested item under the approved item budget.';
  }
  if (report.navigationConfirmed === false
    || !isAmazonRetailProductUrl(observedUrl)
    || ['search_results', 'search', 'browse'].includes(surface)) {
    return `Amazon did not reach a verified product page; it stayed on ${surface || 'an unverified page'}${observedUrl ? ` (${compactNavigationUrl(observedUrl)})` : ''}.`;
  }
  if (!report.addToCartAvailable && surface === 'product') {
    return `Amazon reached the product page${requestedUrl ? ` (${compactNavigationUrl(observedUrl)})` : ''}, but no verified Add to Cart control became available.`;
  }
  return 'The selected result could not be verified as a purchasable product.';
}

function domainPermissionPattern(value = '') {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.hostname === 'localhost') return '';
    return `https://${url.hostname.toLowerCase()}/*`;
  } catch {
    const domain = domainForUrl(value);
    if (!domain || domain === 'localhost') return '';
    return `https://${domain}/*`;
  }
}

function normalizeMissionAction(value = '') {
  const raw = String(value || '').trim().toLowerCase().replace(/[\s.-]+/g, '_');
  const aliases = {
    open: 'browser_open',
    navigate: 'browser_open',
    read: 'read_public_page',
    inspect_page: 'read_public_page',
    click: 'browser_click',
    fill: 'browser_type',
    type: 'browser_type',
    cart: 'prepare_cart',
    checkout: 'browser_click',
    submit: 'final_submit'
  };
  return aliases[raw] || raw || 'inspect';
}

function getTargetUrl(session = {}) {
  const selections = session.finalSelections || session.selections || {};
  return String(selections.targetUrl || selections.inputUrl || session.resolvedOrderUrl || '').trim();
}

function getBudget(session = {}) {
  const selections = session.finalSelections || session.selections || {};
  const candidates = [selections.budget, selections.magicCityPerTaskCap, selections.maxSpend, selections.maxSpendUsd];
  for (const candidate of candidates) {
    const match = String(candidate || '').match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
    if (match) return Number(match[1]);
  }
  return 0;
}

function planForSession(session = {}) {
  return session.extensionMissionPlan && typeof session.extensionMissionPlan === 'object'
    ? session.extensionMissionPlan
    : null;
}

async function validatePlanForSession(session = {}) {
  const plan = planForSession(session);
  if (!plan || plan.schema !== PLAN_SCHEMA || plan.protocol !== RUNNER_PROTOCOL) throw new Error('mission_plan_missing_or_unsupported');
  if (!plan.planId || !plan.planHash || !plan.startUrl || !Array.isArray(plan.actions) || !plan.actions.length || plan.actions.length > MAX_PLAN_ACTIONS) {
    throw new Error('mission_plan_invalid');
  }
  let startUrl = null;
  try {
    startUrl = new URL(plan.startUrl);
  } catch {
    throw new Error('mission_plan_target_invalid');
  }
  if (startUrl.protocol !== 'https:') throw new Error('mission_plan_target_invalid');
  const startDomain = domainForUrl(startUrl.href);
  const allowedDomains = Array.isArray(session.missionBoundAuth?.policy?.allowedDomains)
    ? session.missionBoundAuth.policy.allowedDomains.map((value) => String(value || '').toLowerCase().replace(/^www\./, '')).filter(Boolean)
    : [];
  if (!startDomain || (allowedDomains.length && !allowedDomains.includes(startDomain))) throw new Error('mission_plan_domain_not_allowed');
  const allowedActions = new Set((session.missionBoundAuth?.policy?.allowedActions || []).map(normalizeMissionAction));
  const actionIds = new Set();
  for (const action of plan.actions) {
    if (!action?.id || actionIds.has(action.id) || !SAFE_PLAN_ACTION_TYPES.has(action.type)) throw new Error('mission_plan_action_invalid');
    actionIds.add(action.id);
    if (!action.missionAction || !allowedActions.has(normalizeMissionAction(action.missionAction))) {
      throw new Error('mission_plan_action_not_allowed');
    }
    if (action.type === 'navigate') {
      try {
        const actionUrl = new URL(action.url || '');
        if (actionUrl.protocol !== 'https:' || domainForUrl(actionUrl.href) !== startDomain) throw new Error('mission_plan_navigation_not_allowed');
      } catch {
        throw new Error('mission_plan_navigation_not_allowed');
      }
    }
    if (action.type === 'search' && String(action.query || '').length > 140) throw new Error('mission_plan_query_invalid');
    if (action.type === 'click_intent' && !['add_to_cart', 'checkout', 'prefer_free_delivery'].includes(String(action.intent || ''))) throw new Error('mission_plan_intent_invalid');
    if (action.type === 'final_submit' && (
      action.autoSubmitAfterVerifiedCheckout !== true
      || !Number.isFinite(Number(action.maxPrice))
      || Number(action.maxPrice) <= 0
      || action.missionAction !== 'final_submit'
    )) throw new Error('mission_plan_final_submit_invalid');
    if (action.pendingOrderContinuation === true && (
      action.type !== 'final_submit'
      || action.priorFinalSubmitActionId !== 'submit-final-order'
      || action.chainAuthorizationActionId !== 'submit-final-order'
      || !Number.isInteger(Number(action.expectedItemCount))
      || Number(action.expectedItemCount) < 1
    )) throw new Error('mission_plan_pending_order_continuation_invalid');
    if (action.awaitMerchantOrderConfirmation === true && (
      action.type !== 'inspect'
      || action.expectedMilestone !== 'order_submitted'
      || !Number.isFinite(Number(action.merchantConfirmationTimeoutMs))
      || Number(action.merchantConfirmationTimeoutMs) < MIN_MERCHANT_ORDER_CONFIRMATION_TIMEOUT_MS
      || Number(action.merchantConfirmationTimeoutMs) > MAX_MERCHANT_ORDER_CONFIRMATION_TIMEOUT_MS
    )) throw new Error('mission_plan_merchant_confirmation_invalid');
  }
  const finalSubmitIndex = plan.actions.findIndex((action) => action.type === 'final_submit');
  if (finalSubmitIndex >= 0 && !plan.actions.slice(finalSubmitIndex + 1).some((action) => (
    action.type === 'inspect'
    && action.awaitMerchantOrderConfirmation === true
    && action.expectedMilestone === 'order_submitted'
  ))) throw new Error('mission_plan_merchant_confirmation_missing');
  const { planHash, ...unsignedPlan } = plan;
  if (await hashPlan(unsignedPlan) !== planHash) throw new Error('mission_plan_hash_invalid');
  return plan;
}

function assertLocalMissionAuthority(session = {}) {
  if (!isRunnableSession(session)) throw new Error('execution_cancelled');
  const capabilityExpiry = Date.parse(session.missionBoundAuth?.expiresAt || '');
  if (!Number.isFinite(capabilityExpiry) || capabilityExpiry <= Date.now()) {
    throw new Error('mission_capability_expired');
  }
  if (!session.missionBoundAuth?.capabilityId || !session.missionBoundAuth?.tokenHash) {
    throw new Error('mission_capability_missing');
  }
  return session;
}

function normalizeFinalSubmitAuthorityLease(lease = null) {
  const sessionId = String(lease?.sessionId || '').trim();
  const planHash = String(lease?.planHash || '').trim();
  const actionId = String(lease?.actionId || '').trim();
  const verifiedAt = Number(lease?.verifiedAt || 0);
  if (!sessionId || !planHash || !actionId || !Number.isFinite(verifiedAt) || verifiedAt <= 0) return null;
  return { sessionId, planHash, actionId, verifiedAt };
}

function issueFinalSubmitAuthorityLease(session = {}, plan = {}, action = {}) {
  const sessionId = String(session.id || '').trim();
  const planHash = String(plan.planHash || '').trim();
  const actionId = String(action.id || '').trim();
  if (!sessionId || !planHash || !actionId || action.type !== 'final_submit') return null;
  return { sessionId, planHash, actionId, verifiedAt: Date.now() };
}

function assertFinalSubmitLocalAuthority(session = {}, lease = null, plan = {}, action = {}) {
  assertLocalMissionAuthority(session);
  const normalizedLease = normalizeFinalSubmitAuthorityLease(lease);
  if (!normalizedLease
    || normalizedLease.sessionId !== String(session.id || '').trim()
    || normalizedLease.planHash !== String(plan.planHash || '').trim()
    || normalizedLease.actionId !== String(action.id || '').trim()) {
    const error = new Error('final_submit_authority_lease_scope_mismatch');
    error.code = 'final_submit_authority_lease_scope_mismatch';
    error.finalSubmitAuthorityLease = normalizedLease;
    throw error;
  }
  const ageMs = Date.now() - normalizedLease.verifiedAt;
  if (ageMs > FINAL_SUBMIT_LOCAL_LEASE_MS) {
    const error = new Error(`final_submit_authority_lease_expired:${Math.round(ageMs)}`);
    error.code = 'final_submit_authority_lease_expired';
    error.finalSubmitLeaseAgeMs = ageMs;
    error.finalSubmitAuthorityLease = normalizedLease;
    throw error;
  }
  return session;
}

async function planStartUrl(session = {}) {
  return (await validatePlanForSession(session)).startUrl;
}

function isRunnableSession(session = {}) {
  const preferred = String(session.preferredExecutionAgentId || '').trim();
  const status = String(session.status || '').trim().toLowerCase();
  return session.handoffData?.kind === 'browser'
    && session.completionMode === 'agent_checkout'
    && (preferred === RUNNER_EXTENSION_PLUGIN_ID || preferred === RUNNER_EXTENSION_OWNER_AGENT_ID)
    && ['queued', 'confirmed', 'claimed', 'executing'].includes(status);
}

function isFreshPendingSiteMission(session = {}) {
  if (!isRunnableSession(session)) return false;
  const status = String(session.status || '').trim().toLowerCase();
  const liveState = String(session.executionLive?.state || '').trim().toLowerCase();
  if (['claimed', 'executing'].includes(status) && liveState !== 'permission_required') return false;
  const requestedAt = Date.parse(
    session.executionLive?.createdAt
    || session.executionRequestedAt
    || session.confirmedAt
    || ''
  );
  const ageMs = Date.now() - requestedAt;
  return Number.isFinite(requestedAt) && ageMs >= 0 && ageMs <= PENDING_SITE_MISSION_MAX_AGE_MS;
}

async function getConfig() {
  return chrome.storage.local.get({
    runtimeMode: 'v0.2-legacy',
    baseUrl: DEFAULT_BASE_URL,
    deviceToken: '',
    deviceId: '',
    tokenLast4: '',
    expiresAt: '',
    pluginId: RUNNER_EXTENSION_PLUGIN_ID,
    ownerAgentId: RUNNER_EXTENSION_OWNER_AGENT_ID,
    extensionId: '',
    extensionVersion: '',
    holderPublicJwk: null,
    holderPrivateJwk: null,
    lastPollAt: '',
    lastError: '',
    lastExecution: null,
    activeSessionId: '',
    activeRun: null,
    activeMissionTabs: {},
    pendingPaymentWaits: {},
    finalOrderDispatches: {},
    useExistingBrowser: false,
    pairedAt: ''
  });
}

async function saveConfig(patch = {}) {
  await chrome.storage.local.set(patch);
  return getConfig();
}

function compactFinalOrderDispatchReceipt(receipt = {}) {
  if (!receipt || receipt.kind !== 'final_order' || receipt.phase !== 'click_dispatched') return null;
  const actionId = String(receipt.actionId || '').slice(0, 96);
  const receiptScope = String(receipt.receiptScope || '').slice(0, 192);
  if (!actionId || !receiptScope) return null;
  return {
    actionId,
    actionType: String(receipt.actionType || '').slice(0, 64),
    intent: String(receipt.intent || '').slice(0, 64),
    receiptScope,
    kind: 'final_order',
    phase: 'click_dispatched',
    controlTag: String(receipt.controlTag || '').slice(0, 32),
    controlType: String(receipt.controlType || '').slice(0, 32),
    path: String(receipt.path || '').slice(0, 240),
    at: receipt.at || new Date().toISOString()
  };
}

function mergeBrowserActionReceipts(...receiptLists) {
  const receiptsByIdentity = new Map();
  for (const receipt of receiptLists.flat()) {
    if (!receipt || typeof receipt !== 'object' || !receipt.kind || !receipt.at) continue;
    const identity = [
      receipt.actionId || '',
      receipt.receiptScope || '',
      receipt.kind || '',
      receipt.phase || '',
      receipt.at || ''
    ].join('|');
    receiptsByIdentity.set(identity, receipt);
  }
  return [...receiptsByIdentity.values()]
    .sort((left, right) => String(left.at || '').localeCompare(String(right.at || '')))
    .slice(-24);
}

async function saveFinalOrderDispatchReceipt(tabId, receipt) {
  const normalizedTabId = Number(tabId || 0);
  const compactReceipt = compactFinalOrderDispatchReceipt(receipt);
  if (!normalizedTabId || !compactReceipt) return { saved: false };
  const config = await getConfig();
  const dispatches = config.finalOrderDispatches && typeof config.finalOrderDispatches === 'object'
    ? { ...config.finalOrderDispatches }
    : {};
  const tabKey = String(normalizedTabId);
  const existing = Array.isArray(dispatches[tabKey])
    ? dispatches[tabKey]
    : dispatches[tabKey]
      ? [dispatches[tabKey]]
      : [];
  dispatches[tabKey] = [...existing.filter((entry) => entry?.receiptScope !== compactReceipt.receiptScope), compactReceipt].slice(-8);
  await saveConfig({ finalOrderDispatches: dispatches });
  return { saved: true, receipt: compactReceipt };
}

async function finalOrderDispatchReceiptFor(tabId, receiptScope = '') {
  const config = await getConfig();
  const stored = config.finalOrderDispatches?.[String(Number(tabId || 0))] || null;
  const receipts = Array.isArray(stored) ? stored : stored ? [stored] : [];
  return receipts.find((receipt) => receipt?.receiptScope === String(receiptScope || '')) || null;
}

function normalizeActiveRunCartEvidence(evidence = null) {
  if (!evidence || typeof evidence !== 'object') return null;
  const sessionId = String(evidence.sessionId || '').trim();
  const planHash = String(evidence.planHash || '').trim();
  const asin = String(evidence.asin || '').trim().slice(0, 32);
  const title = String(evidence.title || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  const price = Number(evidence.price);
  const quantity = Number(evidence.quantity);
  if (!sessionId || !planHash || (!asin && !title) || !Number.isInteger(quantity) || quantity < 1) return null;
  return {
    sessionId,
    planHash,
    asin: asin || null,
    title: title || null,
    price: Number.isFinite(price) && price > 0 ? price : null,
    quantity,
    verifiedAt: String(evidence.verifiedAt || '').slice(0, 48) || null
  };
}

function normalizeActiveRunCandidate(candidate = null) {
  if (!candidate || typeof candidate !== 'object') return null;
  const title = String(candidate.title || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  const asin = String(candidate.asin || '').trim().slice(0, 32);
  const price = Number(candidate.price);
  if (!title && !asin) return null;
  return {
    title: title || null,
    asin: asin || null,
    price: Number.isFinite(price) && price > 0 ? price : null
  };
}

function normalizedProductIdentityText(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function verifiedCartEvidenceFor(report = {}, candidate = null, session = {}, plan = {}) {
  if (!candidate || report?.checkoutSummary?.stage !== 'cart') return null;
  const summary = report.checkoutSummary || {};
  if (Number(summary.cartItemCount) !== 1) return null;
  const items = Array.isArray(summary.cartItems) ? summary.cartItems : [];
  if (items.length !== 1) return null;
  const item = items[0] || {};
  const candidateAsin = String(candidate.asin || '').trim();
  const itemAsin = String(item.asin || '').trim();
  const candidateTitle = normalizedProductIdentityText(candidate.title || '');
  const itemTitle = normalizedProductIdentityText(item.title || '');
  const identityMatches = candidateAsin && itemAsin
    ? candidateAsin === itemAsin
    : Boolean(candidateTitle && itemTitle && candidateTitle === itemTitle);
  if (!identityMatches) return null;
  const candidatePrice = Number(candidate.price);
  const itemPrice = Number(item.price);
  if (Number.isFinite(candidatePrice) && candidatePrice > 0
    && Number.isFinite(itemPrice) && itemPrice > 0
    && Math.abs(candidatePrice - itemPrice) > 0.005) return null;
  const quantity = Number.isInteger(Number(item.quantity)) && Number(item.quantity) > 0
    ? Number(item.quantity)
    : Number(summary.cartItemCount);
  if (quantity !== 1) return null;
  return normalizeActiveRunCartEvidence({
    sessionId: session.id,
    planHash: plan.planHash,
    asin: candidateAsin || itemAsin,
    title: item.title || candidate.title,
    price: Number.isFinite(itemPrice) && itemPrice > 0 ? itemPrice : candidatePrice,
    quantity,
    verifiedAt: new Date().toISOString()
  });
}

function normalizeActiveRunEvidenceLabels(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 96))
    .filter(Boolean))].slice(0, 32);
}

function normalizeActiveRun(entry = null) {
  const sessionId = String(entry?.sessionId || '').trim();
  if (!sessionId) return null;
  return {
    sessionId,
    planHash: String(entry?.planHash || '').trim() || null,
    phase: String(entry?.phase || 'claimed').trim() || 'claimed',
    progressLabel: String(entry?.progressLabel || '').replace(/\s+/g, ' ').trim().slice(0, 120) || null,
    progressState: String(entry?.progressState || '').trim().slice(0, 64) || null,
    progressSequence: Math.max(0, Number(entry?.progressSequence || 0) || 0),
    progressUpdatedAt: String(entry?.progressUpdatedAt || '').trim().slice(0, 48) || null,
    startupTiming: entry?.startupTiming && typeof entry.startupTiming === 'object'
      ? Object.fromEntries(Object.entries(entry.startupTiming)
          .filter(([key, value]) => /^[a-z][a-zA-Z0-9]{0,63}$/.test(key)
            && (typeof value === 'string' || Number.isFinite(Number(value))))
          .slice(0, 24))
      : null,
    tabId: Number(entry?.tabId || 0) || null,
    actionId: String(entry?.actionId || '').trim() || null,
    actionIndex: Number.isInteger(Number(entry?.actionIndex)) ? Number(entry.actionIndex) : null,
    nextActionIndex: Number.isInteger(Number(entry?.nextActionIndex)) ? Number(entry.nextActionIndex) : null,
    selectedCandidate: normalizeActiveRunCandidate(entry?.selectedCandidate),
    cartEvidence: normalizeActiveRunCartEvidence(entry?.cartEvidence),
    safeFieldsFilled: normalizeActiveRunEvidenceLabels(entry?.safeFieldsFilled),
    checkoutSelections: normalizeActiveRunEvidenceLabels(entry?.checkoutSelections),
    waitExpiresAt: String(entry?.waitExpiresAt || '').trim() || null,
    merchantConfirmationStartedAt: String(entry?.merchantConfirmationStartedAt || '').trim() || null,
    merchantConfirmationDeadlineAt: String(entry?.merchantConfirmationDeadlineAt || '').trim() || null,
    merchantConfirmationAttempts: Math.max(0, Number(entry?.merchantConfirmationAttempts || 0) || 0),
    finalSubmitAuthorityLease: normalizeFinalSubmitAuthorityLease(entry?.finalSubmitAuthorityLease),
    workerId: String(entry?.workerId || '').trim() || null,
    workerStartedAt: String(entry?.workerStartedAt || '').trim() || null,
    lastAwaitedOperation: entry?.lastAwaitedOperation && typeof entry.lastAwaitedOperation === 'object'
      ? {
          kind: String(entry.lastAwaitedOperation.kind || '').slice(0, 64),
          target: String(entry.lastAwaitedOperation.target || '').slice(0, 240),
          status: String(entry.lastAwaitedOperation.status || '').slice(0, 32),
          workerId: String(entry.lastAwaitedOperation.workerId || '').slice(0, 96),
          startedAt: String(entry.lastAwaitedOperation.startedAt || '').slice(0, 48),
          updatedAt: String(entry.lastAwaitedOperation.updatedAt || '').slice(0, 48),
          error: String(entry.lastAwaitedOperation.error || '').slice(0, 240) || null
        }
      : null,
    startedAt: String(entry?.startedAt || '').trim() || new Date().toISOString(),
    updatedAt: String(entry?.updatedAt || '').trim() || new Date().toISOString()
  };
}

async function getActiveRun() {
  const config = await getConfig();
  return normalizeActiveRun(config.activeRun) || normalizeActiveRun({ sessionId: config.activeSessionId });
}

async function saveActiveRun(patch = {}) {
  const config = await getConfig();
  const current = normalizeActiveRun(config.activeRun);
  const sessionId = String(patch.sessionId || current?.sessionId || '').trim();
  if (!sessionId) throw new Error('active_run_session_required');
  const now = new Date().toISOString();
  const progressChanged = patch.progressLabel !== undefined || patch.progressState !== undefined;
  const activeRun = normalizeActiveRun({
    ...(current?.sessionId === sessionId ? current : {}),
    ...patch,
    sessionId,
    workerId: RUNNER_WORKER_ID,
    workerStartedAt: RUNNER_WORKER_STARTED_AT,
    progressSequence: progressChanged ? Number(current?.progressSequence || 0) + 1 : current?.progressSequence,
    progressUpdatedAt: progressChanged ? now : current?.progressUpdatedAt,
    startedAt: patch.startedAt || (current?.sessionId === sessionId ? current.startedAt : now),
    updatedAt: now
  });
  await saveConfig({ activeSessionId: sessionId, activeRun });
  return activeRun;
}

async function recordAwaitedOperation(kind, target, status, { startedAt = '', error = '' } = {}) {
  const activeRun = await getActiveRun();
  if (!activeRun?.sessionId) return null;
  if (kind === 'control_plane_request'
    && !String(target || '').includes(`/connectors/sessions/${encodeURIComponent(activeRun.sessionId)}`)) {
    return null;
  }
  const now = new Date().toISOString();
  return saveActiveRun({
    lastAwaitedOperation: {
      kind,
      target,
      status,
      workerId: RUNNER_WORKER_ID,
      startedAt: startedAt || now,
      updatedAt: now,
      error
    }
  });
}

async function clearActiveRun(sessionId = '') {
  const config = await getConfig();
  const activeRun = normalizeActiveRun(config.activeRun);
  const requestedId = String(sessionId || '').trim();
  const activeId = String(activeRun?.sessionId || config.activeSessionId || '').trim();
  if (requestedId && activeId && requestedId !== activeId) return false;
  await saveConfig({ activeSessionId: '', activeRun: null });
  return true;
}

function normalizeLocalCheckoutProfile(profile = {}) {
  const value = (key, limit) => String(profile?.[key] || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  const streetAddress = value('streetAddress', 240) || value('shippingStreetAddress', 240);
  const shippingCity = value('shippingCity', 120);
  const shippingState = value('shippingState', 80);
  const zipCode = value('zipCode', 24) || value('shippingZipCode', 24);
  const billingStreetAddress = value('billingStreetAddress', 240) || (profile?.billingSameAsShipping ? streetAddress : '');
  const billingCity = value('billingCity', 120) || (profile?.billingSameAsShipping ? shippingCity : '');
  const billingState = value('billingState', 80) || (profile?.billingSameAsShipping ? shippingState : '');
  const billingZipCode = value('billingZipCode', 24) || value('paymentBillingZip', 24) || (profile?.billingSameAsShipping ? zipCode : '');
  return {
    contactName: value('contactName', 120),
    contactEmail: value('contactEmail', 254),
    contactPhone: value('contactPhone', 48),
    streetAddress,
    zipCode,
    shippingStreetAddress: streetAddress,
    shippingZipCode: zipCode,
    shippingCity,
    shippingState,
    shippingContactName: value('shippingContactName', 120) || value('contactName', 120),
    billingStreetAddress,
    billingCity,
    billingState,
    billingZipCode,
    billingContactName: value('billingContactName', 120) || value('contactName', 120),
    billingSameAsShipping: Boolean(profile?.billingSameAsShipping || (billingStreetAddress && billingStreetAddress === streetAddress && billingZipCode === zipCode)),
    deliveryNotes: value('deliveryNotes', 300),
    paymentCardLabel: value('paymentCardLabel', 100),
    paymentCardLast4: value('paymentCardLast4', 4).replace(/\D/g, '').slice(-4)
  };
}

function localCheckoutProfileStore() {
  const store = chrome.storage?.session;
  if (!store?.get || !store?.set || !store?.remove) {
    throw new Error('local_profile_session_storage_unavailable');
  }
  return store;
}

async function readLocalCheckoutProfiles() {
  const store = localCheckoutProfileStore();
  const stored = await store.get({ [LOCAL_CHECKOUT_PROFILE_STORAGE_KEY]: {} });
  const profiles = { ...(stored?.[LOCAL_CHECKOUT_PROFILE_STORAGE_KEY] || {}) };
  if (Object.keys(profiles).length) return { store, profiles };
  // Older releases retained vault-derived checkout data in persistent local
  // storage. Do not revive it across the upgrade: a fresh, session-bound
  // vault handoff is required before another checkout can use those details.
  await chrome.storage.local.remove('localCheckoutProfiles').catch(() => null);
  return { store, profiles };
}

async function writeLocalCheckoutProfiles(store, profiles = {}) {
  await store.set({ [LOCAL_CHECKOUT_PROFILE_STORAGE_KEY]: profiles });
}

async function purgeLegacyLocalCheckoutProfiles() {
  // Older releases kept private checkout cues in persistent local storage.
  // Never migrate them: a fresh vault handoff is required after this upgrade.
  await chrome.storage.local.remove('localCheckoutProfiles').catch(() => null);
}

async function setLocalCheckoutProfile({ sessionId = '', profile = {}, planHash = '' } = {}, sender = null) {
  const config = await getConfig();
  const senderOrigin = String(sender?.origin || '').replace(/\/+$/, '');
  if (!config.deviceToken || senderOrigin !== normalizeBaseUrl(config.baseUrl)) throw new Error('local_profile_origin_not_allowed');
  const id = String(sessionId || '').trim().slice(0, 160);
  if (!id) throw new Error('local_profile_session_required');
  const now = new Date().toISOString();
  const normalized = normalizeLocalCheckoutProfile(profile);
  if (!Object.values(normalized).some((entry) => typeof entry === 'string' && entry.trim())) throw new Error('local_profile_empty');
  const { store, profiles: localCheckoutProfiles } = await readLocalCheckoutProfiles();
  localCheckoutProfiles[id] = {
    profile: normalized,
    planHash: String(planHash || '').trim() || null,
    createdAt: localCheckoutProfiles[id]?.createdAt || now,
    updatedAt: now
  };
  const retainedEntries = Object.entries(localCheckoutProfiles)
    .sort(([, left], [, right]) => String(right?.updatedAt || '').localeCompare(String(left?.updatedAt || '')))
    .slice(0, 2);
  const retainedProfiles = Object.fromEntries(retainedEntries);
  await writeLocalCheckoutProfiles(store, retainedProfiles);
  await purgeLegacyLocalCheckoutProfiles();
  return { stored: true, sessionId: id, planHash: String(planHash || '').trim() || null };
}

async function bindLocalCheckoutProfileToPlan(sessionId = '', planHash = '') {
  const id = String(sessionId || '').trim();
  const expectedPlanHash = String(planHash || '').trim();
  if (!id || !expectedPlanHash) return null;
  const { store, profiles: localCheckoutProfiles } = await readLocalCheckoutProfiles();
  const entry = localCheckoutProfiles[id];
  if (!entry?.profile) return null;
  // A recovery plan may be newly signed for this same session after a manual
  // stop. Rebind the volatile profile only after the replacement plan passed
  // validatePlanForSession; never carry it across sessions.
  localCheckoutProfiles[id] = {
    ...entry,
    planHash: expectedPlanHash,
    updatedAt: new Date().toISOString()
  };
  await writeLocalCheckoutProfiles(store, localCheckoutProfiles);
  return normalizeLocalCheckoutProfile(entry.profile);
}

async function getLocalCheckoutProfile(sessionId = '', planHash = '') {
  const { profiles: localCheckoutProfiles } = await readLocalCheckoutProfiles();
  const id = String(sessionId || '').trim();
  const expectedPlanHash = String(planHash || '').trim();
  const entry = localCheckoutProfiles[id];
  if (!entry) return null;
  if (expectedPlanHash && entry.planHash && entry.planHash !== expectedPlanHash) return null;
  return normalizeLocalCheckoutProfile(entry.profile || {});
}

async function clearLocalCheckoutProfile(sessionId = '') {
  const { store, profiles: localCheckoutProfiles } = await readLocalCheckoutProfiles();
  const id = String(sessionId || '');
  if (!localCheckoutProfiles[id]) return;
  delete localCheckoutProfiles[id];
  if (Object.keys(localCheckoutProfiles).length) await writeLocalCheckoutProfiles(store, localCheckoutProfiles);
  else await store.remove(LOCAL_CHECKOUT_PROFILE_STORAGE_KEY);
}

async function getPendingPaymentWait(sessionId = '') {
  const config = await getConfig();
  return config.pendingPaymentWaits?.[String(sessionId || '')] || null;
}

async function setPendingPaymentWait(sessionId = '', entry = null) {
  const config = await getConfig();
  const pendingPaymentWaits = { ...(config.pendingPaymentWaits || {}) };
  const id = String(sessionId || '');
  if (!id) return null;
  if (entry) pendingPaymentWaits[id] = entry;
  else delete pendingPaymentWaits[id];
  for (const [staleId] of Object.entries(pendingPaymentWaits).slice(0, -2)) delete pendingPaymentWaits[staleId];
  await saveConfig({ pendingPaymentWaits });
  return entry;
}

async function clearPendingPaymentWait(sessionId = '') {
  return setPendingPaymentWait(sessionId, null);
}

async function readBoundedApiResponse(response, maxBytes = null) {
  if (!Number.isFinite(Number(maxBytes)) || Number(maxBytes) <= 0) return response.text();
  const limit = Number(maxBytes);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new Error('runner_api_response_too_large');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > limit) throw new Error('runner_api_response_too_large');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new Error('runner_api_response_too_large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function api(path, { method = 'GET', body = null, bearer = '', timeoutMs = API_TIMEOUT_MS, maxResponseBytes = null } = {}) {
  const config = await getConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let text = '';
  const operationStartedAt = new Date().toISOString();
  await recordAwaitedOperation('control_plane_request', `${method} ${path}`, 'started', { startedAt: operationStartedAt }).catch(() => null);
  try {
    response = await fetch(`${normalizeBaseUrl(config.baseUrl)}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        'x-magic-city-runner-surface': 'chrome-extension',
        'x-magic-city-runner-protocol': RUNNER_PROTOCOL,
        'x-magic-city-runner-extension-id': chrome.runtime.id || '',
        'x-magic-city-runner-extension-version': chrome.runtime.getManifest().version,
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    // Keep the deadline active through the response body. Headers alone do
    // not complete a control-plane request and a stalled body must not strand
    // an active browser mission indefinitely.
    text = await readBoundedApiResponse(response, maxResponseBytes);
  } catch (error) {
    await recordAwaitedOperation('control_plane_request', `${method} ${path}`, 'failed', {
      startedAt: operationStartedAt,
      error: error?.message || String(error)
    }).catch(() => null);
    if (error?.name === 'AbortError') {
      const timeoutError = new Error(`runner_api_timeout:${path}`);
      timeoutError.retryable = true;
      throw timeoutError;
    }
    if (error && typeof error === 'object') error.retryable = true;
    throw error;
  } finally {
    clearTimeout(timer);
  }
  await recordAwaitedOperation('control_plane_request', `${method} ${path}`, 'completed', { startedAt: operationStartedAt }).catch(() => null);
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`invalid_json_response:${path}`);
  }
  if (!response.ok) {
    const requestError = new Error(data.error || `request_failed_${response.status}`);
    requestError.status = response.status;
    requestError.retryable = [408, 425, 429, 500, 502, 503, 504].includes(response.status);
    throw requestError;
  }
  return data;
}

function isTransientControlPlaneError(error) {
  if (error?.retryable === true) return true;
  const message = String(error?.message || error || '').trim().toLowerCase();
  return error?.name === 'TypeError'
    || /failed to fetch|networkerror|network error|load failed|runner_api_timeout|request_failed_(?:408|425|429|500|502|503|504)/.test(message);
}

function isRetryableBrowserRuntimeError(error) {
  if (error?.retryableBrowserRuntime === true) return true;
  const message = String(error?.message || error || '').trim().toLowerCase();
  return /browser_(?:navigation|script_injection|content_script|tab_read|tab_unavailable|url_change)_|execution context was destroyed|failed to fetch|message channel closed|receiving end does not exist/.test(message);
}

async function retryTransientControlPlane(task) {
  let lastError = null;
  for (let attempt = 0; attempt <= TRANSIENT_CONTROL_PLANE_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      if (!isTransientControlPlaneError(error) || attempt >= TRANSIENT_CONTROL_PLANE_RETRY_DELAYS_MS.length) throw error;
      await delay(TRANSIENT_CONTROL_PLANE_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError || new Error('runner_control_plane_unavailable');
}

function scheduleRunnerResume(delayMs = RUNNER_CONTINUATION_DELAY_MS) {
  // Installed MV3 extensions clamp short alarms to roughly 30 seconds. This
  // alarm is crash recovery only; the live external port owns normal forward
  // progress for a user-started mission.
  void chrome.alarms.create(RESUME_ALARM, {
    when: Date.now() + Math.max(30_000, Number(delayMs) || RUNNER_CONTINUATION_DELAY_MS)
  }).catch(() => {});
}

function isExecutionCancelledError(error) {
  return String(error?.message || error || '').trim().toLowerCase() === 'execution_cancelled';
}

function isFinalSubmitPolicyError(error) {
  const message = String(error?.message || error || '').trim().toLowerCase();
  const code = String(error?.code || '').trim().toLowerCase();
  return code.startsWith('final_submit_')
    || message.startsWith('final_submit_')
    || message.startsWith('mission_final_submit_')
    || message === 'mission_action_requires_user_approval';
}

async function extensionHostPermissions() {
  const permissions = await chrome.permissions.getAll();
  return (permissions.origins || []).filter((origin) => origin.startsWith('https://'));
}

async function ensureHolderKey() {
  const config = await getConfig();
  if (config.holderPublicJwk && config.holderPrivateJwk) return config;
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const holderPublicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const holderPrivateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return saveConfig({ holderPublicJwk, holderPrivateJwk });
}

async function buildProofOfPossession(session, { action, targetUrl }) {
  const config = await ensureHolderKey();
  const capability = session.missionBoundAuth || {};
  if (!capability.capabilityId || !capability.tokenHash) return null;
  const nonce = randomNonce();
  const signingInput = stableJson({
    schema: 'magic-city-mission-pop-v1',
    capabilityId: capability.capabilityId,
    capabilityHash: capability.tokenHash,
    action: normalizeMissionAction(action),
    targetDomain: domainForUrl(targetUrl),
    nonce,
    previousHash: session.missionBoundaryLatestHash || null,
    audience: capability.audience || null,
    sessionId: capability.subject?.sessionId || session.id || null
  });
  const privateKey = await crypto.subtle.importKey('jwk', config.holderPrivateJwk, { name: 'Ed25519' }, false, ['sign']);
  const signature = await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(signingInput));
  return {
    nonce,
    previousHash: session.missionBoundaryLatestHash || null,
    publicKeyJwk: config.holderPublicJwk,
    signature: base64Url(signature)
  };
}

async function registerExecutor(config = null) {
  const current = config || await getConfig();
  if (!current.deviceToken) throw new Error('runner_not_paired');
  const origins = await extensionHostPermissions();
  const registrationKey = stableJson({
    baseUrl: normalizeBaseUrl(current.baseUrl),
    deviceId: current.deviceId || '',
    deviceToken: current.deviceToken,
    extensionId: chrome.runtime.id || '',
    extensionVersion: chrome.runtime.getManifest().version,
    origins: [...origins].sort()
  });
  if (executorRegistrationCache?.key === registrationKey
    && executorRegistrationCache.validUntil > Date.now()) {
    return { ...executorRegistrationCache.result, registrationReused: true };
  }
  if (executorRegistrationInFlight?.key === registrationKey) {
    return executorRegistrationInFlight.promise;
  }
  const registrationPromise = api('/plugins/register', {
    method: 'POST',
    bearer: current.deviceToken,
    body: {
      pluginId: RUNNER_EXTENSION_PLUGIN_ID,
      ownerAgentId: RUNNER_EXTENSION_OWNER_AGENT_ID,
      kind: 'browser',
      endpoint: `chrome-extension://${chrome.runtime.id || 'magic-city-runner'}`,
      executionAgent: true,
      capabilities: [
        'browser-worker-agent',
        'browser.extension_dom_executor',
        'browser.local_authenticated_profile',
        'browser.prepare_cart',
        'browser.open_checkout',
        'browser.pause_before_sensitive_action'
      ],
      tools: [
        'browser.open_local_profile',
        'browser.inspect',
        'browser.select_product',
        'browser.prepare_cart',
        'browser.open_checkout',
        'browser.pause_before_final_approval'
      ],
      privacyModes: ['local-private', 'private'],
      helperAgents: ['site-navigator', 'cart-prepper', 'handoff-recorder'],
      metadata: {
        runnerSurface: 'chrome_extension_executor',
        extensionOnly: true,
        extensionExecutor: true,
        executionBackend: 'extension_dom_executor',
        browserPermissionReady: origins.length > 0,
        browserPermissionOrigins: origins,
        rawCredentialsAccess: false,
        rawPaymentAccess: false,
        finalSubmitEnabled: true,
        extensionId: chrome.runtime.id || null,
        version: chrome.runtime.getManifest().version
      }
    }
  });
  executorRegistrationInFlight = { key: registrationKey, promise: registrationPromise };
  try {
    const result = await registrationPromise;
    executorRegistrationCache = {
      key: registrationKey,
      result,
      validUntil: Date.now() + EXECUTOR_REGISTRATION_REUSE_MS
    };
    return result;
  } finally {
    if (executorRegistrationInFlight?.promise === registrationPromise) executorRegistrationInFlight = null;
  }
}

function invalidateExecutorRegistration() {
  executorRegistrationCache = null;
  executorRegistrationInFlight = null;
}

async function pollSessions() {
  const config = await getConfig();
  if (!config.deviceToken) return { paired: false, sessions: [], actionableCount: 0 };
  const data = await api('/connectors/sessions', { bearer: config.deviceToken });
  await saveConfig({ lastPollAt: new Date().toISOString(), lastError: '' });
  return {
    paired: true,
    sessions: Array.isArray(data.sessions) ? data.sessions : [],
    actionableCount: Number(data.actionableCount || data.sessions?.length || 0) || 0
  };
}

async function hasPermissionForUrl(targetUrl = '') {
  const origin = domainPermissionPattern(targetUrl);
  return Boolean(origin && await chrome.permissions.contains({ origins: [origin] }));
}

// Amazon keeps non-critical page resources open long after the result DOM is
// inspectable. Do not make every navigation wait on those resources; the
// bounded state-read retries below remain the readiness check that matters.
async function waitForTabReady(tabId, timeoutMs = 8000) {
  const current = await chrome.tabs.get(tabId);
  if (current.status === 'complete') return current;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdate);
      reject(new Error('browser_navigation_timeout'));
    }, timeoutMs);
    function onUpdate(updatedTabId, changeInfo, tab) {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdate);
      resolve(tab);
    }
    chrome.tabs.onUpdated.addListener(onUpdate);
  });
}

function waitForTabNavigation(tabId, previousUrl = '', timeoutMs = 3500) {
  let cancel;
  const promise = new Promise((resolve, reject) => {
    let settled = false;
    let navigationStarted = false;
    const finish = (error, tab = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdate);
      if (error) reject(error);
      else resolve(tab);
    };
    const timer = setTimeout(() => finish(new Error('browser_navigation_timeout')), timeoutMs);
    cancel = () => finish(new Error('browser_navigation_cancelled'));
    function onUpdate(updatedTabId, changeInfo, tab) {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === 'loading' || changeInfo.url || tab.url !== previousUrl) navigationStarted = true;
      if (!navigationStarted || changeInfo.status !== 'complete') return;
      finish(null, tab);
    }

    // Register before the tab update. Chrome can emit loading and complete in
    // the same task for warm/cached pages, and missing that window creates a
    // false browser_navigation_timeout.
    chrome.tabs.onUpdated.addListener(onUpdate);
    void chrome.tabs.get(tabId).then((current) => {
      if (settled) return;
      if (current.url !== previousUrl) navigationStarted = true;
      if (navigationStarted && current.status === 'complete') finish(null, current);
    }).catch((error) => finish(error));
  });
  promise.cancel = () => cancel?.();
  return promise;
}

function normalizeNavigationUrl(rawUrl = '') {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    parsed.hash = '';
    parsed.pathname = parsed.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
    parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return String(rawUrl || '').trim();
  }
}

function navigationTargetMatches(currentUrl = '', targetUrl = '') {
  const current = normalizeNavigationUrl(currentUrl);
  const target = normalizeNavigationUrl(targetUrl);
  return Boolean(current && target && current === target);
}

function isRetryableNavigationError(error = null) {
  return /browser_navigation_(?:start_timeout|timeout|unconfirmed)/i.test(String(error?.message || error || ''));
}

async function navigateMissionTab(tabId, targetUrl, { timeoutMs = 8_000, timeoutLabel = 'browser_navigation_timeout' } = {}) {
  const operationStartedAt = new Date().toISOString();
  await recordAwaitedOperation('navigation', targetUrl, 'started', { startedAt: operationStartedAt }).catch(() => null);
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await chrome.tabs.get(tabId);
    const beforeUrl = String(before?.url || '');
    // Reusing a mission tab is normal. Opening the already-approved target is
    // an idempotent success, not a navigation failure.
    if (navigationTargetMatches(beforeUrl, targetUrl)) {
      await recordAwaitedOperation('navigation', targetUrl, 'completed', { startedAt: operationStartedAt }).catch(() => null);
      return before;
    }

    const navigation = waitForTabNavigation(tabId, beforeUrl, timeoutMs);
    try {
      const updatedTab = await withTimeout(
        () => chrome.tabs.update(tabId, { url: targetUrl, active: false }),
        TAB_COMMAND_TIMEOUT_MS,
        'browser_navigation_start_timeout'
      );
      let current = await navigation;
      current = await chrome.tabs.get(tabId).catch(() => current || updatedTab);
      const currentUrl = String(current?.url || '');
      if (!currentUrl || currentUrl === 'about:blank') throw new Error('browser_navigation_unconfirmed');
      await recordAwaitedOperation('navigation', targetUrl, 'completed', { startedAt: operationStartedAt }).catch(() => null);
      return current;
    } catch (error) {
      lastError = error;
      navigation.cancel?.();
      const observed = await chrome.tabs.get(tabId).catch(() => null);
      if (observed?.url && observed.url !== 'about:blank' && navigationTargetMatches(observed.url, targetUrl)) {
        await recordAwaitedOperation('navigation', targetUrl, 'completed', { startedAt: operationStartedAt }).catch(() => null);
        return observed;
      }
      if (attempt === 0 && isRetryableNavigationError(error)) {
        await delay(120);
        continue;
      }
      break;
    }
  }
  await recordAwaitedOperation('navigation', targetUrl, 'failed', {
    startedAt: operationStartedAt,
    error: lastError?.message || timeoutLabel || 'browser_navigation_timeout'
  }).catch(() => null);
  throw new Error(lastError?.message || timeoutLabel || 'browser_navigation_timeout');
}

async function waitForTabUrlChange(tabId, previousUrl = '', timeoutMs = 2500) {
  const current = await chrome.tabs.get(tabId);
  if (current.url !== previousUrl) return current;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdate);
      reject(new Error('browser_url_change_timeout'));
    }, timeoutMs);
    function onUpdate(updatedTabId, changeInfo, tab) {
      if (updatedTabId !== tabId) return;
      if (!changeInfo.url && tab.url === previousUrl) return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdate);
      resolve(tab);
    }
    chrome.tabs.onUpdated.addListener(onUpdate);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(task, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function remainingDeadlineMs(deadlineMs = 0) {
  const deadline = Number(deadlineMs || 0);
  if (!Number.isFinite(deadline) || deadline <= 0) return null;
  return Math.max(0, deadline - Date.now());
}

async function tabCommand(tabId, command, {
  injectionTimeoutMs = TAB_COMMAND_TIMEOUT_MS,
  responseTimeoutMs = TAB_COMMAND_TIMEOUT_MS,
  deadlineMs = 0
} = {}) {
  const operationTarget = `${String(command?.type || 'unknown')}:tab-${Number(tabId || 0)}`;
  const operationStartedAt = new Date().toISOString();
  await recordAwaitedOperation('tab_message', operationTarget, 'started', { startedAt: operationStartedAt }).catch(() => null);
  const remainingBeforeInjectionMs = remainingDeadlineMs(deadlineMs);
  if (remainingBeforeInjectionMs != null && remainingBeforeInjectionMs < 1) {
    throw new Error('browser_command_deadline_exceeded');
  }
  // When a caller supplies an absolute deadline, reserve enough time for the
  // content-script response instead of letting injection consume the whole
  // budget. The second timeout is recalculated after injection completes.
  const boundedInjectionTimeoutMs = remainingBeforeInjectionMs == null
    ? injectionTimeoutMs
    : Math.max(1, Math.min(injectionTimeoutMs, Math.floor(remainingBeforeInjectionMs * 0.45)));
  await withTimeout(
    () => chrome.scripting.executeScript({
      target: { tabId },
      files: [EXECUTOR_FILE],
      injectImmediately: true
    }),
    boundedInjectionTimeoutMs,
    'browser_script_injection_timeout'
  );
  const remainingBeforeResponseMs = remainingDeadlineMs(deadlineMs);
  if (remainingBeforeResponseMs != null && remainingBeforeResponseMs < 1) {
    throw new Error('browser_command_deadline_exceeded');
  }
  const boundedResponseTimeoutMs = remainingBeforeResponseMs == null
    ? responseTimeoutMs
    : Math.max(1, Math.min(responseTimeoutMs, remainingBeforeResponseMs));
  try {
    const result = await withTimeout(
      () => chrome.tabs.sendMessage(tabId, command),
      boundedResponseTimeoutMs,
      'browser_content_script_timeout'
    );
    await recordAwaitedOperation('tab_message', operationTarget, 'completed', { startedAt: operationStartedAt }).catch(() => null);
    return result;
  } catch (error) {
    await recordAwaitedOperation('tab_message', operationTarget, 'failed', {
      startedAt: operationStartedAt,
      error: error?.message || String(error)
    }).catch(() => null);
    throw error;
  }
}

async function amazonSearchCardAddToCart(tabId, action = {}) {
  const maxPrice = action.maxPrice == null || action.maxPrice === '' ? null : Number(action.maxPrice);
  const result = await withTimeout(
    () => chrome.scripting.executeScript({
      target: { tabId },
      injectImmediately: true,
      func: selectAmazonSearchCard,
      args: [{ ...action, maxPrice: Number.isFinite(maxPrice) ? maxPrice : action.maxPrice }]
    }),
    AMAZON_SEARCH_CARD_FAST_PATH_TIMEOUT_MS,
    'amazon_search_card_fast_path_timeout'
  ).catch((error) => ({
    completed: false,
    browserActionIndeterminate: true,
    reason: error?.message || String(error) || 'Amazon search-card fast path failed before returning a result.'
  }));
  if (Array.isArray(result)) return result[0]?.result || null;
  return result && typeof result === 'object' ? result : null;
}

function normalizeSelectionIntelligenceCandidate(candidate = null) {
  if (!candidate || typeof candidate !== 'object') return null;
  const id = String(candidate.id || '').trim().slice(0, 40);
  const asin = String(candidate.asin || '').trim().toUpperCase();
  const title = String(candidate.title || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  const price = candidate.price === null || candidate.price === '' || candidate.price === undefined
    ? null
    : Number(candidate.price);
  const requiresProductPageVerification = candidate.requiresProductPageVerification === true;
  const identityStatus = String(candidate.identityStatus || '').trim().toLowerCase();
  if (!/^candidate-\d{1,2}$/.test(id)
    || !/^[A-Z0-9]{10}$/.test(asin)
    || !title
    || (price !== null && (!Number.isFinite(price) || price <= 0))
    || (!requiresProductPageVerification && price === null)) return null;
  const sourcePack = candidate.packageFacts || candidate.pack || null;
  const positive = (key) => {
    if (!sourcePack || sourcePack[key] === null || sourcePack[key] === '' || sourcePack[key] === undefined) return null;
    const value = Number(sourcePack[key]);
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  const text = (key, limit) => String(sourcePack?.[key] || '').trim().slice(0, limit) || null;
  return {
    id,
    asin,
    title,
    packageFacts: sourcePack ? {
      status: text('status', 24),
      unit: text('unit', 24),
      total: positive('total'),
      per: positive('per'),
      outer: positive('outer'),
      configuration: text('configuration', 32)
    } : null,
    price,
    primeEligible: candidate.primeEligible === true,
    freeShipping: candidate.freeShipping === true,
    conditionalShipping: candidate.conditionalShipping === true,
    requiresProductPageVerification,
    identityStatus: identityStatus === 'provisional' ? 'provisional' : identityStatus === 'semantic' ? 'semantic' : 'verified',
    sponsored: false,
    hardEligible: candidate.hardEligible === true
  };
}

async function consultAmazonSelectionIntelligence(session, plan, action, quickOutcome, tabId) {
  if (session?.selectionIntelligence?.enabled !== true
    || quickOutcome?.selectionKind !== 'no_verified_candidate') return null;
  const candidates = (Array.isArray(quickOutcome.intelligenceCandidates)
    ? quickOutcome.intelligenceCandidates
    : [])
    .slice(0, Math.min(12, Number(session.selectionIntelligence.maxCandidates) || 12))
    .map(normalizeSelectionIntelligenceCandidate)
    .filter(Boolean);
  if (!candidates.length || new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) return null;
  const observationHash = await hashPlan({
    schema: 'magic-city-amazon-candidate-observation-v1',
    candidates
  });
  const requestId = await hashPlan({
    schema: 'magic-city-amazon-selection-advice-request-v1',
    sessionId: session.id,
    planHash: plan.planHash,
    actionId: action.id,
    observationHash
  });
  const config = await getConfig();
  let advice = null;
  try {
    advice = await api(`/connectors/sessions/${encodeURIComponent(session.id)}/rank-candidates`, {
      method: 'POST',
      bearer: config.deviceToken,
      timeoutMs: Math.min(3_000, Math.max(1_000, Number(session.selectionIntelligence.timeoutMs) || 3_000)),
      maxResponseBytes: 4 * 1024,
      body: {
        pluginId: RUNNER_EXTENSION_PLUGIN_ID,
        planHash: plan.planHash,
        planActionId: action.id,
        requestId,
        observationHash,
        candidates
      }
    });
  } catch {
    return null;
  }
  if (advice?.schema !== 'magic-city-amazon-selection-advice-v1'
    || advice.sessionId !== session.id
    || advice.planHash !== plan.planHash
    || advice.actionId !== action.id
    || advice.requestId !== requestId
    || advice.observationHash !== observationHash) return null;
  if (advice.decision !== 'select' || !advice.selectedCandidateId) {
    return {
      ...quickOutcome,
      intelligenceConsulted: true,
      intelligenceDecision: advice.decision || 'abstain',
      reason: String(advice.reason || quickOutcome.reason || '').slice(0, 240)
    };
  }
  const selected = candidates.find((candidate) => candidate.id === advice.selectedCandidateId);
  if (!selected) return null;
  const revalidated = await amazonSearchCardAddToCart(tabId, {
    ...action,
    intelligenceApprovedCandidate: selected
  });
  if (!revalidated || typeof revalidated !== 'object') return null;
  return {
    ...revalidated,
    intelligenceConsulted: true,
    intelligenceDecision: 'select',
    intelligenceRequestId: requestId,
    intelligenceObservationHash: observationHash
  };
}

async function completeAmazonSelectionOutcome(tabId, plan, action, outcome, checkoutProfile = null) {
  if (!outcome?.completed) return outcome;
  if (outcome.directSearchResultCart === true) {
    const cartAdvance = await advanceAmazonAddedItemToCart(tabId, checkoutProfile, amazonCartRecoveryUrl(plan));
    if (cartAdvance.advanced) {
      return {
        ...outcome,
        postAddCartOpened: true,
        cartOpenControlStrategy: cartAdvance.outcome?.controlStrategy || null,
        cartOpenAttempts: cartAdvance.attempts,
        state: cartAdvance.state || outcome.state
      };
    }
    return outcome;
  }
  if (!outcome.navigationRequested || !outcome.navigationUrl) return outcome;
  const before = await chrome.tabs.get(tabId).catch(() => ({ url: '' }));
  const navigation = await confirmCandidateNavigation(tabId, plan, outcome.navigationUrl, before.url);
  if (!navigation.confirmed) {
    return { ...outcome, completed: false, navigationConfirmed: false, reason: 'The exact selected product page did not open.' };
  }
  const selectedState = await waitForPurchasableProduct(tabId, checkoutProfile);
  if (outcome.requiresProductPageVerification !== true) {
    return {
      ...outcome,
      navigationConfirmed: true,
      observedNavigationUrl: navigation.observedUrl,
      state: selectedState
    };
  }
  const summary = selectedState?.checkoutSummary || {};
  const productIdentityVerified = amazonProductIdentityMatches(
    action.query || action.selectionBrief || '',
    summary.productTitle || '',
    summary.productPackageEvidence || ''
  );
  const selectedProductPrice = parseUsdAmount(summary.productPrice);
  const priceVerified = Number.isFinite(selectedProductPrice) && selectedProductPrice > 0;
  const priceWithinCap = priceVerified && (
    !Number.isFinite(Number(action.maxPrice))
    || Number(action.maxPrice) <= 0
    || selectedProductPrice <= Number(action.maxPrice) + 0.005
  );
  const fulfillmentVerified = action.primeRequired !== true || (
    summary.productPrimeEligible === true
    && summary.productShippingKnown === true
    && summary.productPrimeFreeShippingEligible === true
  );
  if (!productIdentityVerified || !selectedState?.addToCartAvailable || !priceWithinCap || !fulfillmentVerified) {
    const reason = !productIdentityVerified
      ? 'Amazon opened the selected product page, but its full product identity did not match the approved request.'
      : !selectedState?.addToCartAvailable
        ? 'Amazon opened the matching product page, but no verified Add to Cart control was available.'
        : !priceVerified
          ? 'Amazon opened the matching product page, but its one-time purchase price could not be verified.'
          : !priceWithinCap
            ? `The matching product costs $${selectedProductPrice.toFixed(2)}, above the approved $${Number(action.maxPrice).toFixed(2)} item budget.`
            : productFulfillmentFailureReason(selectedState, action) || 'The matching product page did not verify Prime and unconditional free delivery.';
    return {
      ...outcome,
      completed: false,
      selectionKind: 'no_verified_candidate',
      navigationConfirmed: true,
      observedNavigationUrl: navigation.observedUrl,
      state: selectedState,
      reason
    };
  }
  return {
    ...outcome,
    productPageVerified: true,
    productIdentityVerified: true,
    selected: { ...outcome.selected, price: selectedProductPrice },
    navigationConfirmed: true,
    observedNavigationUrl: navigation.observedUrl,
    state: selectedState
  };
}

async function advanceAmazonAddedItemToCart(tabId, checkoutProfile = null, cartUrl = '') {
  // Keep the result-card click and cart entry inside one local browser turn.
  // Amazon may render either an inline side cart or a full-page "Added to
  // cart" confirmation. Crossing a signed checkpoint between those two
  // controls lets MV3 suspend the worker while the obvious Go to Cart button
  // is already visible.
  await delay(120);
  const before = await chrome.tabs.get(tabId).catch(() => ({ url: '' }));
  const outcome = await tabCommand(tabId, {
    type: 'MAGIC_CITY_EXECUTE_PLAN_STEP',
    action: {
      type: 'navigate',
      intent: 'open_cart',
      preferExistingCartControl: true,
      url: cartUrl
    },
    checkoutProfile
  }, { injectionTimeoutMs: 2_500, responseTimeoutMs: 2_500 }).catch(() => null);
  if (outcome?.completed && !outcome.cartFallbackRequested) {
    if (outcome.navigationRequested && !outcome.skipped) {
      await waitForTabUrlChange(tabId, before.url, 2_000).catch(() => null);
    }
    return {
      advanced: true,
      outcome,
      state: outcome.state || null,
      attempts: 1
    };
  }
  // The URL is part of the signed open-cart plan action. When Amazon did not
  // expose an exact live cart control, navigate there immediately instead of
  // spending several command timeouts re-probing the same search page.
  const fallbackUrl = withAmazonEnglishLocale(cartUrl || 'https://www.amazon.com/gp/cart/view.html');
  const fallbackTab = await navigateMissionTab(tabId, fallbackUrl, {
    timeoutMs: 5_000,
    timeoutLabel: 'browser_cart_fallback_navigation_timeout'
  }).catch(() => null);
  if (!fallbackTab) return { advanced: false, outcome, state: null, attempts: 1 };
  return {
    advanced: true,
    outcome: {
      ...(outcome || {}),
      completed: true,
      navigationRequested: true,
      cartFallbackRequested: true,
      controlStrategy: 'stable_cart_fallback'
    },
    state: {
      url: fallbackTab.url || fallbackUrl,
      title: fallbackTab.title || '',
      browserState: 'browse',
      browserStateConfidence: 0,
      browserStateReason: 'The signed Amazon cart URL opened after no exact live cart control was available.',
      checkoutSummary: { stage: 'browse', nextAction: 'Inspecting cart' },
      navigationReady: true
    },
    attempts: 1
  };
}

async function tabBrowserState(tabId, checkoutProfile = null, {
  attempts = 5,
  delayMs = 350,
  deadlineMs = 0
} = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (remainingDeadlineMs(deadlineMs) === 0) break;
    try {
      return await tabCommand(
        tabId,
        { type: 'MAGIC_CITY_BROWSER_STATE', checkoutProfile },
        { injectionTimeoutMs: 6_000, responseTimeoutMs: 8_000, deadlineMs }
      );
    } catch (error) {
      lastError = error;
      const remainingMs = remainingDeadlineMs(deadlineMs);
      if (remainingMs === 0) break;
      await delay(remainingMs == null ? delayMs : Math.min(delayMs, remainingMs));
    }
  }
  throw lastError || new Error(deadlineMs ? 'browser_state_deadline_exceeded' : 'browser_state_unavailable');
}

async function waitForMerchantOrderConfirmation(tabId, checkoutProfile = null, assertActive = null, {
  timeoutMs = 14_000,
  intervalMs = 450
} = {}) {
  const startedAt = Date.now();
  const requestedTimeoutMs = Number(timeoutMs);
  const observationWindowMs = Number.isFinite(requestedTimeoutMs)
    ? Math.max(0, requestedTimeoutMs)
    : 14_000;
  if (observationWindowMs === 0) {
    return {
      completed: false,
      finalSubmitRequested: true,
      orderSubmitted: false,
      merchantOrderConfirmation: {
        confirmed: false,
        reason: 'merchant_confirmation_deadline_expired',
        waitMs: 0
      },
      state: null
    };
  }
  const deadline = startedAt + observationWindowMs;
  let latest = null;
  do {
    if (typeof assertActive === 'function') await assertActive();
    try {
      latest = await tabCommand(
        tabId,
        { type: 'MAGIC_CITY_BROWSER_STATE', checkoutProfile },
        {
          injectionTimeoutMs: 2_500,
          responseTimeoutMs: 3_500,
          deadlineMs: deadline
        }
      );
    } catch {
      // A merchant navigation can briefly remove the content script. Retry the
      // same signed observation; do not issue a second final-order click.
    }
    if (latest?.orderSubmitted || latest?.milestoneSignals?.orderSubmitted) {
      return {
        completed: true,
        finalSubmitRequested: true,
        orderSubmitted: true,
        merchantOrderConfirmation: {
          confirmed: true,
          observedAt: new Date().toISOString(),
          waitMs: Date.now() - startedAt
        },
        state: latest
      };
    }
    if (Date.now() < deadline) await delay(Math.min(intervalMs, Math.max(50, deadline - Date.now())));
  } while (Date.now() < deadline);
  return {
    completed: false,
    finalSubmitRequested: true,
    orderSubmitted: false,
    merchantOrderConfirmation: {
      confirmed: false,
      reason: 'merchant_confirmation_not_observed',
      waitMs: Date.now() - startedAt
    },
    state: latest
  };
}

async function waitForPurchasableProduct(tabId, checkoutProfile = null, { timeoutMs = 4_500, intervalMs = 350 } = {}) {
  const deadline = Date.now() + Math.max(1_000, Number(timeoutMs) || 4_500);
  let latest = null;
  do {
    latest = await tabBrowserState(tabId, checkoutProfile, { attempts: 2, delayMs: 180 }).catch(() => latest);
    const stage = String(latest?.checkoutSummary?.stage || latest?.browserState || '').toLowerCase();
    if (latest?.addToCartAvailable || stage === 'cart' || latest?.providerChallenge || latest?.loginRequired) return latest;
    await delay(intervalMs);
  } while (Date.now() < deadline);
  return latest;
}

async function confirmCandidateNavigation(tabId, plan = {}, candidateUrl = '', previousUrl = '') {
  const requestedUrl = plan.targetDomain === 'amazon.com'
    ? withAmazonEnglishLocale(candidateUrl)
    : String(candidateUrl || '');
  let observed = await chrome.tabs.get(tabId).catch(() => ({ url: previousUrl, status: '' }));
  const isExpectedUrl = (value = '') => {
    if (plan.targetDomain !== 'amazon.com') return domainForUrl(value) === plan.targetDomain && value !== previousUrl;
    return amazonProductUrlMatches(requestedUrl, value) && isAmazonRetailProductUrl(value);
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (isExpectedUrl(observed.url || '')) {
      return { confirmed: true, attempts: attempt, requestedUrl, observedUrl: observed.url || requestedUrl };
    }
    await navigateMissionTab(tabId, requestedUrl, { timeoutMs: 9_000 }).catch(() => null);
    await delay(450);
    observed = await chrome.tabs.get(tabId).catch(() => observed);
  }

  return {
    confirmed: isExpectedUrl(observed.url || ''),
    attempts: 2,
    requestedUrl,
    observedUrl: observed.url || previousUrl || ''
  };
}

async function recoverAmazonCheckoutPrelude(tabId, plan = {}, outcome = {}) {
  const currentTab = await chrome.tabs.get(tabId).catch(() => null);
  if (!isAmazonCheckoutPreludeUrl(currentTab?.url || '', plan)) return outcome;
  const recoveryUrl = amazonCheckoutPreludeRecoveryUrl(currentTab.url);
  await navigateMissionTab(tabId, recoveryUrl, { timeoutMs: 5_000 }).catch(() => null);
  await delay(300);
  return {
    ...(outcome || {}),
    navigationRequested: true,
    checkoutPreludeRecovered: true,
    checkoutPreludeRecoveryUrl: recoveryUrl,
    observedNavigationUrl: recoveryUrl
  };
}

async function missionCheckpoint(session, { label, detail, state, missionAction, targetUrl, browser = null, plan = null, planAction = null, planActionStatus = 'completed', runnerTiming = null }) {
  const config = await getConfig();
  const checkpointRequestedAt = new Date().toISOString();
  const proofOfPossession = await buildProofOfPossession(session, { action: missionAction, targetUrl });
  const data = await api(`/connectors/sessions/${encodeURIComponent(session.id)}/checkpoint`, {
    method: 'POST',
    bearer: config.deviceToken,
    body: {
      pluginId: RUNNER_EXTENSION_PLUGIN_ID,
      label,
      detail,
      state,
      missionAction: normalizeMissionAction(missionAction),
      targetUrl,
      ...(browser ? { browser } : {}),
      runnerTiming: {
        workerStartedAt: RUNNER_WORKER_STARTED_AT,
        checkpointRequestedAt,
        ...(runnerTiming && typeof runnerTiming === 'object' ? runnerTiming : {})
      },
      ...(plan ? { planHash: plan.planHash } : {}),
      ...(planAction ? {
        planActionId: planAction.id,
        planActionStatus,
        milestoneProtocol: 'verified-v1',
        verifiedMilestones: Array.isArray(browser?.verifiedMilestones) ? browser.verifiedMilestones : []
      } : {}),
      ...(planAction?.type === 'final_submit' ? { userApproved: true } : {}),
      proofOfPossession
    }
  });
  // Persisted plan progress is authoritative. Arm the continuation only after
  // that checkpoint lands, so an MV3 restart resumes the next signed action.
  scheduleRunnerResume();
  return data.session || session;
}

async function checkpointRunnerStartup(session, plan, nextAction, startupTiming = null) {
  // This is deliberately non-advancing. It closes the MV3 gap between a
  // successful server-side claim and the first browser operation, while the
  // signed open-site action remains the next action to execute.
  return missionCheckpoint(session, {
    label: 'Opening browser',
    detail: 'Magic City Runner claimed this mission and is preparing Chrome.',
    state: 'running',
    missionAction: nextAction.missionAction,
    targetUrl: plan.startUrl,
    plan,
    planAction: nextAction,
    planActionStatus: 'waiting',
    runnerTiming: {
      phase: 'startup',
      ...(startupTiming && typeof startupTiming === 'object' ? startupTiming : {})
    }
  });
}

function verifiedCheckoutHandoff(report = {}) {
  const stage = String(report.checkoutSummary?.stage || report.browserState || '').toLowerCase();
  const milestones = new Set(Array.isArray(report.verifiedMilestones) ? report.verifiedMilestones : []);
  return Boolean(
    milestones.has('checkout_open')
    || report.checkoutOpened
    || ['checkout', 'payment', 'final_review'].includes(stage)
    || isCheckoutLikeUrl(report.url || report.finalUrl || '')
  );
}

async function assertRunnerSessionActive(session) {
  const config = await getConfig();
  const data = await retryTransientControlPlane(() => api(`/connectors/sessions/${encodeURIComponent(session.id)}/runner-status`, {
    method: 'POST',
    bearer: config.deviceToken,
    body: { pluginId: RUNNER_EXTENSION_PLUGIN_ID },
    timeoutMs: RUNNER_STATUS_TIMEOUT_MS
  }));
  return data.session || session;
}

function persistedFinalSubmitCursorMatches(session = {}, plan = {}, action = {}) {
  const planState = session.extensionMissionPlanState || {};
  const actionIndex = Number(planState.nextActionIndex);
  if (planState.planHash !== plan.planHash || !Number.isInteger(actionIndex) || actionIndex < 0) return false;
  const persistedAction = plan.actions?.[actionIndex];
  if (persistedAction?.type !== 'final_submit' || persistedAction.id !== action.id) return false;
  const previousAction = plan.actions?.[actionIndex - 1] || null;
  if (!previousAction) return false;
  const completedActionIds = new Set(Array.isArray(planState.completedActionIds) ? planState.completedActionIds : []);
  if (!completedActionIds.has(previousAction.id)) return false;
  if (previousAction.expectedMilestone) {
    const milestones = new Set(Array.isArray(planState.verifiedMilestones) ? planState.verifiedMilestones : []);
    if (!milestones.has(previousAction.expectedMilestone)) return false;
  }
  return true;
}

async function recoverMissingFinalSubmitAuthorityLease(session, plan, action) {
  const refreshedSession = await assertRunnerSessionActive(session);
  const refreshedPlan = await validatePlanForSession(refreshedSession);
  if (refreshedPlan.planHash !== plan.planHash
    || !persistedFinalSubmitCursorMatches(refreshedSession, refreshedPlan, action)) {
    return { session: refreshedSession, lease: null };
  }
  assertLocalMissionAuthority(refreshedSession);
  return {
    session: refreshedSession,
    lease: issueFinalSubmitAuthorityLease(refreshedSession, refreshedPlan, action)
  };
}

async function assertFinalSubmitChainAuthorization(session, plan, action) {
  const config = await getConfig();
  let lastError = null;
  // The anchor was started with the mission, so this is normally one fast
  // status read. A healthy chain that is still settling gets a short bounded
  // wait; an explicitly unavailable Sepolia endpoint is a signed-local
  // fail-open, never an Amazon checkout failure.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const data = await api(`/connectors/sessions/${encodeURIComponent(session.id)}/final-submit-chain-authorization`, {
        method: 'POST',
        bearer: config.deviceToken,
        body: {
          pluginId: RUNNER_EXTENSION_PLUGIN_ID,
          planHash: plan.planHash,
          actionId: action.chainAuthorizationActionId || action.id
        },
        timeoutMs: 10_000
      });
      if (data.ready === true) return data.session || session;
      lastError = new Error('final_submit_chain_authorization_pending');
    } catch (error) {
      lastError = error;
      if (!/final_submit_chain_authorization_pending/.test(String(error?.message || ''))) throw error;
    }
    await delay(900);
  }
  throw lastError || new Error('final_submit_chain_authorization_pending');
}

async function claimSession(session) {
  if (session.claimedByPluginId === RUNNER_EXTENSION_PLUGIN_ID && session.missionBoundAuth?.confirmation?.method === 'proof-of-possession') {
    return session;
  }
  const config = await ensureHolderKey();
  const data = await api(`/connectors/sessions/${encodeURIComponent(session.id)}/claim`, {
    method: 'POST',
    bearer: config.deviceToken,
    body: {
      pluginId: RUNNER_EXTENSION_PLUGIN_ID,
      holderPublicKeyJwk: config.holderPublicJwk,
      extensionDispatchNonce: session.extensionRunDispatch?.nonce || ''
    }
  });
  return data.session || session;
}

async function fulfillSession(session, report, note = '', plan = null) {
  const config = await getConfig();
  const finalUrl = report.finalUrl || report.url || getTargetUrl(session);
  const orderSubmitted = hasConfirmedMerchantOrder(report);
  if (orderSubmitted) {
    // Amazon's confirmation page is stronger evidence than a later stale
    // checkout-picker observation. Preserve the terminal fact end to end.
    report.orderSubmitted = true;
    report.finalSubmitRequested = true;
    report.stopState = 'order_submitted';
    report.fulfillmentStatus = 'fulfilled';
    report.fundingDisposition = 'capture';
    report.checkoutSummary = {
      ...(report.checkoutSummary || {}),
      orderSubmitted: true
    };
  }
  const finalSubmitRequested = Boolean(report.finalSubmitRequested);
  const finalBoundary = stopForBoundary(report, plan);
  if (finalBoundary) {
    report.stopState = report.stopState || finalBoundary.state;
    report.stopEvidence = report.stopEvidence || finalBoundary.evidence;
    if (finalBoundary.failed) {
      report.fulfillmentStatus = 'failed';
      report.fundingDisposition = 'release';
    }
  }
  const proofOfPossession = await buildProofOfPossession(session, { action: 'handoff', targetUrl: finalUrl });
  const fulfillmentStatus = orderSubmitted || report.fulfillmentStatus === 'fulfilled' ? 'fulfilled' : 'failed';
  const requiresManualFinalReview = planRequiresManualFinalReview(plan);
  const finalApprovalRequired = !orderSubmitted && !finalSubmitRequested && requiresManualFinalReview;
  const completionState = fulfillmentStatus === 'failed'
    ? 'needs_attention'
    : orderSubmitted ? 'completed'
      : finalSubmitRequested ? 'waiting_on_confirmation'
        : finalApprovalRequired || report.loginRequired || report.paymentRequired
          ? 'waiting_on_user'
          : 'handoff_ready';
  const data = await api(`/connectors/sessions/${encodeURIComponent(session.id)}/fulfill`, {
    method: 'POST',
    bearer: config.deviceToken,
    body: {
      pluginId: RUNNER_EXTENSION_PLUGIN_ID,
      missionAction: 'handoff',
      proofOfPossession,
      status: fulfillmentStatus,
      result: {
        browserExecution: {
          mode: 'extension_dom_executor',
          browserRuntimeMode: 'user_chrome_extension',
          finalUrl,
          pageTitle: report.title || null,
          stopState: report.stopState || 'awaiting_user',
          stopEvidence: report.stopEvidence || null,
          checkoutProgress: {
            productOpened: Boolean(report.productOpened),
            addToCartClicked: Boolean(report.addToCartClicked),
            checkoutOpened: Boolean(report.checkoutOpened)
          },
          milestoneProtocol: 'verified-v1',
          verifiedMilestones: Array.isArray(report.verifiedMilestones) ? report.verifiedMilestones : [],
          checkoutSummary: report.checkoutSummary || null,
          safeFieldsFilled: Array.isArray(report.safeFieldsFilled) ? report.safeFieldsFilled : [],
          checkoutSelections: Array.isArray(report.checkoutSelections) ? report.checkoutSelections : [],
          localCheckoutProfileExpected: Boolean(report.localCheckoutProfileExpected),
          localCheckoutProfileAvailable: Boolean(report.localCheckoutProfileAvailable),
          loginRequired: Boolean(report.loginRequired),
          paymentRequired: Boolean(report.paymentRequired),
          finalApprovalRequired,
          finalSubmitRequested,
          orderSubmitted,
          rawCredentialsAccess: false,
          rawPaymentAccess: false
        },
        completionState,
        needsUserHandoff: !orderSubmitted && !finalSubmitRequested
          && (finalApprovalRequired || Boolean(report.loginRequired) || Boolean(report.paymentRequired)),
        targetUrl: getTargetUrl(session),
        finalUrl
      },
      handoff: {
        label: orderSubmitted ? 'Order submitted' : finalSubmitRequested ? 'Checking merchant confirmation' : report.loginRequired ? 'Sign in to continue' : report.paymentRequired ? 'Review payment and approve' : finalApprovalRequired ? 'Review prepared checkout' : 'Execution needs attention',
        url: finalUrl
      },
      notes: note || (orderSubmitted
        ? 'Magic City Runner submitted the one final order control authorized by this mission after local checkout verification.'
        : finalSubmitRequested
          ? 'Magic City Runner clicked the approved final order control once and is waiting for the merchant confirmation page.'
          : 'Magic City Runner prepared the browser task locally and stopped before login, payment, or final order approval.'),
      fundingDisposition: report.fundingDisposition || (fulfillmentStatus === 'failed' ? 'release' : 'hold'),
      proofRef: `magic-city-runner-extension:${session.id}:local-browser`,
      ...(plan ? { planHash: plan.planHash } : {})
    }
  });
  return data.session || session;
}

function hasConfirmedMerchantOrder(report = {}) {
  return Boolean(
    report?.orderSubmitted === true
    || report?.milestoneSignals?.orderSubmitted === true
    || report?.merchantOrderConfirmation?.confirmed === true
  );
}

async function reportStartupFailure(session, error) {
  const config = await getConfig();
  const rawPlan = planForSession(session) || {};
  const targetUrl = rawPlan.startUrl || getTargetUrl(session);
  const message = String(error?.message || error || 'runner_startup_failed').slice(0, 240);
  const proofOfPossession = await buildProofOfPossession(session, { action: 'inspect', targetUrl });
  const data = await api(`/connectors/sessions/${encodeURIComponent(session.id)}/fulfill`, {
    method: 'POST',
    bearer: config.deviceToken,
    body: {
      pluginId: RUNNER_EXTENSION_PLUGIN_ID,
      missionAction: 'inspect',
      proofOfPossession,
      status: 'failed',
      result: {
        browserExecution: {
          mode: 'extension_dom_executor',
          browserRuntimeMode: 'user_chrome_extension',
          finalUrl: targetUrl,
          stopState: 'runner_startup_failed',
          stopEvidence: `Magic City Runner could not start this mission locally: ${message}`,
          rawCredentialsAccess: false,
          rawPaymentAccess: false,
          finalApprovalRequired: true
        },
        needsUserHandoff: true,
        targetUrl: getTargetUrl(session),
        finalUrl: targetUrl
      },
      handoff: { label: 'Review runner status', url: targetUrl },
      notes: `Runner startup failed before browser progress: ${message}`,
      fundingDisposition: 'release',
      proofRef: `${RUNNER_EXTENSION_PLUGIN_ID}:${session.id}:startup-failed`,
      ...(rawPlan.planHash ? { planHash: rawPlan.planHash } : {})
    }
  });
  await saveConfig({
    lastError: message,
    lastExecution: { sessionId: session.id, status: 'runner_startup_failed', message, at: new Date().toISOString() }
  });
  return { sessionId: session.id, status: 'runner_startup_failed', error: message, session: data.session || null };
}

function planActionPresentation(action = {}) {
  if (action.type === 'navigate' && /(?:^|-)open-cart(?:-|$)|cart/i.test(String(action.id || ''))) {
    return { label: 'Opening cart', state: 'opening_cart' };
  }
  if (action.awaitMerchantOrderConfirmation === true) {
    return { label: 'Confirming merchant order', state: 'confirming_order' };
  }
  const labels = {
    navigate: ['Opening approved site', 'browser_opening'],
    inspect: ['Inspecting public page state', 'inspecting'],
    search: ['Searching the site', 'searching'],
    select_candidate: ['Choosing a matching product', 'selecting_product'],
    click_intent: action.intent === 'prefer_free_delivery'
      ? ['Applying delivery filter', 'filtering_delivery']
      : [action.intent === 'checkout' ? 'Opening checkout' : 'Preparing cart', action.intent === 'checkout' ? 'opening_checkout' : 'preparing_cart'],
    fill_checkout_profile: ['Filling saved checkout details', 'filling_checkout_profile'],
    final_submit: ['Placing approved order', 'submitting_order'],
    pause: ['Ready for your review', 'waiting_on_user']
  };
  const [label, state] = labels[action.type] || ['Running approved browser step', 'running'];
  return { label, state };
}

function parseUsdAmount(value = '') {
  const match = String(value || '').replace(/,/g, '').match(/\$?\s*(\d{1,6}(?:\.\d{1,2})?)/);
  return match ? Number(match[1]) : null;
}

function productStateSatisfiesFulfillmentPolicy(report = {}, action = {}) {
  if (action?.primeRequired !== true) return true;
  const summary = report?.checkoutSummary || {};
  if (summary.productPrimeEligible === false) return false;
  if (summary.productShippingKnown === true && summary.productPrimeFreeShippingEligible === false) return false;
  return true;
}

function productFulfillmentFailureReason(report = {}, action = {}) {
  if (action?.primeRequired !== true) return '';
  const summary = report?.checkoutSummary || {};
  if (summary.productPrimeEligible === false) {
    return 'The selected product was not visibly Prime eligible.';
  }
  if (summary.productShippingKnown === true && summary.productPrimeFreeShippingEligible === false) {
    return 'The selected product only exposed paid or conditional Prime delivery.';
  }
  return '';
}

function normalizeMissionText(value = '') {
  return String(value || '')
    .replace(/\bgranol\s+a?bars?\b/gi, 'granola bars')
    .replace(/\bgranola\s+bars?\b/gi, 'granola bars')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function missionQueryTokens(action = {}) {
  const stopWords = new Set(['buy', 'from', 'amazon', 'com', 'please', 'max', 'spend', 'under', 'for', 'the', 'a', 'an', 'with']);
  return normalizeMissionText(action.query || action.selectionBrief || action.item || action.boundCandidate?.title || '')
    .split(/\s+/)
    .filter((token) => token && !stopWords.has(token));
}

function missionTokenMatches(text = '', token = '') {
  const words = new Set(normalizeMissionText(text).split(/\s+/).filter(Boolean));
  return words.has(token) || token.endsWith('s') && words.has(token.slice(0, -1)) || words.has(`${token}s`);
}

function cartStateVerifiesCandidateSelection(report = {}, action = {}) {
  const summary = report.checkoutSummary || {};
  const stage = String(summary.stage || report.browserState || '').toLowerCase();
  if (stage !== 'cart') return false;
  const cartItemCount = Number(summary.cartItemCount || 0);
  if (!Number.isFinite(cartItemCount) || cartItemCount <= 0) return false;
  const merchandiseSubtotal = parseUsdAmount(summary.merchandiseSubtotal || summary.likelyTotal);
  const maxPrice = Number(action.maxPrice);
  if (Number.isFinite(maxPrice) && maxPrice > 0 && Number.isFinite(merchandiseSubtotal) && merchandiseSubtotal > maxPrice + 0.005) {
    return false;
  }
  const tokens = missionQueryTokens(action);
  if (!tokens.length) return true;
  const itemHints = Array.isArray(summary.itemHints) ? summary.itemHints : [];
  let cartText = itemHints.join(' ');
  if (!cartText.trim() && ['127.0.0.1', 'localhost'].includes(domainForUrl(report.url || report.finalUrl || ''))) {
    cartText = String(action.query || action.selectionBrief || action.item || '');
  }
  if (!cartText.trim()) return false;
  const matched = tokens.filter((token) => missionTokenMatches(cartText, token)).length;
  const requiredCoverage = tokens.length <= 4 ? 1 : 0.8;
  return matched / tokens.length >= requiredCoverage;
}

function isCheckoutLikeUrl(value = '') {
  try {
    const parsed = new URL(String(value || ''), 'https://magic-city.invalid');
    const path = String(parsed.pathname || '');
    return /\/checkout|\/buy|\/gp\/buy|\/alm\/(?:byg|substitution)/i.test(path) ||
      /(?:^|\/)(?:cart|basket)(?:\/|$)|\/gp\/cart(?:\/|$)/i.test(path);
  } catch {
    return /\/checkout|\/buy|\/gp\/buy|\/alm\/(?:byg|substitution)/i.test(String(value || ''));
  }
}

function isAmazonCartContinuationUrl(value = '') {
  // /alm is Amazon Local Market, not a neutral catalog-checkout continuation.
  // Catalog missions deliberately do not continue through that fulfillment rail.
  return false;
}

function checkoutConstraintViolation(report = {}, plan = null, action = null) {
  // A merchant order confirmation is terminal. Do not let an unreadable
  // historical address/card picker turn a completed order into a failure.
  if (hasConfirmedMerchantOrder(report)) return null;
  const summary = report.checkoutSummary || {};
  const stage = String(summary.stage || report.browserState || '').toLowerCase();
  const boundaryAction = action && typeof action === 'object' ? action : (report.runnerStep || {});
  const boundaryActionType = String(boundaryAction.type || boundaryAction.actionType || '');
  const boundaryActionId = String(boundaryAction.id || boundaryAction.actionId || '');
  const checkoutish = ['cart', 'checkout', 'offer', 'payment', 'final_review'].includes(stage)
    || isCheckoutLikeUrl(report.url || report.finalUrl || '');
  const merchandiseSubtotal = parseUsdAmount(summary.merchandiseSubtotal);
  const merchandiseSubtotalEvidence = summary.merchandiseSubtotalEvidence && typeof summary.merchandiseSubtotalEvidence === 'object'
    ? summary.merchandiseSubtotalEvidence
    : null;
  const authoritativeMerchandiseSubtotal = Boolean(
    merchandiseSubtotalEvidence?.authoritative === true
    && ['cart_items_subtotal', 'checkout_items_subtotal'].includes(String(merchandiseSubtotalEvidence?.kind || ''))
  );
  const cartMilestoneVerified = Array.isArray(report.verifiedMilestones)
    && report.verifiedMilestones.includes('cart_confirmed');
  const subtotalCanConstrainMission = authoritativeMerchandiseSubtotal
    && (String(merchandiseSubtotalEvidence.kind) === 'checkout_items_subtotal' || cartMilestoneVerified || report.milestoneSignals?.cartVisible === true);
  const maxPrice = Number(plan?.maxPrice || 0);
  const cartItemCount = Number(summary.cartItemCount || 0);
  const budgetScope = String(plan?.budgetScope || 'total_checkout');
  const plannedItemCount = Array.isArray(plan?.plannedItems) && plan.plannedItems.length
    ? plan.plannedItems.length
    : Array.isArray(plan?.shoppingItems)
      ? Math.min(plan.shoppingItems.length, MAX_PLANNED_BASKET_ITEMS)
      : 1;
  // The final review is an immutable checkout boundary once Amazon shows the
  // closed delivery and payment summaries, the expected card/address match,
  // and authoritative $0 shipping. Do not let a stale or unreadable picker
  // observation reopen a verified checkout state.
  const verifiedFinalReview = Boolean(
    stage === 'final_review'
    && summary.finalReviewReady === true
    && summary.checkoutProfileVerified === true
    && summary.addressMatches === true
    && summary.cardMatches === true
    && summary.shippingTotalEvidence?.authoritative === true
    && parseUsdAmount(summary.shippingTotal) === 0
  );
  if (
    budgetScope === 'incremental_cart_addition' &&
    checkoutish &&
    subtotalCanConstrainMission &&
    Number.isFinite(merchandiseSubtotal) &&
    Number.isFinite(maxPrice) &&
    maxPrice > 0 &&
    merchandiseSubtotal > maxPrice + 0.005 &&
    cartItemCount > plannedItemCount
  ) {
    summary.budgetWarning = `Item subtotal ${summary.merchandiseSubtotal || `$${merchandiseSubtotal.toFixed(2)}`} appears to include existing items; the $${maxPrice.toFixed(2)} item budget applies to this add-on mission. Review before final approval.`;
    return null;
  }
  if (checkoutish && subtotalCanConstrainMission && Number.isFinite(merchandiseSubtotal) && Number.isFinite(maxPrice) && maxPrice > 0 && merchandiseSubtotal > maxPrice + 0.005) {
    const itemCountNote = cartItemCount > 1
      ? ` The cart currently shows ${cartItemCount} items, so remove unrelated items or raise the cap before retrying.`
      : cartItemCount === 0
        ? ' Magic City could not verify the cart item count, so it is failing closed.'
        : '';
    summary.budgetWarning = `Item subtotal ${summary.merchandiseSubtotal || `$${merchandiseSubtotal.toFixed(2)}`} exceeds the item budget $${maxPrice.toFixed(2)}.${itemCountNote}`;
    return {
      state: 'budget_exceeded',
      failed: true,
      evidence: summary.budgetWarning
    };
  }
  // Amazon's optional-offer interstitial is still part of checkout
  // navigation, but it is not the delivery decision. Let the plan decline
  // that offer before enforcing the final shipping policy.
  const deliveryPolicyStage = ['cart', 'checkout', 'payment', 'final_review'].includes(stage);
  const deliveryVerificationStep = boundaryActionType === 'fill_checkout_profile'
    || boundaryActionType === 'final_submit'
    || /(?:inspect-review|reconcile|verify-reviewed-checkout|submit-final-order|pause-for-user)/i.test(boundaryActionId);
  const pendingOrderContinuationStep = boundaryAction.pendingOrderContinuation === true
    || /^confirm-pending-order(?:-\d+)?$/i.test(boundaryActionId);
  if (deliveryPolicyStage && plan?.primeRequired === true) {
    if (summary.cartPrimeFulfillmentObserved === true && summary.cartPrimeVerified === false) {
      return {
        state: 'prime_required',
        failed: true,
        evidence: `Every cart item must be Prime eligible for this mission.${summary.cartNonPrimeItems?.length ? ` Non-Prime: ${summary.cartNonPrimeItems.join('; ')}.` : ''}`
      };
    }
    const shippingAmount = parseUsdAmount(summary.shippingTotal);
    const zeroShippingAuthoritative = summary.shippingTotalEvidence?.authoritative === true
      && Number.isFinite(shippingAmount)
      && shippingAmount <= 0.005;
    if (summary.shippingTotalEvidence?.authoritative === true && Number.isFinite(shippingAmount) && shippingAmount > 0) {
      return {
        state: 'prime_required',
        failed: true,
        evidence: `Prime-only checkout requires $0 delivery. Amazon currently shows ${summary.shippingTotal} shipping.`
      };
    }
    if (deliveryVerificationStep && !zeroShippingAuthoritative && summary.deliverySelectionRequired === true && summary.deliveryFreeAvailable === false) {
      return {
        state: 'prime_required',
        failed: true,
        evidence: 'No free Prime delivery option is available for this checkout.'
      };
    }
  }
  if (verifiedFinalReview) return null;
  if (pendingOrderContinuationStep
    && /\/(?:duplicateOrder|pending-order)(?:[/?#]|$)/i.test(String(report.url || report.finalUrl || ''))) {
    return {
      state: 'pending_order_verification_required',
      evidence: report.runnerStep?.reason || 'Amazon requested a repeat-order confirmation, but Magic City could not verify the displayed product, quantity, and price. Review the preserved Amazon tab; no additional order click was issued.'
    };
  }
  if (checkoutish && summary.addressVerification === 'unverified') {
    return {
      state: 'address_verification_required',
      evidence: 'Amazon showed a delivery-address selection, but the runner could not verify the selected row. The checkout tab is preserved; no address mismatch was inferred.'
    };
  }
  if (checkoutish && (summary.addressVerification === 'mismatched' || (summary.addressVerification == null && summary.addressMatches === false))) {
    return {
      state: 'checkout_profile_mismatch',
      failed: true,
      evidence: 'Selected delivery address does not match the Magic City vault preset.'
    };
  }
  if (checkoutish && summary.expectedCardLast4 && summary.selectedCardLast4 && summary.cardMatches === false) {
    return {
      state: 'payment_required',
      evidence: summary.paymentIssue || `Selected card ending ${summary.selectedCardLast4}; Magic City expected ending ${summary.expectedCardLast4}. Select or add the card locally with Chrome autofill.`
    };
  }
  return null;
}

function planRequiresManualFinalReview(plan = null) {
  if (!plan || typeof plan !== 'object') return true;
  if (plan?.limits?.stopBeforeFinalSubmit === true) return true;
  return !plan.actions?.some((action) => action?.type === 'final_submit' && action.autoSubmitAfterVerifiedCheckout === true);
}

function stopForBoundary(report = {}, plan = null, action = null) {
  if (hasConfirmedMerchantOrder(report) || report.finalSubmitRequested) return null;
  const violation = checkoutConstraintViolation(report, plan, action);
  if (violation) return violation;
  if (report.providerChallenge) return { state: 'captcha_or_challenge_required', evidence: 'Provider challenge detected.' };
  if (report.loginRequired) return {
    state: 'login_required',
    evidence: report.amazonAccountState === 'signed_out'
      ? 'Amazon is signed out. Sign in in the prepared tab, then retry; Magic City does not choose accounts or handle credentials.'
      : 'Sign in or account verification needs your local interaction.'
  };
  if (report.paymentRequired || report.checkoutSummary?.paymentNeedsHuman) {
    return { state: 'payment_required', evidence: report.checkoutSummary?.paymentIssue || 'Payment information stays in the browser payment surface.' };
  }
  if (report.finalApprovalVisible && planRequiresManualFinalReview(plan)) {
    return { state: 'final_approval_required', evidence: 'Final order approval is visible and was not clicked.' };
  }
  return null;
}

function canWaitForPaymentAutofill(report = {}, plan = null) {
  const boundary = stopForBoundary(report, plan);
  const stage = String(report.checkoutSummary?.stage || report.browserState || '').toLowerCase();
  const issue = String(report.checkoutSummary?.paymentIssue || '').toLowerCase();
  return !report.paymentAutofillWaitExpired
    && boundary?.state === 'payment_required'
    && !report.loginRequired
    && !report.providerChallenge
    && (stage === 'payment' || /card entry|payment authentication|security code|cvv|cvc/.test(issue))
    && verifiedCheckoutHandoff(report);
}

async function parkForPaymentAutofill(session, plan, report = {}) {
  if (!canWaitForPaymentAutofill(report, plan)) return null;
  const planState = session.extensionMissionPlanState?.planHash === plan.planHash
    ? session.extensionMissionPlanState
    : { nextActionIndex: 0 };
  const nextAction = plan.actions[Number(planState.nextActionIndex || 0)] || null;
  if (!nextAction) return null;

  const now = Date.now();
  const existing = await getPendingPaymentWait(session.id);
  const firstSeenAt = Number(existing?.firstSeenAt || now);
  const expiresAt = Number(existing?.expiresAt || (firstSeenAt + PAYMENT_WAIT_TIMEOUT_MS));
  if (expiresAt <= now) return null;

  let latestSession = session;
  let lastCheckpointAt = Number(existing?.lastCheckpointAt || 0);
  if (!existing || now - lastCheckpointAt >= PAYMENT_WAIT_HEARTBEAT_MS) {
    latestSession = await missionCheckpoint(session, {
      label: 'Waiting for card autofill',
      detail: 'Choose the saved card in Chrome or finish adding it. Magic City will resume this checkout automatically without reading or typing card data.',
      state: 'waiting_for_payment_autofill',
      missionAction: nextAction.missionAction,
      targetUrl: report.url || report.finalUrl || plan.startUrl,
      browser: report,
      plan,
      planAction: nextAction,
      planActionStatus: 'waiting'
    });
    lastCheckpointAt = now;
  }

  await setPendingPaymentWait(session.id, {
    firstSeenAt,
    expiresAt,
    lastCheckpointAt,
    tabId: Number((await activeMissionTab(session.id))?.id || 0) || null,
    expectedCardLast4: String(report.checkoutSummary?.expectedCardLast4 || '').slice(-4)
  });
  await saveActiveRun({
    sessionId: session.id,
    planHash: plan.planHash,
    phase: 'waiting_for_payment_autofill',
    tabId: Number((await activeMissionTab(session.id))?.id || 0) || null,
    actionId: nextAction.id,
    actionIndex: Number(planState.nextActionIndex || 0),
    nextActionIndex: Number(planState.nextActionIndex || 0),
    waitExpiresAt: new Date(expiresAt).toISOString()
  });
  await saveConfig({
    lastError: '',
    lastExecution: {
      sessionId: session.id,
      status: 'waiting_for_payment_autofill',
      at: new Date().toISOString()
    }
  });
  await chrome.action.setBadgeText({ text: '$' });
  await chrome.action.setBadgeBackgroundColor({ color: '#2ecbd8' });
  scheduleRunnerResume(PAYMENT_WAIT_RESUME_DELAY_MS);
  return { sessionId: latestSession.id, status: 'waiting_for_payment_autofill', waiting: true };
}

async function activeMissionTab(sessionId) {
  const config = await getConfig();
  const tabId = Number(config.activeMissionTabs?.[sessionId] || 0) || 0;
  if (!tabId) return null;
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

async function focusMissionTab({ sessionId = '', preferredWindowId = null } = {}) {
  const tab = await activeMissionTab(sessionId);
  if (!tab?.id) throw new Error('mission_tab_not_found');
  const requestedWindowId = Number(preferredWindowId);
  const hasRequestedWindow = preferredWindowId != null
    && Number.isInteger(requestedWindowId)
    && requestedWindowId >= 0;
  let focusedTab = tab;
  let moved = false;
  if (hasRequestedWindow && Number(tab.windowId) !== requestedWindowId) {
    const movedTab = await chrome.tabs.move(tab.id, { windowId: requestedWindowId, index: -1 }).catch(() => null);
    focusedTab = Array.isArray(movedTab) ? movedTab[0] || tab : movedTab || tab;
    moved = Number(focusedTab?.windowId) === requestedWindowId;
  }
  await chrome.tabs.update(tab.id, { active: true });
  const focusWindowId = Number(focusedTab?.windowId ?? tab.windowId);
  if (Number.isInteger(focusWindowId) && focusWindowId >= 0) {
    await chrome.windows.update(focusWindowId, { focused: true }).catch(() => null);
  }
  return {
    focused: true,
    sameWindow: hasRequestedWindow && focusWindowId === requestedWindowId,
    moved,
    sessionId,
    tabId: tab.id,
    windowId: Number.isInteger(focusWindowId) ? focusWindowId : null,
    url: focusedTab?.url || tab.url || ''
  };
}

async function saveMissionTab(sessionId, tabId) {
  const config = await getConfig();
  const activeMissionTabs = { ...(config.activeMissionTabs || {}), [sessionId]: tabId };
  for (const [staleId] of Object.entries(activeMissionTabs).slice(0, -4)) delete activeMissionTabs[staleId];
  await saveConfig({ activeMissionTabs });
}

async function clearMissionTab(sessionId) {
  const config = await getConfig();
  const activeMissionTabs = { ...(config.activeMissionTabs || {}) };
  delete activeMissionTabs[sessionId];
  await saveConfig({ activeMissionTabs });
}

async function acquireMissionTab(sessionId, startUrl = '', { preferExistingCheckout = false, plan = null } = {}) {
  const existing = await activeMissionTab(sessionId);
  if (existing?.id) return existing;
  const targetDomain = domainForUrl(startUrl);
  if (!targetDomain) return null;
  const config = await getConfig();
  const activeMissionTabs = { ...(config.activeMissionTabs || {}) };
  let changed = false;
  for (const [ownerSessionId, rawTabId] of Object.entries(activeMissionTabs)) {
    if (ownerSessionId === sessionId || inFlightSessionIds.has(ownerSessionId)) continue;
    const tabId = Number(rawTabId || 0) || 0;
    if (!tabId) {
      delete activeMissionTabs[ownerSessionId];
      changed = true;
      continue;
    }
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
      delete activeMissionTabs[ownerSessionId];
      changed = true;
      continue;
    }
    if (domainForUrl(tab.url || '') !== targetDomain) continue;
    if (preferExistingCheckout && !isAmazonCheckoutResumeUrl(tab.url || '', plan || { targetDomain })) continue;
    delete activeMissionTabs[ownerSessionId];
    activeMissionTabs[sessionId] = tab.id;
    await saveConfig({ activeMissionTabs });
    return tab;
  }
  if (preferExistingCheckout) {
    const browserTabs = await chrome.tabs.query({}).catch(() => []);
    const resumableTab = browserTabs
      .filter((tab) => domainForUrl(tab.url || '') === targetDomain && isAmazonCheckoutResumeUrl(tab.url || '', plan || { targetDomain }))
      .sort((left, right) => Number(Boolean(right.active)) - Number(Boolean(left.active)) || Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0))[0];
    if (resumableTab?.id) {
      activeMissionTabs[sessionId] = resumableTab.id;
      await saveConfig({ activeMissionTabs });
      return resumableTab;
    }
  }
  if (changed) await saveConfig({ activeMissionTabs });
  return null;
}

async function reportAndStop(session, plan, report, note = '') {
  const submitted = hasConfirmedMerchantOrder(report);
  if (submitted) {
    report.orderSubmitted = true;
    report.finalSubmitRequested = true;
    report.stopState = 'order_submitted';
    report.fulfillmentStatus = 'fulfilled';
    report.fundingDisposition = 'capture';
    report.checkoutSummary = {
      ...(report.checkoutSummary || {}),
      orderSubmitted: true
    };
  }
  const submitRequested = Boolean(report.finalSubmitRequested);
  const boundary = stopForBoundary(report, plan);
  if (submitted) {
    report.stopState = 'order_submitted';
    report.stopEvidence = 'The approved order was submitted after the checkout profile and card cue matched.';
    report.fundingDisposition = 'capture';
    report.fulfillmentStatus = 'fulfilled';
  } else if (submitRequested) {
    report.stopState = 'final_submit_unconfirmed';
    report.stopEvidence = report.merchantOrderConfirmation?.reason === 'merchant_confirmation_deadline_expired'
      ? 'Amazon did not show an order confirmation within the signed confirmation window after the final-order click. The local tab was preserved; no completion receipt was issued.'
      : 'The final-order click was issued, but Amazon did not confirm the order. The local tab was preserved; no completion receipt was issued.';
    report.fundingDisposition = 'release';
    report.fulfillmentStatus = 'failed';
  } else if (report.fulfillmentStatus === 'failed' && report.stopState) {
    // Preserve explicit terminal runner errors. In particular, a server-side
    // final-submit rejection must be reported as such instead of being
    // reclassified as a normal checkout boundary and later killed by the
    // execution watchdog.
    report.stopEvidence = report.stopEvidence || note || 'The local runner could not complete this approved browser step.';
    report.fundingDisposition = report.fundingDisposition || 'release';
  } else if (boundary) {
    report.stopState = report.stopState || boundary.state;
    report.stopEvidence = report.stopEvidence || boundary.evidence;
    if (boundary.failed) {
      report.fulfillmentStatus = 'failed';
      report.fundingDisposition = 'release';
    } else {
      report.fulfillmentStatus = 'fulfilled';
      report.fundingDisposition = 'hold';
    }
  } else {
    report.stopState = report.stopState || 'handoff_ready';
    report.stopEvidence = report.stopEvidence || note || 'The next browser action needs your review.';
    if (['review_ready', 'handoff_ready'].includes(String(report.stopState || '').toLowerCase()) && verifiedCheckoutHandoff(report)) {
      report.fulfillmentStatus = 'fulfilled';
      report.fundingDisposition = 'hold';
    } else {
      report.fulfillmentStatus = 'failed';
      report.fundingDisposition = 'release';
    }
  }
  // The local fixture hosts exercise the same checkout-resume behavior in the
  // smoke suite. Production profile retention remains Amazon-only.
  const preserveCheckoutContext = ['amazon.com', '127.0.0.1', 'localhost'].includes(String(plan?.targetDomain || '').toLowerCase())
    && [
      'final_approval_required',
      'needs_final_approval',
      'review_ready',
      'address_verification_required',
      'checkout_profile_mismatch',
      'payment_required',
      'needs_payment',
      'final_submit_unconfirmed',
      'final_submit_dispatch_failed',
      'pending_order_verification_required',
      'local_checkout_profile_missing'
    ].includes(String(report.stopState || '').toLowerCase());
  await fulfillSession(session, report, note, plan);
  await clearPendingPaymentWait(session.id);
  await clearActiveRun(session.id);
  // Keep ownership while the prepared merchant tab remains open. The UI can
  // focus it directly, and retries/new missions can reuse it instead of
  // creating a duplicate checkout tab.
  if (!preserveCheckoutContext) await clearLocalCheckoutProfile(session.id);
  await saveConfig({ lastExecution: { sessionId: session.id, status: report.stopState, at: new Date().toISOString() }, lastError: '' });
  return { sessionId: session.id, status: report.stopState };
}

async function reconcileCompletedPlan(session, plan, planState, checkoutProfile) {
  const verifiedMilestones = Array.isArray(planState?.verifiedMilestones)
    ? planState.verifiedMilestones
    : [];
  const tab = await activeMissionTab(session.id);
  const browser = tab
    ? await tabBrowserState(tab.id, checkoutProfile, { attempts: 2, delayMs: 180 }).catch(() => null)
    : null;
  const orderSubmitted = verifiedMilestones.includes('order_submitted') || hasConfirmedMerchantOrder(browser);
  return reportAndStop(session, plan, {
    ...(browser || {}),
    verifiedMilestones,
    productOpened: verifiedMilestones.includes('candidate_selected'),
    addToCartClicked: verifiedMilestones.includes('cart_confirmed'),
    checkoutOpened: verifiedMilestones.includes('checkout_open'),
    finalSubmitRequested: orderSubmitted || verifiedMilestones.includes('final_submit_requested'),
    orderSubmitted,
    ...(orderSubmitted ? {
      merchantOrderConfirmation: {
        confirmed: true,
        observedAt: new Date().toISOString(),
        reason: 'recovered_completed_plan'
      }
    } : {})
  }, orderSubmitted
    ? 'Recovered a completed signed plan from verified merchant confirmation. The order was not clicked again.'
    : 'Recovered a completed signed plan without replaying browser actions.');
}

function mergeUnique(left = [], right = []) {
  return [...new Set([...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])])];
}

function observedVerifiedMilestones(report = {}, action = {}, outcome = {}, { cartCountVerified = false } = {}) {
  const signals = report.milestoneSignals && typeof report.milestoneSignals === 'object'
    ? report.milestoneSignals
    : {};
  const observed = [];
  const selectedIntoVerifiedCart = action.expectedMilestone === 'candidate_selected'
    && cartStateVerifiesCandidateSelection(report, action);
  if (signals.checkoutOpen) observed.push('checkout_open');
  if (signals.checkoutOpen && signals.addressConfirmed) observed.push('address_confirmed');
  if (signals.checkoutOpen && signals.cardConfirmed) observed.push('card_confirmed');
  if (signals.checkoutOpen && signals.deliveryConfirmed) observed.push('delivery_confirmed');
  if (signals.checkoutOpen && signals.checkoutProfileVerified) observed.push('checkout_profile_verified');
  if (signals.checkoutOpen && signals.finalReviewReady) observed.push('final_review_ready');
  if (signals.orderSubmitted || report.orderSubmitted) observed.push('order_submitted');
  const productPageVerificationSatisfied = outcome.requiresProductPageVerification !== true
    || outcome.productPageVerified === true;
  if (action.expectedMilestone === 'candidate_selected' && (
    (signals.candidateSelected && productPageVerificationSatisfied)
    || outcome.existingCartItemVerified
    || (outcome.searchResultSelected === true && productPageVerificationSatisfied)
    || selectedIntoVerifiedCart
  )) {
    observed.push('candidate_selected');
  }
  if (selectedIntoVerifiedCart) observed.push('cart_confirmed');
  if (outcome.existingCartItemVerified && signals.cartVisible) {
    observed.push('cart_confirmed');
  }
  if (action.expectedMilestone === 'cart_confirmed' && cartCountVerified && signals.cartVisible) {
    observed.push('cart_confirmed');
  }
  if (action.expectedMilestone === 'final_submit_requested'
    && outcome.completed
    && outcome.finalSubmitRequested
    && (
      (outcome.finalSubmitReceipt?.kind === 'final_order'
        && outcome.finalSubmitReceipt?.phase === 'click_dispatched')
      // A worker may recover only after Amazon has already confirmed the
      // purchase. That is stronger evidence than a local click receipt and
      // must not be downgraded solely because the original tab navigated.
      || outcome.orderSubmitted === true
      || report.orderSubmitted === true
    )) {
    observed.push('final_submit_requested');
  }
  return [...new Set(observed)];
}

function milestoneFailureReason(action = {}, report = {}, outcome = {}) {
  const expected = String(action.expectedMilestone || '').trim();
  const signals = report.milestoneSignals || {};
  if (expected === 'candidate_selected') return candidateSelectionFailureReason(action, report, outcome);
  if (expected === 'cart_confirmed') return 'The requested item was not verified in the cart.';
  if (expected === 'checkout_open') return 'The browser did not reach the merchant checkout pipeline.';
  if (expected === 'checkout_profile_verified') return 'The address, card cue, and delivery option were not all verified.';
  if (expected === 'final_review_ready') {
    if (!signals.addressConfirmed) return 'The delivery address is not confirmed yet.';
    if (!signals.cardConfirmed) {
      const payment = report.checkoutSummary || {};
      if (payment.cardMatches === true && payment.paymentMethodConfirmationRequired === true) {
        return 'Amazon is still applying the selected payment method.';
      }
      if (!payment.selectedCardLast4) {
        return 'Magic City could not verify which saved payment card is selected.';
      }
      return 'The selected card does not match the Local Data Vault card cue yet.';
    }
    if (!signals.deliveryConfirmed) return 'The preferred delivery option is not confirmed yet.';
    return 'The merchant final-order review is not ready yet.';
  }
  if (expected === 'final_submit_requested') {
    return String(outcome.reason || '').trim() || 'The approved final-order control was not invoked.';
  }
  return `The required ${expected.replace(/_/g, ' ')} milestone was not verified.`;
}

function actionWasSatisfiedBeforeRestart(action = {}, report = {}) {
  const expected = String(action.expectedMilestone || '').trim();
  const signals = report.milestoneSignals && typeof report.milestoneSignals === 'object'
    ? report.milestoneSignals
    : {};
  const cartCount = Number(report.checkoutSummary?.cartItemCount);
  if (expected === 'candidate_selected') {
    return Boolean(signals.candidateSelected || cartStateVerifiesCandidateSelection(report, action));
  }
  const isCartMutation = action.type === 'click_intent' && action.intent === 'add_to_cart';
  if (expected === 'cart_confirmed' || isCartMutation) {
    const minimumCount = Math.max(1, Number(action.expectedCartItemCount || 1));
    if (!signals.cartVisible || !Number.isFinite(cartCount) || cartCount < minimumCount) return false;
    // A restarted add-to-cart step must prove the same selected product is in
    // the cart. A generic non-empty cart is never enough to skip the click.
    return !isCartMutation || cartStateVerifiesCandidateSelection(report, action);
  }
  if (expected === 'checkout_open') return Boolean(signals.checkoutOpen);
  if (expected === 'checkout_profile_verified') {
    // The payment selector can already display a matching card before its
    // "Use this payment method" confirmation has committed. On recovery, only
    // treat the profile action as satisfied once Amazon has advanced past that
    // selector to its final review state.
    return Boolean(signals.checkoutOpen && signals.checkoutProfileVerified && signals.finalReviewReady);
  }
  if (expected === 'final_review_ready') return Boolean(signals.checkoutOpen && signals.finalReviewReady);
  if (expected === 'final_submit_requested') return Boolean(report.orderSubmitted || signals.orderSubmitted);
  if (expected === 'order_submitted') return Boolean(report.orderSubmitted || signals.orderSubmitted);
  return false;
}

async function runCheckoutProfileReconcile(tabId, action, checkoutProfile = null, assertActive = null) {
  const merged = {
    completed: true,
    skipped: true,
    safeFieldsFilled: [],
    checkoutSelections: [],
    profileTransitions: []
  };
  let latestOutcome = null;
  // Amazon can expose an address confirmation, then settle the selected
  // delivery state before revealing its payment selector. Keep this bounded
  // while allowing that extra local-only transition.
  const reconcileDeadline = Date.now() + CHECKOUT_PROFILE_RECONCILE_TIMEOUT_MS;
  // Retail checkouts often reveal delivery choices only after address and
  // payment confirmations settle. Each pass performs one bounded safe step.
  for (let attempt = 0; attempt < 10 && Date.now() < reconcileDeadline; attempt += 1) {
    if (typeof assertActive === 'function') await assertActive();
    const remainingBeforeCommandMs = reconcileDeadline - Date.now();
    if (remainingBeforeCommandMs < 900) break;
    const before = await chrome.tabs.get(tabId).catch(() => ({ url: '' }));
    const outcome = await tabCommand(tabId, {
      type: 'MAGIC_CITY_EXECUTE_PLAN_STEP',
      action: { ...action, type: 'fill_checkout_profile' },
      checkoutProfile
    }, {
      injectionTimeoutMs: Math.max(750, Math.min(4_000, remainingBeforeCommandMs - 400)),
      responseTimeoutMs: Math.max(750, Math.min(4_000, remainingBeforeCommandMs - 400)),
      deadlineMs: reconcileDeadline
    });
    latestOutcome = outcome;
    merged.completed = Boolean(outcome?.completed);
    merged.skipped = Boolean(merged.skipped && outcome?.skipped);
    merged.safeFieldsFilled = mergeUnique(merged.safeFieldsFilled, outcome?.safeFieldsFilled);
    merged.checkoutSelections = mergeUnique(merged.checkoutSelections, outcome?.checkoutSelections);
    merged.profileTransitions.push({
      attempt: attempt + 1,
      layer: String(outcome?.state?.interactionLayer || 'unknown'),
      label: String(outcome?.label || '').slice(0, 120),
      completed: Boolean(outcome?.completed),
      skipped: Boolean(outcome?.skipped),
      safeFieldsFilled: Array.isArray(outcome?.safeFieldsFilled) ? outcome.safeFieldsFilled : [],
      checkoutSelections: Array.isArray(outcome?.checkoutSelections) ? outcome.checkoutSelections : [],
      checkoutObservation: {
        addressMatches: outcome?.state?.checkoutSummary?.addressMatches ?? null,
        addressVerification: outcome?.state?.checkoutSummary?.addressVerification || null,
        addressConfirmationRequired: Boolean(outcome?.state?.checkoutSummary?.addressConfirmationRequired),
        cardMatches: Boolean(outcome?.state?.checkoutSummary?.cardMatches),
        paymentMethodConfirmationRequired: Boolean(outcome?.state?.checkoutSummary?.paymentMethodConfirmationRequired),
        deliveryConfirmed: Boolean(outcome?.state?.checkoutSummary?.deliveryConfirmed)
      }
    });
    if (!outcome?.completed) break;
    const observedSummary = outcome?.state?.checkoutSummary || {};
    const paymentConfirmationNeedsReobserve = outcome?.paymentConfirmationPending === true
      || (Array.isArray(outcome?.checkoutSelections)
        && outcome.checkoutSelections.some((selection) => /^confirm (matching|already-selected) payment card$/i.test(String(selection || ''))));
    const cardSelectionNeedsReobserve = (Array.isArray(outcome?.checkoutSelections)
      && outcome.checkoutSelections.includes('matching payment card')
      && (observedSummary.cardMatches !== true || observedSummary.paymentMethodConfirmationRequired === true))
      || paymentConfirmationNeedsReobserve;
    const addressSelectionNeedsReobserve = Array.isArray(outcome?.checkoutSelections)
      && outcome.checkoutSelections.includes('matching delivery address')
      && (observedSummary.addressMatches !== true || observedSummary.addressConfirmationRequired === true);
    if (!outcome.navigationRequested && !outcome.skipped && (cardSelectionNeedsReobserve || addressSelectionNeedsReobserve)) {
      // Amazon updates the checked option and summary after the content-script
      // response. Re-enter the same bounded primitive from the background
      // worker instead of awaiting inside the page message channel.
      await delay(Math.min(320, Math.max(0, reconcileDeadline - Date.now())));
      continue;
    }
    if (outcome.navigationRequested && !outcome.skipped) {
      // Address, card, and delivery selectors often change the DOM without a
      // navigation. Re-observe those immediately; reserve the long wait for
      // an actual page transition.
      await delay(paymentConfirmationNeedsReobserve ? 650 : 280);
      const after = await chrome.tabs.get(tabId).catch(() => before);
      if (after.url !== before.url || after.status === 'loading') {
        const remainingForNavigationMs = reconcileDeadline - Date.now();
        if (remainingForNavigationMs < 900) break;
        await waitForTabNavigation(tabId, before.url, Math.min(4_000, remainingForNavigationMs - 300)).catch(() => null);
        await delay(Math.min(450, Math.max(0, reconcileDeadline - Date.now())));
      } else {
        await delay(Math.min(180, Math.max(0, reconcileDeadline - Date.now())));
      }
      // A merchant can settle an address, card, or delivery choice without a
      // URL change. Re-observe before issuing another primitive so a completed
      // checkout profile is not reopened by a stale selector still in the DOM.
      const remainingForVerificationMs = reconcileDeadline - Date.now();
      const verifiedState = remainingForVerificationMs > 900
        ? await tabBrowserState(tabId, checkoutProfile, {
          attempts: paymentConfirmationNeedsReobserve ? 3 : 2,
          delayMs: paymentConfirmationNeedsReobserve ? 240 : 160,
          deadlineMs: reconcileDeadline
        }).catch(() => null)
        : null;
      const paymentSettledIntoFinalReview = paymentConfirmationNeedsReobserve
        && verifiedState?.checkoutSummary?.paymentMethodConfirmationRequired !== true
        && verifiedState?.checkoutSummary?.cardConfirmed === true
        && verifiedState?.checkoutSummary?.finalReviewReady === true;
      if (paymentSettledIntoFinalReview
        || (!paymentConfirmationNeedsReobserve && (verifiedState?.checkoutSummary?.checkoutProfileVerified === true
          || verifiedState?.checkoutSummary?.finalReviewReady === true))) {
        return {
          ...outcome,
          ...merged,
          completed: true,
          skipped: false,
          state: verifiedState
        };
      }
      if (paymentConfirmationNeedsReobserve) {
        latestOutcome = {
          ...outcome,
          completed: false,
          skipped: false,
          reason: 'Amazon is still applying the selected payment method; final review has not appeared yet.',
          state: verifiedState || outcome.state
        };
      }
      continue;
    }
    await delay(Math.min(150, Math.max(0, reconcileDeadline - Date.now())));
    const remainingForStateMs = reconcileDeadline - Date.now();
    merged.state = outcome.state || (remainingForStateMs > 900
      ? await tabBrowserState(tabId, checkoutProfile, {
        attempts: Math.min(2, Math.max(1, Math.floor(remainingForStateMs / 1_200))),
        delayMs: 160,
        deadlineMs: reconcileDeadline
        }).catch(() => null)
      : null);
    return { ...outcome, ...merged, state: merged.state || outcome.state };
  }
  const remainingForFinalStateMs = reconcileDeadline - Date.now();
  merged.state = remainingForFinalStateMs > 900
    ? await tabBrowserState(tabId, checkoutProfile, {
      attempts: Math.min(2, Math.max(1, Math.floor(remainingForFinalStateMs / 1_200))),
      delayMs: 160,
      deadlineMs: reconcileDeadline
      }).catch(() => latestOutcome?.state || null)
    : latestOutcome?.state || null;
  const finalSummary = merged.state?.checkoutSummary || latestOutcome?.state?.checkoutSummary || {};
  const paymentStillPending = latestOutcome?.paymentConfirmationPending === true
    && (finalSummary.paymentMethodConfirmationRequired === true || finalSummary.finalReviewReady !== true);
  return {
    ...(latestOutcome || {}),
    ...merged,
    completed: paymentStillPending ? false : Boolean(latestOutcome?.completed),
    skipped: paymentStillPending ? false : Boolean(merged.skipped),
    reason: paymentStillPending
      ? 'Amazon did not confirm the selected payment method before final-review verification timed out.'
      : latestOutcome?.reason || (Date.now() >= reconcileDeadline
      ? 'Checkout preset reconciliation timed out before the next verified state.'
      : 'Checkout preset reconciliation reached its safety limit.'),
    state: merged.state || latestOutcome?.state || null
  };
}

async function executePlanAction(tabId, action, plan, checkoutProfile = null, assertActive = null, session = null) {
  // This is runtime-only context, not a mutation of the signed plan. It scopes
  // durable page receipts to this exact signed action so a completed order in a
  // previous mission never suppresses a fresh mission in the same Amazon tab.
  action = {
    ...action,
    receiptScope: `${String(plan?.planHash || '').slice(0, 96)}:${String(action?.id || '').slice(0, 96)}`
  };
  if (action.pendingOrderContinuation === true) {
    const beforeContinuation = await chrome.tabs.get(tabId).catch(() => null);
    const pendingOrderUrlVisible = /\/(?:duplicateOrder|pending-order)(?:[/?#]|$)/i.test(String(beforeContinuation?.url || ''));
    if (pendingOrderUrlVisible) {
      await waitForTabReady(tabId, 2_500).catch(() => null);
      await delay(120);
    } else if (beforeContinuation?.url
      && !/order-confirmation|thank|order-confirmed/i.test(beforeContinuation.url)) {
      await waitForTabNavigation(tabId, beforeContinuation.url, 5_000).catch(() => null);
      await delay(180);
    }
    const activeRun = await getActiveRun();
    const priorReceiptScope = `${String(plan?.planHash || '').slice(0, 96)}:${String(action.priorFinalSubmitActionId || '').slice(0, 96)}`;
    const priorPendingOrderDispatchReceipt = await finalOrderDispatchReceiptFor(tabId, action.receiptScope);
    action = {
      ...action,
      sessionId: String(activeRun?.sessionId || ''),
      planHash: String(plan?.planHash || ''),
      priorFinalSubmitDispatched: Boolean(await finalOrderDispatchReceiptFor(tabId, priorReceiptScope)),
      priorPendingOrderDispatchReceipt,
      boundCandidate: normalizeActiveRunCandidate(activeRun?.selectedCandidate),
      boundCartEvidence: normalizeActiveRunCartEvidence(activeRun?.cartEvidence)
    };
  }
  if (plan.targetDomain === 'amazon.com' && action.type !== 'navigate') {
    const currentTab = await chrome.tabs.get(tabId).catch(() => null);
    if (currentTab?.url && !isAmazonRetailShoppingUrl(currentTab.url)) {
      const recoveryUrl = amazonActionRecoveryUrl(plan, action);
      await navigateMissionTab(tabId, recoveryUrl, { timeoutMs: 5_000 }).catch(() => null);
      await delay(300);
    }
  }
  if (action.type === 'navigate' && action.intent === 'open_cart' && action.preferExistingCartControl === true) {
    const before = await chrome.tabs.get(tabId).catch(() => ({ url: '' }));
    const outcome = await tabCommand(tabId, { type: 'MAGIC_CITY_EXECUTE_PLAN_STEP', action, checkoutProfile });
    if (!outcome?.completed) return outcome;
    if (outcome.alreadyInCart === true) {
      return {
        ...outcome,
        navigationRequested: false,
        cartFallbackUsed: false,
        state: {
          url: before?.url || action.url,
          title: before?.title || '',
          browserState: 'cart',
          browserStateConfidence: 1,
          browserStateReason: 'Amazon cart was already open; the next approved step verifies its contents.',
          checkoutSummary: { stage: 'cart', nextAction: 'Inspecting cart' },
          navigationReady: true
        }
      };
    }
    let usedFallback = Boolean(outcome.cartFallbackRequested);
    if (!usedFallback) {
      await waitForTabUrlChange(tabId, before.url, 2_500)
        .catch(() => waitForTabNavigation(tabId, before.url, 1_000).catch(() => null));
      const current = await chrome.tabs.get(tabId).catch(() => before);
      usedFallback = !current?.url || current.url === before.url;
    }
    let currentTab = await chrome.tabs.get(tabId).catch(() => before);
    if (usedFallback) {
      const navigationUrl = withAmazonEnglishLocale(action.url);
      currentTab = await navigateMissionTab(tabId, navigationUrl, {
        timeoutLabel: 'browser_cart_fallback_navigation_timeout'
      }).catch(() => ({ url: navigationUrl, title: '' }));
    } else {
      await waitForTabReady(tabId, 3_500).catch(() => null);
      currentTab = await chrome.tabs.get(tabId).catch(() => currentTab);
    }
    return {
      ...outcome,
      navigationRequested: true,
      cartFallbackUsed: usedFallback,
      controlStrategy: usedFallback ? 'stable_cart_fallback' : outcome.controlStrategy,
      state: {
        url: currentTab?.url || action.url,
        title: currentTab?.title || '',
        browserState: 'browse',
        browserStateConfidence: 0,
        browserStateReason: usedFallback
          ? 'No live Amazon cart control was available; the signed cart URL was opened.'
          : 'Amazon cart control was invoked; the next approved step verifies the cart.',
        checkoutSummary: { stage: 'browse', nextAction: 'Inspecting cart' },
        navigationReady: true
      }
    };
  }
  if (action.type === 'navigate') {
    const existingTab = await chrome.tabs.get(tabId).catch(() => null);
    if (action.preserveExistingCheckout === true && existingTab && isAmazonCheckoutResumeUrl(existingTab.url || '', plan)) {
      return {
        completed: true,
        navigationRequested: false,
        reusedExistingCheckout: true,
        state: {
          url: existingTab.url || action.url,
          title: existingTab.title || '',
          browserState: 'checkout',
          browserStateConfidence: 1,
          browserStateReason: 'The existing checkout tab was preserved for profile reconciliation.',
          checkoutSummary: { stage: 'checkout', nextAction: 'Rechecking checkout' },
          navigationReady: true
        }
      };
    }
    const navigationUrl = plan.targetDomain === 'amazon.com'
      ? withAmazonEnglishLocale(action.url)
      : action.url;
    const currentTab = await navigateMissionTab(tabId, navigationUrl);
    // Navigation is its own cheap, durable milestone. Reading the entire
    // merchant DOM here made Amazon's large search surface block the
    // checkpoint that unlocks the next inspect step. The following plan
    // action owns page-state extraction and can retry it independently.
    const state = {
      url: currentTab?.url || navigationUrl,
      title: currentTab?.title || '',
      browserState: 'browse',
      browserStateConfidence: 0,
      browserStateReason: 'Navigation completed; page state will be inspected in the next approved step.',
      checkoutSummary: { stage: 'browse', nextAction: 'Inspecting page' },
      navigationReady: true
    };
    return { completed: true, navigationRequested: true, state };
  }
  if (action.type === 'fill_checkout_profile') {
    const outcome = await runCheckoutProfileReconcile(tabId, action, checkoutProfile, assertActive);
    return enforceAmazonRetailLane(tabId, action, plan, checkoutProfile, outcome);
  }
  if (action.type === 'inspect' && action.awaitMerchantOrderConfirmation === true) {
    const deadlineAt = Date.parse(String(action.merchantConfirmationDeadlineAt || ''));
    const remainingMs = Number.isFinite(deadlineAt) ? Math.max(0, deadlineAt - Date.now()) : null;
    const outcome = await waitForMerchantOrderConfirmation(tabId, checkoutProfile, assertActive, {
      // The active website-to-extension port keeps normal execution alive.
      // Observe the whole signed confirmation window here; alarms are only a
      // fallback if Chrome actually terminates the worker.
      timeoutMs: remainingMs == null ? MERCHANT_ORDER_CONFIRMATION_TIMEOUT_MS : remainingMs
    });
    return enforceAmazonRetailLane(tabId, action, plan, checkoutProfile, outcome);
  }
  if (action.type === 'inspect' || action.type === 'pause') {
    const outcome = {
      completed: true,
      state: await tabBrowserState(tabId, checkoutProfile, { attempts: 2, delayMs: 180 })
    };
    return enforceAmazonRetailLane(tabId, action, plan, checkoutProfile, outcome);
  }
  if (action.type === 'select_candidate') {
    const currentTab = await chrome.tabs.get(tabId).catch(() => null);
    let currentPath = '';
    const currentDomain = currentTab?.url ? domainForUrl(currentTab.url) : '';
    try {
      currentPath = currentTab?.url ? new URL(currentTab.url).pathname || '' : '';
    } catch {
      currentPath = '';
    }
    const amazonFastPathAllowed = plan.targetDomain === 'amazon.com'
      || currentDomain === '127.0.0.1'
      || currentDomain === 'localhost';
    const searchSurfaceAllowed = plan.targetDomain === 'amazon.com'
      ? /^\/s(?:\/|$)/i.test(currentPath)
      : Boolean(currentPath);
    if (amazonFastPathAllowed && searchSurfaceAllowed) {
      const quickOutcome = await amazonSearchCardAddToCart(tabId, action);
      if (quickOutcome?.browserActionIndeterminate === true) {
        const error = new Error(quickOutcome.reason || 'amazon_search_card_fast_path_outcome_unknown');
        error.browserActionIndeterminate = true;
        throw error;
      }
      if (quickOutcome?.completed) {
        return completeAmazonSelectionOutcome(tabId, plan, action, quickOutcome, checkoutProfile);
      }
      const intelligenceOutcome = await consultAmazonSelectionIntelligence(session, plan, action, quickOutcome, tabId);
      if (intelligenceOutcome) {
        return completeAmazonSelectionOutcome(tabId, plan, action, intelligenceOutcome, checkoutProfile);
      }
      if (quickOutcome?.selectionDecisionMade === true) return quickOutcome;
    }
  }
  if (action.type === 'click_intent'
    && action.intent === 'add_to_cart'
    && plan.targetDomain === 'amazon.com'
    && action.boundCandidate?.cartActionStarted === true) {
    return {
      completed: true,
      directSearchResultCart: true,
      alreadyStarted: true,
      label: 'Add to cart',
      controlStrategy: 'amazon_search_card_fast_path_already_started',
      selected: {
        id: action.boundCandidate.id,
        asin: action.boundCandidate.asin,
        title: action.boundCandidate.title,
        url: action.boundCandidate.url,
        price: action.boundCandidate.price
      },
      state: {
        url: (await chrome.tabs.get(tabId).catch(() => ({ url: '' }))).url || '',
        title: '',
        interactionLayer: 'page',
        loginRequired: false,
        paymentRequired: false,
        finalApprovalVisible: false,
        providerChallenge: false,
        productOpened: false,
        addToCartAvailable: false,
        browserState: 'search_results',
        browserSurface: 'search_results',
        browserStateConfidence: 1,
        browserStateReason: 'The exact Amazon result-card Add to cart click was already sent; the next step verifies the cart.',
        milestoneSignals: {
          candidateSelected: true,
          cartVisible: false,
          checkoutOpen: false,
          addressConfirmed: false,
          cardConfirmed: false,
          deliveryConfirmed: false,
          checkoutProfileVerified: false,
          finalReviewReady: false,
          orderSubmitted: false
        },
        checkoutSummary: { stage: 'search_results', nextAction: 'Opening cart' },
        observationDurationMs: 0
      }
    };
  }
  let before = await chrome.tabs.get(tabId);
  let outcome = await tabCommand(tabId, { type: 'MAGIC_CITY_EXECUTE_PLAN_STEP', action, checkoutProfile });
  if (action.type === 'select_candidate' && outcome?.directSearchResultCart === true) {
    const cartAdvance = await advanceAmazonAddedItemToCart(tabId, checkoutProfile, amazonCartRecoveryUrl(plan));
    if (cartAdvance.advanced) {
      return {
        ...outcome,
        postAddCartOpened: true,
        cartOpenControlStrategy: cartAdvance.outcome?.controlStrategy || null,
        cartOpenAttempts: cartAdvance.attempts,
        state: cartAdvance.state || outcome.state || null
      };
    }
    await delay(250);
    return {
      ...outcome,
      state: await tabBrowserState(tabId, checkoutProfile, { attempts: 3, delayMs: 220 }).catch(() => outcome.state || null)
    };
  }
  if (action.type === 'select_candidate' && outcome?.navigationRequested && !outcome.navigationUrl) {
    const state = await tabBrowserState(tabId, checkoutProfile, { attempts: 2, delayMs: 180 }).catch(() => null);
    return {
      ...outcome,
      completed: false,
      navigationConfirmed: false,
      state,
      reason: 'The browser selected a candidate but did not return a product URL to open.'
    };
  }
  if (action.type === 'click_intent' && action.intent === 'prefer_free_delivery' && outcome?.completed) {
    await delay(250);
    await waitForTabReady(tabId).catch(() => null);
    await delay(300);
    let filteredTab = await chrome.tabs.get(tabId).catch(() => ({ url: '' }));
    if (plan.targetDomain === 'amazon.com' && !isAmazonRetailShoppingUrl(filteredTab.url || '')) {
      await navigateMissionTab(tabId, withAmazonEnglishLocale(plan.startUrl), { timeoutMs: 5_000 }).catch(() => null);
      await delay(300);
      return {
        ...outcome,
        completed: true,
        skipped: true,
        filterApplied: false,
        navigationRecovered: true,
        reason: 'Ignored a non-shopping Amazon navigation while applying the delivery preference.',
        state: await tabBrowserState(tabId, checkoutProfile, { attempts: 3, delayMs: 180 }).catch(() => outcome.state || null)
      };
    }
    if (plan.targetDomain === 'amazon.com') {
      const englishUrl = withAmazonEnglishLocale(filteredTab.url || '');
      if (englishUrl && englishUrl !== filteredTab.url) {
        await navigateMissionTab(tabId, englishUrl, { timeoutMs: 5_000 }).catch(() => null);
        await delay(250);
        filteredTab = await chrome.tabs.get(tabId).catch(() => filteredTab);
      }
    }
    outcome.state = await tabBrowserState(tabId, checkoutProfile, { attempts: 4, delayMs: 220 }).catch(() => outcome.state || null);
    return outcome;
  }
  if (outcome?.stateRefreshRequested && outcome.completed && !outcome.skipped) {
    await delay(450);
    return {
      ...outcome,
      state: await tabBrowserState(tabId, checkoutProfile, { attempts: 4, delayMs: 220 }).catch(() => outcome.state || null)
    };
  }
  const postActionTab = await chrome.tabs.get(tabId).catch(() => ({ url: before.url || '' }));
  const actionNavigated = Boolean(outcome?.navigationRequested) || postActionTab.url !== before.url;
  if (actionNavigated && outcome?.completed && !outcome.skipped) {
    if (!outcome.navigationRequested) outcome = { ...outcome, navigationRequested: true };
    if (action.type === 'select_candidate' && outcome.navigationUrl) {
      if (domainForUrl(outcome.navigationUrl) !== plan.targetDomain) {
        return { ...outcome, completed: false, reason: 'The selected product URL left the approved mission domain.' };
      }
      if (plan.targetDomain === 'amazon.com' && !isAmazonRetailProductUrl(outcome.navigationUrl)) {
        return { ...outcome, completed: false, reason: 'The selected Amazon result was not a retail product URL.' };
      }
      const navigation = await confirmCandidateNavigation(tabId, plan, outcome.navigationUrl, before.url);
      outcome = {
        ...outcome,
        navigationConfirmed: navigation.confirmed,
        navigationAttempts: navigation.attempts,
        requestedNavigationUrl: navigation.requestedUrl,
        observedNavigationUrl: navigation.observedUrl
      };
      if (!navigation.confirmed) {
        const state = await tabBrowserState(tabId, checkoutProfile, { attempts: 2, delayMs: 180 }).catch(() => null);
        return {
          ...outcome,
          completed: false,
          state,
          reason: candidateSelectionFailureReason(action, {
            ...(state || {}),
            url: navigation.observedUrl,
            navigationConfirmed: false
          }, outcome)
        };
      }
    }
    if (action.type !== 'select_candidate') {
      if (action.type === 'click_intent' && action.intent === 'checkout') {
        await waitForTabUrlChange(tabId, before.url, 2_500)
          .catch(() => waitForTabNavigation(tabId, before.url, 3_500).catch(() => null));
        outcome = await recoverAmazonCheckoutPrelude(tabId, plan, outcome);
        await waitForTabReady(tabId, 3_500).catch(() => null);
        await delay(300);
      } else {
        await waitForTabNavigation(tabId, before.url, 9000).catch(() => null);
        await delay(650);
      }
    } else {
      await delay(250);
    }
    if (action.type === 'select_candidate') {
      let selectedState = await waitForPurchasableProduct(tabId, checkoutProfile);
      const selectedProductPrice = parseUsdAmount(selectedState?.checkoutSummary?.productPrice);
      const selectedPriceWithinCap = !Number.isFinite(Number(action.maxPrice))
        || Number(action.maxPrice) <= 0
        || !Number.isFinite(selectedProductPrice)
        || selectedProductPrice <= Number(action.maxPrice) + 0.005;
      if ((selectedState?.addToCartAvailable || String(selectedState?.checkoutSummary?.stage || '') === 'cart')
        && productStateSatisfiesFulfillmentPolicy(selectedState, action)
        && selectedPriceWithinCap) {
        return { ...outcome, state: selectedState };
      }
      const alternatives = Array.isArray(outcome.alternatives) ? outcome.alternatives.slice(0, 4) : [];
      let fallbackAttempts = 0;
      for (const alternative of alternatives) {
        if (!alternative?.url || domainForUrl(alternative.url) !== plan.targetDomain) continue;
        if (plan.targetDomain === 'amazon.com' && !isAmazonRetailProductUrl(alternative.url)) continue;
        if (typeof assertActive === 'function') await assertActive();
        fallbackAttempts += 1;
        const previous = await chrome.tabs.get(tabId).catch(() => ({ url: '' }));
        const navigation = await confirmCandidateNavigation(tabId, plan, alternative.url, previous.url);
        if (!navigation.confirmed) continue;
        await delay(250);
        selectedState = await waitForPurchasableProduct(tabId, checkoutProfile, { timeoutMs: 3_200, intervalMs: 320 });
        const alternativeProductPrice = parseUsdAmount(selectedState?.checkoutSummary?.productPrice);
        const alternativePriceWithinCap = !Number.isFinite(Number(action.maxPrice))
          || Number(action.maxPrice) <= 0
          || !Number.isFinite(alternativeProductPrice)
          || alternativeProductPrice <= Number(action.maxPrice) + 0.005;
        if ((selectedState?.addToCartAvailable || String(selectedState?.checkoutSummary?.stage || '') === 'cart')
          && productStateSatisfiesFulfillmentPolicy(selectedState, action)
          && alternativePriceWithinCap) {
          return {
            ...outcome,
            selected: alternative,
            fallbackAttempts,
            navigationConfirmed: true,
            observedNavigationUrl: navigation.observedUrl,
            state: selectedState
          };
        }
      }
      return {
        ...outcome,
        completed: false,
        fallbackAttempts,
        reason: productFulfillmentFailureReason(selectedState, action) || (alternatives.length
          ? 'Matching results were opened, but none exposed a purchasable item within the approved item budget.'
          : 'The matching product page was not purchasable within the approved item budget.'),
        state: selectedState
      };
    }
    if (action.type === 'click_intent' && action.intent === 'checkout') {
      let continuationAttempts = 0;
      let currentTab = await chrome.tabs.get(tabId).catch(() => ({ url: '' }));
      while (continuationAttempts < 2
        && isAmazonCartContinuationUrl(currentTab.url || '')) {
        if (typeof assertActive === 'function') await assertActive();
        const continuation = await tabCommand(tabId, {
          type: 'MAGIC_CITY_EXECUTE_PLAN_STEP',
          action,
          checkoutProfile
        });
        if (!continuation?.completed || !continuation.navigationRequested || continuation.checkoutInterstitialContinued !== true) break;
        continuationAttempts += 1;
        await waitForTabNavigation(tabId, currentTab.url, 9000).catch(() => null);
        await delay(650);
        currentTab = await chrome.tabs.get(tabId).catch(() => ({ url: '' }));
        outcome = {
          ...outcome,
          ...continuation,
          checkoutInterstitialContinued: true,
          checkoutInterstitialAttempts: continuationAttempts
        };
      }
    }
    if (action.type === 'final_submit') {
      return enforceAmazonRetailLane(tabId, action, plan, checkoutProfile, {
        ...outcome,
        state: await tabBrowserState(tabId, checkoutProfile)
      });
    }
    if (action.type === 'click_intent' && action.intent === 'checkout' && checkoutProfile) {
      outcome = await recoverAmazonCheckoutPrelude(tabId, plan, outcome);
      let observedState = await tabBrowserState(tabId, checkoutProfile);
      // Some cart variants settle on Amazon's neutral /alm/byg page a beat
      // after the first navigation observer. Re-check here before attempting
      // profile reconciliation so the checkout action is not marked terminal.
      let checkoutTab = await chrome.tabs.get(tabId).catch(() => ({ url: '' }));
      if (isAmazonCartContinuationUrl(checkoutTab.url || '')) {
        await waitForTabReady(tabId, 4_500).catch(() => null);
        checkoutTab = await chrome.tabs.get(tabId).catch(() => checkoutTab);
        if (isAmazonCartContinuationUrl(checkoutTab.url || '')) {
          const continuation = await tabCommand(tabId, {
            type: 'MAGIC_CITY_EXECUTE_PLAN_STEP',
            action,
            checkoutProfile
          });
          if (continuation?.completed && continuation.navigationRequested && continuation.checkoutInterstitialContinued === true) {
            await waitForTabNavigation(tabId, checkoutTab.url, 9_000).catch(() => null);
            await delay(650);
            observedState = await tabBrowserState(tabId, checkoutProfile);
            outcome = {
              ...outcome,
              ...continuation,
              checkoutInterstitialContinued: true,
              checkoutInterstitialAttempts: Math.max(1, Number(outcome.checkoutInterstitialAttempts || 0) + 1)
            };
          }
        }
      }
      if (String(observedState.checkoutSummary?.stage || observedState.browserState || '').toLowerCase() === 'cart'
        && observedState.milestoneSignals?.checkoutOpen !== true) {
        if (typeof assertActive === 'function') await assertActive();
        const intermediate = await chrome.tabs.get(tabId).catch(() => ({ url: '' }));
        const continuation = await tabCommand(tabId, {
          type: 'MAGIC_CITY_EXECUTE_PLAN_STEP',
          action,
          checkoutProfile
        });
        if (continuation?.completed && continuation.navigationRequested && !continuation.skipped) {
          await waitForTabNavigation(tabId, intermediate.url, 9000).catch(() => null);
          await delay(650);
          observedState = await tabBrowserState(tabId, checkoutProfile);
        }
        outcome = {
          ...outcome,
          ...continuation,
          safeFieldsFilled: mergeUnique(outcome.safeFieldsFilled, continuation?.safeFieldsFilled),
          checkoutSelections: mergeUnique(outcome.checkoutSelections, continuation?.checkoutSelections),
          state: observedState
        };
      }
      // Opening checkout is navigation only. Address, card, and delivery
      // changes are a separate signed `fill_checkout_profile` plan action.
      return { ...outcome, state: await tabBrowserState(tabId, checkoutProfile) };
    }
    const state = await tabBrowserState(tabId, checkoutProfile);
    return enforceAmazonRetailLane(tabId, action, plan, checkoutProfile, { ...outcome, state });
  }
  return outcome || { completed: false, reason: 'The local browser action did not return a result.' };
}

async function runSession(rawSession, { onClaimAccepted = null } = {}) {
  if (inFlightSessionIds.has(rawSession.id)) return { sessionId: rawSession.id, status: 'already_running' };
  inFlightSessionIds.add(rawSession.id);
  let session = rawSession;
  let plan = null;
  let currentAction = null;
  let currentActionStartedAt = 0;
  let retainActiveRun = false;
  const startupTiming = {
    clientRunStartedAt: String(rawSession?.runnerClientRunStartedAt || '').trim() || null,
    wakeReceivedAt: String(rawSession?.runnerWakeReceivedAt || '').trim() || null,
    runStartedAt: new Date().toISOString()
  };
  try {
    // Read durable state before claiming. An MV3 restart may be resuming an
    // action after the browser accepted its click but before a checkpoint was
    // recorded, so overwriting this marker would make the action replayable.
    const persistedActiveRun = await getActiveRun();
    const resumingPersistedRun = Boolean(persistedActiveRun?.sessionId === rawSession.id);
    if (!resumingPersistedRun) {
      // Persist before the remote claim. If MV3 is suspended after the server
      // accepts the claim, the gateway can recover this exact signed session.
      startupTiming.claimStartedAt = new Date().toISOString();
      await saveActiveRun({
        sessionId: rawSession.id,
        phase: 'claiming',
        progressLabel: 'Claiming mission',
        progressState: 'claiming',
        startupTiming
      });
    }
    await saveConfig({
      lastError: '',
      lastExecution: { sessionId: rawSession.id, status: 'claiming', at: new Date().toISOString() }
    });
    scheduleRunnerResume(8_000);
    if (!startupTiming.claimStartedAt) startupTiming.claimStartedAt = new Date().toISOString();
    session = await claimSession(rawSession);
    if (typeof onClaimAccepted === 'function') onClaimAccepted(session);
    let authorityVerifiedAt = Date.now();
    startupTiming.claimAcceptedAt = new Date().toISOString();
    startupTiming.claimDurationMs = Math.max(0, Date.parse(startupTiming.claimAcceptedAt) - Date.parse(startupTiming.claimStartedAt));
    if (!resumingPersistedRun) {
      await saveActiveRun({
        sessionId: session.id,
        phase: 'claimed',
        progressLabel: 'Validating mission',
        progressState: 'validating',
        startupTiming
      });
    }
    await saveConfig({
      lastError: '',
      lastExecution: { sessionId: session.id, status: 'claimed', at: new Date().toISOString() }
    });
    // One bounded recovery opportunity protects an already-authorized run
    // from MV3 service-worker suspension without turning alarms into a
    // background mission discovery loop.
    scheduleRunnerResume(8_000);
    plan = await validatePlanForSession(session);
    assertLocalMissionAuthority(session);
    startupTiming.planValidatedAt = new Date().toISOString();
    await bindLocalCheckoutProfileToPlan(session.id, plan.planHash);
    const savedCheckoutProfile = await getLocalCheckoutProfile(session.id, plan.planHash);
    startupTiming.profileBoundAt = new Date().toISOString();
    const checkoutProfileExpected = Boolean(session.extensionCheckoutProfileEnabled);
    const checkoutProfileAvailable = Boolean(savedCheckoutProfile);
    const checkoutProfile = savedCheckoutProfile ? { ...savedCheckoutProfile } : null;
    const startUrl = plan.startUrl;
    const planState = session.extensionMissionPlanState?.planHash === plan.planHash
      ? session.extensionMissionPlanState
      : { nextActionIndex: 0 };
    const interruptedRun = resumingPersistedRun ? persistedActiveRun : await getActiveRun();
    let finalSubmitAuthorityLease = normalizeFinalSubmitAuthorityLease(interruptedRun?.finalSubmitAuthorityLease);
    const resumesInterruptedAction = Boolean(
      interruptedRun?.sessionId === session.id
      && interruptedRun.phase === 'executing_step'
      && Number(interruptedRun.actionIndex) === Number(planState.nextActionIndex || 0)
      && String(interruptedRun.actionId || '').trim()
    );
    await saveActiveRun({
      sessionId: session.id,
      planHash: plan.planHash,
      phase: resumesInterruptedAction ? 'executing_step' : 'running',
      progressLabel: 'Starting browser',
      progressState: 'starting_browser',
      startupTiming,
      nextActionIndex: Number(planState.nextActionIndex || 0),
      ...(resumesInterruptedAction ? {
        actionId: interruptedRun.actionId,
        actionIndex: Number(interruptedRun.actionIndex)
      } : {})
    });
    const completedActionIds = new Set(Array.isArray(planState.completedActionIds) ? planState.completedActionIds : []);
    const persistedMilestones = Array.isArray(planState.verifiedMilestones) ? planState.verifiedMilestones : [];
    const nextAction = plan.actions[Number(planState.nextActionIndex || 0)];
    if (!nextAction) return reconcileCompletedPlan(session, plan, planState, checkoutProfile);
    if (String(session.status || '').toLowerCase() !== 'executing') {
      startupTiming.startupCheckpointStartedAt = new Date().toISOString();
      session = await checkpointRunnerStartup(session, plan, nextAction, startupTiming);
      authorityVerifiedAt = Date.now();
      startupTiming.startupCheckpointAcceptedAt = new Date().toISOString();
      startupTiming.startupCheckpointDurationMs = Math.max(
        0,
        Date.parse(startupTiming.startupCheckpointAcceptedAt) - Date.parse(startupTiming.startupCheckpointStartedAt)
      );
      await saveActiveRun({
        sessionId: session.id,
        planHash: plan.planHash,
        phase: resumesInterruptedAction ? 'executing_step' : 'running',
        progressLabel: 'Opening Amazon',
        progressState: 'opening_browser',
        startupTiming
      });
    }
    if (!await hasPermissionForUrl(startUrl)) {
      const domain = domainForUrl(startUrl);
      session = await missionCheckpoint(session, {
        label: 'Browser access needed',
        detail: `Allow ${domain} in Magic City Runner to start this mission locally.`,
        state: 'permission_required',
        missionAction: nextAction.missionAction,
        targetUrl: startUrl,
        plan,
        planAction: nextAction,
        planActionStatus: 'waiting'
      });
      await saveConfig({
        lastError: `Browser access is needed for ${domain}. Open Magic City Runner and choose Allow ${domain} and start.`,
        lastExecution: { sessionId: session.id, status: 'permission_required', domain, at: new Date().toISOString() }
      });
      await chrome.action.setBadgeText({ text: '!' });
      await chrome.action.setBadgeBackgroundColor({ color: '#e8b84a' });
      return { sessionId: session.id, status: 'permission_required', domain };
    }

    await chrome.action.setBadgeText({ text: '' });
    let tab = await acquireMissionTab(session.id, startUrl, {
      preferExistingCheckout: plan.resumeCheckoutReconcile === true,
      plan
    });
    startupTiming.browserTabAcquiredAt = new Date().toISOString();
    await saveActiveRun({
      sessionId: session.id,
      planHash: plan.planHash,
      phase: resumesInterruptedAction ? 'executing_step' : 'running',
      progressLabel: 'Browser ready',
      progressState: 'browser_ready',
      startupTiming,
      tabId: Number(tab?.id || 0) || null,
      nextActionIndex: Number(planState.nextActionIndex || 0),
      ...(resumesInterruptedAction ? {
        actionId: interruptedRun.actionId,
        actionIndex: Number(interruptedRun.actionIndex)
      } : {})
    });
    const assertActive = async ({ force = false, localOnly = false } = {}) => {
      assertLocalMissionAuthority(session);
      if (localOnly || (!force && Date.now() - authorityVerifiedAt < RUNNER_STATUS_LEASE_MS)) return session;
      session = await assertRunnerSessionActive(session);
      authorityVerifiedAt = Date.now();
      assertLocalMissionAuthority(session);
      return session;
    };
    const progress = {
      productOpened: persistedMilestones.includes('candidate_selected'),
      addToCartClicked: persistedMilestones.includes('cart_confirmed'),
      checkoutOpened: persistedMilestones.includes('checkout_open'),
      verifiedMilestones: [...new Set(persistedMilestones)],
      safeFieldsFilled: normalizeActiveRunEvidenceLabels(interruptedRun?.safeFieldsFilled),
      checkoutSelections: normalizeActiveRunEvidenceLabels(interruptedRun?.checkoutSelections),
      selectedCandidate: null,
      cartEvidence: normalizeActiveRunCartEvidence(interruptedRun?.cartEvidence),
      initialCartItemCount: null,
      reusedPreparedCart: false,
      localCheckoutProfileExpected: checkoutProfileExpected,
      localCheckoutProfileAvailable: checkoutProfileAvailable,
      directSearchResultCart: false
    };
    if (interruptedRun?.selectedCandidate) {
      progress.selectedCandidate = normalizeActiveRunCandidate(interruptedRun.selectedCandidate);
    }
    const pendingPaymentWait = await getPendingPaymentWait(session.id);
    if (pendingPaymentWait && tab) {
      if (checkoutProfileExpected && !checkoutProfileAvailable) {
        await clearPendingPaymentWait(session.id);
        return reportAndStop(session, plan, {
          url: tab.url || startUrl,
          finalUrl: tab.url || startUrl,
          stopState: 'local_checkout_profile_missing',
          stopEvidence: 'Card autofill was not completed before the checkout wait elapsed. Reopen the checkout and use Chrome autofill to continue.',
          fulfillmentStatus: 'failed',
          fundingDisposition: 'release',
          ...progress
        });
      }
      const paymentState = await tabBrowserState(tab.id, checkoutProfile, { attempts: 3 }).catch(() => null);
      if (paymentState && canWaitForPaymentAutofill(paymentState, plan)) {
        if (Number(pendingPaymentWait.expiresAt || 0) <= Date.now()) {
          await clearPendingPaymentWait(session.id);
          paymentState.paymentAutofillWaitExpired = true;
          paymentState.stopState = 'payment_required';
          paymentState.stopEvidence = 'Card entry was not completed before the checkout wait elapsed. Reopen the checkout and use Chrome autofill to continue.';
          return reportAndStop(session, plan, { ...paymentState, ...progress });
        }
        const parked = await parkForPaymentAutofill(session, plan, { ...paymentState, ...progress });
        if (parked?.waiting) {
          retainActiveRun = true;
          return parked;
        }
      }
      await clearPendingPaymentWait(session.id);
      await chrome.action.setBadgeText({ text: '' });
    }
    for (let index = Number(planState.nextActionIndex || 0); index < plan.actions.length; index += 1) {
      const action = plan.actions[index];
      const presentation = planActionPresentation(action);
      currentAction = action;
      currentActionStartedAt = Date.now();
      const durableRun = await getActiveRun();
      if (!progress.selectedCandidate && durableRun?.selectedCandidate) {
        progress.selectedCandidate = normalizeActiveRunCandidate(durableRun.selectedCandidate);
      }
      const recoveringInterruptedAction = Boolean(
        durableRun?.sessionId === session.id
        && durableRun.phase === 'executing_step'
        && durableRun.actionId === action.id
      );
      await saveActiveRun({
        sessionId: session.id,
        planHash: plan.planHash,
        phase: 'executing_step',
        tabId: Number(tab?.id || 0) || null,
        actionId: action.id,
        actionIndex: index,
        nextActionIndex: index,
        progressLabel: presentation.label,
        progressState: presentation.state,
        selectedCandidate: progress.selectedCandidate
      });
      // A worker can restart after Amazon accepted the irreversible click but
      // before the runner reports it. On an order-confirmation page, recover
      // that observed fact without demanding a new click lease or replaying
      // the merchant control. Every other final-submit surface still needs a
      // fresh, scoped local lease before it can dispatch a click.
      const recoveredState = recoveringInterruptedAction && tab
        ? await tabBrowserState(tab.id, checkoutProfile, { attempts: 2, delayMs: 180 }).catch(() => null)
        : null;
      const recoveredFinalOrderAlreadyConfirmed = action.type === 'final_submit'
        && hasConfirmedMerchantOrder(recoveredState);
      // A slow control-plane heartbeat must not race Amazon's irreversible
      // button, but this is not an unlimited offline bypass. The signed
      // capability must still be current and the runner must have observed a
      // live session within one short lease window before dispatch.
      if (action.type === 'final_submit' && !recoveredFinalOrderAlreadyConfirmed) {
	        const leaseScopeChangedAfterCheckpoint = Boolean(
	          resumingPersistedRun
	          && finalSubmitAuthorityLease
	          && (
	            finalSubmitAuthorityLease.sessionId !== String(session.id || '').trim()
	            || finalSubmitAuthorityLease.planHash !== String(plan.planHash || '').trim()
	            || finalSubmitAuthorityLease.actionId !== String(action.id || '').trim()
	          )
	        );
	        if (leaseScopeChangedAfterCheckpoint) {
	          finalSubmitAuthorityLease = null;
	          await saveActiveRun({ finalSubmitAuthorityLease: null });
	        }
	        if (!finalSubmitAuthorityLease) {
	          const recoveredAuthority = await recoverMissingFinalSubmitAuthorityLease(session, plan, action);
	          session = recoveredAuthority.session;
	          finalSubmitAuthorityLease = recoveredAuthority.lease;
	          if (finalSubmitAuthorityLease) {
	            authorityVerifiedAt = Date.now();
	            await saveActiveRun({ finalSubmitAuthorityLease });
	          }
	        }
        assertFinalSubmitLocalAuthority(session, finalSubmitAuthorityLease, plan, action);
        if (session.finalSubmitChainAuthorization) {
          session = await assertFinalSubmitChainAuthorization(session, plan, action);
        }
      } else {
        await assertActive();
      }
      if (!tab && action.type !== 'navigate') {
        return reportAndStop(session, plan, {
          url: startUrl,
          finalUrl: startUrl,
          stopState: 'runner_tab_unavailable',
          stopEvidence: 'The local browser tab was closed before the next approved step.',
          ...progress
        });
      }
      if (action.type === 'navigate' && !tab) {
        tab = await chrome.tabs.create({ url: 'about:blank', active: false });
        await saveMissionTab(session.id, tab.id);
      }
      if (action.type === 'fill_checkout_profile' && checkoutProfileExpected && !checkoutProfileAvailable) {
      const browser = tab ? await tabCommand(tab.id, { type: 'MAGIC_CITY_BROWSER_STATE' }).catch(() => null) : null;
        return reportAndStop(session, plan, {
          ...(browser || {}),
          url: browser?.url || startUrl,
          finalUrl: browser?.url || startUrl,
          stopState: 'local_checkout_profile_missing',
          stopEvidence: 'Magic City Runner did not have the local checkout profile for this session. Unlock the Local Data Vault and retry so the extension can reconcile saved address, card label, and delivery preferences.',
          ...progress
        });
      }
      const reuseVerifiedCart = action.type === 'click_intent'
        && action.intent === 'add_to_cart'
        && progress.reusedPreparedCart === true
        && progress.verifiedMilestones.includes('cart_confirmed');
      const executionAction = action.type === 'click_intent'
        && action.intent === 'add_to_cart'
        && progress.selectedCandidate
        ? {
            ...action,
            boundCandidate: progress.selectedCandidate,
            maxPrice: Number.isFinite(Number(action.maxPrice))
              ? Number(action.maxPrice)
              : Number(plan.maxPrice || 0) || undefined
          }
        : action.awaitMerchantOrderConfirmation === true
          ? {
              ...action,
              merchantConfirmationDeadlineAt: (() => {
                const persistedDeadline = Date.parse(String(durableRun?.merchantConfirmationDeadlineAt || ''));
                if (Number.isFinite(persistedDeadline)) return new Date(persistedDeadline).toISOString();
                const signedWindowMs = Math.max(
                  MIN_MERCHANT_ORDER_CONFIRMATION_TIMEOUT_MS,
                  Math.min(
                    MAX_MERCHANT_ORDER_CONFIRMATION_TIMEOUT_MS,
                    Number(action.merchantConfirmationTimeoutMs) || MERCHANT_ORDER_CONFIRMATION_TIMEOUT_MS
                  )
                );
                return new Date(Date.now() + signedWindowMs).toISOString();
              })()
            }
          : action;
      if (action.awaitMerchantOrderConfirmation === true) {
        const confirmationDeadlineAt = String(executionAction.merchantConfirmationDeadlineAt || '');
        const confirmationDeadlineMs = Date.parse(confirmationDeadlineAt);
        await saveActiveRun({
          sessionId: session.id,
          planHash: plan.planHash,
          phase: 'awaiting_merchant_confirmation',
          tabId: Number(tab?.id || 0) || null,
          actionId: action.id,
          actionIndex: index,
          nextActionIndex: index,
          selectedCandidate: progress.selectedCandidate,
          merchantConfirmationStartedAt: durableRun?.merchantConfirmationStartedAt || new Date().toISOString(),
          merchantConfirmationDeadlineAt: confirmationDeadlineAt,
          merchantConfirmationAttempts: Math.max(0, Number(durableRun?.merchantConfirmationAttempts || 0))
        });
        if (Number.isFinite(confirmationDeadlineMs) && confirmationDeadlineMs <= Date.now()) {
          const state = await tabBrowserState(tab.id, checkoutProfile, { attempts: 2, delayMs: 180 }).catch(() => null);
          if (state?.orderSubmitted || state?.milestoneSignals?.orderSubmitted) {
            return reportAndStop(session, plan, {
              ...(state || {}),
              ...progress,
              finalSubmitRequested: true,
              orderSubmitted: true,
              merchantOrderConfirmation: {
                confirmed: true,
                observedAt: new Date().toISOString(),
                waitMs: 0
              }
            });
          }
          return reportAndStop(session, plan, {
            ...(state || {}),
            ...progress,
            finalSubmitRequested: true,
            orderSubmitted: false,
            merchantOrderConfirmation: {
              confirmed: false,
              reason: 'merchant_confirmation_deadline_expired',
              waitMs: 0
            }
          });
        }
      }
      const resumedActionAlreadySatisfied = recoveredState
        ? actionWasSatisfiedBeforeRestart(executionAction, recoveredState)
        : false;
      let outcome = reuseVerifiedCart
        ? {
            completed: true,
            skipped: false,
            controlStrategy: null,
            reason: 'The approved cart item is already prepared and verified; not adding a duplicate.',
            state: await tabBrowserState(tab.id, checkoutProfile, { attempts: 2, delayMs: 180 })
          }
        : resumedActionAlreadySatisfied
          ? {
              completed: true,
              skipped: false,
              recoveredFromInterruption: true,
              finalSubmitRequested: action.type === 'final_submit' && Boolean(recoveredState?.orderSubmitted || recoveredState?.milestoneSignals?.orderSubmitted),
              orderSubmitted: action.type === 'final_submit' && Boolean(recoveredState?.orderSubmitted || recoveredState?.milestoneSignals?.orderSubmitted),
              reason: 'Recovered the interrupted browser step from its already-verified merchant state.',
              state: recoveredState
            }
        : await withTimeout(
            () => executePlanAction(tab.id, executionAction, plan, checkoutProfile, assertActive, session),
            action.awaitMerchantOrderConfirmation === true
              ? Math.min(
                  MAX_MERCHANT_ORDER_CONFIRMATION_TIMEOUT_MS + 5_000,
                  Math.max(BROWSER_ACTION_TIMEOUT_MS, Number(action.merchantConfirmationTimeoutMs || 0) + 5_000)
                )
              : BROWSER_ACTION_TIMEOUT_MS,
            `browser_step_timeout:${action.id}`
          );
      if (resumesInterruptedAction && outcome?.completed && !outcome.recoveredFromInterruption) {
        outcome = {
          ...outcome,
          recoveredFromInterruption: true,
          reason: outcome.reason || 'Resumed the interrupted browser step and verified its merchant result.'
        };
      }
      const actionDurationMs = Date.now() - currentActionStartedAt;
      if (action.type === 'select_candidate' && outcome?.selected) {
        progress.selectedCandidate = {
          ...outcome.selected,
          cartActionStarted: Boolean(outcome.directSearchResultCart || outcome.selected.cartActionStarted)
        };
        progress.directSearchResultCart = Boolean(outcome.directSearchResultCart);
      }
      let report = outcome.state || await tabCommand(tab.id, { type: 'MAGIC_CITY_BROWSER_STATE' });
      const observedCartEvidence = verifiedCartEvidenceFor(report, progress.selectedCandidate, session, plan);
      if (observedCartEvidence) {
        progress.cartEvidence = observedCartEvidence;
        // Keep the exact cart identity available if the server commits this
        // checkpoint but its response is lost. Recovery may advance directly
        // to the signed pending-order continuation without reinspecting or
        // mutating the cart.
        await saveActiveRun({ cartEvidence: observedCartEvidence });
      }
      if (action.type === 'final_submit' && Array.isArray(outcome.finalSubmitReceipts)) {
        // The executor returns both pre-navigation receipts in its signed
        // action response. Preserve that explicit pair even if a merchant
        // navigation or a later page observation exposes only one of them.
        report.browserActionReceipts = mergeBrowserActionReceipts(
          Array.isArray(report.browserActionReceipts) ? report.browserActionReceipts : [],
          outcome.finalSubmitReceipts
        );
      }
      if (action.type === 'final_submit' && outcome.finalSubmitReceipt) {
        // submitFinalOrder returns the pre-dispatch receipt so this action is
        // non-replayable even if Amazon unloads the page. Give the queued
        // native click one event-loop turn, then capture its dispatched
        // receipt in the same signed checkpoint whenever the tab is readable.
        // A navigation failure here never causes another merchant click.
        await delay(260);
        const dispatchedState = await tabCommand(tab.id, { type: 'MAGIC_CITY_BROWSER_STATE' }).catch(() => null);
        if (dispatchedState?.browserActionReceipts?.length) {
          const priorReceipts = Array.isArray(report.browserActionReceipts) ? report.browserActionReceipts : [];
          report = {
            ...report,
            ...dispatchedState,
            browserActionReceipts: mergeBrowserActionReceipts(
              priorReceipts,
              dispatchedState.browserActionReceipts
            )
          };
        }
        const dispatchedReceipt = await finalOrderDispatchReceiptFor(tab.id, action.receiptScope);
        if (dispatchedReceipt) {
          report.browserActionReceipts = mergeBrowserActionReceipts(
            Array.isArray(report.browserActionReceipts) ? report.browserActionReceipts : [],
            [dispatchedReceipt]
          );
        }
      }
      report.runnerStep = {
        actionId: action.id,
        actionType: action.type,
        completed: Boolean(outcome.completed),
        skipped: Boolean(outcome.skipped),
        durationMs: actionDurationMs,
        controlStrategy: outcome.controlStrategy || null,
        selectionKind: String(outcome.selectionKind || '').slice(0, 48) || null,
        intelligenceConsulted: outcome.intelligenceConsulted === true,
        intelligenceDecision: String(outcome.intelligenceDecision || '').slice(0, 24) || null,
        intelligenceRequestId: String(outcome.intelligenceRequestId || '').slice(0, 80) || null,
        intelligenceObservationHash: String(outcome.intelligenceObservationHash || '').slice(0, 80) || null,
        fallbackAttempts: Number(outcome.fallbackAttempts || 0),
        requestedNavigationUrl: outcome.navigationUrl ? compactNavigationUrl(outcome.navigationUrl) : null,
        observedNavigationUrl: outcome.observedNavigationUrl ? compactNavigationUrl(outcome.observedNavigationUrl) : null,
        navigationConfirmed: typeof outcome.navigationConfirmed === 'boolean' ? outcome.navigationConfirmed : null,
        productPageVerified: Boolean(outcome.productPageVerified),
        productIdentityVerified: Boolean(outcome.productIdentityVerified),
        directSearchResultCart: Boolean(outcome.directSearchResultCart),
        postAddCartOpened: Boolean(outcome.postAddCartOpened),
        cartOpenControlStrategy: outcome.cartOpenControlStrategy || null,
        cartOpenAttempts: Number(outcome.cartOpenAttempts || 0),
        checkoutPreludeRecovered: Boolean(outcome.checkoutPreludeRecovered),
        checkoutPreludeRecoveryUrl: outcome.checkoutPreludeRecoveryUrl ? compactNavigationUrl(outcome.checkoutPreludeRecoveryUrl) : null,
        checkoutInterstitialContinued: Boolean(outcome.checkoutInterstitialContinued),
        checkoutInterstitialAttempts: Number(outcome.checkoutInterstitialAttempts || 0),
        recoveredFromInterruption: Boolean(outcome.recoveredFromInterruption),
        selectedCandidate: outcome.selected ? {
          title: String(outcome.selected.title || '').slice(0, 180),
          asin: String(outcome.selected.asin || '').slice(0, 32) || null,
          price: Number.isFinite(Number(outcome.selected.price)) ? Number(outcome.selected.price) : null,
          url: compactNavigationUrl(outcome.selected.url || '') || null
        } : null,
        selectionScan: outcome.scan && typeof outcome.scan === 'object' ? {
          rawScanned: Number(outcome.scan.rawScanned || 0),
          distinctCards: Number(outcome.scan.distinctCards || 0),
          selectionDurationMs: Number(outcome.scan.selectionDurationMs || 0),
          rejected: outcome.scan.rejected && typeof outcome.scan.rejected === 'object'
            ? Object.fromEntries(Object.entries(outcome.scan.rejected).map(([key, value]) => [key, Number(value || 0)]))
            : null
        } : null,
        selectedProductPrice: outcome.state?.checkoutSummary?.productPrice || null,
        selectedDeliveredPrice: outcome.state?.checkoutSummary?.productDeliveredPrice || null,
        reason: outcome.reason || null,
        profileCorrection: outcome.profileCorrection || null,
        profileCorrectionMissed: Boolean(outcome.profileCorrectionMissed),
        paymentAutofillRequired: Boolean(outcome.paymentAutofillRequired),
        profileTransitions: Array.isArray(outcome.profileTransitions) ? outcome.profileTransitions : [],
        pendingOrderMatchEvidence: outcome.pendingOrderMatchEvidence && typeof outcome.pendingOrderMatchEvidence === 'object'
          ? {
              marker: Boolean(outcome.pendingOrderMatchEvidence.marker),
              identityMatches: Boolean(outcome.pendingOrderMatchEvidence.identityMatches),
              identitySource: String(outcome.pendingOrderMatchEvidence.identitySource || '').slice(0, 32),
              priceMatches: Boolean(outcome.pendingOrderMatchEvidence.priceMatches),
              priceSource: String(outcome.pendingOrderMatchEvidence.priceSource || '').slice(0, 32),
              merchandisePriceContradiction: Boolean(outcome.pendingOrderMatchEvidence.merchandisePriceContradiction),
              explicitMerchandiseSubtotal: Number.isFinite(Number(outcome.pendingOrderMatchEvidence.explicitMerchandiseSubtotal))
                ? Number(outcome.pendingOrderMatchEvidence.explicitMerchandiseSubtotal)
                : null,
              quantityMatches: Boolean(outcome.pendingOrderMatchEvidence.quantityMatches),
              quantitySource: String(outcome.pendingOrderMatchEvidence.quantitySource || '').slice(0, 32),
              quantityContradiction: Boolean(outcome.pendingOrderMatchEvidence.quantityContradiction),
              explicitQuantity: Number.isInteger(Number(outcome.pendingOrderMatchEvidence.explicitQuantity))
                ? Number(outcome.pendingOrderMatchEvidence.explicitQuantity)
                : null
            }
          : null,
        merchantCheckoutDefault: outcome.merchantCheckoutDefault && typeof outcome.merchantCheckoutDefault === 'object'
          ? {
              attempted: Boolean(outcome.merchantCheckoutDefault.attempted),
              saved: Boolean(outcome.merchantCheckoutDefault.saved),
              alreadySet: Boolean(outcome.merchantCheckoutDefault.alreadySet),
              reason: String(outcome.merchantCheckoutDefault.reason || '').slice(0, 96) || null
            }
          : null,
        merchantOrderConfirmation: outcome.merchantOrderConfirmation && typeof outcome.merchantOrderConfirmation === 'object'
          ? {
              confirmed: Boolean(outcome.merchantOrderConfirmation.confirmed),
              reason: String(outcome.merchantOrderConfirmation.reason || '').slice(0, 96) || null,
              observedAt: outcome.merchantOrderConfirmation.observedAt || null,
              waitMs: Number(outcome.merchantOrderConfirmation.waitMs || 0) || null
            }
          : null,
        // The content script records this before triggering merchant
        // navigation, so the signed checkpoint remains auditable even if the
        // navigation tears down the page immediately.
        finalSubmitReceipt: outcome.finalSubmitReceipt && typeof outcome.finalSubmitReceipt === 'object'
          ? {
              actionId: String(outcome.finalSubmitReceipt.actionId || '').slice(0, 96),
              actionType: String(outcome.finalSubmitReceipt.actionType || '').slice(0, 64),
              intent: String(outcome.finalSubmitReceipt.intent || '').slice(0, 64),
              receiptScope: String(outcome.finalSubmitReceipt.receiptScope || '').slice(0, 192),
              kind: String(outcome.finalSubmitReceipt.kind || '').slice(0, 64),
              phase: String(outcome.finalSubmitReceipt.phase || '').slice(0, 64),
              controlTag: String(outcome.finalSubmitReceipt.controlTag || '').slice(0, 32),
              controlType: String(outcome.finalSubmitReceipt.controlType || '').slice(0, 32),
              path: String(outcome.finalSubmitReceipt.path || '').slice(0, 240),
              at: outcome.finalSubmitReceipt.at || null
            }
          : null,
        runnerVersion: chrome.runtime.getManifest().version
      };
      if (report.runnerStep.finalSubmitReceipt) {
        const receipt = report.runnerStep.finalSubmitReceipt;
        // Keep the pre-navigation final-order receipt in the stable browser
        // receipt list as well as the runner-step envelope. Merchant
        // navigation may unload executor.js before a subsequent state read.
        report.browserActionReceipts = mergeBrowserActionReceipts(
          Array.isArray(report.browserActionReceipts) ? report.browserActionReceipts : [],
          [receipt]
        );
      }
      const finalSubmitDispatched = outcome.finalSubmitReceipt?.kind === 'final_order'
        && outcome.finalSubmitReceipt?.phase === 'click_dispatched';
      report.finalSubmitRequested = Boolean(outcome.finalSubmitRequested && (
        action.type !== 'final_submit' || finalSubmitDispatched || outcome.orderSubmitted === true
      ));
      report.orderSubmitted = Boolean(outcome.orderSubmitted || report.orderSubmitted);
      report.lastRunnerAction = String(outcome.label || '');
      const reportStage = String(report.checkoutSummary?.stage || report.browserState || '').toLowerCase();
      const checkoutStageReached = ['checkout', 'offer', 'payment', 'final_review'].includes(reportStage)
        || /\/checkout|\/buy|\/gp\/buy|\/alm\/(?:byg|substitution)/i.test(String(report.url || ''));
      report.productOpened = Boolean(report.productOpened || progress.productOpened);
      report.addToCartClicked = Boolean(progress.addToCartClicked);
      report.checkoutOpened = Boolean(progress.checkoutOpened || checkoutStageReached && progress.verifiedMilestones.includes('checkout_open'));
      if (Array.isArray(outcome.safeFieldsFilled) && outcome.safeFieldsFilled.length) {
        progress.safeFieldsFilled = [...new Set([...progress.safeFieldsFilled, ...outcome.safeFieldsFilled])];
      }
      if (Array.isArray(outcome.checkoutSelections) && outcome.checkoutSelections.length) {
        progress.checkoutSelections = [...new Set([...progress.checkoutSelections, ...outcome.checkoutSelections])];
      }
      report.safeFieldsFilled = progress.safeFieldsFilled;
      report.checkoutSelections = progress.checkoutSelections;
      report.localCheckoutProfileExpected = progress.localCheckoutProfileExpected;
      report.localCheckoutProfileAvailable = progress.localCheckoutProfileAvailable;
      if (outcome.existingCartItemVerified) {
        progress.reusedPreparedCart = true;
        progress.addToCartClicked = true;
        report.addToCartClicked = true;
      }
      const requiredBasketItem = Boolean(action.requiredBasketItem);
      const observedCartItemCount = Number(report.checkoutSummary?.cartItemCount);
      if (/^inspect-results(?:-1)?$/.test(String(action.id || '')) && Number.isFinite(observedCartItemCount)) {
        progress.initialCartItemCount = observedCartItemCount;
      }
      const verifiedPreparedCart = Boolean(
        requiredBasketItem
        && outcome.completed
        && outcome.skipped
        && String(report.checkoutSummary?.stage || report.browserState || '').toLowerCase() === 'cart'
        && Number.isFinite(observedCartItemCount)
        && observedCartItemCount > 0
        && /cart item is already prepared/i.test(String(outcome.reason || ''))
      );
      if (verifiedPreparedCart) {
        outcome = { ...outcome, skipped: false, reusedPreparedCart: true };
        progress.reusedPreparedCart = true;
        progress.addToCartClicked = true;
        report.addToCartClicked = true;
      }
      if (requiredBasketItem && (outcome.skipped || !outcome.completed)) {
        outcome = {
          ...outcome,
          completed: false,
          skipped: false,
          reason: outcome.reason || `Magic City could not confirm ${action.item || 'this basket item'} before moving on.`
        };
      }
      const expectedCartItemCount = Number(action.expectedCartItemCount || 0);
      const initialCartItemCount = Number.isFinite(progress.initialCartItemCount) ? progress.initialCartItemCount : 0;
      const minimumCartItemCount = progress.reusedPreparedCart
        ? Math.max(expectedCartItemCount, initialCartItemCount)
        : expectedCartItemCount + initialCartItemCount;
      const cartCountVerified = expectedCartItemCount > 0
        ? Number.isFinite(observedCartItemCount) && observedCartItemCount >= minimumCartItemCount
        : Boolean(report.milestoneSignals?.cartVisible);
      if (
        requiredBasketItem
        && expectedCartItemCount > 0
        && (!Number.isFinite(observedCartItemCount) || observedCartItemCount < minimumCartItemCount)
      ) {
        outcome = {
          ...outcome,
          completed: false,
          skipped: false,
          reason: `Magic City could not verify ${action.item || 'the planned basket item'} in the cart. Expected at least ${minimumCartItemCount} cart items; the site reported ${Number.isFinite(observedCartItemCount) ? observedCartItemCount : 'no cart count'}.`
        };
      }
      const observedMilestones = observedVerifiedMilestones(report, action, outcome, { cartCountVerified });
      if (action.type === 'select_candidate' && observedMilestones.includes('cart_confirmed')) {
        progress.reusedPreparedCart = true;
        progress.addToCartClicked = true;
        report.addToCartClicked = true;
      }
      progress.verifiedMilestones = mergeUnique(progress.verifiedMilestones, observedMilestones);
      const expectedMilestoneVerified = !action.expectedMilestone
        || progress.verifiedMilestones.includes(action.expectedMilestone);
      if (action.expectedMilestone && expectedMilestoneVerified) {
        outcome = {
          ...outcome,
          completed: true,
          skipped: false,
          reason: outcome.reason || `Verified ${action.expectedMilestone.replace(/_/g, ' ')}.`
        };
      }
      if (action.expectedMilestone && !expectedMilestoneVerified && outcome.selectionKind !== 'size_alternative') {
        outcome = {
          ...outcome,
          completed: false,
          skipped: false,
          reason: milestoneFailureReason(action, report, outcome)
        };
      }
      report.verifiedMilestones = progress.verifiedMilestones;
      progress.productOpened = progress.verifiedMilestones.includes('candidate_selected');
      progress.addToCartClicked = progress.verifiedMilestones.includes('cart_confirmed');
      progress.checkoutOpened = progress.verifiedMilestones.includes('checkout_open');
      report.productOpened = Boolean(report.productOpened || progress.productOpened);
      report.addToCartClicked = progress.addToCartClicked;
      report.checkoutOpened = progress.checkoutOpened;
      if (outcome.selectionKind === 'size_alternative' && outcome.completed) {
        report.sizeSubstitution = outcome.sizeSubstitution || null;
      } else if (outcome.selectionKind === 'size_alternative') {
        report.selectionProposal = outcome.proposedCandidate || null;
        report.stopEvidence = outcome.reason || 'A verified size alternative is available for review.';
      }
      const actionStatus = outcome.completed
        ? (outcome.skipped ? 'skipped' : 'completed')
        : action.expectedMilestone || requiredBasketItem
          ? 'waiting'
          : 'skipped';
      session = await missionCheckpoint(session, {
        label: presentation.label,
        detail: outcome.completed && !outcome.skipped
          ? `The local runner completed a bounded, mission-approved browser primitive in ${actionDurationMs}ms.`
          : `${outcome.reason || 'The browser step could not be completed safely.'} (${actionDurationMs}ms)`,
        state: presentation.state,
        missionAction: action.missionAction,
        targetUrl: report.url || startUrl,
        browser: report,
        plan,
        planAction: action,
        planActionStatus: actionStatus,
        runnerTiming: {
          actionId: action.id,
          actionStartedAt: new Date(currentActionStartedAt).toISOString(),
          actionCompletedAt: new Date().toISOString(),
          actionDurationMs,
          resumedFromActiveRun: resumingPersistedRun,
          resumedPhase: resumingPersistedRun ? (persistedActiveRun?.phase || null) : null,
          recoveredAction: Boolean(recoveringInterruptedAction || outcome.recoveredFromInterruption),
          ...(index === Number(planState.nextActionIndex || 0) ? {
            browserTabAcquiredAt: startupTiming.browserTabAcquiredAt || null
          } : {})
        }
      });
      authorityVerifiedAt = Date.now();
      if (hasConfirmedMerchantOrder(report)) {
        return reportAndStop(
          session,
          plan,
          report,
          'Merchant confirmation was durably recorded. Later tab state is not required to complete this mission.'
        );
      }
      // The authenticated checkpoint immediately before the signed
      // final-submit action renews a short, one-action local lease. This
      // avoids a slow but healthy checkout expiring an authority timestamp
      // captured at run start, without permitting a later or different plan
      // action to reuse the lease.
      const nextAction = plan.actions[index + 1] || null;
      if (actionStatus === 'completed' && nextAction?.type === 'final_submit') {
        finalSubmitAuthorityLease = issueFinalSubmitAuthorityLease(session, plan, nextAction);
      }
      // A failed final-order action must remain at its signed cursor. A
      // persisted dispatch receipt proves a click; a recovered merchant
      // confirmation proves the same action completed without replaying it.
      const finalSubmitReceiptRecorded = action.type !== 'final_submit'
        || (action.pendingOrderContinuation === true && outcome.skipped === true)
        || (report.runnerStep.finalSubmitReceipt?.kind === 'final_order'
          && report.runnerStep.finalSubmitReceipt?.phase === 'click_dispatched')
        || outcome.orderSubmitted === true;
      await saveActiveRun({
        sessionId: session.id,
        planHash: plan.planHash,
        phase: 'running',
        tabId: Number(tab?.id || 0) || null,
        actionId: finalSubmitReceiptRecorded ? null : action.id,
        actionIndex: finalSubmitReceiptRecorded ? null : index,
        nextActionIndex: finalSubmitReceiptRecorded ? index + 1 : index,
        selectedCandidate: progress.selectedCandidate,
        cartEvidence: progress.cartEvidence,
        safeFieldsFilled: progress.safeFieldsFilled,
        checkoutSelections: progress.checkoutSelections,
        finalSubmitAuthorityLease: actionStatus === 'completed' && nextAction?.type === 'final_submit'
          ? finalSubmitAuthorityLease
          : finalSubmitReceiptRecorded ? null : finalSubmitAuthorityLease
      });
      if (action.awaitMerchantOrderConfirmation === true && report.finalSubmitRequested === true && outcome.orderSubmitted !== true) {
        const confirmationDeadlineMs = Date.parse(String(executionAction.merchantConfirmationDeadlineAt || ''));
        if (Number.isFinite(confirmationDeadlineMs) && confirmationDeadlineMs <= Date.now()) {
          return reportAndStop(session, plan, {
            ...report,
            finalSubmitRequested: true,
            orderSubmitted: false,
            merchantOrderConfirmation: {
              ...(outcome.merchantOrderConfirmation || {}),
              confirmed: false,
              reason: 'merchant_confirmation_deadline_expired'
            }
          });
        }
        // The final control was clicked once. Keep this exact signed observer
        // action active and re-check only for merchant confirmation; never
        // replay the irreversible click while a navigation is still settling.
        await saveActiveRun({
          sessionId: session.id,
          planHash: plan.planHash,
          phase: 'awaiting_merchant_confirmation',
          tabId: Number(tab?.id || 0) || null,
          actionId: action.id,
          actionIndex: index,
          nextActionIndex: index,
          selectedCandidate: progress.selectedCandidate,
          cartEvidence: progress.cartEvidence,
          merchantConfirmationStartedAt: durableRun?.merchantConfirmationStartedAt || new Date().toISOString(),
          merchantConfirmationDeadlineAt: executionAction.merchantConfirmationDeadlineAt || null,
          merchantConfirmationAttempts: Math.max(0, Number(durableRun?.merchantConfirmationAttempts || 0)) + 1,
          finalSubmitAuthorityLease: null
        });
        retainActiveRun = true;
        scheduleRunnerResume(RUNNER_RESUME_DELAY_MS);
        await saveConfig({
          lastError: '',
          lastExecution: {
            sessionId: session.id,
            status: 'awaiting_merchant_confirmation',
            actionId: action.id,
            at: new Date().toISOString()
          }
        });
        return { sessionId: session.id, status: 'awaiting_merchant_confirmation', waiting: true };
      }
      if (action.type === 'pause') {
        const boundary = stopForBoundary(report, plan, action);
        if (boundary) {
          const parked = await parkForPaymentAutofill(session, plan, report);
          if (parked) {
            retainActiveRun = true;
            return parked;
          }
          report.stopState = boundary.state;
          report.stopEvidence = boundary.evidence;
          if (boundary.failed) {
            report.fulfillmentStatus = 'failed';
            report.fundingDisposition = 'release';
          }
          return reportAndStop(session, plan, report);
        }
        report.stopState = 'review_ready';
        report.stopEvidence = 'The approved browser plan is complete. Review the local checkout before payment or final approval.';
        return reportAndStop(session, plan, report);
      }
      const boundary = stopForBoundary(report, plan, action);
      const nextPlanAction = plan.actions[index + 1] || null;
      const canFillBeforeSensitiveStop = ['payment_required', 'final_approval_required', 'checkout_profile_mismatch', 'address_verification_required'].includes(String(boundary?.state || ''))
        && nextPlanAction?.type === 'fill_checkout_profile'
        && Boolean(checkoutProfile);
      const canOpenPaymentAutofill = boundary?.state === 'payment_required'
        && nextPlanAction?.type === 'click_intent'
        && nextPlanAction?.intent === 'checkout'
        && Boolean(checkoutProfile)
        && String(report.checkoutSummary?.stage || report.browserState || '').toLowerCase() !== 'payment';
      const pendingFinalSubmitIndex = plan.actions.findIndex((candidate, candidateIndex) => candidateIndex > index && candidate?.type === 'final_submit');
      const canSubmitAfterVerifiedCheckout = boundary?.state === 'final_approval_required'
        && pendingFinalSubmitIndex > index
        && plan?.limits?.stopBeforeFinalSubmit === false
        && plan.actions.slice(index + 1, pendingFinalSubmitIndex).every((candidate) =>
          candidate?.type === 'inspect'
          || candidate?.type === 'fill_checkout_profile'
          || candidate?.type === 'click_intent' && candidate?.intent === 'checkout'
        );
      if (boundary && !canFillBeforeSensitiveStop && !canOpenPaymentAutofill && !canSubmitAfterVerifiedCheckout) {
        const parked = await parkForPaymentAutofill(session, plan, report);
        if (parked) {
          retainActiveRun = true;
          return parked;
        }
        return reportAndStop(session, plan, report);
      }
      if (action.type === 'final_submit' && !outcome.completed) {
        report.stopState = outcome.localCheckoutProfileMissing === true
          ? 'local_checkout_profile_missing'
          : 'final_submit_dispatch_failed';
        report.stopEvidence = outcome.reason || 'The signed final-order action did not dispatch a native merchant click.';
        report.fulfillmentStatus = 'failed';
        report.fundingDisposition = 'release';
        return reportAndStop(session, plan, report);
      }
      if (!outcome.completed && action.type === 'select_candidate' && outcome.selectionKind === 'size_alternative') {
        report.stopState = 'product_selection_needs_review';
        report.stopEvidence = outcome.reason || 'A verified size alternative is available for review.';
        return reportAndStop(session, plan, report);
      }
      if (!outcome.completed && action.type === 'select_candidate' && outcome.selectionKind === 'no_verified_candidate') {
        report.stopState = 'product_selection_needs_review';
        report.stopEvidence = outcome.reason || 'Magic City could not find a verified match. Try again with a more general product query.';
        return reportAndStop(session, plan, report);
      }
      if (action.expectedMilestone && !expectedMilestoneVerified) {
        report.stopState = 'milestone_not_verified';
        report.stopEvidence = outcome.reason || milestoneFailureReason(action, report, outcome);
        report.fulfillmentStatus = 'failed';
        report.fundingDisposition = 'release';
        return reportAndStop(session, plan, report);
      }
      if (!outcome.completed && action.type === 'click_intent' && action.intent === 'checkout' && canSubmitAfterVerifiedCheckout) continue;
      if (!outcome.completed && requiredBasketItem) {
        report.stopState = 'basket_item_not_added';
        report.stopEvidence = outcome.reason || `Magic City could not confirm ${action.item || 'a required basket item'} in the cart.`;
        report.fulfillmentStatus = 'failed';
        report.fundingDisposition = 'release';
        return reportAndStop(session, plan, report);
      }
      if (!outcome.completed && !action.optional) {
        report.stopState = 'step_needs_review';
        report.stopEvidence = outcome.reason || 'This browser control needs your review.';
        return reportAndStop(session, plan, report);
      }
      if (!outcome.completed && action.type === 'select_candidate') {
        report.stopState = 'product_selection_needs_review';
        report.stopEvidence = outcome.reason || 'No high-confidence public result was selected.';
        return reportAndStop(session, plan, report);
      }
    }
    return reportAndStop(session, plan, { url: tab?.url || startUrl, finalUrl: tab?.url || startUrl, ...progress });
  } catch (error) {
    const message = error?.message || String(error);
    if (isExecutionCancelledError(error)) {
      await clearMissionTab(session.id);
      await clearLocalCheckoutProfile(session.id);
      await clearPendingPaymentWait(session.id);
      await clearActiveRun(session.id);
      await saveConfig({
        lastError: '',
        lastExecution: { sessionId: session.id, status: 'cancelled', at: new Date().toISOString() }
      });
      return { sessionId: session.id, status: 'cancelled' };
    }
    const actionDurationMs = currentActionStartedAt ? Date.now() - currentActionStartedAt : 0;
    if (error?.browserActionIndeterminate === true && plan && currentAction) {
      let waitingSession = session;
      try {
        waitingSession = await missionCheckpoint(session, {
          label: 'Browser action needs confirmation',
          detail: `The browser stopped returning a result during ${currentAction.id}. Magic City did not repeat the action.`,
          state: 'browser_action_outcome_unknown',
          missionAction: currentAction.missionAction,
          targetUrl: plan.startUrl,
          plan,
          planAction: currentAction,
          planActionStatus: 'waiting'
        });
      } catch {
        // Terminal reporting below remains idempotent and does not replay the
        // page action when the advisory waiting checkpoint is unavailable.
      }
      return reportAndStop(waitingSession, plan, {
        url: plan.startUrl,
        finalUrl: plan.startUrl,
        stopState: 'browser_action_outcome_unknown',
        stopEvidence: 'The product-selection command timed out after dispatch may have begun. Magic City stopped without repeating the cart action.',
        fulfillmentStatus: 'failed',
        fundingDisposition: 'release'
      });
    }
    if (isTransientControlPlaneError(error)) {
      retainActiveRun = true;
      scheduleRunnerResume();
      await saveConfig({
        lastError: 'Magic City connection was interrupted. Retrying automatically.',
        lastExecution: {
          sessionId: session.id,
          status: 'retrying_control_plane',
          actionId: currentAction?.id || null,
          durationMs: actionDurationMs,
          at: new Date().toISOString()
        }
      });
      return { sessionId: session.id, status: 'retrying_control_plane', retrying: true };
    }
    if (isRetryableBrowserRuntimeError(error)) {
      retainActiveRun = true;
      scheduleRunnerResume();
      await saveConfig({
        lastError: 'The browser connection was interrupted. Retrying the current step.',
        lastExecution: {
          sessionId: session.id,
          status: 'retrying_browser_step',
          actionId: currentAction?.id || null,
          durationMs: actionDurationMs,
          at: new Date().toISOString()
        }
      });
      return { sessionId: session.id, status: 'retrying_browser_step', retrying: true };
    }
    const startupFailure = !plan && !currentAction;
    await saveConfig({
      lastError: message,
      lastExecution: {
        sessionId: session.id,
        status: startupFailure ? 'claim_failed' : 'step_needs_review',
        actionId: currentAction?.id || null,
        durationMs: actionDurationMs,
        ...(Number.isFinite(error?.finalSubmitLeaseAgeMs) ? { finalSubmitLeaseAgeMs: error.finalSubmitLeaseAgeMs } : {}),
        ...(error?.finalSubmitAuthorityLease ? { finalSubmitAuthorityLease: error.finalSubmitAuthorityLease } : {}),
        at: new Date().toISOString()
      }
    });
    if (!plan && session?.claimedByPluginId === RUNNER_EXTENSION_PLUGIN_ID) return reportStartupFailure(session, error);
    if (!plan) throw error;
    const planState = session.extensionMissionPlanState?.planHash === plan.planHash
      ? session.extensionMissionPlanState
      : { nextActionIndex: 0 };
    const nextAction = plan.actions[Number(planState.nextActionIndex || 0)];
    if (!nextAction) throw error;
    const tab = await activeMissionTab(session.id);
    let browser = null;
    if (tab) browser = await tabCommand(tab.id, { type: 'MAGIC_CITY_BROWSER_STATE' }).catch(() => null);
    if (isFinalSubmitPolicyError(error)) {
      return reportAndStop(session, plan, {
        ...(browser || {}),
        url: browser?.url || plan.startUrl,
        finalUrl: browser?.url || plan.startUrl,
        stopState: 'final_submit_authorization_rejected',
        stopEvidence: `Magic City rejected the final-order authority before Amazon was charged: ${String(message).slice(0, 180)}`,
        fulfillmentStatus: 'failed',
        fundingDisposition: 'release',
        finalSubmitRequested: false,
        orderSubmitted: false
      }, 'Final order request rejected by Magic City policy. The order was not placed.');
    }
    try {
      session = await missionCheckpoint(session, {
        label: 'Browser step needs review',
        detail: `The local runner could not complete ${currentAction?.id || 'its next approved browser step'} after ${actionDurationMs}ms: ${String(message).slice(0, 180)}`,
        state: 'step_needs_review',
        missionAction: nextAction.missionAction,
        targetUrl: browser?.url || plan.startUrl,
        browser,
        plan,
        planAction: nextAction,
        planActionStatus: 'skipped'
      });
      return reportAndStop(session, plan, {
        ...(browser || {}),
        url: browser?.url || plan.startUrl,
        finalUrl: browser?.url || plan.startUrl,
        stopState: 'step_needs_review',
        stopEvidence: `The local browser step ${currentAction?.id || ''} did not complete: ${String(message).slice(0, 180)}`,
        fulfillmentStatus: 'failed',
        fundingDisposition: 'release'
      });
    } catch {
      throw error;
    }
  } finally {
    inFlightSessionIds.delete(rawSession.id);
    const config = await getConfig().catch(() => null);
    if (!retainActiveRun && config?.activeSessionId === rawSession.id) {
      await clearActiveRun(rawSession.id).catch(() => null);
    }
  }
}

async function resumeActiveRun() {
  const config = await getConfig();
  const sessionId = String(config.activeRun?.sessionId || config.activeSessionId || '').trim();
  if (!sessionId) return { resumed: false, reason: 'no_active_run' };
  if (inFlightSessionIds.has(sessionId)) return { resumed: false, status: 'already_running', sessionId };
  const poll = await pollSessions();
  const session = poll.sessions.find((candidate) => String(candidate?.id || '') === sessionId);
  if (!session || !isRunnableSession(session)) {
    await clearPendingPaymentWait(sessionId).catch(() => null);
    await clearActiveRun(sessionId);
    return { resumed: false, reason: 'active_run_no_longer_runnable', sessionId };
  }
  return runSession(session);
}

async function pollAndExecute(requestedSessionId = '', requestedDispatchNonce = '', clientRunStartedAt = '') {
  const normalizedSessionId = String(requestedSessionId || '').trim();
  const normalizedDispatchNonce = String(requestedDispatchNonce || '').trim();
  let directClaimAccepted = false;
  const wakeReceivedAt = new Date().toISOString();
  const recordWake = async (status, message = '') => {
    if (!normalizedSessionId) return;
    await saveConfig({
      lastError: message,
      lastExecution: {
        sessionId: normalizedSessionId,
        status,
        ...(message ? { message } : {}),
        at: new Date().toISOString()
      }
    });
  };
  const config = await getConfig();
  if (!config.deviceToken) {
    const error = 'runner_not_paired';
    await recordWake('wake_failed', error);
    return {
      paired: false,
      requestedSessionId: normalizedSessionId || null,
      requestedSessionFound: false,
      executed: normalizedSessionId ? [{ sessionId: normalizedSessionId, status: 'wake_failed', error }] : []
    };
  }
  await recordWake('wake_received');
  let poll;
  try {
    await recordWake('registering_runner');
    await registerExecutor(config);
    if (normalizedSessionId && normalizedDispatchNonce) {
      await recordWake('claiming');
      const directSession = {
        id: normalizedSessionId,
        extensionRunDispatch: { nonce: normalizedDispatchNonce },
        runnerClientRunStartedAt: String(clientRunStartedAt || '').trim() || null,
        runnerWakeReceivedAt: wakeReceivedAt
      };
      const execution = await runSession(directSession, {
        onClaimAccepted: () => {
          directClaimAccepted = true;
        }
      });
      return {
        paired: true,
        sessions: [],
        actionableCount: 1,
        directClaim: true,
        requestedSessionId: normalizedSessionId,
        requestedSessionFound: true,
        executed: [execution]
      };
    }
    await recordWake('locating_mission');
    poll = await pollSessions();
  } catch (error) {
    const message = error?.message || String(error);
    const claimRejected = /extension_run_dispatch_required|extension_session_not_claimable|native_runner_required_for_extension_claim|preferred_execution_agent_mismatch/.test(message);
    const status = claimRejected
      ? 'claim_failed'
      : directClaimAccepted
        ? 'step_needs_review'
        : 'wake_failed';
    await recordWake(status, message);
    return {
      paired: true,
      sessions: [],
      actionableCount: 0,
      requestedSessionId: normalizedSessionId || null,
      requestedSessionFound: directClaimAccepted,
      executed: normalizedSessionId ? [{ sessionId: normalizedSessionId, status, error: message }] : []
    };
  }
  const executed = [];
  const runnableSessions = poll.sessions.filter(isRunnableSession);
  const selectedSessions = normalizedSessionId
    ? runnableSessions.filter((session) => String(session?.id || '') === normalizedSessionId)
    : runnableSessions.slice(0, 1);
  const requestedSession = normalizedSessionId
    ? poll.sessions.find((session) => String(session?.id || '') === normalizedSessionId) || null
    : null;
  if (normalizedSessionId && !selectedSessions.length) {
    const requestedStatus = String(requestedSession?.status || 'not_returned').toLowerCase();
    const error = requestedSession
      ? `requested_session_not_runnable:${requestedStatus}`
      : 'requested_session_not_returned';
    await recordWake('wake_rejected', error);
    return {
      ...poll,
      requestedSessionId: normalizedSessionId,
      requestedSessionFound: false,
      requestedSessionStatus: requestedSession?.status || null,
      executed: [{ sessionId: normalizedSessionId, status: 'wake_rejected', error }]
    };
  }
  // Keep the browser surface single-threaded. A second mission can reuse the
  // same tab after the first one reaches a boundary, but cannot compete for it.
  for (const session of selectedSessions.slice(0, 1)) {
    try {
      executed.push(await runSession(session));
    } catch (error) {
      const message = error?.message || String(error);
      if (isTransientControlPlaneError(error)) {
        scheduleRunnerResume();
        await saveConfig({ lastError: 'Magic City connection was interrupted. Retrying automatically.', lastExecution: { sessionId: session.id, status: 'retrying_control_plane', message, at: new Date().toISOString() } });
        executed.push({ sessionId: session.id, status: 'retrying_control_plane', retrying: true });
      } else {
        const status = /extension_run_dispatch_required|extension_session_not_claimable|native_runner_required_for_extension_claim|preferred_execution_agent_mismatch/.test(message)
          ? 'claim_failed'
          : 'failed';
        await saveConfig({ lastError: message, lastExecution: { sessionId: session.id, status, message, at: new Date().toISOString() } });
        executed.push({ sessionId: session.id, status, error: message });
      }
    }
  }
  return {
    ...poll,
    requestedSessionId: normalizedSessionId || null,
    requestedSessionFound: normalizedSessionId
      ? selectedSessions.length > 0
      : runnableSessions.length > 0,
    executed
  };
}

async function pollOnly() {
  const config = await getConfig();
  if (!config.deviceToken) return { paired: false, sessions: [], actionableCount: 0 };
  if (config.activeRun?.sessionId || config.activeSessionId) return resumeActiveRun();
  await registerExecutor(config);
  const poll = await pollSessions();
  // A website wake is the fast path, but an MV3 service worker can be asleep
  // exactly when the page sends it. The server returns only a short-lived
  // dispatch created by the user's Run click, so the next heartbeat may pick
  // up that exact signed mission without becoming a general work queue.
  const dispatchedSession = poll.sessions.find((session) => {
    if (!isRunnableSession(session)) return false;
    const dispatchExpiry = Date.parse(session?.extensionRunDispatch?.expiresAt || '');
    return Number.isFinite(dispatchExpiry) && dispatchExpiry > Date.now();
  });
  if (!dispatchedSession?.id) return poll;
  return pollAndExecute(dispatchedSession.id, dispatchedSession.extensionRunDispatch?.nonce || '');
}

async function getPendingMissionSite() {
  const poll = await pollSessions();
  const runnable = poll.sessions.filter(isFreshPendingSiteMission);
  for (const session of runnable) {
    let targetUrl = '';
    try {
      targetUrl = await planStartUrl(session);
    } catch {
      continue;
    }
    const origin = domainPermissionPattern(targetUrl);
    if (!origin) continue;
    const alreadyGranted = await chrome.permissions.contains({ origins: [origin] });
    return {
      sessionId: session.id,
      domain: domainForUrl(targetUrl),
      origin,
      targetUrl,
      alreadyGranted
    };
  }
  throw new Error('No browser mission is waiting for site access.');
}

async function startPendingMissionSite({ sessionId = '' } = {}) {
  const poll = await pollSessions();
  const sessions = poll.sessions.filter(isFreshPendingSiteMission);
  const session = sessions.find((entry) => entry.id === sessionId) || sessions[0];
  if (!session) throw new Error('No browser mission is waiting to run.');
  const targetUrl = await planStartUrl(session);
  const origin = domainPermissionPattern(targetUrl);
  const hasPermission = Boolean(origin && await chrome.permissions.contains({ origins: [origin] }));
  if (!hasPermission) {
    throw new Error(`Browser access for ${domainForUrl(targetUrl)} is not enabled yet.`);
  }
  await registerExecutor();
  const execution = await runSession(session);
  return { granted: true, domain: domainForUrl(targetUrl), execution };
}

async function allowAndStartPendingMissionSite() {
  const pending = await getPendingMissionSite();
  if (!pending.alreadyGranted) {
    throw new Error(`Browser access for ${pending.domain} must be allowed from the extension popup first.`);
  }
  return startPendingMissionSite({ sessionId: pending.sessionId });
}

async function pairWithCode({ baseUrl = DEFAULT_BASE_URL, code = '' } = {}) {
  const pairingCode = normalizePairingCode(code);
  if (!pairingCode || pairingCode.length < 6) throw new Error('Enter the pairing code from Magic City.');
  invalidateExecutorRegistration();
  await saveConfig({ baseUrl: normalizeBaseUrl(baseUrl), lastError: '' });
  const claimed = await api('/native-runner/extension/pairing/claim', {
    method: 'POST',
    body: {
      code: pairingCode,
      extensionVersion: chrome.runtime.getManifest().version,
      extensionId: chrome.runtime.id || ''
    }
  });
  const setup = claimed.setup || {};
  if (!setup.deviceToken) throw new Error('pairing_claim_missing_token');
  const saved = await saveConfig({
    baseUrl: normalizeBaseUrl(setup.baseUrl || baseUrl),
    deviceToken: setup.deviceToken,
    deviceId: setup.deviceId || claimed.device?.id || '',
    tokenLast4: setup.tokenLast4 || claimed.device?.tokenLast4 || '',
    expiresAt: setup.expiresAt || claimed.device?.expiresAt || '',
    pluginId: RUNNER_EXTENSION_PLUGIN_ID,
    ownerAgentId: RUNNER_EXTENSION_OWNER_AGENT_ID,
    extensionId: chrome.runtime.id || '',
    extensionVersion: chrome.runtime.getManifest().version,
    useExistingBrowser: Boolean(setup.useExistingBrowser ?? claimed.device?.useExistingBrowser),
    pairedAt: new Date().toISOString(),
    lastError: ''
  });
  await ensureHolderKey();
  await registerExecutor(saved);
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_PERIOD_MINUTES });
  await pollSessions();
  return { paired: true, device: claimed.device || null, setup: { ...setup, deviceToken: undefined } };
}

async function activateRunner() {
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_PERIOD_MINUTES });
  try {
    // A user-approved dispatch is the authorization to run. Resuming it here
    // lets MV3 recover after Chrome suspends a background worker mid-mission.
    await pollAndExecute();
  } catch (error) {
    await saveConfig({ lastError: error?.message || String(error) });
  }
}

async function handleMessage(message, sender = null) {
  if (message?.type === 'PAIR_WITH_CODE') return pairWithCode(message);
  if (message?.type === 'SET_LOCAL_CHECKOUT_PROFILE') return setLocalCheckoutProfile(message, sender);
  if (message?.type === 'MAGIC_CITY_FINAL_ORDER_DISPATCHED') {
    const stored = await saveFinalOrderDispatchReceipt(sender?.tab?.id, message.receipt);
    return { ok: true, saved: Boolean(stored?.saved) };
  }
  if (message?.type === 'CHECK_STATUS') {
    let config = await getConfig();
    const checkedAt = new Date().toISOString();
    if (config.deviceToken) {
      config = await saveConfig({
        lastPollAt: checkedAt,
        extensionId: chrome.runtime.id || '',
        extensionVersion: chrome.runtime.getManifest().version,
        lastError: ''
      });
    }
    const refreshPromise = config.deviceToken
      ? (async () => {
          await registerExecutor(config);
          return pollSessions();
        })()
      : Promise.resolve({ paired: false, sessions: [], actionableCount: 0 });
    refreshPromise.catch((error) => {
      void saveConfig({ lastError: error?.message || String(error) });
    });
    const poll = await withTimeout(
      () => refreshPromise,
      2500,
      'runner_status_refresh_pending'
    ).catch((error) => ({
      paired: Boolean(config.deviceToken),
      sessions: [],
      actionableCount: 0,
      refreshPending: error?.message === 'runner_status_refresh_pending',
      error: error?.message || String(error)
    }));
    config = await getConfig();
    const origins = await extensionHostPermissions().catch(() => []);
    return {
      config: {
        ...config,
        extensionId: chrome.runtime.id || '',
        extensionVersion: chrome.runtime.getManifest().version,
        deviceToken: undefined,
        holderPrivateJwk: undefined
      },
      poll,
      origins
    };
  }
  if (message?.type === 'GET_PENDING_MISSION_SITE') return getPendingMissionSite();
  if (message?.type === 'START_PENDING_MISSION_SITE') return startPendingMissionSite(message);
  if (message?.type === 'FOCUS_MISSION_TAB') {
    return focusMissionTab({
      ...message,
      preferredWindowId: sender?.tab?.windowId
    });
  }
  if (message?.type === 'ALLOW_AND_START_PENDING_MISSION_SITE' || message?.type === 'ENABLE_PENDING_MISSION_SITE') {
    return allowAndStartPendingMissionSite();
  }
  if (message?.type === 'RUN_PENDING_SESSIONS') {
    return pollAndExecute(
      message.sessionId || '',
      message.extensionDispatchNonce || '',
      message.clientRunStartedAt || ''
    );
  }
  if (message?.type === 'REGISTER_PLUGIN') {
    await registerExecutor();
    return { registered: true };
  }
  if (message?.type === 'DISCONNECT') {
    invalidateExecutorRegistration();
    await chrome.storage.local.clear();
    await chrome.storage.session?.clear?.().catch(() => null);
    return { disconnected: true };
  }
  return { ok: true, sender: sender?.origin || null };
}

export { activateRunner, handleMessage, pollAndExecute, pollOnly, resumeActiveRun };
