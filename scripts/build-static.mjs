import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

// Explicit allowlist of public static files deployed to Cloudflare Pages.
// Never copies server.js, firestore.rules, package.json, scripts/, or dotfiles.
const PUBLIC_FILES = [
  'index.html',
  'manifest.webmanifest',
  'robots.txt',
  '_headers',
  'logo-deltacor.png',
  'logo-deltacor-icon.png',
  'og-deltacor.jpg',
  'og-deltacor-square.jpg',
];

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

let copied = 0;
for (const rel of PUBLIC_FILES) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) {
    throw new Error(`Missing required public file: ${rel}`);
  }
  fs.copyFileSync(src, path.join(DIST, rel));
  copied += 1;
}

console.log(`Built clean static dist/ with ${copied} public files.`);
