import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { amazonProductAsin, amazonProductUrlMatches } from '../public/native-runner/extension/amazon-selection.js';

assert.equal(
  amazonProductAsin('https://www.amazon.com/Nature-Valley-Crunchy/dp/B0F2PWJV7D/ref=sr_1_1'),
  'B0F2PWJV7D',
  'slugged Amazon product URLs retain their ASIN'
);
assert.equal(
  amazonProductAsin('https://www.amazon.com/gp/product/B000NVGOOD'),
  'B000NVGOOD',
  'canonical Amazon product URLs retain their ASIN'
);
assert.notEqual(
  amazonProductAsin('https://www.amazon.com/Nature-Valley/dp/B0F2PWJV7D'),
  amazonProductAsin('https://www.amazon.com/Nature-Valley/dp/B0F2PWJV7E'),
  'different-ASIN redirects remain distinguishable'
);
assert.equal(
  amazonProductUrlMatches(
    'https://www.amazon.com/dp/B0F2PWJV7D',
    'https://www.amazon.com/Nature-Valley-Crunchy/dp/B0F2PWJV7D/ref=sr_1_1'
  ),
  true,
  'slugged redirects for the selected ASIN are accepted'
);
assert.equal(
  amazonProductUrlMatches(
    'https://www.amazon.com/dp/B0F2PWJV7D',
    'https://www.amazon.com/Nature-Valley-Crunchy/dp/B0F2PWJV7E/ref=sr_1_1'
  ),
  false,
  'redirects to a different ASIN are rejected'
);

const root = path.resolve(new URL('..', import.meta.url).pathname);
const fixtureDir = process.env.MAGIC_CITY_AMAZON_SELECTION_FIXTURE_DIR
  ? path.resolve(process.env.MAGIC_CITY_AMAZON_SELECTION_FIXTURE_DIR)
  : path.join(root, 'artifacts/amazon-selection-calibration-100-2026-09-12');
const destination = process.env.MAGIC_CITY_AMAZON_SELECTION_OUTPUT_DIR
  ? path.resolve(process.env.MAGIC_CITY_AMAZON_SELECTION_OUTPUT_DIR)
  : path.join(fixtureDir, 'shadow-v10/production-candidate');
const audit = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'shadow-v10/final/audit.json'), 'utf8'));
const sourcePath = path.join(root, 'public/native-runner/extension/amazon-selection.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'magic-selection-production-shadow-'));
const extension = path.join(temp, 'extension');
fs.mkdirSync(extension);
fs.mkdirSync(destination, { recursive: true });
fs.copyFileSync(sourcePath, path.join(extension, 'amazon-selection.js'));
fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify({
  manifest_version: 3,
  name: 'Magic City production selection shadow',
  version: '0.0.1',
  permissions: ['tabs', 'scripting'],
  host_permissions: ['https://www.amazon.com/*'],
  background: { service_worker: 'background.js', type: 'module' }
}));
fs.writeFileSync(path.join(extension, 'background.js'), `
  import { selectAmazonSearchCard } from './amazon-selection.js';
  globalThis.setSelectionFixture = async (tabId, html) => chrome.scripting.executeScript({
    target: { tabId },
    func: (fixture) => { document.body.innerHTML = fixture; },
    args: [html]
  });
  globalThis.runSelectionShadow = async (tabId, action) => {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: selectAmazonSearchCard,
      args: [action, false]
    });
    return result[0]?.result || null;
  };
  globalThis.runSelectionAction = async (tabId, action) => {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: selectAmazonSearchCard,
      args: [action, true]
    });
    return result[0]?.result || null;
  };
`);

const output = {
  scope: 'Production-candidate selector in an MV3 isolated world over 100 saved Amazon DOM fixtures; clicks and external network blocked.',
  sourceSha256: hash(source),
  startedAt: new Date().toISOString(),
  items: [],
  networkBlocked: 0,
  mutationNetworkAttempts: 0
};
let activeHtml = '';
let context;
try {
  context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
    headless: false,
    viewport: { width: 1440, height: 1050 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  await context.route('**/*', (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.isNavigationRequest()
      && request.method() === 'GET'
      && url.hostname === 'www.amazon.com'
      && url.pathname === '/s'
      && url.searchParams.has('productionSelectionShadow')) {
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        headers: { 'content-security-policy': "script-src 'none'; connect-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'; frame-src 'none'; object-src 'none'" },
        body: activeHtml
      });
    }
    output.networkBlocked += 1;
    if (!['GET', 'HEAD'].includes(request.method()) || /cart|checkout|buy|order/i.test(url.pathname)) output.mutationNetworkAttempts += 1;
    return route.abort('blockedbyclient');
  });
  await context.addInitScript(() => {
    globalThis.__selectionGuard = { clicks: 0, forms: 0 };
    const originalClick = HTMLElement.prototype.click;
    HTMLElement.prototype.click = function guardedClick() {
      globalThis.__selectionGuard.clicks += 1;
      return originalClick.call(this);
    };
    HTMLFormElement.prototype.submit = function guardedSubmit() {
      globalThis.__selectionGuard.forms += 1;
      throw new Error('selection_shadow_form_forbidden');
    };
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const page = await context.newPage();
  const replayLimit = Math.max(1, Number(process.env.SELECTION_SHADOW_LIMIT || audit.rows.length));
  const replayRows = process.env.SELECTION_SHADOW_FIXTURE_ONLY === '1' ? [] : audit.rows.slice(0, replayLimit);
  for (const expected of replayRows) {
    activeHtml = fs.readFileSync(path.join(fixtureDir, `${String(expected.id).padStart(2, '0')}-search.html`), 'utf8');
    const url = `https://www.amazon.com/s?productionSelectionShadow=${expected.id}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    const started = performance.now();
    const result = await worker.evaluate(async ({ url, action }) => {
      const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url === url);
      if (!tab) throw new Error('selection_shadow_tab_missing');
      return globalThis.runSelectionShadow(tab.id, action);
    }, {
      url,
      action: {
        type: 'select_candidate',
        query: expected.request,
        maxPrice: expected.cap,
        candidatePolicy: 'price_quality_delivery_preference',
        fulfillmentPolicy: 'amazon_free_shipping_preferred',
        primeRequired: false
      }
    });
    const guard = await page.evaluate(() => globalThis.__selectionGuard);
    assert.equal(guard.clicks, 0, `fixture ${expected.id} click`);
    assert.equal(guard.forms, 0, `fixture ${expected.id} form`);
    output.items.push({
      id: expected.id,
      request: expected.request,
      expectedClassification: expected.classification,
      expectedAsin: expected.asin,
      selectionKind: result?.selectionKind || 'none',
      selectedAsin: result?.selected?.asin || result?.proposedCandidate?.asin || null,
      result,
      elapsedMs: performance.now() - started
    });
    if (result?.selectionKind === 'size_alternative') {
      assert.equal(result.completed, false, `fixture ${expected.id} closest-size completion`);
      assert.equal(result.requiresApproval, true, `fixture ${expected.id} closest-size approval`);
      assert.ok(result.proposedCandidate?.asin, `fixture ${expected.id} closest-size proposed candidate`);
    }
  }
  const wrongProductFixtures = [
    { id: 27, product: 'Ziploc Gallon Freezer Bags', bad: 'Ziploc Half Gallon Freezer Bags, Food Storage, 12 Count' },
    { id: 28, product: 'Ziploc Sandwich Bags', bad: 'Ziploc Sandwich and Snack Bags, Plastic Food Storage Bags, 12 Count' },
    { id: 39, product: 'OXO Good Grips POP Container', bad: 'OXO Good Grips POP Container Brown Sugar Keeper, 12 Count' },
    { id: 51, product: 'Neutrogena Hydro Boost Water Gel', bad: 'Neutrogena Hydro Boost Tint Foundation Makeup Water Gel, 12 Count' },
    { id: 60, product: 'Gillette Fusion5 Razor Blades', bad: 'Gillette Fusion5 Razor Handle Kit, 12 Count' },
    { id: 85, product: 'Gatorade Thirst Quencher Variety Pack', bad: 'Gatorade Thirst Quencher Powder Drink Mix Variety Pack, 12 Count' }
  ];
  const escapeHtml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const cardHtml = (asin, title) => `
    <div data-component-type="s-search-result" data-asin="${asin}" style="display:block;width:600px;min-height:160px">
      <div data-cy="title-recipe"><h2><a href="/dp/${asin}">${escapeHtml(title)}</a></h2></div>
      <span class="a-price"><span class="a-offscreen">$5.00</span></span>
      <button style="display:block;width:120px;height:32px">Add to cart</button>
    </div>`;
  output.wrongProductRegressions = [];
  const regressionTab = (await worker.evaluate(async () => (await chrome.tabs.query({ active: true }))[0]))?.id;
  assert.ok(regressionTab, 'wrong-product regression tab');
  for (const fixture of wrongProductFixtures) {
    const action = { query: `${fixture.product}, 12 ct`, maxPrice: 10, primeRequired: false };
    await worker.evaluate(({ tabId, html }) => globalThis.setSelectionFixture(tabId, html), {
      tabId: regressionTab,
      html: cardHtml('B000000001', fixture.bad)
    });
    const badOnly = await worker.evaluate(({ tabId, action }) => globalThis.runSelectionShadow(tabId, action), { tabId: regressionTab, action });
    await worker.evaluate(({ tabId, html }) => globalThis.setSelectionFixture(tabId, html), {
      tabId: regressionTab,
      html: cardHtml('B000000001', fixture.bad) + cardHtml('B000000002', `${fixture.product}, 12 Count`)
    });
    const withSibling = await worker.evaluate(({ tabId, action }) => globalThis.runSelectionShadow(tabId, action), { tabId: regressionTab, action });
    const record = {
      id: fixture.id,
      badOnly: badOnly?.selectionKind || null,
      intelligenceCandidates: badOnly?.intelligenceCandidates || [],
      selectedWithSibling: withSibling?.selected?.asin || withSibling?.proposedCandidate?.asin || null
    };
    output.wrongProductRegressions.push(record);
    assert.equal(record.badOnly, 'no_verified_candidate', `wrong-product fixture ${fixture.id}`);
    assert.equal(badOnly?.intelligenceCandidates?.length || 0, 0, `wrong-product fixture ${fixture.id} is not offered to intelligence`);
    assert.equal(record.selectedWithSibling, 'B000000002', `valid sibling fixture ${fixture.id}`);
  }

  const semanticCards = [
    cardHtml('B000FRUIT1', 'Nature Valley Mixed Berry Crunchy Granola Bars'),
    cardHtml('B000FRUIT2', 'Nature Valley Cranberry Pomegranate Granola Bars'),
    cardHtml('B000PEANUT', 'Nature Valley Peanut Butter Granola Bars')
  ].join('');
  await worker.evaluate(({ tabId, html }) => globalThis.setSelectionFixture(tabId, html), {
    tabId: regressionTab,
    html: semanticCards
  });
  await page.evaluate(() => { globalThis.__selectionGuard.clicks = 0; });
  output.selectionIntelligenceInitialFixture = await worker.evaluate(({ tabId }) => globalThis.runSelectionAction(tabId, {
    type: 'select_candidate', query: 'fruity Nature Valley granola bars', maxPrice: 6, primeRequired: false
  }), { tabId: regressionTab });
  let intelligenceGuard = await page.evaluate(() => globalThis.__selectionGuard);
  assert.equal(output.selectionIntelligenceInitialFixture?.selectionKind, 'no_verified_candidate', 'semantic wording keeps the first pass non-mutating');
  assert.equal(output.selectionIntelligenceInitialFixture?.completed, false, 'semantic wording requires bounded advice');
  assert.equal(output.selectionIntelligenceInitialFixture?.intelligenceCandidates?.length, 2, 'only fruit-compatible semantic candidates are observed');
  assert.deepEqual(
    output.selectionIntelligenceInitialFixture.intelligenceCandidates.map((candidate) => candidate.asin),
    ['B000FRUIT1', 'B000FRUIT2'],
    'the soft fruity preference cannot admit a conflicting peanut-butter flavor'
  );
  assert.equal(intelligenceGuard.clicks, 0, 'semantic candidate collection never clicks');

  const approvedSemanticCandidate = output.selectionIntelligenceInitialFixture.intelligenceCandidates[0];
  await page.evaluate(() => {
    globalThis.__selectionGuard.clicks = 0;
    document.querySelectorAll('button').forEach((button) => {
      button.addEventListener('click', () => { globalThis.__selectionGuard.clicks += 1; });
    });
  });
  output.selectionIntelligenceApprovedFixture = await worker.evaluate(({ tabId, approved }) => globalThis.runSelectionAction(tabId, {
    type: 'select_candidate',
    query: 'fruity Nature Valley granola bars',
    maxPrice: 6,
    primeRequired: false,
    intelligenceApprovedCandidate: approved
  }), { tabId: regressionTab, approved: approvedSemanticCandidate });
  intelligenceGuard = await page.evaluate(() => globalThis.__selectionGuard);
  assert.equal(output.selectionIntelligenceApprovedFixture?.selectionKind, 'model_assisted', 'observed semantic candidate is identified as model-assisted');
  assert.equal(output.selectionIntelligenceApprovedFixture?.selected?.asin, approvedSemanticCandidate.asin, 'approved candidate remains bound to its ASIN');
  assert.equal(output.selectionIntelligenceApprovedFixture?.completed, true, 'fresh observed semantic candidate can use the existing cart path');
  assert.equal(intelligenceGuard.clicks, 1, 'approved semantic candidate clicks exactly once');

  await worker.evaluate(({ tabId, html }) => globalThis.setSelectionFixture(tabId, html), {
    tabId: regressionTab,
    html: cardHtml('B000FRUIT3', 'Nature Valley Blueberry Granola Bars') + semanticCards
  });
  await page.evaluate(() => { globalThis.__selectionGuard.clicks = 0; });
  output.selectionIntelligenceReorderedFixture = await worker.evaluate(({ tabId, approved }) => globalThis.runSelectionAction(tabId, {
    type: 'select_candidate',
    query: 'fruity Nature Valley granola bars',
    maxPrice: 6,
    primeRequired: false,
    intelligenceApprovedCandidate: approved
  }), { tabId: regressionTab, approved: approvedSemanticCandidate });
  intelligenceGuard = await page.evaluate(() => globalThis.__selectionGuard);
  assert.equal(output.selectionIntelligenceReorderedFixture?.selectionKind, 'model_assisted', 'card reordering does not detach advice from its ASIN');
  assert.equal(output.selectionIntelligenceReorderedFixture?.selected?.asin, approvedSemanticCandidate.asin, 'reordered advice remains bound to the approved ASIN');
  assert.equal(intelligenceGuard.clicks, 1, 'reordered advice clicks only the approved ASIN');

  const hydrationCard = (delivery = '') => `
    <div data-component-type="s-search-result" data-asin="B000HYDRAT" style="display:block;width:600px;min-height:160px">
      <div data-cy="title-recipe"><h2><a href="/dp/B000HYDRAT">Nature Valley Trail Mix Chewy Fruit & Nut Granola Bar, 6 ct, 7.4 oz</a></h2></div>
      <span class="a-price"><span class="a-offscreen">$5.00</span></span>
      ${delivery}
    </div>`;
  await worker.evaluate(({ tabId, html }) => globalThis.setSelectionFixture(tabId, html), {
    tabId: regressionTab,
    html: hydrationCard('')
  });
  const hydrationInitial = await worker.evaluate(({ tabId }) => globalThis.runSelectionShadow(tabId, {
    type: 'select_candidate', query: 'fruity Nature Valley granola bars', maxPrice: 6, primeRequired: true
  }), { tabId: regressionTab });
  const hydrationApproved = hydrationInitial?.intelligenceCandidates?.[0];
  assert.equal(hydrationApproved?.requiresProductPageVerification, true, 'inconclusive fulfillment requires product-page verification');
  await worker.evaluate(({ tabId, html }) => globalThis.setSelectionFixture(tabId, html), {
    tabId: regressionTab,
    html: hydrationCard('<span aria-label="Amazon Prime">Prime delivery</span><span>FREE delivery on $35 of qualifying items</span>')
  });
  output.selectionIntelligenceHydrationFixture = await worker.evaluate(({ tabId, approved }) => globalThis.runSelectionShadow(tabId, {
    type: 'select_candidate',
    query: 'fruity Nature Valley granola bars',
    maxPrice: 6,
    primeRequired: true,
    intelligenceApprovedCandidate: approved
  }), { tabId: regressionTab, approved: hydrationApproved });
  assert.equal(
    output.selectionIntelligenceHydrationFixture?.selectionKind,
    'model_assisted_product_page_verification',
    'hydrated delivery evidence advances only to bounded product-page verification'
  );
  assert.equal(output.selectionIntelligenceHydrationFixture?.selected?.asin, hydrationApproved.asin, 'hydration remains bound to the approved ASIN');

  await worker.evaluate(({ tabId, html }) => globalThis.setSelectionFixture(tabId, html), {
    tabId: regressionTab,
    html: semanticCards.replace('$5.00', '$5.50')
  });
  await page.evaluate(() => { globalThis.__selectionGuard.clicks = 0; });
  output.selectionIntelligenceStaleFixture = await worker.evaluate(({ tabId, approved }) => globalThis.runSelectionAction(tabId, {
    type: 'select_candidate',
    query: 'fruity Nature Valley granola bars',
    maxPrice: 6,
    primeRequired: false,
    intelligenceApprovedCandidate: approved
  }), { tabId: regressionTab, approved: approvedSemanticCandidate });
  intelligenceGuard = await page.evaluate(() => globalThis.__selectionGuard);
  assert.equal(output.selectionIntelligenceStaleFixture?.intelligenceRevalidationFailed, true, 'changed candidate evidence is rejected');
  assert.equal(output.selectionIntelligenceStaleFixture?.completed, false, 'stale advice cannot complete selection');
  assert.equal(intelligenceGuard.clicks, 0, 'stale advice produces zero clicks');

  await worker.evaluate(({ tabId, html }) => globalThis.setSelectionFixture(tabId, html), {
    tabId: regressionTab,
    html: semanticCards
  });
  output.selectionIntelligenceStrictVariantFixture = await worker.evaluate(({ tabId }) => globalThis.runSelectionShadow(tabId, {
    type: 'select_candidate', query: 'fruity Nature Valley granola bars, flavor Mixed Berry', maxPrice: 6, primeRequired: false
  }), { tabId: regressionTab });
  assert.equal(output.selectionIntelligenceStrictVariantFixture?.selectionKind, 'no_verified_candidate', 'explicit variant remains deterministic');
  assert.equal(output.selectionIntelligenceStrictVariantFixture?.intelligenceCandidates?.length || 0, 0, 'explicit variant cannot enter semantic fallback');

  await worker.evaluate(({ tabId, html }) => globalThis.setSelectionFixture(tabId, html), {
    tabId: regressionTab,
    html: cardHtml('B000EXACT1', 'Nature Valley Granola Bars')
  });
  await page.evaluate(() => {
    globalThis.__selectionGuard.clicks = 0;
    document.querySelector('button')?.addEventListener('click', () => { globalThis.__selectionGuard.clicks += 1; });
  });
  output.selectionIntelligenceExactControl = await worker.evaluate(({ tabId }) => globalThis.runSelectionAction(tabId, {
    type: 'select_candidate', query: 'Nature Valley granola bars', maxPrice: 6, primeRequired: false
  }), { tabId: regressionTab });
  intelligenceGuard = await page.evaluate(() => globalThis.__selectionGuard);
  assert.equal(output.selectionIntelligenceExactControl?.selectionKind, 'exact', 'valid exact match keeps the deterministic fast path');
  assert.equal(output.selectionIntelligenceExactControl?.completed, true, 'valid exact match still completes selection');
  assert.equal(intelligenceGuard.clicks, 1, 'valid exact match clicks exactly once');
  await worker.evaluate(({ tabId, html }) => globalThis.setSelectionFixture(tabId, html), {
    tabId: regressionTab,
    html: '<div data-component-type="s-search-result" data-asin="B000SMOKE1" style="display:block;width:600px;min-height:160px"><h2><a href="/dp/test-gadget">Test gadget</a></h2><span class="a-price"><span class="a-offscreen">$3.50</span></span><span aria-label="Amazon Prime">Prime delivery</span><span>FREE delivery</span><button style="display:block;width:120px;height:32px">Add to cart</button></div>'
  });
  output.packagedFixture = await worker.evaluate(({ tabId }) => globalThis.runSelectionShadow(tabId, {
    type: 'select_candidate', query: 'test gadget', maxPrice: null, primeRequired: true
  }), { tabId: regressionTab });
  assert.equal(output.packagedFixture?.selectionKind, 'exact', 'packaged lifecycle fixture');
  await worker.evaluate(({ tabId, html }) => globalThis.setSelectionFixture(tabId, html), {
    tabId: regressionTab,
    html: '<div data-component-type="s-search-result" data-asin="B000MIX001" style="display:block;width:600px;min-height:160px"><h2><a href="/dp/mixed-offer">Test gadget</a></h2><span class="a-price"><span class="a-offscreen">$3.50</span></span><span aria-label="Amazon Prime">Prime delivery</span><div>FREE delivery Tomorrow</div><div>Or FREE delivery on $25 of qualifying items</div><button style="display:block;width:120px;height:32px">Add to cart</button></div>'
  });
  output.mixedShippingFixture = await worker.evaluate(({ tabId }) => globalThis.runSelectionShadow(tabId, {
    type: 'select_candidate', query: 'test gadget', maxPrice: 4, primeRequired: true
  }), { tabId: regressionTab });
  assert.equal(output.mixedShippingFixture?.selectionKind, 'exact', 'unconditional Prime offer survives a separate conditional offer');
  assert.equal(output.mixedShippingFixture?.selected?.asin, 'B000MIX001', 'mixed shipping exact candidate');
  await worker.evaluate(({ tabId, html }) => globalThis.setSelectionFixture(tabId, html), {
    tabId: regressionTab,
    html: '<div data-component-type="s-search-result" data-asin="B000SPLIT1" style="display:block;width:600px;min-height:160px"><h2><a href="/dp/split-shipping">Test gadget</a></h2><span class="a-price"><span class="a-offscreen">$3.50</span></span><span aria-label="Amazon Prime">Prime delivery</span><div><span>FREE delivery</span><span> on $35 of qualifying items</span></div><button style="display:block;width:120px;height:32px">Add to cart</button></div>'
  });
  await page.evaluate(() => { globalThis.__selectionGuard.clicks = 0; });
  output.splitConditionalShippingFixture = await worker.evaluate(({ tabId }) => globalThis.runSelectionAction(tabId, {
    type: 'select_candidate', query: 'test gadget', maxPrice: 4, primeRequired: true
  }), { tabId: regressionTab });
  const splitShippingGuard = await page.evaluate(() => globalThis.__selectionGuard);
  assert.equal(output.splitConditionalShippingFixture?.selectionKind, 'exact_product_page_verification', 'split conditional shipping requires product-page verification');
  assert.equal(output.splitConditionalShippingFixture?.requiresProductPageVerification, true, 'split conditional shipping verification flag');
  assert.equal(splitShippingGuard.clicks, 0, 'split conditional shipping does not click cart');
  await worker.evaluate(({ tabId, html }) => globalThis.setSelectionFixture(tabId, html), {
    tabId: regressionTab,
    html: '<div data-component-type="s-search-result" data-asin="B000MULT01" style="display:block;width:600px;min-height:160px"><h2><a href="/dp/multiple-prices">Test gadget</a></h2><div>One-time purchase <span class="a-price"><span class="a-offscreen">$3.50</span></span></div><div>Subscribe &amp; Save <span class="a-price"><span class="a-offscreen">$3.15</span></span></div><span aria-label="Amazon Prime">Prime delivery</span><div>FREE delivery Tomorrow</div><button style="display:block;width:120px;height:32px">Add to cart</button></div>'
  });
  await page.evaluate(() => { globalThis.__selectionGuard.clicks = 0; });
  output.multiplePriceFixture = await worker.evaluate(({ tabId }) => globalThis.runSelectionAction(tabId, {
    type: 'select_candidate', query: 'test gadget', maxPrice: 4, primeRequired: true
  }), { tabId: regressionTab });
  const multiplePriceGuard = await page.evaluate(() => globalThis.__selectionGuard);
  assert.equal(output.multiplePriceFixture?.selectionKind, 'exact_product_page_verification', 'multiple offer prices require product-page verification');
  assert.equal(output.multiplePriceFixture?.requiresProductPageVerification, true, 'multiple offer price verification flag');
  assert.equal(output.multiplePriceFixture?.navigationRequested, true, 'multiple offer price product navigation');
  assert.equal(multiplePriceGuard.clicks, 0, 'multiple offer price does not click cart');
  await worker.evaluate(({ tabId, html }) => globalThis.setSelectionFixture(tabId, html), {
    tabId: regressionTab,
    html: '<div data-component-type="s-search-result" data-asin="B000WRONG1" style="display:block;width:600px;min-height:160px"><h2><a href="/dp/wrong-product">Wrong replacement accessory</a></h2><div><span class="a-price"><span class="a-offscreen">$3.50</span></span></div><div><span class="a-price"><span class="a-offscreen">$3.15</span></span></div><span aria-label="Amazon Prime">Prime delivery</span><div>FREE delivery Tomorrow</div></div>'
  });
  output.wrongProductVerificationFixture = await worker.evaluate(({ tabId }) => globalThis.runSelectionShadow(tabId, {
    type: 'select_candidate', query: 'test gadget', maxPrice: 4, primeRequired: true
  }), { tabId: regressionTab });
  assert.equal(output.wrongProductVerificationFixture?.selectionKind, 'no_verified_candidate', 'wrong product cannot enter product-page verification');
  await worker.evaluate(({ tabId, html }) => globalThis.setSelectionFixture(tabId, html), {
    tabId: regressionTab,
    html: cardHtml('NATURE-VALLEY-UNAVAILABLE', 'Nature Valley Crunchy Granola Bars')
      + cardHtml('NATURE-VALLEY-LOCAL-MARKET', 'Nature Valley Crunchy Granola Bars')
      + '<div data-component-type="s-search-result" data-asin="B000NVGOOD" style="display:block;width:600px;min-height:160px"><h2><a href="/dp/nature-valley-valid">Nature Valley Oats n Honey Granola Bars</a></h2><span class="a-price">$3.50</span><span aria-label="Amazon Prime">Prime delivery</span><span>FREE delivery Tomorrow</span><button style="display:block;width:120px;height:32px">Add to cart</button></div>'
  });
  output.brandFixture = await worker.evaluate(({ tabId }) => globalThis.runSelectionShadow(tabId, {
    type: 'select_candidate', query: 'nature valley granol abars', maxPrice: 4, primeRequired: true
  }), { tabId: regressionTab });
  assert.equal(output.brandFixture?.selected?.asin, 'B000NVGOOD', 'brand lifecycle fixture');
  await worker.evaluate(({ tabId, html }) => globalThis.setSelectionFixture(tabId, html), {
    tabId: regressionTab,
    html: cardHtml('B000SIZE12', 'Test Wipes, 12 Count')
  });
  await page.evaluate(() => {
    globalThis.__selectionGuard.clicks = 0;
    document.querySelector('button')?.addEventListener('click', () => { globalThis.__selectionGuard.clicks += 1; });
  });
  output.closestSizeReviewFixture = await worker.evaluate(({ tabId }) => globalThis.runSelectionAction(tabId, {
    type: 'select_candidate', query: 'test wipes, 24 ct', maxPrice: 10, primeRequired: false
  }), { tabId: regressionTab });
  let closestSizeGuard = await page.evaluate(() => globalThis.__selectionGuard);
  assert.equal(output.closestSizeReviewFixture?.selectionKind, 'size_alternative', 'closest-size review fixture');
  assert.equal(output.closestSizeReviewFixture?.completed, false, 'closest-size review completion');
  assert.equal(output.closestSizeReviewFixture?.requiresApproval, true, 'closest-size review authorization');
  assert.equal(output.closestSizeReviewFixture?.proposedCandidate?.asin, 'B000SIZE12', 'closest-size review identity');
  assert.equal(closestSizeGuard.clicks, 0, 'unapproved closest-size action does not click');
  await page.evaluate(() => { globalThis.__selectionGuard.clicks = 0; });
  output.closestSizeAuthorizedFixture = await worker.evaluate(({ tabId }) => globalThis.runSelectionAction(tabId, {
    type: 'select_candidate', query: 'test wipes, 24 ct', maxPrice: 10, primeRequired: false, allowSizeSubstitution: true
  }), { tabId: regressionTab });
  closestSizeGuard = await page.evaluate(() => globalThis.__selectionGuard);
  assert.equal(output.closestSizeAuthorizedFixture?.selectionKind, 'size_alternative', 'authorized closest-size action fixture');
  assert.equal(output.closestSizeAuthorizedFixture?.completed, true, 'authorized closest-size action completion');
  assert.equal(output.closestSizeAuthorizedFixture?.selected?.asin, 'B000SIZE12', 'authorized closest-size action identity');
  assert.equal(closestSizeGuard.clicks, 1, 'authorized closest-size action clicks once');

  await worker.evaluate(({ tabId, html }) => globalThis.setSelectionFixture(tabId, html), {
    tabId: regressionTab,
    html: cardHtml('B000BAR006', 'Test Bars, 6 Bars, 8 oz')
  });
  output.compoundSizeMismatchFixture = await worker.evaluate(({ tabId }) => globalThis.runSelectionAction(tabId, {
    type: 'select_candidate', query: 'test bars, 12 bars, 8 oz', maxPrice: 10, primeRequired: false
  }), { tabId: regressionTab });
  assert.equal(output.compoundSizeMismatchFixture?.selectionKind, 'size_alternative', 'compound count and weight mismatch');
  assert.equal(output.compoundSizeMismatchFixture?.requiresApproval, true, 'compound mismatch requires approval');
  assert.equal(output.compoundSizeMismatchFixture?.completed, false, 'compound mismatch is not exact');

  await worker.evaluate(({ tabId, html }) => globalThis.setSelectionFixture(tabId, html), {
    tabId: regressionTab,
    html: cardHtml('B000BAR006', 'Test Bars, 6 Bars, 8 oz') + cardHtml('B000BAR012', 'Test Bars, 12 Bars, 8 oz')
  });
  output.compoundSizeExactFixture = await worker.evaluate(({ tabId }) => globalThis.runSelectionShadow(tabId, {
    type: 'select_candidate', query: 'test bars, 12 bars, 8 oz', maxPrice: 10, primeRequired: false
  }), { tabId: regressionTab });
  assert.equal(output.compoundSizeExactFixture?.selectionKind, 'exact', 'compound count and weight exact');
  assert.equal(output.compoundSizeExactFixture?.selected?.asin, 'B000BAR012', 'compound exact identity');

  await worker.evaluate(({ tabId, html }) => globalThis.setSelectionFixture(tabId, html), {
    tabId: regressionTab,
    html: cardHtml('B00CNFLT01', 'Test Popcorn, 18 Count Individual Bags, 0.65 oz and 8 oz')
  });
  output.conflictingPackageFixture = await worker.evaluate(({ tabId }) => globalThis.runSelectionAction(tabId, {
    type: 'select_candidate', query: 'test popcorn, 18 x 0.65 oz', maxPrice: 10, primeRequired: false
  }), { tabId: regressionTab });
  assert.equal(output.conflictingPackageFixture?.selectionKind, 'no_verified_candidate', 'conflicting package evidence');
  assert.equal(output.conflictingPackageFixture?.completed, false, 'conflicting package evidence abstains');
  assert.equal(output.conflictingPackageFixture?.scan?.rejected?.package, 1, 'conflicting package evidence is rejected by package validation');
  output.finishedAt = new Date().toISOString();
  output.summary = output.items.reduce((summary, item) => {
    summary[item.selectionKind] = (summary[item.selectionKind] || 0) + 1;
    if (item.selectedAsin === item.expectedAsin) summary.expectedAsinMatches += 1;
    return summary;
  }, { expectedAsinMatches: 0 });
  assert.equal(output.mutationNetworkAttempts, 0);
} finally {
  await context?.close();
  fs.writeFileSync(path.join(destination, 'results.json'), JSON.stringify(output, null, 2));
}

const report = [
  '# Production Candidate Selection Replay',
  '',
  `Source SHA-256: \`${output.sourceSha256}\``,
  '',
  `Result: ${output.summary?.exact || 0} exact, ${output.summary?.size_alternative || 0} review-only closest-size alternatives, ${output.summary?.no_verified_candidate || 0} abstentions.`,
  '',
  '| # | Request | Prior review | Candidate result | ASIN |',
  '|---:|---|---|---|---|',
  ...output.items.map((item) => {
    const result = item.selectionKind === 'exact'
      ? 'exact'
      : item.selectionKind === 'size_alternative'
        ? 'closest size (review)'
        : 'abstain';
    return `| ${item.id} | ${String(item.request).replaceAll('|', '\\|')} | ${item.expectedClassification} | ${result} | ${item.selectedAsin ? `\`${item.selectedAsin}\`` : '-'} |`;
  }),
  '',
  '## Wrong-product controls',
  '',
  '| Fixture | Bad card alone | Valid sibling |',
  '|---:|---|---|',
  ...(output.wrongProductRegressions || []).map((item) => `| ${item.id} | ${item.badOnly} | \`${item.selectedWithSibling}\` |`),
  ''
].join('\n');
fs.writeFileSync(path.join(destination, 'REVIEW.md'), report);

console.log(JSON.stringify(output.summary, null, 2));
