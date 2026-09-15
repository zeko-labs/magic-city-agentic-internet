(() => {
  // Each executeScript call gets a fresh lexical scope, but the extension's
  // isolated world survives. Reinstall the current handler on every command
  // while keeping only one runtime listener below; otherwise an earlier
  // executor closure can answer a later command with stale page state.
  globalThis.__magicCityExecutorInstalled = true;

  const FINAL_ACTION_PATTERN = /place (your )?order|confirm purchase|complete purchase|pay now|submit order|buy now|confirm and pay/i;
  const FINAL_ORDER_PATTERN = /place (your )?order|confirm purchase|complete purchase|pay now|submit order|confirm and pay/i;
  const LOGIN_PATTERN = /sign in to continue|log in to continue|enter your email or mobile phone number|account sign in/i;
  const CHALLENGE_PATTERN = /captcha|verify you are human|checking your browser|just a moment|access denied|security challenge/i;
  const PAYMENT_PATTERN = /card number|security code|cvv|cvc|expiration date|expiry date/i;
  const OPTIONAL_OFFER_PATTERN = /(?:try|get|join|start).*prime|prime.*(?:free|trial|membership|one-day delivery)|without prime|with prime|auto-renew|subscribe\s*&\s*save|protection plan|warranty|add-on|special offer|limited time offer|upsell|no thanks/i;
  const DECLINE_OFFER_PATTERN = /^(?:no thanks|not now|skip|decline|continue without(?: prime| trial| offer| add-ons?)?|continue to checkout|continue without benefits|maybe later|keep my current delivery|do not add|no,? thanks|i'?ll pass)$/i;
  const POSITIVE_OFFER_PATTERN = /(?:get|join|start|try|add|accept|yes|claim).*(?:prime|trial|membership|free one-day|protection|warranty)|subscribe\s*&\s*save/i;
  const SELECTED_CANDIDATE_TTL_MS = 2 * 60 * 1000;
  const RECENT_BROWSER_ACTIONS_LIMIT = 12;
  const BROWSER_ACTION_RECEIPTS_STORAGE_KEY = 'magic_city_browser_action_receipts_v1';
  const recentBrowserActions = loadBrowserActionReceipts();
  let activeActionContext = null;
  const US_STATE_CODES = {
    alabama: 'al', alaska: 'ak', arizona: 'az', arkansas: 'ar', california: 'ca', colorado: 'co', connecticut: 'ct', delaware: 'de', florida: 'fl', georgia: 'ga', hawaii: 'hi', idaho: 'id', illinois: 'il', indiana: 'in', iowa: 'ia', kansas: 'ks', kentucky: 'ky', louisiana: 'la', maine: 'me', maryland: 'md', massachusetts: 'ma', michigan: 'mi', minnesota: 'mn', mississippi: 'ms', missouri: 'mo', montana: 'mt', nebraska: 'ne', nevada: 'nv', 'new hampshire': 'nh', 'new jersey': 'nj', 'new mexico': 'nm', 'new york': 'ny', 'north carolina': 'nc', 'north dakota': 'nd', ohio: 'oh', oklahoma: 'ok', oregon: 'or', pennsylvania: 'pa', 'rhode island': 'ri', 'south carolina': 'sc', 'south dakota': 'sd', tennessee: 'tn', texas: 'tx', utah: 'ut', vermont: 'vt', virginia: 'va', washington: 'wa', 'west virginia': 'wv', wisconsin: 'wi', wyoming: 'wy'
  };

  function visible(element) {
    if (!element) return false;
    // Merchant checkout panels commonly remain mounted while their parent is
    // hidden. A child can retain dimensions in some layouts, but it is never a
    // valid target while an ancestor is explicitly hidden from the user.
    if (element.hidden || element.closest?.('[hidden], [aria-hidden="true"]')) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 4 && rect.height > 4;
  }

  function compactText(value = '', limit = 240) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  }

  function pagePlainText(limit = 30000) {
    return String(document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  }

  function textFor(element) {
    return compactText([
      element?.textContent,
      element?.value,
      element?.getAttribute?.('aria-label'),
      ariaLabelledText(element),
      element?.getAttribute?.('title'),
      element?.getAttribute?.('placeholder'),
      element?.id,
      element?.getAttribute?.('name')
    ].filter(Boolean).join(' '));
  }

  function ariaReferenceText(element, attribute = 'aria-labelledby') {
    const ids = String(element?.getAttribute?.(attribute) || '').split(/\s+/).filter(Boolean);
    if (!ids.length) return '';
    return compactText(ids.map((id) => document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || '').join(' '), 240);
  }

  function ariaLabelledText(element) {
    return ariaReferenceText(element, 'aria-labelledby');
  }

  function ariaDescribedText(element) {
    return ariaReferenceText(element, 'aria-describedby');
  }

  function visibleControlLabel(element, limit = 180) {
    const fragments = [
      element?.innerText,
      element?.textContent,
      element?.value,
      element?.getAttribute?.('aria-label'),
      ariaLabelledText(element),
      element?.closest?.('.a-button')?.innerText,
      element?.parentElement?.innerText,
      element?.getAttribute?.('title')
    ].map((fragment) => compactText(fragment, limit)).filter(Boolean);
    const uniqueFragments = fragments.filter((fragment, index) =>
      fragments.findIndex((candidate) => candidate.toLowerCase() === fragment.toLowerCase()) === index
    );
    return compactText(uniqueFragments.join(' '), limit).replace(/\s+/g, ' ').trim();
  }

  function controlDescriptor(element) {
    return compactText([
      textFor(element),
      element?.getAttribute?.('href'),
      element?.getAttribute?.('data-action'),
      element?.getAttribute?.('data-testid')
    ].filter(Boolean).join(' '), 600);
  }

  // Keep a compact, non-sensitive trace of merchant clicks. It is deliberately
  // categorical: no address text, card number, or merchant-page body is kept.
  function loadBrowserActionReceipts() {
    try {
      const stored = JSON.parse(sessionStorage.getItem(BROWSER_ACTION_RECEIPTS_STORAGE_KEY) || '[]');
      if (!Array.isArray(stored)) return [];
      return stored.slice(-RECENT_BROWSER_ACTIONS_LIMIT).map((entry) => ({
        actionId: String(entry?.actionId || '').slice(0, 96),
        actionType: String(entry?.actionType || '').slice(0, 64),
        intent: String(entry?.intent || '').slice(0, 64),
        receiptScope: String(entry?.receiptScope || '').slice(0, 192),
        kind: String(entry?.kind || '').slice(0, 64),
        phase: String(entry?.phase || '').slice(0, 64),
        controlTag: String(entry?.controlTag || '').slice(0, 32),
        controlType: String(entry?.controlType || '').slice(0, 32),
        path: String(entry?.path || '').slice(0, 240),
        at: entry?.at || null
      })).filter((entry) => entry.kind && entry.at);
    } catch {
      return [];
    }
  }

  function persistBrowserActionReceipts() {
    try {
      sessionStorage.setItem(BROWSER_ACTION_RECEIPTS_STORAGE_KEY, JSON.stringify(recentBrowserActions.slice(-RECENT_BROWSER_ACTIONS_LIMIT)));
    } catch {
      // The in-memory receipt still accompanies the current browser response.
    }
  }

  function currentBrowserActionReceipts() {
    const receiptsByIdentity = new Map();
    for (const receipt of [...loadBrowserActionReceipts(), ...recentBrowserActions]) {
      if (!receipt?.kind || !receipt?.at) continue;
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
      .slice(-RECENT_BROWSER_ACTIONS_LIMIT);
  }

  function priorBrowserActionReceipt(kind = '', context = activeActionContext) {
    const actionId = String(context?.actionId || '').trim();
    const receiptScope = String(context?.receiptScope || '').trim();
    const expectedKind = String(kind || '').trim();
    if (!actionId || !receiptScope || !expectedKind) return null;
    return [...currentBrowserActionReceipts()].reverse().find((receipt) => (
      receipt?.kind === expectedKind
      && String(receipt.actionId || '') === actionId
      && String(receipt.receiptScope || '') === receiptScope
    )) || null;
  }

  function browserClickKind(element, validatedLabel = '') {
    const directLabel = compactText([
      element?.getAttribute?.('aria-label'),
      element?.getAttribute?.('title'),
      element?.value,
      element?.innerText,
      element?.textContent
    ].filter(Boolean).join(' '), 80);
    if (/(?:^|\s)(?:x|×|close|cancel|done)(?:\s|$)/i.test(directLabel)) return 'pickup_overlay_close';
    // Payment confirmation is scoped to the control's own label. A nearby
    // Change link can inherit the whole picker text through its parent.
    if (/\buse this payment method\b/i.test(directLabel)) return 'payment_confirm';
    const text = compactText(`${validatedLabel}\n${visibleControlLabel(element, 180)}\n${controlDescriptor(element)}`, 400);
    if (/\bplace(?: your)? order|submit order|confirm and pay\b/i.test(text)) return 'final_order';
    if (/\bdeliver to this address|use this address\b/i.test(text)) return 'address_confirm';
    if (/\bdefault to this (?:delivery address|address) and payment method\b/i.test(text)) return 'merchant_checkout_default';
    return 'safe_browser_click';
  }

  function recordBrowserClick(element, context = activeActionContext, { kind = '', phase = '', validatedLabel = '' } = {}) {
    const receipt = {
      actionId: String(context?.actionId || '').slice(0, 96),
      actionType: String(context?.actionType || '').slice(0, 64),
      intent: String(context?.intent || '').slice(0, 64),
      receiptScope: String(context?.receiptScope || '').slice(0, 192),
      kind: kind || browserClickKind(element, validatedLabel),
      ...(phase ? { phase: String(phase).slice(0, 64) } : {}),
      controlTag: String(element?.tagName || '').toLowerCase().slice(0, 32),
      controlType: String(element?.getAttribute?.('type') || '').toLowerCase().slice(0, 32),
      path: String(location.pathname || '').slice(0, 240),
      at: new Date().toISOString()
    };
    recentBrowserActions.push(receipt);
    if (recentBrowserActions.length > RECENT_BROWSER_ACTIONS_LIMIT) {
      recentBrowserActions.splice(0, recentBrowserActions.length - RECENT_BROWSER_ACTIONS_LIMIT);
    }
    persistBrowserActionReceipts();
    return receipt;
  }

  function normalized(value = '') {
    return compactText(value, 600).toLowerCase();
  }

  function normalizeMatchText(value = '') {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function canonicalProductTitle(value = '') {
    const title = compactText(value, 500)
      .replace(/\s*(?:\|\s*\.{0,3}\s*)?opens in (?:a )?new tab\s*$/i, '')
      .trim();
    if (title.length < 24) return title;
    const midpoint = Math.floor(title.length / 2);
    for (let split = Math.max(12, midpoint - 2); split <= Math.min(title.length - 12, midpoint + 2); split += 1) {
      const first = title.slice(0, split).trim();
      const second = title.slice(split).trim();
      if (first.length >= 12 && normalizeMatchText(first) === normalizeMatchText(second)) return first;
    }
    return title;
  }

  function productTitleFromRow(row, link = null) {
    const titleLink = link || row?.querySelector?.('a[href*="/dp/"], a[href*="/gp/product/"]') || null;
    const rowTitle = row?.querySelector?.('.sc-product-title, [data-testid*="title" i], h2, h3') || null;
    const candidates = [
      titleLink?.querySelector?.('.a-truncate-full')?.textContent,
      rowTitle && rowTitle !== titleLink ? (rowTitle.innerText || rowTitle.textContent) : '',
      titleLink?.innerText,
      titleLink?.getAttribute?.('aria-label'),
      titleLink?.textContent
    ];
    return candidates.map(canonicalProductTitle).find(Boolean) || '';
  }

  const ADDRESS_TOKEN_ALIASES = {
    st: 'street', str: 'street', street: 'street',
    rd: 'road', road: 'road',
    ave: 'avenue', av: 'avenue', avenue: 'avenue',
    blvd: 'boulevard', boulevard: 'boulevard',
    dr: 'drive', drive: 'drive',
    ln: 'lane', lane: 'lane',
    ct: 'court', court: 'court',
    cir: 'circle', circle: 'circle',
    hwy: 'highway', highway: 'highway',
    pkwy: 'parkway', parkway: 'parkway',
    pl: 'place', place: 'place',
    ter: 'terrace', terrace: 'terrace',
    trl: 'trail', trail: 'trail',
    wy: 'way', way: 'way',
    n: 'north', north: 'north',
    s: 'south', south: 'south',
    e: 'east', east: 'east',
    w: 'west', west: 'west',
    ne: 'northeast', northeast: 'northeast',
    nw: 'northwest', northwest: 'northwest',
    se: 'southeast', southeast: 'southeast',
    sw: 'southwest', southwest: 'southwest'
  };
  const ADDRESS_UNIT_MARKERS = new Set(['apt', 'apartment', 'unit', 'suite', 'ste']);
  const ADDRESS_NOISE_TOKENS = new Set(['united', 'states', 'usa', 'phone', 'number']);

  function canonicalAddressTokens(value = '') {
    const withUnitMarkers = String(value || '').replace(/#\s*([a-z0-9-]+)/gi, ' unit $1 ');
    return normalizeMatchText(withUnitMarkers)
      .split(/\s+/)
      .filter(Boolean)
      .map((token) => ADDRESS_TOKEN_ALIASES[token] || token);
  }

  function addressZip5(value = '') {
    return String(value || '').match(/\b(\d{5})(?:-?\d{4})?\b/)?.[1] || '';
  }

  function addressUnit(value = '') {
    const tokens = canonicalAddressTokens(value);
    for (let index = 0; index < tokens.length - 1; index += 1) {
      if (ADDRESS_UNIT_MARKERS.has(tokens[index])) return tokens[index + 1];
    }
    return '';
  }

  function streetIdentity(value = '') {
    const tokens = canonicalAddressTokens(value);
    const zip = addressZip5(value);
    const unit = addressUnit(value);
    const houseIndex = tokens.findIndex((token) => /^\d+[a-z]?$/.test(token) && token !== zip);
    const houseNumber = houseIndex >= 0 ? tokens[houseIndex] : '';
    const streetTokens = [];
    for (let index = houseIndex + 1; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (ADDRESS_UNIT_MARKERS.has(token)) break;
      if (token === zip || /^\d{5}(?:\d{4})?$/.test(token) || ADDRESS_NOISE_TOKENS.has(token)) continue;
      streetTokens.push(token);
    }
    return { houseNumber, streetTokens, unit, zip };
  }

  function activeModalRoot() {
    const dialogs = Array.from(document.querySelectorAll('dialog[open], [aria-modal="true"], [role="dialog"]'))
      .filter((dialog) => {
        if (dialog.hidden || dialog.closest('[hidden]')) return false;
        if (visible(dialog)) return true;
        return Array.from(dialog.querySelectorAll('button, a, input, textarea, select, [role="button"]')).some(visible);
      });
    return dialogs.at(-1) || null;
  }

  function waitForPaint(milliseconds = 60) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function isPickupChooserRoot(root = null) {
    if (!root) return false;
    const text = compactText(root.innerText || root.textContent || '', 5000);
    return /\b(?:select a pickup location|find pickup locations near|pick up here|amazon locker|amazon counter|whole foods market)\b/i.test(text)
      && !/\b(?:add|edit|enter)\s+(?:a\s+)?(?:new\s+)?(?:delivery|shipping)?\s*address\b|\bstreet address\b|\bzip code\b/i.test(text);
  }

  // Amazon's pickup sheet is not consistently exposed as a semantic dialog.
  // Find a visible, bounded overlay by its own pickup content, never by the
  // checkout page that happens to contain a nearby "FREE pickup" disclosure.
  function visiblePickupChooserRoots() {
    const candidates = new Set();
    const selectors = [
      'dialog[open]', '[aria-modal="true"]', '[role="dialog"]',
      '.a-popover', '.a-modal-scroller', '[class*="popover" i]', '[class*="modal" i]'
    ];
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((node) => candidates.add(node));
    }
    document.querySelectorAll('h1, h2, h3, [role="heading"], button, [role="button"]').forEach((node) => {
      const text = compactText(node.innerText || node.textContent || '', 240);
      if (!/select a pickup location|find pickup locations near|pick up here|amazon locker|amazon counter|whole foods market/i.test(text)) return;
      let parent = node.parentElement;
      for (let depth = 0; parent && parent !== document.body && depth < 7; depth += 1, parent = parent.parentElement) {
        candidates.add(parent);
      }
    });
    return Array.from(candidates)
      .filter((node) => node && node !== document.body && visible(node) && isPickupChooserRoot(node))
      .sort((left, right) => {
        const score = (node) => {
          const text = compactText(node.innerText || node.textContent || '', 1500);
          const hasClose = Array.from(node.querySelectorAll('button, a, [role="button"]'))
            .some((control) => /^(?:x|×|close|cancel)$/i.test(compactText(visibleControlLabel(control, 80) || textFor(control), 80)));
          const structuralSignal = /select a pickup location|find pickup locations near/i.test(text);
          const style = getComputedStyle(node);
          const positioned = /fixed|absolute/i.test(style.position || '');
          return (hasClose ? 100 : 0) + (structuralSignal ? 40 : 0) + (positioned ? 20 : 0);
        };
        const scoreDifference = score(right) - score(left);
        if (scoreDifference) return scoreDifference;
        const depth = (node) => {
          let value = 0;
          for (let current = node; current && current !== document.body; current = current.parentElement) value += 1;
          return value;
        };
        return depth(right) - depth(left);
      });
  }

  function checkoutFinalProgressControlVisible() {
    return Array.from(document.querySelectorAll('button, a, input[type="submit"], input[type="button"], [role="button"], .a-button, .a-button-inner'))
      .some((control) => visible(control) && (
        FINAL_ORDER_PATTERN.test(visibleControlLabel(control, 220) || textFor(control))
        || /\buse this payment method\b/i.test(visibleControlLabel(control, 220) || textFor(control))
        || /\bdeliver to this address\b/i.test(visibleControlLabel(control, 220) || textFor(control))
      ));
  }

  function nonBlockingCheckoutPickupModal() {
    const modal = visiblePickupChooserRoots()[0] || null;
    if (!modal) return null;
    const checkoutish = /\/checkout|\/buy|\/gp\/buy/i.test(String(location.pathname || ''));
    if (!checkoutish || !checkoutFinalProgressControlVisible()) return null;
    return modal;
  }

  async function closeNonBlockingCheckoutPickupModal() {
    const modal = nonBlockingCheckoutPickupModal();
    if (!modal) return { closed: false, reason: 'not_visible' };
    const closeControl = Array.from(modal.querySelectorAll('button, a, input[type="button"], [role="button"]'))
      .filter(visible)
      .map((control, index) => {
        // Amazon's close button may inherit the entire pickup sheet through
        // its parent. Score the button's own label, never the sheet text.
        const directLabel = compactText([
          control.getAttribute?.('aria-label'),
          control.getAttribute?.('title'),
          control.value,
          control.innerText,
          control.textContent
        ].filter(Boolean).join(' '), 120);
        const label = compactText(visibleControlLabel(control, 120) || directLabel, 120);
        const descriptor = compactText(controlDescriptor(control), 240);
        const directClose = /(?:^|\s)(?:x|×|close|cancel|done)(?:\s|$)/i.test(directLabel);
        const closeish = directClose || /\b(?:close|cancel)\b/i.test(`${directLabel}\n${descriptor}`);
        const risky = !directClose && /\b(?:pick up here|use this pickup|select pickup|place(?: your)? order|use this payment method|deliver to this address)\b/i.test(`${label}\n${descriptor}`);
        return { control, score: (directClose ? 1000 : closeish ? 100 : 0) - (risky ? 500 : 0), index };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.control;
    const clickedCloseControl = Boolean(closeControl && immediateSafeClick(closeControl, { allowPickupOverlay: true }));
    const method = clickedCloseControl ? 'close_control' : 'escape';
    if (!clickedCloseControl) {
      try {
        modal.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
      } catch {
        return { closed: false, reason: 'close_failed' };
      }
    }
    // Do not claim success simply because a close event was dispatched. The
    // next checkout primitive must see the overlay gone before it can act.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await waitForPaint(70);
      if (!visiblePickupChooserRoots().length) return { closed: true, method };
    }
    return { closed: false, closeRequested: true, reason: 'pickup_overlay_still_visible' };
  }

  function interactionRoot() {
    if (nonBlockingCheckoutPickupModal()) return document;
    return activeModalRoot() || document;
  }

  function pickupOrLockerControl(control = null) {
    if (!control) return false;
    // Use the control's own text here. Its parent may contain unrelated
    // checkout copy such as "FREE pickup available nearby", which must not
    // make a legitimate Shipping speed Change link look like pickup.
    const directText = compactText([
      control.innerText,
      control.textContent,
      control.value,
      control.getAttribute?.('aria-label'),
      control.getAttribute?.('title'),
      control.getAttribute?.('data-testid'),
      control.getAttribute?.('href')
    ].filter(Boolean).join('\n'), 600);
    // This is intentionally an absolute veto for a home-delivery mission.
    // The direct control label is safe to inspect: unlike a parent container,
    // it cannot accidentally inherit unrelated pickup disclosure copy.
    return /\b(?:pick\s*up|pickup|amazon locker|amazon counter|whole foods|amazon fresh|local market)\b/i.test(directText);
  }

  function interactiveControls(root = null) {
    const scope = root || interactionRoot();
    return Array.from(scope.querySelectorAll('button, a, input[type="submit"], input[type="button"], [role="button"]'))
      .filter(visible);
  }

  function observationControls() {
    const scope = interactionRoot();
    const resultCardVisible = Boolean(scope.querySelector('[data-component-type="s-search-result"], [data-asin]:not([data-asin=""])'));
    if (!resultCardVisible) return interactiveControls();
    return Array.from(scope.querySelectorAll([
      'button',
      'input[type="submit"]',
      'input[type="button"]',
      '[role="button"]',
      'a[href*="/cart" i]',
      'a[href*="/basket" i]',
      'a[href*="/checkout" i]'
    ].join(','))).filter(visible);
  }

  function canonicalAddToCartControl() {
    const selectors = [
      '#add-to-cart-button',
      '[id^="add-to-cart-button"]',
      'input[name="submit.add-to-cart"]',
      'button[name="submit.add-to-cart"]',
      'input[name^="submit.add-to-cart"]',
      'button[name^="submit.add-to-cart"]',
      '[data-testid="add-to-cart-button"]',
      '[data-action*="add-to-cart" i]',
      'form[action*="/cart/add" i] input[type="submit"]',
      'form[action*="/cart/add" i] button[type="submit"]'
    ];
    return selectors
      .map((selector) => interactionRoot().querySelector(selector))
      .find((control) => visible(control) && !control.disabled && !POSITIVE_OFFER_PATTERN.test(controlDescriptor(control))) || null;
  }

  function hasVisibleSensitiveField() {
    return Array.from(interactionRoot().querySelectorAll('input, textarea, select')).some((field) => {
      if (!visible(field)) return false;
      const description = normalized([
        field.type,
        field.autocomplete,
        field.name,
        field.id,
        field.getAttribute('aria-label'),
        field.placeholder
      ].filter(Boolean).join(' '));
      return /password|current-password|new-password|cc-number|cc-csc|cc-exp|card number|security code|cvv|cvc|one-time-code|otp|verification code/.test(description);
    });
  }

  function hasVisibleCredentialField() {
    return Array.from(interactionRoot().querySelectorAll('input, textarea, select')).some((field) => {
      if (!visible(field)) return false;
      const description = normalized([
        field.type,
        field.autocomplete,
        field.name,
        field.id,
        field.getAttribute('aria-label'),
        field.placeholder
      ].filter(Boolean).join(' '));
      return /password|current-password|new-password|one-time-code|otp|verification code/.test(description);
    });
  }

  function hasVisibleLoginField() {
    return Array.from(document.querySelectorAll('input, textarea, select')).some((field) => {
      if (!visible(field)) return false;
      const description = normalized([
        field.type,
        field.autocomplete,
        field.name,
        field.id,
        field.getAttribute('aria-label'),
        field.placeholder
      ].filter(Boolean).join(' '));
      return /password|current-password|new-password|one-time-code|otp|verification code/.test(description);
    });
  }

  function checkoutFieldKind(field) {
    const description = normalized([
      field.type,
      field.autocomplete,
      field.name,
      field.id,
      field.getAttribute('aria-label'),
      field.placeholder,
      field.closest('label')?.textContent
    ].filter(Boolean).join(' '));
    if (/password|current-password|new-password|cc-|card number|credit card|debit card|payment method|security code|cvv|cvc|one-time-code|otp|verification/.test(description)) return '';
    const isBilling = /\bbilling\b/.test(description);
    const isShipping = /\b(shipping|ship to|delivery|deliver to)\b/.test(description);
    if (/email/.test(description)) return 'contactEmail';
    if (/tel|phone|mobile/.test(description)) return 'contactPhone';
    if (/full.?name|first.?name|last.?name|recipient|contact name|your name|billing name|shipping name/.test(description)) {
      if (isBilling) return 'billingContactName';
      if (isShipping) return 'shippingContactName';
      return 'contactName';
    }
    if (/address.?line.?1|street address|shipping address|delivery address|billing address|address1|address_1/.test(description)) {
      if (isBilling) return 'billingStreetAddress';
      return 'streetAddress';
    }
    if (/\b(city|town|locality)\b/.test(description)) {
      if (isBilling) return 'billingCity';
      return 'shippingCity';
    }
    if (/\b(state|province|region)\b/.test(description) && !/country|country region/.test(description)) {
      if (isBilling) return 'billingState';
      return 'shippingState';
    }
    if (/postal|zip/.test(description)) {
      if (isBilling) return 'billingZipCode';
      return 'zipCode';
    }
    if (/delivery note|delivery instruction|order note|drop.?off note/.test(description)) return 'deliveryNotes';
    return '';
  }

  function valueForCheckoutField(profile = {}, key = '') {
    if (key === 'shippingContactName') return profile.shippingContactName || profile.contactName || '';
    if (key === 'billingContactName') return profile.billingContactName || profile.contactName || '';
    if (key === 'billingStreetAddress') return profile.billingStreetAddress || profile.streetAddress || '';
    if (key === 'billingZipCode') return profile.billingZipCode || profile.zipCode || '';
    if (key === 'billingCity') return profile.billingCity || profile.shippingCity || '';
    if (key === 'billingState') return profile.billingState || profile.shippingState || '';
    return profile[key] || '';
  }

  function safeCheckoutFields() {
    return Array.from(interactionRoot().querySelectorAll('input:not([type="hidden"]), textarea, select'))
      .filter((field) => visible(field) && checkoutFieldKind(field));
  }

  function nearbyContainer(element) {
    return element?.closest?.('li, section, article, form, fieldset, [role="group"], [data-testid], [id*="address" i], [id*="payment" i], [class*="address" i], [class*="payment" i], [class*="ship" i], [class*="delivery" i]') || element?.parentElement || element;
  }

  function radioContainer(input) {
    if (input?.labels?.[0]) return input.labels[0];
    // A generic layout div can contain the entire checkout page, which makes a
    // delivery-speed radio look like an address choice. Prefer semantic rows.
    return input?.closest?.('label, [role="radio"], [role="option"], li, [data-testid*="address" i], [data-testid*="payment" i], [data-testid*="delivery" i], [id*="address" i], [id*="payment" i], [id*="delivery" i], [class*="address" i], [class*="payment" i], [class*="delivery" i]') || nearbyContainer(input);
  }

  function visibleChoiceInput(input) {
    return Boolean(input && (visible(input) || visible(radioContainer(input)) || visible(input.parentElement)));
  }

  function cardEndingMentions(value = '') {
    const text = String(value || '');
    const matches = [
      ...text.matchAll(/(?:ending|ends in|last(?:\s*4)?|card)\D{0,24}(\d{4})(?!\d)/gi),
      ...text.matchAll(/\b(?:visa|mastercard|amex|american express|discover)\D{0,32}(\d{4})(?!\d)/gi)
    ];
    return [...new Set(matches.map((match) => match[1]).filter(Boolean))];
  }

  function singlePaymentCardContext(node, text = '', source = '') {
    const normalizedText = compactText(text, 1400);
    const endings = cardEndingMentions(normalizedText);
    const paymentLike = /\b(?:visa|mastercard|amex|american express|discover|card|payment)\b/i.test(normalizedText);
    if (!node || !paymentLike || endings.length !== 1) return null;
    return { node, text: normalizedText, endings, source };
  }

  function paymentPickerScope(input) {
    let node = input?.parentElement || input;
    for (let depth = 0; node && depth < 10; depth += 1) {
      const choices = Array.from(node.querySelectorAll?.('input[type="radio"], input[type="checkbox"]') || [])
        .filter((choice) => visibleChoiceInput(choice));
      const text = compactText(node.innerText || node.textContent || '', 8000);
      const marker = compactText([
        node.id,
        node.getAttribute?.('class'),
        node.getAttribute?.('aria-label'),
        node.getAttribute?.('data-testid')
      ].filter(Boolean).join(' '), 500);
      if (choices.length >= 2
        && cardEndingMentions(text).length >= 2
        && /\b(?:payment|card)\b/i.test(marker)) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  function amazonPaymentVisualRowContext(input) {
    if (!isAmazonAddressPickerHost()) return null;
    const scope = paymentPickerScope(input);
    const anchor = input;
    if (!scope || !anchor) return null;
    const anchorRect = anchor.getBoundingClientRect();
    const anchorCenterY = (anchorRect.top + anchorRect.bottom) / 2;
    if (!Number.isFinite(anchorCenterY)) return null;

    const candidates = Array.from(scope.querySelectorAll('label, div, li, p, span, section, article'))
      .filter((node) => node !== scope && visible(node))
      .map((node) => {
        const context = singlePaymentCardContext(
          node,
          [
            node.innerText || node.textContent || '',
            node.getAttribute?.('aria-label') || '',
            ariaLabelledText(node)
          ].filter(Boolean).join('\n'),
          'amazon_visual_row'
        );
        return context ? { ...context, inputCount: node.querySelectorAll?.('input[type="radio"], input[type="checkbox"]').length || 0 } : null;
      })
      .filter((candidate) => candidate && candidate.inputCount === 0)
      .filter((candidate) => !Array.from(candidate.node.querySelectorAll('label, div, li, p, span, section, article'))
        .some((child) => child !== candidate.node
          && visible(child)
          && singlePaymentCardContext(child, child.innerText || child.textContent || '', 'child')))
      .map((candidate) => {
        const rect = candidate.node.getBoundingClientRect();
        const distance = anchorCenterY < rect.top
          ? rect.top - anchorCenterY
          : anchorCenterY > rect.bottom
            ? anchorCenterY - rect.bottom
            : 0;
        return { ...candidate, distance };
      })
      .filter((candidate) => candidate.distance <= 72)
      .sort((left, right) => left.distance - right.distance
        || left.node.getBoundingClientRect().width - right.node.getBoundingClientRect().width);
    const match = candidates[0] || null;
    const runnerUp = candidates[1] || null;
    if (!match || (runnerUp && runnerUp.distance === match.distance && runnerUp.endings[0] !== match.endings[0])) return null;
    return match;
  }

  function paymentChoiceContext(input, _expectedLast4 = '') {
    const label = input?.labels?.[0];
    const labelContext = label
      ? singlePaymentCardContext(label, [
        label.innerText || label.textContent || '',
        label.getAttribute?.('aria-label') || '',
        ariaLabelledText(label)
      ].filter(Boolean).join('\n'), 'label')
      : null;
    if (labelContext) return labelContext;

    const ariaContext = singlePaymentCardContext(input, [
      input?.getAttribute?.('aria-label') || '',
      ariaLabelledText(input),
      ariaDescribedText(input)
    ].filter(Boolean).join('\n'), 'aria');
    if (ariaContext) return ariaContext;

    let node = input;
    for (let depth = 0; node && depth < 9; depth += 1) {
      const text = compactText([
        node.innerText || node.textContent || '',
        node.getAttribute?.('aria-label') || '',
        node.getAttribute?.('data-testid') || ''
      ].filter(Boolean).join('\n'), 1400);
      const endings = cardEndingMentions(text);
      const context = singlePaymentCardContext(node, text, 'ancestor');
      const visibleChoiceCount = Array.from(node.querySelectorAll?.('input[type="radio"], input[type="checkbox"]') || [])
        .filter((choice) => visibleChoiceInput(choice)).length;
      if (context && visibleChoiceCount <= 1) return context;
      // Card mentions only accumulate while walking outward. Once an ancestor
      // contains several endings or visible choices it is shared checkout state,
      // never this input's row.
      if (endings.length && visibleChoiceCount > 1) break;
      node = node.parentElement;
    }
    return amazonPaymentVisualRowContext(input);
  }

  function paymentChoiceUnavailable(context = null, input = null) {
    return Boolean(input?.disabled || input?.getAttribute?.('aria-disabled') === 'true')
      || /\b(?:expired|currently unavailable|not available|cannot be used|update required)\b/i.test(String(context?.text || ''));
  }

  function semanticPaymentCardControls() {
    if (!isAmazonAddressPickerHost()) return [];
    return Array.from(interactionRoot().querySelectorAll('button, [role="radio"], [role="option"]'))
      .filter((control) => visible(control)
        && !control.matches?.('input')
        && !control.querySelector?.('input[type="radio"], input[type="checkbox"]'));
  }

  function semanticPaymentCardControlText(control) {
    return compactText([
      control?.getAttribute?.('aria-label') || '',
      ariaLabelledText(control),
      ariaDescribedText(control),
      control?.innerText || control?.textContent || ''
    ].filter(Boolean).join('\n'), 1400);
  }

  function semanticPaymentCardControlContext(control) {
    if (!control) return null;
    // The interactive row itself must identify exactly one card. Never climb
    // into a shared payment container that can describe several cards.
    return singlePaymentCardContext(control, semanticPaymentCardControlText(control), 'semantic_payment_control');
  }

  function semanticPaymentCardControlSelected(control) {
    if (!control) return false;
    const testId = String(control.getAttribute?.('data-testid') || '');
    return control.getAttribute?.('aria-current') === 'true'
      || control.getAttribute?.('aria-checked') === 'true'
      || control.getAttribute?.('aria-selected') === 'true'
      || control.getAttribute?.('data-selected') === 'true'
      || /^(?:checked|selected)$/i.test(String(control.getAttribute?.('data-state') || ''))
      || /^selected(?:-|_)/i.test(testId);
  }

  function semanticPaymentCardChoices() {
    return semanticPaymentCardControls()
      .map((control) => ({
        control,
        context: semanticPaymentCardControlContext(control),
        selected: semanticPaymentCardControlSelected(control),
        kind: 'semantic_control'
      }))
      .filter((choice) => choice.context?.endings?.length === 1);
  }

  function unreadableSelectedPaymentControlPresent() {
    return semanticPaymentCardControls().some((control) => semanticPaymentCardControlSelected(control)
      && cardEndingMentions(semanticPaymentCardControlText(control)).length !== 1);
  }

  function selectSemanticPaymentCardControl(choice = null) {
    const control = choice?.control;
    const context = semanticPaymentCardControlContext(control);
    const expected = String(choice?.context?.endings?.[0] || '').replace(/\D/g, '').slice(-4);
    if (!control
      || !visible(control)
      || paymentChoiceUnavailable(context, control)
      || context?.endings?.length !== 1
      || context.endings[0] !== expected) return false;
    if (semanticPaymentCardControlSelected(control)) return true;
    try {
      control.scrollIntoView?.({ block: 'center', inline: 'center' });
      control.click();
      return true;
    } catch {
      return false;
    }
  }

  function paymentChoiceInput(input) {
    if (!input || !visibleChoiceInput(input)) return false;
    if (paymentChoiceContext(input)) return true;
    const marker = compactText([
      input.id,
      input.getAttribute?.('name'),
      input.getAttribute?.('aria-label'),
      input.getAttribute?.('data-testid'),
      input.closest?.('[id*="payment" i], [class*="payment" i], [data-testid*="payment" i]')?.getAttribute?.('id'),
      input.closest?.('[id*="payment" i], [class*="payment" i], [data-testid*="payment" i]')?.getAttribute?.('class')
    ].filter(Boolean).join(' '), 600);
    return /\b(?:payment|card)\b/i.test(marker);
  }

  function paymentChoiceClickTarget(input, context = null) {
    if (!input) return null;
    // In Amazon's split-column picker the card description is a visual sibling,
    // not the radio's interactive row. Use it only as identity evidence.
    if (context?.source === 'amazon_visual_row') return input;
    const expected = String(context?.endings?.[0] || '').replace(/\D/g, '').slice(-4);
    const candidates = [
      input.labels?.[0],
      input.closest?.('label, [role="radio"], [role="option"], [data-testid*="payment" i], [id*="payment" i], [class*="payment" i], [class*="card" i]'),
      context?.node,
      radioContainer(input),
      input.parentElement
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (!visible(candidate) || candidate.disabled || candidate.getAttribute?.('aria-disabled') === 'true') continue;
      const endings = cardEndingMentions(compactText([
        candidate.innerText || candidate.textContent || '',
        candidate.getAttribute?.('aria-label') || '',
        ariaLabelledText(candidate)
      ].filter(Boolean).join('\n'), 1400));
      // A broad checkout section can mention several cards. A row click is
      // safe only when this exact visible target names the intended card.
      if (expected && (!endings.includes(expected) || endings.some((ending) => ending !== expected))) continue;
      return candidate;
    }
    return input;
  }

  function selectPaymentChoiceInput(input, context = null) {
    if (!input || input.disabled || input.getAttribute?.('aria-disabled') === 'true' || !visibleChoiceInput(input)) return false;
    const observedContext = paymentChoiceContext(input);
    const expected = String(context?.endings?.[0] || '').replace(/\D/g, '').slice(-4);
    if (!observedContext || observedContext.endings.length !== 1 || observedContext.endings[0] !== expected || paymentChoiceUnavailable(observedContext, input)) return false;
    if (input.checked || input.getAttribute?.('aria-checked') === 'true') return true;
    const target = paymentChoiceClickTarget(input, observedContext);
    try {
      target?.scrollIntoView?.({ block: 'center', inline: 'center' });
      // Invoke exactly one control. A row click can select its nested radio;
      // clicking the radio again risks toggling or advancing a sibling layout.
      (target || input).click();
      return Boolean(input.checked || input.getAttribute?.('aria-checked') === 'true');
    } catch {
      return false;
    }
  }

  function addressPickerScope(input) {
    let node = input;
    for (let depth = 0; node && depth < 12; depth += 1) {
      const text = compactText([
        node.innerText || node.textContent || '',
        node.getAttribute?.('aria-label') || '',
        ariaLabelledText(node)
      ].filter(Boolean).join('\n'), 12000);
      const choiceCount = Array.from(node.querySelectorAll?.('input[type="radio"]') || [])
        .filter((choice) => visibleChoiceInput(choice)).length;
      if (choiceCount >= 2 && /select a (?:delivery|shipping) address|delivery addresses|shipping addresses/i.test(text)) return node;
      node = node.parentElement;
    }
    return null;
  }

  function isAmazonAddressPickerHost() {
    const host = String(location.hostname || '').toLowerCase();
    // Loopback is used only by the packaged extension fixture. Production
    // address reconciliation remains intentionally Amazon-specific.
    return /(^|\.)amazon\.com$/.test(host) || host === '127.0.0.1' || host === 'localhost';
  }

  function amazonAddressRowContext(input) {
    if (!isAmazonAddressPickerHost()) return null;
    const scope = addressPickerScope(input);
    const anchor = radioContainer(input);
    if (!scope || !anchor) return null;
    const anchorRect = anchor.getBoundingClientRect();
    const anchorCenterY = (anchorRect.top + anchorRect.bottom) / 2;
    if (!Number.isFinite(anchorCenterY)) return null;

    // Amazon's address picker frequently renders the radio and its text in
    // separate columns. Read the one visible address-sized element on the
    // same visual row; never scan the entire address book for a match.
    const candidates = Array.from(scope.querySelectorAll('div, li, p, span, address, section'))
      .filter((node) => node !== scope && visible(node))
      .map((node) => ({
        node,
        text: compactText(node.innerText || node.textContent || '', 1200)
      }))
      .filter(({ node, text }) => {
        if (!addressChoiceText(text)) return false;
        const visibleRadios = Array.from(node.querySelectorAll('input[type="radio"]'))
          .filter((choice) => visibleChoiceInput(choice)).length;
        // A detail element can describe one address but must not aggregate
        // the whole selector or another radio row.
        return visibleRadios === 0 && (text.match(/\b\d{5}(?:\s*\d{4})?\b/g) || []).length === 1;
      })
      .filter(({ node, text }) => !Array.from(node.querySelectorAll('div, li, p, span, address, section'))
        .some((child) => child !== node
          && visible(child)
          && addressChoiceText(compactText(child.innerText || child.textContent || '', 1200))
          && compactText(child.innerText || child.textContent || '', 1200) !== text));

    const closest = candidates
      .map(({ node, text }) => {
        const rect = node.getBoundingClientRect();
        const distance = anchorCenterY < rect.top
          ? rect.top - anchorCenterY
          : anchorCenterY > rect.bottom
            ? anchorCenterY - rect.bottom
            : 0;
        return { node, text, distance };
      })
      .filter(({ distance }) => distance <= 72)
      .sort((left, right) => left.distance - right.distance
        || left.node.getBoundingClientRect().width - right.node.getBoundingClientRect().width);
    const match = closest[0];
    return match ? { ...match, source: 'amazon_visual_row' } : null;
  }

  function addressChoiceContext(input) {
    const label = input?.labels?.[0];
    if (label) {
      const text = compactText(label.innerText || label.textContent || '', 1200);
      if (addressChoiceText(text)) return { node: label, text, source: 'label' };
    }
    // Amazon's real picker may keep the radio in one column and the address
    // detail in a sibling column. ARIA references are the most precise link;
    // use them before inspecting layout containers.
    const ariaText = compactText([
      input?.getAttribute?.('aria-label') || '',
      ariaLabelledText(input),
      ariaDescribedText(input)
    ].filter(Boolean).join('\n'), 1200);
    if (addressChoiceText(ariaText)) return { node: input, text: ariaText, source: 'aria' };
    const amazonVisualRow = amazonAddressRowContext(input);
    if (amazonVisualRow) return amazonVisualRow;
    let node = input;
    // Walk only to a row with exactly one visible choice. Never use an address
    // book as fallback: its text can make an unrelated checked radio look like
    // the saved address.
    for (let depth = 0; node && depth < 10; depth += 1) {
      const choiceCount = Array.from(node.querySelectorAll?.('input[type="radio"]') || [])
        .filter((choice) => visibleChoiceInput(choice)).length;
      const siblingText = Array.from(node.children || [])
        .filter((child) => child !== input && !child.contains?.(input))
        .map((child) => child.innerText || child.textContent || '')
        .join('\n');
      const text = compactText([
        node.innerText || node.textContent || '',
        siblingText,
        node.getAttribute?.('aria-label') || '',
        ariaLabelledText(node),
        ariaDescribedText(node),
        node.getAttribute?.('data-testid') || ''
      ].filter(Boolean).join('\n'), 1400);
      if (choiceCount <= 1 && addressChoiceText(text)) return { node, text, source: 'row' };
      node = node.parentElement;
    }
    return null;
  }

  function selectAddressChoiceInput(input) {
    if (!input || input.disabled || input.getAttribute?.('aria-disabled') === 'true' || !visibleChoiceInput(input)) return false;
    if (input.checked || input.getAttribute?.('aria-checked') === 'true') return true;
    try {
      radioContainer(input)?.scrollIntoView?.({ block: 'center', inline: 'center' });
      input.click();
      return Boolean(input.checked || input.getAttribute?.('aria-checked') === 'true');
    } catch {
      return false;
    }
  }

  function last4FromText(value = '') {
    const text = String(value || '');
    const patterns = [
      /(?:ending|ends in|last(?:\s*4)?|card)\D{0,24}(\d{4})(?!\d)/i,
      /\b(?:visa|mastercard|amex|american express|discover)\D{0,32}(\d{4})(?!\d)/i,
      /(?<!\d)(\d{4})(?!\d)/
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) return match[1];
    }
    return '';
  }

  function selectedCardLast4() {
    const root = interactionRoot();
    const paymentInputs = Array.from(root.querySelectorAll('input[type="radio"], input[type="checkbox"]'))
      .filter((input) => paymentChoiceInput(input));
    if (paymentInputs.length) {
      const selectedInputs = paymentInputs.filter((input) => input.checked || input.getAttribute?.('aria-checked') === 'true');
      if (selectedInputs.length !== 1) return '';
      const selectedInput = selectedInputs[0];
      const context = paymentChoiceContext(selectedInput);
      if (!context || context.endings.length !== 1 || paymentChoiceUnavailable(context, selectedInput)) return '';
      const matchingEligibleInputs = paymentInputs.filter((input) => {
        const candidateContext = paymentChoiceContext(input);
        return candidateContext?.endings?.length === 1
          && candidateContext.endings[0] === context.endings[0]
          && !paymentChoiceUnavailable(candidateContext, input);
      });
      if (matchingEligibleInputs.length !== 1 || matchingEligibleInputs[0] !== selectedInput) return '';
      return context.endings[0];
    }

    const semanticChoices = semanticPaymentCardChoices();
    if (semanticChoices.length) {
      const selectedChoices = semanticChoices.filter((choice) => choice.selected && !paymentChoiceUnavailable(choice.context, choice.control));
      if (selectedChoices.length !== 1) return '';
      const selectedChoice = selectedChoices[0];
      const selectedEnding = selectedChoice.context.endings[0];
      const matchingEligibleChoices = semanticChoices.filter((choice) => choice.context.endings[0] === selectedEnding
        && !paymentChoiceUnavailable(choice.context, choice.control));
      if (matchingEligibleChoices.length !== 1 || matchingEligibleChoices[0].control !== selectedChoice.control) return '';
      return selectedEnding;
    }
    if (unreadableSelectedPaymentControlPresent()) return '';

    const ariaSelectedEndings = [...new Set(Array.from(root.querySelectorAll('[role="radio"][aria-checked="true"], [role="option"][aria-selected="true"]'))
      .filter(visible)
      .map((control) => compactText(control.innerText || control.textContent || textFor(control), 600))
      .map((text) => cardEndingMentions(text))
      .filter((endings) => endings.length === 1)
      .map((endings) => endings[0]))];
    if (ariaSelectedEndings.length === 1) return ariaSelectedEndings[0];
    if (ariaSelectedEndings.length > 1) return '';

    const summaryEnding = Array.from(root.querySelectorAll([
      '[id*="payment" i]',
      '[data-testid*="payment" i]',
      '[class*="payment-summary" i]',
      'h1',
      'h2',
      'h3',
      '[role="heading"]'
    ].join(',')))
      .filter(visible)
      .map((element) => compactText(element.innerText || element.textContent || '', 800))
      .filter((text) => /\b(?:paying with|selected payment|payment method)\b/i.test(text))
      .map((text) => cardEndingMentions(text))
      .find((endings) => endings.length === 1)?.[0];
    return summaryEnding || '';
  }

  function expectedPaymentCardIsSelected(expectedLast4 = '') {
    const expected = String(expectedLast4 || '').replace(/\D/g, '').slice(-4);
    if (!expected) return false;
    const root = interactionRoot();
    const visiblePaymentInputs = Array.from(root.querySelectorAll('input[type="radio"], input[type="checkbox"]'))
      .filter((input) => paymentChoiceInput(input));
    // When the merchant presents card choices, trust only the checked card
    // row. A stale summary must never override an explicit selection.
    if (visiblePaymentInputs.length) {
      const selectedInputs = visiblePaymentInputs.filter((input) => input.checked || input.getAttribute?.('aria-checked') === 'true');
      if (selectedInputs.length !== 1) return false;
      const selectedInput = selectedInputs[0];
      const context = paymentChoiceContext(selectedInput);
      if (!context || paymentChoiceUnavailable(context, selectedInput) || context.endings[0] !== expected) return false;
      const matchingEligibleInputs = visiblePaymentInputs.filter((input) => {
        const candidateContext = paymentChoiceContext(input);
        return candidateContext?.endings?.length === 1
          && candidateContext.endings[0] === expected
          && !paymentChoiceUnavailable(candidateContext, input);
      });
      return matchingEligibleInputs.length === 1 && matchingEligibleInputs[0] === selectedInput;
    }


    const semanticChoices = semanticPaymentCardChoices();
    if (semanticChoices.length) {
      const selectedChoices = semanticChoices.filter((choice) => choice.selected && !paymentChoiceUnavailable(choice.context, choice.control));
      if (selectedChoices.length !== 1 || selectedChoices[0].context.endings[0] !== expected) return false;
      const matchingEligibleChoices = semanticChoices.filter((choice) => choice.context.endings[0] === expected
        && !paymentChoiceUnavailable(choice.context, choice.control));
      return matchingEligibleChoices.length === 1 && matchingEligibleChoices[0].control === selectedChoices[0].control;
    }
    if (unreadableSelectedPaymentControlPresent()) return false;

    const summaryEnding = Array.from(root.querySelectorAll('h1, h2, h3, [role="heading"], [id*="payment" i], [data-testid*="payment" i]'))
      .filter(visible)
      .map((element) => compactText(element.innerText || element.textContent || '', 800))
      .filter((text) => /\b(?:paying with|selected payment|payment method)\b/i.test(text))
      .map((text) => cardEndingMentions(text))
      .find((endings) => endings.length === 1)?.[0];
    return summaryEnding === expected;
  }

  function addressLooksLikeProfile(text = '', profile = {}) {
    const profileStreet = profile.streetAddress || profile.shippingStreetAddress || '';
    const profileAddress = `${profileStreet} ${profile.zipCode || profile.shippingZipCode || ''}`;
    const expected = streetIdentity(profileAddress);
    if (!expected.houseNumber || !expected.streetTokens.length || !expected.zip) return false;
    const candidateTokens = new Set(canonicalAddressTokens(text));
    const candidateZip = addressZip5(text);
    const candidateUnit = addressUnit(text);
    if (!candidateTokens.has(expected.houseNumber) || candidateZip !== expected.zip) return false;
    // The unit is a useful tie-breaker when both sources have one. It must not
    // invalidate the same street/ZIP when Amazon puts a suite on its own line
    // or the local vault intentionally omits it.
    if (expected.unit && candidateUnit && expected.unit !== candidateUnit) return false;
    const matchedTokens = expected.streetTokens.filter((token) => candidateTokens.has(token));
    const coverage = matchedTokens.length / expected.streetTokens.length;
    const hasDistinctiveStreetToken = expected.streetTokens
      .filter((token) => !Object.values(ADDRESS_TOKEN_ALIASES).includes(token))
      .some((token) => candidateTokens.has(token));
    return coverage >= 0.8 && hasDistinctiveStreetToken;
  }

  function addressChoiceText(value = '') {
    const text = normalizeMatchText(value);
    const hasAddressShape = /\b\d{5}(?:\s*\d{4})?\b/.test(text)
      || /\bunited states\b|\bphone number\b/.test(text);
    const paymentOrDeliverySpeed = /\b(?:visa|mastercard|amex|american express|discover|card ending|payment method|fastest|one day|amazon day|delivery option)\b/.test(text);
    const pickupLocation = /\b(?:pickup locations?|amazon locker|locker|counter location|free pickup)\b/.test(text);
    return Boolean(hasAddressShape && !paymentOrDeliverySpeed && !pickupLocation);
  }

  function closedDeliverySummaryObservation(profile = {}) {
    // The final-review delivery summary remains meaningful even if an
    // unrelated pickup overlay is mounted above it.
    const root = document;
    const candidates = Array.from(root.querySelectorAll([
      'h1', 'h2', 'h3', '[role="heading"]',
      '[aria-label*="delivery" i]', '[aria-label*="shipping" i]',
      '[data-testid*="delivery" i]', '[data-testid*="shipping" i]',
      '[id*="delivery" i]', '[id*="shipping" i]',
      '[class*="delivery" i]', '[class*="shipping" i]'
    ].join(','))).filter(visible);
    for (const candidate of candidates) {
      let node = candidate;
      for (let depth = 0; node && depth < 4; depth += 1) {
        const text = compactText(node.innerText || node.textContent || '', 1800);
        // This is deliberately a closed-summary signal, not a generic address
        // search. The address chooser has "Select a delivery address" and must
        // continue to rely on its selected radio row.
        if (/\b(?:delivering|shipping)\s+to\b/i.test(text)) {
          return {
            visible: true,
            matches: addressLooksLikeProfile(text, profile)
          };
        }
        node = node.parentElement;
      }
    }
    return { visible: false, matches: false };
  }

  function visibleAddressChoices() {
    return Array.from(interactionRoot().querySelectorAll('input[type="radio"]'))
      .filter((input) => visibleChoiceInput(input))
      .filter((input) => !visiblePickupChooserRoots().some((root) => root.contains(input)))
      .map((input) => ({ input, context: addressChoiceContext(input) }))
      .filter(({ context }) => Boolean(context));
  }

  function selectedVisibleAddressChoiceMatches(profile = {}) {
    return observeSelectedAddress(profile).status === 'matched';
  }

  function observeSelectedAddress(profile = {}) {
    const rawVisibleChoices = Array.from(interactionRoot().querySelectorAll('input[type="radio"]'))
      .filter((input) => visibleChoiceInput(input));
    const visibleChoices = visibleAddressChoices();
    const addressPickerVisible = /select a (?:delivery|shipping) address|delivery addresses|shipping addresses/i.test(pagePlainText(12000));
    const closedSummary = closedDeliverySummaryObservation(profile);
    if (addressPickerVisible && rawVisibleChoices.length && !visibleChoices.length) {
      return {
        status: 'unverified',
        source: 'address_picker',
        diagnostics: {
          visibleChoiceCount: rawVisibleChoices.length,
          selectedChoiceCount: rawVisibleChoices.filter((input) => input.checked || input.getAttribute?.('aria-checked') === 'true').length,
          readableSelectedChoiceCount: 0,
          matchingSelectedChoiceCount: 0
        }
      };
    }
    if (visibleChoices.length) {
      const selectedChoices = visibleChoices.filter(({ input }) => input.checked || input.getAttribute?.('aria-checked') === 'true');
      const readableSelectedChoices = selectedChoices.filter(({ context }) => addressChoiceText(context?.text || ''));
      const matchingSelectedChoices = readableSelectedChoices.filter(({ context }) => addressLooksLikeProfile(context.text, profile));
      const directMismatchObserved = readableSelectedChoices
        .some(({ context }) => context?.source !== 'ordinal_layout');
      return {
        status: matchingSelectedChoices.length ? 'matched' : directMismatchObserved ? 'mismatched' : closedSummary.matches ? 'matched' : 'unverified',
        source: matchingSelectedChoices.length || directMismatchObserved || !closedSummary.matches ? 'address_picker' : 'checkout_summary',
        diagnostics: {
          visibleChoiceCount: visibleChoices.length,
          selectedChoiceCount: selectedChoices.length,
          readableSelectedChoiceCount: readableSelectedChoices.length,
          matchingSelectedChoiceCount: matchingSelectedChoices.length,
          selectedChoiceSources: readableSelectedChoices.map(({ context }) => context?.source || 'unknown')
        }
      };
    }
    return {
      status: closedSummary.visible ? (closedSummary.matches ? 'matched' : 'mismatched') : 'unverified',
      source: 'checkout_summary',
      diagnostics: { visibleChoiceCount: 0, selectedChoiceCount: 0, readableSelectedChoiceCount: 0, matchingSelectedChoiceCount: 0 }
    };
  }

  function selectedAddressMatches(profile = {}) {
    return observeSelectedAddress(profile).status === 'matched';
  }

  function searchControl() {
    const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea')).filter(visible);
    return inputs.find((input) => {
      const description = normalized([
        input.type,
        input.autocomplete,
        input.name,
        input.id,
        input.getAttribute('aria-label'),
        input.placeholder,
        input.closest('[role="search"]')?.getAttribute('aria-label')
      ].filter(Boolean).join(' '));
      return input.type === 'search' || input.getAttribute('role') === 'searchbox' || /\b(search|find|looking for|what are you looking)\b/.test(description);
    }) || null;
  }

  function priceFromText(value = '') {
    const match = String(value || '').match(/(?:US\s*)?\$\s*(\d{1,5}(?:\.\d{2})?)/i);
    return match ? Number(match[1]) : null;
  }

  function candidateContainer(link) {
    // Amazon search results use `s-search-result`, not a product-ish class.
    // Read the result card so title, price, and review signals stay together;
    // reading only the heading makes the hard cap look unverifiable.
    return link.closest(
      '[data-component-type="s-search-result"], [data-asin]:not([data-asin=""]), article, li, [data-testid*="product" i], [data-component-type*="product" i], [class*="product" i], [class*="item" i]'
    ) || link.parentElement || link;
  }

  function primeBadgePresent(root = document) {
    if (!root?.querySelectorAll) return false;
    const selectors = [
      '.a-icon-prime',
      '[aria-label*="prime" i]',
      '[data-csa-c-content-id*="prime" i]',
      'img[alt*="prime" i]'
    ];
    return selectors.some((selector) => Array.from(root.querySelectorAll(selector)).some((node) => {
      const evidence = compactText([
        node.getAttribute?.('aria-label') || '',
        node.getAttribute?.('alt') || '',
        node.innerText || node.textContent || ''
      ].join(' '), 240);
      return /\bprime\b/i.test(evidence) && !promotionalDeliveryOption(evidence);
    }));
  }

  function amazonAccountState(rawPageText = '') {
    const accountRoots = [
      '#nav-link-accountList',
      '#nav-link-accountList-nav-line-1',
      '#nav-logobar-greeting',
      '[data-nav-role="signin"]',
      '[data-csa-c-slot-id="nav-link-accountList"]'
    ].flatMap((selector) => Array.from(document.querySelectorAll(selector))).filter(visible);
    const accountText = compactText(accountRoots.map((node) => node.innerText || node.textContent || node.getAttribute?.('aria-label') || '').join(' '), 500);
    const signInLinkVisible = Array.from(document.querySelectorAll('a[href*="/ap/signin"], a[data-nav-ref*="signin" i]'))
      .some((link) => visible(link) && /sign in|account/i.test(textFor(link)));
    const signedOut = hasVisibleLoginField()
      || /\bhello,?\s+sign in\b|\bsign in to amazon(?:\.com)?\b/i.test(accountText)
      || signInLinkVisible;
    const signedIn = !signedOut && (
      /\bhello,?\s+(?!sign\s+in\b)[a-z0-9]/i.test(accountText)
      || /\b(?:your )?account\s*&\s*lists\b/i.test(accountText)
    );
    return {
      state: signedOut ? 'signed_out' : signedIn ? 'signed_in' : 'unknown',
      evidence: compactText(accountText || (signedOut ? rawPageText : ''), 180)
    };
  }

  function refinementDescriptor(control) {
    if (!control) return '';
    const linkedLabel = control.id
      ? document.querySelector(`label[for="${CSS.escape(control.id)}"]`)
      : null;
    const container = control.closest?.('label, li, [role="listitem"], [data-csa-c-content-id], [class*="filter" i], [class*="refinement" i]');
    return compactText([
      controlDescriptor(control),
      linkedLabel?.innerText || linkedLabel?.textContent || '',
      container?.innerText || container?.textContent || ''
    ].filter(Boolean).join(' '), 500);
  }

  function refinementClickTarget(control) {
    if (!control) return null;
    const linkedLabel = control.id
      ? document.querySelector(`label[for="${CSS.escape(control.id)}"]`)
      : null;
    return visible(control)
      ? control
      : visible(linkedLabel)
        ? linkedLabel
        : visible(control.closest?.('label'))
          ? control.closest('label')
          : null;
  }

  function refinementSelected(control) {
    if (!control) return false;
    if ('checked' in control && control.checked) return true;
    if (control.getAttribute?.('aria-checked') === 'true' || control.getAttribute?.('aria-pressed') === 'true') return true;
    const container = control.closest?.('label, li, [role="listitem"], [class*="filter" i], [class*="refinement" i]');
    return /\b(?:selected|checked|active)\b/i.test(String(container?.className || ''));
  }

  function amazonRetailSearchSurface() {
    if (!/(^|\.)amazon\.com$/i.test(String(location.hostname || ''))) return true;
    if (!/^\/s(?:\/|$)/i.test(String(location.pathname || ''))) return false;
    return Boolean(document.querySelector(
      '[data-component-type="s-search-result"], [data-asin]:not([data-asin=""])'
    ));
  }

  function amazonRefinementControlAllowed(control) {
    if (!control || !amazonRetailSearchSurface()) return false;
    if (!/(^|\.)amazon\.com$/i.test(String(location.hostname || ''))) return true;
    const identity = compactText([
      control.id,
      control.getAttribute?.('name'),
      control.getAttribute?.('aria-label'),
      control.getAttribute?.('data-csa-c-content-id'),
      control.getAttribute?.('data-filter-id'),
      control.getAttribute?.('href')
    ].filter(Boolean).join(' '), 600);
    if (control.matches?.('a[href]')) {
      try {
        const href = new URL(control.href, location.href);
        return href.origin === location.origin
          && /^\/s(?:\/|$)/i.test(href.pathname)
          && (href.searchParams.has('rh') || href.searchParams.has('refinements'))
          && /p_(?:85|76)/i.test(identity);
      } catch {
        return false;
      }
    }
    if (/p_(?:85|76)/i.test(identity)) return true;
    return Boolean(control.closest?.([
      '#s-refinements',
      '#s-refinements-left',
      '[data-component-type*="refinement" i]',
      '[data-csa-c-content-id*="refinement" i]',
      '[class*="refinement" i]',
      '[data-filter-id]',
      '[class*="filter" i]'
    ].join(',')));
  }

  function amazonSearchRefinement(kind = 'prime') {
    if (!amazonRetailSearchSurface()) return null;
    const controls = Array.from(document.querySelectorAll([
      'input[type="checkbox"]',
      '[role="switch"]',
      '[role="checkbox"]',
      'button[aria-pressed]',
      'a[href]'
    ].join(',')));
    const candidates = controls.filter(amazonRefinementControlAllowed).map((control, index) => {
      const descriptor = refinementDescriptor(control);
      const normalizedDescriptor = normalized(descriptor);
      const canonicalIdentity = normalized([
        control.id,
        control.getAttribute?.('name'),
        control.getAttribute?.('aria-label'),
        control.getAttribute?.('data-csa-c-content-id'),
        control.getAttribute?.('data-filter-id'),
        control.getAttribute?.('href')
      ].filter(Boolean).join(' '));
      const promotional = /\b(?:join|try|start|get)\s+prime\b|\bprime\s+(?:trial|membership)\b|auto-renew/i.test(descriptor);
      const deliverySpeed = /\b(?:overnight|today|tomorrow|one[- ]day|two[- ]day|by\s+\d|before\s+\d|am|pm)\b/i.test(descriptor);
      const canonicalMarker = kind === 'prime'
        ? /p_85/i.test(canonicalIdentity)
        : /p_76/i.test(canonicalIdentity);
      const matches = kind === 'prime'
        ? (canonicalMarker || /(?:^|\b)prime(?:\s+delivery)?(?:\b|$)/i.test(descriptor)) && !promotional && !deliverySpeed
        : (canonicalMarker || /\bfree\s+(?:delivery|shipping)(?:\s+by\s+amazon)?\b/i.test(descriptor)) && !promotional;
      const target = refinementClickTarget(control);
      const exact = kind === 'prime'
        ? /^(?:prime|prime delivery)$/i.test(compactText(descriptor, 80))
        : /^free (?:delivery|shipping)$/i.test(compactText(descriptor, 80));
      const score = (matches ? 50 : 0) + (canonicalMarker ? 40 : 0) + (exact ? 30 : 0) + (/checkbox|switch/.test(`${control.type || ''} ${control.getAttribute?.('role') || ''}`) ? 10 : 0);
      return { control, target, descriptor, selected: refinementSelected(control), score, index };
    }).filter((entry) => entry.target && entry.score >= 50)
      .sort((left, right) => right.score - left.score || left.index - right.index);
    return candidates[0] || null;
  }

  function amazonFulfillmentPreference(rawPageText = '') {
    const account = amazonAccountState(rawPageText);
    const prime = amazonSearchRefinement('prime');
    const freeShipping = amazonSearchRefinement('free_shipping');
    return {
      accountState: account.state,
      accountEvidence: account.evidence,
      available: prime ? 'prime' : freeShipping ? 'free_shipping' : 'none',
      selected: prime?.selected ? 'prime' : freeShipping?.selected ? 'free_shipping' : 'none'
    };
  }

  function amazonCandidateFulfillment(context = '') {
    const text = compactText(context, 1600);
    const merchantLabel = '(?:ships from|sold by|fulfilled by|shipper\\s*\\/\\s*seller)';
    const amazonFulfilled = new RegExp(`\\b${merchantLabel}\\s*:?\\s*amazon(?:\\.com)?\\b`, 'i').test(text);
    const localMarket = /\b(?:amazon fresh|whole foods(?: market)?|lucky(?: market| supermarket)?|local market|grocery delivery)\b/i.test(text);
    const merchantMentions = Array.from(text.matchAll(new RegExp(`\\b${merchantLabel}\\s*:?\\s*([^\\n|.]{2,80})`, 'gi')))
      .map((match) => String(match[1] || '').trim())
      .filter(Boolean);
    const thirdPartySeller = merchantMentions.some((merchant) => !/\bamazon(?:\.com)?\b/i.test(merchant));
    return { amazonFulfilled, localMarket, thirdPartySeller };
  }

  function candidateRows(limit = 12) {
    const seen = new Set();
    const candidates = [];
    const amazonPage = /(^|\.)amazon\.com$/i.test(String(location.hostname || ''));
    const amazonResultLinks = Array.from(document.querySelectorAll([
      '[data-component-type="s-search-result"] h2 a[href]',
      '[data-component-type="s-search-result"] a[href*="/dp/"]',
      '[data-asin]:not([data-asin=""]) h2 a[href]',
      '[data-asin]:not([data-asin=""]) a[href*="/dp/"]'
    ].join(',')));
    const links = amazonPage || amazonResultLinks.length
      ? amazonResultLinks
      : Array.from(document.querySelectorAll('a[href]'));
    for (const link of links) {
      if (!visible(link)) continue;
      const href = String(link.href || '');
      if (!href || seen.has(href) || !href.startsWith(location.origin)) continue;
      const label = textFor(link);
      const container = candidateContainer(link);
      const context = compactText(container?.innerText || label, 500);
      const haystack = normalized(`${label} ${context} ${href}`);
      const deliveryEvidence = deliveryCostEvidenceFromText(context);
      const linkIdentity = normalized(`${label} ${href}`);
      const hrefPath = new URL(href).pathname;
      const amazonResultCard = Boolean(link.closest('[data-component-type="s-search-result"], [data-asin]:not([data-asin=""])'));
      if (amazonPage && !amazonResultCard && !/\/(?:dp|gp\/product)\//i.test(hrefPath)) continue;
      if (label.length < 3 || /\b(account|sign in|help|returns|customer service|cart|checkout|privacy|terms|sponsored|advertisement)\b/.test(linkIdentity)) continue;
      const productish = /\b(product|item|add to cart|add to bag|buy|price|\$\d)/.test(haystack) || /\/(?:p|product|products|dp|item|shop)\b/i.test(new URL(href).pathname);
      if (!productish) continue;
      seen.add(href);
      const primeEligible = primeBadgePresent(container) || (/\bprime\b/.test(haystack) && !promotionalDeliveryOption(context));
      const fulfillment = amazonCandidateFulfillment(context);
      candidates.push({
        id: `candidate-${candidates.length + 1}`,
        order: candidates.length,
        asin: String(container?.getAttribute?.('data-asin') || '').trim(),
        element: link,
        container,
        title: compactText(label || context, 160),
        url: href,
        price: priceFromText(context),
        rating: Number((context.match(/\b(\d(?:\.\d)?)\s+out\s+of\s+5\s+stars?\b/i) || [])[1]) || null,
        reviewCount: Number(String((context.match(/([\d,]+)\s+(?:ratings?|reviews?)\b/i) || [])[1] || '').replace(/,/g, '')) || null,
        context: compactText(context, 320),
        sponsored: /\b(sponsored|advertisement|ad)\b/.test(haystack),
        primeEligible,
        amazonFulfilled: fulfillment.amazonFulfilled,
        freeShipping: deliveryEvidence.known && deliveryEvidence.price === 0,
        shippingPrice: deliveryEvidence.known ? deliveryEvidence.price : null,
        estimatedDeliveredPrice: deliveryEvidence.known && Number.isFinite(priceFromText(context))
          ? priceFromText(context) + deliveryEvidence.price
          : null,
        thirdPartyMarketplace: fulfillment.localMarket,
        thirdPartySeller: fulfillment.thirdPartySeller
      });
      if (candidates.length >= limit) break;
    }
    return candidates;
  }

  function candidateStableKey(candidate = {}) {
    const asin = String(candidate.asin || candidate.container?.getAttribute?.('data-asin') || '').trim();
    if (asin) return `asin:${asin}`;
    return `url:${String(candidate.url || '').replace(/[?#].*$/, '')}`;
  }

  function candidateCartControl(candidate = {}) {
    const initialRoot = candidate.container || (candidate.element ? candidateContainer(candidate.element) : null);
    if (!initialRoot?.querySelectorAll) return null;
    // Amazon has shipped result cards with the action button one wrapper above
    // the node that contains the product link. Keep the search bounded to the
    // candidate card so a neighboring sponsored result can never be clicked.
    const roots = [initialRoot];
    let parent = initialRoot.parentElement;
    for (let depth = 0; parent && depth < 3; depth += 1, parent = parent.parentElement) {
      const parentHasCandidateIdentity = parent.matches?.('[data-component-type="s-search-result"], [data-asin]:not([data-asin=""])');
      if (parentHasCandidateIdentity && !roots.includes(parent)) roots.push(parent);
      if (parentHasCandidateIdentity) break;
    }
    const selector = [
      '#add-to-cart-button',
      '[id^="add-to-cart-button"]',
      'input[name*="submit.add-to-cart"]',
      'button[name*="submit.add-to-cart"]',
      '[data-action*="add-to-cart" i]',
      'input[value*="add to cart" i]',
      'button[data-testid*="cart" i]',
      'input[aria-label*="add to cart" i]',
      'button[aria-label*="add to cart" i]',
      '[role="button"][aria-label*="add to cart" i]',
      'button',
      'input[type="submit"]',
      'input[type="button"]',
      '[role="button"]'
    ].join(',');
    for (const root of roots) {
      const controls = Array.from(root.querySelectorAll(selector)).filter((control) => {
        if (!visible(control) || control.disabled) return false;
        const descriptor = controlDescriptor(control);
        return /\badd to (?:cart|bag)\b|\badd item\b/i.test(descriptor)
          && !FINAL_ACTION_PATTERN.test(descriptor)
          && !POSITIVE_OFFER_PATTERN.test(descriptor);
      });
      if (controls[0]) return controls[0];
    }
    return null;
  }

  function clickSelectedCandidateCartControl(candidate = {}) {
    const control = candidateCartControl(candidate);
    if (!control) return null;
    // Amazon's result cards can be mid-page or inside a horizontal carousel.
    // Bring the exact, already-scored card into view before one native click;
    // never fall back to a page-wide cart control from this path.
    try {
      control.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    } catch {
      control.scrollIntoView({ block: 'center', inline: 'center' });
    }
    return immediateSafeClick(control) ? control : null;
  }

  function isCartNavigationLink(control) {
    const href = String(control?.href || control?.getAttribute?.('href') || '');
    return /\/(?:gp\/cart(?:\/view(?:\.html)?)?|cart(?:\/view(?:\.html)?)?)(?:[/?#]|$)/i.test(href);
  }

  function findAmazonCartOpenControl() {
    const seen = new Set();
    const add = (control, strategy) => {
      if (!control || seen.has(control) || !visible(control) || control.disabled) return null;
      seen.add(control);
      return { control, strategy };
    };
    const roots = [interactionRoot(), document].filter((root, index, values) => root && values.indexOf(root) === index);
    for (const root of roots) {
      for (const selector of [
        '#sw-gtc a',
        '#sw-gtc button',
        '#sw-gtc input[type="submit"]',
        '#sw-gtc'
      ]) {
        const candidate = add(root.querySelector(selector), 'amazon_post_add_go_to_cart');
        if (candidate) return candidate;
      }
    }
    // Amazon's current search-result cart flyout is not consistently marked
    // as a dialog or side-cart. It commonly lives under these EWC containers
    // beside the page, with the native button nested under presentation spans.
    // Restrict this to an exact cart label inside a visible cart summary so a
    // page-wide "Cart" disclosure can never become a navigation target.
    const flyoutRoots = roots.flatMap((root) => Array.from(root.querySelectorAll([
      '#nav-flyout-ewc',
      '#ewc-content',
      '[id*="nav-flyout" i][id*="cart" i]',
      '[id*="ewc" i]'
    ].join(','))))
      .filter((root) => visible(root) && /\b(?:subtotal|cart)\b/i.test(compactText(root.innerText || root.textContent || '', 1200)));
    for (const root of flyoutRoots) {
      const control = interactiveControls(root).find((candidate) =>
        /^(?:go to cart|view cart|view shopping cart)$/i.test(compactText(visibleControlLabel(candidate), 120))
      );
      const candidate = add(control, 'amazon_nav_cart_flyout');
      if (candidate) return candidate;
    }
    const previewRoots = roots.flatMap((root) => Array.from(root.querySelectorAll([
      '#attach-sidesheet-view-cart-button',
      '[id*="sidecart" i]',
      '[id*="side-cart" i]',
      '[aria-label*="cart preview" i]',
      'aside'
    ].join(','))))
      .filter((root) => visible(root) && /\b(?:subtotal|cart|basket)\b/i.test(compactText(root.innerText || root.textContent || '', 1000)));
    for (const root of previewRoots) {
      const control = interactiveControls(root).find((candidate) =>
        /^(?:go to cart|view cart|view shopping cart)$/i.test(compactText(textFor(candidate), 120))
        || /\b(?:go to cart|view cart|view shopping cart)\b/i.test(compactText(visibleControlLabel(candidate), 180))
      );
      const candidate = add(control, 'amazon_side_cart');
      if (candidate) return candidate;
    }
    for (const root of roots) {
      for (const selector of [
        '#attach-sidesheet-view-cart-button',
        '#attach-sidesheet-view-cart-button-announce',
        '[data-testid*="go-to-cart" i]',
        '[data-action*="go-to-cart" i]',
        '[aria-label="Go to Cart" i]'
      ]) {
        const candidate = add(root.querySelector(selector), 'amazon_side_cart');
        if (candidate) return candidate;
      }
      const labeled = interactiveControls(root).find((control) =>
        /^(?:go to cart|view cart|view shopping cart)$/i.test(compactText(textFor(control), 120))
        || /\b(?:go to cart|view cart|view shopping cart)\b/i.test(compactText(visibleControlLabel(control), 180))
      );
      const labeledCandidate = add(labeled, 'amazon_side_cart');
      if (labeledCandidate) return labeledCandidate;
    }
    for (const root of roots) {
      for (const selector of [
        '#nav-cart',
        '#nav-cart-count-container',
        '#nav-cart-text-container',
        'a[href*="/gp/cart/view" i]',
        'a[href*="/cart/view" i]'
      ]) {
        const control = root.querySelector(selector);
        const candidate = add(control, 'amazon_header_cart');
        if (candidate && (selector.startsWith('#nav-cart') || isCartNavigationLink(control))) return candidate;
      }
    }
    return null;
  }

  function rememberSelectedCandidate(candidate = {}) {
    const memory = {
      key: candidateStableKey(candidate),
      asin: String(candidate.asin || '').trim(),
      url: String(candidate.url || ''),
      pageUrl: String(location.href || ''),
      selectedAt: Date.now(),
      cartActionStarted: false
    };
    globalThis.__magicCitySelectedCandidate = memory;
    return memory;
  }

  function selectedCandidateCartActionStarted(candidate = {}) {
    const memory = globalThis.__magicCitySelectedCandidate;
    if (!memory || !memory.cartActionStarted) return false;
    if (Date.now() - Number(memory.selectedAt || 0) > SELECTED_CANDIDATE_TTL_MS) return false;
    if (String(memory.pageUrl || '') !== String(location.href || '')) return false;
    const sameAsin = memory.asin && String(candidate.asin || '') === String(memory.asin);
    const sameKey = candidateStableKey(candidate) === String(memory.key || '');
    return Boolean(sameAsin || sameKey);
  }

  function currentRememberedCandidate() {
    const memory = globalThis.__magicCitySelectedCandidate;
    if (!memory || Date.now() - Number(memory.selectedAt || 0) > SELECTED_CANDIDATE_TTL_MS) return null;
    if (String(memory.pageUrl || '') !== String(location.href || '')) return null;
    return candidateRows(18).find((candidate) => {
      const sameAsin = memory.asin && String(candidate.asin || '') === String(memory.asin);
      const sameKey = candidateStableKey(candidate) === String(memory.key || '');
      return sameAsin || sameKey;
    }) || null;
  }

  function boundCandidateForAction(action = {}) {
    const bound = action?.boundCandidate;
    const remembered = currentRememberedCandidate();
    if (!bound || typeof bound !== 'object') return remembered;
    const expectedAsin = String(bound.asin || '').trim();
    const expectedUrl = String(bound.url || '').replace(/[?#].*$/, '');
    return candidateRows(18).find((candidate) => {
      const sameAsin = expectedAsin && String(candidate.asin || '') === expectedAsin;
      const sameUrl = expectedUrl && String(candidate.url || '').replace(/[?#].*$/, '') === expectedUrl;
      return sameAsin || sameUrl;
    }) || remembered;
  }

  function cartItemRows(limit = 12) {
    const amazonPage = /(^|\.)amazon\.com$/i.test(String(location.hostname || ''));
    if (!amazonPage) return [];
    const links = Array.from(document.querySelectorAll([
      '#activeCartViewForm .sc-list-item a[href*="/dp/"]',
      '#activeCartViewForm [data-asin]:not([data-asin=""]) a[href*="/dp/"]',
      '#nav-flyout-ewc .sc-list-item a[href*="/dp/"]',
      '#ewc-content a[href*="/dp/"]',
      '[aria-label*="cart" i] a[href*="/dp/"]'
    ].join(',')));
    const seen = new Set();
    const rows = [];
    for (const link of links) {
      const href = String(link.href || '');
      if (!href || seen.has(href)) continue;
      const container = link.closest('.sc-list-item, [data-asin]:not([data-asin=""]), li, article, [aria-label*="cart" i]') || link;
      const title = compactText(textFor(link) || container.innerText || '', 180);
      if (!title) continue;
      seen.add(href);
      rows.push({ title, url: href, context: compactText(container.innerText || title, 500) });
      if (rows.length >= limit) break;
    }
    return rows;
  }

  function candidateSummary(rows = null) {
    return (Array.isArray(rows) ? rows : candidateRows(8)).slice(0, 8).map(({
      id, asin, title, url, price, rating, reviewCount, context, sponsored, primeEligible, amazonFulfilled, freeShipping, shippingPrice, estimatedDeliveredPrice, thirdPartyMarketplace, thirdPartySeller
    }) => ({ id, asin, title, url, price, rating, reviewCount, context, sponsored, primeEligible, amazonFulfilled, freeShipping, shippingPrice, estimatedDeliveredPrice, thirdPartyMarketplace, thirdPartySeller }));
  }

  function visibleCartSubtotal(rawPageText = '') {
    const match = String(rawPageText || '').match(/\bsubtotal\b[\s\S]{0,80}?\$\s*(\d{1,5}(?:\.\d{2})?)/i);
    const amount = match ? Number(match[1]) : null;
    return Number.isFinite(amount) && amount > 0 ? amount : null;
  }

  function activeCartPreview(rawPageText = '', controlText = '') {
    const subtotal = visibleCartSubtotal(rawPageText);
    const forwardControlVisible = /\b(?:go to|view) (?:cart|basket|bag)\b|\bproceed to checkout\b/i.test(String(controlText || ''));
    const pageMentionsCart = /\b(?:cart|basket|bag|subtotal)\b/i.test(String(rawPageText || ''));
    return {
      subtotal,
      visible: Boolean(subtotal != null && forwardControlVisible && pageMentionsCart)
    };
  }

  function isAmazonPostAddCartConfirmationPath(path = '') {
    return /^\/cart\/smart-wagon(?:\/|$)/i.test(String(path || ''));
  }

  function isCartPath(path = '') {
    if (isAmazonPostAddCartConfirmationPath(path)) return false;
    return /(?:^|\/)(?:cart|basket)(?:\/|$)|\/gp\/cart(?:\/|$)/i.test(String(path || ''));
  }

  function isAmazonShoppingCartPath(path = '') {
    if (isAmazonPostAddCartConfirmationPath(path)) return false;
    return /^(?:\/cart(?:\/|$)|\/basket(?:\/|$)|\/gp\/cart(?:\/|$))/i.test(String(path || ''));
  }

  function isCartSurface(rawPageText = '', controlText = '') {
    const path = String(location.pathname || '');
    if (isAmazonPostAddCartConfirmationPath(path)) return false;
    if (isCartPath(path)) return true;
    if (/\/checkout|\/buy|\/gp\/buy/i.test(path)) return false;
    // Amazon renders cart previews on search and product pages. Those overlays
    // are useful evidence, but they do not change the primary page surface.
    if (/\/(?:dp|gp\/product|product|products|item)\b/i.test(path)) return false;
    if (/\/(?:s|search|search-results)\b/i.test(path)) return false;
    if (activeCartPreview(rawPageText, controlText).visible) return true;
    return /your cart|shopping cart|cart subtotal|basket subtotal|subtotal\s*\(\s*\d+\s+items?\s*\)/i.test(`${rawPageText}\n${controlText}`);
  }

  function hasCheckoutProgressControl(controlText = '') {
    return /proceed to checkout|go to checkout|go to cart|view (?:cart|basket|bag)|review (?:cart|bag|order)|checkout|check out/i.test(String(controlText || ''));
  }

  function visibleOfferRoot() {
    const roots = Array.from(document.querySelectorAll([
      '[role="dialog"]',
      '[aria-modal="true"]',
      '[id*="upsell" i]',
      '[class*="upsell" i]',
      '[id*="offer" i]',
      '[class*="offer" i]',
      '[id*="prime" i][class*="modal" i]',
      '[class*="prime" i][class*="modal" i]'
    ].join(','))).filter(visible);
    return roots.find((root) => {
      const text = compactText(root.innerText || root.textContent || '', 5000);
      const controls = interactiveControls(root).map(textFor).join('\n');
      const checkoutFormModal = /\b(?:add|edit|enter).*(?:shipping|delivery|billing)?\s*address\b|\bstreet address\b|\bzip code\b|\bcard number\b/i.test(text);
      if (checkoutFormModal) return false;
      return OPTIONAL_OFFER_PATTERN.test(text)
        && /\b(?:no thanks|not now|decline|continue without|without prime|without benefits|do not add|i'?ll pass|maybe later)\b/i.test(controls);
    }) || null;
  }

  function hasBlockingOptionalOffer(rawPageText = '', controlText = '') {
    const explicitOfferPath = /\/checkout\/p\/.*\/pip\b/i.test(String(location.pathname || ''))
      || /referrer=prime/i.test(String(location.search || ''));
    const root = explicitOfferPath ? document : visibleOfferRoot();
    if (!root) return false;
    const scopedPageText = root === document ? rawPageText : compactText(root.innerText || root.textContent || '', 5000);
    const scopedControlText = root === document ? controlText : interactiveControls(root).map(textFor).join('\n');
    const combined = `${scopedPageText}\n${scopedControlText}`;
    const offerish = OPTIONAL_OFFER_PATTERN.test(combined) || POSITIVE_OFFER_PATTERN.test(combined);
    const declineVisible = /\b(?:no thanks|not now|decline|continue without|without prime|without benefits|do not add|i'?ll pass|maybe later)\b/i.test(scopedControlText)
      || Boolean(findDeclineOfferControl(root));
    const contractualOffer = /\b(?:prime|trial|auto-renew|renews|membership|subscribe|protection plan|warranty|add-ons?|offer|benefits)\b/i.test(combined);
    return Boolean(offerish && declineVisible && contractualOffer);
  }

  function isOptionalOfferPage(rawPageText = '', controlText = '') {
    const path = String(location.pathname || '');
    const search = String(location.search || '');
    if (/\/checkout\/p\/.*\/pip\b/i.test(path) || /referrer=prime/i.test(search)) return true;
    if (isCartSurface(rawPageText, controlText)) return false;
    return hasBlockingOptionalOffer(rawPageText, controlText);
  }

  function classifyBrowserState({ rawPageText = '', controlText = '', addToCartAvailable = false, sensitiveField = false, resultCandidates = null } = {}) {
    const pageText = normalized(rawPageText);
    const urlText = `${location.pathname || ''}${location.search || ''}`;
    const postAddConfirmation = isAmazonPostAddCartConfirmationPath(location.pathname || '');
    const cartLike = isCartSurface(rawPageText, controlText);
    const checkoutLike = !postAddConfirmation && (
      /checkout|review your order|shipping address|delivery address|payment|place your order/.test(pageText)
      || /\/checkout|\/buy|\/gp\/buy|\/alm\/(?:byg|substitution)/i.test(urlText)
    );
    const productPath = /\/(?:dp|gp\/product|product|products|item)\b/i.test(location.pathname);
    const candidates = Array.isArray(resultCandidates) ? resultCandidates : candidateRows(2);
    const searchResultsLike = candidates.length > 0 && (
      /\b(results|sort by|filter|sponsored|price)\b/i.test(rawPageText)
      || /\/(?:s|search|search-results)\b/i.test(location.pathname)
    );
    const productLike = productPath || (addToCartAvailable && !searchResultsLike);
    const searchLike = Boolean(searchControl());
    const optionalOfferVisible = isOptionalOfferPage(rawPageText, controlText);
    // "Buy now" on a product page is an irreversible shortcut that remains
    // blocked, but it is not evidence that checkout reached final review.
    const finalApprovalVisible = checkoutLike && FINAL_ORDER_PATTERN.test(controlText);
    const loginRequired = hasVisibleLoginField()
      || LOGIN_PATTERN.test(pageText)
      || amazonAccountState(rawPageText).state === 'signed_out';
    const providerChallenge = CHALLENGE_PATTERN.test(`${document.title}\n${pageText}`);
    const paymentRequired = sensitiveField || PAYMENT_PATTERN.test(`${pageText}\n${controlText}`);
    const overlays = [
      activeCartPreview(rawPageText, controlText).visible ? 'cart_preview' : '',
      optionalOfferVisible ? 'optional_offer' : '',
      finalApprovalVisible ? 'final_approval' : ''
    ].filter(Boolean);
    const withEvidence = (state, confidence, reason, surface = state) => ({ state, surface, overlays, confidence, reason });

    const primarySurface = cartLike
      ? 'cart'
      : searchResultsLike
        ? 'search_results'
        : productLike
          ? 'product'
          : checkoutLike
            ? 'checkout'
            : searchLike
              ? 'search'
              : 'browse';
    if (providerChallenge) return withEvidence('challenge', 0.99, 'provider challenge visible', primarySurface);
    if (loginRequired) return withEvidence('login', 0.96, 'login or verification visible', primarySurface);
    if (paymentRequired) return withEvidence('payment', 0.94, 'sensitive payment field visible', primarySurface);
    if (postAddConfirmation) return withEvidence(
      'browse',
      0.98,
      'Amazon post-add confirmation requires navigation to the full cart before cart verification.',
      'post_add_confirmation'
    );
    if (optionalOfferVisible) return withEvidence('offer', /\/checkout\/p\/.*\/pip\b/i.test(location.pathname) ? 0.96 : 0.82, 'optional offer or upsell visible', 'checkout');
    if (finalApprovalVisible) return withEvidence('final_review', 0.98, 'final purchase control visible', 'checkout');
    if (cartLike) return withEvidence('cart', isCartPath(location.pathname) ? 0.94 : 0.86, 'cart surface visible');
    if (checkoutLike) return withEvidence('checkout', 0.86, 'checkout surface visible', 'checkout');
    if (searchResultsLike) return withEvidence('search_results', 0.74, 'search results visible');
    if (productLike) return withEvidence('product', addToCartAvailable ? 0.86 : 0.76, 'product surface visible');
    if (searchLike) return withEvidence('search', 0.68, 'site search visible');
    return withEvidence('browse', 0.52, 'generic page');
  }

  function visibleProductPrice() {
    const selectors = [
      '#newAccordionRow .a-price',
      '[id*="oneTimePurchase" i] .a-price',
      '[data-testid*="one-time" i] .a-price',
      '#corePrice_feature_div',
      '#corePrice_feature_div .a-price',
      '#corePriceDisplay_desktop_feature_div',
      '#corePriceDisplay_desktop_feature_div .a-price',
      '#desktop_buybox .a-price',
      '#buybox .a-price',
      '#price_inside_buybox',
      '#priceblock_ourprice',
      '#priceblock_dealprice',
      '.apexPriceToPay',
      '[data-testid="product-price"]'
    ];
    const nodes = [...new Set(selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))))];
    const visibleLegacyCorePrice = (element) => {
      if (!/^(?:corePrice_feature_div|corePriceDisplay_desktop_feature_div)$/.test(element?.id || '')) return false;
      for (let current = element; current && current.nodeType === Node.ELEMENT_NODE; current = current.parentElement) {
        if (current.hidden || current.getAttribute?.('aria-hidden') === 'true') return false;
        const style = window.getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (current === document.body) break;
      }
      return true;
    };
    const candidates = nodes.map((node) => {
      const container = node.matches?.('.a-price') ? node : node.closest?.('.a-price') || node;
      if (!visible(container) && !visibleLegacyCorePrice(container)) return null;
      const activeOfferScope = container.closest?.('[data-csa-c-is-in-initial-active-row]');
      if (activeOfferScope?.getAttribute('data-csa-c-is-in-initial-active-row') === 'false') return null;
      const accessiblePrices = Array.from(container.querySelectorAll?.('.a-offscreen, [aria-label*="$"], [title*="$"]') || [])
        .map((priceNode) => priceFromText(priceNode.textContent || priceNode.getAttribute('aria-label') || priceNode.getAttribute('title') || ''))
        .filter((amount) => Number.isFinite(amount) && amount > 0);
      const directPrice = priceFromText(container.getAttribute?.('aria-label') || container.textContent || '');
      const amounts = [...new Set([...accessiblePrices, directPrice].filter((amount) => Number.isFinite(amount) && amount > 0))];
      if (amounts.length !== 1) return null;
      let scope = container;
      for (let depth = 0; depth < 4; depth += 1) {
        const parent = scope.parentElement;
        if (!parent || parent === document.body || parent === document.documentElement) break;
        const siblingPrices = parent.querySelectorAll('.a-price, #price_inside_buybox, #priceblock_ourprice, #priceblock_dealprice, [data-testid="product-price"]');
        if (siblingPrices.length > 1) break;
        scope = parent;
      }
      const namedOfferScope = container.closest?.([
        '[data-csa-c-slot-id]',
        '[id*="AccordionRow" i]',
        '[id*="oneTimePurchase" i]',
        '[data-testid*="one-time" i]',
        '[id*="subscribe" i]',
        '[id*="sns" i]'
      ].join(','));
      const offerText = compactText([
        namedOfferScope?.id,
        namedOfferScope?.getAttribute?.('data-csa-c-slot-id'),
        namedOfferScope?.getAttribute?.('data-feature-name'),
        namedOfferScope?.innerText || namedOfferScope?.textContent,
        scope.innerText || scope.textContent
      ].filter(Boolean).join(' '), 1000);
      return {
        amount: amounts[0],
        oneTime: /\bone[- ]time(?: purchase)?\b|\bbuy new\b|\bnewaccordionrow\b/i.test(offerText),
        subscription: /\bsubscribe(?:\s*&\s*save)?\b|\bsubscription\b|\bsns(?:[-_a-z0-9]*)?\b/i.test(offerText)
      };
    }).filter(Boolean);
    const oneTime = candidates.filter((candidate) => candidate.oneTime);
    const neutral = candidates.filter((candidate) => !candidate.subscription);
    const accepted = oneTime.length ? oneTime : neutral;
    const amounts = [...new Set(accepted.map((candidate) => candidate.amount))];
    return amounts.length === 1 ? amounts[0] : null;
  }

  function visibleProductTitle() {
    const selectors = [
      '#productTitle',
      '#title',
      '[data-feature-name="title"] h1',
      '[data-testid="product-title"]',
      'main h1'
    ];
    const candidates = [...new Set(selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))))]
      .filter((node) => visible(node) || Array.from(node.querySelectorAll?.('*') || []).some(visible))
      .flatMap((node) => [node.getAttribute?.('aria-label'), node.getAttribute?.('title'), node.innerText, node.textContent])
      .map(canonicalProductTitle)
      .filter(Boolean)
      .sort((a, b) => normalizeMatchText(b).length - normalizeMatchText(a).length);
    return candidates[0] || '';
  }

  function visibleProductPackageEvidence() {
    const selectors = [
      '#variation_size_name .selection',
      '#variation_size_name [aria-selected="true"]',
      '#variation_package_quantity .selection',
      '#variation_number_of_items .selection',
      '#detailBullets_feature_div li',
      '#productDetails_detailBullets_sections1 tr',
      '#productDetails_techSpec_section_1 tr'
    ];
    const packagePattern = /\b(?:size|unit count|number of items|item weight|package|volume|\d+(?:\.\d+)?\s*(?:fl\.?\s*oz|fluid ounces?|oz|ounces?|sq\.?\s*ft|qt|quarts?|l|liters?|litres?|ct|count|bars?|bags?|packets?|sticks?|pods?|refills?|pairs?|pads?|sheets?|pieces?|rolls?|boxes?)|pack of\s+\d+|\d+[ -]+pack)\b/i;
    const values = [...new Set(selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))))]
      .filter((node) => visible(node) || Array.from(node.querySelectorAll?.('*') || []).some(visible))
      .map((node) => compactText(node.innerText || node.textContent, 400))
      .filter((value) => value && packagePattern.test(value));
    return compactText(values.join(' | '), 2200);
  }

  function deliveryCostEvidenceFromText(value = '') {
    const text = String(value || '');
    const explicitPrice = text.match(/\b(?:shipping(?:\s*&\s*handling)?|delivery)(?:\s+(?:fee|cost|charge))?\s*[:\-]?\s*\$\s*(\d{1,4}(?:\.\d{2})?)/i)
      || text.match(/\$\s*(\d{1,4}(?:\.\d{2})?)\s+(?:shipping|delivery)\b/i);
    if (explicitPrice) {
      return { known: true, price: Number(explicitPrice[1]), kind: 'paid_shipping' };
    }
    const freeLine = text.split(/\n+/).find((line) => (
      /\bfree\s+(?:standard\s+)?delivery\b|\bshipping(?:\s*&\s*handling)?\s*[:\-]?\s*\$\s*0(?:\.00)?\b/i.test(line)
      && !/\b(?:join|try|start|get)\s+prime\b|\bprime\b.*\b(?:trial|membership|auto-renew|renews|month)\b|\badd\s+\$\s*\d|\bon\s+\$\s*\d+(?:\.\d{2})?\s+of\s+qualifying\s+items\b|\border(?:s)?\s+over\s+\$\s*\d|\bwith\s+\$\s*\d+\s+more\b|\bminimum\s+order\b/i.test(line)
    ));
    if (freeLine) return { known: true, price: 0, kind: 'free_shipping' };
    const conditionalFreeLine = text.split(/\n+/).find((line) => (
      /\bfree\s+(?:standard\s+)?delivery\b|\bfree\s+shipping\b/i.test(line)
      && /\badd\s+\$\s*\d|\bon\s+\$\s*\d+(?:\.\d{2})?\s+of\s+qualifying\s+items\b|\border(?:s)?\s+over\s+\$\s*\d|\bwith\s+\$\s*\d+\s+more\b|\bminimum\s+order\b/i.test(line)
    ));
    if (conditionalFreeLine) return { known: true, price: Number.POSITIVE_INFINITY, kind: 'conditional_free_shipping' };
    return { known: false, price: null, kind: 'unknown' };
  }

  function visibleProductDeliveryEvidence(rawPageText = '') {
    const selectors = [
      '#mir-layout-DELIVERY_BLOCK',
      '#deliveryBlockMessage',
      '#ddmDeliveryMessage',
      '#shippingMessageInsideBuyBox_feature_div',
      '#price-shipping-message',
      '[data-csa-c-delivery-price]'
    ];
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      if (!node || !visible(node)) continue;
      const evidence = deliveryCostEvidenceFromText(node.innerText || node.textContent || node.getAttribute('aria-label') || '');
      if (evidence.known) return evidence;
    }
    return deliveryCostEvidenceFromText(rawPageText);
  }

  function visibleProductFulfillmentEvidence(rawPageText = '') {
    const delivery = visibleProductDeliveryEvidence(rawPageText);
    const scopedRoots = [
      '#desktop_buybox',
      '#buybox',
      '#rightCol',
      '#ppd',
      '#centerCol',
      'main'
    ].map((selector) => document.querySelector(selector)).filter(Boolean);
    const scopedText = compactText(scopedRoots.map((root) => root.innerText || root.textContent || '').join('\n'), 12000);
    const sellerSelectors = [
      '#shipsFromSoldByInsideBuyBox_feature_div',
      '#merchant-info',
      '#tabular-buybox',
      '#tabular_feature_div',
      '#desktop_buybox [data-feature-name="shipsFromSoldBy"]',
      '#buybox [data-feature-name="shipsFromSoldBy"]',
      '#desktop_buybox [data-feature-name="merchantInfoFeature"][data-csa-c-is-in-initial-active-row="true"]',
      '#buybox [data-feature-name="merchantInfoFeature"][data-csa-c-is-in-initial-active-row="true"]',
      '#desktop_buybox [data-csa-c-slot-id^="newAccordionRow"][data-feature-name="merchantInfoFeature"]',
      '#buybox [data-csa-c-slot-id^="newAccordionRow"][data-feature-name="merchantInfoFeature"]'
    ];
    const sellerRoots = [...new Set(sellerSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))))]
      .filter((node) => {
        const activeOfferScope = node.closest?.('[data-csa-c-is-in-initial-active-row]');
        if (activeOfferScope?.getAttribute('data-csa-c-is-in-initial-active-row') === 'false') return false;
        if (visible(node) || Array.from(node.querySelectorAll?.('*') || []).some(visible)) return true;
        if (node.getAttribute?.('data-csa-c-is-in-initial-active-row') !== 'true') return false;
        for (let current = node; current && current.nodeType === Node.ELEMENT_NODE; current = current.parentElement) {
          if (current.hidden || current.getAttribute?.('aria-hidden') === 'true') return false;
          const style = window.getComputedStyle(current);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          if (current === document.body) break;
        }
        return true;
      });
    const fallbackSellerStatements = sellerRoots.length
      ? []
      : Array.from(document.querySelectorAll('p, span, div'))
          .filter(visible)
          .map((node) => compactText(node.innerText || node.textContent || '', 320))
          .filter((text) => /^(?:ships from|sold by|fulfilled by)\b/i.test(text));
    const sellerText = compactText(
      sellerRoots.length
        ? sellerRoots.map((root) => root.innerText || root.textContent || '').join('\n')
        : [...new Set(fallbackSellerStatements)].join('\n'),
      4000
    );
    const seller = amazonCandidateFulfillment(sellerText);
    const primeEligible = scopedRoots.some((root) => primeBadgePresent(root))
      || /\bprime (?:delivery|eligible)\b/i.test(scopedText);
    const explicitlyPaid = delivery.known && Number(delivery.price) > 0;
    const freeShipping = delivery.known && Number(delivery.price) === 0;
    return {
      primeEligible,
      amazonFulfilled: seller.amazonFulfilled,
      thirdPartyMarketplace: seller.localMarket,
      thirdPartySeller: seller.thirdPartySeller,
      freeShipping: Boolean(freeShipping || primeEligible && !explicitlyPaid),
      explicitlyPaid,
      shippingPrice: delivery.known ? delivery.price : null,
      deliveryKind: delivery.kind,
      eligible: Boolean(freeShipping || primeEligible && !explicitlyPaid)
    };
  }

  function shippingTotalEvidenceForSurface(rawPageText = '', classification = {}) {
    const surface = String(classification.surface || classification.state || 'browse');
    if (surface !== 'checkout') return { kind: 'none', amount: null, authoritative: false };
    const bodyText = String(rawPageText || '');
    const match = bodyText.match(/\bshipping(?:\s*&\s*handling)?\s*:?\s*(?:\$\s*(\d{1,5}(?:\.\d{2})?)|free)\b/i);
    if (!match) return { kind: 'none', amount: null, authoritative: false };
    return {
      kind: 'checkout_shipping_total',
      amount: match[1] == null ? 0 : Number(match[1]),
      authoritative: true
    };
  }

  function activeCartFulfillmentRows() {
    const roots = [
      '#activeCartViewForm',
      '[data-name="Active Items"]',
      '#sc-active-cart',
      '[data-testid="active-cart"]'
    ].map((selector) => document.querySelector(selector)).filter(visible);
    const rowSelector = [
      '.sc-list-item[data-asin]:not([data-asin=""])',
      '[data-asin]:not([data-asin=""])',
      '[data-testid*="cart-item" i]',
      '[data-item-index]'
    ].join(',');
    const seen = new Set();
    const add = (row) => {
      if (!row || !visible(row) || seen.has(row)) return;
      seen.add(row);
    };
    for (const root of roots) {
      if (root.matches(rowSelector)) add(root);
      root.querySelectorAll(rowSelector).forEach(add);
    }
    if (seen.size) return [...seen];

    // Some Amazon cart variants omit the stable active-cart wrapper. Fall back
    // only to rows that expose cart-line controls, never recommendations.
    document.querySelectorAll('[data-testid*="cart-item" i], [data-item-index]').forEach((row) => {
      const text = compactText(row.innerText || row.textContent || '', 2400);
      const cartLine = Boolean(row.querySelector([
        '[data-action*="delete" i]',
        '[aria-label*="delete" i]',
        '[name*="quantity" i]',
        '[data-a-selector*="quantity" i]'
      ].join(','))) || /\b(?:delete|save for later|quantity|this is a gift|subscribe\s*&\s*save)\b/i.test(text);
      if (cartLine) add(row);
    });
    return [...seen];
  }

  function cartPrimeFulfillmentEvidence(rawPageText = '') {
    const rows = activeCartFulfillmentRows();
    if (!rows.length) {
      return { observed: false, itemCount: 0, allPrimeFreeEligible: null, allPrimeEligible: null, ineligibleItems: [], nonPrimeItems: [] };
    }
    const itemEvidence = rows.map((row) => {
      const text = compactText(row.innerText || row.textContent || '', 2400);
      const delivery = deliveryCostEvidenceFromText(text);
      const primeEligible = primeBadgePresent(row) || /\bprime\b/i.test(text);
      const explicitlyPaid = delivery.known && Number(delivery.price) > 0;
      const freeShipping = delivery.known && Number(delivery.price) === 0;
      return {
        title: compactText(row.querySelector('a[href*="/dp/"], h2, h3, [data-testid*="title" i]')?.textContent || text, 180),
        primeEligible,
        explicitlyPaid,
        eligible: Boolean(primeEligible || freeShipping)
      };
    });
    return {
      observed: true,
      itemCount: itemEvidence.length,
      allPrimeFreeEligible: itemEvidence.every((item) => item.eligible),
      allPrimeEligible: itemEvidence.every((item) => item.primeEligible),
      ineligibleItems: itemEvidence.filter((item) => !item.eligible).map((item) => item.title).filter(Boolean).slice(0, 4),
      nonPrimeItems: itemEvidence.filter((item) => !item.primeEligible).map((item) => item.title).filter(Boolean).slice(0, 4)
    };
  }

  function amazonCartTextSnapshot() {
    const roots = [
      '#activeCartViewForm',
      '[data-name="Active Items"]',
      '#sc-active-cart',
      '[data-testid="active-cart"]',
      '#sc-buy-box',
      '#sc-subtotal-label-buybox',
      '#sc-subtotal-amount-buybox',
      '#sc-subtotal-label-activecart',
      '#sc-subtotal-amount-activecart',
      '[data-feature-id*="proceed-to-checkout" i]'
    ].map((selector) => document.querySelector(selector)).filter(visible);
    const main = document.querySelector('main');
    const uniqueRoots = [...new Set([...roots, main].filter(visible))];
    const text = uniqueRoots.map((root) => root.innerText || root.textContent || '').join('\n');
    return compactText(text, 8000);
  }

  function cartItemCountFromText(rawText = '') {
    const text = String(rawText || '');
    const explicit = text.match(/\bsubtotal\s*\(\s*(\d+)\s+items?\s*\)/i)
      || text.match(/\b(\d+)\s+items?\s+in\s+(?:your\s+)?(?:cart|basket)\b/i);
    if (explicit) return Number(explicit[1]);
    const navCount = compactText(
      document.querySelector('#nav-cart-count, [data-testid*="cart-count" i], [data-a-selector*="cart-count" i]')?.textContent || '',
      24
    ).match(/\d+/)?.[0];
    if (navCount) return Number(navCount);
    const rowCount = activeCartFulfillmentRows().length;
    return rowCount || null;
  }

  function activeCartItemHints() {
    return activeCartFulfillmentRows().slice(0, 4).map((row) => {
      const rowText = compactText(row.innerText || row.textContent || '', 1800);
      const title = compactText(row.querySelector('a[href*="/dp/"], h2, h3, [data-testid*="title" i]')?.textContent || rowText, 180);
      const price = priceFromText(rowText);
      return [title, Number.isFinite(price) && price > 0 ? `$${price.toFixed(2)}` : ''].filter(Boolean).join(' · ');
    }).filter(Boolean);
  }

  function cartRowQuantity(row) {
    const directValue = [
      row?.getAttribute?.('data-quantity'),
      row?.querySelector?.('select[name*="quantity" i], select[data-a-selector*="quantity" i]')?.value,
      row?.querySelector?.('input[name*="quantity" i], input[data-a-selector*="quantity" i]')?.value,
      row?.querySelector?.('[data-a-selector*="quantity" i] .a-dropdown-prompt, [aria-label*="quantity" i]')?.textContent
    ].map((value) => String(value || '').trim()).find((value) => /^\d+$/.test(value));
    if (directValue) return Number(directValue);
    const rowText = compactText(row?.innerText || row?.textContent || '', 1800);
    const match = rowText.match(/\b(?:quantity|qty)\s*(?::|\(|x)?\s*(\d+)\b/i);
    return match ? Number(match[1]) : null;
  }

  function activeCartItemEvidence() {
    return activeCartFulfillmentRows().slice(0, 4).map((row) => {
      const link = row.querySelector?.('a[href*="/dp/"], a[href*="/gp/product/"]') || null;
      const href = String(link?.href || '');
      const asinFromUrl = href.match(/\/(?:dp|gp\/product)\/([A-Za-z0-9_-]{6,32})(?:[/?#]|$)/i)?.[1] || '';
      const asin = String(row.getAttribute?.('data-asin') || row.querySelector?.('[data-asin]')?.getAttribute?.('data-asin') || asinFromUrl).trim().slice(0, 32);
      const rowText = compactText(row.innerText || row.textContent || '', 1800);
      const title = compactText(productTitleFromRow(row, link) || canonicalProductTitle(rowText), 180);
      const price = priceFromText(rowText);
      return {
        asin: asin || null,
        title: title || null,
        quantity: cartRowQuantity(row),
        price: Number.isFinite(price) && price > 0 ? price : null
      };
    }).filter((item) => item.asin || item.title);
  }

  function findAmazonProceedToCheckoutControl() {
    const selectors = [
      '#sc-buy-box-ptc-button input[name="proceedToRetailCheckout"]',
      '#sc-buy-box-ptc-button input[type="submit"]',
      '#sc-buy-box-ptc-button button',
      'input[name="proceedToRetailCheckout"]',
      'button[name="proceedToRetailCheckout"]',
      'input[name*="proceedToCheckout" i]',
      'button[name*="proceedToCheckout" i]',
      '[data-testid="proceed-to-checkout"]',
      '[data-feature-id*="proceed-to-checkout" i] input[type="submit"]',
      '[data-feature-id*="proceed-to-checkout" i] button',
      'input[value*="Proceed to checkout" i]'
    ];
    for (const selector of selectors) {
      const control = Array.from(document.querySelectorAll(selector)).find((candidate) => {
        const label = compactText(visibleControlLabel(candidate), 220);
        return visible(candidate)
          && !candidate.disabled
          && !FINAL_ACTION_PATTERN.test(label)
          && /\bproceed\s+to\s+checkout\b/i.test(label || selector);
      });
      if (control) return { control, strategy: 'amazon_cart_proceed_to_checkout_selector' };
    }
    const control = interactiveControls().find((candidate) => {
      const label = compactText(visibleControlLabel(candidate), 220);
      const descriptor = controlDescriptor(candidate);
      return /\bproceed\s+to\s+checkout\b/i.test(`${label}\n${descriptor}`)
        && !FINAL_ACTION_PATTERN.test(label)
        && !POSITIVE_OFFER_PATTERN.test(descriptor);
    });
    return control ? { control, strategy: 'amazon_cart_proceed_to_checkout_label' } : null;
  }

  function fastAmazonCartState(profile = {}) {
    const observationStartedAt = performance.now();
    const rawPageText = amazonCartTextSnapshot();
    const cartCount = cartItemCountFromText(rawPageText);
    const cartFulfillment = cartPrimeFulfillmentEvidence(rawPageText);
    const subtotal = visibleCartSubtotal(rawPageText);
    const merchandiseSubtotalEvidence = Number.isFinite(subtotal) && subtotal > 0
      ? { kind: 'cart_items_subtotal', amount: subtotal, authoritative: true }
      : { kind: 'none', amount: null, authoritative: false };
    const totalEvidence = Number.isFinite(subtotal) && subtotal > 0
      ? { kind: 'cart_total', amount: subtotal, authoritative: true }
      : { kind: 'none', amount: null, authoritative: false };
    const proceed = findAmazonProceedToCheckoutControl();
    const accountLabel = document.querySelector('#nav-link-accountList-nav-line-1, [data-nav-role="signin"], [aria-label*="sign in" i]');
    const accountText = compactText(accountLabel?.textContent || '', 120);
    const expectedLast4 = String(profile.paymentCardLast4 || '').replace(/\D/g, '').slice(-4);
    const cartVisible = Number.isFinite(cartCount) ? cartCount > 0 : activeCartFulfillmentRows().length > 0;
    return {
      url: location.href,
      title: compactText(document.title, 180),
      interactionLayer: activeModalRoot() && !nonBlockingCheckoutPickupModal() ? 'modal' : 'page',
      loginRequired: hasVisibleLoginField() || /hello\s*,?\s*sign in|sign in/i.test(accountText),
      amazonAccountState: /hello\s*,?\s*sign in|sign in/i.test(accountText) ? 'signed_out' : 'signed_in',
      amazonFulfillmentFilterAvailable: false,
      amazonFulfillmentFilterSelected: '',
      paymentRequired: false,
      finalApprovalVisible: false,
      providerChallenge: CHALLENGE_PATTERN.test(`${document.title}\n${rawPageText}`),
      searchAvailable: false,
      safeAddressFieldsAvailable: false,
      productOpened: false,
      addToCartAvailable: false,
      candidates: [],
      optionalOfferVisible: false,
      orderSubmitted: false,
      milestoneSignals: {
        candidateSelected: false,
        cartVisible,
        checkoutOpen: false,
        addressConfirmed: false,
        cardConfirmed: false,
        deliveryConfirmed: false,
        checkoutProfileVerified: false,
        finalReviewReady: false,
        orderSubmitted: false
      },
      browserState: 'cart',
      browserSurface: 'cart',
      browserOverlays: [],
      browserStateConfidence: 1,
      browserStateReason: 'Amazon cart page detected with a direct checkout control.',
      observationDurationMs: Math.round(performance.now() - observationStartedAt),
      checkoutSummary: {
        stage: 'cart',
        surface: 'cart',
        overlays: [],
        confidence: 1,
        likelyTotal: totalEvidence.authoritative ? `$${totalEvidence.amount.toFixed(2)}` : '',
        merchandiseSubtotal: merchandiseSubtotalEvidence.authoritative ? `$${merchandiseSubtotalEvidence.amount.toFixed(2)}` : '',
        merchandiseSubtotalEvidence,
        shippingTotal: '',
        shippingTotalEvidence: { kind: 'none', amount: null, authoritative: false },
        productPrice: '',
        cartPrimeFulfillmentObserved: cartFulfillment.observed,
        cartPrimeFreeShippingVerified: cartFulfillment.allPrimeFreeEligible,
        cartPrimeVerified: cartFulfillment.allPrimeEligible,
        cartPrimeIneligibleItems: cartFulfillment.ineligibleItems,
        cartNonPrimeItems: cartFulfillment.nonPrimeItems,
        totalEvidence,
        cartItemCount: Number.isFinite(cartCount) ? cartCount : null,
        cartItems: activeCartItemEvidence(),
        itemHints: activeCartItemHints(),
        nextAction: proceed ? 'Opening checkout' : 'Find checkout button',
        optionalOfferVisible: false,
        selectedCardLast4: '',
        expectedCardLast4: expectedLast4,
        cardMatches: false,
        addressMatches: null,
        addressConfirmationRequired: false,
        paymentMethodConfirmationRequired: false,
        addressConfirmed: false,
        cardConfirmed: false,
        deliveryConfirmed: false,
        deliverySelectionRequired: false,
        deliveryFreeAvailable: null,
        selectedDeliveryPrice: null,
        checkoutOpen: false,
        checkoutProfileVerified: false,
        finalReviewReady: false,
        paymentNeedsHuman: false,
        paymentIssue: '',
        availableActions: proceed ? ['Proceed to checkout'] : []
      }
    };
  }

  function totalEvidenceForSurface(rawPageText = '', classification = {}) {
    const bodyText = String(rawPageText || '');
    const surface = String(classification.surface || classification.state || 'browse');
    const checkoutMatch = bodyText.match(/\border total\b[\s\S]{0,80}?\$\s*(\d{1,5}(?:\.\d{2})?)/i);
    const cartMatch = bodyText.match(/\b(?:cart subtotal|subtotal(?:\s*\(\s*\d+\s+items?\s*\))?)\b[\s\S]{0,80}?\$\s*(\d{1,5}(?:\.\d{2})?)/i);
    const productPrice = surface === 'product' ? visibleProductPrice() : null;
    if (surface === 'checkout' && checkoutMatch) {
      return { kind: 'checkout_total', amount: Number(checkoutMatch[1]), authoritative: true };
    }
    if (surface === 'cart' && cartMatch) {
      return { kind: 'cart_total', amount: Number(cartMatch[1]), authoritative: true };
    }
    if (Number.isFinite(productPrice) && productPrice > 0) {
      return { kind: 'product_price', amount: productPrice, authoritative: false };
    }
    const preview = activeCartPreview(rawPageText, '');
    if (preview.visible && Number.isFinite(preview.subtotal)) {
      return { kind: 'cart_preview_total', amount: preview.subtotal, authoritative: false };
    }
    return { kind: 'none', amount: null, authoritative: false };
  }

  function merchandiseSubtotalEvidenceForSurface(rawPageText = '', classification = {}) {
    const bodyText = String(rawPageText || '');
    const surface = String(classification.surface || classification.state || 'browse');
    const itemsMatch = bodyText.match(/\b(?:items?|item subtotal|merchandise subtotal)\b(?:\s*\(\s*\d+\s*items?\s*\))?\s*:?\s*\$\s*(\d{1,6}(?:\.\d{2})?)/i);
    const cartMatch = bodyText.match(/\b(?:cart subtotal|subtotal(?:\s*\(\s*\d+\s+items?\s*\))?)\b[\s\S]{0,80}?\$\s*(\d{1,6}(?:\.\d{2})?)/i);
    if (surface === 'checkout' && itemsMatch) {
      return { kind: 'checkout_items_subtotal', amount: Number(itemsMatch[1]), authoritative: true };
    }
    if (surface === 'cart' && cartMatch) {
      return { kind: 'cart_items_subtotal', amount: Number(cartMatch[1]), authoritative: true };
    }
    return { kind: 'none', amount: null, authoritative: false };
  }

  function pageState(profile = {}) {
    if (isAmazonShoppingCartPath(location.pathname || '')) {
      return fastAmazonCartState(profile);
    }
    const observationStartedAt = performance.now();
    const rawPageText = pagePlainText(30000);
    const pageText = normalized(rawPageText);
    const controls = observationControls();
    const controlText = controls.map(textFor).join('\n');
    const optionalOfferVisible = isOptionalOfferPage(rawPageText, controlText);
    const search = searchControl();
    const sensitiveField = hasVisibleSensitiveField();
    const addToCartAvailable = Boolean(canonicalAddToCartControl())
      || controls.some((control) => /add to (cart|bag)|add item/i.test(textFor(control)));
    const resultCandidates = candidateRows(8);
    const browserState = classifyBrowserState({ rawPageText, controlText, addToCartAvailable, sensitiveField, resultCandidates });
    const amazonPreference = amazonFulfillmentPreference(rawPageText);
    const productOpened = /\/(?:dp|gp\/product|product|products|item)\b/i.test(location.pathname)
      || browserState.state === 'product' && addToCartAvailable && resultCandidates.length === 0;
    const orderSubmitted = /\b(?:order (?:placed|confirmed)|thank you for your order|your order is confirmed)\b/i.test(rawPageText)
      || /\/(?:thankyou|order-confirmation|order-confirmed)\b/i.test(location.pathname);
    const summary = checkoutSummary({
      pageText,
      rawPageText,
      controlText,
      addToCartAvailable,
      sensitiveField,
      profile,
      browserState,
      resultCandidates,
      controlLabels: controls.map(textFor).filter(Boolean)
    });
    const milestoneSignals = {
      candidateSelected: Boolean(productOpened && addToCartAvailable),
      cartVisible: Boolean(summary.stage === 'cart' && Number(summary.cartItemCount || 0) > 0),
      checkoutOpen: Boolean(summary.checkoutOpen),
      addressConfirmed: Boolean(summary.addressConfirmed),
      cardConfirmed: Boolean(summary.cardConfirmed),
      deliveryConfirmed: Boolean(summary.deliveryConfirmed),
      checkoutProfileVerified: Boolean(summary.checkoutProfileVerified),
      finalReviewReady: Boolean(summary.finalReviewReady),
      orderSubmitted
    };
    return {
      url: location.href,
      title: compactText(document.title, 180),
      interactionLayer: activeModalRoot() && !nonBlockingCheckoutPickupModal() ? 'modal' : 'page',
      loginRequired: hasVisibleLoginField() || LOGIN_PATTERN.test(pageText) || amazonPreference.accountState === 'signed_out',
      amazonAccountState: amazonPreference.accountState,
      amazonFulfillmentFilterAvailable: amazonPreference.available,
      amazonFulfillmentFilterSelected: amazonPreference.selected,
      paymentRequired: sensitiveField || PAYMENT_PATTERN.test(`${pageText}\n${controlText}`) || Boolean(summary.paymentNeedsHuman),
      finalApprovalVisible: browserState.state === 'final_review',
      providerChallenge: CHALLENGE_PATTERN.test(`${document.title}\n${pageText}`),
      searchAvailable: Boolean(search),
      safeAddressFieldsAvailable: Boolean(summary.checkoutOpen && safeCheckoutFields().some((field) => ['streetAddress', 'zipCode', 'billingStreetAddress', 'billingZipCode', 'contactName', 'shippingContactName', 'billingContactName', 'contactPhone'].includes(checkoutFieldKind(field)))),
      productOpened,
      addToCartAvailable,
      candidates: candidateSummary(resultCandidates),
      optionalOfferVisible,
      orderSubmitted,
      milestoneSignals,
      browserState: browserState.state,
      browserSurface: browserState.surface,
      browserOverlays: browserState.overlays,
      browserStateConfidence: browserState.confidence,
      browserStateReason: browserState.reason,
      observationDurationMs: Math.round(performance.now() - observationStartedAt),
      checkoutSummary: summary
    };
  }

  // Result grids can contain thousands of nodes. The happy-path plan only
  // needs a signed acknowledgement that it bound one exact candidate or sent
  // one native cart click; the following cart inspection is authoritative.
  function compactPlanStepState({ candidateSelected = false, cartActionStarted = false, cartOpenStarted = false } = {}) {
    const accountLabel = document.querySelector('#nav-link-accountList-nav-line-1, [data-nav-role="signin"], [aria-label*="sign in" i]');
    const accountText = compactText(accountLabel?.textContent || '', 120);
    const loginRequired = hasVisibleLoginField() || /hello\s*,?\s*sign in|sign in/i.test(accountText);
    return {
      url: location.href,
      title: compactText(document.title, 180),
      interactionLayer: activeModalRoot() && !nonBlockingCheckoutPickupModal() ? 'modal' : 'page',
      loginRequired,
      paymentRequired: false,
      finalApprovalVisible: false,
      providerChallenge: false,
      productOpened: false,
      addToCartAvailable: false,
      browserState: candidateSelected ? 'search_results' : 'browse',
      browserSurface: candidateSelected ? 'search_results' : 'browse',
      browserStateConfidence: 1,
      browserStateReason: candidateSelected
        ? 'An exact catalog candidate was bound; the next step owns its cart control.'
        : cartOpenStarted
          ? 'Amazon cart navigation was invoked; the next step verifies the cart.'
          : 'The exact candidate cart control was invoked; the next step verifies the cart.',
      milestoneSignals: {
        candidateSelected: Boolean(candidateSelected),
        cartVisible: false,
        checkoutOpen: false,
        addressConfirmed: false,
        cardConfirmed: false,
        deliveryConfirmed: false,
        checkoutProfileVerified: false,
        finalReviewReady: false,
        orderSubmitted: false
      },
      checkoutSummary: {
        stage: candidateSelected ? 'search_results' : 'browse',
        nextAction: cartOpenStarted ? 'Inspecting cart' : cartActionStarted ? 'Opening cart' : 'Preparing cart'
      },
      observationDurationMs: 0
    };
  }

  function checkoutSummary({ pageText = '', rawPageText = '', controlText = '', addToCartAvailable = false, sensitiveField = false, profile = {}, browserState = null, resultCandidates = null, controlLabels = null } = {}) {
    const bodyText = String(rawPageText || document.body?.innerText || '');
    const cartPreview = activeCartPreview(rawPageText, controlText);
    const itemCountMatch = bodyText.match(/(?:subtotal|cart subtotal|order total)\s*\(\s*(\d+)\s+items?\s*\)/i)
      || bodyText.match(/\b(?:cart|basket|order)\b[\s\S]{0,120}?\b(\d+)\s+items?\b/i);
    const amazonCartCount = compactText(
      document.querySelector('#nav-cart-count, [data-testid*="cart-count" i], [data-a-selector*="cart-count" i]')?.textContent || '',
      24
    ).match(/\d+/)?.[0];
    const cartItemCount = itemCountMatch
      ? Number(itemCountMatch[1])
      : amazonCartCount
        ? Number(amazonCartCount)
        : (cartPreview.visible ? 1 : null);
    const itemHints = candidateSummary(resultCandidates)
      .filter((candidate) => candidate.title && !candidate.sponsored)
      .slice(0, 3)
      .map((candidate) => [candidate.title, candidate.price != null ? `$${candidate.price.toFixed(2)}` : ''].filter(Boolean).join(' · '));
    const controls = Array.isArray(controlLabels) ? controlLabels : interactiveControls().map(textFor).filter(Boolean);
    const classification = browserState || classifyBrowserState({ rawPageText, controlText, addToCartAvailable, sensitiveField, resultCandidates });
    const totalEvidence = totalEvidenceForSurface(rawPageText, classification);
    const merchandiseSubtotalEvidence = merchandiseSubtotalEvidenceForSurface(rawPageText, classification);
    const shippingTotalEvidence = shippingTotalEvidenceForSurface(rawPageText, classification);
    const productDelivery = classification.surface === 'product'
      ? visibleProductDeliveryEvidence(rawPageText)
      : { known: false, price: null, kind: 'unknown' };
    const productTitle = classification.surface === 'product' ? visibleProductTitle() : '';
    const productPackageEvidence = classification.surface === 'product' ? visibleProductPackageEvidence() : '';
    const productFulfillment = classification.surface === 'product'
      ? visibleProductFulfillmentEvidence(rawPageText)
      : { primeEligible: false, freeShipping: false, explicitlyPaid: false, eligible: false };
    const cartFulfillment = classification.surface === 'cart'
      ? cartPrimeFulfillmentEvidence(rawPageText)
      : { observed: false, itemCount: 0, allPrimeFreeEligible: null, allPrimeEligible: null, ineligibleItems: [], nonPrimeItems: [] };
    const cartItems = classification.surface === 'cart' ? activeCartItemEvidence() : [];
    const productDeliveredAmount = totalEvidence.kind === 'product_price'
      && Number.isFinite(totalEvidence.amount)
      && productDelivery.known
      ? totalEvidence.amount + productDelivery.price
      : null;
    const checkoutOpen = Boolean(
      ['offer', 'checkout', 'payment', 'final_review'].includes(classification.state)
      || /\/checkout|\/buy|\/gp\/buy|\/alm\/(?:byg|substitution)/i.test(`${location.pathname || ''}${location.search || ''}`)
    );
    const checkoutFields = checkoutOpen ? safeCheckoutFields() : [];
    const credentialVisible = checkoutOpen && hasVisibleCredentialField();
    const nextAction = credentialVisible
      ? 'Sign in or verify in Chrome'
      : sensitiveField
        ? 'Approve payment in Chrome'
        : classification.state === 'final_review'
          ? 'Review final order in Chrome'
          : checkoutFields.length
            ? 'Filling checkout details'
            : addToCartAvailable
              ? 'Preparing cart'
              : /checkout|review your order|place your order|payment|shipping|delivery address/.test(pageText)
                ? 'Review checkout'
                : 'Working';
    const optionalOfferVisible = classification.state === 'offer';
    const expectedLast4 = String(profile.paymentCardLast4 || '').replace(/\D/g, '').slice(-4);
    const cardSelectionVisible = checkoutOpen && !optionalOfferVisible && (/select a payment method|payment method|paying with|add a credit or debit card|add a payment method/i.test(rawPageText) || /\b(?:visa|mastercard|amex|american express|discover)\D{0,32}\d{4}\b/i.test(rawPageText));
    // A checkout page can have unrelated selected radios (delivery, offers,
    // account choices) before the payment card. Prefer the exact selected
    // card row when the mission specifies one.
    const currentLast4 = cardSelectionVisible
      ? (expectedLast4 && expectedPaymentCardIsSelected(expectedLast4) ? expectedLast4 : selectedCardLast4())
      : '';
    const cardMatches = Boolean(expectedLast4 && currentLast4 && expectedLast4 === currentLast4);
    const cardMismatch = Boolean(expectedLast4 && currentLast4 && expectedLast4 !== currentLast4);
    const expectedAddressText = normalizeMatchText(`${profile.streetAddress || profile.shippingStreetAddress || ''} ${profile.zipCode || profile.shippingZipCode || ''}`);
    const hasAddressPreset = Boolean(expectedAddressText);
    const hasCardPreset = Boolean(expectedLast4);
    let addressObservation = checkoutOpen && hasAddressPreset
      ? observeSelectedAddress(profile)
      // An address profile is not an address-verification problem while the
      // shopper is still on a catalog or cart surface. Emitting "unverified"
      // here made the runner stop after add-to-cart before checkout existed.
      : { status: 'not_requested', source: 'none', diagnostics: {} };
    const closedDeliverySummary = checkoutOpen && hasAddressPreset
      ? closedDeliverySummaryObservation(profile)
      : { visible: false, matches: false };
    // A closed "Delivering to" summary on Amazon's final review is the
    // authoritative delivery identity. An unreadable address picker or a
    // mounted pickup sheet must not regress that verified state back to an
    // address mismatch.
    if (classification.state === 'final_review' && closedDeliverySummary.visible && closedDeliverySummary.matches) {
      addressObservation = {
        status: 'matched',
        source: 'checkout_summary_final_review',
        diagnostics: {
          ...addressObservation.diagnostics,
          finalReviewSummaryMatched: true
        }
      };
    }
    // A closed "Delivering to" summary and an open address picker both contain
    // address language. Only the picker exposes a pending address selection.
    // Never let a mounted-but-inactive picker turn a verified summary into a
    // second address-confirmation loop.
    const addressPickerOpen = checkoutOpen && addressObservation.source === 'address_picker';
    const addressMatch = addressObservation.status === 'matched';
    // Do not conflate an unreadable Amazon row with a different address. Only
    // a readable, selected row that fails the exact fingerprint is a mismatch.
    const addressMismatch = Boolean(addressPickerOpen && addressObservation.status === 'mismatched');
    const addressConfirmationRequired = Boolean(addressPickerOpen && findAddressConfirmControl());
    const paymentMethodConfirmationRequired = Boolean(checkoutOpen && findPaymentMethodConfirmControl());
    const shippingFormOpen = checkoutOpen && shippingAddressFormVisible(checkoutFields);
    const deliveryState = checkoutOpen
      ? deliverySelectionState()
      : { required: false, confirmed: false, selectedPrice: null, bestPrice: null };
    // On Amazon's final-review surface the delivery radio group is often no
    // longer mounted. Its checkout order summary is the authoritative source
    // at that point: a $0 shipping line confirms the retained free delivery
    // choice without reopening any delivery or pickup UI.
    const deliveryConfirmed = Boolean(
      deliveryState.confirmed
      || classification.state === 'final_review'
        && shippingTotalEvidence.authoritative
        && shippingTotalEvidence.amount === 0
    );
    const addressConfirmed = Boolean(checkoutOpen && (!hasAddressPreset || addressMatch && !addressConfirmationRequired && !shippingFormOpen));
    const cardConfirmed = Boolean(checkoutOpen && (!hasCardPreset || cardMatches && !sensitiveField && !paymentMethodConfirmationRequired));
    const checkoutProfileVerified = Boolean(checkoutOpen && addressConfirmed && cardConfirmed && deliveryConfirmed);
    const finalReviewReady = Boolean(
      classification.state === 'final_review'
      && checkoutProfileVerified
      && !sensitiveField
      && !credentialVisible
    );
    const paymentNeedsHuman = Boolean(checkoutOpen && !optionalOfferVisible && (
      sensitiveField ||
      cardMismatch ||
      addressMismatch ||
      (cardSelectionVisible && expectedLast4 && !cardMatches && /add a credit or debit card|add a payment method/i.test(rawPageText))
    ));
    const paymentIssue = sensitiveField
      ? 'Card entry or payment authentication is visible. Magic City needs you in Chrome.'
      : cardMismatch
        ? `Selected card ending ${currentLast4}; Magic City expected ending ${expectedLast4}.`
        : addressMismatch
          ? 'Selected delivery address does not match the Magic City vault preset. Choose the saved address in Chrome or update the vault.'
          : paymentNeedsHuman
            ? 'No matching saved card option was visible. Add or select the card in Chrome.'
          : '';
    return {
      stage: classification.state,
      surface: classification.surface,
      overlays: classification.overlays,
      confidence: classification.confidence,
      likelyTotal: totalEvidence.authoritative && Number.isFinite(totalEvidence.amount) ? `$${totalEvidence.amount.toFixed(2)}` : '',
      merchandiseSubtotal: merchandiseSubtotalEvidence.authoritative && Number.isFinite(merchandiseSubtotalEvidence.amount)
        ? `$${merchandiseSubtotalEvidence.amount.toFixed(2)}`
        : '',
      merchandiseSubtotalEvidence,
      shippingTotal: shippingTotalEvidence.authoritative && Number.isFinite(shippingTotalEvidence.amount)
        ? `$${shippingTotalEvidence.amount.toFixed(2)}`
        : '',
      shippingTotalEvidence,
      productPrice: totalEvidence.kind === 'product_price' && Number.isFinite(totalEvidence.amount) ? `$${totalEvidence.amount.toFixed(2)}` : '',
      productTitle,
      productPackageEvidence,
      productShippingKnown: productDelivery.known,
      productShippingPrice: productDelivery.known && Number.isFinite(productDelivery.price) ? `$${productDelivery.price.toFixed(2)}` : '',
      productDeliveredPrice: Number.isFinite(productDeliveredAmount) ? `$${productDeliveredAmount.toFixed(2)}` : '',
      productDeliveryKind: productDelivery.kind,
      productPrimeEligible: productFulfillment.primeEligible,
      productPrimeFreeShippingEligible: productFulfillment.eligible,
      cartPrimeFulfillmentObserved: cartFulfillment.observed,
      cartPrimeFreeShippingVerified: cartFulfillment.allPrimeFreeEligible,
      cartPrimeVerified: cartFulfillment.allPrimeEligible,
      cartPrimeIneligibleItems: cartFulfillment.ineligibleItems,
      cartNonPrimeItems: cartFulfillment.nonPrimeItems,
      totalEvidence,
      cartItemCount: Number.isFinite(cartItemCount) ? cartItemCount : null,
      cartItems,
      itemHints,
      nextAction: optionalOfferVisible ? 'Decline optional offer' : paymentNeedsHuman ? 'Payment needs you in Chrome' : nextAction,
      optionalOfferVisible,
      selectedCardLast4: currentLast4,
      expectedCardLast4: expectedLast4,
      cardMatches,
      addressMatches: addressObservation.status === 'matched' ? true : addressObservation.status === 'mismatched' ? false : null,
      addressVerification: addressObservation.status,
      addressVerificationSource: addressObservation.source,
      addressVerificationDiagnostics: addressObservation.diagnostics,
      finalReviewDeliverySummaryMatches: classification.state === 'final_review' && closedDeliverySummary.matches,
      addressConfirmationRequired,
      paymentMethodConfirmationRequired,
      addressConfirmed,
      cardConfirmed,
      deliveryConfirmed,
      deliverySelectionRequired: deliveryConfirmed ? false : deliveryState.required,
      deliveryFreeAvailable: deliveryState.freeAvailable ?? null,
      selectedDeliveryPrice: deliveryState.selectedPrice,
      checkoutOpen,
      checkoutProfileVerified,
      finalReviewReady,
      paymentNeedsHuman,
      paymentIssue,
      browserActionReceipts: currentBrowserActionReceipts(),
      availableActions: controls
        .filter((label) => /cart|checkout|continue|shipping|address|payment|place|order/i.test(label))
        .slice(0, 4)
    };
  }

  function scheduleSafeClick(element) {
    if (!visible(element) || element.disabled) return false;
    const label = textFor(element);
    if (FINAL_ACTION_PATTERN.test(label) || pickupOrLockerControl(element)) return false;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    // Let the runtime serialize the signed response before a merchant
    // navigation can unload this content-script message channel.
    const actionContext = activeActionContext;
    // Yield once so the extension message carrying final_submit_intent can
    // serialize, but do not leave a long window for MV3 or the page lifecycle
    // to tear down this content script before the already-authorized click.
    setTimeout(() => {
      if (!visible(element) || element.disabled) return;
      try {
        element.click();
        recordBrowserClick(element, actionContext);
      } catch {
        // The next inspection step reports a safe handoff when navigation fails.
      }
    }, 80);
    return true;
  }

  function immediateSafeClick(element, { allowPickupOverlay = false, allowFinalAction = false } = {}) {
    if (!visible(element) || element.disabled) return false;
    const label = textFor(element);
    if ((!allowFinalAction && FINAL_ACTION_PATTERN.test(label)) || (!allowPickupOverlay && pickupOrLockerControl(element))) return false;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    try {
      element.click();
      recordBrowserClick(element);
      return true;
    } catch {
      return false;
    }
  }

  function scheduleFinalOrderClick(control) {
    const clickTarget = control?.clickTarget || control;
    const wrapper = control?.wrapper || clickTarget;
    const validatedLabel = compactText(control?.validatedLabel || visibleControlLabel(wrapper, 220), 220);
    const nativeSubmitTarget = Boolean(clickTarget?.matches?.('input[type="submit"], input[type="button"], button'));
    // Amazon's native submit input can be visually collapsed inside the
    // visible a-button wrapper. The wrapper carries the user-visible label;
    // an enabled native descendant remains the correct click target.
    if (!visible(wrapper) || (!visible(clickTarget) && !nativeSubmitTarget) || clickTarget.disabled) return null;
    // The wrapper is the element whose visible Amazon text was verified. The
    // nested native input can legitimately have no standalone accessible name.
    // Never discard that verified context and reclassify the nested input.
    if (!FINAL_ACTION_PATTERN.test(validatedLabel) || pickupOrLockerControl(wrapper) || pickupOrLockerControl(clickTarget)) return null;
    clickTarget.scrollIntoView({ block: 'center', inline: 'center' });

    // A merchant navigation can destroy this content-script context before a
    // synchronous click result reaches the background worker. Persist the
    // categorical receipt first, return it with the action result, then make
    // the one already-authorized merchant click after the message serializes.
    const intentReceipt = recordBrowserClick(clickTarget, activeActionContext, {
      kind: 'final_order',
      phase: 'final_submit_intent',
      validatedLabel
    });
    const actionContext = activeActionContext;
    let resolveDispatch;
    const dispatchReady = new Promise((resolve) => {
      resolveDispatch = resolve;
    });
    setTimeout(async () => {
      if (!visible(wrapper) || (!visible(clickTarget) && !nativeSubmitTarget) || clickTarget.disabled) {
        resolveDispatch({ receipt: null, reason: 'The final order control became unavailable before its click was dispatched.' });
        return;
      }
      try {
        // Persist this just before invocation. It survives an Amazon
        // navigation so a control-plane timeout cannot replay the order.
        const dispatchReceipt = recordBrowserClick(clickTarget, actionContext, {
          kind: 'final_order',
          phase: 'click_dispatched',
          validatedLabel
        });
        // Best-effort out-of-band handoff for the post-dispatch receipt. The
        // background keeps this scoped receipt long enough to include it in
        // the signed checkpoint even if Amazon unloads this document at once.
        // It carries no merchant text, address, or payment data.
        const dispatchHandoff = chrome.runtime.sendMessage({
          type: 'MAGIC_CITY_FINAL_ORDER_DISPATCHED',
          receipt: dispatchReceipt
        }).catch(() => null);
        // Give the background a short, bounded opportunity to durably retain
        // the dispatch receipt before Amazon can unload this document. A
        // missed acknowledgement never blocks the already-authorized click.
        const handoff = await Promise.race([
          dispatchHandoff,
          new Promise((resolve) => setTimeout(() => resolve(null), 320))
        ]);
        // Return only after the immutable action receipt exists. The plan
        // response can now checkpoint the dispatch before the merchant page
        // starts navigating, preventing a timeout from replaying the click.
        resolveDispatch({
          receipt: dispatchReceipt,
          handoffSaved: Boolean(handoff?.result?.saved || handoff?.saved)
        });
        setTimeout(() => {
          if (!visible(wrapper) || (!visible(clickTarget) && !nativeSubmitTarget) || clickTarget.disabled) return;
          try {
            recordBrowserClick(clickTarget, actionContext, {
              kind: 'final_order',
              phase: 'native_click_invoked',
              validatedLabel
            });
            clickTarget.click();
          } catch {
            // The next observer reports a terminal failure; never replay.
          }
        }, 50);
      } catch {
        resolveDispatch({ receipt: null, reason: 'The final order dispatch receipt could not be recorded.' });
      }
    }, 0);
    return { intentReceipt, dispatchReady };
  }

  function priorFinalOrderReceipt(actionId = '', receiptScope = '', receipts = [], phase = '') {
    const normalizedActionId = String(actionId || '').trim();
    const normalizedScope = String(receiptScope || '').trim();
    const normalizedPhase = String(phase || '').trim();
    return (Array.isArray(receipts) ? receipts : []).find((receipt) => (
      receipt
      && receipt.kind === 'final_order'
      && (!normalizedPhase || receipt.phase === normalizedPhase)
      && (!normalizedActionId || String(receipt.actionId || '') === normalizedActionId)
      && (!normalizedScope || String(receipt.receiptScope || '') === normalizedScope)
    )) || null;
  }

  function finalOrderReceiptsFor(state = {}) {
    // The page snapshot can be created just before a navigation or a fresh
    // executor injection. Read the durable tab-local receipts again at the
    // irreversible boundary so a persisted intent can never be replayed.
    return [...(
      Array.isArray(state?.browserActionReceipts)
        ? state.browserActionReceipts
        : []
    ), ...currentBrowserActionReceipts()];
  }

  function dispatchInput(element, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set ||
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function canonicalState(value = '') {
    const normalizedValue = normalizeMatchText(value);
    if (!normalizedValue) return '';
    if (US_STATE_CODES[normalizedValue]) return US_STATE_CODES[normalizedValue];
    return normalizedValue.replace(/\s+/g, '');
  }

  function checkoutFieldValueMatches(field, value, key = '') {
    const actual = String(field?.value || '').trim();
    if (key === 'shippingState' || key === 'billingState') {
      return canonicalState(actual) === canonicalState(value);
    }
    return normalizeMatchText(actual) === normalizeMatchText(value);
  }

  function selectSafeOption(field, value, key = '') {
    const options = Array.from(field?.options || []);
    const expected = key === 'shippingState' || key === 'billingState'
      ? canonicalState(value)
      : normalizeMatchText(value);
    const option = options.find((candidate) => {
      const candidateValue = String(candidate.value || '').trim();
      const candidateText = String(candidate.textContent || '').trim();
      const normalizedCandidate = key === 'shippingState' || key === 'billingState'
        ? canonicalState(candidateValue) || canonicalState(candidateText)
        : normalizeMatchText(candidateValue) || normalizeMatchText(candidateText);
      return normalizedCandidate === expected;
    });
    if (!option) return false;
    field.value = option.value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function setSafeCheckoutFieldValue(field, value, key = '') {
    if (!field || !value || checkoutFieldValueMatches(field, value, key)) return false;
    if (String(field.tagName || '').toLowerCase() === 'select') {
      return selectSafeOption(field, value, key);
    }
    dispatchInput(field, value);
    return checkoutFieldValueMatches(field, value, key);
  }

  function fullShippingAddressAvailable(profile = {}) {
    return ['streetAddress', 'shippingCity', 'shippingState', 'zipCode']
      .every((key) => String(valueForCheckoutField(profile, key) || '').trim());
  }

  function shippingAddressFormVisible(fields = safeCheckoutFields()) {
    const kinds = new Set(fields.map(checkoutFieldKind));
    return kinds.has('streetAddress') && (kinds.has('zipCode') || kinds.has('shippingCity') || kinds.has('shippingState'));
  }

  function visibleShippingFieldsMatchProfile(profile = {}, fields = safeCheckoutFields()) {
    const shippingFields = fields.filter((field) => ['streetAddress', 'shippingCity', 'shippingState', 'zipCode', 'shippingContactName', 'contactName', 'contactPhone'].includes(checkoutFieldKind(field)));
    const requiredKinds = new Set(shippingFields.map(checkoutFieldKind));
    if (!requiredKinds.has('streetAddress') || !requiredKinds.has('zipCode')) return false;
    return shippingFields.every((field) => {
      const key = checkoutFieldKind(field);
      const expected = String(valueForCheckoutField(profile, key) || '').trim();
      return !expected || checkoutFieldValueMatches(field, expected, key);
    });
  }

  async function runSearch(query = '') {
    const field = searchControl();
    const safeQuery = compactText(query, 120);
    if (!safeQuery) return { completed: false, reason: 'No approved search query was provided.' };
    if (!field) return { completed: false, reason: 'No accessible site search field was found.' };
    field.scrollIntoView({ block: 'center', inline: 'center' });
    field.focus();
    dispatchInput(field, safeQuery);
    const form = field.closest('form');
    const submit = form
      ? Array.from(form.querySelectorAll('button, input[type="submit"], [role="button"]')).find((control) => /search|find|go/i.test(textFor(control)))
      : null;
    if (submit && scheduleSafeClick(submit)) {
      return { completed: true, method: 'submit_control', navigationRequested: true };
    }
    setTimeout(() => {
      for (const type of ['keydown', 'keypress', 'keyup']) {
        field.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
      }
    }, 0);
    return { completed: true, method: 'enter', navigationRequested: true };
  }

  function applyAmazonFulfillmentPreference(action = {}) {
    const rawPageText = pagePlainText(30000);
    const account = amazonAccountState(rawPageText);
    if (account.state === 'signed_out') {
      return {
        completed: false,
        reason: 'Amazon is signed out. Sign in in this prepared tab, then retry the mission; Magic City will not choose an account or handle credentials.'
      };
    }
    const prime = amazonSearchRefinement('prime');
    const freeShipping = amazonSearchRefinement('free_shipping');
    const primeRequired = action.primeRequired === true;
    const selected = primeRequired ? prime : (prime || freeShipping);
    if (!selected) {
      return {
        completed: true,
        skipped: true,
        fulfillmentFilter: primeRequired ? 'prime_unavailable' : 'none',
        primeRequired,
        reason: primeRequired
          ? 'No usable Prime search refinement was visible. Magic City will continue only if a matching product card proves Prime eligibility.'
          : 'No usable Prime or free-shipping search refinement was visible; product and checkout delivery evidence will be verified instead.'
      };
    }
    const fulfillmentFilter = prime ? 'prime' : 'free_shipping';
    if (selected.selected) {
      return {
        completed: true,
        skipped: true,
        fulfillmentFilter,
        reason: `${fulfillmentFilter === 'prime' ? 'Prime' : 'Free shipping'} filtering is already selected.`
      };
    }
    if (!immediateSafeClick(selected.target)) {
      return {
        completed: true,
        skipped: true,
        fulfillmentFilter: 'none',
        reason: 'A delivery refinement was visible but could not be applied safely; product and checkout delivery evidence will be verified instead.'
      };
    }
    return {
      completed: true,
      filterApplied: true,
      fulfillmentFilter,
      label: fulfillmentFilter === 'prime' ? 'Prime filter' : 'Free shipping filter'
    };
  }

  function lexicalToken(value = '') {
    const aliases = new Map([
      ['granol', 'granola'],
      ['abar', 'bar'],
      ['abars', 'bar']
    ]);
    const token = aliases.get(String(value || '').toLowerCase()) || String(value || '').toLowerCase();
    if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
    if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
    return token;
  }

  function queryTokens(value = '') {
    const ignored = new Set(['buy', 'purchase', 'order', 'get', 'some', 'from', 'with', 'under', 'max', 'spend', 'budget', 'please', 'best', 'cheap', 'cheapest']);
    return [...new Set(normalizeMatchText(value)
      .split(/\s+/)
      .map(lexicalToken)
      .filter((token) => token.length > 1 && !ignored.has(token)))]
      .slice(0, 12);
  }

  function candidateRelevance(candidate, query = '') {
    const requiredTokens = queryTokens(query);
    let pathIdentity = '';
    try {
      pathIdentity = decodeURIComponent(new URL(candidate.url || '', location.href).pathname.replace(/[\/_-]+/g, ' '));
    } catch {
      pathIdentity = '';
    }
    const identityText = normalizeMatchText(`${candidate.title || ''} ${pathIdentity}`);
    const titleTokens = new Set(identityText.split(/\s+/).map(lexicalToken).filter(Boolean));
    const contextTokens = new Set(normalizeMatchText(candidate.context).split(/\s+/).map(lexicalToken).filter(Boolean));
    const titleMatches = requiredTokens.filter((token) => titleTokens.has(token));
    const contextMatches = requiredTokens.filter((token) => contextTokens.has(token));
    const matched = requiredTokens.filter((token) => titleTokens.has(token) || contextTokens.has(token));
    const coverage = requiredTokens.length ? matched.length / requiredTokens.length : 0;
    const identityCoverage = requiredTokens.length ? titleMatches.length / requiredTokens.length : 0;
    const normalizedQuery = normalizeMatchText(query);
    const exactPhrase = Boolean(normalizedQuery && normalizeMatchText(candidate.title).includes(normalizedQuery));
    return {
      requiredTokenCount: requiredTokens.length,
      matchedTokenCount: matched.length,
      titleMatchCount: titleMatches.length,
      contextMatchCount: contextMatches.length,
      coverage,
      identityCoverage,
      exactPhrase,
      score: matched.length * 5 + titleMatches.length * 3 + Math.round(coverage * 20) + (exactPhrase ? 20 : 0)
    };
  }

  function minimumCandidateCoverage(tokenCount = 0) {
    if (tokenCount <= 4) return 1;
    return 0.8;
  }

  function scoreCandidate(candidate, query = '', maxPrice = null) {
    const relevance = candidateRelevance(candidate, query);
    let score = candidate.sponsored ? -100 : 0;
    score += relevance.score;
    if (candidate.price != null && maxPrice != null) score += candidate.price <= maxPrice ? 5 : -40;
    if (candidate.price != null) score += 1;
    return { score, relevance };
  }

  function qualityScore(candidate = {}) {
    return Math.round(Number(candidate.rating || 0) * 1_000_000) + Math.min(999_999, Number(candidate.reviewCount || 0));
  }

  function fulfillmentScore(candidate = {}) {
    if (candidate.thirdPartyMarketplace || candidate.thirdPartySeller) return -100;
    if (candidate.primeEligible && candidate.freeShipping) return 6;
    if (candidate.freeShipping) return 5;
    if (candidate.primeEligible) return 4;
    if (candidate.amazonFulfilled) return 2;
    return 0;
  }

  function compareCandidates(left, right, candidatePolicy = '') {
    const coverageDifference = Number(right.relevance?.coverage || 0) - Number(left.relevance?.coverage || 0);
    if (Math.abs(coverageDifference) > 0.001) return coverageDifference;
    if (candidatePolicy === 'free_shipping_preferred_price_quality') {
      const fulfillmentDifference = fulfillmentScore(right) - fulfillmentScore(left);
      if (fulfillmentDifference) return fulfillmentDifference;
    }
    const leftPrice = Number.isFinite(left.price) ? left.price : Number.POSITIVE_INFINITY;
    const rightPrice = Number.isFinite(right.price) ? right.price : Number.POSITIVE_INFINITY;
    if (leftPrice !== rightPrice) return leftPrice - rightPrice;
    const qualityDifference = qualityScore(right) - qualityScore(left);
    if (qualityDifference) return qualityDifference;
    if (candidatePolicy === 'price_quality_delivery_preference') {
      const fulfillmentDifference = fulfillmentScore(right) - fulfillmentScore(left);
      if (fulfillmentDifference) return fulfillmentDifference;
    }
    const relevanceDifference = Number(right.score || 0) - Number(left.score || 0);
    if (relevanceDifference) return relevanceDifference;
    return Number(left.order || 0) - Number(right.order || 0);
  }

  function selectCandidate({ query = '', selectionBrief = '', maxPrice = null, candidatePolicy = '', fulfillmentPolicy = '', primeRequired = false } = {}) {
    const effectiveQuery = compactText(query || selectionBrief, 180);
    const onProductPage = /\/(?:dp|gp\/product|product|products|item)\b/i.test(String(location.pathname || ''));
    if (onProductPage) return { completed: true, skipped: true, reason: 'A product page is already open.' };
    // Search-result cards are enough to make a candidate decision. Avoid a
    // full-body checkout report here: Amazon grids are large and that report
    // was the main source of the apparent stall before the card click.
    if (isCartPath(location.pathname)) {
      const state = pageState();
      if (state.checkoutSummary?.stage === 'cart' && Number(state.checkoutSummary?.cartItemCount || 0) > 0) {
      const amazonPage = /(^|\.)amazon\.com$/i.test(String(location.hostname || ''));
      const matchingCartItem = amazonPage
        ? cartItemRows(16)
          .map((candidate) => ({ candidate, relevance: candidateRelevance(candidate, effectiveQuery) }))
          .find(({ relevance }) => relevance.identityCoverage >= minimumCandidateCoverage(relevance.requiredTokenCount))
        : (() => {
            const cartText = pagePlainText(16000);
            const relevance = candidateRelevance({ title: cartText, context: cartText, url: location.href }, effectiveQuery);
            return relevance.coverage >= minimumCandidateCoverage(relevance.requiredTokenCount)
              ? { candidate: { title: cartText }, relevance }
              : null;
          })();
      if (matchingCartItem) {
        return {
          completed: true,
          skipped: true,
          existingCartItemVerified: true,
          reason: 'The approved item is already verified in the cart; continuing to checkout.'
        };
      }
      }
    }
    const candidates = candidateRows(18)
      .map((candidate) => ({ ...candidate, ...scoreCandidate(candidate, effectiveQuery, maxPrice) }))
      .filter((candidate) => candidate.score >= 4 && !candidate.sponsored)
      .filter((candidate) => candidate.relevance.identityCoverage >= minimumCandidateCoverage(candidate.relevance.requiredTokenCount))
      .filter((candidate) => maxPrice == null || (
        candidate.price != null
        && candidate.price <= Number(maxPrice) + 0.005
      ));
    // Amazon catalog missions never silently fall back into Local Market or an
    // identified external seller. They are a different fulfillment rail.
    const strictAmazonCatalog = fulfillmentPolicy === 'amazon_free_shipping_preferred' || primeRequired;
    const effectiveCandidatePolicy = strictAmazonCatalog ? 'free_shipping_preferred_price_quality' : candidatePolicy;
    const catalogCandidates = strictAmazonCatalog
      ? candidates.filter((candidate) => !candidate.thirdPartyMarketplace && !candidate.thirdPartySeller)
      : candidates;
    if (!catalogCandidates.length) {
      return {
        completed: false,
        reason: 'No Amazon catalog candidate matched. Magic City will not switch this mission to Local Market or an identified third-party seller.'
      };
    }
    const fulfillmentEligibleCandidates = catalogCandidates.filter((candidate) => fulfillmentScore(candidate) > 0);
    const candidatesWithFulfillmentPreference = primeRequired
      ? catalogCandidates.filter((candidate) => candidate.primeEligible)
      : fulfillmentEligibleCandidates.length
        ? fulfillmentEligibleCandidates
        : catalogCandidates;
    if (primeRequired && !candidatesWithFulfillmentPreference.length) {
      return {
        completed: false,
        primeRequired: true,
        reason: 'No matching Amazon Prime product was visible within the approved item budget. Magic City did not fall back to non-Prime shipping.'
      };
    }
    const eligibleCandidates = candidatesWithFulfillmentPreference
      .sort((left, right) => compareCandidates(left, right, effectiveCandidatePolicy));
    const selected = eligibleCandidates[0];
    if (!selected) {
      return {
        completed: false,
        reason: 'No high-confidence, non-sponsored public result matched the approved query.'
      };
    }
    const summarize = (candidate) => ({
      id: candidate.id,
      asin: candidate.asin,
      title: candidate.title,
      url: candidate.url,
      price: candidate.price,
      score: candidate.score,
      relevance: candidate.relevance,
      primeEligible: candidate.primeEligible,
      amazonFulfilled: candidate.amazonFulfilled,
      freeShipping: candidate.freeShipping,
      shippingPrice: candidate.shippingPrice,
      estimatedDeliveredPrice: candidate.estimatedDeliveredPrice,
      thirdPartyMarketplace: candidate.thirdPartyMarketplace,
      thirdPartySeller: candidate.thirdPartySeller,
      candidatePolicy: effectiveCandidatePolicy || 'relevance'
    });
    const selectedSummary = summarize(selected);
    // Unknown fulfillment opens the product page first. A catalog mission may
    // direct-cart only when the result card itself proves Prime or Amazon
    // fulfillment.
    const directCartAllowed = !strictAmazonCatalog
      // Search-result cards are allowed to add a bounded, matching Prime item
      // directly. Amazon often shows threshold/free-delivery copy on the card;
      // the authoritative shipping decision happens later on the checkout page.
      || (primeRequired
        ? Boolean(selected.primeEligible)
        : Boolean(selected.primeEligible || selected.amazonFulfilled));
    // The candidate identity and its DOM container are the authority here,
    // not a brittle assumption about the current host name.
    const remembered = rememberSelectedCandidate(selected);
    // Selection and the exact card-local cart click are one small Amazon
    // primitive. It removes the service-worker handoff that previously left a
    // run at "Product selected" while the cart control sat visible on screen.
    const directCartControl = directCartAllowed ? clickSelectedCandidateCartControl(selected) : null;
    if (directCartControl) remembered.cartActionStarted = true;
    return {
      completed: true,
      navigationRequested: !directCartControl,
      navigationUrl: directCartControl ? '' : selected.url,
      searchResultSelected: Boolean(directCartControl),
      directCartControlAvailable: Boolean(directCartControl),
      directSearchResultCart: Boolean(directCartControl),
      controlStrategy: directCartControl ? 'selected_search_result' : 'product_navigation',
      selected: selectedSummary,
      alternatives: eligibleCandidates.filter((candidate) => candidate.id !== selected.id).slice(0, 4).map(summarize)
    };
  }

  function selectMatchingCheckoutOptions(profile = {}) {
    const selected = [];
    const expectedLast4 = String(profile.paymentCardLast4 || '').replace(/\D/g, '').slice(-4);
    const shippingText = normalizeMatchText(`${profile.streetAddress || profile.shippingStreetAddress || ''} ${profile.zipCode || profile.shippingZipCode || ''}`);
    // A merchant can render several variants of one address (for example,
    // different saved suites). If the currently checked row already matches
    // the vault's address identity, preserve that user/merchant selection
    // instead of clicking a later approximate sibling.
    const selectedShippingAddressAlreadyMatches = Boolean(shippingText) && selectedVisibleAddressChoiceMatches(profile);
    const candidateInputs = Array.from(interactionRoot().querySelectorAll('input[type="radio"], input[type="checkbox"]'))
      .filter((input) => visibleChoiceInput(input));
    const matchingPaymentChoice = expectedLast4 ? findMatchingStoredPaymentChoice(profile) : null;
    if (matchingPaymentChoice && !matchingPaymentChoice.selected) {
      const paymentSelected = matchingPaymentChoice.kind === 'semantic_control'
        ? selectSemanticPaymentCardControl(matchingPaymentChoice)
        : selectPaymentChoiceInput(matchingPaymentChoice.input, matchingPaymentChoice.context);
      if (paymentSelected) selected.push('matching payment card');
    }
    for (const input of candidateInputs) {
      const addressChoice = shippingText ? addressChoiceContext(input) : null;
      if (paymentChoiceInput(input)) continue;
      if (shippingText && !selectedShippingAddressAlreadyMatches && !input.checked
        && addressChoice
        && addressLooksLikeProfile(addressChoice.text, profile)) {
        if (selectAddressChoiceInput(input)) {
          selected.push('matching delivery address');
        }
      }
    }
    const selectedKinds = new Set(selected);
    if (selectedShippingAddressAlreadyMatches) selectedKinds.add('matching delivery address');
    const riskyPattern = /\b(add a credit|add credit|add debit|add a new card|card number|security code|cvv|cvc|gift card|promo code|add a new address|add new address|new address|prime|trial|subscribe)\b/i;
    for (const control of interactiveControls()) {
      const label = textFor(control);
      if (!label || FINAL_ACTION_PATTERN.test(label) || riskyPattern.test(label)) continue;
      const descriptor = controlDescriptor(control);
      const sectionText = sectionTextForControl(control);
      const sameRow = sameRowTextForControl(control);
      const nearby = nearbyTextForControl(control);
      const haystack = compactText([label, descriptor, sectionText, sameRow, nearby].filter(Boolean).join('\n'), 3000);
      if (shippingText && !selectedKinds.has('matching delivery address') && addressLooksLikeProfile(haystack, profile)
        && /\b(?:use|select|choose|deliver to|ship to)\s+(?:this\s+)?address\b/i.test(`${label}\n${descriptor}`)) {
        if (immediateSafeClick(control)) {
          selected.push('matching delivery address');
          selectedKinds.add('matching delivery address');
        }
      }
    }
    return [...new Set(selected)];
  }

  function savedPaymentChoiceVisible() {
    return Array.from(interactionRoot().querySelectorAll('input[type="radio"], input[type="checkbox"]'))
      .some((input) => paymentChoiceInput(input))
      || semanticPaymentCardChoices().length > 0;
  }

  function findPaymentAddControl() {
    const entries = interactiveControls()
      .map((control, index) => {
        const label = textFor(control);
        const descriptor = controlDescriptor(control);
        const combined = `${label}\n${descriptor}`;
        const addCard = /\badd (?:a )?(?:(?:credit|debit)(?: or (?:credit|debit))?) card\b|\badd a new card\b/i.test(combined);
        const unsafe = /\b(?:gift card|voucher|promo code|apply and pay|place (?:your )?order|buy now)\b/i.test(combined);
        return { control, label, score: (addCard ? 220 : 0) - (unsafe ? 500 : 0), index };
      })
      .filter((entry) => entry.score >= 200)
      .sort((left, right) => right.score - left.score || left.index - right.index);
    return entries[0] || null;
  }

  function findMatchingStoredPaymentChoice(profile = {}) {
    const expectedLast4 = String(profile.paymentCardLast4 || '').replace(/\D/g, '').slice(-4);
    if (!expectedLast4) return null;
    const inputs = Array.from(interactionRoot().querySelectorAll('input[type="radio"], input[type="checkbox"]'));
    const matches = inputs
      .filter((input) => !input.disabled && input.getAttribute?.('aria-disabled') !== 'true' && visibleChoiceInput(input))
      .map((input) => ({ input, context: paymentChoiceContext(input) }))
      .filter(({ input, context }) => context?.endings?.length === 1
        && context.endings[0] === expectedLast4
        && !paymentChoiceUnavailable(context, input))
      .map(({ input, context }) => ({
        input,
        context,
        selected: Boolean(input.checked || input.getAttribute?.('aria-checked') === 'true'),
        kind: 'input',
        target: paymentChoiceClickTarget(input, context),
        label: compactText(context.text, 180),
        score: 280
      }));
    if (matches.length) return matches.length === 1 ? matches[0] : null;
    const buttonMatches = semanticPaymentCardChoices()
      .filter((choice) => choice.context.endings[0] === expectedLast4
        && !paymentChoiceUnavailable(choice.context, choice.control))
      .map((choice) => ({
        ...choice,
        label: compactText(choice.context.text, 180),
        score: 280
      }));
    return buttonMatches.length === 1 ? buttonMatches[0] : null;
  }

  function findPaymentMethodConfirmControl() {
    const candidates = [
      ...interactiveControls(),
      ...Array.from(interactionRoot().querySelectorAll('.a-button, .a-button-inner')).map((root) =>
        root.querySelector?.('input[type="submit"], input[type="button"], button, [role="button"]') || root
      )
    ];
    const seen = new Set();
    const entries = candidates
      .map((control, index) => {
        if (!control || seen.has(control)) return null;
        seen.add(control);
        if (!visible(control) || control.disabled || control.getAttribute?.('aria-disabled') === 'true') return null;
        const directLabel = compactText([
          control?.innerText,
          control?.textContent,
          control?.value,
          control?.getAttribute?.('aria-label'),
          ariaLabelledText(control)
        ].filter(Boolean).join(' '), 180);
        const visibleLabel = visibleControlLabel(control, 180);
        const descriptor = controlDescriptor(control);
        const label = directLabel || visibleLabel || compactText(textFor(control), 180).replace(/\s+/g, ' ').trim();
        // Do not use the parent-derived visible label for matching here. On
        // Amazon it can include the whole payment section, causing a nearby
        // Change link to inherit "Use this payment method" text.
        const confirmationText = directLabel;
        const exactConfirmation = /^(?:use this payment method|continue with (?:this|selected) payment method)$/im.test(confirmationText);
        const containsConfirmation = /\buse this payment method\b/i.test(confirmationText)
          || /\bcontinue with (?:this|selected) payment method\b/i.test(confirmationText);
        const unsafeLabel = /\b(add (?:a )?(?:new )?(?:credit|debit|payment)|gift card|promo code|prime|trial|subscribe)\b/i.test(confirmationText);
        const unsafeDescriptor = /\b(gift card|promo code|prime|trial|subscribe)\b/i.test(descriptor);
        const unsafe = FINAL_ACTION_PATTERN.test(directLabel || label) || unsafeLabel || unsafeDescriptor;
        return { control, label, score: (exactConfirmation ? 280 : containsConfirmation ? 240 : 0) - (unsafe ? 500 : 0), index };
      })
      .filter(Boolean)
      .filter((entry) => entry.score >= 220)
      .sort((left, right) => right.score - left.score || left.index - right.index);
    return entries[0] || null;
  }

  function contextTextForControl(control, maxDepth = 7) {
    const parts = [];
    let node = control;
    for (let depth = 0; node && depth < maxDepth; depth += 1) {
      const text = compactText(node.innerText || node.textContent || '', 1400);
      const marker = compactText([
        node.id,
        node.getAttribute?.('class'),
        node.getAttribute?.('aria-label'),
        node.getAttribute?.('data-testid')
      ].filter(Boolean).join(' '), 400);
      if (text) parts.push(text);
      if (marker) parts.push(marker);
      node = node.parentElement;
    }
    return compactText([...new Set(parts)].join('\n'), 3000);
  }

  function sectionTextForControl(control) {
    const node = control?.closest?.('section, article, li, fieldset, form, [role="group"], [data-testid], [id*="address" i], [id*="payment" i], [id*="ship" i], [id*="delivery" i], [class*="address" i], [class*="payment" i], [class*="ship" i], [class*="delivery" i]') || control?.parentElement || control;
    return compactText([
      node?.innerText || node?.textContent || '',
      node?.getAttribute?.('aria-label') || ''
    ].filter(Boolean).join('\n'), 2200);
  }

  function nearbyTextForControl(control) {
    const rect = control?.getBoundingClientRect?.();
    if (!rect) return '';
    const centerY = rect.top + rect.height / 2;
    const textBlocks = [];
    const candidates = Array.from(document.querySelectorAll('h1, h2, h3, h4, p, span, div, label, [role="heading"]'));
    for (const element of candidates) {
      if (!visible(element) || element === control || element.contains(control)) continue;
      const entryRect = element.getBoundingClientRect();
      if (entryRect.width < 8 || entryRect.height < 6 || entryRect.height > 260) continue;
      const entryCenterY = entryRect.top + entryRect.height / 2;
      if (Math.abs(entryCenterY - centerY) > 180) continue;
      if (entryRect.left > rect.right + 80) continue;
      const text = compactText(element.innerText || element.textContent || '', 900);
      if (!text || text.length < 4) continue;
      textBlocks.push(text);
      if (textBlocks.length >= 14) break;
    }
    return compactText([...new Set(textBlocks)].join('\n'), 2600);
  }

  function sameRowTextForControl(control) {
    const rect = control?.getBoundingClientRect?.();
    if (!rect) return '';
    const centerY = rect.top + rect.height / 2;
    const textBlocks = [];
    const candidates = Array.from(document.querySelectorAll('h1, h2, h3, h4, p, span, div, label, [role="heading"]'));
    for (const element of candidates) {
      if (!visible(element) || element === control || element.contains(control)) continue;
      const entryRect = element.getBoundingClientRect();
      if (entryRect.width < 8 || entryRect.height < 6 || entryRect.height > 220) continue;
      const entryCenterY = entryRect.top + entryRect.height / 2;
      const sameRow = Math.abs(entryCenterY - centerY) <= Math.max(46, rect.height * 1.6);
      const toLeft = entryRect.right <= rect.left + 24;
      const nearby = Math.abs(entryRect.right - rect.left) < 1400 || Math.abs(entryRect.left - rect.left) < 1400;
      if (!sameRow || !toLeft || !nearby) continue;
      const text = compactText(element.innerText || element.textContent || '', 900);
      if (!text || text.length < 4) continue;
      textBlocks.push(text);
      if (textBlocks.length >= 16) break;
    }
    return compactText([...new Set(textBlocks)].join('\n'), 2600);
  }

  function scopedTextForCorrectionControl(control, sectionPattern, competingPattern) {
    let node = control;
    let mixedContext = '';
    for (let depth = 0; node && depth < 9; depth += 1) {
      const text = compactText([
        node.innerText || node.textContent || '',
        node.getAttribute?.('aria-label') || ''
      ].filter(Boolean).join('\n'), 2600);
      if (text && sectionPattern.test(text)) {
        if (!competingPattern.test(text)) return text;
        if (!mixedContext) mixedContext = text;
      }
      node = node.parentElement;
    }
    const sameRow = sameRowTextForControl(control);
    if (sameRow && sectionPattern.test(sameRow) && !competingPattern.test(sameRow)) return sameRow;
    const nearby = nearbyTextForControl(control);
    if (nearby && sectionPattern.test(nearby) && !competingPattern.test(nearby)) return nearby;
    const fallback = sectionTextForControl(control);
    if (fallback && sectionPattern.test(fallback) && !competingPattern.test(fallback)) return fallback;
    return mixedContext;
  }

  function findSectionBoundChangeControl(kind = '') {
    const targetHeading = kind === 'payment'
      ? /\b(paying with|payment method|select a payment|card)\b/i
      : kind === 'delivery'
        ? /\b(shipping speed|delivery option|shipping option)\b/i
        : /\b(delivering to|delivery address|shipping address|ship to)\b/i;
    const competingHeading = kind === 'payment'
      ? /\b(delivering to|delivery address|shipping address|ship to)\b/i
      : /\b(paying with|payment method|select a payment|card)\b/i;
    const controls = interactiveControls().filter((control) => /^(?:change|select another|choose another|use another)$/i.test(textFor(control)));
    for (const control of controls) {
      let node = control.parentElement;
      for (let depth = 0; node && depth < 7; depth += 1) {
        const headings = Array.from(node.querySelectorAll('h1, h2, h3, h4, [role="heading"]'))
          .filter(visible)
          .map((heading) => compactText(heading.innerText || heading.textContent || '', 300));
        if (headings.some((heading) => targetHeading.test(heading))
          && !headings.some((heading) => competingHeading.test(heading))) {
          return { control, label: textFor(control), score: 300 };
        }
        node = node.parentElement;
      }
    }
    return null;
  }

  function findCheckoutCorrectionControl(kind = '', summary = {}) {
    // Amazon's final-review surfaces contain several delivery-adjacent
    // disclosures (pickup, locker, Whole Foods, local market). They are not
    // shipping selectors. Shipping is changed only through a verified radio
    // row below, never through a generic "delivery" control.
    if (kind === 'delivery') return null;
    const sectionBound = findSectionBoundChangeControl(kind);
    if (sectionBound) return sectionBound;
    const isPayment = kind === 'payment';
    const isDelivery = kind === 'delivery';
    const sectionPattern = isPayment
      ? /\b(paying with|payment method|select a payment|card|visa|mastercard|amex|american express|discover)\b/i
      : isDelivery
        ? /\b(delivery option|shipping option|shipping speed|delivery speed|delivery date|arrives|receive|get it|shipping|delivery)\b/i
      : /\b(delivering to|delivery address|shipping address|ship to|address)\b/i;
    const competingPattern = isPayment
      ? /\b(delivering to|delivery address|shipping address|ship to|address)\b/i
      : isDelivery
        ? /\b(paying with|payment method|select a payment|card|visa|mastercard|amex|american express|discover|delivering to|delivery address|shipping address|ship to|address)\b/i
      : /\b(paying with|payment method|select a payment|card|visa|mastercard|amex|american express|discover)\b/i;
    const riskyPattern = isPayment
      ? /\b(add a credit|add credit|add debit|add a new card|card number|security code|cvv|cvc|gift card|promo code)\b/i
      : isDelivery
        ? /\b(try|join|start|get)\s+prime\b|\bprime\b[\s\S]{0,80}\b(trial|membership|auto-renew|renews|month|sign up|subscribe)\b/i
      : /\b(add a new address|add new address|new address)\b/i;
    const expectedLast4 = String(summary.expectedCardLast4 || '').replace(/\D/g, '').slice(-4);
    const entries = interactiveControls()
      .map((control, index) => {
        const label = textFor(control);
        const descriptor = controlDescriptor(control);
        const localContext = scopedTextForCorrectionControl(control, sectionPattern, competingPattern);
        const broadContext = contextTextForControl(control, 7);
        const localHaystack = `${label}\n${descriptor}\n${localContext}`;
        const broadHaystack = `${label}\n${descriptor}\n${broadContext}`;
        const changeish = /\b(change|edit|select another|choose another|use another|manage)\b/i.test(`${label}\n${descriptor}`);
        const unsafeExistingAddressEdit = !isPayment && !isDelivery && /\bedit\b/i.test(`${label}\n${descriptor}`);
        const sectionish = sectionPattern.test(localHaystack);
        const broadSectionish = !sectionish && sectionPattern.test(broadHaystack) && !competingPattern.test(broadHaystack);
        const competingLocal = competingPattern.test(localHaystack);
        const alreadyExpectedCard = isPayment && expectedLast4 && last4FromText(localHaystack) === expectedLast4;
        const risky = riskyPattern.test(`${label}\n${descriptor}`);
        const score = (changeish ? 90 : 0) + (sectionish ? 80 : 0) + (broadSectionish ? 12 : 0) + (alreadyExpectedCard ? 8 : 0) - (competingLocal ? 80 : 0) - (risky ? 95 : 0) - (unsafeExistingAddressEdit ? 240 : 0) - (FINAL_ACTION_PATTERN.test(label) ? 500 : 0);
        return { control, label, score, index };
      })
      .filter((entry) => entry.score >= 100)
      .sort((left, right) => right.score - left.score || left.index - right.index);
    return entries[0] || null;
  }

  function findAddressAddControl() {
    const entries = interactiveControls()
      .map((control, index) => {
        const label = textFor(control);
        const descriptor = controlDescriptor(control);
        const combined = `${label}\n${descriptor}`;
        const addsAddress = /\badd (?:a )?(?:new )?(?:delivery|shipping)?\s*address\b/i.test(combined);
        const score = (addsAddress ? 220 : 0)
          - (FINAL_ACTION_PATTERN.test(label) ? 500 : 0)
          - (POSITIVE_OFFER_PATTERN.test(combined) ? 250 : 0);
        return { control, label, score, index };
      })
      .filter((entry) => entry.score >= 180)
      .sort((left, right) => right.score - left.score || left.index - right.index);
    return entries[0] || null;
  }

  function findAddressConfirmControl() {
    const entries = interactiveControls()
      .map((control, index) => {
        const label = textFor(control);
        const descriptor = controlDescriptor(control);
        const context = scopedTextForCorrectionControl(
          control,
          /\b(delivery address|shipping address|deliver(?:ing)? to|ship to|address)\b/i,
          /\b(payment method|paying with|visa|mastercard|card number|cvv|cvc)\b/i
        );
        const confirmsAddress = /\b(?:use|deliver to|ship to|save|continue with) (?:this |selected |my )?(?:delivery |shipping )?address\b/i.test(`${label}\n${descriptor}`);
        const score = (confirmsAddress ? 220 : 0)
          + (context ? 25 : 0)
          - (FINAL_ACTION_PATTERN.test(label) ? 500 : 0)
          - (POSITIVE_OFFER_PATTERN.test(`${label}\n${descriptor}`) ? 250 : 0);
        return { control, label, score, index };
      })
      .filter((entry) => entry.score >= 200)
      .sort((left, right) => right.score - left.score || left.index - right.index);
    return entries[0] || null;
  }

  function checkoutProfileCorrection(summary = {}) {
    if (summary.addressMatches === false) return 'address';
    if (summary.expectedCardLast4 && summary.selectedCardLast4 && summary.cardMatches === false) return 'payment';
    return '';
  }

  function shippingPriceFromText(value = '') {
    const text = String(value || '');
    if (/\bfree\b/i.test(text) && !/\bprime\b|\btrial\b|auto-renew/i.test(text)) return 0;
    const match = text.match(/\$\s*(\d{1,4}(?:\.\d{2})?)/);
    return match ? Number(match[1]) : null;
  }

  function promotionalDeliveryOption(text = '') {
    return /\b(try|join|start|get)\s+prime\b|\bprime\b[\s\S]{0,80}\b(trial|membership|auto-renew|renews|month|sign up|subscribe)\b|\btrial\b|\bauto-renew\b|\bmembership\b/i.test(String(text || ''));
  }

  function pickupDeliveryOption(text = '') {
    return /\b(?:pickup|pick up|locker|counter|whole foods|amazon fresh|local market)\b/i.test(String(text || ''));
  }

  function deliverySpeedRank(text = '') {
    const value = String(text || '').toLowerCase();
    if (/\b(today|same day)\b/.test(value)) return 0;
    if (/\b(tomorrow|one-day|1-day|next day)\b/.test(value)) return 1;
    if (/\b(two-day|2-day)\b/.test(value)) return 2;
    if (/\bstandard\b/.test(value)) return 5;
    const range = value.match(/\b(\d+)\s*-\s*(\d+)\s+(?:business\s+)?days?\b/);
    if (range) return Number(range[1]) || 9;
    const single = value.match(/\b(\d+)\s+(?:business\s+)?days?\b/);
    if (single) return Number(single[1]) || 9;
    return 9;
  }

  function homeDeliveryOnly(fulfillmentMode = '') {
    return String(fulfillmentMode || '').trim() !== 'pickup_allowed';
  }

  function shippingSpeedSections() {
    const headings = Array.from(interactionRoot().querySelectorAll('h1, h2, h3, h4, [role="heading"]'))
      .filter(visible)
      .filter((heading) => /^shipping speed$/i.test(compactText(heading.innerText || heading.textContent || '', 120)));
    const sections = [];
    for (const heading of headings) {
      let node = heading.parentElement;
      for (let depth = 0; node && node !== document.body && depth < 6; depth += 1, node = node.parentElement) {
        const text = compactText(node.innerText || node.textContent || '', 3600);
        const controls = Array.from(node.querySelectorAll('a, button, input[type="button"], input[type="submit"], [role="button"]'));
        const radios = Array.from(node.querySelectorAll('input[type="radio"]'));
        if (!/\bshipping speed\b/i.test(text) || pickupDeliveryOption(text)) continue;
        if (controls.length || radios.length) {
          sections.push(node);
          break;
        }
      }
    }
    return [...new Set(sections)];
  }

  function deliveryOptionEntries({ includeHidden = false, fulfillmentMode = '' } = {}) {
    const sections = shippingSpeedSections();
    if (!sections.length) return [];
    const inputs = [...new Set(sections.flatMap((section) => Array.from(section.querySelectorAll('input[type="radio"]'))))]
      .filter((input) => includeHidden || visibleChoiceInput(input));
    return inputs
      .map((input) => {
        const container = input.labels?.[0] || radioContainer(input) || input.parentElement;
        const text = compactText(container?.innerText || container?.textContent || '', 1000);
        const shippingish = /\b(delivery|shipping|arrives|receive|get it|standard|free|one.?day|fastest)\b/i.test(text);
        const subscriptionish = promotionalDeliveryOption(text);
        const pickupish = pickupDeliveryOption(text);
        const price = shippingPriceFromText(text);
        return { input, container, text, price, speedRank: deliverySpeedRank(text), shippingish, subscriptionish, pickupish };
      })
      .filter((option) => option.shippingish && !option.subscriptionish && (!homeDeliveryOnly(fulfillmentMode) || !option.pickupish) && option.price != null);
  }

  function selectDeliveryOption(option) {
    if (!option?.input || !visibleChoiceInput(option.input) || option.input.disabled) return false;
    if (option.input.checked || option.input.getAttribute?.('aria-checked') === 'true') return true;
    const target = option.input.labels?.[0] && visible(option.input.labels[0])
      ? option.input.labels[0]
      : visible(option.container)
        ? option.container
        : option.input;
    if (!immediateSafeClick(target)) return false;
    return Boolean(option.input.checked || option.input.getAttribute?.('aria-checked') === 'true');
  }

  function selectPreferredDeliveryOption({ primeRequired = false, fulfillmentMode = '' } = {}) {
    const options = deliveryOptionEntries({ fulfillmentMode });
    const freeOptions = options.filter((option) => option.price === 0)
      .sort((left, right) => left.speedRank - right.speedRank);
    const paidOptions = options.filter((option) => option.price > 0)
      .sort((left, right) => left.price - right.price || left.speedRank - right.speedRank);
    const best = freeOptions[0] || (!primeRequired ? paidOptions[0] : null);
    if (!best) return '';
    if (!selectDeliveryOption(best)) return '';
    return `delivery option ${best.price === 0 ? 'free' : `$${best.price.toFixed(2)}`}`;
  }

  function deliverySelectionState({ fulfillmentMode = '' } = {}) {
    const pageText = pagePlainText(18000);
    const shippingSections = shippingSpeedSections();
    const hiddenShippingOptions = deliveryOptionEntries({ includeHidden: true, fulfillmentMode });
    const options = deliveryOptionEntries({ fulfillmentMode });
    const deliverySectionVisible = shippingSections.length > 0
      || /\b(delivery option|shipping option|shipping speed|delivery speed|delivery date|arrives|receive|get it)\b/i.test(pageText);
    // A named Shipping speed section is an explicit merchant decision point.
    // Its collapsed choices must be opened and selected; a $0 summary line is
    // not evidence that the fastest free option was actually chosen.
    if (shippingSections.length && hiddenShippingOptions.length && !options.length) {
      return {
        required: true,
        confirmed: false,
        freeAvailable: hiddenShippingOptions.some((option) => option.price === 0),
        selectedPrice: null,
        bestPrice: hiddenShippingOptions.filter((option) => option.price === 0)
          .sort((left, right) => left.speedRank - right.speedRank)[0]?.price ?? null,
        source: 'shipping_speed_collapsed'
      };
    }
    // Final review commonly collapses the shipping choices into its order
    // summary. A verified $0 checkout shipping line is stronger evidence than
    // an absent radio control and must not trigger a pickup/local-market flow.
    const checkoutShipping = shippingTotalEvidenceForSurface(pageText, { surface: 'checkout' });
    if (!options.length && checkoutShipping.authoritative && checkoutShipping.amount === 0) {
      return {
        required: false,
        confirmed: true,
        freeAvailable: true,
        selectedPrice: 0,
        bestPrice: 0,
        source: 'checkout_shipping_total'
      };
    }
    if (!deliverySectionVisible && !options.length) return { required: false, confirmed: true };
    const freeOptions = options.filter((option) => option.price === 0)
      .sort((left, right) => left.speedRank - right.speedRank);
    const paidOptions = options.filter((option) => option.price > 0)
      .sort((left, right) => left.price - right.price || left.speedRank - right.speedRank);
    const best = freeOptions[0] || paidOptions[0] || null;
    const selected = options.find((option) => option.input.checked) || null;
    return {
      required: true,
      confirmed: Boolean(best && selected && best.input === selected.input),
      freeAvailable: freeOptions.length > 0,
      selectedPrice: selected?.price ?? null,
      bestPrice: best?.price ?? null
    };
  }

  function shouldOpenDeliverySelector(state = {}) {
    // selectPreferredDeliveryOption handles real, visible shipping radio rows
    // directly. There is no safe generic fallback: Amazon's pickup disclosure
    // also contains delivery/free language and must never be opened by a
    // delivery correction. When no shipping rows are visible, preserve the
    // merchant's current shipping choice and continue with address/card work.
    void state;
    return false;
  }

  // Unlike generic delivery links, a Change control bound to a visible
  // "Shipping speed" / "Delivery option" section has a narrowly defined
  // purpose. It can expose standard carrier-speed radios, but must never be
  // used for pickup, locker, Fresh, Counter, or local-market routing.
  function findSafeDeliveryOptionsControl() {
    for (const section of shippingSpeedSections()) {
      const sectionText = compactText(section.innerText || section.textContent || '', 3600);
      if (pickupDeliveryOption(sectionText)) continue;
      const control = Array.from(section.querySelectorAll('a, button, input[type="button"], input[type="submit"], [role="button"]'))
        .filter(visible)
        .find((candidate) => /^(?:change|choose|edit)$/i.test(compactText(textFor(candidate), 80)) && !pickupOrLockerControl(candidate));
      if (control) return { control, label: textFor(control), score: 320 };
    }
    return null;
  }

  async function chooseFastestFreeShipping({ primeRequired = false, fulfillmentMode = '' } = {}) {
    let selection = selectPreferredDeliveryOption({ primeRequired, fulfillmentMode });
    if (selection) return { selection, opened: false };
    const opener = findSafeDeliveryOptionsControl();
    if (!opener || !immediateSafeClick(opener.control)) return { selection: '', opened: false };
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await waitForPaint(80);
      selection = selectPreferredDeliveryOption({ primeRequired, fulfillmentMode });
      if (selection) return { selection, opened: true };
    }
    return { selection: '', opened: true };
  }

  function findDeclineOfferControl(root = null) {
    const controls = interactiveControls(root)
      .map((control, index) => {
        const label = textFor(control);
        const descriptor = controlDescriptor(control);
        const normalizedLabel = label.toLowerCase().replace(/\s+/g, ' ').trim();
        const exactDecline = DECLINE_OFFER_PATTERN.test(normalizedLabel);
        const declineish = /no thanks|not now|skip|decline|maybe later|continue without|without prime|without benefits|do not add|i'?ll pass/i.test(descriptor);
        const positiveOffer = POSITIVE_OFFER_PATTERN.test(descriptor);
        const href = String(control.getAttribute?.('href') || '');
        const hrefCheckout = /\/checkout|\/buy|\/gp\/buy/i.test(href);
        const hashOnly = /^#/.test(href.trim());
        const score = (exactDecline ? 100 : 0) + (declineish ? 40 : 0) + (hrefCheckout ? 8 : 0) - (hashOnly ? 180 : 0) - (positiveOffer ? 120 : 0) - (FINAL_ACTION_PATTERN.test(label) ? 500 : 0);
        return { control, label, score, index };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.index - right.index);
    return controls[0] || null;
  }

  // Amazon sometimes inserts neutral checkout-prelude pages before its
  // checkout pipeline. Their only forward action is "Continue"; they are not
  // Prime offers or purchase actions, so they can advance within the mission.
  function findAmazonCartContinuationControl() {
    const path = String(location.pathname || '');
    const pageText = pagePlainText(8000);
    const cartContinuation = /^\/alm\/byg(?:\/|$)/i.test(path)
      && /\bneed anything else\b|\bcomplete your cart\b/i.test(pageText);
    const substitutionContinuation = /^\/alm\/substitution(?:\/|$)/i.test(path)
      && /\bchoose your substitution preferences\b/i.test(pageText);
    if (!cartContinuation && !substitutionContinuation) return null;
    return interactiveControls().find((control) => {
      const label = compactText(textFor(control), 120).replace(/\s+/g, ' ').trim();
      const descriptor = controlDescriptor(control);
      return label.toLowerCase() === 'continue'
        && !FINAL_ACTION_PATTERN.test(descriptor)
        && !POSITIVE_OFFER_PATTERN.test(descriptor);
    }) || null;
  }

  function isAmazonLocalMarketFlow() {
    return /^\/alm(?:\/|$)/i.test(String(location.pathname || ''));
  }

  function scoreControlForIntent(control, intent = '', browserState = {}) {
    if (!visible(control) || control.disabled) return null;
    const label = textFor(control);
    const descriptor = controlDescriptor(control);
    const normalizedLabel = label.toLowerCase().replace(/\s+/g, ' ').trim();
    const href = String(control.getAttribute?.('href') || '');
    const hashOnly = /^#/.test(href.trim());
    const state = String(browserState.state || 'browse');
    const onCartPath = isCartPath(location.pathname);
    let score = 0;
    const reasons = [];
    const add = (points, reason) => {
      score += points;
      if (reason) reasons.push(reason);
    };

    if (FINAL_ACTION_PATTERN.test(label)) add(-1000, 'final action blocked');
    if (hashOnly) add(-180, 'hash-only link');
    if (/\b(delete|remove|save for later|share|gift|qty|quantity)\b|^\s*[+-]\s*$/i.test(descriptor)) add(-140, 'cart utility control');
    if (POSITIVE_OFFER_PATTERN.test(descriptor) || /\b(subscribe\s*&\s*save|try prime|join prime|start.*trial|get.*prime|warranty|protection plan)\b/i.test(descriptor)) add(-120, 'positive upsell');
    if (/\b(no thanks|not now|skip|decline|continue without|without prime|without benefits)\b/i.test(descriptor) && state !== 'offer') add(-90, 'decline control outside offer');

    if (intent === 'add_to_cart') {
      if (/\badd to cart\b/i.test(label)) add(150, 'add to cart');
      if (/\badd to bag\b/i.test(label)) add(145, 'add to bag');
      if (/\badd item\b/i.test(label)) add(120, 'add item');
      if (state === 'product') add(20, 'product state');
      if (state === 'search_results') add(-30, 'not on product yet');
      if (/\bbuy now\b/i.test(label)) add(-180, 'direct buy blocked');
    }

    if (intent === 'checkout') {
      if (/\bproceed to checkout\b/i.test(label)) add(180, 'proceed to checkout');
      if (/\bgo to checkout\b/i.test(label)) add(170, 'go to checkout');
      if (/^checkout$/i.test(normalizedLabel) || /\bcheck out\b/i.test(label)) add(140, 'checkout');
      if (/\bcontinue to (?:checkout|payment|shipping|delivery|review)\b/i.test(label)) add(128, 'continue checkout flow');
      if (/\bsave and continue\b/i.test(label)) add(115, 'save and continue');
      if (/\b(use|deliver to|ship to) this address\b/i.test(label)) add(112, 'select address');
      if (/^continue$/i.test(normalizedLabel)) add(state === 'checkout' ? 84 : 36, 'continue');
      if (/\b(go to|view) (?:cart|basket|bag)\b/i.test(label)) add(state === 'cart' && !onCartPath ? 168 : state === 'cart' ? 12 : 104, 'open cart');
      if (/\b(?:shopping )?(?:cart|basket)\b/i.test(label)) add(state === 'cart' && !onCartPath ? 118 : state === 'cart' ? 0 : 78, 'cart link');
      if (state === 'cart' && /\bcheckout\b/i.test(label)) add(26, 'cart checkout state');
      if (state === 'checkout' && /\bcontinue|address|shipping|delivery|payment|review\b/i.test(label)) add(22, 'checkout state');
      if (state === 'product' && /\bcart|checkout\b/i.test(label)) add(14, 'product forward motion');
    }

    return { control, label, score, reasons };
  }

  function chooseIntentControl(intent = '', browserState = {}) {
    const minimumScore = intent === 'add_to_cart' ? 95 : 80;
    const scored = interactiveControls()
      .map((control, index) => {
        const scoredControl = scoreControlForIntent(control, intent, browserState);
        return scoredControl ? { ...scoredControl, index } : null;
      })
      .filter(Boolean)
      .filter((entry) => entry.control && entry.score >= minimumScore)
      .sort((left, right) => right.score - left.score || left.index - right.index);
    const best = scored[0] || null;
    if (!best) {
      return {
        control: null,
        reason: `No high-confidence ${intent === 'checkout' ? 'checkout-progress' : 'cart-prep'} control was found from ${browserState.state || 'this'} state.`
      };
    }
    const runnerUp = scored[1] || null;
    if (runnerUp && best.score < 125 && best.score - runnerUp.score < 8) {
      return {
        control: null,
        reason: `Multiple similar ${intent === 'checkout' ? 'checkout-progress' : 'cart-prep'} controls were visible; Magic City stopped instead of guessing.`
      };
    }
    return best;
  }

  function exactIntentControl(intent = '', browserState = {}) {
    if (intent === 'add_to_cart') {
      const canonical = canonicalAddToCartControl();
      if (canonical) return canonical;
    }
    const selectorGroups = intent === 'add_to_cart'
      ? [
          '#add-to-cart-button',
          'input[name="submit.add-to-cart"]',
          'button[name="submit.add-to-cart"]',
          '[data-testid="add-to-cart-button"]'
        ]
      : String(browserState.state || '') === 'cart'
        ? [
            '#sc-buy-box-ptc-button input[name="proceedToRetailCheckout"]',
            'input[name="proceedToRetailCheckout"]',
            'button[name="proceedToRetailCheckout"]',
            '[data-testid="proceed-to-checkout"]'
          ]
        : [];
    for (const selector of selectorGroups) {
      const control = document.querySelector(selector);
      if (visible(control) && !control.disabled && !FINAL_ACTION_PATTERN.test(textFor(control))) return control;
    }
    const exactLabel = intent === 'add_to_cart'
      ? /^(?:add to cart|add to bag|add item)$/i
      : String(browserState.state || '') === 'cart'
        ? /^(?:proceed to checkout|go to checkout|checkout|go to cart|view cart)$/i
        : /^(?:(?:use|deliver to|ship to) this address|continue to (?:checkout|payment|shipping|delivery|review)|save and continue|continue)$/i;
    return interactiveControls().find((control) => {
      const label = compactText(textFor(control), 160).replace(/\s+/g, ' ').trim();
      return exactLabel.test(label) && !FINAL_ACTION_PATTERN.test(label) && !POSITIVE_OFFER_PATTERN.test(controlDescriptor(control));
    }) || null;
  }

  function clickIntent(intent = '', action = {}, profile = {}) {
    if (intent === 'prefer_free_delivery') return applyAmazonFulfillmentPreference(action);
    if (intent === 'open_cart') {
      if (isAmazonShoppingCartPath(location.pathname || '')) {
        return {
          completed: true,
          skipped: true,
          alreadyInCart: true,
          label: 'Cart open',
          controlStrategy: 'amazon_cart_already_open'
        };
      }
      const target = findAmazonCartOpenControl();
      if (target && immediateSafeClick(target.control)) {
        return {
          completed: true,
          navigationRequested: true,
          label: compactText(visibleControlLabel(target.control), 140) || 'Open cart',
          controlStrategy: target.strategy
        };
      }
      return {
        completed: true,
        cartFallbackRequested: true,
        label: 'Open cart',
        controlStrategy: 'stable_cart_fallback'
      };
    }
    // Fast retail path: selection has already bound an exact Amazon result
    // card. Click only that card's native cart control before doing a full-page
    // state extraction. This keeps the normal search -> cart transition small
    // and prevents large result grids from delaying the one required click.
    if (intent === 'add_to_cart') {
      const selectedCandidate = boundCandidateForAction(action);
      if (selectedCandidate && selectedCandidateCartActionStarted(selectedCandidate)) {
        return {
          completed: true,
          directSearchResultCart: true,
          alreadyStarted: true,
          label: 'Add to cart',
          selected: {
            id: selectedCandidate.id,
            asin: selectedCandidate.asin,
            title: selectedCandidate.title,
            url: selectedCandidate.url,
            price: selectedCandidate.price
          },
          controlStrategy: 'selected_search_result_atomic'
        };
      }
      const strictAmazonCatalog = action.fulfillmentPolicy === 'amazon_free_shipping_preferred' || action.primeRequired === true;
      const directCartAllowed = selectedCandidate && (!strictAmazonCatalog
        || (action.primeRequired === true
          ? selectedCandidate.primeEligible === true
          : Boolean(selectedCandidate.primeEligible || selectedCandidate.amazonFulfilled)));
      const directCartControl = directCartAllowed ? clickSelectedCandidateCartControl(selectedCandidate) : null;
      if (directCartControl) {
        return {
          completed: true,
          directSearchResultCart: true,
          label: compactText(textFor(directCartControl), 140) || 'Add to cart',
          selected: {
            id: selectedCandidate.id,
            asin: selectedCandidate.asin,
            title: selectedCandidate.title,
            url: selectedCandidate.url,
            price: selectedCandidate.price
          },
          controlStrategy: 'selected_search_result'
        };
      }
    }
    if (intent === 'checkout'
      && (action.fulfillmentPolicy === 'amazon_free_shipping_preferred' || action.primeRequired === true)
      && isAmazonLocalMarketFlow()) {
      return {
        completed: false,
        localMarketBlocked: true,
        reason: 'Amazon redirected this cart to Local Market. This mission is restricted to Amazon catalog fulfillment, so Magic City did not continue into that third-party delivery flow.'
      };
    }
    if (intent === 'checkout' && isAmazonShoppingCartPath(location.pathname || '')) {
      const proceed = findAmazonProceedToCheckoutControl();
      const state = fastAmazonCartState(profile || {});
      if (proceed?.control && immediateSafeClick(proceed.control)) {
        return {
          completed: true,
          navigationRequested: true,
          cartCheckoutStarted: true,
          label: compactText(visibleControlLabel(proceed.control), 140) || 'Proceed to checkout',
          browserState: 'cart',
          controlStrategy: proceed.strategy,
          state
        };
      }
      return {
        completed: false,
        browserState: 'cart',
        reason: 'No visible Proceed to checkout control was found on the Amazon cart page.',
        state
      };
    }
    const rawPageText = pagePlainText(30000);
    const controls = interactiveControls();
    const controlText = controls.map(textFor).join('\n');
    const sensitiveField = hasVisibleSensitiveField();
    const addToCartAvailable = Boolean(canonicalAddToCartControl())
      || controls.some((control) => /add to (cart|bag)|add item/i.test(textFor(control)));
    let browserState = classifyBrowserState({ rawPageText, controlText, addToCartAvailable, sensitiveField });
    // "Use this payment method" is not a final spending action. It only
    // confirms a card that is already selected in the merchant UI. Handle it
    // before the generic payment boundary so the continuation action cannot
    // strand a checkout between selection and final review.
    if (intent === 'checkout') {
      const expectedLast4 = String(profile.paymentCardLast4 || '').replace(/\D/g, '').slice(-4);
      const confirmPayment = expectedLast4 && expectedPaymentCardIsSelected(expectedLast4)
        ? findPaymentMethodConfirmControl()
        : null;
      if (confirmPayment && priorBrowserActionReceipt('payment_confirm')) {
        return {
          completed: false,
          paymentConfirmationPending: true,
          reason: 'Amazon is still applying the selected payment method.',
          browserState: browserState.state,
          controlStrategy: 'selected_payment_method_confirmation_pending'
        };
      }
      if (confirmPayment && immediateSafeClick(confirmPayment.control)) {
        return {
          completed: true,
          navigationRequested: true,
          paymentMethodConfirmed: true,
          label: compactText(confirmPayment.label || 'Use this payment method', 140),
          browserState: browserState.state,
          controlStrategy: 'selected_payment_method_confirmation'
        };
      }
    }
    if (['challenge', 'login', 'payment', 'final_review'].includes(browserState.state)) {
      return {
        completed: false,
        reason: `Stopped at ${browserState.state.replace(/_/g, ' ')} boundary: ${browserState.reason}.`
      };
    }
    if (intent === 'add_to_cart' && browserState.state === 'cart' && isCartPath(location.pathname)) {
      return {
        completed: true,
        skipped: true,
        reason: 'A cart item is already prepared; not adding a duplicate item.'
      };
    }
    if (intent === 'add_to_cart'
      && browserState.state === 'cart'
      && /\/(?:dp|gp\/product|product|products|item)\b/i.test(location.pathname)
      && addToCartAvailable) {
      browserState = {
        ...browserState,
        state: 'product',
        reason: 'Product page with a side-cart preview and a canonical Add to Cart control.'
      };
    }
    if (intent === 'add_to_cart') {
      // The exact candidate card, rather than the host name, is the safety
      // boundary. This supports Amazon's changing retail surface without
      // ever selecting a neighboring sponsored or side-cart product.
      const selectedCandidate = boundCandidateForAction(action);
      const strictAmazonCatalog = action.fulfillmentPolicy === 'amazon_free_shipping_preferred' || action.primeRequired === true;
      const primeRequired = action.primeRequired === true;
      if (strictAmazonCatalog && /\/(?:dp|gp\/product)\b/i.test(String(location.pathname || ''))) {
        const fulfillment = visibleProductFulfillmentEvidence(rawPageText);
        if (fulfillment.thirdPartyMarketplace || fulfillment.thirdPartySeller) {
          return {
            completed: false,
            reason: 'This product uses Local Market or an identified third-party seller. Magic City will not add it to a catalog-only mission.'
          };
        }
        if (primeRequired && !fulfillment.primeEligible) {
          return {
            completed: false,
            reason: 'This product is not visibly Prime eligible. Magic City will not add a non-Prime product to a Prime-only mission.'
          };
        }
        if (primeRequired && fulfillment.explicitlyPaid && !fulfillment.freeShipping) {
          return {
            completed: false,
            reason: 'This Prime product only exposed paid or conditional delivery for this checkout. Magic City will try another matching item instead of adding it.'
          };
        }
        if (!primeRequired && !fulfillment.primeEligible && !fulfillment.amazonFulfilled) {
          return {
            completed: false,
            reason: 'Amazon did not expose Prime or Amazon fulfillment for this product, so Magic City did not add an unverified fulfillment option.'
          };
        }
      }
    }
    if (intent === 'checkout') {
      const continuation = findAmazonCartContinuationControl();
      if (continuation && immediateSafeClick(continuation)) {
        return {
          completed: true,
          navigationRequested: true,
          checkoutInterstitialContinued: true,
          label: 'Continue',
          browserState: browserState.state,
          controlStrategy: 'amazon_checkout_continuation'
        };
      }
    }
    if (intent === 'checkout' && browserState.state === 'offer') {
      const decline = findDeclineOfferControl();
      if (decline && scheduleSafeClick(decline.control)) {
        return {
          completed: true,
          navigationRequested: true,
          label: compactText(decline.label || 'Decline optional offer', 140),
          declinedOptionalOffer: true
        };
      }
      return {
        completed: false,
        reason: 'Optional offer page is blocking checkout, but no safe decline/no-thanks control was found.'
      };
    }
    const exactControl = exactIntentControl(intent, browserState);
    if (exactControl && immediateSafeClick(exactControl)) {
      return {
        completed: true,
        navigationRequested: true,
        label: compactText(textFor(exactControl), 140),
        browserState: browserState.state,
        controlStrategy: 'exact'
      };
    }
    const selected = chooseIntentControl(intent, browserState);
    if (selected.control && immediateSafeClick(selected.control)) {
      return {
        completed: true,
        navigationRequested: true,
        label: compactText(selected.label, 140),
        browserState: browserState.state,
        controlScore: selected.score
      };
    }
    return { completed: false, reason: selected.reason || (intent === 'checkout' ? 'No safe checkout control was found.' : 'No safe cart control was found.') };
  }

  function finalOrderControls() {
    const roots = Array.from(interactionRoot().querySelectorAll([
      'button',
      'a',
      'input[type="submit"]',
      'input[type="button"]',
      '[role="button"]',
      '.a-button',
      '.a-button-inner',
      '[id*="submitOrder" i]',
      '[name*="submitOrder" i]',
      '[name*="placeYourOrder" i]'
    ].join(',')));
    const controls = [];
    const seen = new Set();
    for (const root of roots) {
      // Amazon often wraps the visible order label in a role=button surface
      // around the actual native submit input. Prefer that nested native
      // control when it exists; clicking the wrapper itself is not equivalent
      // and can be a no-op.
      const nestedNativeControl = root.querySelector?.('input[type="submit"], input[type="button"], button') || null;
      const clickTarget = nestedNativeControl
        || (root.matches?.('button, a, input[type="submit"], input[type="button"], [role="button"]') ? root : null)
        || root.querySelector?.('[role="button"]')
        || root;
      if ((!visible(root) && !visible(clickTarget)) || clickTarget.disabled) continue;
      const label = visibleControlLabel(root, 220) || visibleControlLabel(clickTarget, 220) || compactText(textFor(clickTarget), 220);
      const hasFinalOrderIntent = /^(?:place(?: your)? order|submit order|confirm and pay)$/i.test(label)
        || /\b(?:place(?: your)? order|submit order|confirm and pay)\b/i.test(label);
      const unsafe = /\b(?:use this payment method|gift card|promo code|prime|trial|subscribe|delivery address|payment method)\b/i.test(label)
        && !/\bplace(?: your)? order\b/i.test(label);
      if (!hasFinalOrderIntent || unsafe) continue;
      if (seen.has(clickTarget)) continue;
      seen.add(clickTarget);
      controls.push({ wrapper: root, clickTarget, validatedLabel: label });
    }
    return controls;
  }

  function saveAmazonCheckoutDefault() {
    if (!/(^|\.)amazon\.com$/i.test(String(location.hostname || ''))) {
      return { attempted: false, saved: false, reason: 'not_amazon' };
    }
    const control = Array.from(interactionRoot().querySelectorAll('input[type="checkbox"], [role="checkbox"]'))
      .filter((entry) => visible(entry))
      .find((entry) => /\bdefault to this (?:delivery address|address) and payment method\b/i.test(compactText([
        entry.labels?.[0]?.innerText || '',
        entry.getAttribute?.('aria-label') || '',
        ariaLabelledText(entry),
        radioContainer(entry)?.innerText || ''
      ].filter(Boolean).join('\n'), 500)));
    if (!control) return { attempted: true, saved: false, reason: 'not_offered' };
    const isChecked = () => control.matches?.('input[type="checkbox"]')
      ? control.checked
      : control.getAttribute?.('aria-checked') === 'true';
    if (isChecked()) return { attempted: true, saved: true, alreadySet: true };
    if (!immediateSafeClick(control)) return { attempted: true, saved: false, reason: 'click_failed' };
    return { attempted: true, saved: isChecked(), reason: isChecked() ? 'enabled' : 'not_confirmed' };
  }

  function pendingOrderMatchEvidence(action = {}) {
    const rawText = pagePlainText(30000);
    const marker = /\bthis is a pending order\b/i.test(rawText);
    const candidate = action.boundCandidate && typeof action.boundCandidate === 'object'
      ? action.boundCandidate
      : null;
    const cartEvidence = action.boundCartEvidence && typeof action.boundCartEvidence === 'object'
      ? action.boundCartEvidence
      : null;
    const expectedAsin = String(cartEvidence?.asin || candidate?.asin || '').trim();
    const expectedTitle = normalizeMatchText(canonicalProductTitle(cartEvidence?.title || candidate?.title || ''));
    const productRows = Array.from(document.querySelectorAll([
      '[data-asin]:not([data-asin=""])',
      '[data-item-index]',
      '[data-testid*="item" i]',
      'article',
      'li'
    ].join(','))).filter(visible);
    const productLinks = Array.from(document.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]')).filter(visible);
    const semanticRowFor = (element) => element?.closest?.([
      '[data-asin]:not([data-asin=""])',
      '[data-item-index]',
      '[data-testid*="item" i]',
      'article',
      'li',
      '.a-fixed-left-grid-inner'
    ].join(',')) || null;
    const evidenceRowFor = (element) => semanticRowFor(element) || element || null;
    const asinElement = expectedAsin
      ? Array.from(document.querySelectorAll('[data-asin]:not([data-asin=""])')).find((element) => String(element.getAttribute('data-asin') || '').trim() === expectedAsin)
      : null;
    const asinLink = expectedAsin
      ? productLinks.find((link) => new RegExp(`/(?:dp|gp/product)/${expectedAsin}(?:[/?#]|$)`, 'i').test(String(link.href || '')))
      : null;
    const asinRow = evidenceRowFor(asinElement || asinLink);
    const titleElement = expectedTitle
      ? [...productLinks, ...Array.from(document.querySelectorAll('h1, h2, h3, [data-testid*="title" i], span.a-size-base, span.a-text-bold, p')).filter(visible)]
          .find((element) => normalizeMatchText(canonicalProductTitle(element.innerText || element.textContent || '')) === expectedTitle)
      : null;
    const exactTitleRow = evidenceRowFor(titleElement)
      || productRows.find((row) => normalizeMatchText(canonicalProductTitle(row.innerText || row.textContent || '')) === expectedTitle);
    const identityRow = asinRow || exactTitleRow;
    const identityMatches = Boolean(identityRow);
    const candidatePrice = Number(cartEvidence?.price ?? candidate?.price);
    const identityText = String(identityRow?.innerText || identityRow?.textContent || '');
    const identityPrices = Array.from(new Set(Array.from(identityText.matchAll(/\$\s*(\d{1,6}(?:\.\d{2})?)/g))
      .filter((match) => {
        const suffix = identityText.slice((match.index || 0) + match[0].length, (match.index || 0) + match[0].length + 40);
        const prefix = identityText.slice(Math.max(0, (match.index || 0) - 24), match.index || 0);
        const unitSuffix = /^\s*(?:\/|per\b)\s*(?:\d+(?:\.\d+)?\s*)?(?:fl\s*oz|ounces?|oz|pounds?|lbs?|kilograms?|kgs?|grams?|g|milliliters?|ml|liters?|l|counts?|ct|each|units?)\b/i.test(suffix);
        const unitPrefix = /(?:unit price|price per)\s*:?\s*$/i.test(prefix);
        return !unitSuffix && !unitPrefix;
      })
      .map((match) => Number(match[1]))
      .filter((amount) => Number.isFinite(amount) && amount > 0)));
    const priceEvidenceAmbiguous = identityPrices.length > 1;
    const priceMatchesInIdentityRow = Number.isFinite(candidatePrice) && candidatePrice > 0
      && identityPrices.length === 1
      && Math.abs(identityPrices[0] - candidatePrice) <= 0.005;
    const merchandiseSubtotalMatch = rawText.match(/\b(?:items?|merchandise subtotal|item subtotal|subtotal\s*\(\s*\d+\s*items?\s*\))\s*:?\s*\$\s*(\d{1,6}(?:\.\d{2})?)/i);
    const explicitMerchandiseSubtotal = merchandiseSubtotalMatch ? Number(merchandiseSubtotalMatch[1]) : null;
    const expectedItemCount = Number(action.expectedItemCount || 0);
    const expectedMerchandiseSubtotal = Number.isFinite(candidatePrice)
      && candidatePrice > 0
      && Number.isInteger(expectedItemCount)
      && expectedItemCount > 0
      ? candidatePrice * expectedItemCount
      : null;
    const merchandisePriceContradiction = Boolean(identityMatches
      && Number.isFinite(candidatePrice)
      && candidatePrice > 0
      && (identityPrices.length > 0 && (!priceMatchesInIdentityRow || priceEvidenceAmbiguous)
        || Number.isFinite(explicitMerchandiseSubtotal)
          && Number.isFinite(expectedMerchandiseSubtotal)
          && Math.abs(explicitMerchandiseSubtotal - expectedMerchandiseSubtotal) > 0.005));
    const singleItemOrderTotalMatches = Number(cartEvidence?.quantity) === 1
      && Number.isFinite(candidatePrice)
      && candidatePrice > 0
      && new RegExp(`\\border total\\s*:?\\s*\\$\\s*${candidatePrice.toFixed(2).replace('.', '\\.')}`, 'i').test(rawText);
    const priceMatches = Boolean(identityMatches
      && !merchandisePriceContradiction
      && (priceMatchesInIdentityRow || singleItemOrderTotalMatches));
    const explicitQuantity = cartRowQuantity(identityRow);
    const quantityContradiction = Number.isInteger(explicitQuantity)
      && Number.isInteger(expectedItemCount)
      && expectedItemCount > 0
      && explicitQuantity !== expectedItemCount;
    const quantityMatches = Number.isInteger(expectedItemCount)
      && expectedItemCount > 0
      && Number(cartEvidence?.quantity) === expectedItemCount
      && cartEvidence?.sessionId === action.sessionId
      && cartEvidence?.planHash === action.planHash
      && !quantityContradiction;
    return {
      marker,
      identityMatches,
      identitySource: asinRow ? 'asin' : exactTitleRow ? 'exact_title' : 'none',
      priceMatches,
      priceSource: priceMatchesInIdentityRow ? 'identity_row' : singleItemOrderTotalMatches ? 'single_item_order_total' : 'none',
      priceEvidenceAmbiguous,
      merchandisePriceContradiction,
      explicitMerchandiseSubtotal: Number.isFinite(explicitMerchandiseSubtotal) ? explicitMerchandiseSubtotal : null,
      quantityMatches,
      quantitySource: quantityMatches ? 'verified_cart' : 'none',
      quantityContradiction,
      explicitQuantity: Number.isInteger(explicitQuantity) ? explicitQuantity : null
    };
  }

  async function confirmPendingOrder(action = {}, profile = {}) {
    const state = pageState(profile);
    if (state.orderSubmitted) {
      return {
        completed: true,
        skipped: true,
        finalSubmitRequested: true,
        orderSubmitted: true,
        reason: 'Merchant order confirmation is already visible.',
        state
      };
    }
    const durableDispatch = action.priorPendingOrderDispatchReceipt;
    if (durableDispatch?.kind === 'final_order'
      && durableDispatch?.phase === 'click_dispatched'
      && durableDispatch?.receiptScope === action.receiptScope) {
      return {
        completed: true,
        skipped: true,
        finalSubmitRequested: true,
        finalSubmitReceipt: durableDispatch,
        pendingOrderContinuationPresent: true,
        reason: 'Pending-order continuation was already dispatched; awaiting merchant confirmation.',
        state
      };
    }
    const evidence = pendingOrderMatchEvidence(action);
    if (!evidence.marker) {
      return {
        completed: true,
        skipped: true,
        finalSubmitRequested: true,
        pendingOrderContinuationPresent: false,
        reason: 'No Amazon pending-order continuation is present.',
        state
      };
    }
    if (action.priorFinalSubmitDispatched !== true) {
      return { completed: false, reason: 'The pending order is not bound to a recorded first final-order dispatch.', state };
    }
    if (!evidence.identityMatches || !evidence.priceMatches || !evidence.quantityMatches) {
      return {
        completed: false,
        reason: 'The pending order did not match the current mission item, quantity, and price.',
        pendingOrderMatchEvidence: evidence,
        state
      };
    }
    const finalOrderReceipts = finalOrderReceiptsFor(state);
    const existingDispatch = priorFinalOrderReceipt(action.id, action.receiptScope, finalOrderReceipts, 'click_dispatched');
    if (existingDispatch) {
      return {
        completed: true,
        skipped: true,
        finalSubmitRequested: true,
        finalSubmitReceipt: existingDispatch,
        pendingOrderContinuationPresent: true,
        pendingOrderMatchEvidence: evidence,
        reason: 'Pending-order continuation was already dispatched; awaiting merchant confirmation.',
        state
      };
    }
    const existingIntent = priorFinalOrderReceipt(action.id, action.receiptScope, finalOrderReceipts, 'final_submit_intent');
    if (existingIntent) {
      return {
        completed: false,
        noReplay: true,
        pendingOrderContinuationPresent: true,
        pendingOrderMatchEvidence: evidence,
        reason: 'Pending-order continuation was interrupted before the native merchant click. Magic City will not replay it.',
        state
      };
    }
    const controls = finalOrderControls();
    if (!controls.length) {
      return { completed: false, reason: 'The matching pending order did not expose a verified continuation control.', state };
    }
    const scheduled = scheduleFinalOrderClick(controls[0]);
    if (!scheduled) {
      return { completed: false, reason: 'The matching pending-order continuation could not be clicked safely.', state };
    }
    const dispatched = await scheduled.dispatchReady;
    if (!dispatched?.receipt) {
      return {
        completed: false,
        reason: dispatched?.reason || 'The matching pending-order continuation could not be dispatched safely.',
        state: pageState(profile)
      };
    }
    return {
      completed: true,
      navigationRequested: true,
      finalSubmitRequested: true,
      finalSubmitReceipt: dispatched.receipt,
      finalSubmitReceipts: [scheduled.intentReceipt, dispatched.receipt],
      pendingOrderContinuationPresent: true,
      pendingOrderMatchEvidence: evidence,
      label: compactText(controls[0].validatedLabel, 140),
      state: pageState(profile)
    };
  }

  async function submitFinalOrder(action = {}, profile = {}) {
    if (action.pendingOrderContinuation === true) return confirmPendingOrder(action, profile);
    if (action.autoSubmitAfterVerifiedCheckout !== true) {
      return { completed: false, reason: 'This mission did not authorize automatic final order submission.' };
    }
    const closedPickupModal = await closeNonBlockingCheckoutPickupModal();
    if (closedPickupModal.closeRequested && !closedPickupModal.closed) {
      return {
        completed: false,
        reason: 'An unexpected pickup overlay remained open after Magic City tried to close it. No delivery or pickup change was made.',
        state: pageState(profile)
      };
    }
    const state = pageState(profile);
    const summary = state.checkoutSummary || {};
    if (state.orderSubmitted) {
      return {
        completed: true,
        skipped: true,
        finalSubmitRequested: true,
        orderSubmitted: true,
        reason: 'Merchant order confirmation is already visible.',
        state
      };
    }
    const maxPrice = Number(action.maxPrice || 0);
    const merchandiseSubtotal = priceFromText(summary.merchandiseSubtotal || '');
    const expectedCardLast4 = String(profile.paymentCardLast4 || '').replace(/\D/g, '').slice(-4);
    const hasAddressPreset = Boolean(profile.streetAddress || profile.shippingStreetAddress || profile.zipCode || profile.shippingZipCode);
    if (state.providerChallenge || state.loginRequired || state.paymentRequired || summary.paymentNeedsHuman) {
      return { completed: false, reason: 'Login, payment, or verification still needs local user interaction.', state };
    }
    if (!state.finalApprovalVisible || String(summary.stage || state.browserState || '') !== 'final_review') {
      return { completed: false, reason: 'The merchant final-order control is not ready yet.', state };
    }
    if (Number.isFinite(maxPrice) && maxPrice > 0 && Number.isFinite(merchandiseSubtotal) && merchandiseSubtotal > maxPrice + 0.005) {
      return { completed: false, reason: 'The verified merchandise subtotal exceeds the approved item budget.', state };
    }
    if (!expectedCardLast4) {
      return {
        completed: false,
        localCheckoutProfileMissing: true,
        reason: 'The local checkout profile is unavailable, so Magic City cannot verify the authorized card.',
        state
      };
    }
    if (summary.cardMatches !== true) {
      return { completed: false, reason: 'The selected merchant card does not match the Local Data Vault card cue.', state };
    }
    if (hasAddressPreset && summary.addressMatches !== true) {
      return { completed: false, reason: 'The selected delivery address does not match the Local Data Vault preset.', state };
    }
    if (summary.deliveryConfirmed !== true) {
      return { completed: false, reason: 'The preferred delivery option is not confirmed yet.', state };
    }
    // An Amazon navigation may outlive a checkpoint request. Only a persisted
    // dispatch receipt proves that the native control was actually invoked.
    // Intent alone is deliberately not replayed or treated as proof: the
    // original page may have died between intent and click.
    const finalOrderReceipts = finalOrderReceiptsFor(state);
    const existingDispatch = priorFinalOrderReceipt(
      action.id,
      action.receiptScope,
      finalOrderReceipts,
      'click_dispatched'
    );
    if (existingDispatch) {
      return {
        completed: true,
        skipped: true,
        finalSubmitRequested: true,
        finalSubmitReceipt: existingDispatch,
        reason: 'Final order click was already requested; awaiting merchant confirmation.',
        state
      };
    }
    const existingIntent = priorFinalOrderReceipt(
      action.id,
      action.receiptScope,
      finalOrderReceipts,
      'final_submit_intent'
    );
    if (existingIntent) {
      return {
        completed: false,
        noReplay: true,
        reason: 'Final order dispatch was interrupted before the native merchant click. Magic City will not replay an irreversible order action.',
        state
      };
    }
    const controls = finalOrderControls();
    if (!controls.length) {
      return { completed: false, reason: 'Magic City could not identify a verified final order control.', state };
    }
    const control = controls[0];
    if (control.clickTarget.disabled) {
      return { completed: false, reason: 'The final order control is not available.', state };
    }
    // This Amazon preference changes a persistent merchant default. Only touch
    // it after the one signed final-order control is present and enabled. It is
    // deliberately best-effort: a missing or failed checkbox never blocks the
    // already-authorized order submission.
    const merchantCheckoutDefault = action.saveMerchantCheckoutDefault === true
      ? saveAmazonCheckoutDefault()
      : { attempted: false, saved: false, reason: 'not_requested' };
    try {
      const scheduledFinalSubmit = scheduleFinalOrderClick(control);
      if (!scheduledFinalSubmit) {
        return { completed: false, reason: 'The merchant final order control could not be clicked safely.', state };
      }
      const dispatchedFinalSubmit = await scheduledFinalSubmit.dispatchReady;
      if (!dispatchedFinalSubmit?.receipt) {
        return {
          completed: false,
          reason: dispatchedFinalSubmit?.reason || 'The merchant final order control could not be dispatched safely.',
          state: pageState(profile)
        };
      }
      const stateAfterFinalSubmitRequested = pageState(profile);
      return {
        completed: true,
        navigationRequested: true,
        finalSubmitRequested: true,
        finalSubmitReceipt: dispatchedFinalSubmit.receipt,
        finalSubmitReceipts: [
          scheduledFinalSubmit.intentReceipt,
          dispatchedFinalSubmit.receipt
        ],
        label: compactText(control.validatedLabel, 140),
        merchantCheckoutDefault,
        checkoutPickupModalClosed: closedPickupModal.closed,
        state: stateAfterFinalSubmitRequested
      };
    } catch {
      return { completed: false, reason: 'The merchant final order control could not be clicked safely.', state };
    }
  }

  async function fillCheckoutProfile(profile = {}, action = {}) {
    const closedPickupModal = await closeNonBlockingCheckoutPickupModal();
    if (closedPickupModal.closed) {
      return {
        completed: true,
        skipped: false,
        checkoutPickupModalClosed: true,
        label: 'Closed pickup chooser',
        state: pageState(profile)
      };
    }
    if (closedPickupModal.closeRequested) {
      return {
        completed: false,
        reason: 'An unexpected pickup overlay remained open after Magic City tried to close it. No delivery or pickup change was made.',
        state: pageState(profile)
      };
    }
    // Once Amazon exposes a verified final review, do not reopen address or
    // delivery controls. The signed final-submit action owns the next step.
    const existingState = pageState(profile);
    if (existingState.checkoutSummary?.finalReviewReady === true) {
      return {
        completed: true,
        skipped: true,
        reason: 'Verified final review is already ready; preserving the merchant checkout state.',
        state: existingState
      };
    }
    const expectedLast4 = String(profile.paymentCardLast4 || '').replace(/\D/g, '').slice(-4);
    const existingSummary = existingState.checkoutSummary || {};
    const priorPaymentConfirmation = priorBrowserActionReceipt('payment_confirm');
    if (expectedLast4
      && priorPaymentConfirmation
      && existingSummary.checkoutOpen === true
      && !existingState.providerChallenge
      && !existingState.loginRequired
      && (existingSummary.cardMatches !== true || existingSummary.paymentMethodConfirmationRequired === true)) {
      return {
        completed: true,
        skipped: false,
        navigationRequested: false,
        paymentConfirmationPending: true,
        paymentConfirmationAlreadyRequested: true,
        label: 'Waiting for payment confirmation',
        reason: 'Amazon is still applying the selected payment method.',
        safeFieldsFilled: [],
        checkoutSelections: [],
        state: existingState
      };
    }
    const rawPageText = pagePlainText(30000);
    const controlText = interactiveControls().map(textFor).join('\n');
    if (isOptionalOfferPage(rawPageText, controlText)) {
      const decline = findDeclineOfferControl();
      if (decline && scheduleSafeClick(decline.control)) {
        return {
          completed: true,
          skipped: false,
          navigationRequested: true,
          label: compactText(decline.label || 'Decline optional offer', 140),
          declinedOptionalOffer: true,
          state: pageState(profile)
        };
      }
      return {
        completed: true,
        skipped: true,
        reason: 'Optional offer is blocking checkout, but no safe decline/no-thanks control was found.',
        state: pageState(profile)
      };
    }
    if (hasVisibleCredentialField() || hasVisibleSensitiveField()) {
      return {
        completed: true,
        skipped: true,
        reason: 'A login, verification, or card-entry field is visible. Magic City will not focus, read, or type into it.',
        state: pageState(profile)
      };
    }
    const filled = [];
    const selectedOptions = selectMatchingCheckoutOptions(profile);
    const checkoutFields = safeCheckoutFields();
    const shippingFormVisible = shippingAddressFormVisible(checkoutFields);
    for (const field of checkoutFields) {
      const key = checkoutFieldKind(field);
      const value = String(valueForCheckoutField(profile, key) || '').trim();
      if (!value || checkoutFieldValueMatches(field, value, key)) continue;
      if (setSafeCheckoutFieldValue(field, value, key)) {
        filled.push(key.replace(/([A-Z])/g, ' $1').toLowerCase());
      }
    }
    // The mission binds fulfillmentMode. Home delivery is the default, and a
    // pickup route is legal only when the signed action explicitly allows it.
    const deliveryChoice = await chooseFastestFreeShipping({
      primeRequired: action.primeRequired === true,
      fulfillmentMode: action.fulfillmentMode
    });
    const deliverySelection = deliveryChoice.selection;
    const state = pageState(profile);
    const summary = state.checkoutSummary || {};
    const selections = [...selectedOptions, deliverySelection].filter(Boolean);
    const addressMatches = summary.addressMatches;
    const addressVerification = String(summary.addressVerification || '');
    const completeShippingProfile = fullShippingAddressAvailable(profile);

    // Amazon's current payment picker uses React-managed card buttons. After
    // selecting one, re-observe the rendered selected row before confirming it.
    if (selectedOptions.includes('matching payment card') && semanticPaymentCardChoices().length) {
      return {
        completed: true,
        skipped: false,
        navigationRequested: true,
        paymentSelectionPending: true,
        label: 'Select matching payment card',
        safeFieldsFilled: [...new Set(filled)],
        checkoutSelections: selections,
        state
      };
    }

    // If the signed Shipping speed section was opened but its radio rows did
    // not render, re-observe. Do not ever fall back to generic delivery or
    // pickup controls.
    if (summary.deliverySelectionRequired === true
      && summary.deliveryConfirmed !== true
      && summary.stage !== 'final_review'
      && !deliverySelection) {
      if (deliveryChoice.opened) {
        return {
          completed: true,
          skipped: false,
          navigationRequested: true,
          label: 'Open Shipping speed',
          checkoutSelections: [...selections, 'open Shipping speed'],
          state
        };
      }
    }

    // Confirming an exact saved-card selection is a non-final checkout step.
    // Raw card entry and the final order action remain hard boundaries.
    const selectedLast4 = expectedPaymentCardIsSelected(expectedLast4)
      ? expectedLast4
      : selectedCardLast4();
    if (expectedLast4 && selectedLast4 === expectedLast4) {
      const confirmPayment = findPaymentMethodConfirmControl();
      if (confirmPayment && priorBrowserActionReceipt('payment_confirm')) {
        return {
          completed: true,
          skipped: false,
          navigationRequested: true,
          paymentConfirmationPending: true,
          paymentConfirmationAlreadyRequested: true,
          label: 'Waiting for payment confirmation',
          safeFieldsFilled: [...new Set(filled)],
          checkoutSelections: selections,
          state
        };
      }
      if (confirmPayment && immediateSafeClick(confirmPayment.control)) {
        return {
          completed: true,
          skipped: false,
          navigationRequested: true,
          // A click only begins Amazon's payment transition. The background
          // must re-observe until this control is gone and final review exists.
          paymentConfirmationPending: true,
          label: compactText(confirmPayment.label || 'Use this payment method', 140),
          safeFieldsFilled: [...new Set(filled)],
          checkoutSelections: [...selections, selectedOptions.includes('matching payment card') ? 'confirm matching payment card' : 'confirm already-selected payment card'],
          state
        };
      }
      if (summary.paymentMethodConfirmationRequired) {
        return {
          completed: false,
          reason: 'The matching payment card is selected, but Amazon did not expose a safe Use this payment method control.',
          safeFieldsFilled: [...new Set(filled)],
          checkoutSelections: selections,
          state
        };
      }
    }

    // A newly filled shipping form is a local-safe state transition. Do not
    // wait for the merchant's rendered summary to catch up before submitting
    // its explicit non-payment address confirmation.
    const addressFormMatchesProfile = shippingFormVisible
      && completeShippingProfile
      && visibleShippingFieldsMatchProfile(profile, checkoutFields);
    if (addressFormMatchesProfile) {
      const confirmAddress = findAddressConfirmControl();
      if (confirmAddress && scheduleSafeClick(confirmAddress.control)) {
        return {
          completed: true,
          skipped: false,
          navigationRequested: true,
          label: compactText(confirmAddress.label || 'Use this address', 140),
          safeFieldsFilled: [...new Set(filled)],
          checkoutSelections: [...selections, 'confirm vault delivery address'],
          state
        };
      }
    }

    // Selecting an address can update Amazon's checkout state asynchronously.
    // Treat the exact profile match as sufficient evidence to continue through
    // the non-sensitive "Deliver to this address" confirmation.
    if (addressMatches === true && summary.addressConfirmationRequired) {
      const confirmAddress = findAddressConfirmControl();
      if (confirmAddress && scheduleSafeClick(confirmAddress.control)) {
        return {
          completed: true,
          skipped: false,
          navigationRequested: true,
          label: compactText(confirmAddress.label || 'Use this address', 140),
          safeFieldsFilled: [...new Set(filled)],
          checkoutSelections: [...selections, 'confirm matching delivery address'],
          state
        };
      }
    }

    if (addressMatches === false) {
      if (shippingFormVisible) {
        if (!completeShippingProfile) {
          return {
            completed: false,
            reason: 'No saved delivery address matched. Add or select the address in Chrome once, then Magic City can reuse it on later runs.',
            safeFieldsFilled: [...new Set(filled)],
            checkoutSelections: selections,
            state
          };
        }
        if (!visibleShippingFieldsMatchProfile(profile, checkoutFields)) {
          return {
            completed: false,
            reason: 'The shipping form did not retain the exact Local Data Vault address, so Magic City stopped instead of submitting it.',
            safeFieldsFilled: [...new Set(filled)],
            checkoutSelections: selections,
            state
          };
        }
        const confirmAddress = findAddressConfirmControl();
        if (confirmAddress && scheduleSafeClick(confirmAddress.control)) {
          return {
            completed: true,
            skipped: false,
            navigationRequested: true,
            label: compactText(confirmAddress.label || 'Use this address', 140),
            safeFieldsFilled: [...new Set(filled)],
            checkoutSelections: [...selections, 'create delivery address from vault'],
            state
          };
        }
        return {
          completed: false,
          reason: 'The exact vault address is filled, but the site did not expose a safe address confirmation control.',
          safeFieldsFilled: [...new Set(filled)],
          checkoutSelections: selections,
          state
        };
      }

      const addAddress = completeShippingProfile ? findAddressAddControl() : null;
      if (addAddress && scheduleSafeClick(addAddress.control)) {
        return {
          completed: true,
          skipped: false,
          navigationRequested: true,
          label: compactText(addAddress.label || 'Add a new address', 140),
          profileCorrection: 'address',
          safeFieldsFilled: [...new Set(filled)],
          checkoutSelections: [...selections, 'create new delivery address'].filter(Boolean),
          state
        };
      }

      const openAddressPicker = findCheckoutCorrectionControl('address', summary);
      if (openAddressPicker && scheduleSafeClick(openAddressPicker.control)) {
        return {
          completed: true,
          skipped: false,
          navigationRequested: true,
          label: compactText(openAddressPicker.label || 'Change delivery address', 140),
          profileCorrection: 'address',
          safeFieldsFilled: [...new Set(filled)],
          checkoutSelections: [...selections, 'open delivery address selector'].filter(Boolean),
          state
        };
      }

      if (!completeShippingProfile) {
        return {
          completed: false,
          reason: 'No saved delivery address matched. Add or select the address in Chrome once, then Magic City can reuse it instead of editing an unrelated saved address.',
          safeFieldsFilled: [...new Set(filled)],
          checkoutSelections: selections,
          state
        };
      }
    }

    if (addressVerification === 'unverified') {
      return {
        completed: false,
        profileCorrection: 'address_verification',
        reason: 'Amazon showed a selected delivery-address row, but the local runner could not verify that row against the saved address fingerprint.',
        safeFieldsFilled: [...new Set(filled)],
        checkoutSelections: selections,
        state
      };
    }

    const correctionKind = checkoutProfileCorrection(summary) ||
      (!deliverySelection && shouldOpenDeliverySelector(state) ? 'delivery' : '');
    if (
      correctionKind === 'payment'
      && summary.expectedCardLast4
      && summary.cardMatches === false
      && !selectedOptions.includes('matching payment card')
    ) {
      const addPaymentCard = findPaymentAddControl();
      if (addPaymentCard && scheduleSafeClick(addPaymentCard.control)) {
        return {
          completed: true,
          skipped: false,
          navigationRequested: true,
          label: compactText(addPaymentCard.label || 'Add a credit or debit card', 140),
          paymentAutofillRequired: true,
          safeFieldsFilled: [...new Set(filled)],
          checkoutSelections: [...selections, 'open browser card autofill'].filter(Boolean),
          state
        };
      }
      // The payment picker may still be collapsed. Fall through to the
      // section-bound Change control, then re-observe and open Add card.
    }
    if (correctionKind) {
      const correction = findCheckoutCorrectionControl(correctionKind, state.checkoutSummary || {});
      if (correction && scheduleSafeClick(correction.control)) {
        return {
          completed: true,
          skipped: false,
          navigationRequested: true,
          label: compactText(correction.label || `Change ${correctionKind}`, 140),
          profileCorrection: correctionKind,
          safeFieldsFilled: [...new Set(filled)],
          checkoutSelections: [...selections, `open ${correctionKind} selector`].filter(Boolean),
          state
        };
      }
      return {
        completed: true,
        skipped: !filled.length && !selectedOptions.length && !deliverySelection,
        reason: `No safe ${correctionKind} change selector was found.`,
        profileCorrection: correctionKind,
        profileCorrectionMissed: true,
        safeFieldsFilled: [...new Set(filled)],
        checkoutSelections: selections,
        state
      };
    }
    return {
      completed: true,
      skipped: !filled.length && !selections.length,
      safeFieldsFilled: [...new Set(filled)],
      checkoutSelections: selections,
      state
    };
  }

  async function executePlanStep(action = {}, checkoutProfile = null) {
    if (!action || typeof action !== 'object') return { completed: false, reason: 'Invalid plan action.' };
    const previousActionContext = activeActionContext;
    activeActionContext = {
      actionId: action.id || '',
      actionType: action.type || '',
      intent: action.intent || '',
      receiptScope: action.receiptScope || ''
    };
    try {
      if (action.type === 'inspect' || action.type === 'pause') return { completed: true, state: pageState(checkoutProfile || {}) };
      if (action.type === 'search') return { ...(await runSearch(action.query)), state: pageState(checkoutProfile || {}) };
      if (action.type === 'select_candidate') {
        const outcome = selectCandidate(action);
        if (outcome.completed && outcome.searchResultSelected === true) {
          return { ...outcome, state: compactPlanStepState({ candidateSelected: true }) };
        }
        return { ...outcome, state: pageState(checkoutProfile || {}) };
      }
      if (action.type === 'navigate' && action.intent === 'open_cart') {
        const outcome = clickIntent('open_cart', action, checkoutProfile || {});
        return { ...outcome, state: compactPlanStepState({ cartOpenStarted: true }) };
      }
      if (action.type === 'click_intent') {
        const outcome = clickIntent(action.intent, action, checkoutProfile || {});
        if (action.intent === 'add_to_cart' && outcome.completed && outcome.directSearchResultCart === true) {
          return { ...outcome, state: compactPlanStepState({ cartActionStarted: true }) };
        }
        if (action.intent === 'checkout' && outcome.completed && outcome.cartCheckoutStarted === true) {
          return outcome;
        }
        return { ...outcome, state: pageState(checkoutProfile || {}) };
      }
      if (action.type === 'fill_checkout_profile') return await fillCheckoutProfile(checkoutProfile || {}, action);
      if (action.type === 'final_submit') return await submitFinalOrder(action, checkoutProfile || {});
      return { completed: false, reason: 'Unsupported local plan action.' };
    } finally {
      activeActionContext = previousActionContext;
    }
  }

  const EXECUTOR_MESSAGE_HANDLER_KEY = '__magicCityExecutorMessageHandlerV1';
  const EXECUTOR_MESSAGE_LISTENER_KEY = '__magicCityExecutorMessageListenerInstalledV1';

  // Chrome executes this file for each browser command. Keep a single
  // listener in the extension's isolated world, but replace its handler on
  // every injection so a later state read cannot be answered by an earlier
  // executor instance with stale in-memory receipts.
  globalThis[EXECUTOR_MESSAGE_HANDLER_KEY] = async (message) => {
      if (message?.type === 'MAGIC_CITY_BROWSER_STATE') return pageState(message.checkoutProfile || {});
      if (message?.type === 'MAGIC_CITY_EXECUTE_PLAN_STEP') return executePlanStep(message.action || {}, message.checkoutProfile || null);
      return { ok: true };
  };

  if (!globalThis[EXECUTOR_MESSAGE_LISTENER_KEY]) {
    globalThis[EXECUTOR_MESSAGE_LISTENER_KEY] = true;
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      const handler = globalThis[EXECUTOR_MESSAGE_HANDLER_KEY];
      Promise.resolve(typeof handler === 'function'
        ? handler(message)
        : { completed: false, reason: 'Magic City browser executor is unavailable.' })
        .then(sendResponse)
        .catch((error) => sendResponse({ completed: false, reason: error?.message || String(error) }));
      return true;
    });
  }
})();
