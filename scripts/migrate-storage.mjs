import { list } from '@vercel/blob';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const root = path.resolve('.migration');
const backup = path.join(root, 'blob-backup');
const mode = process.argv[2] || 'inventory';
if (!['inventory', 'bootstrap', 'backup', 'copy', 'verify'].includes(mode)) throw new Error('Unknown migration mode');
const gateway = `${process.env.SUPABASE_URL}/functions/v1/deck-studio-storage`;
const token = process.env.SUPABASE_STORAGE_GATEWAY_TOKEN;
const hash = (body) => createHash('sha256').update(body).digest('hex');
await mkdir(backup, { recursive: true });

async function retry(operation) {
  for (let i = 0; ; i++) {
    try { return await operation(); }
    catch (error) {
      if (i >= 3) throw error;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
}

async function call(action, pathname = '', init = {}) {
  const url = new URL(gateway);
  url.searchParams.set('action', action);
  url.searchParams.set('path', pathname);
  const response = await fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers }, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Supabase ${action}: ${response.status} ${(await response.text()).slice(0, 200)}`);
  return response;
}

if (mode === 'bootstrap') {
  console.log(await (await call('bootstrap', '', { method: 'POST' })).json());
  process.exit(0);
}

let inventory;
if (mode === 'inventory') {
  inventory = [];
  let cursor;
  do {
    const page = await list({ limit: 1000, cursor });
    inventory.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  await writeFile(path.join(root, 'inventory.json'), JSON.stringify(inventory, null, 2));
  const prefixes = {};
  for (const file of inventory) {
    const prefix = file.pathname.split('/')[0];
    prefixes[prefix] = (prefixes[prefix] || 0) + 1;
  }
  console.log(JSON.stringify({ files: inventory.length, bytes: inventory.reduce((n, f) => n + f.size, 0), largest: Math.max(...inventory.map((f) => f.size)), prefixes }));
  process.exit(0);
}
inventory = JSON.parse(await readFile(path.join(root, 'inventory.json'), 'utf8'));
const byUrl = new Map(inventory.map((f) => [f.url, f.pathname]));
const paths = new Set(inventory.map((f) => f.pathname));
const origins = new Set(inventory.map((f) => new URL(f.url).origin));
let replacements = 0;
function rewrite(value) {
  if (typeof value === 'string') {
    let key = byUrl.get(value);
    if (!key && /^https?:\/\//.test(value)) {
      const u = new URL(value);
      const pathname = decodeURIComponent(u.pathname.slice(1));
      if (origins.has(u.origin) && paths.has(pathname)) key = pathname;
    }
    if (key) {
      replacements++;
      return `/api/files/${key.split('/').map(encodeURIComponent).join('/')}`;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(rewrite);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v)]));
  return value;
}

const report = [];
let index = 0;
async function worker() {
  while (index < inventory.length) {
    const file = inventory[index++];
    const local = path.resolve(backup, file.pathname);
    if (!local.startsWith(backup + path.sep)) throw new Error('Unsafe object path');
    let source;
    try { source = await readFile(local); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      source = await retry(async () => {
        const response = await fetch(file.url, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error(`Source download failed ${response.status}: ${file.pathname}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length !== file.size) throw new Error(`Source size mismatch: ${file.pathname}`);
        return bytes;
      });
      await mkdir(path.dirname(local), { recursive: true });
      await writeFile(local, source);
    }
    if (source.length !== file.size) throw new Error(`Backup size mismatch: ${file.pathname}`);
    if (mode === 'backup') {
      report.push({ pathname: file.pathname, size: source.length, sha256: hash(source) });
    } else {
      let body = source;
      const isJson = file.pathname.endsWith('.json');
      if (isJson) body = Buffer.from(JSON.stringify(rewrite(JSON.parse(source.toString('utf8')))));
      const extension = file.pathname.split('.').pop().toLowerCase();
      const contentType = { json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf' }[extension] || 'application/octet-stream';
      if (mode === 'copy') {
        await retry(async () => call('file', file.pathname, { method: 'PUT', body, headers: { 'content-type': contentType, 'x-migrated-uploaded-at': new Date(file.uploadedAt).toISOString() } }));
      }
      const response = await retry(async () => call('file', file.pathname));
      const actual = Buffer.from(await response.arrayBuffer());
      if (hash(actual) !== hash(body)) throw new Error(`Destination checksum mismatch: ${file.pathname}`);
      report.push({ pathname: file.pathname, size: body.length, sha256: hash(body), sourceSha256: hash(source) });
    }
    if (report.length % 100 === 0) console.log(`${mode}: ${report.length}/${inventory.length}`);
  }
}
await Promise.all(Array.from({ length: 6 }, worker));
await writeFile(path.join(root, `${mode}-report.json`), JSON.stringify({ files: report.length, replacements, objects: report.sort((a, b) => a.pathname.localeCompare(b.pathname)) }, null, 2));
console.log(JSON.stringify({ mode, files: report.length, replacements, bytes: report.reduce((n, f) => n + f.size, 0) }));
