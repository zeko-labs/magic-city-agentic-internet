import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { buildBrowserExtensionMissionPlan } from '../src/browserMissionPlan.js';

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const extensionSource = path.resolve(process.env.MAGIC_CITY_EXTENSION_SOURCE || path.join(rootDir, 'public/native-runner/extension'));
const extensionManifest = JSON.parse(fs.readFileSync(path.join(extensionSource, 'manifest.json'), 'utf8'));

function supportsFinalSubmit(version = '') {
  const parts = String(version).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const minimum = [0, 2, 27];
  for (let index = 0; index < minimum.length; index += 1) {
    const delta = (parts[index] || 0) - minimum[index];
    if (delta) return delta > 0;
  }
  return true;
}

const extensionFinalSubmitEnabled = supportsFinalSubmit(extensionManifest.version);

function buildExtensionPlan(session = {}) {
  return buildBrowserExtensionMissionPlan({
    ...session,
    extensionFinalSubmitEnabled
  });
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]));
  }
  return value;
}

function rehashExtensionPlan(plan) {
  const { planHash: _ignored, ...unsignedPlan } = plan;
  return {
    ...unsignedPlan,
    planHash: `0x${crypto.createHash('sha256').update(JSON.stringify(stableValue(unsignedPlan))).digest('hex')}`
  };
}
let checkoutFixture = {
  total: '$4.15',
  merchandiseSubtotal: '$3.50',
  shipping: '$0.00',
  itemCount: 1,
  showAddressPrimeModal: false,
  selectedCardLast4: '1817',
  matchingAddressAvailable: false,
  startWithNewAddressModal: true,
  checkoutPrelude: true
};
let multiBasketItems = [];
let brandCandidateVisits = [];
let conditionalCandidateVisits = [];
let mixedOfferCandidateVisits = [];
let lateShippingCandidateVisits = [];
let brandCartItem = null;
let lateShippingCartItem = null;
let delayFirstProductControl = true;
const purchaseScenarioResults = [];
const multiCatalog = [
  {
    id: 'whole-foods-marshmallows',
    query: 'marshmallows',
    title: 'Whole Foods Market Marshmallows',
    price: 1.99,
    rating: '4.9',
    reviews: '8,000',
    fulfillment: 'Sold by Whole Foods Market.'
  },
  {
    id: 'gourmet-marshmallows',
    query: 'marshmallows',
    title: 'Gourmet Campfire Marshmallows',
    price: 14.99,
    rating: '4.9',
    reviews: '8,000',
    fulfillment: 'Ships from Amazon.com. Prime delivery.'
  },
  {
    id: 'marshmallows',
    query: 'marshmallows',
    title: 'Campfire Marshmallows',
    price: 2.5,
    rating: '4.6',
    reviews: '1,000',
    fulfillment: 'Ships from Amazon.com. Prime delivery.'
  },
  {
    id: 'graham-crackers-marketplace',
    query: 'graham crackers',
    title: 'Graham Crackers - Marketplace Pack',
    price: 2.25,
    rating: '4.7',
    reviews: '3,000',
    fulfillment: 'Ships from Lucky Market.'
  },
  {
    id: 'graham-crackers',
    query: 'graham crackers',
    title: 'Honey Graham Crackers',
    price: 2.25,
    rating: '4.7',
    reviews: '3,000',
    fulfillment: 'Ships from Amazon.com. Prime delivery.'
  },
  {
    id: 'hersheys-chocolate',
    query: 'chocolate',
    title: "Hershey's Milk Chocolate Bar",
    price: 3,
    rating: '4.6',
    reviews: '1,000',
    fulfillment: 'Ships from Amazon.com. Prime delivery.'
  }
];

function fail(message) {
  throw new Error(message);
}

function recordPurchaseScenario(name, details = {}) {
  purchaseScenarioResults.push({ name, ok: true, ...details });
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : {};
}

function createCertificate(directory) {
  const keyPath = path.join(directory, 'key.pem');
  const certPath = path.join(directory, 'cert.pem');
  const result = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
    '-subj', '/CN=127.0.0.1', '-keyout', keyPath, '-out', certPath
  ], { stdio: 'ignore' });
  if (result.status !== 0) fail('test_certificate_generation_failed');
  return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
}

function copyTestExtension(directory, externalOrigin = '', options = {}) {
  const destination = path.join(directory, 'extension');
  fs.cpSync(extensionSource, destination, { recursive: true });
  const manifestPath = path.join(destination, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), 'https://127.0.0.1/*'])];
  manifest.externally_connectable = {
    ...(manifest.externally_connectable || {}),
    matches: [...new Set([
      ...(manifest.externally_connectable?.matches || []),
      'https://127.0.0.1/*'
    ])]
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  if (externalOrigin) {
    const backgroundPath = path.join(destination, 'background.js');
    const background = fs.readFileSync(backgroundPath, 'utf8');
    const origin = new URL(externalOrigin).origin;
    const marker = "  'https://magic-city-staging.fly.dev'\n]);";
    if (!background.includes(marker)) fail('test_extension_external_origin_marker_missing');
    fs.writeFileSync(backgroundPath, background.replace(
      marker,
      `  'https://magic-city-staging.fly.dev',\n  '${origin}'\n]);`
    ));
  }
  const finalSubmitLeaseMs = Number(options.finalSubmitLeaseMs);
  if (options.finalSubmitLeaseMs != null
    && Number.isFinite(finalSubmitLeaseMs)
    && finalSubmitLeaseMs > 0) {
    const backgroundPath = path.join(destination, 'background-v0.2.js');
    const background = fs.readFileSync(backgroundPath, 'utf8');
    const marker = 'const FINAL_SUBMIT_LOCAL_LEASE_MS = 45_000;';
    if (!background.includes(marker)) fail('test_extension_final_submit_lease_marker_missing');
    fs.writeFileSync(backgroundPath, background.replace(
      marker,
      `const FINAL_SUBMIT_LOCAL_LEASE_MS = ${finalSubmitLeaseMs};`
    ));
  }
  if (Number.isFinite(Number(options.finalSubmitDelayMs)) && Number(options.finalSubmitDelayMs) > 0) {
    const backgroundPath = path.join(destination, 'background-v0.2.js');
    const background = fs.readFileSync(backgroundPath, 'utf8');
    const marker = '        assertFinalSubmitLocalAuthority(session, finalSubmitAuthorityLease, plan, action);';
    if (!background.includes(marker)) fail('test_extension_final_submit_delay_marker_missing');
    fs.writeFileSync(backgroundPath, background.replace(
      marker,
      [
        `        await new Promise((resolve) => setTimeout(resolve, ${Number(options.finalSubmitDelayMs)}));`,
        marker
      ].join('\n')
    ));
  }
  if (options.forceFastPathPostClickTimeout === true) {
    const backgroundPath = path.join(destination, 'background-v0.2.js');
    const background = fs.readFileSync(backgroundPath, 'utf8');
    const functionMarker = 'async function amazonSearchCardAddToCart(tabId, action = {}) {\n';
    if (!background.includes(functionMarker)) fail('test_extension_force_fast_path_timeout_marker_missing');
    const injectedBranch = [
      functionMarker.trimEnd(),
      '  if (!globalThis.__magicCityTestFastPathTimedOutOnce) {',
      '    globalThis.__magicCityTestFastPathTimedOutOnce = true;',
      '    const testResult = await withTimeout(',
      '      () => chrome.scripting.executeScript({',
      '        target: { tabId },',
      '        injectImmediately: true,',
      '        func: async () => {',
      "          document.querySelector('#timeout-search-add')?.click();",
      '          await new Promise((resolve) => setTimeout(resolve, 300));',
      '          return { completed: true };',
      '        }',
      '      }),',
      '      80,',
      "      'amazon_search_card_fast_path_timeout'",
      '    ).catch((error) => ({',
      '      completed: false,',
      '      browserActionIndeterminate: true,',
      "      reason: error?.message || String(error) || 'Amazon search-card fast path failed before returning a result.'",
      '    }));',
      '    if (Array.isArray(testResult)) return testResult[0]?.result || null;',
      "    return testResult && typeof testResult === 'object' ? testResult : null;",
      '  }'
    ].join('\n');
    fs.writeFileSync(backgroundPath, background.replace(functionMarker, `${injectedBranch}\n`));
  }
  if (options.failFirstPlanStepInjection === true) {
    const backgroundPath = path.join(destination, 'background-v0.2.js');
    const background = fs.readFileSync(backgroundPath, 'utf8');
    const injectionMarker = '  await withTimeout(\n    () => chrome.scripting.executeScript({\n      target: { tabId },\n      files: [EXECUTOR_FILE],';
    if (!background.includes(injectionMarker)) fail('test_extension_plan_step_injection_marker_missing');
    fs.writeFileSync(backgroundPath, background.replace(
      injectionMarker,
      [
        "  if (command?.type === 'MAGIC_CITY_EXECUTE_PLAN_STEP' && !globalThis.__magicCityTestPlanStepInjectionFailedOnce) {",
        '    globalThis.__magicCityTestPlanStepInjectionFailedOnce = true;',
        "    throw new Error('browser_script_injection_timeout');",
        '  }',
        injectionMarker
      ].join('\n')
    ));
  }
  if (options.disableSearchFastPath === true) {
    const backgroundPath = path.join(destination, 'background-v0.2.js');
    const background = fs.readFileSync(backgroundPath, 'utf8');
    const fastPathMarker = '    if (amazonFastPathAllowed && searchSurfaceAllowed) {';
    if (!background.includes(fastPathMarker)) fail('test_extension_disable_fast_path_marker_missing');
    fs.writeFileSync(backgroundPath, background.replace(
      fastPathMarker,
      '    if (false && amazonFastPathAllowed && searchSurfaceAllowed) {'
    ));
  }
  return destination;
}

async function waitFor(check, timeoutMs = 20_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('browser_extension_smoke_timeout');
}

function withTimeout(promise, timeoutMs, errorCode) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(errorCode)), timeoutMs))
  ]);
}

function runtimeMessageWithTimeout(page, message, timeoutMs = 3_000) {
  return page.evaluate(({ payload, timeout }) => new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    setTimeout(() => finish({ timeout: true }), timeout);
    chrome.runtime.sendMessage(payload, (response) => {
      finish({ response, error: chrome.runtime.lastError?.message || '' });
    });
  }), { payload: message, timeout: timeoutMs });
}

function storefront(pathname, searchParams = new URLSearchParams()) {
  const ambiguousPackageFixtures = [
    { key: 'range', asin: 'B000PACK03', evidence: '<tr><th>Package Quantity</th><td>2-6</td></tr>' },
    { key: 'alternatives', asin: 'B000PACK04', evidence: '<tr><th>Number of Items</th><td>2 or 6</td></tr>' },
    { key: 'unknown', asin: 'B000PACK05', evidence: '<tr><th>Item Package Quantity</th><td>2</td></tr><tr><th>Number of Items</th><td>unknown</td></tr>' }
  ];
  const ambiguousSearch = ambiguousPackageFixtures.find((fixture) => pathname === `/selection-package-${fixture.key}-search`);
  if (ambiguousSearch) {
    return [
      '<main><h1>Results for Nature Valley granola bars 2-pack</h1>',
      `<div data-component-type="s-search-result" data-asin="${ambiguousSearch.asin}">`,
      `<div data-cy="title-recipe"><h2>Nature Valley</h2><h2><a href="/dp/${ambiguousSearch.asin}">Nature Valley granola bars 2-pack</a></h2></div>`,
      '<span class="a-price"><span class="a-offscreen">$6.95</span></span>',
      '<span aria-label="Amazon Prime">Prime delivery</span>',
      '</div>',
      '</main>'
    ].join('');
  }
  const ambiguousProduct = ambiguousPackageFixtures.find((fixture) => pathname === `/dp/${fixture.asin}`);
  if (ambiguousProduct) {
    return [
      '<main><h1 id="productTitle">Nature Valley granola bars</h1>',
      `<table id="productDetails_detailBullets_sections1">${ambiguousProduct.evidence}</table>`,
      '<div id="corePrice_feature_div"><span class="a-offscreen">$6.95</span></div>',
      '<span aria-label="Amazon Prime">Prime delivery</span>',
      '<div id="deliveryBlockMessage">FREE delivery Tomorrow</div>',
      '<div id="merchant-info">Ships from Amazon.com. Sold by Amazon.com.</div>',
      `<input id="add-to-cart-button" type="submit" value="Add to Cart" onclick="sessionStorage.setItem('selection-package-${ambiguousProduct.key}-cart-click-count', String(Number(sessionStorage.getItem('selection-package-${ambiguousProduct.key}-cart-click-count') || 0) + 1))" />`,
      '</main>'
    ].join('');
  }
  if (pathname === '/selection-intelligence-search') {
    const card = (asin, title, price) => [
      `<div data-component-type="s-search-result" data-asin="${asin}">`,
      `<h2><a href="/dp/${asin}">${title}</a></h2>`,
      `<span class="a-price"><span class="a-offscreen">$${price}</span></span>`,
      '<span aria-label="Amazon Prime">Prime delivery</span><span>FREE delivery Tomorrow</span>',
      `<button onclick="sessionStorage.setItem('selection-intelligence-click-count', String(Number(sessionStorage.getItem('selection-intelligence-click-count') || 0) + 1)); location.href='/post-add-confirmation'">Add to cart</button>`,
      '</div>'
    ].join('');
    return [
      '<main><h1>Results for fruity Nature Valley granola bars</h1>',
      card('B000FRUIT1', 'Nature Valley Mixed Berry Crunchy Granola Bars', '3.79'),
      card('B000FRUIT2', 'Nature Valley Cranberry Pomegranate Granola Bars', '3.89'),
      card('B000PEANUT', 'Nature Valley Peanut Butter Granola Bars', '3.50'),
      '<a id="nav-cart" href="/cart"><span id="nav-cart-count">0</span> Cart</a>',
      '</main>'
    ].join('');
  }
  if (pathname === '/selection-explicit-identity-search') {
    const card = (asin, brand, title, price) => [
      `<div data-component-type="s-search-result" data-asin="${asin}">`,
      `<div data-cy="title-recipe"><h2>${brand}</h2><h2><a href="/dp/${asin}">${title}</a></h2></div>`,
      `<span class="a-price"><span class="a-offscreen">$${price}</span></span>`,
      '<span aria-label="Amazon Prime">Prime delivery</span><span>FREE delivery Tomorrow</span>',
      `<button onclick="sessionStorage.setItem('selection-explicit-identity-click-count', String(Number(sessionStorage.getItem('selection-explicit-identity-click-count') || 0) + 1))">Add to cart</button>`,
      '</div>'
    ].join('');
    return [
      '<main><h1>Results for Nature Valley Strawberry granola bars</h1>',
      card('B000PEANUT', 'Nature Valley', 'Nature Valley Peanut Butter Granola Bars', '3.50'),
      card('B000STRAWB', 'Great Value', 'Great Value Strawberry Granola Bars', '3.25'),
      '<a id="nav-cart" href="/cart"><span id="nav-cart-count">0</span> Cart</a>',
      '</main>'
    ].join('');
  }
  if (pathname === '/selection-provisional-search') {
    return [
      '<main><h1>Results for HERSHEY\'S S\'mores Kit Box, 14 oz</h1>',
      '<div data-component-type="s-search-result" data-asin="B000SMORE1">',
      '<div data-cy="title-recipe"><h2>HERSHEY\'S</h2><h2><a href="/dp/B000SMORE1">mores Kit Box, 14 oz</a></h2></div>',
      '<span class="a-price"><span class="a-offscreen">$6.95</span></span>',
      '<span aria-label="Amazon Prime">Prime delivery</span>',
      '</div>',
      '</main>'
    ].join('');
  }
  if (pathname === '/selection-accessible-title-search') {
    return [
      '<main><h1>Results for HERSHEY\'S S\'mores Kit Box, 14 oz</h1>',
      '<div data-component-type="s-search-result" data-asin="B000SMORE2">',
      '<div data-cy="title-recipe"><h2>HERSHEY\'S</h2><h2><a href="/dp/B000SMORE2" aria-label="HERSHEY\'S S\'mores Kit Box, 14 oz">mores Kit Box, 14 oz</a></h2></div>',
      '<span class="a-price"><span class="a-offscreen">$6.95</span></span>',
      '<span aria-label="Amazon Prime">Prime delivery</span><span>FREE delivery Tomorrow</span>',
      '<button onclick="sessionStorage.setItem(\'selection-accessible-title-click-count\', String(Number(sessionStorage.getItem(\'selection-accessible-title-click-count\') || 0) + 1))">Add to cart</button>',
      '</div>',
      '</main>'
    ].join('');
  }
  if (pathname === '/selection-package-mismatch-search') {
    return [
      '<main><h1>Results for HERSHEY\'S S\'mores Kit Box, 14 oz</h1>',
      '<div data-component-type="s-search-result" data-asin="B000PACK01">',
      '<div data-cy="title-recipe"><h2>HERSHEY\'S</h2><h2><a href="/dp/B000PACK01">HERSHEY\'S S\'mores Kit Box, 14 oz</a></h2></div>',
      '<span class="a-price"><span class="a-offscreen">$6.95</span></span>',
      '<span aria-label="Amazon Prime">Prime delivery</span>',
      '</div>',
      '</main>'
    ].join('');
  }
  if (pathname === '/selection-pack-count-mismatch-search') {
    return [
      '<main><h1>Results for Nature Valley granola bars 2-pack</h1>',
      '<div data-component-type="s-search-result" data-asin="B000PACK02">',
      '<div data-cy="title-recipe"><h2>Nature Valley</h2><h2><a href="/dp/B000PACK02">Nature Valley granola bars 2-pack</a></h2></div>',
      '<span class="a-price"><span class="a-offscreen">$6.95</span></span>',
      '<span aria-label="Amazon Prime">Prime delivery</span>',
      '</div>',
      '</main>'
    ].join('');
  }
  if (pathname === '/dp/B000SMORE1') {
    return [
      '<main><h1 id="productTitle">HERSHEY\'S S\'mores Kit Box, 14 oz</h1>',
      '<div id="corePrice_feature_div"><span class="a-offscreen">$6.95</span></div>',
      '<span aria-label="Amazon Prime">Prime delivery</span>',
      '<div id="deliveryBlockMessage">FREE delivery Tomorrow</div>',
      '<div id="merchant-info">Ships from Amazon.com. Sold by Amazon.com.</div>',
      '<input id="add-to-cart-button" type="submit" value="Add to Cart" onclick="sessionStorage.setItem(\'selection-provisional-cart-click-count\', String(Number(sessionStorage.getItem(\'selection-provisional-cart-click-count\') || 0) + 1))" />',
      '</main>'
    ].join('');
  }
  if (pathname === '/dp/B000PACK01') {
    return [
      '<main><h1 id="productTitle">HERSHEY\'S S\'mores Kit Box, 14 oz</h1>',
      '<table id="productDetails_detailBullets_sections1"><tr><th>Number of Items</th><td>2</td></tr></table>',
      '<div id="corePrice_feature_div"><span class="a-offscreen">$6.95</span></div>',
      '<span aria-label="Amazon Prime">Prime delivery</span>',
      '<div id="deliveryBlockMessage">FREE delivery Tomorrow</div>',
      '<div id="merchant-info">Ships from Amazon.com. Sold by Amazon.com.</div>',
      '<input id="add-to-cart-button" type="submit" value="Add to Cart" onclick="sessionStorage.setItem(\'selection-package-mismatch-cart-click-count\', String(Number(sessionStorage.getItem(\'selection-package-mismatch-cart-click-count\') || 0) + 1))" />',
      '</main>'
    ].join('');
  }
  if (pathname === '/dp/B000PACK02') {
    return [
      '<main><h1 id="productTitle">Nature Valley granola bars 6-pack</h1>',
      '<div id="corePrice_feature_div"><span class="a-offscreen">$6.95</span></div>',
      '<span aria-label="Amazon Prime">Prime delivery</span>',
      '<div id="deliveryBlockMessage">FREE delivery Tomorrow</div>',
      '<div id="merchant-info">Ships from Amazon.com. Sold by Amazon.com.</div>',
      '<input id="add-to-cart-button" type="submit" value="Add to Cart" onclick="sessionStorage.setItem(\'selection-pack-count-mismatch-cart-click-count\', String(Number(sessionStorage.getItem(\'selection-pack-count-mismatch-cart-click-count\') || 0) + 1))" />',
      '</main>'
    ].join('');
  }
  if (pathname === '/selection-timeout-search') {
    return [
      '<main><h1>Results for test gadget</h1>',
      '<div data-component-type="s-search-result" data-asin="TIMEOUT-ASIN">',
      '<h2><a href="/dp/test-gadget">Test gadget</a></h2>',
      '<span class="a-price">$3.50</span><span aria-label="Amazon Prime">Prime delivery</span><span>FREE shipping</span>',
      '<button id="timeout-search-add" onclick="sessionStorage.setItem(\'selection-click-count\', String(Number(sessionStorage.getItem(\'selection-click-count\') || 0) + 1)); document.querySelector(\'#nav-cart-count\').textContent=\'1\'">Add to cart</button>',
      '</div>',
      '<a id="nav-cart" href="/cart"><span id="nav-cart-count">0</span> Cart</a>',
      '</main>'
    ].join('');
  }
  if (pathname === '/selection-recovery-search') {
    return [
      '<main><h1>Results for test gadget</h1>',
      '<div data-component-type="s-search-result" data-asin="RECOVERY-ASIN">',
      '<h2><a href="/dp/test-gadget">Test gadget</a></h2>',
      '<span class="a-price">$3.50</span><span aria-label="Amazon Prime">Prime delivery</span>',
      '<button id="recovery-search-add" onclick="sessionStorage.setItem(\'selection-click-count\', String(Number(sessionStorage.getItem(\'selection-click-count\') || 0) + 1)); location.href=\'/post-add-confirmation\'">Add to cart</button>',
      '</div><a id="nav-cart" href="/cart"><span id="nav-cart-count">0</span> Cart</a>',
      '</main>'
    ].join('');
  }
  if (pathname === '/signed-out-search') {
    return [
      '<main>',
      '<nav><a id="nav-link-accountList" href="/ap/signin"><span id="nav-link-accountList-nav-line-1">Hello, sign in</span><span>Account & Lists</span></a></nav>',
      '<h1>Results</h1>',
      '<form><input type="search" role="searchbox" /></form>',
      '<div data-component-type="s-search-result" data-asin="SIGNED-OUT"><h2><a href="/dp/test-gadget">Test gadget</a></h2><span class="a-price">$3.50</span></div>',
      '</main>'
    ].join('');
  }
  if (pathname === '/free-shipping-search') {
    return [
      '<main>',
      '<nav><span id="nav-link-accountList-nav-line-1">Hello, Test Shopper</span></nav>',
      '<h1>Results</h1>',
      '<form><input type="search" role="searchbox" /></form>',
      '<label for="free-only-filter"><input id="free-only-filter" type="checkbox" aria-label="Free shipping" /> Free shipping</label>',
      '<div data-component-type="s-search-result" data-asin="FREE-SHIPPING"><h2><a href="/dp/test-gadget">Test gadget</a></h2><span class="a-price">$3.50</span><span>FREE shipping</span></div>',
      '</main>'
    ].join('');
  }
  if (pathname === '/direct-result-cart-search') {
    return [
      '<main>',
      '<nav><span id="nav-link-accountList-nav-line-1">Hello, Test Shopper</span></nav>',
      '<h1>Results for nature valley granola bars</h1>',
      '<form action="/direct-result-cart-search"><label>Search <input type="search" name="q" role="searchbox" value="nature valley granola bars" /></label><button type="submit">Search</button></form>',
      '<aside id="s-refinements-left">',
      '<label><input id="prime-filter" type="checkbox" aria-label="Prime" /> All Prime</label>',
      '<label><input id="delivery-today-filter" type="checkbox" aria-label="Today by 6PM" /> Today by 6PM</label>',
      '</aside>',
      '<div data-component-type="s-search-result" data-asin="NATURE-VALLEY-DIRECT">',
      '<h2><a href="/dp/nature-valley-direct">Nature Valley Crunchy Granola Bars, Oats & Honey, 12 ct, 8.94 oz</a></h2>',
      '<span class="a-price">$2.97</span><span>4.7 out of 5 stars</span><span>20,571 ratings</span>',
      '<span aria-label="Amazon Prime">Prime</span>',
      '<p><span class="a-icon-prime">prime</span> FREE delivery Overnight 7 AM - 11 AM on $25 of qualifying items</p>',
      '<button id="direct-result-add" onclick="document.querySelector(\'#nav-cart-count\').textContent=\'1\'; document.querySelector(\'#direct-result-sidecart\').hidden=false; this.textContent=\'Added to cart\';">Add to cart</button>',
      '</div>',
      '<div data-component-type="s-search-result" data-asin="CLIF-SPONSORED">',
      '<h2><a href="/dp/clif-sponsored">CLIF Bar Cool Mint Chocolate with Caffeine</a></h2>',
      '<span>Sponsored</span><span class="a-price">$2.49</span><button>Add to cart</button>',
      '</div>',
      '<aside id="direct-result-sidecart" aria-label="Cart preview" hidden><p>Subtotal $2.97</p><button id="direct-result-go-to-cart" onclick="location.href=\'/cart?source=side-cart\'">Go to Cart</button></aside>',
      '<a id="nav-cart" href="/cart?source=header-cart"><span id="nav-cart-count">0</span> Cart</a>',
      '</main>'
    ].join('');
  }
  if (pathname === '/header-cart-search') {
    return [
      '<main>',
      '<nav><span id="nav-link-accountList-nav-line-1">Hello, Test Shopper</span><a id="nav-cart" href="/cart?source=header-cart">1 Cart</a></nav>',
      '<h1>Cart ready</h1>',
      '</main>'
    ].join('');
  }
  if (pathname === '/brand-search') {
    return [
      '<main>',
      '<h1>Results</h1>',
      '<form action="/brand-search"><label>Search <input type="search" name="q" role="searchbox" /></label><button type="submit">Search</button></form>',
      '<div data-component-type="s-search-result" data-asin="NUTRIGRAIN-DECOY">',
      '<h2><a href="/dp/nutri-grain-decoy">Kellogg\'s Nutri-Grain Breakfast Blueberry Granola Bar</a></h2>',
      '<span class="a-price">$2.79</span><span>4.7 out of 5 stars</span><span>4,000 ratings</span>',
      '<button>Add to Cart</button>',
      '</div>',
     '<div data-component-type="s-search-result" data-asin="NATURE-VALLEY-UNAVAILABLE">',
     '<h2><a href="/dp/nature-valley-unavailable">Nature Valley Crunchy Granola Bars</a></h2>',
     '<span class="a-price">$2.97</span><span>4.8 out of 5 stars</span><span>8,000 ratings</span>',
     '<button>Add to Cart</button>',
     '</div>',
      '<div data-component-type="s-search-result" data-asin="NATURE-VALLEY-LOCAL-MARKET">',
      '<h2><a href="/dp/nature-valley-local-market">Nature Valley Crunchy Granola Bars</a></h2>',
      '<span class="a-price">$2.50</span><span>4.9 out of 5 stars</span><span>20,000 ratings</span><span>Ships from Lucky Supermarket. FREE delivery.</span>',
      '<button onclick="location.href=\'/cart?brand=local-market\'">Add to Cart</button>',
      '</div>',
     '<div data-component-type="s-search-result" data-asin="B000NVGOOD">',
      '<h2><a href="/dp/nature-valley-valid">Nature Valley Oats n Honey Granola Bars</a></h2>',
      '<span class="a-price">$3.50</span><span>4.7 out of 5 stars</span><span>12,000 ratings</span><span>Ships from Amazon.com. Prime delivery. FREE delivery Tomorrow.</span>',
      '<button onclick="location.href=\'/cart?brand=nature-valley-valid\'">Add to Cart</button>',
      '</div>',
      '</main>'
    ].join('');
  }
  if (pathname === '/dp/nutri-grain-decoy') {
    brandCandidateVisits.push('nutri-grain-decoy');
    return '<main><h1>Kellogg\'s Nutri-Grain Breakfast Blueberry Granola Bar</h1><p>$2.79</p><p>Buying options unavailable.</p></main>';
  }
 if (pathname === '/dp/nature-valley-unavailable') {
   brandCandidateVisits.push('nature-valley-unavailable');
   return '<main><h1>Nature Valley Crunchy Granola Bars</h1><div id="corePrice_feature_div"><span class="a-offscreen">$19.93</span></div><input id="add-to-cart-button" type="submit" value="Add to Cart" /></main>';
 }
  if (pathname === '/dp/nature-valley-local-market') {
    return '<main><h1>Nature Valley Crunchy Granola Bars</h1><div id="corePrice_feature_div"><span class="a-offscreen">$2.50</span></div><p>Ships from Lucky Supermarket. FREE delivery.</p><input id="add-to-cart-button" type="submit" value="Add to Cart" /></main>';
  }
  if (pathname === '/dp/nature-valley-valid') {
    brandCandidateVisits.push('nature-valley-valid');
    return [
      '<span id="nav-cart-count">0</span>',
      '<main><h1>Nature Valley Oats n Honey Granola Bars</h1>',
      '<div id="corePrice_feature_div"><span class="a-offscreen">$3.50</span></div>',
      '<span aria-label="Amazon Prime">Prime delivery</span>',
      '<div id="deliveryBlockMessage">FREE delivery</div>',
      '<input id="add-to-cart-button" type="submit" value="Add to Cart" onclick="location.href=\'/cart\'" />',
      '<input id="buy-now-button" type="submit" value="Buy Now" />',
      '<aside aria-label="Cart preview"><h2>Cart</h2><p>Subtotal $19.93</p><button onclick="location.href=\'/cart\'">Go to Cart</button></aside>',
      '</main>'
    ].join('');
  }
  if (pathname === '/conditional-shipping-search') {
    return [
      '<main>',
      '<h1>Results</h1>',
      '<form action="/conditional-shipping-search"><label>Search <input type="search" name="q" role="searchbox" /></label><button type="submit">Search</button></form>',
      '<div data-component-type="s-search-result" data-asin="NATURE-VALLEY-CONDITIONAL">',
      '<h2><a href="/dp/nature-valley-conditional">Nature Valley Sweet & Salty Almond Granola Bars</a></h2>',
      '<span class="a-price">$2.97</span><span>4.9 out of 5 stars</span><span>20,000 ratings</span><span aria-label="Amazon Prime">Prime Overnight</span><p>FREE delivery on $25 of qualifying items. Or $4.99 delivery in 3 hours.</p>',
      '<button>Add to Cart</button>',
      '</div>',
      '<div data-component-type="s-search-result" data-asin="B000NVGOOD">',
      '<h2><a href="/dp/nature-valley-valid-multi-price">Nature Valley Sweet & Salty Almond Granola Bars</a></h2>',
      '<span>Subscribe &amp; Save <span class="a-price"><span class="a-offscreen">$3.15</span></span></span><span>One-time purchase <span class="a-price"><span class="a-offscreen">$3.50</span></span></span><span>4.7 out of 5 stars</span><span>12,000 ratings</span><span aria-label="Amazon Prime">Prime delivery</span><p>FREE delivery Tomorrow</p>',
      '<button onclick="location.href=\'/cart?brand=nature-valley-valid&variant=almond\'">Add to Cart</button>',
      '</div>',
      '</main>'
    ].join('');
  }
  if (pathname === '/dp/nature-valley-conditional') {
    conditionalCandidateVisits.push('nature-valley-conditional');
    return [
      '<span id="nav-cart-count">0</span>',
      '<main><h1>Nature Valley Sweet & Salty Almond Granola Bars</h1>',
      '<div id="corePrice_feature_div"><span class="a-offscreen">$2.97</span></div>',
      '<span aria-label="Amazon Prime">Prime Overnight</span>',
      '<div id="deliveryBlockMessage">FREE delivery on $25 of qualifying items. Or $4.99 delivery in 3 hours.</div>',
      '<input id="add-to-cart-button" type="submit" value="Add to Cart" onclick="location.href=\'/cart?brand=conditional-paid\'" />',
      '</main>'
    ].join('');
  }
  if (pathname === '/dp/nature-valley-valid-multi-price') {
    mixedOfferCandidateVisits.push('nature-valley-valid-multi-price');
    return [
      '<span id="nav-cart-count">0</span>',
      '<main><h1>Nature Valley Sweet & Salty Almond Granola Bars</h1>',
      '<div id="desktop_buybox">',
      '<div>Subscribe &amp; Save <span class="a-price"><span class="a-offscreen" style="position:absolute;width:1px;height:1px;overflow:hidden">$3.15</span><span aria-hidden="true">$3.15</span></span></div>',
      '<div id="newAccordionRow">One-time purchase <span class="a-price"><span class="a-offscreen" style="position:absolute;width:1px;height:1px;overflow:hidden">$3.50</span><span aria-hidden="true">$3.50</span></span></div>',
      '<span aria-label="Amazon Prime">Prime delivery</span>',
      '<div id="deliveryBlockMessage">FREE delivery Tomorrow</div>',
      '<div id="merchant-info">Ships from Amazon.com. Sold by Amazon.com.</div>',
      '<input id="add-to-cart-button" type="submit" value="Add to Cart" onclick="location.href=\'/cart?brand=nature-valley-valid&variant=almond\'" />',
      '</div>',
      '<aside>Other offers may ship from Lucky Supermarket.</aside>',
      '</main>'
    ].join('');
  }
  if (pathname === '/selection-product-verification-failure-search') {
    return [
      '<main><h1>Results</h1>',
      '<div data-component-type="s-search-result" data-asin="B0F2PWJV7D">',
      '<h2><a href="/Test-Gadget/dp/B0F2PWJV7D/ref=sr_1_1">Test Gadget</a></h2>',
      '<span>Subscribe &amp; Save <span class="a-price">$3.50</span></span>',
      '<span>One-time purchase <span class="a-price">$4.97</span></span>',
      '<span aria-label="Amazon Prime">Prime delivery</span><p>FREE delivery Tomorrow</p>',
      '</div></main>'
    ].join('');
  }
  if (pathname === '/Test-Gadget/dp/B0F2PWJV7D/ref=sr_1_1') {
    return [
      '<main><h1>Test Gadget</h1>',
      '<div id="desktop_buybox">',
      '<div id="newAccordionRow">One-time purchase <span class="a-price"><span class="a-offscreen">$4.97</span></span></div>',
      '<span aria-label="Amazon Prime">Prime delivery</span>',
      '<div id="deliveryBlockMessage">FREE delivery Tomorrow</div>',
      '<div id="merchant-info">Ships from Amazon.com. Sold by Amazon.com.</div>',
      '<input id="add-to-cart-button" type="submit" value="Add to Cart" onclick="sessionStorage.setItem(\'verification-failure-cart-clicks\', String(Number(sessionStorage.getItem(\'verification-failure-cart-clicks\') || 0) + 1))" />',
      '</div></main>'
    ].join('');
  }
  if (pathname === '/late-shipping-search') {
    return [
      '<main>',
      '<h1>Results</h1>',
      '<form action="/late-shipping-search"><label>Search <input type="search" name="q" role="searchbox" /></label><button type="submit">Search</button></form>',
      '<div data-component-type="s-search-result" data-asin="TEST-GADGET-LATE-PAID">',
      '<h2><a href="/dp/test-gadget-late-paid">Test Gadget Prime Snack Pack</a></h2>',
      '<span class="a-price">$3.50</span><span>4.9 out of 5 stars</span><span>20,000 ratings</span><span aria-label="Amazon Prime">Prime delivery</span><p>FREE delivery Tomorrow</p>',
      '</div>',
      '<div data-component-type="s-search-result" data-asin="TEST-GADGET-FREE-PRIME">',
      '<h2><a href="/dp/test-gadget-free-prime">Test Gadget Free Prime Pack</a></h2>',
      '<span class="a-price">$3.75</span><span>4.7 out of 5 stars</span><span>12,000 ratings</span><span aria-label="Amazon Prime">Prime delivery</span><p>FREE delivery Tomorrow</p>',
      '</div>',
      '</main>'
    ].join('');
  }
  if (pathname === '/dp/test-gadget-late-paid') {
    lateShippingCandidateVisits.push('test-gadget-late-paid');
    return [
      '<span id="nav-cart-count">0</span>',
      '<main><h1>Test Gadget Prime Snack Pack</h1>',
      '<div id="corePrice_feature_div"><span class="a-offscreen">$3.50</span></div>',
      '<span aria-label="Amazon Prime">Prime delivery</span>',
      '<div id="deliveryBlockMessage">FREE delivery Tomorrow</div>',
      '<input id="add-to-cart-button" type="submit" value="Add to Cart" onclick="location.href=\'/cart?late=paid\'" />',
      '</main>'
    ].join('');
  }
  if (pathname === '/dp/test-gadget-free-prime') {
    lateShippingCandidateVisits.push('test-gadget-free-prime');
    return [
      '<span id="nav-cart-count">0</span>',
      '<main><h1>Test Gadget Free Prime Pack</h1>',
      '<div id="corePrice_feature_div"><span class="a-offscreen">$3.75</span></div>',
      '<span aria-label="Amazon Prime">Prime delivery</span>',
      '<div id="deliveryBlockMessage">FREE delivery Tomorrow</div>',
      '<input id="add-to-cart-button" type="submit" value="Add to Cart" onclick="location.href=\'/cart?late=free\'" />',
      '</main>'
    ].join('');
  }
  if (pathname === '/multi-search') {
    const query = String(searchParams.get('q') || '').toLowerCase();
    const items = multiCatalog.filter((item) => query.includes(item.query) || (item.query === 'chocolate' && /hershey/.test(query)));
    return [
      '<main>',
      '<h1>Results</h1>',
      '<form action="/multi-search"><label>Search <input type="search" name="q" role="searchbox" /></label><button type="submit">Search</button></form>',
      ...items.map((item) => [
        `<div data-component-type="s-search-result" data-asin="BROWSER-SMOKE-${item.id.toUpperCase()}">`,
        `<h2><a href="/dp/${item.id}">${item.title}</a></h2>`,
        `<span class="a-price">$${item.price.toFixed(2)}</span><span>${item.rating} out of 5 stars</span><span>${item.reviews} ratings</span><span>${item.fulfillment}</span>`,
        '</div>'
      ].join('')),
      '</div>',
      '</main>'
    ].join('');
  }
  if (pathname.startsWith('/dp/')) {
    const item = multiCatalog.find((candidate) => pathname === `/dp/${candidate.id}`);
    if (item) return `<main><h1>${item.title}</h1><p>$${item.price.toFixed(2)}</p><button onclick="location.href='/multi-cart?add=${item.id}'">Add to cart</button></main>`;
  }
  if (pathname === '/multi-cart') {
    const added = String(searchParams.get('add') || '');
    if (added && !multiBasketItems.includes(added)) multiBasketItems.push(added);
    const selectedItems = multiBasketItems.map((item) => multiCatalog.find((candidate) => candidate.id === item)).filter(Boolean);
    const total = selectedItems.reduce((sum, item) => sum + item.price, 0);
    const labels = selectedItems.map((item) => item.title);
    return [
      '<main><h1>Your cart</h1>',
      `<p>${labels.join(' · ') || 'No items yet'}</p>`,
      `<p>Subtotal (${multiBasketItems.length} ${multiBasketItems.length === 1 ? 'item' : 'items'}): $${total.toFixed(2)}</p>`,
      '<button onclick="location.href=\'/checkout\'">Proceed to checkout</button>',
      '</main>'
    ].join('');
  }
  if (pathname === '/dp/test-gadget') {
    const delayed = delayFirstProductControl;
    delayFirstProductControl = false;
    const addControl = '<input id="add-to-cart-button-ubb" name="submit.add-to-cart.retail" type="submit" value="Add to Cart" onclick="location.href=\'/cart\'" />';
    return [
      '<main><h1>Test Gadget</h1><p>$3.50</p><span aria-label="Amazon Prime">Prime delivery</span><div id="deliveryBlockMessage">FREE delivery</div>',
      delayed ? '<div id="purchase-box">Loading purchase options...</div>' : addControl,
      '</main>',
      delayed ? `<script>setTimeout(() => { document.querySelector('#purchase-box').outerHTML = ${JSON.stringify(addControl)}; }, 1800);</script>` : ''
    ].join('');
  }
  if (pathname === '/cart-preview-start') {
    return [
      '<main><h1>Results for "test gadget"</h1>',
      '<p>Search results are visible, but the approved item is already in the cart preview.</p>',
      '<aside aria-label="Cart preview">',
      '<h2>Cart</h2>',
      '<p>Test Gadget</p>',
      '<p>Subtotal $3.50</p>',
      '<button onclick="location.href=\'/cart\'">Go to Cart</button>',
      '<button aria-label="Decrease quantity">-</button>',
      '<button aria-label="Increase quantity">+</button>',
      '</aside>',
      '</main>'
    ].join('');
  }
  if (pathname === '/post-add-confirmation') {
    return [
      '<main data-testid="added-to-cart-confirmation">',
      '<nav><span id="nav-link-accountList-nav-line-1">Hello, Test Shopper</span><a id="nav-cart" href="/cart?source=post-add-header"><span id="nav-cart-count">1</span> Cart</a></nav>',
      '<h1>Added to cart</h1>',
      '<section><p>Nature Valley Crunchy Granola Bars</p><p>Cart Subtotal: $3.50</p>',
      '<div id="sw-ptc"><button onclick="location.href=\'/checkout/from-post-add\'">Proceed to checkout (1 item)</button></div>',
      '<div id="sw-gtc"><a href="/cart?source=post-add-confirmation">Go to Cart</a></div>',
      '</section>',
      '<aside aria-label="Cart preview"><p>Subtotal $3.50</p><a href="/cart?source=post-add-side">Go to Cart</a></aside>',
      '</main>'
    ].join('');
  }
  if (pathname === '/cart-accessibility-title') {
    return [
      '<main><h1>Your cart</h1>',
      '<div id="activeCartViewForm">',
      '<div class="sc-list-item" data-asin="NATURE-VALLEY-ALMOND">',
      '<a href="/dp/NATURE-VALLEY-ALMOND">Nature Valley Sweet &amp; Salty Almond Granola Bars, 6 ct, 7.2 oz<span class="a-offscreen"> | ... Opens in a new tab</span></a>',
      '<p>$2.97</p><label>Quantity: <select name="quantity"><option selected>1</option></select></label><button data-action="delete">Delete</button>',
      '</div></div><p>Subtotal (1 item): $2.97</p>',
      '</main>'
    ].join('');
  }
  if (pathname === '/cart-duplicated-title') {
    const title = 'Nature Valley Granola Bar, Oats and Honey, 1.5 oz';
    return [
      '<main><h1>Your cart</h1>',
      '<div id="activeCartViewForm">',
      '<div class="sc-list-item" data-asin="NATURE-VALLEY-OATS-HONEY">',
      `<a href="/dp/NATURE-VALLEY-OATS-HONEY"><span>${title}</span><span aria-hidden="true">${title}</span></a>`,
      '<p>$2.97</p><label>Quantity: <select name="quantity"><option selected>1</option></select></label><button data-action="delete">Delete</button>',
      '</div></div><p>Subtotal (1 item): $2.97</p>',
      '</main>'
    ].join('');
  }
  if (pathname === '/cart' || pathname === '/gp/cart/view.html') {
    if (searchParams.get('brand') === 'nature-valley-valid') {
      brandCartItem = searchParams.get('variant') === 'almond' ? 'nature-valley-almond-valid' : 'nature-valley-valid';
    }
    if (searchParams.get('late') === 'paid') {
      lateShippingCartItem = 'paid';
      checkoutFixture = {
        ...checkoutFixture,
        total: '$7.49',
        merchandiseSubtotal: '$3.50',
        shipping: '$3.99',
        itemCount: 1,
        freeDeliveryAvailable: false
      };
    }
    if (searchParams.get('late') === 'free') {
      lateShippingCartItem = 'free';
      checkoutFixture = {
        ...checkoutFixture,
        total: '$3.75',
        merchandiseSubtotal: '$3.75',
        shipping: '$0.00',
        itemCount: 1,
        freeDeliveryAvailable: true
      };
    }
    const selectedBrandItem = ['nature-valley-valid', 'nature-valley-almond-valid'].includes(brandCartItem);
    const selectedLatePaidItem = lateShippingCartItem === 'paid';
    const selectedLateFreeItem = lateShippingCartItem === 'free';
    const cartAsin = selectedBrandItem ? 'B000NVGOOD' : selectedLatePaidItem ? 'TEST-GADGET-LATE-PAID' : selectedLateFreeItem ? 'TEST-GADGET-FREE-PRIME' : 'B000SMOKE1';
    const cartUrl = selectedBrandItem ? '/dp/nature-valley-valid' : selectedLatePaidItem ? '/dp/test-gadget-late-paid' : selectedLateFreeItem ? '/dp/test-gadget-free-prime' : '/dp/test-gadget';
    const cartTitle = brandCartItem === 'nature-valley-almond-valid'
      ? 'Nature Valley Sweet & Salty Almond Granola Bars'
      : selectedBrandItem ? 'Nature Valley Oats n Honey Granola Bars' : selectedLatePaidItem ? 'Test Gadget Prime Snack Pack' : selectedLateFreeItem ? 'Test Gadget Free Prime Pack' : 'Test Gadget';
    const cartPrice = selectedLateFreeItem ? '$3.75' : '$3.50';
    const cartDelivery = selectedLatePaidItem
      ? 'Prime Overnight. FREE delivery on $25 of qualifying items. Or $3.99 delivery Tomorrow.'
      : 'Prime delivery. FREE delivery Tomorrow.';
    const checkoutTarget = checkoutFixture.checkoutPrelude
      ? `/checkout/byg?sessionID=browser-smoke&useDefaultCart=1&cartItemCount=1&partialCheckoutCart=1&pipelineType=Chewbacca&referrer=cart&tangoIngressUrl=${encodeURIComponent('/checkout/entry/cart?proceedToCheckout=1&pipelineType=Chewbacca&referrer=cart')}`
      : '/checkout/p/p-106-7044535-6467434/pip?pipelineType=Chewbacca&referrer=cart';
    return [
      '<a href="#skippedLink">Skip to main content</a>',
      '<main><h1>Your cart</h1>',
      `<div id="activeCartViewForm"><div class="sc-list-item" data-asin="${cartAsin}"><a href="${cartUrl}">${cartTitle}</a><span aria-label="Amazon Prime">Prime delivery</span><p>${cartDelivery}</p><button data-action="delete" onclick="lateShippingCartItem=null; brandCartItem=null; document.querySelector('#activeCartViewForm').innerHTML='<p>Your cart is empty.</p>'; document.querySelector('#nav-cart-count')?.replaceChildren(document.createTextNode('0'));">Delete</button></div></div>`,
      `<p>Subtotal (1 item): ${cartPrice}</p>`,
      '<button>Subscribe & Save</button>',
      `<span id="sc-buy-box-ptc-button"><input type="submit" name="proceedToRetailCheckout" value="Proceed to checkout" onclick="location.href='${checkoutTarget}'" /></span>`,
      '</main>',
      '<aside data-item-index="recommended-melitta"><a href="/dp/MELITTA-COFFEE">Melitta Junior Basket Coffee Filter</a><span>Free delivery</span></aside>',
      '<aside>',
      '<p>Add $32.21 of eligible items or Join Prime to get FREE delivery on eligible items with no order minimum.</p>',
      '<button>Try Prime FREE</button>',
      '<button>No thanks</button>',
      '</aside>'
    ].join('');
  }
  if (pathname === '/checkout/byg') {
    return '';
  }
  if (pathname === '/alm/byg') {
    return [
      '<main><h1>Need anything else?</h1>',
      '<section><h2>Recommended for you</h2><button>Add a suggested item</button></section>',
      '<button onclick="location.href=\'/alm/substitution?pipelineType=Chewbacca&referrer=cart\'">Continue</button>',
      '</main>'
    ].join('');
  }
  if (pathname === '/alm/substitution') {
    return [
      '<main><h1>Choose your substitution preferences</h1>',
      '<p>Substitute with best available.</p>',
      '<button>Change</button>',
      '<button onclick="location.href=\'/checkout/p/p-106-7044535-6467434/pip?pipelineType=Chewbacca&referrer=prime\'">Continue</button>',
      '</main>'
    ].join('');
  }
  if (pathname === '/checkout/entry/cart') {
    return [
      '<main><h1>Opening checkout</h1>',
      '<script>setTimeout(() => { location.href = "/checkout/p/p-106-7044535-6467434/pip?pipelineType=Chewbacca&referrer=cart"; }, 50);</script>',
      '</main>'
    ].join('');
  }
  if (pathname === '/checkout/p/p-106-7044535-6467434/pip') {
    return [
      '<main><h1>Try Prime FREE for 30 days</h1>',
      '<p>Receive eligible items tomorrow with Prime. After trial, Prime auto-renews.</p>',
      '<p>Select a payment method for Prime. Visa ending in 0109.</p>',
      '<a class="a-link-normal" href="/checkout/p/p-106-7044535-6467434/spc?pipelineType=Chewbacca&referrer=spc"><span>No thanks</span></a>',
      '<button>Get FREE One-Day Delivery with Prime</button>',
      '</main>'
    ].join('');
  }
  if (pathname === '/checkout' || pathname === '/checkout/p/p-106-7044535-6467434/spc') {
    const confirmedPendingOrder = searchParams.get('confirmed') === '1';
    const selectedCardLast4 = confirmedPendingOrder ? '6383' : String(checkoutFixture.selectedCardLast4 || '0109');
    const selectedCardBrand = ['1817', '6383'].includes(selectedCardLast4) ? 'Mastercard' : 'Visa';
    const addressPrimeModal = checkoutFixture.showAddressPrimeModal
      ? [
          '<div id="prime-address-modal" role="dialog" aria-modal="true">',
          '<h2>Try Prime free for 30 days and get Two-Day Delivery</h2>',
          '<p>After trial, Prime auto-renews. Cancel anytime.</p>',
          '<p>Select a payment method for Prime. Visa ending in 0109.</p>',
          '<button onclick="document.querySelector(\'#prime-address-modal\').remove()">No thanks</button>',
          '<button>Start your free trial of Prime</button>',
          '</div>'
        ].join('')
      : '';
    const matchingAddressSummary = checkoutFixture.matchingAddressSummary || '1 Magic City Way, San Francisco, CA 94107';
    const matchingAddressText = checkoutFixture.matchingAddressText || 'Test User 1 Magic City Way, San Francisco, CA 94107, United States Phone number: 415-555-0100';
    const conflictingUnitChoice = checkoutFixture.includeConflictingUnitAddress
      ? '<label><input type="radio" name="address" data-summary="1 MAGIC CITY ST, UNIT 999, SAN FRANCISCO, CA 94107" /> Test User 1 MAGIC CITY ST Unit 999 San Francisco, CA 94107 United States</label>'
      : '';
    const matchingAddressChoice = checkoutFixture.matchingAddressAvailable
      ? `<label><input type="radio" name="address" data-summary="${matchingAddressSummary}"${checkoutFixture.matchingAddressChecked ? ' checked' : ''} /> ${matchingAddressText}</label>`
      : '';
    const selectedFreeDelivery = confirmedPendingOrder || checkoutFixture.selectedFreeDelivery === true;
    const freeDeliveryOptions = checkoutFixture.freeDeliveryAvailable === false
      ? ''
      : [
          '<label><input type="radio" name="delivery" /> Standard delivery FREE</label>',
          `<label><input type="radio" name="delivery"${selectedFreeDelivery ? ' checked' : ''} /> One-Day delivery FREE</label>`
        ].join('');
    return [
      addressPrimeModal,
      '<main><h1>Review your order</h1>',
      `<p>Order total: ${checkoutFixture.total}</p>`,
      `<p>Items: ${checkoutFixture.merchandiseSubtotal || checkoutFixture.total}</p>`,
      `<p>Shipping &amp; handling: ${checkoutFixture.shipping || '$0.00'}</p>`,
      `<p>Subtotal (${checkoutFixture.itemCount} ${checkoutFixture.itemCount === 1 ? 'item' : 'items'}): ${checkoutFixture.merchandiseSubtotal || checkoutFixture.total}</p>`,
      '<div class="checkout-card"><div class="checkout-card-copy">',
      '<h2>Delivering to Test User</h2>',
      `<p id="delivery-summary">${confirmedPendingOrder ? '1 Magic City Way, San Francisco, CA 94107' : '99 Wrong Road, New York, NY 10001'}</p>`,
      '<p>Add delivery instructions</p></div>',
      '<div class="checkout-card-action"><a href="#" onclick="event.preventDefault(); (window.__checkoutEvents ||= []).push(\'open-address\'); document.querySelector(\'#address-options\').hidden=false">Change</a></div>',
      '<div id="address-options" hidden>',
      '<label><input type="radio" name="address" /> 99 Wrong Road, 10001</label>',
      conflictingUnitChoice,
      matchingAddressChoice,
      '<button onclick="(window.__checkoutEvents ||= []).push(\'confirm-address-choice\'); const selected=document.querySelector(\'input[name=address]:checked\'); if(selected?.dataset.summary){document.querySelector(\'#delivery-summary\').textContent=selected.dataset.summary; document.querySelector(\'#address-options\').hidden=true}">Deliver to this address</button>',
      '<button onclick="(window.__checkoutEvents ||= []).push(\'open-new-address\'); document.querySelector(\'#new-address-form\').hidden=false">Add a new delivery address</button></div>',
      `<div id="new-address-form" role="dialog" aria-modal="true" style="position:fixed;inset:24px;z-index:10;background:white;overflow:auto" ${checkoutFixture.startWithNewAddressModal ? '' : 'hidden'}><h2>Add a new delivery address</h2>`,
      '<input aria-label="Full name" value="Wrong Name" />',
      '<input aria-label="Phone number" value="2125550100" />',
      '<input aria-label="Street address" value="99 Wrong Road" />',
      '<input aria-label="City" value="New York" />',
      '<select aria-label="State"><option value="CA">California</option><option value="NY" selected>New York</option></select>',
      '<input aria-label="ZIP code" value="10001" />',
      '<button onclick="(window.__checkoutEvents ||= []).push(\'confirm-new-address\'); const street=document.querySelector(\'[aria-label=\\\'Street address\\\']\').value; const city=document.querySelector(\'[aria-label=\\\'City\\\']\').value; const state=document.querySelector(\'[aria-label=\\\'State\\\']\').value; const zip=document.querySelector(\'[aria-label=\\\'ZIP code\\\']\').value; document.querySelector(\'#delivery-summary\').textContent=`${street}, ${city}, ${state} ${zip}`; document.querySelector(\'#new-address-form\').hidden=true; document.querySelector(\'#address-options\').hidden=true">Deliver to this address</button></div></div>',
      '<div class="checkout-card"><div class="checkout-card-copy">',
      `<h2 id="payment-summary">Paying with ${selectedCardBrand} ${selectedCardLast4}</h2>`,
      '<p>Use a gift card, voucher, or promo code</p></div>',
      '<div class="checkout-card-action"><a href="#" onclick="event.preventDefault(); (window.__checkoutEvents ||= []).push(\'open-payment\'); document.querySelector(\'#payment-options\').hidden=false">Change</a></div>',
      '<div id="payment-options" hidden>',
      `<label><input style="position:absolute;opacity:0;width:1px;height:1px" type="radio" name="payment" ${selectedCardLast4 === '0109' ? 'checked' : ''} /> Visa ending in 0109</label>`,
      `<label><input style="position:absolute;opacity:0;width:1px;height:1px" type="radio" name="payment" ${selectedCardLast4 === '1817' ? 'checked' : ''} /> Mastercard ending 1817</label>`,
      `<label><input style="position:absolute;opacity:0;width:1px;height:1px" type="radio" name="payment" ${selectedCardLast4 === '6383' ? 'checked' : ''} /> Mastercard ending in 6383</label>`,
      '<a href="#" onclick="event.preventDefault(); document.querySelector(\'#add-card-form\').hidden=false">Add a credit or debit card</a>',
      '<button id="use-payment-method" onclick="(window.__checkoutEvents ||= []).push(\'confirm-payment\'); const selected=document.querySelector(\'input[name=payment]:checked\'); const text=selected?.closest(\'label\')?.innerText || \'\'; if(selected && /(?:visa|mastercard|amex|discover)/i.test(text)){document.querySelector(\'#payment-summary\').textContent=`Paying with ${text.replace(/ ending in /i, \' \')}`; document.querySelector(\'#payment-options\').hidden=true}">Use this payment method</button></div>',
      '<div id="add-card-form" hidden><h2>Add a credit or debit card</h2><input id="card-number-input" aria-label="Card number" autocomplete="cc-number" /><input aria-label="Name on card" autocomplete="cc-name" /><button onclick="const number=document.querySelector(\'#card-number-input\').value.replace(/\\D/g,\'\'); const last4=number.slice(-4); document.querySelector(\'#payment-summary\').textContent=`Paying with Mastercard ${last4}`; document.querySelector(\'#add-card-form\').hidden=true; document.querySelector(\'#payment-options\').hidden=true">Add your card</button></div></div>',
      '<div class="checkout-card"><div class="checkout-card-copy">',
      '<h2>Shipping speed</h2>',
      `<p>${selectedFreeDelivery ? 'One-Day delivery FREE' : 'Fast delivery $3.99'}</p></div>`,
      '<div class="checkout-card-action"><a href="#" onclick="event.preventDefault(); document.querySelector(\'#delivery-options\').hidden=false">Change</a></div>',
      '<div id="delivery-options" hidden>',
      '<label><input type="radio" name="delivery" /> Fast delivery $3.99</label>',
      freeDeliveryOptions,
      '<label><input type="radio" name="delivery" /> Try Prime FREE one-day trial</label></div></div>',
      `<input aria-label="Billing street address" value="${confirmedPendingOrder ? '99 Billing Plaza' : '1 Wrong Billing Way'}" />`,
      `<input aria-label="Billing ZIP code" value="${confirmedPendingOrder ? '10001' : '99999'}" />`,
      `<div id="amazon-final-order-wrapper" role="button"><span class="a-button-text">Place your order</span><input id="submitOrderButtonId" type="submit" onclick="sessionStorage.setItem('magic-city-native-final-click', String(Number(sessionStorage.getItem('magic-city-native-final-click') || 0) + 1)); ${checkoutFixture.pendingOrderContinuation ? "location.href='/checkout/duplicateOrder?pipelineType=Chewbacca&cartItemCount=1'" : "document.querySelector('#order-result').textContent='Order placed'; return false"}" /></div>`,
      `<p id="order-result">${confirmedPendingOrder ? 'Order placed' : ''}</p>`,
      confirmedPendingOrder ? '<script>document.querySelector(\'[aria-label="Street address"]\').value="1 Magic City Way"; document.querySelector(\'[aria-label="City"]\').value="San Francisco"; document.querySelector(\'[aria-label="State"]\').value="CA"; document.querySelector(\'[aria-label="ZIP code"]\').value="94107"; document.querySelector(\'#new-address-form\').hidden=true; document.querySelector(\'#address-options\').hidden=true; document.querySelector(\'#payment-options\').hidden=true;</script>' : '',
      '</main>'
    ].join('');
  }
  if (pathname === '/checkout/pay-confirm') {
    return [
      '<main><h1>Select a payment method</h1>',
      '<section aria-label="Order summary">',
      '<p>Items: $2.97</p>',
      '<p>Shipping &amp; handling: $0.00</p>',
      '<p>Order total: $2.97</p>',
      '</section>',
      '<section aria-label="Payment method">',
      '<h2 id="payment-summary">Paying with Mastercard 6383</h2>',
      '<div id="payment-options-noise">',
      '<label><input type="radio" name="payment" /> Visa ending in 0109</label>',
      '<label><input type="radio" name="payment" checked /> Mastercard ending in 6383</label>',
      '<label>Reference number (optional): <input aria-label="Reference number (optional)" type="text" /></label>',
      '<a href="#add-card">Add a credit or debit card</a>',
      '<a href="#gift-card">Use a gift card, voucher, or promo code</a>',
      '</div>',
      '<span class="a-button"><span class="a-button-inner"><input id="payment-confirm-top" name="payment-confirm-top" type="submit" aria-labelledby="payment-confirm-top-announce" onclick="sessionStorage.setItem(\'magic-city-payment-confirm-clicks\', String(Number(sessionStorage.getItem(\'magic-city-payment-confirm-clicks\') || 0) + 1)); setTimeout(() => { location.href=\'/checkout/final-review\' }, 650)" /><span id="payment-confirm-top-announce" class="a-button-text">Use this payment method</span></span></span>',
      '<div style="height: 300px"></div>',
      '<span class="a-button"><span class="a-button-inner"><input id="payment-confirm-bottom" name="payment-confirm-bottom" type="submit" aria-labelledby="payment-confirm-bottom-announce" onclick="sessionStorage.setItem(\'magic-city-payment-confirm-clicks\', String(Number(sessionStorage.getItem(\'magic-city-payment-confirm-clicks\') || 0) + 1)); setTimeout(() => { location.href=\'/checkout/final-review\' }, 650)" /><span id="payment-confirm-bottom-announce" class="a-button-text">Use this payment method</span></span></span>',
      '</section>',
      '<section aria-label="Delivery address">',
      '<h2>Delivering to Test User</h2>',
      '<p>1 Magic City Way, San Francisco, CA 94107, United States</p>',
      '<a href="#">Change</a>',
      '</section>',
      '</main>'
    ].join('');
  }
  if (pathname === '/checkout/final-review') {
    const pickupDisclosure = checkoutFixture.showPickupDisclosure
      ? [
          '<button id="pickup-disclosure" onclick="window.__checkoutEvents ||= []; window.__checkoutEvents.push(\'bad-pickup-disclosure-opened\'); document.querySelector(\'#pickup-modal\')?.removeAttribute(\'hidden\')">FREE pickup available nearby</button>',
          '<button id="pickup-change" onclick="window.__checkoutEvents ||= []; window.__checkoutEvents.push(\'bad-change-to-pickup\'); document.querySelector(\'#pickup-modal\')?.removeAttribute(\'hidden\')">Change to pickup</button>'
        ].join('')
      : '';
    const pickupModal = checkoutFixture.showPickupModal
      ? [
          `<div id="pickup-modal" class="a-popover a-popover-modal"${checkoutFixture.showPickupDisclosure ? ' hidden' : ''} style="position:fixed;inset:48px;z-index:20;background:white;border:1px solid #999;padding:16px;overflow:auto">`,
          '<button id="pickup-close" aria-label="Close" onclick="sessionStorage.setItem(\'magic-city-pickup-overlay-closed\', \'1\'); document.querySelector(\'#pickup-modal\').remove()">×</button>',
          '<h2>Select a pickup location</h2>',
          '<label>Find pickup locations near: <input placeholder="Enter an address, zip code, or landmark" /></label>',
          '<section><h3>Amazon Counter at Whole Foods Market</h3><p>774 Emerson St, Palo Alto, CA 94301</p><p>FREE pickup Friday, Aug 28</p><button onclick="window.__checkoutEvents ||= []; window.__checkoutEvents.push(\'bad-pickup-selected\')">Pick up here</button></section>',
          '</div>'
        ].join('')
      : '';
    return [
      pickupModal,
      '<main><h1>Review your order</h1>',
      '<section aria-label="Order summary"><p>Items: $2.97</p><p>Shipping &amp; handling: $0.00</p><p>Order total: $2.97</p></section>',
      '<section aria-label="Payment method"><h2>Paying with Mastercard 6383</h2></section>',
      `<section aria-label="Delivery address"><h2>Delivering to Test User</h2><p>1 Magic City Way, San Francisco, CA 94107, United States</p>${pickupDisclosure}</section>`,
      '<label><input id="merchant-checkout-default" type="checkbox" /> Default to this delivery address and payment method.</label>',
      // Amazon can put the visible final-order words on a wrapper while the
      // native input itself has no standalone accessible label. Keep this
      // realistic shape so the runner must preserve the wrapper validation
      // when dispatching the native click.
      '<div id="amazon-final-order-wrapper" role="button"><span class="a-button-text">Place your order</span><input id="submitOrderButtonId" type="submit" /></div>',
      `<script>document.addEventListener('click', (event) => { if (event.target?.id !== 'submitOrderButtonId') return; sessionStorage.setItem('magic-city-native-final-click', '1'); ${checkoutFixture.pendingOrderContinuation ? "location.href='/checkout/duplicateOrder?pipelineType=Chewbacca&cartItemCount=1'" : "document.body.dataset.orderSubmitted='1'; event.preventDefault()"}; }, true)</script>`,
      '</main>'
    ].join('');
  }
  if (pathname === '/checkout/pending-order' || pathname === '/checkout/duplicateOrder') {
    const sparseDuplicateOrder = pathname === '/checkout/duplicateOrder';
    const liveSparseDuplicateOrder = sparseDuplicateOrder && searchParams.get('live') === '1';
    const pendingVariant = searchParams.get('variant');
    const pendingTitle = pendingVariant === 'cashew'
      ? 'Nature Valley Cashew Granola Bars'
      : pendingVariant === 'almond'
        ? 'Nature Valley Sweet & Salty Almond Granola Bars, 6 ct, 7.2 oz'
        : pendingVariant === 'almond-pack-mismatch'
          ? 'Nature Valley Sweet & Salty Almond Granola Bars, 12 ct, 14.4 oz'
        : pendingVariant === 'single-oats'
          ? 'Nature Valley Granola Bar, Oats and Honey, 1.5 oz'
      : liveSparseDuplicateOrder
        ? 'Nature Valley Crunchy Granola Bars, Oats & Honey, 12 ct, 8.94 oz'
        : 'Test Gadget';
    const pendingAsin = pendingVariant === 'cashew' ? 'NATURE-VALLEY-CASHEW' : 'B000SMOKE1';
    const pendingQuantity = Number(searchParams.get('quantity')) || null;
    const pendingUnitPrice = Number(searchParams.get('unitPrice')) || 3.5;
    const pendingComparisonUnitPrice = Number(searchParams.get('comparisonUnitPrice')) || 0.33;
    const pendingComparisonUnit = searchParams.get('comparisonUnit') || 'ounce';
    const siblingPriceOnly = searchParams.get('siblingPriceOnly') === '1';
    const pendingOrderTotal = Number(searchParams.get('orderTotal')) || pendingUnitPrice;
    const pendingClick = searchParams.get('stay') === '1'
      ? ''
      : Number(checkoutFixture.pendingOrderConfirmationDelayMs) > 0
        ? `location.href='/checkout/processing-order?delay=${Number(checkoutFixture.pendingOrderConfirmationDelayMs)}';`
        : "location.href='/checkout?confirmed=1';";
    return [
      '<main><h1>This is a pending order</h1>',
      liveSparseDuplicateOrder
        ? `<section class="a-section"><div class="a-fixed-left-grid"><img alt="" /><div class="a-fixed-left-grid-inner"><span class="a-size-base">${pendingTitle}</span>${siblingPriceOnly ? '' : `<div><span class="a-price"><span aria-hidden="true">$${pendingUnitPrice.toFixed(2)}</span></span> <span>($${pendingComparisonUnitPrice.toFixed(2)} / ${pendingComparisonUnit})</span></div>`}<span>Ships from and sold by Amazon.com</span></div>${siblingPriceOnly ? `<div class="a-fixed-left-grid-inner"><span class="a-size-base">Different sibling product</span><span class="a-price"><span aria-hidden="true">$${pendingUnitPrice.toFixed(2)}</span></span></div>` : ''}</div></section>`
        : `<section data-asin="${pendingAsin}"><a href="/dp/${pendingAsin}">${pendingTitle}</a><p>$${pendingUnitPrice.toFixed(2)}</p>${pendingQuantity ? `<p>Quantity: ${pendingQuantity}</p>` : ''}</section>`,
      sparseDuplicateOrder ? '' : `<p>Order total: $${pendingOrderTotal.toFixed(2)}</p>`,
      '<p>Do you want to order these items again?</p>',
      '<div id="amazon-pending-order-wrapper" role="button"><span class="a-button-text">Place your order</span><input id="confirmPendingOrderButtonId" type="submit" /></div>',
      `<script>document.addEventListener('click', (event) => { if (event.target?.id !== 'confirmPendingOrderButtonId') return; const count=Number(sessionStorage.getItem('magic-city-pending-final-clicks')||0)+1; sessionStorage.setItem('magic-city-pending-final-clicks',String(count)); ${pendingClick} }, true)</script>`,
      '</main>'
    ].join('');
  }
  if (pathname === '/checkout/processing-order') {
    const delayMs = Math.max(1_000, Math.min(90_000, Number(searchParams.get('delay')) || 1_000));
    return [
      '<main><h1>Processing order</h1>',
      '<p>Amazon is confirming this purchase.</p>',
      `<script>setTimeout(() => { location.href='/checkout?confirmed=1'; }, ${delayMs})</script>`,
      '</main>'
    ].join('');
  }
  if (pathname === '/checkout/order-confirmation') {
    return [
      '<main><h1>Order placed</h1>',
      '<p>Thank you, your order has been placed.</p>',
      '</main>'
    ].join('');
  }
  const catalogNoise = Array.from({ length: 1200 }, (_, index) => `<a href="/help/noise-${index}">Catalog navigation ${index}</a>`).join('');
  return [
    '<main>',
    '<nav><span id="nav-link-accountList-nav-line-1">Hello, Test Shopper</span><a href="/prime">Join Prime</a><button>No thanks</button></nav>',
    '<h1>Results for test gadget</h1>',
    '<form action="/search"><label>Search <input type="search" name="q" role="searchbox" /></label><button type="submit">Search</button></form>',
    '<section aria-label="Search filters"><label for="prime-filter"><input id="prime-filter" type="checkbox" aria-label="Prime" /> Prime</label><label for="free-shipping-filter"><input id="free-shipping-filter" type="checkbox" aria-label="Free shipping" /> Free shipping</label></section>',
    catalogNoise,
    '<div data-component-type="s-search-result" data-asin="B000SMOKE1">',
    '<h2><a href="/dp/test-gadget">Test gadget</a></h2>',
    '<span class="a-price"><span class="a-offscreen">$3.50</span></span><span>4.7 out of 5 stars</span><span>1,240 ratings</span><span aria-label="Amazon Prime">Prime delivery</span><span>FREE delivery</span>',
    '<button id="browser-smoke-search-add" onclick="location.href=\'/post-add-confirmation\'">Add to cart</button>',
    '</div>',
    '<aside id="browser-smoke-sidecart" aria-label="Cart preview" hidden><p>Subtotal $3.50</p><button onclick="location.href=\'/cart?source=browser-smoke-sidecart\'">Go to Cart</button></aside>',
    '<a id="nav-cart" href="/cart?source=browser-smoke-header"><span id="nav-cart-count">0</span> Cart</a>',
    '</main>'
  ].join('');
}

async function main() {
  const smokeMode = process.env.MAGIC_CITY_BROWSER_SMOKE_FOCUS || 'full';
  console.log(`native-runner browser smoke starting (${smokeMode})`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'magic-city-extension-browser-'));
  let context = null;
  let server = null;
  // Playwright's browser protocol promises are intentionally unref'd. Keep
  // Node alive until the assertions below resolve instead of letting a quiet
  // MV3 startup make the smoke exit before it exercises any scenario.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    const certificate = createCertificate(tmpDir);
    const checkpoints = [];
    const claimedSessionIds = [];
    let registrationRequestCount = 0;
    let sessionListRequestCount = 0;
    let selectionRankRequestCount = 0;
    let selectionRankRequestBody = null;
    let fulfillment = null;
    let session = null;
    let distractorSession = null;
    let slowInitialSearchResponse = true;
    // Exhaust the in-action retries once. The runner must preserve the plan
    // cursor, schedule a resume, and finish instead of posting a failed receipt.
    let transientRunnerStatusFailures = 3;
    let transientRunnerStatusFailureCount = 0;
    // The final click must not depend on a slow control-plane status request.
    // This models cs-225: the worker resumes after a long technical pause,
    // while status reporting is temporarily unavailable at final review.
    let blockRunnerStatusForFinalDispatch = false;
    let blockedFinalRunnerStatusCalls = 0;
    let runnerStatusRequestCount = 0;
    let delayLeaseExpiryCheckpoint = false;
    let dropInspectReviewCheckpointResponse = false;
    let inspectReviewCheckpointCommitted = false;
    let releaseDroppedInspectReviewResponse = null;
    let dropPrepareCartCheckpointResponse = false;
    let prepareCartCheckpointCommittedAtMs = 0;
    let dropPrepareCartCheckpointConnection = false;
    let prepareCartConnectionDroppedAtMs = 0;
    let dropContinueCheckoutCheckpointResponse = false;
    let continueCheckoutCheckpointCommittedAtMs = 0;
    let dropCommittedCheckpointResponses = new Set();
    let committedCheckpointDroppedAtMs = new Map();
    let committedCheckpointRecoveryPolledAtMs = new Map();
    let closeMerchantTabAfterConfirmationCheckpoint = false;
    let dropFulfillmentResponseAfterCommit = false;
    let fulfillmentResponseDroppedAtMs = 0;
    let deferPrimaryClaimResponse = false;
    let releasePrimaryClaimResponse = null;
    let rejectPrimaryClaimError = '';
    let stopAfterAlreadyOpenCartCheckpoint = false;
    // The full browser matrix intentionally runs longer than the initial
    // ten-minute test capability. Keep the fixture's active capabilities
    // fresh; expiry itself is covered by the focused mocked-clock regression.
    const renewTestCapability = (candidate) => {
      if (!candidate?.missionBoundAuth?.capabilityId?.startsWith('browser-smoke-')) return candidate;
      return {
        ...candidate,
        missionBoundAuth: {
          ...candidate.missionBoundAuth,
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString()
        }
      };
    };
    server = https.createServer(certificate, async (req, res) => {
      const origin = `https://${req.headers.host}`;
      const url = new URL(req.url || '/', origin);
      if (!url.pathname.startsWith('/connectors/') && !url.pathname.startsWith('/plugins/') && !url.pathname.startsWith('/native-runner/')) {
        if (url.pathname === '/slow-loading-search') {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.write([
            '<!doctype html><title>Slow Test Store</title><main><h1>Results for test gadget</h1>',
            '<div data-component-type="s-search-result" data-asin="SLOW-ASIN">',
            '<h2><a href="/dp/test-gadget">Test gadget</a></h2>',
            '<span class="a-price">$3.50</span><span aria-label="Amazon Prime">Prime delivery</span><span>FREE delivery</span>',
            '<button id="slow-search-add" onclick="sessionStorage.setItem(\'selection-click-count\', String(Number(sessionStorage.getItem(\'selection-click-count\') || 0) + 1)); location.href=\'/post-add-confirmation\'">Add to cart</button>',
            '</div><a id="nav-cart" href="/cart"><span id="nav-cart-count">0</span> Cart</a></main>'
          ].join(''));
          const finish = setTimeout(() => {
            if (!res.writableEnded) res.end('<!-- delayed resources finished -->');
          }, 12_000);
          req.on('close', () => clearTimeout(finish));
          return;
        }
        if (url.pathname === '/search' && slowInitialSearchResponse) {
          slowInitialSearchResponse = false;
          await new Promise((resolve) => setTimeout(resolve, 3_300));
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><title>Test Store</title>${storefront(url.pathname, url.searchParams)}`);
        return;
      }
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method || '') ? await readJson(req) : {};
      if (req.method === 'POST' && url.pathname === '/native-runner/extension/pairing/claim') {
        return json(res, 201, { setup: { baseUrl: origin, deviceToken: 'mcnr_browser_smoke_token', deviceId: 'browser-smoke-device' } });
      }
      if (req.method === 'POST' && url.pathname === '/plugins/register') {
        registrationRequestCount += 1;
        return json(res, 201, { registered: true });
      }
      if (req.method === 'GET' && url.pathname === '/connectors/sessions') {
        sessionListRequestCount += 1;
        for (const [actionId, droppedAtMs] of committedCheckpointDroppedAtMs) {
          if (!committedCheckpointRecoveryPolledAtMs.has(actionId) && Date.now() >= droppedAtMs) {
            committedCheckpointRecoveryPolledAtMs.set(actionId, Date.now());
          }
        }
        session = renewTestCapability(session);
        distractorSession = renewTestCapability(distractorSession);
        const active = [distractorSession, session]
          .filter(Boolean)
          .filter((candidate) => !['fulfilled', 'failed'].includes(candidate.status));
        return json(res, 200, { sessions: active, actionableCount: active.length });
      }
      if (req.method === 'POST' && url.pathname.endsWith('/claim')) {
        const matched = url.pathname.match(/^\/connectors\/sessions\/([^/]+)\/claim$/);
        const claimedSessionId = decodeURIComponent(matched?.[1] || '');
        claimedSessionIds.push(claimedSessionId);
        if (claimedSessionId === session?.id) {
          if (rejectPrimaryClaimError) return json(res, 409, { error: rejectPrimaryClaimError });
          session = { ...session, status: 'claimed', claimedByPluginId: body.pluginId };
          if (deferPrimaryClaimResponse) {
            await new Promise((resolve) => { releasePrimaryClaimResponse = resolve; });
          }
          return json(res, 200, { claimed: true, session });
        }
        if (claimedSessionId === distractorSession?.id) {
          distractorSession = { ...distractorSession, status: 'claimed', claimedByPluginId: body.pluginId };
          return json(res, 200, { claimed: true, session: distractorSession });
        }
        return json(res, 404, { error: 'test_claim_session_not_found' });
      }
      if (req.method === 'POST' && url.pathname.endsWith('/runner-status')) {
        runnerStatusRequestCount += 1;
        session = renewTestCapability(session);
        const nextAction = session?.extensionMissionPlan?.actions?.[session?.extensionMissionPlanState?.nextActionIndex || 0];
        if (blockRunnerStatusForFinalDispatch && nextAction?.id === 'submit-final-order') {
          blockedFinalRunnerStatusCalls += 1;
          req.socket.destroy();
          return;
        }
        if (transientRunnerStatusFailures > 0) {
          transientRunnerStatusFailures -= 1;
          transientRunnerStatusFailureCount += 1;
          req.socket.destroy();
          return;
        }
        return json(res, 200, { active: !['fulfilled', 'failed'].includes(session.status), session });
      }
      if (req.method === 'POST' && url.pathname.endsWith('/rank-candidates')) {
        selectionRankRequestCount += 1;
        selectionRankRequestBody = body;
        return json(res, 200, {
          schema: 'magic-city-amazon-selection-advice-v1',
          sessionId: session.id,
          planHash: body.planHash,
          actionId: body.planActionId,
          requestId: body.requestId,
          observationHash: body.observationHash,
          decision: 'select',
          selectedCandidateId: 'candidate-1',
          reason: 'Observed fruit-flavored Nature Valley match.'
        });
      }
      if (req.method === 'POST' && url.pathname.endsWith('/checkpoint')) {
        const plan = session.extensionMissionPlan;
        const state = session.extensionMissionPlanState;
        const expected = plan.actions[state.nextActionIndex];
        const latestCheckpoint = checkpoints.at(-1);
        const exactReplay = Boolean(
          latestCheckpoint
          && latestCheckpoint.planHash === body.planHash
          && latestCheckpoint.planActionId === body.planActionId
          && latestCheckpoint.planActionStatus === body.planActionStatus
          && latestCheckpoint.runnerTiming?.checkpointRequestedAt === body.runnerTiming?.checkpointRequestedAt
        );
        if (exactReplay) return json(res, 200, { updated: true, replayed: true, session });
        if (!expected || expected.id !== body.planActionId || expected.missionAction !== body.missionAction) {
          return json(res, 409, { error: 'test_plan_step_out_of_order' });
        }
        const reportedMilestones = Array.isArray(body.verifiedMilestones) ? body.verifiedMilestones : [];
        if (body.milestoneProtocol === 'verified-v1'
          && body.planActionStatus !== 'waiting'
          && expected.expectedMilestone
          && !reportedMilestones.includes(expected.expectedMilestone)) {
          return json(res, 409, { error: 'test_plan_milestone_not_verified', expectedMilestone: expected.expectedMilestone });
        }
        if (delayLeaseExpiryCheckpoint && expected.id === 'inspect-before-final-submit') {
          await new Promise((resolve) => setTimeout(resolve, 1_250));
        }
        checkpoints.push({ ...body, testReceivedAtMs: Date.now() });
        const advanced = body.planActionStatus !== 'waiting';
        const stopAfterCartCheckpoint = stopAfterAlreadyOpenCartCheckpoint
          && expected.id === 'open-cart'
          && body.planActionStatus !== 'waiting'
          && body.browser?.runnerStep?.controlStrategy === 'amazon_cart_already_open';
        session = {
          ...session,
          status: stopAfterCartCheckpoint ? 'failed' : 'executing',
          missionBoundaryLatestHash: `0x${crypto.randomBytes(8).toString('hex')}`,
          missionBoundaryEventCount: Number(session.missionBoundaryEventCount || 0) + 1,
          extensionMissionPlanState: advanced
            ? {
                ...state,
                nextActionIndex: state.nextActionIndex + 1,
                completedActionIds: [...state.completedActionIds, expected.id],
                verifiedMilestones: [...new Set([
                  ...(Array.isArray(state.verifiedMilestones) ? state.verifiedMilestones : []),
                  ...reportedMilestones
                ])]
              }
            : state
        };
        if (closeMerchantTabAfterConfirmationCheckpoint
          && body.browser?.orderSubmitted === true) {
          closeMerchantTabAfterConfirmationCheckpoint = false;
          const merchantPage = context.pages().find((page) => /\/checkout(?:\/order-confirmation|\?confirmed=1)/.test(page.url()));
          await merchantPage?.close();
        }
        if (dropInspectReviewCheckpointResponse && expected.id === 'inspect-before-final-submit') {
          inspectReviewCheckpointCommitted = true;
          await new Promise((resolve) => { releaseDroppedInspectReviewResponse = resolve; });
          dropInspectReviewCheckpointResponse = false;
          req.socket.destroy();
          return;
        }
        if (dropPrepareCartCheckpointResponse
          && body.planActionStatus !== 'waiting'
          && /^prepare-cart(?:-\d+)?$/.test(expected.id)) {
          dropPrepareCartCheckpointResponse = false;
          prepareCartCheckpointCommittedAtMs = Date.now();
          return json(res, 503, { error: 'test_committed_checkpoint_response_lost' });
        }
        if (dropPrepareCartCheckpointConnection
          && body.planActionStatus !== 'waiting'
          && /^prepare-cart(?:-\d+)?$/.test(expected.id)) {
          dropPrepareCartCheckpointConnection = false;
          prepareCartConnectionDroppedAtMs = Date.now();
          await context.setOffline(true);
          setTimeout(() => { void context.setOffline(false).catch(() => null); }, 120);
          req.socket.destroy();
          return;
        }
        if (dropContinueCheckoutCheckpointResponse
          && body.planActionStatus !== 'waiting'
          && /^continue-checkout(?:-\d+)?$/.test(expected.id)) {
          dropContinueCheckoutCheckpointResponse = false;
          continueCheckoutCheckpointCommittedAtMs = Date.now();
          return json(res, 503, { error: 'test_committed_checkout_checkpoint_response_lost' });
        }
        if (body.planActionStatus !== 'waiting' && dropCommittedCheckpointResponses.has(expected.id)) {
          dropCommittedCheckpointResponses.delete(expected.id);
          committedCheckpointDroppedAtMs.set(expected.id, Date.now());
          return json(res, 503, { error: `test_committed_${expected.id}_checkpoint_response_lost` });
        }
        return json(res, 200, { updated: true, session });
      }
      if (req.method === 'POST' && url.pathname.endsWith('/fulfill')) {
        fulfillment = body;
        session = { ...session, status: body.status || 'fulfilled', fulfilledByPluginId: body.pluginId };
        if (dropFulfillmentResponseAfterCommit) {
          dropFulfillmentResponseAfterCommit = false;
          fulfillmentResponseDroppedAtMs = Date.now();
          req.socket.destroy();
          return;
        }
        return json(res, 200, { session });
      }
      return json(res, 404, { error: 'test_route_not_found' });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const baseUrl = `https://127.0.0.1:${port}`;
    const plan = buildExtensionPlan({
      id: 'browser-smoke-session',
      handoffData: { kind: 'browser' },
      selections: {
        targetUrl: `${baseUrl}/search`,
        goal: 'buy test gadget',
        budget: '$4',
        finalApprovalPolicy: 'auto_submit_after_verified_checkout'
      },
      extensionCheckoutProfileEnabled: true,
      extensionFulfillmentPolicy: 'amazon_free_shipping_preferred',
      extensionPrimeRequired: true
    });
    session = {
      id: 'browser-smoke-session',
      connectorId: 'browser-worker-demo-v1',
      status: 'queued',
      completionMode: 'agent_checkout',
      preferredExecutionAgentId: 'magic-city-runner-extension',
      extensionCheckoutProfileEnabled: true,
      handoffData: { kind: 'browser' },
      missionBoundAuth: {
        capabilityId: 'browser-smoke-capability',
        tokenHash: '0xbrowser-smoke-token',
        token: 'browser-smoke-token',
        audience: 'magic_internet_helper',
        subject: { sessionId: 'browser-smoke-session' },
        policy: {
          allowedDomains: ['127.0.0.1'],
          allowedActions: ['browser_open', 'read_public_page', 'browser_type', 'browser_click', 'fill_safe_fields', 'prepare_cart', 'final_submit', 'handoff']
        },
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        confirmation: { method: 'proof-of-possession' }
      },
      extensionMissionPlan: plan,
      extensionMissionPlanState: { planHash: plan.planHash, nextActionIndex: 0, completedActionIds: [] },
      missionBoundaryLatestHash: null,
      missionBoundaryEventCount: 0
    };
    distractorSession = {
      ...session,
      id: 'browser-smoke-distractor-session',
      missionBoundAuth: {
        ...session.missionBoundAuth,
        capabilityId: 'browser-smoke-distractor-capability',
        subject: { sessionId: 'browser-smoke-distractor-session' }
      }
    };

    const extensionDir = copyTestExtension(tmpDir, baseUrl, {
      // Test the actual MV3/browser boundary with a short copied lease rather
      // than exporting production internals or waiting forty-five seconds.
      finalSubmitLeaseMs: /^final-submit-lease-(?:renewal|expiry|lost-checkpoint)$/.test(smokeMode) ? 1_000 : null,
      finalSubmitDelayMs: smokeMode === 'final-submit-lease-expiry' ? 1_250 : null,
      forceFastPathPostClickTimeout: smokeMode === 'selection-fast-path-timeout',
      failFirstPlanStepInjection: smokeMode === 'selection-injection-recovery',
      disableSearchFastPath: smokeMode === 'selection-injection-recovery'
    });
    const profileDir = path.join(tmpDir, 'profile');
    const launchOptions = {
      headless: false,
      args: ['--ignore-certificate-errors', `--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
    };
    console.log('native-runner browser smoke launching Chrome');
    context = await chromium.launchPersistentContext(profileDir, launchOptions);
    context.setDefaultTimeout(20_000);
    await waitFor(() => context.serviceWorkers()[0], 15_000);
    console.log('native-runner browser smoke service worker ready');
    let worker = context.serviceWorkers()[0];
    const extensionId = new URL(worker.url()).host;
    const defaultCheckoutProfile = {
      contactName: 'Test User',
      streetAddress: '1 Magic City Way',
      shippingCity: 'San Francisco',
      shippingState: 'CA',
      zipCode: '94107',
      contactPhone: '4155550100',
      billingStreetAddress: '99 Billing Plaza',
      billingZipCode: '10001',
      paymentCardLast4: '1817'
    };
    const seedSessionCheckoutProfile = async (sessionId, profile = defaultCheckoutProfile, planHash = '') => {
      await worker.evaluate(async ({ id, value, expectedPlanHash }) => {
        const storageKey = 'magicCityLocalCheckoutProfiles';
        const stored = await chrome.storage.session.get({ [storageKey]: {} });
        await chrome.storage.session.set({
          [storageKey]: {
            ...(stored[storageKey] || {}),
            [id]: {
              profile: value,
              planHash: expectedPlanHash || null,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            }
          }
        });
        await chrome.storage.local.remove('localCheckoutProfiles');
      }, { id: sessionId, value: profile, expectedPlanHash: planHash });
    };
    let popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.locator('#baseUrl').fill(baseUrl);
    await popup.locator('#pairingCode').fill('BROWSER-SMOKE');
    await popup.locator('#pairBtn').click();
    await popup.waitForFunction(() => document.querySelector('#status')?.textContent?.includes('Connected'), null, { timeout: 30_000 }).catch(async (error) => {
      const status = await popup.locator('#status').textContent().catch(() => 'unreadable');
      console.error(`pairing_status_timeout:${status}`);
      throw error;
    });
    console.log(`native-runner browser smoke paired (${smokeMode})`);
    const prepareSelectionOnlySession = async (pathname, { goal = 'buy test gadget', budget = '$4', selectionIntelligence = null } = {}) => {
      checkpoints.length = 0;
      fulfillment = null;
      transientRunnerStatusFailures = 0;
      slowInitialSearchResponse = false;
      const sessionId = `browser-smoke-${smokeMode}-session`;
      const targetUrl = `${baseUrl}${pathname}`;
      const generatedPlan = buildExtensionPlan({
        id: sessionId,
        handoffData: { kind: 'browser' },
        selections: {
          targetUrl,
          goal,
          budget,
          finalApprovalPolicy: 'auto_submit_after_verified_checkout'
        },
        extensionCheckoutProfileEnabled: false,
        extensionPrimeRequired: true
      });
      const selectAction = generatedPlan.actions.find((action) => action.type === 'select_candidate');
      if (!selectAction) fail('browser_extension_selection_focus_action_missing');
      const selectionPlan = rehashExtensionPlan({ ...generatedPlan, actions: [selectAction] });
      session = {
        ...session,
        id: sessionId,
        status: 'queued',
        claimedByPluginId: null,
        fulfillment: null,
        extensionCheckoutProfileEnabled: false,
        missionBoundAuth: {
          ...session.missionBoundAuth,
          capabilityId: `browser-smoke-${smokeMode}-capability`,
          subject: { sessionId },
          expiresAt: new Date(Date.now() + 10 * 60_000).toISOString()
        },
        extensionMissionPlan: selectionPlan,
        extensionMissionPlanState: { planHash: selectionPlan.planHash, nextActionIndex: 0, completedActionIds: [] },
        selectionIntelligence,
        missionBoundaryLatestHash: null,
        missionBoundaryEventCount: 0
      };
      const merchantPage = await context.newPage();
      if (pathname === '/slow-loading-search') {
        await merchantPage.goto(targetUrl, { waitUntil: 'commit' });
        await merchantPage.locator('#slow-search-add').waitFor({ state: 'visible', timeout: 3_000 });
      } else {
        await merchantPage.goto(targetUrl);
      }
      const merchantTab = await worker.evaluate(async (url) => {
        const tabs = await chrome.tabs.query({});
        return tabs.find((candidate) => candidate.url === url) || null;
      }, merchantPage.url());
      if (!merchantTab?.id) fail(`browser_extension_selection_focus_tab_missing:${merchantPage.url()}`);
      await worker.evaluate(async ({ sessionId: focusedSessionId, tabId }) => {
        const stored = await chrome.storage.local.get({ activeMissionTabs: {} });
        await chrome.storage.local.set({
          activeMissionTabs: { ...(stored.activeMissionTabs || {}), [focusedSessionId]: tabId }
        });
      }, { sessionId, tabId: merchantTab.id });
      return { merchantPage, merchantTab, selectionPlan };
    };
    const runSelectionFocus = async (dispatchNonce) => {
      const wakePage = await context.newPage();
      await wakePage.goto(`${baseUrl}/external-wake`);
      const startedAt = Date.now();
      const result = await withTimeout(wakePage.evaluate(({ extensionId: targetExtensionId, sessionId, nonce }) => new Promise((resolve) => {
        const progress = [];
        const port = chrome.runtime.connect(targetExtensionId, { name: 'magic-city-active-run-v1' });
        port.onMessage.addListener((payload) => {
          if (payload?.type === 'RUNNER_PROGRESS') progress.push(payload);
          if (payload?.type === 'RUNNER_RESULT') resolve({ payload, progress });
        });
        port.onDisconnect.addListener(() => resolve({ disconnected: true, progress }));
        port.postMessage({
          type: 'RUN_PENDING_SESSIONS',
          sessionId,
          extensionDispatchNonce: nonce
        });
      }), { extensionId, sessionId: session.id, nonce: dispatchNonce }), 12_000, 'browser_extension_selection_focus_wake_timeout');
      await wakePage.close();
      return { ...result, durationMs: Date.now() - startedAt };
    };
    if (smokeMode === 'same-window-focus') {
      const focusSessionId = 'browser-smoke-same-window-focus-session';
      const targetUrl = `${baseUrl}/search`;
      const createdWindow = await worker.evaluate((url) => chrome.windows.create({ url, focused: false }), targetUrl);
      const targetTab = createdWindow?.tabs?.[0] || null;
      if (!targetTab?.id || targetTab.windowId == null) fail('browser_extension_focus_target_window_missing');
      await worker.evaluate(async ({ sessionId: focusedSessionId, tabId }) => {
        const stored = await chrome.storage.local.get({ activeMissionTabs: {} });
        await chrome.storage.local.set({
          activeMissionTabs: { ...(stored.activeMissionTabs || {}), [focusedSessionId]: tabId }
        });
      }, { sessionId: focusSessionId, tabId: targetTab.id });

      const magicCityPage = await context.newPage();
      await magicCityPage.goto(`${baseUrl}/external-wake`);
      const magicCityTab = await worker.evaluate((url) => chrome.tabs.query({}).then((tabs) => (
        tabs.find((tab) => tab.url === url) || null
      )), magicCityPage.url());
      if (!magicCityTab?.id || magicCityTab.windowId == null) fail('browser_extension_focus_sender_window_missing');
      if (magicCityTab.windowId === targetTab.windowId) fail('browser_extension_focus_fixture_needs_two_windows');

      const response = await magicCityPage.evaluate(({ extensionId: targetExtensionId, sessionId }) => new Promise((resolve) => {
        chrome.runtime.sendMessage(targetExtensionId, { type: 'FOCUS_MISSION_TAB', sessionId }, resolve);
      }), { extensionId, sessionId: focusSessionId });
      const focusedTab = await worker.evaluate((tabId) => chrome.tabs.get(tabId), targetTab.id);
      if (!response?.ok
        || response?.result?.focused !== true
        || response?.result?.sameWindow !== true
        || response?.result?.moved !== true
        || focusedTab?.windowId !== magicCityTab.windowId
        || focusedTab?.active !== true) {
        fail(`browser_extension_same_window_focus_failed:${JSON.stringify({ response, magicCityTab, targetTab, focusedTab })}`);
      }
      recordPurchaseScenario('External focus moves the exact mission tab beside the requesting Magic City tab', {
        moved: response.result.moved,
        sameWindow: response.result.sameWindow,
        active: focusedTab.active
      });
      await magicCityPage.close();
      console.log(JSON.stringify({ amazonPurchaseSimulations: purchaseScenarioResults.length, scenarios: purchaseScenarioResults }, null, 2));
      console.log('native-runner same-window focus smoke passed');
      return;
    }
    if (smokeMode === 'selection-intelligence') {
      const { merchantPage } = await prepareSelectionOnlySession('/selection-intelligence-search', {
        goal: 'buy fruity Nature Valley granola bars',
        selectionIntelligence: { enabled: true, maxCandidates: 12, timeoutMs: 3000 }
      });
      const wake = await runSelectionFocus('browser-smoke-selection-intelligence');
      const selectionCheckpoint = checkpoints.find((checkpoint) => checkpoint.planActionId === 'select-match'
        && checkpoint.planActionStatus !== 'waiting');
      const clickCount = Number(await merchantPage.evaluate(() => sessionStorage.getItem('selection-intelligence-click-count') || '0'));
      const sentCandidates = Array.isArray(selectionRankRequestBody?.candidates) ? selectionRankRequestBody.candidates : [];
      if (!selectionCheckpoint
        || selectionCheckpoint?.browser?.runnerStep?.selectionKind !== 'model_assisted'
        || selectionCheckpoint?.browser?.runnerStep?.intelligenceConsulted !== true
        || selectionCheckpoint?.browser?.runnerStep?.intelligenceDecision !== 'select'
        || selectionCheckpoint?.browser?.runnerStep?.selectedCandidate?.asin !== 'B000FRUIT1'
        || selectionCheckpoint?.browser?.runnerStep?.controlStrategy !== 'amazon_search_card_model_assisted'
        || clickCount !== 1
        || selectionRankRequestCount !== 1
        || sentCandidates.length !== 2
        || JSON.stringify(selectionRankRequestBody).includes('url')) {
        fail(`browser_extension_selection_intelligence_failed:${JSON.stringify({
          selectionCheckpoint,
          clickCount,
          selectionRankRequestCount,
          selectionRankRequestBody,
          wake
        })}`);
      }
      recordPurchaseScenario('Bounded selection intelligence chooses one observed candidate after a no-click abstention', {
        durationMs: wake.durationMs,
        clickCount,
        candidateCount: sentCandidates.length,
        rankRequests: selectionRankRequestCount
      });
      await merchantPage.close();
      const rankRequestsBeforeExplicitIdentity = selectionRankRequestCount;
      const { merchantPage: explicitIdentityPage } = await prepareSelectionOnlySession('/selection-explicit-identity-search', {
        goal: 'buy Nature Valley Strawberry granola bars',
        selectionIntelligence: { enabled: true, maxCandidates: 12, timeoutMs: 3000 }
      });
      const explicitIdentityWake = await runSelectionFocus('browser-smoke-selection-explicit-identity');
      const explicitIdentityClicks = Number(await explicitIdentityPage.evaluate(() => sessionStorage.getItem('selection-explicit-identity-click-count') || '0'));
      if (explicitIdentityClicks !== 0
        || selectionRankRequestCount !== rankRequestsBeforeExplicitIdentity
        || explicitIdentityWake?.payload?.result?.executed?.[0]?.status !== 'product_selection_needs_review') {
        fail(`browser_extension_selection_intelligence_overrode_explicit_identity:${JSON.stringify({
          explicitIdentityClicks,
          selectionRankRequestCount,
          rankRequestsBeforeExplicitIdentity,
          explicitIdentityWake
        })}`);
      }
      recordPurchaseScenario('Selection intelligence preserves explicit brand and flavor constraints', {
        clickCount: explicitIdentityClicks,
        additionalRankRequests: selectionRankRequestCount - rankRequestsBeforeExplicitIdentity
      });
      await explicitIdentityPage.close();
      const rankRequestsBeforeAccessibleTitle = selectionRankRequestCount;
      const { merchantPage: accessibleTitlePage } = await prepareSelectionOnlySession('/selection-accessible-title-search', {
        goal: "buy S'mores Kit Box, 14 oz HERSHEY'S",
        budget: '$8',
        selectionIntelligence: { enabled: true, maxCandidates: 12, timeoutMs: 3000 }
      });
      const accessibleTitleWake = await runSelectionFocus('browser-smoke-selection-accessible-title');
      const accessibleTitleClicks = Number(await accessibleTitlePage.evaluate(() => sessionStorage.getItem('selection-accessible-title-click-count') || '0'));
      const accessibleTitleCheckpoint = checkpoints.find((checkpoint) => checkpoint.planActionId === 'select-match'
        && checkpoint.planActionStatus !== 'waiting');
      if (accessibleTitleCheckpoint?.browser?.runnerStep?.selectionKind !== 'exact'
        || accessibleTitleCheckpoint?.browser?.runnerStep?.directSearchResultCart !== true
        || selectionRankRequestCount !== rankRequestsBeforeAccessibleTitle) {
        fail(`browser_extension_accessible_title_recovery_failed:${JSON.stringify({
          accessibleTitleCheckpoint,
          accessibleTitleClicks,
          selectionRankRequestCount,
          rankRequestsBeforeAccessibleTitle,
          accessibleTitleWake
        })}`);
      }
      recordPurchaseScenario('A complete card-bound accessible title preserves the exact no-model fast path', {
        directSearchResultCart: accessibleTitleCheckpoint.browser.runnerStep.directSearchResultCart,
        additionalRankRequests: selectionRankRequestCount - rankRequestsBeforeAccessibleTitle
      });
      await accessibleTitlePage.close();
      const rankRequestsBeforeProvisionalTitle = selectionRankRequestCount;
      const { merchantPage: provisionalTitlePage } = await prepareSelectionOnlySession('/selection-provisional-search', {
        goal: "buy HERSHEY'S S'mores Kit Box, 14 oz",
        budget: '$8',
        selectionIntelligence: { enabled: true, maxCandidates: 12, timeoutMs: 3000 }
      });
      const provisionalTitleWake = await runSelectionFocus('browser-smoke-selection-provisional-title');
      const provisionalTitleCheckpoint = checkpoints.find((checkpoint) => checkpoint.planActionId === 'select-match'
        && checkpoint.planActionStatus !== 'waiting');
      const provisionalCartClicks = Number(await provisionalTitlePage.evaluate(() => sessionStorage.getItem('selection-provisional-cart-click-count') || '0'));
      if (provisionalTitleCheckpoint?.browser?.runnerStep?.selectionKind !== 'model_assisted_product_page_verification'
        || provisionalTitleCheckpoint?.browser?.runnerStep?.productPageVerified !== true
        || provisionalTitleCheckpoint?.browser?.runnerStep?.productIdentityVerified !== true
        || selectionRankRequestCount !== rankRequestsBeforeProvisionalTitle + 1
        || provisionalCartClicks !== 0) {
        fail(`browser_extension_provisional_title_verification_failed:${JSON.stringify({
          provisionalTitleCheckpoint,
          lastCheckpoint: checkpoints.at(-1),
          provisionalCartClicks,
          selectionRankRequestCount,
          rankRequestsBeforeProvisionalTitle,
          provisionalTitleWake
        })}`);
      }
      recordPurchaseScenario('A clipped observed title gets one model ranking and one read-only product-page verification', {
        cartClicks: provisionalCartClicks,
        rankRequests: selectionRankRequestCount - rankRequestsBeforeProvisionalTitle,
        productPageVerified: provisionalTitleCheckpoint.browser.runnerStep.productPageVerified
      });
      await provisionalTitlePage.close();
      const rankRequestsBeforePackageMismatch = selectionRankRequestCount;
      const { merchantPage: packageMismatchPage } = await prepareSelectionOnlySession('/selection-package-mismatch-search', {
        goal: "buy HERSHEY'S S'mores Kit Box, 14 oz",
        budget: '$8',
        selectionIntelligence: { enabled: true, maxCandidates: 12, timeoutMs: 3000 }
      });
      const packageMismatchWake = await runSelectionFocus('browser-smoke-selection-package-mismatch');
      const packageMismatchCheckpoint = checkpoints.find((checkpoint) => checkpoint.planActionId === 'select-match'
        && checkpoint.browser?.runnerStep?.actionId === 'select-match');
      const packageMismatchCartClicks = Number(await packageMismatchPage.evaluate(() => sessionStorage.getItem('selection-package-mismatch-cart-click-count') || '0'));
      if (packageMismatchCheckpoint?.planActionStatus !== 'waiting'
        || packageMismatchCheckpoint?.browser?.runnerStep?.productPageVerified !== false
        || packageMismatchCheckpoint?.browser?.runnerStep?.productIdentityVerified !== false
        || packageMismatchCheckpoint?.verifiedMilestones?.includes('candidate_selected')
        || selectionRankRequestCount !== rankRequestsBeforePackageMismatch
        || packageMismatchCartClicks !== 0) {
        fail(`browser_extension_product_page_package_mismatch_advanced:${JSON.stringify({
          packageMismatchCheckpoint,
          packageMismatchCartClicks,
          selectionRankRequestCount,
          rankRequestsBeforePackageMismatch,
          packageMismatchWake
        })}`);
      }
      recordPurchaseScenario('Structured product-page item count blocks an unrequested multipack', {
        cartClicks: packageMismatchCartClicks,
        additionalRankRequests: selectionRankRequestCount - rankRequestsBeforePackageMismatch,
        checkpointStatus: packageMismatchCheckpoint.planActionStatus
      });
      await packageMismatchPage.close();
      const rankRequestsBeforePackCountMismatch = selectionRankRequestCount;
      const { merchantPage: packCountMismatchPage } = await prepareSelectionOnlySession('/selection-pack-count-mismatch-search', {
        goal: 'buy Nature Valley granola bars 2-pack',
        budget: '$8',
        selectionIntelligence: { enabled: true, maxCandidates: 12, timeoutMs: 3000 }
      });
      const packCountMismatchWake = await runSelectionFocus('browser-smoke-selection-pack-count-mismatch');
      const packCountMismatchCheckpoint = checkpoints.find((checkpoint) => checkpoint.planActionId === 'select-match'
        && checkpoint.browser?.runnerStep?.actionId === 'select-match');
      const packCountMismatchCartClicks = Number(await packCountMismatchPage.evaluate(() => sessionStorage.getItem('selection-pack-count-mismatch-cart-click-count') || '0'));
      if (packCountMismatchCheckpoint?.planActionStatus !== 'waiting'
        || packCountMismatchCheckpoint?.browser?.runnerStep?.productPageVerified !== false
        || packCountMismatchCheckpoint?.browser?.runnerStep?.productIdentityVerified !== false
        || packCountMismatchCheckpoint?.verifiedMilestones?.includes('candidate_selected')
        || selectionRankRequestCount !== rankRequestsBeforePackCountMismatch
        || packCountMismatchCartClicks !== 0) {
        fail(`browser_extension_product_page_pack_count_mismatch_advanced:${JSON.stringify({
          packCountMismatchCheckpoint,
          packCountMismatchCartClicks,
          selectionRankRequestCount,
          rankRequestsBeforePackCountMismatch,
          packCountMismatchWake
        })}`);
      }
      recordPurchaseScenario('Explicit product-page pack count must match the requested pack count', {
        cartClicks: packCountMismatchCartClicks,
        additionalRankRequests: selectionRankRequestCount - rankRequestsBeforePackCountMismatch,
        checkpointStatus: packCountMismatchCheckpoint.planActionStatus
      });
      await packCountMismatchPage.close();
      for (const packageFixture of ['range', 'alternatives', 'unknown']) {
        const rankRequestsBeforeAmbiguousPackage = selectionRankRequestCount;
        const { merchantPage: ambiguousPackagePage } = await prepareSelectionOnlySession(`/selection-package-${packageFixture}-search`, {
          goal: 'buy Nature Valley granola bars 2-pack',
          budget: '$8',
          selectionIntelligence: { enabled: true, maxCandidates: 12, timeoutMs: 3000 }
        });
        const ambiguousPackageWake = await runSelectionFocus(`browser-smoke-selection-package-${packageFixture}`);
        const ambiguousPackageCheckpoint = checkpoints.find((checkpoint) => checkpoint.planActionId === 'select-match'
          && checkpoint.browser?.runnerStep?.actionId === 'select-match');
        const ambiguousPackageCartClicks = Number(await ambiguousPackagePage.evaluate((key) => (
          sessionStorage.getItem(`selection-package-${key}-cart-click-count`) || '0'
        ), packageFixture));
        if (ambiguousPackageCheckpoint?.planActionStatus !== 'waiting'
          || ambiguousPackageCheckpoint?.browser?.runnerStep?.productPageVerified !== false
          || ambiguousPackageCheckpoint?.browser?.runnerStep?.productIdentityVerified !== false
          || ambiguousPackageCheckpoint?.verifiedMilestones?.includes('candidate_selected')
          || selectionRankRequestCount !== rankRequestsBeforeAmbiguousPackage
          || ambiguousPackageCartClicks !== 0) {
          fail(`browser_extension_ambiguous_product_package_advanced:${JSON.stringify({
            packageFixture,
            ambiguousPackageCheckpoint,
            ambiguousPackageCartClicks,
            selectionRankRequestCount,
            rankRequestsBeforeAmbiguousPackage,
            ambiguousPackageWake
          })}`);
        }
        recordPurchaseScenario(`Ambiguous structured package evidence fails closed (${packageFixture})`, {
          cartClicks: ambiguousPackageCartClicks,
          additionalRankRequests: selectionRankRequestCount - rankRequestsBeforeAmbiguousPackage,
          checkpointStatus: ambiguousPackageCheckpoint.planActionStatus
        });
        await ambiguousPackagePage.close();
      }
      console.log(JSON.stringify({ amazonPurchaseSimulations: purchaseScenarioResults.length, scenarios: purchaseScenarioResults }, null, 2));
      console.log('native-runner selection intelligence smoke passed');
      return;
    }
    if (smokeMode === 'selection-injection-recovery') {
      const { merchantPage } = await prepareSelectionOnlySession('/selection-recovery-search');
      const wake = await runSelectionFocus('browser-smoke-selection-injection-recovery');
      const selectionCheckpoint = checkpoints.find((checkpoint) => checkpoint.planActionId === 'select-match'
        && checkpoint.planActionStatus !== 'waiting');
      const clickCount = Number(await merchantPage.evaluate(() => sessionStorage.getItem('selection-click-count') || '0'));
      const sawReconnectingRunner = (wake.progress || []).some((entry) => entry?.activeRun?.progressState === 'reconnecting_control_plane');
      const runnerState = await worker.evaluate(() => chrome.storage.local.get(['lastError', 'lastExecution', 'activeRun']));
      if (!selectionCheckpoint
        || !selectionCheckpoint.verifiedMilestones?.includes('candidate_selected')
        || clickCount !== 1
        || !sawReconnectingRunner
        || wake.durationMs >= 8_000
        || runnerState.lastExecution?.status === 'wake_failed') {
        fail(`browser_extension_selection_injection_recovery_failed:${JSON.stringify({
          selectionCheckpoint,
          clickCount,
          sawReconnectingRunner,
          durationMs: wake.durationMs,
          runnerState,
          wake
        })}`);
      }
      recordPurchaseScenario('A select-match executor injection timeout reconnects inline and clicks once', {
        durationMs: wake.durationMs,
        clickCount
      });
      await merchantPage.close();
      console.log(JSON.stringify({ amazonPurchaseSimulations: purchaseScenarioResults.length, scenarios: purchaseScenarioResults }, null, 2));
      console.log('native-runner selection injection recovery smoke passed');
      return;
    }
    if (smokeMode === 'selection-delayed-page-load') {
      const { merchantPage } = await prepareSelectionOnlySession('/slow-loading-search');
      const wake = await runSelectionFocus('browser-smoke-selection-delayed-page-load');
      const selectionCheckpoint = checkpoints.find((checkpoint) => checkpoint.planActionId === 'select-match'
        && checkpoint.planActionStatus !== 'waiting');
      const clickCount = Number(await merchantPage.evaluate(() => sessionStorage.getItem('selection-click-count') || '0'));
      const runnerState = await worker.evaluate(() => chrome.storage.local.get(['lastError', 'lastExecution']));
      if (!selectionCheckpoint
        || clickCount !== 1
        || wake.durationMs >= 8_000
        || /browser_script_injection_timeout/.test(String(runnerState.lastError || ''))) {
        fail(`browser_extension_selection_delayed_page_load_failed:${JSON.stringify({
          selectionCheckpoint,
          clickCount,
          durationMs: wake.durationMs,
          runnerState,
          wake
        })}`);
      }
      recordPurchaseScenario('Selection installs before document_idle on a still-loading page', {
        durationMs: wake.durationMs,
        clickCount
      });
      await merchantPage.close();
      console.log(JSON.stringify({ amazonPurchaseSimulations: purchaseScenarioResults.length, scenarios: purchaseScenarioResults }, null, 2));
      console.log('native-runner delayed-page selection smoke passed');
      return;
    }
    if (smokeMode === 'selection-fast-path-timeout') {
      const { merchantPage } = await prepareSelectionOnlySession('/selection-timeout-search');
      const wake = await runSelectionFocus('browser-smoke-selection-fast-path-timeout');
      await new Promise((resolve) => setTimeout(resolve, 450));
      const clickCount = Number(await merchantPage.evaluate(() => sessionStorage.getItem('selection-click-count') || '0'));
      const selectionCheckpoints = checkpoints.filter((checkpoint) => checkpoint.planActionId === 'select-match');
      const outcomeUnknownCheckpoints = selectionCheckpoints.filter((checkpoint) => (
        checkpoint.state === 'browser_action_outcome_unknown'
      ));
      const runnerState = await worker.evaluate(() => chrome.storage.local.get(['lastError', 'lastExecution', 'activeRun']));
      const stopState = fulfillment?.result?.browserExecution?.stopState || '';
      if (clickCount !== 1
        || stopState !== 'browser_action_outcome_unknown'
        || outcomeUnknownCheckpoints.length !== 1
        || outcomeUnknownCheckpoints[0]?.planActionStatus !== 'waiting'
        || selectionCheckpoints.some((checkpoint) => checkpoint.planActionStatus !== 'waiting')
        || selectionCheckpoints.some((checkpoint) => checkpoint.planActionStatus === 'skipped')
        || runnerState.lastExecution?.status === 'wake_failed'
        || runnerState.activeRun) {
        fail(`browser_extension_selection_fast_path_timeout_handling_failed:${JSON.stringify({
          clickCount,
          stopState,
          selectionCheckpoints,
          outcomeUnknownCheckpoints,
          runnerState,
          fulfillment,
          wake
        })}`);
      }
      recordPurchaseScenario('A lost fast-path response stops without repeating an uncertain cart click', {
        clickCount,
        checkpointStatus: selectionCheckpoints[0].planActionStatus,
        stopState
      });
      await merchantPage.close();
      console.log(JSON.stringify({ amazonPurchaseSimulations: purchaseScenarioResults.length, scenarios: purchaseScenarioResults }, null, 2));
      console.log('native-runner selection fast-path timeout smoke passed');
      return;
    }
    if (smokeMode === 'selection-product-verification-failure') {
      const { merchantPage } = await prepareSelectionOnlySession('/selection-product-verification-failure-search');
      const wake = await runSelectionFocus('browser-smoke-selection-product-verification-failure');
      await new Promise((resolve) => setTimeout(resolve, 250));
      const selectionCheckpoints = checkpoints.filter((checkpoint) => (
        checkpoint.planActionId === 'select-match'
        && checkpoint.browser?.runnerStep?.actionId === 'select-match'
      ));
      const cartClicks = Number(await merchantPage.evaluate(() => sessionStorage.getItem('verification-failure-cart-clicks') || '0'));
      const state = session.extensionMissionPlanState;
      if (selectionCheckpoints.length !== 1
        || selectionCheckpoints[0]?.planActionStatus !== 'waiting'
        || selectionCheckpoints[0]?.browser?.runnerStep?.productPageVerified !== false
        || !/above the approved \$4\.00 item budget/i.test(String(selectionCheckpoints[0]?.browser?.runnerStep?.reason || ''))
        || selectionCheckpoints[0]?.verifiedMilestones?.includes('candidate_selected')
        || Number(state?.nextActionIndex || 0) !== 0
        || cartClicks !== 0) {
        fail(`browser_extension_failed_product_verification_advanced:${JSON.stringify({
          selectionCheckpoints,
          state,
          cartClicks,
          wake
        })}`);
      }
      recordPurchaseScenario('Failed product-page verification does not advance selection or click cart', {
        checkpointStatus: selectionCheckpoints[0].planActionStatus,
        nextActionIndex: state.nextActionIndex,
        cartClicks
      });
      await merchantPage.close();
      console.log(JSON.stringify({ amazonPurchaseSimulations: purchaseScenarioResults.length, scenarios: purchaseScenarioResults }, null, 2));
      console.log('native-runner product verification failure smoke passed');
      return;
    }
    const verifyAmazonNavFlyout = async () => {
      const page = await context.newPage();
      await page.goto(`${baseUrl}/cart-preview-start`);
      await page.setContent([
        '<main><h1>Results for nature valley granola bars</h1></main>',
        '<div id="nav-flyout-ewc" class="a-popover" aria-label="Shopping cart">',
        '<div id="ewc-content"><p>Subtotal: $1.82</p>',
        '<div class="a-button"><span class="a-button-inner"><button id="nav-flyout-go-to-cart" onclick="location.href=\'/cart?source=nav-flyout-ewc\'"><span class="a-button-text">Go to Cart</span></button></span></div>',
        '</div></div>'
      ].join(''));
      const tab = await worker.evaluate(async (url) => {
        const tabs = await chrome.tabs.query({});
        return tabs.find((candidate) => candidate.url === url) || null;
      }, page.url());
      if (!tab?.id) fail(`browser_extension_cart_flyout_tab_missing:${page.url()}`);
      const outcome = await worker.evaluate(async (tabId) => {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['executor.js'] });
        return chrome.tabs.sendMessage(tabId, {
          type: 'MAGIC_CITY_EXECUTE_PLAN_STEP',
          action: { type: 'navigate', intent: 'open_cart', preferExistingCartControl: true }
        });
      }, tab.id);
      await page.waitForURL(/\/cart\?source=nav-flyout-ewc/, { timeout: 5_000 });
      if (!outcome?.completed || outcome.controlStrategy !== 'amazon_nav_cart_flyout') {
        fail(`browser_extension_amazon_nav_flyout_cart_transition_failed:${JSON.stringify(outcome)}`);
      }
      recordPurchaseScenario('Amazon nav flyout Go to Cart uses the exact native control immediately', {
        strategy: outcome.controlStrategy
      });
      await page.close();
    };
    if (smokeMode === 'cart-flyout') {
      await verifyAmazonNavFlyout();
      console.log(JSON.stringify({ amazonPurchaseSimulations: purchaseScenarioResults.length, scenarios: purchaseScenarioResults }, null, 2));
      console.log('native-runner cart flyout smoke passed');
      return;
    }
    if (smokeMode === 'claim-startup') {
      checkpoints.length = 0;
      deferPrimaryClaimResponse = true;
      const registrationBaseline = registrationRequestCount;
      const sessionListBaseline = sessionListRequestCount;
      const wakePage = await context.newPage();
      await wakePage.goto(`${baseUrl}/external-wake`);
      const claimPromise = wakePage.evaluate(({ extensionId: targetExtensionId, sessionId, extensionDispatchNonce }) => new Promise((resolve) => {
        chrome.runtime.sendMessage(targetExtensionId, {
          type: 'RUN_PENDING_SESSIONS',
          sessionId,
          extensionDispatchNonce
        }, (response) => resolve({ response, error: chrome.runtime.lastError?.message || '' }));
      }), { extensionId, sessionId: session.id, extensionDispatchNonce: 'browser-smoke-dispatch' });
      await waitFor(() => claimedSessionIds.includes(session.id), 5_000);
      const claimingRun = await popup.evaluate(() => new Promise((resolve) => {
        chrome.storage.local.get(['activeSessionId', 'activeRun'], resolve);
      }));
      if (claimingRun.activeSessionId !== session.id || claimingRun.activeRun?.phase !== 'claiming') {
        fail(`browser_extension_claim_marker_not_durable:${JSON.stringify(claimingRun)}`);
      }
      deferPrimaryClaimResponse = false;
      releasePrimaryClaimResponse?.();
      await waitFor(() => checkpoints.some((checkpoint) => checkpoint.planActionId === 'open-site'
        && checkpoint.planActionStatus === 'waiting'
        && checkpoint.label === 'Opening browser'), 5_000);
      const startupCheckpoint = checkpoints.find((checkpoint) => checkpoint.planActionId === 'open-site'
        && checkpoint.planActionStatus === 'waiting'
        && checkpoint.label === 'Opening browser');
      if (!startupCheckpoint
        || startupCheckpoint.runnerTiming?.phase !== 'startup'
        || !startupCheckpoint.runnerTiming?.workerStartedAt
        || !startupCheckpoint.runnerTiming?.checkpointRequestedAt
        || session.extensionMissionPlanState?.nextActionIndex !== 0) {
        fail(`browser_extension_claim_startup_checkpoint_not_nonadvancing:${JSON.stringify({ startupCheckpoint, planState: session.extensionMissionPlanState })}`);
      }
      const wakeResult = await claimPromise;
      if (wakeResult.error || !wakeResult.response?.ok) {
        fail(`browser_extension_claim_startup_wake_failed:${JSON.stringify(wakeResult)}`);
      }
      if (sessionListRequestCount !== sessionListBaseline || registrationRequestCount !== registrationBaseline) {
        fail(`browser_extension_direct_claim_performed_redundant_startup_requests:${JSON.stringify({
          registrationBaseline,
          registrationRequestCount,
          sessionListBaseline,
          sessionListRequestCount
        })}`);
      }
      recordPurchaseScenario('Claim persistence survives the server-accepted startup gap before browser work', {
        phase: claimingRun.activeRun.phase,
        checkpoint: startupCheckpoint.planActionStatus,
        directClaim: wakeResult.response?.result?.directClaim === true,
        redundantQueueRequests: sessionListRequestCount - sessionListBaseline
      });
      await wakePage.close();
      console.log(JSON.stringify({ amazonPurchaseSimulations: purchaseScenarioResults.length, scenarios: purchaseScenarioResults }, null, 2));
      console.log('native-runner claim startup recovery smoke passed');
      return;
    }
    if (smokeMode === 'cart-already-open') {
      checkpoints.length = 0;
      stopAfterAlreadyOpenCartCheckpoint = true;
      const openCartIndex = plan.actions.findIndex((action) => action.id === 'open-cart');
      if (openCartIndex < 0) fail('browser_extension_cart_already_open_plan_action_missing');
      session = {
        ...session,
        status: 'queued',
        extensionMissionPlanState: {
          planHash: plan.planHash,
          nextActionIndex: openCartIndex,
          completedActionIds: plan.actions.slice(0, openCartIndex).map((action) => action.id),
          verifiedMilestones: ['candidate_selected', 'cart_confirmed']
        }
      };
      const cartPage = await context.newPage();
      await cartPage.goto(`${baseUrl}/gp/cart/view.html`);
      const cartTab = await worker.evaluate(async (url) => {
        const tabs = await chrome.tabs.query({});
        return tabs.find((candidate) => candidate.url === url) || null;
      }, cartPage.url());
      if (!cartTab?.id) fail(`browser_extension_cart_already_open_tab_missing:${cartPage.url()}`);
      await worker.evaluate(async ({ sessionId, tabId }) => {
        const stored = await chrome.storage.local.get({ activeMissionTabs: {} });
        await chrome.storage.local.set({
          activeMissionTabs: { ...(stored.activeMissionTabs || {}), [sessionId]: tabId }
        });
      }, { sessionId: session.id, tabId: cartTab.id });
      const wakePage = await context.newPage();
      await wakePage.goto(`${baseUrl}/external-wake`);
      const wakePromise = wakePage.evaluate(({ extensionId: targetExtensionId, sessionId }) => new Promise((resolve) => {
        chrome.runtime.sendMessage(targetExtensionId, {
          type: 'RUN_PENDING_SESSIONS',
          sessionId,
          extensionDispatchNonce: 'browser-smoke-cart-dispatch'
        }, (response) => resolve({ response, error: chrome.runtime.lastError?.message || '' }));
      }), { extensionId, sessionId: session.id });
      try {
        await waitFor(() => checkpoints.some((checkpoint) => checkpoint.planActionId === 'open-cart'
          && checkpoint.planActionStatus !== 'waiting'
          && checkpoint.browser?.runnerStep?.controlStrategy === 'amazon_cart_already_open'), 5_000);
      } catch {
        const runnerState = await worker.evaluate(() => chrome.storage.local.get([
          'lastError',
          'lastExecution',
          'activeSessionId',
          'activeRun',
          'activeMissionTabs'
        ]));
        fail(`browser_extension_cart_already_open_timeout:${JSON.stringify({ checkpoints, runnerState, session })}`);
      }
      const cartCheckpoint = checkpoints.find((checkpoint) => checkpoint.planActionId === 'open-cart'
        && checkpoint.planActionStatus !== 'waiting'
        && checkpoint.browser?.runnerStep?.controlStrategy === 'amazon_cart_already_open');
      if (!cartCheckpoint
        || Number(cartCheckpoint.runnerTiming?.actionDurationMs || Infinity) >= 1_000
        || !/\/gp\/cart\/view\.html/.test(cartPage.url())) {
        fail(`browser_extension_cart_already_open_not_immediate:${JSON.stringify({ cartCheckpoint, url: cartPage.url() })}`);
      }
      await Promise.race([wakePromise, new Promise((resolve) => setTimeout(resolve, 2_000))]);
      recordPurchaseScenario('An already-open Amazon cart advances without waiting or reloading', {
        durationMs: cartCheckpoint.runnerTiming.actionDurationMs,
        strategy: cartCheckpoint.browser.runnerStep.controlStrategy
      });
      await wakePage.close();
      await cartPage.close();
      console.log(JSON.stringify({ amazonPurchaseSimulations: purchaseScenarioResults.length, scenarios: purchaseScenarioResults }, null, 2));
      console.log('native-runner already-open cart smoke passed');
      return;
    }
    if (smokeMode === 'cart-checkpoint-connection-drop') {
      checkpoints.length = 0;
      fulfillment = null;
      transientRunnerStatusFailures = 0;
      slowInitialSearchResponse = false;
      dropPrepareCartCheckpointConnection = true;
      stopAfterAlreadyOpenCartCheckpoint = true;
      const wakePage = await context.newPage();
      await wakePage.goto(`${baseUrl}/external-wake`);
      const wakePromise = wakePage.evaluate(({ extensionId: targetExtensionId, sessionId }) => new Promise((resolve) => {
        const progress = [];
        const port = chrome.runtime.connect(targetExtensionId, { name: 'magic-city-active-run-v1' });
        port.onMessage.addListener((payload) => {
          if (payload?.type === 'RUNNER_PROGRESS') progress.push(payload);
          if (payload?.type === 'RUNNER_RESULT') resolve({ payload, progress });
        });
        port.onDisconnect.addListener(() => resolve({ disconnected: true, progress }));
        port.postMessage({
          type: 'RUN_PENDING_SESSIONS',
          sessionId,
          extensionDispatchNonce: 'browser-smoke-cart-connection-drop'
        });
      }), { extensionId, sessionId: session.id });
      try {
        await waitFor(() => checkpoints.some((checkpoint) => checkpoint.planActionId === 'open-cart'
          && checkpoint.planActionStatus !== 'waiting'), 10_000);
      } catch {
        const runnerState = await popup.evaluate(() => chrome.storage.local.get([
          'lastError', 'lastExecution', 'activeSessionId', 'activeRun'
        ]));
        fail(`browser_extension_cart_connection_drop_timeout:${JSON.stringify({ checkpoints, runnerState, session })}`);
      }
      const wake = await withTimeout(wakePromise, 10_000, 'browser_extension_cart_connection_drop_wake_timeout');
      const nextCheckpoint = checkpoints.find((checkpoint) => checkpoint.planActionId === 'open-cart'
        && checkpoint.planActionStatus !== 'waiting');
      const recoveryMs = Number(nextCheckpoint?.testReceivedAtMs || 0) - prepareCartConnectionDroppedAtMs;
      const prepareCartCheckpointCount = checkpoints.filter((checkpoint) => checkpoint.planActionId === 'prepare-cart').length;
      const sawReconnectingRunner = (wake.progress || []).some((entry) => (
        entry?.activeRun?.progressState === 'reconnecting_control_plane'
        && entry?.activeRun?.progressLabel === 'Reconnecting Runner'
      ));
      if (prepareCartConnectionDroppedAtMs <= 0
        || recoveryMs <= 0
        || recoveryMs >= 8_000
        || prepareCartCheckpointCount !== 1
        || !sawReconnectingRunner
        || nextCheckpoint?.browser?.runnerStep?.controlStrategy !== 'amazon_cart_already_open') {
        fail(`browser_extension_cart_connection_drop_recovery_failed:${JSON.stringify({
          prepareCartConnectionDroppedAtMs,
          recoveryMs,
          prepareCartCheckpointCount,
          sawReconnectingRunner,
          nextCheckpoint,
          wake
        })}`);
      }
      recordPurchaseScenario('Literal cart checkpoint connection drop reconciles without replay', {
        recoveryMs,
        prepareCartCheckpointCount,
        strategy: nextCheckpoint.browser.runnerStep.controlStrategy
      });
      await wakePage.close();
      console.log(JSON.stringify({ amazonPurchaseSimulations: purchaseScenarioResults.length, scenarios: purchaseScenarioResults }, null, 2));
      console.log('native-runner cart checkpoint connection-drop smoke passed');
      return;
    }
    if (smokeMode === 'checkout-checkpoint-response-loss') {
      checkpoints.length = 0;
      fulfillment = null;
      transientRunnerStatusFailures = 0;
      slowInitialSearchResponse = false;
      dropContinueCheckoutCheckpointResponse = true;
      const continuationSessionId = 'browser-smoke-checkout-response-loss';
      const checkoutPage = await context.newPage();
      await checkoutPage.goto(`${baseUrl}/checkout/pay-confirm`);
      const checkoutTab = await popup.evaluate((url) => chrome.tabs.query({}).then((tabs) =>
        tabs.find((candidate) => candidate.url === url) || null), checkoutPage.url());
      if (!checkoutTab?.id) fail(`browser_extension_checkout_connection_drop_tab_missing:${checkoutPage.url()}`);
      const continuationPlan = rehashExtensionPlan({
        ...plan,
        planId: `mplan_${continuationSessionId}`,
        startUrl: checkoutPage.url(),
        actions: [
          { id: 'continue-checkout', type: 'click_intent', missionAction: 'browser_click', intent: 'checkout', optional: true },
          { id: 'inspect-review', type: 'inspect', missionAction: 'read_public_page', expectedMilestone: 'final_review_ready' },
          { id: 'pause-for-user', type: 'pause', missionAction: 'handoff', reason: 'checkout_connection_drop_smoke' }
        ]
      });
      session = {
        ...session,
        id: continuationSessionId,
        status: 'queued',
        claimedByPluginId: null,
        missionBoundAuth: {
          ...session.missionBoundAuth,
          capabilityId: 'browser-smoke-checkout-response-loss-capability',
          subject: { sessionId: continuationSessionId }
        },
        extensionMissionPlan: continuationPlan,
        extensionMissionPlanState: { planHash: continuationPlan.planHash, nextActionIndex: 0, completedActionIds: [] }
      };
      await seedSessionCheckoutProfile(continuationSessionId, {
        ...defaultCheckoutProfile,
        paymentCardLast4: '6383'
      }, continuationPlan.planHash);
      await popup.evaluate(async ({ sessionId, tabId }) => {
        const stored = await chrome.storage.local.get({ activeMissionTabs: {} });
        await chrome.storage.local.set({
          activeMissionTabs: { ...(stored.activeMissionTabs || {}), [sessionId]: tabId }
        });
      }, { sessionId: continuationSessionId, tabId: checkoutTab.id });
      const wakePage = await context.newPage();
      await wakePage.goto(`${baseUrl}/external-wake`);
      const wakePromise = wakePage.evaluate(({ extensionId: targetExtensionId, sessionId }) => new Promise((resolve) => {
        const progress = [];
        const port = chrome.runtime.connect(targetExtensionId, { name: 'magic-city-active-run-v1' });
        port.onMessage.addListener((payload) => {
          if (payload?.type === 'RUNNER_PROGRESS') progress.push(payload);
          if (payload?.type === 'RUNNER_RESULT') resolve({ payload, progress });
        });
        port.onDisconnect.addListener(() => resolve({ disconnected: true, progress }));
        port.postMessage({
          type: 'RUN_PENDING_SESSIONS',
          sessionId,
          extensionDispatchNonce: 'browser-smoke-checkout-response-loss'
        });
      }), { extensionId, sessionId: continuationSessionId });
      try {
        await waitFor(() => Boolean(fulfillment), 10_000);
      } catch {
        const runnerState = await popup.evaluate(() => chrome.storage.local.get([
          'lastError', 'lastExecution', 'activeSessionId', 'activeRun'
        ]));
        fail(`browser_extension_checkout_response_loss_timeout:${JSON.stringify({ checkpoints, runnerState, session })}`);
      }
      const wake = await withTimeout(wakePromise, 10_000, 'browser_extension_checkout_response_loss_wake_timeout');
      const recoveryMs = Date.now() - continueCheckoutCheckpointCommittedAtMs;
      const continuationCheckpointCount = checkpoints.filter((checkpoint) => checkpoint.planActionId === 'continue-checkout'
        && checkpoint.planActionStatus !== 'waiting').length;
      const continuationCheckpoint = checkpoints.find((checkpoint) => checkpoint.planActionId === 'continue-checkout'
        && checkpoint.planActionStatus !== 'waiting');
      const continuationClickCount = await checkoutPage.evaluate(() => Number(sessionStorage.getItem('magic-city-payment-confirm-clicks') || 0));
      const sawReconnectingRunner = (wake.progress || []).some((entry) => (
        entry?.activeRun?.progressState === 'reconnecting_control_plane'
        && entry?.activeRun?.progressLabel === 'Reconnecting Runner'
      ));
      if (continueCheckoutCheckpointCommittedAtMs <= 0
        || recoveryMs <= 0
        || recoveryMs >= 8_000
        || continuationCheckpointCount !== 1
        || continuationClickCount !== 1
        || !sawReconnectingRunner
        || continuationCheckpoint?.browser?.checkoutSummary?.stage !== 'final_review'
        || fulfillment?.result?.browserExecution?.stopState !== 'final_approval_required') {
        fail(`browser_extension_checkout_response_loss_recovery_failed:${JSON.stringify({
          continueCheckoutCheckpointCommittedAtMs,
          recoveryMs,
          continuationCheckpointCount,
          continuationClickCount,
          sawReconnectingRunner,
          continuationCheckpoint,
          fulfillment,
          wake
        })}`);
      }
      recordPurchaseScenario('Lost committed continue-checkout response reconciles without replay', {
        recoveryMs,
        continuationCheckpointCount,
        continuationClickCount
      });
      await wakePage.close();
      await checkoutPage.close();
      console.log(JSON.stringify({ amazonPurchaseSimulations: purchaseScenarioResults.length, scenarios: purchaseScenarioResults }, null, 2));
      console.log('native-runner checkout checkpoint response-loss smoke passed');
      return;
    }
    if (smokeMode === 'claim-rejection') {
      checkpoints.length = 0;
      fulfillment = null;
      rejectPrimaryClaimError = 'extension_run_dispatch_required';
      const wakeResult = await popup.evaluate((sessionId) => new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'RUN_PENDING_SESSIONS', sessionId }, resolve);
      }), session.id);
      if (!wakeResult?.ok
        || wakeResult.result?.requestedSessionFound !== true
        || wakeResult.result?.executed?.[0]?.status !== 'claim_failed'
        || wakeResult.result?.executed?.[0]?.error !== rejectPrimaryClaimError) {
        fail(`browser_extension_claim_rejection_not_reported:${JSON.stringify(wakeResult)}`);
      }
      const runnerState = await popup.evaluate(() => new Promise((resolve) => {
        chrome.storage.local.get(['lastError', 'lastExecution', 'activeSessionId', 'activeRun'], resolve);
      }));
      if (runnerState.lastError !== rejectPrimaryClaimError
        || runnerState.lastExecution?.status !== 'claim_failed'
        || runnerState.activeSessionId
        || runnerState.activeRun
        || checkpoints.length !== 0
        || session.status !== 'queued') {
        fail(`browser_extension_claim_rejection_state_not_durable:${JSON.stringify({ runnerState, checkpoints, session })}`);
      }
      rejectPrimaryClaimError = 'extension_run_dispatch_required';
      const directWakeResult = await popup.evaluate((sessionId) => new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: 'RUN_PENDING_SESSIONS',
          sessionId,
          extensionDispatchNonce: 'rejected-direct-dispatch'
        }, resolve);
      }), session.id);
      if (!directWakeResult?.ok
        || directWakeResult.result?.requestedSessionFound !== false
        || directWakeResult.result?.executed?.[0]?.status !== 'claim_failed'
        || directWakeResult.result?.executed?.[0]?.error !== rejectPrimaryClaimError) {
        fail(`browser_extension_direct_claim_rejection_not_reported:${JSON.stringify(directWakeResult)}`);
      }
      const directRunnerState = await popup.evaluate(() => new Promise((resolve) => {
        chrome.storage.local.get(['lastError', 'lastExecution', 'activeSessionId', 'activeRun'], resolve);
      }));
      if (directRunnerState.lastError !== rejectPrimaryClaimError
        || directRunnerState.lastExecution?.status !== 'claim_failed'
        || directRunnerState.activeSessionId
        || directRunnerState.activeRun
        || checkpoints.length !== 0
        || session.status !== 'queued') {
        fail(`browser_extension_direct_claim_rejection_state_not_durable:${JSON.stringify({
          runnerState: directRunnerState,
          checkpoints,
          session
        })}`);
      }
      recordPurchaseScenario('Polling and direct-start claim rejections are reported before browser work', {
        status: runnerState.lastExecution.status,
        directStatus: directRunnerState.lastExecution.status,
        error: runnerState.lastError,
        directError: directRunnerState.lastError
      });
      console.log(JSON.stringify({ amazonPurchaseSimulations: purchaseScenarioResults.length, scenarios: purchaseScenarioResults }, null, 2));
      console.log('native-runner claim rejection smoke passed');
      return;
    }
    if (smokeMode === 'completion-recovery') {
      checkpoints.length = 0;
      fulfillment = null;
      const completedSessionId = 'browser-smoke-completion-recovery-session';
      const completedPlan = rehashExtensionPlan({
        ...plan,
        planId: 'mplan_completion_recovery'
      });
      const completedMilestones = [
        'candidate_selected',
        'cart_confirmed',
        'checkout_open',
        'address_confirmed',
        'card_confirmed',
        'delivery_confirmed',
        'checkout_profile_verified',
        'final_review_ready',
        'final_submit_requested',
        'order_submitted'
      ];
      session = {
        ...session,
        id: completedSessionId,
        status: 'executing',
        claimedByPluginId: 'magic-city-runner-extension',
        fulfillment: null,
        missionBoundAuth: {
          ...session.missionBoundAuth,
          capabilityId: 'browser-smoke-completion-recovery-capability',
          subject: { sessionId: completedSessionId }
        },
        extensionMissionPlan: completedPlan,
        extensionMissionPlanState: {
          planHash: completedPlan.planHash,
          nextActionIndex: completedPlan.actions.length,
          completedActionIds: completedPlan.actions.map((action) => action.id),
          verifiedMilestones: completedMilestones
        }
      };
      await seedSessionCheckoutProfile(completedSessionId, defaultCheckoutProfile, completedPlan.planHash);
      await worker.evaluate(async ({ sessionId: activeSessionId, planHash, nextActionIndex }) => {
        await chrome.storage.local.set({
          activeSessionId,
          activeRun: {
            sessionId: activeSessionId,
            planHash,
            phase: 'running',
            nextActionIndex
          }
        });
      }, {
        sessionId: completedSessionId,
        planHash: completedPlan.planHash,
        nextActionIndex: completedPlan.actions.length
      });
      const completionResult = await popup.evaluate((sessionId) => new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'RUN_PENDING_SESSIONS', sessionId }, resolve);
      }), completedSessionId);
      if (!completionResult?.ok) {
        fail(`browser_extension_completion_recovery_wake_failed:${JSON.stringify(completionResult)}`);
      }
      await waitFor(() => Boolean(fulfillment), 10_000);
      if (fulfillment?.status !== 'fulfilled'
        || fulfillment?.result?.browserExecution?.stopState !== 'order_submitted'
        || fulfillment?.result?.browserExecution?.orderSubmitted !== true
        || checkpoints.length !== 0) {
        fail(`browser_extension_completion_recovery_not_terminal:${JSON.stringify({ fulfillment, checkpoints })}`);
      }
      const completionStorage = await worker.evaluate(() => new Promise((resolve) => {
        chrome.storage.local.get(['activeSessionId', 'activeRun'], resolve);
      }));
      if (completionStorage.activeSessionId || completionStorage.activeRun) {
        fail(`browser_extension_completion_recovery_active_run_not_cleared:${JSON.stringify(completionStorage)}`);
      }
      recordPurchaseScenario('Completed plan reconciles a durable merchant confirmation without replaying browser work', {
        stopState: fulfillment.result.browserExecution.stopState,
        checkpoints: checkpoints.length
      });
      console.log(JSON.stringify({ amazonPurchaseSimulations: purchaseScenarioResults.length, scenarios: purchaseScenarioResults }, null, 2));
      console.log('native-runner completed plan recovery smoke passed');
      return;
    }
    if (smokeMode === 'confirmed-order-terminal') {
      const runConfirmedOrderCase = async ({ id, closeTab = false, dropFulfillResponse = false }) => {
        checkpoints.length = 0;
        fulfillment = null;
        fulfillmentResponseDroppedAtMs = 0;
        const confirmationPlan = rehashExtensionPlan({
          ...plan,
          planId: `mplan_${id}`,
          startUrl: `${baseUrl}/checkout/order-confirmation`,
          limits: { ...plan.limits, stopBeforeFinalSubmit: false },
          actions: [
            {
              id: 'submit-final-order',
              type: 'final_submit',
              missionAction: 'final_submit',
              autoSubmitAfterVerifiedCheckout: true,
              expectedMilestone: 'final_submit_requested',
              maxPrice: 4
            },
            {
              id: 'confirm-merchant-order',
              type: 'inspect',
              missionAction: 'read_public_page',
              awaitMerchantOrderConfirmation: true,
              merchantConfirmationTimeoutMs: 90_000,
              expectedMilestone: 'order_submitted'
            },
            { id: 'pause-for-user', type: 'pause', missionAction: 'handoff', reason: 'order_confirmed' }
          ]
        });
        const merchantPage = await context.newPage();
        await merchantPage.goto(confirmationPlan.startUrl);
        const merchantTab = await popup.evaluate((url) => chrome.tabs.query({}).then((tabs) => (
          tabs.find((candidate) => candidate.url === url) || null
        )), merchantPage.url());
        if (!merchantTab?.id) fail(`browser_extension_${id}_merchant_tab_missing`);
        session = {
          ...session,
          id,
          status: 'queued',
          claimedByPluginId: null,
          fulfillment: null,
          missionBoundAuth: {
            ...session.missionBoundAuth,
            capabilityId: `browser-smoke-${id}-capability`,
            subject: { sessionId: id }
          },
          extensionMissionPlan: confirmationPlan,
          extensionMissionPlanState: {
            planHash: confirmationPlan.planHash,
            nextActionIndex: 1,
            completedActionIds: ['submit-final-order'],
            verifiedMilestones: ['final_submit_requested']
          }
        };
        await seedSessionCheckoutProfile(id, defaultCheckoutProfile, confirmationPlan.planHash);
        await popup.evaluate(async ({ sessionId, tabId }) => {
          const stored = await chrome.storage.local.get({ activeMissionTabs: {} });
          await chrome.storage.local.set({
            activeMissionTabs: { ...(stored.activeMissionTabs || {}), [sessionId]: tabId }
          });
        }, { sessionId: id, tabId: merchantTab.id });
        closeMerchantTabAfterConfirmationCheckpoint = closeTab;
        dropFulfillmentResponseAfterCommit = dropFulfillResponse;
        const wakePage = await context.newPage();
        await wakePage.goto(`${baseUrl}/external-wake`);
        const wakePromise = wakePage.evaluate(({ extensionId: targetExtensionId, sessionId }) => new Promise((resolve) => {
          const port = chrome.runtime.connect(targetExtensionId, { name: 'magic-city-active-run-v1' });
          const timer = setTimeout(() => resolve({ timedOut: true }), 12_000);
          port.onMessage.addListener((payload) => {
            if (payload?.type !== 'RUNNER_RESULT') return;
            clearTimeout(timer);
            resolve(payload);
          });
          port.onDisconnect.addListener(() => { void chrome.runtime.lastError; });
          port.postMessage({
            type: 'RUN_PENDING_SESSIONS',
            sessionId,
            extensionDispatchNonce: `browser-smoke-${sessionId}`
          });
        }), { extensionId, sessionId: id });
        await waitFor(() => Boolean(fulfillment), 10_000);
        await waitFor(async () => {
          const state = await popup.evaluate(() => chrome.storage.local.get(['activeSessionId', 'activeRun']));
          return !state.activeSessionId && !state.activeRun;
        }, 10_000);
        const wake = await wakePromise;
        const confirmationCheckpoints = checkpoints.filter((checkpoint) => (
          checkpoint.planActionId === 'confirm-merchant-order' && checkpoint.planActionStatus === 'completed'
        ));
        const pauseCheckpoints = checkpoints.filter((checkpoint) => checkpoint.planActionId === 'pause-for-user');
        if (wake?.timedOut
          || fulfillment?.status !== 'fulfilled'
          || fulfillment?.result?.browserExecution?.orderSubmitted !== true
          || fulfillment?.result?.browserExecution?.stopState !== 'order_submitted'
          || confirmationCheckpoints.length !== 1
          || pauseCheckpoints.length !== 0
          || (closeTab && !merchantPage.isClosed())
          || (dropFulfillResponse && fulfillmentResponseDroppedAtMs <= 0)) {
          fail(`browser_extension_${id}_confirmation_not_terminal:${JSON.stringify({
            wake,
            fulfillment,
            confirmationCheckpointCount: confirmationCheckpoints.length,
            pauseCheckpointCount: pauseCheckpoints.length,
            merchantPageClosed: merchantPage.isClosed(),
            fulfillmentResponseDroppedAtMs
          })}`);
        }
        await wakePage.close();
        if (!merchantPage.isClosed()) await merchantPage.close();
        return {
          confirmationCheckpointCount: confirmationCheckpoints.length,
          pauseCheckpointCount: pauseCheckpoints.length,
          tabClosed: closeTab,
          fulfillmentResponseDropped: dropFulfillResponse
        };
      };

      const runPendingOrderVerificationCase = async () => {
        checkpoints.length = 0;
        fulfillment = null;
        const id = 'browser-smoke-pending-order-verification';
        const pendingPlan = rehashExtensionPlan({
          ...plan,
          planId: `mplan_${id}`,
          startUrl: `${baseUrl}/checkout/duplicateOrder?stay=1&live=1&variant=cashew&unitPrice=2.97`,
          limits: { ...plan.limits, stopBeforeFinalSubmit: false },
          actions: [
            {
              id: 'submit-final-order',
              type: 'final_submit',
              missionAction: 'final_submit',
              autoSubmitAfterVerifiedCheckout: true,
              expectedMilestone: 'final_submit_requested',
              maxPrice: 4
            },
            {
              id: 'confirm-pending-order',
              type: 'final_submit',
              missionAction: 'final_submit',
              autoSubmitAfterVerifiedCheckout: true,
              pendingOrderContinuation: true,
              priorFinalSubmitActionId: 'submit-final-order',
              chainAuthorizationActionId: 'submit-final-order',
              expectedItemCount: 1,
              maxPrice: 4
            },
            {
              id: 'confirm-merchant-order',
              type: 'inspect',
              missionAction: 'read_public_page',
              awaitMerchantOrderConfirmation: true,
              merchantConfirmationTimeoutMs: 90_000,
              expectedMilestone: 'order_submitted'
            }
          ]
        });
        const merchantPage = await context.newPage();
        await merchantPage.goto(pendingPlan.startUrl);
        const merchantTab = await popup.evaluate((url) => chrome.tabs.query({}).then((tabs) => (
          tabs.find((candidate) => candidate.url === url) || null
        )), merchantPage.url());
        if (!merchantTab?.id) fail(`browser_extension_${id}_merchant_tab_missing`);
        const cartEvidence = {
          sessionId: id,
          planHash: pendingPlan.planHash,
          asin: 'NATURE-VALLEY-ALMOND',
          title: 'Nature Valley Sweet & Salty Almond Granola Bars, 6 ct, 7.2 oz',
          price: 2.97,
          quantity: 1,
          verifiedAt: new Date().toISOString()
        };
        session = {
          ...session,
          id,
          status: 'queued',
          claimedByPluginId: null,
          fulfillment: null,
          missionBoundAuth: {
            ...session.missionBoundAuth,
            capabilityId: `browser-smoke-${id}-capability`,
            subject: { sessionId: id }
          },
          extensionMissionPlan: pendingPlan,
          extensionMissionPlanState: {
            planHash: pendingPlan.planHash,
            nextActionIndex: 1,
            completedActionIds: ['submit-final-order'],
            verifiedMilestones: ['checkout_open', 'final_review_ready', 'final_submit_requested']
          }
        };
        await seedSessionCheckoutProfile(id, defaultCheckoutProfile, pendingPlan.planHash);
        await popup.evaluate(async ({ sessionId, tabId, planHash, evidence }) => {
          const stored = await chrome.storage.local.get({ activeMissionTabs: {}, finalOrderDispatches: {} });
          await chrome.storage.local.set({
            activeSessionId: sessionId,
            activeRun: {
              sessionId,
              planHash,
              phase: 'running',
              tabId,
              nextActionIndex: 1,
              selectedCandidate: { asin: evidence.asin, title: evidence.title, price: evidence.price },
              cartEvidence: evidence
            },
            activeMissionTabs: { ...(stored.activeMissionTabs || {}), [sessionId]: tabId },
            finalOrderDispatches: {
              ...(stored.finalOrderDispatches || {}),
              [String(tabId)]: [{
                actionId: 'submit-final-order',
                receiptScope: `${planHash}:submit-final-order`,
                kind: 'final_order',
                phase: 'click_dispatched',
                at: new Date().toISOString()
              }]
            }
          });
        }, { sessionId: id, tabId: merchantTab.id, planHash: pendingPlan.planHash, evidence: cartEvidence });
        const wake = await popup.evaluate((sessionId) => new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: 'RUN_PENDING_SESSIONS', sessionId }, resolve);
        }), id);
        if (!wake?.ok) fail(`browser_extension_${id}_wake_failed:${JSON.stringify(wake)}`);
        await waitFor(() => Boolean(fulfillment), 10_000);
        const browserExecution = fulfillment?.result?.browserExecution || {};
        const clickCount = await merchantPage.evaluate(() => Number(sessionStorage.getItem('magic-city-pending-final-clicks') || 0));
        if (fulfillment?.status !== 'fulfilled'
          || fulfillment?.fundingDisposition !== 'hold'
          || browserExecution.stopState !== 'pending_order_verification_required'
          || !/pending order did not match/i.test(String(browserExecution.stopEvidence || ''))
          || clickCount !== 0
          || checkpoints.some((checkpoint) => checkpoint.state === 'address_verification_required')) {
          fail(`browser_extension_${id}_wrong_handoff:${JSON.stringify({ fulfillment, checkpoints, clickCount })}`);
        }
        await merchantPage.close();
        return { stopState: browserExecution.stopState, fundingDisposition: fulfillment.fundingDisposition, clickCount };
      };

      const closedTabResult = await runConfirmedOrderCase({
        id: 'browser-smoke-confirmation-tab-closed',
        closeTab: true
      });
      recordPurchaseScenario('Durable merchant confirmation remains terminal after its tab closes', closedTabResult);
      const droppedResponseResult = await runConfirmedOrderCase({
        id: 'browser-smoke-confirmation-response-lost',
        dropFulfillResponse: true
      });
      recordPurchaseScenario('Lost fulfillment response reconciles the original confirmed order without replay', droppedResponseResult);
      const pendingOrderVerificationResult = await runPendingOrderVerificationCase();
      recordPurchaseScenario('Pending-order identity mismatch pauses for manual verification without an address error', pendingOrderVerificationResult);
      console.log(JSON.stringify({ amazonPurchaseSimulations: purchaseScenarioResults.length, scenarios: purchaseScenarioResults }, null, 2));
      console.log('native-runner confirmed order terminal smoke passed');
      return;
    }
    if (smokeMode === 'recovery') {
      const runRecoveryScenario = async ({ id, startPath, action, selectedCandidate = null, checkoutProfile = null, assertCheckpoint }) => {
        checkpoints.length = 0;
        fulfillment = null;
        const page = await context.newPage();
        await page.goto(`${baseUrl}${startPath}`);
        const tab = await popup.evaluate((url) => chrome.tabs.query({}).then((tabs) =>
          tabs.find((candidate) => candidate.url === url) || null), page.url());
        if (!tab?.id) fail(`browser_extension_${id}_tab_missing`);
        const recoveryPlan = rehashExtensionPlan({
          ...plan,
          planId: `mplan_${id}`,
          startUrl: page.url(),
          limits: { ...plan.limits, stopBeforeFinalSubmit: false },
          actions: [
            action,
            ...(action.type === 'final_submit' ? [{
              id: 'confirm-merchant-order',
              type: 'inspect',
              missionAction: 'read_public_page',
              awaitMerchantOrderConfirmation: true,
              merchantConfirmationTimeoutMs: 90_000,
              expectedMilestone: 'order_submitted'
            }] : []),
            { id: 'pause-for-user', type: 'pause', missionAction: 'handoff', reason: 'recovery_smoke' }
          ]
        });
        session = {
          ...session,
          id,
          status: 'claimed',
          claimedByPluginId: 'magic-city-runner-extension',
          fulfillment: null,
          missionBoundAuth: { ...session.missionBoundAuth, subject: { sessionId: id } },
          extensionMissionPlan: recoveryPlan,
          extensionMissionPlanState: { planHash: recoveryPlan.planHash, nextActionIndex: 0, completedActionIds: [] },
          missionBoundaryLatestHash: null,
          missionBoundaryEventCount: 0
        };
        if (checkoutProfile) await seedSessionCheckoutProfile(id, checkoutProfile, recoveryPlan.planHash);
        await popup.evaluate(({ sessionId, tabId, planHash, action: interruptedAction, selected }) => new Promise((resolve) => {
          chrome.storage.local.get(['activeMissionTabs'], (stored) => {
            chrome.storage.local.set({
              activeMissionTabs: { ...(stored.activeMissionTabs || {}), [sessionId]: tabId },
              activeSessionId: sessionId,
              activeRun: {
                sessionId,
                planHash,
                phase: 'executing_step',
                tabId,
                actionId: interruptedAction.id,
                actionIndex: 0,
                nextActionIndex: 0,
                selectedCandidate: selected,
                startedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
              }
            }, () => {
              chrome.alarms.create('magic-city-runner-resume', { when: Date.now() + 400 });
              resolve();
            });
          });
        }), { sessionId: id, tabId: tab.id, planHash: recoveryPlan.planHash, action, selected: selectedCandidate });
        const cdp = await context.newCDPSession(page);
        await cdp.send('ServiceWorker.enable');
        await cdp.send('ServiceWorker.stopAllWorkers');
        await waitFor(() => Boolean(fulfillment), 12_000);
        const checkpoint = checkpoints.find((entry) => entry.planActionId === action.id
          && entry.planActionStatus === 'completed');
        assertCheckpoint(checkpoint, fulfillment);
        await page.close();
      };
      await runRecoveryScenario({
        id: 'browser-smoke-cart-recovery-session',
        startPath: '/cart',
        action: {
          id: 'prepare-cart', type: 'click_intent', missionAction: 'prepare_cart', intent: 'add_to_cart',
          query: 'test gadget', requiredBasketItem: true, expectedMilestone: 'cart_confirmed', expectedCartItemCount: 1, maxPrice: 4
        },
        selectedCandidate: { title: 'Test Gadget', asin: 'B000SMOKE1', price: 3.5 },
        assertCheckpoint: (checkpoint) => {
          if (checkpoint?.browser?.runnerStep?.recoveredFromInterruption !== true || !checkpoint?.verifiedMilestones?.includes('cart_confirmed')) {
            fail(`browser_extension_cart_recovery_not_verified:${JSON.stringify({ checkpoint, fulfillment })}`);
          }
        }
      });
      await runRecoveryScenario({
        id: 'browser-smoke-payment-recovery-session',
        startPath: '/checkout/pay-confirm',
        action: {
          id: 'fill-checkout-profile', type: 'fill_checkout_profile', missionAction: 'fill_safe_fields',
          expectedMilestone: 'checkout_profile_verified', primeRequired: true
        },
        checkoutProfile: {
          contactName: 'Test User', streetAddress: '1 Magic City Way', shippingCity: 'San Francisco',
          shippingState: 'CA', zipCode: '94107', contactPhone: '4155550100',
          billingStreetAddress: '99 Billing Plaza', billingZipCode: '10001', paymentCardLast4: '6383'
        },
        assertCheckpoint: (checkpoint) => {
          if (checkpoint?.browser?.runnerStep?.recoveredFromInterruption !== true
            || !checkpoint?.verifiedMilestones?.includes('checkout_profile_verified')) {
            fail(`browser_extension_payment_recovery_not_verified:${JSON.stringify({ checkpoint, fulfillment })}`);
          }
        }
      });
      await runRecoveryScenario({
        id: 'browser-smoke-checkout-recovery-session',
        startPath: '/checkout/p/p-106-7044535-6467434/spc?pipelineType=Chewbacca&referrer=spc',
        action: {
          id: 'open-checkout', type: 'click_intent', missionAction: 'browser_click', intent: 'checkout',
          expectedMilestone: 'checkout_open'
        },
        assertCheckpoint: (checkpoint) => {
          if (checkpoint?.browser?.runnerStep?.recoveredFromInterruption !== true
            || !checkpoint?.verifiedMilestones?.includes('checkout_open')) {
            fail(`browser_extension_checkout_recovery_not_verified:${JSON.stringify({ checkpoint, fulfillment })}`);
          }
        }
      });
      await runRecoveryScenario({
        id: 'browser-smoke-final-recovery-session',
        startPath: '/checkout/order-confirmation',
        action: {
          id: 'submit-final-order', type: 'final_submit', missionAction: 'final_submit', autoSubmitAfterVerifiedCheckout: true,
          expectedMilestone: 'final_submit_requested', maxPrice: 4
        },
        assertCheckpoint: (checkpoint) => {
          if (checkpoint?.browser?.runnerStep?.recoveredFromInterruption !== true
            || checkpoint?.browser?.finalSubmitRequested !== true
            || checkpoint?.browser?.orderSubmitted !== true
            || !checkpoint?.verifiedMilestones?.includes('final_submit_requested')) {
            fail(`browser_extension_final_recovery_not_verified:${JSON.stringify({ checkpoint, fulfillment })}`);
          }
        }
      });
      recordPurchaseScenario('Forced MV3 restart recovers cart, checkout, payment confirmation, and final-order mutations', { scenarios: 4 });
      console.log(JSON.stringify({ amazonPurchaseSimulations: purchaseScenarioResults.length, scenarios: purchaseScenarioResults }, null, 2));
      console.log('native-runner focused recovery smoke passed');
      return;
    }
    if (/^final-submit-lease-(?:renewal|expiry|lost-checkpoint)$/.test(smokeMode)) {
      const shouldExpireAfterCheckpoint = smokeMode === 'final-submit-lease-expiry';
      const shouldRecoverLostCheckpoint = smokeMode === 'final-submit-lease-lost-checkpoint';
      // Drive the real worker through navigation, a normal inspection
      // checkpoint, and then the irreversible final-submit action. The
      // renewal case lets the original copied one-second lease expire while
      // the signed review checkpoint is pending. The expiry case delays only
      // after that fresh checkpoint, so it proves a stale scoped lease still
      // cannot dispatch the native Amazon input.
      checkoutFixture = {
        total: '$2.97',
        merchandiseSubtotal: '$2.97',
        shipping: '$0.00',
        itemCount: 1,
        selectedCardLast4: '6383',
        matchingAddressAvailable: true,
        matchingAddressChecked: true,
        selectedFreeDelivery: true,
        showAddressPrimeModal: false,
        showPickupDisclosure: false,
        showPickupModal: false
      };
      checkpoints.length = 0;
      fulfillment = null;
      delayLeaseExpiryCheckpoint = !shouldExpireAfterCheckpoint && !shouldRecoverLostCheckpoint;
      dropInspectReviewCheckpointResponse = shouldRecoverLostCheckpoint;
      if (shouldRecoverLostCheckpoint) transientRunnerStatusFailures = 0;
      const leaseExpiryPlan = rehashExtensionPlan({
        ...plan,
        planId: 'mplan_browser-smoke-final-submit-lease',
        startUrl: `${baseUrl}/checkout/final-review`,
        limits: { ...plan.limits, stopBeforeFinalSubmit: false },
        actions: [
          {
            ...plan.actions.find((action) => action.id === 'open-site'),
            id: 'open-final-review',
            url: `${baseUrl}/checkout/final-review`
          },
          {
            ...plan.actions.find((action) => action.id === 'inspect-review'),
            id: 'inspect-before-final-submit',
            ...(shouldRecoverLostCheckpoint ? {} : { expectedMilestone: undefined })
          },
          {
            ...plan.actions.find((action) => action.id === 'submit-final-order'),
            autoSubmitAfterVerifiedCheckout: true
          },
          { ...plan.actions.find((action) => action.id === 'confirm-merchant-order') },
          { ...plan.actions.find((action) => action.id === 'pause-for-user') }
        ]
      });
      session = {
        ...session,
        id: 'browser-smoke-final-submit-lease',
        status: 'queued',
        claimedByPluginId: null,
        fulfillment: null,
        missionBoundAuth: {
          ...session.missionBoundAuth,
          subject: { sessionId: 'browser-smoke-final-submit-lease' }
        },
        extensionMissionPlan: leaseExpiryPlan,
        extensionMissionPlanState: { planHash: leaseExpiryPlan.planHash, nextActionIndex: 0, completedActionIds: [] },
        missionBoundaryLatestHash: null,
        missionBoundaryEventCount: 0
      };
      await worker.evaluate(() => chrome.storage.local.set({ activeMissionTabs: {}, activeRun: null, activeSessionId: null }));
      await seedSessionCheckoutProfile(session.id, {
        ...defaultCheckoutProfile,
        paymentCardLast4: '6383'
      }, leaseExpiryPlan.planHash);
      const leaseRunPromise = runtimeMessageWithTimeout(
        popup,
        { type: 'RUN_PENDING_SESSIONS', sessionId: session.id }
      );
      if (shouldRecoverLostCheckpoint) {
        void leaseRunPromise.catch(() => null);
        await waitFor(() => session.extensionMissionPlanState.nextActionIndex === 2
          && inspectReviewCheckpointCommitted, 10_000);
        try {
          const state = await withTimeout(popup.evaluate(() => new Promise((resolve) => {
            chrome.storage.local.get(['activeRun'], resolve);
          })), 3_000, 'browser_extension_lost_checkpoint_storage_timeout');
          if (state.activeRun?.sessionId !== session.id || state.activeRun?.finalSubmitAuthorityLease != null) {
            throw new Error('lost_checkpoint_active_run_not_scoped');
          }
        } catch (error) {
          const state = await withTimeout(popup.evaluate(() => new Promise((resolve) => {
            chrome.storage.local.get(['lastError', 'lastExecution', 'activeRun'], resolve);
          })), 3_000, 'browser_extension_lost_checkpoint_diagnostics_timeout');
          fail(`browser_extension_lost_checkpoint_not_interruptible:${JSON.stringify({ state, sessionState: session.extensionMissionPlanState, error: error.message })}`);
        }
        const cdp = await context.newCDPSession(popup);
        await cdp.send('ServiceWorker.enable');
        await withTimeout(
          cdp.send('ServiceWorker.stopAllWorkers'),
          10_000,
          'browser_extension_lost_checkpoint_worker_stop_timeout'
        );
        releaseDroppedInspectReviewResponse?.();
        await new Promise((resolve) => setTimeout(resolve, 250));
        const resumed = await runtimeMessageWithTimeout(
          popup,
          { type: 'RUN_PENDING_SESSIONS', sessionId: session.id }
        );
        if (resumed?.response && (!resumed.response.ok || resumed.response.result?.status === 'already_running')) {
          fail(`browser_extension_lost_checkpoint_resume_failed:${JSON.stringify(resumed)}`);
        }
      } else {
        const leaseRun = await leaseRunPromise;
        if (leaseRun?.response && !leaseRun.response.ok) {
          fail(`browser_extension_final_submit_lease_start_failed:${leaseRun?.error || leaseRun?.response?.error || 'no_response'}`);
        }
      }
      try {
        await waitFor(async () => {
          if (!shouldExpireAfterCheckpoint) {
            return checkpoints.some((checkpoint) => checkpoint.planActionId === 'submit-final-order'
              && checkpoint.browser?.runnerStep?.finalSubmitReceipt?.phase === 'click_dispatched');
          }
          const state = await withTimeout(popup.evaluate(() => new Promise((resolve) => {
            chrome.storage.local.get(['lastError', 'activeRun'], resolve);
          })), 3_000, 'browser_extension_final_submit_lease_storage_timeout');
          return fulfillment?.result?.browserExecution?.stopState === 'final_submit_authorization_rejected'
            && !state.activeRun;
        }, 15_000);
      } catch {
        const runnerState = await withTimeout(popup.evaluate(() => new Promise((resolve) => {
          chrome.storage.local.get(['lastError', 'lastExecution', 'activeRun', 'activeMissionTabs'], resolve);
        })), 3_000, 'browser_extension_final_submit_lease_diagnostics_timeout');
        fail(`browser_extension_final_submit_lease_timeout:${JSON.stringify({
          checkpoints: checkpoints.map((checkpoint) => ({
            actionId: checkpoint.planActionId,
            status: checkpoint.planActionStatus,
            detail: checkpoint.detail
          })),
          runnerState,
          sessionState: session.extensionMissionPlanState
        })}`);
      } finally {
        delayLeaseExpiryCheckpoint = false;
      }
      const checkoutPage = context.pages().find((page) => page.url().startsWith(baseUrl)
        && page.url().includes('/checkout/final-review'));
      if (!checkoutPage) fail('browser_extension_final_submit_lease_checkout_page_missing');
      const browserEvidence = await checkoutPage.evaluate(() => ({
        nativeClick: sessionStorage.getItem('magic-city-native-final-click') || '',
        orderSubmitted: document.body.dataset.orderSubmitted || '',
        receipts: JSON.parse(sessionStorage.getItem('magic_city_browser_action_receipts_v1') || '[]')
      }));
      const runnerEvidence = await withTimeout(popup.evaluate(() => new Promise((resolve) => {
        chrome.storage.local.get(['lastError', 'lastExecution', 'activeRun'], resolve);
      })), 3_000, 'browser_extension_final_submit_lease_evidence_timeout');
      const finalCheckpoint = checkpoints.find((checkpoint) => checkpoint.planActionId === 'submit-final-order');
      const checkpointReceipts = finalCheckpoint?.browser?.browserActionReceipts || [];
      if (shouldExpireAfterCheckpoint) {
        if (fulfillment?.status !== 'failed'
          || fulfillment?.result?.browserExecution?.stopState !== 'final_submit_authorization_rejected'
          || !String(fulfillment?.result?.browserExecution?.stopEvidence || '').includes('final_submit_authority_lease_expired')
          || browserEvidence.nativeClick
          || browserEvidence.orderSubmitted
          || browserEvidence.receipts.some((receipt) => receipt?.kind === 'final_order')
          || checkpointReceipts.some((receipt) => receipt?.kind === 'final_order')) {
          fail(`browser_extension_final_submit_lease_expiry_dispatched_or_reported_order:${JSON.stringify({
            fulfillment,
            runnerEvidence,
            browserEvidence,
            checkpoint: finalCheckpoint || null
          })}`);
        }
      } else if (runnerEvidence.lastError
        || browserEvidence.nativeClick !== '1'
        || browserEvidence.orderSubmitted !== '1'
        || !checkpointReceipts.some((receipt) => receipt?.kind === 'final_order' && receipt?.phase === 'click_dispatched')) {
        fail(`browser_extension_final_submit_lease_renewal_did_not_dispatch:${JSON.stringify({
          fulfillment,
          runnerEvidence,
          browserEvidence,
          checkpoint: finalCheckpoint || null,
          sessionState: session.extensionMissionPlanState,
          runnerStatusCalls: runnerStatusRequestCount
        })}`);
      }
      recordPurchaseScenario(
        shouldExpireAfterCheckpoint
          ? 'Expired final-submit lease blocks the native Amazon click and receipts'
          : shouldRecoverLostCheckpoint
            ? 'Lost review-checkpoint response recovers one exact final-submit lease after worker restart'
          : 'Fresh signed review checkpoint renews the exact final-submit lease once',
        shouldExpireAfterCheckpoint
          ? {
            error: runnerEvidence.lastError,
            finalCheckpointStatus: finalCheckpoint?.planActionStatus || 'none',
            terminalReport: fulfillment?.result?.browserExecution?.stopState || 'missing'
            }
          : {
              finalCheckpointStatus: finalCheckpoint?.planActionStatus || 'none',
              nativeClick: browserEvidence.nativeClick,
              orderSubmitted: browserEvidence.orderSubmitted
            }
      );
      console.log(JSON.stringify({ amazonPurchaseSimulations: purchaseScenarioResults.length, scenarios: purchaseScenarioResults }, null, 2));
      console.log('native-runner final-submit lease behavior smoke passed');
      return;
    }
    console.log('native-runner browser smoke running full checkout matrix');
    const commandPage = async (page, message) => {
      const activeWorker = context.serviceWorkers()[0] || worker;
      const tab = await Promise.race([
        activeWorker.evaluate(async (url) => {
          const tabs = await chrome.tabs.query({});
          return tabs.find((candidate) => candidate.url === url) || null;
        }, page.url()),
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 15_000))
      ]);
      if (tab?.timeout) fail(`browser_extension_service_worker_tab_lookup_timeout:${page.url()}`);
      if (!tab?.id) fail(`browser_extension_policy_test_tab_missing:${page.url()}`);
      const response = await Promise.race([
        activeWorker.evaluate(async ({ tabId, payload }) => {
        const timeoutResult = { completed: false, reason: 'browser_content_script_injection_timeout' };
        const injected = await Promise.race([
          chrome.scripting.executeScript({ target: { tabId }, files: ['executor.js'] }).then(() => true),
          new Promise((resolve) => setTimeout(() => resolve(false), 15_000))
        ]);
        if (!injected) return timeoutResult;
        return Promise.race([
          chrome.tabs.sendMessage(tabId, payload),
          new Promise((resolve) => setTimeout(() => resolve({
            completed: false,
            reason: 'browser_content_script_timeout'
          }), 15_000))
        ]);
        }, { tabId: tab.id, payload: message }),
        new Promise((resolve) => setTimeout(() => resolve({
          completed: false,
          reason: 'browser_service_worker_evaluation_timeout'
        }), 20_000))
      ]);
      if (/^browser_content_script_(?:injection_)?timeout$/.test(String(response?.reason || ''))) {
        fail(`browser_extension_content_script_timeout:${page.url()}`);
      }
      return response;
    };
    console.log('native-runner browser smoke opening signed-out fixture');
    const signedOutPage = await context.newPage();
    console.log('native-runner browser smoke signed-out fixture tab ready');
    await signedOutPage.goto(`${baseUrl}/signed-out-search`);
    console.log('native-runner browser smoke signed-out fixture loaded');
    const signedOutState = await commandPage(signedOutPage, { type: 'MAGIC_CITY_BROWSER_STATE' });
    if (signedOutState.amazonAccountState !== 'signed_out' || signedOutState.loginRequired !== true) {
      fail(`browser_extension_did_not_fail_closed_for_signed_out_amazon:${JSON.stringify(signedOutState)}`);
    }
    recordPurchaseScenario('signed-out Amazon account stops before purchase work', {
      state: signedOutState.amazonAccountState
    });
    await signedOutPage.close();

    const freeShippingPage = await context.newPage();
    await freeShippingPage.goto(`${baseUrl}/free-shipping-search`);
    const fallbackAction = await commandPage(freeShippingPage, {
      type: 'MAGIC_CITY_EXECUTE_PLAN_STEP',
      action: { type: 'click_intent', intent: 'prefer_free_delivery', fulfillmentPolicy: 'amazon_free_shipping_preferred', primeRequired: true }
    });
    if (!fallbackAction.completed || fallbackAction.fulfillmentFilter !== 'prime_unavailable') {
      fail(`browser_extension_prime_only_mission_fell_back_to_free_shipping:${JSON.stringify(fallbackAction)}`);
    }
    const freeShippingState = await commandPage(freeShippingPage, { type: 'MAGIC_CITY_BROWSER_STATE' });
    if (freeShippingState.amazonFulfillmentFilterSelected === 'free_shipping') {
      fail(`browser_extension_prime_only_selected_generic_free_shipping:${JSON.stringify(freeShippingState)}`);
    }
    recordPurchaseScenario('Prime-only mission does not silently use generic free-shipping filter', {
      selectedFilter: freeShippingState.amazonFulfillmentFilterSelected || 'none'
    });
    await freeShippingPage.close();

    const directResultCartPage = await context.newPage();
    await directResultCartPage.goto(`${baseUrl}/direct-result-cart-search`);
    const directResultSelection = await commandPage(directResultCartPage, {
      type: 'MAGIC_CITY_EXECUTE_PLAN_STEP',
      action: {
        type: 'select_candidate',
        query: 'nature valley granola bars',
        maxPrice: 4,
        candidatePolicy: 'price_quality_delivery_preference',
        fulfillmentPolicy: 'amazon_free_shipping_preferred',
        primeRequired: true
      }
    });
    if (!directResultSelection?.completed
      || directResultSelection.navigationRequested !== false
      || directResultSelection.directCartControlAvailable !== true
      || directResultSelection.directSearchResultCart !== true
      || !/Nature Valley/i.test(String(directResultSelection.selected?.title || ''))) {
      fail(`browser_extension_direct_result_cart_candidate_not_selected:${JSON.stringify(directResultSelection)}`);
    }
    const directResultStateAfterSelection = await commandPage(directResultCartPage, { type: 'MAGIC_CITY_BROWSER_STATE' });
    if (Number(directResultStateAfterSelection.checkoutSummary?.cartItemCount || 0) !== 1) {
      fail(`browser_extension_direct_result_selection_did_not_add_exact_card:${JSON.stringify(directResultStateAfterSelection)}`);
    }
    const directResultCartAction = await commandPage(directResultCartPage, {
      type: 'MAGIC_CITY_EXECUTE_PLAN_STEP',
      action: {
        type: 'click_intent',
        intent: 'add_to_cart',
        boundCandidate: directResultSelection.selected,
        fulfillmentPolicy: 'amazon_free_shipping_preferred',
        primeRequired: true
      }
    });
    const directResultCartState = await commandPage(directResultCartPage, { type: 'MAGIC_CITY_BROWSER_STATE' });
    if (!directResultCartAction?.completed
      || directResultCartAction.directSearchResultCart !== true
      || directResultCartAction.alreadyStarted !== true
      || Number(directResultCartState.checkoutSummary?.cartItemCount || 0) !== 1
      || directResultCartPage.url().includes('/dp/')) {
      fail(`browser_extension_direct_result_card_add_to_cart_failed:${JSON.stringify({
        action: directResultCartAction,
        state: directResultCartState,
        url: directResultCartPage.url()
      })}`);
    }
    recordPurchaseScenario('Visible Prime search result is selected and added atomically without a duplicate', {
      title: directResultSelection.selected?.title,
      cartCount: directResultCartState.checkoutSummary?.cartItemCount
    });
    const directResultOpenCartAction = await commandPage(directResultCartPage, {
      type: 'MAGIC_CITY_EXECUTE_PLAN_STEP',
      action: { type: 'navigate', intent: 'open_cart', preferExistingCartControl: true }
    });
    await directResultCartPage.waitForURL(/\/cart\?source=side-cart/);
    if (!directResultOpenCartAction?.completed || directResultOpenCartAction?.controlStrategy !== 'amazon_side_cart') {
      fail(`browser_extension_side_cart_transition_failed:${JSON.stringify(directResultOpenCartAction)}`);
    }
    recordPurchaseScenario('Visible side-cart Go to Cart is preferred over generic navigation', {
      strategy: directResultOpenCartAction.controlStrategy
    });
    await directResultCartPage.close();
    await verifyAmazonNavFlyout();

    const headerCartPage = await context.newPage();
    await headerCartPage.goto(`${baseUrl}/header-cart-search`);
    const headerCartAction = await commandPage(headerCartPage, {
      type: 'MAGIC_CITY_EXECUTE_PLAN_STEP',
      action: { type: 'navigate', intent: 'open_cart', preferExistingCartControl: true }
    });
    await headerCartPage.waitForURL(/\/cart\?source=header-cart/);
    if (!headerCartAction?.completed || headerCartAction?.controlStrategy !== 'amazon_header_cart') {
      fail(`browser_extension_header_cart_transition_failed:${JSON.stringify(headerCartAction)}`);
    }
    recordPurchaseScenario('Header cart is used when no side-cart action is visible', {
      strategy: headerCartAction.controlStrategy
    });
    await headerCartPage.close();

    const postAddConfirmationPage = await context.newPage();
    await postAddConfirmationPage.goto(`${baseUrl}/post-add-confirmation`);
    const postAddCartAction = await commandPage(postAddConfirmationPage, {
      type: 'MAGIC_CITY_EXECUTE_PLAN_STEP',
      action: { type: 'navigate', intent: 'open_cart', preferExistingCartControl: true }
    });
    await postAddConfirmationPage.waitForURL(/\/cart\?source=post-add-confirmation/, { timeout: 5_000 }).catch(() => null);
    if (!postAddCartAction?.completed
      || postAddCartAction?.controlStrategy !== 'amazon_post_add_go_to_cart'
      || !/\/cart\?source=post-add-confirmation/.test(postAddConfirmationPage.url())
      || postAddConfirmationPage.url().includes('/checkout/')) {
      fail(`browser_extension_post_add_confirmation_transition_failed:${JSON.stringify({
        action: postAddCartAction,
        url: postAddConfirmationPage.url()
      })}`);
    }
    recordPurchaseScenario('Full-page Added to cart confirmation enters the cart before checkout', {
      strategy: postAddCartAction.controlStrategy,
      url: postAddConfirmationPage.url()
    });
    await postAddConfirmationPage.close();

    const cartProceedPage = await context.newPage();
    await cartProceedPage.goto(`${baseUrl}/gp/cart/view.html`);
    const cartProceedState = await commandPage(cartProceedPage, { type: 'MAGIC_CITY_BROWSER_STATE' });
    if (cartProceedState?.browserState !== 'cart'
      || Number(cartProceedState.checkoutSummary?.cartItemCount || 0) !== 1
      || !cartProceedState.checkoutSummary?.availableActions?.some((label) => /proceed to checkout/i.test(String(label)))) {
      fail(`browser_extension_cart_fast_state_not_ready_for_checkout:${JSON.stringify(cartProceedState)}`);
    }
    const cartProceedAction = await commandPage(cartProceedPage, {
      type: 'MAGIC_CITY_EXECUTE_PLAN_STEP',
      action: {
        type: 'click_intent',
        intent: 'checkout',
        fulfillmentPolicy: 'amazon_free_shipping_preferred',
        primeRequired: true,
        expectedMilestone: 'checkout_open'
      }
    });
    await cartProceedPage.waitForURL(/\/checkout\//, { timeout: 5_000 }).catch(() => null);
    if (!cartProceedAction?.completed
      || cartProceedAction.cartCheckoutStarted !== true
      || !/proceed to checkout/i.test(String(cartProceedAction.label || ''))
      || !cartProceedPage.url().includes('/checkout/')) {
      fail(`browser_extension_cart_proceed_to_checkout_failed:${JSON.stringify({
        action: cartProceedAction,
        url: cartProceedPage.url()
      })}`);
    }
    recordPurchaseScenario('Cart page clicks Proceed to checkout directly', {
      strategy: cartProceedAction.controlStrategy,
      url: cartProceedPage.url()
    });
    await cartProceedPage.close();

    const checkoutInterstitialPage = await context.newPage();
    await checkoutInterstitialPage.goto(`${baseUrl}/alm/byg?pipelineType=Chewbacca&referrer=cart`);
    const checkoutInterstitialAction = await commandPage(checkoutInterstitialPage, {
      type: 'MAGIC_CITY_EXECUTE_PLAN_STEP',
      action: { type: 'click_intent', intent: 'checkout', fulfillmentPolicy: 'amazon_free_shipping_preferred' }
    });
    if (checkoutInterstitialAction?.completed !== false || checkoutInterstitialAction?.localMarketBlocked !== true) {
      fail('browser_extension_did_not_block_amazon_local_market:' + JSON.stringify(checkoutInterstitialAction));
    }
    recordPurchaseScenario('Amazon Local Market checkout prelude is blocked under Prime-only policy', {
      path: '/alm/byg'
    });
   await checkoutInterstitialPage.close();

    const thirdPartyProductPage = await context.newPage();
    await thirdPartyProductPage.goto(`${baseUrl}/dp/nature-valley-local-market`);
    const thirdPartyProductAction = await commandPage(thirdPartyProductPage, {
      type: 'MAGIC_CITY_EXECUTE_PLAN_STEP',
      action: { type: 'click_intent', intent: 'add_to_cart', fulfillmentPolicy: 'amazon_free_shipping_preferred' }
    });
    if (thirdPartyProductAction?.completed !== false || !/third-party seller/i.test(String(thirdPartyProductAction?.reason || ''))) {
      fail('browser_extension_did_not_block_third_party_product:' + JSON.stringify(thirdPartyProductAction));
    }
    recordPurchaseScenario('Third-party product page is blocked before cart add', {
      path: '/dp/nature-valley-local-market'
    });
    await thirdPartyProductPage.close();

    await seedSessionCheckoutProfile('browser-smoke-session', {
      ...defaultCheckoutProfile,
      paymentCardLast4: '6383'
    }, plan.planHash);

    const paymentConfirmPage = await context.newPage();
    await paymentConfirmPage.goto(`${baseUrl}/checkout/pay-confirm`);
    const paymentConfirmAction = await commandPage(paymentConfirmPage, {
      type: 'MAGIC_CITY_EXECUTE_PLAN_STEP',
      action: { type: 'fill_checkout_profile', primeRequired: true },
      checkoutProfile: {
        contactName: 'Test User',
        streetAddress: '1 Magic City Way',
        shippingCity: 'San Francisco',
        shippingState: 'CA',
        zipCode: '94107',
        contactPhone: '4155550100',
        billingStreetAddress: '99 Billing Plaza',
        billingZipCode: '10001',
        paymentCardLast4: '6383'
      }
    });
    await paymentConfirmPage.waitForURL(/\/checkout\/final-review/, { timeout: 5_000 }).catch(() => null);
    if (!paymentConfirmAction?.completed
      || !/use this payment method/i.test(String(paymentConfirmAction.label || ''))
      || !paymentConfirmPage.url().includes('/checkout/final-review')) {
      fail(`browser_extension_did_not_confirm_already_selected_payment_method:${JSON.stringify({
        action: paymentConfirmAction,
        url: paymentConfirmPage.url()
      })}`);
    }
    recordPurchaseScenario('Already-selected matching payment card clicks Use this payment method', {
      label: paymentConfirmAction.label
    });
    await paymentConfirmPage.close();

    const paymentConfirmContinuationPage = await context.newPage();
    await paymentConfirmContinuationPage.goto(`${baseUrl}/checkout/pay-confirm`);
    const paymentConfirmContinuationAction = await commandPage(paymentConfirmContinuationPage, {
      type: 'MAGIC_CITY_EXECUTE_PLAN_STEP',
      action: { type: 'click_intent', intent: 'checkout', primeRequired: true },
      checkoutProfile: {
        contactName: 'Test User',
        streetAddress: '1 Magic City Way',
        shippingCity: 'San Francisco',
        shippingState: 'CA',
        zipCode: '94107',
        contactPhone: '4155550100',
        billingStreetAddress: '99 Billing Plaza',
        billingZipCode: '10001',
        paymentCardLast4: '6383'
      }
    });
    await paymentConfirmContinuationPage.waitForURL(/\/checkout\/final-review/, { timeout: 5_000 }).catch(() => null);
    if (!paymentConfirmContinuationAction?.completed
      || paymentConfirmContinuationAction?.controlStrategy !== 'selected_payment_method_confirmation'
      || !/use this payment method/i.test(String(paymentConfirmContinuationAction.label || ''))
      || !paymentConfirmContinuationPage.url().includes('/checkout/final-review')) {
      fail(`browser_extension_did_not_continue_matching_payment_method:${JSON.stringify({
        action: paymentConfirmContinuationAction,
        url: paymentConfirmContinuationPage.url()
      })}`);
    }
    recordPurchaseScenario('Checkout continuation confirms the selected matching card with duplicate merchant controls', {
      strategy: paymentConfirmContinuationAction.controlStrategy,
      label: paymentConfirmContinuationAction.label
    });
    await paymentConfirmContinuationPage.close();

    checkoutFixture = {
      ...checkoutFixture,
      pendingOrderContinuation: true,
      // Keep the merchant response deliberately slow. This proves the live
      // extension connection survives a normal checkout that lasts longer
      // than one Chrome heartbeat without making browser steps slow.
      pendingOrderConfirmationDelayMs: 65_000
    };
    dropPrepareCartCheckpointResponse = true;
    dropCommittedCheckpointResponses = new Set([
      'open-site',
      'inspect-cart',
      'reconcile-payment-profile',
      'inspect-review',
      'submit-final-order',
      'confirm-pending-order'
    ]);
    committedCheckpointDroppedAtMs = new Map();
    committedCheckpointRecoveryPolledAtMs = new Map();
    await popup.close();
    const externalWakePage = await context.newPage();
    await externalWakePage.goto(`${baseUrl}/external-wake`);
    const cdp = await context.newCDPSession(externalWakePage);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    const externalWakeStartedAtMs = Date.now();
    const externalWakePromise = externalWakePage.evaluate(({ extensionId: targetExtensionId, sessionId }) => new Promise((resolve) => {
      const startedAt = performance.now();
      const progress = [];
      const port = chrome.runtime.connect(targetExtensionId, { name: 'magic-city-active-run-v1' });
      port.onMessage.addListener((payload) => {
        if (payload?.type === 'RUNNER_PROGRESS') {
          progress.push(payload);
          return;
        }
        if (payload?.type === 'RUNNER_RESULT') {
          resolve({ response: { ok: payload.ok, result: payload.result, error: payload.error }, progress, elapsedMs: performance.now() - startedAt });
        }
      });
      port.onDisconnect.addListener(() => {
        if (chrome.runtime.lastError) resolve({ response: null, error: chrome.runtime.lastError.message, progress, elapsedMs: performance.now() - startedAt });
      });
      port.postMessage({
        type: 'RUN_PENDING_SESSIONS',
        sessionId,
        extensionDispatchNonce: 'browser-smoke-full-dispatch',
        clientRunStartedAt: new Date().toISOString()
      });
    }), { extensionId, sessionId: session.id });
    const initialWakeState = await Promise.race([
      externalWakePromise,
      new Promise((resolve) => setTimeout(() => resolve({ pending: true }), 2_000))
    ]);
    // The extension must keep the MV3 external event alive until it has
    // claimed the exact mission. An early accepted response followed by a
    // detached promise is the production regression this test protects.
    if (!initialWakeState?.pending) {
      fail(`browser_extension_external_wake_replied_before_claim:${JSON.stringify(initialWakeState)}`);
    }
    await waitFor(() => claimedSessionIds.length > 0, 5_000);
    if (claimedSessionIds[0] !== session.id) {
      fail(`browser_extension_claimed_wrong_queued_session:${JSON.stringify(claimedSessionIds)}`);
    }
    await waitFor(() => checkpoints.some((checkpoint) => checkpoint.planActionId === 'open-site'
      && checkpoint.planActionStatus === 'waiting'
      && checkpoint.label === 'Opening browser'), 5_000);
    const startupCheckpointIndex = checkpoints.findIndex((checkpoint) => checkpoint.planActionId === 'open-site'
      && checkpoint.planActionStatus === 'waiting'
      && checkpoint.label === 'Opening browser');
    const completedOpenSiteIndex = checkpoints.findIndex((checkpoint) => checkpoint.planActionId === 'open-site'
      && checkpoint.planActionStatus === 'completed');
    if (startupCheckpointIndex < 0 || (completedOpenSiteIndex >= 0 && completedOpenSiteIndex < startupCheckpointIndex)) {
      fail(`browser_extension_claim_startup_checkpoint_missing_or_advanced:${JSON.stringify(checkpoints)}`);
    }
    try {
      await waitFor(() => Boolean(fulfillment), 90_000);
    } catch (error) {
      const diagnosticPage = await context.newPage();
      await diagnosticPage.goto(`chrome-extension://${extensionId}/popup.html`);
      const runnerState = await diagnosticPage.evaluate(() => new Promise((resolve) => {
        chrome.storage.local.get([
          'lastError',
          'lastExecution',
          'activeSessionId',
          'explicitWakeSessionId',
          'activeRun'
        ], resolve);
      }));
      await diagnosticPage.close();
      fail(`browser_extension_smoke_timeout:${JSON.stringify({
        steps: checkpoints.map((checkpoint) => ({
          id: checkpoint.planActionId,
          status: checkpoint.planActionStatus,
          milestones: checkpoint.verifiedMilestones
        })),
          runnerState,
          openPages: context.pages().map((page) => page.url()),
          session: {
          status: session?.status,
          planState: session?.extensionMissionPlanState,
          fulfillment: session?.fulfillment,
          runnerStatus: session?.runnerStatus
        }
      })}`);
    }
    const externalWake = await externalWakePromise;
    if (externalWake.error || !externalWake.response?.ok || !externalWake.response?.result?.requestedSessionFound) {
      fail(`browser_extension_external_wake_failed:${JSON.stringify(externalWake)}`);
    }
    if (externalWake.response.result.requestedSessionId !== session.id) {
      fail(`browser_extension_external_wake_wrong_session:${JSON.stringify(externalWake)}`);
    }
    const connectedWorkerIds = [...new Set((externalWake.progress || [])
      .map((entry) => String(entry?.activeRun?.workerId || ''))
      .filter(Boolean))];
    const pendingContinuationCheckpoint = checkpoints.find((checkpoint) => checkpoint.planActionId === 'confirm-pending-order'
      && checkpoint.planActionStatus === 'completed');
    const checkpointAfterPrepareCart = checkpoints.find((checkpoint) => (
      Number(checkpoint.testReceivedAtMs || 0) > prepareCartCheckpointCommittedAtMs
      && !/^prepare-cart(?:-\d+)?$/.test(String(checkpoint.planActionId || ''))
    ));
    const inlineCartRecoveryMs = Number(checkpointAfterPrepareCart?.testReceivedAtMs || 0) - prepareCartCheckpointCommittedAtMs;
    const prepareCartCheckpointCount = checkpoints.filter((checkpoint) => /^prepare-cart(?:-\d+)?$/.test(String(checkpoint.planActionId || ''))).length;
    const sawReconnectingRunner = (externalWake.progress || []).some((entry) => (
      entry?.activeRun?.progressState === 'reconnecting_control_plane'
      && entry?.activeRun?.progressLabel === 'Reconnecting Runner'
    ));
    const continuationDispatchMs = Number(pendingContinuationCheckpoint?.testReceivedAtMs || 0) - externalWakeStartedAtMs;
    if (externalWake.elapsedMs < 60_000
      || externalWake.elapsedMs >= 90_000
      || externalWake.progress?.length < 4
      || connectedWorkerIds.length !== 1
      || continuationDispatchMs <= 0
      || continuationDispatchMs >= 30_000
      || prepareCartCheckpointCommittedAtMs <= 0
      || inlineCartRecoveryMs <= 0
      || inlineCartRecoveryMs >= 8_000
      || prepareCartCheckpointCount !== 1
      || !sawReconnectingRunner) {
      fail(`browser_extension_active_run_port_lifecycle_failed:${JSON.stringify({
        elapsedMs: externalWake.elapsedMs,
        progressCount: externalWake.progress?.length || 0,
        connectedWorkerIds,
        continuationDispatchMs,
        prepareCartCheckpointCommittedAtMs,
        inlineCartRecoveryMs,
        prepareCartCheckpointCount,
        sawReconnectingRunner,
        fulfillmentStatus: fulfillment?.status || null,
        stopState: fulfillment?.result?.browserExecution?.stopState || null,
        stopEvidence: fulfillment?.result?.browserExecution?.stopEvidence || null,
        recentCheckpoints: checkpoints.slice(-4).map((checkpoint) => ({
          actionId: checkpoint.planActionId,
          status: checkpoint.planActionStatus,
          reason: checkpoint.browser?.runnerStep?.reason || null
        }))
      })}`);
    }
    const expandedRecoveryActions = [
      'open-site',
      'inspect-cart',
      'reconcile-payment-profile',
      'inspect-review',
      'submit-final-order',
      'confirm-pending-order'
    ];
    const expandedRecoveryTimings = Object.fromEntries(expandedRecoveryActions.map((actionId) => {
      const droppedAtMs = Number(committedCheckpointDroppedAtMs.get(actionId) || 0);
      const recoveryPolledAtMs = Number(committedCheckpointRecoveryPolledAtMs.get(actionId) || 0);
      return [actionId, {
        recoveryMs: recoveryPolledAtMs - droppedAtMs,
        checkpointCount: checkpoints.filter((checkpoint) => (
          checkpoint.planActionId === actionId && checkpoint.planActionStatus !== 'waiting'
        )).length
      }];
    }));
    if (expandedRecoveryActions.some((actionId) => (
      Number(expandedRecoveryTimings[actionId].recoveryMs) <= 0
      || Number(expandedRecoveryTimings[actionId].recoveryMs) >= 8_000
      || expandedRecoveryTimings[actionId].checkpointCount !== 1
    ))) {
      fail(`browser_extension_expanded_checkpoint_recovery_failed:${JSON.stringify(expandedRecoveryTimings)}`);
    }
    recordPurchaseScenario('Cold external website wake stays alive through exact mission claim', {
      sessionId: session.id,
      queuedSessions: 2,
      completionMs: Math.round(externalWake.elapsedMs),
      continuationDispatchMs,
      progressPulses: externalWake.progress.length,
      workerCount: connectedWorkerIds.length,
      startupCheckpoint: 'open-site waiting'
    });
    recordPurchaseScenario('Lost committed cart checkpoint resumes inline without replay', {
      recoveryMs: inlineCartRecoveryMs,
      prepareCartCheckpointCount,
      progressLabel: 'Reconnecting Runner'
    });
    recordPurchaseScenario('Lost committed non-cart checkpoints resume inline without replay', expandedRecoveryTimings);
    const primaryStorePage = context.pages().find((page) => page.url().startsWith(baseUrl) && page.url().includes('/checkout'));
    const finalClickEvidence = primaryStorePage
      ? await primaryStorePage.evaluate(() => ({
          firstSubmitClicks: Number(sessionStorage.getItem('magic-city-native-final-click') || 0),
          pendingFinalClicks: Number(sessionStorage.getItem('magic-city-pending-final-clicks') || 0)
        }))
      : { firstSubmitClicks: 0, pendingFinalClicks: 0 };
    const { firstSubmitClicks, pendingFinalClicks } = finalClickEvidence;
    const pendingDiagnosticPage = await context.newPage();
    await pendingDiagnosticPage.goto(`chrome-extension://${extensionId}/popup.html`);
    const pendingRunnerState = await pendingDiagnosticPage.evaluate(() => new Promise((resolve) => {
      chrome.storage.local.get(['activeRun'], resolve);
    }));
    if (firstSubmitClicks !== 1
      || pendingFinalClicks !== 1
      || !checkpoints.some((checkpoint) => checkpoint.planActionId === 'confirm-pending-order'
        && checkpoint.planActionStatus === 'completed')) {
      fail(`browser_extension_pending_order_continuation_not_exactly_once:${JSON.stringify({ firstSubmitClicks, pendingFinalClicks, activeRun: pendingRunnerState.activeRun, steps: checkpoints.map((checkpoint) => ({ id: checkpoint.planActionId, status: checkpoint.planActionStatus, url: checkpoint.browser?.url, reason: checkpoint.browser?.runnerStep?.reason, evidence: checkpoint.browser?.runnerStep?.pendingOrderMatchEvidence, cartItems: checkpoint.browser?.checkoutSummary?.cartItems })) })}`);
    }
    const durableDispatches = await pendingDiagnosticPage.evaluate(() => new Promise((resolve) => {
      chrome.storage.local.get(['finalOrderDispatches'], resolve);
    }));
    const durableTabReceipts = Object.values(durableDispatches.finalOrderDispatches || {}).flatMap((value) => Array.isArray(value) ? value : [value]);
    const durableScopes = durableTabReceipts.map((receipt) => receipt?.receiptScope).filter(Boolean);
    if (!durableScopes.includes(`${plan.planHash}:submit-final-order`)
      || !durableScopes.includes(`${plan.planHash}:confirm-pending-order`)) {
      fail(`browser_extension_pending_order_dispatch_receipts_not_both_durable:${JSON.stringify(durableDispatches)}`);
    }
    recordPurchaseScenario('Lost first-submit response advances to pending-order continuation without replay', {
      firstSubmitClicks,
      pendingFinalClicks
    });

    const replayPage = await context.newPage();
    await replayPage.goto(`${baseUrl}/checkout/pending-order?stay=1`);
    const replayTab = await pendingDiagnosticPage.evaluate((url) => chrome.tabs.query({}).then((tabs) => tabs.find((tab) => tab.url === url) || null), replayPage.url());
    const replayAction = {
      id: 'confirm-pending-order',
      type: 'final_submit',
      missionAction: 'final_submit',
      autoSubmitAfterVerifiedCheckout: true,
      pendingOrderContinuation: true,
      priorFinalSubmitDispatched: true,
      receiptScope: 'pending-replay-plan:confirm-pending-order',
      sessionId: 'pending-replay-session',
      planHash: 'pending-replay-plan',
      expectedItemCount: 1,
      boundCandidate: { asin: 'B000SMOKE1', title: 'Test Gadget', price: 3.5 },
      boundCartEvidence: {
        sessionId: 'pending-replay-session',
        planHash: 'pending-replay-plan',
        asin: 'B000SMOKE1',
        title: 'Test Gadget',
        price: 3.5,
        quantity: 1
      }
    };
    const invokePendingAction = async (tabId, action) => pendingDiagnosticPage.evaluate(async ({ targetTabId, pendingAction }) => {
      await chrome.scripting.executeScript({ target: { tabId: targetTabId }, files: ['executor.js'] });
      return chrome.tabs.sendMessage(targetTabId, { type: 'MAGIC_CITY_EXECUTE_PLAN_STEP', action: pendingAction, checkoutProfile: {} });
    }, { targetTabId: tabId, pendingAction: action });
    const firstPendingDispatch = await invokePendingAction(replayTab.id, replayAction);
    await replayPage.waitForTimeout(300);
    // Simulate content-script reinjection after page-local receipts were lost.
    // The background's durable action-scoped receipt must still veto replay.
    await replayPage.evaluate(() => sessionStorage.removeItem('magic_city_browser_action_receipts_v1'));
    const repeatedPendingDispatch = await invokePendingAction(replayTab.id, {
      ...replayAction,
      priorPendingOrderDispatchReceipt: firstPendingDispatch?.finalSubmitReceipt || null
    });
    const replayClickCount = await replayPage.evaluate(() => Number(sessionStorage.getItem('magic-city-pending-final-clicks') || 0));
    if (!firstPendingDispatch?.completed
      || repeatedPendingDispatch?.skipped !== true
      || repeatedPendingDispatch?.finalSubmitReceipt?.phase !== 'click_dispatched'
      || replayClickCount !== 1) {
      fail(`browser_extension_pending_order_replay_guard_failed:${JSON.stringify({ firstPendingDispatch, repeatedPendingDispatch, replayClickCount })}`);
    }
    recordPurchaseScenario('Pending-order continuation reuses action-scoped no-replay receipts', { replayClickCount });
    await replayPage.close();

    const accessibilityCartPage = await context.newPage();
    await accessibilityCartPage.goto(`${baseUrl}/cart-accessibility-title`);
    const accessibilityCartTab = await pendingDiagnosticPage.evaluate((url) => chrome.tabs.query({}).then((tabs) => tabs.find((tab) => tab.url === url) || null), accessibilityCartPage.url());
    const accessibilityCartState = await pendingDiagnosticPage.evaluate(async (tabId) => {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['executor.js'] });
      return chrome.tabs.sendMessage(tabId, { type: 'MAGIC_CITY_BROWSER_STATE', checkoutProfile: {} });
    }, accessibilityCartTab.id);
    const accessibilityCartItem = accessibilityCartState?.checkoutSummary?.cartItems?.[0] || null;
    const cleanAlmondTitle = 'Nature Valley Sweet & Salty Almond Granola Bars, 6 ct, 7.2 oz';
    if (accessibilityCartItem?.asin !== 'NATURE-VALLEY-ALMOND'
      || accessibilityCartItem?.title !== cleanAlmondTitle
      || Number(accessibilityCartItem?.price) !== 2.97
      || Number(accessibilityCartItem?.quantity) !== 1) {
      fail(`browser_extension_cart_accessibility_title_not_clean:${JSON.stringify(accessibilityCartState)}`);
    }
    await accessibilityCartPage.close();

    const accessibilityPendingPage = await context.newPage();
    await accessibilityPendingPage.goto(`${baseUrl}/checkout/duplicateOrder?stay=1&live=1&variant=almond&unitPrice=2.97`);
    const accessibilityPendingTab = await pendingDiagnosticPage.evaluate((url) => chrome.tabs.query({}).then((tabs) => tabs.find((tab) => tab.url === url) || null), accessibilityPendingPage.url());
    const accessibilityPendingOutcome = await invokePendingAction(accessibilityPendingTab.id, {
      ...replayAction,
      receiptScope: 'pending-accessibility-title-plan:confirm-pending-order',
      sessionId: 'pending-accessibility-title-session',
      planHash: 'pending-accessibility-title-plan',
      boundCandidate: { asin: 'NATURE-VALLEY-ALMOND', title: cleanAlmondTitle, price: 2.97 },
      boundCartEvidence: {
        ...accessibilityCartItem,
        sessionId: 'pending-accessibility-title-session',
        planHash: 'pending-accessibility-title-plan'
      }
    });
    await accessibilityPendingPage.waitForTimeout(300);
    const accessibilityPendingClickCount = await accessibilityPendingPage.evaluate(() => Number(sessionStorage.getItem('magic-city-pending-final-clicks') || 0));
    if (!accessibilityPendingOutcome?.completed
      || accessibilityPendingOutcome?.pendingOrderMatchEvidence?.identityMatches !== true
      || accessibilityPendingOutcome?.pendingOrderMatchEvidence?.identitySource !== 'exact_title'
      || accessibilityPendingOutcome?.pendingOrderMatchEvidence?.priceMatches !== true
      || accessibilityPendingOutcome?.pendingOrderMatchEvidence?.quantityMatches !== true
      || accessibilityPendingClickCount !== 1) {
      fail(`browser_extension_accessibility_title_pending_order_not_confirmed:${JSON.stringify({ accessibilityPendingOutcome, accessibilityPendingClickCount })}`);
    }
    recordPurchaseScenario('ASIN-bound cart title excludes the accessibility suffix before strict pending-order matching', {
      title: accessibilityCartItem.title,
      identitySource: accessibilityPendingOutcome.pendingOrderMatchEvidence.identitySource,
      clickCount: accessibilityPendingClickCount
    });
    await accessibilityPendingPage.close();

    const duplicatedTitleCartPage = await context.newPage();
    await duplicatedTitleCartPage.goto(`${baseUrl}/cart-duplicated-title`);
    const duplicatedTitleCartTab = await pendingDiagnosticPage.evaluate((url) => chrome.tabs.query({}).then((tabs) => tabs.find((tab) => tab.url === url) || null), duplicatedTitleCartPage.url());
    const duplicatedTitleCartState = await pendingDiagnosticPage.evaluate(async (tabId) => {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['executor.js'] });
      return chrome.tabs.sendMessage(tabId, { type: 'MAGIC_CITY_BROWSER_STATE', checkoutProfile: {} });
    }, duplicatedTitleCartTab.id);
    const duplicatedTitleCartItem = duplicatedTitleCartState?.checkoutSummary?.cartItems?.[0] || null;
    const cleanSingleBarTitle = 'Nature Valley Granola Bar, Oats and Honey, 1.5 oz';
    if (duplicatedTitleCartItem?.asin !== 'NATURE-VALLEY-OATS-HONEY'
      || duplicatedTitleCartItem?.title !== cleanSingleBarTitle
      || Number(duplicatedTitleCartItem?.price) !== 2.97
      || Number(duplicatedTitleCartItem?.quantity) !== 1) {
      fail(`browser_extension_cart_duplicated_title_not_clean:${JSON.stringify(duplicatedTitleCartState)}`);
    }
    await duplicatedTitleCartPage.close();

    const duplicatedTitlePendingPage = await context.newPage();
    await duplicatedTitlePendingPage.goto(`${baseUrl}/checkout/duplicateOrder?stay=1&live=1&variant=single-oats&unitPrice=2.97`);
    const duplicatedTitlePendingTab = await pendingDiagnosticPage.evaluate((url) => chrome.tabs.query({}).then((tabs) => tabs.find((tab) => tab.url === url) || null), duplicatedTitlePendingPage.url());
    const duplicatedTitlePendingOutcome = await invokePendingAction(duplicatedTitlePendingTab.id, {
      ...replayAction,
      receiptScope: 'pending-duplicated-title-plan:confirm-pending-order',
      sessionId: 'pending-duplicated-title-session',
      planHash: 'pending-duplicated-title-plan',
      boundCandidate: { asin: 'NATURE-VALLEY-OATS-HONEY', title: cleanSingleBarTitle, price: 2.97 },
      boundCartEvidence: {
        ...duplicatedTitleCartItem,
        sessionId: 'pending-duplicated-title-session',
        planHash: 'pending-duplicated-title-plan'
      }
    });
    await duplicatedTitlePendingPage.waitForTimeout(300);
    const duplicatedTitlePendingClickCount = await duplicatedTitlePendingPage.evaluate(() => Number(sessionStorage.getItem('magic-city-pending-final-clicks') || 0));
    if (!duplicatedTitlePendingOutcome?.completed
      || duplicatedTitlePendingOutcome?.pendingOrderMatchEvidence?.identityMatches !== true
      || duplicatedTitlePendingOutcome?.pendingOrderMatchEvidence?.identitySource !== 'exact_title'
      || duplicatedTitlePendingOutcome?.pendingOrderMatchEvidence?.priceMatches !== true
      || duplicatedTitlePendingOutcome?.pendingOrderMatchEvidence?.quantityMatches !== true
      || duplicatedTitlePendingClickCount !== 1) {
      fail(`browser_extension_duplicated_title_pending_order_not_confirmed:${JSON.stringify({ duplicatedTitlePendingOutcome, duplicatedTitlePendingClickCount })}`);
    }
    recordPurchaseScenario('Duplicated cart title is canonicalized before strict pending-order matching', {
      title: duplicatedTitleCartItem.title,
      identitySource: duplicatedTitlePendingOutcome.pendingOrderMatchEvidence.identitySource,
      clickCount: duplicatedTitlePendingClickCount
    });
    await duplicatedTitlePendingPage.close();

    const livePendingPage = await context.newPage();
    await livePendingPage.goto(`${baseUrl}/checkout/duplicateOrder?stay=1&live=1&unitPrice=2.97`);
    const livePendingTab = await pendingDiagnosticPage.evaluate((url) => chrome.tabs.query({}).then((tabs) => tabs.find((tab) => tab.url === url) || null), livePendingPage.url());
    const livePendingOutcome = await invokePendingAction(livePendingTab.id, {
      ...replayAction,
      receiptScope: 'pending-live-sparse-plan:confirm-pending-order',
      sessionId: 'pending-live-sparse-session',
      planHash: 'pending-live-sparse-plan',
      boundCandidate: { asin: 'B000NVGOOD', title: 'Nature Valley', price: 2.97 },
      boundCartEvidence: {
        sessionId: 'pending-live-sparse-session',
        planHash: 'pending-live-sparse-plan',
        asin: 'B000NVGOOD',
        title: 'Nature Valley Crunchy Granola Bars, Oats & Honey, 12 ct, 8.94 oz',
        price: 2.97,
        quantity: 1
      }
    });
    await livePendingPage.waitForTimeout(300);
    const livePendingClickCount = await livePendingPage.evaluate(() => Number(sessionStorage.getItem('magic-city-pending-final-clicks') || 0));
    if (!livePendingOutcome?.completed
      || livePendingOutcome?.pendingOrderMatchEvidence?.identityMatches !== true
      || livePendingOutcome?.pendingOrderMatchEvidence?.identitySource !== 'exact_title'
      || livePendingOutcome?.pendingOrderMatchEvidence?.priceMatches !== true
      || livePendingOutcome?.pendingOrderMatchEvidence?.priceSource !== 'identity_row'
      || livePendingOutcome?.pendingOrderMatchEvidence?.quantityMatches !== true
      || livePendingClickCount !== 1) {
      fail(`browser_extension_live_sparse_pending_order_not_confirmed:${JSON.stringify({ livePendingOutcome, livePendingClickCount })}`);
    }
    recordPurchaseScenario('Live-shaped duplicateOrder page uses verified cart identity exactly once', {
      identitySource: livePendingOutcome.pendingOrderMatchEvidence.identitySource,
      priceSource: livePendingOutcome.pendingOrderMatchEvidence.priceSource,
      clickCount: livePendingClickCount
    });
    await livePendingPage.close();

    const pendingUnitPricePage = await context.newPage();
    await pendingUnitPricePage.goto(`${baseUrl}/checkout/duplicateOrder?stay=1&live=1&unitPrice=3.97&comparisonUnitPrice=2.97&comparisonUnit=100%20g`);
    const pendingUnitPriceTab = await pendingDiagnosticPage.evaluate((url) => chrome.tabs.query({}).then((tabs) => tabs.find((tab) => tab.url === url) || null), pendingUnitPricePage.url());
    const pendingUnitPriceOutcome = await invokePendingAction(pendingUnitPriceTab.id, {
      ...replayAction,
      receiptScope: 'pending-unit-price-plan:confirm-pending-order',
      sessionId: 'pending-unit-price-session',
      planHash: 'pending-unit-price-plan',
      boundCartEvidence: {
        sessionId: 'pending-unit-price-session',
        planHash: 'pending-unit-price-plan',
        asin: 'B000NVGOOD',
        title: 'Nature Valley Crunchy Granola Bars, Oats & Honey, 12 ct, 8.94 oz',
        price: 2.97,
        quantity: 1
      }
    });
    const pendingUnitPriceClickCount = await pendingUnitPricePage.evaluate(() => Number(sessionStorage.getItem('magic-city-pending-final-clicks') || 0));
    if (pendingUnitPriceOutcome?.completed !== false
      || pendingUnitPriceOutcome?.pendingOrderMatchEvidence?.identityMatches !== true
      || pendingUnitPriceOutcome?.pendingOrderMatchEvidence?.priceMatches !== false
      || pendingUnitPriceOutcome?.pendingOrderMatchEvidence?.merchandisePriceContradiction !== true
      || pendingUnitPriceClickCount !== 0) {
      fail(`browser_extension_pending_order_unit_price_false_match_not_rejected:${JSON.stringify({ pendingUnitPriceOutcome, pendingUnitPriceClickCount })}`);
    }
    recordPurchaseScenario('Pending-order continuation rejects a matching unit price beside a contradictory merchandise price', {
      expectedPrice: '$2.97',
      merchandisePrice: '$3.97',
      comparisonUnitPrice: '$2.97 / 100 g',
      clickCount: pendingUnitPriceClickCount
    });
    await pendingUnitPricePage.close();

    const pendingSiblingPricePage = await context.newPage();
    await pendingSiblingPricePage.goto(`${baseUrl}/checkout/duplicateOrder?stay=1&live=1&siblingPriceOnly=1&unitPrice=2.97`);
    const pendingSiblingPriceTab = await pendingDiagnosticPage.evaluate((url) => chrome.tabs.query({}).then((tabs) => tabs.find((tab) => tab.url === url) || null), pendingSiblingPricePage.url());
    const pendingSiblingPriceOutcome = await invokePendingAction(pendingSiblingPriceTab.id, {
      ...replayAction,
      receiptScope: 'pending-sibling-price-plan:confirm-pending-order',
      sessionId: 'pending-sibling-price-session',
      planHash: 'pending-sibling-price-plan',
      boundCartEvidence: {
        sessionId: 'pending-sibling-price-session',
        planHash: 'pending-sibling-price-plan',
        asin: 'B000NVGOOD',
        title: 'Nature Valley Crunchy Granola Bars, Oats & Honey, 12 ct, 8.94 oz',
        price: 2.97,
        quantity: 1
      }
    });
    const pendingSiblingPriceClickCount = await pendingSiblingPricePage.evaluate(() => Number(sessionStorage.getItem('magic-city-pending-final-clicks') || 0));
    if (pendingSiblingPriceOutcome?.completed !== false
      || pendingSiblingPriceOutcome?.pendingOrderMatchEvidence?.identityMatches !== true
      || pendingSiblingPriceOutcome?.pendingOrderMatchEvidence?.priceMatches !== false
      || pendingSiblingPriceClickCount !== 0) {
      fail(`browser_extension_pending_order_sibling_price_false_match_not_rejected:${JSON.stringify({ pendingSiblingPriceOutcome, pendingSiblingPriceClickCount })}`);
    }
    recordPurchaseScenario('Pending-order continuation does not borrow a sibling product price', {
      matchingProductPrice: 'missing',
      siblingPrice: '$2.97',
      clickCount: pendingSiblingPriceClickCount
    });
    await pendingSiblingPricePage.close();

    const pendingMismatchPage = await context.newPage();
    await pendingMismatchPage.goto(`${baseUrl}/checkout/duplicateOrder?stay=1&live=1&variant=cashew&unitPrice=3.50`);
    const mismatchTab = await pendingDiagnosticPage.evaluate((url) => chrome.tabs.query({}).then((tabs) => tabs.find((tab) => tab.url === url) || null), pendingMismatchPage.url());
    const mismatchOutcome = await invokePendingAction(mismatchTab.id, {
      ...replayAction,
      receiptScope: 'pending-mismatch-plan:confirm-pending-order',
      sessionId: 'pending-mismatch-session',
      planHash: 'pending-mismatch-plan',
      boundCandidate: { asin: 'NATURE-VALLEY-ALMOND', title: 'Nature Valley Almond Granola Bars', price: 3.5 },
      boundCartEvidence: {
        sessionId: 'pending-mismatch-session',
        planHash: 'pending-mismatch-plan',
        asin: 'NATURE-VALLEY-ALMOND',
        title: 'Nature Valley Almond Granola Bars',
        price: 3.5,
        quantity: 1
      }
    });
    const mismatchClickCount = await pendingMismatchPage.evaluate(() => Number(sessionStorage.getItem('magic-city-pending-final-clicks') || 0));
    if (mismatchOutcome?.completed !== false
      || mismatchOutcome?.pendingOrderMatchEvidence?.identityMatches !== false
      || mismatchClickCount !== 0) {
      fail(`browser_extension_pending_order_variant_mismatch_not_rejected:${JSON.stringify({ mismatchOutcome, mismatchClickCount })}`);
    }
    recordPurchaseScenario('Pending-order continuation rejects a same-price product variant mismatch', { mismatchClickCount });
    await pendingMismatchPage.close();

    const pendingPackMismatchPage = await context.newPage();
    await pendingPackMismatchPage.goto(`${baseUrl}/checkout/duplicateOrder?stay=1&live=1&variant=almond-pack-mismatch&unitPrice=2.97`);
    const packMismatchTab = await pendingDiagnosticPage.evaluate((url) => chrome.tabs.query({}).then((tabs) => tabs.find((tab) => tab.url === url) || null), pendingPackMismatchPage.url());
    const packMismatchOutcome = await invokePendingAction(packMismatchTab.id, {
      ...replayAction,
      receiptScope: 'pending-pack-mismatch-plan:confirm-pending-order',
      sessionId: 'pending-pack-mismatch-session',
      planHash: 'pending-pack-mismatch-plan',
      boundCandidate: { asin: 'NATURE-VALLEY-ALMOND', title: 'Nature Valley Sweet & Salty Almond Granola Bars, 6 ct, 7.2 oz', price: 2.97 },
      boundCartEvidence: {
        sessionId: 'pending-pack-mismatch-session',
        planHash: 'pending-pack-mismatch-plan',
        asin: 'NATURE-VALLEY-ALMOND',
        title: 'Nature Valley Sweet & Salty Almond Granola Bars, 6 ct, 7.2 oz',
        price: 2.97,
        quantity: 1
      }
    });
    const packMismatchClickCount = await pendingPackMismatchPage.evaluate(() => Number(sessionStorage.getItem('magic-city-pending-final-clicks') || 0));
    if (packMismatchOutcome?.completed !== false
      || packMismatchOutcome?.pendingOrderMatchEvidence?.identityMatches !== false
      || packMismatchClickCount !== 0) {
      fail(`browser_extension_pending_order_pack_mismatch_not_rejected:${JSON.stringify({ packMismatchOutcome, packMismatchClickCount })}`);
    }
    recordPurchaseScenario('Pending-order continuation rejects a same-price pack-size mismatch', { packMismatchClickCount });
    await pendingPackMismatchPage.close();

    const pendingQuantityMismatchPage = await context.newPage();
    await pendingQuantityMismatchPage.goto(`${baseUrl}/checkout/pending-order?stay=1&quantity=2&unitPrice=2.97&orderTotal=5.94`);
    const quantityMismatchTab = await pendingDiagnosticPage.evaluate((url) => chrome.tabs.query({}).then((tabs) => tabs.find((tab) => tab.url === url) || null), pendingQuantityMismatchPage.url());
    const quantityMismatchOutcome = await invokePendingAction(quantityMismatchTab.id, {
      ...replayAction,
      receiptScope: 'pending-quantity-mismatch-plan:confirm-pending-order',
      sessionId: 'pending-quantity-mismatch-session',
      planHash: 'pending-quantity-mismatch-plan',
      boundCandidate: { asin: 'B000SMOKE1', title: 'Test Gadget', price: 2.97 },
      boundCartEvidence: {
        sessionId: 'pending-quantity-mismatch-session',
        planHash: 'pending-quantity-mismatch-plan',
        asin: 'B000SMOKE1',
        title: 'Test Gadget',
        price: 2.97,
        quantity: 1
      }
    });
    const quantityMismatchClickCount = await pendingQuantityMismatchPage.evaluate(() => Number(sessionStorage.getItem('magic-city-pending-final-clicks') || 0));
    if (quantityMismatchOutcome?.completed !== false
      || quantityMismatchOutcome?.pendingOrderMatchEvidence?.identityMatches !== true
      || quantityMismatchOutcome?.pendingOrderMatchEvidence?.priceMatches !== true
      || quantityMismatchOutcome?.pendingOrderMatchEvidence?.quantityMatches !== false
      || quantityMismatchOutcome?.pendingOrderMatchEvidence?.quantityContradiction !== true
      || quantityMismatchOutcome?.pendingOrderMatchEvidence?.explicitQuantity !== 2
      || quantityMismatchClickCount !== 0) {
      fail(`browser_extension_pending_order_quantity_contradiction_not_rejected:${JSON.stringify({ quantityMismatchOutcome, quantityMismatchClickCount })}`);
    }
    recordPurchaseScenario('Pending-order continuation rejects current quantity 2 over saved quantity 1', {
      explicitQuantity: 2,
      orderTotal: '$5.94',
      clickCount: quantityMismatchClickCount
    });
    await pendingQuantityMismatchPage.close();

    const pendingPriceMismatchPage = await context.newPage();
    await pendingPriceMismatchPage.goto(`${baseUrl}/checkout/pending-order?stay=1&unitPrice=4.25&orderTotal=4.25`);
    const priceMismatchTab = await pendingDiagnosticPage.evaluate((url) => chrome.tabs.query({}).then((tabs) => tabs.find((tab) => tab.url === url) || null), pendingPriceMismatchPage.url());
    const priceMismatchOutcome = await invokePendingAction(priceMismatchTab.id, {
      ...replayAction,
      receiptScope: 'pending-price-mismatch-plan:confirm-pending-order',
      sessionId: 'pending-price-mismatch-session',
      planHash: 'pending-price-mismatch-plan',
      boundCartEvidence: {
        sessionId: 'pending-price-mismatch-session',
        planHash: 'pending-price-mismatch-plan',
        asin: 'B000SMOKE1',
        title: 'Test Gadget',
        price: 3.5,
        quantity: 1
      }
    });
    const priceMismatchClickCount = await pendingPriceMismatchPage.evaluate(() => Number(sessionStorage.getItem('magic-city-pending-final-clicks') || 0));
    if (priceMismatchOutcome?.completed !== false
      || priceMismatchOutcome?.pendingOrderMatchEvidence?.identityMatches !== true
      || priceMismatchOutcome?.pendingOrderMatchEvidence?.priceMatches !== false
      || priceMismatchOutcome?.pendingOrderMatchEvidence?.merchandisePriceContradiction !== true
      || priceMismatchClickCount !== 0) {
      fail(`browser_extension_pending_order_price_contradiction_not_rejected:${JSON.stringify({ priceMismatchOutcome, priceMismatchClickCount })}`);
    }
    recordPurchaseScenario('Pending-order continuation rejects an explicit current unit-price contradiction', {
      expectedUnitPrice: '$3.50',
      currentUnitPrice: '$4.25',
      clickCount: priceMismatchClickCount
    });
    await pendingPriceMismatchPage.close();
    await pendingDiagnosticPage.close();
    checkoutFixture = {
      ...checkoutFixture,
      pendingOrderContinuation: false,
      pendingOrderConfirmationDelayMs: 0
    };

    popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    // The service worker was deliberately stopped above. Use a fresh extension
    // page to wake the worker and expose Chrome APIs for the retained-tab test.
    worker = popup;

    // A retained Amazon tab is allowed to already be on the approved target.
    // This guards the production failure where open-site reloaded the same URL
    // and then waited for an event that Chrome had already emitted.
    const retainedTargetPage = await context.newPage();
    await retainedTargetPage.goto(`${baseUrl}/search`);
    const retainedTargetTab = await worker.evaluate((url) => chrome.tabs.query({}).then((tabs) =>
      tabs.find((candidate) => candidate.url === url) || null), retainedTargetPage.url());
    if (!retainedTargetTab?.id) fail(`browser_extension_same_url_tab_missing:${retainedTargetPage.url()}`);
    const sameUrlSessionId = 'browser-smoke-same-url-session';
    const sameUrlPlan = rehashExtensionPlan({
      ...plan,
      planId: 'mplan_browser-smoke-same-url-session',
      startUrl: retainedTargetPage.url(),
      actions: [{
        ...plan.actions[0],
        id: 'open-site',
        url: retainedTargetPage.url(),
        missionAction: 'browser_open'
      }]
    });
    const primaryCheckpoints = checkpoints.slice();
    const primaryFulfillment = fulfillment;
    const primarySession = session;
    const primaryDistractorSession = distractorSession;
    checkpoints.length = 0;
    fulfillment = null;
    session = {
      ...session,
      id: sameUrlSessionId,
      status: 'queued',
      claimedByPluginId: null,
      fulfillment: null,
      missionBoundAuth: {
        ...session.missionBoundAuth,
        subject: { sessionId: sameUrlSessionId }
      },
      extensionMissionPlan: sameUrlPlan,
      extensionMissionPlanState: { planHash: sameUrlPlan.planHash, nextActionIndex: 0, completedActionIds: [] },
      missionBoundaryLatestHash: null,
      missionBoundaryEventCount: 0
    };
    await worker.evaluate(({ sessionId, tabId }) => new Promise((resolve) => {
      chrome.storage.local.get(['activeMissionTabs'], (stored) => {
        chrome.storage.local.set({
          activeMissionTabs: { ...(stored.activeMissionTabs || {}), [sessionId]: tabId }
        }, resolve);
      });
    }), { sessionId: sameUrlSessionId, tabId: retainedTargetTab.id });
    const sameUrlWake = await popup.evaluate((sessionId) => new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'RUN_PENDING_SESSIONS', sessionId }, resolve);
    }), sameUrlSessionId);
    if (!sameUrlWake?.ok) fail(`browser_extension_same_url_wake_failed:${sameUrlWake?.error || 'no_response'}`);
    try {
      await waitFor(() => Boolean(fulfillment), 15_000);
    } catch {
      const diagnosticPage = await context.newPage();
      await diagnosticPage.goto(`chrome-extension://${extensionId}/popup.html`);
      const runnerState = await diagnosticPage.evaluate(() => new Promise((resolve) => {
        chrome.storage.local.get(['lastError', 'lastExecution', 'activeSessionId', 'explicitWakeSessionId'], resolve);
      }));
      await diagnosticPage.close();
      fail(`browser_extension_same_url_timeout:steps=${checkpoints.map((checkpoint) => checkpoint.planActionId).join(',')}:last_error=${runnerState.lastError || 'none'}:last_execution=${runnerState.lastExecution?.status || 'none'}:active=${runnerState.activeSessionId || 'none'}:wake=${runnerState.explicitWakeSessionId || 'none'}`);
    }
    // This fixture intentionally contains only the open-site action. The
    // runner must record that action and then stop at the normal handoff
    // boundary; it should not pretend a one-step plan placed an order.
    if (fulfillment.status !== 'failed'
      || fulfillment.result?.browserExecution?.stopState !== 'handoff_ready'
      || checkpoints[0]?.planActionId !== 'open-site') {
      fail(`browser_extension_same_url_not_idempotent:${JSON.stringify({ fulfillment, checkpoints })}`);
    }
    recordPurchaseScenario('Retained tab on the approved URL completes open-site idempotently', {
      url: retainedTargetPage.url(),
      steps: checkpoints.map((checkpoint) => checkpoint.planActionId),
      stopState: fulfillment.result?.browserExecution?.stopState
    });

    // Simulate an MV3 worker suspension immediately after Amazon accepted an
    // add-to-cart click. The persisted candidate identity must let the resumed
    // worker verify the cart and checkpoint the existing mutation, never click
    // Add to cart a second time.
    const recoveredCartSessionId = 'browser-smoke-cart-recovery-session';
    const recoveredCartPlan = rehashExtensionPlan({
      ...plan,
      planId: 'mplan_browser-smoke-cart-recovery-session',
      startUrl: `${baseUrl}/cart`,
      actions: [
        {
          id: 'prepare-cart',
          type: 'click_intent',
          missionAction: 'prepare_cart',
          intent: 'add_to_cart',
          query: 'test gadget',
          requiredBasketItem: true,
          expectedMilestone: 'cart_confirmed',
          expectedCartItemCount: 1,
          maxPrice: 4
        },
        { id: 'pause-for-user', type: 'pause', missionAction: 'handoff', reason: 'cart_recovered' }
      ]
    });
    checkpoints.length = 0;
    fulfillment = null;
    await retainedTargetPage.goto(`${baseUrl}/cart`);
    const recoveredCartTab = await worker.evaluate((url) => chrome.tabs.query({}).then((tabs) =>
      tabs.find((candidate) => candidate.url === url) || null), retainedTargetPage.url());
    if (!recoveredCartTab?.id) fail('browser_extension_cart_recovery_tab_missing');
    session = {
      ...session,
      id: recoveredCartSessionId,
      status: 'claimed',
      claimedByPluginId: 'magic-city-runner-extension',
      fulfillment: null,
      missionBoundAuth: {
        ...session.missionBoundAuth,
        subject: { sessionId: recoveredCartSessionId }
      },
      extensionMissionPlan: recoveredCartPlan,
      extensionMissionPlanState: { planHash: recoveredCartPlan.planHash, nextActionIndex: 0, completedActionIds: [] },
      missionBoundaryLatestHash: null,
      missionBoundaryEventCount: 0
    };
    await worker.evaluate(({ sessionId, tabId, planHash }) => new Promise((resolve) => {
      chrome.storage.local.get(['activeMissionTabs'], (stored) => {
        chrome.storage.local.set({
          activeMissionTabs: { ...(stored.activeMissionTabs || {}), [sessionId]: tabId },
          activeSessionId: sessionId,
          activeRun: {
            sessionId,
            planHash,
            phase: 'executing_step',
            tabId,
            actionId: 'prepare-cart',
            actionIndex: 0,
            nextActionIndex: 0,
            selectedCandidate: { title: 'Test Gadget', asin: 'B000SMOKE1', price: 3.5 },
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        }, () => {
          chrome.alarms.create('magic-city-runner-resume', { when: Date.now() + 500 });
          resolve();
        });
      });
    }), { sessionId: recoveredCartSessionId, tabId: recoveredCartTab.id, planHash: recoveredCartPlan.planHash });
    const cartRecoveryCdp = await context.newCDPSession(retainedTargetPage);
    await cartRecoveryCdp.send('ServiceWorker.enable');
    await cartRecoveryCdp.send('ServiceWorker.stopAllWorkers');
    try {
      await waitFor(() => Boolean(fulfillment), 20_000);
    } catch {
      fail(`browser_extension_cart_recovery_timeout:${JSON.stringify(await worker.evaluate(() => new Promise((resolve) => chrome.storage.local.get(['lastError', 'lastExecution', 'activeRun'], resolve))))}`);
    }
    const recoveredCartCheckpoint = checkpoints.find((checkpoint) => checkpoint.planActionId === 'prepare-cart'
      && checkpoint.planActionStatus === 'completed');
    if (recoveredCartCheckpoint?.browser?.runnerStep?.recoveredFromInterruption !== true
      || !Array.isArray(recoveredCartCheckpoint?.verifiedMilestones)
      || !recoveredCartCheckpoint.verifiedMilestones.includes('cart_confirmed')) {
      fail(`browser_extension_cart_recovery_not_verified:${JSON.stringify({ fulfillment, checkpoints })}`);
    }
    recordPurchaseScenario('MV3 restart after cart mutation verifies the bound cart item without replay', {
      recovered: recoveredCartCheckpoint.browser.runnerStep.recoveredFromInterruption,
      milestones: recoveredCartCheckpoint.verifiedMilestones
    });

    // The final-order equivalent is just as important: once the merchant has
    // confirmed an order, a resumed worker must preserve that fact rather than
    // retrying a no-longer-visible purchase control.
    const recoveredFinalSessionId = 'browser-smoke-final-recovery-session';
    const recoveredFinalPlan = rehashExtensionPlan({
      ...plan,
      planId: 'mplan_browser-smoke-final-recovery-session',
      startUrl: `${baseUrl}/checkout/order-confirmation`,
      limits: { ...plan.limits, stopBeforeFinalSubmit: false },
      actions: [
        {
          id: 'submit-final-order',
          type: 'final_submit',
          missionAction: 'final_submit',
          autoSubmitAfterVerifiedCheckout: true,
          expectedMilestone: 'final_submit_requested',
          maxPrice: 4
        },
        {
          id: 'confirm-merchant-order',
          type: 'inspect',
          missionAction: 'read_public_page',
          awaitMerchantOrderConfirmation: true,
          merchantConfirmationTimeoutMs: 90_000,
          expectedMilestone: 'order_submitted'
        },
        { id: 'pause-for-user', type: 'pause', missionAction: 'handoff', reason: 'order_confirmed' }
      ]
    });
    checkpoints.length = 0;
    fulfillment = null;
    await retainedTargetPage.goto(`${baseUrl}/checkout/order-confirmation`);
    const recoveredFinalTab = await worker.evaluate((url) => chrome.tabs.query({}).then((tabs) =>
      tabs.find((candidate) => candidate.url === url) || null), retainedTargetPage.url());
    if (!recoveredFinalTab?.id) fail('browser_extension_final_recovery_tab_missing');
    session = {
      ...session,
      id: recoveredFinalSessionId,
      status: 'claimed',
      claimedByPluginId: 'magic-city-runner-extension',
      fulfillment: null,
      missionBoundAuth: {
        ...session.missionBoundAuth,
        subject: { sessionId: recoveredFinalSessionId }
      },
      extensionMissionPlan: recoveredFinalPlan,
      extensionMissionPlanState: { planHash: recoveredFinalPlan.planHash, nextActionIndex: 0, completedActionIds: [] },
      missionBoundaryLatestHash: null,
      missionBoundaryEventCount: 0
    };
    await worker.evaluate(({ sessionId, tabId, planHash }) => new Promise((resolve) => {
      chrome.storage.local.get(['activeMissionTabs'], (stored) => {
        chrome.storage.local.set({
          activeMissionTabs: { ...(stored.activeMissionTabs || {}), [sessionId]: tabId },
          activeSessionId: sessionId,
          activeRun: {
            sessionId,
            planHash,
            phase: 'executing_step',
            tabId,
            actionId: 'submit-final-order',
            actionIndex: 0,
            nextActionIndex: 0,
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          }
        }, () => {
          chrome.alarms.create('magic-city-runner-resume', { when: Date.now() + 500 });
          resolve();
        });
      });
    }), { sessionId: recoveredFinalSessionId, tabId: recoveredFinalTab.id, planHash: recoveredFinalPlan.planHash });
    const finalRecoveryCdp = await context.newCDPSession(retainedTargetPage);
    await finalRecoveryCdp.send('ServiceWorker.enable');
    await finalRecoveryCdp.send('ServiceWorker.stopAllWorkers');
    try {
      await waitFor(() => Boolean(fulfillment), 20_000);
    } catch {
      fail(`browser_extension_final_recovery_timeout:${JSON.stringify(await worker.evaluate(() => new Promise((resolve) => chrome.storage.local.get(['lastError', 'lastExecution', 'activeRun'], resolve))))}`);
    }
    const recoveredFinalCheckpoint = checkpoints.find((checkpoint) => checkpoint.planActionId === 'submit-final-order'
      && checkpoint.planActionStatus === 'completed');
    if (recoveredFinalCheckpoint?.browser?.runnerStep?.recoveredFromInterruption !== true
      || recoveredFinalCheckpoint?.browser?.finalSubmitRequested !== true
      || recoveredFinalCheckpoint?.browser?.orderSubmitted !== true
      || !recoveredFinalCheckpoint?.verifiedMilestones?.includes('final_submit_requested')) {
      fail(`browser_extension_final_recovery_not_verified:${JSON.stringify({ fulfillment, checkpoints })}`);
    }
    recordPurchaseScenario('MV3 restart after merchant order confirmation preserves final-submit proof', {
      recovered: recoveredFinalCheckpoint.browser.runnerStep.recoveredFromInterruption,
      orderSubmitted: recoveredFinalCheckpoint.browser.orderSubmitted
    });

    // An order click is irreversible. If the worker restarts while waiting for
    // confirmation and the signed window is already exhausted, it must release
    // the run without replaying the button and leave the merchant tab intact.
    const unconfirmedFinalSessionId = 'browser-smoke-unconfirmed-final-session';
    const unconfirmedFinalPlan = rehashExtensionPlan({
      ...plan,
      planId: 'mplan_browser-smoke-unconfirmed-final-session',
      startUrl: `${baseUrl}/checkout/final-review`,
      limits: { ...plan.limits, stopBeforeFinalSubmit: false },
      actions: [
        {
          id: 'submit-final-order',
          type: 'final_submit',
          missionAction: 'final_submit',
          autoSubmitAfterVerifiedCheckout: true,
          expectedMilestone: 'final_submit_requested',
          maxPrice: 4
        },
        {
          id: 'confirm-merchant-order',
          type: 'inspect',
          missionAction: 'read_public_page',
          awaitMerchantOrderConfirmation: true,
          merchantConfirmationTimeoutMs: 90_000,
          expectedMilestone: 'order_submitted'
        },
        { id: 'pause-for-user', type: 'pause', missionAction: 'handoff', reason: 'confirmation_timeout_smoke' }
      ]
    });
    checkpoints.length = 0;
    fulfillment = null;
    await retainedTargetPage.goto(`${baseUrl}/checkout/final-review`);
    const unconfirmedFinalTab = await worker.evaluate((url) => chrome.tabs.query({}).then((tabs) =>
      tabs.find((candidate) => candidate.url === url) || null), retainedTargetPage.url());
    if (!unconfirmedFinalTab?.id) fail('browser_extension_unconfirmed_final_tab_missing');
    session = {
      ...session,
      id: unconfirmedFinalSessionId,
      status: 'claimed',
      claimedByPluginId: 'magic-city-runner-extension',
      fulfillment: null,
      missionBoundAuth: {
        ...session.missionBoundAuth,
        subject: { sessionId: unconfirmedFinalSessionId }
      },
      extensionMissionPlan: unconfirmedFinalPlan,
      extensionMissionPlanState: {
        planHash: unconfirmedFinalPlan.planHash,
        nextActionIndex: 1,
        completedActionIds: ['submit-final-order'],
        verifiedMilestones: ['final_submit_requested']
      },
      missionBoundaryLatestHash: null,
      missionBoundaryEventCount: 0
    };
    await worker.evaluate(({ sessionId, tabId, planHash }) => new Promise((resolve) => {
      chrome.storage.local.get(['activeMissionTabs'], (stored) => {
        chrome.storage.local.set({
          activeMissionTabs: { ...(stored.activeMissionTabs || {}), [sessionId]: tabId },
          activeSessionId: sessionId,
          activeRun: {
            sessionId,
            planHash,
            phase: 'awaiting_merchant_confirmation',
            tabId,
            actionId: 'confirm-merchant-order',
            actionIndex: 1,
            nextActionIndex: 1,
            merchantConfirmationStartedAt: new Date(Date.now() - 91_000).toISOString(),
            merchantConfirmationDeadlineAt: new Date(Date.now() - 1_000).toISOString(),
            merchantConfirmationAttempts: 4,
            startedAt: new Date(Date.now() - 91_000).toISOString(),
            updatedAt: new Date().toISOString()
          }
        }, () => {
          chrome.alarms.create('magic-city-runner-resume', { when: Date.now() + 500 });
          resolve();
        });
      });
    }), { sessionId: unconfirmedFinalSessionId, tabId: unconfirmedFinalTab.id, planHash: unconfirmedFinalPlan.planHash });
    const unconfirmedFinalCdp = await context.newCDPSession(retainedTargetPage);
    await unconfirmedFinalCdp.send('ServiceWorker.enable');
    await unconfirmedFinalCdp.send('ServiceWorker.stopAllWorkers');
    try {
      await waitFor(() => Boolean(fulfillment), 20_000);
    } catch {
      fail(`browser_extension_unconfirmed_final_timeout:${JSON.stringify(await worker.evaluate(() => new Promise((resolve) => chrome.storage.local.get(['lastError', 'lastExecution', 'activeRun'], resolve))))}`);
    }
    const unconfirmedFinalStorage = await worker.evaluate(() => new Promise((resolve) => chrome.storage.local.get(['activeRun'], resolve)));
    const unconfirmedOrderSubmitted = await retainedTargetPage.evaluate(() => document.body.dataset.orderSubmitted === '1');
    if (fulfillment.status !== 'failed'
      || fulfillment.fundingDisposition !== 'release'
      || fulfillment.result?.browserExecution?.stopState !== 'final_submit_unconfirmed'
      || !/signed confirmation window/i.test(String(fulfillment.result?.browserExecution?.stopEvidence || ''))
      || unconfirmedOrderSubmitted
      || unconfirmedFinalStorage.activeRun) {
      fail(`browser_extension_unconfirmed_final_not_released:${JSON.stringify({ fulfillment, unconfirmedOrderSubmitted, activeRun: unconfirmedFinalStorage.activeRun })}`);
    }
    if (!retainedTargetPage.url().includes('/checkout/final-review')) {
      fail(`browser_extension_unconfirmed_final_tab_not_preserved:${retainedTargetPage.url()}`);
    }
    recordPurchaseScenario('Expired merchant confirmation releases without replaying the final order control', {
      stopState: fulfillment.result.browserExecution.stopState,
      fundingDisposition: fulfillment.fundingDisposition
    });

    await retainedTargetPage.close();
    await externalWakePage.close();
    checkpoints.splice(0, checkpoints.length, ...primaryCheckpoints);
    fulfillment = primaryFulfillment;
    session = primarySession;
    distractorSession = primaryDistractorSession;

    const completedIds = checkpoints
      .filter((checkpoint) => checkpoint.planActionStatus !== 'waiting')
      .map((checkpoint) => checkpoint.planActionId);
    const completedPlanPrefix = plan.actions
      .slice(0, completedIds.length)
      .map((action) => action.id);
    if (JSON.stringify(completedIds) !== JSON.stringify(completedPlanPrefix)) {
      fail(`browser_extension_skipped_plan_action:${JSON.stringify({ completedIds, completedPlanPrefix })}`);
    }
    if (transientRunnerStatusFailureCount !== 3) {
      fail(`browser_extension_transient_runner_status_not_exercised:${transientRunnerStatusFailureCount}:steps=${checkpoints.map((checkpoint) => checkpoint.planActionId).join(',')}:fulfillment=${JSON.stringify(fulfillment)}`);
    }
    const inspectCartCheckpoint = checkpoints.find((checkpoint) => checkpoint.planActionId === 'inspect-cart');
    if (inspectCartCheckpoint?.browser?.checkoutSummary?.stage !== 'cart') {
      fail(`browser_extension_cart_promo_misclassified:${JSON.stringify({
        stage: inspectCartCheckpoint?.browser?.checkoutSummary?.stage || null,
        optionalOfferVisible: inspectCartCheckpoint?.browser?.optionalOfferVisible || false,
        nextAction: inspectCartCheckpoint?.browser?.checkoutSummary?.nextAction || null,
        availableActions: inspectCartCheckpoint?.browser?.checkoutSummary?.availableActions || []
      })}`);
    }
    const openCheckoutCheckpoint = checkpoints.find((checkpoint) => checkpoint.planActionId === 'open-checkout');
    if (openCheckoutCheckpoint?.browser?.runnerStep?.checkoutPreludeRecovered !== true) {
      fail(`browser_extension_checkout_prelude_not_recovered:${JSON.stringify({
        url: openCheckoutCheckpoint?.browser?.url || null,
        finalUrl: openCheckoutCheckpoint?.browser?.finalUrl || null,
        stage: openCheckoutCheckpoint?.browser?.checkoutSummary?.stage || null,
        runnerStep: openCheckoutCheckpoint?.browser?.runnerStep || null
      })}`);
    }
    const deliveryFilterCheckpoint = checkpoints.find((checkpoint) => checkpoint.planActionId === 'prefer-delivery-filter');
    if (deliveryFilterCheckpoint?.browser?.checkoutSummary?.stage !== 'search_results') {
      fail(`browser_extension_search_header_promo_misclassified:${JSON.stringify({
        stage: deliveryFilterCheckpoint?.browser?.checkoutSummary?.stage || null,
        optionalOfferVisible: deliveryFilterCheckpoint?.browser?.optionalOfferVisible || false,
        candidates: deliveryFilterCheckpoint?.browser?.candidates || []
      })}`);
    }
    if (Number(deliveryFilterCheckpoint?.browser?.observationDurationMs || 0) > 2500) {
      fail(`browser_extension_catalog_observation_too_slow:${deliveryFilterCheckpoint.browser.observationDurationMs}ms`);
    }
    if (deliveryFilterCheckpoint?.planActionStatus !== 'completed'
      || deliveryFilterCheckpoint?.browser?.amazonAccountState !== 'signed_in'
      || deliveryFilterCheckpoint?.browser?.amazonFulfillmentFilterSelected !== 'prime') {
      fail(`browser_extension_did_not_apply_signed_in_prime_filter:${JSON.stringify({
        status: deliveryFilterCheckpoint?.planActionStatus || null,
        account: deliveryFilterCheckpoint?.browser?.amazonAccountState || null,
        available: deliveryFilterCheckpoint?.browser?.amazonFulfillmentFilterAvailable || null,
        selected: deliveryFilterCheckpoint?.browser?.amazonFulfillmentFilterSelected || null
      })}`);
    }
    const selectedMatchCheckpoint = checkpoints.find((checkpoint) => checkpoint.planActionId === 'select-match');
    if (selectedMatchCheckpoint?.planActionStatus !== 'completed') {
      fail(`browser_extension_amazon_result_not_selected:${JSON.stringify({
        status: selectedMatchCheckpoint?.planActionStatus || null,
        detail: selectedMatchCheckpoint?.detail || null,
        candidates: deliveryFilterCheckpoint?.browser?.candidates || []
      })}`);
    }
    if (selectedMatchCheckpoint?.browser?.runnerStep?.directSearchResultCart !== true
      || !['amazon_search_card_exact_first', 'amazon_search_card_fast_path', 'selected_search_result'].includes(selectedMatchCheckpoint?.browser?.runnerStep?.controlStrategy)) {
      fail(`browser_extension_candidate_direct_cart_not_verified:${JSON.stringify({
        url: selectedMatchCheckpoint?.browser?.url || null,
        navigationConfirmed: selectedMatchCheckpoint?.browser?.runnerStep?.navigationConfirmed ?? null,
        directSearchResultCart: selectedMatchCheckpoint?.browser?.runnerStep?.directSearchResultCart ?? null,
        controlStrategy: selectedMatchCheckpoint?.browser?.runnerStep?.controlStrategy || null,
        requestedNavigationUrl: selectedMatchCheckpoint?.browser?.runnerStep?.requestedNavigationUrl || null,
        observedNavigationUrl: selectedMatchCheckpoint?.browser?.runnerStep?.observedNavigationUrl || null
      })}`);
    }
    if (selectedMatchCheckpoint?.browser?.runnerStep?.postAddCartOpened !== true
      || !selectedMatchCheckpoint?.browser?.runnerStep?.cartOpenControlStrategy) {
      fail(`browser_extension_post_add_cart_not_atomic:${JSON.stringify(selectedMatchCheckpoint?.browser?.runnerStep || {})}`);
    }
    if (fulfillment.result?.browserExecution?.checkoutProgress?.addToCartClicked !== true
      || fulfillment.result?.browserExecution?.checkoutProgress?.checkoutOpened !== true
      || fulfillment.result?.browserExecution?.finalApprovalRequired !== false
      || fulfillment.result?.browserExecution?.orderSubmitted !== true) {
      const currentStorePage = context.pages().find((page) => page.url().startsWith(baseUrl));
      const paymentRadios = currentStorePage ? await currentStorePage.evaluate(() => Array.from(document.querySelectorAll('input[type="radio"]')).map((input) => ({
        checked: input.checked,
        hidden: Boolean(input.closest('[hidden]')),
        text: String(input.labels?.[0]?.textContent || input.closest('label')?.textContent || '').trim()
      }))) : [];
      const addressFixtureState = currentStorePage ? await currentStorePage.evaluate(() => ({
        summary: document.querySelector('#delivery-summary')?.textContent || '',
        optionsHidden: document.querySelector('#address-options')?.hidden,
        newFormHidden: document.querySelector('#new-address-form')?.hidden,
        shippingValues: Array.from(document.querySelectorAll('#new-address-form input, #new-address-form select')).map((field) => ({ label: field.getAttribute('aria-label'), value: field.value })),
        events: window.__checkoutEvents || []
      })) : null;
      fail(`browser_extension_auto_submit_not_verified:steps=${JSON.stringify(checkpoints.map((checkpoint) => ({
        id: checkpoint.planActionId,
        status: checkpoint.planActionStatus,
        detail: checkpoint.detail,
        action: checkpoint.browser?.lastRunnerAction,
        selections: checkpoint.browser?.checkoutSelections,
        profileTransitions: checkpoint.browser?.runnerStep?.profileTransitions || []
      })))}:payment_radios=${JSON.stringify(paymentRadios)}:address=${JSON.stringify(addressFixtureState)}:execution=${JSON.stringify(fulfillment.result?.browserExecution || {})}`);
    }
    const merchantDefaultCheckpoint = checkpoints.find((checkpoint) => checkpoint.planActionId === 'submit-final-order');
    const merchantCheckoutDefault = merchantDefaultCheckpoint?.browser?.runnerStep?.merchantCheckoutDefault || {};
    // The smoke merchant is localhost. The Amazon-only preference checkbox is
    // intentionally unavailable there, so assert the behavior that is valid
    // for this fixture while preserving the strict assertion for an Amazon DOM.
    if (merchantCheckoutDefault.attempted === true && merchantCheckoutDefault.saved !== true) {
      fail(`browser_extension_merchant_checkout_default_not_saved:${JSON.stringify(merchantDefaultCheckpoint?.browser?.runnerStep || {})}`);
    }
    if (merchantCheckoutDefault.attempted !== true && !['not_amazon', 'not_requested'].includes(merchantCheckoutDefault.reason)) {
      fail(`browser_extension_merchant_checkout_default_state_unexpected:${JSON.stringify(merchantDefaultCheckpoint?.browser?.runnerStep || {})}`);
    }
    const merchantConfirmationCheckpoint = checkpoints.find((checkpoint) => checkpoint.planActionId === 'confirm-merchant-order');
    if (merchantConfirmationCheckpoint?.browser?.runnerStep?.merchantOrderConfirmation?.confirmed !== true) {
      fail(`browser_extension_merchant_order_confirmation_not_verified:${JSON.stringify(merchantConfirmationCheckpoint?.browser?.runnerStep || {})}`);
    }
    if (fulfillment.result?.browserExecution?.checkoutSummary?.merchandiseSubtotal !== '$3.50'
      || fulfillment.result?.browserExecution?.checkoutSummary?.shippingTotal !== '$0.00'
      || fulfillment.result?.browserExecution?.checkoutSummary?.likelyTotal !== '$4.15') {
      fail(`browser_extension_did_not_separate_item_budget_from_all_in_total:${JSON.stringify(fulfillment.result?.browserExecution?.checkoutSummary || {})}`);
    }
    const verifiedMilestones = fulfillment.result?.browserExecution?.verifiedMilestones || [];
    for (const milestone of [
      'candidate_selected',
      'cart_confirmed',
      'checkout_open',
      'address_confirmed',
      'card_confirmed',
      'delivery_confirmed',
      'checkout_profile_verified',
      'final_review_ready',
      'final_submit_requested',
      'order_submitted'
    ]) {
      if (!verifiedMilestones.includes(milestone)) {
        fail(`browser_extension_missing_verified_milestone:${milestone}:${JSON.stringify(verifiedMilestones)}`);
      }
    }
    if (fulfillment.result?.browserExecution?.milestoneProtocol !== 'verified-v1') {
      fail('browser_extension_missing_verified_milestone_protocol');
    }
    const productCheckpoint = checkpoints.find((checkpoint) => checkpoint.planActionId === 'select-match');
    if (productCheckpoint?.browser?.runnerStep?.directSearchResultCart !== true
      || !['amazon_search_card_exact_first', 'amazon_search_card_fast_path', 'selected_search_result'].includes(productCheckpoint?.browser?.runnerStep?.controlStrategy)
      || !/test gadget/i.test(String(productCheckpoint?.browser?.runnerStep?.selectedCandidate?.title || ''))) {
      fail(`browser_extension_did_not_use_direct_search_card_receipt:${JSON.stringify({
        runnerStep: productCheckpoint?.browser?.runnerStep || null,
        summary: productCheckpoint?.browser?.checkoutSummary || null
      })}`);
    }
    const cartCheckpoint = checkpoints.find((checkpoint) => checkpoint.planActionId === 'inspect-cart');
    if (cartCheckpoint?.browser?.checkoutSummary?.cartPrimeFreeShippingVerified !== true) {
      fail(`browser_extension_did_not_verify_every_cart_item_prime_eligible:${JSON.stringify(cartCheckpoint?.browser?.checkoutSummary || {})}`);
    }
    const storePage = context.pages().find((page) => page.url().startsWith(baseUrl));
    if (!storePage || !storePage.url().includes('/checkout')) fail('browser_extension_did_not_reach_checkout');
    if (await storePage.locator('#prime-address-modal').count()) {
      fail('browser_extension_did_not_decline_checkout_prime_modal');
    }
    if (await storePage.locator('input[aria-label="Street address"]').inputValue() !== '1 Magic City Way') {
      fail(`browser_extension_did_not_fill_local_checkout_profile:${JSON.stringify({
        street: await storePage.locator('input[aria-label="Street address"]').inputValue(),
        billingStreet: await storePage.locator('input[aria-label="Billing street address"]').inputValue(),
        checkpoints: checkpoints.map((checkpoint) => ({
          id: checkpoint.planActionId,
          status: checkpoint.planActionStatus,
          state: checkpoint.browser?.checkoutSummary?.stage,
          nextAction: checkpoint.browser?.checkoutSummary?.nextAction,
          fields: checkpoint.browser?.safeFieldsFilled,
          selections: checkpoint.browser?.checkoutSelections,
          optionalOfferVisible: checkpoint.browser?.optionalOfferVisible
        })),
        fulfillment: fulfillment.result?.browserExecution
      })}`);
    }
    if (await storePage.locator('input[aria-label="Billing street address"]').inputValue() !== '99 Billing Plaza'
      || await storePage.locator('input[aria-label="Billing ZIP code"]').inputValue() !== '10001') {
      fail('browser_extension_did_not_fill_billing_checkout_profile');
    }
    if (!(await storePage.locator('#delivery-summary').textContent() || '').includes('1 Magic City Way, San Francisco, CA 94107')) {
      fail(`browser_extension_did_not_create_vault_delivery_address:summary=${await storePage.locator('#delivery-summary').textContent()}:steps=${JSON.stringify(checkpoints.map((checkpoint) => ({
        id: checkpoint.planActionId,
        status: checkpoint.planActionStatus,
        state: checkpoint.browser?.checkoutSummary?.stage,
        selections: checkpoint.browser?.checkoutSelections,
        summary: checkpoint.browser?.checkoutSummary
      })))}:profile=${JSON.stringify({
        expected: fulfillment.result?.browserExecution?.localCheckoutProfileExpected,
        available: fulfillment.result?.browserExecution?.localCheckoutProfileAvailable
      })}:selections=${JSON.stringify(fulfillment.result?.browserExecution?.checkoutSelections || [])}:summary=${JSON.stringify(fulfillment.result?.browserExecution?.checkoutSummary || {})}`);
    }
    if (!await storePage.locator('input[name="payment"]').nth(2).isChecked()) {
      const paymentState = await storePage.locator('input[name="payment"]').evaluateAll((inputs) => inputs.map((input) => ({
        checked: input.checked,
        visible: Boolean(input.offsetWidth || input.offsetHeight || input.getClientRects().length),
        text: input.closest('label')?.innerText || ''
      })));
      fail(`browser_extension_did_not_select_matching_card:${JSON.stringify(paymentState)}:selections=${JSON.stringify(fulfillment.result?.browserExecution?.checkoutSelections || [])}:summary=${JSON.stringify(fulfillment.result?.browserExecution?.checkoutSummary || {})}`);
    }
    if (!(await storePage.locator('#payment-summary').textContent() || '').includes('6383')
      || !await storePage.locator('#payment-options').isHidden()) {
      fail(`browser_extension_did_not_confirm_matching_saved_payment_method:${JSON.stringify({
        summary: await storePage.locator('#payment-summary').textContent(),
        optionsHidden: await storePage.locator('#payment-options').isHidden(),
        useButtonVisible: await storePage.locator('#use-payment-method').isVisible(),
        checkedCards: await storePage.locator('input[name="payment"]:checked').evaluateAll((inputs) => inputs.map((input) => input.closest('label')?.innerText || '')),
        steps: checkpoints.map((checkpoint) => ({
          id: checkpoint.planActionId,
          label: checkpoint.browser?.lastRunnerAction || '',
          selections: checkpoint.browser?.checkoutSelections || [],
          transitions: checkpoint.browser?.runnerStep?.profileTransitions || []
        }))
      })}`);
    }
    if (!await storePage.locator('input[name="delivery"]').nth(2).isChecked()) {
      const deliveryState = await storePage.locator('input[name="delivery"]').evaluateAll((inputs) => inputs.map((input) => ({
        checked: input.checked,
        visible: Boolean(input.offsetWidth || input.offsetHeight || input.getClientRects().length),
        text: input.closest('label')?.innerText || ''
      })));
      fail(`browser_extension_did_not_select_fastest_free_delivery:${JSON.stringify(deliveryState)}:selections=${JSON.stringify(fulfillment.result?.browserExecution?.checkoutSelections || [])}:summary=${JSON.stringify(fulfillment.result?.browserExecution?.checkoutSummary || {})}`);
    }
    if (!fulfillment.result?.browserExecution?.safeFieldsFilled?.includes('street address')) {
      fail('browser_extension_did_not_report_safe_checkout_fields');
    }
    if (!fulfillment.result?.browserExecution?.safeFieldsFilled?.includes('billing street address')) {
      fail('browser_extension_did_not_report_billing_checkout_fields');
    }
    const finalStage = fulfillment.result?.browserExecution?.checkoutSummary?.stage || '';
    if (!['checkout', 'final_review', 'payment'].includes(finalStage)) {
      fail('browser_extension_did_not_report_checkout_summary');
    }
    if (fulfillment.result?.browserExecution?.checkoutSummary?.cardMatches !== true) {
      fail('browser_extension_did_not_report_card_match');
    }
    if (!fulfillment.result?.browserExecution?.checkoutSelections?.includes('matching payment card')
      || !fulfillment.result?.browserExecution?.checkoutSelections?.includes('confirm matching payment card')
      || !fulfillment.result?.browserExecution?.checkoutSelections?.includes('confirm vault delivery address')) {
      fail('browser_extension_did_not_report_checkout_option_selection');
    }
    if (!completedIds.includes('submit-final-order') || !/Order placed/i.test(await storePage.locator('#order-result').textContent())) {
      fail('browser_extension_did_not_submit_verified_order');
    }
    const storeTab = (await worker.evaluate(() => chrome.tabs.query({})))
      .find((tab) => String(tab.url || '').startsWith(baseUrl));
    if (!storeTab || storeTab.active) fail('browser_extension_tab_stole_focus');
    recordPurchaseScenario('Single Prime item reaches verified checkout and auto-submits when authorized', {
      merchandiseSubtotal: fulfillment.result?.browserExecution?.checkoutSummary?.merchandiseSubtotal,
      shippingTotal: fulfillment.result?.browserExecution?.checkoutSummary?.shippingTotal,
      orderSubmitted: fulfillment.result?.browserExecution?.orderSubmitted === true
    });

    await Promise.all(context.pages()
      .filter((page) => page.url().startsWith(baseUrl))
      .map((page) => page.close().catch(() => null)));
    checkoutFixture = {
      total: '$3.50',
      itemCount: 1,
      showAddressPrimeModal: false,
      selectedCardLast4: '1817',
      matchingAddressAvailable: true,
      matchingAddressSummary: '2865 SAND HILL RD STE 101, MENLO PARK, CA, 94025-7022, United States',
      matchingAddressText: 'Test User 2865 SAND HILL RD STE 101 Menlo Park, CA 94025-7022 United States Phone number: 415-555-0100'
    };
    brandCandidateVisits = [];
    brandCartItem = null;
    checkpoints.length = 0;
    fulfillment = null;
    const brandFallbackPlan = buildExtensionPlan({
      id: 'browser-smoke-brand-fallback-session',
      handoffData: { kind: 'browser' },
      selections: {
        targetUrl: `${baseUrl}/brand-search`,
        goal: 'buy nature valley granol abars',
        budget: '$4',
        finalApprovalPolicy: 'auto_submit_after_verified_checkout'
      },
      extensionCheckoutProfileEnabled: true,
      extensionFulfillmentPolicy: 'amazon_free_shipping_preferred',
      extensionPrimeRequired: true
    });
    session = {
      ...session,
      id: 'browser-smoke-brand-fallback-session',
      status: 'queued',
      claimedByPluginId: null,
      extensionMissionPlan: brandFallbackPlan,
      extensionMissionPlanState: { planHash: brandFallbackPlan.planHash, nextActionIndex: 0, completedActionIds: [] },
      missionBoundaryLatestHash: null,
      missionBoundaryEventCount: 0
    };
    await worker.evaluate(() => chrome.storage.local.set({ activeMissionTabs: {} }));
    await seedSessionCheckoutProfile(session.id, defaultCheckoutProfile, brandFallbackPlan.planHash);
    const brandFallbackStartResponse = await popup.evaluate((sessionId) => new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'RUN_PENDING_SESSIONS', sessionId }, resolve);
    }), session.id);
    if (!brandFallbackStartResponse?.ok) fail(`browser_extension_brand_fallback_start_failed:${brandFallbackStartResponse?.error || 'no_response'}`);
    try {
      await waitFor(() => Boolean(fulfillment));
    } catch {
      const runnerState = await worker.evaluate(() => new Promise((resolve) => chrome.storage.local.get(['lastError', 'lastExecution'], resolve)));
      fail(`browser_extension_brand_fallback_timeout:steps=${checkpoints.map((checkpoint) => checkpoint.planActionId).join(',')}:last_error=${runnerState.lastError || 'none'}`);
    }
    if (fulfillment.status !== 'fulfilled') {
      fail(`browser_extension_brand_fallback_not_fulfilled:${JSON.stringify({
        execution: fulfillment.result?.browserExecution || {},
        steps: checkpoints.map((checkpoint) => ({
          id: checkpoint.planActionId,
          status: checkpoint.planActionStatus,
          control: checkpoint.browser?.runnerStep?.controlStrategy,
          directCart: checkpoint.browser?.runnerStep?.directSearchResultCart,
          selected: checkpoint.browser?.runnerStep?.selectedCandidate,
          selectionScan: checkpoint.browser?.runnerStep?.selectionScan,
          detail: checkpoint.detail
        }))
      })}`);
    }
    if (brandCandidateVisits.includes('nutri-grain-decoy')) {
      fail(`browser_extension_selected_wrong_brand:${JSON.stringify(brandCandidateVisits)}`);
    }
    if (brandCandidateVisits.length) {
      fail(`browser_extension_direct_search_cart_unexpectedly_opened_product_page:${JSON.stringify(brandCandidateVisits)}`);
    }
    const brandFilterCheckpoint = checkpoints.find((checkpoint) => checkpoint.planActionId === 'prefer-delivery-filter');
    if (brandFilterCheckpoint?.browser?.browserState !== 'search_results') {
      fail(`browser_extension_inline_cart_misclassified_search:${JSON.stringify(brandFilterCheckpoint?.browser || {})}`);
    }
    const brandSelectCheckpoint = checkpoints.find((checkpoint) => checkpoint.planActionId === 'select-match');
    if (brandSelectCheckpoint?.planActionStatus !== 'completed' || brandSelectCheckpoint?.browser?.runnerStep?.skipped) {
      fail(`browser_extension_inline_cart_skipped_required_selection:${JSON.stringify(brandSelectCheckpoint || {})}`);
    }
    if (brandSelectCheckpoint?.browser?.runnerStep?.directSearchResultCart !== true
      || !['amazon_search_card_exact_first', 'amazon_search_card_fast_path'].includes(brandSelectCheckpoint?.browser?.runnerStep?.controlStrategy)) {
      fail(`browser_extension_selection_did_not_click_bound_result_cart:${JSON.stringify(brandSelectCheckpoint?.browser?.runnerStep || {})}`);
    }
    if (!/Nature Valley Oats n Honey/i.test(String(brandSelectCheckpoint?.browser?.runnerStep?.selectedCandidate?.title || ''))) {
      fail(`browser_extension_direct_search_selection_wrong_candidate:${JSON.stringify(brandSelectCheckpoint?.browser || {})}`);
    }
    if (fulfillment.result?.browserExecution?.checkoutProgress?.addToCartClicked !== true
      || fulfillment.result?.browserExecution?.checkoutProgress?.checkoutOpened !== true) {
      fail(`browser_extension_brand_fallback_did_not_reach_checkout:${JSON.stringify(fulfillment.result?.browserExecution || {})}`);
    }
    const retainedBrandTab = await worker.evaluate((sessionId) => new Promise((resolve) => {
      chrome.storage.local.get(['activeMissionTabs'], (stored) => resolve(stored.activeMissionTabs?.[sessionId] || null));
    }), session.id);
    if (!retainedBrandTab) fail('browser_extension_terminal_handoff_lost_tab_ownership');
    const brandPrepareCart = checkpoints.find((checkpoint) => checkpoint.planActionId === 'prepare-cart');
    const brandOpenCheckout = checkpoints.find((checkpoint) => checkpoint.planActionId === 'open-checkout');
    const reusedPreparedCart = brandPrepareCart?.browser?.runnerStep?.completed === true
      && /already prepared|not adding a duplicate/i.test(String(brandPrepareCart?.browser?.runnerStep?.reason || brandPrepareCart?.detail || ''));
    if (!reusedPreparedCart
      || brandOpenCheckout?.planActionStatus !== 'completed') {
      fail(`browser_extension_direct_search_cart_did_not_use_bound_controls:${JSON.stringify({
        prepareCart: brandPrepareCart?.browser?.runnerStep || null,
        openCheckout: brandOpenCheckout?.browser?.runnerStep || null
      })}`);
    }
    recordPurchaseScenario('Typoed Nature Valley query picks the correct direct Add to Cart result', {
      selectedTitle: brandSelectCheckpoint?.browser?.runnerStep?.selectedCandidate?.title,
      visitedProductPages: brandCandidateVisits.length
    });

    await Promise.all(context.pages()
      .filter((page) => page.url().startsWith(baseUrl))
      .map((page) => page.close().catch(() => null)));
    checkoutFixture = {
      total: '$3.50',
      itemCount: 1,
      showAddressPrimeModal: false,
      selectedCardLast4: '1817',
      matchingAddressAvailable: true,
      matchingAddressSummary: '1 MAGIC CITY WAY, SAN FRANCISCO, CA, 94107, United States',
      matchingAddressText: 'Test User 1 MAGIC CITY WAY San Francisco, CA 94107 United States Phone number: 415-555-0100'
    };
    conditionalCandidateVisits = [];
    mixedOfferCandidateVisits = [];
    brandCartItem = null;
    checkpoints.length = 0;
    fulfillment = null;
    const conditionalShippingPlan = buildExtensionPlan({
      id: 'browser-smoke-conditional-prime-shipping-session',
      handoffData: { kind: 'browser' },
      selections: {
        targetUrl: `${baseUrl}/conditional-shipping-search`,
        goal: 'buy nature valley almond granola bars',
        budget: '$4',
        finalApprovalPolicy: 'auto_submit_after_verified_checkout'
      },
      extensionCheckoutProfileEnabled: true,
      extensionFulfillmentPolicy: 'amazon_free_shipping_preferred',
      extensionPrimeRequired: true
    });
    session = {
      ...session,
      id: 'browser-smoke-conditional-prime-shipping-session',
      status: 'queued',
      claimedByPluginId: null,
      extensionMissionPlan: conditionalShippingPlan,
      extensionMissionPlanState: { planHash: conditionalShippingPlan.planHash, nextActionIndex: 0, completedActionIds: [] },
      missionBoundaryLatestHash: null,
      missionBoundaryEventCount: 0
    };
    await worker.evaluate(() => chrome.storage.local.set({ activeMissionTabs: {} }));
    await seedSessionCheckoutProfile(session.id, defaultCheckoutProfile, conditionalShippingPlan.planHash);
    const conditionalShippingStartResponse = await popup.evaluate((sessionId) => new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'RUN_PENDING_SESSIONS', sessionId }, resolve);
    }), session.id);
    if (!conditionalShippingStartResponse?.ok) fail(`browser_extension_conditional_shipping_start_failed:${conditionalShippingStartResponse?.error || 'no_response'}`);
    try {
      await waitFor(() => Boolean(fulfillment));
    } catch {
      const runnerState = await worker.evaluate(() => new Promise((resolve) => chrome.storage.local.get(['lastError', 'lastExecution'], resolve)));
      fail(`browser_extension_conditional_shipping_timeout:steps=${checkpoints.map((checkpoint) => checkpoint.planActionId).join(',')}:last_error=${runnerState.lastError || 'none'}`);
    }
    if (fulfillment.status !== 'fulfilled') {
      fail(`browser_extension_conditional_shipping_not_fulfilled:${JSON.stringify({
        execution: fulfillment.result?.browserExecution || {},
        steps: checkpoints.map((checkpoint) => ({
          id: checkpoint.planActionId,
          status: checkpoint.planActionStatus,
          selected: checkpoint.browser?.runnerStep?.selectedCandidate,
          reason: checkpoint.browser?.runnerStep?.reason,
          detail: checkpoint.detail
        }))
      })}`);
    }
    const conditionalSelect = checkpoints.find((checkpoint) => checkpoint.planActionId === 'select-match');
    const selectedTitle = String(conditionalSelect?.browser?.runnerStep?.selectedCandidate?.title || '');
    if (!/Sweet & Salty Almond/i.test(selectedTitle)) {
      fail(`browser_extension_conditional_shipping_did_not_fallback_to_free_prime:${JSON.stringify({
        visits: conditionalCandidateVisits,
        selected: conditionalSelect?.browser?.runnerStep?.selectedCandidate || null,
        reason: conditionalSelect?.browser?.runnerStep?.reason || null
      })}`);
    }
    if (mixedOfferCandidateVisits.length !== 1
      || conditionalSelect?.browser?.runnerStep?.productPageVerified !== true
      || conditionalSelect?.browser?.runnerStep?.directSearchResultCart === true) {
      fail(`browser_extension_ambiguous_offer_not_verified_once:${JSON.stringify({
        visits: mixedOfferCandidateVisits,
        runnerStep: conditionalSelect?.browser?.runnerStep || null
      })}`);
    }
    recordPurchaseScenario('Paid-only result is skipped and a multiple-price match is verified on one product page', {
      rejectedProductPages: conditionalCandidateVisits.length,
      verifiedProductPages: mixedOfferCandidateVisits.length,
      selectedTitle
    });

    await Promise.all(context.pages()
      .filter((page) => page.url().startsWith(baseUrl))
      .map((page) => page.close().catch(() => null)));
    checkoutFixture = {
      total: '$7.75',
      itemCount: 3,
      showAddressPrimeModal: false,
      selectedCardLast4: '1817'
    };
    multiBasketItems = [];
    checkpoints.length = 0;
    fulfillment = null;
    const multiItemPlan = buildExtensionPlan({
      id: 'browser-smoke-multi-item-session',
      handoffData: { kind: 'browser' },
      selections: {
        targetUrl: `${baseUrl}/multi-search`,
        goal: "buy marshmallows, graham crackers, and hershey's chocolate",
        budget: '$15',
        shoppingItems: ['marshmallows', 'graham crackers', "hershey's chocolate"]
      },
      extensionCheckoutProfileEnabled: true
    });
    session = {
      ...session,
      id: 'browser-smoke-multi-item-session',
      status: 'queued',
      claimedByPluginId: null,
      extensionMissionPlan: multiItemPlan,
      extensionMissionPlanState: { planHash: multiItemPlan.planHash, nextActionIndex: 0, completedActionIds: [] },
      missionBoundaryLatestHash: null,
      missionBoundaryEventCount: 0
    };
    await worker.evaluate(() => chrome.storage.local.set({ activeMissionTabs: {} }));
    await seedSessionCheckoutProfile(session.id, defaultCheckoutProfile, multiItemPlan.planHash);
    const multiItemStartResponse = await popup.evaluate((sessionId) => new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'RUN_PENDING_SESSIONS', sessionId }, resolve);
    }), session.id);
    if (!multiItemStartResponse?.ok) fail(`browser_extension_multi_item_start_failed:${multiItemStartResponse?.error || 'no_response'}`);
    try {
      await waitFor(() => Boolean(fulfillment));
    } catch {
      const runnerState = await worker.evaluate(() => new Promise((resolve) => chrome.storage.local.get(['lastError', 'lastExecution'], resolve)));
      fail(`browser_extension_multi_item_timeout:steps=${checkpoints.map((checkpoint) => checkpoint.planActionId).join(',')}:last_error=${runnerState.lastError || 'none'}:last_execution=${runnerState.lastExecution?.status || 'none'}`);
    }
    if (fulfillment.status !== 'fulfilled') {
      const failedMultiItemPage = context.pages().find((page) => page.url().startsWith(baseUrl));
      const failedMultiItemPageText = failedMultiItemPage ? await failedMultiItemPage.locator('body').innerText() : '';
      fail(`browser_extension_multi_item_not_fulfilled:${fulfillment.status || 'none'}:${JSON.stringify(fulfillment.result?.browserExecution || {})}:page=${JSON.stringify(failedMultiItemPageText)}`);
    }
    const multiItemCompletedIds = checkpoints
      .filter((checkpoint) => checkpoint.planActionStatus !== 'waiting')
      .map((checkpoint) => checkpoint.planActionId);
    for (const actionId of [
      'search-item-1', 'inspect-results-1', 'select-match-1', 'prepare-cart-1', 'verify-cart-1',
      'search-item-2', 'inspect-results-2', 'select-match-2', 'prepare-cart-2', 'verify-cart-2',
      'search-item-3', 'inspect-results-3', 'select-match-3', 'prepare-cart-3', 'verify-cart-3',
      'inspect-cart', 'open-checkout'
    ]) {
      if (!multiItemCompletedIds.includes(actionId)) {
        fail(`browser_extension_multi_item_missing_step:${actionId}:${multiItemCompletedIds.join(',')}:cursor=${JSON.stringify(session.extensionMissionPlanState)}:result=${JSON.stringify(fulfillment.result?.browserExecution || {})}`);
      }
    }
    if (multiBasketItems.length !== 3
      || !multiBasketItems.includes('marshmallows')
      || !multiBasketItems.includes('graham-crackers')
      || !multiBasketItems.includes('hersheys-chocolate')
      || multiBasketItems.some((item) => /whole-foods|marketplace|gourmet/.test(item))) {
      fail(`browser_extension_multi_item_cart_incomplete:${JSON.stringify(multiBasketItems)}`);
    }
    const multiItemPage = context.pages().find((page) => page.url().startsWith(baseUrl));
    if (!multiItemPage || !multiItemPage.url().includes('/checkout')) {
      fail(`browser_extension_multi_item_did_not_reach_checkout:${multiItemPage?.url() || 'none'}:${multiItemCompletedIds.join(',')}`);
    }
    if (!/\$7\.75/.test(String(fulfillment.result?.browserExecution?.checkoutSummary?.likelyTotal || ''))) {
      fail(`browser_extension_multi_item_wrong_total:${JSON.stringify(fulfillment.result?.browserExecution?.checkoutSummary || {})}`);
    }
    recordPurchaseScenario('Three-item camping basket reaches checkout with only approved items', {
      items: [...multiBasketItems],
      likelyTotal: fulfillment.result?.browserExecution?.checkoutSummary?.likelyTotal
    });

    await Promise.all(context.pages()
      .filter((page) => page.url().startsWith(baseUrl))
      .map((page) => page.close().catch(() => null)));
    multiBasketItems = [];
    checkpoints.length = 0;
    fulfillment = null;
    const incompleteBasketPlan = buildExtensionPlan({
      id: 'browser-smoke-incomplete-basket-session',
      handoffData: { kind: 'browser' },
      selections: {
        targetUrl: `${baseUrl}/multi-search`,
        goal: 'buy marshmallows and unavailable sleeping bag',
        budget: '$15',
        shoppingItems: ['marshmallows', 'unavailable sleeping bag']
      },
      extensionCheckoutProfileEnabled: true
    });
    session = {
      ...session,
      id: 'browser-smoke-incomplete-basket-session',
      status: 'queued',
      claimedByPluginId: null,
      extensionMissionPlan: incompleteBasketPlan,
      extensionMissionPlanState: { planHash: incompleteBasketPlan.planHash, nextActionIndex: 0, completedActionIds: [] },
      missionBoundaryLatestHash: null,
      missionBoundaryEventCount: 0
    };
    await worker.evaluate(() => chrome.storage.local.set({ activeMissionTabs: {} }));
    await seedSessionCheckoutProfile(session.id, defaultCheckoutProfile, incompleteBasketPlan.planHash);
    const incompleteBasketStartResponse = await popup.evaluate((sessionId) => new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'RUN_PENDING_SESSIONS', sessionId }, resolve);
    }), session.id);
    if (!incompleteBasketStartResponse?.ok) fail(`browser_extension_incomplete_basket_start_failed:${incompleteBasketStartResponse?.error || 'no_response'}`);
    try {
      await waitFor(() => Boolean(fulfillment));
    } catch {
      const runnerState = await worker.evaluate(() => new Promise((resolve) => chrome.storage.local.get(['lastError', 'lastExecution'], resolve)));
      fail(`browser_extension_incomplete_basket_timeout:steps=${checkpoints.map((checkpoint) => checkpoint.planActionId).join(',')}:last_error=${runnerState.lastError || 'none'}:last_execution=${runnerState.lastExecution?.status || 'none'}`);
    }
    if (fulfillment.status !== 'failed'
      || fulfillment.fundingDisposition !== 'release'
      || fulfillment.result?.browserExecution?.stopState !== 'basket_item_not_added') {
      fail(`browser_extension_incomplete_basket_not_failed_closed:${JSON.stringify(fulfillment)}`);
    }
    const incompleteBasketActionIds = checkpoints
      .filter((checkpoint) => checkpoint.planActionStatus !== 'waiting')
      .map((checkpoint) => checkpoint.planActionId);
    if (!incompleteBasketActionIds.includes('prepare-cart-1')
      || incompleteBasketActionIds.includes('open-cart')
      || incompleteBasketActionIds.includes('open-checkout')) {
      fail(`browser_extension_incomplete_basket_reached_checkout:${incompleteBasketActionIds.join(',')}`);
    }
    recordPurchaseScenario('Incomplete basket fails closed before checkout', {
      completedSteps: incompleteBasketActionIds
    });
    await Promise.all(context.pages()
      .filter((page) => page.url().startsWith(baseUrl))
      .map((page) => page.close().catch(() => null)));
    checkoutFixture = {
      total: '$3.50',
      itemCount: 1,
      showAddressPrimeModal: false,
      selectedCardLast4: '1817',
      matchingAddressAvailable: true,
      matchingAddressSummary: '1 MAGIC CITY WAY, SAN FRANCISCO, CA, 94107, United States',
      matchingAddressText: 'Test User 1 MAGIC CITY WAY San Francisco, CA 94107 United States Phone number: 415-555-0100'
    };
    checkpoints.length = 0;
    fulfillment = null;
    const sideCartPlan = buildExtensionPlan({
      id: 'browser-smoke-sidecart-session',
      handoffData: { kind: 'browser' },
      selections: { targetUrl: `${baseUrl}/cart-preview-start`, goal: 'buy test gadget', budget: '$4' },
      extensionCheckoutProfileEnabled: true
    });
    session = {
      ...session,
      id: 'browser-smoke-sidecart-session',
      status: 'queued',
      claimedByPluginId: null,
      extensionMissionPlan: sideCartPlan,
      extensionMissionPlanState: { planHash: sideCartPlan.planHash, nextActionIndex: 0, completedActionIds: [] },
      missionBoundaryLatestHash: null,
      missionBoundaryEventCount: 0
    };
    await worker.evaluate(() => chrome.storage.local.set({ activeMissionTabs: {} }));
    await seedSessionCheckoutProfile(session.id, defaultCheckoutProfile, sideCartPlan.planHash);
    const sideCartStartResponse = await popup.evaluate((sessionId) => new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'RUN_PENDING_SESSIONS', sessionId }, resolve);
    }), session.id);
    if (!sideCartStartResponse?.ok) fail(`browser_extension_sidecart_start_failed:${sideCartStartResponse?.error || 'no_response'}`);
    try {
      await waitFor(() => Boolean(fulfillment));
    } catch {
      const runnerState = await worker.evaluate(() => new Promise((resolve) => chrome.storage.local.get(['lastError', 'lastExecution'], resolve)));
      fail(`browser_extension_sidecart_timeout:steps=${checkpoints.map((checkpoint) => checkpoint.planActionId).join(',')}:last_error=${runnerState.lastError || 'none'}:last_execution=${runnerState.lastExecution?.status || 'none'}`);
    }
    if (fulfillment.status !== 'fulfilled') {
      fail(`browser_extension_sidecart_not_fulfilled:${fulfillment.status || 'none'}:${JSON.stringify({
        checkpoints: checkpoints.map((checkpoint) => ({
          id: checkpoint.planActionId,
          status: checkpoint.planActionStatus,
      detail: checkpoint.detail,
      url: checkpoint.browser?.url,
      stage: checkpoint.browser?.checkoutSummary?.stage,
      action: checkpoint.browser?.lastRunnerAction,
      strategy: checkpoint.browser?.runnerStep?.controlStrategy,
      continuedInterstitial: checkpoint.browser?.runnerStep?.checkoutInterstitialContinued,
      milestones: checkpoint.browser?.verifiedMilestones
        })),
        execution: fulfillment.result?.browserExecution || {}
      })}`);
    }
    const sideCartCompletedIds = checkpoints
      .filter((checkpoint) => checkpoint.planActionStatus !== 'waiting')
      .map((checkpoint) => checkpoint.planActionId);
    if (!sideCartCompletedIds.includes('select-match') || !sideCartCompletedIds.includes('prepare-cart') || !sideCartCompletedIds.includes('open-checkout')) {
      fail(`browser_extension_sidecart_did_not_skip_forward:${sideCartCompletedIds.join(',')}`);
    }
    const sideCartPage = context.pages().find((page) => page.url().startsWith(baseUrl));
    if (!sideCartPage || !sideCartPage.url().includes('/checkout')) {
      fail(`browser_extension_sidecart_did_not_reach_checkout:${sideCartPage?.url() || 'none'}:steps=${JSON.stringify(checkpoints.map((checkpoint) => ({
        id: checkpoint.planActionId,
        status: checkpoint.planActionStatus,
        label: checkpoint.label,
        state: checkpoint.browser?.checkoutSummary?.stage,
        nextAction: checkpoint.browser?.checkoutSummary?.nextAction,
        actions: checkpoint.browser?.checkoutSummary?.availableActions,
        url: checkpoint.browser?.url
      })))}:fulfillment=${JSON.stringify(fulfillment.result?.browserExecution || {})}`);
    }
    recordPurchaseScenario('Existing matching side-cart item advances to checkout without duplicate add', {
      completedSteps: sideCartCompletedIds
    });

    checkoutFixture = {
      total: '$12.57',
      itemCount: 2
    };
    checkpoints.length = 0;
    fulfillment = null;
    const overBudgetPlan = buildExtensionPlan({
      id: 'browser-smoke-overbudget-session',
      handoffData: { kind: 'browser' },
      selections: { targetUrl: `${baseUrl}/search`, goal: 'buy test gadget', budget: '$4' },
      extensionCheckoutProfileEnabled: true
    });
    session = {
      ...session,
      id: 'browser-smoke-overbudget-session',
      status: 'queued',
      claimedByPluginId: null,
      extensionMissionPlan: overBudgetPlan,
      extensionMissionPlanState: { planHash: overBudgetPlan.planHash, nextActionIndex: 0, completedActionIds: [] },
      missionBoundaryLatestHash: null,
      missionBoundaryEventCount: 0
    };
    await worker.evaluate(() => chrome.storage.local.set({ activeMissionTabs: {} }));
    await seedSessionCheckoutProfile(session.id, defaultCheckoutProfile, overBudgetPlan.planHash);
    const overBudgetStartResponse = await popup.evaluate((sessionId) => new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'RUN_PENDING_SESSIONS', sessionId }, resolve);
    }), session.id);
    if (!overBudgetStartResponse?.ok) fail(`browser_extension_overbudget_start_failed:${overBudgetStartResponse?.error || 'no_response'}`);
    try {
      await waitFor(() => Boolean(fulfillment));
    } catch {
      const runnerState = await worker.evaluate(() => new Promise((resolve) => chrome.storage.local.get(['lastError', 'lastExecution'], resolve)));
      fail(`browser_extension_overbudget_timeout:steps=${checkpoints.map((checkpoint) => checkpoint.planActionId).join(',')}:last_error=${runnerState.lastError || 'none'}:last_execution=${runnerState.lastExecution?.status || 'none'}`);
    }
    if (fulfillment.status !== 'failed') {
      fail(`browser_extension_overbudget_not_failed:${JSON.stringify(fulfillment.result?.browserExecution?.checkoutSummary || {})}`);
    }
    if (fulfillment.fundingDisposition !== 'release') {
      fail(`browser_extension_overbudget_did_not_release:${fulfillment.fundingDisposition || 'none'}`);
    }
    if (fulfillment.result?.browserExecution?.stopState !== 'budget_exceeded') {
      fail(`browser_extension_overbudget_wrong_stop:${fulfillment.result?.browserExecution?.stopState || 'none'}`);
    }
    if (!/12\.57/.test(String(fulfillment.result?.browserExecution?.stopEvidence || ''))) {
      fail(`browser_extension_overbudget_missing_evidence:${fulfillment.result?.browserExecution?.stopEvidence || 'none'}`);
    }
    recordPurchaseScenario('Over-budget prepared cart releases credits and stops before checkout', {
      stopState: fulfillment.result?.browserExecution?.stopState,
      evidence: fulfillment.result?.browserExecution?.stopEvidence
    });

    await Promise.all(context.pages()
      .filter((page) => page.url().startsWith(baseUrl))
      .map((page) => page.close().catch(() => null)));
    checkpoints.length = 0;
    fulfillment = null;
    lateShippingCartItem = null;
    lateShippingCandidateVisits = [];
    checkoutFixture = {
      total: '$7.49',
      merchandiseSubtotal: '$3.50',
      shipping: '$3.99',
      itemCount: 1,
      selectedCardLast4: '1817',
      matchingAddressAvailable: true,
      freeDeliveryAvailable: false
    };
    const paidDeliveryStopPlan = buildExtensionPlan({
      id: 'browser-smoke-paid-delivery-stop-session',
      handoffData: { kind: 'browser' },
      selections: {
        targetUrl: `${baseUrl}/late-shipping-search`,
        goal: 'buy test gadget',
        budget: '$4',
        finalApprovalPolicy: 'auto_submit_after_verified_checkout'
      },
      extensionCheckoutProfileEnabled: true,
      extensionFulfillmentPolicy: 'amazon_free_shipping_preferred',
      extensionPrimeRequired: true
    });
    session = {
      ...session,
      id: 'browser-smoke-paid-delivery-stop-session',
      status: 'queued',
      claimedByPluginId: null,
      extensionMissionPlan: paidDeliveryStopPlan,
      extensionMissionPlanState: { planHash: paidDeliveryStopPlan.planHash, nextActionIndex: 0, completedActionIds: [] },
      missionBoundaryLatestHash: null,
      missionBoundaryEventCount: 0
    };
    await worker.evaluate(() => chrome.storage.local.set({ activeMissionTabs: {} }));
    await seedSessionCheckoutProfile(session.id, defaultCheckoutProfile, paidDeliveryStopPlan.planHash);
    const paidDeliveryStartResponse = await popup.evaluate((sessionId) => new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'RUN_PENDING_SESSIONS', sessionId }, resolve);
    }), session.id);
    if (!paidDeliveryStartResponse?.ok) fail(`browser_extension_paid_delivery_start_failed:${paidDeliveryStartResponse?.error || 'no_response'}`);
    await waitFor(() => Boolean(fulfillment));
    if (fulfillment.status !== 'failed'
      || fulfillment.fundingDisposition !== 'release'
      || fulfillment.result?.browserExecution?.stopState !== 'prime_required') {
      fail(`browser_extension_paid_delivery_stop_not_failed:${JSON.stringify({
        status: fulfillment.status,
        fundingDisposition: fulfillment.fundingDisposition,
        fulfillment: fulfillment.result?.browserExecution || {},
        visits: lateShippingCandidateVisits,
        steps: checkpoints.map((checkpoint) => ({
          id: checkpoint.planActionId,
          status: checkpoint.planActionStatus,
          runnerStep: checkpoint.browser?.runnerStep || null,
          detail: checkpoint.detail
        }))
      })}`);
    }
    if (!/Prime-only checkout requires \$0 delivery|No free Prime delivery/i.test(String(fulfillment.result?.browserExecution?.stopEvidence || ''))) {
      fail(`browser_extension_paid_delivery_stop_missing_evidence:${fulfillment.result?.browserExecution?.stopEvidence || 'none'}`);
    }
    if (!lateShippingCandidateVisits.includes('test-gadget-late-paid')) {
      fail(`browser_extension_paid_delivery_stop_did_not_visit_paid_item:${JSON.stringify(lateShippingCandidateVisits)}`);
    }
    const paidDeliveryRecoveryCheckpoint = checkpoints.find((checkpoint) =>
      checkpoint.browser?.runnerStep?.primeDeliverySubstitution?.attempted === true
    );
    if (paidDeliveryRecoveryCheckpoint) {
      fail(`browser_extension_paid_delivery_stop_should_not_recover_in_extension:${JSON.stringify(checkpoints.map((checkpoint) => ({
        id: checkpoint.planActionId,
        runnerStep: checkpoint.browser?.runnerStep || null
      })))}`);
    }
    recordPurchaseScenario('Prime item with paid checkout delivery stops cleanly', {
      stopState: fulfillment.result?.browserExecution?.stopState,
      evidence: fulfillment.result?.browserExecution?.stopEvidence,
      shippingTotal: fulfillment.result?.browserExecution?.checkoutSummary?.shippingTotal
    });

    checkpoints.length = 0;
    fulfillment = null;
    checkoutFixture = {
      total: '$3.50',
      itemCount: 1,
      showAddressPrimeModal: false,
      selectedCardLast4: '0109',
      matchingAddressAvailable: true,
      includeConflictingUnitAddress: true,
      matchingAddressSummary: '1 MAGIC CITY ST, UNIT 303, SAN FRANCISCO, CA 94107-1234',
      matchingAddressText: 'Test User\n1 MAGIC CITY ST\nUnit 303\nSan Francisco, CA 94107-1234\nUnited States\nPhone number: 415-555-0100'
    };
    const mismatchPlan = buildExtensionPlan({
      id: 'browser-smoke-mismatch-session',
      handoffData: { kind: 'browser' },
      selections: { targetUrl: `${baseUrl}/search`, goal: 'buy test gadget', budget: '$20' },
      extensionCheckoutProfileEnabled: true
    });
    session = {
      ...session,
      id: 'browser-smoke-mismatch-session',
      status: 'queued',
      claimedByPluginId: null,
      extensionMissionPlan: mismatchPlan,
      extensionMissionPlanState: { planHash: mismatchPlan.planHash, nextActionIndex: 0, completedActionIds: [] },
      missionBoundaryLatestHash: null,
      missionBoundaryEventCount: 0
    };
    await worker.evaluate(() => chrome.storage.local.set({ activeMissionTabs: {} }));
    await seedSessionCheckoutProfile(session.id, {
      ...defaultCheckoutProfile,
      streetAddress: '1 Magic City Street Apt 303',
      paymentCardLast4: '9999'
    }, mismatchPlan.planHash);
    const mismatchStartResponse = await popup.evaluate((sessionId) => new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'RUN_PENDING_SESSIONS', sessionId }, resolve);
    }), session.id);
    if (!mismatchStartResponse?.ok) fail(`browser_extension_mismatch_start_failed:${mismatchStartResponse?.error || 'no_response'}`);
    let mismatchPage = null;
    const mismatchPageDeadline = Date.now() + 20_000;
    while (!mismatchPage && Date.now() < mismatchPageDeadline) {
      for (const candidatePage of context.pages().filter((page) => page.url().startsWith(baseUrl)).reverse()) {
        if (await candidatePage.locator('#delivery-summary').count().catch(() => 0)) {
          mismatchPage = candidatePage;
          break;
        }
      }
      if (!mismatchPage) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!mismatchPage) fail('browser_extension_card_handoff_missing_page');
    await mismatchPage.locator('input[aria-label="Card number"]').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => null);
    const cardEntryVisible = await mismatchPage.locator('input[aria-label="Card number"]').isVisible();
    if (!(await mismatchPage.locator('#delivery-summary').textContent() || '').includes('1 MAGIC CITY ST, UNIT 303')) {
      fail(`browser_extension_did_not_select_matching_unlabeled_address:${await mismatchPage.locator('#delivery-summary').textContent()}`);
    }
    if (!checkpoints.some((checkpoint) => checkpoint.browser?.checkoutSelections?.includes('matching delivery address'))) {
      fail(`browser_extension_missing_matching_address_checkpoint:${JSON.stringify(checkpoints.map((checkpoint) => ({ id: checkpoint.planActionId, selections: checkpoint.browser?.checkoutSelections || [] })))}`);
    }
    const pendingPaymentState = await worker.evaluate(() => new Promise((resolve) => chrome.storage.local.get(['pendingPaymentWaits', 'activeRun', 'lastExecution'], resolve)));
    if (fulfillment) fail(`browser_extension_card_handoff_fulfilled_before_user_autofill:${JSON.stringify({
      fulfillment,
      steps: checkpoints.map((checkpoint) => ({
        id: checkpoint.planActionId,
        status: checkpoint.planActionStatus,
        state: checkpoint.state,
        stage: checkpoint.browser?.checkoutSummary?.stage,
        issue: checkpoint.browser?.checkoutSummary?.paymentIssue,
        runner: checkpoint.browser?.runnerStep
      }))
    })}`);
    if (!pendingPaymentState.pendingPaymentWaits?.['browser-smoke-mismatch-session']) {
      fail(`browser_extension_card_handoff_not_parked:${JSON.stringify(pendingPaymentState.lastExecution || {})}`);
    }
    if (pendingPaymentState.activeRun?.sessionId !== 'browser-smoke-mismatch-session'
      || pendingPaymentState.activeRun?.phase !== 'waiting_for_payment_autofill') {
      fail(`browser_extension_card_handoff_missing_durable_run:${JSON.stringify(pendingPaymentState.activeRun || {})}`);
    }
    if (!checkpoints.some((checkpoint) => checkpoint.state === 'waiting_for_payment_autofill' && checkpoint.planActionStatus === 'waiting')) {
      fail(`browser_extension_card_handoff_missing_waiting_checkpoint:${JSON.stringify(checkpoints.map((checkpoint) => ({ id: checkpoint.planActionId, state: checkpoint.state, status: checkpoint.planActionStatus })))}`);
    }
    if (!cardEntryVisible) {
      const paymentFormState = mismatchPage ? await mismatchPage.evaluate(() => ({
        paymentOptionsHidden: document.querySelector('#payment-options')?.hidden,
        addCardFormHidden: document.querySelector('#add-card-form')?.hidden,
        controls: Array.from(document.querySelectorAll('button, a, input[type="submit"], input[type="button"], [role="button"]')).map((control) => ({
          text: String(control.textContent || control.getAttribute('aria-label') || '').trim().slice(0, 100),
          hidden: Boolean(control.closest('[hidden]')),
          display: getComputedStyle(control).display,
          width: Math.round(control.getBoundingClientRect().width),
          height: Math.round(control.getBoundingClientRect().height)
        }))
      })) : null;
      fail(`browser_extension_card_handoff_did_not_open_browser_autofill_form:url=${mismatchPage?.url() || 'none'}:steps=${JSON.stringify(checkpoints.map((checkpoint) => ({
        id: checkpoint.planActionId,
        status: checkpoint.planActionStatus,
        label: checkpoint.label,
        detail: checkpoint.detail,
        stage: checkpoint.browser?.checkoutSummary?.stage,
        nextAction: checkpoint.browser?.checkoutSummary?.nextAction,
        card: checkpoint.browser?.checkoutSummary?.selectedCardLast4,
        runnerAction: checkpoint.browser?.lastRunnerAction,
        actions: checkpoint.browser?.checkoutSummary?.availableActions
      })))}:payment_form=${JSON.stringify(paymentFormState)}`);
    }
    if (cardEntryVisible && await mismatchPage.locator('input[aria-label="Card number"]').inputValue()) {
      fail('browser_extension_card_handoff_typed_sensitive_card_data');
    }
    // Simulate MV3 suspending the service worker while the user is choosing a
    // local card. The persisted active run plus the real resume alarm must
    // recover this without any test-only wake message.
    const paymentWaitCdp = await context.newCDPSession(mismatchPage);
    await paymentWaitCdp.send('ServiceWorker.enable');
    await paymentWaitCdp.send('ServiceWorker.stopAllWorkers');
    await mismatchPage.locator('input[aria-label="Card number"]').fill('5555555555559999');
    await mismatchPage.locator('input[aria-label="Name on card"]').fill('Test User');
    await mismatchPage.getByRole('button', { name: 'Add your card' }).click();
    try {
      await waitFor(() => Boolean(fulfillment), 55_000);
    } catch {
      const runnerState = await worker.evaluate(() => new Promise((resolve) => chrome.storage.local.get(['lastError', 'lastExecution', 'pendingPaymentWaits', 'activeRun'], resolve)));
      fail(`browser_extension_mismatch_resume_timeout:steps=${checkpoints.map((checkpoint) => checkpoint.planActionId).join(',')}:last_error=${runnerState.lastError || 'none'}:last_execution=${runnerState.lastExecution?.status || 'none'}:pending=${JSON.stringify(runnerState.pendingPaymentWaits || {})}`);
    }
    if (fulfillment.status !== 'fulfilled' || fulfillment.fundingDisposition !== 'hold') {
      fail(`browser_extension_card_resume_not_fulfilled:${JSON.stringify(fulfillment)}`);
    }
    const mismatchStopState = fulfillment.result?.browserExecution?.stopState || '';
    if (!['final_approval_required', 'review_ready'].includes(mismatchStopState)) {
      fail(`browser_extension_card_resume_wrong_stop:${mismatchStopState}`);
    }
    if (fulfillment.result?.browserExecution?.checkoutSummary?.cardMatches !== true) {
      fail(`browser_extension_card_resume_did_not_verify_expected_card:${JSON.stringify(fulfillment.result?.browserExecution?.checkoutSummary || {})}`);
    }
    const resumedPaymentState = await worker.evaluate(() => new Promise((resolve) => chrome.storage.local.get(['pendingPaymentWaits', 'activeRun'], resolve)));
    if (resumedPaymentState.pendingPaymentWaits?.['browser-smoke-mismatch-session']) {
      fail('browser_extension_card_resume_did_not_clear_wait_state');
    }
    if (resumedPaymentState.activeRun) fail(`browser_extension_card_resume_did_not_clear_durable_run:${JSON.stringify(resumedPaymentState.activeRun)}`);
    recordPurchaseScenario('Approximate saved address match plus wrong card opens card handoff and resumes', {
      stopState: fulfillment.result?.browserExecution?.stopState,
      cardMatches: fulfillment.result?.browserExecution?.checkoutSummary?.cardMatches
    });

    // A user opting into final review must be able to approve the already
    // prepared checkout without replaying search/cart work or opening a tab.
    await Promise.all(context.pages()
      .filter((page) => page.url().startsWith(baseUrl))
      .map((page) => page.close().catch(() => null)));
    checkoutFixture = {
      total: '$3.50',
      itemCount: 1,
      showAddressPrimeModal: false,
      selectedCardLast4: '1817',
      matchingAddressAvailable: true,
      matchingAddressChecked: true,
      matchingAddressSummary: '2865 SAND HILL RD STE 101, MENLO PARK, CA, 94025-7022, United States',
      matchingAddressText: 'Test User 2865 SAND HILL RD STE 101 Menlo Park, CA 94025-7022 United States Phone number: 415-555-0100',
      selectedFreeDelivery: true,
      // Amazon renders this pickup disclosure next to a perfectly valid
      // shipped-order review. It must never be treated as a delivery change.
      showPickupDisclosure: true
    };
    checkpoints.length = 0;
    fulfillment = null;
    const manualReviewPlan = buildExtensionPlan({
      id: 'browser-smoke-final-review-session',
      handoffData: { kind: 'browser' },
      selections: {
        targetUrl: `${baseUrl}/search`,
        goal: 'buy test gadget',
        budget: '$4',
        finalApprovalPolicy: 'pause_before_final_approval'
      },
      extensionCheckoutProfileEnabled: true
    });
    session = {
      ...session,
      id: 'browser-smoke-final-review-session',
      status: 'queued',
      claimedByPluginId: null,
      fulfillment: null,
      extensionFinalSubmitResume: false,
      extensionMissionPlan: manualReviewPlan,
      extensionMissionPlanState: { planHash: manualReviewPlan.planHash, nextActionIndex: 0, completedActionIds: [] },
      missionBoundaryLatestHash: null,
      missionBoundaryEventCount: 0
    };
    await worker.evaluate(() => chrome.storage.local.set({ activeMissionTabs: {} }));
    await seedSessionCheckoutProfile(session.id, {
      ...defaultCheckoutProfile,
      streetAddress: '2865 Sand Hill Road Suite 101',
      shippingCity: 'Menlo Park',
      shippingState: 'CA',
      zipCode: '94025'
    }, manualReviewPlan.planHash);
    const manualReviewStartResponse = await popup.evaluate((sessionId) => new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'RUN_PENDING_SESSIONS', sessionId }, resolve);
    }), session.id);
    if (!manualReviewStartResponse?.ok) fail(`browser_extension_final_review_start_failed:${manualReviewStartResponse?.error || 'no_response'}`);
    try {
      await waitFor(() => Boolean(fulfillment));
    } catch {
      const runnerState = await worker.evaluate(() => new Promise((resolve) => chrome.storage.local.get(['lastError', 'lastExecution'], resolve)));
      fail(`browser_extension_final_review_timeout:steps=${checkpoints.map((checkpoint) => checkpoint.planActionId).join(',')}:last_error=${runnerState.lastError || 'none'}:last_execution=${runnerState.lastExecution?.status || 'none'}`);
    }
    if (fulfillment.status !== 'fulfilled'
      || fulfillment.result?.browserExecution?.stopState !== 'final_approval_required'
      || fulfillment.result?.browserExecution?.orderSubmitted === true) {
      fail(`browser_extension_final_review_not_paused:${JSON.stringify(fulfillment)}`);
    }
    const preservedReviewState = await worker.evaluate(async () => {
      const [local, session] = await Promise.all([
        chrome.storage.local.get(['activeMissionTabs', 'localCheckoutProfiles']),
        chrome.storage.session.get(['magicCityLocalCheckoutProfiles'])
      ]);
      return {
        ...local,
        sessionCheckoutProfiles: session.magicCityLocalCheckoutProfiles || {}
      };
    });
    if (Object.keys(preservedReviewState.localCheckoutProfiles || {}).length) {
      fail(`browser_extension_final_review_profile_persisted_to_local_storage:${JSON.stringify(preservedReviewState.localCheckoutProfiles)}`);
    }
    const reviewTabId = preservedReviewState.activeMissionTabs?.['browser-smoke-final-review-session'];
    if (!reviewTabId || !preservedReviewState.sessionCheckoutProfiles?.['browser-smoke-final-review-session']) {
      fail(`browser_extension_final_review_context_not_preserved:${JSON.stringify(preservedReviewState)}`);
    }
    const preparedReviewPage = context.pages().find((page) => page.url().startsWith(baseUrl)
      && page.url().includes('/checkout/'));
    if (!preparedReviewPage) fail('browser_extension_final_review_page_missing');
    await preparedReviewPage.evaluate(() => {
      window.__nativeFinalClickTargetId = '';
      document.addEventListener('click', (event) => {
        if (event.target?.id === 'submitOrderButtonId') {
          window.__nativeFinalClickTargetId = event.target.id;
        }
      }, true);
      const summary = document.querySelector('#delivery-summary');
      if (summary) summary.textContent = '2865 SAND HILL RD STE 101, MENLO PARK, CA, 94025-7022, United States';
      const unrelated = document.createElement('label');
      unrelated.innerHTML = '<input type="checkbox" checked /> Default to this delivery address and payment method.';
      document.querySelector('main')?.appendChild(unrelated);
      const pickupModal = document.createElement('div');
      pickupModal.id = 'pickup-modal';
      pickupModal.className = 'a-popover a-popover-modal';
      pickupModal.style.cssText = 'position:fixed;inset:48px;z-index:20;background:white;border:1px solid #999;padding:16px;overflow:auto';
      pickupModal.innerHTML = [
        '<button id="pickup-close" aria-label="Close" onclick="sessionStorage.setItem(\'magic-city-pickup-overlay-closed\', \'1\'); document.querySelector(\'#pickup-modal\').remove()">×</button>',
        '<h2>Select a pickup location</h2>',
        '<label>Find pickup locations near: <input placeholder="Enter an address, zip code, or landmark" /></label>',
        '<section><h3>Amazon Counter at Whole Foods Market</h3><p>774 Emerson St, Palo Alto, CA 94301</p><p>FREE pickup Friday, Aug 28</p><button onclick="window.__checkoutEvents ||= []; window.__checkoutEvents.push(\'bad-pickup-selected\')">Pick up here</button></section>'
      ].join('');
      document.body.appendChild(pickupModal);
    });
    const reviewTabCount = (await worker.evaluate(() => chrome.tabs.query({})))
      .filter((tab) => String(tab.url || '').startsWith(baseUrl)).length;

    // An interruption after intent persistence but before native dispatch is
    // deliberately inconclusive. It must neither click a second time nor
    // claim final-submit evidence that the browser cannot prove.
    await preparedReviewPage.evaluate(() => {
      const key = 'magic_city_browser_action_receipts_v1';
      const current = JSON.parse(sessionStorage.getItem(key) || '[]');
      current.push({
        actionId: 'interrupted-final-submit',
        actionType: 'final_submit',
        intent: 'submit_final_order',
        receiptScope: 'browser-smoke-interrupted-final-submit',
        kind: 'final_order',
        phase: 'final_submit_intent',
        at: new Date().toISOString()
      });
      sessionStorage.setItem(key, JSON.stringify(current));
      window.__nativeFinalClickTargetId = '';
    });
    // Force a fresh executor injection after the durable receipt was written.
    // This covers the MV3/content-script reinjection path rather than relying
    // on an earlier in-memory receipt array.
    const reinjectExecutor = await worker.evaluate(async ({ tabId }) => {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['executor.js'] });
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error?.message || String(error) };
      }
    }, { tabId: reviewTabId });
    if (!reinjectExecutor?.ok) fail(`browser_extension_final_order_intent_reinject_failed:${reinjectExecutor?.error || 'unknown'}`);
    const interruptedFinalSubmit = await worker.evaluate(({ tabId }) => new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, {
        type: 'MAGIC_CITY_EXECUTE_PLAN_STEP',
        action: {
          id: 'interrupted-final-submit',
          type: 'final_submit',
          receiptScope: 'browser-smoke-interrupted-final-submit',
          autoSubmitAfterVerifiedCheckout: true,
          maxPrice: 4
        },
        checkoutProfile: {
          streetAddress: '2865 Sand Hill Road Suite 101',
          shippingCity: 'Menlo Park',
          shippingState: 'CA',
          zipCode: '94025',
          paymentCardLast4: '1817'
        }
      }, (response) => resolve({ response, error: chrome.runtime.lastError?.message || '' }));
    }), { tabId: reviewTabId });
    const interruptedNativeClick = await preparedReviewPage.evaluate(() => window.__nativeFinalClickTargetId || '');
    if (interruptedFinalSubmit.error
      || interruptedFinalSubmit.response?.completed !== false
      || interruptedFinalSubmit.response?.noReplay !== true
      || interruptedFinalSubmit.response?.finalSubmitRequested === true
      || interruptedNativeClick) {
      fail(`browser_extension_final_order_intent_interruption_replayed_or_counted_as_dispatch:${JSON.stringify({
        interruptedFinalSubmit,
        interruptedNativeClick
      })}`);
    }

    checkpoints.length = 0;
    fulfillment = null;
    const resumeFinalSubmitPlan = buildExtensionPlan({
      id: 'browser-smoke-final-review-session',
      handoffData: { kind: 'browser' },
      selections: {
        targetUrl: `${baseUrl}/search`,
        goal: 'buy test gadget',
        budget: '$4',
        finalApprovalPolicy: 'auto_submit_after_verified_checkout'
      },
      extensionCheckoutProfileEnabled: true,
      extensionFinalSubmitResume: true
    });
    session = {
      ...session,
      status: 'queued',
      claimedByPluginId: null,
      fulfillment: null,
      extensionFinalSubmitResume: true,
      extensionMissionPlan: resumeFinalSubmitPlan,
      extensionMissionPlanState: { planHash: resumeFinalSubmitPlan.planHash, nextActionIndex: 0, completedActionIds: [] },
      missionBoundaryLatestHash: null,
      missionBoundaryEventCount: 0
    };
    // Match the production retry path: the Magic City page re-provisions its
    // unlocked vault snapshot to the extension before it asks the runner to
    // resume a newly signed plan for this same session.
    const reprovisionedProfile = await preparedReviewPage.evaluate(({ extensionId, sessionId }) => new Promise((resolve) => {
      if (!window.chrome?.runtime?.sendMessage) {
        resolve({ ok: false, error: 'web_chrome_runtime_unavailable' });
        return;
      }
      window.chrome.runtime.sendMessage(extensionId, {
        type: 'SET_LOCAL_CHECKOUT_PROFILE',
        sessionId,
        profile: {
          contactName: 'Test User',
          streetAddress: '2865 Sand Hill Road Suite 101',
          shippingCity: 'Menlo Park', shippingState: 'CA', zipCode: '94025',
          contactPhone: '4155550100', billingStreetAddress: '99 Billing Plaza',
          billingZipCode: '10001', paymentCardLast4: '1817'
        }
      }, (response) => {
        resolve({ ok: Boolean(response?.ok), error: window.chrome.runtime.lastError?.message || response?.error || '' });
      });
    }), { extensionId, sessionId: session.id });
    if (!reprovisionedProfile?.ok) {
      fail(`browser_extension_final_review_profile_reprovision_failed:${reprovisionedProfile?.error || 'unknown'}`);
    }
    // Persisted session data must survive an MV3 restart, and the final action
    // must use the fresh signed local lease rather than wait on runner-status.
    const finalReviewRecoveryCdp = await context.newCDPSession(preparedReviewPage);
    await finalReviewRecoveryCdp.send('ServiceWorker.enable');
    await finalReviewRecoveryCdp.send('ServiceWorker.stopAllWorkers');
    blockRunnerStatusForFinalDispatch = true;
    const resumeFinalSubmitResponse = await popup.evaluate((sessionId) => new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'RUN_PENDING_SESSIONS', sessionId }, resolve);
    }), session.id);
    if (!resumeFinalSubmitResponse?.ok) fail(`browser_extension_final_review_resume_failed:${resumeFinalSubmitResponse?.error || 'no_response'}`);
    try {
      await waitFor(() => Boolean(fulfillment));
    } catch {
      const runnerState = await worker.evaluate(() => new Promise((resolve) => chrome.storage.local.get(['lastError', 'lastExecution'], resolve)));
      fail(`browser_extension_final_review_resume_timeout:steps=${checkpoints.map((checkpoint) => checkpoint.planActionId).join(',')}:last_error=${runnerState.lastError || 'none'}:last_execution=${runnerState.lastExecution?.status || 'none'}`);
    } finally {
      blockRunnerStatusForFinalDispatch = false;
    }
    if (fulfillment.status !== 'fulfilled'
      || fulfillment.result?.browserExecution?.orderSubmitted !== true
      || fulfillment.result?.browserExecution?.stopState !== 'order_submitted') {
      fail(`browser_extension_final_review_resume_not_submitted:${JSON.stringify(fulfillment)}`);
    }
    const resumeActionIds = checkpoints
      .filter((checkpoint) => checkpoint.planActionStatus !== 'waiting')
      .map((checkpoint) => checkpoint.planActionId);
    if (resumeActionIds.some((actionId) => /^(open-site|inspect-landing|inspect-results|select-match|prepare-cart|open-cart|inspect-cart|open-checkout)$/.test(actionId))
      || !resumeActionIds.includes('submit-final-order')) {
      fail(`browser_extension_final_review_replayed_checkout:${resumeActionIds.join(',')}`);
    }
    const resumeTabs = (await worker.evaluate(() => chrome.tabs.query({})))
      .filter((tab) => String(tab.url || '').startsWith(baseUrl));
    if (resumeTabs.length !== reviewTabCount || !resumeTabs.some((tab) => tab.id === reviewTabId)) {
      fail(`browser_extension_final_review_did_not_reuse_tab:${JSON.stringify({ reviewTabId, reviewTabCount, resumeTabs })}`);
    }
    const reviewEvents = await preparedReviewPage.evaluate(() => window.__checkoutEvents || []);
    if (reviewEvents.includes('bad-pickup-selected') || reviewEvents.includes('bad-pickup-disclosure-opened') || reviewEvents.includes('bad-change-to-pickup')) {
      fail(`browser_extension_final_review_selected_pickup:${reviewEvents.join(',')}`);
    }
    const pickupOverlayClosed = await preparedReviewPage.evaluate(() => sessionStorage.getItem('magic-city-pickup-overlay-closed'));
    if (pickupOverlayClosed !== '1') {
      fail(`browser_extension_final_review_pickup_overlay_not_closed:${pickupOverlayClosed || 'missing'}`);
    }
    const finalSubmitCheckpoint = checkpoints.find((checkpoint) => checkpoint.planActionId === 'submit-final-order');
    const finalOrderReceipts = finalSubmitCheckpoint?.browser?.browserActionReceipts || [];
    if (finalSubmitCheckpoint?.browser?.runnerStep?.finalSubmitReceipt?.kind !== 'final_order'
      || finalSubmitCheckpoint?.browser?.runnerStep?.finalSubmitReceipt?.phase !== 'click_dispatched'
      || !finalOrderReceipts.some((receipt) => receipt?.kind === 'final_order' && receipt?.phase === 'final_submit_intent')
      || !finalOrderReceipts.some((receipt) => receipt?.kind === 'final_order' && receipt?.phase === 'click_dispatched')) {
      fail(`browser_extension_final_order_receipt_missing_before_navigation:${JSON.stringify({
        runnerStep: finalSubmitCheckpoint?.browser?.runnerStep || {},
        receipts: finalOrderReceipts
      })}`);
    }
    const nativeFinalClick = await preparedReviewPage.evaluate(() => window.__nativeFinalClickTargetId || '');
    if (nativeFinalClick !== 'submitOrderButtonId') {
      fail(`browser_extension_final_order_native_control_not_clicked:${JSON.stringify({
        url: preparedReviewPage.url(),
        nativeFinalClick,
        finalSubmit: finalSubmitCheckpoint?.browser?.runnerStep || null,
        receipts: finalSubmitCheckpoint?.browser?.browserActionReceipts || [],
        fulfillment: fulfillment?.result?.browserExecution || null
      })}`);
    }
    if (blockedFinalRunnerStatusCalls !== 0) {
      fail(`browser_extension_final_review_waited_for_control_plane:${blockedFinalRunnerStatusCalls}`);
    }
    if (!checkpoints.some((checkpoint) => checkpoint?.browser?.browserActionReceipts?.some((receipt) => (
      receipt?.kind === 'final_order' && receipt?.phase === 'click_dispatched'
    )))) {
      const pageReceiptStorage = await preparedReviewPage.evaluate(() => sessionStorage.getItem('magic_city_browser_action_receipts_v1') || '');
      fail(`browser_extension_final_order_dispatch_receipt_missing_after_navigation:${JSON.stringify({
        checkpoints: checkpoints
          .filter((checkpoint) => checkpoint.planActionId === 'submit-final-order' || checkpoint.planActionId === 'confirm-merchant-order')
          .map((checkpoint) => ({
            actionId: checkpoint.planActionId,
            receipts: checkpoint.browser?.browserActionReceipts || []
          })),
        pageReceiptStorage
      })}`);
    }
    recordPurchaseScenario('Manual final-review handoff resumes in the same prepared checkout tab', {
      resumedSteps: resumeActionIds,
      addressVariant: 'RD/STE and ZIP+4 with unrelated checked checkout control',
      pickupModalIgnored: true,
      finalOrderReceiptCheckpointed: true,
      intentOnlyFinalSubmitRejected: true
    });

    checkpoints.length = 0;
    fulfillment = null;
    const invalidStartupPlan = {
      ...mismatchPlan,
      planId: 'mplan_browser-smoke-invalid-startup-session',
      startUrl: 'http://example.invalid/not-allowed'
    };
    session = {
      ...session,
      id: 'browser-smoke-invalid-startup-session',
      status: 'queued',
      claimedByPluginId: null,
      extensionMissionPlan: invalidStartupPlan,
      extensionMissionPlanState: { planHash: invalidStartupPlan.planHash, nextActionIndex: 0, completedActionIds: [] },
      missionBoundaryLatestHash: null,
      missionBoundaryEventCount: 0
    };
    await worker.evaluate(async () => {
      await chrome.storage.local.set({ activeMissionTabs: {} });
      await chrome.storage.session.remove('magicCityLocalCheckoutProfiles');
    });
    const invalidStartupResponse = await popup.evaluate((sessionId) => new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'RUN_PENDING_SESSIONS', sessionId }, resolve);
    }), session.id);
    if (!invalidStartupResponse?.ok) fail(`browser_extension_invalid_startup_failed_to_return:${invalidStartupResponse?.error || 'no_response'}`);
    try {
      await waitFor(() => Boolean(fulfillment));
    } catch {
      const runnerState = await worker.evaluate(() => new Promise((resolve) => chrome.storage.local.get(['lastError', 'lastExecution'], resolve)));
      fail(`browser_extension_invalid_startup_watchdog_risk:last_error=${runnerState.lastError || 'none'}:last_execution=${runnerState.lastExecution?.status || 'none'}`);
    }
    if (fulfillment.status !== 'failed'
      || fulfillment.result?.browserExecution?.stopState !== 'runner_startup_failed'
      || fulfillment.fundingDisposition !== 'release') {
      fail(`browser_extension_invalid_startup_not_reported:${JSON.stringify(fulfillment)}`);
    }

    const stalePermissionPlan = buildExtensionPlan({
      id: 'browser-smoke-stale-permission-session',
      handoffData: { kind: 'browser' },
      selections: { targetUrl: `${baseUrl}/search`, goal: 'prepare an old travel search', budget: '$4000' }
    });
    const stalePermissionCreatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    session = {
      ...session,
      id: 'browser-smoke-stale-permission-session',
      status: 'executing',
      completionMode: 'agent_checkout',
      preferredExecutionAgentId: 'magic-city-runner-extension',
      claimedByPluginId: 'magic-city-runner-extension',
      executionRequestedAt: stalePermissionCreatedAt,
      executionLive: {
        state: 'permission_required',
        label: 'Browser access needed',
        createdAt: stalePermissionCreatedAt
      },
      extensionMissionPlan: stalePermissionPlan,
      extensionMissionPlanState: { planHash: stalePermissionPlan.planHash, nextActionIndex: 0, completedActionIds: [] }
    };
    const stalePendingResponse = await popup.evaluate(() => new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'GET_PENDING_MISSION_SITE' }, resolve);
    }));
    if (stalePendingResponse?.ok || !/no browser mission is waiting/i.test(String(stalePendingResponse?.error || ''))) {
      fail(`browser_extension_stale_permission_mission_visible:${JSON.stringify(stalePendingResponse)}`);
    }

    // Disconnect the website's active port while a long merchant observation
    // is in flight, then terminate the MV3 worker. The durable active run and
    // crash-recovery alarm must resume the same read-only confirmation step;
    // no browser mutation is replayed.
    checkpoints.length = 0;
    fulfillment = null;
    distractorSession = null;
    const disconnectedSessionId = 'browser-smoke-active-port-disconnect-session';
    const disconnectedPlan = rehashExtensionPlan({
      ...plan,
      planId: 'mplan_browser-smoke-active-port-disconnect-session',
      startUrl: `${baseUrl}/checkout/processing-order?delay=40000`,
      actions: [
        {
          id: 'open-processing-order',
          type: 'navigate',
          missionAction: 'browser_open',
          url: `${baseUrl}/checkout/processing-order?delay=40000`
        },
        {
          id: 'confirm-disconnected-order',
          type: 'inspect',
          missionAction: 'read_public_page',
          awaitMerchantOrderConfirmation: true,
          merchantConfirmationTimeoutMs: 75_000,
          expectedMilestone: 'order_submitted'
        }
      ]
    });
    session = {
      ...session,
      id: disconnectedSessionId,
      status: 'queued',
      claimedByPluginId: null,
      fulfillment: null,
      extensionCheckoutProfileEnabled: false,
      executionRequestedAt: new Date().toISOString(),
      missionBoundAuth: {
        ...session.missionBoundAuth,
        capabilityId: 'browser-smoke-active-port-disconnect-capability',
        subject: { sessionId: disconnectedSessionId },
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString()
      },
      extensionMissionPlan: disconnectedPlan,
      // This scenario begins after the irreversible click was already
      // dispatched. The only recoverable work is observing its merchant
      // confirmation, so retain that verified milestone explicitly.
      extensionMissionPlanState: {
        planHash: disconnectedPlan.planHash,
        nextActionIndex: 0,
        completedActionIds: [],
        verifiedMilestones: ['final_submit_requested']
      },
      missionBoundaryLatestHash: null,
      missionBoundaryEventCount: 0
    };
    const disconnectWakePage = await context.newPage();
    await disconnectWakePage.goto(`${baseUrl}/external-wake`);
    const disconnectedPort = await disconnectWakePage.evaluate(({ extensionId: targetExtensionId, sessionId }) => new Promise((resolve) => {
      const progress = [];
      const port = chrome.runtime.connect(targetExtensionId, { name: 'magic-city-active-run-v1' });
      const timer = setTimeout(() => resolve({ disconnected: false, progress, error: 'confirmation_progress_timeout' }), 25_000);
      port.onMessage.addListener((payload) => {
        if (payload?.type !== 'RUNNER_PROGRESS') return;
        progress.push(payload);
        if (payload?.activeRun?.actionId !== 'confirm-disconnected-order') return;
        clearTimeout(timer);
        port.disconnect();
        resolve({ disconnected: true, progress });
      });
      port.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
      });
      port.postMessage({ type: 'RUN_PENDING_SESSIONS', sessionId });
    }), { extensionId, sessionId: disconnectedSessionId });
    if (!disconnectedPort.disconnected) {
      fail(`browser_extension_active_port_disconnect_not_exercised:${JSON.stringify(disconnectedPort)}`);
    }
    const disconnectRecoveryCdp = await context.newCDPSession(disconnectWakePage);
    await disconnectRecoveryCdp.send('ServiceWorker.enable');
    await disconnectRecoveryCdp.send('ServiceWorker.stopAllWorkers');
    try {
      await waitFor(() => Boolean(fulfillment), 60_000);
    } catch {
      const runnerState = await popup.evaluate(() => new Promise((resolve) => {
        chrome.storage.local.get(['lastError', 'lastExecution', 'activeRun'], resolve);
      }));
      fail(`browser_extension_active_port_disconnect_recovery_timeout:${JSON.stringify({ runnerState, checkpoints })}`);
    }
    const disconnectWorkerStarts = [...new Set(checkpoints
      .map((checkpoint) => String(checkpoint?.runnerTiming?.workerStartedAt || ''))
      .filter(Boolean))];
    const disconnectedConfirmation = checkpoints.find((checkpoint) => checkpoint.planActionId === 'confirm-disconnected-order'
      && checkpoint.planActionStatus === 'completed');
    if (!fulfillment
      || disconnectedConfirmation?.browser?.orderSubmitted !== true
      || !disconnectedConfirmation?.verifiedMilestones?.includes('order_submitted')
      || disconnectWorkerStarts.length < 2) {
      fail(`browser_extension_active_port_disconnect_not_recovered:${JSON.stringify({ fulfillment, disconnectWorkerStarts, checkpoints })}`);
    }
    recordPurchaseScenario('Disconnected active port recovers a long read-only confirmation after MV3 restart', {
      progressPulsesBeforeDisconnect: disconnectedPort.progress.length,
      workerStarts: disconnectWorkerStarts.length,
      orderSubmitted: true
    });
    await disconnectWakePage.close();

    if (purchaseScenarioResults.length < 10) {
      fail(`browser_extension_purchase_matrix_incomplete:${JSON.stringify(purchaseScenarioResults)}`);
    }
    if (selectionRankRequestCount !== 0) {
      fail(`browser_extension_deterministic_path_called_selection_intelligence:${selectionRankRequestCount}`);
    }
    console.log(JSON.stringify({
      amazonPurchaseSimulations: purchaseScenarioResults.length,
      scenarios: purchaseScenarioResults
    }, null, 2));
    console.log('native-runner browser extension smoke passed');
  } finally {
    clearInterval(keepAlive);
    await context?.close();
    await new Promise((resolve) => server?.close(resolve) ?? resolve());
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
}
