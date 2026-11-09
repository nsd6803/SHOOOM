// CPU passes for effects that can't be a single fragment shader:
// error-diffusion dithering (sequential by nature) and pixel sorting.
// Signature: fn(src, dst, w, h, params, { px, time }) — RGBA8 buffers, row 0 = top of the image.

export const PALETTES = [
  ['Retro green (4)', ['#0f380f', '#306230', '#8bac0f', '#9bbc0f']],
  ['Grayscale (4)', ['#000000', '#555555', '#aaaaaa', '#ffffff']],
  ['Sepia (4)', ['#2b1d0e', '#6b4423', '#b08a5a', '#efe0c4']],
  ['Ice (4)', ['#0b132b', '#1c2541', '#5bc0be', '#e0fbfc']],
  ['Sunset (4)', ['#2d1b4e', '#a23b72', '#f18f01', '#f5e6a8']],
  ['Neon (4)', ['#0d0221', '#541388', '#ff00a0', '#2de2e6']],
  ['Cyan-magenta (4)', ['#000000', '#55ffff', '#ff55ff', '#ffffff']],
];

const rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const PAL_RGB = PALETTES.map(([, cols]) => cols.map(rgb));

// same maths as adj() in the GLSL header
const adjFn = (bri, con) => {
  const b = bri * .005, k = con < 0 ? 1 + con * .01 : 1 + con * .02;
  return v => { v = (v + b - .5) * k + .5; return v < 0 ? 0 : v > 1 ? 1 : v; };
};

/* ---------- error-diffusion dithering ---------- */
// [divisor, [dx, dy, weight]...] — indices match the first 8 "Algorithm" options
const KERNELS = [
  [16, [[1, 0, 7], [-1, 1, 3], [0, 1, 5], [1, 1, 1]]], // Floyd–Steinberg
  [8, [[1, 0, 1], [2, 0, 1], [-1, 1, 1], [0, 1, 1], [1, 1, 1], [0, 2, 1]]], // Atkinson
  [48, [[1, 0, 7], [2, 0, 5], [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3], [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1]]], // Jarvis–Judice–Ninke
  [42, [[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2], [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1]]], // Stucki
  [32, [[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2]]], // Burkes
  [32, [[1, 0, 5], [2, 0, 3], [-2, 1, 2], [-1, 1, 4], [0, 1, 5], [1, 1, 4], [2, 1, 2], [-1, 2, 2], [0, 2, 3], [1, 2, 2]]], // Sierra
  [16, [[1, 0, 4], [2, 0, 3], [-2, 1, 1], [-1, 1, 2], [0, 1, 3], [1, 1, 2], [2, 1, 1]]], // Sierra two-row
  [4, [[1, 0, 2], [-1, 1, 1], [0, 1, 1]]], // Sierra lite
];

function diffuse(a, gw, gh, L, [div, taps], amount) {
  const M = L - 1, n = taps.length;
  const DX = Int32Array.from(taps, t => t[0]), DY = Int32Array.from(taps, t => t[1]), W = Float32Array.from(taps, t => t[2] * amount / div);
  const OFF = Int32Array.from(taps, t => t[1] * gw + t[0]);
  for (let y = 0, i = 0; y < gh; y++) for (let x = 0; x < gw; x++, i++) {
    const old = a[i];
    let q = Math.round(old * M); q = (q < 0 ? 0 : q > M ? M : q) / M;
    a[i] = q;
    const e = old - q;
    if (e === 0) continue;
    for (let k = 0; k < n; k++) {
      const xx = x + DX[k];
      if (xx < 0 || xx >= gw || y + DY[k] >= gh) continue;
      a[i + OFF[k]] += e * W[k];
    }
  }
}

export function ditherCPU(src, dst, w, h, p, { px }) {
  const s = Math.max(1, Math.round(p.pixel * px)), gw = Math.ceil(w / s), gh = Math.ceil(h / s), n = gw * gh;
  const ch = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const off = [[0, 0], [0, 0], [0, 0]];
  if (p.chroma) [p.rang, p.gang, p.bang].forEach((a, c) => {
    const r = a * Math.PI / 180, D = p.disp * px;
    off[c] = [Math.round(Math.cos(r) * D), Math.round(Math.sin(r) * D)];
  });
  // 1. average each cell (strided, ≤16 samples), with optional per-channel displacement
  const st = Math.max(1, Math.floor(s / 4));
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    const i = gy * gw + gx;
    for (let c = 0; c < 3; c++) {
      let sum = 0, cnt = 0;
      for (let sy = st >> 1; sy < s; sy += st) for (let sx = st >> 1; sx < s; sx += st) {
        let x = gx * s + sx + off[c][0], y = gy * s + sy + off[c][1];
        x = x < 0 ? 0 : x >= w ? w - 1 : x; y = y < 0 ? 0 : y >= h ? h - 1 : y;
        sum += src[(y * w + x) * 4 + c]; cnt++;
      }
      ch[c][i] = sum / cnt / 255;
    }
  }
  // 2. sharpen, adjustments, gamma
  if (p.sharpen) for (let c = 0; c < 3; c++) {
    const a = ch[c], b = a.slice();
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const i = y * gw + x;
      const nb = (b[y * gw + Math.max(0, x - 1)] + b[y * gw + Math.min(gw - 1, x + 1)] + b[Math.max(0, y - 1) * gw + x] + b[Math.min(gh - 1, y + 1) * gw + x]) * .25;
      a[i] = b[i] + (b[i] - nb) * p.sharpen;
    }
  }
  const adj = adjFn(p.bri, p.con), g = 1 / p.gamma;
  if (p.bri || p.con || g !== 1) for (let c = 0; c < 3; c++) {
    const a = ch[c];
    if (g === 1) for (let i = 0; i < n; i++) a[i] = adj(a[i]);
    else for (let i = 0; i < n; i++) a[i] = Math.pow(adj(a[i]), g);
  }
  // 3. quantize with error diffusion
  const mode = p.mode, K = KERNELS[p.algo] || KERNELS[0], amt = p.intensity;
  let lum = null;
  if (mode === 3) ch.forEach(a => diffuse(a, gw, gh, p.depth, K, amt));
  else {
    lum = new Float32Array(n);
    for (let i = 0; i < n; i++) lum[i] = .2126 * ch[0][i] + .7152 * ch[1][i] + .0722 * ch[2][i];
    diffuse(lum, gw, gh, mode === 1 ? p.levels : mode === 2 ? 4 : 2, K, amt);
  }
  // 4. colorize and expand cells back to pixels
  const fg = rgb(p.fg), bg = rgb(p.bg), pal = PAL_RGB[p.pal] || PAL_RGB[0], col = [0, 0, 0];
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    const i = gy * gw + gx;
    if (mode === 3) for (let c = 0; c < 3; c++) col[c] = ch[c][i] * 255;
    else if (mode === 2) { const k = pal[Math.round(lum[i] * 3)]; col[0] = k[0]; col[1] = k[1]; col[2] = k[2]; }
    else if (mode === 4) for (let c = 0; c < 3; c++) col[c] = lum[i] > .5 ? ch[c][i] * 255 : bg[c];
    else for (let c = 0; c < 3; c++) col[c] = bg[c] + (fg[c] - bg[c]) * lum[i];
    const x1 = Math.min(w, (gx + 1) * s), y1 = Math.min(h, (gy + 1) * s);
    for (let y = gy * s; y < y1; y++) for (let x = gx * s, o = (y * w + x) * 4; x < x1; x++, o += 4) {
      dst[o] = col[0]; dst[o + 1] = col[1]; dst[o + 2] = col[2]; dst[o + 3] = 255;
    }
  }
}

/* ---------- pixel sort ---------- */
const mulberry = a => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

export function pixelSortCPU(src, dst, w, h, p, { px, time }) {
  const N = w * h, adj = adjFn(p.bri, p.con);
  const base = new Uint8ClampedArray(N * 4);
  for (let i = 0; i < N * 4; i += 4) {
    base[i] = adj(src[i] / 255) * 255; base[i + 1] = adj(src[i + 1] / 255) * 255; base[i + 2] = adj(src[i + 2] / 255) * 255; base[i + 3] = 255;
  }
  dst.set(base);
  // luma decides what gets sorted; the sort key depends on the mode
  const lum = new Float32Array(N), key = new Float32Array(N);
  for (let i = 0, o = 0; i < N; i++, o += 4) {
    const r = base[o] / 255, g = base[o + 1] / 255, b = base[o + 2] / 255;
    lum[i] = .2126 * r + .7152 * g + .0722 * b;
    if (p.mode === 0) key[i] = lum[i];
    else {
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
      if (p.mode === 2) key[i] = mx ? d / mx : 0;
      else key[i] = !d ? 0 : mx === r ? ((g - b) / d + 6) % 6 / 6 : mx === g ? ((b - r) / d + 2) / 6 : ((r - g) / d + 4) / 6;
    }
  }
  const maxLen = Math.max(2, Math.round(p.length * px)), rnd = p.rand, amt = p.intensity, dir = p.reverse ? -1 : 1;
  const seed = Math.floor(time * 1000) | 0;
  const line = new Int32Array(w + h), span = [];
  const flush = () => {
    const n = span.length;
    if (n > 1) {
      const order = span.slice().sort((a, b) => (key[a] - key[b]) * dir);
      for (let j = 0; j < n; j++) {
        const d = span[j] * 4, s = order[j] * 4;
        for (let c = 0; c < 3; c++) dst[d + c] = base[d + c] + (base[s + c] - base[d + c]) * amt;
      }
    }
    span.length = 0;
  };
  const sortLine = (len, li) => {
    const r = mulberry(li * 7919 + seed);
    let lim = maxLen * (1 - rnd * r());
    for (let k = 0; k < len; k++) {
      const i = line[k];
      if (lum[i] >= p.threshold) {
        span.push(i);
        if (span.length >= lim) { flush(); lim = maxLen * (1 - rnd * r()); }
      } else if (span.length) { flush(); lim = maxLen * (1 - rnd * r()); }
    }
    flush();
  };
  if (p.dir === 0) for (let y = 0; y < h; y++) { for (let x = 0; x < w; x++) line[x] = y * w + x; sortLine(w, y); }
  else if (p.dir === 1) for (let x = 0; x < w; x++) { for (let y = 0; y < h; y++) line[y] = y * w + x; sortLine(h, x); }
  else for (let x0 = -(h - 1); x0 < w; x0++) { // diagonal: top-left → bottom-right
    let n = 0;
    for (let y = Math.max(0, -x0); y < h && x0 + y < w; y++) line[n++] = y * w + x0 + y;
    sortLine(n, x0 + h);
  }
}
