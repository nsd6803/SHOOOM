import {
  Input, Output, Conversion, BlobSource, BufferTarget, Mp4OutputFormat, ALL_FORMATS,
  QUALITY_MEDIUM, QUALITY_HIGH, QUALITY_VERY_HIGH, VideoSample, getFirstEncodableVideoCodec,
} from 'mediabunny';
import { EFFECT_MAP, EFFECTS, GROUPS, PRESETS } from './effects.js';
import { Renderer } from './renderer.js';
import { icon, hydrateIcons } from './icons.js';

const $ = s => document.querySelector(s);
const cv = $('#cv');
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- icons + theme ---------- */
hydrateIcons();
$('#playBtn').innerHTML = icon('play');
$('#muteBtn').innerHTML = icon('volume');
const themeBtn = $('#themeBtn');
const syncTheme = () => {
  const d = document.documentElement.classList.contains('dark');
  themeBtn.innerHTML = icon(d ? 'sun' : 'moon');
  themeBtn.title = d ? 'Light theme' : 'Dark theme';
};
themeBtn.onclick = () => {
  const d = document.documentElement.classList.toggle('dark');
  try { localStorage.setItem('shooom.theme', d ? 'dark' : 'light'); } catch { }
  syncTheme();
};
syncTheme();
// the ASCII glyph atlas draws with JetBrains Mono, which no longer appears in the DOM: fetch it explicitly
try { document.fonts.load('700 52px "JetBrains Mono"'); } catch { }

let R;
try { R = new Renderer(cv); }
catch (e) {
  $('#empty').innerHTML = `<div class="ico">${icon('info', 24)}</div><h1>Oops<em>…</em></h1><p>${esc(e.message)}. Open this page in an up-to-date Chrome, Edge, Safari or Firefox.</p>`;
  throw e;
}

const state = { media: null, stack: [], preview: 'fast', bypass: false, seed: 0, exporting: false };
let uid = 0;
const mk = (type, over = {}) => {
  const def = EFFECT_MAP[type], p = {};
  def.params.forEach(x => { if (x.type !== 'head') p[x.id] = over[x.id] ?? x.def; });
  return { uid: ++uid, type, on: true, open: true, p };
};

/* ---------- persistence (per-browser convenience only) ---------- */
let saveT = 0;
const persist = () => {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    try { localStorage.setItem('shooom.stack', JSON.stringify(state.stack.map(({ type, on, open, p }) => ({ type, on, open, p })))); } catch { }
  }, 250);
};
try {
  const a = JSON.parse(localStorage.getItem('shooom.stack') || 'null');
  if (Array.isArray(a)) state.stack = a.filter(e => EFFECT_MAP[e.type]).map(e => ({ ...mk(e.type, e.p), on: e.on !== false, open: !!e.open }));
} catch { }

/* ---------- toast ---------- */
let toastT = 0;
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms);
}

/* ---------- media ---------- */
const fmtTime = s => { s = Math.max(0, s || 0); const m = Math.floor(s / 60); return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`; };
const fmtSize = b => b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
const baseName = n => (n || 'file').replace(/\.[^.]+$/, '');

async function openFile(file) {
  if (!file || state.exporting) return;
  const isVideo = file.type.startsWith('video/') || /\.(mp4|mov|webm|mkv|m4v|avi)$/i.test(file.name);
  const isImage = file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name);
  if (!isVideo && !isImage) return toast('Please choose a photo or video file');
  try { isVideo ? await openVideo(file) : await openImage(file); }
  catch (e) { console.error(e); toast('Could not open: ' + (e.message || e), 4200); }
}

async function openImage(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { throw new Error(/heic|heif/i.test(file.name) ? 'the browser cannot read HEIC — save it as JPG' : 'unsupported format'); }
  setMedia({ kind: 'image', name: file.name, file, w: bmp.width, h: bmp.height, el: bmp });
}

function openVideo(file) {
  return new Promise((res, rej) => {
    const v = document.createElement('video');
    v.playsInline = true; v.loop = true; v.preload = 'auto';
    v.src = URL.createObjectURL(file);
    v.onloadeddata = () => {
      v.onloadeddata = null;
      setMedia({ kind: 'video', name: file.name, file, w: v.videoWidth, h: v.videoHeight, el: v, dur: v.duration });
      res();
    };
    v.onerror = () => rej(new Error('the browser cannot play this format/codec'));
  });
}

function setMedia(m) {
  const old = state.media;
  if (old?.kind === 'video') { old.el.pause(); URL.revokeObjectURL(old.el.src); old.el.removeAttribute('src'); old.el.load(); }
  else if (old?.el?.close) old.el.close();
  state.media = m;
  $('#empty').hidden = true; $('#frame').hidden = false;
  $('#transport').hidden = m.kind !== 'video';
  $('#exportBtn').disabled = false;
  const kind = m.kind === 'video' ? 'Video' : 'Photo';
  const fi = $('#fileInfo'); fi.classList.add('live');
  fi.innerHTML = `<i class="led"></i><b>${esc(m.name)}</b><span>${m.w}×${m.h}</span><span>${kind}${m.dur ? ' · ' + fmtTime(m.dur) : ''}</span>`;
  if (m.kind === 'video') {
    const v = m.el;
    v.addEventListener('seeked', () => { if (!state.exporting) { R.upload(v, m.w, m.h); requestRender(); } });
    v.addEventListener('play', syncTransport); v.addEventListener('pause', syncTransport);
    v.addEventListener('timeupdate', syncTransport);
  }
  layoutPreview();
  R.upload(m.el, m.w, m.h);
  syncTransport();
  requestRender();
}

function fullSize(w, h) {
  const s = Math.min(1, R.maxSize / Math.max(w, h));
  return [Math.round(w * s), Math.round(h * s)];
}

function layoutPreview() {
  const m = state.media; if (!m) return;
  const cap = state.preview === 'full' ? R.maxSize : 1600;
  const s = Math.min(1, cap / Math.max(m.w, m.h));
  R.setSize(m.w * s, m.h * s);
  $('#badge').innerHTML = `${m.w}×${m.h} · <b>${m.kind === 'video' ? 'video' : 'photo'}</b>${s < 1 ? ` · preview ${Math.round(s * 100)}%` : ' · 1:1'}`;
  fit();
}

function fit() {
  const m = state.media; if (!m) return;
  const vp = $('#viewport'), cs = getComputedStyle(vp);
  const W = vp.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const H = vp.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const s = Math.min(W / m.w, H / m.h);
  cv.style.width = Math.max(1, Math.floor(m.w * s)) + 'px';
  cv.style.height = Math.max(1, Math.floor(m.h * s)) + 'px';
}
new ResizeObserver(fit).observe($('#viewport'));

/* ---------- render loop ---------- */
let dirty = false;
const requestRender = () => { dirty = true; };
const timeNow = () => (state.media?.kind === 'video' ? state.media.el.currentTime : 0) + state.seed;
function tick() {
  requestAnimationFrame(tick);
  const m = state.media;
  if (!m || state.exporting) return;
  if (m.kind === 'video' && !m.el.paused && m.el.readyState >= 2) { R.upload(m.el, m.w, m.h); dirty = true; }
  if (dirty) {
    dirty = false;
    R.render(state.stack, timeNow(), state.bypass);
    $('#frame').classList.toggle('bypass', state.bypass);
  }
}
requestAnimationFrame(tick);

/* ---------- transport ---------- */
function syncTransport() {
  const m = state.media; if (m?.kind !== 'video') return;
  const v = m.el;
  const pi = v.paused ? 'play' : 'pause', mi = v.muted ? 'mute' : 'volume';
  if ($('#playBtn').dataset.i !== pi) { $('#playBtn').dataset.i = pi; $('#playBtn').innerHTML = icon(pi); }
  if ($('#muteBtn').dataset.i !== mi) { $('#muteBtn').dataset.i = mi; $('#muteBtn').innerHTML = icon(mi); }
  $('#time').textContent = `${fmtTime(v.currentTime)} / ${fmtTime(v.duration)}`;
  if (!scrubbing) { const s = $('#scrub'); s.value = v.duration ? v.currentTime / v.duration * 1000 : 0; s.style.setProperty('--v', s.value / 10 + '%'); }
  $('#muteBtn').classList.toggle('off', v.muted);
}
let scrubbing = false;
const togglePlay = () => { const v = state.media?.el; if (state.media?.kind !== 'video' || state.exporting) return; v.paused ? v.play().catch(() => { }) : v.pause(); };
$('#playBtn').onclick = togglePlay;
$('#muteBtn').onclick = () => { const v = state.media?.el; if (v) { v.muted = !v.muted; syncTransport(); } };
const scrub = $('#scrub');
scrub.addEventListener('pointerdown', () => { scrubbing = true; });
scrub.addEventListener('pointerup', () => { scrubbing = false; });
scrub.addEventListener('input', () => {
  const v = state.media?.el; if (!v?.duration) return;
  v.currentTime = scrub.value / 1000 * v.duration;
  scrub.style.setProperty('--v', scrub.value / 10 + '%');
  $('#time').textContent = `${fmtTime(v.currentTime)} / ${fmtTime(v.duration)}`;
});

/* ---------- stack UI ---------- */
const fmtVal = (v, p) => p.step >= 1 ? Math.round(v) : (p.max - p.min) <= 4 ? (+v).toFixed(2) : (+v).toFixed(1);

// onChange: re-render + persist + refresh which params are visible (see `show` in effects.js)
function control(e, p, onChange) {
  const w = document.createElement('div');
  const set = v => { e.p[p.id] = v; onChange(); };
  if (p.type === 'head') {
    w.className = 'prm-h'; w.textContent = p.name;
  } else if (p.type === 'range') {
    w.className = 'prm';
    w.innerHTML = `<label><span>${esc(p.name)}</span><output></output></label><input type="range" min="${p.min}" max="${p.max}" step="${p.step}" title="Double-click to reset">`;
    const r = w.querySelector('input'), out = w.querySelector('output');
    r.value = e.p[p.id];
    const sync = () => { out.textContent = fmtVal(r.value, p); r.style.setProperty('--v', (r.value - p.min) / (p.max - p.min) * 100 + '%'); };
    sync();
    r.addEventListener('input', () => { sync(); set(+r.value); });
    r.addEventListener('dblclick', () => { r.value = p.def; sync(); set(p.def); });
  } else if (p.type === 'select' && p.options.length > 5) {
    w.className = 'prm';
    w.innerHTML = `<label><span>${esc(p.name)}</span></label><select class="sel">${p.options.map((o, i) => `<option value="${i}"${e.p[p.id] == i ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    w.querySelector('select').addEventListener('change', ev => set(+ev.target.value));
  } else if (p.type === 'select') {
    w.className = 'prm';
    w.innerHTML = `<label><span>${esc(p.name)}</span></label><div class="opts">${p.options.map((o, i) => `<button data-i="${i}" class="${e.p[p.id] == i ? 'on' : ''}">${esc(o)}</button>`).join('')}</div>`;
    w.querySelector('.opts').addEventListener('click', ev => {
      const b = ev.target.closest('button'); if (!b) return;
      w.querySelectorAll('.opts button').forEach(x => x.classList.toggle('on', x === b));
      set(+b.dataset.i);
    });
  } else if (p.type === 'toggle') {
    w.className = 'prm inline';
    w.innerHTML = `<label><span>${esc(p.name)}</span></label><button class="sw ${e.p[p.id] ? 'on' : ''}" role="switch" aria-checked="${!!e.p[p.id]}"></button>`;
    const b = w.querySelector('button');
    b.addEventListener('click', () => { const v = e.p[p.id] ? 0 : 1; b.classList.toggle('on', !!v); b.setAttribute('aria-checked', !!v); set(v); });
  } else if (p.type === 'text') {
    w.className = 'prm';
    w.innerHTML = `<label><span>${esc(p.name)}</span></label><input type="text" class="txt" maxlength="96" spellcheck="false">`;
    const t = w.querySelector('input'); t.value = e.p[p.id] ?? '';
    t.addEventListener('input', () => set(t.value));
  } else {
    w.className = 'prm inline';
    w.innerHTML = `<label><span>${esc(p.name)}</span></label><input type="color" value="${e.p[p.id]}">`;
    w.querySelector('input').addEventListener('input', ev => set(ev.target.value));
  }
  return w;
}

function card(e, i) {
  const def = EFFECT_MAP[e.type];
  const c = document.createElement('div');
  c.className = 'card' + (e.on ? '' : ' off') + (e.open ? '' : ' closed');
  c.innerHTML = `<div class="card-h">
    <span class="n">${String(i + 1).padStart(2, '0')}</span>
    <button class="sw ${e.on ? 'on' : ''}" title="On/off"></button>
    <span class="nm">${def.name}</span>
    <button class="ib" data-a="up" title="Move up">${icon('up')}</button><button class="ib" data-a="down" title="Move down">${icon('down')}</button>
    <button class="ib" data-a="reset" title="Reset parameters">${icon('reset', 14)}</button><button class="ib" data-a="del" title="Remove">${icon('x')}</button>
  </div><div class="card-b"></div>`;
  c.querySelector('.card-h').addEventListener('click', ev => {
    const st = state.stack;
    if (ev.target.closest('.sw')) { e.on = !e.on; return changed(); }
    const a = ev.target.closest('[data-a]')?.dataset.a;
    if (!a) { e.open = !e.open; c.classList.toggle('closed', !e.open); return persist(); }
    if (a === 'up' && i > 0) [st[i - 1], st[i]] = [st[i], st[i - 1]];
    else if (a === 'down' && i < st.length - 1) [st[i + 1], st[i]] = [st[i], st[i + 1]];
    else if (a === 'del') st.splice(i, 1);
    else if (a === 'reset') def.params.forEach(p => { if (p.type !== 'head') e.p[p.id] = p.def; });
    else return;
    changed();
  });
  const b = c.querySelector('.card-b');
  const rows = def.params.map(p => [p, b.appendChild(control(e, p, () => { vis(); requestRender(); persist(); }))]);
  // hide conditional params, and headings whose section ended up empty
  function vis() {
    let head = null, any = false;
    const closeHead = () => { if (head) head.hidden = !any; };
    for (const [p, el] of rows) {
      if (p.type === 'head') { closeHead(); head = el; any = false; continue; }
      el.hidden = !!p.show && !p.show(e.p);
      if (!el.hidden) any = true;
    }
    closeHead();
  }
  vis();
  return c;
}

function renderStack() {
  const el = $('#stack');
  el.innerHTML = '';
  $('#stackCount').textContent = state.stack.length;
  if (!state.stack.length) { el.innerHTML = `<div class="stack-empty"><div class="ico">${icon('layers', 18)}</div><b>No layers yet</b><span>Add an effect or pick a preset —<br>layers are applied top to bottom.</span></div>`; return; }
  state.stack.forEach((e, i) => el.appendChild(card(e, i)));
}
function changed() { renderStack(); requestRender(); persist(); }

// library
$('#library').innerHTML = GROUPS.map(g => `<div class="lib-g"><span>${g}</span><div>${EFFECTS.filter(e => e.group === g).map(e => `<button data-id="${e.id}">${e.name}</button>`).join('')}</div></div>`).join('');
$('#library').addEventListener('click', ev => {
  const b = ev.target.closest('button[data-id]'); if (!b) return;
  state.stack.forEach(e => { e.open = false; });
  state.stack.push(mk(b.dataset.id));
  changed();
  const s = $('#stack'); s.scrollTop = s.scrollHeight;
});
// presets
$('#presets').innerHTML = PRESETS.map((p, i) => `<button class="chip" data-i="${i}">${p.name}</button>`).join('');
$('#presets').addEventListener('click', ev => {
  const b = ev.target.closest('button'); if (!b) return;
  const p = PRESETS[+b.dataset.i];
  state.stack = p.stack.map(([t, o]) => ({ ...mk(t, o), open: false }));
  changed(); toast('Preset: ' + p.name);
});
$('#clearBtn').onclick = () => { state.stack = []; changed(); };

/* ---------- resizable panel sections (desktop) ---------- */
// Each .split resizes the section above it; the Layers section takes whatever is left.
const PANEL_KEY = 'shooom.panel', SEC_MIN = 48, STACK_MIN = 140;
const desktop = matchMedia('(min-width: 821px)');
let secSizes = {};
try { secSizes = JSON.parse(localStorage.getItem(PANEL_KEY) || '{}') || {}; } catch { }
const savePanel = () => { try { localStorage.setItem(PANEL_KEY, JSON.stringify(secSizes)); } catch { } };
const setSec = (el, h) => {
  el.style.height = h == null ? '' : h + 'px';
  el.classList.toggle('sized', h != null);
};
const applySecSizes = () => document.querySelectorAll('.split').forEach(sp => {
  const el = document.getElementById(sp.dataset.for);
  setSec(el, desktop.matches && secSizes[el.id] ? secSizes[el.id] : null);
});
const resizeSec = (el, h0, dy, room) => {
  const h = Math.round(Math.max(SEC_MIN, Math.min(h0 + dy, h0 + room)));
  secSizes[el.id] = h; setSec(el, h);
};
document.querySelectorAll('.split').forEach(sp => {
  const el = document.getElementById(sp.dataset.for);
  const room = () => $('#secStack').getBoundingClientRect().height - STACK_MIN; // how much Layers can still give up
  sp.addEventListener('pointerdown', ev => {
    if (!desktop.matches || ev.button !== 0) return;
    ev.preventDefault(); try { sp.setPointerCapture(ev.pointerId); } catch { }
    const y0 = ev.clientY, h0 = el.getBoundingClientRect().height, r = room();
    sp.classList.add('on'); document.body.classList.add('resizing');
    const move = e => resizeSec(el, h0, e.clientY - y0, r);
    const up = () => {
      sp.removeEventListener('pointermove', move); sp.removeEventListener('pointerup', up); sp.removeEventListener('pointercancel', up);
      sp.classList.remove('on'); document.body.classList.remove('resizing'); savePanel();
    };
    sp.addEventListener('pointermove', move); sp.addEventListener('pointerup', up); sp.addEventListener('pointercancel', up);
  });
  sp.addEventListener('dblclick', () => { delete secSizes[el.id]; savePanel(); applySecSizes(); });
  sp.addEventListener('keydown', ev => {
    const d = { ArrowUp: -16, ArrowDown: 16 }[ev.key]; if (!d || !desktop.matches) return;
    ev.preventDefault(); resizeSec(el, el.getBoundingClientRect().height, d, room()); savePanel();
  });
});
desktop.addEventListener('change', applySecSizes);
applySecSizes();

/* ---------- stage controls ---------- */
const cmp = $('#compareBtn');
const setBypass = v => { if (state.bypass !== v) { state.bypass = v; cmp.classList.toggle('on', v); requestRender(); } };
cmp.addEventListener('pointerdown', ev => { ev.preventDefault(); setBypass(true); });
['pointerup', 'pointerleave', 'pointercancel'].forEach(t => cmp.addEventListener(t, () => setBypass(false)));
$('#seedBtn').onclick = () => { state.seed = Math.random() * 1000; requestRender(); };
$('#previewSeg').addEventListener('click', ev => {
  const b = ev.target.closest('button'); if (!b) return;
  state.preview = b.dataset.v;
  $('#previewSeg').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
  layoutPreview(); requestRender();
});

const typing = t => t && (t.tagName === 'INPUT' && !['range', 'button'].includes(t.type) || t.tagName === 'TEXTAREA');
addEventListener('keydown', ev => {
  if (typing(ev.target) || !$('#modal').hidden) return;
  if (ev.code === 'Space') { ev.preventDefault(); togglePlay(); }
  if (ev.key === '\\') setBypass(true);
});
addEventListener('keyup', ev => { if (ev.key === '\\') setBypass(false); });

/* ---------- file input / drop / paste ---------- */
$('#fileInput').addEventListener('change', ev => { openFile(ev.target.files[0]); ev.target.value = ''; });
let dragN = 0;
addEventListener('dragenter', ev => { ev.preventDefault(); dragN++; document.body.classList.add('drag'); });
addEventListener('dragleave', () => { if (--dragN <= 0) { dragN = 0; document.body.classList.remove('drag'); } });
addEventListener('dragover', ev => ev.preventDefault());
addEventListener('drop', ev => { ev.preventDefault(); dragN = 0; document.body.classList.remove('drag'); openFile(ev.dataTransfer.files[0]); });
addEventListener('paste', ev => { const f = [...(ev.clipboardData?.files || [])][0]; if (f) openFile(f); });

$('#demoBtn').onclick = async () => {
  try { await Promise.race([document.fonts.load('700 130px Lora'), new Promise(r => setTimeout(r, 1500))]); } catch { }
  const W = 1920, H = 1280, c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d'), hz = H * .62;
  let g = x.createLinearGradient(0, 0, 0, hz);
  g.addColorStop(0, '#0d0221'); g.addColorStop(.55, '#3a0b5e'); g.addColorStop(.85, '#c1246b'); g.addColorStop(1, '#ff9f45');
  x.fillStyle = g; x.fillRect(0, 0, W, hz);
  for (let i = 0; i < 220; i++) { x.fillStyle = `rgba(255,255,255,${Math.random() * .8})`; x.fillRect(Math.random() * W, Math.random() * hz * .6, 2, 2); }
  x.save(); x.beginPath(); x.arc(W / 2, hz - 40, 260, 0, Math.PI * 2); x.clip();
  g = x.createLinearGradient(0, hz - 300, 0, hz + 220); g.addColorStop(0, '#fff36b'); g.addColorStop(.6, '#ff4f8b'); g.addColorStop(1, '#a1007a');
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  x.fillStyle = '#3a0b5e'; for (let k = 0; k < 9; k++) x.fillRect(0, hz - 140 + k * 26, W, 4 + k * 1.8);
  x.restore();
  const mtn = (col, amp, seed, base) => { x.fillStyle = col; x.beginPath(); x.moveTo(0, hz);
    for (let px = 0; px <= W; px += 40) x.lineTo(px, base - Math.abs(Math.sin(px * .004 + seed) * amp + Math.sin(px * .013 + seed * 2) * amp * .35));
    x.lineTo(W, hz); x.fill(); };
  mtn('#25063f', 170, 1.3, hz); mtn('#14022a', 110, 4.1, hz + 4);
  g = x.createLinearGradient(0, hz, 0, H); g.addColorStop(0, '#1a0233'); g.addColorStop(1, '#050010');
  x.fillStyle = g; x.fillRect(0, hz, W, H - hz);
  x.strokeStyle = '#ff2fd6'; x.lineWidth = 2; x.shadowColor = '#ff2fd6'; x.shadowBlur = 12;
  for (let k = -24; k <= 24; k++) { x.beginPath(); x.moveTo(W / 2 + k * 18, hz); x.lineTo(W / 2 + k * 260, H); x.stroke(); }
  for (let k = 0; k < 16; k++) { const y = hz + Math.pow(k / 15, 2.2) * (H - hz); x.beginPath(); x.moveTo(0, y); x.lineTo(W, y); x.stroke(); }
  x.shadowBlur = 0;
  x.fillStyle = '#ece6d6'; x.font = '700 140px Lora, Georgia, serif'; x.textAlign = 'center'; x.fillText('SHOOOM', W / 2, H * .9);
  setMedia({ kind: 'image', name: 'demo.png', w: W, h: H, el: c });
};

/* ---------- saving (artifact downloads capability, with plain-download fallback) ---------- */
let dlNs = null, dlTried = false;
async function getDownloads() {
  if (dlTried) return dlNs;
  if (!window.claude?.use) return null;
  dlTried = true;
  try { dlNs = await Promise.race([window.claude.use('downloads'), new Promise(r => setTimeout(() => r(null), 10000))]); } catch { dlNs = null; }
  return dlNs;
}
setTimeout(getDownloads, 300);

async function saveBlob(blob, name) {
  const dl = await getDownloads();
  if (dl) {
    try { await dl.save({ filename: name, data: blob }); toast('Saved: ' + name); return true; }
    catch (e) {
      if (e?.code === 'declined') { toast('Save canceled'); return false; }
      if (e?.code === 'rate_limited') { toast('A save dialog is already open — wait a moment'); return false; }
      console.warn('downloads.save failed, falling back', e);
    }
  }
  const a = document.createElement('a'), url = URL.createObjectURL(blob);
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 120000);
  return true;
}

/* ---------- export ---------- */
const modal = $('#modal'), sheet = $('#sheet');
const closeModal = () => { if (!busy) modal.hidden = true; };
modal.addEventListener('pointerdown', ev => { if (ev.target === modal) closeModal(); });
addEventListener('keydown', ev => { if (ev.key === 'Escape') closeModal(); });
let busy = false;

$('#exportBtn').onclick = () => {
  const m = state.media; if (!m) return;
  if (m.kind === 'video') m.el.pause();
  m.kind === 'image' ? imageSheet() : videoSheet();
  modal.hidden = false;
};

function segPick(root, cb) {
  root.addEventListener('click', ev => {
    const b = ev.target.closest('button'); if (!b) return;
    root.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); cb(b.dataset.v);
  });
}
const activeCount = () => state.stack.filter(e => e.on).length;

function imageSheet() {
  const m = state.media, [W, H] = fullSize(m.w, m.h);
  let fmt = 'png', q = 92;
  sheet.innerHTML = `<h2>Export photo</h2>
    <div class="meta">Size: <b>${W}×${H}</b>${W < m.w ? ' (GPU limit)' : ' — original'}<br>Active layers: <b>${activeCount()}</b></div>
    <div class="field"><span>Format</span><div class="seg" id="fmtSeg"><button data-v="png" class="on">PNG</button><button data-v="jpg">JPG</button><button data-v="webp">WEBP</button></div></div>
    <div class="field" id="qField" hidden><span>Quality · <output>${q}</output></span><input type="range" min="50" max="100" value="${q}" style="--v:84%"></div>
    <div class="row"><button class="btn" data-x="close">Cancel</button><button class="btn accent" data-x="go">Save</button></div>`;
  segPick(sheet.querySelector('#fmtSeg'), v => { fmt = v; sheet.querySelector('#qField').hidden = v === 'png'; });
  const qr = sheet.querySelector('#qField input');
  qr.oninput = () => { q = +qr.value; qr.style.setProperty('--v', (q - 50) * 2 + '%'); sheet.querySelector('#qField output').textContent = q; };
  sheet.querySelector('[data-x=close]').onclick = closeModal;
  const go = sheet.querySelector('[data-x=go]');
  go.onclick = async () => {
    go.disabled = true; go.textContent = 'Rendering…';
    try {
      const type = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[fmt];
      const blob = await renderImage(type, q / 100);
      if (!blob) throw new Error('the browser could not encode ' + fmt.toUpperCase());
      const ok = await saveBlob(blob, `${baseName(m.name)}_shooom.${fmt}`);
      if (ok) modal.hidden = true;
    } catch (e) { console.error(e); toast('Export failed: ' + (e.message || e), 4000); }
    go.disabled = false; go.textContent = 'Save';
  };
}

async function renderImage(type, quality) {
  const m = state.media, [W, H] = fullSize(m.w, m.h);
  state.exporting = true;
  try {
    R.setSize(W, H);
    R.render(state.stack, timeNow(), false);
    return await new Promise(r => cv.toBlob(r, type, quality));
  } finally {
    state.exporting = false; layoutPreview(); requestRender();
  }
}

const QUALITY = { m: QUALITY_MEDIUM, h: QUALITY_HIGH, vh: QUALITY_VERY_HIGH };
const CODEC_NAME = { avc: 'H.264', hevc: 'H.265', vp9: 'VP9', av1: 'AV1' };

function videoSheet() {
  const m = state.media, [W, H] = fullSize(m.w, m.h);
  let ql = 'h';
  sheet.innerHTML = `<h2>Export video</h2>
    <div class="meta">Resolution: <b>${W}×${H}</b>${W < m.w ? ' (GPU limit)' : ' — original'}<br>Duration: <b>${fmtTime(m.dur)}</b> · layers: <b>${activeCount()}</b> · audio is kept</div>
    <div class="field"><span>Quality</span><div class="seg" id="qSeg"><button data-v="m">Medium</button><button data-v="h" class="on">High</button><button data-v="vh">Very high</button></div></div>
    <div class="note">${icon('info')}<span>Encoding runs right in your browser, frame by frame, on your GPU. Long 4K clips take a while — keep this tab open.</span></div>
    <div id="pw" hidden><div class="bar"><i></i></div><div class="prog" style="margin-top:8px"><span id="pPct">0%</span><span id="pEta">preparing…</span></div></div>
    <div class="row"><button class="btn" data-x="close">Cancel</button><button class="btn accent" data-x="go">Start</button></div>`;
  segPick(sheet.querySelector('#qSeg'), v => { ql = v; });
  let conv = null;
  const close = sheet.querySelector('[data-x=close]'), go = sheet.querySelector('[data-x=go]');
  close.onclick = () => { if (conv && busy) conv.cancel(); else closeModal(); };
  go.onclick = async () => {
    go.disabled = true; sheet.querySelector('#qSeg').style.pointerEvents = 'none';
    sheet.querySelector('#pw').hidden = false; close.textContent = 'Abort';
    busy = true;
    const t0 = performance.now();
    try {
      const res = await exportVideo(QUALITY[ql], c => { conv = c; }, p => {
        sheet.querySelector('.bar i').style.width = (p * 100).toFixed(1) + '%';
        sheet.querySelector('#pPct').textContent = (p * 100).toFixed(1) + '%';
        const el = (performance.now() - t0) / 1000;
        if (p > .02) sheet.querySelector('#pEta').textContent = '~' + fmtTime(el / p - el) + ' left';
      });
      busy = false;
      doneSheet(res);
    } catch (e) {
      busy = false;
      if (e?.name === 'ConversionCanceledError' || /cancel/i.test(e?.message)) { toast('Export aborted'); modal.hidden = true; }
      else { console.error(e); sheet.querySelector('#pEta').textContent = ''; toast('Error: ' + (e.message || e), 5000); close.textContent = 'Close'; }
    }
  };
}

async function exportVideo(quality, onConv, onProgress) {
  const m = state.media;
  m.el.pause();
  state.exporting = true;
  try {
    const input = new Input({ source: new BlobSource(m.file), formats: ALL_FORMATS });
    const vt = await input.getPrimaryVideoTrack();
    if (!vt) throw new Error('the file has no video track');
    const [fw, fh] = fullSize(vt.displayWidth, vt.displayHeight);
    const W = Math.floor(fw / 2) * 2, H = Math.floor(fh / 2) * 2;
    const codec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width: W, height: H, quality });
    if (!codec) throw new Error(`the browser cannot encode ${W}×${H} video`);
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
    R.setSize(W, H);
    const conv = await Conversion.init({
      input, output,
      video: {
        codec, quality, forceTranscode: true, allowTransformationMetadata: false,
        processedWidth: W, processedHeight: H,
        process: sample => {
          const f = sample.toVideoFrame();
          try { R.upload(f, f.displayWidth, f.displayHeight); } finally { f.close(); }
          R.render(state.stack, sample.timestamp + state.seed, false);
          const out = new VideoFrame(cv, { timestamp: Math.round(sample.timestamp * 1e6), duration: Math.round(sample.duration * 1e6) });
          return new VideoSample(out);
        },
      },
    });
    if (!conv.isValid) throw new Error('could not build the file: ' + conv.discardedTracks.map(d => d.reason).join(', '));
    const audioLost = conv.discardedTracks.some(d => d.track.type === 'audio');
    onConv(conv);
    conv.onProgress = p => onProgress(p);
    await conv.execute();
    const blob = new Blob([output.target.buffer], { type: 'video/mp4' });
    return { blob, W, H, codec, audioLost, name: `${baseName(m.name)}_shooom.mp4` };
  } finally {
    state.exporting = false;
    layoutPreview();
    if (m === state.media) R.upload(m.el, m.w, m.h);
    requestRender();
  }
}

function doneSheet(r) {
  sheet.innerHTML = `<h2><span class="ok">${icon('check')}</span>Done</h2>
    <div class="meta"><b>${esc(r.name)}</b><br>${r.W}×${r.H} · ${CODEC_NAME[r.codec] || r.codec} · <b>${fmtSize(r.blob.size)}</b>${r.audioLost ? '<br>Audio could not be carried over in this browser' : ''}</div>
    <div class="row"><button class="btn" data-x="close">Close</button><button class="btn accent" data-x="save">Save file</button></div>`;
  sheet.querySelector('[data-x=close]').onclick = closeModal;
  sheet.querySelector('[data-x=save]').onclick = async () => { if (await saveBlob(r.blob, r.name)) modal.hidden = true; };
}

/* ---------- init ---------- */
renderStack();
window.__shooom = { state, R, openFile }; // handy for debugging in devtools
