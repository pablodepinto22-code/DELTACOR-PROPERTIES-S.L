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
  'assets/demo/fachada_residencial_cadmia.webp',
  'assets/demo/salon_mirador_sur.webp',
  'assets/demo/cocina_roble_norte.webp',
  'assets/demo/suite_principal_obra_nueva.webp',
  'assets/demo/terraza_panoramica_mostoles.webp',
  'assets/demo/bano_porcelanico_gres.webp',
];

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

let copied = 0;
for (const rel of PUBLIC_FILES) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) {
    throw new Error(`Missing required public file: ${rel}`);
  }
  const dst = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  copied += 1;
}

console.log(`Built clean static dist/ with ${copied} public files.`);
