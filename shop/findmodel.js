// "Find a real 3D model online" for the admin's 3D models tab: searches Sketchfab's downloadable models, has
// Gemini check the previews for exactly this product, downloads the chosen one as .glb (needs the admin's free
// Sketchfab API token), stands phones upright with the screen facing front, shrinks big textures, and renders
// front / right / back / left / top pictures of it for the shop's 360° photos tab.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { askJson, asBase64, sameVariant } from './findphotos.js';

const API = 'https://api.sketchfab.com/v3';
const MAX_DOWNLOAD = 40 * 1024 * 1024; // bigger downloads are skipped (slow, and too big even after shrinking)
const TEX = 1024;                       // longest side of each texture after shrinking, px
// Licences that allow use in a shop. NonCommercial and Editorial ones are left out.
const OK_LICENCE = /^(CC Attribution|CC Attribution-ShareAlike|CC Attribution-NoDerivs|CC0 Public Domain|Free Standard|Standard)$/;

// Every variant word in the search must be in the model's name: "iPhone 16" is not an "iPhone 16 Pro".
const VARIANTS = ['pro', 'max', 'ultra', 'plus', 'mini', 'lite', 'fe', 'neo', 'edge', 'fold', 'flip'];
const words = t => new Set(String(t).toLowerCase().replace(/\+/g, ' plus ').split(/[^a-z0-9]+/).filter(Boolean));
const hasVariants = (name, title) => { const want = words(name), got = words(title); return VARIANTS.every(v => !want.has(v) || got.has(v)); };
const thumb = (m, w) => { const im = ((m.thumbnails || {}).images || []).slice().sort((a, b) => Math.abs(a.width - w) - Math.abs(b.width - w)); return im[0] ? im[0].url : ''; };

// Downloadable Sketchfab models for this product. Returns [{ uid, name, author, licence, url, thumb, bytes, faces }].
export async function searchModels(name) {
  const r = await fetch(API + '/search?type=models&downloadable=true&count=24&q=' + encodeURIComponent(name));
  if (!r.ok) throw new Error('3D model search failed (' + r.status + ')');
  const { results = [] } = await r.json();
  return results.map(m => {
    const glb = (m.archives || {}).glb || {};
    return { uid: m.uid, name: m.name || '', author: (m.user || {}).displayName || (m.user || {}).username || '', licence: (m.license || {}).label || '',
      url: m.viewerUrl || 'https://sketchfab.com/3d-models/' + m.uid, thumb: thumb(m, 720), bytes: glb.size || 0, faces: glb.faceCount || m.faceCount || 0 };
  }).filter(m => OK_LICENCE.test(m.licence) && m.bytes && m.bytes <= MAX_DOWNLOAD && m.thumb && sameVariant(name, { title: m.name, url: '' }) && hasVariants(name, m.name));
}

// Has Gemini look at the previews: exactly this product, realistic, one product only. Returns the good ones, best first.
export async function pickModels(name, list, onStatus) {
  if (!list.length) return [];
  onStatus && onStatus('Loading ' + list.length + ' 3D model previews…');
  const loaded = (await Promise.all(list.map(async m => { try { return { ...m, b64: await asBase64(m.thumb) }; } catch (e) { return null; } }))).filter(Boolean);
  if (!loaded.length) return [];
  onStatus && onStatus('AI is checking ' + loaded.length + ' 3D models…');
  const prompt = `These are preview pictures of ${loaded.length} 3D models from a search for the product "${name}", numbered 0 to ${loaded.length - 1}.
For each, decide:
- match: true only if the model is exactly this product (variants are different models: "Pro" is not "Pro Max", "S25" is not "S25 Ultra"), shown as ONE product (not a collection of several, not a case, not a concept, leak or generic phone), and looks like the real product.
- score: 1 to 5, how realistic and detailed it looks (5 = looks like a product photo, real materials and colours).
Reply with only JSON: [{"i": 0, "match": true, "score": 4}, ...]`;
  const parts = [{ text: prompt }, ...loaded.map((m, i) => [{ text: 'Model ' + i + ': "' + m.name + '"' }, { inlineData: { mimeType: 'image/jpeg', data: m.b64 } }]).flat()];
  const out = await askJson(parts, onStatus);
  const good = [];
  (Array.isArray(out) ? out : []).forEach(o => { const m = loaded[o && o.i]; if (m && o.match) good.push({ ...m, b64: undefined, score: Number(o.score) || 1 }); });
  // Best looking first; between equals, the smaller download (loads faster in the shop).
  return good.sort((a, b) => b.score - a.score || a.bytes - b.bytes);
}

// The model's .glb file. Sketchfab only hands out download links to signed-in users, hence the token.
export async function downloadModel(m, token, onStatus) {
  if (!token) throw new Error('Add your Sketchfab API token first.');
  const r = await fetch(API + '/models/' + m.uid + '/download', { headers: { Authorization: 'Token ' + token } });
  if (r.status === 401 || r.status === 403) throw new Error('Sketchfab rejected the API token. Check it at sketchfab.com/settings/password.');
  if (!r.ok) throw new Error('Could not get the download (' + r.status + ').');
  const links = await r.json();
  if (!links.glb || !links.glb.url) throw new Error('This model has no .glb download. Pick another one.');
  onStatus && onStatus('Downloading "' + m.name + '" (' + (m.bytes / 1048576).toFixed(1) + ' MB)…');
  const f = await fetch(links.glb.url);
  if (!f.ok) throw new Error('Download failed (' + f.status + ').');
  return f.arrayBuffer();
}

function parse(buf) { return new Promise((res, rej) => new GLTFLoader().parse(buf.slice(0), '', g => res(g.scene), rej)); }

// A small renderer that draws the model from one side into an image.
function snapper(root) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(512, 512); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.5;
  const scene = new THREE.Scene(), pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(2, 3, 4); // moves with the camera, see shot()
  scene.add(new THREE.HemisphereLight(0xffffff, 0x475569, 1.1), key, root);
  const box = new THREE.Box3().setFromObject(root), c = box.getCenter(new THREE.Vector3()), r = box.getSize(new THREE.Vector3()).length() / 2 || 1;
  const camera = new THREE.PerspectiveCamera(30, 1, r / 100, r * 50);
  return {
    // dir: where the camera looks from, e.g. [0, 0, 1] = in front.
    shot(dir, type = 'image/webp', size = 512) {
      if (renderer.domElement.width !== size) renderer.setSize(size, size);
      const d = new THREE.Vector3(...dir).normalize();
      camera.position.copy(c).addScaledVector(d, r / Math.tan(THREE.MathUtils.degToRad(15)) * 1.05);
      camera.up.set(0, 1, 0); if (Math.abs(d.y) > 0.99) camera.up.set(0, 0, -1);
      camera.lookAt(c); key.position.copy(camera.position).add(new THREE.Vector3(r, r * 1.5, 0)); key.target.position.copy(c); key.target.updateMatrixWorld();
      renderer.render(scene, camera);
      return renderer.domElement.toDataURL(type, 0.82);
    },
    dispose() { scene.remove(root); pmrem.dispose(); renderer.dispose(); renderer.forceContextLoss(); }
  };
}

// Phones: tallest side up (y), thinnest side towards the viewer (z). Then Gemini looks at both faces and says which
// one is the screen and whether it's upside down, so the shop opens on the screen with the phone the right way up.
async function standUp(root, onStatus) {
  const size = () => new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
  let s = size();
  if (s.z >= s.x && s.z >= s.y) root.rotateX(-Math.PI / 2); else if (s.x >= s.y && s.x >= s.z) root.rotateZ(Math.PI / 2);
  root.updateMatrixWorld(true); s = size();
  if (s.x < s.z) { root.rotateY(Math.PI / 2); root.updateMatrixWorld(true); }
  const shots = snapper(root), a = shots.shot([0, 0, 1], 'image/jpeg'), b = shots.shot([0, 0, -1], 'image/jpeg'); shots.dispose();
  onStatus && onStatus('AI is checking which side is the screen…');
  try {
    const o = await askJson([{ text: 'Image A and image B show the two flat faces of the same 3D phone model. Which one shows the screen (display side, not the cameras)? And in that image, is the phone upside down (its top edge, with the earpiece / front camera, at the bottom of the picture)? Reply with only JSON: {"screen": "A" or "B", "upsideDown": true or false}' },
      { text: 'Image A' }, { inlineData: { mimeType: 'image/jpeg', data: a.split(',')[1] } }, { text: 'Image B' }, { inlineData: { mimeType: 'image/jpeg', data: b.split(',')[1] } }], onStatus);
    if (o && o.screen === 'B') root.rotateY(Math.PI);
    if (o && o.upsideDown === true) root.rotateZ(Math.PI);
  } catch (e) { console.warn('Could not check the screen side', e); }
  root.updateMatrixWorld(true);
}

// Laptops and other devices: Gemini looks at four sides and says which is the front, which is turned to face +z.
async function faceFront(root, kind, name, onStatus) {
  const shots = snapper(root), dirs = [[0, 0.25, 1], [1, 0.25, 0], [0, 0.25, -1], [-1, 0.25, 0]], pics = dirs.map(d => shots.shot(d, 'image/jpeg')); shots.dispose();
  onStatus && onStatus('AI is checking which side is the front…');
  const what = kind === 'laptop' ? 'a laptop. Its front is the side you sit at: the keyboard faces you and the screen\'s display is visible (not the back of the lid)'
    : '"' + name + '". Its front is the side with the main buttons, display, logo or front ports, the side that faces the user';
  try {
    const o = await askJson([{ text: 'Images A, B, C and D show the same 3D model from four sides. It is ' + what + '. Which image shows the front? Reply with only JSON: {"front": "A", "B", "C" or "D"}' },
      ...pics.map((u, i) => [{ text: 'Image ' + 'ABCD'[i] }, { inlineData: { mimeType: 'image/jpeg', data: u.split(',')[1] } }]).flat()], onStatus);
    const turn = { A: 0, B: -Math.PI / 2, C: Math.PI, D: Math.PI / 2 }[o && o.front];
    if (turn) root.rotateY(turn);
  } catch (e) { console.warn('Could not check the front', e); }
  root.updateMatrixWorld(true);
}

/**
 * Downloaded .glb -> ready for the shop: phones stood upright facing front, textures at most 1024 px, and pictures of
 * it from five sides. Returns { blob (.glb), shots: { front, right, back, left, top } (WebP data URLs) }.
 */
export async function prepareModel(buf, { phone, kind, name, onStatus } = {}) {
  onStatus && onStatus('Preparing the 3D model…');
  const scene = await parse(buf), root = new THREE.Group(); root.add(scene); root.updateMatrixWorld(true);
  if (phone) await standUp(root, onStatus); else await faceFront(root, kind, name || 'this product', onStatus);
  const shots = snapper(root), pics = {};
  [['front', [0, 0, 1]], ['right', [1, 0, 0]], ['back', [0, 0, -1]], ['left', [-1, 0, 0]], ['top', [0.0001, 1, 0.35]]].forEach(([k, d]) => { pics[k] = shots.shot(d); });
  shots.dispose();
  // Textures are saved as JPEG (much smaller than the PNG the exporter would use), except colour maps with see-through parts.
  root.traverse(o => { if (o.isMesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
    for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) {
      const t = m && m[k]; if (!t) continue;
      t.userData.mimeType = k === 'map' && (m.transparent || m.alphaTest > 0) ? 'image/png' : 'image/jpeg';
    }
  }); });
  onStatus && onStatus('Shrinking the 3D model…');
  const out = await new GLTFExporter().parseAsync(root, { binary: true, maxTextureSize: TEX });
  return { blob: new Blob([out], { type: 'model/gltf-binary' }), shots: pics };
}
