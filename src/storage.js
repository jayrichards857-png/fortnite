'use strict';
// Durable storage for uploaded images (product photos, avatars, logos, banners).
//   fs    local disk under PAIRPLUG_UPLOADS (development, a single VM with a persistent disk). The default off Vercel.
//   s3    any S3-compatible object store (AWS S3, Cloudflare R2, Backblaze B2, Supabase Storage, MinIO ...), reached with PRIVATE server-side
//         credentials from environment variables. The bucket stays private: files are served through the app (/uploads/<file>), never directly.
//   none  Vercel without object storage configured: nothing can be stored durably, so saving is refused (never silently written to /tmp).
// The database keeps storing plain file names, so nothing else in the application changes when the driver does.
// SigV4 is implemented here (node:crypto only) so no SDK dependency is needed; it is checked against the published AWS test vectors.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');

const sha256 = (d) => crypto.createHash('sha256').update(d).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** AWS Signature Version 4 for S3. `headers` are signed as given (plus host); returns the headers to send. */
function sign({ method, url, headers = {}, body = '', region, accessKeyId, secretAccessKey, service = 's3', date = new Date() }) {
  const u = new URL(url), amz = date.toISOString().replace(/[:-]|\.\d{3}/g, ''), day = amz.slice(0, 8);
  const payloadHash = sha256(body);
  const h = { host: u.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amz };
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  const names = Object.keys(h).sort();
  const canonicalUri = u.pathname.split('/').map((seg) => enc(decodeURIComponent(seg))).join('/') || '/';
  const canonicalQuery = [...u.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [method, canonicalUri, canonicalQuery, names.map((n) => `${n}:${h[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amz, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  return { ...h, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope},SignedHeaders=${names.join(';')},Signature=${signature}` };
}

const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const FILE = /^[a-f0-9]{32}\.(jpg|png|webp)$/;
const mimeOf = (file) => MIME[String(file).split('.').pop()];

function s3Driver(c) {
  const urlFor = (file) => `${c.endpoint.replace(/\/+$/, '')}/${encodeURIComponent(c.bucket)}/${(c.prefix || '').split('/').filter(Boolean).map(encodeURIComponent).join('/')}${c.prefix ? '/' : ''}${file}`;
  const call = async (method, file, body = '', headers = {}) => {
    const url = urlFor(file);
    const res = await fetch(url, { method, headers: sign({ method, url, headers, body, region: c.region, accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey }), body: body.length ? body : undefined, signal: AbortSignal.timeout(c.timeoutMs || 8000) });
    return res;
  };
  return {
    kind: 's3',
    async put(file, buf, mime) {
      const res = await call('PUT', file, buf, { 'content-type': mime, 'cache-control': 'public, max-age=31536000, immutable' });
      if (!res.ok) throw new Error(`object storage rejected the upload (HTTP ${res.status})`);
    },
    async get(file) {
      const res = await call('GET', file);
      if (res.status === 404 || res.status === 403 && false) return null;
      if (!res.ok) throw new Error(`object storage read failed (HTTP ${res.status})`);
      return Buffer.from(await res.arrayBuffer());
    },
    async del(file) { const res = await call('DELETE', file); if (!res.ok && res.status !== 404) throw new Error(`object storage delete failed (HTTP ${res.status})`); },
  };
}

function fsDriver(dir) {
  return {
    kind: 'fs', dir,
    async put(file, buf) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, file), buf); },
    async get(file) { try { return fs.readFileSync(path.join(dir, file)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } },
    async del(file) { fs.rmSync(path.join(dir, file), { force: true }); },
  };
}

const noneDriver = { kind: 'none',
  async put() { throw Object.assign(new Error('no durable storage configured'), { unconfigured: true }); },
  async get() { return null; }, async del() {} };

function create(cfg = config) {
  if (cfg.storage.s3) return s3Driver(cfg.storage.s3);
  return cfg.onVercel ? noneDriver : fsDriver(cfg.uploadDir);
}
let current = null;
const driver = () => current || (current = create());
module.exports = { sign, create, driver, setDriver: (d) => { current = d; }, FILE, mimeOf, MIME };
