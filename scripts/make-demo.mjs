// Builds the bundled demo deck (public/demo/*.svg + lib/demo-manifest.json).
// The SVGs mimic Figma's export: every layer carries data-node-id, logo slots
// and text layers line up with the manifest exactly like a real sync.
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const W = 1920, H = 1080;
const FONT = 'Arial';
const ASC = 0.905, DESC = 0.212; // Arial / Liberation Sans metrics

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
let nid = 0;
const id = (slide) => `${slide}:${++nid}`;

function text(slide, { name, chars, x, y, w, size, weight = 400, color = '#111', align = 'LEFT', lh = 1.2, auto = 'HEIGHT', ls = 0, h }) {
  const lines = chars.split('\n');
  const lineH = Math.round(size * lh);
  const box = { x, y, w, h: h ?? lines.length * lineH };
  const nodeId = id(slide);
  const anchor = align === 'CENTER' ? 'middle' : align === 'RIGHT' ? 'end' : 'start';
  const ax = align === 'CENTER' ? x + w / 2 : align === 'RIGHT' ? x + w : x;
  const tspans = lines
    .map((l, i) => {
      const base = y + i * lineH + (lineH - (ASC + DESC) * size) / 2 + ASC * size;
      return `<tspan x="${ax}" y="${base.toFixed(1)}">${esc(l)}</tspan>`;
    })
    .join('');
  const svg = `<text data-node-id="${nodeId}" font-family="Arial, Helvetica, sans-serif" font-size="${size}" font-weight="${weight}" fill="${color}" text-anchor="${anchor}" letter-spacing="${ls}">${tspans}</text>`;
  const layer = {
    id: nodeId,
    name,
    characters: chars,
    box,
    style: {
      fontFamily: FONT, fontWeight: weight, fontSize: size, italic: false, align, valign: 'TOP',
      letterSpacing: ls, lineHeightPx: lineH, textCase: 'ORIGINAL', color, autoResize: auto,
    },
    editable: !/^(lock|_)/i.test(name),
    mixed: false,
    tokens: [...new Set([...chars.matchAll(/\{([A-Za-z][\w-]*)\}/g)].map((m) => m[1].toLowerCase()))],
  };
  return { svg, layer };
}

function slot(slide, { name = 'logo-slot', x, y, w, h, dark = false }) {
  const nodeId = id(slide);
  const stroke = dark ? 'rgba(255,255,255,0.45)' : 'rgba(17,17,17,0.35)';
  const label = dark ? 'rgba(255,255,255,0.6)' : 'rgba(17,17,17,0.5)';
  const svg = `<g data-node-id="${nodeId}"><rect x="${x + 1}" y="${y + 1}" width="${w - 2}" height="${h - 2}" rx="12" fill="none" stroke="${stroke}" stroke-width="2" stroke-dasharray="10 8"/><text x="${x + w / 2}" y="${y + h / 2 + 8}" text-anchor="middle" font-family="Arial, sans-serif" font-size="22" fill="${label}">Client logo</text></g>`;
  const key = name.includes(':') ? name.split(':')[1].trim().toLowerCase() : 'client';
  return { svg, slot: { id: nodeId, name, key, box: { x, y, w, h } } };
}

const texture = (op) => `<filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 ${op} 0"/></filter>`;

function wordmark(slide, x, y, color) {
  return text(slide, { name: 'lock / Intervue wordmark', chars: 'intervue', x, y, w: 260, size: 44, weight: 700, color, auto: 'WIDTH_AND_HEIGHT', ls: -1 });
}

const slides = [];
function build(name, bg, parts, defs = '') {
  const sid = `${slides.length + 1}:0`;
  const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none" xmlns="http://www.w3.org/2000/svg"><defs>${defs}</defs><g data-node-id="${sid}">${bg}${parts.map((p) => p.svg).join('')}</g></svg>`;
  const file = `slide-${slides.length + 1}.svg`;
  writeFileSync(join(root, 'public/demo', file), svg);
  slides.push({
    id: sid, name, width: W, height: H, svg: `/demo/${file}`,
    texts: parts.filter((p) => p.layer).map((p) => p.layer),
    slots: parts.filter((p) => p.slot).map((p) => p.slot),
  });
}

mkdirSync(join(root, 'public/demo'), { recursive: true });

// 1 — Cover
{
  const s = 'c';
  build('Cover',
    `<rect width="${W}" height="${H}" fill="#0E1430"/><rect width="${W}" height="${H}" fill="url(#glow1)"/><rect width="${W}" height="${H}" filter="url(#grain)"/>`,
    [
      wordmark(s, 120, 96, '#FFFFFF'),
      slot(s, { x: 1460, y: 72, w: 340, h: 120, dark: true }),
      text(s, { name: 'Eyebrow', chars: 'PROPOSAL · TECHNICAL HIRING', x: 120, y: 330, w: 900, size: 26, weight: 700, color: 'rgba(140,164,255,1)', ls: 3, auto: 'WIDTH_AND_HEIGHT' }),
      text(s, { name: 'Title', chars: 'Interview smarter,\nhire faster at {client}', x: 120, y: 390, w: 1500, size: 104, weight: 700, color: '#FFFFFF', lh: 1.08 }),
      text(s, { name: 'Subtitle', chars: 'A plan for the {client} engineering team', x: 120, y: 650, w: 1300, size: 40, color: 'rgba(255,255,255,0.72)' }),
      text(s, { name: 'Date', chars: 'October 2026', x: 120, y: 940, w: 600, size: 28, color: 'rgba(255,255,255,0.55)', auto: 'WIDTH_AND_HEIGHT' }),
    ],
    `<radialGradient id="glow1" cx="0.85" cy="0.9" r="0.9"><stop offset="0" stop-color="#3B5BFD" stop-opacity="0.75"/><stop offset="0.55" stop-color="#3B5BFD" stop-opacity="0.12"/><stop offset="1" stop-color="#0E1430" stop-opacity="0"/></radialGradient>${texture(0.06)}`);
}

// 2 — Problem
{
  const s = 'p';
  const card = (x, n, label) => [
    { svg: `<rect x="${x}" y="560" width="520" height="300" rx="24" fill="#FFFFFF" stroke="#E4E1D8"/>` },
    text(s, { name: `Stat ${n}`, chars: n, x: x + 48, y: 610, w: 430, size: 96, weight: 700, color: '#3B5BFD', auto: 'WIDTH_AND_HEIGHT' }),
    text(s, { name: `Stat label ${n}`, chars: label, x: x + 48, y: 740, w: 430, size: 28, color: '#4A4A55', lh: 1.35 }),
  ];
  build('The problem',
    `<rect width="${W}" height="${H}" fill="#F6F5F1"/>`,
    [
      wordmark(s, 120, 96, '#0E1430'),
      text(s, { name: 'Heading', chars: 'Why {client} needs structured\ntechnical interviews', x: 120, y: 250, w: 1600, size: 72, weight: 700, color: '#0E1430', lh: 1.12 }),
      ...card(120, '38%', 'of engineering time goes\ninto interviewing'),
      ...card(700, '21 days', 'average time-to-hire for\nsenior engineers'),
      ...card(1280, '1 in 3', 'offers declined after a\nslow process'),
      slot(s, { x: 1600, y: 940, w: 200, h: 80 }),
    ]);
}

// 3 — Solution
{
  const s = 's';
  build('What we do',
    `<rect width="${W}" height="${H}" fill="#FFFFFF"/><rect x="1060" y="0" width="860" height="${H}" fill="url(#photo)"/><rect x="1060" y="0" width="860" height="${H}" filter="url(#grain)"/><circle cx="1490" cy="520" r="210" fill="#FFFFFF" fill-opacity="0.12"/><circle cx="1490" cy="520" r="120" fill="#FFFFFF" fill-opacity="0.18"/>`,
    [
      wordmark(s, 120, 96, '#0E1430'),
      text(s, { name: 'Heading', chars: 'What Intervue does\nfor {client}', x: 120, y: 240, w: 860, size: 68, weight: 700, color: '#0E1430', lh: 1.12 }),
      text(s, { name: 'Bullets', chars: '• Senior engineers run your first-round interviews\n• Structured scorecards for every role\n• Recordings and reports within 2 hours\n• Fraud and proxy detection built in', x: 120, y: 480, w: 860, size: 32, color: '#33333D', lh: 1.75 }),
      text(s, { name: 'Footnote', chars: 'Prepared for {client} · Confidential', x: 120, y: 960, w: 860, size: 22, color: 'rgba(17,17,17,0.45)', auto: 'WIDTH_AND_HEIGHT' }),
      slot(s, { x: 1330, y: 460, w: 320, h: 120, dark: true }),
    ],
    `<linearGradient id="photo" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3B5BFD"/><stop offset="0.5" stop-color="#7A4DFF"/><stop offset="1" stop-color="#FF7A59"/></linearGradient>${texture(0.18)}`);
}

// 4 — Closing
{
  const s = 'e';
  build('Thank you',
    `<rect width="${W}" height="${H}" fill="#0E1430"/><rect width="${W}" height="${H}" fill="url(#glow2)"/><rect width="${W}" height="${H}" filter="url(#grain)"/>`,
    [
      text(s, { name: 'Thank you', chars: 'Thank you, {client} team', x: 160, y: 300, w: 1600, size: 96, weight: 700, color: '#FFFFFF', align: 'CENTER' }),
      text(s, { name: 'lock / Intervue ×', chars: 'intervue  ×', x: 560, y: 560, w: 380, size: 56, weight: 700, color: '#FFFFFF', align: 'RIGHT', auto: 'NONE', h: 68 }),
      slot(s, { x: 980, y: 534, w: 340, h: 120, dark: true }),
      text(s, { name: 'Contact', chars: 'Your Name · you@intervue.io · intervue.io', x: 160, y: 860, w: 1600, size: 30, color: 'rgba(255,255,255,0.7)', align: 'CENTER' }),
    ],
    `<radialGradient id="glow2" cx="0.5" cy="0.55" r="0.7"><stop offset="0" stop-color="#3B5BFD" stop-opacity="0.55"/><stop offset="1" stop-color="#0E1430" stop-opacity="0"/></radialGradient>${texture(0.06)}`);
}

const manifest = {
  version: 1,
  source: 'demo',
  syncedAt: new Date().toISOString(),
  fileName: 'Demo deck',
  decks: [{ id: 'demo', name: 'Sales pitch (demo)', slides }],
};
writeFileSync(join(root, 'lib/demo-manifest.json'), JSON.stringify(manifest, null, 1));
console.log(`Demo deck: ${slides.length} slides`);
