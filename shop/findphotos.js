// "Find photos online" for the admin's Phone photos card: searches Google Images through Serper, has Gemini
// (Firebase AI Logic, same as Noni Sales AI) pick out straight-on front and back views of the exact phone and
// mark where they are in each image (press photos often show both side by side), then crops them.
// Other sites don't let a browser read their images, so they're fetched through the public wsrv.nl image proxy.

const FB = { apiKey: 'AIzaSyBxjSk2_BO2Np1PD6nYvBVKqAfSGGPLPms', authDomain: 'nonix-technologies.firebaseapp.com', projectId: 'nonix-technologies', appId: '1:1020109167752:web:4bd5e746b33ba91a3a933d' };
const MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest']; // full model is better at locating things; lite as fallback
const CHECK = 24;  // how many search results Gemini looks at
const THUMB = 320; // px, size Gemini sees

export const proxied = (url, w) => 'https://wsrv.nl/?url=' + encodeURIComponent(url) + '&w=' + w + '&h=' + w + '&fit=inside&output=jpg&q=88';

// Google Images results via Serper (https://serper.dev). Returns [{ url, title, domain, link, w, h }].
export async function searchImages(query, key) {
  if (!key) throw new Error('Add your Serper API key first.');
  const r = await fetch('https://google.serper.dev/images', {
    method: 'POST', headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num: 40 })
  });
  if (r.status === 401 || r.status === 403) throw new Error('Serper rejected the API key. Check it at serper.dev.');
  if (!r.ok) throw new Error('Image search failed (' + r.status + ')' + (r.status === 400 ? ': out of Serper credits?' : ''));
  const { images = [] } = await r.json();
  return images.filter(i => i.imageUrl && /^https?:/.test(i.imageUrl))
    .map(i => ({ url: i.imageUrl, title: i.title || '', domain: i.domain || '', link: i.link || '', w: i.imageWidth || 0, h: i.imageHeight || 0 }));
}

function loadImage(src) {
  return new Promise((res, rej) => { const img = new Image(); img.crossOrigin = 'anonymous'; img.onload = () => res(img); img.onerror = () => rej(new Error('image')); img.src = src; });
}
async function asBase64(url) {
  const img = await loadImage(proxied(url, THUMB)), c = document.createElement('canvas');
  c.width = img.width; c.height = img.height; c.getContext('2d').drawImage(img, 0, 0);
  return c.toDataURL('image/jpeg', 0.85).split(',')[1];
}

let gem = null;
function gemini() {
  if (!gem) {
    const b = 'https://www.gstatic.com/firebasejs/12.19.0/';
    gem = Promise.all([import(b + 'firebase-app.js'), import(b + 'firebase-ai.js')])
      .then(([app, m]) => ({ m, ai: m.getAI(app.initializeApp(FB, 'photo-finder'), { backend: new m.GoogleAIBackend() }) }))
      .catch(e => { gem = null; throw e; });
  }
  return gem;
}

/**
 * Has Gemini check the search results. Returns { front: [...], back: [...] }, each a list of
 * { url, domain, link, box: [ymin, xmin, ymax, xmax] (0-1000), score }, best first.
 */
// Variant words: a result named "... Pro Max" isn't the "Pro" the admin searched for.
const VARIANTS = ['pro', 'max', 'ultra', 'plus', 'mini', 'lite', 'fe', 'neo', 'edge', 'fold', 'flip'];
const words = t => new Set(String(t).toLowerCase().replace(/\+/g, ' plus ').split(/[^a-z0-9]+/).filter(Boolean));
function sameVariant(phoneName, r) {
  const want = words(phoneName), got = words(r.title + ' ' + decodeURIComponent(r.url.split('?')[0]).replace(/[-_]/g, ' '));
  return VARIANTS.every(v => want.has(v) || !got.has(v));
}

export async function pickViews(phoneName, results, onStatus) {
  results = results.filter(r => sameVariant(phoneName, r));
  if (!results.length) throw new Error('No photos of exactly this model found. Check the name.');
  const loaded = [];
  onStatus && onStatus('Loading ' + Math.min(CHECK, results.length) + ' photos…');
  await Promise.all(results.slice(0, CHECK).map(async (r, i) => { try { loaded[i] = { ...r, b64: await asBase64(r.url) }; } catch (e) {} }));
  const list = loaded.filter(Boolean);
  if (!list.length) throw new Error('None of the photos could be loaded.');
  onStatus && onStatus('AI is checking ' + list.length + ' photos…');
  const prompt = `These are ${list.length} images from an image search for the phone "${phoneName}", numbered 0 to ${list.length - 1} in order.
For each image, decide:
- match: true only if it shows exactly this phone model. Variants are different models: "Pro" is not "Pro Max", "S25" is not "S25 Ultra" or "S25+". Not a case or accessory on its own.
- front: the box of ONE straight-on view of the phone's screen side, or null.
- back: the box of ONE straight-on view of the phone's back, or null.
  A view only counts if the WHOLE phone outline is visible: not tilted or angled, not cut off by the image edge, and not partly covered by another phone, a hand, text or any object. If the only views overlap each other (e.g. a front phone in front of a back phone), give null for the covered one.
- score: 1 to 5, how clean the view is for cutting out (5 = plain background, sharp, nothing near it).
Boxes are [ymin, xmin, ymax, xmax] scaled 0-1000 and must contain the whole phone with a little margin.
Reply with only JSON: [{"i": 0, "match": true, "front": [..] or null, "back": [..] or null, "score": 4}, ...]`;
  const parts = [{ text: prompt }, ...list.map((r, i) => [{ text: 'Image ' + i }, { inlineData: { mimeType: 'image/jpeg', data: r.b64 } }]).flat()];
  const g = await gemini(); let out = null, lastErr = null;
  // The full model is often briefly overloaded ("high demand"): retry it before falling back to lite.
  const tries = [MODELS[0], MODELS[0], MODELS[0], MODELS[1]];
  for (let t = 0; t < tries.length; t++) {
    const name = tries[t];
    try {
      const model = g.m.getGenerativeModel(g.ai, { model: name, generationConfig: { responseMimeType: 'application/json', temperature: 0 } });
      const text = (await model.generateContent(parts)).response.text();
      out = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)); break;
    } catch (e) {
      lastErr = e; console.warn('Photo finder AI error (' + name + ')', e);
      if (/429|quota/i.test(String(e)) && name === MODELS[0]) t = tries.length - 2; // daily limit: go straight to lite
      else if (/500|503|overload|demand/i.test(String(e))) { onStatus && onStatus('AI is busy, retrying…'); await new Promise(r => setTimeout(r, 2500)); }
    }
  }
  if (!out) throw new Error('The AI could not check the photos' + (lastErr && /quota|429/i.test(String(lastErr)) ? ' (free AI limit reached, try again in a minute).' : '.'));
  const ok = b => Array.isArray(b) && b.length === 4 && b.every(n => typeof n === 'number') && b[2] - b[0] > 80 && b[3] - b[1] > 30;
  const views = { front: [], back: [] };
  // Front and back boxes that overlap mean one phone covers the other: push both to the bottom of the list.
  const overlap = (a, b) => { const w = Math.min(a[3], b[3]) - Math.max(a[1], b[1]), h = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
    return w > 0 && h > 0 ? (w * h) / Math.min((a[3] - a[1]) * (a[2] - a[0]), (b[3] - b[1]) * (b[2] - b[0])) : 0; };
  out.forEach(o => {
    const r = list[o && o.i]; if (!r || !o.match) return;
    const covered = ok(o.front) && ok(o.back) && overlap(o.front, o.back) > 0.03;
    for (const k of ['front', 'back']) if (ok(o[k])) views[k].push({ url: r.url, domain: r.domain, link: r.link, box: o[k], score: covered ? 0 : Number(o.score) || 1 });
  });
  for (const k of ['front', 'back']) views[k].sort((a, b) => b.score - a.score);
  return views;
}

// Crops one view out of the full-size image (through the proxy), with a small margin. Returns a JPEG data URL.
export async function cropView(v, size = 1400) {
  const img = await loadImage(proxied(v.url, size));
  const [y0, x0, y1, x1] = v.box, mx = (x1 - x0) * 0.04, my = (y1 - y0) * 0.03;
  const sx = Math.max(0, (x0 - mx) / 1000 * img.width), sy = Math.max(0, (y0 - my) / 1000 * img.height);
  const sw = Math.min(img.width, (x1 + mx) / 1000 * img.width) - sx, sh = Math.min(img.height, (y1 + my) / 1000 * img.height) - sy;
  const c = document.createElement('canvas'); c.width = Math.round(sw); c.height = Math.round(sh);
  c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.9);
}
