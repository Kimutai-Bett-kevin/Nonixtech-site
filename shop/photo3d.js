// Phone photos for the shop's built-in 3D phone: trims the background from a front and a back photo and
// returns them as JPEGs, with the phone's proportions and edge colour. The shop lays the front photo on the
// screen and the back photo on the back cover, so the model is always phone-shaped and still explodes into parts.

const MAX = 900; // longest side of each stored photo, px
const TOL = 42;  // how far (sum of RGB differences) a pixel can be from the background colour and still count as background

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => res(img); img.onerror = () => rej(new Error('Could not read a photo'));
    img.src = typeof src === 'string' ? src : URL.createObjectURL(src);
  });
}

// Finds the phone in a photo. Background is whatever matches the colour around the photo's edges AND is
// connected to the edges (flood fill), so white parts inside the phone (a logo, a MagSafe ring) are kept.
function trim(img) {
  const s = Math.min(1, MAX / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.width * s)); c.height = Math.max(1, Math.round(img.height * s));
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, c.width, c.height);
  const { width: w, height: h } = c, d = g.getImageData(0, 0, w, h).data;
  const border = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) border.push(y * w, y * w + w - 1);
  const med = k => { const v = border.map(i => d[i * 4 + k]).sort((a, b) => a - b); return v[v.length >> 1]; };
  const bg = [med(0), med(1), med(2)];
  const like = i => d[i * 4 + 3] < 40 || Math.abs(d[i * 4] - bg[0]) + Math.abs(d[i * 4 + 1] - bg[1]) + Math.abs(d[i * 4 + 2] - bg[2]) < TOL;
  const mask = new Uint8Array(w * h), stack = [];
  border.forEach(i => { if (!mask[i] && like(i)) { mask[i] = 1; stack.push(i); } });
  while (stack.length) {
    const i = stack.pop(), x = i % w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w])
      if (j >= 0 && j < w * h && !mask[j] && like(j)) { mask[j] = 1; stack.push(j); }
  }
  // Bounds of the phone: rows/columns that are at least 1% phone, so specks and faint shadows don't widen it.
  const rows = new Array(h).fill(0), cols = new Array(w).fill(0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!mask[y * w + x]) { rows[y]++; cols[x]++; }
  const first = (a, n) => a.findIndex(v => v > n), last = (a, n) => a.length - 1 - [...a].reverse().findIndex(v => v > n);
  const y0 = first(rows, w * 0.01), y1 = last(rows, w * 0.01), x0 = first(cols, h * 0.01), x1 = last(cols, h * 0.01);
  if (y0 < 0 || x0 < 0 || x1 - x0 < 10 || y1 - y0 < 10) throw new Error('Could not find the phone in a photo. Use a plain background.');
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1, out = document.createElement('canvas'); out.width = cw; out.height = ch;
  out.getContext('2d', { willReadFrequently: true }).drawImage(c, x0, y0, cw, ch, 0, 0, cw, ch);
  const m = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) m[y * cw + x] = mask[(y + y0) * w + x + x0];
  return { canvas: out, mask: m, w: cw, h: ch };
}

// Median colour of a band just inside the phone's outline: the colour of its frame.
function edgeColour(t) {
  const d = t.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, t.w, t.h).data, ch = [[], [], []];
  const band = Math.max(2, Math.round(Math.min(t.w, t.h) * 0.03));
  for (let y = 0; y < t.h; y += 2) for (let x = 0; x < t.w; x += 2) {
    const i = y * t.w + x;
    if (t.mask[i] || !(x < band || y < band || x >= t.w - band || y >= t.h - band)) continue;
    for (let k = 0; k < 3; k++) ch[k].push(d[i * 4 + k]);
  }
  const med = a => a.length ? a.sort((p, q) => p - q)[a.length >> 1] : 90;
  return '#' + ch.map(a => med(a).toString(16).padStart(2, '0')).join('');
}

// The trimmed photo as a JPEG, with the leftover background (the rounded corners) painted in the frame colour.
function toJpeg(t, colour) {
  const g = t.canvas.getContext('2d', { willReadFrequently: true }), img = g.getImageData(0, 0, t.w, t.h);
  const rgb = [1, 3, 5].map(i => parseInt(colour.slice(i, i + 2), 16));
  for (let i = 0; i < t.w * t.h; i++) if (t.mask[i]) { img.data.set(rgb, i * 4); img.data[i * 4 + 3] = 255; }
  g.putImageData(img, 0, 0);
  return t.canvas.toDataURL('image/jpeg', 0.85);
}

/**
 * photos: { front, back } as image URLs, data URLs or Blobs (both required).
 * Returns { front, back (JPEG data URLs), colour ('#rrggbb', the frame), aspect (height / width) }.
 */
export async function makeSkin(photos) {
  if (!photos.front || !photos.back) throw new Error('Add a front and a back photo.');
  const f = trim(await loadImage(photos.front)), b = trim(await loadImage(photos.back));
  const colour = edgeColour(b);
  return { front: toJpeg(f, colour), back: toJpeg(b, colour), colour, aspect: Math.round((f.h / f.w + b.h / b.w) / 2 * 1000) / 1000 };
}
