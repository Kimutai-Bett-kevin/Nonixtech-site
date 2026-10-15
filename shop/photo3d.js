// Photo model: builds a phone/tablet-shaped .glb from real product photos (front, back, optional sides),
// in the browser, with no AI and no GPU. The body is a rounded slab; each photo is laid on its face.
// Works for flat products (phones, tablets, TVs); the AI engines in g3d.js are for other shapes.
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

const TEX = 1024; // longest side of each face texture, px

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => res(img); img.onerror = () => rej(new Error('Could not read a photo'));
    img.src = typeof src === 'string' ? src : URL.createObjectURL(src);
  });
}

// Finds the product inside a photo: everything that differs from the background (taken from the corners).
// Returns a canvas cropped to the product, a mask of which pixels are background, and the background colour.
function trim(img) {
  const s = Math.min(1, TEX / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, c.width, c.height);
  const { width: w, height: h } = c, d = g.getImageData(0, 0, w, h).data;
  const px = (x, y) => { const i = (y * w + x) * 4; return [d[i], d[i + 1], d[i + 2], d[i + 3]]; };
  const corners = [px(1, 1), px(w - 2, 1), px(1, h - 2), px(w - 2, h - 2)];
  const bg = [0, 1, 2].map(k => Math.round(corners.reduce((a, p) => a + p[k], 0) / 4));
  const isBg = (i) => d[i + 3] < 40 || Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) < 60;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!isBg((y * w + x) * 4)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < x0 || y1 < y0) throw new Error('Could not find the product in a photo. Use a plain background.');
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1, out = document.createElement('canvas'); out.width = cw; out.height = ch;
  out.getContext('2d', { willReadFrequently: true }).drawImage(c, x0, y0, cw, ch, 0, 0, cw, ch);
  const mask = new Uint8Array(cw * ch); // 1 = background pixel in the cropped photo
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) mask[y * cw + x] = isBg(((y + y0) * w + x + x0) * 4) ? 1 : 0;
  return { canvas: out, mask, w: cw, h: ch };
}

// Median colour of the product's outer edge (a ring just inside its outline), used for the body's sides.
function edgeColour(t) {
  const g = t.canvas.getContext('2d').getImageData(0, 0, t.w, t.h).data, rs = [], gs = [], bs = [];
  const band = Math.max(2, Math.round(Math.min(t.w, t.h) * 0.03));
  for (let y = 0; y < t.h; y += 2) for (let x = 0; x < t.w; x += 2) {
    const edge = x < band || y < band || x >= t.w - band || y >= t.h - band;
    const i = y * t.w + x; if (!edge || t.mask[i]) continue;
    rs.push(g[i * 4]); gs.push(g[i * 4 + 1]); bs.push(g[i * 4 + 2]);
  }
  const med = a => a.length ? a.sort((p, q) => p - q)[a.length >> 1] : 90;
  return '#' + [med(rs), med(gs), med(bs)].map(v => v.toString(16).padStart(2, '0')).join('');
}

// Paints the background pixels in the body colour, so rounded corners blend into the body, not white.
function faceTexture(t, colour, region) {
  const c = document.createElement('canvas'), g = c.getContext('2d');
  const sx = region ? Math.round(region[0] * t.w) : 0, sy = region ? Math.round(region[1] * t.h) : 0;
  const sw = region ? Math.round(region[2] * t.w) : t.w, sh = region ? Math.round(region[3] * t.h) : t.h;
  c.width = sw; c.height = sh;
  const src = t.canvas.getContext('2d').getImageData(sx, sy, sw, sh), col = new THREE.Color(colour);
  const r = Math.round(col.r * 255), gg = Math.round(col.g * 255), b = Math.round(col.b * 255);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    if (!t.mask[(y + sy) * t.w + (x + sx)]) continue;
    const j = (y * sw + x) * 4; src.data[j] = r; src.data[j + 1] = gg; src.data[j + 2] = b; src.data[j + 3] = 255;
  }
  g.putImageData(src, 0, 0);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.userData.mimeType = 'image/jpeg';
  return tex;
}

function roundedRect(w, h, r) {
  const s = new THREE.Shape(), x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

// A flat face in the outline of the body, with the photo stretched over it. Unlit, because the photo
// already has its own lighting; the shop's lights would wash it out (exported as KHR_materials_unlit).
function faceMesh(shape, w, h, tex, name) {
  const geo = new THREE.ShapeGeometry(shape, 12), pos = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) + w / 2) / w, (pos.getY(i) + h / 2) / h);
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex })); m.name = name;
  return m;
}

/**
 * photos: { front, back, left?, right? } as image URLs/data URLs/Blobs. front and back are required.
 * opts: { widthMm = 75, radiusMm = 8, thicknessMm (blank = from a side photo, else 11% of width), colour (blank = from the photos) }
 * Returns { blob (model/gltf-binary), bytes, colour, sizeMm: [w, h, t] }.
 */
export async function buildPhotoModel(photos, opts = {}) {
  if (!photos.front || !photos.back) throw new Error('Add a front and a back photo.');
  const T = {};
  for (const k of ['front', 'back', 'left', 'right']) if (photos[k]) T[k] = trim(await loadImage(photos[k]));
  const mm = 0.001, W = (Number(opts.widthMm) || 75) * mm;
  const aspect = (T.back.h / T.back.w + T.front.h / T.front.w) / 2, H = W * aspect;
  const side = T.right || T.left;
  const thick = (Number(opts.thicknessMm) || 0) * mm || (side ? H * side.w / side.h : W * 0.11);
  const R = Math.min((Number(opts.radiusMm) || 8) * mm, W / 2 - mm, H / 2 - mm);
  const colour = opts.colour || edgeColour(T.back);

  const root = new THREE.Group(), shape = roundedRect(W, H, R), gap = thick * 0.004;
  const body = new THREE.Mesh(
    new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false, curveSegments: 12 }),
    // unlit like the photos, so the ends and corners match them from every angle; a little darker reads as an edge
    new THREE.MeshBasicMaterial({ color: new THREE.Color(colour).multiplyScalar(0.8) }));
  body.geometry.translate(0, 0, -thick / 2); body.name = 'Body'; body.userData.keepMaterial = true; root.add(body);

  const front = faceMesh(shape, W, H, faceTexture(T.front, colour), 'Front'); front.position.z = thick / 2 + gap; root.add(front);
  const back = faceMesh(shape, W, H, faceTexture(T.back, colour), 'Back'); back.rotation.y = Math.PI; back.position.z = -thick / 2 - gap; root.add(back);

  // Side photos cover the straight part of each long side (the rounded ends stay body colour).
  const vy = R / H;
  for (const [k, sign] of [['right', 1], ['left', -1]]) {
    if (!T[k]) continue;
    const tex = faceTexture(T[k], colour, [0, vy, 1, 1 - 2 * vy]);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(thick, H - 2 * R), new THREE.MeshBasicMaterial({ map: tex }));
    m.name = k === 'right' ? 'Right' : 'Left'; // glTF names can't have spaces
    m.rotation.y = sign * Math.PI / 2; m.position.x = sign * (W / 2 + gap); root.add(m);
  }

  const buf = await new GLTFExporter().parseAsync(root, { binary: true });
  root.traverse(o => { if (o.isMesh) { o.geometry.dispose(); if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
  return { blob: new Blob([buf], { type: 'model/gltf-binary' }), bytes: buf.byteLength, colour, sizeMm: [W, H, thick].map(v => Math.round(v / mm * 10) / 10) };
}
