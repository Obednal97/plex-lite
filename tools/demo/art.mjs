// Generated artwork for the demo server, as SVG: placeholder posters and stills for titles without
// freely licensed art, simple wordmark logos, channel logos, collection collages, and the blurred
// "ambient" backdrops the app asks Plex's photo transcoder for. Nothing here is copied from anywhere.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

function hash(s) {
  let h = 2166136261;
  for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

// Muted, cinematic pairs (top, bottom) so placeholders sit well next to real art.
const PALETTES = [
  ['#2d4a5a', '#0e1a22'], ['#5a3d2d', '#1c120d'], ['#3d2d5a', '#130e1f'], ['#2d5a46', '#0d1c16'],
  ['#5a2d3d', '#1f0d13'], ['#4a5a2d', '#171c0d'], ['#2d3d5a', '#0d121f'], ['#5a4f2d', '#1f1a0d'],
];
const palette = (key) => PALETTES[hash(key) % PALETTES.length];

// Breaks a title into lines of at most `max` characters.
function lines(text, max) {
  const out = [];
  let cur = '';
  for (const w of String(text).split(/\s+/)) {
    if (cur && (cur + ' ' + w).length > max) { out.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) out.push(cur);
  return out;
}

const svg = (w, h, body) => `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;

function ground(w, h, key) {
  const [a, b] = palette(key);
  const r = hash(key + 'x');
  const cx = 20 + (r % 60);
  const cy = 15 + ((r >> 8) % 40);
  return `<defs><linearGradient id="g" x1="0" y1="0" x2="0.3" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>` +
    `<radialGradient id="l" cx="${cx}%" cy="${cy}%" r="70%"><stop offset="0" stop-color="#fff" stop-opacity=".16"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>` +
    `<rect width="${w}" height="${h}" fill="url(#g)"/><rect width="${w}" height="${h}" fill="url(#l)"/>`;
}

// A typographic poster: title, year and a thin rule; reads as a deliberate design, not an error.
export function poster(title, year, key) {
  const w = 500;
  const h = 750;
  const ls = lines(title, 12);
  const size = ls.some((l) => l.length > 9) ? 54 : 64;
  const top = 470 - (ls.length - 1) * size * 0.55;
  const text = ls.map((l, i) => `<text x="44" y="${top + i * size * 1.08}" font-family="Georgia, 'Times New Roman', serif" font-size="${size}" font-weight="700" fill="#f4efe6">${esc(l)}</text>`).join('');
  return svg(w, h, ground(w, h, key) +
    `<rect x="44" y="${top - size - 26}" width="64" height="4" fill="#f4efe6" opacity=".8"/>${text}` +
    (year ? `<text x="44" y="690" font-family="'Helvetica Neue', Arial, sans-serif" font-size="26" letter-spacing="6" fill="#f4efe6" opacity=".7">${esc(year)}</text>` : ''));
}

// A wide still/backdrop placeholder with soft light, no text (the app draws titles itself).
export function still(key, w = 1280, h = 720) {
  const r = hash(key);
  const circles = [0, 1, 2].map((i) => {
    const x = (r >> (i * 5)) % w;
    const y = (r >> (i * 7)) % h;
    return `<circle cx="${x}" cy="${y}" r="${h * (0.25 + i * 0.12)}" fill="#fff" opacity="${0.04 + i * 0.015}"/>`;
  }).join('');
  return svg(w, h, ground(w, h, key) + circles);
}

// A transparent wordmark. Width is estimated from the text so the app's constant-area sizing works.
export function logo(title, style) {
  const serif = style !== 'sans';
  const size = 120;
  const text = String(title).toUpperCase();
  const w = Math.round(text.length * size * (serif ? 0.74 : 0.7) + 40);
  const h = 170;
  return svg(w, h, `<text x="${w / 2}" y="132" text-anchor="middle" font-family="${serif ? "Georgia, 'Times New Roman', serif" : "'Helvetica Neue', Arial, sans-serif"}" font-size="${size}" font-weight="700" letter-spacing="${serif ? 4 : 2}" fill="#fbf7ef">${esc(text)}</text>`);
}

// Channel logos for the Live TV guide: a rounded badge with the channel's short name.
export function channel(name, key) {
  const [a] = palette(key);
  return svg(224, 120, `<rect x="4" y="12" width="216" height="96" rx="22" fill="${a}"/><text x="112" y="74" text-anchor="middle" font-family="'Helvetica Neue', Arial, sans-serif" font-size="34" font-weight="700" fill="#fff">${esc(name)}</text>`);
}

// Collection poster: a collage of up to four member posters (data URIs, since SVG images can't fetch).
export function collage(title, images, key) {
  const w = 500;
  const h = 750;
  // 2: side by side; 3: one across the top, two below; 4+: a 2x2 grid
  const n = Math.min(images.length, 4);
  const cells = n === 2 ? [[0, 0, w / 2, h], [w / 2, 0, w / 2, h]]
    : n === 3 ? [[0, 0, w, h / 2], [0, h / 2, w / 2, h / 2], [w / 2, h / 2, w / 2, h / 2]]
      : [[0, 0, w / 2, h / 2], [w / 2, 0, w / 2, h / 2], [0, h / 2, w / 2, h / 2], [w / 2, h / 2, w / 2, h / 2]];
  const body = cells.map(([x, y, cw, ch], i) => `<image x="${x}" y="${y}" width="${cw}" height="${ch}" preserveAspectRatio="xMidYMid slice" xlink:href="${images[i]}"/>`).join('');
  return svg(w, h, ground(w, h, key) + body +
    `<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset=".45" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".85"/></linearGradient></defs>` +
    `<rect width="${w}" height="${h}" fill="url(#s)"/>` +
    lines(title, 16).map((l, i, all) => `<text x="36" y="${700 - (all.length - 1 - i) * 52}" font-family="Georgia, 'Times New Roman', serif" font-size="46" font-weight="700" fill="#fff">${esc(l)}</text>`).join(''));
}

// What Plex's transcoder does for ?blur=&opacity=&background=: blur the art and lay it over a solid
// colour. Done with an SVG filter so the server needs no image library.
export function ambient(dataUri, w, h, blur, opacity, background) {
  const pad = blur * 3;
  return svg(w, h, `<defs><filter id="b" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="${blur}"/></filter></defs>` +
    `<rect width="${w}" height="${h}" fill="#${background}"/>` +
    `<image x="${-pad}" y="${-pad}" width="${w + pad * 2}" height="${h + pad * 2}" preserveAspectRatio="xMidYMid slice" opacity="${opacity / 100}" filter="url(#b)" xlink:href="${dataUri}"/>`);
}
