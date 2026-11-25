import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

const DEFAULT_PUBLIC_ORIGIN = 'https://pablodepinto22-code.github.io/DELTACOR-PROPERTIES-S.L/';
const BLOCKED_PATHS = new Set([
  '/server.js',
  '/package.json',
  '/package-lock.json',
  '/metadata.json',
  '/.env',
  '/.env.example',
]);

app.use((req, res, next) => {
  const normalizedPath = path.posix.normalize(req.path);
  if (
    BLOCKED_PATHS.has(normalizedPath) ||
    normalizedPath.startsWith('/node_modules') ||
    normalizedPath.includes('/.')
  ) {
    return res.status(404).send('Not Found');
  }
  next();
});

const staticOptions = {
  dotfiles: 'ignore',
  index: false,
  setHeaders: (res, filePath) => {
    if (/\.(png|jpe?g|webp|ico|svg)$/i.test(filePath)) {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  }
};

app.use(express.static(path.join(__dirname, 'public'), staticOptions));
app.use(express.static(__dirname, staticOptions));

const sendIndexWithDynamicOg = (req, res) => {
  try {
    let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
    const envUrl = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
    const proto = String(req.get('x-forwarded-proto') || req.protocol || 'https').split(',')[0].trim();
    const host = String(req.get('host') || '').trim();
    const isLocalHost = !host || /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(host);
    const activeOrigin = !isLocalHost ? `${proto}://${host}` : envUrl;
    if (activeOrigin && /^https?:\/\//i.test(activeOrigin)) {
      const headEnd = html.indexOf('</head>');
      if (headEnd !== -1) {
        const head = html.slice(0, headEnd).split(DEFAULT_PUBLIC_ORIGIN).join(`${activeOrigin}/`);
        html = head + html.slice(headEnd);
      }
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(html);
  } catch (_) {
    res.sendFile(path.join(__dirname, 'index.html'));
  }
};

app.get('/', sendIndexWithDynamicOg);
app.use(sendIndexWithDynamicOg);

app.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
});

