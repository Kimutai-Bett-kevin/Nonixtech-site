// "Real spare parts" for the admin's 3D models tab: searches Google Images (Serper) for this product's spare parts
// (battery, logic board, camera module, chip…), has Gemini pick one loose part per photo and mark it, and crops it.
// The shop lays each photo on that part in the exploded 3D view, so the parts look like the real ones.
import { searchImages, askJson, asBase64, cropView } from './findphotos.js';

const PER_PART = 6; // search results Gemini looks at per part
// key -> [what to search for, what the part is]. chip: searched by the chip's own name when the product has one.
const PARTS = {
  phone: { battery: ['battery', 'the phone battery'], board: ['logic board motherboard', 'the main circuit board (logic board / motherboard)'],
    camera: ['rear camera module', 'the rear camera module'], soc: ['chipset', 'the processor chip (SoC)'] },
  laptop: { battery: ['battery', 'the laptop battery'], board: ['motherboard', 'the motherboard'], fan: ['cooling fan', 'the cooling fan'],
    ram: ['RAM module', 'a RAM memory module'], ssd: ['SSD', 'the SSD (solid-state drive)'], cpu: ['processor', 'the processor chip (CPU)'] },
  minipc: { board: ['motherboard', 'the motherboard'], cpu: ['CPU cooler', 'the CPU or its cooler'], ram: ['RAM module', 'a RAM memory module'],
    ssd: ['SSD', 'the SSD (solid-state drive)'], wifi: ['wifi card', 'the Wi-Fi card'] }
};

// Shrinks a data URL to at most max px, as JPEG. Returns { url, aspect (height / width) }.
function small(url, max = 512) {
  return new Promise((res, rej) => {
    const img = new Image(); img.onerror = rej;
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      res({ url: c.toDataURL('image/jpeg', 0.82), aspect: Math.round(c.height / c.width * 1000) / 1000 });
    };
    img.src = url;
  });
}

/**
 * Finds photos of this product's spare parts. kind: 'phone' | 'laptop' | 'minipc'; labels: the product's part labels
 * (e.g. { soc: 'A18 Pro chip' }). Returns { key: [{ url, domain, link, box, score }] } (best first) for parts found.
 */
export async function findParts(name, kind, labels, serperKey, onStatus) {
  const parts = PARTS[kind] || PARTS.phone, keys = Object.keys(parts);
  onStatus && onStatus('Searching for ' + keys.length + ' spare parts…');
  const query = k => (k === 'soc' || k === 'cpu') && labels && labels[k] ? labels[k].replace(/\bchip\b/i, '').trim() + ' chip' : name + ' ' + parts[k][0];
  const found = await Promise.all(keys.map(k => searchImages(query(k), serperKey).then(r => r.slice(0, PER_PART).map(x => ({ ...x, part: k }))).catch(() => [])));
  onStatus && onStatus('Loading spare part photos…');
  const list = (await Promise.all(found.flat().map(async r => { try { return { ...r, b64: await asBase64(r.url) }; } catch (e) { return null; } }))).filter(Boolean);
  if (!list.length) return {};
  onStatus && onStatus('AI is checking ' + list.length + ' spare part photos…');
  const prompt = `These are ${list.length} images from image searches for spare parts of the ${kind === 'phone' ? 'phone' : kind === 'laptop' ? 'laptop' : 'device'} "${name}", numbered 0 to ${list.length - 1}. Each says which part was searched for.
For each image decide:
- part: which part it shows, one of ${keys.map(k => `"${k}" (${parts[k][1]})`).join(', ')}, or null. Only count a real photo of ONE loose part on its own (not fitted inside the device, not the whole device, not a drawing, not packaging), of this product or a part that looks the same.
- box: the box around that one part, [ymin, xmin, ymax, xmax] scaled 0-1000, tight with a little margin.
- score: 1 to 5, how good it is to show in a shop (5 = sharp, straight top-down view, plain background, nothing covering it).
Reply with only JSON: [{"i": 0, "part": "battery" or null, "box": [..], "score": 4}, ...]`;
  const out = await askJson([{ text: prompt }, ...list.map((r, i) => [{ text: 'Image ' + i + ' (searched for: ' + r.part + ')' }, { inlineData: { mimeType: 'image/jpeg', data: r.b64 } }]).flat()], onStatus);
  const res = {};
  (Array.isArray(out) ? out : []).forEach(o => {
    const r = list[o && o.i], b = o && o.box;
    if (!r || !keys.includes(o.part) || !Array.isArray(b) || b.length !== 4 || b[2] - b[0] < 60 || b[3] - b[1] < 60) return;
    (res[o.part] = res[o.part] || []).push({ url: r.url, domain: r.domain, link: r.link, box: b, score: Number(o.score) || 1 });
  });
  for (const k in res) res[k].sort((a, b) => b.score - a.score);
  return res;
}

// One found part photo, cropped and shrunk for storing. Returns { url (JPEG data URL), aspect }.
export async function partPhoto(v) { return small(await cropView(v, 1000)); }
