// Blob tracking overlay (CPU pass): finds feature points, then draws HUD-style regions,
// connections and labels with Canvas 2D, optionally running a filter inside (or outside) the regions.
// Signature matches cpu.js: fn(src, dst, w, h, p, { px, time }).

export const TRACK_STYLES = ['Basic', 'Cross', 'Label', 'Frame', 'L-frame', 'X-frame', 'Grid', 'Particle', 'Dash', 'Scope', 'Win2K', 'Label 2', 'Glow', 'Backdrop'];
export const TRACK_FILTERS = ['None', 'Invert', 'Glitch', 'Thermal', 'Pixel', 'Tone', 'Blur', 'Dither', 'Zoom', 'X-ray', 'Water', 'Mask', 'CRT', 'Edge', 'Blink'];
const ST = Object.fromEntries(TRACK_STYLES.map((s, i) => [s, i]));
const FI = Object.fromEntries(TRACK_FILTERS.map((s, i) => [s, i]));

const hash = (a, b = 0) => { let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263); h = Math.imul(h ^ h >>> 13, 1274126177); return ((h ^ h >>> 16) >>> 0) / 4294967296; };
const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));

let canv = null;
const mkCanvas = (w, h) => {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  return { c, x: c.getContext('2d', { willReadFrequently: true }) };
};
const surface = (k, w, h) => {
  canv ??= {};
  if (!canv[k] || canv[k].c.width !== w || canv[k].c.height !== h) canv[k] = mkCanvas(w, h);
  return canv[k];
};

/* ---------- 1. feature detection (Harris corners on a coarse grid + non-max suppression) ---------- */
function detect(src, w, h, p, px) {
  const gs = Math.max(2, Math.round(6 * px)), gw = Math.floor(w / gs), gh = Math.floor(h / gs);
  const L = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    const o = ((y * gs + (gs >> 1)) * w + x * gs + (gs >> 1)) * 4;
    L[y * gw + x] = (.2126 * src[o] + .7152 * src[o + 1] + .0722 * src[o + 2]) / 255;
  }
  const Sxx = new Float32Array(gw * gh), Syy = new Float32Array(gw * gh), Sxy = new Float32Array(gw * gh);
  for (let y = 1; y < gh - 1; y++) for (let x = 1; x < gw - 1; x++) {
    const i = y * gw + x, ix = L[i + 1] - L[i - 1], iy = L[i + gw] - L[i - gw];
    Sxx[i] = ix * ix; Syy[i] = iy * iy; Sxy[i] = ix * iy;
  }
  const R = new Float32Array(gw * gh); let max = 0;
  for (let y = 2; y < gh - 2; y++) for (let x = 2; x < gw - 2; x++) {
    let a = 0, b = 0, c = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const j = (y + dy) * gw + x + dx; a += Sxx[j]; b += Syy[j]; c += Sxy[j]; }
    const r = a * b - c * c - .05 * (a + b) * (a + b);
    if (r > 0) { R[y * gw + x] = r; if (r > max) max = r; }
  }
  // spread the picks: best corner per bucket, then strongest buckets first.
  // By count: bucket size so that ~1.5×count buckets cover the frame; By size: one bucket per box size.
  const size = p.bsize * px;
  const limit = p.single ? 1 : p.cmode === 0 ? p.count : 256;
  const B = Math.max(2, (p.cmode === 0 && !p.single ? Math.sqrt(w * h / (limit * 1.5)) : size) / gs);
  const bw = Math.ceil(gw / B), best = new Int32Array(bw * Math.ceil(gh / B)).fill(-1);
  const thr = max * (p.cmode === 1 ? 1e-3 : 2e-5);
  for (let i = 0; i < R.length; i++) {
    if (R[i] <= thr) continue;
    const b = Math.floor(((i / gw) | 0) / B) * bw + Math.floor((i % gw) / B);
    if (best[b] < 0 || R[i] > R[best[b]]) best[b] = i;
  }
  const cand = [...best].filter(i => i >= 0).sort((a, b) => R[b] - R[a]);
  const pts = cand.slice(0, limit).map(i => { const x = i % gw, y = (i / gw) | 0; return { x: (x + .5) * gs, y: (y + .5) * gs }; });
  // region sizes
  return pts.map((q, i) => {
    const k = p.same || p.single ? 1 : .45 + hash(i, 11) * 1.1;
    let rw = size * k * (p.single ? 2.2 : 1), rh = rw;
    if (p.shape === 2) { const a = .55 + hash(i, 23) * 1.1; rw *= Math.sqrt(a) * 1.25; rh /= Math.sqrt(a) * 1.25; }
    return { i, cx: q.x, cy: q.y, w: rw, h: rh, x: q.x - rw / 2, y: q.y - rh / 2 };
  });
}

/* ---------- 2. full-frame filters (drawn through the region clip later) ---------- */
function filterImage(src, w, h, f, p, px, time) {
  const out = new Uint8ClampedArray(src.length);
  const lum = o => (.2126 * src[o] + .7152 * src[o + 1] + .0722 * src[o + 2]) / 255;
  const col = rgb(p.color);
  const at = (x, y) => ((Math.min(h - 1, Math.max(0, y | 0)) * w) + Math.min(w - 1, Math.max(0, x | 0))) * 4;
  const fr = Math.floor(time * 12);
  if (f === FI.Blur) { // separable box blur
    const r = Math.max(1, Math.round(6 * px)), tmp = new Float32Array(src.length);
    for (let y = 0; y < h; y++) for (let c = 0; c < 3; c++) {
      let s = 0; for (let k = -r; k <= r; k++) s += src[at(k, y) + c];
      for (let x = 0; x < w; x++) { tmp[(y * w + x) * 4 + c] = s / (2 * r + 1); s += src[at(x + r + 1, y) + c] - src[at(x - r, y) + c]; }
    }
    for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
      const T = (yy) => tmp[(Math.min(h - 1, Math.max(0, yy)) * w + x) * 4 + c];
      let s = 0; for (let k = -r; k <= r; k++) s += T(k);
      for (let y = 0; y < h; y++) { out[(y * w + x) * 4 + c] = s / (2 * r + 1); s += T(y + r + 1) - T(y - r); }
    }
    for (let i = 3; i < out.length; i += 4) out[i] = 255;
    return out;
  }
  const bs = Math.max(2, Math.round(12 * px));
  const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  for (let y = 0; y < h; y++) {
    const shift = f === FI.Glitch && hash((y / (8 * px)) | 0, fr) > .82 ? Math.round((hash(y >> 3, fr + 7) - .5) * 80 * px) : 0;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4; let r, g, b;
      if (f === FI.Invert) { r = 255 - src[o]; g = 255 - src[o + 1]; b = 255 - src[o + 2]; }
      else if (f === FI.Glitch) { const q = at(x + shift, y); r = src[at(x + shift + 6 * px, y)]; g = src[q + 1]; b = src[at(x + shift - 6 * px, y) + 2]; }
      else if (f === FI.Thermal) {
        const l = lum(o), t = l * 4, k = Math.min(3, t | 0), u = t - k;
        const S = [[0, 0, 40], [90, 0, 160], [230, 30, 60], [255, 170, 0], [255, 255, 220]];
        r = S[k][0] + (S[k + 1][0] - S[k][0]) * u; g = S[k][1] + (S[k + 1][1] - S[k][1]) * u; b = S[k][2] + (S[k + 1][2] - S[k][2]) * u;
      }
      else if (f === FI.Pixel) { const q = at(Math.floor(x / bs) * bs + bs / 2, Math.floor(y / bs) * bs + bs / 2); r = src[q]; g = src[q + 1]; b = src[q + 2]; }
      else if (f === FI.Tone) { const l = lum(o); r = 20 + (col[0] - 20) * l; g = 16 + (col[1] - 16) * l; b = 40 + (col[2] - 40) * l; }
      else if (f === FI.Dither) { const v = lum(o) > (bayer[(y & 3) * 4 + (x & 3)] + .5) / 16 ? 255 : 0; r = g = b = v; }
      else if (f === FI['X-ray']) { const v = Math.min(1, Math.max(0, (1 - lum(o) - .5) * 1.6 + .5)); r = v * 150; g = v * 225; b = v * 255; }
      else if (f === FI.Water) { const q = at(x + Math.sin(y * .045 / px + time * 3) * 7 * px, y + Math.cos(x * .04 / px + time * 2.4) * 5 * px); r = src[q]; g = src[q + 1]; b = src[q + 2]; }
      else if (f === FI.CRT) {
        const sl = ((y / Math.max(1, px * 1.5)) | 0) % 3 === 2 ? .45 : 1, m = ((x / Math.max(1, px * 1.2)) | 0) % 3;
        r = src[o] * sl * (m === 0 ? 1.25 : .7); g = src[o + 1] * sl * (m === 1 ? 1.25 : .7); b = src[o + 2] * sl * (m === 2 ? 1.25 : .7);
      }
      else if (f === FI.Edge) {
        const d = Math.max(1, Math.round(px));
        const gx = lum(at(x + d, y)) - lum(at(x - d, y)), gy = lum(at(x, y + d)) - lum(at(x, y - d));
        const v = Math.min(1, Math.hypot(gx, gy) * 3); r = col[0] * v; g = col[1] * v; b = col[2] * v;
      }
      else { r = src[o]; g = src[o + 1]; b = src[o + 2]; } // Mask / Zoom / Blink use the original
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
    }
  }
  return out;
}

/* ---------- 3. drawing helpers ---------- */
const shapePath = (x, r, shape) => {
  if (shape === 1) x.ellipse(r.cx, r.cy, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
  else x.rect(r.x, r.y, r.w, r.h);
};
function link(x, a, b, style, seed, px) {
  const dx = b.cx - a.cx, dy = b.cy - a.cy, len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len;
  x.beginPath(); x.moveTo(a.cx, a.cy);
  if (style === 1) { const k = (hash(seed, 3) - .5) * len * .5; x.quadraticCurveTo((a.cx + b.cx) / 2 + nx * k, (a.cy + b.cy) / 2 + ny * k, b.cx, b.cy); }
  else if (style === 2) { const n = Math.max(8, len / (4 * px)) | 0, amp = 6 * px, waves = Math.max(1, Math.round(len / (40 * px)));
    for (let k = 1; k <= n; k++) { const t = k / n, s = Math.sin(t * Math.PI * 2 * waves) * amp; x.lineTo(a.cx + dx * t + nx * s, a.cy + dy * t + ny * s); } }
  else if (style === 3) { const n = Math.max(3, len / (18 * px)) | 0;
    for (let k = 1; k < n; k++) { const t = k / n, s = (hash(seed, k) - .5) * 22 * px; x.lineTo(a.cx + dx * t + nx * s, a.cy + dy * t + ny * s); }
    x.lineTo(b.cx, b.cy); }
  else x.lineTo(b.cx, b.cy);
  x.stroke();
}
function labelText(r, p, time) {
  if (p.tcontent === 1) return `${Math.round(r.cx)},${Math.round(r.cy)}`;
  if (p.tcontent === 2) return String(r.i + 1);
  return hash(r.i, Math.floor(time * 4) + 101).toFixed(4);
}

/* ---------- 4. the pass ---------- */
export function blobTrackCPU(src, dst, w, h, p, { px, time }) {
  const regions = detect(src, w, h, p, px);
  const { c, x } = surface('main', w, h);
  const base = new ImageData(new Uint8ClampedArray(src.buffer, src.byteOffset, src.length).slice(), w, h);
  x.setTransform(1, 0, 0, 1, 0, 0); x.globalAlpha = 1; x.shadowBlur = 0; x.setLineDash([]);
  x.putImageData(base, 0, 0);
  const S = surface('src', w, h); S.x.putImageData(base, 0, 0);

  // backdrop / mask fill the frame first
  if (p.style === ST.Backdrop) { x.fillStyle = p.bdcol; x.fillRect(0, 0, w, h); }
  if (p.filter === FI.Mask) { x.fillStyle = '#000'; x.fillRect(0, 0, w, h); }

  // filter, clipped to the regions (or to everything else when "Invert area" is on)
  const f = p.filter;
  if (f !== FI.None && regions.length) {
    const F = surface('filt', w, h);
    if (f !== FI.Mask && f !== FI.Zoom) // Blink flashes an inverted copy
      F.x.putImageData(new ImageData(filterImage(src, w, h, f === FI.Blink ? FI.Invert : f, p, px, time), w, h), 0, 0);
    x.save();
    x.globalAlpha = p.fusion ? .5 : 1;
    if (f === FI.Zoom || f === FI.Blink) {
      for (const r of regions) {
        if (f === FI.Blink && hash(r.i, Math.floor(time * 6) + 50) < .5) continue;
        x.save(); x.beginPath(); shapePath(x, r, p.shape); x.clip();
        if (f === FI.Zoom) x.drawImage(S.c, r.cx - r.w / 4, r.cy - r.h / 4, r.w / 2, r.h / 2, r.x, r.y, r.w, r.h);
        else x.drawImage(F.c, 0, 0);
        x.restore();
      }
    } else {
      x.beginPath();
      if (p.finv) x.rect(0, 0, w, h);
      for (const r of regions) shapePath(x, r, p.shape);
      x.clip(p.finv ? 'evenodd' : 'nonzero');
      x.drawImage(f === FI.Mask ? S.c : F.c, 0, 0);
    }
    x.restore();
  }

  const lw = Math.max(1, p.stroke * px), fs = Math.max(6, p.font * px);
  const colorOf = r => p.sep ? `hsl(${(hash(r.i, 7) * 360) | 0} 90% 60%)` : p.color;
  x.lineWidth = lw; x.lineCap = 'round'; x.lineJoin = 'round';

  // connections
  if (p.rate > 0 && regions.length > 1) {
    x.save();
    x.setLineDash(p.dashed ? [5 * px, 4 * px] : []);
    x.strokeStyle = p.color; x.globalAlpha = .85;
    if (p.hub) {
      const hub = { cx: regions.reduce((s, r) => s + r.cx, 0) / regions.length, cy: regions.reduce((s, r) => s + r.cy, 0) / regions.length };
      for (const r of regions) if (hash(r.i, 31) < p.rate) { x.strokeStyle = colorOf(r); link(x, hub, r, p.lstyle, r.i, px); }
      x.setLineDash([]); x.fillStyle = p.color; x.beginPath(); x.arc(hub.cx, hub.cy, 4 * px, 0, Math.PI * 2); x.fill();
    } else {
      regions.forEach((a, ai) => {
        if (hash(a.i, 31) >= p.rate) return;
        let best = null, bd = Infinity;
        regions.forEach((b, bi) => { if (bi <= ai) return; const d = (a.cx - b.cx) ** 2 + (a.cy - b.cy) ** 2; if (d < bd) { bd = d; best = b; } });
        if (best) { x.strokeStyle = colorOf(a); link(x, a, best, p.lstyle, a.i * 97 + best.i, px); }
      });
    }
    x.restore();
  }

  // regions + labels
  x.font = `600 ${fs}px "JetBrains Mono", ui-monospace, Consolas, monospace`;
  x.textBaseline = 'middle';
  for (const r of regions) {
    const cc = colorOf(r), st = p.style, txt = labelText(r, p, time);
    x.save();
    x.strokeStyle = cc; x.fillStyle = cc; x.lineWidth = lw;
    if (st === ST.Glow) { x.shadowColor = cc; x.shadowBlur = 14 * px; }
    if (st === ST.Dash) x.setLineDash([6 * px, 4 * px]);
    const box = () => { x.beginPath(); shapePath(x, r, p.shape); x.stroke(); };
    switch (st) {
      case ST['L-frame']: {
        const k = Math.min(r.w, r.h) * .25; x.beginPath();
        for (const [px0, py0, sx, sy] of [[r.x, r.y, 1, 1], [r.x + r.w, r.y, -1, 1], [r.x, r.y + r.h, 1, -1], [r.x + r.w, r.y + r.h, -1, -1]]) {
          x.moveTo(px0 + sx * k, py0); x.lineTo(px0, py0); x.lineTo(px0, py0 + sy * k);
        }
        x.stroke(); break;
      }
      case ST.Frame: box(); x.beginPath(); x.rect(r.x + 4 * px, r.y + 4 * px, r.w - 8 * px, r.h - 8 * px); x.globalAlpha = .6; x.stroke(); break;
      case ST['X-frame']: box(); x.beginPath(); x.moveTo(r.x, r.y); x.lineTo(r.x + r.w, r.y + r.h); x.moveTo(r.x + r.w, r.y); x.lineTo(r.x, r.y + r.h); x.globalAlpha = .6; x.stroke(); break;
      case ST.Grid: box(); x.beginPath(); for (let k = 1; k < 3; k++) { x.moveTo(r.x + r.w * k / 3, r.y); x.lineTo(r.x + r.w * k / 3, r.y + r.h); x.moveTo(r.x, r.y + r.h * k / 3); x.lineTo(r.x + r.w, r.y + r.h * k / 3); } x.globalAlpha = .5; x.stroke(); break;
      case ST.Cross: box(); x.beginPath(); x.moveTo(r.cx, r.y - r.h * .4); x.lineTo(r.cx, r.y + r.h * 1.4); x.moveTo(r.x - r.w * .4, r.cy); x.lineTo(r.x + r.w * 1.4, r.cy); x.globalAlpha = .7; x.stroke(); break;
      case ST.Scope: {
        const rad = Math.min(r.w, r.h) / 2; x.beginPath(); x.arc(r.cx, r.cy, rad, 0, Math.PI * 2); x.stroke();
        x.beginPath(); x.arc(r.cx, r.cy, rad * .35, 0, Math.PI * 2);
        for (const [a, b] of [[0, 1], [1, 0], [0, -1], [-1, 0]]) { x.moveTo(r.cx + a * rad * .55, r.cy + b * rad * .55); x.lineTo(r.cx + a * rad * 1.15, r.cy + b * rad * 1.15); }
        x.stroke(); break;
      }
      case ST.Particle: {
        box(); x.globalAlpha = .9;
        for (let k = 0; k < 14; k++) { const a = hash(r.i, k * 3 + 1) * Math.PI * 2, d = Math.sqrt(hash(r.i, k * 3 + 2)) * Math.max(r.w, r.h) * .75, s = (1 + hash(r.i, k * 3) * 2.5) * px;
          x.fillRect(r.cx + Math.cos(a) * d - s / 2, r.cy + Math.sin(a) * d - s / 2, s, s); }
        break;
      }
      case ST.Win2K: {
        const tb = fs * 1.5;
        x.lineWidth = Math.max(1, 2 * px); x.strokeStyle = '#d4d0c8'; x.strokeRect(r.x, r.y, r.w, r.h);
        const g = x.createLinearGradient(r.x, 0, r.x + r.w, 0); g.addColorStop(0, '#0a246a'); g.addColorStop(1, '#3a6ea5');
        x.fillStyle = g; x.fillRect(r.x, r.y - tb, r.w, tb);
        const bsz = tb * .7; x.fillStyle = '#d4d0c8'; x.fillRect(r.x + r.w - bsz - tb * .15, r.y - tb + tb * .15, bsz, bsz);
        x.fillStyle = '#000'; x.font = `700 ${bsz * .9}px Arial, sans-serif`; x.textAlign = 'center'; x.fillText('×', r.x + r.w - bsz / 2 - tb * .15, r.y - tb / 2 + px);
        x.font = `600 ${fs}px "JetBrains Mono", ui-monospace, monospace`; x.textAlign = 'left'; x.fillStyle = '#fff';
        if (p.tpos !== 3) x.fillText(txt, r.x + 4 * px, r.y - tb / 2, r.w - bsz - 8 * px);
        x.restore(); continue;
      }
      case ST.Label: {
        box();
        if (p.tpos !== 3) { const tw = x.measureText(txt).width + 8 * px, th = fs * 1.5; x.fillRect(r.x - lw / 2, r.y - th, tw, th); x.fillStyle = '#000'; x.textAlign = 'left'; x.fillText(txt, r.x + 4 * px - lw / 2, r.y - th / 2); }
        x.restore(); continue;
      }
      case ST['Label 2']: {
        x.globalAlpha = .8; box(); x.globalAlpha = 1;
        const ex = r.x + r.w + 10 * px, ey = r.y - 10 * px;
        x.beginPath(); x.moveTo(r.x + r.w, r.y); x.lineTo(ex, ey); x.lineTo(ex + 40 * px, ey); x.stroke();
        if (p.tpos !== 3) { x.textAlign = 'left'; x.fillText(`Object ${r.i + 1}`, ex + 2 * px, ey - fs * .7); }
        x.restore(); continue;
      }
      default: box();
    }
    if (p.tpos !== 3) {
      x.textAlign = 'center'; x.shadowBlur = 0; x.globalAlpha = 1;
      const ty = p.tpos === 1 ? r.y - fs * .8 : p.tpos === 2 ? r.y + r.h + fs * .8 : r.cy;
      x.fillText(txt, r.cx, ty);
    }
    x.restore();
  }
  dst.set(x.getImageData(0, 0, w, h).data);
}
