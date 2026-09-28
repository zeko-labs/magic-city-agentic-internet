import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeExecutionArtifact } from './executionArtifacts.js';
import { startHostedBrowserPublicNetworkProxy } from './hostedBrowserNetwork.js';
import { JOB_APPLICATION_MODE_PLAN, normalizeJobApplicationMode } from './jobApplicationModels.js';
import { stripUsdBudgetPhrases } from './browserMissionExtraction.js';

function titleize(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

async function getChromium() {
  try {
    const mod = await import('playwright');
    return mod.chromium ?? mod.default?.chromium ?? null;
  } catch {
    return null;
  }
}

function escapeRegex(value = '') {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function tryFillFirst(page, selectors, value) {
  if (!value) return false;
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.count()) {
        await locator.fill(value, { timeout: 1500 });
        return true;
      }
    } catch {
      // try next selector
    }
  }
  return false;
}

async function tryPressFirst(page, selectors, value) {
  if (!value) return false;
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.count()) {
        await locator.fill(value, { timeout: 1500 });
        await Promise.all([
          page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => null),
          locator.press('Enter')
        ]);
        return true;
      }
    } catch {
      // try next selector
    }
  }
  return false;
}

async function createHumanLikeContext(browser, options = {}) {
  const existingContext = options.reuseExistingContext ? browser.contexts?.()[0] : null;
  const context = existingContext || await browser.newContext({
    viewport: { width: 1440, height: 980 },
    userAgent: process.env.MAGIC_CITY_BROWSER_USER_AGENT || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    colorScheme: 'dark'
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined
    });
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en']
    });
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4]
    });
    window.chrome = window.chrome || { runtime: {} };
  });
  return context;
}

export async function launchHostedBrowser(chromium, options = {}) {
  const networkProxy = await startHostedBrowserPublicNetworkProxy();
  try {
    const browser = await chromium.launch({
      ...options,
      proxy: { server: networkProxy.url },
      args: [
        ...(Array.isArray(options.args) ? options.args : []),
        '--proxy-bypass-list=<-loopback>',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--disable-quic'
      ]
    });
    return { browser, networkProxy };
  } catch (error) {
    await networkProxy.close().catch(() => {});
    throw error;
  }
}

async function closeHostedBrowser(runtime = null) {
  await runtime?.browser?.close().catch(() => {});
  await runtime?.networkProxy?.close().catch(() => {});
}

async function createBrowserRuntime(chromium, options = {}) {
  const cdpUrl = String(
    options.cdpUrl ||
    process.env.MAGIC_CITY_BROWSER_CDP_URL ||
    process.env.MAGIC_CITY_CHROME_CDP_URL ||
    ''
  ).trim();
  if (cdpUrl) {
    const browser = await chromium.connectOverCDP(cdpUrl);
    return {
      browser,
      mode: 'local_authenticated_browser_profile',
      reuseExistingContext: true,
      shouldCloseBrowser: false,
      cdpUrl
    };
  }
  const userDataDir = String(
    options.userDataDir ||
    process.env.MAGIC_CITY_BROWSER_USER_DATA_DIR ||
    ''
  ).trim();
  if (userDataDir) {
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      viewport: { width: 1440, height: 980 },
      locale: 'en-US',
      timezoneId: 'America/Los_Angeles',
      colorScheme: 'dark',
      args: ['--disable-blink-features=AutomationControlled']
    });
    return {
      browser: null,
      context,
      mode: 'local_persistent_browser_profile',
      reuseExistingContext: true,
      shouldCloseContext: false
    };
  }
  const hosted = await launchHostedBrowser(chromium, {
    headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
    executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
    args: ['--disable-blink-features=AutomationControlled']
  });
  return {
    browser: hosted.browser,
    networkProxy: hosted.networkProxy,
    mode: 'server_ephemeral_browser',
    reuseExistingContext: false,
    shouldCloseBrowser: true
  };
}

async function detectProviderChallenge(page) {
  const title = await page.title().catch(() => '');
  const bodyText = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
  const combined = `${title}\n${bodyText}`.toLowerCase();
  const patterns = [
    /just a moment/,
    /verify you are human/,
    /checking your browser/,
    /attention required/,
    /access denied/,
    /cloudflare/,
    /captcha/
  ];
  const matched = patterns.find((pattern) => pattern.test(combined)) || null;
  return {
    detected: Boolean(matched),
    reason: matched ? matched.source : null,
    title
  };
}

async function clickVisibleRole(page, role, pattern) {
  const locator = page.getByRole(role, { name: pattern }).first();
  try {
    if (await locator.count()) {
      await locator.click({ timeout: 1800 });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function clickVisibleText(page, text) {
  if (!text) return false;
  const escaped = escapeRegex(text);
  const candidates = [
    page.getByRole('button', { name: new RegExp(escaped, 'i') }).first(),
    page.getByRole('link', { name: new RegExp(escaped, 'i') }).first(),
    page.locator(`text=/${escaped}/i`).first()
  ];
  for (const locator of candidates) {
    try {
      if (await locator.count()) {
        await locator.scrollIntoViewIfNeeded().catch(() => {});
        await locator.click({ timeout: 1800 });
        return true;
      }
    } catch {
      // try next candidate
    }
  }
  return false;
}

async function clickFirstVisibleLocator(page, selectors = [], { timeout = 2000 } = {}) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.count() && await locator.isVisible({ timeout: 700 }).catch(() => false)) {
        await locator.scrollIntoViewIfNeeded().catch(() => {});
        await locator.click({ timeout });
        return { clicked: true, selector };
      }
    } catch {
      // try next selector
    }
  }
  return { clicked: false, selector: null };
}

async function clickSafeRole(page, role, pattern, blockedPattern = /place order|confirm purchase|complete purchase|pay now|submit order|buy now/i) {
  const locator = page.getByRole(role, { name: pattern });
  try {
    const count = await locator.count();
    for (let index = 0; index < Math.min(count, 8); index += 1) {
      const candidate = locator.nth(index);
      if (!await candidate.isVisible({ timeout: 700 }).catch(() => false)) continue;
      const label = await candidate.innerText({ timeout: 700 }).catch(async () =>
        candidate.getAttribute('aria-label').catch(() => '') || ''
      );
      if (blockedPattern.test(String(label || ''))) continue;
      await candidate.scrollIntoViewIfNeeded().catch(() => {});
      await candidate.click({ timeout: 2000 });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function clickFirstDomControl(page, patterns = [], {
  selector = 'button, a, input[type="button"], input[type="submit"], [role="button"], [role="link"]',
  blockedPattern = /place order|confirm purchase|complete purchase|pay now|submit order|buy now/i
} = {}) {
  const patternPayload = patterns.map((pattern) => ({
    source: pattern instanceof RegExp ? pattern.source : escapeRegex(String(pattern || '')),
    flags: pattern instanceof RegExp ? pattern.flags : 'i'
  }));
  const blockedPayload = {
    source: blockedPattern instanceof RegExp ? blockedPattern.source : escapeRegex(String(blockedPattern || '')),
    flags: blockedPattern instanceof RegExp ? blockedPattern.flags : 'i'
  };
  return await page.evaluate(({ selector, patterns: rawPatterns, blocked }) => {
    function isVisible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style && style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 4 && rect.height > 4;
    }
    const regexes = rawPatterns.map((item) => new RegExp(item.source, item.flags.includes('i') ? item.flags : `${item.flags}i`));
    const blockedRegex = new RegExp(blocked.source, blocked.flags.includes('i') ? blocked.flags : `${blocked.flags}i`);
    for (const element of Array.from(document.querySelectorAll(selector))) {
      if (!isVisible(element) || element.disabled) continue;
      const label = [
        element.textContent,
        element.getAttribute('value'),
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element.id,
        element.getAttribute('name'),
        element.getAttribute('data-testid')
      ].filter(Boolean).join(' ');
      if (!label || blockedRegex.test(label)) continue;
      if (!regexes.some((regex) => regex.test(label))) continue;
      element.scrollIntoView({ block: 'center', inline: 'center' });
      element.click();
      return true;
    }
    return false;
  }, { selector, patterns: patternPayload, blocked: blockedPayload }).catch(() => false);
}

async function clickFirstProductLinkFromDom(page) {
  return await page.evaluate(() => {
    function isVisible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style && style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 20 && rect.height > 12;
    }
    const selectors = [
      '[data-component-type="s-search-result"] h2 a[href*="/dp/"]',
      '[data-component-type="s-search-result"] a.a-link-normal.s-no-outline[href*="/dp/"]',
      '[data-component-type="s-search-result"] a[href*="/gp/product/"]',
      '[data-component-type="s-search-result"] a[href*="/product/"]',
      '[data-testid*="product" i] a[href]',
      '[class*="product" i] a[href]'
    ];
    for (const selector of selectors) {
      const links = Array.from(document.querySelectorAll(selector)).slice(0, 12);
      for (const link of links) {
        const href = String(link.href || '');
        if (!href || !isVisible(link)) continue;
        if (/\/sspa\/click|adId=|creativeASIN/i.test(href)) continue;
        link.scrollIntoView({ block: 'center', inline: 'center' });
        link.click();
        return true;
      }
    }
    return false;
  }).catch(() => false);
}

async function waitForSoftNavigation(page, ms = 1800) {
  await Promise.race([
    page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => null),
    page.waitForTimeout(ms)
  ]);
}

async function dismissCommonFoodModals(page) {
  const dismissLabels = [/no thanks/i, /skip/i, /not now/i, /close/i, /continue/i, /done/i];
  for (const pattern of dismissLabels) {
    await clickVisibleRole(page, 'button', pattern).catch(() => {});
  }
}

async function addToastItemToCart(page, itemName, quantity = 1) {
  if (!itemName || quantity <= 0) return 0;
  let added = 0;
  for (let index = 0; index < quantity; index += 1) {
    const opened = await clickVisibleText(page, itemName);
    if (!opened) break;
    await page.waitForTimeout(900);
    await dismissCommonFoodModals(page);
    const addClicked = await clickVisibleRole(page, 'button', /add to order|add to cart|add item|add/i)
      || await clickVisibleText(page, 'Add to order')
      || await clickVisibleText(page, 'Add to cart')
      || await clickVisibleText(page, 'Add');
    if (!addClicked) {
      await page.keyboard.press('Escape').catch(() => {});
      break;
    }
    added += 1;
    await page.waitForTimeout(900);
    await dismissCommonFoodModals(page);
  }
  return added;
}

async function prepareToastOrderPage(page, session) {
  const selections = session?.finalSelections ?? session?.selections ?? {};
  const localPrivate = session?.localPrivateContext ?? {};
  const orderMode = selections.deliveryMode || 'Delivery';
  const addressValue = [localPrivate.streetAddress, localPrivate.zipCode].filter(Boolean).join(', ');
  const items = [
    { name: selections.item1, quantity: Number(selections.item1Qty || 1) || 1 },
    { name: selections.item2, quantity: Number(selections.item2Qty || 1) || 1 }
  ].filter((entry) => entry.name);

  await clickVisibleRole(page, 'button', new RegExp(orderMode, 'i')).catch(() => {});
  await clickVisibleText(page, orderMode).catch(() => {});
  await page.waitForTimeout(1000);

  const addressFilled = orderMode !== 'Reservation'
    ? await tryFillFirst(page, [
        'input[placeholder*="address" i]',
        'input[placeholder*="delivery" i]',
        'input[aria-label*="address" i]',
        'input[name*="address" i]'
      ], addressValue)
    : false;
  if (addressFilled) {
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(1000);
  }

  const itemsAdded = [];
  for (const item of items) {
    const addedCount = await addToastItemToCart(page, item.name, item.quantity);
    if (addedCount > 0) {
      itemsAdded.push(`${item.name}${addedCount > 1 ? ` x${addedCount}` : ''}`);
    }
  }

  const cartOpened = await clickVisibleRole(page, 'button', /view cart|cart|checkout|continue to cart/i)
    || await clickVisibleRole(page, 'link', /view cart|cart|checkout|continue to cart/i)
    || await clickVisibleText(page, 'View cart')
    || await clickVisibleText(page, 'Checkout');
  if (cartOpened) {
    await page.waitForTimeout(1200);
  }

  return {
    addressFilled,
    itemsAdded,
    cartPrepared: itemsAdded.length > 0 || cartOpened,
    cartOpened
  };
}

function getExecutionArtifactDir() {
  const dir = path.resolve(process.cwd(), 'data', 'execution-artifacts');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function captureBrowserPreview(page, sessionId, lane, label) {
  let buffer;
  try {
    buffer = await page.screenshot({
      fullPage: false,
      type: 'png',
      animations: 'disabled',
      timeout: 3000
    });
  } catch {
    return null;
  }
  const artifact = writeExecutionArtifact({
    sessionId,
    lane,
    label,
    extension: 'png',
    content: buffer
  });
  return {
    label: artifact.label,
    url: artifact.url,
    sha256: artifact.sha256
  };
}

async function captureScreenshotHash(page, screenshotPath) {
  try {
    await page.screenshot({
      path: screenshotPath,
      fullPage: false,
      animations: 'disabled',
      timeout: 3000
    });
    return sha256File(screenshotPath);
  } catch {
    return null;
  }
}

async function emitBrowserStep({ page, sessionId, lane, onProgress, label, detail, state, tool = 'browser' }) {
  const previewArtifact = await captureBrowserPreview(page, sessionId, lane, label);
  const browser = {
    tool,
    url: page.url(),
    title: await page.title().catch(() => ''),
    previewArtifact
  };
  if (typeof onProgress === 'function') {
    await onProgress({
      label,
      detail,
      state,
      browser
    });
  }
  return browser;
}

function cleanTravelHint(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function buildTravelSearchUrls(session) {
  const localPrivate = session?.localPrivateContext ?? {};
  const selections = session?.finalSelections ?? session?.selections ?? {};
  const destination =
    cleanTravelHint(selections.destination) ||
    cleanTravelHint(session?.handoffData?.defaults?.destination) ||
    'your destination';
  const homeAirport =
    cleanTravelHint(localPrivate.homeAirport) ||
    cleanTravelHint(session?.profileSummary?.homeAirport) ||
    'SFO';
  const travelWindow =
    cleanTravelHint(localPrivate.departureDate && localPrivate.returnDate
      ? `${localPrivate.departureDate} to ${localPrivate.returnDate}`
      : localPrivate.travelWindow) ||
    cleanTravelHint(session?.profileSummary?.travelWindow) ||
    cleanTravelHint(selections.nights) ||
    'flexible dates';
  const tripGoal =
    cleanTravelHint(selections.tripGoal) ||
    cleanTravelHint(session?.handoffData?.defaults?.tripGoal) ||
    `Travel to ${destination}`;
  const flightQuery = `Flights from ${homeAirport} to ${destination} ${travelWindow}`;
  const stayQuery = `${destination} hotels ${travelWindow}`;
  const highlightsQuery = `${destination} ${tripGoal}`;
  return {
    destination,
    homeAirport,
    travelWindow,
    tripGoal,
    flightSearchUrl: `https://www.google.com/travel/flights?q=${encodeURIComponent(flightQuery)}`,
    staySearchUrl: `https://www.google.com/search?q=${encodeURIComponent(stayQuery)}`,
    highlightsUrl: `https://www.google.com/search?q=${encodeURIComponent(highlightsQuery)}`
  };
}

function escapeHtml(value = '') {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function normalizeJobBoards(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || '')
        .split(',')
        .map((entry) => entry.trim());
  const normalized = raw
    .map((entry) => String(entry || '').trim().toLowerCase())
    .filter(Boolean)
    .map((entry) => {
      if (/greenhouse/.test(entry)) return 'greenhouse';
      if (/lever/.test(entry)) return 'lever';
      if (/ashby/.test(entry)) return 'ashby';
      if (/linkedin/.test(entry)) return 'linkedin';
      if (/workable/.test(entry)) return 'workable';
      if (/indeed/.test(entry)) return 'indeed';
      return entry;
    });
  return [...new Set(normalized)].slice(0, 5);
}

function getJobBoardMeta(board, { targetRole, locationPreference, companyTargets }) {
  const normalizedBoard = String(board || '').trim().toLowerCase();
  if (normalizedBoard === 'linkedin') {
    return {
      board: normalizedBoard,
      label: 'LinkedIn Jobs',
      atsProvider: 'linkedin',
      atsLabel: 'LinkedIn Jobs',
      searchUrl: `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(targetRole)}&location=${encodeURIComponent(locationPreference)}`,
      linkPattern: /linkedin\.com\/jobs\/view\//i
    };
  }
  const domain = normalizedBoard === 'greenhouse'
    ? 'greenhouse.io'
    : normalizedBoard === 'lever'
      ? 'jobs.lever.co'
      : normalizedBoard === 'ashby'
        ? 'ashbyhq.com'
        : normalizedBoard === 'workable'
          ? 'apply.workable.com'
          : 'indeed.com';
  const label = normalizedBoard === 'greenhouse'
    ? 'Greenhouse'
    : normalizedBoard === 'lever'
      ? 'Lever'
      : normalizedBoard === 'ashby'
        ? 'Ashby'
        : titleize(normalizedBoard);
  const query = [`site:${domain}`, `"${targetRole}"`, locationPreference, companyTargets].filter(Boolean).join(' ');
  return {
    board: normalizedBoard,
    label,
    atsProvider: normalizedBoard,
    atsLabel: label,
    searchUrl: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
    linkPattern: normalizedBoard === 'greenhouse'
      ? /(boards|job-boards)\.greenhouse\.io|greenhouse\.io\/.*\/jobs\//i
      : normalizedBoard === 'lever'
        ? /jobs\.lever\.co\//i
        : normalizedBoard === 'ashby'
          ? /ashbyhq\.com\//i
          : new RegExp(domain.replace(/\./g, '\\.'), 'i')
  };
}

function resolveJobExecutionOwner(session, jobMode) {
  const selected = String(session?.finalSelections?.executionOwner || session?.selections?.executionOwner || '').trim().toLowerCase();
  if (selected === 'your_agent') return 'your_agent';
  if (selected === 'magic_city_worker') return 'magic_city_worker';
  const requesterAgent = session?.personalAgentProfile || session?.profileSummary?.personalAgent || null;
  if (jobMode !== JOB_APPLICATION_MODE_PLAN && requesterAgent?.enabled) return 'your_agent';
  return 'magic_city_worker';
}

function buildJobSearchTargets(session) {
  const selections = session?.finalSelections ?? session?.selections ?? {};
  const localPrivate = session?.localPrivateContext ?? {};
  const jobMode = normalizeJobApplicationMode(selections.jobMode || session?.localContext?.jobMode || JOB_APPLICATION_MODE_PLAN);
  const requesterAgent = session?.personalAgentProfile || session?.profileSummary?.personalAgent || null;
  const executionOwner = resolveJobExecutionOwner(session, jobMode);
  const targetRole = cleanTravelHint(selections.targetRole) || cleanTravelHint(session?.localContext?.targetRole) || 'Software Engineer';
  const locationPreference = cleanTravelHint(selections.locationPreference) || cleanTravelHint(session?.localContext?.locationPreference) || 'Remote';
  const companyTargets = cleanTravelHint(selections.companyTargets) || '';
  const submissionMode = cleanTravelHint(selections.submissionMode) || 'review_before_submit';
  const applicationLimit = Math.max(1, Math.min(Number(selections.applicationLimit || session?.localContext?.applicationLimit || 3), 12));
  const boards = normalizeJobBoards(selections.jobBoards || session?.localContext?.jobBoards || ['linkedin', 'greenhouse', 'lever', 'ashby']);
  const applicantName = cleanTravelHint(localPrivate.applicantName) || '';
  const applicantEmail = cleanTravelHint(localPrivate.applicantEmail) || '';
  const applicantPhone = cleanTravelHint(localPrivate.applicantPhone) || '';
  const linkedinUrl = cleanTravelHint(localPrivate.linkedinUrl) || '';
  const portfolioUrl = cleanTravelHint(localPrivate.portfolioUrl) || '';
  const coverLetterNotes = cleanTravelHint(localPrivate.coverLetterNotes) || '';

  const targets = boards.map((board) => getJobBoardMeta(board, { targetRole, locationPreference, companyTargets }));

  return {
    jobMode,
    executionOwner,
    executionOwnerLabel: executionOwner === 'your_agent'
      ? `${requesterAgent?.name || 'Your Agent'} last-mile handoff`
      : 'Magic City execution worker',
    targetRole,
    locationPreference,
    companyTargets,
    submissionMode,
    applicationLimit,
    requesterAgent: requesterAgent || null,
    targets,
    applicantProfile: {
      applicantName,
      applicantEmail,
      applicantPhone,
      linkedinUrl,
      portfolioUrl,
      coverLetterNotes,
      resumeText: String(localPrivate.resumeText || '').trim(),
      resumeFileName: String(localPrivate.resumeFileName || 'magic-city-resume.pdf')
    }
  };
}

function detectAtsProvider(url = '', fallback = '') {
  const normalizedUrl = String(url || '').toLowerCase();
  const normalizedFallback = String(fallback || '').trim().toLowerCase();
  if (/greenhouse\.io/.test(normalizedUrl) || normalizedFallback === 'greenhouse') return 'greenhouse';
  if (/jobs\.lever\.co/.test(normalizedUrl) || normalizedFallback === 'lever') return 'lever';
  if (/ashbyhq\.com/.test(normalizedUrl) || normalizedFallback === 'ashby') return 'ashby';
  if (/linkedin\.com\/jobs/.test(normalizedUrl) || normalizedFallback === 'linkedin') return 'linkedin';
  if (/workable\.com/.test(normalizedUrl) || normalizedFallback === 'workable') return 'workable';
  if (/indeed\.com/.test(normalizedUrl) || normalizedFallback === 'indeed') return 'indeed';
  return normalizedFallback || 'generic';
}

function describeAtsProvider(atsProvider = '') {
  if (atsProvider === 'greenhouse') return 'Greenhouse';
  if (atsProvider === 'lever') return 'Lever';
  if (atsProvider === 'ashby') return 'Ashby';
  if (atsProvider === 'linkedin') return 'LinkedIn Jobs';
  if (atsProvider === 'workable') return 'Workable';
  if (atsProvider === 'indeed') return 'Indeed';
  return titleize(atsProvider || 'ATS');
}

function getAtsApplyPrompts(atsProvider = '') {
  if (atsProvider === 'linkedin') return ['Easy Apply', 'Apply', 'Apply now'];
  if (atsProvider === 'greenhouse') return ['Apply for this job', 'Apply now', 'Apply'];
  if (atsProvider === 'lever') return ['Apply for this job', 'Apply Now', 'Apply'];
  if (atsProvider === 'ashby') return ['Apply for this job', 'Apply now', 'Apply'];
  return ['Apply for this job', 'Apply now', 'Apply', 'Easy Apply'];
}

async function openJobApplicationSurface(page, atsProvider = '') {
  for (const prompt of getAtsApplyPrompts(atsProvider)) {
    if (await clickVisibleText(page, prompt)) {
      await page.waitForTimeout(1200);
      return true;
    }
  }
  return false;
}

function getJobFieldSelectors(atsProvider = '', field = '') {
  const base = {
    first_name: [
      'input[name*="first" i]',
      'input[id*="first" i]',
      'input[autocomplete="given-name"]'
    ],
    last_name: [
      'input[name*="last" i]',
      'input[id*="last" i]',
      'input[autocomplete="family-name"]'
    ],
    full_name: [
      'input[name="name"]',
      'input[name*="full" i]',
      'input[id*="full" i]'
    ],
    email: [
      'input[type="email"]',
      'input[name*="email" i]',
      'input[id*="email" i]'
    ],
    phone: [
      'input[type="tel"]',
      'input[name*="phone" i]',
      'input[id*="phone" i]'
    ],
    linkedin: [
      'input[name*="linkedin" i]',
      'input[id*="linkedin" i]'
    ],
    portfolio: [
      'input[name*="portfolio" i]',
      'input[id*="portfolio" i]',
      'input[name*="website" i]',
      'input[id*="website" i]',
      'input[name*="github" i]'
    ],
    cover_letter: [
      'textarea[name*="cover" i]',
      'textarea[id*="cover" i]',
      'textarea[name*="message" i]'
    ]
  };
  const atsSpecific = {
    greenhouse: {
      first_name: ['input[name="first_name"]', 'input#first_name'],
      last_name: ['input[name="last_name"]', 'input#last_name'],
      email: ['input[name="email"]', 'input#email'],
      phone: ['input[name="phone"]', 'input#phone'],
      linkedin: ['input[name="linkedin_url"]', 'input#linkedin_url'],
      portfolio: ['input[name="website"]', 'input#website'],
      cover_letter: ['textarea[name="cover_letter"]', 'textarea#cover_letter']
    },
    lever: {
      full_name: ['input[name="name"]'],
      email: ['input[name="email"]'],
      phone: ['input[name="phone"]'],
      linkedin: ['input[name="urls[LinkedIn]"]', 'input[name*="LinkedIn"]'],
      portfolio: ['input[name="urls[Portfolio]"]', 'input[name*="GitHub"]', 'input[name*="Portfolio"]'],
      cover_letter: ['textarea[name="comments"]']
    },
    ashby: {
      full_name: ['input[name="name"]'],
      email: ['input[name="email"]'],
      phone: ['input[name="phone"]'],
      linkedin: ['input[name*="linkedin" i]'],
      portfolio: ['input[name*="website" i]', 'input[name*="github" i]'],
      cover_letter: ['textarea[name*="cover" i]', 'textarea[name*="note" i]']
    },
    linkedin: {
      full_name: ['input[id*="name"]'],
      email: ['input[id*="email"]'],
      phone: ['input[id*="phone"]']
    }
  };
  return [...(atsSpecific[atsProvider]?.[field] || []), ...(base[field] || [])];
}

function getResumeFileSelectors(atsProvider = '') {
  const base = ['input[type="file"]', 'input[name*="resume" i]', 'input[id*="resume" i]'];
  const specific = atsProvider === 'greenhouse'
    ? ['input[name="resume"]', 'input#resume']
    : atsProvider === 'lever'
      ? ['input[name="resume"]']
      : atsProvider === 'ashby'
        ? ['input[name*="resume" i]', 'input[name*="attachment" i]']
        : atsProvider === 'linkedin'
          ? ['input[type="file"][name*="resume" i]']
          : [];
  return [...specific, ...base];
}

function getSubmitSelectors(atsProvider = '') {
  const generic = [
    'button:has-text("Submit application")',
    'button:has-text("Submit")',
    'button:has-text("Apply")',
    'input[type="submit"]'
  ];
  const specific = atsProvider === 'greenhouse'
    ? ['button#submit_app', 'button:has-text("Submit Application")']
    : atsProvider === 'lever'
      ? ['button:has-text("Submit application")']
      : atsProvider === 'ashby'
        ? ['button:has-text("Submit application")', 'button:has-text("Submit")']
        : atsProvider === 'linkedin'
          ? ['button:has-text("Submit application")', 'button:has-text("Next")']
          : [];
  return [...specific, ...generic];
}

async function readApplicationSurfaceSignals(page) {
  const title = await page.title().catch(() => '');
  const bodyText = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '');
  return `${title}\n${bodyText}`.toLowerCase();
}

function normalizeBrowserWorkerUrl(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^https?:\/\//i.test(text)) return text;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(text)) return `https://${text}`;
  return '';
}

function inferBrowserWorkerUrlFromText(value = '') {
  const text = String(value || '');
  const explicitUrl = text.match(/https?:\/\/[^\s)]+/i);
  if (explicitUrl) return normalizeBrowserWorkerUrl(explicitUrl[0].replace(/[.,;:]+$/, ''));
  const lower = text.toLowerCase();
  if (/\bamazon\b/.test(lower)) return 'https://www.amazon.com';
  if (/\btarget\b/.test(lower)) return 'https://www.target.com';
  if (/\bwalmart\b/.test(lower)) return 'https://www.walmart.com';
  if (/\bbest buy\b|\bbestbuy\b/.test(lower)) return 'https://www.bestbuy.com';
  if (/\binstacart\b/.test(lower)) return 'https://www.instacart.com';
  return '';
}

function getBrowserWorkerInputs(session) {
  const selections = {
    ...(session?.selections ?? {}),
    ...(session?.finalSelections ?? {})
  };
  const localContext = session?.localContext ?? {};
  const localPrivate = session?.localPrivateContext ?? {};
  const shoppingItems = normalizeShoppingItemsForBrowserExecution(
    selections.shoppingItems ||
    selections.items ||
    selections.itemList ||
    localContext.shoppingItems
  );
  const goalSeed = cleanTravelHint(selections.goal) || cleanTravelHint(localContext.goal) || cleanTravelHint(localContext.prompt) || cleanTravelHint(localContext.request) || '';
  const constraintSeed = cleanTravelHint(selections.constraints) || '';
  const budgetSeed = cleanTravelHint(selections.budget) || cleanTravelHint(localContext.budget) || '';
  const targetUrl = normalizeBrowserWorkerUrl(
    selections.targetUrl ||
    localContext.targetUrl ||
    session?.handoffData?.providerLinks?.find((link) => link?.preferredForExecution)?.url ||
    session?.handoffData?.providerLinks?.[0]?.url ||
    inferBrowserWorkerUrlFromText([goalSeed, constraintSeed, budgetSeed].filter(Boolean).join('\n')) ||
    ''
  );
  const amazonCheckoutMission = (() => {
    try {
      return /(^|\.)amazon\.com$/i.test(new URL(targetUrl || 'https://invalid.local').hostname || '');
    } catch {
      return false;
    }
  })();
  const goal = goalSeed || 'Move the site task forward until a safe handoff point.';
  const constraints = constraintSeed;
  const budget = budgetSeed;
  const inferredAuthority = inferBrowserPolicyAuthority({ targetUrl, goal, constraints, budget });
  const explicitAllowedMerchants = cleanTravelHint(selections.allowedMerchants) || '';
  const explicitTrustTier = cleanTravelHint(selections.trustTier) || '';
  const contextualAuthorityMode = cleanTravelHint(selections.contextualAuthorityMode) || inferredAuthority.mode;
  const useInferredBoundedAuthority = inferredAuthority.checkoutAuthority
    && !explicitAllowedMerchants
    && (!explicitTrustTier || explicitTrustTier === 'ask_every_time' || contextualAuthorityMode === 'bounded_purchase');
  const inferredAmount = parseUsdAmount(budget);
  const finalApprovalPolicy = cleanTravelHint(selections.finalApprovalPolicy) || (amazonCheckoutMission
    ? 'auto_submit_after_verified_checkout'
    : 'pause_before_final_approval');
  // A connector-wide legacy stop flag used to survive into Amazon sessions and
  // silently override the explicitly signed auto-submit policy. For Amazon,
  // the policy is the source of truth; non-Amazon paths retain their default
  // final-review boundary unless a caller sets another policy.
  const checkoutRunnerStopBeforeFinalSubmit = finalApprovalPolicy === 'auto_submit_after_verified_checkout'
    ? false
    : typeof selections.checkoutRunnerStopBeforeFinalSubmit === 'boolean'
      ? selections.checkoutRunnerStopBeforeFinalSubmit
      : true;
  return {
    targetUrl,
    goal,
    constraints,
    budget,
    shoppingItems,
    shoppingSearchMode: shoppingItems.length > 1 ? 'best_match_per_item' : 'single_item_best_match',
    sharedConstraints: shoppingItems.length > 1
      ? {
          targetUrl,
          budget,
          budgetScope: cleanTravelHint(selections.budgetScope) || cleanTravelHint(localContext.budgetScope) || 'total_checkout',
          budgetStrategy: 'shared_total_with_soft_per_item_search_guard'
        }
      : null,
    actionDepth: cleanTravelHint(selections.actionDepth) || 'Prepare cart or form',
    stopCondition: cleanTravelHint(selections.stopCondition) || cleanTravelHint(localContext.stopCondition) || (amazonCheckoutMission
      ? 'Pause only for login, captcha, payment, or a checkout mismatch'
      : 'Pause at login, captcha, payment, final submit, or uncertainty'),
    confirmationEmail: normalizeBrowserWorkerEmail(selections.confirmationEmail || localPrivate.contactEmail || localContext.contactEmail || ''),
    paymentProfile: {
      cardName: cleanTravelHint(selections.cardName) || 'Evan Business Agent Card',
      fundingSource: cleanTravelHint(selections.fundingSource) || 'bank_virtual_debit',
      localPaymentCredentialReady: Boolean(selections.localPaymentCredentialReady || selections.paymentCardLabel || selections.paymentCardLast4 || selections.paymentBillingZip),
      paymentCardLabel: cleanTravelHint(selections.paymentCardLabel) || '',
      paymentCardLast4: cleanTravelHint(selections.paymentCardLast4).replace(/\D/g, '').slice(-4),
      paymentBillingZip: cleanTravelHint(selections.paymentBillingZip) || '',
      cardAuthority: cleanTravelHint(selections.cardAuthority) || 'issuer_or_card_wallet',
      paymentEntryAuthority: cleanTravelHint(selections.paymentEntryAuthority) || 'user_handoff',
      missionAuthority: cleanTravelHint(selections.missionAuthority) || 'magic_city',
      proofAuthority: cleanTravelHint(selections.proofAuthority) || 'zeko_mission_bound_auth',
      paymentProfileDisplay: cleanTravelHint(selections.paymentProfileDisplay) || 'agent_card_label_and_last4',
      checkoutRunnerMode: normalizeCheckoutRunnerMode(selections.checkoutRunnerMode),
      checkoutRunnerReceiptProof: cleanTravelHint(selections.checkoutRunnerReceiptProof) || 'receipt_hashes_and_screenshots',
      checkoutRunnerStopBeforeFinalSubmit,
      limitSource: cleanTravelHint(selections.limitSource) || 'bank_controls_and_magic_city_policy',
      allowedUse: cleanTravelHint(selections.allowedUse) || 'internet_agent,procurement,bookings,applications',
      trustTier: normalizeBrowserTrustTier(useInferredBoundedAuthority ? inferredAuthority.trustTier : explicitTrustTier || inferredAuthority.trustTier),
      magicCityPerTaskCap: cleanTravelHint(selections.magicCityPerTaskCap) || (useInferredBoundedAuthority && inferredAmount != null ? `$${inferredAmount}` : ''),
      allowedMerchants: explicitAllowedMerchants || (useInferredBoundedAuthority ? inferredAuthority.allowedMerchants : ''),
      contextualAuthorityMode,
      contextualAuthorityReason: inferredAuthority.reason,
      inferredMerchants: inferredAuthority.inferredMerchants,
      authProfileMode: cleanTravelHint(selections.authProfileMode) || 'public_handoff',
      loginTouchpointPolicy: cleanTravelHint(selections.loginTouchpointPolicy) || 'handoff_before_login_or_mfa',
      paymentTouchpointPolicy: cleanTravelHint(selections.paymentTouchpointPolicy) || 'handoff_before_payment',
      finalApprovalPolicy,
      blockedUses: cleanTravelHint(selections.blockedUses) || 'subscriptions,cash_equivalents,gift_cards,financial_services',
      killSwitch: cleanTravelHint(selections.killSwitch) || 'remove_payment_profile'
    },
    privateNotes: cleanTravelHint(localPrivate.privateNotes) || ''
  };
}

function normalizeBrowserTrustTier(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'auto_under_cap') return 'auto_under_cap';
  if (normalized === 'allowlisted_merchants_only') return 'allowlisted_merchants_only';
  return 'ask_every_time';
}

function normalizeCheckoutRunnerMode(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'manual_takeover_only') return 'manual_takeover_only';
  if (normalized === 'local_runner_or_browser_autofill' || normalized === 'local_runner') return 'local_runner_or_browser_autofill';
  return 'server_prep_only';
}

function normalizeBrowserWorkerEmail(value = '') {
  const email = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

const BROWSER_POLICY_MERCHANT_NAME_TO_DOMAIN = {
  amazon: 'amazon.com',
  target: 'target.com',
  walmart: 'walmart.com',
  bestbuy: 'bestbuy.com',
  'best buy': 'bestbuy.com',
  macys: 'macys.com',
  "macy's": 'macys.com',
  nordstrom: 'nordstrom.com',
  costco: 'costco.com',
  expedia: 'expedia.com',
  booking: 'booking.com',
  hotels: 'hotels.com',
  airbnb: 'airbnb.com',
  delta: 'delta.com',
  united: 'united.com',
  southwest: 'southwest.com',
  doordash: 'doordash.com',
  ubereats: 'ubereats.com',
  instacart: 'instacart.com'
};

function normalizePolicyMerchantHost(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/[),.;:]+$/, '');
}

function inferPolicyMerchantsFromText(text = '', targetUrl = '') {
  const merchants = new Set();
  for (const match of String(text || '').matchAll(/\b(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:\/[^\s),;]*)?/gi)) {
    const host = normalizePolicyMerchantHost(match[1]);
    if (host) merchants.add(host);
  }
  const lower = String(text || '').toLowerCase();
  for (const [name, domain] of Object.entries(BROWSER_POLICY_MERCHANT_NAME_TO_DOMAIN)) {
    const pattern = new RegExp(`(^|[^a-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
    if (pattern.test(lower)) merchants.add(domain);
  }
  const targetHost = normalizePolicyMerchantHost(targetUrl);
  if (targetHost) merchants.add(targetHost);
  return Array.from(merchants);
}

function inferBrowserPolicyAuthority(inputs) {
  const text = `${inputs.goal || ''} ${inputs.constraints || ''} ${inputs.budget || ''}`;
  const lower = text.toLowerCase();
  const merchants = inferPolicyMerchantsFromText(text, inputs.targetUrl);
  const hasPurchaseIntent = /\b(buy|book|order|purchase|reserve|checkout|pay|get me|pick and buy|choose and buy|best one|best option)\b/.test(lower);
  const hasDiscoveryIntent = /\b(search|compare|find|show|research|options|recommend|shortlist|look for|which|what are)\b/.test(lower);
  const hasBoundedMerchantPhrase = /\b(these|from these|among these|one of these|from the following|allowlist|allowed merchants|stores|sites|merchants|vendors)\b/.test(lower);
  const delegatesChoice = /\b(best one|best option|choose|pick|select|book the best|buy the best|order the best)\b/.test(lower);
  const hasBudgetAmount = parseUsdAmount(text) != null;
  const hasSingleExplicitMerchantBudget = merchants.length === 1 && hasBudgetAmount;
  const mode = hasPurchaseIntent
    ? (merchants.length && (hasBoundedMerchantPhrase || delegatesChoice || hasSingleExplicitMerchantBudget) ? 'bounded_purchase' : 'purchase_requires_review')
    : hasDiscoveryIntent
      ? 'discovery_only'
      : 'scoped_browser_prep';
  return {
    mode,
    inferredMerchants: merchants,
    checkoutAuthority: mode === 'bounded_purchase',
    trustTier: mode === 'bounded_purchase' ? 'allowlisted_merchants_only' : 'ask_every_time',
    allowedMerchants: mode === 'bounded_purchase' ? merchants.join(',') : '',
    reason: mode === 'bounded_purchase'
      ? (hasSingleExplicitMerchantBudget ? 'single_merchant_with_budget' : 'bounded_merchant_purchase_phrasing')
      : mode === 'discovery_only'
        ? 'discovery_only_phrasing'
        : 'no_bounded_checkout_authority'
  };
}

function parseUsdAmount(value = '') {
  const match = String(value || '').match(/\$?\s*([0-9][0-9,]*(?:\.\d{1,2})?)/);
  if (!match) return null;
  const amount = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(amount) ? amount : null;
}

function getBrowserMaxSpendAmount(inputs = {}) {
  const directBudget = parseUsdAmount(inputs.budget);
  if (directBudget != null) return directBudget;
  const profileCap = parseUsdAmount(inputs.paymentProfile?.magicCityPerTaskCap);
  if (profileCap != null) return profileCap;
  return null;
}

function normalizeShoppingItemsForBrowserExecution(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanTravelHint(item).slice(0, 120))
    .filter(Boolean)
    .filter((item) => !/\b(?:beer|wine|spirits?|alcohol|liquor|vape|tobacco|cannabis|weed|marijuana)\b/i.test(item))
    .slice(0, 20);
}

function buildRetailSearchUrlForHost({ host = '', origin = '', query = '', inputs = {} } = {}) {
  const normalizedHost = String(host || '').replace(/^www\./i, '').toLowerCase();
  const encodedQuery = encodeURIComponent(query || inputs.goal || 'search');
  const maxSpend = getBrowserMaxSpendAmount(inputs);
  if (normalizedHost === 'amazon.com') {
    const url = new URL('https://www.amazon.com/s');
    url.searchParams.set('k', query || inputs.goal || 'search');
    if (maxSpend != null && maxSpend > 0) {
      url.searchParams.set('rh', `p_36:-${Math.max(1, Math.floor(maxSpend * 100))}`);
      url.searchParams.set('high-price', String(maxSpend));
    }
    return url.toString();
  }
  if (normalizedHost === 'target.com') return `https://www.target.com/s?searchTerm=${encodedQuery}`;
  if (normalizedHost === 'walmart.com') return `https://www.walmart.com/search?q=${encodedQuery}`;
  if (normalizedHost === 'bestbuy.com') return `https://www.bestbuy.com/site/searchpage.jsp?st=${encodedQuery}`;
  return `${origin || ''}/search?q=${encodedQuery}`;
}

function getHostForPolicy(url = '') {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function defaultFinalApprovalPolicyForRetailHost(...urls) {
  return urls.some((url) => getHostForPolicy(url) === 'amazon.com')
    ? 'auto_submit_after_verified_checkout'
    : 'pause_before_final_approval';
}

function listPolicyTokens(value = '') {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function evaluateBrowserPaymentPolicy(inputs, finalUrl = '') {
  const profile = inputs.paymentProfile || {};
  const trustTier = normalizeBrowserTrustTier(profile.trustTier);
  const merchantHost = getHostForPolicy(finalUrl || inputs.targetUrl);
  const defaultFinalApprovalPolicy = defaultFinalApprovalPolicyForRetailHost(finalUrl, inputs.targetUrl);
  const amount = parseUsdAmount(inputs.budget);
  const cap = parseUsdAmount(profile.magicCityPerTaskCap);
  const allowedMerchants = listPolicyTokens(profile.allowedMerchants);
  const blockedUses = listPolicyTokens(profile.blockedUses);
  const goalAndConstraints = `${inputs.goal || ''} ${inputs.constraints || ''}`.toLowerCase();
  const blockedUseMatch = blockedUses.find((token) => token && goalAndConstraints.includes(token.replace(/_/g, ' '))) || '';
  const merchantAllowed = allowedMerchants.some((token) => merchantHost.includes(token.replace(/^https?:\/\//, '').replace(/^www\./, '')));
  const amountWithinCap = amount != null && cap != null && amount <= cap;
  let decision = 'requires_user_approval';
  const reasons = [];
  if (blockedUseMatch) reasons.push(`blocked_use:${blockedUseMatch}`);
  if (trustTier === 'allowlisted_merchants_only' && !allowedMerchants.length) reasons.push('allowlist_empty');
  if (trustTier === 'allowlisted_merchants_only' && allowedMerchants.length && !merchantAllowed) reasons.push('merchant_not_allowlisted');
  if (trustTier !== 'ask_every_time' && amount == null) reasons.push('missing_budget_amount');
  if (trustTier !== 'ask_every_time' && cap == null) reasons.push('missing_magic_city_cap');
  if (trustTier !== 'ask_every_time' && amount != null && cap != null && !amountWithinCap) reasons.push('amount_above_magic_city_cap');
  if (trustTier === 'auto_under_cap' && !blockedUseMatch && amountWithinCap) decision = 'policy_allows_auto_under_cap';
  if (trustTier === 'allowlisted_merchants_only' && !blockedUseMatch && amountWithinCap && merchantAllowed) decision = 'policy_allows_allowlisted_merchant';
  if (trustTier === 'ask_every_time') reasons.push('trust_tier_ask_every_time');
  if (reasons.length) decision = 'requires_user_approval';
  return {
    cardName: profile.cardName || 'Agent card',
    fundingSource: profile.fundingSource || 'bank_virtual_debit',
    localPaymentCredentialReady: Boolean(profile.localPaymentCredentialReady),
    paymentCardLabel: profile.paymentCardLabel || '',
    paymentCardLast4: profile.paymentCardLast4 || '',
    paymentBillingZipReady: Boolean(profile.paymentBillingZip),
    cardAuthority: profile.cardAuthority || 'issuer_or_card_wallet',
    paymentEntryAuthority: profile.paymentEntryAuthority || 'user_handoff',
    missionAuthority: profile.missionAuthority || 'magic_city',
    proofAuthority: profile.proofAuthority || 'zeko_mission_bound_auth',
    paymentProfileDisplay: profile.paymentProfileDisplay || 'agent_card_label_and_last4',
    limitSource: profile.limitSource || 'bank_controls_and_magic_city_policy',
    trustTier,
    merchantHost,
    amount,
    magicCityPerTaskCap: cap,
    allowedMerchants,
    contextualAuthorityMode: profile.contextualAuthorityMode || '',
    contextualAuthorityReason: profile.contextualAuthorityReason || '',
    inferredMerchants: Array.isArray(profile.inferredMerchants) ? profile.inferredMerchants : [],
    authProfileMode: profile.authProfileMode || 'public_handoff',
    loginTouchpointPolicy: profile.loginTouchpointPolicy || 'handoff_before_login_or_mfa',
    paymentTouchpointPolicy: profile.paymentTouchpointPolicy || 'handoff_before_payment',
    finalApprovalPolicy: profile.finalApprovalPolicy || defaultFinalApprovalPolicy,
    blockedUses,
    decision,
    reasons,
    killSwitch: profile.killSwitch || 'remove_payment_profile',
    rawCardDataHandled: false,
    rawCardDataHandledByMagicCity: false
  };
}

function buildLocalCheckoutRunnerPolicy(inputs, finalUrl = '') {
  const profile = inputs.paymentProfile || {};
  const defaultFinalApprovalPolicy = defaultFinalApprovalPolicyForRetailHost(finalUrl, inputs.targetUrl);
  const finalApprovalPolicy = profile.finalApprovalPolicy || defaultFinalApprovalPolicy;
  const mode = normalizeCheckoutRunnerMode(profile.checkoutRunnerMode);
  const localPaymentCredentialReady = Boolean(profile.localPaymentCredentialReady);
  const requiresLocalRunner = mode === 'local_runner_or_browser_autofill' && localPaymentCredentialReady;
  return {
    mode,
    available: mode !== 'server_prep_only',
    requiredForPayment: requiresLocalRunner,
    localPaymentCredentialReady,
    capabilities: [
      'local_authenticated_session_reuse',
      'device_vault_unlock',
      'local_card_fill',
      'browser_autofill',
      'approved_payment_sheet',
      'stop_before_final_submit',
      'receipt_hash'
    ],
    stopBeforeFinalSubmit: finalApprovalPolicy === 'auto_submit_after_verified_checkout'
      ? false
      : typeof profile.checkoutRunnerStopBeforeFinalSubmit === 'boolean'
        ? profile.checkoutRunnerStopBeforeFinalSubmit
        : true,
    receiptProof: profile.checkoutRunnerReceiptProof || 'receipt_hashes_and_screenshots',
    authoritySplit: {
      cardAuthority: profile.cardAuthority || 'issuer_or_card_wallet',
      paymentEntryAuthority: profile.paymentEntryAuthority || 'user_handoff',
      missionAuthority: profile.missionAuthority || 'magic_city',
      proofAuthority: profile.proofAuthority || 'zeko_mission_bound_auth'
    },
    finalUrl: finalUrl || inputs.targetUrl || '',
    authProfileMode: profile.authProfileMode || 'public_handoff',
    loginTouchpointPolicy: profile.loginTouchpointPolicy || 'handoff_before_login_or_mfa',
    paymentTouchpointPolicy: profile.paymentTouchpointPolicy || 'handoff_before_payment',
    finalApprovalPolicy,
    serverReceivesRawCard: false,
    rawCardDataHandledByMagicCity: false,
    userFacingRevocation: 'remove_payment_profile'
  };
}

const BROWSER_WORKER_HANDOFF_STATES = new Set([
  'needs_captcha',
  'needs_login',
  'needs_payment',
  'needs_final_approval'
]);

function isBrowserWorkerHandoffState(state = '') {
  return BROWSER_WORKER_HANDOFF_STATES.has(String(state || '').toLowerCase());
}

function isBlockingBrowserWorkerHandoff(stopState = {}) {
  const state = String(stopState?.state || '').toLowerCase();
  if (!isBrowserWorkerHandoffState(state)) return false;
  if (state !== 'needs_login') return true;
  const evidence = String(stopState?.evidence || '').toLowerCase();
  const signals = stopState?.signals || {};
  const sampleText = String(stopState?.sampleText || '').toLowerCase();
  if (evidence === 'password_field_visible' || Number(signals.passwordInputs || 0) > 0) return true;
  return /\b(account required|sign in to continue|log in to continue|authentication required|create an account to continue)\b/.test(sampleText);
}

async function countVisibleLocators(page, selectors = []) {
  let total = 0;
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector);
      const count = await locator.count();
      for (let index = 0; index < Math.min(count, 6); index += 1) {
        if (await locator.nth(index).isVisible({ timeout: 400 }).catch(() => false)) {
          total += 1;
        }
      }
    } catch {
      // keep detection conservative across unusual DOMs
    }
  }
  return total;
}

async function hasVisibleRole(page, role, pattern) {
  try {
    const locator = page.getByRole(role, { name: pattern });
    const count = await locator.count();
    for (let index = 0; index < Math.min(count, 6); index += 1) {
      if (await locator.nth(index).isVisible({ timeout: 400 }).catch(() => false)) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

async function detectBrowserWorkerStopState(page) {
  const title = await page.title().catch(() => '');
  const currentUrl = page.url();
  const bodyText = await page.locator('body').innerText({ timeout: 2500 }).catch(() => '');
  const combined = `${currentUrl}\n${title}\n${bodyText}`.toLowerCase();
  const passwordInputs = await countVisibleLocators(page, [
    'input[type="password"]',
    'input[autocomplete="current-password"]',
    'input[autocomplete="new-password"]'
  ]);
  const paymentInputs = await countVisibleLocators(page, [
    'input[autocomplete="cc-number"]',
    'input[autocomplete="cc-csc"]',
    'input[autocomplete="cc-exp"]',
    'input[name*="card" i]',
    'input[id*="card" i]',
    'input[name*="cvv" i]',
    'input[id*="cvv" i]',
    'input[name*="cvc" i]',
    'input[id*="cvc" i]',
    'input[name*="expiry" i]',
    'input[id*="expiry" i]',
    'input[name*="billing" i]',
    'input[id*="billing" i]'
  ]);
  const paymentFrames = await countVisibleLocators(page, [
    'iframe[name*="stripe" i]',
    'iframe[src*="stripe" i]',
    'iframe[src*="braintree" i]',
    'iframe[src*="adyen" i]',
    'iframe[src*="checkout" i]',
    'iframe[src*="paypal" i]'
  ]);
  const finalSubmitVisible = await hasVisibleRole(page, 'button', /place order|confirm booking|complete order|complete purchase|finalize purchase|submit application|book now|pay now/i)
    || await hasVisibleRole(page, 'link', /place order|confirm booking|complete order|complete purchase|finalize purchase|book now|pay now/i);
  const loginVisible = passwordInputs > 0
    || await hasVisibleRole(page, 'button', /sign in|log in|login|continue with google|continue with apple|create account/i)
    || await hasVisibleRole(page, 'link', /sign in|log in|login|continue with google|continue with apple|create account/i);
  const loginUrlVisible = /\/(?:ap\/signin|signin|login|log-in|account\/login|auth)\b|[?&](?:login|signin|openid\.mode)=/i.test(currentUrl);
  const loginGateVisible = passwordInputs > 0
    || loginUrlVisible
    || /\b(account required|authentication required|sign in to continue|log in to continue|create an account to continue|enter your email|email or mobile phone number|enter your password|continue with google|continue with apple)\b/.test(combined);
  const checks = [
    { state: 'needs_captcha', detected: /captcha|verify you are human|checking your browser|just a moment|cloudflare|attention required|access denied/.test(combined), evidence: 'captcha_or_bot_challenge' },
    { state: 'needs_payment', detected: paymentInputs > 0 || paymentFrames > 0 || /\b(card number|security code|cvv|cvc|billing address|payment method|pay now)\b/.test(combined), evidence: paymentInputs > 0 ? 'payment_fields_visible' : paymentFrames > 0 ? 'payment_iframe_visible' : 'payment_text_visible' },
    { state: 'needs_final_approval', detected: finalSubmitVisible || /\b(place order|confirm booking|complete order|complete purchase|finalize purchase|submit application|book now)\b/.test(combined), evidence: finalSubmitVisible ? 'final_action_visible' : 'final_action_text_visible' },
    { state: 'needs_login', detected: loginGateVisible, evidence: passwordInputs > 0 ? 'password_field_visible' : 'login_gate_visible' }
  ];
  const matched = checks.find((entry) => entry.detected);
  return {
    state: matched?.state || 'browser_ready',
    detected: Boolean(matched),
    evidence: matched?.evidence || null,
    signals: {
      passwordInputs,
      paymentInputs,
      paymentFrames,
      finalSubmitVisible,
      loginVisible,
      loginGateVisible,
      loginUrlVisible
    },
    title,
    sampleText: bodyText.slice(0, 1200)
  };
}

export function buildBrowserRetailSearchQuery(inputs) {
  const text = `${inputs.goal || ''} ${inputs.constraints || ''}`.replace(/\s+/g, ' ').trim();
  const direct = text.match(/\b(?:buy|purchase|order|get me|shop for|add(?: it)? to cart|find|search for)\s+(.+?)(?:\s+(?:from|on|at|via|under|budget|max|maximum|up to|less than|spend(?:ing)?|for)\b|$)/i);
  const cleaned = stripUsdBudgetPhrases(direct?.[1] || text)
    .replace(/\b(?:please|for me|online|from amazon(?:\.com)?|on amazon(?:\.com)?|at amazon(?:\.com)?|from target(?:\.com)?|from walmart(?:\.com)?|with max spend|pause before payment|pause before final purchase|stop before(?: any)? final purchase|prefer a normal single pack)\b/gi, ' ')
    .replace(/\b(?:from|on|at|via)\s+(?:amazon|amazon\.com|target|target\.com|walmart|walmart\.com|best buy|bestbuy|bestbuy\.com|instacart|instacart\.com)\b/gi, ' ')
    .replace(/\b(?:i\s+(?:really\s+)?want\s+to|i\s+would\s+like\s+to|i'?d\s+like\s+to|can\s+you|could\s+you|help\s+me)\b/gi, ' ')
    .replace(/^\s*(?:buy|purchase|order|get|grab|find|search for|shop for|add(?: it)? to cart)\b\s*/i, ' ')
    .replace(/^\s*(?:some|a|an|the|one|1|a\s+pack\s+of|pack\s+of)\b\s*/i, ' ')
    .replace(/\$[0-9][0-9,]*(?:\.\d{1,2})?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 120) || [inputs.goal, inputs.constraints].filter(Boolean).join(' ').slice(0, 120);
}

function buildBrowserWorkerSearchText(inputs) {
  const retailQuery = buildBrowserRetailSearchQuery(inputs);
  if (retailQuery) return retailQuery;
  return [inputs.goal, inputs.constraints, inputs.budget].filter(Boolean).join(' · ').slice(0, 240);
}

function buildSearchUrlFromTemplate(template = '', query = '') {
  const raw = String(template || '').trim();
  if (!raw || !query) return '';
  const encoded = encodeURIComponent(query);
  return raw
    .replace(/\{searchTerms\??\}/gi, encoded)
    .replace(/\{search_term_string\??\}/gi, encoded)
    .replace(/\{searchTerms\}/gi, encoded)
    .replace(/\{search_term_string\}/gi, encoded)
    .replace(/\{\?searchTerms\}/gi, `?q=${encoded}`)
    .replace(/\{\?search_term_string\}/gi, `?q=${encoded}`)
    .replace(/\{[^}]+\}/g, '');
}

async function applyMachineReadableSearchHint(page, inputs) {
  const query = buildBrowserRetailSearchQuery(inputs);
  if (!query) return false;
  const template = await page.evaluate(async () => {
    function asArray(value) {
      return Array.isArray(value) ? value : value == null ? [] : [value];
    }
    function typeIncludes(value, needle) {
      return asArray(value).some((entry) => String(entry || '').toLowerCase().includes(needle));
    }
    function targetFromAction(action) {
      if (!action || typeof action !== 'object') return '';
      const target = action.target;
      if (typeof target === 'string') return target;
      if (target && typeof target === 'object') {
        return target.urlTemplate || target.url || target.href || '';
      }
      return '';
    }
    function walk(value) {
      if (!value || typeof value !== 'object') return '';
      if (typeIncludes(value['@type'], 'searchaction')) return targetFromAction(value);
      const potential = asArray(value.potentialAction);
      for (const action of potential) {
        if (typeIncludes(action?.['@type'], 'searchaction')) {
          const target = targetFromAction(action);
          if (target) return target;
        }
      }
      for (const child of Array.isArray(value) ? value : Object.values(value)) {
        const found = walk(child);
        if (found) return found;
      }
      return '';
    }
    for (const node of Array.from(document.querySelectorAll('script[type="application/ld+json"]'))) {
      try {
        const found = walk(JSON.parse(node.textContent || ''));
        if (found) return found;
      } catch {
        // ignore malformed site metadata
      }
    }
    const openSearch = Array.from(document.querySelectorAll('link[rel~="search"]'))
      .find((link) => /opensearchdescription\+xml/i.test(link.getAttribute('type') || ''));
    if (openSearch?.href) {
      try {
        const response = await fetch(openSearch.href);
        const xmlText = await response.text();
        const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
        const urlNode = Array.from(xml.querySelectorAll('Url'))
          .find((node) => /text\/html/i.test(node.getAttribute('type') || ''));
        return urlNode?.getAttribute('template') || '';
      } catch {
        return '';
      }
    }
    return '';
  }).catch(() => '');
  const nextUrl = buildSearchUrlFromTemplate(template, query);
  if (!nextUrl) return false;
  await page.goto(nextUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1200);
  return true;
}

async function revealSearchControl(page) {
  const selectors = [
    'button[aria-label*="search" i]',
    'a[aria-label*="search" i]',
    'button[title*="search" i]',
    'a[title*="search" i]',
    '[role="button"][aria-label*="search" i]',
    '[data-testid*="search" i]',
    '[class*="search" i] button',
    '[class*="search" i] a'
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.count() && await locator.isVisible({ timeout: 500 }).catch(() => false)) {
        await locator.click({ timeout: 1500 });
        await page.waitForTimeout(500);
        return true;
      }
    } catch {
      // try next selector
    }
  }
  return await clickVisibleRole(page, 'button', /search/i)
    || await clickVisibleRole(page, 'link', /search/i);
}

async function submitSearchFormFromDom(page, query) {
  if (!query) return false;
  const submitted = await page.evaluate((searchQuery) => {
    function isVisible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style && style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 4 && rect.height > 4;
    }
    const fields = Array.from(document.querySelectorAll('input, textarea'))
      .filter((field) => {
        if (!isVisible(field) || field.disabled || field.readOnly) return false;
        const type = String(field.getAttribute('type') || '').toLowerCase();
        if (['hidden', 'password', 'email', 'tel', 'number', 'checkbox', 'radio', 'submit', 'button'].includes(type)) return false;
        const haystack = [
          type,
          field.getAttribute('name'),
          field.id,
          field.getAttribute('placeholder'),
          field.getAttribute('aria-label'),
          field.getAttribute('role'),
          field.closest('form')?.getAttribute('role'),
          field.closest('form')?.getAttribute('aria-label')
        ].filter(Boolean).join(' ').toLowerCase();
        return /search|query|keyword|keywords|q\b|find/.test(haystack);
      });
    const field = fields[0] || null;
    if (!field) return false;
    field.focus();
    field.value = searchQuery;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    const form = field.closest('form');
    if (form) {
      if (typeof form.requestSubmit === 'function') form.requestSubmit();
      else form.submit();
      return true;
    }
    const root = field.closest('[role="search"], [class*="search" i], [data-testid*="search" i]') || document;
    const button = Array.from(root.querySelectorAll('button, input[type="submit"], [role="button"]'))
      .find((candidate) => isVisible(candidate) && /search|go|submit|\u{1F50D}/iu.test(`${candidate.textContent || ''} ${candidate.getAttribute('aria-label') || ''} ${candidate.getAttribute('title') || ''}`));
    if (button) {
      button.click();
      return true;
    }
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    field.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
    return true;
  }, query).catch(() => false);
  if (!submitted) return false;
  await Promise.race([
    page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => null),
    page.waitForTimeout(1200)
  ]);
  return true;
}

async function applyGenericSearchUrlFallback(page, inputs) {
  const query = buildBrowserRetailSearchQuery(inputs);
  if (!query) return false;
  let url;
  try {
    url = new URL(page.url() || inputs.targetUrl || '');
  } catch {
    try {
      url = new URL(inputs.targetUrl || '');
    } catch {
      return false;
    }
  }
  const host = url.hostname.replace(/^www\./i, '').toLowerCase();
  const origin = url.origin;
  const common = [
    `/search?q=${encodeURIComponent(query)}`,
    `/search?query=${encodeURIComponent(query)}`,
    `/search?searchTerm=${encodeURIComponent(query)}`,
    `/search?keyword=${encodeURIComponent(query)}`,
    `/s?k=${encodeURIComponent(query)}`,
    `/?s=${encodeURIComponent(query)}`
  ];
  let nextUrl = `${origin}${common[0]}`;
  if (host === 'amazon.com') {
    nextUrl = buildRetailSearchUrlForHost({ host, origin, query, inputs });
  } else if (host === 'target.com') {
    nextUrl = buildRetailSearchUrlForHost({ host, origin, query, inputs });
  } else if (host === 'walmart.com') {
    nextUrl = buildRetailSearchUrlForHost({ host, origin, query, inputs });
  } else if (host === 'bestbuy.com') {
    nextUrl = buildRetailSearchUrlForHost({ host, origin, query, inputs });
  }
  const candidates = [nextUrl, ...common.map((pathPart) => `${origin}${pathPart}`)]
    .filter((candidate, index, rows) => candidate && rows.indexOf(candidate) === index);
  for (const candidate of candidates.slice(0, 3)) {
    try {
      await page.goto(candidate, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1200);
      const current = new URL(page.url());
      if (current.hostname.replace(/^www\./i, '').toLowerCase() === host || current.hostname.endsWith(`.${host}`)) {
        return true;
      }
    } catch {
      // try next same-domain search route
    }
  }
  return false;
}

async function fillSafeBrowserWorkerFields(page, inputs) {
  const actionDepth = String(inputs.actionDepth || '').toLowerCase();
  if (!/search|compare|fill|cart|form|prepare/.test(actionDepth)) {
    return { queryFilled: false, safeFieldsFilled: [] };
  }
  const searchText = buildBrowserWorkerSearchText(inputs);
  let searchMethod = '';
  let queryFilled = await applyMachineReadableSearchHint(page, inputs);
  if (queryFilled) searchMethod = 'machine_readable_search_hint';
  if (!queryFilled) {
    queryFilled = await tryPressFirst(page, [
    '#twotabsearchtextbox',
    'input[name="field-keywords"]',
    'input[aria-label*="Search Amazon" i]',
    'input[placeholder*="Search Amazon" i]',
    'input[data-testid*="search" i]',
    'input[id*="search" i]',
    'input[type="search"]',
    'input[placeholder*="search" i]',
    'input[aria-label*="search" i]',
    'input[name="q"]',
    'input[name*="search" i]'
    ], searchText);
    if (queryFilled) searchMethod = 'visible_search_input';
  }
  if (!queryFilled) {
    await revealSearchControl(page);
    queryFilled = await submitSearchFormFromDom(page, buildBrowserRetailSearchQuery(inputs));
    if (queryFilled) searchMethod = 'revealed_or_dom_search_form';
  }
  let queryFallbackUsed = false;
  if (!queryFilled) {
    queryFallbackUsed = await applyGenericSearchUrlFallback(page, inputs).catch(() => false);
    if (queryFallbackUsed) searchMethod = 'same_domain_search_url';
  }
  if (queryFilled || queryFallbackUsed) {
    await page.waitForTimeout(1800);
  }
  const safeFieldsFilled = [];
  if (/fill|form|cart|prepare/.test(actionDepth)) {
    const emailFilled = await tryFillFirst(page, [
      'input[type="email"]',
      'input[name*="email" i]',
      'input[id*="email" i]',
      'input[autocomplete="email"]'
    ], inputs.confirmationEmail);
    if (emailFilled) safeFieldsFilled.push('confirmation_email');
    const goalFilled = await tryFillFirst(page, [
      'textarea[placeholder*="message" i]',
      'textarea[placeholder*="note" i]',
      'textarea[name*="message" i]',
      'textarea[name*="note" i]'
    ], [inputs.goal, inputs.constraints].filter(Boolean).join('\n'));
    if (goalFilled) safeFieldsFilled.push('goal_or_notes');
  }
  return { queryFilled: queryFilled || queryFallbackUsed, safeFieldsFilled, searchMethod };
}

async function openAmazonProductUnderBudget(page, inputs) {
  const maxSpend = getBrowserMaxSpendAmount(inputs);
  let url;
  try {
    url = new URL(page.url());
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./i, '').toLowerCase();
  if (!host.endsWith('amazon.com') || !/^\/s\b/i.test(url.pathname)) return null;
  const query = buildBrowserRetailSearchQuery(inputs).toLowerCase();
  const queryTokens = query
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/g, ''))
    .filter((token) => token.length > 2)
    .slice(0, 6);
  const candidate = await page.evaluate(({ maxSpend, queryTokens }) => {
    function cleanText(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }
    function priceFromText(value) {
      const match = cleanText(value).match(/\$([0-9][0-9,]*(?:\.\d{1,2})?)/);
      if (!match) return null;
      const amount = Number(match[1].replace(/,/g, ''));
      return Number.isFinite(amount) ? amount : null;
    }
    function resultPrice(row) {
      const offscreen = row.querySelector('.a-price .a-offscreen, [data-a-color="price"] .a-offscreen');
      const price = priceFromText(offscreen?.textContent || '');
      if (price != null) return price;
      return priceFromText(row.textContent || '');
    }
    const rows = Array.from(document.querySelectorAll('[data-component-type="s-search-result"], div[data-asin]'))
      .filter((row) => row.querySelector('h2 a[href], a[href*="/dp/"], a[href*="/gp/product/"]'));
    const scored = rows.map((row, index) => {
      const link = row.querySelector('h2 a[href], a[href*="/dp/"], a[href*="/gp/product/"]');
      const href = link?.href || '';
      const title = cleanText(link?.textContent || row.querySelector('h2')?.textContent || '');
      const text = cleanText(row.textContent || '');
      const lower = `${title} ${text}`.toLowerCase();
      const price = resultPrice(row);
      const sponsored = /\bsponsored\b/i.test(text);
      const subscription = /\bsubscribe\s*&?\s*save|subscription|subscribe\b/i.test(text);
      const tokenMatches = queryTokens.length
        ? queryTokens.filter((token) => lower.includes(token)).length
        : 0;
      const withinBudget = maxSpend == null || (price != null && price <= maxSpend + 0.01);
      const score =
        (withinBudget ? 100 : 0)
        + tokenMatches * 8
        + (price != null ? Math.max(0, 20 - price) : 0)
        - (sponsored ? 4 : 0)
        - (subscription ? 30 : 0)
        - index;
      return { href, title, price, sponsored, subscription, tokenMatches, withinBudget, score, index };
    }).filter((entry) => entry.href && entry.title && !entry.subscription);
    const eligible = scored
      .filter((entry) => entry.withinBudget && (!queryTokens.length || entry.tokenMatches > 0))
      .sort((left, right) => right.score - left.score);
    const fallback = scored
      .filter((entry) => !queryTokens.length || entry.tokenMatches > 0)
      .sort((left, right) => right.score - left.score);
    if (maxSpend != null) return eligible[0] || null;
    return eligible[0] || fallback[0] || null;
  }, { maxSpend, queryTokens }).catch(() => null);
  if (!candidate?.href) return null;
  await page.goto(candidate.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1800);
  return candidate;
}

async function advanceRetailCheckoutFlow(page, inputs, { onProgress, sessionId } = {}) {
  const actionDepth = String(inputs.actionDepth || '').toLowerCase();
  if (!/cart|checkout|form|prepare|buy|order/.test(`${actionDepth} ${inputs.goal || ''}`)) {
    return { productOpened: false, addToCartClicked: false, checkoutOpened: false, steps: [] };
  }
  const steps = [];
  const emit = async (label, detail, state) => {
    steps.push({ label, state, url: page.url() });
    await onProgress?.({ label, detail, state });
  };

  await emit(
    'Finding product page',
    'Looking for a product/result link that can be opened before any cart or checkout action.',
    'browser_product_search'
  );
  let productOpened = false;
  const amazonCandidate = await openAmazonProductUnderBudget(page, inputs);
  if (amazonCandidate?.href) {
    productOpened = true;
    await emit(
      'Opened product page',
      `${amazonCandidate.price != null ? `Opened an Amazon result priced around $${amazonCandidate.price}.` : 'Opened a likely Amazon result.'} Checking whether it can be added to the cart within the mission boundary.`,
      'browser_product_open'
    );
  }
  if (!productOpened) {
    const productOpenedFromDom = await Promise.race([
      clickFirstProductLinkFromDom(page),
      page.waitForTimeout(3500).then(() => false)
    ]).catch(() => false);
    if (productOpenedFromDom) {
      productOpened = true;
      await waitForSoftNavigation(page, 2200);
      await emit(
        'Opened product page',
        'Opened the first likely product page. Checking whether it can be added to a cart without payment or final submit.',
        'browser_product_open'
      );
    }
  }
  if (productOpened) {
    productOpened = true;
  }

  let addToCartClicked = false;
  let addSelector = null;
  const addClick = await clickFirstVisibleLocator(page, [
    '#add-to-cart-button',
    'input#add-to-cart-button',
    'input[name="submit.add-to-cart"]',
    'button[name="add"]',
    'button[data-testid*="add-to-cart" i]',
    '[data-testid*="add-to-cart" i]',
    '[aria-label*="add to cart" i]',
    '[aria-label*="add to basket" i]'
  ]);
  addToCartClicked = addClick.clicked;
  addSelector = addClick.selector;
  if (!addToCartClicked) {
    addToCartClicked = await clickFirstDomControl(page, [
      /add to cart/i,
      /add to basket/i,
      /add item/i
    ], {
      selector: 'button, a, input[type="button"], input[type="submit"], [role="button"], [role="link"]'
    });
  }
  if (addToCartClicked) {
    await waitForSoftNavigation(page, 2400);
    await clickSafeRole(page, 'button', /no thanks|not now|skip/i).catch(() => false);
    await emit(
      'Added item to cart',
      `Clicked an add-to-cart control${addSelector ? ` (${addSelector})` : ''}. The worker will now look for cart or checkout handoff controls.`,
      'browser_cart_ready'
    );
  }

  let checkoutOpened = false;
  if (addToCartClicked || productOpened) {
    checkoutOpened = await clickFirstDomControl(page, [
      /proceed to checkout/i,
      /checkout/i,
      /go to cart/i,
      /view cart/i,
      /\bcart\b/i
    ]);
    if (!checkoutOpened) {
      const checkoutClick = await clickFirstVisibleLocator(page, [
        '#hlb-ptc-btn-native',
        '#sc-buy-box-ptc-button input',
        '#sc-buy-box-ptc-button',
        'input[name="proceedToRetailCheckout"]',
        'form[action*="/gp/buy/"] input[type="submit"]',
        'a[href*="checkout"]',
        'a[href*="/gp/buy/"]',
        'button[data-testid*="checkout" i]',
        '[data-testid*="checkout" i]',
        'a[href*="/cart"]',
        'a[href*="/basket"]'
      ]);
      checkoutOpened = checkoutClick.clicked;
    }
    if (!checkoutOpened && addToCartClicked) {
      try {
        const current = new URL(page.url());
        const cartUrl = /amazon\./i.test(current.hostname)
          ? `${current.origin}/gp/cart/view.html`
          : `${current.origin}/cart`;
        await page.goto(cartUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        await page.waitForTimeout(1400);
        await emit(
          'Opened cart',
          'Opened the cart after adding the item. Looking for a checkout handoff control while avoiding final purchase actions.',
          'browser_cart_open'
        );
        checkoutOpened = await clickFirstDomControl(page, [
          /proceed to checkout/i,
          /checkout/i
        ]);
        if (!checkoutOpened) {
          const cartCheckoutClick = await clickFirstVisibleLocator(page, [
            '#sc-buy-box-ptc-button input',
            '#sc-buy-box-ptc-button',
            'input[name="proceedToRetailCheckout"]',
            'form[action*="/gp/buy/"] input[type="submit"]',
            'a[href*="/gp/buy/"]',
            'a[href*="checkout"]',
            'button[data-testid*="checkout" i]',
            '[data-testid*="checkout" i]'
          ]);
          checkoutOpened = cartCheckoutClick.clicked;
        }
      } catch {
        // Cart recovery is best-effort; the captured URL/screenshot still provide a handoff.
      }
    }
  }
  if (checkoutOpened) {
    await waitForSoftNavigation(page, 2400);
    await emit(
      'Opened checkout handoff',
      'Reached a cart or checkout handoff surface. The worker will stop before login, payment, or final submit.',
      'browser_checkout_handoff'
    );
  } else if (productOpened) {
    await emit(
      'Product handoff ready',
      addToCartClicked
        ? 'The item page/cart state is ready for review, but no safe checkout handoff control was available before the worker boundary.'
        : 'The worker opened a likely product page and saved it for review because no safe add-to-cart control was available before the worker boundary.',
      addToCartClicked ? 'browser_cart_handoff' : 'browser_product_handoff'
    );
  } else {
    await emit(
      'Search handoff ready',
      'The worker searched the site and saved the current results page, but did not find a safe product link before the worker boundary.',
      'browser_search_handoff'
    );
  }

  return { productOpened, addToCartClicked, checkoutOpened, steps };
}

export async function runAssistedBrowserWorkerExecution(session, options = {}) {
  const onProgress = options.onProgress;
  const inputs = getBrowserWorkerInputs(session);
  if (!inputs.targetUrl) {
    return {
      mode: 'missing_target',
      browserAvailable: false,
      targetUrl: null,
      stopState: 'needs_user_input',
      paymentPolicy: evaluateBrowserPaymentPolicy(inputs, ''),
      localCheckoutRunner: buildLocalCheckoutRunnerPolicy(inputs, ''),
      notes: 'Add a target URL before running the browser worker.',
      ...inputs
    };
  }

  const localBrowserRuntimeRequested = Boolean(
    options.cdpUrl ||
    options.userDataDir ||
    process.env.MAGIC_CITY_BROWSER_CDP_URL ||
    process.env.MAGIC_CITY_CHROME_CDP_URL ||
    process.env.MAGIC_CITY_BROWSER_USER_DATA_DIR
  );
  const targetHostForServerFastHandoff = (() => {
    try {
      return new URL(inputs.targetUrl).hostname.replace(/^www\./i, '').toLowerCase();
    } catch {
      return '';
    }
  })();
  if (!localBrowserRuntimeRequested && targetHostForServerFastHandoff.endsWith('amazon.com')) {
    const shoppingItems = Array.isArray(inputs.shoppingItems) ? inputs.shoppingItems : [];
    const maxSpend = getBrowserMaxSpendAmount(inputs);
    const softMaxItemPrice = shoppingItems.length > 1 && maxSpend != null
      ? Math.max(1, Number((maxSpend / shoppingItems.length).toFixed(2)))
      : null;
    const itemSearchHandoffs = shoppingItems.length > 1
      ? shoppingItems.map((item, index) => {
          const itemInputs = {
            ...inputs,
            goal: item,
            budget: softMaxItemPrice != null ? `$${softMaxItemPrice}` : inputs.budget
          };
          return {
            item,
            query: item,
            ordinal: index + 1,
            url: buildRetailSearchUrlForHost({
              host: targetHostForServerFastHandoff,
              origin: 'https://www.amazon.com',
              query: item,
              inputs: itemInputs
            })
          };
        })
      : [];
    const query = itemSearchHandoffs[0]?.query || buildBrowserRetailSearchQuery(inputs);
    const finalUrl = itemSearchHandoffs[0]?.url || buildRetailSearchUrlForHost({
      host: targetHostForServerFastHandoff,
      origin: 'https://www.amazon.com',
      query,
      inputs
    });
    await onProgress?.({
      label: 'Finding website',
      detail: `Preparing an Amazon search handoff for ${inputs.targetUrl}. Server-side Magic City will not attempt logged-in cart or payment steps on Amazon.`,
      state: 'browser_opening'
    });
    await onProgress?.({
      label: 'Search handoff ready',
      detail: itemSearchHandoffs.length
        ? `The server worker built ${itemSearchHandoffs.length} item-specific Amazon search handoffs from the basket. User handoff handles result review, cart, login, payment, and final approval.`
        : 'The server worker built the Amazon search URL from the task. User handoff handles result review, cart, login, payment, and final approval.',
      state: 'browser_search_handoff',
      browser: {
        tool: 'browser',
        url: finalUrl,
        title: 'Amazon search handoff',
        previewArtifact: null
      }
    });
    const paymentPolicy = evaluateBrowserPaymentPolicy(inputs, finalUrl);
    const localCheckoutRunner = buildLocalCheckoutRunnerPolicy(inputs, finalUrl);
    return {
      mode: 'browser_ready',
      browserRuntimeMode: 'server_fast_handoff',
      browserAvailable: false,
      targetUrl: inputs.targetUrl,
      finalUrl,
      pageTitle: 'Amazon search handoff',
      screenshotPath: null,
      screenshotHash: null,
      previewArtifact: null,
      currentBrowser: {
        tool: 'browser',
        url: finalUrl,
        title: 'Amazon search handoff',
        previewArtifact: null
      },
      stopState: 'browser_ready',
      stopEvidence: 'server_amazon_fast_search_handoff',
      stopSignals: {},
      paymentPolicy,
      localCheckoutRunner,
      queryFilled: Boolean(query),
      searchMethod: 'direct_amazon_search_url',
      shoppingSearchMode: itemSearchHandoffs.length ? 'best_match_per_item' : 'single_item_best_match',
      itemSearchHandoffs,
      sharedConstraints: itemSearchHandoffs.length
        ? {
            targetUrl: inputs.targetUrl,
            budget: inputs.budget,
            maxPrice: maxSpend,
            maxItemPrice: softMaxItemPrice,
            budgetScope: inputs.sharedConstraints?.budgetScope || 'total_checkout',
            budgetStrategy: 'shared_total_with_soft_per_item_search_guard'
          }
        : null,
      safeFieldsFilled: [],
      checkoutProgress: {
        productOpened: false,
        addToCartClicked: false,
        checkoutOpened: false,
        steps: itemSearchHandoffs.length
          ? itemSearchHandoffs.map((entry) => ({
              label: `Search ${entry.ordinal}: ${entry.item}`,
              state: 'browser_search_handoff',
              url: entry.url
            }))
          : [
              {
                label: 'Search handoff ready',
                state: 'browser_search_handoff',
                url: finalUrl
              }
            ]
      },
      pageTextPreview: '',
      notes: 'The server worker prepared the Amazon search handoff without launching a server browser. Finish signed-in cart, payment, and final approval yourself from the handoff.',
      ...inputs
    };
  }

  const chromium = await getChromium();
  if (!chromium) {
    return {
      mode: 'browser_adapter_unavailable',
      browserAvailable: false,
      targetUrl: inputs.targetUrl,
      stopState: 'needs_local_browser_runtime',
      paymentPolicy: evaluateBrowserPaymentPolicy(inputs, inputs.targetUrl),
      localCheckoutRunner: buildLocalCheckoutRunnerPolicy(inputs, inputs.targetUrl),
      notes: 'Playwright is not installed or available, so Magic City can only prepare the target handoff.',
      ...inputs
    };
  }

  let runtime;
  try {
    runtime = await createBrowserRuntime(chromium, options);
  } catch (error) {
    return {
      mode: 'browser_launch_failed',
      browserAvailable: false,
      targetUrl: inputs.targetUrl,
      stopState: 'needs_local_browser_runtime',
      paymentPolicy: evaluateBrowserPaymentPolicy(inputs, inputs.targetUrl),
      localCheckoutRunner: buildLocalCheckoutRunnerPolicy(inputs, inputs.targetUrl),
      notes: error instanceof Error ? error.message : 'browser_launch_failed',
      ...inputs
    };
  }

	try {
    const targetHostForFastHandoff = (() => {
      try {
        return new URL(inputs.targetUrl).hostname.replace(/^www\./i, '').toLowerCase();
      } catch {
        return '';
      }
    })();
    if (runtime.mode === 'server_ephemeral_browser' && targetHostForFastHandoff.endsWith('amazon.com')) {
      const query = buildBrowserRetailSearchQuery(inputs);
      const finalUrl = buildRetailSearchUrlForHost({
        host: targetHostForFastHandoff,
        origin: 'https://www.amazon.com',
        query,
        inputs
      });
      await onProgress?.({
        label: 'Finding website',
        detail: `Preparing an Amazon search handoff for ${inputs.targetUrl}. Server-side Magic City will not attempt logged-in cart or payment steps on Amazon.`,
        state: 'browser_opening'
      });
      await onProgress?.({
        label: 'Search handoff ready',
        detail: 'The server worker built the Amazon search URL from the task. User handoff handles result review, cart, login, payment, and final approval.',
        state: 'browser_search_handoff',
        browser: {
          tool: 'browser',
          url: finalUrl,
          title: 'Amazon search handoff',
          previewArtifact: null
        }
      });
      const paymentPolicy = evaluateBrowserPaymentPolicy(inputs, finalUrl);
      const localCheckoutRunner = buildLocalCheckoutRunnerPolicy(inputs, finalUrl);
      return {
        mode: 'browser_ready',
        browserRuntimeMode: runtime.mode,
        browserAvailable: true,
        targetUrl: inputs.targetUrl,
        finalUrl,
        pageTitle: 'Amazon search handoff',
        screenshotPath: null,
        screenshotHash: null,
        previewArtifact: null,
        currentBrowser: {
          tool: 'browser',
          url: finalUrl,
          title: 'Amazon search handoff',
          previewArtifact: null
        },
        stopState: 'browser_ready',
        stopEvidence: 'server_amazon_fast_search_handoff',
        stopSignals: {},
        paymentPolicy,
        localCheckoutRunner,
        queryFilled: Boolean(query),
        searchMethod: 'direct_amazon_search_url',
        safeFieldsFilled: [],
        checkoutProgress: {
          productOpened: false,
          addToCartClicked: false,
          checkoutOpened: false,
          steps: [
            {
              label: 'Search handoff ready',
              state: 'browser_search_handoff',
              url: finalUrl
            }
          ]
        },
        pageTextPreview: '',
        notes: 'The server worker prepared the Amazon search handoff without loading Amazon result pages. Finish signed-in cart, payment, and final approval yourself from the handoff.',
        ...inputs
      };
    }
    const context = runtime.context || await createHumanLikeContext(runtime.browser, {
      reuseExistingContext: runtime.reuseExistingContext
    });
    const page = await context.newPage();
    await onProgress?.({
      label: 'Finding website',
      detail: `Opening ${inputs.targetUrl} with the task, merchant, and max-spend policy from the execution sheet.`,
      state: 'browser_opening'
    });
    await page.goto(inputs.targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1800);
    let currentBrowser = await emitBrowserStep({
      page,
      sessionId: session.id,
      lane: 'browser',
      onProgress,
      label: 'Opened target site',
      detail: 'The browser reached the target site and is checking for captcha, login walls, payment fields, or final-submit gates.',
      state: 'browser_open'
    });
    let stopState = await detectBrowserWorkerStopState(page);
    if (isBlockingBrowserWorkerHandoff(stopState)) {
      await emitBrowserStep({
        page,
        sessionId: session.id,
        lane: 'browser',
        onProgress,
        label: stopState.state === 'needs_captcha' ? 'Blocked by site challenge' : 'Paused for your input',
        detail: stopState.state === 'needs_login'
          ? 'The page is asking for sign-in or account creation before the worker can safely continue.'
          : `The worker hit ${stopState.state.replace(/_/g, ' ')} and saved the current browser state.`,
        state: stopState.state
      });
      const previewArtifact = await captureBrowserPreview(
        page,
        session.id,
        'browser',
        stopState.state === 'needs_captcha' ? 'site-blocker' : 'browser-handoff-required'
      );
      const isProviderChallenge = stopState.state === 'needs_captcha';
      return {
	        mode: isProviderChallenge ? 'blocked_by_site' : 'handoff_required',
	        browserRuntimeMode: runtime.mode,
	        browserAvailable: !isProviderChallenge,
        targetUrl: inputs.targetUrl,
        finalUrl: page.url(),
        pageTitle: stopState.title || await page.title().catch(() => ''),
        stopState: stopState.state,
        stopEvidence: stopState.evidence,
        stopSignals: stopState.signals,
        paymentPolicy: evaluateBrowserPaymentPolicy(inputs, page.url()),
        localCheckoutRunner: buildLocalCheckoutRunnerPolicy(inputs, page.url()),
        previewArtifact,
        providerChallenge: isProviderChallenge,
        providerChallengeReason: isProviderChallenge ? 'captcha_or_bot_protection' : null,
        notes: isProviderChallenge
          ? 'The target site challenged automated browser access. Magic City paused and saved the page state for manual takeover.'
          : `Paused at ${stopState.state.replace(/_/g, ' ')} before filling fields or taking further action.`,
        ...inputs
      };
    }

    await onProgress?.({
      label: 'Searching for item',
      detail: 'A visible sign-in link alone is not a blocker. The worker is now looking for a search field or building a safe search URL.',
      state: 'browser_preparing'
    });
    const currentHostForSearch = (() => {
      try {
        return new URL(page.url() || inputs.targetUrl).hostname.replace(/^www\./i, '').toLowerCase();
      } catch {
        return '';
      }
    })();
    if (runtime.mode === 'server_ephemeral_browser' && currentHostForSearch.endsWith('amazon.com')) {
      const query = buildBrowserRetailSearchQuery(inputs);
      const searchUrl = buildRetailSearchUrlForHost({
        host: currentHostForSearch,
        origin: 'https://www.amazon.com',
        query,
        inputs
      });
      const finalUrl = searchUrl;
      await onProgress?.({
        label: 'Search handoff ready',
        detail: 'The server worker built an Amazon search URL from the task. User handoff handles result review, cart, login, payment, and final approval.',
        state: 'browser_search_handoff',
        browser: {
          tool: 'browser',
          url: finalUrl,
          title: 'Amazon search handoff',
          previewArtifact: currentBrowser?.previewArtifact || null
        }
      });
      const screenshotPath = null;
      const screenshotHash = currentBrowser?.previewArtifact?.sha256 || null;
      const previewArtifact = currentBrowser?.previewArtifact || null;
      const paymentPolicy = evaluateBrowserPaymentPolicy(inputs, finalUrl);
      const localCheckoutRunner = buildLocalCheckoutRunnerPolicy(inputs, finalUrl);
      return {
        mode: 'browser_ready',
        browserRuntimeMode: runtime.mode,
        browserAvailable: true,
        targetUrl: inputs.targetUrl,
        finalUrl,
        pageTitle: 'Amazon search handoff',
        screenshotPath,
        screenshotHash,
        previewArtifact,
        currentBrowser,
        stopState: 'browser_ready',
        stopEvidence: 'server_amazon_search_url_handoff',
        stopSignals: {},
        paymentPolicy,
        localCheckoutRunner,
        queryFilled: Boolean(query),
        searchMethod: 'direct_amazon_search_url',
        safeFieldsFilled: [],
        checkoutProgress: {
          productOpened: false,
          addToCartClicked: false,
          checkoutOpened: false,
          steps: [
            {
              label: 'Search handoff ready',
              state: 'browser_search_handoff',
              url: finalUrl
            }
          ]
        },
        pageTextPreview: '',
        notes: 'The server worker prepared the Amazon search handoff without slow server-side result rendering. Finish signed-in cart, payment, and final approval yourself from the handoff.',
        ...inputs
      };
    }
    const prep = await fillSafeBrowserWorkerFields(page, inputs);
	    if (prep.queryFilled || prep.safeFieldsFilled.length) {
      currentBrowser = await emitBrowserStep({
        page,
        sessionId: session.id,
        lane: 'browser',
        onProgress,
        label: 'Prepared site state',
        detail: [
          prep.queryFilled ? 'Submitted the goal into a visible search field.' : '',
          prep.safeFieldsFilled.length ? `Filled safe non-payment fields: ${prep.safeFieldsFilled.join(', ')}.` : ''
        ].filter(Boolean).join(' '),
	        state: 'browser_prepared'
	      });
	    }
	    const preparedUrl = page.url();
	    const preparedHost = (() => {
	      try {
	        return new URL(preparedUrl).hostname.replace(/^www\./i, '').toLowerCase();
	      } catch {
	        return '';
	      }
	    })();
	    const serverAmazonSearchHandoff = runtime.mode === 'server_ephemeral_browser'
	      && preparedHost.endsWith('amazon.com')
	      && /\/s\?/i.test(preparedUrl)
	      && prep.queryFilled;
	    if (serverAmazonSearchHandoff) {
	      await onProgress?.({
	        label: 'Search handoff ready',
	        detail: 'The worker searched Amazon and saved the results page. Server-side automation stops here to avoid unreliable cart/checkout behavior on Amazon; finish logged-in cart/payment steps yourself from the handoff.',
	        state: 'browser_search_handoff',
	        browser: {
	          tool: 'browser',
	          url: preparedUrl,
	          title: await page.title().catch(() => ''),
	          previewArtifact: currentBrowser?.previewArtifact || null
	        }
	      });
	      const screenshotPath = null;
	      const screenshotHash = currentBrowser?.previewArtifact?.sha256 || null;
	      const previewArtifact = currentBrowser?.previewArtifact || null;
	      const paymentPolicy = evaluateBrowserPaymentPolicy(inputs, preparedUrl);
	      const localCheckoutRunner = buildLocalCheckoutRunnerPolicy(inputs, preparedUrl);
	      return {
	        mode: 'browser_ready',
	        browserRuntimeMode: runtime.mode,
	        browserAvailable: true,
	        targetUrl: inputs.targetUrl,
	        finalUrl: preparedUrl,
	        pageTitle: await page.title().catch(() => ''),
	        screenshotPath,
	        screenshotHash,
	        previewArtifact,
	        currentBrowser,
	        stopState: 'browser_ready',
	        stopEvidence: 'server_amazon_search_handoff',
	        stopSignals: {},
	        paymentPolicy,
	        localCheckoutRunner,
	        queryFilled: prep.queryFilled,
	        searchMethod: prep.searchMethod || null,
	        safeFieldsFilled: prep.safeFieldsFilled,
	        checkoutProgress: {
	          productOpened: false,
	          addToCartClicked: false,
	          checkoutOpened: false,
	          steps: [
	            {
	              label: 'Search handoff ready',
	              state: 'browser_search_handoff',
	              url: preparedUrl
	            }
	          ]
	        },
	        pageTextPreview: '',
	        notes: 'The worker searched Amazon and saved the result page. Cart, login, card/payment, and final approval continue through user handoff.',
	        ...inputs
	      };
	    }
	    const checkoutProgress = await advanceRetailCheckoutFlow(page, inputs, {
	      onProgress,
	      sessionId: session.id
	    });

	    stopState = await detectBrowserWorkerStopState(page);
	    const artifactDir = getExecutionArtifactDir();
	    const screenshotPath = path.join(artifactDir, `${session.id}-browser-worker.png`);
	    const screenshotHash = await captureScreenshotHash(page, screenshotPath);
	    const previewArtifact = await captureBrowserPreview(page, session.id, 'browser', 'browser-worker-preview');
    const paymentPolicy = evaluateBrowserPaymentPolicy(inputs, page.url());
    const localCheckoutRunner = buildLocalCheckoutRunnerPolicy(inputs, page.url());
    return {
	      mode: 'browser_ready',
	      browserRuntimeMode: runtime.mode,
	      browserAvailable: true,
      targetUrl: inputs.targetUrl,
      finalUrl: page.url(),
      pageTitle: await page.title().catch(() => stopState.title || ''),
      screenshotPath,
      screenshotHash,
      previewArtifact,
      currentBrowser,
      stopState: stopState.state,
      stopEvidence: stopState.evidence,
      stopSignals: stopState.signals,
      paymentPolicy,
	      localCheckoutRunner,
	      queryFilled: prep.queryFilled,
	      searchMethod: prep.searchMethod || null,
	      safeFieldsFilled: prep.safeFieldsFilled,
	      checkoutProgress,
	      pageTextPreview: stopState.sampleText,
      notes: stopState.detected
        ? `Paused at ${stopState.state.replace(/_/g, ' ')}.`
        : 'The worker prepared the page as far as it could without crossing the handoff boundary.',
      ...inputs
	    };
	  } finally {
	    if (runtime?.shouldCloseContext && runtime.context) {
	      await runtime.context.close().catch(() => {});
	    }
	    if (runtime?.shouldCloseBrowser && runtime.browser) {
	      await closeHostedBrowser(runtime);
	    }
	  }
}

function getAtsConfirmationPatterns(atsProvider = '') {
  if (atsProvider === 'greenhouse') {
    return [
      /thank you for applying/,
      /application submitted/,
      /we have received your application/,
      /your application has been submitted/
    ];
  }
  if (atsProvider === 'lever') {
    return [
      /application submitted/,
      /thank you for applying/,
      /your application has been sent/,
      /we've received your application/
    ];
  }
  if (atsProvider === 'ashby') {
    return [
      /application received/,
      /thanks for applying/,
      /thank you for applying/,
      /your application has been submitted/
    ];
  }
  return [
    /application submitted/,
    /thank you for applying/,
    /we have received your application/,
    /your application has been submitted/
  ];
}

function getAtsBlockedPatterns(atsProvider = '') {
  const shared = [
    /please fill out this field/,
    /required field/,
    /this question is required/,
    /captcha/,
    /verify you are human/,
    /sign in to apply/,
    /log in to apply/
  ];
  if (atsProvider === 'linkedin') {
    return [...shared, /easy apply is no longer available/];
  }
  return shared;
}

function getAtsClosedPatterns(atsProvider = '') {
  const shared = [
    /job is no longer accepting applications/,
    /applications have closed/,
    /this position has been filled/,
    /job posting is no longer available/,
    /no longer accepting applications/
  ];
  if (atsProvider === 'greenhouse') {
    return [...shared, /this job is closed/];
  }
  if (atsProvider === 'lever') {
    return [...shared, /this posting is no longer active/];
  }
  if (atsProvider === 'ashby') {
    return [...shared, /this opening is no longer available/];
  }
  return shared;
}

function getAtsAuthPatterns(atsProvider = '') {
  const shared = [
    /sign in to apply/,
    /log in to apply/,
    /continue with google/,
    /continue with linkedin/,
    /create an account to apply/,
    /sign up to continue/
  ];
  if (atsProvider === 'greenhouse') {
    return [...shared, /sign in to continue your application/];
  }
  if (atsProvider === 'lever') {
    return [...shared, /sign in to continue/];
  }
  if (atsProvider === 'ashby') {
    return [...shared, /log in to continue/];
  }
  return shared;
}

function getAtsResumePatterns(atsProvider = '') {
  const shared = [
    /resume is required/,
    /upload your resume/,
    /attach your resume/,
    /cv is required/
  ];
  if (atsProvider === 'greenhouse') {
    return [...shared, /attach resume\/cv/i];
  }
  return shared;
}

function getAtsQuestionPatterns(atsProvider = '') {
  const shared = [
    /please answer/,
    /complete all required fields/,
    /additional questions/,
    /required question/,
    /question is required/
  ];
  if (atsProvider === 'lever') {
    return [...shared, /enter a valid/];
  }
  if (atsProvider === 'ashby') {
    return [...shared, /complete application/];
  }
  return shared;
}

function buildAtsTakeoverLabel(atsProvider = '', confirmationState = '', executionOwner = '') {
  const atsLabel = describeAtsProvider(atsProvider);
  const normalizedState = String(confirmationState || '').trim().toLowerCase();
  const normalizedOwner = String(executionOwner || '').trim().toLowerCase();
  if (normalizedState === 'confirmed' || normalizedState === 'submitted_pending_verification') {
    return `Open ${atsLabel} receipt`;
  }
  if (normalizedState === 'login_required') {
    return `Sign in on ${atsLabel}`;
  }
  if (normalizedState === 'resume_required') {
    return `Upload resume in ${atsLabel}`;
  }
  if (normalizedState === 'additional_questions_required') {
    return `Finish ${atsLabel} questions`;
  }
  if (normalizedState === 'job_closed') {
    return `Open ${atsLabel} listing`;
  }
  if (normalizedOwner === 'your_agent' || normalizedState === 'handoff_ready') {
    return `Continue in ${atsLabel}`;
  }
  return `Open ${atsLabel} application`;
}

function buildAtsTakeoverReason({
  atsProvider = '',
  confirmationState = '',
  executionOwner = '',
  unansweredRequiredCount = 0,
  resumeUploaded = false
} = {}) {
  const atsLabel = describeAtsProvider(atsProvider);
  const normalizedState = String(confirmationState || '').trim().toLowerCase();
  const normalizedOwner = String(executionOwner || '').trim().toLowerCase();
  if (normalizedState === 'confirmed') {
    return `${atsLabel} returned a clear application confirmation.`;
  }
  if (normalizedState === 'submitted_pending_verification') {
    return `${atsLabel} accepted the submit action, and Magic City is waiting for a clearer provider-side confirmation signal.`;
  }
  if (normalizedState === 'login_required') {
    return `${atsLabel} requires an account sign-in before the application can continue.`;
  }
  if (normalizedState === 'resume_required') {
    return `${atsLabel} still needs a resume or attachment before the application can be submitted.`;
  }
  if (normalizedState === 'additional_questions_required') {
    return `${atsLabel} still has ${Math.max(1, Number(unansweredRequiredCount || 0))} required field${Number(unansweredRequiredCount || 0) === 1 ? '' : 's'} or screening questions left to complete.`;
  }
  if (normalizedState === 'job_closed') {
    return `${atsLabel} indicates this role is no longer accepting applications.`;
  }
  if (normalizedState === 'blocked') {
    return `${atsLabel} presented a gate Magic City could not clear automatically.`;
  }
  if (normalizedOwner === 'your_agent' || normalizedState === 'handoff_ready') {
    return `${atsLabel} is ready for Your Agent to continue the last-mile browser work.`;
  }
  if (!resumeUploaded) {
    return `${atsLabel} is prepared, but the final application still needs review before submit.`;
  }
  return `${atsLabel} is prepared for the last-mile submit step.`;
}

async function detectJobSubmissionState(page, atsProvider = '', options = {}) {
  const signals = await readApplicationSurfaceSignals(page);
  const submitClicked = Boolean(options.submitClicked);
  const executionOwner = String(options.executionOwner || 'magic_city_worker').trim().toLowerCase();
  const unansweredRequiredCount = Math.max(0, Number(options.unansweredRequiredCount || 0));
  const fileRequiredCount = Math.max(0, Number(options.fileRequiredCount || 0));
  const resumeUploaded = Boolean(options.resumeUploaded);
  const currentUrl = page.url();
  const currentTitle = await page.title().catch(() => '');
  const remainingNonFileRequiredCount = Math.max(0, unansweredRequiredCount - fileRequiredCount);
  if (executionOwner === 'your_agent') {
    return {
      confirmationState: 'handoff_ready',
      confirmationLabel: 'Ready for local agent handoff',
      submissionEvidence: 'prepared_local_handoff',
      manualTakeoverLabel: buildAtsTakeoverLabel(atsProvider, 'handoff_ready', executionOwner),
      manualTakeoverReason: buildAtsTakeoverReason({ atsProvider, confirmationState: 'handoff_ready', executionOwner, unansweredRequiredCount, resumeUploaded }),
      currentUrl,
      currentTitle
    };
  }
  const confirmed = getAtsConfirmationPatterns(atsProvider).find((pattern) => pattern.test(signals));
  if (confirmed) {
    return {
      confirmationState: 'confirmed',
      confirmationLabel: 'Submission confirmed',
      submissionEvidence: confirmed.source,
      manualTakeoverLabel: buildAtsTakeoverLabel(atsProvider, 'confirmed', executionOwner),
      manualTakeoverReason: buildAtsTakeoverReason({ atsProvider, confirmationState: 'confirmed', executionOwner, unansweredRequiredCount, resumeUploaded }),
      currentUrl,
      currentTitle
    };
  }
  const closed = getAtsClosedPatterns(atsProvider).find((pattern) => pattern.test(signals));
  if (closed) {
    return {
      confirmationState: 'job_closed',
      confirmationLabel: 'Role no longer accepting applications',
      submissionEvidence: closed.source,
      manualTakeoverLabel: buildAtsTakeoverLabel(atsProvider, 'job_closed', executionOwner),
      manualTakeoverReason: buildAtsTakeoverReason({ atsProvider, confirmationState: 'job_closed', executionOwner, unansweredRequiredCount, resumeUploaded }),
      currentUrl,
      currentTitle
    };
  }
  const authRequired = getAtsAuthPatterns(atsProvider).find((pattern) => pattern.test(signals));
  if (authRequired) {
    return {
      confirmationState: 'login_required',
      confirmationLabel: 'Sign-in required',
      submissionEvidence: authRequired.source,
      manualTakeoverLabel: buildAtsTakeoverLabel(atsProvider, 'login_required', executionOwner),
      manualTakeoverReason: buildAtsTakeoverReason({ atsProvider, confirmationState: 'login_required', executionOwner, unansweredRequiredCount, resumeUploaded }),
      currentUrl,
      currentTitle
    };
  }
  const blocked = getAtsBlockedPatterns(atsProvider).find((pattern) => pattern.test(signals));
  if (blocked) {
    return {
      confirmationState: 'blocked',
      confirmationLabel: 'Blocked by the ATS',
      submissionEvidence: blocked.source,
      manualTakeoverLabel: buildAtsTakeoverLabel(atsProvider, 'blocked', executionOwner),
      manualTakeoverReason: buildAtsTakeoverReason({ atsProvider, confirmationState: 'blocked', executionOwner, unansweredRequiredCount, resumeUploaded }),
      currentUrl,
      currentTitle
    };
  }
  if (submitClicked) {
    return {
      confirmationState: 'submitted_pending_verification',
      confirmationLabel: 'Submitted, confirming receipt',
      submissionEvidence: 'submit_clicked_no_provider_receipt',
      manualTakeoverLabel: buildAtsTakeoverLabel(atsProvider, 'submitted_pending_verification', executionOwner),
      manualTakeoverReason: buildAtsTakeoverReason({ atsProvider, confirmationState: 'submitted_pending_verification', executionOwner, unansweredRequiredCount, resumeUploaded }),
      currentUrl,
      currentTitle
    };
  }
  const extraQuestions = getAtsQuestionPatterns(atsProvider).find((pattern) => pattern.test(signals));
  if (remainingNonFileRequiredCount > 0 || (extraQuestions && unansweredRequiredCount > Math.max(1, fileRequiredCount))) {
    return {
      confirmationState: 'additional_questions_required',
      confirmationLabel: 'More required answers needed',
      submissionEvidence: extraQuestions?.source || `required_fields_remaining:${unansweredRequiredCount}`,
      manualTakeoverLabel: buildAtsTakeoverLabel(atsProvider, 'additional_questions_required', executionOwner),
      manualTakeoverReason: buildAtsTakeoverReason({ atsProvider, confirmationState: 'additional_questions_required', executionOwner, unansweredRequiredCount, resumeUploaded }),
      currentUrl,
      currentTitle
    };
  }
  const resumeRequired = getAtsResumePatterns(atsProvider).find((pattern) => pattern.test(signals));
  if ((!resumeUploaded && fileRequiredCount > 0) || resumeRequired) {
    return {
      confirmationState: 'resume_required',
      confirmationLabel: 'Resume upload needed',
      submissionEvidence: resumeRequired?.source || 'resume_required_before_submit',
      manualTakeoverLabel: buildAtsTakeoverLabel(atsProvider, 'resume_required', executionOwner),
      manualTakeoverReason: buildAtsTakeoverReason({ atsProvider, confirmationState: 'resume_required', executionOwner, unansweredRequiredCount, resumeUploaded }),
      currentUrl,
      currentTitle
    };
  }
  if (unansweredRequiredCount > 0 || extraQuestions) {
    return {
      confirmationState: 'additional_questions_required',
      confirmationLabel: 'More required answers needed',
      submissionEvidence: extraQuestions?.source || `required_fields_remaining:${unansweredRequiredCount}`,
      manualTakeoverLabel: buildAtsTakeoverLabel(atsProvider, 'additional_questions_required', executionOwner),
      manualTakeoverReason: buildAtsTakeoverReason({ atsProvider, confirmationState: 'additional_questions_required', executionOwner, unansweredRequiredCount, resumeUploaded }),
      currentUrl,
      currentTitle
    };
  }
  return {
    confirmationState: 'prepared',
    confirmationLabel: 'Prepared for review',
    submissionEvidence: 'surface_prepared',
    manualTakeoverLabel: buildAtsTakeoverLabel(atsProvider, 'prepared', executionOwner),
    manualTakeoverReason: buildAtsTakeoverReason({ atsProvider, confirmationState: 'prepared', executionOwner, unansweredRequiredCount, resumeUploaded }),
    currentUrl,
    currentTitle
  };
}

async function createResumePdf(browser, sessionId, resumeText = '') {
  if (!String(resumeText || '').trim()) return null;
  const artifactDir = getExecutionArtifactDir();
  const filePath = path.join(artifactDir, `${sessionId}-resume.pdf`);
  const page = await browser.newPage({ viewport: { width: 900, height: 1200 } });
  await page.setContent(`
    <html>
      <body style="font-family: Arial, sans-serif; white-space: pre-wrap; padding: 32px; line-height: 1.45; font-size: 12px; color: #111;">
        ${escapeHtml(resumeText)}
      </body>
    </html>
  `);
  await page.pdf({
    path: filePath,
    format: 'Letter',
    margin: { top: '16mm', right: '14mm', bottom: '16mm', left: '14mm' },
    printBackground: false
  });
  await page.close();
  return {
    filePath,
    sha256: sha256File(filePath)
  };
}

async function extractJobCandidateLinks(page, pattern, max = 3) {
  return page.evaluate(({ patternSource, patternFlags, maxLinks }) => {
    const regex = new RegExp(patternSource, patternFlags);
    const rows = [];
    const seen = new Set();
    for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
      const href = anchor.href || '';
      const text = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
      if (!href || !text || text.length < 4) continue;
      if (!regex.test(href)) continue;
      if (seen.has(href)) continue;
      seen.add(href);
      rows.push({ href, text: text.slice(0, 160) });
      if (rows.length >= maxLinks) break;
    }
    return rows;
  }, {
    patternSource: pattern.source,
    patternFlags: pattern.flags,
    maxLinks: max
  });
}

async function fillJobApplicationPage(page, applicantProfile, resumePdfPath, submissionMode, options = {}) {
  const atsProvider = String(options.atsProvider || '').trim().toLowerCase() || 'generic';
  const executionOwner = String(options.executionOwner || 'magic_city_worker').trim().toLowerCase();
  const nameParts = String(applicantProfile.applicantName || '').trim().split(/\s+/).filter(Boolean);
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';
  const filledFields = [];
  const tryFill = async (label, selectors, value) => {
    const filled = await tryFillFirst(page, selectors, value);
    if (filled) filledFields.push(label);
    return filled;
  };

  await tryFill('first_name', getJobFieldSelectors(atsProvider, 'first_name'), firstName);
  await tryFill('last_name', getJobFieldSelectors(atsProvider, 'last_name'), lastName);
  await tryFill('full_name', getJobFieldSelectors(atsProvider, 'full_name'), applicantProfile.applicantName);
  await tryFill('email', getJobFieldSelectors(atsProvider, 'email'), applicantProfile.applicantEmail);
  await tryFill('phone', getJobFieldSelectors(atsProvider, 'phone'), applicantProfile.applicantPhone);
  await tryFill('linkedin', getJobFieldSelectors(atsProvider, 'linkedin'), applicantProfile.linkedinUrl);
  await tryFill('portfolio', getJobFieldSelectors(atsProvider, 'portfolio'), applicantProfile.portfolioUrl);
  await tryFill('cover_letter', getJobFieldSelectors(atsProvider, 'cover_letter'), applicantProfile.coverLetterNotes);

  let resumeUploaded = false;
  if (resumePdfPath) {
    for (const selector of getResumeFileSelectors(atsProvider)) {
      const locator = page.locator(selector).first();
      try {
        if (await locator.count()) {
          await locator.setInputFiles(resumePdfPath);
          resumeUploaded = true;
          break;
        }
      } catch {
        // keep trying
      }
    }
  }

  const requirementStats = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('input, textarea, select'))
      .filter((node) => !node.disabled);
    const requiredNodes = nodes.filter((node) => (
      node.required || String(node.getAttribute('aria-required') || '').toLowerCase() === 'true'
    ));
    let unansweredRequiredCount = 0;
    let fileRequiredCount = 0;
    for (const node of requiredNodes) {
      const tag = String(node.tagName || '').toLowerCase();
      const type = String(node.getAttribute('type') || '').toLowerCase();
      const value = tag === 'select' ? String(node.value || '') : String(node.value || '');
      const checked = type === 'checkbox' || type === 'radio' ? Boolean(node.checked) : true;
      const fileCount = type === 'file' ? Number(node.files?.length || 0) : 0;
      const missing = type === 'file'
        ? fileCount === 0
        : type === 'checkbox' || type === 'radio'
          ? !checked
          : !value.trim();
      if (missing) unansweredRequiredCount += 1;
      if (type === 'file') fileRequiredCount += 1;
    }
    return {
      requiredCount: requiredNodes.length,
      unansweredRequiredCount,
      fileRequiredCount,
      resumeInputPresent: nodes.some((node) => String(node.getAttribute('type') || '').toLowerCase() === 'file')
    };
  }).catch(() => ({
    requiredCount: 0,
    unansweredRequiredCount: 0,
    fileRequiredCount: 0,
    resumeInputPresent: false
  }));
  const requiredCount = Number(requirementStats.requiredCount || 0) || 0;
  const unansweredRequiredCount = Number(requirementStats.unansweredRequiredCount || 0) || 0;
  let submitClicked = false;
  const shouldAutoSubmit = submissionMode === 'auto_submit_simple_forms'
    && executionOwner !== 'your_agent'
    && requiredCount <= 6
    && unansweredRequiredCount === 0
    && filledFields.length >= 3;
  if (shouldAutoSubmit) {
    for (const selector of getSubmitSelectors(atsProvider)) {
      const locator = page.locator(selector).first();
      try {
        if (await locator.count()) {
          await locator.click({ timeout: 1500 });
          submitClicked = true;
          await page.waitForTimeout(1200);
          break;
        }
      } catch {
        // keep looking
      }
    }
  }

  return {
    atsProvider,
    filledFields,
    resumeUploaded,
    requiredCount,
    unansweredRequiredCount,
    fileRequiredCount: Number(requirementStats.fileRequiredCount || 0) || 0,
    resumeInputPresent: Boolean(requirementStats.resumeInputPresent),
    submitClicked
  };
}

export async function runFoodExecutionInBrowser(session, options = {}) {
  const onProgress = options.onProgress;
  const localPrivate = session?.localPrivateContext ?? {};
  const selections = session?.finalSelections ?? session?.selections ?? {};
  const localContext = session?.localContext ?? {};
  const orderMode = selections.deliveryMode || 'Delivery';
  const selectedRestaurantSource =
    session?.liveDiscovery?.restaurants?.find((entry) => entry?.name === selections.restaurant)?.sourceUrl ||
    null;
  const targetUrl =
    selectedRestaurantSource ||
    session?.resolvedOrderUrl ||
    session?.handoffData?.providerLinks?.find((link) => link?.preferredForExecution)?.url ||
    session?.handoffData?.providerLinks?.[0]?.url ||
    session?.fulfillment?.handoff?.url ||
    null;

  if (!targetUrl) {
    return {
      mode: 'missing_target',
      targetUrl: null,
      browserAvailable: false,
      notes: 'No live provider target was available for browser execution.'
    };
  }

  const chromium = await getChromium();
  if (!chromium) {
    return {
      mode: 'browser_adapter_unavailable',
      targetUrl,
      browserAvailable: false,
      notes: 'Playwright is not installed yet, so the execution agent can only prepare the live provider target.'
    };
  }

  let browserRuntime;
  try {
    browserRuntime = await launchHostedBrowser(chromium, {
      headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
      args: ['--disable-blink-features=AutomationControlled']
    });
  } catch (error) {
    return {
      mode: 'browser_launch_failed',
      targetUrl,
      browserAvailable: false,
      notes: error instanceof Error ? error.message : 'browser_launch_failed'
    };
  }

  try {
    const browser = browserRuntime.browser;
    const context = await createHumanLikeContext(browser);
    const page = await context.newPage();
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1800);
    const providerChallenge = await detectProviderChallenge(page);
    if (providerChallenge.detected) {
      const previewArtifact = await captureBrowserPreview(page, session.id, 'food', 'provider-challenge');
      return {
        mode: 'provider_challenge',
        targetUrl,
        finalUrl: page.url(),
        browserAvailable: false,
        pageTitle: providerChallenge.title || await page.title().catch(() => ''),
        providerChallenge: true,
        providerChallengeReason: providerChallenge.reason,
        previewArtifact,
        notes: 'The provider challenged automated access before Magic City could prepare the cart.'
      };
    }
    let currentBrowser = await emitBrowserStep({
      page,
      sessionId: session.id,
      lane: 'food',
      onProgress,
      label: 'Opened live provider page',
      detail: 'The execution agent opened the live order surface and is checking whether it can apply the prepared address and order context.',
      state: 'browser_open'
    });

    const cartItems = [
      selections.item1 ? `${selections.item1}${selections.item1Qty ? ` x${selections.item1Qty}` : ''}` : '',
      selections.item2 ? `${selections.item2}${selections.item2Qty ? ` x${selections.item2Qty}` : ''}` : ''
    ].filter(Boolean).join(', ');
    const reservationQuery = [selections.restaurant, selections.partySize, selections.reservationWindow || selections.timingHint, localPrivate.zipCode].filter(Boolean).join(' ');
    const orderQuery = orderMode === 'Reservation'
      ? reservationQuery
      : [cartItems, selections.cartNote, localContext.orderText, localContext.cuisine, localPrivate.zipCode].filter(Boolean).join(' ');
    let addressFilled = false;
    let itemsAdded = [];
    let cartPrepared = false;
    let cartOpened = false;

    const targetHost = (() => {
      try {
        return new URL(targetUrl).hostname.toLowerCase();
      } catch {
        return '';
      }
    })();
    if (targetHost.includes('toasttab.com')) {
      const toastPreparation = await prepareToastOrderPage(page, session);
      addressFilled = toastPreparation.addressFilled;
      itemsAdded = toastPreparation.itemsAdded;
      cartPrepared = toastPreparation.cartPrepared;
      cartOpened = toastPreparation.cartOpened;
      if (addressFilled) {
        currentBrowser = await emitBrowserStep({
          page,
          sessionId: session.id,
          lane: 'food',
          onProgress,
          label: 'Applied delivery address',
          detail: 'The execution agent filled the local delivery address into the provider surface without sending raw address data back through orchestration.',
          state: 'address_ready'
        });
      }
      if (itemsAdded.length) {
        currentBrowser = await emitBrowserStep({
          page,
          sessionId: session.id,
          lane: 'food',
          onProgress,
          label: 'Built provider cart',
          detail: `Added ${itemsAdded.join(', ')} to the provider cart and moved the checkout closer to final confirmation.`,
          state: 'cart_ready'
        });
      }
    }

    if (orderMode !== 'Reservation') {
      addressFilled = addressFilled || await tryFillFirst(page, [
        'input[placeholder*="address" i]',
        'input[placeholder*="delivery" i]',
        'input[aria-label*="address" i]',
        'input[name*="address" i]'
      ], [localPrivate.streetAddress, localPrivate.zipCode].filter(Boolean).join(', '));
      if (addressFilled) {
        await page.keyboard.press('Enter').catch(() => {});
        await page.waitForTimeout(1200);
        currentBrowser = await emitBrowserStep({
          page,
          sessionId: session.id,
          lane: 'food',
          onProgress,
          label: 'Applied delivery address',
          detail: 'The execution agent filled the local delivery address into the provider search surface without sending raw address data back through orchestration.',
          state: 'address_ready'
        });
      }
    }

    const queryFilled = await tryPressFirst(page, [
      'input[placeholder*="search" i]',
      'input[aria-label*="search" i]',
      'input[type="search"]'
    ], orderQuery);
    if (queryFilled) {
      await page.waitForTimeout(1800);
      await emitBrowserStep({
        page,
        sessionId: session.id,
        lane: 'food',
        onProgress,
        label: 'Searching with prepared order context',
        detail: 'The execution agent submitted the prepared restaurant and cart context to move the provider page closer to a ready-to-review cart.',
        state: 'query_ready'
      });
    }
    const challengeAfterWork = await detectProviderChallenge(page);
    if (challengeAfterWork.detected) {
      const previewArtifact = await captureBrowserPreview(page, session.id, 'food', 'provider-challenge');
      return {
        mode: 'provider_challenge',
        browserAvailable: false,
        targetUrl,
        finalUrl: page.url(),
        pageTitle: challengeAfterWork.title || await page.title().catch(() => ''),
        previewArtifact,
        providerChallenge: true,
        providerChallengeReason: challengeAfterWork.reason,
        notes: 'The provider challenged automation before Magic City could keep building the order.'
      };
    }

    const artifactDir = getExecutionArtifactDir();
    const screenshotPath = path.join(artifactDir, `${session.id}-food-execution.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const screenshotHash = sha256File(screenshotPath);
    const previewArtifact = await captureBrowserPreview(page, session.id, 'food', 'live-provider-preview');
    return {
      mode: 'browser_ready',
      browserAvailable: true,
      targetUrl,
      finalUrl: page.url(),
      pageTitle: await page.title(),
      screenshotPath,
      screenshotHash,
      previewArtifact,
      currentBrowser,
      addressFilled,
      queryFilled,
      itemsAdded,
      cartPrepared,
      cartOpened
    };
  } finally {
    await closeHostedBrowser(browserRuntime);
  }
}

export async function runTravelExecutionInBrowser(session, options = {}) {
  const onProgress = options.onProgress;
  const urls = buildTravelSearchUrls(session);
  const chromium = await getChromium();
  if (!chromium) {
    return {
      mode: 'browser_adapter_unavailable',
      targetUrl: urls.flightSearchUrl,
      browserAvailable: false,
      notes: 'Playwright is not installed yet, so the execution agent can only prepare the live flight and stay searches.',
      ...urls
    };
  }

  let browserRuntime;
  try {
    browserRuntime = await launchHostedBrowser(chromium, {
      headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined
    });
  } catch (error) {
    return {
      mode: 'browser_launch_failed',
      targetUrl: urls.flightSearchUrl,
      browserAvailable: false,
      notes: error instanceof Error ? error.message : 'browser_launch_failed',
      ...urls
    };
  }

  try {
    const browser = browserRuntime.browser;
    const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
    await page.goto(urls.flightSearchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2200);

    const searchStep = await emitBrowserStep({
      page,
      sessionId: session.id,
      lane: 'travel',
      onProgress,
      label: 'Opened live flight search',
      detail: `The execution agent opened a live flight search from ${urls.homeAirport} to ${urls.destination} for ${urls.travelWindow}.`,
      state: 'searching_flights'
    });

    const artifactDir = getExecutionArtifactDir();
    const screenshotPath = path.join(artifactDir, `${session.id}-travel-execution.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const screenshotHash = sha256File(screenshotPath);
    const previewArtifact = await captureBrowserPreview(page, session.id, 'travel', 'live-flight-search');

    return {
      mode: 'browser_ready',
      browserAvailable: true,
      targetUrl: urls.flightSearchUrl,
      finalUrl: page.url(),
      pageTitle: await page.title(),
      screenshotPath,
      screenshotHash,
      previewArtifact,
      currentBrowser: searchStep,
      ...urls
    };
  } finally {
    await closeHostedBrowser(browserRuntime);
  }
}

export async function runJobApplicationExecutionInBrowser(session, options = {}) {
  const onProgress = options.onProgress;
  const search = buildJobSearchTargets(session);
  const planningOnly = search.jobMode === JOB_APPLICATION_MODE_PLAN;
  const chromium = await getChromium();
  if (!chromium) {
    return {
      mode: planningOnly ? 'browser_plan_unavailable' : 'browser_adapter_unavailable',
      browserAvailable: false,
      notes: 'Playwright is not installed yet, so the execution agent can only prepare search targets.',
      ...search
    };
  }

  let browserRuntime;
  try {
    browserRuntime = await launchHostedBrowser(chromium, {
      headless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
      executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined
    });
  } catch (error) {
    return {
      mode: planningOnly ? 'browser_plan_launch_failed' : 'browser_launch_failed',
      browserAvailable: false,
      notes: error instanceof Error ? error.message : 'browser_launch_failed',
      ...search
    };
  }

  try {
    const browser = browserRuntime.browser;
    const context = await createHumanLikeContext(browser);
    const page = await context.newPage();
    const resumePdf = await createResumePdf(browser, session.id, search.applicantProfile.resumeText);
    const applications = [];

    for (const target of search.targets.slice(0, Math.min(search.applicationLimit, search.targets.length))) {
      await page.goto(target.searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(1800);
      await emitBrowserStep({
        page,
        sessionId: session.id,
        lane: 'job',
        onProgress,
        label: `Searching ${target.label}`,
        detail: `Searching ${target.label} for ${search.targetRole} in ${search.locationPreference}.`,
        state: 'searching_jobs'
      });

      const candidates = await extractJobCandidateLinks(page, target.linkPattern, planningOnly ? 4 : 2);
      if (!candidates.length) {
        applications.push({
          board: target.board,
          label: target.label,
          atsProvider: target.atsProvider,
          atsLabel: target.atsLabel,
          executionOwner: search.executionOwner,
          executionOwnerLabel: search.executionOwnerLabel,
          status: 'no_matches_found',
          searchUrl: target.searchUrl,
          nextHumanAction: 'Widen the search filters, add more boards, or loosen the location constraint before running this search again.',
          observedAt: new Date().toISOString()
        });
        continue;
      }

      if (planningOnly) {
        for (const candidate of candidates.slice(0, Math.max(1, Math.min(2, search.applicationLimit - applications.length)))) {
          await page.goto(candidate.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await page.waitForTimeout(1600);
          await emitBrowserStep({
            page,
            sessionId: session.id,
            lane: 'job',
            onProgress,
            label: `Reviewed ${target.label} match`,
            detail: `Researching a likely ${target.label} role for ${search.targetRole} in ${search.locationPreference} and preparing the application plan ledger.`,
            state: 'reviewing_fit'
          });

          const previewArtifact = await captureBrowserPreview(page, session.id, 'job', `${target.board}-research-preview-${applications.length + 1}`);
          applications.push({
            board: target.board,
            label: target.label,
            atsProvider: detectAtsProvider(candidate.href, target.atsProvider || target.board),
            atsLabel: describeAtsProvider(detectAtsProvider(candidate.href, target.atsProvider || target.board)),
            executionOwner: search.executionOwner,
            executionOwnerLabel: search.executionOwnerLabel,
            searchUrl: target.searchUrl,
            jobUrl: candidate.href,
            jobTitle: candidate.text,
            status: 'research_ready',
            nextHumanAction: 'Review this role in the plan and promote it into an application run if it fits.',
            requiredCount: 0,
            resumeUploaded: false,
            previewArtifact,
            observedAt: new Date().toISOString()
          });

          if (applications.length >= search.applicationLimit) break;
        }
        if (applications.length >= search.applicationLimit) break;
        continue;
      }

      const candidate = candidates[0];
      await page.goto(candidate.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(1600);
      const atsProvider = detectAtsProvider(candidate.href, target.atsProvider || target.board);
      const atsLabel = describeAtsProvider(atsProvider);
      const applySurfaceOpened = await openJobApplicationSurface(page, atsProvider);
      await emitBrowserStep({
        page,
        sessionId: session.id,
        lane: 'job',
        onProgress,
        label: `Opened ${atsLabel} application`,
        detail: search.executionOwner === 'your_agent'
          ? `Prepared the ${atsLabel} application surface so ${search.requesterAgent?.name || 'Your Agent'} can take over the brittle last-mile browser work.`
          : `Inspecting the first matching ${atsLabel} application page and preparing applicant fields.`,
        state: 'prefilling_application'
      });

      const fillResult = search.executionOwner === 'your_agent'
        ? {
            atsProvider,
            filledFields: [],
            resumeUploaded: false,
            requiredCount: await page.evaluate(() =>
              Array.from(document.querySelectorAll('input[required], textarea[required], select[required]')).length
            ).catch(() => 0),
            unansweredRequiredCount: 0,
            fileRequiredCount: 0,
            resumeInputPresent: await page.evaluate(() =>
              Array.from(document.querySelectorAll('input[type="file"]')).length > 0
            ).catch(() => false),
            submitClicked: false
          }
        : await fillJobApplicationPage(
            page,
            search.applicantProfile,
            resumePdf?.filePath || null,
            search.submissionMode,
            {
              atsProvider,
              executionOwner: search.executionOwner
            }
          );
      const previewArtifact = await captureBrowserPreview(page, session.id, 'job', `${target.board}-application-preview`);
      const submissionState = await detectJobSubmissionState(page, atsProvider, {
        submitClicked: fillResult.submitClicked,
        executionOwner: search.executionOwner,
        unansweredRequiredCount: fillResult.unansweredRequiredCount,
        fileRequiredCount: fillResult.fileRequiredCount,
        resumeUploaded: fillResult.resumeUploaded,
        resumeInputPresent: fillResult.resumeInputPresent
      });
      const applicationUrl = submissionState.currentUrl || page.url();
      const rowStatus = submissionState.confirmationState === 'confirmed' || submissionState.confirmationState === 'submitted_pending_verification'
        ? 'submitted'
        : search.executionOwner === 'your_agent'
          ? 'prepared_for_agent'
          : ['blocked', 'job_closed', 'login_required'].includes(String(submissionState.confirmationState || '').trim().toLowerCase())
            ? 'blocked'
            : 'prepared_for_review';
      applications.push({
        board: target.board,
        label: target.label,
        atsProvider,
        atsLabel,
        executionOwner: search.executionOwner,
        executionOwnerLabel: search.executionOwnerLabel,
        searchUrl: target.searchUrl,
        jobUrl: candidate.href,
        applicationUrl,
        manualTakeoverUrl: applicationUrl || candidate.href || target.searchUrl,
        manualTakeoverLabel: submissionState.manualTakeoverLabel || buildAtsTakeoverLabel(atsProvider, submissionState.confirmationState, search.executionOwner),
        manualTakeoverReason: submissionState.manualTakeoverReason || buildAtsTakeoverReason({
          atsProvider,
          confirmationState: submissionState.confirmationState,
          executionOwner: search.executionOwner,
          unansweredRequiredCount: fillResult.unansweredRequiredCount,
          resumeUploaded: fillResult.resumeUploaded
        }),
        nextHumanAction: submissionState.manualTakeoverReason || null,
        jobTitle: candidate.text,
        status: rowStatus,
        filledFields: fillResult.filledFields,
        requiredCount: fillResult.requiredCount,
        unansweredRequiredCount: fillResult.unansweredRequiredCount,
        resumeUploaded: fillResult.resumeUploaded,
        applySurfaceOpened,
        confirmationState: submissionState.confirmationState,
        confirmationLabel: submissionState.confirmationLabel,
        submissionEvidence: submissionState.submissionEvidence,
        currentPageTitle: submissionState.currentTitle || await page.title().catch(() => candidate.text),
        previewArtifact,
        observedAt: new Date().toISOString()
      });

      if (applications.length >= search.applicationLimit) break;
    }

    return {
      mode: planningOnly ? 'browser_plan_ready' : 'browser_ready',
      browserAvailable: true,
      applications,
      executionOwner: search.executionOwner,
      executionOwnerLabel: search.executionOwnerLabel,
      resumeArtifact: resumePdf
        ? {
            url: `/artifacts/${path.basename(resumePdf.filePath)}`,
            sha256: resumePdf.sha256
          }
        : null,
      currentBrowser: applications[applications.length - 1]?.previewArtifact
        ? {
            tool: 'browser',
            url: applications[applications.length - 1].jobUrl || applications[applications.length - 1].searchUrl || '',
            title: applications[applications.length - 1].jobTitle || applications[applications.length - 1].label,
            previewArtifact: applications[applications.length - 1].previewArtifact
          }
        : null,
      ...search
    };
  } finally {
    await closeHostedBrowser(browserRuntime);
  }
}

export async function discoverFoodOptionsInBrowser(session) {
  const localPrivate = session?.localPrivateContext ?? {};
  const selections = session?.finalSelections ?? session?.selections ?? {};
  const localContext = session?.localContext ?? {};
  const orderMode = selections.deliveryMode || 'Delivery';
  const targetUrl =
    session?.handoffData?.providerLinks?.find((link) => link?.preferredForExecution)?.url ||
    session?.handoffData?.providerLinks?.[0]?.url ||
    null;

  if (!targetUrl) {
    return {
      mode: 'missing_target',
      restaurants: [],
      notes: 'No live provider target was available for discovery.'
    };
  }

  const chromium = await getChromium();
  if (!chromium) {
    return {
      mode: 'browser_adapter_unavailable',
      restaurants: [],
      notes: 'Playwright is not installed yet, so live restaurant discovery is unavailable.'
    };
  }

  const browserRuntime = await launchHostedBrowser(chromium, {
    headless: process.env.PLAYWRIGHT_HEADLESS !== 'false'
  });

  try {
    const browser = browserRuntime.browser;
    const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1800);

    const addressValue = [localPrivate.streetAddress, localPrivate.zipCode].filter(Boolean).join(', ');
    const orderQuery = orderMode === 'Reservation'
      ? [selections.restaurant, selections.partySize, selections.reservationWindow || selections.timingHint, localPrivate.zipCode].filter(Boolean).join(' ')
      : [selections.cartNote, localContext.orderText, localContext.cuisine, localPrivate.zipCode].filter(Boolean).join(' ');
    if (orderMode !== 'Reservation') {
      await tryFillFirst(page, [
        'input[placeholder*="address" i]',
        'input[placeholder*="delivery" i]',
        'input[aria-label*="address" i]',
        'input[name*="address" i]'
      ], addressValue);
      await page.keyboard.press('Enter').catch(() => {});
      await page.waitForTimeout(1200);
    }
    await tryPressFirst(page, [
      'input[placeholder*="search" i]',
      'input[aria-label*="search" i]',
      'input[type="search"]'
    ], orderQuery);
    await page.waitForTimeout(2200);

    const restaurants = await page.evaluate(() => {
      const seen = new Set();
      const rows = [];
      const nodes = Array.from(document.querySelectorAll('a, [role="link"], article, [data-testid*="store"]'));
      for (const node of nodes) {
        const href = node.getAttribute?.('href') || '';
        const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length < 4 || text.length > 180) continue;
        const looksLikeRestaurant = /store|restaurant|delivery|sushi|pizza|thai|burger|taco|ramen/i.test(href + ' ' + text);
        if (!looksLikeRestaurant) continue;
        const name = text.split(/ · |\n| from /)[0].trim();
        if (!name || name.length < 3 || name.length > 80) continue;
        if (seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        rows.push({ name, sourceText: text.slice(0, 180) });
        if (rows.length >= 8) break;
      }
      return rows;
    });

    return {
      mode: 'live_provider_discovery',
      restaurants,
      finalUrl: page.url(),
      notes: restaurants.length
        ? `Discovered ${restaurants.length} live restaurant candidates from the provider surface.`
        : 'The provider page opened, but no live restaurant cards were extracted.'
    };
  } finally {
    await closeHostedBrowser(browserRuntime);
  }
}
