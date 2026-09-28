import dns from 'node:dns';
import http from 'node:http';
import net from 'node:net';

const BLOCKED_RESPONSE_HEADERS = {
  'content-type': 'text/plain; charset=utf-8',
  'cache-control': 'no-store',
  'x-magic-city-network-block': 'private_or_non_public_destination'
};

function stripIpv6Brackets(value = '') {
  const text = String(value || '').trim();
  return text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
}

function ipv4Number(address = '') {
  const parts = String(address || '').split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((value, part) => (value << 8n) | BigInt(Number(part)), 0n);
}

function ipv4InRange(value, base, prefix) {
  const bits = BigInt(32 - prefix);
  return (value >> bits) === (base >> bits);
}

function isPublicIpv4(address = '') {
  const value = ipv4Number(address);
  if (value == null) return false;
  const blocked = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4]
  ];
  return !blocked.some(([base, prefix]) => ipv4InRange(value, ipv4Number(base), prefix));
}

function parseIpv6(address = '') {
  let text = stripIpv6Brackets(address).split('%')[0].toLowerCase();
  if (!text || net.isIP(text) !== 6) return null;
  const ipv4Match = text.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Match) {
    const ipv4 = ipv4Number(ipv4Match[1]);
    if (ipv4 == null) return null;
    text = text.slice(0, -ipv4Match[1].length) + `${Number((ipv4 >> 16n) & 0xffffn).toString(16)}:${Number(ipv4 & 0xffffn).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = halves.length === 2 ? [...left, ...Array(missing).fill('0'), ...right] : left;
  if (groups.length !== 8 || groups.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return groups.reduce((value, part) => (value << 16n) | BigInt(parseInt(part, 16)), 0n);
}

function ipv6InRange(value, base, prefix) {
  const bits = BigInt(128 - prefix);
  return (value >> bits) === (base >> bits);
}

function isPublicIpv6(address = '') {
  const value = parseIpv6(address);
  if (value == null) return false;
  const mappedBase = parseIpv6('::ffff:0:0');
  if (ipv6InRange(value, mappedBase, 96)) {
    const ipv4 = Number(value & 0xffffffffn);
    return isPublicIpv4(`${(ipv4 >>> 24) & 255}.${(ipv4 >>> 16) & 255}.${(ipv4 >>> 8) & 255}.${ipv4 & 255}`);
  }
  const globalBase = parseIpv6('2000::');
  if (!ipv6InRange(value, globalBase, 3)) return false;
  const protocolAssignmentsBase = parseIpv6('2001::');
  const documentationBase = parseIpv6('2001:db8::');
  const benchmarkBase = parseIpv6('2001:2::');
  const orchidBase = parseIpv6('2001:10::');
  const transitionBase = parseIpv6('2002::');
  const documentationV2Base = parseIpv6('3fff::');
  return !ipv6InRange(value, protocolAssignmentsBase, 23)
    && !ipv6InRange(value, documentationBase, 32)
    && !ipv6InRange(value, benchmarkBase, 48)
    && !ipv6InRange(value, orchidBase, 28)
    && !ipv6InRange(value, transitionBase, 16)
    && !ipv6InRange(value, documentationV2Base, 20);
}

export function isPublicNetworkAddress(address = '') {
  const normalized = stripIpv6Brackets(address).split('%')[0];
  const family = net.isIP(normalized);
  if (family === 4) return isPublicIpv4(normalized);
  if (family === 6) return isPublicIpv6(normalized);
  return false;
}

async function resolvePublicEndpoint(hostname, lookup = dns.promises.lookup) {
  const normalizedHost = stripIpv6Brackets(hostname).replace(/\.$/, '').toLowerCase();
  if (!normalizedHost) throw new Error('hosted_browser_destination_invalid');
  const literalFamily = net.isIP(normalizedHost);
  const answers = literalFamily
    ? [{ address: normalizedHost, family: literalFamily }]
    : await lookup(normalizedHost, { all: true, verbatim: true });
  if (!Array.isArray(answers) || !answers.length) throw new Error('hosted_browser_destination_unresolved');
  const normalized = answers.map((answer) => ({
    address: stripIpv6Brackets(answer.address),
    family: Number(answer.family) || net.isIP(answer.address)
  }));
  if (normalized.some((answer) => !isPublicNetworkAddress(answer.address))) {
    throw new Error('hosted_browser_private_network_blocked');
  }
  normalized.sort((a, b) => a.family - b.family);
  return normalized[0];
}

function proxyTarget(raw = '') {
  let parsed;
  try {
    parsed = new URL(String(raw || ''));
  } catch {
    throw new Error('hosted_browser_destination_invalid');
  }
  if (parsed.protocol !== 'http:' || parsed.username || parsed.password) {
    throw new Error('hosted_browser_destination_invalid');
  }
  return parsed;
}

function connectTarget(raw = '') {
  let parsed;
  try {
    parsed = new URL(`http://${String(raw || '')}`);
  } catch {
    throw new Error('hosted_browser_destination_invalid');
  }
  if (!parsed.hostname || parsed.username || parsed.password) throw new Error('hosted_browser_destination_invalid');
  const port = Number(parsed.port || 443);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('hosted_browser_destination_invalid');
  return { hostname: parsed.hostname, port };
}

function publicRequestHeaders(headers = {}, host = '') {
  const clean = { ...headers, host };
  for (const name of ['proxy-authorization', 'proxy-connection', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade']) {
    delete clean[name];
  }
  return clean;
}

function rejectHttpResponse(res, error) {
  if (res.headersSent) return res.destroy();
  res.writeHead(403, BLOCKED_RESPONSE_HEADERS);
  res.end(error?.message || 'hosted_browser_destination_blocked');
}

function rejectTunnel(socket, error) {
  if (!socket.destroyed) {
    socket.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n${error?.message || 'hosted_browser_destination_blocked'}`);
  }
}

export async function startHostedBrowserPublicNetworkProxy({
  lookup = dns.promises.lookup,
  connect = net.connect
} = {}) {
  let closing = false;
  const tunnelSockets = new Set();
  const server = http.createServer(async (req, res) => {
    try {
      const target = proxyTarget(req.url);
      const endpoint = await resolvePublicEndpoint(target.hostname, lookup);
      if (closing) throw new Error('hosted_browser_proxy_closing');
      const agent = new http.Agent({ keepAlive: false });
      agent.createConnection = (options, callback) => connect(options, callback);
      const upstream = http.request({
        host: endpoint.address,
        family: endpoint.family,
        port: Number(target.port || 80),
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers: publicRequestHeaders(req.headers, target.host),
        agent
      }, (upstreamResponse) => {
        res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
        upstreamResponse.pipe(res);
      });
      upstream.setTimeout(30_000, () => upstream.destroy(new Error('hosted_browser_upstream_timeout')));
      upstream.on('error', (error) => rejectHttpResponse(res, error));
      req.pipe(upstream);
    } catch (error) {
      rejectHttpResponse(res, error);
    }
  });
  server.on('connect', async (req, clientSocket, head) => {
    tunnelSockets.add(clientSocket);
    clientSocket.once('close', () => tunnelSockets.delete(clientSocket));
    try {
      const target = connectTarget(req.url);
      const endpoint = await resolvePublicEndpoint(target.hostname, lookup);
      if (closing || clientSocket.destroyed) throw new Error('hosted_browser_proxy_closing');
      const upstream = connect({ host: endpoint.address, family: endpoint.family, port: target.port });
      tunnelSockets.add(upstream);
      upstream.once('close', () => tunnelSockets.delete(upstream));
      let connected = false;
      upstream.setTimeout(30_000, () => upstream.destroy(new Error('hosted_browser_upstream_timeout')));
      upstream.once('connect', () => {
        connected = true;
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) upstream.write(head);
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
      });
      upstream.once('error', (error) => {
        if (!connected) rejectTunnel(clientSocket, error);
        else clientSocket.destroy(error);
      });
      clientSocket.once('error', () => upstream.destroy());
    } catch (error) {
      rejectTunnel(clientSocket, error);
    }
  });
  server.on('clientError', (_error, socket) => rejectTunnel(socket, new Error('hosted_browser_proxy_request_invalid')));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      closing = true;
      for (const socket of tunnelSockets) socket.destroy();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    }
  };
}
