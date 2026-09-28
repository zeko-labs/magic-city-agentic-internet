import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(new URL('..', import.meta.url).pathname);

function extractFunction(source, name, nextName = '') {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `${name} missing`);
  if (nextName) {
    const end = source.indexOf(`function ${nextName}`, start);
    assert.ok(end > start, `${nextName} missing after ${name}`);
    return source.slice(start, end).trim();
  }
  const tail = source.slice(start + `function ${name}`.length);
  const next = tail.search(/\n\s*function\s+[A-Za-z0-9_$]+\s*\(/);
  assert.ok(next >= 0, `function following ${name} missing`);
  return source.slice(start, start + `function ${name}`.length + next).trim();
}

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT4sAAAAASUVORK5CYII=', 'base64');
const server = http.createServer((req, res) => {
  if (req.url === '/artifacts/preview.png') {
    res.setHeader('content-type', 'image/png');
    res.end(pixel);
    return;
  }
  res.setHeader('content-type', 'text/html');
  res.end('<div id="fixture"></div>');
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext();
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === baseUrl) return route.continue();
    return route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  for (const file of ['public/index.html', 'public/app.js']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const safeFunction = extractFunction(source, 'safeExecutionPreviewUrl');
    const linkFunction = extractFunction(source, 'renderExecutionPreviewLink');
    const renderFunction = extractFunction(source, 'renderExecutionLiveView', 'renderExecutionVerification');
    for (const fixture of [
      {
        name: 'attribute-injection',
        url: '/artifacts/missing.png" onerror="window.__previewExecuted=1" data-fixture="',
        expectPreview: true
      },
      { name: 'javascript-scheme', url: 'javascript:window.__previewExecuted=2', expectPreview: false },
      { name: 'credentialed-https', url: 'https://user:secret@example.test/preview.png', expectPreview: false },
      { name: 'non-artifact-relative', url: '/uploads/preview.png', expectPreview: false },
      { name: 'valid-artifact', url: '/artifacts/preview.png', expectPreview: true },
      { name: 'valid-https', url: 'https://images.example.test/preview.png', expectPreview: true }
    ]) {
      await page.goto(baseUrl);
      const observed = await page.evaluate(({ safeFunction, linkFunction, renderFunction, previewUrl }) => {
        const escapeExecutionValue = (value) => String(value || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
        const inferExecutionPhase = () => ({ cls: 'working', label: 'Working' });
        const compactExecutionTraceDetail = () => '';
        const compactExecutionCompletionNote = () => '';
        const compactExecutionSentence = (value) => value;
        const renderCheckoutSummary = () => '';
        const sessionHasBrowserOrderSubmitted = () => false;
        const safeExecutionPreviewUrl = eval(`(${safeFunction})`);
        const renderExecutionPreviewLink = eval(`(${linkFunction})`);
        const renderExecutionLiveView = eval(`(${renderFunction})`);
        window.__previewExecuted = 0;
        document.querySelector('#fixture').innerHTML = renderExecutionLiveView({
          id: 'preview-security-fixture',
          status: 'executing',
          executionTrace: [{
            label: 'Fixture',
            state: 'working',
            browser: {
              url: 'https://example.test/',
              title: 'Synthetic preview',
              previewArtifact: { url: previewUrl }
            }
          }]
        });
        const image = document.querySelector('.execution-live-media img');
        return {
          executions: window.__previewExecuted,
          imagePresent: Boolean(image),
          imageOnError: image?.getAttribute('onerror') || '',
          imageSource: image?.getAttribute('src') || '',
          link: document.querySelector('.execution-live-media')?.getAttribute('href') || ''
        };
      }, { safeFunction, linkFunction, renderFunction, previewUrl: fixture.url });
      await page.waitForTimeout(100);
      const executions = await page.evaluate(() => window.__previewExecuted || 0);
      assert.equal(observed.imagePresent, fixture.expectPreview, `${file}:${fixture.name}`);
      assert.equal(observed.imageOnError, '', `${file}:${fixture.name}: handler`);
      assert.equal(observed.executions, 0, `${file}:${fixture.name}: immediate execution`);
      assert.equal(executions, 0, `${file}:${fixture.name}: delayed execution`);
      if (fixture.name === 'attribute-injection') {
        assert.doesNotMatch(observed.imageSource, /\sonerror=/i);
        assert.doesNotMatch(observed.link, /\sonerror=/i);
      }
    }
  }
  console.log('execution preview URL security regressions passed');
} finally {
  await browser.close();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(() => resolve()));
}
