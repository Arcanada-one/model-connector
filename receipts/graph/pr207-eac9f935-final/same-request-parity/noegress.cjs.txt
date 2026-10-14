const fs = require('node:fs');
const net = require('node:net');
const tls = require('node:tls');
const log = process.env.MC_EGRESS_LOG;
const isLoopback = (h) => ['127.0.0.1', '::1', 'localhost'].includes(String(h || '').replace(/^\[|\]$/g, ''));
function note(proto, host, port) { if (log) fs.appendFileSync(log, `${proto}://${host || '?'}:${port || (proto === 'https' ? 443 : 80)}\n`, { mode: 0o600 }); }
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const u = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  if (!isLoopback(u.hostname)) { note(u.protocol.slice(0, -1), u.hostname, u.port); throw new Error('blocked by candidate egress guard'); }
  return originalFetch(input, init);
};
const origConnect = net.connect.bind(net);
net.connect = function(...args) {
  let o = args[0];
  if (typeof o === 'number') o = args[1];
  const host = typeof o === 'object' ? (o.host || o.hostname) : 'localhost';
  const port = typeof args[0] === 'number' ? args[0] : (o && o.port);
  if (isLoopback(host)) return origConnect(...args);
  note('http', host, port);
  const socket = new net.Socket();
  process.nextTick(() => socket.destroy(Object.assign(new Error('blocked by candidate egress guard'), { code: 'ECONNREFUSED' })));
  return socket;
};
const origTlsConnect = tls.connect.bind(tls);
tls.connect = function(...args) {
  let o = args[0];
  const host = typeof o === 'object' ? (o.host || o.hostname || o.servername) : args[1];
  const port = typeof o === 'object' ? o.port : args[0];
  if (isLoopback(host)) return origTlsConnect(...args);
  note('https', host, port);
  const socket = new net.Socket();
  process.nextTick(() => socket.destroy(Object.assign(new Error('blocked by candidate egress guard'), { code: 'ECONNREFUSED' })));
  return socket;
};
