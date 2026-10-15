// Admin "3D models" tab: turn a product photo into .glb models with three AI engines, compare them
// side by side, and save the chosen one to Firestore (in ~900 KB binary chunks, since the free plan has no file storage).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { generate, engines } from './g3d.js';

const CHUNK = 900 * 1024, MAX_BYTES = 15 * 1024 * 1024, TOKEN_KEY = 'nonixHfToken';
const mb = n => (n / 1048576).toFixed(1) + ' MB';
const pad = i => String(i).padStart(3, '0');

// ---------- Viewer: orbit (rotate / zoom / pan), environment lighting, auto-framing ----------
export function viewer(el, buf) {
  const W = () => el.clientWidth || 300, H = () => el.clientHeight || 300;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); renderer.setSize(W(), H());
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping;
  el.innerHTML = ''; el.appendChild(renderer.domElement);
  const scene = new THREE.Scene(), pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 0.6));
  const camera = new THREE.PerspectiveCamera(35, W() / H(), 0.01, 100);
  const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.autoRotate = true; controls.autoRotateSpeed = 1.2;
  renderer.domElement.addEventListener('pointerdown', () => { controls.autoRotate = false; }, { once: true });
  new GLTFLoader().parse(buf.slice(0), '', g => {
    const root = g.scene; fixMaterials(root); scene.add(root);
    const box = new THREE.Box3().setFromObject(root), size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    root.position.sub(c); const r = Math.max(size.x, size.y, size.z) || 1;
    camera.position.set(r * 1.1, r * 0.6, r * 1.6); camera.near = r / 100; camera.far = r * 50; camera.updateProjectionMatrix();
    controls.target.set(0, 0, 0); controls.update();
  }, e => { el.innerHTML = '<p class="err" style="padding:12px">Could not display this model: ' + String(e && e.message || e).slice(0, 120) + '</p>'; });
  let alive = true;
  const loop = () => {
    if (!alive) return;
    if (!el.isConnected) return dispose(); // tab changed
    if (renderer.domElement.width !== Math.round(W() * renderer.getPixelRatio())) { renderer.setSize(W(), H()); camera.aspect = W() / H(); camera.updateProjectionMatrix(); }
    controls.update(); renderer.render(scene, camera); requestAnimationFrame(loop);
  };
  function dispose() { alive = false; controls.dispose(); pmrem.dispose(); renderer.dispose(); renderer.forceContextLoss(); }
  loop();
  return dispose;
}

// Meshes with no texture and no vertex colours (e.g. a plain shape) get a neutral material so they still look solid.
export function fixMaterials(root) {
  root.traverse(o => {
    if (!o.isMesh) return;
    const hasColors = !!o.geometry.getAttribute('color');
    (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { if (m && hasColors) { m.vertexColors = true; m.needsUpdate = true; } });
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (!hasColors && !(m && m.map)) o.material = new THREE.MeshStandardMaterial({ color: 0x8a94a6, metalness: 0.4, roughness: 0.4 });
    if (!o.geometry.getAttribute('normal')) o.geometry.computeVertexNormals();
  });
}

// ---------- Firestore storage ----------
export async function saveModel(db, pid, engine, blob) {
  const u8 = new Uint8Array(await blob.arrayBuffer());
  if (u8.length > MAX_BYTES) throw new Error('Model is ' + mb(u8.length) + '; the limit is ' + mb(MAX_BYTES) + '.');
  const prev = await db.doc('productModels/' + pid).get().then(d => d.exists ? d.data() : null).catch(() => null);
  const ver = Date.now().toString(36), n = Math.ceil(u8.length / CHUNK), B = firebase.firestore.Blob;
  for (let i = 0; i < n; i++)
    await db.doc(`productModels/${pid}/chunks/${ver}_${pad(i)}`).set({ ver, i, data: B.fromUint8Array(u8.subarray(i * CHUNK, (i + 1) * CHUNK)) });
  const meta = { ver, chunks: n, bytes: u8.length, engine, engineName: (engines[engine] || {}).name || engine };
  await db.doc('productModels/' + pid).set({ ...meta, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
  await db.doc('products/' + pid).set({ model3d: meta }, { merge: true }); // the shop reads this to know which chunks to load
  if (prev && prev.ver && prev.ver !== ver) await deleteChunks(db, pid, prev.ver, prev.chunks);
  return meta;
}
export async function loadModel(db, meta, pid) {
  const docs = await Promise.all(Array.from({ length: meta.chunks }, (_, i) => db.doc(`productModels/${pid}/chunks/${meta.ver}_${pad(i)}`).get()));
  if (docs.some(d => !d.exists)) throw new Error('Model is incomplete');
  const parts = docs.map(d => d.data().data.toUint8Array()), out = new Uint8Array(parts.reduce((a, x) => a + x.length, 0));
  let o = 0; parts.forEach(x => { out.set(x, o); o += x.length; });
  return out.buffer;
}
async function deleteChunks(db, pid, ver, n) { for (let i = 0; i < (n || 0); i++) await db.doc(`productModels/${pid}/chunks/${ver}_${pad(i)}`).delete().catch(() => {}); }
export async function deleteModel(db, pid) {
  const meta = await db.doc('productModels/' + pid).get().then(d => d.exists ? d.data() : null).catch(() => null);
  if (meta) await deleteChunks(db, pid, meta.ver, meta.chunks);
  await db.doc('productModels/' + pid).delete().catch(() => {});
  await db.doc('products/' + pid).update({ model3d: firebase.firestore.FieldValue.delete() }).catch(() => {});
}

// ---------- Tab ----------
export async function show3d(app, { db, toast, esc }) {
  const products = (await db.collection('products').get()).docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.sort || 0) - (b.sort || 0));
  let token = ''; try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) {}
  let photo = null, results = {};
  app.innerHTML = `<h1>3D models</h1>
  <div class="list">
    <div class="card list">
      <div class="grid">
        <label>Product<select id="m-pid">${products.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label>
        <label>Photo angle<select id="m-angle"><option>Front</option><option>Back</option><option>Side</option></select></label>
      </div>
      <div id="m-current" class="muted"></div>
    </div>
    <div class="card list">
      <b>1. Product photo</b>
      <span class="muted">Best results: one product, whole item in frame, plain background, good light. The engines remove the background themselves.</span>
      <label class="slot" style="max-width:220px;aspect-ratio:1"><div class="img" id="m-photo">＋</div><div class="lbl"><span id="m-photo-name">Choose photo</span></div>
        <input id="m-file" type="file" accept="image/*" hidden></label>
      <details><summary class="muted" style="cursor:pointer">Hugging Face token (optional, for more free GPU time)</summary>
        <div class="row" style="margin-top:8px"><input id="m-token" type="password" autocomplete="off" placeholder="hf_…" value="${esc(token)}" style="max-width:360px">
        <button class="btn" type="button" id="m-token-save">Save</button></div>
        <span class="muted">Without a token the free GPUs allow only a few models a day. Create a free "Read" token at <a href="https://huggingface.co/settings/tokens" target="_blank" rel="noopener">huggingface.co/settings/tokens</a>. It is saved only in this browser, never on the website.</span>
      </details>
      <div class="row"><button class="btn primary" id="m-go" disabled>Generate 3D Assets (All 3 Engines)</button><span class="muted" id="m-go-note">Choose a photo first.</span></div>
    </div>
    <div class="grid" id="m-cards" style="grid-template-columns:repeat(auto-fit,minmax(280px,1fr))"></div>
  </div>`;
  const $ = id => document.getElementById(id), pidSel = $('m-pid');

  async function showCurrent() {
    const p = products.find(x => x.id === pidSel.value), m = p && p.model3d, el = $('m-current');
    if (!m) { el.innerHTML = 'Current 3D model: <b>none</b>, the shop shows the built-in ' + esc(p ? p.model || 'phone' : '') + ' shape.'; return; }
    el.innerHTML = `<div class="row">Current 3D model: <b>${esc(m.engineName || m.engine)}</b> · ${mb(m.bytes)} <button class="btn" id="m-cur-view" type="button">Preview</button> <button class="btn danger" id="m-cur-del" type="button">Remove (use built-in shape)</button></div><div id="m-cur-box"></div>`;
    $('m-cur-view').onclick = async () => {
      const box = $('m-cur-box'); box.innerHTML = '<div style="height:320px;max-width:520px;margin-top:10px;border:1px solid var(--line);border-radius:12px;position:relative"><p class="muted" style="padding:12px">Loading…</p></div>';
      try { viewer(box.firstChild, await loadModel(db, m, p.id)); } catch (e) { box.innerHTML = '<p class="err">' + esc(e.message) + '</p>'; }
    };
    $('m-cur-del').onclick = async () => {
      if (!confirm('Remove the 3D model from ' + p.name + '? The shop will show the built-in shape.')) return;
      await deleteModel(db, p.id); delete p.model3d; toast('3D model removed'); showCurrent();
    };
  }
  pidSel.onchange = () => { showCurrent(); renderCards(); };
  showCurrent();

  $('m-file').onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    if (!/^image\//.test(f.type)) { toast('Please choose an image file'); return; }
    if (f.size > 10 * 1024 * 1024) { toast('Photo is too large (max 10 MB)'); return; }
    photo = f; $('m-photo').style.backgroundImage = `url("${URL.createObjectURL(f)}")`; $('m-photo').textContent = '';
    $('m-photo-name').textContent = f.name.slice(0, 28); $('m-go').disabled = false; $('m-go-note').textContent = 'Takes about 30 seconds to 3 minutes.';
  };
  $('m-token-save').onclick = () => { token = $('m-token').value.trim(); try { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY); } catch (e) {} toast(token ? 'Token saved in this browser' : 'Token removed'); };

  function renderCards() {
    $('m-cards').innerHTML = Object.entries(engines).map(([k, e]) => {
      const r = results[k] || {};
      return `<div class="card list" data-engine="${k}">
        <div><b>${esc(e.name)}</b><div class="muted">${esc(e.note)}</div></div>
        <div class="m-view" style="height:280px;border:1px solid var(--line);border-radius:12px;position:relative;overflow:hidden;display:grid;place-items:center;background:rgba(11,15,25,.5)">
          <span class="muted" style="padding:12px;text-align:center">${esc(r.status || (r.error ? '' : 'Waiting for a photo'))}</span>${r.error ? `<p class="err" style="padding:12px">${esc(r.error)}</p>` : ''}</div>
        <div class="row"><span class="muted grow">${r.blob ? mb(r.bytes) + ' · ' + r.secs + ' s' : ''}</span>
          ${r.blob ? `<a class="btn" style="display:inline-grid;place-items:center;text-decoration:none" download="${esc(pidSel.value + '-' + k)}.glb" href="${r.href}">Download .glb</a><button class="btn primary" data-use="${k}">Use This Model</button>` : ''}</div>
      </div>`;
    }).join('');
    Object.entries(results).forEach(([k, r]) => { if (r.buf) viewer(document.querySelector(`[data-engine="${k}"] .m-view`), r.buf); });
  }
  renderCards();

  $('m-cards').onclick = async e => {
    const k = e.target.dataset.use; if (!k) return;
    const p = products.find(x => x.id === pidSel.value), r = results[k];
    e.target.disabled = true; e.target.textContent = 'Saving…';
    try { p.model3d = await saveModel(db, p.id, k, r.blob); toast(engines[k].name + ' model saved for ' + p.name); showCurrent(); }
    catch (err) { toast('Could not save: ' + err.message); }
    e.target.disabled = false; e.target.textContent = 'Use This Model';
  };

  $('m-go').onclick = () => {
    if (!photo) return;
    $('m-go').disabled = true; results = {};
    const t0 = Date.now(), angle = $('m-angle').value.toLowerCase();
    const jobs = Object.keys(engines).map(k => {
      results[k] = { status: 'Starting…' };
      const setStatus = s => { results[k].status = s; const el = document.querySelector(`[data-engine="${k}"] .m-view span`); if (el) el.textContent = s; };
      return generate(k, photo, { token, fileName: angle + '-' + (photo.name || 'photo.jpg'), onStatus: setStatus })
        .then(async r => { const buf = await r.blob.arrayBuffer(); results[k] = { blob: r.blob, buf, bytes: r.bytes, secs: Math.round((Date.now() - t0) / 1000), href: URL.createObjectURL(r.blob) }; })
        .catch(err => { results[k] = { error: err.message }; })
        .finally(() => { if ($('m-cards')) renderCards(); });
    });
    renderCards();
    Promise.allSettled(jobs).then(() => { const b = $('m-go'); if (b) b.disabled = false; });
  };
}
