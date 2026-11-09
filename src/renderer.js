import { HEADER, EFFECT_MAP } from './effects.js';

const VS = `#version 300 es
out vec2 v_uv; uniform float u_flip;
void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2))*2.-1.;
 v_uv=p*.5+.5; if(u_flip>.5) v_uv.y=1.-v_uv.y; gl_Position=vec4(p,0.,1.);}`;

const COPY = HEADER + `void main(){o=vec4(texture(u_tex,v_uv).rgb,1.);}`;

const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);

export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, alpha: false, antialias: false, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    this.canvas = canvas;
    this.maxSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
    this.vao = gl.createVertexArray();
    this.progs = new Map();
    this.glyphTex = new Map();
    this.src = this._tex();
    this.srcW = 0; this.srcH = 0;
    this.fb = [null, null];
    this.w = 0; this.h = 0;
    this.copy = this._prog(COPY, 'copy');
    this.errors = new Set();
  }

  _tex() {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  _prog(fs, name) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(name + ': ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(name + ': ' + gl.getProgramInfoLog(p));
    const locs = new Map();
    return { p, loc: n => { if (!locs.has(n)) locs.set(n, gl.getUniformLocation(p, n)); return locs.get(n); } };
  }

  _effectProg(def) {
    if (this.progs.has(def.id)) return this.progs.get(def.id);
    let prog = null;
    try { prog = this._prog(HEADER + def.frag, def.id); }
    catch (e) { console.error(e); this.errors.add(def.id); }
    this.progs.set(def.id, prog);
    return prog;
  }

  _glyphs(str) {
    if (this.glyphTex.has(str)) return this.glyphTex.get(str);
    if (this.glyphTex.size > 24) { // custom charsets change per keystroke: keep the cache small
      for (const g of this.glyphTex.values()) this.gl.deleteTexture(g.t);
      this.glyphTex.clear();
    }
    const chars = [...str];
    const S = Math.max(16, Math.min(64, Math.floor(4096 / chars.length))); // keep the atlas ≤ 4096 px wide
    const c = document.createElement('canvas'); c.width = S * chars.length; c.height = S;
    const x = c.getContext('2d');
    x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = '#fff'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = `700 ${S * .82}px "JetBrains Mono", ui-monospace, Menlo, Consolas, monospace`;
    chars.forEach((ch, k) => {
      if ('░▒▓█'.includes(ch)) { // draw block shades as patterns so they don't depend on fonts
        const d = { '░': .25, '▒': .5, '▓': .75, '█': 1 }[ch];
        x.globalAlpha = d; x.fillRect(k * S + 2, 2, S - 4, S - 4); x.globalAlpha = 1;
      } else x.fillText(ch, k * S + S / 2, S / 2 + 2);
    });
    const gl = this.gl, t = this._tex();
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    const g = { t, count: chars.length };
    this.glyphTex.set(str, g);
    return g;
  }

  setSize(w, h) {
    w = Math.max(2, Math.round(w)); h = Math.max(2, Math.round(h));
    if (w === this.w && h === this.h) return;
    const gl = this.gl;
    this.w = w; this.h = h;
    this.canvas.width = w; this.canvas.height = h;
    for (let i = 0; i < 2; i++) {
      if (this.fb[i]) { gl.deleteFramebuffer(this.fb[i].f); gl.deleteTexture(this.fb[i].t); }
      const t = this._tex();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      this.fb[i] = { f, t };
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  upload(source, w, h) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.src);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    this.srcW = w; this.srcH = h;
  }

  _common(prog, time) {
    const gl = this.gl;
    gl.uniform1i(prog.loc('u_tex'), 0);
    gl.uniform2f(prog.loc('u_res'), this.w, this.h);
    gl.uniform1f(prog.loc('u_time'), time);
    gl.uniform1f(prog.loc('u_px'), Math.min(this.w, this.h) / 1080);
    gl.uniform1f(prog.loc('u_flip'), 0);
  }

  _mips(tex, on) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (on) gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, on ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  }

  // read the current frame back, run a JS pass, upload the result as the next ping-pong target
  _cpuPass(def, e, cur, out, time) {
    const gl = this.gl, n = this.w * this.h * 4;
    if (!this.cpuIn || this.cpuIn.length !== n) { this.cpuIn = new Uint8Array(n); this.cpuOut = new Uint8Array(n); }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb[cur].f);
    gl.readPixels(0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, this.cpuIn);
    try { def.cpu(this.cpuIn, this.cpuOut, this.w, this.h, e.p, { px: Math.min(this.w, this.h) / 1080, time }); }
    catch (err) { console.error(err); this.errors.add(def.id); this.cpuOut.set(this.cpuIn); }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fb[out].t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, this.cpuOut);
  }

  render(stack, time = 0, bypass = false) {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, this.w, this.h);
    gl.disable(gl.BLEND);

    // 1. source -> fb0 (resample to output size)
    this._mips(this.src, this.srcW > this.w * 1.25);
    gl.useProgram(this.copy.p); this._common(this.copy, time);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb[0].f);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    let cur = 0;

    // 2. effect passes
    if (!bypass) for (const e of stack) {
      if (!e.on) continue;
      const def = EFFECT_MAP[e.type]; if (!def) continue;
      const inT = this.fb[cur].t, out = 1 - cur;
      if (def.cpu && (!def.frag || !def.cpuWhen || def.cpuWhen(e.p))) { this._cpuPass(def, e, cur, out, time); cur = out; continue; }
      const prog = this._effectProg(def); if (!prog) continue;
      const g = def.glyphs ? this._glyphs(def.glyphs(e.p)) : null; // may bind a new texture: do it before binding input
      this._mips(inT, !!def.mips);
      gl.useProgram(prog.p); this._common(prog, time);
      for (const p of def.params) {
        if (p.type === 'head' || p.type === 'text') continue;
        const v = e.p[p.id] ?? p.def, l = prog.loc('u_' + p.id);
        if (!l) continue;
        if (p.type === 'color') gl.uniform3fv(l, hex(v)); else gl.uniform1f(l, +v);
      }
      if (g) {
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, g.t);
        gl.uniform1i(prog.loc('u_glyphs'), 1); gl.uniform1f(prog.loc('u_count'), g.count);
        gl.activeTexture(gl.TEXTURE0);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fb[out].f);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (def.mips) this._mips(inT, false);
      cur = out;
    }

    // 3. present (flip to canvas orientation)
    this._mips(this.fb[cur].t, false);
    gl.useProgram(this.copy.p); this._common(this.copy, time);
    gl.uniform1f(this.copy.loc('u_flip'), 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
