// Admin "3D models" tab. Phones: put the phone's real photos on the shop's built-in 3D phone (photo3d.js).
// Other shapes: turn a product photo into .glb models with three AI engines, compare them side by side, and save
// the chosen one to Firestore (in ~900 KB binary chunks, since the free plan has no file storage).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { generate, engines } from './g3d.js';
import { makeSkin } from './photo3d.js';
import { searchImages, pickViews, cropView } from './findphotos.js';

const CHUNK = 900 * 1024, MAX_BYTES = 15 * 1024 * 1024, TOKEN_KEY = 'nonixHfToken', SERPER_KEY = 'nonixSerperKey';
const mb = n => (n / 1048576).toFixed(1) + ' MB';
const pad = i => String(i).padStart(3, '0');

// ---------- Viewer: orbit (rotate / zoom / pan), environment lighting, auto-framing ----------
export function viewer(el, buf, yaw = 0) {
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
    const root = g.scene; fixMaterials(root); root.rotation.y = yaw; scene.add(root);
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
    if (!hasColors && !(m && m.map) && !o.userData.keepMaterial) o.material = new THREE.MeshStandardMaterial({ color: 0x8a94a6, metalness: 0.4, roughness: 0.4 });
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
  const meta = { ver, chunks: n, bytes: u8.length, engine, engineName: (engines[engine] || {}).name || (engine === 'photo' ? 'Photo model' : engine), yaw: (engines[engine] || {}).yaw || 0 };
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

// Phone photos: the trimmed screen and back photos (JPEG data URLs, well under Firestore's 1 MB per document)
// go in productSkins/{pid}; products/{pid}.skin tells the shop they exist and which version to load.
export async function saveSkin(db, pid, skin) {
  const meta = { ver: Date.now().toString(36), aspect: skin.aspect, colour: skin.colour };
  await db.doc('productSkins/' + pid).set({ ...meta, front: skin.front, back: skin.back, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
  await db.doc('products/' + pid).set({ skin: meta }, { merge: true });
  return meta;
}
export async function deleteSkin(db, pid) {
  await db.doc('productSkins/' + pid).delete().catch(() => {});
  await db.doc('products/' + pid).update({ skin: firebase.firestore.FieldValue.delete() }).catch(() => {});
}

// ---------- Tab ----------
export async function show3d(app, { db, toast, esc }) {
  const products = (await db.collection('products').get()).docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.sort || 0) - (b.sort || 0));
  let token = ''; try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) {}
  let serperKey = ''; try { serperKey = localStorage.getItem(SERPER_KEY) || ''; } catch (e) {}
  let photo = null, results = {};
  app.innerHTML = `<h1>3D models</h1>
  <div class="list">
    <div class="card list">
      <div class="grid">
        <label>Product<select id="m-pid">${products.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label>
      </div>
      <div id="m-current" class="muted"></div>
    </div>
    <div class="card list">
      <b>Phone photos (recommended for phones)</b>
      <span class="muted">Puts this phone's real photos on the shop's built-in 3D phone: the front photo becomes the screen and the back photo the back cover. It always looks like a phone, and Exploded and X-Ray still show the battery, board, chips and camera with your spec labels. It starts with this product's 360° photos; click a box to use a different photo. Use photos of the whole phone, straight on, on a plain background.</span>
      <div class="photos" id="pm-slots" style="max-width:300px"></div>
      <details id="pf"><summary style="cursor:pointer"><b>Find photos online</b> <span class="muted">· search Google Images and let the AI pick the front and back</span></summary>
        <div class="list" style="margin-top:10px">
          <div class="row"><input id="pf-q" placeholder="Phone name, e.g. itel S25 Ultra" style="max-width:360px"><button class="btn" id="pf-go" type="button">Search</button><span class="muted" id="pf-status"></span></div>
          <details><summary class="muted" style="cursor:pointer">Serper API key (needed once)</summary>
            <div class="row" style="margin-top:8px"><input id="pf-key" type="password" autocomplete="off" placeholder="Serper API key" value="${esc(serperKey)}" style="max-width:360px">
            <button class="btn" type="button" id="pf-key-save">Save</button></div>
            <span class="muted">Sign up free at <a href="https://serper.dev" target="_blank" rel="noopener">serper.dev</a> (2,500 free searches) and copy your API key. It is saved only in this browser, never on the website.</span>
          </details>
          <div id="pf-out"></div>
          <span class="muted">Photos belong to whoever took them. Prefer the maker's official site (shown under each photo).</span>
        </div>
      </details>
      <div class="row"><button class="btn primary" id="pm-go" type="button">Build 3D Phone</button><span class="muted" id="pm-note">Runs by itself once a front and a back are picked.</span></div>
      <div id="pm-out"></div>
    </div>
    <details id="ai-card"><summary style="cursor:pointer;margin:4px 0 10px"><b>Other shapes (laptops, mini PCs…): AI model from one photo</b> <span class="muted">· not for phones</span></summary>
    <div class="list">
    <div class="card list">
      <b>AI model from one photo: other shapes</b>
      <label style="max-width:220px">Photo angle<select id="m-angle"><option>Front</option><option>Back</option><option>Side</option></select></label>
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
    </div></details>
  </div>`;
  const $ = id => document.getElementById(id), pidSel = $('m-pid');

  async function showCurrent() {
    const p = products.find(x => x.id === pidSel.value), m = p && p.model3d, el = $('m-current');
    if (!m && p && p.skin) {
      el.innerHTML = `<div class="row">Current 3D model: <b>built-in phone with this phone's photos</b> <a class="btn" style="display:inline-grid;place-items:center;text-decoration:none" href="/shop/?product=${encodeURIComponent(p.id)}" target="_blank" rel="noopener">Open in shop ↗</a> <button class="btn danger" id="m-skin-del" type="button">Remove photos</button></div>`;
      $('m-skin-del').onclick = async () => {
        if (!confirm('Remove the photos from the 3D phone for ' + p.name + '? The shop will show the plain built-in phone.')) return;
        await deleteSkin(db, p.id); delete p.skin; toast('Photos removed from the 3D phone'); showCurrent();
      };
      return;
    }
    if (!m) { el.innerHTML = 'Current 3D model: <b>none</b>, the shop shows the built-in ' + esc(p ? p.model || 'phone' : '') + ' shape.'; return; }
    el.innerHTML = `<div class="row">Current 3D model: <b>${esc(m.engineName || m.engine)}</b> · ${mb(m.bytes)} <button class="btn" id="m-cur-view" type="button">Preview</button> <button class="btn danger" id="m-cur-del" type="button">Remove (use built-in shape)</button></div><div id="m-cur-box"></div>`;
    $('m-cur-view').onclick = async () => {
      const box = $('m-cur-box'); box.innerHTML = '<div style="height:320px;max-width:520px;margin-top:10px;border:1px solid var(--line);border-radius:12px;position:relative"><p class="muted" style="padding:12px">Loading…</p></div>';
      try { viewer(box.firstChild, await loadModel(db, m, p.id), m.yaw ?? (engines[m.engine] || {}).yaw ?? 0); } catch (e) { box.innerHTML = '<p class="err">' + esc(e.message) + '</p>'; }
    };
    $('m-cur-del').onclick = async () => {
      if (!confirm('Remove the 3D model from ' + p.name + '? The shop will show the built-in shape.')) return;
      await deleteModel(db, p.id); delete p.model3d; toast('3D model removed'); showCurrent();
    };
  }
  // ---------- Phone photos (skin for the built-in phone) ----------
  const PM_SLOTS = [['front', 'Front'], ['back', 'Back']];
  let pmPhotos = {};
  const drawPmSlots = () => {
    $('pm-slots').innerHTML = PM_SLOTS.map(([k, l]) => `<label class="slot"><input type="file" accept="image/*" data-pm="${k}" hidden>
      <div class="img" style="${pmPhotos[k] ? `background-image:url('${esc(pmPhotos[k])}')` : ''}">${pmPhotos[k] ? '' : '+'}</div>
      <div class="lbl"><span>${l}</span>${pmPhotos[k] ? `<button type="button" data-pm-clear="${k}">Remove</button>` : ''}</div></label>`).join('');
  };
  async function loadPmPhotos() {
    $('pm-out').innerHTML = ''; $('pm-note').textContent = ''; $('pf-out').innerHTML = ''; $('pf-status').textContent = '';
    $('pf-q').value = (products.find(x => x.id === pidSel.value) || {}).name || '';
    const ph = await db.doc('productPhotos/' + pidSel.value).get().then(d => d.exists ? d.data() : {}).catch(() => ({}));
    pmPhotos = {}; PM_SLOTS.forEach(([k]) => { if (typeof ph[k] === 'string') pmPhotos[k] = ph[k]; });
    drawPmSlots();
  }
  $('pm-slots').onchange = e => {
    const k = e.target.dataset.pm, f = e.target.files[0]; if (!k || !f) return;
    if (!/^image\//.test(f.type)) { toast('Please choose an image file'); return; }
    pmPhotos[k] = URL.createObjectURL(f); drawPmSlots(); autoBuild();
  };
  $('pm-slots').onclick = e => { const k = e.target.dataset.pmClear; if (k) { e.preventDefault(); delete pmPhotos[k]; drawPmSlots(); } };
  // Find photos online: Serper image search -> Gemini picks front/back views -> click one to use it.
  $('pf-key-save').onclick = () => { serperKey = $('pf-key').value.trim(); try { serperKey ? localStorage.setItem(SERPER_KEY, serperKey) : localStorage.removeItem(SERPER_KEY); } catch (e) {} toast(serperKey ? 'Serper key saved in this browser' : 'Serper key removed'); };
  let pfViews = { front: [], back: [] };
  $('pf-go').onclick = async () => {
    const q = $('pf-q').value.trim(), st = $('pf-status'), out = $('pf-out'), btn = $('pf-go');
    if (!q) { toast('Type the phone name'); return; }
    if (!serperKey) { $('pf').querySelector('details').open = true; toast('Add your Serper API key first'); return; }
    btn.disabled = true; out.innerHTML = ''; st.textContent = 'Searching…';
    try {
      const results = await searchImages(q + ' front and back', serperKey);
      if (!results.length) throw new Error('No photos found. Try a different name.');
      pfViews = await pickViews(q, results, s => { st.textContent = s; });
      st.textContent = pfViews.front.length || pfViews.back.length ? 'Pick a back and a front, or use the AI\'s best picks.' : '';
      const row = (k, label) => {
        const vs = pfViews[k].slice(0, 8);
        return `<div><b>${label}</b> <span class="muted">(${pfViews[k].length} found)</span>
          ${vs.length ? `<div class="photos" style="margin-top:6px">${vs.map((v, i) => `<div class="slot" data-pf="${k}:${i}" title="Use this as the ${k}">
            <div class="img" data-pf-img="${k}:${i}"><span class="muted" style="font-size:12px">…</span></div>
            <div class="lbl"><a href="${esc(v.link || v.url)}" target="_blank" rel="noopener" class="muted" style="font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(v.domain || 'source')}</a></div></div>`).join('')}</div>`
            : '<p class="muted" style="margin:6px 0 0">None found. Try another search or upload a photo.</p>'}</div>`;
      };
      out.innerHTML = (pfViews.front.length && pfViews.back.length ? '<div class="row"><button class="btn primary" id="pf-best" type="button">Use AI\'s best picks and build</button></div>' : '')
        + row('back', 'Back') + row('front', 'Front');
      for (const k of ['back', 'front']) pfViews[k].slice(0, 8).forEach((v, i) => cropView(v, 360)
        .then(u => { const el = out.querySelector(`[data-pf-img="${k}:${i}"]`); if (el) { el.style.backgroundImage = `url('${u}')`; el.innerHTML = ''; } })
        .catch(() => { const el = out.querySelector(`[data-pf="${k}:${i}"]`); if (el) el.remove(); }));
    } catch (err) { st.textContent = ''; out.innerHTML = `<p class="err">${esc(err.message)}</p>`; }
    btn.disabled = false;
  };
  const pick = async (k, i) => {
    const v = pfViews[k][i]; if (!v) return;
    $('pf-status').textContent = 'Getting the full-size ' + k + ' photo…';
    pmPhotos[k] = await cropView(v); drawPmSlots();
    $('pf-out').querySelectorAll(`[data-pf^="${k}:"]`).forEach(el => { el.style.outline = el.dataset.pf === k + ':' + i ? '2px solid var(--accent, #10b981)' : ''; });
    $('pf-status').textContent = (k === 'front' ? 'Front' : 'Back') + ' set.' + (pmPhotos.front && pmPhotos.back ? '' : ' Now pick the ' + (k === 'front' ? 'back' : 'front') + '.');
  };
  $('pf-out').onclick = async e => {
    if (e.target.id === 'pf-best') {
      try { await pick('back', 0); await pick('front', 0); autoBuild(); } catch (err) { $('pf-status').textContent = 'Could not get those photos. Pick others.'; }
      return;
    }
    const tile = e.target.closest('[data-pf]'); if (!tile || e.target.closest('a')) return;
    const [k, i] = tile.dataset.pf.split(':');
    try { await pick(k, Number(i)); autoBuild(); } catch (err) { $('pf-status').textContent = 'Could not get that photo. Try another one.'; }
  };

  // Front + back -> cut out -> save on the product -> show the finished 3D phone from the shop. No extra clicks.
  let building = false;
  function autoBuild() { if (pmPhotos.front && pmPhotos.back) build3dPhone(); }
  async function build3dPhone() {
    if (building) return;
    const p = products.find(x => x.id === pidSel.value), btn = $('pm-go'), note = $('pm-note'), out = $('pm-out');
    if (p.model && p.model !== 'phone') { out.innerHTML = `<p class="err">${esc(p.name)}'s 3D model shape is not "Phone". Change it under Products first.</p>`; return; }
    if (!pmPhotos.front || !pmPhotos.back) { out.innerHTML = '<p class="err">Add a front and a back photo first.</p>'; return; }
    building = true; btn.disabled = true; out.innerHTML = '';
    try {
      note.textContent = '1/3 Cutting the phone out of the photos…';
      const skin = await makeSkin(pmPhotos);
      note.textContent = '2/3 Saving on ' + p.name + '…';
      p.skin = await saveSkin(db, p.id, skin);
      if (p.model3d) { await deleteModel(db, p.id); delete p.model3d; }
      note.textContent = '3/3 Done. This is the shop page (drag to turn it, try Exploded and X-Ray):';
      showCurrent();
      out.innerHTML = `<div class="row" style="align-items:flex-end;margin:4px 0 8px">
          <figure style="margin:0"><img src="${skin.back}" style="height:120px;border-radius:8px;border:1px solid var(--line)"><figcaption class="muted">Back cover</figcaption></figure>
          <figure style="margin:0"><img src="${skin.front}" style="height:120px;border-radius:8px;border:1px solid var(--line)"><figcaption class="muted">Screen</figcaption></figure>
          <span class="muted">Wrong photo or background left around the phone? Pick or upload another and it rebuilds.</span></div>
        <iframe src="/shop/?product=${encodeURIComponent(p.id)}&v=${p.skin.ver}" title="Shop preview" style="width:100%;height:640px;border:1px solid var(--line);border-radius:12px;background:#0b0f19"></iframe>`;
      toast('3D phone ready for ' + p.name);
    } catch (err) { note.textContent = ''; out.innerHTML = `<p class="err">${esc(err.message)}</p>`; }
    building = false; btn.disabled = false;
  }
  $('pm-go').onclick = build3dPhone;

  const openAi = () => { const p = products.find(x => x.id === pidSel.value); $('ai-card').open = !!(p && p.model && p.model !== 'phone'); };
  pidSel.onchange = () => { showCurrent(); renderCards(); loadPmPhotos(); openAi(); };
  showCurrent(); loadPmPhotos(); openAi();

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
    Object.entries(results).forEach(([k, r]) => { if (r.buf) viewer(document.querySelector(`[data-engine="${k}"] .m-view`), r.buf, engines[k].yaw); });
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
