import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import http from 'node:http';
import net from 'node:net';
import { chromium } from 'playwright';
import {
  isPublicNetworkAddress,
  startHostedBrowserPublicNetworkProxy
} from '../src/hostedBrowserNetwork.js';

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve(server.address()));
  });
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

function requestThroughProxy(proxyUrl, targetUrl) {
  const proxy = new URL(proxyUrl);
  const target = new URL(targetUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.hostname,
      port: proxy.port,
      method: 'GET',
      path: target.href,
      headers: { host: target.host }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.once('error', reject);
    req.end();
  });
}

function connectThroughProxy(proxyUrl, target) {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port) });
    let response = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    socket.on('data', (chunk) => {
      response += chunk;
      if (response.includes('\r\n\r\n')) {
        socket.destroy();
        resolve(response);
      }
    });
    socket.once('error', reject);
  });
}

function openTunnelThroughProxy(proxyUrl, target) {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port) });
    let response = '';
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    socket.on('data', (chunk) => {
      response += chunk;
      if (response.includes('\r\n\r\n')) resolve({ socket, response });
    });
    socket.once('error', reject);
  });
}

for (const address of [
  '127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1',
  '0.0.0.0', '224.0.0.1', '::', '::1', '::ffff:127.0.0.1', '2001:db8::1',
  '2002:0a00:0001::1', 'fc00::1', 'fe80::1', 'ff00::1'
]) {
  assert.equal(isPublicNetworkAddress(address), false, `${address} must not be public`);
}
assert.equal(isPublicNetworkAddress('8.8.8.8'), true);
assert.equal(isPublicNetworkAddress('2606:4700:4700::1111'), true);

for (const [first, last] of [
  ['0.0.0.0', '0.255.255.255'],
  ['10.0.0.0', '10.255.255.255'],
  ['100.64.0.0', '100.127.255.255'],
  ['127.0.0.0', '127.255.255.255'],
  ['169.254.0.0', '169.254.255.255'],
  ['172.16.0.0', '172.31.255.255'],
  ['192.0.0.0', '192.0.0.255'],
  ['192.0.2.0', '192.0.2.255'],
  ['192.88.99.0', '192.88.99.255'],
  ['192.168.0.0', '192.168.255.255'],
  ['198.18.0.0', '198.19.255.255'],
  ['198.51.100.0', '198.51.100.255'],
  ['203.0.113.0', '203.0.113.255'],
  ['224.0.0.0', '239.255.255.255'],
  ['240.0.0.0', '255.255.255.255']
]) {
  assert.equal(isPublicNetworkAddress(first), false, `${first} range start must be blocked`);
  assert.equal(isPublicNetworkAddress(last), false, `${last} range end must be blocked`);
  assert.equal(isPublicNetworkAddress(`::ffff:${first}`), false, `mapped ${first} must be blocked`);
  assert.equal(isPublicNetworkAddress(`::ffff:${last}`), false, `mapped ${last} must be blocked`);
}

for (const address of [
  '1.0.0.0', '9.255.255.255', '11.0.0.0', '100.63.255.255', '100.128.0.0',
  '126.255.255.255', '128.0.0.0', '169.253.255.255', '169.255.0.0', '172.15.255.255',
  '172.32.0.0', '192.0.1.0', '192.0.3.0', '192.88.98.255', '192.88.100.0',
  '192.167.255.255', '192.169.0.0', '198.17.255.255', '198.20.0.0', '198.51.99.255',
  '198.51.101.0', '203.0.112.255', '203.0.114.0', '223.255.255.255'
]) {
  assert.equal(isPublicNetworkAddress(address), true, `${address} adjacent public address must remain allowed`);
}

const hits = [];
const fixture = http.createServer((req, res) => {
  hits.push(req.url);
  if (req.url === '/redirect') {
    res.writeHead(302, { location: `http://127.0.0.1:${fixture.address().port}/private?redirected=1` });
    res.end();
    return;
  }
  res.setHeader('content-type', 'text/html');
  res.end(`<img src="http://127.0.0.1:${fixture.address().port}/private-image"><iframe src="http://127.0.0.1:${fixture.address().port}/private-frame"></iframe>`);
});
const fixtureAddress = await listen(fixture);

const directProxy = await startHostedBrowserPublicNetworkProxy();
try {
  for (const url of [
    `http://127.0.0.1:${fixtureAddress.port}/private`,
    `http://localhost:${fixtureAddress.port}/private`,
    `http://2130706433:${fixtureAddress.port}/private`,
    'http://240.0.0.1/private',
    'http://255.255.255.255/private',
    'http://[::ffff:240.0.0.1]/private'
  ]) {
    const response = await requestThroughProxy(directProxy.url, url);
    assert.equal(response.status, 403, url);
    assert.equal(response.headers['x-magic-city-network-block'], 'private_or_non_public_destination');
  }
  const tunnel = await connectThroughProxy(directProxy.url, `127.0.0.1:${fixtureAddress.port}`);
  assert.match(tunnel, /^HTTP\/1\.1 403/);
  assert.deepEqual(hits, [], 'direct and CONNECT attempts must be rejected before private contact');
} finally {
  await directProxy.close();
}

const mappedProxy = await startHostedBrowserPublicNetworkProxy({
  lookup: async (hostname) => {
    return hostname === 'public-fixture.test'
      ? [{ address: '8.8.8.8', family: 4 }]
      : [{ address: '127.0.0.1', family: 4 }];
  },
  connect: (options, callback) => {
    return net.connect({ ...options, host: '127.0.0.1', port: fixtureAddress.port }, () => {
      callback?.();
    });
  }
});
try {
  const publicPage = await requestThroughProxy(mappedProxy.url, `http://public-fixture.test:${fixtureAddress.port}/public`);
  assert.equal(publicPage.status, 200);
  assert.deepEqual(hits, ['/public']);

  const redirect = await requestThroughProxy(mappedProxy.url, `http://public-fixture.test:${fixtureAddress.port}/redirect`);
  assert.equal(redirect.status, 302);
  const redirected = await requestThroughProxy(mappedProxy.url, redirect.headers.location);
  assert.equal(redirected.status, 403);

  for (const privatePath of ['/private-image', '/private-frame']) {
    const subresource = await requestThroughProxy(mappedProxy.url, `http://127.0.0.1:${fixtureAddress.port}${privatePath}`);
    assert.equal(subresource.status, 403);
  }
  assert.deepEqual(hits, ['/public', '/redirect'], 'redirects, frames, and subresources must be rejected before private contact');
} finally {
  await mappedProxy.close();
}

const tunnelPeers = new Set();
const tunnelTarget = net.createServer((socket) => {
  tunnelPeers.add(socket);
  socket.once('close', () => tunnelPeers.delete(socket));
});
const tunnelAddress = await listen(tunnelTarget);
const cleanupProxy = await startHostedBrowserPublicNetworkProxy({
  lookup: async () => [{ address: '8.8.8.8', family: 4 }],
  connect: (options, callback) => net.connect({
    ...options,
    host: '127.0.0.1',
    port: tunnelAddress.port
  }, callback)
});
const openTunnel = await openTunnelThroughProxy(cleanupProxy.url, 'public-tunnel.test:443');
assert.match(openTunnel.response, /^HTTP\/1\.1 200/);
assert.equal(tunnelPeers.size, 1);
const tunnelClientClosed = new Promise((resolve) => openTunnel.socket.once('close', resolve));
const tunnelPeerClosed = new Promise((resolve) => [...tunnelPeers][0].once('close', resolve));
await cleanupProxy.close();
await Promise.all([tunnelClientClosed, tunnelPeerClosed]);
assert.equal(tunnelPeers.size, 0, 'proxy shutdown must close active CONNECT tunnel sockets');
await close(tunnelTarget);

for (const name of [
  'MAGIC_CITY_BROWSER_CDP_URL',
  'MAGIC_CITY_CHROME_CDP_URL',
  'MAGIC_CITY_BROWSER_USER_DATA_DIR'
]) delete process.env[name];
const { launchHostedBrowser, runAssistedBrowserWorkerExecution } = await import('../src/browserExecution.js');

const udpProbe = dgram.createSocket('udp4');
let udpPackets = 0;
udpProbe.on('message', () => { udpPackets += 1; });
await new Promise((resolve, reject) => {
  udpProbe.once('error', reject);
  udpProbe.bind(0, '127.0.0.1', resolve);
});
const hostedRuntime = await launchHostedBrowser(chromium, { headless: true });
try {
  const page = await hostedRuntime.browser.newPage();
  await page.evaluate(async (port) => {
    const peer = new RTCPeerConnection({
      iceServers: [{ urls: `stun:127.0.0.1:${port}` }],
      iceCandidatePoolSize: 1
    });
    peer.createDataChannel('private-network-probe');
    await peer.setLocalDescription(await peer.createOffer());
    await new Promise((resolve) => setTimeout(resolve, 800));
    peer.close();
  }, udpProbe.address().port);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(udpPackets, 0, 'hosted Chromium must not send non-proxied WebRTC UDP');
} finally {
  await hostedRuntime.browser.close();
  await hostedRuntime.networkProxy.close();
  udpProbe.close();
}

const browserHitCount = hits.length;
let browserStoppedAtObservation = false;
try {
  await runAssistedBrowserWorkerExecution({
    id: 'hosted-network-browser-fixture',
    selections: {
      targetUrl: `http://127.0.0.1:${fixtureAddress.port}/browser-private`,
      goal: 'Read the harmless local fixture',
      finalApprovalPolicy: 'pause_before_final_approval'
    }
  }, {
    onProgress: async (progress) => {
      if (progress.state === 'browser_open') {
        browserStoppedAtObservation = true;
        throw new Error('hosted_network_fixture_observed');
      }
    }
  });
} catch (error) {
  assert.equal(error.message, 'hosted_network_fixture_observed');
}
assert.equal(browserStoppedAtObservation, true, 'hosted Chromium must reach the proxy-blocked observation page');
assert.equal(hits.length, browserHitCount, 'hosted Chromium must not bypass the proxy for loopback');

await close(fixture);

console.log('hosted browser public-network proxy regressions passed');
