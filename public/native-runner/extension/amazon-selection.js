export function amazonProductAsin(value = '') {
  let url = null;
  try {
    url = new URL(String(value || ''));
  } catch {
    return '';
  }
  if (!/(^|\.)amazon\.com$/i.test(String(url.hostname || ''))) return '';
  return String(url.pathname || '').match(/(?:^|\/)(?:dp|gp\/product)\/([a-z0-9]{10})(?:\/|$)/i)?.[1]?.toUpperCase() || '';
}

export function amazonProductUrlMatches(expectedUrl = '', observedUrl = '') {
  const expectedAsin = amazonProductAsin(expectedUrl);
  return Boolean(expectedAsin && amazonProductAsin(observedUrl) === expectedAsin);
}

export function amazonProductIdentityMatches(request = '', observedTitle = '', observedPackageEvidence = '') {
  const normalize = (value = '') => String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u2019']/g, '')
    .replace(/&/g, ' and ')
    .replace(/(\d(?:\.\d+)?)([a-z])/gi, '$1 $2')
    .replace(/[^a-z0-9.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const singular = (token = '') => token.length > 4 && token.endsWith('ies')
    ? `${token.slice(0, -3)}y`
    : token.length > 3 && token.endsWith('s') && !token.endsWith('ss')
      ? token.slice(0, -1)
      : token;
  const aliases = new Map([
    ['ct', 'count'], ['paks', 'pack'], ['pacs', 'pack'], ['oz', 'ounce'],
    ['fl', 'fluid'], ['ft', 'foot'], ['sheets', 'sheet'], ['granol', 'granola'], ['abars', 'bar']
  ]);
  const ignored = new Set([
    'and', 'in', 'of', 'the', 'for', 'with', 'buy', 'purchase', 'order', 'get',
    'some', 'from', 'amazon', 'com', 'please', 'spend', 'under', 'budget', 'max'
  ]);
  const numbersFor = (value = '', pattern = '') => [...new Set(
    [...String(value || '').matchAll(new RegExp(`(?<![\\d.])(\\d+(?:\\.\\d+)?|\\.\\d+)\\s*(?:${pattern})\\b`, 'gi'))]
      .map((match) => Number(match[1]))
      .filter(Number.isFinite)
  )];
  const units = [
    ['fluid', 'fl\\.?\\s*oz|fluid\\s*ounces?'],
    ['area', 'sq\\.?\\s*ft|square\\s*(?:feet|foot)'],
    ['quart', 'qt|quarts?'],
    ['liter', 'l|liters?|litres?'],
    ['ounce', '(?<!fl\\s)(?<!fluid\\s)oz|ounces?'],
    ['count', 'ct|count|bars?|bags?|packets?|sticks?|pods?|refills?|pairs?|pads?|sheets?|pieces?'],
    ['roll', 'rolls?'],
    ['box', 'boxes?']
  ];
  const packPatterns = [
    /\b\d+\s*[x\u00d7]\s*~?\d+(?:\.\d+)?\s*(?:fl\.?\s*oz|fluid\s*ounces?|oz|ounces?|sq\.?\s*ft|square\s*(?:feet|foot)|l|liters?|litres?)\b/gi,
    /~?\b\d+(?:\.\d+)?\s*[-\u2013]\s*\d+(?:\.\d+)?\s*(?:fl\.?\s*oz|fluid\s*ounces?|oz|ounces?|sq\.?\s*ft|square\s*(?:feet|foot)|l|liters?|litres?)\b/gi,
    /\b\d+(?:\.\d+)?\s*(?:fl\.?\s*oz|fluid\s*ounces?|oz|ounces?|sq\.?\s*ft|square\s*(?:feet|foot)|qt|quarts?|l|liters?|litres?|ct|count|bars?|bags?|packets?|sticks?|pods?|refills?|pairs?|pads?|sheets?|pieces?|rolls?|boxes?)\b/gi,
    /\b(?:pack of\s+\d+|\d+[ -]+pack)\b/gi
  ];
  const canonicalIdentity = (value = '') => normalize(packPatterns.reduce(
    (text, pattern) => text.replace(pattern, ' '),
    String(value || '').toLowerCase().normalize('NFKD')
      .replace(/\b(?:laundry detergent )?(?:power )?(?:paks?|pacs?|pods?)\b/g, ' detergent capsule ')
      .replace(/\b(?:fabric softener (?:dryer )?sheets|dryer sheets)\b/g, ' laundry finishing sheet ')
      .replace(/\b(?:facial cleanser|face wash)\b/g, ' face cleanser ')
  ));
  const identityRequest = canonicalIdentity(String(request || '').replace(/\$\s*\d+(?:\.\d{1,2})?/g, ' '));
  const tokens = (value = '') => [...new Set(normalize(value).split(/\s+/)
    .map((token) => aliases.get(token) || singular(token))
    .filter((token) => token.length > 1 && !ignored.has(token)))];
  const wanted = tokens(identityRequest);
  const available = new Set(tokens(canonicalIdentity(observedTitle)));
  if (!wanted.length || !observedTitle) return false;
  const exactIdentity = wanted.every((token) => available.has(token));
  const withoutSoftDescription = wanted.filter((token) => token !== 'fruity');
  const semanticIdentity = wanted.includes('fruity')
    && withoutSoftDescription.length > 1
    && withoutSoftDescription.every((token) => available.has(token))
    && /\b(?:fruit|[a-z]*berry|pomegranate)\b/i.test(normalize(observedTitle));
  if (!exactIdentity && !semanticIdentity) return false;

  const packageText = (value = '') => String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u2012\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  const requestText = packageText(String(request || '').replace(/\$\s*\d+(?:\.\d{1,2})?/g, ' '));
  const evidenceText = packageText(`${observedTitle || ''} ${observedPackageEvidence || ''}`);
  const inlinePackCounts = (value = '') => [...new Set([
    ...[...value.matchAll(/\bpack of\s+(\d+)\b/gi)].map((match) => Number(match[1])),
    ...[...value.matchAll(/\b(\d+)[ -]+pack\b/gi)].map((match) => Number(match[1]))
  ].filter(Number.isFinite))];
  const structuredPackFields = (value = '') => [...value.matchAll(
    /\b(item package quantity|package quantity|number of items)\s*:?\s*([^|\n]{0,80})(?=\||\n|$)/gi
  )].map((match) => {
    const fieldValue = String(match[2] || '').trim();
    const exact = /^(\d+)\s*(?:items?|units?|packs?)?$/i.exec(fieldValue);
    if (exact) return { status: 'known', value: Number(exact[1]) };
    const values = [...new Set([...fieldValue.matchAll(/\d+/g)].map((entry) => Number(entry[0])))];
    return {
      status: values.length > 1 || /\b(?:or|through|to)\b|\d\s*[-\u2013]\s*\d/i.test(fieldValue)
        ? 'conflicting'
        : 'unknown',
      value: null
    };
  });
  const requestedOuterValues = inlinePackCounts(requestText);
  if (requestedOuterValues.length > 1) return false;
  const observedStructuredFields = structuredPackFields(packageText(observedPackageEvidence));
  const observedOuterValues = [...new Set([
    ...inlinePackCounts(evidenceText),
    ...observedStructuredFields.filter((field) => field.status === 'known').map((field) => field.value)
  ])];
  const requestedUnitConstraint = units.some(([, pattern]) => (
    new RegExp(`(?:^|\\s)\\d+(?:\\.\\d+)?\\s*[-\\u2013]\\s*\\d+(?:\\.\\d+)?\\s*(?:${pattern})\\b`, 'i').test(requestText)
    || new RegExp(`(?:^|\\s)\\d+\\s*[x\\u00d7]\\s*~?\\d+(?:\\.\\d+)?\\s*(?:${pattern})\\b`, 'i').test(requestText)
    || numbersFor(requestText, pattern).length > 0
  ));
  const packageConstrained = requestedOuterValues.length === 1 || requestedUnitConstraint;
  if (packageConstrained && observedStructuredFields.some((field) => field.status !== 'known')) return false;
  if (observedOuterValues.length > 1) return false;
  if (requestedOuterValues.length === 1
    && (observedOuterValues.length !== 1 || requestedOuterValues[0] !== observedOuterValues[0])) return false;
  const outer = observedOuterValues[0] || 1;

  for (const [unit, pattern] of units) {
    const range = new RegExp(`(?:^|\\s)(\\d+(?:\\.\\d+)?)\\s*[-\\u2013]\\s*(\\d+(?:\\.\\d+)?)\\s*(?:${pattern})\\b`, 'i').exec(requestText);
    const nested = new RegExp(`(?:^|\\s)(\\d+)\\s*[x\\u00d7]\\s*~?(\\d+(?:\\.\\d+)?)\\s*(?:${pattern})\\b`, 'i').exec(requestText);
    const requestedValues = numbersFor(requestText, pattern);
    if (!range && !nested && requestedValues.length === 0) continue;
    if (!range && !nested && requestedValues.length !== 1) return false;

    const observedValues = numbersFor(evidenceText, pattern);
    if (observedValues.length !== 1) return false;
    let observedTotal = observedValues[0];
    if (['fluid', 'area', 'ounce', 'liter'].includes(unit) && outer > 1) observedTotal *= outer;
    if (['count', 'roll', 'box'].includes(unit) && outer > 1 && outer !== observedTotal) return false;

    if (range) {
      if (observedTotal < Number(range[1]) || observedTotal > Number(range[2])) return false;
      continue;
    }
    const requestedTotal = nested ? Number(nested[1]) * Number(nested[2]) : requestedValues[0];
    if (observedTotal !== requestedTotal) return false;
  }
  return true;
}

// This function is passed to chrome.scripting.executeScript, so every helper
// intentionally lives inside its body and the card scan stays self-contained.
export function selectAmazonSearchCard(rawAction = {}, performClick = true) {
  const selectionStartedAt = performance.now();
  const clean = (value = '', limit = 1400) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  const normalize = (value = '') => clean(String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u2019']/g, '')
    .replace(/&/g, ' and ')
    .replace(/(\d(?:\.\d+)?)([a-z])/gi, '$1 $2')
    .replace(/[^a-z0-9.]+/g, ' '));
  const singular = (token = '') => token.length > 4 && token.endsWith('ies')
    ? `${token.slice(0, -3)}y`
    : token.length > 3 && token.endsWith('s') && !token.endsWith('ss')
      ? token.slice(0, -1)
      : token;
  const aliases = new Map([
    ['ct', 'count'], ['paks', 'pack'], ['pacs', 'pack'], ['oz', 'ounce'],
    ['fl', 'fluid'], ['ft', 'foot'], ['sheets', 'sheet'], ['granol', 'granola'], ['abars', 'bar']
  ]);
  const ignored = new Set([
    'and', 'in', 'of', 'the', 'for', 'with', 'buy', 'purchase', 'order', 'get',
    'some', 'from', 'amazon', 'com', 'please', 'spend', 'under', 'budget'
  ]);
  const tokens = (value = '') => [...new Set(normalize(value).split(/\s+/)
    .map((token) => aliases.get(token) || singular(token))
    .filter((token) => token.length > 1 && !ignored.has(token)))];
  const uniqueNumbers = (values = []) => [...new Set(values.filter(Number.isFinite))];
  const numbersFor = (value = '', pattern = '') => uniqueNumbers(
    [...String(value || '').matchAll(new RegExp(`(?<![\\d.])(\\d+(?:\\.\\d+)?|\\.\\d+)\\s*(?:${pattern})\\b`, 'gi'))]
      .map((match) => Number(match[1]))
  );
  const exactMoney = (value = '') => {
    const match = /^\$([\d,]+(?:\.\d{2})?)$/.exec(clean(value, 40));
    return match ? Number(match[1].replaceAll(',', '')) : null;
  };
  const labelFor = (element) => clean([
    element?.innerText,
    element?.textContent,
    element?.value,
    element?.getAttribute?.('aria-label'),
    element?.getAttribute?.('title')
  ].filter(Boolean).join(' '), 300);
  const visible = (element) => {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 4 && rect.height > 4;
  };
  const cartControl = (card) => Array.from(card.querySelectorAll([
    '#add-to-cart-button',
    '[id^="add-to-cart-button"]',
    'input[name*="submit.add-to-cart"]',
    'button[name*="submit.add-to-cart"]',
    '[data-action*="add-to-cart" i]',
    'input[value*="add to cart" i]',
    'button[aria-label*="add to cart" i]',
    'input[aria-label*="add to cart" i]',
    '[role="button"][aria-label*="add to cart" i]',
    'button',
    'input[type="submit"]',
    'input[type="button"]',
    '[role="button"]'
  ].join(','))).find((control) => visible(control)
    && !control.disabled
    && /\badd to (?:cart|bag)\b|\badd item\b/i.test(labelFor(control))
    && !/place (your )?order|confirm purchase|complete purchase|pay now|submit order|buy now/i.test(labelFor(control))) || null;

  const query = clean(rawAction.query || rawAction.selectionBrief, 220);
  const requestedPack = (() => {
    let match = /(\d+)\s*[x\u00d7]\s*~?(\d+(?:\.\d+)?)\s*(fl\.?\s*oz|fluid\s*ounces?|oz|ounces?|sq\.?\s*ft|square\s*(?:feet|foot))\b/i.exec(query);
    if (match) {
      const unit = /fl|fluid/i.test(match[3]) ? 'fluid' : /sq|square/i.test(match[3]) ? 'area' : 'ounce';
      return { unit, total: Number(match[1]) * Number(match[2]), per: Number(match[2]), outer: Number(match[1]), configuration: 'nested' };
    }
    match = /(\d+)\s*[x\u00d7]\s*~?(\d+(?:\.\d+)?)\s*(l|liters?|litres?)\b/i.exec(query);
    if (match) return { unit: 'liter', total: Number(match[1]) * Number(match[2]), per: Number(match[2]), outer: Number(match[1]), configuration: 'nested' };
    match = /~?(\d+(?:\.\d+)?)\s*[-\u2013]\s*(\d+(?:\.\d+)?)\s*(fl\.?\s*oz|fluid\s*ounces?|oz|ounces?|sq\.?\s*ft|square\s*(?:feet|foot))\b/i.exec(query);
    if (match) {
      const unit = /fl|fluid/i.test(match[3]) ? 'fluid' : /sq|square/i.test(match[3]) ? 'area' : 'ounce';
      return { unit, min: Number(match[1]), max: Number(match[2]), total: (Number(match[1]) + Number(match[2])) / 2, configuration: 'range' };
    }
    match = /(\d+)\s+(triple|double|mega|family)\s+(rolls?|boxes?)\b/i.exec(query);
    if (match) return { unit: /^roll/i.test(match[3]) ? 'roll' : 'box', total: Number(match[1]), grade: match[2].toLowerCase(), configuration: 'graded' };
    match = /(\d+)\s*(?:packs?)\s*(?:\/|and)?\s*(\d+)\s*(?:ct|count)\b/i.exec(query);
    if (match) return { unit: 'count', total: Number(match[2]), outer: Number(match[1]), configuration: 'nested-count' };
    const patterns = [
      ['fluid', 'fl\\.?\\s*oz|fluid\\s*ounces?'],
      ['area', 'sq\\.?\\s*ft|square\\s*(?:feet|foot)'],
      ['quart', 'qt|quarts?'],
      ['liter', 'l|liters?|litres?'],
      ['ounce', '(?<!fl\\s)(?<!fluid\\s)oz|ounces?'],
      ['count', 'ct|count|bars?|bags?|packets?|sticks?|pods?|refills?|pairs?|pads?|sheets?|pieces?'],
      ['roll', 'rolls?'],
      ['box', 'boxes?']
    ];
    for (const [unit, pattern] of patterns) {
      const values = numbersFor(query, pattern);
      if (values.length === 1) return { unit, total: values[0], configuration: 'single-measure' };
      if (values.length > 1) return { unit, conflict: true, configuration: 'conflict' };
    }
    match = /\b(\d+)\s*[- ]packs?\b/i.exec(query);
    if (match) return { unit: 'count', total: Number(match[1]), configuration: 'pack' };
    if (/\b(?:single|one[- ]pack|1[- ]pack)\b/i.test(query)) return { unit: 'count', total: 1, configuration: 'single' };
    return null;
  })();
  const countUnitPattern = 'ct|count|bars?|bags?|packets?|sticks?|pods?|refills?|pairs?|pads?|sheets?|pieces?';
  const requestedCountValues = requestedPack?.unit === 'count' ? [] : numbersFor(query, countUnitPattern);
  const requestedCount = requestedCountValues.length === 1
    ? requestedCountValues[0]
    : requestedCountValues.length > 1
      ? NaN
      : null;

  const packTokenPatterns = [
    /\b\d+\s*[x\u00d7]\s*~?\d+(?:\.\d+)?\s*(?:fl\.?\s*oz|fluid\s*ounces?|oz|ounces?|sq\.?\s*ft|square\s*(?:feet|foot))\b/gi,
    /\b\d+\s*[x\u00d7]\s*~?\d+(?:\.\d+)?\s*(?:l|liters?|litres?)\b/gi,
    /~?\b\d+(?:\.\d+)?\s*[-\u2013]\s*\d+(?:\.\d+)?\s*(?:fl\.?\s*oz|fluid\s*ounces?|oz|ounces?|sq\.?\s*ft|square\s*(?:feet|foot))\b/gi,
    /\b\d+\s+(?:triple|double|mega|family)\s+(?:rolls?|boxes?)\b/gi,
    /\b\d+\s*(?:packs?)\s*(?:\/|and)?\s*\d+\s*(?:ct|count)\b/gi,
    /\b\d+(?:\.\d+)?\s*(?:fl\.?\s*oz|fluid\s*ounces?|oz|ounces?|sq\.?\s*ft|square\s*(?:feet|foot)|ct|count|bars?|packets?|sticks?|pods?|refills?|pairs?|pads?|sheets?|pieces?|rolls?|boxes?)\b/gi,
    /\b\d+\s*[- ]packs?\b/gi,
    /\b(?:single|one[- ]pack|1[- ]pack)\b/gi
  ];
  const productText = packTokenPatterns.reduce((value, pattern) => value.replace(pattern, ' '), query);
  const requestedIdentityTokens = tokens(productText).slice(0, 18);
  const requestedFirstToken = requestedIdentityTokens[0] || '';
  const softSemanticTokens = new Set(['fruity']);

  const semanticRoles = (value = '') => {
    const text = normalize(value);
    const roles = new Set();
    const add = (name, pattern) => { if (pattern.test(text)) roles.add(name); };
    add('container', /\bcontainer\b/);
    add('accessory', /\b(?:keeper|accessory|replacement lid|wallet insert|holder|protective case)\b/);
    add('item-tracker', /\b(?:airtag|item tracker|tracking tag)\b/);
    add('skin-moisturizer', /\b(?:moisturizer|moisturizing|water gel|healing ointment|skin protectant)\b/);
    add('makeup', /\b(?:foundation|tint|makeup)\b/);
    add('blade-refill', /\b(?:razor blades?|blade refills?)\b/);
    add('razor-handle', /\b(?:razor handle|handle kit|razor kit)\b/);
    add('ready-drink', /\b(?:thirst quencher|sports drink|ready to drink)\b/);
    add('drink-powder', /\b(?:powder|drink mix)\b/);
    add('shampoo', /\bshampoo\b/);
    add('conditioner', /\b(?:conditioner|2 in 1)\b/);
    return roles;
  };
  const requestRoles = semanticRoles(productText);
  const incompatibleRole = (title = '') => {
    const offered = semanticRoles(title);
    const pairs = [
      ['container', 'accessory'],
      ['item-tracker', 'accessory'],
      ['skin-moisturizer', 'makeup'],
      ['blade-refill', 'razor-handle'],
      ['ready-drink', 'drink-powder'],
      ['shampoo', 'conditioner']
    ];
    if (pairs.some(([wanted, wrong]) => requestRoles.has(wanted) && offered.has(wrong) && !requestRoles.has(wrong))) return true;
    if (/\bsandwich bags?\b/i.test(productText) && /\bsandwich (?:and|&) snack/i.test(title)) return true;
    if (/\b(?:travel size|travel-size|refill pod|refill only|renewed|refurbished)\b/i.test(title)
      && !/\b(?:travel|refill|renewed|refurbished)\b/i.test(productText)) return true;
    if (/\brefill\b/i.test(title)
      && !/\brefill\b/i.test(productText)
      && !/\b(?:pads?|blades?|filters?|pods?)\b/i.test(productText)
      && !/\bjug\b/i.test(title)) return true;
    if (/\b(?:mini|minis|snack size|snack-size)\b/i.test(title)
      && /\b(?:bars?|snacks?)\b/i.test(productText)
      && !/\b(?:mini|minis|snack size|snack-size)\b/i.test(productText)) return true;
    if (/\bvariety pack\b/i.test(title) && !/\bvariety\b/i.test(productText)) return true;
    if (/\b(?:proglide|proshield)\b/i.test(title) && !/\b(?:proglide|proshield)\b/i.test(productText)) return true;
    if (/\b(?:unlimited collection|odor defense plus|oxi boost|builders?|fierce)\b/i.test(title)
      && !/\b(?:unlimited collection|odor defense plus|oxi boost|builders?|fierce)\b/i.test(productText)) return true;
    if (/\b(?:gift set|bundle)\b/i.test(title) && !/\b(?:gift set|bundle)\b/i.test(productText)) return true;
    const compatibility = /\b(?:compatible (?:with|for)|fits)\b/i.exec(title);
    if (compatibility && !/\b(?:compatible (?:with|for)|fits)\b/i.test(productText)) {
      const prefixTokens = new Set(tokens(title.slice(0, compatibility.index)));
      if (!requestedIdentityTokens.every((token) => prefixTokens.has(token))) return true;
    }
    if (/\bantibacterial\b/i.test(title) && !/\bantibacterial\b/i.test(productText) && /\bbody wash\b/i.test(productText)) return true;
    if (/\bspf\s*\d+\b/i.test(title) && !/\bspf\s*\d+\b/i.test(productText)) return true;
    if (/\baa batteries?\b/i.test(productText) && !/\baaa\b/i.test(productText) && /\baaa\b/i.test(title)) return true;
    const offeredBodyWashOunces = /\b(\d+(?:\.\d+)?)\s*(?:fl\.?\s*)?oz\b/i.exec(title);
    if (/\bbody wash\b/i.test(productText)
      && !/\b(?:travel|mini|\d+(?:\.\d+)?\s*(?:fl\.?\s*)?oz)\b/i.test(productText)
      && offeredBodyWashOunces
      && Number(offeredBodyWashOunces[1]) <= 3) return true;
    return false;
  };
  const functionalMismatch = (title = '') => {
    const checks = [
      [/\b(\d+(?:\.\d+)?)\s*(?:gal|gallon)\b/i, /\b(?:bags?|trash)\b/i],
      [/\b(\d+(?:\.\d+)?)\s*(?:ft|feet|foot)\b/i, /\b(?:cable|cord)\b/i],
      [/\b(\d+(?:\.\d+)?)\s*mm\b/i, /\b(?:pen|marker|point|tip)\b/i],
      [/\b(\d+(?:\.\d+)?)\s*(?:qt|quart)\b/i, /\bcontainer\b/i],
      [/\b(\d+(?:\.\d+)?)\s*(?:in|inch|inches|\")\b/i, /\b(?:plate|paper|note)\b/i],
      [/\b(\d+(?:\.\d+)?)\s*w\b/i, /\bcharger\b/i]
    ];
    for (const [measurement, category] of checks) {
      if (!category.test(productText)) continue;
      const expected = measurement.exec(productText);
      if (!expected) continue;
      const offered = measurement.exec(title);
      if (!offered || Number(offered[1]) !== Number(expected[1])) return true;
    }
    const dimensions = /(\d+(?:\.\d+)?)\s*[x\u00d7]\s*(\d+(?:\.\d+)?)\b/i.exec(productText);
    if (dimensions) {
      const offered = /(\d+(?:\.\d+)?)\s*[x\u00d7]\s*(\d+(?:\.\d+)?)\b/i.exec(title);
      if (!offered || Number(offered[1]) !== Number(dimensions[1]) || Number(offered[2]) !== Number(dimensions[2])) return true;
    }
    if (/\bgallon\b[\s\S]{0,30}\bbags?\b/i.test(productText)
      && !/\b(?:half|quarter|\d+(?:\.\d+)?)\s+gallon\b/i.test(productText)
      && /\b(?:half|quarter|\d+(?:\.\d+)?)\s+gallon\b/i.test(title)) return true;
    return false;
  };
  const offeredPack = (identityEvidence = '') => {
    if (!requestedPack || requestedPack.conflict) return { status: requestedPack?.conflict ? 'conflict' : 'unspecified' };
    const patterns = {
      fluid: 'fl\\.?\\s*oz|fluid\\s*ounces?',
      area: 'sq\\.?\\s*ft|square\\s*(?:feet|foot)',
      quart: 'qt|quarts?',
      liter: 'l|liters?|litres?',
      ounce: '(?<!fl\\s)(?<!fluid\\s)oz|ounces?',
      count: 'ct|count|bars?|bags?|packets?|sticks?|pods?|refills?|pairs?|pads?|sheets?|pieces?',
      roll: 'rolls?',
      box: 'boxes?'
    };
    const pattern = patterns[requestedPack.unit];
    if (!pattern) return { status: 'unknown' };
    if (requestedPack.unit === 'ounce' && /\b(?:fl\.?\s*oz|fluid\s*ounces?)\b/i.test(identityEvidence)) return { status: 'unknown' };
    let observed = numbersFor(identityEvidence, requestedPack.grade ? `${requestedPack.grade}\\s+${pattern}` : pattern);
    if (requestedPack.unit === 'box') {
      observed = uniqueNumbers([...identityEvidence.matchAll(/(?<![\d.])(\d+(?:\.\d+)?)\s+(?:(?:family(?:\s+rectangle)?|cube)\s+)?boxes\b/gi)].map((match) => Number(match[1])));
    }
    const measureThenOuter = new RegExp(`(?:\\d+(?:\\.\\d+)?)\\s*(?:${pattern})\\s*[x\\u00d7]\\s*(\\d+)\\b`, 'gi');
    const outer = uniqueNumbers([
      ...[...identityEvidence.matchAll(/\bpack of\s+(\d+)\b/gi)].map((match) => Number(match[1])),
      ...[...identityEvidence.matchAll(/\b(\d+)[ -]+pack\b/gi)].map((match) => Number(match[1])),
      ...[...identityEvidence.matchAll(measureThenOuter)].map((match) => Number(match[1]))
    ]);
    if (outer.length > 1) return { status: 'conflict', observed: outer };
    if ((requestedPack.configuration === 'pack' || requestedPack.configuration === 'single') && outer.length === 1) {
      return { status: 'known', unit: 'count', total: outer[0], per: outer[0], outer: 1 };
    }
    if (requestedPack.configuration === 'single' && !outer.length && !observed.length) {
      return { status: 'known', unit: 'count', total: 1, per: 1, outer: 1 };
    }
    if (requestedPack.configuration === 'nested-count') {
      const totals = numbersFor(identityEvidence, 'total\\s+(?:wipes?|count|ct)');
      if (outer.length === 1 && outer[0] === requestedPack.outer && totals.includes(requestedPack.total)) {
        return { status: 'known', unit: 'count', total: requestedPack.total, per: requestedPack.total / requestedPack.outer, outer: requestedPack.outer };
      }
    }
    if (requestedPack.configuration === 'nested') {
      if (observed.length !== 1) return { status: observed.length ? 'conflict' : 'unknown', observed };
      const servingCounts = numbersFor(identityEvidence, 'count|ct|bags?|packets?|sticks?|bars?');
      if (servingCounts.length === 1) {
        const servingOuter = servingCounts[0] * (outer[0] > 1 ? outer[0] : 1);
        return { status: 'known', unit: requestedPack.unit, total: observed[0] * servingOuter, per: observed[0], outer: servingOuter };
      }
    }
    if (requestedPack.unit === 'count' && !observed.length && outer.length === 1) {
      return { status: 'known', unit: 'count', total: outer[0], per: outer[0], outer: 1 };
    }
    if (observed.length !== 1) return { status: observed.length ? 'conflict' : 'unknown', observed };
    let total = observed[0];
    if (['fluid', 'area', 'ounce', 'liter'].includes(requestedPack.unit) && outer[0] > 1) {
      const binding = new RegExp(`(?:${pattern})[\\s\\S]{0,40}(?:(?:pack of|x)\\s*${outer[0]}|${outer[0]}[ -]*pack)|${outer[0]}[ -]+pack[\\s\\S]{0,40}(?:${pattern})`, 'i');
      if (!binding.test(identityEvidence)) return { status: 'unknown' };
      total *= outer[0];
    } else if (['count', 'roll', 'box'].includes(requestedPack.unit) && outer[0] > 1 && outer[0] !== observed[0]) {
      return { status: 'unknown' };
    }
    return { status: 'known', unit: requestedPack.unit, total, per: observed[0], outer: outer[0] || 1 };
  };
  const titleHasIdentity = (title = '', brand = '') => {
    let normalizedTitle = normalize(title);
    let normalizedProduct = normalize(productText);
    if (/^brita\b/.test(normalizedProduct) && /\bfilter\b/.test(normalizedProduct)) {
      normalizedProduct = normalizedProduct.replace(/\b(?:standard|original)\b/g, 'original');
      normalizedTitle = normalizedTitle.replace(/\b(?:standard|original)\b/g, 'original');
    }
    normalizedProduct = normalizedProduct
      .replace(/\b(?:laundry detergent )?(?:power )?(?:paks?|pacs?|pods?)\b/g, ' detergent capsule ')
      .replace(/\b(?:fabric softener (?:dryer )?sheets|dryer sheets)\b/g, ' laundry finishing sheet ')
      .replace(/\b(?:facial cleanser|face wash)\b/g, ' face cleanser ');
    normalizedTitle = normalizedTitle
      .replace(/\b(?:laundry detergent )?(?:power )?(?:paks?|pacs?|pods?)\b/g, ' detergent capsule ')
      .replace(/\b(?:fabric softener (?:dryer )?sheets|dryer sheets)\b/g, ' laundry finishing sheet ')
      .replace(/\b(?:facial cleanser|face wash)\b/g, ' face cleanser ');
    const wanted = tokens(normalizedProduct);
    const available = new Set(tokens(normalizedTitle));
    const brandFirst = tokens(brand || (fixtureHost ? '' : normalizedTitle))[0] || '';
    return Boolean(wanted.length)
      && (!brandFirst
        || brandFirst === requestedFirstToken
        || requestedIdentityTokens.includes(brandFirst))
      && wanted.every((token) => available.has(token));
  };
  const semanticIdentityEligible = (title = '') => {
    if (/\b(?:only|exactly|must be|specifically|flavo[u]?r|scent|color|colour|model|formula|compatible with)\b/i.test(productText)) return false;
    const wanted = requestedIdentityTokens.filter((token) => !softSemanticTokens.has(token));
    const availableTokens = tokens(title);
    const available = new Set(availableTokens);
    // Intelligence can interpret an allowlisted soft description, but it may
    // not drop any other requested identity token.
    if (!wanted.length || wanted.some((token) => !available.has(token))) return false;
    if (requestedIdentityTokens.includes('fruity')
      && !/\b(?:fruit|[a-z]*berry|pomegranate)\b/i.test(normalize(title))) return false;
    const wantedBigrams = new Set(wanted.slice(0, -1).map((token, index) => `${token} ${wanted[index + 1]}`));
    const availableBigrams = availableTokens.slice(0, -1).map((token, index) => `${token} ${availableTokens[index + 1]}`);
    const sharesPhrase = availableBigrams.some((pair) => wantedBigrams.has(pair));
    return wanted.length >= 2 && sharesPhrase;
  };
  const provisionalIdentityEligible = (title = '') => {
    const wanted = requestedIdentityTokens.filter((token) => !softSemanticTokens.has(token));
    const availableTokens = tokens(title);
    const available = new Set(availableTokens);
    const matched = wanted.filter((token) => available.has(token));
    const missing = wanted.filter((token) => !available.has(token));
    if (wanted.length < 3 || missing.length !== 1 || matched.length / wanted.length < 0.7) return false;
    const clippedToken = availableTokens.some((token) => token.length >= 4
      && Math.abs(token.length - missing[0].length) <= 2
      && (token.endsWith(missing[0]) || missing[0].endsWith(token)));
    if (!clippedToken) return false;
    const matchedBigrams = matched.slice(0, -1).some((token, index) => {
      const pair = `${token} ${matched[index + 1]}`;
      return availableTokens.slice(0, -1).some((availableToken, availableIndex) => (
        `${availableToken} ${availableTokens[availableIndex + 1]}` === pair
      ));
    });
    return matchedBigrams;
  };

  const cards = [];
  const seen = new Set();
  const fixtureHost = ['127.0.0.1', 'localhost'].includes(String(location.hostname || '').toLowerCase());
  let rawScanned = 0;
  for (const card of document.querySelectorAll('[data-component-type="s-search-result"][data-asin], [data-asin]:not([data-asin=""])')) {
    rawScanned += 1;
    if (rawScanned > 96 || cards.length >= 48) break;
    if (!visible(card)) continue;
    const asin = String(card.getAttribute('data-asin') || '').trim();
    const text = clean(card.textContent, 2600);
    const sponsored = Array.from(card.querySelectorAll('[aria-label]')).some((node) => /^Sponsored\b/i.test(node.getAttribute('aria-label') || ''))
      || /SponsoredSponsored|You[\u2019']re seeing this ad|Leave ad feedback|(?:^|\s)Sponsored(?:\s|$)/i.test(text);
    const validAsin = /^[A-Z0-9]{10}$/.test(asin) || fixtureHost && /^[A-Z0-9-]{3,64}$/.test(asin);
    if (sponsored || !validAsin || seen.has(asin)) continue;
    const root = card.querySelector('[data-cy="title-recipe"]') || card;
    const headingNodes = Array.from(root.querySelectorAll('h2'))
      .filter((node) => !node.closest('[data-a-popover], .a-popover-preload'))
    const headings = headingNodes.map((node) => clean(node.textContent, 300)).filter(Boolean);
    const productLinks = Array.from(root.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]'))
      .filter((link) => !link.closest('[data-a-popover], .a-popover-preload'))
      .filter((link) => {
        const hrefAsin = String(link.getAttribute('href') || '').match(/(?:^|\/)(?:dp|gp\/product)\/([a-z0-9]{10})(?:\/|$)/i)?.[1]?.toUpperCase();
        return !hrefAsin || hrefAsin === asin;
      });
    const titleCandidates = [
      ...productLinks.flatMap((link) => [
        link.querySelector('.a-truncate-full')?.textContent,
        link.getAttribute('aria-label'),
        link.getAttribute('title'),
        link.textContent
      ]),
      ...headingNodes.flatMap((node) => [node.getAttribute('aria-label'), node.getAttribute('title'), node.textContent])
    ].map((value) => clean(value, 300)).filter(Boolean);
    const baseTitle = [...new Set(titleCandidates)]
      .sort((a, b) => normalize(b).length - normalize(a).length)[0] || '';
    const brandHeading = headings.length > 1 ? headings[0] : '';
    const title = brandHeading && !tokens(brandHeading).every((token) => new Set(tokens(baseTitle)).has(token))
      ? clean(`${brandHeading} ${baseTitle}`, 300)
      : baseTitle;
    if (!title) continue;
    const boundPriceNodes = Array.from(card.querySelectorAll('.a-price:not(.a-text-price) .a-offscreen'));
    const priceEvidence = (boundPriceNodes.length
      ? boundPriceNodes
      : Array.from(card.querySelectorAll('.a-price:not(.a-text-price)')))
      .map((node) => clean(node.textContent, 40));
    const prices = uniqueNumbers(priceEvidence.map(exactMoney));
    const price = prices.length === 1 ? prices[0] : null;
    const identityEvidence = text.split(/Price, product page|\bOptions:|\d\.\d out of 5 stars/)[0].slice(0, 1300);
    const prime = Boolean(card.querySelector('.a-icon-prime, img[alt="Prime"], [aria-label*="Prime" i]'))
      || /\bprime (?:delivery|eligible)\b/i.test(text);
    const conditionalShippingPattern = /\b(?:on|over)\s+\$\s*\d|\$\s*\d+\s+(?:of|more)|qualifying items?|minimum order/i;
    const completeDeliveryMessage = (node) => {
      const block = node.closest('p, [data-csa-c-delivery-price], [data-cy*="delivery" i], [class*="delivery" i], [class*="shipping" i]');
      if (block && card.contains(block)) return clean(block.textContent, 500);
      if (node.tagName === 'SPAN' && node.parentElement) {
        const inlineText = Array.from(node.parentElement.childNodes)
          .filter((sibling) => sibling.nodeType === Node.TEXT_NODE
            || sibling.nodeType === Node.ELEMENT_NODE && /^(?:SPAN|BR|STRONG|EM|B|I)$/.test(sibling.tagName))
          .map((sibling) => sibling.textContent || '')
          .join(' ');
        if (/\bfree (?:delivery|shipping)\b/i.test(inlineText)) return clean(inlineText, 500);
      }
      return clean(node.textContent, 500);
    };
    const deliveryEvidence = [...new Set(Array.from(card.querySelectorAll('span, p, div'))
      .map(completeDeliveryMessage)
      .filter((value) => /\bfree (?:delivery|shipping)\b/i.test(value)))];
    const freeShipping = deliveryEvidence.some((value) => !conditionalShippingPattern.test(value));
    const conditionalShipping = deliveryEvidence.some((value) => conditionalShippingPattern.test(value));
    seen.add(asin);
    cards.push({
      card,
      control: cartControl(card),
      index: cards.length,
      asin,
      title,
      brand: brandHeading,
      identityEvidence,
      price,
      priceConflict: prices.length > 1,
      prime,
      freeShipping,
      conditionalShipping,
      href: card.querySelector('h2 a[href*="/dp/"], a[href*="/dp/"]')?.href || `https://www.amazon.com/dp/${asin}`
    });
  }

  const maxPrice = rawAction.maxPrice == null || rawAction.maxPrice === '' ? null : Number(rawAction.maxPrice);
  const requiresFulfillment = rawAction.primeRequired === true;
  const approvedIntelligenceCandidate = rawAction.intelligenceApprovedCandidate
    && typeof rawAction.intelligenceApprovedCandidate === 'object'
    ? rawAction.intelligenceApprovedCandidate
    : null;
  let bestExact = null;
  let bestAlternative = null;
  let bestVerificationCandidate = null;
  const intelligenceCandidates = [];
  const rejected = { price: 0, budget: 0, fulfillment: 0, prime: 0, freeShipping: 0, conditionalShipping: 0, identity: 0, package: 0 };
  const summarize = (candidate, pack = null, { requiresProductPageVerification = false, identityStatus = 'verified' } = {}) => ({
    id: `candidate-${candidate.index + 1}`,
    asin: candidate.asin,
    title: candidate.title,
    url: candidate.href,
    price: candidate.price,
    primeEligible: candidate.prime,
    freeShipping: candidate.freeShipping,
    conditionalShipping: candidate.conditionalShipping,
    cartActionStarted: false,
    pack,
    packageFacts: pack,
    requiresProductPageVerification,
    identityStatus,
    hardEligible: true
  });
  const elapsed = () => Math.max(0, performance.now() - selectionStartedAt);
  const betterExact = (candidate, current) => {
    if (!current) return true;
    if (Number(candidate.prime) !== Number(current.prime)) return candidate.prime;
    const candidateFree = candidate.freeShipping && !candidate.conditionalShipping;
    const currentFree = current.freeShipping && !current.conditionalShipping;
    if (Number(candidateFree) !== Number(currentFree)) return candidateFree;
    if (candidate.price !== current.price) return candidate.price < current.price;
    return candidate.index < current.index;
  };
  const packageMatchFor = (candidate) => {
    let pack = offeredPack(candidate.title);
    if (pack.status === 'unknown') pack = offeredPack(candidate.identityEvidence || candidate.title);
    if (!requestedPack) return { kind: 'exact', pack };
    if (pack.status !== 'known' || pack.unit !== requestedPack.unit) return { kind: 'reject', pack };
    const offeredCountValues = requestedCount == null
      ? []
      : numbersFor(candidate.identityEvidence || candidate.title, countUnitPattern);
    if (Number.isNaN(requestedCount) || (requestedCount != null && offeredCountValues.length !== 1)) {
      return { kind: 'reject', pack };
    }
    const offeredCount = requestedCount == null ? null : offeredCountValues[0];
    const requiresMatchingPortion = requestedPack.configuration === 'nested'
      && (requestedPack.outer >= 6 || /\b(?:snack packs?|individual|on[- ]the[- ]go)\b/i.test(productText));
    if (requiresMatchingPortion && pack.per !== requestedPack.per) return { kind: 'reject', pack, offeredCount };
    const primaryPackExact = requestedPack.configuration === 'range'
      ? pack.total >= requestedPack.min && pack.total <= requestedPack.max
      : pack.total === requestedPack.total;
    const exact = primaryPackExact && (requestedCount == null || offeredCount === requestedCount);
    if (exact) return { kind: 'exact', pack, offeredCount };
    return {
      kind: 'alternative',
      pack,
      offeredCount,
      distance: Math.max(
        primaryPackExact ? 0 : Math.abs(Math.log(pack.total / requestedPack.total)),
        requestedCount == null ? 0 : Math.abs(Math.log(offeredCount / requestedCount))
      )
    };
  };
  const approvedEvidenceMatches = (candidate, pack) => {
    if (!approvedIntelligenceCandidate) return false;
    const expectedPrice = approvedIntelligenceCandidate.price === null || approvedIntelligenceCandidate.price === ''
      ? null
      : Number(approvedIntelligenceCandidate.price);
    const expectedPack = approvedIntelligenceCandidate.packageFacts || approvedIntelligenceCandidate.pack || null;
    const samePack = !expectedPack || (
      String(expectedPack.status || '') === String(pack?.status || '')
      && String(expectedPack.unit || '') === String(pack?.unit || '')
      && Number(expectedPack.total || 0) === Number(pack?.total || 0)
      && Number(expectedPack.per || 0) === Number(pack?.per || 0)
      && Number(expectedPack.outer || 0) === Number(pack?.outer || 0)
      && String(expectedPack.configuration || '') === String(pack?.configuration || '')
    );
    const sameAsin = candidate.asin === String(approvedIntelligenceCandidate.asin || '').toUpperCase();
    if (!sameAsin || !samePack) return false;
    if (approvedIntelligenceCandidate.requiresProductPageVerification === true) {
      // Amazon can hydrate price and delivery fragments while the bounded
      // title consultation is in flight. Keep the advice bound to the same
      // ASIN, then verify the current offer on its product page.
      return true;
    }
    return normalize(candidate.title) === normalize(approvedIntelligenceCandidate.title || '')
      && (expectedPrice === null
        ? !Number.isFinite(candidate.price)
        : Number.isFinite(expectedPrice) && Math.abs(candidate.price - expectedPrice) <= 0.005)
      && candidate.prime === (approvedIntelligenceCandidate.primeEligible === true)
      && candidate.freeShipping === (approvedIntelligenceCandidate.freeShipping === true)
      && candidate.conditionalShipping === (approvedIntelligenceCandidate.conditionalShipping === true)
      && !(approvedIntelligenceCandidate.identityStatus === 'provisional'
        || !Number.isFinite(candidate.price)
        || requiresFulfillment && !(candidate.prime && candidate.freeShipping));
  };
  for (const candidate of cards) {
    if (approvedIntelligenceCandidate
      && candidate.asin !== String(approvedIntelligenceCandidate.asin || '').toUpperCase()) continue;
    const exactIdentity = titleHasIdentity(candidate.title, candidate.brand);
    const semanticIdentity = !exactIdentity && semanticIdentityEligible(candidate.title);
    const provisionalIdentity = !exactIdentity && !semanticIdentity && provisionalIdentityEligible(candidate.title);
    if ((!exactIdentity && !semanticIdentity && !provisionalIdentity) || incompatibleRole(candidate.title) || functionalMismatch(candidate.title)) { rejected.identity += 1; continue; }
    const packageMatch = packageMatchFor(candidate);
    if (packageMatch.kind === 'reject') { rejected.package += 1; continue; }
    const priceInconclusive = candidate.priceConflict || !Number.isFinite(candidate.price) || candidate.price <= 0;
    if (!priceInconclusive && Number.isFinite(maxPrice) && candidate.price > maxPrice + 0.005) { rejected.budget += 1; continue; }
    const fulfillmentInconclusive = requiresFulfillment && !(candidate.prime && candidate.freeShipping);
    if (priceInconclusive) rejected.price += 1;
    if (fulfillmentInconclusive) {
      rejected.fulfillment += 1;
      if (!candidate.prime) rejected.prime += 1;
      if (!candidate.freeShipping) rejected.freeShipping += 1;
      if (candidate.conditionalShipping) rejected.conditionalShipping += 1;
    }
    if (priceInconclusive || fulfillmentInconclusive) {
      if (approvedIntelligenceCandidate && packageMatch.kind === 'exact') {
        if (approvedEvidenceMatches(candidate, packageMatch.pack)) bestExact = candidate;
        else rejected.identity += 1;
      } else if (exactIdentity && packageMatch.kind === 'exact' && (!bestVerificationCandidate || betterExact(candidate, bestVerificationCandidate.candidate))) {
        bestVerificationCandidate = {
          candidate,
          pack: packageMatch.pack,
          priceInconclusive,
          fulfillmentInconclusive
        };
      } else if ((semanticIdentity || provisionalIdentity) && packageMatch.kind === 'exact') {
        if (intelligenceCandidates.length < 12) {
          intelligenceCandidates.push(summarize(candidate, packageMatch.pack, {
            requiresProductPageVerification: true,
            identityStatus: provisionalIdentity ? 'provisional' : 'semantic'
          }));
        }
      }
      continue;
    }
    if (semanticIdentity || provisionalIdentity) {
      if (packageMatch.kind !== 'exact') { rejected.package += 1; continue; }
      if (approvedIntelligenceCandidate) {
        if (approvedEvidenceMatches(candidate, packageMatch.pack)) bestExact = candidate;
        else rejected.identity += 1;
      } else if (intelligenceCandidates.length < 12) {
        intelligenceCandidates.push(summarize(candidate, packageMatch.pack, {
          requiresProductPageVerification: provisionalIdentity,
          identityStatus: provisionalIdentity ? 'provisional' : 'semantic'
        }));
      }
      continue;
    }
    if (approvedIntelligenceCandidate) {
      if (packageMatch.kind === 'exact' && approvedEvidenceMatches(candidate, packageMatch.pack)) bestExact = candidate;
      else rejected.identity += 1;
      continue;
    }
    if (packageMatch.kind === 'exact') {
      if (betterExact(candidate, bestExact)) bestExact = candidate;
      continue;
    }
    if (!bestAlternative
      || packageMatch.distance < bestAlternative.distance
      || (packageMatch.distance === bestAlternative.distance && candidate.price < bestAlternative.candidate.price)
      || (packageMatch.distance === bestAlternative.distance && candidate.price === bestAlternative.candidate.price && candidate.index < bestAlternative.candidate.index)) {
      bestAlternative = {
        candidate,
        pack: packageMatch.pack,
        offeredCount: packageMatch.offeredCount,
        distance: packageMatch.distance
      };
    }
  }

  const sizeSubstitutionAuthorized = rawAction.allowSizeSubstitution === true;
  if (approvedIntelligenceCandidate && !bestExact) {
    return {
      completed: false,
      selectionDecisionMade: true,
      selectionKind: 'no_verified_candidate',
      intelligenceRevalidationFailed: true,
      reason: 'The model-selected Amazon result changed or no longer satisfies the approved product, package, budget, and delivery constraints.',
      scan: { rawScanned: Math.min(rawScanned, 96), distinctCards: cards.length, rejected, selectionDurationMs: elapsed() }
    };
  }
  if (!bestExact && bestVerificationCandidate) {
    const selected = summarize(bestVerificationCandidate.candidate, bestVerificationCandidate.pack);
    return {
      completed: true,
      selectionDecisionMade: true,
      selectionKind: 'exact_product_page_verification',
      requiresProductPageVerification: true,
      navigationRequested: Boolean(performClick),
      navigationUrl: performClick ? bestVerificationCandidate.candidate.href : '',
      selected,
      reason: 'A matching Amazon result needs one product-page check for its purchase price and delivery terms before it can be added to cart.',
      scan: { rawScanned: Math.min(rawScanned, 96), distinctCards: cards.length, rejected, selectionDurationMs: elapsed() }
    };
  }
  if (approvedIntelligenceCandidate?.requiresProductPageVerification === true && bestExact) {
    const selected = summarize(bestExact, packageMatchFor(bestExact).pack, {
      requiresProductPageVerification: true,
      identityStatus: String(approvedIntelligenceCandidate.identityStatus || 'provisional')
    });
    return {
      completed: true,
      selectionDecisionMade: true,
      selectionKind: 'model_assisted_product_page_verification',
      requiresProductPageVerification: true,
      navigationRequested: Boolean(performClick),
      navigationUrl: performClick ? bestExact.href : '',
      selected,
      reason: 'The observed Amazon result needs one product-page identity and offer check before it can be added to cart.',
      scan: { rawScanned: Math.min(rawScanned, 96), distinctCards: cards.length, rejected, selectionDurationMs: elapsed() }
    };
  }
  if (!bestExact && bestAlternative && !sizeSubstitutionAuthorized) {
    const proposed = summarize(bestAlternative.candidate, bestAlternative.pack);
    const requestedDescription = [
      `${requestedPack.total} ${requestedPack.unit}`,
      requestedCount == null ? '' : `${requestedCount} count`
    ].filter(Boolean).join(', ');
    const offeredDescription = [
      `${bestAlternative.pack.total} ${bestAlternative.pack.unit}`,
      bestAlternative.offeredCount == null ? '' : `${bestAlternative.offeredCount} count`
    ].filter(Boolean).join(', ');
    return {
      completed: false,
      selectionDecisionMade: true,
      selectionKind: 'size_alternative',
      requiresApproval: true,
      requestedPack,
      requestedCount,
      proposedCandidate: proposed,
      reason: `Closest verified size found: requested ${requestedDescription}; available ${offeredDescription} for $${bestAlternative.candidate.price.toFixed(2)}. Review before adding it to cart.`,
      scan: { rawScanned: Math.min(rawScanned, 96), distinctCards: cards.length, rejected, selectionDurationMs: elapsed() }
    };
  }
  if (!bestExact && !bestAlternative) {
    return {
      completed: false,
      selectionDecisionMade: true,
      selectionKind: 'no_verified_candidate',
      reason: 'Magic City could not find a verified match for that specific product within budget. Try again with a more general product query.',
      intelligenceCandidates,
      scan: { rawScanned: Math.min(rawScanned, 96), distinctCards: cards.length, rejected, selectionDurationMs: elapsed() }
    };
  }

  const selectionKind = approvedIntelligenceCandidate ? 'model_assisted' : bestExact ? 'exact' : 'size_alternative';
  const selectionDescription = selectionKind === 'model_assisted'
    ? 'model-assisted'
    : selectionKind === 'exact'
      ? 'exact'
      : 'closest-size';
  const selectedCard = bestExact || bestAlternative.candidate;
  let selectedPack = bestExact ? offeredPack(selectedCard.title) : bestAlternative.pack;
  if (selectedPack.status === 'unknown') selectedPack = offeredPack(selectedCard.identityEvidence || selectedCard.title);
  const selected = summarize(selectedCard, selectedPack);
  const directCart = Boolean(performClick && selectedCard.control);
  if (directCart) {
    selectedCard.control.scrollIntoView({ block: 'center', inline: 'center' });
    selectedCard.control.click();
    selected.cartActionStarted = true;
    globalThis.__magicCitySelectedCandidate = {
      key: `asin:${selectedCard.asin}`,
      asin: selectedCard.asin,
      url: selectedCard.href,
      pageUrl: String(location.href || ''),
      selectedAt: Date.now(),
      cartActionStarted: true
    };
  }
  const cartCount = Number(String(document.querySelector('#nav-cart-count')?.textContent || '').match(/\d+/)?.[0] || '') || null;
  return {
    completed: true,
    selectionDecisionMade: true,
    selectionKind,
    sizeSubstitution: selectionKind === 'size_alternative' ? {
      requested: requestedPack,
      requestedCount,
      selected: selectedPack,
      selectedCount: bestAlternative?.offeredCount ?? null,
      authorized: true
    } : null,
    navigationRequested: Boolean(performClick && !directCart),
    navigationUrl: performClick && !directCart ? selectedCard.href : '',
    searchResultSelected: directCart,
    directSearchResultCart: directCart,
    directCartControlAvailable: Boolean(selectedCard.control),
    label: directCart
      ? 'Add to cart'
      : selectionKind === 'exact'
        ? 'Exact candidate'
        : selectionKind === 'model_assisted'
          ? 'Model-assisted candidate'
          : 'Closest verified size',
    controlStrategy: directCart
      ? selectionKind === 'exact'
        ? 'amazon_search_card_exact_first'
        : selectionKind === 'model_assisted'
          ? 'amazon_search_card_model_assisted'
          : 'amazon_search_card_closest_size'
      : selectionKind === 'exact'
        ? 'amazon_search_card_exact_navigation'
        : selectionKind === 'model_assisted'
          ? 'amazon_search_card_model_assisted_navigation'
          : 'amazon_search_card_closest_size_navigation',
    selected,
    scan: { rawScanned: Math.min(rawScanned, 96), distinctCards: cards.length, rejected, selectionDurationMs: elapsed() },
    state: {
      url: location.href,
      title: clean(document.title, 180),
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
      browserStateReason: directCart
        ? `The ${selectionDescription} verified Amazon result card was added to cart.`
        : performClick
          ? `The ${selectionDescription} verified Amazon result card was selected for product-page verification.`
          : `The ${selectionDescription} verified Amazon result card was selected without clicking.`,
      milestoneSignals: {
        candidateSelected: directCart,
        cartVisible: false,
        checkoutOpen: false,
        addressConfirmed: false,
        cardConfirmed: false,
        deliveryConfirmed: false,
        checkoutProfileVerified: false,
        finalReviewReady: false,
        orderSubmitted: false
      },
      checkoutSummary: { stage: 'search_results', nextAction: directCart ? 'Opening cart' : performClick ? 'Opening product' : 'Selection only', cartItemCount: cartCount }
    }
  };
}
