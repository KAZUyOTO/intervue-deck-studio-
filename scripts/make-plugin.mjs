// Packages the Figma plugin (plugin/) as public/deck-studio-plugin.zip, pointed at this site.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { zipSync, strToU8 } from 'fflate';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const host = process.env.SITE_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || 'localhost:3000';
const site = (/^https?:\/\//.test(host) ? host : (host.startsWith('localhost') ? 'http://' : 'https://') + host).replace(/\/+$/, '');

const files = {};
for (const name of ['manifest.json', 'code.js', 'ui.html']) {
  const text = readFileSync(join(root, 'plugin', name), 'utf8').replaceAll('__SITE__', site);
  files[`deck-studio-plugin/${name}`] = strToU8(text);
}
mkdirSync(join(root, 'public'), { recursive: true });
writeFileSync(join(root, 'public/deck-studio-plugin.zip'), zipSync(files, { level: 9 }));
console.log(`Figma plugin packaged for ${site}`);
