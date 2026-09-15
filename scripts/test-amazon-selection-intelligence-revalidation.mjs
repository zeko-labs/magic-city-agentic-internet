import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { selectAmazonSearchCard } from '../public/native-runner/extension/amazon-selection.js';

const runSelection = (page, action, performClick = false) => page.evaluate(
  ({ source, input, click }) => (0, eval)(`(${source})`)(input, click),
  { source: selectAmazonSearchCard.toString(), input: action, click: performClick }
);

const card = ({ asin, title, price = '5.00', delivery = '', clickable = false }) => `
  <div data-component-type="s-search-result" data-asin="${asin}" style="display:block;width:600px;min-height:160px">
    <div data-cy="title-recipe"><h2><a href="/dp/${asin}">${title}</a></h2></div>
    <span class="a-price"><span class="a-offscreen">$${price}</span></span>
    ${delivery}
    ${clickable ? '<button onclick="window.__clicks += 1">Add to cart</button>' : ''}
  </div>`;

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
try {
  await page.setContent([
    '<script>window.__clicks = 0</script>',
    card({ asin: 'B000FRUIT1', title: 'Nature Valley Mixed Berry Crunchy Granola Bars', clickable: true }),
    card({ asin: 'B000FRUIT2', title: 'Nature Valley Cranberry Pomegranate Granola Bars', clickable: true })
  ].join(''));
  const initial = await runSelection(page, {
    type: 'select_candidate', query: 'fruity Nature Valley granola bars', maxPrice: 6, primeRequired: false
  });
  const approved = initial.intelligenceCandidates[0];
  await page.setContent([
    '<script>window.__clicks = 0</script>',
    card({ asin: 'B000FRUIT3', title: 'Nature Valley Blueberry Granola Bars', clickable: true }),
    card({ asin: 'B000FRUIT1', title: 'Nature Valley Mixed Berry Crunchy Granola Bars', clickable: true }),
    card({ asin: 'B000FRUIT2', title: 'Nature Valley Cranberry Pomegranate Granola Bars', clickable: true })
  ].join(''));
  const reordered = await runSelection(page, {
    type: 'select_candidate',
    query: 'fruity Nature Valley granola bars',
    maxPrice: 6,
    primeRequired: false,
    intelligenceApprovedCandidate: approved
  }, true);
  assert.equal(reordered.selectionKind, 'model_assisted');
  assert.equal(reordered.selected.asin, approved.asin);
  assert.equal(await page.evaluate(() => window.__clicks), 1);

  await page.setContent([
    '<script>window.__clicks = 0</script>',
    card({ asin: approved.asin, title: approved.title, price: '5.50', clickable: true })
  ].join(''));
  const stalePrice = await runSelection(page, {
    type: 'select_candidate',
    query: 'fruity Nature Valley granola bars',
    maxPrice: 6,
    primeRequired: false,
    intelligenceApprovedCandidate: approved
  }, true);
  assert.equal(stalePrice.intelligenceRevalidationFailed, true);
  assert.equal(await page.evaluate(() => window.__clicks), 0);

  await page.setContent([
    '<script>window.__clicks = 0</script>',
    card({ asin: approved.asin, title: 'Nature Valley Peanut Butter Granola Bars', clickable: true })
  ].join(''));
  const wrongVariant = await runSelection(page, {
    type: 'select_candidate',
    query: 'fruity Nature Valley granola bars',
    maxPrice: 6,
    primeRequired: false,
    intelligenceApprovedCandidate: approved
  }, true);
  assert.equal(wrongVariant.intelligenceRevalidationFailed, true);
  assert.equal(await page.evaluate(() => window.__clicks), 0);

  await page.setContent(card({
    asin: 'B000HYDRAT',
    title: 'Nature Valley Trail Mix Chewy Fruit & Nut Granola Bar, 6 ct, 7.4 oz'
  }));
  const hydrationInitial = await runSelection(page, {
    type: 'select_candidate', query: 'fruity Nature Valley granola bars', maxPrice: 6, primeRequired: true
  });
  const hydrationApproved = hydrationInitial.intelligenceCandidates[0];
  assert.equal(hydrationApproved.requiresProductPageVerification, true);
  await page.setContent(card({
    asin: 'B000HYDRAT',
    title: 'Nature Valley Trail Mix Chewy Fruit & Nut Granola Bar, 6 ct, 7.4 oz',
    delivery: '<span aria-label="Amazon Prime">Prime delivery</span><span>FREE delivery on $35 of qualifying items</span>'
  }));
  const hydrated = await runSelection(page, {
    type: 'select_candidate',
    query: 'fruity Nature Valley granola bars',
    maxPrice: 6,
    primeRequired: true,
    intelligenceApprovedCandidate: hydrationApproved
  });
  assert.equal(hydrated.selectionKind, 'model_assisted_product_page_verification');
  assert.equal(hydrated.selected.asin, hydrationApproved.asin);
  assert.equal(hydrated.requiresProductPageVerification, true);

  await page.setContent(card({
    asin: 'B000SMORES',
    title: "HERSHEY'S mores Kit Box, 14 oz"
  }));
  const clippedTitleEvidence = await runSelection(page, {
    type: 'select_candidate', query: "HERSHEY'S mores kit 14 oz", maxPrice: 20, primeRequired: true
  });
  const clippedTitleApproved = {
    ...clippedTitleEvidence.selected,
    id: 'candidate-1',
    requiresProductPageVerification: true,
    identityStatus: 'provisional'
  };
  assert.equal(clippedTitleApproved?.asin, 'B000SMORES');
  assert.equal(clippedTitleApproved?.requiresProductPageVerification, true);
  await page.setContent([
    '<script>window.__clicks = 0</script>',
    card({
      asin: 'B000SMORES',
      title: "HERSHEY'S S'mores Kit Box, 14 oz",
      delivery: '<span aria-label="Amazon Prime">Prime delivery</span><span>FREE delivery on $35 of qualifying items</span>',
      clickable: true
    })
  ].join(''));
  const completedTitle = await runSelection(page, {
    type: 'select_candidate',
    query: "HERSHEY'S s'mores kit 14 oz",
    maxPrice: 20,
    primeRequired: true,
    intelligenceApprovedCandidate: clippedTitleApproved
  }, true);
  assert.equal(completedTitle.selectionKind, 'model_assisted_product_page_verification');
  assert.equal(completedTitle.selected.asin, clippedTitleApproved.asin);
  assert.equal(completedTitle.requiresProductPageVerification, true);
  assert.equal(await page.evaluate(() => window.__clicks), 0);

  console.log(JSON.stringify({
    amazonSelectionIntelligenceRevalidation: 'passed',
    reorderedAsin: reordered.selected.asin,
    stalePriceClicks: 0,
    wrongVariantClicks: 0,
    hydratedAsin: hydrated.selected.asin,
    hydratedNextStep: hydrated.selectionKind,
    completedTitleAsin: completedTitle.selected.asin,
    completedTitleNextStep: completedTitle.selectionKind
  }));
} finally {
  await browser.close();
}
