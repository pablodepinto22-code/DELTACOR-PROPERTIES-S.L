import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

const DEFAULT_PUBLIC_ORIGIN = 'https://pablodepinto22-code.github.io/DELTACOR-PROPERTIES-S.L/';
const INDEX_PATH = path.join(__dirname, 'index.html');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Explicit allowlist of public static files permitted from the repository root.
// Using an allowlist prevents URL-encoding or path-normalization bypasses against
// server.js, package.json, bun.lock, firestore.rules, .env, .git, etc.
const PUBLIC_ROOT_FILES = new Set([
  'logo-deltacor.png',
  'logo-deltacor-icon.png',
  'og-deltacor.jpg',
  'og-deltacor-square.jpg',
  'logo-invercor.png',
  'og-invercor.jpg',
  'og-invercor.png',
  'og-invercor-square.jpg',
]);

const ALLOWED_HOSTS = new Set(
  String(process.env.ALLOWED_HOSTS || '')
    .split(',')
    .map(h => h.trim().toLowerCase())
    .filter(Boolean)
);

const VALID_HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/i;
const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/i;

// Lightweight in-memory rate limiter (no external dependency required)
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_REQ = 240;
const rateBuckets = new Map();
const rateCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets) {
    if (now > bucket.resetAt) rateBuckets.delete(ip);
  }
}, RATE_WINDOW_MS);
rateCleanupTimer.unref?.();

function getValidOrigin(req) {
  const rawProto = String(req.get('x-forwarded-proto') || req.protocol || 'https')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const proto = rawProto === 'http' || rawProto === 'https' ? rawProto : 'https';

  const rawHost = String(req.get('host') || '').trim().toLowerCase();
  const hostValid = rawHost && VALID_HOST_RE.test(rawHost);
  const hostAllowed = !ALLOWED_HOSTS.size || ALLOWED_HOSTS.has(rawHost);

  if (hostValid && hostAllowed && !LOCAL_HOST_RE.test(rawHost)) {
    return `${proto}://${rawHost}`;
  }

  const rawEnvUrl = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (rawEnvUrl) {
    try {
      const parsed = new URL(rawEnvUrl);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.origin + parsed.pathname.replace(/\/+$/, '');
      }
    } catch {
      // Ignore malformed APP_URL
    }
  }
  return '';
}

function buildCspHeader(isHttps) {
  const directives = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://www.gstatic.com https://apis.google.com https://www.googletagmanager.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com https://firestore.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.google-analytics.com https://region1.google-analytics.com https://api.web3forms.com https://script.google.com https://script.googleusercontent.com",
    "frame-src 'self' https://invencor-a1477.firebaseapp.com https://accounts.google.com https://www.openstreetmap.org https://www.google.com https://maps.google.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ];
  if (isHttps) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}

// 1. Method restriction & rate limiting
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).type('text/plain').send('Method Not Allowed');
  }

  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (bucket.count > RATE_MAX_REQ) {
    res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
    return res.status(429).type('text/plain').send('Too Many Requests');
  }
  next();
});

// 2. Security headers on all responses
app.use((req, res, next) => {
  const rawProto = String(req.get('x-forwarded-proto') || req.protocol || 'http')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const isHttps = req.secure || rawProto === 'https';

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (isHttps) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// 3. Strict URL decoding & traversal guard
app.use((req, res, next) => {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(req.path);
  } catch {
    return res.status(400).type('text/plain').send('Bad Request');
  }

  if (
    decodedPath.includes('\0') ||
    decodedPath.includes('\\') ||
    decodedPath.includes('..') ||
    /(^|\/)\./.test(decodedPath)
  ) {
    return res.status(404).type('text/plain').send('Not Found');
  }

  req.decodedPath = path.posix.normalize(decodedPath);
  next();
});

// 4. Static assets under /public
app.use(
  express.static(PUBLIC_DIR, {
    dotfiles: 'ignore',
    index: false,
    fallthrough: true,
    setHeaders: (res, filePath) => {
      if (/\.(png|jpe?g|webp|ico|svg)$/i.test(filePath)) {
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Cache-Control', 'public, max-age=86400');
      }
    },
  })
);

// 5. Explicit allowlisted root public images (OG images and logos)
app.get('/:rootAsset', (req, res, next) => {
  const name = req.params.rootAsset;
  if (!PUBLIC_ROOT_FILES.has(name)) return next();

  const filePath = path.join(__dirname, name);
  if (!fs.existsSync(filePath)) return res.status(404).type('text/plain').send('Not Found');

  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  return res.sendFile(filePath);
});

// Cached index.html loader (avoids synchronous disk reads on every request)
let cachedHtml = '';
let cachedMtimeMs = 0;
let lastStatCheck = 0;

function getIndexHtml() {
  const now = Date.now();
  if (!cachedHtml || now - lastStatCheck > 2000) {
    lastStatCheck = now;
    const stat = fs.statSync(INDEX_PATH);
    if (!cachedHtml || stat.mtimeMs !== cachedMtimeMs) {
      cachedHtml = fs.readFileSync(INDEX_PATH, 'utf8');
      cachedMtimeMs = stat.mtimeMs;
    }
  }
  return cachedHtml;
}

const sendIndexWithDynamicOg = (req, res) => {
  const decoded = req.decodedPath || '/';
  // Return 404 for unknown asset-like paths instead of serving index.html
  if (decoded !== '/' && decoded !== '/index.html' && /\.[a-z0-9]{1,8}$/i.test(decoded)) {
    return res.status(404).type('text/plain').send('Not Found');
  }

  try {
    let html = getIndexHtml();
    const activeOrigin = getValidOrigin(req);
    if (activeOrigin) {
      const headEnd = html.indexOf('</head>');
      if (headEnd !== -1) {
        const head = html.slice(0, headEnd).split(DEFAULT_PUBLIC_ORIGIN).join(`${activeOrigin}/`);
        html = head + html.slice(headEnd);
      }
    }
    const rawProto = String(req.get('x-forwarded-proto') || req.protocol || 'http')
      .split(',')[0]
      .trim()
      .toLowerCase();
    const isHttps = req.secure || rawProto === 'https';

    res.setHeader('Content-Security-Policy', buildCspHeader(isHttps));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    return res.send(html);
  } catch {
    return res.status(500).type('text/plain').send('Internal Server Error');
  }
};

app.get('/', sendIndexWithDynamicOg);
app.get('/index.html', sendIndexWithDynamicOg);
app.use(sendIndexWithDynamicOg);

// Error handler without stack trace leakage
app.use((_err, _req, res, _next) => {
  res.status(500).type('text/plain').send('Internal Server Error');
});

app.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
});
