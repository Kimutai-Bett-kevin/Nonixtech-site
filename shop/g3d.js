// Image-to-3D through public Hugging Face Spaces (Gradio queue API), called straight from the browser.
// Three engines: Stable Fast 3D, InstantMesh, Hunyuan3D-2. Each Space removes the background itself.
// Works in browsers and Node 18+ (fetch + streams). An optional Hugging Face token raises the free GPU quota.

const ENGINES = {
  sf3d: {
    name: 'Stable Fast 3D', note: 'Fast, textured (successor to TripoSR)',
    yaw: Math.PI, // its model faces away from the photo's camera; turn it round so the photographed side is in front
    base: 'https://stabilityai-stable-fast-3d.hf.space', prefix: '',
    async run(c, img, onStatus) {
      // The Space's main button runs twice: "Remove Background" (fills its session state), then "Run".
      await c.call(5, ['Remove Background', img, null, 0.85, 'None', -1, 1024], 13);
      onStatus && onStatus('Background removed, building model…');
      const out = await c.call(5, ['Run', img, null, 0.85, 'None', -1, 1024], 13);
      return out[4];
    }
  },
  instantmesh: {
    name: 'InstantMesh', note: 'Multi-view reconstruction (Tencent ARC)', yaw: 0,
    base: 'https://tencentarc-instantmesh.hf.space', prefix: '/gradio_api',
    async run(c, img) {
      const [clean] = await c.call(2, [img, true], null);
      await c.call(3, [clean, 75, 42], null);
      const out = await c.call(4, [null], null);
      return out[1];
    }
  },
  hunyuan: {
    name: 'Hunyuan3D-2', note: 'High detail, PBR texture (slowest)', yaw: 0,
    base: 'https://tencent-hunyuan3d-2.hf.space', prefix: '',
    async run(c, img, onStatus) {
      const args = ['', img, null, null, null, null, 30, 5, 1234, 256, true, 8000, false];
      try {
        const out = await c.call(8, args, 19); // shape + texture
        return out[1] || out[0];
      } catch (e) {
        if (/quota/i.test(e.message)) throw e;
        // The Space's texture step is sometimes broken; fall back to the untextured shape.
        onStatus && onStatus('Texture step failed, making the plain shape…');
        const out = await c.call(5, args, 18);
        return out[0];
      }
    }
  }
};

function client(engine, { token, onStatus } = {}) {
  const e = ENGINES[engine], root = e.base + e.prefix, session = Math.random().toString(36).slice(2, 13);
  const auth = token ? { Authorization: 'Bearer ' + token } : {};
  const fileUrl = f => f && (f.url || (f.path ? root + '/file=' + f.path : null));
  return {
    async upload(blob, name) {
      const fd = new FormData(); fd.append('files', blob, name || 'photo.png');
      const r = await fetch(root + '/upload', { method: 'POST', body: fd, headers: auth });
      if (!r.ok) throw new Error('Upload failed (' + r.status + ')');
      const [path] = await r.json();
      return { path, orig_name: name || 'photo.png', meta: { _type: 'gradio.FileData' } };
    },
    async call(fnIndex, data, triggerId) {
      const j = await fetch(root + '/queue/join', { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({ data, fn_index: fnIndex, session_hash: session, event_data: null, trigger_id: triggerId }) });
      if (!j.ok) throw new Error('Queue join failed (' + j.status + ')');
      const { event_id } = await j.json();
      const r = await fetch(root + '/queue/data?session_hash=' + session, { headers: auth });
      const reader = r.body.getReader(), dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 2);
          if (!line.startsWith('data:')) continue;
          const m = JSON.parse(line.slice(5));
          if (m.event_id && m.event_id !== event_id) continue;
          if (m.msg === 'estimation' && onStatus) onStatus('In queue' + (m.rank != null ? ' (position ' + (m.rank + 1) + ')' : ''));
          if (m.msg === 'process_starts' && onStatus) onStatus('Working on GPU…');
          if (m.msg === 'progress' && onStatus && m.progress_data && m.progress_data[0]) { const p = m.progress_data[0]; onStatus((p.desc || 'Working') + (p.index != null && p.length ? ' ' + p.index + '/' + p.length : '')); }
          if (m.msg === 'process_completed') {
            reader.cancel().catch(() => {});
            if (!m.success) throw new Error(friendly(m.output && (m.output.error || m.output.title)));
            return m.output.data;
          }
        }
      }
      throw new Error('Connection closed before the result arrived');
    },
    fileUrl
  };
}

function friendly(err) {
  const s = String(err || 'Unknown error');
  if (/quota|ZeroGPU|GPU duration|exceeded/i.test(s)) return 'Free GPU quota used up for now. Add a Hugging Face token in settings or try again later. (' + s.slice(0, 160) + ')';
  return 'The 3D engine returned an error: ' + s.slice(0, 200);
}

// Returns { engine, name, blob (model/gltf-binary), bytes }.
export async function generate(engine, imageBlob, opts = {}) {
  const e = ENGINES[engine]; if (!e) throw new Error('Unknown engine ' + engine);
  const c = client(engine, opts);
  opts.onStatus && opts.onStatus('Uploading photo…');
  const img = await c.upload(imageBlob, opts.fileName);
  const out = await e.run(c, img, opts.onStatus);
  const url = c.fileUrl(out && (out.value || out));
  if (!url) throw new Error('The engine finished but returned no model');
  opts.onStatus && opts.onStatus('Downloading model…');
  const r = await fetch(url, { headers: opts.token ? { Authorization: 'Bearer ' + opts.token } : {} });
  if (!r.ok) throw new Error('Could not download the model (' + r.status + ')');
  const buf = await r.arrayBuffer(), magic = new TextDecoder().decode(new Uint8Array(buf, 0, 4));
  if (magic !== 'glTF') throw new Error('The engine returned a file that is not a .glb model');
  return { engine, name: e.name, blob: new Blob([buf], { type: 'model/gltf-binary' }), bytes: buf.byteLength };
}

export const engines = Object.fromEntries(Object.entries(ENGINES).map(([k, v]) => [k, { name: v.name, note: v.note, yaw: v.yaw }]));
