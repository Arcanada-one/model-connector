// Local S3-compatible contract stub for the R2 storage integration arm.
//
// It is a stand-in for the wire contract only (path-style PUT/GET/DELETE with AWS
// Signature V4 verified against throw-away credentials the caller generated). It is
// NOT Cloudflare R2: nothing here says anything about R2 availability, quotas or
// account configuration. A request with a missing or wrong signature is refused 403,
// so the stub cannot turn an unsigned or mis-signed client green.
//
// Usage: STUB_ACCESS_KEY_ID=... STUB_SECRET_ACCESS_KEY=... node s3-contract-stub.mjs
// Prints one JSON line {"port":N} (kernel-chosen loopback port), then serves until SIGTERM.
import { createHash, createHmac } from 'node:crypto';
import { createServer } from 'node:http';

const ACCESS = process.env.STUB_ACCESS_KEY_ID;
const SECRET = process.env.STUB_SECRET_ACCESS_KEY;
if (!ACCESS || !SECRET) {
  console.error('STUB_ACCESS_KEY_ID and STUB_SECRET_ACCESS_KEY are required');
  process.exit(2);
}

const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
const hex = (data) => createHash('sha256').update(data).digest('hex');
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function canonicalQuery(params, skip) {
  return [...params.entries()]
    .filter(([k]) => k !== skip)
    .map(([k, v]) => [enc(k), enc(v)])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => k + '=' + v)
    .join('&');
}

function signature(req, url, scope, amzDate, signedHeaders, payloadHash, skipQuery) {
  const names = signedHeaders.split(';');
  const headers = names.map((n) => n + ':' + String(req.headers[n] ?? '').trim().replace(/\s+/g, ' ') + '\n').join('');
  const canonicalPath = url.pathname.split('/').map((seg) => enc(decodeURIComponent(seg))).join('/');
  const canonical = [req.method, canonicalPath, canonicalQuery(url.searchParams, skipQuery), headers, signedHeaders, payloadHash].join('\n');
  const [date, region, service] = scope.split('/');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac('AWS4' + SECRET, date), region), service), 'aws4_request');
  return createHmac('sha256', key).update(toSign).digest('hex');
}

function verified(req, url) {
  const query = url.searchParams;
  if (query.get('X-Amz-Algorithm') === 'AWS4-HMAC-SHA256') {
    const [access, ...scope] = (query.get('X-Amz-Credential') ?? '').split('/');
    if (access !== ACCESS) return false;
    const issued = Date.parse((query.get('X-Amz-Date') ?? '').replace(/(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z/, '$1-$2-$3T$4:$5:$6Z'));
    const ttl = Number(query.get('X-Amz-Expires'));
    if (!Number.isFinite(issued) || !(ttl > 0) || Date.now() > issued + ttl * 1000) return false;
    const want = signature(req, url, scope.join('/'), query.get('X-Amz-Date'), query.get('X-Amz-SignedHeaders'), 'UNSIGNED-PAYLOAD', 'X-Amz-Signature');
    return want === query.get('X-Amz-Signature');
  }
  const auth = req.headers.authorization ?? '';
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
  if (!m || m[1] !== ACCESS) return false;
  const want = signature(req, url, m[2], req.headers['x-amz-date'], m[3], req.headers['x-amz-content-sha256'], null);
  return want === m[4];
}

const objects = new Map();
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://stub.invalid');
    if (!verified(req, url)) {
      res.writeHead(403, { 'content-type': 'application/xml' }).end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
      return;
    }
    const key = decodeURIComponent(url.pathname);
    if (req.method === 'PUT') {
      const body = Buffer.concat(chunks);
      const declared = req.headers['x-amz-content-sha256'];
      if (/^[0-9a-f]{64}$/.test(declared ?? '') && declared !== hex(body)) {
        res.writeHead(400).end('<Error><Code>XAmzContentSHA256Mismatch</Code></Error>');
        return;
      }
      objects.set(key, { body, type: req.headers['content-type'] ?? 'application/octet-stream' });
      res.writeHead(200, { etag: '"' + createHash('md5').update(body).digest('hex') + '"' }).end();
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      const hit = objects.get(key);
      if (!hit) return void res.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>');
      res.writeHead(200, { 'content-type': hit.type, 'content-length': hit.body.length });
      res.end(req.method === 'HEAD' ? undefined : hit.body);
    } else if (req.method === 'DELETE') {
      objects.delete(key);
      res.writeHead(204).end();
    } else {
      res.writeHead(405).end();
    }
  });
});
server.listen(0, '127.0.0.1', () => {
  console.log(JSON.stringify({ port: server.address().port }));
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
