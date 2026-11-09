// Effect library. Every effect is one pass: a fragment shader, or (for sequential algorithms) a CPU function.
// Pixel-sized params are expressed in "1080p pixels": the shader multiplies them by u_px
// (= min(width,height)/1080), so a preview and a 4K export look the same.
import { PALETTES, ditherCPU, pixelSortCPU } from './cpu.js';
import { TRACK_STYLES, TRACK_FILTERS, blobTrackCPU } from './track.js';

export const HEADER = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_tex;
uniform vec2 u_res;
uniform float u_time;
uniform float u_px;
uniform float u_bri,u_con;
float hash12(vec2 p){vec3 p3=fract(vec3(p.xyx)*.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}
vec2 hash22(vec2 p){vec3 p3=fract(vec3(p.xyx)*vec3(.1031,.1030,.0973));p3+=dot(p3,p3.yzx+33.33);return fract((p3.xx+p3.yz)*p3.zy);}
float luma(vec3 c){return dot(c,vec3(.2126,.7152,.0722));}
vec3 tex(vec2 uv){return texture(u_tex,uv).rgb;}
float vnoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(hash12(i),hash12(i+vec2(1,0)),f.x),mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),f.x),f.y);}
vec3 adj(vec3 c){float k=u_con<0.?1.+u_con*.01:1.+u_con*.02; return clamp((c+u_bri*.005-.5)*k+.5,0.,1.);}
float bayer2(vec2 a){a=floor(a);return fract(a.x/2.+a.y*a.y*.75);}
#define bayer4(a) (bayer2(.5*(a))*.25+bayer2(a))
#define bayer8(a) (bayer4(.5*(a))*.25+bayer2(a))
#define bayer16(a) (bayer8(.5*(a))*.25+bayer2(a))
const mat3 toYIQ=mat3(.299,.596,.211,.587,-.274,-.523,.114,-.322,.312);
const mat3 toRGB=mat3(1.,1.,1.,.956,-.272,-1.106,.621,-.647,1.703);
`;

/* ---------- param helpers ----------
   R = slider, S = select, C = color, T = toggle, X = text, H = section heading.
   when(fn, ...params) shows those params only while fn(effectParams) is true. */
const R = (id, name, min, max, def, step) => ({ id, name, type: 'range', min, max, def, step: step ?? (max - min) / 200 });
const S = (id, name, options, def = 0) => ({ id, name, type: 'select', options, def });
const C = (id, name, def) => ({ id, name, type: 'color', def });
const T = (id, name, def = 0) => ({ id, name, type: 'toggle', def });
const X = (id, name, def) => ({ id, name, type: 'text', def });
const H = name => ({ id: '_' + name, name, type: 'head' });
const when = (fn, ...ps) => ps.map(p => ({ ...p, show: fn }));
const ADJ = () => [H('Adjustments'), R('bri', 'Brightness', -100, 100, 0, 1), R('con', 'Contrast', -100, 100, 0, 1)];

/* ---------- character sets (sparse → dense) ---------- */
export const CHARSET_NAMES = ['Standard', 'Blocks', 'Binary', 'Detailed', 'Minimal', 'Alphabetic', 'Numeric', 'Math', 'Symbols', 'Katakana', 'Custom'];
const CHARSETS = [
  ' .:-=+*#%@',
  ' ░▒▓█',
  ' 10',
  ' .\'`^",:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$',
  ' .+#',
  ' ilrtjfcvxzsnuoaeykhdbpqgwmNMW',
  ' 1723456980',
  ' ·-+×÷=≠≈±∑∏∫∞',
  ' .,:;!?*+=#%&$@',
  ' ｰｨｸｼｽｦｱｳｴｵｶｷｹｺｻｾｿﾀﾂﾃﾅﾆﾇﾈﾊﾋﾎﾏﾐﾑﾒﾓﾔﾕﾗﾘﾜ0123456789',
];
const CUSTOM = CHARSET_NAMES.length - 1;
const charsOf = p => (p.charset === CUSTOM ? String(p.chars || '') : CHARSETS[p.charset] ?? CHARSETS[0]).slice(0, 96) || ' ';
const CHARSET_PARAMS = def => [S('charset', 'Character set', CHARSET_NAMES, def), ...when(p => p.charset === CUSTOM, X('chars', 'Custom characters', ' .:-=+*#%@'))];

/* ---------- dithering tables ---------- */
const DITHER_ALGOS = ['Floyd–Steinberg', 'Atkinson', 'Jarvis–Judice–Ninke', 'Stucki', 'Burkes', 'Sierra', 'Sierra two-row', 'Sierra lite',
  'Bayer 2×2', 'Bayer 4×4', 'Bayer 8×8', 'Bayer 16×16', 'Clustered dot', 'Blue noise', 'Interleaved gradient', 'Crosshatch'];
const PAL_GLSL = (() => {
  const v = PALETTES.flatMap(([, cs]) => cs).map(h => `vec3(${[1, 3, 5].map(i => (parseInt(h.slice(i, i + 2), 16) / 255).toFixed(4)).join(',')})`);
  return `const vec3 PAL[${v.length}]=vec3[${v.length}](${v.join(',')});`;
})();

export const GROUPS = ['Basic', 'Retro', 'Digital', 'Print', 'Stylize', 'Light', 'Distort'];

export const EFFECTS = [
  /* ===================== Basic ===================== */
  {
    id: 'adjust', name: 'Adjust', group: 'Basic',
    params: [R('brightness', 'Brightness', -1, 1, 0), R('contrast', 'Contrast', 0, 2, 1), R('saturation', 'Saturation', 0, 2, 1), R('hue', 'Hue', -180, 180, 0, 1), R('temp', 'Temperature', -1, 1, 0)],
    frag: `uniform float u_brightness,u_contrast,u_saturation,u_hue,u_temp;
void main(){vec3 c=tex(v_uv);
 c+=u_brightness*.5; c=(c-.5)*u_contrast+.5;
 c*=vec3(1.+u_temp*.18,1.,1.-u_temp*.18);
 float l=luma(c); c=mix(vec3(l),c,u_saturation);
 vec3 y=toYIQ*c; float h=atan(y.z,y.y)+radians(u_hue); float ch=length(y.yz); y.yz=vec2(cos(h),sin(h))*ch; c=toRGB*y;
 o=vec4(clamp(c,0.,1.),1.);}`
  },
  {
    id: 'vignette', name: 'Vignette', group: 'Basic',
    params: [R('amount', 'Amount', 0, 1, .5), R('radius', 'Radius', .2, 1.5, .75), R('soft', 'Softness', .05, 1, .5)],
    frag: `uniform float u_amount,u_radius,u_soft;
void main(){vec3 c=tex(v_uv); vec2 p=(v_uv-.5)*vec2(u_res.x/u_res.y,1.)*1.4;
 float v=smoothstep(u_radius,u_radius-u_soft,length(p)); c*=mix(1.,v,u_amount); o=vec4(c,1.);}`
  },
  {
    id: 'sharpen', name: 'Sharpen', group: 'Basic',
    params: [R('amount', 'Amount', 0, 3, 1), R('radius', 'Radius', .5, 4, 1)],
    frag: `uniform float u_amount,u_radius;
void main(){vec2 d=u_radius*u_px/u_res; vec3 c=tex(v_uv);
 vec3 b=(tex(v_uv+vec2(d.x,0))+tex(v_uv-vec2(d.x,0))+tex(v_uv+vec2(0,d.y))+tex(v_uv-vec2(0,d.y)))*.25;
 o=vec4(clamp(c+(c-b)*u_amount,0.,1.),1.);}`
  },
  {
    id: 'threshold', name: 'Threshold', group: 'Basic',
    params: [R('levels', 'Levels', 2, 8, 2, 1), R('point', 'Threshold point', .1, .9, .5, .05), T('dither', 'Dither'), T('invert', 'Invert'),
      ...ADJ(), H('Color'), S('mode', 'Mode', ['Mono', 'Original']), ...when(p => p.mode === 0, C('fg', 'Foreground', '#ffffff'), C('bg', 'Background', '#000000'))],
    frag: `uniform float u_levels,u_point,u_dither,u_invert,u_mode; uniform vec3 u_fg,u_bg;
float q(float v,float th){float L=u_levels-1.; return clamp(floor(clamp(v+.5-u_point,0.,1.)*L+.5+th),0.,L)/L;}
void main(){vec3 c=adj(tex(v_uv)); float th=u_dither>.5?bayer8(gl_FragCoord.xy/max(1.,floor(u_px+.5)))-.5:0.;
 vec3 r;
 if(u_mode<.5){float v=q(luma(c),th); if(u_invert>.5) v=1.-v; r=mix(u_bg,u_fg,v);}
 else{r=vec3(q(c.r,th),q(c.g,th),q(c.b,th)); if(u_invert>.5) r=1.-r;}
 o=vec4(r,1.);}`
  },

  /* ===================== Retro ===================== */
  {
    id: 'vhs', name: 'VHS', group: 'Retro',
    params: [R('wobble', 'Distortion', 0, 1, .5, .05), R('noise', 'Noise', 0, 1, .3, .05), R('bleed', 'Color bleed', 0, 1, .5, .05), R('scan', 'Scanlines', 0, 1, .3, .05), R('tracking', 'Tracking error', 0, 1, .2, .05), ...ADJ()],
    frag: `uniform float u_wobble,u_bleed,u_noise,u_tracking,u_scan;
void main(){vec2 px=u_px/u_res; vec2 uv=v_uv; float t=u_time;
 float line=floor(v_uv.y*u_res.y/u_px*.5);
 uv.x+=(vnoise(vec2(line*.05,t*2.))-.5)*u_wobble*8.*px.x+sin(v_uv.y*20.+t*3.)*u_wobble*2.*px.x;
 float band=fract(t*.13); float tb=smoothstep(.05,0.,abs(v_uv.y-band))*u_tracking*2.;
 uv.x+=tb*(hash12(vec2(line,floor(t*24.)))-.5)*50.*px.x;
 vec3 yiq=toYIQ*texture(u_tex,uv).rgb;
 vec2 ch=vec2(0.); float w=0.; float rad=u_bleed*14.;
 for(int i=-6;i<=6;i++){float f=float(i)/6.; float wi=1.-abs(f)*.6;
  ch+=(toYIQ*texture(u_tex,uv+vec2((f*rad+u_bleed*5.)*px.x,0.)).rgb).yz*wi; w+=wi;}
 yiq.yz=mix(yiq.yz,ch/w,clamp(u_bleed*2.,0.,1.))*(1.+u_bleed*.35);
 vec3 c=toRGB*yiq;
 float n=hash12(floor(v_uv*u_res/(u_px*1.5))+fract(t*7.)*137.);
 c+=(n-.5)*u_noise*.35; c+=tb*n*.6;
 c=mix(c,c*vec3(1.02,.98,1.05)+vec3(.02,0.,.03),u_bleed*.5);
 c*=1.-u_scan*.45*(.5+.5*cos(gl_FragCoord.y/u_px*3.14159));
 o=vec4(adj(clamp(c,0.,1.)),1.);}`
  },
  {
    id: 'crt', name: 'CRT monitor', group: 'Retro',
    params: [R('scan', 'Scanlines', 0, 1, .5), R('lines', 'Line density', 120, 1080, 480, 1), R('curve', 'Curvature', 0, 1, .3), R('mask', 'RGB mask', 0, 1, .35), R('vig', 'Vignette', 0, 1, .5)],
    frag: `uniform float u_scan,u_lines,u_curve,u_mask,u_vig;
void main(){vec2 uv=v_uv*2.-1.; uv+=uv*(uv.yx*uv.yx)*u_curve*.3; uv=uv*.5+.5;
 if(uv.x<0.||uv.x>1.||uv.y<0.||uv.y>1.){o=vec4(0,0,0,1);return;}
 vec3 c=tex(uv);
 float s=.5-.5*cos(uv.y*u_lines*6.28318); c*=1.-u_scan*.55*s; c*=1.+u_scan*.25;
 float mx=mod(floor(gl_FragCoord.x/max(1.,u_px*1.5)),3.);
 vec3 m=mx<1.?vec3(1.,.55,.55):(mx<2.?vec3(.55,1.,.55):vec3(.55,.55,1.));
 c*=mix(vec3(1.),m*1.25,u_mask);
 float v=uv.x*uv.y*(1.-uv.x)*(1.-uv.y)*16.; c*=mix(1.,pow(clamp(v,0.,1.),.3),u_vig);
 o=vec4(clamp(c,0.,1.),1.);}`
  },
  {
    id: 'grain', name: 'Film grain', group: 'Retro',
    params: [R('amount', 'Amount', 0, 1, .35), R('size', 'Size', 1, 4, 1.4), R('color', 'Color', 0, 1, .2), R('speed', 'Animation', 0, 1, 1)],
    frag: `uniform float u_amount,u_size,u_color,u_speed;
// value noise whose lattice values are re-rolled every frame (seed goes into the hash, not the coordinates),
// so grain flickers in place instead of sliding across the image
float gn(vec2 p,vec2 seed){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
 return mix(mix(hash12(i+seed),hash12(i+vec2(1,0)+seed),f.x),mix(hash12(i+vec2(0,1)+seed),hash12(i+vec2(1,1)+seed),f.x),f.y);}
void main(){vec3 c=tex(v_uv); vec2 p=gl_FragCoord.xy/(u_px*u_size);
 float fr=floor(u_time*u_speed*24.);
 vec2 sd=vec2(hash12(vec2(fr,3.7)),hash12(vec2(9.1,fr)))*4096.;
 vec3 n=vec3(gn(p,sd),gn(p,sd+vec2(517.,131.)),gn(p,sd+vec2(263.,947.)))-.5; n*=2.;
 n=mix(vec3(n.x),n,u_color);
 float l=luma(c); float m=1.-pow(abs(l-.5)*2.,2.);
 c+=n*u_amount*.4*(.35+.65*m); o=vec4(clamp(c,0.,1.),1.);}`
  },

  /* ===================== Digital ===================== */
  {
    id: 'glitch', name: 'Glitch', group: 'Digital',
    params: [R('intensity', 'Intensity', 0, 1, .5), R('block', 'Block size', 4, 200, 40, 1), R('speed', 'Speed', 0, 10, 3), R('split', 'RGB split', 0, 1, .6)],
    frag: `uniform float u_intensity,u_block,u_speed,u_split;
void main(){float t=floor(u_time*u_speed*4.)+1.;
 vec2 p=v_uv*u_res/u_px;
 float r1=hash12(vec2(floor(p.y/u_block),t)), r2=hash12(vec2(floor(p.y/(u_block*.25)),t+7.));
 float on=step(1.-u_intensity*.6,r1);
 vec2 cell=floor(p/vec2(u_block*3.,u_block));
 float blk=step(1.-u_intensity*.25,hash12(cell+t*1.7));
 vec2 uv=v_uv; uv.x+=(r2-.5)*.3*u_intensity*on+blk*(hash12(cell+3.1+t)-.5)*.2; uv.x=fract(uv.x);
 float s=u_split*u_intensity*(on+blk)*.02+u_split*u_intensity*.002;
 vec3 c=vec3(texture(u_tex,uv+vec2(s,0)).r,texture(u_tex,uv).g,texture(u_tex,uv-vec2(s,0)).b);
 if(blk>0.&&hash12(cell+t*2.3)>.7) c=c.gbr;
 if(blk>0.&&hash12(cell+t*4.1)>.85) c=1.-c;
 c+=(hash12(floor(p)+t)-.5)*.2*u_intensity*on;
 o=vec4(clamp(c,0.,1.),1.);}`
  },
  {
    id: 'rgb', name: 'RGB shift', group: 'Digital',
    params: [R('amount', 'Shift, px', 0, 60, 8), R('angle', 'Angle', 0, 360, 0, 1), R('radial', 'Radial', 0, 1, 0)],
    frag: `uniform float u_amount,u_angle,u_radial;
void main(){vec2 px=u_px/u_res; float a=radians(u_angle);
 vec2 rd=(v_uv-.5)*2.; vec2 d=mix(vec2(cos(a),sin(a)),rd,u_radial)*u_amount*px;
 o=vec4(texture(u_tex,v_uv+d).r,texture(u_tex,v_uv).g,texture(u_tex,v_uv-d).b,1.);}`
  },
  {
    id: 'pixelate', name: 'Pixelate', group: 'Digital', mips: true,
    params: [R('size', 'Pixel size', 1, 120, 12, 1)],
    frag: `uniform float u_size;
void main(){float s=max(1.,u_size*u_px); vec2 cell=floor(gl_FragCoord.xy/s);
 o=vec4(textureLod(u_tex,(cell+.5)*s/u_res,log2(s)-.5).rgb,1.);}`
  },
  {
    id: 'blockify', name: 'Blockify', group: 'Digital', mips: true,
    params: [S('style', 'Style', ['Full blocks', 'Shaded', 'Outline']), R('block', 'Block size', 4, 40, 8, 1), R('border', 'Border width', 0, 3, 1, .5),
      ...ADJ(), H('Color'), S('mode', 'Mode', ['Preserve colors', 'Grayscale']), C('bcol', 'Border color', '#000000')],
    frag: `uniform float u_style,u_block,u_border,u_mode; uniform vec3 u_bcol;
void main(){float s=max(2.,u_block*u_px); vec2 fc=gl_FragCoord.xy; vec2 cell=floor(fc/s); vec2 lp=fc-cell*s;
 vec3 c=adj(textureLod(u_tex,(cell+.5)*s/u_res,log2(s)-.5).rgb); if(u_mode>.5) c=vec3(luma(c));
 float bw=u_border*u_px; float e=min(min(lp.x,lp.y),min(s-lp.x,s-lp.y)); bool grid=bw>0.&&(lp.x<bw||lp.y<bw);
 vec3 r;
 if(u_style<.5){r=grid?u_bcol:c;}
 else if(u_style<1.5){float bev=max(s*.16,1.); float sh=0.;
  if(lp.y<bev&&lp.y<=lp.x&&lp.y<=s-lp.x) sh=.3;
  else if(lp.x<bev&&lp.x<s-lp.y) sh=.15;
  else if(s-lp.y<bev) sh=-.35;
  else if(s-lp.x<bev) sh=-.2;
  r=grid?u_bcol:clamp(c*(1.+sh)+sh*.08,0.,1.);}
 else{float w=max(bw,1.); float g=max(u_px,s*.1); r=(e>=g&&e<g+w)?c:u_bcol;}
 o=vec4(r,1.);}`
  },
  {
    id: 'pixelsort', name: 'Pixel sort', group: 'Digital', cpu: pixelSortCPU,
    params: [S('dir', 'Direction', ['Horizontal', 'Vertical', 'Diagonal']), S('mode', 'Sort mode', ['Brightness', 'Hue', 'Saturation']),
      R('threshold', 'Threshold', 0, .5, .3, .05), R('length', 'Streak length', 10, 300, 100, 10), R('intensity', 'Intensity', 0, 1, .8, .05),
      R('rand', 'Randomness', 0, 1, .3, .05), T('reverse', 'Reverse'), ...ADJ()],
  },
  {
    id: 'dither', name: 'Dither', group: 'Digital', mips: true, cpu: ditherCPU, cpuWhen: p => p.algo < 8,
    params: [S('algo', 'Algorithm', DITHER_ALGOS, 10), R('intensity', 'Intensity', .1, 2, 1, .05),
      ...when(p => p.algo === 12 || p.algo === 15, S('msize', 'Matrix size', ['2×2 (coarse)', '4×4 (medium)', '8×8 (fine)', '16×16 (very fine)'], 1)),
      R('pixel', 'Pixel size', 1, 12, 2, 1),
      ...ADJ(), R('gamma', 'Gamma', .5, 2, 1, .05), R('sharpen', 'Sharpen', -1, 1, 0, .1),
      H('Color'), S('mode', 'Mode', ['Mono', 'Tonal', 'Palette', 'RGB', 'Original']),
      ...when(p => p.mode === 1, R('levels', 'Levels', 2, 32, 4, 1)),
      ...when(p => p.mode === 2, S('pal', 'Palette', PALETTES.map(p => p[0]))),
      ...when(p => p.mode === 3, R('depth', 'Color depth', 2, 64, 2, 1)),
      ...when(p => p.mode <= 1, C('fg', 'Foreground', '#ffffff')),
      ...when(p => p.mode <= 1 || p.mode === 4, C('bg', 'Background', '#000000')),
      H('Chromatic'), T('chroma', 'Chromatic effects'),
      ...when(p => !!p.chroma, R('disp', 'Max displace, px', 0, 50, 6, 1), R('rang', 'Red channel angle', 0, 360, 23, 1), R('gang', 'Green channel angle', 0, 360, 50, 1), R('bang', 'Blue channel angle', 0, 360, 80, 1))],
    frag: `uniform float u_algo,u_intensity,u_msize,u_pixel,u_gamma,u_sharpen,u_mode,u_levels,u_pal,u_depth,u_chroma,u_disp,u_rang,u_gang,u_bang; uniform vec3 u_fg,u_bg;
${PAL_GLSL}
float thmap(vec2 c){
 if(u_algo<8.5) return bayer2(c);
 if(u_algo<9.5) return bayer4(c);
 if(u_algo<10.5) return bayer8(c);
 if(u_algo<11.5) return bayer16(c);
 float n=exp2(u_msize+1.);
 if(u_algo<12.5){vec2 f=fract(c/n)-.5; return clamp(length(f)*1.41,0.,1.);}
 if(u_algo<13.5){float s=0.; for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++) s+=hash12(c+vec2(x,y)); return clamp((hash12(c)-(s-hash12(c))/8.)*1.6+.5,0.,1.);}
 if(u_algo<14.5) return fract(52.9829189*fract(dot(c,vec2(.06711056,.00583715))));
 vec2 f=c/n; return abs(fract((f.x+f.y)*.5)-.5)+abs(fract((f.x-f.y)*.5)-.5);}
float qz(float v,float th,float L){L-=1.; return clamp(floor(v*L+th+.5),0.,L)/L;}
vec3 smp(vec2 uv,float lod){
 if(u_chroma<.5) return textureLod(u_tex,uv,lod).rgb;
 vec2 k=u_disp*u_px/u_res;
 return vec3(textureLod(u_tex,uv+vec2(cos(radians(u_rang)),sin(radians(u_rang)))*k,lod).r,
  textureLod(u_tex,uv+vec2(cos(radians(u_gang)),sin(radians(u_gang)))*k,lod).g,
  textureLod(u_tex,uv+vec2(cos(radians(u_bang)),sin(radians(u_bang)))*k,lod).b);}
void main(){float s=max(1.,floor(u_pixel*u_px+.5)); vec2 cell=floor(gl_FragCoord.xy/s); vec2 cu=(cell+.5)*s/u_res; float lod=max(0.,log2(s)-.5);
 vec3 c=smp(cu,lod);
 if(abs(u_sharpen)>0.){vec2 d=s/u_res; vec3 b=(smp(cu+vec2(d.x,0),lod)+smp(cu-vec2(d.x,0),lod)+smp(cu+vec2(0,d.y),lod)+smp(cu-vec2(0,d.y),lod))*.25; c+=(c-b)*u_sharpen;}
 c=pow(adj(c),vec3(1./u_gamma));
 float th=(thmap(cell)-.5)*u_intensity; float l=luma(c); vec3 r;
 if(u_mode<.5) r=mix(u_bg,u_fg,qz(l,th,2.));
 else if(u_mode<1.5) r=mix(u_bg,u_fg,qz(l,th,u_levels));
 else if(u_mode<2.5) r=PAL[int(u_pal+.5)*4+int(qz(l,th,4.)*3.+.5)];
 else if(u_mode<3.5) r=vec3(qz(c.r,th,u_depth),qz(c.g,th,u_depth),qz(c.b,th,u_depth));
 else r=qz(l,th,2.)>.5?c:u_bg;
 o=vec4(r,1.);}`
  },
  {
    id: 'ascii', name: 'ASCII', group: 'Digital', mips: true, glyphs: charsOf,
    params: [R('cell', 'Cell size', 4, 48, 12, 1), R('spacing', 'Spacing', 0, 1, 0, .05), R('cols', 'Columns (0 = auto)', 0, 500, 0, 10), ...CHARSET_PARAMS(0),
      ...ADJ(), R('sat', 'Saturation', -100, 100, 0, 1), R('hue', 'Hue rotation', 0, 360, 0, 1), R('sharp', 'Sharpness', 0, 100, 0, 1), R('gamma', 'Gamma', .1, 3, 1, .1),
      H('Color'), S('mode', 'Mode', ['Original', 'Mono']), ...when(p => p.mode === 1, C('fg', 'Glyph color', '#7dff8a')), C('bg', 'Background', '#000000'),
      R('intensity', 'Intensity', 0, 2, 1, .1), T('invert', 'Invert')],
    frag: `uniform sampler2D u_glyphs; uniform float u_count,u_cell,u_spacing,u_cols,u_sat,u_hue,u_sharp,u_gamma,u_mode,u_intensity,u_invert; uniform vec3 u_fg,u_bg;
vec3 hueRot(vec3 c,float h){vec3 y=toYIQ*c; float a=atan(y.z,y.y)+radians(h); float ch=length(y.yz); y.yz=vec2(cos(a),sin(a))*ch; return toRGB*y;}
void main(){float s=u_cols>0.?max(2.,u_res.x/u_cols):max(3.,u_cell*u_px);
 vec2 cell=floor(gl_FragCoord.xy/s), lc=fract(gl_FragCoord.xy/s);
 float lod=log2(s)-1.; vec2 cu=(cell+.5)*s/u_res;
 vec3 col=textureLod(u_tex,cu,lod).rgb;
 if(u_sharp>0.){vec2 d=vec2(s)/u_res; vec3 b=(textureLod(u_tex,cu+vec2(d.x,0),lod)+textureLod(u_tex,cu-vec2(d.x,0),lod)+textureLod(u_tex,cu+vec2(0,d.y),lod)+textureLod(u_tex,cu-vec2(0,d.y),lod)).rgb*.25;
  col=clamp(col+(col-b)*u_sharp*.03,0.,1.);}
 col=adj(col); col=mix(vec3(luma(col)),col,1.+u_sat*.01); col=clamp(hueRot(col,u_hue),0.,1.);
 col=pow(col,vec3(1./u_gamma));
 float l=luma(col); if(u_invert>.5) l=1.-l;
 float idx=min(floor(l*u_count),u_count-1.);
 vec2 g=(lc-.5)/(1.-u_spacing*.8)+.5;
 float a=(g.x<0.||g.x>1.||g.y<0.||g.y>1.)?0.:texture(u_glyphs,vec2((idx+g.x)/u_count,g.y)).r;
 vec3 fg=(u_mode<.5?min(col*1.2+.04,1.):u_fg)*u_intensity;
 o=vec4(clamp(mix(u_bg,fg,a),0.,1.),1.);}`
  },
  {
    id: 'matrix', name: 'Matrix rain', group: 'Digital', mips: true, glyphs: charsOf,
    params: [...CHARSET_PARAMS(9), R('cell', 'Cell size', 4, 32, 10, 1), R('spacing', 'Spacing', 0, 1, 0, .05), R('speed', 'Speed', .5, 3, 1, .1),
      R('trail', 'Trail length', 5, 30, 15, 1), S('dir', 'Direction', ['Down', 'Up', 'Left', 'Right']), R('glow', 'Glow', 0, 2, 1, .1), R('bgop', 'Background opacity', 0, 1, .3, .05),
      ...ADJ(), R('thresh', 'Threshold', 0, .5, 0, .01), H('Color'), C('rain', 'Rain color', '#00ff41')],
    frag: `uniform sampler2D u_glyphs; uniform float u_count,u_cell,u_spacing,u_speed,u_trail,u_dir,u_glow,u_bgop,u_thresh; uniform vec3 u_rain;
void main(){float s=max(3.,u_cell*u_px); vec2 fc=gl_FragCoord.xy; vec2 N=ceil(u_res/s);
 vec2 cell=floor(fc/s), lc=fract(fc/s);
 float col,row,rows;
 if(u_dir<.5){col=cell.x;row=cell.y;rows=N.y;}
 else if(u_dir<1.5){col=cell.x;row=N.y-1.-cell.y;rows=N.y;}
 else if(u_dir<2.5){col=cell.y;row=N.x-1.-cell.x;rows=N.x;}
 else{col=cell.y;row=cell.x;rows=N.x;}
 float t=u_time*u_speed, tr=0., head=0.;
 for(int k=0;k<3;k++){float fk=float(k);
  float sp=(.6+hash12(vec2(col,fk*7.1))*.8)*8.;
  float len=rows+u_trail*1.5;
  float h=mod(t*sp+hash12(vec2(col*1.37,fk+3.))*len,len);
  float d=h-row;
  if(d>=0.&&d<u_trail){float v=1.-d/u_trail; if(v>tr){tr=v; head=d<1.?1.:0.;}}}
 // the whole picture is made of glyphs: image brightness sets each glyph's level,
 // "Background opacity" is the level outside the rain, the falling trails light columns up
 vec3 img=adj(textureLod(u_tex,(cell+.5)*s/u_res,log2(s)-1.).rgb);
 float l=luma(img); l=l<u_thresh?0.:pow(l,.65);
 float lit=l*mix(.2+u_bgop,1.4,tr)+head*(.12+.6*l);
 float rate=(1.+hash12(cell.yx)*2.)*(1.+tr*4.);
 float gi=floor(hash12(cell*1.37+floor(t*rate+hash12(cell)*9.)*.731)*u_count);
 vec2 g=(lc-.5)/(1.-u_spacing*.8)+.5;
 float inside=step(0.,g.x)*step(g.x,1.)*step(0.,g.y)*step(g.y,1.);
 vec2 guv=vec2((gi+clamp(g.x,0.,1.))/u_count,clamp(g.y,0.,1.));
 float a=texture(u_glyphs,guv).r*inside, halo=textureLod(u_glyphs,guv,3.).r*inside;
 vec3 rc=mix(u_rain,vec3(1.),clamp(head*.8+pow(lit,4.)*.45,0.,1.));
 vec3 c=rc*lit*(a+halo*u_glow*.45*(.4+tr));
 o=vec4(clamp(c,0.,1.),1.);}`
  },

  /* ===================== Print ===================== */
  {
    id: 'halftone', name: 'Halftone', group: 'Print', mips: true,
    params: [S('shape', 'Shape', ['Circle', 'Square', 'Diamond', 'Line']), R('scale', 'Dot scale', .5, 2, 1, .1), R('size', 'Spacing', 3, 60, 10, 1), R('angle', 'Angle', 0, 90, 45, 1),
      R('soft', 'Softness', 0, 1, .15), T('invert', 'Invert'),
      ...ADJ(), H('Color'), S('mode', 'Mode', ['Mono', 'Original', 'CMYK']), ...when(p => p.mode === 0, C('ink', 'Ink', '#141414')), C('paper', 'Paper', '#f3ecdc')],
    frag: `uniform float u_shape,u_scale,u_size,u_angle,u_soft,u_invert,u_mode; uniform vec3 u_ink,u_paper;
vec4 cmyk(vec3 c){float k=1.-max(max(c.r,c.g),c.b); return vec4((1.-c-k)/max(1.-k,1e-3),k);}
float shp(vec2 p,float v,float s){v=clamp(v,0.,1.); float d,r;
 if(u_shape<.5){d=length(p);r=sqrt(v)*.71;}
 else if(u_shape<1.5){d=max(abs(p.x),abs(p.y));r=sqrt(v)*.5;}
 else if(u_shape<2.5){d=abs(p.x)+abs(p.y);r=sqrt(v)*.71;}
 else{d=abs(p.y);r=v*.5;}
 r*=u_scale; float aa=u_soft*.3+1./s; return 1.-smoothstep(r-aa,r+aa,d);}
float hdot(vec2 f,float ang,float s,int ch,inout vec3 col){float ca=cos(ang),sa=sin(ang); mat2 R=mat2(ca,sa,-sa,ca);
 vec2 p=R*f; vec2 base=floor(p/s); float best=0.;
 for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){vec2 cc=(base+vec2(x,y)+.5)*s;
  vec3 c=adj(textureLod(u_tex,(transpose(R)*cc)/u_res,log2(s)-1.).rgb);
  float v=ch<0?1.-luma(c):cmyk(c)[ch]; if(u_invert>.5) v=1.-v;
  float m=shp((p-cc)/s,v,s); if(m>best){best=m; col=c;}}
 return best;}
void main(){vec2 f=gl_FragCoord.xy; float s=max(2.,u_size*u_px); float a=radians(u_angle); vec3 col=vec3(0);
 if(u_mode<.5){o=vec4(mix(u_paper,u_ink,hdot(f,a,s,-1,col)),1.);return;}
 if(u_mode<1.5){float m=hdot(f,a,s,-1,col); o=vec4(mix(u_paper,col,m),1.);return;}
 float cy=hdot(f,a-radians(30.),s,0,col),mg=hdot(f,a+radians(30.),s,1,col),ye=hdot(f,a-radians(45.),s,2,col),k=hdot(f,a,s,3,col);
 vec3 r=u_paper; r.r*=1.-cy*.95; r.g*=1.-mg*.95; r.b*=1.-ye*.95; r*=1.-k*.9;
 o=vec4(r,1.);}`
  },
  {
    id: 'dots', name: 'Dots', group: 'Print', mips: true,
    params: [S('shape', 'Shape', ['Circle', 'Square', 'Diamond']), S('grid', 'Grid type', ['Square grid', 'Hexagonal grid']), R('size', 'Dot size', .5, 2, 1, .1),
      R('spacing', 'Spacing', .5, 2, 1, .1), R('cell', 'Grid size', 4, 60, 12, 1), T('invert', 'Invert'),
      ...ADJ(), H('Color'), S('mode', 'Mode', ['Original', 'Mono']), ...when(p => p.mode === 1, C('fg', 'Dot color', '#ffffff')), C('bg', 'Background', '#000000')],
    frag: `uniform float u_shape,u_grid,u_size,u_spacing,u_cell,u_invert,u_mode; uniform vec3 u_fg,u_bg;
void main(){float s=max(3.,u_cell*u_px*u_spacing); vec2 fc=gl_FragCoord.xy; vec2 ctr;
 if(u_grid<.5) ctr=(floor(fc/s)+.5)*s;
 else{vec2 r=vec2(s,s*1.7320508), h=r*.5; vec2 a=mod(fc,r)-h, b=mod(fc-h,r)-h; ctr=dot(a,a)<dot(b,b)?fc-a:fc-b;}
 vec3 c=adj(textureLod(u_tex,ctr/u_res,log2(s)-1.).rgb);
 float v=luma(c); if(u_invert>.5) v=1.-v;
 vec2 p=(fc-ctr)/s; float d=u_shape<.5?length(p):u_shape<1.5?max(abs(p.x),abs(p.y)):(abs(p.x)+abs(p.y))*.7071;
 float r=sqrt(clamp(v,0.,1.))*.5*u_size, aa=1./s;
 float m=1.-smoothstep(r-aa,r+aa,d);
 vec3 col=u_mode<.5?min(c*1.15,1.):u_fg;
 o=vec4(mix(u_bg,col,m),1.);}`
  },
  {
    id: 'crosshatch', name: 'Crosshatch', group: 'Print', mips: true,
    params: [R('density', 'Density', 2, 12, 6, 1), R('layers', 'Layers', 1, 4, 3, 1), R('angle', 'Angle', 0, 90, 45, 5), R('width', 'Line width', .5, 3, 1, .25),
      R('rand', 'Randomness', 0, 1, 0, .05), T('invert', 'Invert'), ...ADJ(), H('Color'), C('ink', 'Line color', '#000000'), C('paper', 'Background', '#ffffff')],
    frag: `uniform float u_density,u_layers,u_angle,u_width,u_rand,u_invert; uniform vec3 u_ink,u_paper;
void main(){vec2 f=gl_FragCoord.xy/u_px; float sp=72./u_density;
 float l=luma(adj(textureLod(u_tex,v_uv,log2(max(1.,sp*u_px*.5))).rgb)); float dk=u_invert>.5?l:1.-l;
 float ink=0., hw=u_width*.5*(.6+dk*1.4), aa=.6/u_px;
 for(int k=0;k<4;k++){if(float(k)>=u_layers) break;
  float a=radians(u_angle+(k==1?90.:k==2?45.:k==3?-45.:0.));
  float u=dot(f,vec2(-sin(a),cos(a)))/sp;
  u+=(vnoise(f*.03+float(k)*13.)-.5)*u_rand*1.5;
  float dist=abs(fract(u)-.5)*sp;
  float line=1.-smoothstep(hw-aa,hw+aa,dist);
  float tk=(float(k)+1.)/(u_layers+1.);
  ink=max(ink,line*smoothstep(tk-.05,tk+.1,dk));}
 o=vec4(mix(u_paper,u_ink,ink),1.);}`
  },
  {
    id: 'posterize', name: 'Posterize', group: 'Print',
    params: [R('levels', 'Levels', 2, 12, 5, 1), R('gamma', 'Gamma', .4, 2.5, 1)],
    frag: `uniform float u_levels,u_gamma;
void main(){vec3 c=pow(tex(v_uv),vec3(u_gamma)); float L=u_levels-1.; c=floor(c*L+.5)/L; o=vec4(pow(c,vec3(1./u_gamma)),1.);}`
  },
  {
    id: 'gradmap', name: 'Gradient map', group: 'Print',
    params: [S('palette', 'Palette', ['Duotone', 'Thermal', 'Night vision', 'Sunset']), R('mix', 'Mix', 0, 1, 1), C('dark', 'Shadows', '#0b1d51'), C('light', 'Highlights', '#ff7a59')],
    frag: `uniform float u_palette,u_mix; uniform vec3 u_dark,u_light;
vec3 ramp(float t, vec3 a, vec3 b, vec3 c, vec3 d, vec3 e){t*=4.; return t<1.?mix(a,b,t):t<2.?mix(b,c,t-1.):t<3.?mix(c,d,t-2.):mix(d,e,t-3.);}
void main(){vec3 c=tex(v_uv); float l=clamp(luma(c),0.,1.); vec3 g;
 if(u_palette<.5) g=mix(u_dark,u_light,smoothstep(0.,1.,l));
 else if(u_palette<1.5) g=ramp(l,vec3(0,0,.05),vec3(.25,0,.55),vec3(.85,.1,.25),vec3(1.,.6,0.),vec3(1.,1.,.85));
 else if(u_palette<2.5) g=ramp(l,vec3(0,.02,0),vec3(0,.2,.03),vec3(.15,.6,.15),vec3(.5,.95,.4),vec3(.9,1.,.85));
 else g=ramp(l,vec3(.08,.02,.18),vec3(.42,.06,.4),vec3(.92,.25,.3),vec3(1.,.6,.25),vec3(1.,.93,.6));
 o=vec4(mix(c,g,u_mix),1.);}`
  },

  /* ===================== Stylize ===================== */
  {
    id: 'edges', name: 'Edge detection', group: 'Stylize',
    params: [S('algo', 'Algorithm', ['Sobel', 'Prewitt', 'Laplacian']), R('thresh', 'Threshold', .05, .8, .3, .05), R('width', 'Line width', .5, 4, 1, .5), T('invert', 'Invert'),
      ...ADJ(), H('Color'), S('mode', 'Mode', ['Mono', 'Original']), ...when(p => p.mode === 0, C('edge', 'Edge color', '#ffffff')), C('bg', 'Background', '#000000')],
    frag: `uniform float u_algo,u_thresh,u_width,u_invert,u_mode; uniform vec3 u_edge,u_bg;
float L(vec2 uv){return luma(adj(tex(uv)));}
void main(){vec2 d=u_width*u_px/u_res;
 float tl=L(v_uv-d),t=L(v_uv-vec2(0,d.y)),tr=L(v_uv+vec2(d.x,-d.y)),l=L(v_uv-vec2(d.x,0)),cc=L(v_uv),r=L(v_uv+vec2(d.x,0)),bl=L(v_uv+vec2(-d.x,d.y)),b=L(v_uv+vec2(0,d.y)),br=L(v_uv+d);
 float m;
 if(u_algo<.5){float gx=tr+2.*r+br-tl-2.*l-bl, gy=bl+2.*b+br-tl-2.*t-tr; m=length(vec2(gx,gy))*.25;}
 else if(u_algo<1.5){float gx=tr+r+br-tl-l-bl, gy=bl+b+br-tl-t-tr; m=length(vec2(gx,gy))/3.;}
 else m=abs(8.*cc-(tl+t+tr+l+r+bl+b+br))*.25;
 float e=smoothstep(u_thresh,u_thresh+.08,m); if(u_invert>.5) e=1.-e;
 vec3 col=u_mode<.5?u_edge:adj(tex(v_uv));
 o=vec4(mix(u_bg,col,e),1.);}`
  },
  {
    id: 'contour', name: 'Contour', group: 'Stylize', mips: true,
    params: [S('fill', 'Fill mode', ['Filled bands', 'Lines only']), R('levels', 'Levels', 3, 20, 8, 1), R('thick', 'Line thickness', .5, 3, 1, .25), T('invert', 'Invert'),
      ...ADJ(), H('Color'), S('mode', 'Mode', ['Original', 'Mono']), C('line', 'Line color', '#000000'), ...when(p => p.fill === 1, C('bg', 'Background', '#ffffff'))],
    frag: `uniform float u_fill,u_levels,u_thick,u_invert,u_mode; uniform vec3 u_line,u_bg;
float F(vec2 uv){float l=luma(adj(textureLod(u_tex,uv,1.5).rgb)); if(u_invert>.5) l=1.-l; return l*u_levels;}
void main(){vec2 px=1./u_res; float f=F(v_uv);
 float fx=F(v_uv+vec2(px.x,0))-F(v_uv-vec2(px.x,0)), fy=F(v_uv+vec2(0,px.y))-F(v_uv-vec2(0,px.y));
 float g=max(length(vec2(fx,fy))*.5,1e-4);
 float dist=(.5-abs(fract(f)-.5))/g;
 float hw=u_thick*u_px*.5, line=1.-smoothstep(hw-.5,hw+.5,dist);
 float qv=(clamp(floor(f),0.,u_levels-1.)+.5)/u_levels;
 vec3 src=adj(textureLod(u_tex,v_uv,1.5).rgb);
 vec3 fillc=u_mode<.5?clamp(src*(qv/max(luma(src),.02)),0.,1.):vec3(qv);
 vec3 base=u_fill<.5?fillc:u_bg;
 vec3 lc=(u_fill>.5&&u_mode<.5)?src:u_line;
 o=vec4(mix(base,lc,line),1.);}`
  },
  {
    id: 'wavelines', name: 'Wave lines', group: 'Stylize', mips: true,
    params: [R('count', 'Line count', 10, 150, 50, 5), R('amp', 'Amplitude', 5, 50, 20, 1), R('freq', 'Frequency', .5, 3, 1, .1), R('thick', 'Line thickness', .5, 3, 1, .1),
      S('dir', 'Direction', ['Horizontal', 'Vertical']), T('animate', 'Animate', 1),
      ...ADJ(), H('Color'), S('mode', 'Mode', ['Original', 'Mono']), ...when(p => p.mode === 1, C('fg', 'Line color', '#ffffff')), C('bg', 'Background', '#000000')],
    frag: `uniform float u_count,u_amp,u_freq,u_thick,u_dir,u_animate,u_mode; uniform vec3 u_fg,u_bg;
void main(){bool V=u_dir>.5; vec2 q=V?gl_FragCoord.yx:gl_FragCoord.xy; vec2 R=V?u_res.yx:u_res;
 float sp=R.y/u_count, A=u_amp*u_px, ph=u_animate>.5?u_time*2.:0., k=6.2831853*u_freq*8./R.x;
 float n0=floor(q.y/sp), reach=ceil(A/sp)+1., bl=luma(u_bg);
 float cov=0.; vec3 lc=vec3(0);
 for(int i=-10;i<=10;i++){float fi=float(i); if(abs(fi)>reach) continue;
  float n=n0+fi; if(n<0.||n>=u_count) continue;
  float y0=(n+.5)*sp;
  vec2 suv=(V?vec2(y0,q.x):vec2(q.x,y0))/u_res;
  vec3 sc=adj(textureLod(u_tex,suv,1.).rgb); float e=abs(luma(sc)-bl);
  float arg=q.x*k+ph+n*.7, disp=sin(arg)*A*e, slope=cos(arg)*A*e*k;
  float dist=abs(q.y-y0-disp)/sqrt(1.+slope*slope);
  float th=u_thick*u_px*(.6+.9*e)*.5+.3;
  float c=1.-smoothstep(th-.7,th+.7,dist);
  if(c>cov){cov=c; lc=sc;}}
 vec3 hi=lc/max(max(lc.r,max(lc.g,lc.b)),.05); // on a dark background, lift line colors so dark areas stay visible
 vec3 col=u_mode<.5?mix(lc,hi*.9,(1.-bl)*.6):u_fg;
 o=vec4(mix(u_bg,clamp(col,0.,1.),cov),1.);}`
  },
  {
    id: 'voronoi', name: 'Voronoi', group: 'Stylize', mips: true,
    params: [R('cell', 'Cell size', 10, 100, 30, 5), R('edge', 'Edge width', 0, 1, .3, .05), S('ecol', 'Edge color', ['Black', 'White', 'Darkened']),
      S('cmode', 'Color mode', ['Cell average', 'Center sample', 'Gradient']), R('rand', 'Randomize', 0, 1, .8, .05), ...ADJ()],
    frag: `uniform float u_cell,u_edge,u_ecol,u_cmode,u_rand;
void main(){float s=max(4.,u_cell*u_px); vec2 p=gl_FragCoord.xy/s; vec2 ip=floor(p), fp=fract(p);
 float d1=8.,d2=8.; vec2 r1=vec2(0),r2=vec2(0),site=vec2(0);
 for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){vec2 g=vec2(x,y); vec2 off=.5+(hash22(ip+g)-.5)*u_rand; vec2 r=g+off-fp; float d=dot(r,r);
  if(d<d1){d2=d1;r2=r1;d1=d;r1=r;site=ip+g+off;} else if(d<d2){d2=d;r2=r;}}
 float ed=dot(.5*(r1+r2),normalize(r2-r1+1e-5));
 vec2 su=site*s/u_res;
 vec3 c=adj(textureLod(u_tex,su,u_cmode<.5?log2(s)-.5:0.).rgb);
 if(u_cmode>1.5) c*=mix(1.15,.55,smoothstep(0.,.75,sqrt(d1)));
 float w=u_edge*.1, e=w>0.?1.-smoothstep(w,w+1.5/s,ed):0.;
 vec3 ec=u_ecol<.5?vec3(0):u_ecol<1.5?vec3(1):c*.35;
 o=vec4(mix(c,ec,e),1.);}`
  },

  {
    id: 'relief', name: 'Relief', group: 'Stylize', mips: true,
    params: [S('style', 'Style', ['Stone relief', 'Plaster', 'Chrome']),
      H('Pattern'), R('depth', 'Depth', 0, 3, 1.55, .05), R('radius', 'Sample radius, px', .5, 8, 2.5, .1), R('angle', 'Light angle', 0, 360, 135, 1), R('elev', 'Light elevation, %', 10, 100, 68, 1),
      H('Surface & detail'), R('contrast', 'Contrast', .5, 2, 1.25, .05), R('rough', 'Roughness, %', 0, 100, 25, 1), R('hi', 'Highlight intensity, %', 0, 100, 58, 1), R('blend', 'Effect blend, %', 0, 100, 100, 1),
      H('Color'), C('mat', 'Material color', '#bea989'), C('shade', 'Shade color', '#283039'), C('hic', 'Highlight color', '#f5f1e7')],
    frag: `uniform float u_style,u_depth,u_radius,u_angle,u_elev,u_contrast,u_rough,u_hi,u_blend; uniform vec3 u_mat,u_shade,u_hic;
float Hh(vec2 uv,float lod){return clamp((luma(textureLod(u_tex,uv,lod).rgb)-.5)*u_contrast+.5,0.,1.);}
void main(){float r=max(.5,u_radius*u_px), lod=max(0.,log2(r)-.5); vec2 d=r/u_res;
 float hc=Hh(v_uv,lod);
 vec2 g=vec2(Hh(v_uv+vec2(d.x,0),lod)-Hh(v_uv-vec2(d.x,0),lod), Hh(v_uv+vec2(0,d.y),lod)-Hh(v_uv-vec2(0,d.y),lod))*.5;
 // surface grain: perturb the normal with fine noise (finer for plaster, glossy smooth for chrome)
 vec2 np=gl_FragCoord.xy/(u_px*(u_style>.5&&u_style<1.5?.8:1.6));
 vec2 rn=(vec2(vnoise(np),vnoise(np+17.3))-.5)+(vec2(vnoise(np*3.1+5.),vnoise(np*3.1+41.))-.5)*.5;
 float rk=u_rough*.01*(u_style>1.5?.25:1.);
 vec3 n=normalize(vec3(-g*u_depth*6.+rn*rk*.9,1.));   // image y grows downwards
 float a=radians(u_angle), e=radians(u_elev*.9);
 vec3 L=normalize(vec3(cos(a)*cos(e),-sin(a)*cos(e),sin(e)));
 float nl=dot(n,L), hi=u_hi*.01; vec3 R=reflect(-L,n); vec3 c;
 if(u_style<.5){ // stone: hard lambert, granite speckle, cavities darker
  float dif=max(nl,0.), spec=pow(max(R.z,0.),18.)*hi*.7;
  float speck=1.-rk*.35*vnoise(gl_FragCoord.xy/(u_px*2.5));
  c=mix(u_shade,u_mat,dif)*speck*(.82+.18*hc)+u_hic*spec;
 } else if(u_style<1.5){ // plaster: soft wrapped light, chalky matte
  float dif=clamp((nl+.45)/1.45,0.,1.); dif*=dif;
  vec3 base=mix(u_mat,u_hic,.55);
  c=mix(mix(u_shade,base,.35),base,dif)+u_hic*pow(max(R.z,0.),8.)*hi*.25;
 } else { // chrome: mirror an imaginary studio environment
  vec3 rv=reflect(vec3(0,0,-1),n);
  float t=rv.y*.5+.5+rv.x*.15;
  vec3 env=mix(u_shade,u_hic,smoothstep(.35,.55,t))*mix(.6,1.1,smoothstep(.6,.95,t));
  env=mix(env,u_shade*.6,smoothstep(.75,.8,t)*.6);
  c=mix(env,env*u_mat*1.6,.35)+u_hic*pow(max(R.z,0.),70.)*hi*1.4;
 }
 o=vec4(mix(tex(v_uv),clamp(c,0.,1.),u_blend*.01),1.);}`
  },
  {
    id: 'blobtrack', name: 'Blob tracking', group: 'Stylize', cpu: blobTrackCPU,
    params: [S('shape', 'Shape', ['Square', 'Circle', 'Rectangle']), S('style', 'Region style', TRACK_STYLES), ...when(p => p.style === 13, C('bdcol', 'Backdrop color', '#00ff3c')),
      H('Filter'), S('filter', 'Filter effect', TRACK_FILTERS), ...when(p => p.filter > 0, T('finv', 'Invert area'), T('fusion', 'Fusion')),
      H('Connection'), R('rate', 'Connection rate', 0, 1, .5, .25), ...when(p => p.rate > 0, T('hub', 'Center hub'), S('lstyle', 'Line style', ['Straight', 'Curve', 'Snake', 'Lightning']), T('dashed', 'Dashed')),
      R('stroke', 'Stroke width, px', .5, 6, 1, .5),
      H('Blobs'), S('cmode', 'Blob count control', ['By count', 'By size']), ...when(p => p.cmode === 0, R('count', 'Blob count', 4, 256, 16, 1)),
      R('bsize', 'Bounding size, px', 16, 512, 96, 8), T('same', 'Same size'), T('single', 'Single tracking'),
      H('Text'), S('tpos', 'Text position', ['Center', 'Top', 'Bottom', 'Hidden']), S('tcontent', 'Text content', ['Random', 'Position', 'Count']),
      R('font', 'Font size, px', 8, 24, 12, 1), C('color', 'Color', '#ffffff'), T('sep', 'Separate colors')],
  },

  /* ===================== Light ===================== */
  {
    id: 'bloom', name: 'Bloom', group: 'Light', mips: true,
    params: [R('threshold', 'Threshold', 0, .95, .6), R('intensity', 'Amount', 0, 3, 1), R('radius', 'Radius', 4, 120, 30, 1)],
    frag: `uniform float u_threshold,u_intensity,u_radius;
void main(){vec3 c=tex(v_uv); vec3 acc=vec3(0.); float r=u_radius*u_px; float lod=log2(max(1.,r/5.));
 for(int i=0;i<40;i++){float fi=float(i); float rr=sqrt((fi+.5)/40.)*r; float a=fi*2.39996;
  vec3 s=textureLod(u_tex,v_uv+vec2(cos(a),sin(a))*rr/u_res,lod).rgb;
  acc+=s*max(0.,luma(s)-u_threshold)/(1.-u_threshold+1e-3);}
 c+=acc/40.*u_intensity*1.5; o=vec4(clamp(c,0.,1.),1.);}`
  },
  {
    id: 'neon', name: 'Neon edges', group: 'Light',
    params: [S('color', 'Line color', ['From image', 'Custom']), R('strength', 'Amount', 0, 4, 1.5), R('width', 'Width', .5, 4, 1), R('keep', 'Original', 0, 1, .2), C('tint', 'Custom color', '#00f0ff')],
    frag: `uniform float u_color,u_strength,u_width,u_keep; uniform vec3 u_tint;
void main(){vec2 d=u_width*u_px/u_res;
 float tl=luma(tex(v_uv+vec2(-d.x,d.y))),t=luma(tex(v_uv+vec2(0,d.y))),tr=luma(tex(v_uv+d));
 float l=luma(tex(v_uv-vec2(d.x,0))),r=luma(tex(v_uv+vec2(d.x,0)));
 float bl=luma(tex(v_uv-d)),b=luma(tex(v_uv-vec2(0,d.y))),br=luma(tex(v_uv+vec2(d.x,-d.y)));
 float gx=tr+2.*r+br-tl-2.*l-bl, gy=tl+2.*t+tr-bl-2.*b-br; float e=clamp(length(vec2(gx,gy))*u_strength,0.,1.);
 vec3 c=tex(v_uv); vec3 ec=u_color<.5?normalize(c+.05)*1.6:u_tint;
 o=vec4(clamp(c*u_keep+ec*e,0.,1.),1.);}`
  },
  {
    id: 'streaks', name: 'Streaks', group: 'Light',
    params: [S('dir', 'Direction', ['Down', 'Up', 'Right', 'Left']), R('threshold', 'Threshold', 0, 1, .55), R('length', 'Length', 10, 600, 160, 1), R('mix', 'Amount', 0, 1, 1)],
    frag: `uniform float u_dir,u_threshold,u_length,u_mix;
void main(){vec2 dir=u_dir<.5?vec2(0,-1):u_dir<1.5?vec2(0,1):u_dir<2.5?vec2(-1,0):vec2(1,0);
 vec2 step_=dir*u_length*u_px/u_res/48.; vec3 c=tex(v_uv); vec3 best=c; float bl=luma(c);
 for(int i=1;i<=48;i++){vec3 s=tex(v_uv+step_*float(i)); float ls=luma(s); float fall=1.-float(i)/48.;
  if(ls>u_threshold && ls*fall>bl*.98){best=mix(best,s,fall); bl=ls*fall;}}
 o=vec4(mix(c,max(c,best),u_mix),1.);}`
  },

  /* ===================== Distort ===================== */
  {
    id: 'waves', name: 'Waves', group: 'Distort',
    params: [R('amp', 'Amplitude', 0, 60, 12), R('freq', 'Frequency', 1, 60, 12), R('speed', 'Speed', 0, 5, 1)],
    frag: `uniform float u_amp,u_freq,u_speed;
void main(){vec2 uv=v_uv; vec2 px=u_px/u_res; float t=u_time*u_speed;
 uv.x+=sin(uv.y*u_freq+t*2.)*u_amp*px.x; uv.y+=cos(uv.x*u_freq*.7+t*2.6)*u_amp*.5*px.y;
 o=vec4(tex(uv),1.);}`
  },
  {
    id: 'noisefield', name: 'Noise field', group: 'Distort',
    params: [S('type', 'Noise type', ['Perlin', 'Simplex', 'Worley']), R('scale', 'Scale', 10, 100, 50, 5), R('intensity', 'Intensity', .5, 3, 1, .1), R('oct', 'Octaves', 1, 8, 4, 1),
      R('speed', 'Speed', .1, 3, 1, .1), T('animate', 'Animate', 1), T('distort', 'Distort only'), ...ADJ()],
    frag: `uniform float u_type,u_scale,u_intensity,u_oct,u_speed,u_animate,u_distort;
vec2 grad2(vec2 i){float a=hash12(i)*6.2831853; return vec2(cos(a),sin(a));}
float perlin(vec2 p){vec2 i=floor(p),f=fract(p); vec2 u=f*f*f*(f*(f*6.-15.)+10.);
 float a=dot(grad2(i),f), b=dot(grad2(i+vec2(1,0)),f-vec2(1,0)), c=dot(grad2(i+vec2(0,1)),f-vec2(0,1)), d=dot(grad2(i+1.),f-1.);
 return mix(mix(a,b,u.x),mix(c,d,u.x),u.y)*.7+.5;}
float simplex(vec2 p){const float K1=.366025404, K2=.211324865;
 vec2 i=floor(p+(p.x+p.y)*K1); vec2 a=p-i+(i.x+i.y)*K2;
 vec2 o1=a.x>a.y?vec2(1,0):vec2(0,1); vec2 b=a-o1+K2, c=a-1.+2.*K2;
 vec3 h=max(.5-vec3(dot(a,a),dot(b,b),dot(c,c)),0.);
 vec3 n=h*h*h*h*vec3(dot(a,grad2(i)),dot(b,grad2(i+o1)),dot(c,grad2(i+1.)));
 return dot(n,vec3(70.))*.5+.5;}
float worley(vec2 p){vec2 i=floor(p),f=fract(p); float d=1.;
 for(int y=-1;y<=1;y++)for(int x=-1;x<=1;x++){vec2 g=vec2(x,y); d=min(d,length(g+hash22(i+g)-f));} return d;}
float nz(vec2 p){return u_type<.5?perlin(p):u_type<1.5?simplex(p):worley(p);}
float fbm(vec2 p,float t){float s=0.,a=.5,n=0.;
 for(int k=0;k<8;k++){if(float(k)>=u_oct) break; s+=a*nz(p+vec2(t*.7,-t*.4)*(1.+float(k)*.3)); n+=a; p=p*2.03+17.1; a*=.5;}
 return s/n;}
void main(){vec2 p=gl_FragCoord.xy/(u_px*u_scale*3.); float t=u_animate>.5?u_time*u_speed*.5:0.;
 float n1=fbm(p,t), n2=fbm(p+vec2(31.4,-12.7),t);
 vec2 disp=(vec2(n1,n2)-.5)*u_intensity*60.*u_px/u_res;
 vec3 c=adj(tex(v_uv+disp));
 if(u_distort<.5) c*=.4+smoothstep(.25,.75,n1)*1.2*min(u_intensity,1.5);
 o=vec4(clamp(c,0.,1.),1.);}`
  },
  {
    id: 'kaleido', name: 'Kaleidoscope', group: 'Distort',
    params: [R('seg', 'Segments', 2, 16, 6, 1), R('rot', 'Rotation', 0, 360, 0, 1), R('zoom', 'Zoom', .3, 3, 1), R('spin', 'Spin', 0, 2, 0)],
    frag: `uniform float u_seg,u_rot,u_zoom,u_spin;
void main(){float ar=u_res.x/u_res.y; vec2 p=(v_uv-.5)*vec2(ar,1.); float r=length(p);
 float a=atan(p.y,p.x)+radians(u_rot)+u_time*u_spin; float seg=6.28318/u_seg; a=mod(a,seg); a=abs(a-seg*.5);
 vec2 uv=vec2(cos(a),sin(a))*r/u_zoom/vec2(ar,1.)+.5; uv=1.-abs(1.-mod(uv,2.));
 o=vec4(tex(uv),1.);}`
  },
];

export const EFFECT_MAP = Object.fromEntries(EFFECTS.map(e => [e.id, e]));

export const PRESETS = [
  { name: 'Tape 1989', stack: [['adjust', { saturation: 1.25, contrast: 1.1, temp: .25 }], ['vhs', {}], ['crt', { curve: .15, mask: .2, scan: .35 }], ['grain', { amount: .25 }]] },
  { name: 'Broken signal', stack: [['glitch', { intensity: .7 }], ['rgb', { amount: 6, radial: .4 }], ['crt', { curve: 0, mask: .25, vig: .3 }]] },
  { name: 'Digital rain', stack: [['matrix', { bgop: .15, glow: 1.2 }], ['bloom', { threshold: .35, intensity: .8, radius: 18 }]] },
  { name: '8-bit handheld', stack: [['adjust', { contrast: 1.2 }], ['dither', { mode: 2, pal: 0, pixel: 5 }]] },
  { name: 'Newspaper', stack: [['adjust', { contrast: 1.3, saturation: 0 }], ['halftone', { size: 8 }], ['grain', { amount: .2, color: 0 }]] },
  { name: 'CMYK comic', stack: [['adjust', { saturation: 1.4, contrast: 1.15 }], ['halftone', { mode: 2, size: 9, soft: .1 }]] },
  { name: 'Sketchbook', stack: [['crosshatch', { density: 7, rand: .35, con: 20 }], ['grain', { amount: .15, color: 0 }]] },
  { name: 'Terminal', stack: [['ascii', { mode: 1 }], ['bloom', { threshold: .3, intensity: 1.2, radius: 16 }], ['crt', { curve: .2, scan: .4, mask: .15 }]] },
  { name: 'Data mosh', stack: [['pixelsort', { threshold: .25, length: 220 }], ['rgb', { amount: 4 }]] },
  { name: 'Stained glass', stack: [['voronoi', { cell: 40, edge: .35 }], ['adjust', { saturation: 1.3 }]] },
  { name: 'Topo map', stack: [['contour', { levels: 10, mode: 1 }]] },
  { name: 'Film', stack: [['adjust', { temp: .35, contrast: 1.08, saturation: .9 }], ['bloom', { threshold: .7, intensity: .6, radius: 40 }], ['grain', { amount: .3, size: 1.6 }], ['vignette', { amount: .45 }]] },
  { name: 'Thermal', stack: [['gradmap', { palette: 1 }], ['grain', { amount: .15 }], ['sharpen', { amount: .8 }]] },
  { name: 'Neon', stack: [['adjust', { brightness: -.2 }], ['neon', {}], ['bloom', { threshold: .2, intensity: 1.6, radius: 24 }]] },
  { name: 'Duotone dither', stack: [['adjust', { contrast: 1.2 }], ['dither', { algo: 0, mode: 1, levels: 2, pixel: 3, fg: '#ffd27a', bg: '#1b1035' }]] },
];
