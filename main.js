// Paper Cloud：照片印在棉纸上，悬成一片云，浮在破碎镜面之上；镜面把流动的光投到天花板。
// 原生 WebGL2。房间、每一张纸片（一次实例化绘制）、吊线，外加半分辨率的镜面反射 pass。
// 在原作者实现基础上本地化，并加了“运行时上传/替换/添加照片、自动适配”的能力。
const LAYER = 256;            // 每张照片的纹理尺寸；选中时会加载原图
const MAX_LAYERS = 64;        // 纹理数组预留层数（含你后续添加的照片）
const MAX_SHEETS = 256;       // 纸片实例上限
const FLOATS_PER_SHEET = 16;  // 每个实例：中心xyz+yaw、宽高相位层、裁切uv、交互动力学(位移xyz+偏航)
const [RX, RH, RZ] = [8, 5.4, 8]; // 房间半宽、高、半深（米）
const FOV = 45 * Math.PI / 180;
const HOME = { yaw: .3, pitch: .1, dist: 10.5, x: 0, y: 2.6, z: 0 };
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (id) => document.getElementById(id);
const canvas = $('scene');
const gl = canvas.getContext('webgl2', { alpha: false, antialias: true, powerPreference: 'high-performance' });
if (!gl) { document.body.append('这个作品需要 WebGL 2。'); throw new Error('WebGL 2 unavailable'); }

let W = 1, H = 1, live = false, raf = 0, last = 0, time = 0, idleSince = 0, sel = -1, hover = -1, fullFor = -1, backFullFor = -1, ready = false, glReady = false;
const cam = { ...HOME }, goal = { ...HOME }, view = {};

// 平台容器会告诉作品是否离开屏幕；独立打开时，作品照常运行。
let hostActive = true;
const running = () => hostActive && !document.hidden;
addEventListener('message', (e) => {
  if (e.source === parent && e.data?.type === 'platform:visibility') { hostActive = !!e.data.active; wake(); }
});
document.addEventListener('visibilitychange', wake);
if (parent !== window) parent.postMessage({ type: 'platform:hello' }, '*');

// ---------------------------------------------------------------------------
// 着色器（与原作一致）
// ---------------------------------------------------------------------------
const NOISE = `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec2 hash2(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); f *= f * (3. - 2. * f); return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + 1.), f.x), f.y); }`;
// 纸片随吊线转动、飘动；pick() 在 JavaScript 里重复这一段。
const SWAY = `
uniform float uTime;
void sway(vec4 a, vec4 b, out vec3 c, out float yaw) {
  yaw = a.w + sin(uTime * .35 + b.z) * .1 + sin(uTime * .17 + b.z * 1.7) * .06;
  c = a.xyz + vec3(sin(uTime * .23 + b.z * 2.1), 0, cos(uTime * .19 + b.z * 1.3)) * .015;
}`;

const roomProgram = program(`
layout(location = 0) in vec3 aPos;
layout(location = 1) in float aFace;
uniform mat4 uVP;
out vec3 vP; flat out int vFace;
void main() { vP = aPos; vFace = int(aFace); gl_Position = uVP * vec4(aPos, 1); }`, `
${NOISE}
uniform vec3 uEye; uniform vec2 uRes; uniform float uTime; uniform int uMirror; uniform sampler2D uRefl;
in vec3 vP; flat in int vFace;
out vec4 o;
const vec3 N[6] = vec3[6](vec3(0, 1, 0), vec3(0, -1, 0), vec3(-1, 0, 0), vec3(1, 0, 0), vec3(0, 0, -1), vec3(0, 0, 1));
float caustic(vec2 uv) { // 镜面碎片投到天花板的光
  vec2 p = mod(uv * 6.2832, 6.2832) - 250., i = p; float c = 1.;
  for (int n = 0; n < 4; n++) {
    float t = uTime * .2 * (1. - 3.5 / float(n + 1));
    i = p + vec2(cos(t - i.x) + sin(t + i.y), sin(t - i.y) + cos(t + i.x));
    c += 1. / length(vec2(p.x / (sin(i.x + t) / .005), p.y / (cos(i.y + t) / .005)));
  }
  return pow(abs(1.17 - pow(c / 4., 1.4)), 8.);
}
void main() {
  // 从外面看，墙会避让；镜面 pass 不放地板
  if (dot(N[vFace], uEye - vP) < 0. || (uMirror == 1 && vFace == 0)) discard;
  float r = length(vP.xz);
  vec3 col;
  if (vFace == 0) {
    vec2 suv = gl_FragCoord.xy / uRes;
    if (r < 2.5) {
      // 破碎镜面：每块碎片稍微倾斜，映出房间自己的一个片段
      vec2 q = vP.xz * 4.2 + noise(vP.xz * 2.) * .6, i = floor(q), f = fract(q), id; float d1 = 9., d2 = 9.;
      for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
        vec2 g = vec2(x, y), v = g + hash2(i + g) - f; float d = dot(v, v);
        if (d < d1) { d2 = d1; d1 = d; id = i + g; } else if (d < d2) d2 = d;
      }
      vec2 h = hash2(id + 3.1);
      float crack = 1. - smoothstep(0., .015 + length(uEye - vP) * .004, sqrt(d2) - sqrt(d1));
      col = texture(uRefl, suv + (h - .5) * vec2(.12, .3)).rgb * (.55 + .3 * h.x) + step(.97, h.y) * .3;
      col = mix(col, vec3(.8), crack * .35);
    } else if (r < 2.57) col = vec3(.9, .89, .86);
    else col = vec3(.6, .59, .56) * (.6 + .4 * exp(-r * r * .02)) * (.78 + .22 * smoothstep(2.57, 3.2, r)) + texture(uRefl, suv).rgb * .1;
  } else if (vFace == 1) {
    vec2 g = abs(fract(vP.xz / 1.2) - .5);
    col = vec3(.2, .2, .21) * (1. - .25 * step(.485, max(g.x, g.y)));
    col += vec3(1, .97, .9) * caustic(vP.xz * .13) * smoothstep(7., 1., r) * .8;
    col = mix(col, vec3(1.3), smoothstep(.13, .1, length(vec2(abs(vP.x) - 2.6, vP.z - 2.2))));
  } else {
    col = vec3(.74, .73, .7) * (.62 + .38 * smoothstep(${RH.toFixed(1)}, 1.2, vP.y)) * (vP.y < .1 ? .45 : 1.) * (.97 + .03 * noise(vP.xy * 3. + vP.z));
  }
  o = vec4(col, 1);
}`);

const sheetProgram = program(`
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aA;    // 中心, yaw
layout(location = 2) in vec4 aB;    // 宽, 高, 相位, 层
layout(location = 3) in vec4 aCrop; // 纹理空间裁切
layout(location = 4) in vec4 aDyn;  // 交互动力学：位移 xyz + 偏航
${SWAY}
uniform mat4 uVP;
out vec2 vUV; out vec3 vN, vP; flat out vec4 vCrop; flat out vec3 vMeta; flat out vec2 vId;
void main() {
  vec3 c; float yaw; sway(aA, aB, c, yaw);
  c += aDyn.xyz; yaw += aDyn.w;
  vec3 r = vec3(cos(yaw), 0, -sin(yaw)), n = vec3(sin(yaw), 0, cos(yaw));
  vec2 q = aCorner * aB.xy;
  float curl = (fract((aB.z >= 1000.0 ? aB.z - 1000.0 : aB.z) * 7.31) - .5) * .5; // 纸微微卷曲
  vP = c + r * q.x + vec3(0, q.y, 0) + n * curl * (q.x * q.x - aB.x * aB.x * .25);
  vN = n - r * 2. * curl * q.x;
  vUV = vec2(aCorner.x + .5, .5 - aCorner.y);
  // vId = (实例序号, 是否背面朝外)；后者决定背面 UV 要不要镜像：
  // 背面朝外 → 没转过 → 不镜像；翻转到背面 → 转了 180° → 需镜像才正读。
  // backOut 借 phase 高位传递：aB.z ≥ 1000 表示背面朝外，取景相位 = aB.z - 1000
  bool backOut = aB.z >= 1000.0;
  vCrop = aCrop; vMeta = vec3(aB.w, aB.xy); vId = vec2(float(gl_InstanceID), backOut ? 1.0 : 0.0);
  gl_Position = uVP * vec4(vP, 1);
}`, `
${NOISE}
uniform mediump sampler2DArray uPhotos; uniform mediump sampler2DArray uBacks; uniform sampler2D uFull; uniform sampler2D uBackFull; uniform int uSel, uHover; uniform bool uFullOn, uBackFullOn; uniform vec3 uEye, uFocus;
in vec2 vUV; in vec3 vN, vP; flat in vec4 vCrop; flat in vec3 vMeta; flat in vec2 vId;
out vec4 o;
void main() {
  // 选中照片与眼睛之间的纸片柔和淡出：墨色先隐入空纸，贴近视线才碎成窄窄的纸屑
  float occ = 0., dis = 0.;
  if (uSel >= 0 && vId.x != float(uSel)) {
    vec3 seg = uFocus - uEye; float t = clamp(dot(vP - uEye, seg) / dot(seg, seg), 0., 1.);
    if (t < .95) {
      float d = length(uEye + seg * t - vP);
      occ = smoothstep(.85, .25, d);
      dis = smoothstep(.32, .1, d);
      if (hash(gl_FragCoord.xy) < dis) discard;
    }
  }
  vec2 size = vMeta.yz, a = vec2(0.), b = vec2(1.); // 照片整幅贴满纸片（相框由相纸合成自带，不再留棉纸边）
  vec2 cuv = mix(vCrop.xy, vCrop.zw, clamp((vUV - a) / (b - a), 0., 1.));
  vec3 n = normalize(vN);
  bool front = dot(n, uEye - vP) > 0.;      // 纸片朝向：true=正面，false=背面（已翻转）
  vec3 photoF = vId.x == float(uSel) && uFullOn ? texture(uFull, cuv).rgb : texture(uPhotos, vec3(cuv, vMeta.x)).rgb;
  // 聚焦且翻到背面时用高清背面纹理（否则 256 层会看不清手写字）。
  // 背面 UV：背面朝外（vId.y=1）时纸片没转过，直接用原 UV；
  // 翻转 180° 看过背面时几何转了，需水平镜像才正读。
  // 背面始终用整幅 vUV（不走正面的随机取景 cuv），否则背面内容会被裁掉一部分
  vec2 buv = vId.y > .5 ? vec2(1. - vUV.x, vUV.y) : vUV;
  vec3 photoB = (vId.x == float(uSel) && uBackFullOn && !front) ? texture(uBackFull, buv).rgb : texture(uBacks, vec3(buv, vMeta.x)).rgb;
  vec3 photo = front ? photoF : photoB;
  // 棉纸上的颜料：更亮更柔，边缘不均匀地晕开
  vec3 ink = 1. - (1. - mix(vec3(dot(photo, vec3(.3, .59, .11))), photo, .85)) * .85;
  if (vId.x == float(uSel)) ink = mix(ink, photo, .7);
  vec2 d = (abs(vUV - (a + b) * .5) - (b - a) * .5) * size;
  float inked = smoothstep(.003, -.003, max(d.x, d.y) + (noise(vUV * size * 28.) - .5) * .008);
  inked *= 1. - occ; // 遮挡淡出的柔和段：墨色归于空白棉纸
  vec3 paper = vec3(.95, .935, .9) * (.97 + .03 * noise(vUV * size * 160.));
  vec3 col = paper * mix(vec3(1), ink, inked);
  float lit = (.74 + .2 * abs(dot(n, normalize(vec3(.35, .55, .75)))) + .08 * smoothstep(1.5, 4.6, vP.y)) * (vId.x == float(uHover) ? 1.1 : 1.);
  o = vec4(col * lit, 1);
}`);

const threadProgram = program(`
layout(location = 1) in vec4 aA;
layout(location = 2) in vec4 aB;
layout(location = 4) in vec4 aDyn; // 与纸片同步的交互位移
${SWAY}
uniform mat4 uVP;
void main() { // 每张纸片两根吊线，从顶角连到天花板
  vec3 c; float yaw; sway(aA, aB, c, yaw);
  c += aDyn.xyz; yaw += aDyn.w; // 只有下端跟随纸片动，上端仍固定在天花板
  float side = (gl_VertexID < 2 ? -.4 : .4) * aB.x;
  vec3 p = (gl_VertexID & 1) == 0 ? c + vec3(cos(yaw), 0, -sin(yaw)) * side + vec3(0, aB.y * .5, 0)
                                  : vec3(aA.x + cos(aA.w) * side, ${RH.toFixed(1)}, aA.z - sin(aA.w) * side);
  gl_Position = uVP * vec4(p, 1);
}`, `
out vec4 o;
void main() { o = vec4(.85, .84, .8, 1) * .3; }`);

function program(vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, `#version 300 es\nprecision highp float;\n${src}`);
    gl.compileShader(sh);
    gl.attachShader(p, sh);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getAttachedShaders(p).map((sh) => gl.getShaderInfoLog(sh)).join('\n'));
  const u = {};
  for (let i = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i--;) { const { name } = gl.getActiveUniform(p, i); u[name] = gl.getUniformLocation(p, name); }
  return { p, u };
}
const buffer = (data) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); return b; };
const attrib = (loc, n, stride, offset, divisor) => { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, n, gl.FLOAT, false, stride, offset); gl.vertexAttribDivisor(loc, divisor); };

// ---------------------------------------------------------------------------
// 照片与“云”
// ---------------------------------------------------------------------------
const basePhotos = (await (await fetch('photos.json')).json()).photos;
// 应用本地存储里你自己上传/替换的照片（IndexedDB 优先，localStorage 兜底）
const STORE_KEY = 'papercloud.v1';
const saved = await storeGet(STORE_KEY).catch((e) => { console.warn('读取已存作品失败', e); return null; });
const photos = basePhotos.map((p) => ({ ...p }));
if (saved) {
  for (const p of photos) if (saved.replaced?.[p.id]) { const r = saved.replaced[p.id]; p.src = r.src; p.width = r.width; p.height = r.height; p.aspect = r.width / r.height; p.fitted = r.fitted !== false; p.back = r.back || null; p.raw = r.raw || null; p.cfg = r.cfg || null; p.texts = r.texts || null; }
  for (const a of saved.added || []) photos.push({ ...a, aspect: a.width / a.height, fitted: a.fitted !== false, back: a.back || null });
}
photos.forEach((p) => {
  const w = p.width || (/\/(\d+)\/(\d+)\.jpg$/.exec(p.source_url) || [])[1];
  const h = p.height || (/\/(\d+)\/(\d+)\.jpg$/.exec(p.source_url) || [])[2];
  p.aspect = (w && h) ? +w / +h : 1.5;
  p.back = p.back || null;
  p.full = p.src;
});
const P0 = photos.length;

// 每张照片挂两次：k 显示整图，(P0 + k) 是其局部特写。整图填一个上宽下窄的倒锥，
// 每张大致朝外。
// 纸片布局全部由 makeSheet 内部的「每张照片独立种子」决定，不用全局随机序列，
// 保证：刷新、增删照片、给照片加背面，都不会让其它照片的位置发生任何变化
const sheets = [];
const sheetData = new Float32Array(MAX_SHEETS * FLOATS_PER_SHEET);
function writeSheet(n, s) {
  // phase 的高位编码 backOut（≥1000 表示背面朝外），供着色器决定背面 UV 是否镜像
  const ph = s.phase + (s.backOut ? 1000 : 0);
  sheetData.set([s.x, s.y, s.z, s.renderYaw ?? s.yaw, s.w, s.h, ph, s.layer, s.crop[0], s.crop[1], s.crop[2], s.crop[3]], n * FLOATS_PER_SHEET);
}
// 只更新某张纸片的偏航（翻转动画用，避免整块重传）
function writeYaw(n, yaw) {
  const off = n * FLOATS_PER_SHEET;
  sheetData[off + 3] = yaw;
  gl.bindBuffer(gl.ARRAY_BUFFER, instances);
  gl.bufferSubData(gl.ARRAY_BUFFER, off * 4, sheetData.subarray(off, off + 4));
}
// 每张照片用「自己的」确定性随机源：seed 只由 photoIndex 与 isStudy 决定，
// 因此某张照片新增背面/被裁剪都不会影响其它照片的取景，刷新后布局绝对稳定
function makeSheet(photoIndex, isStudy) {
  const rnd = mulberry32(0x9e37 + photoIndex * 7919 + (isStudy ? 104729 : 0));
  let best, score = -1;
  for (let k = 0; k < 30; k++) {
    const y = 1.55 + rnd() * 3, R = 1 + 1.6 * ((y - 1.55) / 3) ** .6, a = rnd() * Math.PI * 2, r = R * Math.sqrt(rnd());
    const x = Math.cos(a) * r * 1.15, z = Math.sin(a) * r;
    let d = 9;
    for (const s of sheets) d = Math.min(d, Math.hypot(s.x - x, (s.y - y) * 1.4, s.z - z));
    if (d > score) { score = d; best = { x, y, z }; }
  }
  const ap = photos[photoIndex].aspect;
  let w, h, cw, ch, u, v;
  if (photos[photoIndex].fitted && !isStudy) {
    // 经过编辑器裁剪的照片：纸片按照片比例生成，整图全幅贴入，不再随机裁切
    h = .55 + rnd() * .25;
    w = ap * h; // 纸片比例即照片比例（照片整幅贴满，无内边）
    if (w < .32 || w > .8) { w = Math.max(.32, Math.min(.8, w)); h = w / ap; }
    u = 0; v = 0; cw = 1; ch = 1;
  } else {
    w = .42 + rnd() * .16; h = w * (rnd() < .35 ? 1.3 : .74);
    const ai = w / h, zoom = isStudy ? 1.25 + rnd() * .35 : 1;
    cw = Math.min(1, ai / ap) / zoom; ch = Math.min(1, ap / ai) / zoom;
    u = rnd() * (1 - cw); v = rnd() * (1 - ch);
  }
  const yaw = Math.atan2(best.x, best.z) + (rnd() - .5) * 1.2;
  const phase = rnd() * 100;
  // 背面朝向也用独立随机源：有无背面都不影响其它纸片
  // 背面朝向：约 1/4 纸片背面朝外（正反混飘但风景照仍是主角，米色太多会糊成一片）
  const backOut = !!photos[photoIndex].back && rnd() < .25;
  return { ...best, yaw, renderYaw: yaw + (backOut ? Math.PI : 0), backOut, flipped: backOut, flipAnim: null, w, h, phase, photo: photoIndex, layer: photoIndex, study: isStudy, crop: [u, v, u + cw, v + ch] };
}
{ // 每张照片挂一张整图。示例照片数量多（30 张），不再额外挂「特写」纸片——
  // 否则纸片翻倍会挤成一团；照片少时或用户自己添加的照片仍可保留特写
  const dense = P0 > 12; // 示例照片较多时从简
  let n = 0;
  for (let pi = 0; pi < P0; pi++) {
    const s = makeSheet(pi, false); s.buf = n++; sheets.push(s); writeSheet(s.buf, s);
    if (!dense && !photos[pi].fitted) { const st = makeSheet(pi, true); st.buf = n++; sheets.push(st); writeSheet(st.buf, st); }
  }
}

// 每张纸片的交互动力学状态：位移偏移 + 速度（软弹簧回归静止）
const dyn = sheets.map(() => ({ ox: 0, oy: 0, oz: 0, ry: 0, vx: 0, vy: 0, vz: 0, vyaw: 0, was: false }));
const tmpDyn = new Float32Array(4);
let sheetDrag = null; // { i, tx, ty, tz } 按住照片拖拽时的目标位移

const quad = (a, b, c, d, f) => [a, b, c, a, c, d].flatMap((v) => [...v, f]);
const roomVao = gl.createVertexArray();
gl.bindVertexArray(roomVao);
buffer(new Float32Array([
  ...quad([-RX, 0, -RZ], [RX, 0, -RZ], [RX, 0, RZ], [-RX, 0, RZ], 0),
  ...quad([-RX, RH, -RZ], [-RX, RH, RZ], [RX, RH, RZ], [RX, RH, -RZ], 1),
  ...quad([RX, 0, -RZ], [RX, RH, -RZ], [RX, RH, RZ], [RX, 0, RZ], 2),
  ...quad([-RX, 0, -RZ], [-RX, 0, RZ], [-RX, RH, RZ], [-RX, RH, -RZ], 3),
  ...quad([-RX, 0, RZ], [RX, 0, RZ], [RX, RH, RZ], [-RX, RH, RZ], 4),
  ...quad([-RX, 0, -RZ], [-RX, RH, -RZ], [RX, RH, -RZ], [RX, 0, -RZ], 5),
]));
attrib(0, 3, 16, 0, 0);
attrib(1, 1, 16, 12, 0);

const instances = buffer(sheetData);
const sheetVao = gl.createVertexArray();
gl.bindVertexArray(sheetVao);
buffer(new Float32Array(Array.from({ length: 7 }, (_, i) => [i / 6 - .5, -.5, i / 6 - .5, .5]).flat()));
attrib(0, 2, 0, 0, 0);
gl.bindBuffer(gl.ARRAY_BUFFER, instances);
for (let i = 0; i < 4; i++) attrib(i + 1, 4, FLOATS_PER_SHEET * 4, i * 16, 1);
const threadVao = gl.createVertexArray();
gl.bindVertexArray(threadVao);
gl.bindBuffer(gl.ARRAY_BUFFER, instances);
attrib(1, 4, FLOATS_PER_SHEET * 4, 0, 1);
attrib(2, 4, FLOATS_PER_SHEET * 4, 16, 1);
attrib(4, 4, FLOATS_PER_SHEET * 4, 48, 1);
gl.bindVertexArray(null);

// 纹理单元：0 照片（每层一张），1 选中的原图，2 镜面。
const texture = (unit, target) => { const t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(target, t); gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR); return t; };
const fullTex = texture(1, gl.TEXTURE_2D);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
const backFullTex = texture(4, gl.TEXTURE_2D); // 聚焦翻到背面时的高清背面
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
const reflTex = texture(2, gl.TEXTURE_2D);
const depth = gl.createRenderbuffer();
const fbo = gl.createFramebuffer();
const photoTex = texture(0, gl.TEXTURE_2D_ARRAY);
gl.texStorage3D(gl.TEXTURE_2D_ARRAY, Math.log2(LAYER) + 1, gl.RGBA8, LAYER, LAYER, MAX_LAYERS);
const backTex = texture(3, gl.TEXTURE_2D_ARRAY); // 背面：与正面同层号；无背面时填纸色（翻转即看到空白纸背）
gl.texStorage3D(gl.TEXTURE_2D_ARRAY, Math.log2(LAYER) + 1, gl.RGBA8, LAYER, LAYER, MAX_LAYERS);
const scratch = Object.assign(document.createElement('canvas'), { width: LAYER, height: LAYER }).getContext('2d');
// 先把所有层填成纸色占位，保证后续生成 mipmap 时纹理完整
{
  const blank = document.createElement('canvas'); blank.width = blank.height = LAYER;
  blank.getContext('2d').fillStyle = '#efe9df'; blank.getContext('2d').fillRect(0, 0, LAYER, LAYER);
  const blankBM = await createImageBitmap(blank);
  // 背面默认纸色（略偏暖，像未印刷的纸背）
  const bback = document.createElement('canvas'); bback.width = bback.height = LAYER;
  bback.getContext('2d').fillStyle = '#ece6db'; bback.getContext('2d').fillRect(0, 0, LAYER, LAYER);
  const bbackBM = await createImageBitmap(bback);
  for (let i = 0; i < MAX_LAYERS; i++) {
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, LAYER, LAYER, 1, gl.RGBA, gl.UNSIGNED_BYTE, blankBM);
    gl.activeTexture(gl.TEXTURE3);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, LAYER, LAYER, 1, gl.RGBA, gl.UNSIGNED_BYTE, bbackBM);
  }
  gl.activeTexture(gl.TEXTURE0);
}
async function loadLayerImage(src, layer) {
  const blob = await (await fetch(src)).blob();
  let img = await createImageBitmap(blob, { resizeWidth: LAYER, resizeHeight: LAYER, resizeQuality: 'high' });
  if (img.width !== LAYER || img.height !== LAYER) { scratch.drawImage(img, 0, 0, LAYER, LAYER); img = scratch.canvas; }
  gl.activeTexture(gl.TEXTURE0);
  gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, LAYER, LAYER, 1, gl.RGBA, gl.UNSIGNED_BYTE, img);
}
// 背面纹理：src 为空则填纸色（无背面创作）
async function loadBackLayer(src, layer) {
  let img;
  if (src) {
    const blob = await (await fetch(src)).blob();
    img = await createImageBitmap(blob, { resizeWidth: LAYER, resizeHeight: LAYER, resizeQuality: 'high' });
    if (img.width !== LAYER || img.height !== LAYER) { scratch.drawImage(img, 0, 0, LAYER, LAYER); img = scratch.canvas; }
  } else {
    const b = document.createElement('canvas'); b.width = b.height = LAYER;
    b.getContext('2d').fillStyle = '#ece6db'; b.getContext('2d').fillRect(0, 0, LAYER, LAYER);
    img = await createImageBitmap(b);
  }
  gl.activeTexture(gl.TEXTURE3);
  gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, LAYER, LAYER, 1, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.activeTexture(gl.TEXTURE0);
}
// 聚焦某张且翻到背面时：把该照片的高清背面载入 uBackFull，保证手写字清晰
async function loadBackFull(i) {
  const p = photos[sheets[i].photo];
  if (!p || !p.back) return;
  try {
    const blob = await (await fetch(p.back)).blob();
    const img = await createImageBitmap(blob);
    gl.activeTexture(gl.TEXTURE4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.activeTexture(gl.TEXTURE0);
    if (sel === i) { backFullFor = i; wake(); }
  } catch (e) { /* 背面加载失败则退回 256 层 */ }
}
const loaded = Promise.all(photos.map(async (p, i) => {
  try { await loadLayerImage(p.src, i); } catch (err) { console.warn('缺少照片', p.src, err); }
  try { if (p.back) await loadBackLayer(p.back, i); } catch (err) { console.warn('缺少背面', p.back, err); }
})).then(() => {
  gl.activeTexture(gl.TEXTURE0);
  gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.activeTexture(gl.TEXTURE3);
  gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.activeTexture(gl.TEXTURE0);
  ready = true;
  wake();
});

for (const [prog, units] of [[roomProgram, { uRefl: 2 }], [sheetProgram, { uPhotos: 0, uFull: 1, uBacks: 3, uBackFull: 4 }]]) {
  gl.useProgram(prog.p);
  for (const name in units) gl.uniform1i(prog.u[name], units[name]);
}
gl.enable(gl.DEPTH_TEST);
gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
gl.clearColor(.16, .16, .15, 1);

function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 1.5);
  W = canvas.width = Math.round(innerWidth * dpr);
  H = canvas.height = Math.round(innerHeight * dpr);
  // 镜面按半分辨率绘制
  gl.activeTexture(gl.TEXTURE2);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W >> 1, H >> 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, W >> 1, H >> 1);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, reflTex, 0);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  wake();
}

// ---------------------------------------------------------------------------
// 相机与绘制
// ---------------------------------------------------------------------------
function updateView() {
  const cp = Math.cos(cam.pitch), z = [Math.sin(cam.yaw) * cp, Math.sin(cam.pitch), Math.cos(cam.yaw) * cp];
  const x = [Math.cos(cam.yaw), 0, -Math.sin(cam.yaw)], y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const eye = [cam.x + z[0] * cam.dist, cam.y + z[1] * cam.dist, cam.z + z[2] * cam.dist];
  const dot = (a) => a[0] * eye[0] + a[1] * eye[1] + a[2] * eye[2];
  const f = 1 / Math.tan(FOV / 2), aspect = W / H, n = .05, far = 80;
  const v = [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x), -dot(y), -dot(z), 1];
  const pr = [f / aspect, f, (far + n) / (n - far), -1, 2 * far * n / (n - far)];
  // 投影 × 视图，为这个投影展开少数非零项
  const vp = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    vp[c * 4] = pr[0] * v[c * 4]; vp[c * 4 + 1] = pr[1] * v[c * 4 + 1];
    vp[c * 4 + 2] = pr[2] * v[c * 4 + 2] + pr[4] * v[c * 4 + 3]; vp[c * 4 + 3] = -v[c * 4 + 2];
  }
  const mirror = vp.slice(); // 在地板里反射：y → −y
  for (let i = 4; i < 8; i++) mirror[i] = -mirror[i];
  Object.assign(view, { eye, x, y, z, aspect, vp, mirror, eyeM: [eye[0], -eye[1], eye[2]] });
}

function draw(vp, eye, mirror) {
  gl.useProgram(roomProgram.p);
  gl.uniformMatrix4fv(roomProgram.u.uVP, false, vp);
  gl.uniform3fv(roomProgram.u.uEye, eye);
  gl.uniform1i(roomProgram.u.uMirror, mirror);
  gl.uniform1f(roomProgram.u.uTime, time);
  gl.uniform2f(roomProgram.u.uRes, W, H);
  gl.bindVertexArray(roomVao);
  gl.drawArrays(gl.TRIANGLES, 0, 36);
  if (!ready) return;
  gl.useProgram(sheetProgram.p);
  gl.uniformMatrix4fv(sheetProgram.u.uVP, false, vp);
  gl.uniform3fv(sheetProgram.u.uEye, eye);
  gl.uniform1f(sheetProgram.u.uTime, time);
  gl.uniform1i(sheetProgram.u.uSel, sel);
  if (sel >= 0) gl.uniform3f(sheetProgram.u.uFocus, sheets[sel].x, sheets[sel].y, sheets[sel].z);
  gl.uniform1i(sheetProgram.u.uHover, hover);
  gl.uniform1i(sheetProgram.u.uFullOn, fullFor === sel);
  gl.uniform1i(sheetProgram.u.uBackFullOn, backFullFor === sel && !!sheets[sel]?.flipped);
  gl.bindVertexArray(sheetVao);
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 14, sheets.length);
  if (mirror) return;
  gl.useProgram(threadProgram.p);
  gl.uniformMatrix4fv(threadProgram.u.uVP, false, vp);
  gl.uniform1f(threadProgram.u.uTime, time);
  gl.bindVertexArray(threadVao);
  gl.enable(gl.BLEND); gl.depthMask(false);
  gl.drawArraysInstanced(gl.LINES, 0, 4, sheets.length);
  gl.disable(gl.BLEND); gl.depthMask(true);
}

function render() {
  updateView();
  // 镜面的视图，在其纹理解绑时绘制（纹理在被绘制时不能被读取）
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.viewport(0, 0, W >> 1, H >> 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  draw(view.mirror, view.eyeM, 1);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, reflTex);
  gl.viewport(0, 0, W, H);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  draw(view.vp, view.eye, 0);
}

// 相机缓动到目标。离开屏幕时只重绘一帧；在屏幕上纸片会飘动（除非偏好减少动态），
// 一旦没有运动就停循环。
function wake() { if (live && !raf) raf = requestAnimationFrame(frame); }
function frame(now) {
  raf = 0;
  const dt = last ? Math.min((now - last) / 1000, .05) : 1 / 60;
  let moving = false;
  if (running()) {
    last = now;
    if (!reduced) {
      time += dt;
      if (sel < 0 && now - idleSince > 8000) goal.yaw += dt * .04; // 无人操作时缓慢环视
    }
    const k = 1 - Math.exp(-dt * 4);
    for (const key in goal) {
      const d = goal[key] - cam[key];
      if (Math.abs(d) > 1e-4) { cam[key] += d * k; moving = true; } else cam[key] = goal[key];
    }
    // 照片动力学：拨动/拖拽后的软弹簧回归（欠阻尼，柔和地弹几下再归于平静）
    let dynAny = false;
    for (let i = 0; i < sheets.length; i++) {
      const d = dyn[i]; if (!d) continue;
      const dragging = sheetDrag && sheetDrag.i === i;
      // 拖拽时跟手但保留一点松弛感；松手后弹簧更软、阻尼更小 → 像被拨动的线帘轻轻荡、慢慢归于平静
      const ks = dragging ? 55 : 12, cd = dragging ? 7 : 1.8;
      const tx = dragging ? sheetDrag.tx : 0, ty = dragging ? sheetDrag.ty : 0, tz = dragging ? sheetDrag.tz : 0;
      d.vx += (-ks * (d.ox - tx) - cd * d.vx) * dt; d.vy += (-ks * (d.oy - ty) - cd * d.vy) * dt; d.vz += (-ks * (d.oz - tz) - cd * d.vz) * dt;
      d.vx = Math.max(-2.5, Math.min(2.5, d.vx)); d.vy = Math.max(-2.5, Math.min(2.5, d.vy)); d.vz = Math.max(-2.5, Math.min(2.5, d.vz));
      d.ox += d.vx * dt; d.oy += d.vy * dt; d.oz += d.vz * dt;
      d.vyaw += (-10 * d.ry - 2.0 * d.vyaw) * dt; d.ry += d.vyaw * dt;
      const act = Math.abs(d.ox) + Math.abs(d.oy) + Math.abs(d.oz) + Math.abs(d.ry) + Math.abs(d.vx) + Math.abs(d.vy) + Math.abs(d.vz) + Math.abs(d.vyaw) > 3e-4;
      if (!act) { d.ox = d.oy = d.oz = d.ry = d.vx = d.vy = d.vz = d.vyaw = 0; }
      if (act || d.was) { // 进入/离开运动态都要写回缓冲，静止时归零
        tmpDyn[0] = d.ox; tmpDyn[1] = d.oy; tmpDyn[2] = d.oz; tmpDyn[3] = d.ry;
        gl.bindBuffer(gl.ARRAY_BUFFER, instances);
        gl.bufferSubData(gl.ARRAY_BUFFER, (i * FLOATS_PER_SHEET + 12) * 4, tmpDyn);
      }
      d.was = act;
      if (act) dynAny = true;
    }
    // 翻转动画：绕竖轴转 180°，转到侧面时朝向翻转，着色器自动改采背面
    for (let i = 0; i < sheets.length; i++) {
      const a = sheets[i].flipAnim; if (!a) continue;
      a.t += dt;
      const k = Math.min(1, a.t / a.dur);
      const e = 1 - Math.pow(1 - k, 3); // 缓出，柔和
      writeYaw(i, a.from + (a.to - a.from) * e);
      if (k >= 1) { sheets[i].renderYaw = a.to; sheets[i].flipAnim = null; }
      moving = true;
    }
    if (dynAny) moving = true;
    moving ||= !reduced;
  }
  render();
  if (moving) wake(); else last = 0;
}

// ---------------------------------------------------------------------------
// 拾取、选中与输入
// ---------------------------------------------------------------------------
function pick(cx, cy) {
  const { eye, x, y, z, aspect } = view, t = Math.tan(FOV / 2);
  const nx = (cx / innerWidth * 2 - 1) * t * aspect, ny = (1 - cy / innerHeight * 2) * t;
  const d = [0, 1, 2].map((i) => x[i] * nx + y[i] * ny - z[i]);
  let best = -1, bestT = Infinity;
  sheets.forEach((s, i) => {
    const D = dyn[i];
    const yaw = s.yaw + Math.sin(time * .35 + s.phase) * .1 + Math.sin(time * .17 + s.phase * 1.7) * .06 + D.ry;
    const c = [s.x + Math.sin(time * .23 + s.phase * 2.1) * .015 + D.ox, s.y + D.oy, s.z + Math.cos(time * .19 + s.phase * 1.3) * .015 + D.oz];
    const sn = Math.sin(yaw), cs = Math.cos(yaw), den = d[0] * sn + d[2] * cs;
    if (Math.abs(den) < 1e-5) return;
    const hit = ((c[0] - eye[0]) * sn + (c[2] - eye[2]) * cs) / den;
    if (hit <= 0 || hit >= bestT) return;
    const hx = eye[0] + d[0] * hit - c[0], hy = eye[1] + d[1] * hit - c[1], hz = eye[2] + d[2] * hit - c[2];
    if (Math.abs(hx * cs - hz * sn) < s.w / 2 && Math.abs(hy) < s.h / 2) { best = i; bestT = hit; }
  });
  return best;
}

// 丝线拾取：指针射线与每根吊线段的最近距离
function raySegDist(o, d, p0, p1) {
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const v = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], w = [o[0] - p0[0], o[1] - p0[1], o[2] - p0[2]];
  const a = dot(d, d), b = dot(d, v), c = dot(v, v), f = dot(d, w), g = dot(v, w), D = a * c - b * b;
  let t, s;
  if (D < 1e-9) { t = 0; s = g / c; }
  else { t = Math.max(0, (b * g - c * f) / D); s = (b * t + g) / c; }
  if (s < 0) s = 0; else if (s > 1) s = 1;
  t = Math.max(0, (b * s - f) / a);
  return Math.hypot(o[0] + d[0] * t - (p0[0] + v[0] * s), o[1] + d[1] * t - (p0[1] + v[1] * s), o[2] + d[2] * t - (p0[2] + v[2] * s));
}
function pickThread(cx, cy) {
  if (!ready || !view.eye) return -1;
  const { eye, x, y, z, aspect } = view, t = Math.tan(FOV / 2);
  const nx = (cx / innerWidth * 2 - 1) * t * aspect, ny = (1 - cy / innerHeight * 2) * t;
  const d = [x[0] * nx + y[0] * ny - z[0], x[1] * nx + y[1] * ny - z[1], x[2] * nx + y[2] * ny - z[2]];
  let best = -1, bestD = .07;
  sheets.forEach((s, i) => {
    const D = dyn[i];
    const yaw = s.yaw + Math.sin(time * .35 + s.phase) * .1 + Math.sin(time * .17 + s.phase * 1.7) * .06 + D.ry;
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    const c = [s.x + Math.sin(time * .23 + s.phase * 2.1) * .015 + D.ox, s.y + D.oy, s.z + Math.cos(time * .19 + s.phase * 1.3) * .015 + D.oz];
    for (const side of [-.4 * s.w, .4 * s.w]) {
      const dist = raySegDist(eye, d, [c[0] + cs * side, c[1] + s.h * .5, c[2] - sn * side], [s.x + Math.cos(s.yaw) * side, RH, s.z - Math.sin(s.yaw) * side]);
      if (dist < bestD) { bestD = dist; best = i; }
    }
  });
  return best;
}
// 轻拨：把指针在屏幕上的滑动换算成世界方向的速度脉冲（限幅，保证柔和）
function applyBrush(i, dxm, dym, scale) {
  const d = dyn[i]; if (!d) return;
  const wpp = 2 * cam.dist * Math.tan(FOV / 2) / innerHeight, f = wpp * 1.1 * scale; // 拨动力度大幅增大，像拨开线帘
  const vx = (view.x[0] * dxm - view.y[0] * dym) * f;
  const vy = (view.x[1] * dxm - view.y[1] * dym) * f;
  const vz = (view.x[2] * dxm - view.y[2] * dym) * f;
  const s0 = sheets[i];
  // 线帘级联：附近 1.2m 内的其他纸片也跟着轻轻荡，越近越明显
  for (let j = 0; j < sheets.length; j++) {
    if (j === i) continue;
    const sj = sheets[j], w = 1 - Math.hypot(sj.x - s0.x, sj.y - s0.y, sj.z - s0.z) / 1.2;
    if (w <= 0) continue;
    const dj = dyn[j]; if (!dj) continue;
    dj.vx += vx * w * .45; dj.vy += vy * w * .45; dj.vz += vz * w * .45;
  }
  d.vx += vx; d.vy += vy; d.vz += vz;
  d.vyaw += dxm * .0016 * scale;
  const m = Math.hypot(d.vx, d.vy, d.vz), cap = 1.5 * scale;
  if (m > cap) { d.vx *= cap / m; d.vy *= cap / m; d.vz *= cap / m; }
  d.vyaw = Math.max(-1.2, Math.min(1.2, d.vyaw));
}

const caption = $('caption');
function select(i) {
  sel = i;
  idleSince = performance.now();
  if (i < 0) {
    Object.assign(goal, { ...HOME, yaw: goal.yaw });
    caption.hidden = true;
    canvas.focus({ preventScroll: true });
  } else {
    const s = sheets[i], p = photos[s.photo], t = Math.tan(FOV / 2);
    // 聚焦时统一看正面：若这张原本背面朝外，先翻回正面（符合「点照片看正面，翻转看背面」）
    if (s.flipped) flipSheet(i);
    const turn = Math.atan2(Math.sin(s.yaw - cam.yaw), Math.cos(s.yaw - cam.yaw));
    Object.assign(goal, { x: s.x, y: s.y, z: s.z, yaw: cam.yaw + turn, pitch: .04, dist: Math.max(s.h / (1.1 * t), s.w / (1.2 * t * W / H)) });
    $('title').textContent = p.description;
    $('credit').textContent = p.photographer;
    if (p.back) loadBackFull(i);
    const src = $('source');
    if (p.source_page) { src.href = p.source_page; src.style.display = ''; } else src.style.display = 'none';
    caption.hidden = false;
    fetch(p.full).then((r) => r.blob()).then((b) => createImageBitmap(b)).then((img) => {
      if (sel !== i) return;
      gl.activeTexture(gl.TEXTURE1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      fullFor = i;
      wake();
    }, () => {});
  }
  wake();
}
const firstSheetOf = (photo) => { const i = sheets.findIndex((s) => s.photo === photo); return i < 0 ? 0 : i; };
const step = (dir) => select(sel < 0 ? firstSheetOf(0) : firstSheetOf((sheets[sel].photo + dir + photos.length) % photos.length));
$('prev').onclick = () => step(-1);
$('next').onclick = () => step(1);
$('close').onclick = () => select(-1);
// 翻转：绕竖轴转 180°，转到侧面时朝向翻转，着色器自动改采背面纹理
function flipSheet(si) {
  const s = sheets[si];
  if (!s || s.flipAnim) return;
  const from = s.renderYaw ?? s.yaw;
  s.flipAnim = { from, to: from + Math.PI, t: 0, dur: reduced ? .01 : .5 };
  s.flipped = !s.flipped;
  s.backOut = !s.backOut; // 翻转后朝向互换 → 背面 UV 的镜像策略随之切换
  writeSheet(si, s);
  if (glReady) { gl.bindBuffer(gl.ARRAY_BUFFER, instances); gl.bufferSubData(gl.ARRAY_BUFFER, si * FLOATS_PER_SHEET * 4, sheetData.subarray(si * FLOATS_PER_SHEET, (si + 1) * FLOATS_PER_SHEET)); }
  if (sel === si) loadBackFull(si);
  wake();
}
const pointers = new Map();
let moved = 0, spread = 0;
const pinch = () => { const [a, b] = [...pointers.values()]; return Math.hypot(a.x - b.x, a.y - b.y) || 1; };
const touched = () => { idleSince = performance.now(); wake(); };
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  moved = 0;
  if (pointers.size === 2) { spread = pinch(); sheetDrag = null; } // 双指捏合时取消拖照片
  else if (ready) { const i = pick(e.clientX, e.clientY); if (i >= 0) sheetDrag = { i, tx: 0, ty: 0, tz: 0 }; } // 按住照片：进入拖拽
  touched();
});
const lastMouse = { x: innerWidth / 2, y: innerHeight / 2 };
canvas.addEventListener('pointermove', (e) => {
  const dxm = e.clientX - lastMouse.x, dym = e.clientY - lastMouse.y;
  lastMouse.x = e.clientX; lastMouse.y = e.clientY;
  const p = pointers.get(e.pointerId);
  if (!p) {
    if (e.pointerType !== 'mouse' || !ready) return;
    const i = Math.max(pick(e.clientX, e.clientY), pickThread(e.clientX, e.clientY)); // 照片或丝线都算悬停
    if (i !== hover) { hover = i; canvas.classList.toggle('is-pointer', i >= 0); }
    if (i >= 0 && (dxm || dym)) { applyBrush(i, dxm, dym, 1); wake(); } // 轻轻拨过去
    return;
  }
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY; moved += Math.abs(dx) + Math.abs(dy);
  if (pointers.size === 1) {
    if (sheetDrag) {
      // 拉动照片：指针位移换算成世界位移目标（限幅 .5m，手感柔和）
      const wpp = 2 * cam.dist * Math.tan(FOV / 2) / innerHeight;
      let tx = sheetDrag.tx + (view.x[0] * dx - view.y[0] * dy) * wpp;
      let ty = sheetDrag.ty + (view.x[1] * dx - view.y[1] * dy) * wpp;
      let tz = sheetDrag.tz + (view.x[2] * dx - view.y[2] * dy) * wpp;
      const m = Math.hypot(tx, ty, tz);
      if (m > .95) { tx *= .95 / m; ty *= .95 / m; tz *= .95 / m; } // 可拉得更远、更松弛
      sheetDrag.tx = tx; sheetDrag.ty = ty; sheetDrag.tz = tz;
    } else {
      goal.yaw -= dx * .005;
      goal.pitch = Math.max(-.05, Math.min(1.1, goal.pitch + dy * .004));
    }
  } else {
    const d = pinch();
    goal.dist = Math.max(1, Math.min(13, goal.dist * spread / d));
    spread = d;
  }
  touched();
});
const release = (e) => {
  pointers.delete(e.pointerId);
  if (e.type === 'pointerup' && !pointers.size && ready) {
    if (sheetDrag) {
      // 原地点击：已聚焦的那张→翻转看背面；否则照常飞入聚焦（单击翻转是原有手感，不改）
      if (moved < 6) { if (sel === sheetDrag.i) flipSheet(sheetDrag.i); else select(sheetDrag.i); }
      sheetDrag = null; // 拉动后松手：目标归零，弹簧自然回弹
    } else if (moved < 6) {
      const i = pick(e.clientX, e.clientY);
      if (i >= 0) { if (sel === i) flipSheet(i); else select(i); }
    }
  }
};
// 重新编辑一张照片：直接打开编辑器，绝不弹文件选择框
// —— 用户的意思是「在这张照片已有的创作基础上继续改」，而不是让他去文件夹里重新找一遍
async function reeditPhoto(si) {
  const sh = sheets[si];
  if (!sh) return;
  await openEditorOn(sh.photo);
}
// 用照片的「原始素材 + 上次编辑设置」打开编辑器（还原正面裁剪/相纸/相框，并载入既有背面）
async function openEditorOn(pi) {
  const p = photos[pi];
  try {
    // 优先用保存下来的原始图（未合成的），否则用当前成品
    const src = p.raw || p.src;
    const blob = await (await fetch(src)).blob();
    const file = new File([blob], 'reedit.jpg', { type: blob.type || 'image/jpeg' });
    select(-1);
    openEditor('replace', firstSheetOf(pi), file, p.cfg || null);
    edit.pendingBack = p.back || null;   // 供 initBack 还原既有背面
    edit.pendingTexts = p.texts || null; // 文本框对象也一并还原（可继续移动/改字）
  } catch (e) {
    console.warn('无法打开该照片', e);
    toast('这张照片暂时无法重新编辑');
  }
}
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('dblclick', (e) => { // 双击照片 → 重新编辑（单击留给聚焦/翻转）
  const i = pick(e.clientX, e.clientY);
  if (i >= 0) reeditPhoto(i);
});
canvas.addEventListener('pointerleave', () => { if (hover >= 0) { hover = -1; wake(); } });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  goal.dist = Math.max(1, Math.min(13, goal.dist * Math.exp(e.deltaY * (e.deltaMode ? .05 : .0015))));
  touched();
}, { passive: false });
addEventListener('keydown', (e) => {
  if (!editor.hidden) {
    // 背面创作时：先关文本浮层 / 取消文本选中，再按 Esc 才退出编辑器
    if (e.key === 'Escape') {
      if (edit.mode === 'back' && !edTextPop.hidden) { closeTextPop(); e.stopPropagation(); return; }
      if (edit.mode === 'back' && selText >= 0) { selText = -1; syncTextPanel(); renderTexts(); e.stopPropagation(); return; }
      closeEditor();
    }
    return; // 编辑器打开时接管按键
  }
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); step(e.key === 'ArrowRight' ? 1 : -1); }
  else if (e.key === 'Escape' && sel >= 0) select(-1);
});
addEventListener('resize', resize);

// ---------------------------------------------------------------------------
// 运行时上传：替换当前照片 / 添加新照片（自动适配、本地保存）
// ---------------------------------------------------------------------------
const fileInput = $('file');
let pending = null; // { mode: 'add' | 'replace', sheet?: number }
function openPicker(mode, sheet) { pending = { mode, sheet }; fileInput.value = ''; fileInput.click(); }
fileInput.addEventListener('change', () => {
  const f = fileInput.files[0];
  if (!f) return;
  openEditor(pending?.mode === 'replace' ? 'replace' : 'add', pending?.sheet, f);
  pending = null;
});

// ---------------------------------------------------------------------------
// 照片编辑器：自由/常用比例裁剪 + 白色相框模板（拍立得下宽 / 等边 / 无），实时预览
// ---------------------------------------------------------------------------
const editor = $('editor'), edImg = $('edImg'), edStage = $('edStage'), edCrop = $('edCrop');
const edPrev = $('edPrev'), pctx = edPrev.getContext('2d');
const edit = { ratio: 0, crop: null, frame: 'polaroid', fw: .07, series: 'classic', paperId: 'warm', custom: '#f4f1ea', lastPaper: { classic: 'warm' }, tpl: 'wide', pending: null, pendingBack: null, pendingTexts: null, restore: null, origURL: null, drag: null, mode: 'front', backURL: null, tool: 'pencil', color: '#35302a', size: 4, bold: false, italic: false, font: "'Ma Shan Zheng', cursive", _backInit: false };
const MINC = 24;               // 最小裁剪尺寸（图像像素）

// ---------------------------------------------------------------------------
// 相纸系统：fill 纯色 / grad 渐变 / doodle 照片之上的手绘装饰
// ---------------------------------------------------------------------------
const PAPERS = {
  classic: [
    { id: 'warm', name: '暖白', fill: '#f4f1ea' },
    { id: 'pure', name: '纯白', fill: '#fdfcf8' },
    { id: 'cream', name: '米黄', fill: '#f5eeda' },
    { id: 'kraft', name: '牛皮', fill: '#c9a878' },
  ],
  solid: [
    ['#e60012', '大红'], ['#f37021', '橙'], ['#fdb913', '橙黄'], ['#6abf4b', '草绿'], ['#56b9e9', '天蓝'], ['#27447b', '深蓝'],
    ['#7d5fc4', '紫'], ['#d062c4', '洋红'], ['#ea5f8f', '玫红'], ['#8a5a3b', '棕'], ['#f4f1ea', '米白'], ['#1d1c1a', '黑'],
  ].map(([hex, name]) => ({ id: hex, name, fill: hex })),
  doodle: [
    { id: 'kitty', name: '凯蒂线描', fill: '#fbf8f1', doodle: doodleKitty },
    { id: 'stitch', name: '史迪奇线描', fill: '#f7f4ec', doodle: doodleStitch },
    { id: 'confetti', name: '糖果图形', fill: '#fbf9f4', doodle: doodleConfetti },
    { id: 'flowers', name: '小花', fill: '#fbfaf6', doodle: doodleFlowers },
    { id: 'moon', name: '月亮星星', fill: '#f7f4ec', doodle: doodleMoon },
    { id: 'hearts', name: '爱心', fill: '#fbf9f4', doodle: doodleHearts },
  ],
  laser: [
    { id: 'rainbow', name: '彩虹镭射', grad: laserGrad([[0, '#f6b8c5'], [.16, '#f9d8a6'], [.32, '#f7f0a9'], [.48, '#bfe8c4'], [.62, '#a9dcef'], [.78, '#b7b4ea'], [.9, '#e3b3dd'], [1, '#f6c3a0']]) },
    { id: 'silver', name: '银白镭射', grad: laserGrad([[0, '#f2f3f5'], [.25, '#d5d9df'], [.45, '#f7f8fa'], [.62, '#c9ced8'], [.8, '#eef0f3'], [1, '#d8dce2']]) },
    { id: 'noir', name: '玄黑镭射', fill: '#17161a', grad: laserNoir },
    { id: 'aurora', name: '极光镭射', grad: laserGrad([[0, '#bfeee4'], [.3, '#9fd8ef'], [.55, '#b9b0ee'], [.8, '#d9b3e6'], [1, '#a9e0d2']]) },
  ],
};
function laserGrad(stops) {
  return (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, 0, w, h);
    for (const [t, c] of stops) g.addColorStop(t, c);
    return g;
  };
}
function laserNoir(ctx, w, h) {
  const g = ctx.createLinearGradient(0, h, w, 0);
  for (const [t, c] of [[0, 'rgba(255,122,150,.18)'], [.25, 'rgba(255,209,128,.14)'], [.5, 'rgba(122,229,180,.13)'], [.75, 'rgba(122,168,255,.17)'], [1, 'rgba(201,132,255,.18)']]) g.addColorStop(t, c);
  return g;
}
// —— 涂鸦绘制（确定性抖动，所见即所得；坐标为合成图像素） ——
function scribbleLine(ctx, x0, y0, x1, y1, amp = 1.4) {
  const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1, n = Math.max(3, Math.round(len / 14));
  const nx = -dy / len, ny = dx / len;
  ctx.moveTo(x0, y0);
  for (let i = 1; i <= n; i++) {
    const t = i / n, w = Math.sin(t * 9.7 + len) * amp * (i < n ? 1 : .15);
    ctx.lineTo(x0 + dx * t + nx * w, y0 + dy * t + ny * w);
  }
}
// —— 确定性随机（每次合成涂鸦分布完全一致，预览即成品） ——
function rngOf(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
// 两个可复用的小零件（供组合图形拼装）
function miniFlower(ctx, x, y, s, rot) {
  for (let i = 0; i < 5; i++) {
    const a = rot + i * Math.PI * 2 / 5, px = x + Math.cos(a) * s * .45, py = y + Math.sin(a) * s * .45;
    ctx.moveTo(px + s * .28, py); ctx.arc(px, py, s * .28, 0, 7);
  }
  ctx.moveTo(x + s * .16, y); ctx.arc(x, y, s * .16, 0, 7);
}
function miniCloud(ctx, x, y, w, h) {
  ctx.moveTo(x - w, y + h);
  ctx.quadraticCurveTo(x - w * 1.2, y - h * .9, x - w * .35, y - h * .28);
  ctx.quadraticCurveTo(x, y - h * 1.65, x + w * .4, y - h * .24);
  ctx.quadraticCurveTo(x + w * 1.18, y - h * .85, x + w, y + h);
  ctx.closePath();
}
// 简笔小图形库：沿相框留白随机分布
function drawMini(ctx, kind, x, y, s, rot) {
  if (kind === 'star') return starPath(ctx, x, y, s, rot);
  if (kind === 'heart') return heartPath(ctx, x, y, s, rot);
  if (kind === 'circle') { ctx.moveTo(x + s * .5, y); ctx.arc(x, y, s * .5, 0, 7); return; }
  if (kind === 'cross') { const t = s * .35; ctx.moveTo(x - t, y - t); ctx.lineTo(x + t, y + t); ctx.moveTo(x + t, y - t); ctx.lineTo(x - t, y + t); return; }
  if (kind === 'flower') { miniFlower(ctx, x, y, s, rot); return; }
  if (kind === 'wave') {
    ctx.moveTo(x - s * .6, y);
    for (let i = 1; i <= 6; i++) ctx.quadraticCurveTo(x - s * .6 + s * .2 * (i - .5), y + (i % 2 ? 1 : -1) * s * .3, x - s * .6 + s * .2 * i, y);
    return;
  }
  if (kind === 'sparkle') { // 四角闪光（细长的星芒）
    const r = s * .5, r2 = s * .16;
    ctx.moveTo(x, y - r); ctx.lineTo(x + r2, y - r2); ctx.lineTo(x + r, y); ctx.lineTo(x + r2, y + r2);
    ctx.lineTo(x, y + r); ctx.lineTo(x - r2, y + r2); ctx.lineTo(x - r, y); ctx.lineTo(x - r2, y - r2); ctx.closePath();
    return;
  }
  if (kind === 'moon') { // 月牙：外弧 + 偏移内弧
    const R = s * .5, a0 = -1.15, a1 = 1.15;
    ctx.moveTo(x + R * Math.cos(a0), y + R * Math.sin(a0));
    ctx.arc(x, y, R, a0, a1, false);
    ctx.arc(x + R * .42, y, R * .92, a1, a0, true);
    ctx.closePath();
    return;
  }
  if (kind === 'leaf') { // 叶片 + 主脉
    const L = s * .5;
    ctx.moveTo(x - L, y);
    ctx.quadraticCurveTo(x, y - L * .85, x + L, y);
    ctx.quadraticCurveTo(x, y + L * .85, x - L, y);
    ctx.moveTo(x - L, y); ctx.lineTo(x + L, y);
    return;
  }
  if (kind === 'butterfly') { // 蝴蝶：双翼 + 身体 + 触角
    const w = s * .5, h = s * .44;
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x - w * 1.15, y - h * 1.2, x - w * .92, y + h * .12);
    ctx.quadraticCurveTo(x - w * .8, y + h * .95, x, y + h * .26);
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + w * 1.15, y - h * 1.2, x + w * .92, y + h * .12);
    ctx.quadraticCurveTo(x + w * .8, y + h * .95, x, y + h * .26);
    ctx.moveTo(x, y - h * .18); ctx.lineTo(x, y + h * .32);
    ctx.moveTo(x - w * .06, y - h * .18); ctx.lineTo(x - w * .32, y - h * .82);
    ctx.moveTo(x + w * .06, y - h * .18); ctx.lineTo(x + w * .32, y - h * .82);
    return;
  }
  if (kind === 'cloud') { miniCloud(ctx, x, y, s * .5, s * .3); return; }
  if (kind === 'sun') { // 太阳：圆 + 六道光芒
    const r = s * .26;
    ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, 7);
    for (let i = 0; i < 6; i++) {
      const a = rot + i * Math.PI / 3;
      ctx.moveTo(x + Math.cos(a) * r * 1.6, y + Math.sin(a) * r * 1.6);
      ctx.lineTo(x + Math.cos(a) * r * 2.4, y + Math.sin(a) * r * 2.4);
    }
    return;
  }
  if (kind === 'rainbow') { // 彩虹：三道同心弧
    for (let i = 0; i < 3; i++) {
      const r = s * (.5 - i * .14);
      ctx.moveTo(x - r, y); ctx.arc(x, y, r, Math.PI, 0, false);
    }
    return;
  }
  if (kind === 'music') { // 音符：符头 + 符干 + 旗
    const r = s * .15;
    ctx.moveTo(x - s * .12 + r, y + s * .3); ctx.arc(x - s * .12, y + s * .3, r, 0, 7);
    ctx.moveTo(x + s * .03, y + s * .3); ctx.lineTo(x + s * .03, y - s * .42);
    ctx.moveTo(x + s * .03, y - s * .42);
    ctx.quadraticCurveTo(x + s * .38, y - s * .26, x + s * .26, y + s * .04);
    return;
  }
  if (kind === 'bow') { // 蝴蝶结：双环 + 中心结
    const b = s * .32;
    ctx.moveTo(x - b * .12, y);
    ctx.quadraticCurveTo(x - b * 1.5, y - b * 1.05, x - b * 1.28, y + b * .06);
    ctx.quadraticCurveTo(x - b * 1.5, y + b * 1.05, x - b * .12, y);
    ctx.moveTo(x + b * .12, y);
    ctx.quadraticCurveTo(x + b * 1.5, y - b * 1.05, x + b * 1.28, y + b * .06);
    ctx.quadraticCurveTo(x + b * 1.5, y + b * 1.05, x + b * .12, y);
    ctx.moveTo(x + b * .14, y); ctx.arc(x, y, b * .14, 0, 7);
    return;
  }
  if (kind === 'drop') { // 水滴
    const r = s * .42;
    ctx.moveTo(x, y - r);
    ctx.quadraticCurveTo(x + r * .95, y + r * .25, x, y + r);
    ctx.quadraticCurveTo(x - r * .95, y + r * .25, x, y - r);
    return;
  }
  if (kind === 'paw') { // 爪印：掌垫 + 三趾
    const r = s * .22;
    ctx.moveTo(x + r * .9, y + r * .55); ctx.arc(x, y + r * .55, r * .9, 0, 7);
    for (let i = -1; i <= 1; i++) {
      const px = x + i * r * 1.1, py = y - r * .8;
      ctx.moveTo(px + r * .46, py); ctx.arc(px, py, r * .46, 0, 7);
    }
    return;
  }
  if (kind === 'lightning') { // 闪电
    ctx.moveTo(x + s * .14, y - s * .48); ctx.lineTo(x - s * .28, y + s * .05);
    ctx.lineTo(x + s * .04, y + s * .05); ctx.lineTo(x - s * .12, y + s * .48);
    ctx.lineTo(x + s * .3, y - s * .06); ctx.lineTo(x - s * .02, y - s * .06);
    ctx.closePath();
    return;
  }
  if (kind === 'crown') { // 皇冠
    const w = s * .45, h = s * .38;
    ctx.moveTo(x - w, y + h * .55);
    ctx.lineTo(x - w * .95, y - h * .6);
    ctx.lineTo(x - w * .34, y + h * .06);
    ctx.lineTo(x, y - h * .9);
    ctx.lineTo(x + w * .34, y + h * .06);
    ctx.lineTo(x + w * .95, y - h * .6);
    ctx.lineTo(x + w, y + h * .55);
    ctx.closePath();
    return;
  }
  if (kind === 'balloon') { // 气球 + 飘线
    const r = s * .3;
    ctx.moveTo(x + r * .85, y - r); ctx.ellipse(x, y - r, r * .85, r, 0, 0, 7);
    ctx.moveTo(x, y); ctx.quadraticCurveTo(x + s * .12, y + r, x - s * .02, y + r * 1.7);
    return;
  }
  if (kind === 'smile') { // 笑脸：圆 + 双眼 + 笑嘴
    const r = s * .42;
    ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, 7);
    ctx.moveTo(x - r * .35 + r * .1, y - r * .18); ctx.arc(x - r * .35, y - r * .18, r * .1, 0, 7);
    ctx.moveTo(x + r * .35 + r * .1, y - r * .18); ctx.arc(x + r * .35, y - r * .18, r * .1, 0, 7);
    ctx.moveTo(x + Math.cos(Math.PI * .22) * r * .45, y - r * .05 + Math.sin(Math.PI * .22) * r * .45);
    ctx.arc(x, y - r * .05, r * .45, Math.PI * .22, Math.PI * .78, false);
    return;
  }
  if (kind === 'icecream') { // 冰淇淋：球 + 蛋筒
    const r = s * .25;
    ctx.moveTo(x + r, y - r * .35); ctx.arc(x, y - r * .35, r, 0, 7);
    ctx.moveTo(x - r * 1.05, y); ctx.lineTo(x + r * 1.05, y); ctx.lineTo(x, y + r * 1.8); ctx.closePath();
    return;
  }
  if (kind === 'snowflake') { // 雪花：三轴 + 分叉
    const r = s * .45;
    for (let i = 0; i < 3; i++) {
      const a = rot + i * Math.PI / 3;
      ctx.moveTo(x - Math.cos(a) * r, y - Math.sin(a) * r);
      ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
      for (const sg of [-1, 1]) {
        const bx = x + Math.cos(a) * r * sg * .58, by = y + Math.sin(a) * r * sg * .58;
        ctx.moveTo(bx, by); ctx.lineTo(bx + Math.cos(a + 1.15) * r * .3, by + Math.sin(a + 1.15) * r * .3);
        ctx.moveTo(bx, by); ctx.lineTo(bx + Math.cos(a - 1.15) * r * .3, by + Math.sin(a - 1.15) * r * .3);
      }
    }
    return;
  }
  if (kind === 'triangle') {
    const r = s * .44;
    for (let i = 0; i < 3; i++) {
      const a = -Math.PI / 2 + i * Math.PI * 2 / 3;
      i ? ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r) : ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    }
    ctx.closePath();
    return;
  }
  if (kind === 'diamond') { // 菱形
    const r = s * .46;
    ctx.moveTo(x, y - r); ctx.lineTo(x + r * .72, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r * .72, y); ctx.closePath();
    return;
  }
  // ——— 以下是“小孩乱画”系列：歪歪扭扭、绕线圈、随手涂 ———
  if (kind === 'scribbleCircle') { // 绕了不止一圈、闭不拢的圆（小孩画的圆都这样）
    const R = s * .45, n = 32;
    ctx.moveTo(x + R, y);
    for (let i = 1; i <= n; i++) {
      const a = i / n * Math.PI * 2 * 1.12, rr = R * (1 + Math.sin(a * 3.1) * .14 + Math.sin(a * 7.7) * .08);
      ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    return;
  }
  if (kind === 'spiral') { // 螺旋线圈，一圈圈绕进去
    const n = 32, R = s * .48;
    for (let i = 0; i <= n; i++) {
      const t = i / n, a = t * Math.PI * 5.2, rr = R * (1 - t * .9);
      const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    return;
  }
  if (kind === 'zigzag') { // 之字折线
    ctx.moveTo(x - s * .6, y);
    for (let i = 1; i <= 6; i++) ctx.lineTo(x - s * .6 + i * s * .2, y + (i % 2 ? s * .32 : -s * .32));
    return;
  }
  if (kind === 'swirl') { // 卷卷小尾巴
    ctx.moveTo(x - s * .5, y + s * .38);
    ctx.quadraticCurveTo(x + s * .55, y + s * .42, x + s * .48, y - s * .02);
    ctx.quadraticCurveTo(x + s * .42, y - s * .38, x + s * .08, y - s * .32);
    ctx.quadraticCurveTo(x - s * .16, y - s * .28, x - s * .06, y - s * .06);
    return;
  }
  if (kind === 'hatch') { // 一撮排线（像在涂色）
    for (let i = 0; i < 4; i++) {
      const px = x - s * .33 + i * s * .22;
      ctx.moveTo(px, y - s * .28); ctx.lineTo(px + s * .14, y + s * .28);
    }
    return;
  }
  if (kind === 'dots3') { // 三个小点
    for (let i = -1; i <= 1; i++) {
      const px = x + i * s * .28;
      ctx.moveTo(px + s * .09, y); ctx.arc(px, y, s * .09, 0, 7);
    }
    return;
  }
  if (kind === 'asterisk') { // 放射星芒
    for (let i = 0; i < 6; i++) {
      const a = rot + i * Math.PI / 3;
      ctx.moveTo(x + Math.cos(a) * s * .14, y + Math.sin(a) * s * .14);
      ctx.lineTo(x + Math.cos(a) * s * .48, y + Math.sin(a) * s * .48);
    }
    return;
  }
  if (kind === 'loops') { // 一串小圈圈，弹簧似的
    for (let i = 0; i < 4; i++) {
      const px = x - s * .55 + i * s * .36, py = y + (i % 2 ? -s * .14 : s * .14);
      ctx.moveTo(px + s * .16, py); ctx.arc(px, py, s * .16, 0, 7);
    }
    return;
  }
  if (kind === 'bundle') { // 一撮小草
    for (let i = 0; i < 4; i++) {
      const a = -Math.PI / 2 + (i - 1.5) * .38;
      ctx.moveTo(x, y + s * .42);
      ctx.quadraticCurveTo(x + Math.cos(a) * s * .22, y + s * .05, x + Math.cos(a) * s * .48 + (i - 1.5) * s * .07, y + Math.sin(a) * s * .58);
    }
    return;
  }
  // ——— 组合图形：有点设计感的小构图 ———
  if (kind === 'flowerStem') { // 一朵花 + 茎 + 两片叶
    miniFlower(ctx, x, y - s * .32, s * .62, rot);
    ctx.moveTo(x, y - s * .1); ctx.lineTo(x, y + s * .5);
    ctx.moveTo(x, y + s * .12); ctx.quadraticCurveTo(x - s * .3, y + s * .02, x, y + s * .3);
    ctx.moveTo(x, y + s * .26); ctx.quadraticCurveTo(x + s * .3, y + s * .18, x, y + s * .44);
    return;
  }
  if (kind === 'cloudRain') { // 云 + 下雨
    miniCloud(ctx, x, y - s * .22, s * .42, s * .25);
    for (let i = -1; i <= 1; i++) {
      const px = x + i * s * .24, py = y + s * .16;
      ctx.moveTo(px, py); ctx.lineTo(px - s * .07, py + s * .28);
    }
    return;
  }
  if (kind === 'starBurst') { // 星星 + 一圈放射线
    starPath(ctx, x, y, s * .5, rot);
    for (let i = 0; i < 8; i++) {
      const a = rot + i * Math.PI / 4 + .2;
      ctx.moveTo(x + Math.cos(a) * s * .62, y + Math.sin(a) * s * .62);
      ctx.lineTo(x + Math.cos(a) * s * .86, y + Math.sin(a) * s * .86);
    }
    return;
  }
  if (kind === 'heartArrow') { // 爱心 + 一支穿过去的箭
    heartPath(ctx, x, y, s * .5, rot * .3);
    ctx.moveTo(x - s * .68, y + s * .5); ctx.lineTo(x + s * .68, y - s * .5);
    ctx.moveTo(x + s * .34, y - s * .46); ctx.lineTo(x + s * .68, y - s * .5); ctx.lineTo(x + s * .52, y - s * .16);
    return;
  }
}
// 全部小图形清单（38 种）；不指定主题时用这份全混合
const MINI_MIX = ['star', 'heart', 'circle', 'cross', 'flower', 'wave', 'sparkle', 'moon', 'leaf',
  'butterfly', 'cloud', 'sun', 'rainbow', 'music', 'bow', 'drop', 'paw', 'lightning',
  'crown', 'balloon', 'smile', 'icecream', 'snowflake', 'triangle', 'diamond',
  'scribbleCircle', 'spiral', 'zigzag', 'swirl', 'hatch', 'dots3', 'asterisk', 'loops', 'bundle',
  'flowerStem', 'cloudRain', 'starBurst', 'heartArrow'];
// 儿童马克笔配色（最后一个是墨黑，用来压一压，不至于太花）
const DOODLE_COLORS = ['#e8534f', '#ef8a3c', '#f3c33f', '#6fc257', '#3fb3d6', '#7b74d9', '#e569a6', '#3a332c'];
function scatterDoodles(ctx, w, h, side, bottom, seed, face, kinds, tpl) {
  const rnd = rngOf(seed + (TPL_SEED[tpl] || 0)); // 同一张涂鸦纸在不同模板下分布也不同，各自固定
  const KINDS = kinds || MINI_MIX;
  // 图形大小锚定“照片区域”短边 × 模板系数：模板固定，图形大小随之恒定
  const anchor = Math.max(1, Math.min(w - side * 2, h - side - bottom)) * (TPL_ANCHOR[tpl] || .07);
  const lw0 = Math.max(1, anchor * .08);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (let i = 0; i < 18; i++) { // 四周更热闹，但每个独立上色所以不能太挤
    const kind = KINDS[(rnd() * KINDS.length) | 0];
    const t = rnd(); // 大小分小/中/大三档，做出层次感
    const s = Math.max(3, Math.min(side * 1.25, anchor * (t < .34 ? .26 + rnd() * .2 : t < .74 ? .5 + rnd() * .26 : .84 + rnd() * .3)));
    const rot = rnd() * 6.28, zone = (rnd() * 4) | 0;
    let x, y;
    if (zone === 0) { x = side + rnd() * (w - side * 2); y = side * (.3 + rnd() * .5); }               // 顶边
    else if (zone === 1) { x = side * (.35 + rnd() * .45); y = side + rnd() * (h - side - bottom); }   // 左边
    else if (zone === 2) { x = w - side * (.35 + rnd() * .45); y = side + rnd() * (h - side - bottom); } // 右边
    else { // 底边（有主角脸时避开中间）
      y = h - bottom * (.25 + rnd() * .5);
      x = face ? (rnd() < .5 ? w * (.04 + rnd() * .3) : w * (.66 + rnd() * .3)) : side + rnd() * (w - side * 2);
    }
    ctx.strokeStyle = DOODLE_COLORS[(rnd() * DOODLE_COLORS.length) | 0];
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = lw0 * (.7 + rnd() * .85); // 笔画粗细也不同，更像手绘
    ctx.beginPath();
    drawMini(ctx, kind, x, y, s, rot);
    ctx.stroke();
  }
  face?.(ctx, w, h, side, bottom);
}
function heartPath(ctx, x, y, s, rot = 0) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(s, s);
  ctx.moveTo(0, .38);
  ctx.bezierCurveTo(-.52, .02, -.42, -.4, 0, -.12);
  ctx.bezierCurveTo(.42, -.4, .52, .02, 0, .38);
  ctx.restore();
}
function starPath(ctx, x, y, s, rot = 0) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(rot);
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? s * .45 : s;
    i ? ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr) : ctx.moveTo(Math.cos(a) * rr, Math.sin(a) * rr);
  }
  ctx.restore();
}
const MARKER = '#35302a';
// —— 流行元素简笔线描（马克笔手绘感 + 标志性配色，追求高还原） ——
function kittyFace(ctx, x, y, s) { // s ≈ 头宽；Hello Kitty：白宽脸·尖耳·竖椭圆眼·黄鼻·三须·红蝴蝶结
  ctx.save(); ctx.translate(x, y);
  const hw = s / 2, hh = s * .42, lw = Math.max(1.2, s * .035);
  ctx.lineWidth = lw; ctx.strokeStyle = MARKER; ctx.fillStyle = MARKER; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  // 耳朵（两只三角尖耳，先画在头后面）
  for (const m of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(m * hw * .3, -hh * .92);
    ctx.lineTo(m * hw * .8, -hh * 1.72);
    ctx.lineTo(m * hw * .98, -hh * .5);
    ctx.closePath();
    ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.stroke();
  }
  // 头：宽椭圆，白色填充
  ctx.beginPath(); ctx.ellipse(0, 0, hw, hh, 0, 0, 7);
  ctx.fillStyle = '#ffffff'; ctx.fill(); ctx.stroke();
  // 胡须：每侧三根，向外展开
  ctx.beginPath();
  for (const m of [-1, 1]) for (let i = -1; i <= 1; i++) {
    const y0 = i * hh * .3 + hh * .05;
    ctx.moveTo(m * hw * .68, y0);
    ctx.lineTo(m * hw * 1.22, y0 * .55 + i * hh * .12 - hh * .02);
  }
  ctx.stroke();
  // 眼睛：竖椭圆黑眼，间距宽
  ctx.beginPath();
  ctx.ellipse(-hw * .42, hh * .02, s * .042, s * .072, 0, 0, 7);
  ctx.ellipse(hw * .42, hh * .02, s * .042, s * .072, 0, 0, 7);
  ctx.fillStyle = '#1d1c1a'; ctx.fill();
  // 黄色椭圆鼻（凯蒂的标志性黄鼻子）
  ctx.beginPath(); ctx.ellipse(0, hh * .3, s * .055, s * .038, 0, 0, 7);
  ctx.fillStyle = '#f2b52c'; ctx.fill(); ctx.lineWidth = lw * .8; ctx.stroke();
  // 红色蝴蝶结：左耳上，双环+中心结
  const bx = -hw * .8, by = -hh * 1.28, bs = s * .11;
  ctx.lineWidth = lw; ctx.strokeStyle = MARKER;
  ctx.beginPath();
  ctx.ellipse(bx - bs * 1.05, by, bs * .95, bs * .62, -.5, 0, 7);
  ctx.fillStyle = '#d8352f'; ctx.fill(); ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(bx + bs * 1.05, by, bs * .95, bs * .62, .5, 0, 7);
  ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.ellipse(bx, by, bs * .42, bs * .4, 0, 0, 7);
  ctx.fillStyle = '#b8271f'; ctx.fill(); ctx.stroke();
  ctx.restore();
}
function stitchFace(ctx, x, y, s) { // s ≈ 头宽；史迪奇：蓝皮肤·大长耳·外倾杏仁眼·宽黑鼻
  ctx.save(); ctx.translate(x, y);
  const hw = s / 2, hh = s * .44, lw = Math.max(1.2, s * .035);
  ctx.lineWidth = lw; ctx.strokeStyle = MARKER; ctx.fillStyle = MARKER; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const BLUE = '#79c0ec', BLUE_IN = '#4f9fd2';
  // 大长耳：比头还高，向上外展开（先画，被头盖住根部）
  for (const m of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(m * hw * .88, -hh * .95, hw * .24, hh * 1.05, m * .42, 0, 7);
    ctx.fillStyle = BLUE; ctx.fill(); ctx.stroke();
    // 耳内
    ctx.beginPath();
    ctx.ellipse(m * hw * .88, -hh * .8, hw * .13, hh * .7, m * .42, 0, 7);
    ctx.fillStyle = BLUE_IN; ctx.fill();
  }
  // 头：宽圆，蓝色填充
  ctx.beginPath(); ctx.ellipse(0, 0, hw, hh, 0, 0, 7);
  ctx.fillStyle = BLUE; ctx.fill(); ctx.stroke();
  // 头顶小毛簇（一小撮，别抢戏）
  ctx.beginPath();
  ctx.moveTo(-hw * .06, -hh * .97); ctx.lineTo(0, -hh * 1.14); ctx.lineTo(hw * .05, -hh * .96);
  ctx.stroke();
  // 眼周深蓝底斑（史迪奇的招牌眼斑）
  ctx.beginPath();
  ctx.ellipse(-hw * .28, hh * .06, s * .135, s * .19, -.32, 0, 7);
  ctx.ellipse(hw * .28, hh * .06, s * .135, s * .19, .32, 0, 7);
  ctx.fillStyle = '#3f8ec4'; ctx.fill();
  // 大黑杏仁眼：外上倾斜、几乎在中线相碰
  ctx.beginPath();
  ctx.ellipse(-hw * .28, hh * .06, s * .1, s * .16, -.32, 0, 7);
  ctx.ellipse(hw * .28, hh * .06, s * .1, s * .16, .32, 0, 7);
  ctx.fillStyle = '#101418'; ctx.fill();
  // 眼内高光
  ctx.beginPath();
  ctx.ellipse(-hw * .25, hh * -.04, s * .026, s * .038, -.32, 0, 7);
  ctx.ellipse(hw * .31, hh * -.04, s * .026, s * .038, .32, 0, 7);
  ctx.fillStyle = '#ffffffcc'; ctx.fill();
  // 宽黑圆三角鼻
  ctx.beginPath();
  ctx.moveTo(0, hh * .64);
  ctx.quadraticCurveTo(-s * .15, hh * .34, -s * .06, hh * .25);
  ctx.quadraticCurveTo(0, hh * .19, s * .06, hh * .25);
  ctx.quadraticCurveTo(s * .15, hh * .34, 0, hh * .64);
  ctx.fillStyle = '#16222e'; ctx.fill();
  // 宽嘴：W 形微笑
  ctx.beginPath();
  ctx.moveTo(-hw * .34, hh * .62);
  ctx.quadraticCurveTo(-hw * .17, hh * .88, 0, hh * .66);
  ctx.quadraticCurveTo(hw * .17, hh * .88, hw * .34, hh * .62);
  ctx.stroke();
  ctx.restore();
}
function curTpl() { return edit.tpl || 'wide'; }
// 脸的整体高度（含耳朵）必须完全落在底边带内：s 按总高反推，y 让脸在底边带内垂直居中
function doodleKitty(ctx, w, h, side, bottom) {
  scatterDoodles(ctx, w, h, side, bottom, 20260501, (c, W, H, sd, bt) => {
    const s = Math.min(bt * .92, sd * 3);            // 耳尖 0.72s + 鼻底 0.16s ≈ 0.88s 总高
    kittyFace(c, W * .5, H - bt * .5 + s * .28, s);
  }, null, curTpl());
}
function doodleStitch(ctx, w, h, side, bottom) {
  scatterDoodles(ctx, w, h, side, bottom, 739291, (c, W, H, sd, bt) => {
    const s = Math.min(bt * .72, sd * 3);            // 长耳 0.84s + 嘴底 0.39s ≈ 1.23s 总高
    stitchFace(c, W * .5, H - bt * .5 + s * .23, s);
  }, null, curTpl());
}
function doodleConfetti(ctx, w, h, side, bottom) { scatterDoodles(ctx, w, h, side, bottom, 31315, null, null, curTpl()); }
function doodleFlowers(ctx, w, h, side, bottom) { scatterDoodles(ctx, w, h, side, bottom, 50521, null, ['flower', 'flowerStem', 'flower', 'leaf', 'butterfly', 'sun', 'cloud', 'cloudRain', 'drop', 'swirl', 'bundle', 'circle', 'heart', 'scribbleCircle'], curTpl()); }
function doodleMoon(ctx, w, h, side, bottom) { scatterDoodles(ctx, w, h, side, bottom, 77123, null, ['moon', 'sparkle', 'star', 'starBurst', 'cloud', 'cloudRain', 'rainbow', 'circle', 'snowflake', 'spiral', 'dots3', 'swirl'], curTpl()); }
function doodleHearts(ctx, w, h, side, bottom) { scatterDoodles(ctx, w, h, side, bottom, 88231, null, ['heart', 'heartArrow', 'heart', 'bow', 'sparkle', 'star', 'smile', 'circle', 'crown', 'swirl', 'loops', 'dots3'], curTpl()); }
function currentPaper() {
  if (edit.series === 'solid' && edit.paperId === 'custom') return { id: 'custom', name: '自定义', fill: edit.custom };
  return PAPERS[edit.series]?.find((p) => p.id === edit.paperId) || PAPERS.classic[0];
}
function paintPaper(ctx, w, h, paper) {
  if (paper.fill) { ctx.fillStyle = paper.fill; ctx.fillRect(0, 0, w, h); }
  if (paper.grad) { ctx.fillStyle = paper.grad(ctx, w, h); ctx.fillRect(0, 0, w, h); }
}

function openEditor(mode, sheet, file, restore) {
  edit.pending = { mode, sheet };
  edit.mode = 'front'; edit.backURL = null; edit._backInit = false;
  edit.restore = restore || null;   // 重新编辑：带回上次的裁剪/相纸/相框设置
  backCur = 0; edTextPop.hidden = true;
  for (const el of $('edMode').children) el.classList.toggle('on', el.dataset.mode === 'front');
  setMode('front');
  const url = URL.createObjectURL(file);
  edImg.onload = () => {
    URL.revokeObjectURL(url);
    edit.crop = null;
    applyRatio(edit.ratio, true);
    if (edit.restore) applyRestore(edit.restore);
    renderPreview();
  };
  edImg.src = url;
  editor.hidden = false;
}
// —— 恢复上次的编辑设置：裁剪框 / 相纸系列 / 相纸 / 相框 / 模板 / 配色 ——
function applyRestore(r) {
  const W = edImg.naturalWidth, H = edImg.naturalHeight;
  if (r.series) {
    edit.series = r.series;
    for (const el of $('edSeries').children) el.classList.toggle('on', el.dataset.s === r.series);
    buildPapers();
  }
  if (r.paperId) { edit.paperId = r.paperId; edit.lastPaper[edit.series] = r.paperId; }
  if (r.hue != null) edHue.value = r.hue;
  if (r.sat != null) edSat.value = r.sat;
  if (r.paperId === 'custom') { const [cr, cg, cb] = hsv2rgb(+edHue.value, +edSat.value / 100, 1); edit.custom = `rgb(${cr},${cg},${cb})`; }
  if (r.frame) { edit.frame = r.frame; for (const el of $('edFrames').children) el.classList.toggle('on', el.dataset.f === r.frame); }
  if (r.fw != null) { edit.fw = r.fw; $('edWidth').value = Math.round(r.fw * 100); $('edWidthVal').textContent = Math.round(r.fw * 100) + '%'; }
  if (r.tpl) { edit.tpl = r.tpl; for (const el of $('edTpl').children) el.classList.toggle('on', el.dataset.t === r.tpl); }
  if (r.crop) { // 裁剪框按比例还原（原图尺寸可能与上次不同）
    edit.crop = { x: r.crop[0] * W, y: r.crop[1] * H, w: r.crop[2] * W, h: r.crop[3] * H };
    clampCrop();
    edit.ratio = r.ratio || 0;
    for (const el of $('edRatios').children) el.classList.toggle('on', +el.dataset.r === edit.ratio);
  }
  markPapers(); markSwatch(); syncFrameUI(); updateSliderUI();
  renderCropBox();
}
// 记录当前编辑设置（存进照片，重新编辑时按它还原）
function snapshotRestore() {
  const c = edit.crop, W = edImg.naturalWidth || 1, H = edImg.naturalHeight || 1;
  return {
    series: edit.series, paperId: edit.paperId, frame: edit.frame, fw: edit.fw, tpl: edit.tpl,
    hue: +edHue.value, sat: +edSat.value, ratio: edit.ratio,
    crop: c ? [c.x / W, c.y / H, (c.x + c.w) / W, (c.y + c.h) / H] : null,
  };
}
function updateSliderUI() { // 还原配色后刷新滑杆的渐变与预览
  const [cr, cg, cb] = hsv2rgb(+edHue.value, +edSat.value / 100, 1);
  edSat.style.setProperty('--satgrad', `linear-gradient(to right, hsl(${edHue.value},0%,80%), hsl(${edHue.value},100%,55%))`);
  if (edit.paperId === 'custom') edit.custom = `rgb(${cr},${cg},${cb})`;
  renderPreview();
}

function closeEditor() { editor.hidden = true; edit.pending = null; edit.drag = null; edImg.removeAttribute('src'); }

// 图像在舞台里的显示矩形与缩放比
function dispRect() {
  const sr = edStage.getBoundingClientRect(), ir = edImg.getBoundingClientRect();
  return { x: ir.left - sr.left, y: ir.top - sr.top, w: ir.width, h: ir.height, scale: ir.width / edImg.naturalWidth };
}
function renderCropBox() {
  if (!edit.crop) return;
  const d = dispRect(), c = edit.crop, s = d.scale;
  edCrop.style.left = d.x + c.x * s + 'px';
  edCrop.style.top = d.y + c.y * s + 'px';
  edCrop.style.width = c.w * s + 'px';
  edCrop.style.height = c.h * s + 'px';
}
// 设置比例并重设一个居中的最大选框
function applyRatio(r, initial) {
  edit.ratio = r;
  const W = edImg.naturalWidth, H = edImg.naturalHeight;
  if (!edit.crop || initial) edit.crop = { x: W * .1, y: H * .1, w: W * .8, h: H * .8 };
  if (r) {
    const c = edit.crop, cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    let w = Math.min(W * .8, (H * .8) * r), h = w / r;
    if (h > H * .8) { h = H * .8; w = h * r; }
    edit.crop = { x: cx - w / 2, y: cy - h / 2, w, h };
    clampCrop();
  }
  renderCropBox(); renderPreview();
}
function clampCrop() {
  const c = edit.crop, W = edImg.naturalWidth, H = edImg.naturalHeight;
  c.w = Math.min(c.w, W); c.h = Math.min(c.h, H);
  c.x = Math.max(0, Math.min(c.x, W - c.w));
  c.y = Math.max(0, Math.min(c.y, H - c.h));
}
function moveCrop(handle, st, dx, dy) {
  const W = edImg.naturalWidth, H = edImg.naturalHeight, r = edit.ratio;
  if (handle === 'move') {
    edit.crop = { x: st.x + dx, y: st.y + dy, w: st.w, h: st.h };
    clampCrop(); return;
  }
  const E = handle.includes('e'), Wt = handle.includes('w'), N = handle.includes('n'), S = handle.includes('s');
  let nw = Math.max(MINC, st.w + (E ? dx : 0) - (Wt ? dx : 0));
  let nh = Math.max(MINC, st.h + (S ? dy : 0) - (N ? dy : 0));
  if (r) {
    // 锁比例：先定尺寸（上限=整张图），再定位——对边锚定、放不下时让位，保证能一直放大到铺满图
    const corner = (N || S) && (Wt || E);
    const driveW = corner ? Math.abs(dx) >= Math.abs(dy) : (Wt || E);
    if (driveW) { nw = Math.min(nw, W); nh = nw / r; if (nh > H) { nh = H; nw = nh * r; } }
    else { nh = Math.min(nh, H); nw = nh * r; if (nw > W) { nw = W; nh = nw / r; } }
  } else { nw = Math.min(nw, W); nh = Math.min(nh, H); }
  let l, t;
  if (Wt && !E) l = st.x + st.w - nw; else if (E && !Wt) l = st.x; else l = st.x + st.w / 2 - nw / 2;
  if (N && !S) t = st.y + st.h - nh; else if (S && !N) t = st.y; else t = st.y + st.h / 2 - nh / 2;
  l = Math.max(0, Math.min(l, W - nw)); t = Math.max(0, Math.min(t, H - nh));
  edit.crop = { x: l, y: t, w: nw, h: nh };
}
// 裁剪交互
edStage.addEventListener('pointerdown', (e) => {
  if (editor.hidden || !edit.crop) return;
  const handle = e.target?.dataset?.h;
  let mode = null;
  if (handle) mode = handle;
  else if (e.target === edCrop) mode = 'move';
  else if (e.target === edImg) {
    const d = dispRect(), sr = edStage.getBoundingClientRect();
    const nx = (e.clientX - sr.left - d.x) / d.scale, ny = (e.clientY - sr.top - d.y) / d.scale, c = edit.crop;
    if (nx >= c.x && nx <= c.x + c.w && ny >= c.y && ny <= c.y + c.h) mode = 'move';
  }
  if (!mode) return;
  e.preventDefault();
  edStage.setPointerCapture(e.pointerId);
  edit.drag = { handle: mode, sx: e.clientX, sy: e.clientY, start: { ...edit.crop } };
});
edStage.addEventListener('pointermove', (e) => {
  if (!edit.drag) return;
  const d = dispRect();
  moveCrop(edit.drag.handle, edit.drag.start, (e.clientX - edit.drag.sx) / d.scale, (e.clientY - edit.drag.sy) / d.scale);
  renderCropBox(); renderPreview();
});
const endDrag = () => { edit.drag = null; };
edStage.addEventListener('pointerup', endDrag);
edStage.addEventListener('pointercancel', endDrag);

// 相框尺寸：非涂鸦系列保留滑杆（宽度以裁剪短边的百分比计，拍立得下边 ≈ 其余边的 2.2 倍）；
// 涂鸦系列锁死为三个固定模板（窄边 / 等边 / 宽边），与涂鸦分布一一对应、所见即所得
const DOODLE_TPLS = {
  narrow: { side: .045, bottom: .08 }, // 窄边：四边 4.5%，下宽 8%
  equal:  { side: .07, bottom: .07 },  // 等边：四边 7%
  wide:   { side: .065, bottom: .14 }, // 宽边：四边 6.5%，下宽 14%
};
const TPL_SEED = { narrow: 3701, equal: 74011, wide: 148021 };   // 每个模板一份独立分布
const TPL_ANCHOR = { narrow: .042, equal: .07, wide: .06 };      // 每个模板的图形基准大小
function frameDims() {
  const b = Math.min(edit.crop.w, edit.crop.h);
  if (edit.series === 'doodle') {
    const t = DOODLE_TPLS[edit.tpl] || DOODLE_TPLS.wide;
    return { side: t.side * b, bottom: t.bottom * b };
  }
  if (edit.frame === 'none') return { side: 0, bottom: 0 };
  const bw = edit.fw * b;
  return edit.frame === 'equal' ? { side: bw, bottom: bw } : { side: bw, bottom: bw * 2.2 };
}
function composite(scaleCap) {
  const c = edit.crop, { side, bottom } = frameDims();
  const ow = c.w + side * 2, oh = c.h + side + bottom;
  const s = Math.min(1, scaleCap / Math.max(ow, oh));
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(ow * s)); cv.height = Math.max(1, Math.round(oh * s));
  const ctx = cv.getContext('2d');
  paintPaper(ctx, cv.width, cv.height, currentPaper());
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(edImg, c.x, c.y, c.w, c.h, side * s, side * s, c.w * s, c.h * s);
  currentPaper().doodle?.(ctx, cv.width, cv.height, side * s, bottom * s);
  return cv;
}
function renderPreview() {
  if (!edit.crop) return;
  const cv = composite(520);
  edPrev.width = cv.width; edPrev.height = cv.height;
  pctx.drawImage(cv, 0, 0);
}
// 编辑器控件
$('edRatios').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  for (const el of $('edRatios').children) el.classList.toggle('on', el === b);
  applyRatio(+b.dataset.r);
});
$('edFrames').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  for (const el of $('edFrames').children) el.classList.toggle('on', el === b);
  edit.frame = b.dataset.f;
  $('edWidth').disabled = edit.frame === 'none';
  renderPreview();
});
$('edWidth').addEventListener('input', (e) => {
  edit.fw = +e.target.value / 100;
  $('edWidthVal').textContent = e.target.value + '%';
  renderPreview();
});
// —— 相纸系列与相纸选择 ——
$('edSeries').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b || b.dataset.s === edit.series) return;
  for (const el of $('edSeries').children) el.classList.toggle('on', el === b);
  edit.series = b.dataset.s;
  edit.paperId = edit.lastPaper[edit.series] || PAPERS[edit.series][0].id;
  buildPapers(); syncFrameUI(); renderPreview();
});
function buildPapers() {
  const wrap = $('edPapers');
  wrap.innerHTML = '';
  wrap.classList.toggle('solidgrid', edit.series === 'solid');
  wrap.classList.toggle('doodlegrid', edit.series === 'doodle');
  for (const p of PAPERS[edit.series]) {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.id = p.id; b.title = p.name;
    if (edit.series === 'solid') { b.className = 'paper-chip solid' + (edit.paperId === p.id ? ' on' : ''); b.style.background = p.fill; }
    else {
      b.className = 'paper-chip' + (edit.paperId === p.id ? ' on' : '');
      const c = document.createElement('canvas'); c.width = 30; c.height = 38;
      const x = c.getContext('2d');
      paintPaper(x, 30, 38, p);
      x.fillStyle = '#8b857c'; x.fillRect(5, 5, 20, 18); // 示意照片位置
      p.doodle?.(x, 30, 38, 4, 9);
      b.appendChild(c);
    }
    b.onclick = () => {
      edit.paperId = p.id;
      edit.lastPaper[edit.series] = p.id;
      markPapers(); renderPreview();
    };
    wrap.appendChild(b);
  }
  $('edSliders').hidden = edit.series !== 'solid';
}
function markPapers() {
  for (const el of $('edPapers').children) el.classList.toggle('on', el.dataset.id === edit.paperId);
}
function syncFrameUI() { // 涂鸦系列：相框锁死为三个模板按钮，滑杆隐藏；其余系列照旧
  const doodle = edit.series === 'doodle';
  $('edFrames').hidden = doodle;
  $('edWidthRow').hidden = doodle;
  $('edTpl').hidden = !doodle;
}
// 涂鸦模板切换：窄边 / 等边 / 宽边（每种涂鸦相纸对每个模板都有独立固定的分布）
$('edTpl').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  for (const el of $('edTpl').children) el.classList.toggle('on', el === b);
  edit.tpl = b.dataset.t;
  renderPreview();
});
buildPapers();
syncFrameUI();
const edHue = $('edHue'), edSat = $('edSat');
function hsv2rgb(h, s, v) {
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
}
function applySliders() {
  const [r, g, b] = hsv2rgb(+edHue.value, +edSat.value / 100, 1);
  edit.custom = `rgb(${r},${g},${b})`;
  edit.paperId = 'custom'; edit.lastPaper.solid = 'custom';
  edSat.style.setProperty('--satgrad', `linear-gradient(to right, hsl(${edHue.value},0%,80%), hsl(${edHue.value},100%,55%))`);
  markPapers(); renderPreview();
}
edHue.addEventListener('input', applySliders);
edSat.addEventListener('input', applySliders);
$('edCancel').onclick = closeEditor;
// 原始素材图（未合成相框的），用于重新编辑时还原——否则会在成品上再叠一层相框
function rawOriginal() {
  const W = edImg.naturalWidth, H = edImg.naturalHeight;
  if (!W || !H) return null;
  const s = Math.min(1, 1600 / Math.max(W, H)); // 限长边 1600，兼顾清晰度与体积
  const cv = document.createElement('canvas');
  cv.width = Math.round(W * s); cv.height = Math.round(H * s);
  cv.getContext('2d').drawImage(edImg, 0, 0, cv.width, cv.height);
  return cv.toDataURL('image/jpeg', .9);
}
$('edOk').onclick = async () => {
  if (!edit.pending || !edit.crop) return;
  const out = composite(1400);
  const dataURL = out.toDataURL('image/jpeg', .88);
  const cfg = snapshotRestore();
  const raw = rawOriginal();
  // 背面：只有画过东西才生成（backCur>0 表示撤销栈里存在非初始状态）
  edit.backURL = (backCur > 0 && backInk.width) ? compositeBack() : null;
  const texts = backTexts.length ? backTexts.map((t) => ({ ...t })) : null;
  const { mode, sheet } = edit.pending;
  closeEditor();
  if (mode === 'replace') await replacePhoto(sheet, dataURL, out.width, out.height, true, edit.backURL || null, { raw, cfg, texts });
  else await addPhoto(dataURL, out.width, out.height, true, edit.backURL || null, { raw, cfg, texts });
};
addEventListener('resize', () => { if (!editor.hidden) renderCropBox(); });

// ===========================================================================
// 背面创作：单屏自由画布（缩放/平移）+ 纸面 + 墨层 + 文本对象层
//  - 画笔 5 支：铅笔 / 圆珠 / 油性记号笔（不透明）/ 喷枪 / 橡皮
//  - 文本是「对象」而非像素：可选中、拖动、等比缩放、双击改字
//  - 撤销双轨：画笔与文本分开记录，统一按时间顺序回退，上限 20 步
// ===========================================================================
const backPaper = $('edBackPaper'), backInk = $('edBackInk'), backTextCv = $('edBackText');
const bpc = backPaper.getContext('2d'), bic = backInk.getContext('2d'), btc = backTextCv.getContext('2d');
const backStage = $('edBackStage'), backWorld = $('edBackWorld');
const BACK_COLORS = ['#35302a', '#1d1c1a', '#1f4fd6', '#e60012', '#f37021', '#fdb913', '#6abf4b', '#56b9e9', '#7d5fc4', '#d062c4', '#ffffff'];
let backW = 1000, backH = 750;
let backTexts = [];        // 文本对象：{x,y,w,h,text,font,size,color,bold,italic}
let selText = -1;          // 选中的文本索引
let backUndo = [], backCur = 0;   // 撤销栈：每项 {ink:ImageData, texts:深拷贝}
let backDrawing = false, backLast = null, backPanning = false, backPanFrom = null;
let backDrag = null;       // 文本拖动/缩放：{kind:'move'|'scale', ...}
let textEditIdx = -1, textEditPop = null;
const bview = { z: 1, x: 0, y: 0 };   // 画布缩放与平移
// 手写字体按需加载：首屏不再拉这 4.5MB，只有用户真的选了该字体写文字时才下载。
// 之前在模块顶层就 document.fonts.load 三个字体，导致所有人一进页面就下载全部字体（首屏 4.6MB）。
const HAND_FONTS = { "'Ma Shan Zheng', cursive": "40px 'Ma Shan Zheng'", "'Zhi Mang Xing', cursive": "40px 'Zhi Mang Xing'", "'Caveat', cursive": "40px 'Caveat'" };
const fontCache = new Map();
function ensureFont(font) {
  const spec = HAND_FONTS[font];
  if (!spec) return Promise.resolve();            // 系统字体无需下载
  if (!fontCache.has(font)) fontCache.set(font, document.fonts.load(spec).catch(() => {}));
  return fontCache.get(font);
}

function buildSwatches() {
  const w = $('edSwatches'); w.innerHTML = '';
  for (const c of BACK_COLORS) {
    const b = document.createElement('button');
    b.style.background = c; b.dataset.c = c; b.title = c;
    b.onclick = () => { edit.color = c; markSwatch(); updateCursor(); if (selText >= 0) applyTextStyle({ color: c }); };
    w.appendChild(b);
  }
  const cu = document.createElement('button');
  cu.className = 'ed-custom'; cu.title = '自定义颜色';
  const ci = document.createElement('input'); ci.type = 'color'; ci.value = edit.color;
  ci.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer';
  ci.addEventListener('input', () => { edit.color = ci.value; markSwatch(); updateCursor(); if (selText >= 0) applyTextStyle({ color: ci.value }); });
  cu.appendChild(ci); w.appendChild(cu);
  markSwatch();
}
function markSwatch() {
  const c0 = selText >= 0 ? backTexts[selText].color : edit.color;
  [...$('edSwatches').children].forEach((el) => {
    const c = el.dataset.c;
    el.classList.toggle('on', !!c && c.toLowerCase() === c0.toLowerCase());
  });
}
function setMode(m) {
  edit.mode = m;
  const back = m === 'back';
  $('edFrontLeft').hidden = back; $('edFrontRight').hidden = back;
  $('edBackLeft').hidden = !back; $('edBackRight').hidden = !back;
  document.querySelector('.ed-panel').classList.toggle('ed-full', back); // 背面模式整屏不滚动
  if (back) { initBack(); requestAnimationFrame(fitView); maybeShowPanTip(); } else { closeTextPop(); }
}
function initBack() {
  const c = edit.crop; if (!c) return;
  backW = 1000; backH = Math.max(360, Math.round(backW * c.h / c.w));
  if (edit._backInit && backInk.width === backW && backInk.height === backH) { // 已有内容：只更新纸色
    paintPaper(bpc, backW, backH, currentPaper());
    return;
  }
  edit._backInit = true;
  for (const cv of [backPaper, backInk, backTextCv]) {
    cv.width = backW; cv.height = backH;
    cv.style.width = backW + 'px'; cv.style.height = backH + 'px'; // CSS 尺寸须与位图一致，否则命中换算会错位
  }
  paintPaper(bpc, backW, backH, currentPaper());
  bic.clearRect(0, 0, backW, backH);
  backTexts = []; selText = -1; syncTextPanel();
  backUndo = [{ ink: bic.getImageData(0, 0, backW, backH), texts: [] }]; backCur = 0;
  $('edUndo').disabled = true;
  // 重新编辑时若已有背面：铺回墨层 + 文本框对象，用户是在既有作品上继续创作
  const prev = edit.pendingBack, prevT = edit.pendingTexts;
  if (prev || prevT) {
    edit.pendingBack = null; edit.pendingTexts = null;
    if (prevT) {
      backTexts = prevT.map((t) => ({ ...t }));
      selText = -1; syncTextPanel();
      // 只加载这些文本框真正用到的字体（而不是全部三个）
      Promise.all([...new Set(backTexts.map((t) => t.font))].map(ensureFont)).then(() => {
        for (const t of backTexts) { const m = measureText(t); t.w = m.w; t.h = m.h; }
        renderTexts(); snapshot();
      });
    } else snapshot();
    if (prev) {
      const img = new Image();
      img.onload = () => {
        bic.drawImage(img, 0, 0, backW, backH);
        snapshot();
        toast('已载入你之前的背面，可继续创作');
      };
      img.src = prev;
    }
  }
}
function refreshBackPaper() {
  if (!backInk.width) return;
  paintPaper(bpc, backW, backH, currentPaper());
}
// —— 撤销：画笔像素 + 文本对象一起快照 ——
function snapshot() {
  backUndo = backUndo.slice(0, backCur + 1);
  backUndo.push({ ink: bic.getImageData(0, 0, backW, backH), texts: backTexts.map((t) => ({ ...t })) });
  if (backUndo.length > 21) backUndo.shift();
  backCur = backUndo.length - 1;
  $('edUndo').disabled = backCur <= 0;
}
function undo() {
  if (backCur <= 0) return;
  backCur--;
  const s = backUndo[backCur];
  bic.putImageData(s.ink, 0, 0);
  backTexts = s.texts.map((t) => ({ ...t }));
  if (selText >= backTexts.length) selText = backTexts.length - 1;
  syncTextPanel();
  $('edUndo').disabled = backCur <= 0;
}
// —— 坐标换算：屏幕 → 画布（含缩放平移） ——
function inkPos(e) {
  const r = backInk.getBoundingClientRect();
  if (!r.width || !r.height) return { x: 0, y: 0 };
  return { x: (e.clientX - r.left) / r.width * backW, y: (e.clientY - r.top) / r.height * backH };
}
// —— 画布视图：缩放 / 平移 ——
function applyView() {
  backWorld.style.transform = `translate(${bview.x}px, ${bview.y}px) scale(${bview.z})`;
  $('edZoomVal').textContent = Math.round(bview.z * 100) + '%';
}
function fitView() {
  const r = backStage.getBoundingClientRect();
  if (!r.width || !backW) return;
  // 铺满可用空间（cover）：纸面充满舞台，超出部分可平移查看，初始即有「放大感」
  const z = Math.max((r.width - 20) / backW, (r.height - 20) / backH);
  bview.z = Math.max(.05, Math.min(z, 8));
  bview.x = (r.width - backW * bview.z) / 2;
  bview.y = (r.height - backH * bview.z) / 2;
  applyView();
}
function zoomAt(cx, cy, factor) {
  const nz = Math.max(.08, Math.min(bview.z * factor, 8));
  const k = nz / bview.z;
  bview.x = cx - (cx - bview.x) * k; bview.y = cy - (cy - bview.y) * k;
  bview.z = nz; applyView();
}
$('edZoomIn').onclick = () => { const r = backStage.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1.25); };
$('edZoomOut').onclick = () => { const r = backStage.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, .8); };
$('edZoomFit').onclick = fitView;
// 平移引导：点「？怎么平移」展开说明；看过之后本次会话不再自动弹出
const PAN_TIP_KEY = 'papercloud.panhint.v1';
$('edPanHelp').onclick = () => { $('edPanTip').hidden = false; requestAnimationFrame(fitView); }; // 画布变矮，重新适应
$('edPanTipClose').onclick = () => {
  $('edPanTip').hidden = true;
  try { sessionStorage.setItem(PAN_TIP_KEY, '1'); } catch (e) {}
  requestAnimationFrame(fitView); // 画布区域变高了，重新适应窗口，避免纸面位置漂移
};
function maybeShowPanTip() { // 第一次进背面创作时提示一次（若本会话已读过则不再打扰）
  let seen = false;
  try { seen = !!sessionStorage.getItem(PAN_TIP_KEY); } catch (e) {}
  if (!seen) $('edPanTip').hidden = false;
}
backStage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = backStage.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.25 : 1 / 1.25);
}, { passive: false });
// —— 画笔光标：实心圆，颜色=当前画笔色，直径=笔宽（换算到屏幕像素） ——
const brushCursor = $('edBrushCursor');
let cursorXY = null;
function brushDiameter() {
  const t = edit.tool;
  if (t === 'eraser') return Math.max(5, edit.size * 1.5);
  if (t === 'marker') return edit.size * 1.6;
  if (t === 'pencil') return Math.max(1, edit.size * .32);
  if (t === 'ball') return Math.max(1, edit.size * .28);
  if (t === 'air') return Math.max(10, edit.size * 4.8);
  return edit.size; // 文字/抓手
}
function updateCursor() {
  if (!cursorXY || edit.mode !== 'back' || backPanning) { brushCursor.hidden = true; return; }
  brushCursor.hidden = false;
  const d = Math.max(3, brushDiameter() * bview.z); // 画布尺寸经缩放后的屏幕大小
  brushCursor.style.width = d + 'px';
  brushCursor.style.height = d + 'px';
  brushCursor.style.left = cursorXY.x + 'px';
  brushCursor.style.top = cursorXY.y + 'px';
  brushCursor.style.background = edit.tool === 'eraser' ? '#8a8a8a' : edit.color;
  brushCursor.style.opacity = edit.tool === 'text' ? '.45' : edit.tool === 'air' ? '.35' : '.92';
}
backStage.addEventListener('pointermove', (e) => {
  const r = backStage.getBoundingClientRect();
  cursorXY = { x: e.clientX - r.left, y: e.clientY - r.top };
  updateCursor();
});
backStage.addEventListener('pointerleave', () => { cursorXY = null; updateCursor(); });
backStage.addEventListener('pointerenter', () => updateCursor());

// —— 画笔 ——
function applyBackBrush() {
  bic.lineCap = 'round'; bic.lineJoin = 'round';
  bic.strokeStyle = edit.color; bic.fillStyle = edit.color;
  // 笔触一律不透明：半透明笔迹重叠会累积 alpha，浅色笔画叠加成"擦不掉的银灰残影"
  bic.globalAlpha = 1;
  bic.globalCompositeOperation = edit.tool === 'eraser' ? 'destination-out' : 'source-over';
  if (edit.tool === 'pencil') { bic.lineWidth = Math.max(1, edit.size * .32); }
  else if (edit.tool === 'ball') { bic.lineWidth = Math.max(1, edit.size * .28); }
  else if (edit.tool === 'marker') { bic.lineWidth = edit.size * 1.6; } // 油性笔：实色覆盖
  else if (edit.tool === 'eraser') { bic.lineWidth = Math.max(5, edit.size * 1.5); }
}
function drawSeg(a, b) { bic.beginPath(); bic.moveTo(a.x, a.y); bic.lineTo(b.x, b.y); bic.stroke(); }
function stampAir(x, y) {
  const r = Math.max(5, edit.size * 2.4);
  bic.globalCompositeOperation = 'source-over'; bic.globalAlpha = .07;
  bic.fillStyle = edit.color;
  for (let i = 0; i < 12; i++) {
    const a = Math.random() * 6.283, d = Math.sqrt(Math.random()) * r;
    bic.beginPath(); bic.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, Math.max(.5, edit.size * .16), 0, 7); bic.fill();
  }
  bic.globalAlpha = 1;
}
// —— 文本对象：绘制 + 命中测试 ——
function fontStrOf(t) { return `${t.italic ? 'italic ' : ''}${t.bold ? '700 ' : '400 '}${t.size}px ${t.font}`; }
function measureText(t) {
  btc.font = fontStrOf(t);
  const w = btc.measureText(t.text).width;
  return { w: Math.max(24, w + t.size * .3), h: t.size * 1.32 }; // 留出下伸部空间
}
// 文本的绘制中心（用于旋转：绕中心转，而不是绕左上角）
function textCX(t) { return t.x + t.w / 2; }
function textCY(t) { return t.y + t.h / 2; }
// 字体就位后重测一次，避免文本框尺寸/位置偏差（改用 ensureFont 以命中缓存，不重复下载）
function ensureFontsThenRefit(t) {
  ensureFont(t.font).then(() => {
    const m = measureText(t); t.w = m.w; t.h = m.h;
    renderTexts();
  });
}
function renderTexts() { // 重绘文本层 + 选中框（选中时绕中心旋转，带缩放与旋转手柄）
  btc.clearRect(0, 0, backW, backH);
  for (let i = 0; i < backTexts.length; i++) {
    const t = backTexts[i];
    const rot = t.rot || 0;
    if (i === selText && rot) { // 只有选中时才按旋转角绘制，逻辑与命中测试保持一致
      btc.save();
      btc.translate(textCX(t), textCY(t));
      btc.rotate(rot);
      btc.translate(-textCX(t), -textCY(t));
    }
    btc.font = fontStrOf(t);
    btc.textAlign = 'left'; btc.textBaseline = 'top';
    btc.fillStyle = t.color;
    btc.fillText(t.text, t.x, t.y);
    if (i === selText) { // 选中框 + 手柄
      btc.save();
      btc.strokeStyle = '#3b82f6'; btc.lineWidth = Math.max(1.5, 2 / bview.z);
      btc.setLineDash([6 / bview.z, 4 / bview.z]);
      btc.strokeRect(t.x, t.y, t.w, t.h);
      btc.setLineDash([]);
      // 右下角：等比缩放手柄
      const hs = 11 / bview.z;
      btc.fillStyle = '#ffffff'; // 白色描边让它在任何纸色上都看得清
      btc.fillRect(t.x + t.w - hs / 2 - 1.5 / bview.z, t.y + t.h - hs / 2 - 1.5 / bview.z, hs + 3 / bview.z, hs + 3 / bview.z);
      btc.fillStyle = '#3b82f6';
      btc.fillRect(t.x + t.w - hs / 2, t.y + t.h - hs / 2, hs, hs);
      // 顶部中间：旋转手柄（位置必须与 hitRotate 共用 rotateHandlePos，否则画在这里、判在那里）
      const rhp = rotateHandlePos(t), rx = rhp.x, ry = rhp.y;
      btc.strokeStyle = '#3b82f6'; btc.lineWidth = Math.max(1.2, 1.6 / bview.z);
      btc.beginPath(); btc.moveTo(rx, t.y); btc.lineTo(rx, ry + hs / 2); btc.stroke();
      btc.fillStyle = '#ffffff';
      btc.beginPath(); btc.arc(rx, ry, hs / 2 + 1.5 / bview.z, 0, 7); btc.fill();
      btc.fillStyle = '#3b82f6';
      btc.beginPath(); btc.arc(rx, ry, hs / 2, 0, 7); btc.fill();
      btc.restore();
      btc.restore();
    } else if (rot) btc.restore();
  }
}
// 把画布点逆旋转回「未旋转时」的局部坐标——命中测试与渲染共用，保证所见即所点
function unrotate(t, p) {
  const rot = t.rot || 0;
  if (!rot) return p;
  const cx = textCX(t), cy = textCY(t), dx = p.x - cx, dy = p.y - cy;
  const c = Math.cos(-rot), s = Math.sin(-rot);
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
}
function hitText(p) {
  for (let i = backTexts.length - 1; i >= 0; i--) { // 从上层往下找
    const t = backTexts[i];
    const q = unrotate(t, p);
    if (q.x >= t.x && q.x <= t.x + t.w && q.y >= t.y && q.y <= t.y + t.h) return i;
  }
  return -1;
}
// 旋转手柄（选中框顶部中间的圆点）。距离随框大小自适应：至少 40px，避免和右下角缩放手柄重叠
const ROT_DIST = 40;
function rotateHandlePos(t) {
  const d = Math.max(ROT_DIST, Math.min(Math.max(t.w, t.h) * .7, 90));
  return { x: t.x + t.w / 2, y: t.y - d / bview.z };
}
function hitRotate(p) {
  if (selText < 0) return false;
  const t = backTexts[selText], h = rotateHandlePos(t), q = unrotate(t, p);
  return Math.hypot(q.x - h.x, q.y - h.y) < 16 / bview.z;
}
function hitHandle(p) { // 选中框右下角手柄（等比缩放）——容差放宽，手柄更好抓
  if (selText < 0) return false;
  const t = backTexts[selText], hs = 20 / bview.z, q = unrotate(t, p);
  return Math.hypot(q.x - (t.x + t.w), q.y - (t.y + t.h)) < hs;
}
function applyTextStyle(patch) {
  if (selText < 0) return;
  Object.assign(backTexts[selText], patch);
  const t = backTexts[selText];
  const m = measureText(t); t.w = m.w; t.h = m.h;
  renderTexts();
}
function syncTextPanel() {
  const on = selText >= 0 && !!backTexts[selText];
  $('edTextPanel').hidden = !on;
  $('edSizeRow').hidden = false;
  if (!on) return;
  const t = backTexts[selText];
  $('edFont').value = t.font; $('edBold').classList.toggle('on', t.bold); $('edItalic').classList.toggle('on', t.italic);
  $('edSize').min = 12; $('edSize').max = 200; $('edSize').value = Math.round(t.size); $('edSizeVal').textContent = Math.round(t.size);
  markSwatch();
}
function restoreBrushUI() { // 未选中文字时，滑杆回到「粗细」语义
  $('edSize').min = 1; $('edSize').max = 60; $('edSize').value = edit.size; $('edSizeVal').textContent = edit.size;
}

// —— 指针交互：画笔 / 抓手 / 文本选中移动缩放 ——
backStage.addEventListener('pointerdown', (e) => {
  if (edit.mode !== 'back') return;
  e.preventDefault();
  backStage.setPointerCapture(e.pointerId);
  const p = inkPos(e);
  // 平移：右键拖拽（桌面最顺手）/ 中键 / 空格 / 抓手工具（触屏）
  if (e.button === 2 || e.button === 1 || edit.tool === 'pan' || e.getModifierState('Space')) {
    e.preventDefault();
    backPanning = true;
    backPanFrom = { cx: e.clientX, cy: e.clientY, vx: bview.x, vy: bview.y };
    backStage.classList.add('panning');
    updateCursor();
    return;
  }
  // 文本框：框内拖动 > 旋转手柄 > 缩放手柄
  // 顺序很关键：点在框内部时一律按「移动」处理，绝不被手柄抢走（小文本框离手柄很近）
  const hit = hitText(p);
  const insideBox = hit >= 0 && (() => { const t = backTexts[hit], q = unrotate(t, p); const m = 4 / bview.z; return q.x > t.x + m && q.x < t.x + t.w - m && q.y > t.y + m && q.y < t.y + t.h - m; })();
  if (!insideBox && selText >= 0 && hitRotate(p)) {
    const t = backTexts[selText];
    // 记录按下瞬间「指针相对中心」的方位角，拖动时取差值 → 跟手且不会跳
    backDrag = { kind: 'rotate', i: selText, a0: Math.atan2(p.y - textCY(t), p.x - textCX(t)), r0: t.rot || 0 };
    return;
  }
  if (!insideBox && hitHandle(p) && selText >= 0) {
    const t = backTexts[selText];
    // 基准距离取「框中心→角」的一半并夹到合理区间：太小会让同样的拖动幅度变化过缓（不跟手）
    const d0 = Math.max(30, Math.min(Math.hypot(t.w, t.h) * .5, 160));
    backDrag = { kind: 'scale', i: selText, sx: p.x, sy: p.y, d0, ssz: t.size };
    return;
  }
  if (hit >= 0) { // 点在已有文本上：选中并准备拖动
    if (selText !== hit) { selText = hit; syncTextPanel(); renderTexts(); }
    const t = backTexts[hit];
    // 记下「按下点」与「框中心」的向量（世界坐标）；拖动时让这个向量随指针平移，旋转后也不会漂
    backDrag = { kind: 'move', i: hit, vx: p.x - textCX(t), vy: p.y - textCY(t), moved: false };
    return;
  }
  if (edit.tool === 'text') { // 文字工具点空白处：新增文本框
    selText = -1; syncTextPanel(); renderTexts();
    addTextAt(p);
    return;
  }
  // 其余情况：画笔
  if (hit !== selText) { selText = -1; syncTextPanel(); restoreBrushUI(); renderTexts(); }
  backDrawing = true; backLast = p;
  applyBackBrush();
  if (edit.tool === 'air') stampAir(p.x, p.y); else drawSeg(p, p);
});
backStage.addEventListener('pointermove', (e) => {
  const p = inkPos(e);
  if (backPanning && backPanFrom) {
    bview.x = backPanFrom.vx + (e.clientX - backPanFrom.cx);
    bview.y = backPanFrom.vy + (e.clientY - backPanFrom.cy);
    applyView();
    return;
  }
  if (backDrag) {
    const t = backTexts[backDrag.i];
    if (backDrag.kind === 'move') {
      // 目标：框中心 = 当前指针 - 按下时的指针偏移向量。旋转只影响外观，不影响这个关系
      t.x = p.x - backDrag.vx - t.w / 2;
      t.y = p.y - backDrag.vy - t.h / 2;
      backDrag.moved = true;
    } else if (backDrag.kind === 'rotate') {
      const a = Math.atan2(p.y - textCY(t), p.x - textCX(t));
      let rot = backDrag.r0 + (a - backDrag.a0);
      // Shift 吸附到 15° 的整数倍，便于摆正
      if (e.shiftKey) rot = Math.round(rot / (Math.PI / 12)) * (Math.PI / 12);
      t.rot = Math.max(-Math.PI, Math.min(Math.PI, rot));
    } else { // 等比缩放：以「指针到中心的距离」变化量驱动，中心保持不动
      const d = Math.hypot(p.x - textCX(t), p.y - textCY(t));
      const ratio = Math.max(.08, Math.min(25, d / backDrag.d0));
      t.size = Math.max(10, Math.min(240, backDrag.ssz * ratio));
      // 保持中心不动：尺寸变了要让中心留在原地
      const cx = textCX(t), cy = textCY(t), m = measureText(t);
      t.w = m.w; t.h = m.h;
      t.x = cx - t.w / 2; t.y = cy - t.h / 2;
    }
    renderTexts();
    return;
  }
  if (!backDrawing) return;
  if (edit.tool === 'air') stampAir(p.x, p.y); else drawSeg(backLast, p);
  backLast = p;
});
const endBackPointer = (e) => {
  if (backPanning) {
    backPanning = false; backPanFrom = null;
    backStage.classList.remove('panning');
    updateCursor();
    return;
  }
  if (backDrag) { if (backDrag.kind === 'move' && !backDrag.moved) { /* 单击选中，不撤销 */ } else snapshot(); backDrag = null; syncTextPanel(); return; }
  if (!backDrawing) return;
  backDrawing = false; bic.globalCompositeOperation = 'source-over'; bic.globalAlpha = 1;
  snapshot();
};
backStage.addEventListener('pointerup', endBackPointer);
backStage.addEventListener('pointercancel', endBackPointer);
backStage.addEventListener('dblclick', (e) => { // 双击文字改字
  const i = hitText(inkPos(e));
  if (i >= 0) { selText = i; syncTextPanel(); renderTexts(); addTextAt(backTexts[i], true); }
});
backStage.addEventListener('contextmenu', (e) => e.preventDefault()); // 右键用于平移，不弹系统菜单
addEventListener('keydown', (e) => { // 空格临时抓手（Esc 由文件前部的全局处理器统一处理）
  if (edit.mode !== 'back') return;
  if (e.code === 'Space' && edTextPop.hidden) { backStage.style.cursor = 'grab'; e.preventDefault(); }
});
addEventListener('keyup', (e) => { if (e.code === 'Space') backStage.style.cursor = ''; });

// —— 文本输入浮层 ——
const edTextPop = $('edTextPop'), edTextInput = $('edTextInput');
function addTextAt(p, editing = false) {
  textEditIdx = editing ? selText : backTexts.length;
  const t = editing ? backTexts[selText] : { x: p.x, y: p.y, text: '', font: edit.font, size: Math.max(20, edit.size * 7), color: edit.color, bold: edit.bold, italic: edit.italic, rot: 0, w: 24, h: 24 };
  if (!editing) lastTextPos = { x: p.x, y: p.y };
  edTextInput.value = t.text;
  const r = backStage.getBoundingClientRect();
  edTextPop.hidden = false;
  // 换算成屏幕位置：用背面自己的视图 bview（此前误用了 3D 的 view，浮层会飘到别处）
  const px = p ? p.x * bview.z + bview.x : r.width / 2;
  const py = p ? p.y * bview.z + bview.y : r.height / 2;
  edTextPop.style.left = Math.max(8, Math.min(r.left + px, innerWidth - 210)) + 'px';
  edTextPop.style.top = Math.max(8, r.top + py - 46) + 'px';
  edTextInput.focus(); edTextInput.select();
}
function closeTextPop() { edTextPop.hidden = true; textEditIdx = -1; }
function commitText() {
  const val = edTextInput.value.trim();
  const idx = textEditIdx;
  closeTextPop();
  if (!val || idx < 0) { renderTexts(); return; }
  const t = backTexts[idx];
  if (t) { // 改字：保持位置与样式
    t.text = val;
  } else { // 新增
    const nt = { x: lastTextPos.x, y: lastTextPos.y, text: val, font: edit.font, size: Math.max(20, edit.size * 7), color: edit.color, bold: edit.bold, italic: edit.italic, rot: 0, w: 0, h: 0 };
    backTexts.push(nt); selText = backTexts.length - 1;
  }
  const cur = backTexts[selText];
  snapshot(); syncTextPanel();
  // 手写字体可能此刻才刚开始下载 → 等它就位后再测量与绘制，否则会用 fallback 字体量错框宽
  ensureFont(cur.font).then(() => {
    const m = measureText(cur); cur.w = m.w; cur.h = m.h;
    renderTexts();
  });
  // 提交后自动切回铅笔：文本已就位，直接继续画更顺手（不影响后续再点「文字」加新框）
  selectTool('pencil');
}
function selectTool(name) {
  edit.tool = name;
  for (const el of $('edBackTools').children) el.classList.toggle('on', el.dataset.tool === name);
  updateCursor();
}
let lastTextPos = { x: 0, y: 0 };
edTextInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') commitText(); if (e.key === 'Escape') closeTextPop(); });
$('edTextOk').onclick = commitText;

// —— 工具栏 ——
$('edBackTools').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  for (const el of $('edBackTools').children) el.classList.toggle('on', el === b);
  edit.tool = b.dataset.tool;
});
$('edSize').addEventListener('input', (e) => {
  const v = +e.target.value; $('edSizeVal').textContent = v;
  if (selText >= 0 && backTexts[selText]) { // 选中文字时滑杆＝字号
    backTexts[selText].size = v;
    const m = measureText(backTexts[selText]); backTexts[selText].w = m.w; backTexts[selText].h = m.h;
    renderTexts();
  } else { edit.size = v; updateCursor(); }
});
// 选中某个字体时顺手预热它（下次写这个字体就不用等）；系统字体无请求
$('edFont').addEventListener('change', (e) => { edit.font = e.target.value; ensureFont(edit.font); if (selText >= 0) applyTextStyle({ font: e.target.value }); });
$('edBold').onclick = () => { edit.bold = !edit.bold; $('edBold').classList.toggle('on', edit.bold); if (selText >= 0) applyTextStyle({ bold: edit.bold }); };
$('edItalic').onclick = () => { edit.italic = !edit.italic; $('edItalic').classList.toggle('on', edit.italic); if (selText >= 0) applyTextStyle({ italic: edit.italic }); };
$('edTextDel').onclick = () => {
  if (selText < 0) return;
  backTexts.splice(selText, 1); selText = -1;
  syncTextPanel(); restoreBrushUI(); renderTexts(); snapshot();
};
$('edUndo').onclick = undo;
$('edClear').onclick = () => {
  const hasInk = backTexts.length > 0 || backCur > 0;
  if (hasInk && !confirm('确定清空整个背面画布吗？\n所有笔迹和文字都会被擦掉（之后仍可用「撤销」找回）。')) return;
  bic.clearRect(0, 0, backW, backH);
  backTexts = []; selText = -1; syncTextPanel(); restoreBrushUI(); renderTexts();
  snapshot();
  toast('画布已清空，可以重新创作了');
};
$('edMode').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  for (const el of $('edMode').children) el.classList.toggle('on', el === b);
  setMode(b.dataset.mode);
});
function compositeBack() {
  const cv = document.createElement('canvas'); cv.width = backW; cv.height = backH;
  const c = cv.getContext('2d');
  paintPaper(c, backW, backH, currentPaper());
  c.drawImage(backInk, 0, 0);
  c.drawImage(backTextCv, 0, 0);
  return cv.toDataURL('image/jpeg', .9);
}
buildSwatches(); // 背面色板（放在 BACK_COLORS 初始化之后）
// 替换：保留该纸片在云里的位置；编辑器成品（fitted）会把纸片调成照片比例、全幅贴入，
// 并且不再保留“特写”纸片——成品被随机放大取景只会裁到相框边缘，看起来像照片自己位移了
async function replacePhoto(si, dataURL, width, height, fitted, backURL, extra) {
  const target = sheets[si], pi = target.photo;
  const selObj = sel >= 0 ? sheets[sel] : target;
  const p = photos[pi];
  // 保留此前保存的原始素材与编辑设置（若这次没带新的）
  const raw = extra?.raw || p.raw || dataURL;
  const cfg = extra?.cfg || p.cfg || null;
  p.src = dataURL; p.width = width; p.height = height; p.aspect = width / height; p.fitted = !!fitted; p.full = dataURL;
  p.description = '（你替换的照片）'; p.photographer = '你'; p.back = backURL || null;
  p.raw = raw; p.cfg = cfg; p.texts = extra?.texts || null;
  await loadLayerImage(dataURL, target.layer);
  gl.activeTexture(gl.TEXTURE0); gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  if (backURL) { await loadBackLayer(backURL, target.layer); gl.activeTexture(gl.TEXTURE3); gl.generateMipmap(gl.TEXTURE_2D_ARRAY); gl.activeTexture(gl.TEXTURE0); }
  if (fitted) { // 删除该照片的特写纸片（若有），选中项若正好被删则选回整图
    for (let idx = sheets.length - 1; idx >= 0; idx--) if (sheets[idx].photo === pi && sheets[idx].study) { sheets.splice(idx, 1); dyn.splice(idx, 1); }
    sel = sheets.indexOf(selObj);
    if (sel < 0) sel = Math.max(0, sheets.findIndex((sh) => sh.photo === pi));
  }
  // 该照片的所有纸片按新比例重算；特写已删，只剩整图（与未裁剪照片的特写）
  sheets.forEach((sh, idx) => {
    sh.buf = idx;
    if (sh.photo !== pi) { writeSheet(idx, sh); return; }
    const ap = photos[pi].aspect;
    if (photos[pi].fitted && !sh.study) {
      // 主纸片：按照片比例改尺寸，整图全幅，不再裁切
      let w = sh.w, h = w / ap;
      if (h < .45 || h > 1.05) { h = Math.max(.45, Math.min(1.05, h)); w = ap * h; }
      sh.w = w; sh.h = h; sh.crop = [0, 0, 1, 1];
    } else {
      // 保持确定性：用该纸片自己的种子重算取景，重复替换同一张不会让画面乱跳
      const rnd2 = mulberry32(0x51ed + pi * 7919 + (sh.study ? 104729 : 0));
      const ai = sh.w / sh.h, zoom = sh.study ? 1.45 : 1;
      const cw = Math.min(1, ai / ap) / zoom, ch = Math.min(1, ap / ai) / zoom, u = rnd2() * (1 - cw), v = rnd2() * (1 - ch);
      sh.crop = [u, v, u + cw, v + ch];
    }
    writeSheet(idx, sh);
  });
  gl.bindBuffer(gl.ARRAY_BUFFER, instances);
  gl.bufferData(gl.ARRAY_BUFFER, sheetData, gl.STATIC_DRAW); // 索引重排后整体重传
  if (sel >= 0 && sheets[sel]?.photo === pi) {
    const selNow = sel;
    $('title').textContent = photos[pi].description; $('credit').textContent = photos[pi].photographer;
    fetch(dataURL).then((r) => r.blob()).then((b) => createImageBitmap(b)).then((img) => {
      if (sel !== selNow) return;
      gl.activeTexture(gl.TEXTURE1); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      fullFor = selNow; wake();
    });
  }
  persist(); wake();
  await new Promise((r) => setTimeout(r, 30)); // 给异步写入一点时间再返回，减少极端情况下丢失
}
// 添加：把新照片作为一张新纸片自动挂进云里（编辑器成品 → 按照片比例挂、不裁切），随后飞过去查看
async function addPhoto(dataURL, width, height, fitted, backURL, extra) {
  if (photos.length >= MAX_LAYERS) { alert(`最多容纳 ${MAX_LAYERS} 张照片，请先“重置”或清理。`); return; }
  const pi = photos.length;
  photos.push({ id: 'u' + Date.now(), src: dataURL, full: dataURL, description: '你添加的照片', photographer: '你', source_page: '', width, height, aspect: width / height, fitted: !!fitted, back: backURL || null, raw: extra?.raw || dataURL, cfg: extra?.cfg || null, texts: extra?.texts || null });
  await loadLayerImage(dataURL, pi);
  gl.activeTexture(gl.TEXTURE0); gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  if (backURL) { await loadBackLayer(backURL, pi); gl.activeTexture(gl.TEXTURE3); gl.generateMipmap(gl.TEXTURE_2D_ARRAY); gl.activeTexture(gl.TEXTURE0); }
  const s = makeSheet(pi, false);
  s.backOut = false; s.flipped = false; s.renderYaw = s.yaw; // 刚加的照片先正面朝外，方便立刻查看正面
  s.buf = sheets.length; sheets.push(s); writeSheet(s.buf, s);
  dyn.push({ ox: 0, oy: 0, oz: 0, ry: 0, vx: 0, vy: 0, vz: 0, vyaw: 0, was: false });
  gl.bindBuffer(gl.ARRAY_BUFFER, instances);
  gl.bufferSubData(gl.ARRAY_BUFFER, s.buf * FLOATS_PER_SHEET * 4, sheetData.subarray(s.buf * FLOATS_PER_SHEET, (s.buf + 1) * FLOATS_PER_SHEET));
  persist();
  await new Promise((r) => setTimeout(r, 30));
  select(s.buf);
}
// —— 持久化：优先 IndexedDB（容量大），同时写一份 localStorage 兜底 ——
// 照片是 base64 大图，localStorage 通常只有 5MB 几张就满；满了若不提示，刷新后用户会以为作品丢了
const DB_NAME = 'paper-cloud', STORE = 'kv';
let dbPromise = null;
function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((res, rej) => {
    if (!self.indexedDB) return rej(new Error('no indexedDB'));
    const rq = indexedDB.open(DB_NAME, 1);
    rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains(STORE)) rq.result.createObjectStore(STORE); };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
    rq.onblocked = () => rej(new Error('idb blocked'));
  });
  return dbPromise;
}
async function storeSet(key, val) {
  let ok = false;
  try {
    const db = await openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(val, key);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
    });
    ok = true;
  } catch (e) { console.warn('IndexedDB 写入失败，改用 localStorage', e); }
  // 同步兜底一份（容量小也没关系：至少小作品能救回来）；超限不抛，避免打断保存流程
  let lsOk = false;
  try { localStorage.setItem(key, JSON.stringify(val)); lsOk = true; } catch (e) { /* 容量满，忽略 */ }
  if (!ok && !lsOk) throw new Error('所有存储均写入失败');
  return ok ? 'idb' : 'ls';
}
async function storeGet(key) {
  let fromIdb = null;
  try {
    const db = await openDB();
    fromIdb = await new Promise((res, rej) => {
      const rq = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      rq.onsuccess = () => res(rq.result ?? null); rq.onerror = () => rej(rq.error);
    });
  } catch (e) { console.warn('IndexedDB 读取失败，改读 localStorage', e); }
  if (fromIdb && (fromIdb.added?.length || Object.keys(fromIdb.replaced || {}).length)) return fromIdb;
  // IDB 没有或为空 → 读 localStorage 兜底
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const v = JSON.parse(raw);
      if (v && (v.added?.length || Object.keys(v.replaced || {}).length)) return v;
    }
  } catch (e) { console.warn('localStorage 数据损坏', e); }
  return fromIdb;
}
let saving = false;
function buildUserData() {
  const user = { replaced: {}, added: [] };
  photos.forEach((p) => {
    if (!p.src.startsWith('data:')) return;
    const rec = { src: p.src, width: p.width, height: p.height, description: p.description, photographer: p.photographer, source_page: p.source_page, fitted: p.fitted, back: p.back || null, raw: p.raw || null, cfg: p.cfg || null, texts: p.texts || null };
    if (p.id.startsWith('u')) user.added.push({ id: p.id, ...rec });
    else user.replaced[p.id] = rec;
  });
  return user;
}
function persist() {
  const user = buildUserData();
  saving = true;
  storeSet(STORE_KEY, user).then((where) => {
    saving = false;
    if (where === 'ls') toast('浏览器存储空间不足：本次作品刷新后可能无法保留，建议少放几张');
  }).catch((e) => {
    saving = false;
    console.warn('保存失败', e);
    toast('保存失败：这次的作品不会被保留，请立即截图备份');
  });
}
// 刷新/关闭时若还在异步写入，同步补写一份，避免最后一张丢失
addEventListener('pagehide', () => {
  if (!saving) return;
  try { localStorage.setItem(STORE_KEY, JSON.stringify(buildUserData())); } catch (e) { /* 容量满则忽略 */ }
});
// 轻提示（保存异常等重要信息才出现）
let toastTimer = 0;
function toast(msg, ms = 4200) {
  const el = $('toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}
// 存储状态：顶部小圆点，正常绿色、失败红色（不打扰）
function watchStorage() {
  let warned = false;
  addEventListener('storage', (e) => { // 另一个标签页清空/覆盖
    if (e.key === STORE_KEY && !warned) { warned = true; toast('另一个标签页改动了作品数据，刷新后生效'); }
  });
}
$('add').onclick = () => openPicker('add');
$('replace').onclick = () => { if (sel >= 0) openPicker('replace', sel); };
$('reset').onclick = async () => {
  if (!confirm('确定要清除你添加/替换的照片，恢复到最初的 6 张示例吗？此操作不可撤销。')) return;
  try {
    const db = await openDB();
    await new Promise((res) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).delete(STORE_KEY); tx.oncomplete = res; tx.onerror = res; });
  } catch (e) { /* 忽略：下面还有 localStorage 兜底 */ }
  localStorage.removeItem(STORE_KEY);
  location.reload();
};

function mulberry32(a) {
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------------------------------------------------------------------------
glReady = true; // 实例缓冲已就绪（flipSheet 需要直接回写）
live = true; // 一切就绪：可以跑帧了
window.__pc = { sheets, photos, flipSheet, select }; // 调试/验证出口
window.__pick = pick;
window.__pcBack = () => ({ texts: backTexts, view: bview, sel: selText, undo: backCur, hitText, hitHandle, hitRotate, inkPos, canvasW: backW, canvasH: backH, getDrag: () => backDrag, getTool: () => edit.tool, getFont: () => edit.font, ensureFont }); // 背面画布调试出口
window.__pcDraw = { rngOf, drawMini, MINI_MIX, DOODLE_COLORS }; // 供构建脚本复用同一套涂鸦绘制（保证示例背面与编辑器风格一致）
resize();
await loaded;
if (parent !== window) {
  let sent = false;
  const done = () => { if (!sent) { sent = true; parent.postMessage({ type: 'platform:ready' }, '*'); } };
  requestAnimationFrame(() => requestAnimationFrame(done));
  setTimeout(done, 200); // 作品在屏幕外时帧可能被挂起
}