// Ozz photos：照片印在棉纸上，悬成一片云，浮在破碎镜面之上；镜面把流动的光投到天花板。
// 原生 WebGL2。房间、每一张纸片（一次实例化绘制）、吊线，外加半分辨率的镜面反射 pass。
// 在原作者实现基础上本地化，并加了“运行时上传/替换/添加照片、自动适配”的能力。
const LAYER = 256;            // 每张照片的纹理尺寸；选中时会加载原图
const MAX_LAYERS = 64;        // 纹理数组预留层数（含你后续添加的照片）
const MAX_SHEETS = 256;       // 纸片实例上限
const FLOATS_PER_SHEET = 24;  // 每实例24float：0-3中心xyz+yaw｜4-7宽高相位层｜8-11裁切uv｜12-15动力学(位移xyz+偏航)｜16-19镭射强度+种子+左右窗口｜20-23上下窗口+背面比例+预留
// 背面纸片的宽高比（backW/backH）。纹理数组是正方形 LAYER×LAYER，而背面图是长方形——
// 上传时按此比例居中 contain，着色器按同一比例采样，两边对齐图案才不变形。
// ⚠️ 必须声明在 writeSheet 之前：模块顶层会立刻调用 writeSheet 建首批纸片，
// 用 let 声明在后面会触发 TDZ（Cannot access before initialization）直接白屏。
let backAspect = 1;
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
layout(location = 5) in vec4 aPaper; // 镭射强度, 种子, 照片窗口左, 照片窗口右
layout(location = 6) in vec4 aPaper2;// 照片窗口上, 照片窗口下, 背面贴图宽高比, 预留
${SWAY}
uniform mat4 uVP;
out vec2 vUV; out vec3 vN, vP; flat out vec4 vCrop; flat out vec3 vMeta; flat out vec2 vId;
flat out vec4 vPaper; flat out vec4 vPaper2;
void main() {
  vec3 c; float yaw; sway(aA, aB, c, yaw);
  c += aDyn.xyz; yaw += aDyn.w;
  vec3 r = vec3(cos(yaw), 0, -sin(yaw)), n = vec3(sin(yaw), 0, cos(yaw));
  vec2 q = aCorner * aB.xy;
  // 纸微微卷曲：沿法线方向做一个抛物面凸起，中间鼓、边缘收。
  // ⚠️ 归一化基准必须用**半高的平方**（aB.y*aB.y），早先写成了 aB.x*aB.x（半宽的平方）——
  //   对非正方形纸片（照片按比例生成，w≠h 是常态）来说基准完全错，
  //   曲率随宽度线性放大，纸片正对镜头时就表现为「整张纸扭曲/变成梯形」，
  //   用户实测「刚加的照片整个变形，翻转一下才正常」。
  //   另：卷曲幅度必须与纸片尺寸成比例，否则小纸片会被卷得看不见、大纸片纹丝不动。
  float curl = (fract((aB.z >= 1000.0 ? aB.z - 1000.0 : aB.z) * 7.31) - .5);
  curl *= min(aB.y * aB.y, .3) * .55;   // 幅度 ∝ 半高²，视觉弯曲才一致
  vP = c + r * q.x + vec3(0, q.y, 0) + n * curl * (q.x * q.x / (aB.x * aB.x) - .25);
  vN = normalize(n - r * curl * 2. * q.x / (aB.x * aB.x));
  vUV = vec2(aCorner.x + .5, .5 - aCorner.y);
  // vId = (实例序号, 是否背面朝外)；后者决定背面 UV 要不要镜像：
  // 背面朝外 → 没转过 → 不镜像；翻转到背面 → 转了 180° → 需镜像才正读。
  // backOut 借 phase 高位传递：aB.z ≥ 1000 表示背面朝外，取景相位 = aB.z - 1000
  bool backOut = aB.z >= 1000.0;
  vCrop = aCrop; vMeta = vec3(aB.w, aB.xy); vId = vec2(float(gl_InstanceID), backOut ? 1.0 : 0.0);
  vPaper = aPaper; vPaper2 = aPaper2;
  gl_Position = uVP * vec4(vP, 1);
}`, `
${NOISE}
uniform mediump sampler2DArray uPhotos; uniform mediump sampler2DArray uBacks; uniform sampler2D uFull; uniform sampler2D uBackFull; uniform int uSel, uHover; uniform bool uFullOn, uBackFullOn; uniform vec3 uEye, uFocus; uniform float uTime;
in vec2 vUV; in vec3 vN, vP; flat in vec4 vCrop; flat in vec3 vMeta; flat in vec2 vId;
flat in vec4 vPaper; flat in vec4 vPaper2;
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
  // 背面始终用整幅 vUV（不走正面的随机取景 cuv），否则背面内容会被裁掉一部分。
  // 背面贴图上传时按 backAspect 居中 contain 进方形纹理（长方形图不变形），
  // 这里用同一套映射把纹理里那一块取出来，两边比例一致图案才对得上。
  vec2 buv = vId.y > .5 ? vec2(1. - vUV.x, vUV.y) : vUV;
  // 背面贴图上传时按「等比缩放 + 居中」放进方形纹理（loadBackLayer 的 contain），
  // 所以采样必须**从纹理里把那块区域取出来**：vUV ∈[0,1] 线性映射到
  //   ar ≥ 1：x 满幅、y ∈ [(1-1/ar)/2, (1+1/ar)/2]   （上下留白）
  //   ar < 1：y 满幅、x ∈ [(1-ar)/2, (1+ar)/2]       （左右留白）
  // ⚠️ 早先写成了**反向映射**（把 UV 从方图投到长方形），
  //    UV 靠近 0/1 时算出 -0.5 / 1.5 → clamp 后采到 contain 填充的灰边，
  //    正中间才落在图像上 → 背面看起来「只有中间一行是镭射，上下空白相纸」，
  //    翻转时改走 uBackFull（无 contain）才"看起来正常" —— 实为两条路径不一致。
  float vAspect = clamp(vPaper2.z, .2, 5.);   // 背面贴图宽高比
  if (vAspect > 1.001)      buv.y = (1. - 1. / vAspect) * .5 + buv.y / vAspect;
  else if (vAspect < .999)  buv.x = (1. - vAspect) * .5 + buv.x * vAspect;
  vec3 photoB = (vId.x == float(uSel) && uBackFullOn && !front)
      // uBackFull 直接用原图（未经 contain 缩放），所以不能用 vAspect 映射
      ? texture(uBackFull, vId.y > .5 ? vec2(1. - vUV.x, vUV.y) : vUV).rgb
      : texture(uBacks, vec3(clamp(buv, 0., 1.), vMeta.x)).rgb;
  vec3 photo = front ? photoF : photoB;
  // 棉纸上的颜料：更亮更柔，边缘不均匀地晕开。
  // ⚠️ 这个「朝灰度压 85%」是为了模拟颜料渗进棉纸的质感，但**背面整张都是相纸**，
  // 压灰会把箔面的虹彩差异削到只剩 15% —— 这正是用户看到「正面有流光、背面没有」的原因。
  // 所以背面（无照片内容、整片是箔面）跳过压灰，保住干涉色。
  vec3 ink = front ? 1. - (1. - mix(vec3(dot(photo, vec3(.3, .59, .11))), photo, .85)) * .85
                   : mix(photo, 1. - (1. - photo) * .92, .35);   // 背面：只轻微提亮，不压灰
  if (vId.x == float(uSel)) ink = mix(ink, photo, front ? .7 : .45);
  vec2 d = (abs(vUV - (a + b) * .5) - (b - a) * .5) * size;
  float inked = smoothstep(.003, -.003, max(d.x, d.y) + (noise(vUV * size * 28.) - .5) * .008);
  inked *= 1. - occ; // 遮挡淡出的柔和段：墨色归于空白棉纸
  vec3 paper = vec3(.95, .935, .9) * (.97 + .03 * noise(vUV * size * 160.));
  vec3 col = paper * mix(vec3(1), ink, inked);

  // ---- 镭射相纸：随视角流动的全息箔 ----
  // 之前是把渐变烘焙进贴图，所以转动纸片颜色不变——那只是「印上去的花纹」。
  // 真实镭射膜的彩虹来自薄膜干涉：颜色取决于「视线与纸面夹角」，转动纸片就该换色。
  //
  // ⚠️ 上一版用「0.5 + 0.5×cos(相位 + 三通道偏移)」直接生成 RGB，那是**数学上的满饱和色环**，
  // 必然经过纯品红/纯黄/纯青 → 用户反馈「艳丽得假、不像真镭射」。
  // 真实镭射的三个关键特征必须还原：
  //   ① 低饱和粉彩色为主（虹彩是「闪色」不是「涂色」），只在局部泛出饱和色
  //   ② 底色是金属灰/深色，虹彩是叠加在底上的**光**，不会把底色冲淡
  //   ③ 细密磨砂颗粒（箔面微结构），近看有微弱的衍射纹
  if (vPaper.x > .5) {
    vec3 V = normalize(uEye - vP);
    float ndv = clamp(dot(n, V), .06, 1.);           // 正对=1，掠射→0
    float ang = 1. - ndv;                             // 偏离越大，干涉级次越高
    // 背面 UV 可能被水平镜像（翻到背面看时），用它算条纹才不会被拉花
    vec2 suv = front ? vUV : buv;
    // 膜厚沿纸面有微小起伏（真实箔面各点厚度不同），再叠上视角项。
    // 用较高频率的噪声：低频噪声只会让色带平滑地弯几下，反而显得是「画上去的渐变」；
    // 高频才像真实箔面那种细碎多变的干涉。
    float film = noise(suv * vec2(14., 9.5) + vPaper.y * 11.) - .5;      // ±0.5 的厚度扰动
    float film2 = noise(suv * vec2(31., 23.) - vPaper.y * 7.) - .5;      // 再叠一层更细的
    float band = dot(suv, vec2(1.15, .78)) * 6.2831 + ang * 2.2 + film * 1.9 + film2 * .7 + vPaper.y * 6.2831;

    // 干涉色：仍用三通道余弦，但相位差只取「窄带」——真实薄膜的干涉级次是不均匀的，
    // 而且要压掉满饱和。做法：先用单色相 cos 得到虹彩色相，再整体降饱和 + 提亮底。
    vec3 irid = .5 + .5 * cos(band + vec3(0., 2.094, 4.188));
    // 降饱和：向其亮度靠拢 ~58%，得到粉彩「闪色」而非涂色
    float iridLum = dot(irid, vec3(.299, .587, .114));
    irid = mix(vec3(iridLum), irid, .42);
    irid = mix(irid, irid * .82 + .18, .5);           // 略提亮，保住箔面的通透感

    // 视角越大彩越明显，但用幂次收紧，避免正对时满屏乱闪。
    // ⚠️ 另外要压住上限：纸片侧转时 ang 很容易接近 1，若不封顶，
    //    深底玄黑会被整片虹彩盖住（用户实测「背面满屏彩虹、黑镭射都不黑了」）。
    //    这里对 amt 做硬上限，并且背面（整张箔面、无照片遮挡）不给额外增益。
    float angGain = smoothstep(0., .55, ang) * .78;
    // 高光带：宽而柔的光扫（不是硬边条纹），随时间极慢漂移
    float sweep = pow(max(0., sin(suv.x * 1.25 - suv.y * .85 + uTime * .28 + vPaper.y * 6.28)), 2.2);

    // 磨砂颗粒：箔面微结构造成的细微闪点。用屏幕像素坐标（不随距离糊掉）
    float grain = (hash(floor(gl_FragCoord.xy * .5)) - .5) * .05;
    // 衍射微纹：极细的斜向纹路，近看可见。
    // ⚠️ 不要用单一频率的正弦（sin(uv*300)）——那会形成极其规整的条纹，
    //    在深底上看起来就像「生硬的印刷痕迹」（用户实测）。真箔面的干涉是细密多频的，
    //    所以用两个不可通约的频率叠加 + 噪声扰动 → 无规则的细密微光。
    float micro = sin(suv.x * 197.0 + suv.y * 131.0 + ang * 33.0)
                * sin(suv.x * 89.0 - suv.y * 173.0 - ang * 21.0);
    micro = micro * .5 + .5;
    micro = (micro - .5) * .022;

    // 正面：只作用在相纸留白（照片窗口之外），照片本身不受影响；
    // 背面：整张都是相纸，全幅显色。
    // 窗口四边分别在 vPaper.z(左) / vPaper.w(右) / vPaper2.x(上) / vPaper2.y(下)。
    float border;
    if (front) {
      float inX = step(vPaper.z, vUV.x) * step(vUV.x, 1. - vPaper.w);
      float inY = step(vPaper2.x, vUV.y) * step(vUV.y, 1. - vPaper2.y);
      border = 1. - inX * inY;
    } else border = 1.;

    // 组装：虹彩以「加光」方式叠在原底色上（保留金属底），而不是把底色替换掉。
    // 强度刻意压低 —— 真镭射是暗底上偶尔泛出的闪色，不是满屏彩虹。
    // amt 封顶 .55：保证任何角度下底色都还在（黑镭射永远是黑底，只泛出局部彩光）。
    float back = front ? 0. : 1.;
    // 底色深度调制：深底（玄黑）上泛出的彩光本来就弱，浅底（银/金）上可以更明显。
    // vPaper2.w = 该纸底色的相对亮度（0=纯黑, 1=近白）。
    float baseW = clamp(vPaper2.w, .12, 1.);
    float depthMul = .38 + baseW * .82;      // 玄黑(≈.12) → .48；银白(≈.85) → 1.08
    float amt = min(border * (angGain * .5 + sweep * angGain * .3) * depthMul, .55);
    vec3 foil = col * (1. - amt * .34) + irid * amt * .62 + sweep * irid * amt * .5;
    foil += (grain + micro) * (.4 + amt);            // 颗粒在有虹彩处更明显（光下的微结构）
    col = mix(col, foil, clamp(amt * 1.1, 0., .8));
  }

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
    // 编译失败时 link 也会失败，但 getProgramInfoLog 会把错误吞成一句含糊的
    // 「front is not defined」式误导信息（Chrome 对 GLSL 错误的文案极不可靠）。
    // 这里把**编译日志原文**打出来，附上出错行，才能真正定位问题。
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh) || '';
      const lines = src.split('\n');
      const detail = log.replace(/ERROR: \d+:(\d+)/g, (m, n) => `${m}  « ${(lines[+n - 1] || '').trim()} »`);
      console.error(`[shader ${type === gl.VERTEX_SHADER ? 'VS' : 'FS'}] 编译失败:\n${detail}`);
    }
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
// 照片与"云"
// ---------------------------------------------------------------------------
// 只读模式：导出的单文件 HTML 会把作品数据内嵌在 window.__PC_DATA__ 里，
// 此时既不读 photos.json、也不连本地存储，更不提供任何写入入口（只能浏览）。
const EMBEDDED = window.__PC_DATA__ || null;
const READONLY = !!(EMBEDDED && EMBEDDED.readonly);
if (READONLY) document.documentElement.dataset.readonly = '1';
const basePhotos = EMBEDDED ? EMBEDDED.photos : (await (await fetch('photos.json')).json()).photos;
// 应用本地存储里你自己上传/替换的照片（IndexedDB 优先，localStorage 兜底）
const STORE_KEY = 'papercloud.v1';
// ⚠️⚠️ 关键修复（v113）：这三个常量**必须声明在上面的启动读取之前**。
// 历史上它们用 `var` 声明在文件更下方（约 3350 行），而启动时（这里）就调用了 storeGet：
// `var` 只提升声明、**赋值语句尚未执行**，于是那一刻 DB_NAME / STORE 都是 undefined，
// 导致 indexedDB.open(undefined) 打开一个假数据库并抛错——启动读取**必然失败**。
// 这个 bug 长期被 storeGet 的 localStorage 兜底掩盖（所以平时看不出问题），
// 一旦去掉兜底就暴露成「刚加的照片刷新后全部消失」。
const DB_NAME = 'paper-cloud', STORE = 'kv';
let dbPromise = null;
// 把「用户数据」（buildUserData 的 {replaced, added} 格式，也是草稿快照的格式）
// 还原成完整照片数组。启动时喂当前作品，草稿分享/草稿会话喂草稿快照——同一套逻辑，
// 避免"当前作品能渲染、草稿却渲染不出来"的两处不一致。
function materializePhotos(userData) {
  const arr = basePhotos.map((p) => ({ ...p }));
  if (userData) {
    for (const p of arr) if (userData.replaced?.[p.id]) { const r = userData.replaced[p.id]; p.src = r.src; p.width = r.width; p.height = r.height; p.aspect = r.width / r.height; p.fitted = r.fitted !== false; p.back = r.back || null; p.raw = r.raw || null; p.cfg = r.cfg || null; p.texts = r.texts || null; p.paper = r.paper || null; }
    for (const a of userData.added || []) arr.push({ ...a, aspect: a.width / a.height, fitted: a.fitted !== false, back: a.back || null });
  }
  arr.forEach((p) => {
    const w = p.width || (/\/(\d+)\/(\d+)\.jpg$/.exec(p.source_url) || [])[1];
    const h = p.height || (/\/(\d+)\/(\d+)\.jpg$/.exec(p.source_url) || [])[2];
    p.aspect = (w && h) ? +w / +h : 1.5;
    p.back = p.back || null;
    p.full = p.src;
  });
  // 示例照片自带的 30 张「预置手写涂鸦背面」（assets/backs/*.jpg）一律不再加载：
  // 用户要求把背面那些模拟的画清空——背面回到空白相纸（着色器会填纸色），
  // 真实内容由用户自己在背面创作，或后续选相纸时重新生成。
  // 保留 p.back 字段本身（用户自己画过并存下来的背面不受影响，仍要显示）。
  for (const p of arr) if (p.back && /assets\/backs\//.test(p.back)) p.back = null;
  return arr;
}
const saved = READONLY ? null : await storeGet(STORE_KEY).catch((e) => { console.warn('读取已存作品失败', e); return null; });
const photos = materializePhotos(saved);
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
  // ⚠️ 槽位顺序必须与下面 attrib() 的字节偏移严格一一对应，**写错顺序不会报错、只会静默错乱**：
  //   0..3   中心 xyz + yaw            → attrib(1) @ 0
  //   4..7   宽 高 相位 层              → attrib(2) @ 16
  //   8..11  裁切 uv                    → attrib(3) @ 32
  //   12..15 交互动力学 位移xyz + 偏航   → attrib(4) @ 48（每帧由弹簧直接 bufferSubData 覆写）
  //   16..19 相纸 镭射强度/种子/窗口四边 → attrib(5) @ 64、attrib(6) @ 80
  // 历史教训：曾把相纸数据误写进 12..15，纸片动态位移读到「镭射强度1 / 种子数千」，
  // 表现为照片被甩飞 + 吊线拉成满屏斜线且静止后一直定住；种子还串到了下一张纸的 x/y。
  const p = s.paper || {};
  sheetData.set([s.x, s.y, s.z, s.renderYaw ?? s.yaw, s.w, s.h, ph, s.layer, s.crop[0], s.crop[1], s.crop[2], s.crop[3],
    0, 0, 0, 0,                                          // 12..15 动力学占位，运行时覆写
    p.holo || 0, p.seed || 0, p.winL || 0, p.winR || 0,   // 16..19 镭射强度 / 种子 / 左右窗口
    p.winT || 0, p.winB || 0, p.aspect || backAspect || 1, p.baseLum ?? 1], n * FLOATS_PER_SHEET); // 20..23 上下窗口+背面比例+底色亮度
}
// 只更新某张纸片的偏航（翻转动画用，避免整块重传）
function writeYaw(n, yaw) {
  const off = n * FLOATS_PER_SHEET;
  sheetData[off + 3] = yaw;
  gl.bindBuffer(gl.ARRAY_BUFFER, instances);
  gl.bufferSubData(gl.ARRAY_BUFFER, off * 4, sheetData.subarray(off, off + 4));
}
// 每张照片用「自己的」确定性随机源：seed 只由 photoIndex 与isStudy 决定，
// 因此某张照片新增背面/被裁剪都不会影响其它照片的取景，刷新后布局绝对稳定
//
// yRange：候选高度区间。**必须在候选搜索之内就限定**，不能选完再把 y 夹回来 ——
// 后夹会把"最空的那个位置"破坏掉（空位优化是基于候选 y 算出来的）。
// 用户新添加的照片传 [1.6, 4.0]（见 addPhoto）；示例照片沿用历史上的宽区间。
function makeSheet(photoIndex, isStudy, yRange) {
  const Y0 = yRange ? yRange[0] : 1.55, Y1 = yRange ? yRange[1] : 4.55;
  const rnd = mulberry32(0x9e37 + photoIndex * 7919 + (isStudy ? 104729 : 0));
  let best, score = -1;
  for (let k = 0; k < 30; k++) {
    const y = Y0 + rnd() * (Y1 - Y0), R = 1 + 1.6 * ((y - Y0) / (Y1 - Y0)) ** .6, a = rnd() * Math.PI * 2, r = R * Math.sqrt(rnd());
    const x = Math.cos(a) * r * 1.15, z = Math.sin(a) * r;
    let d = 9;
    for (const s of sheets) d = Math.min(d, Math.hypot(s.x - x, (s.y - y) * 1.4, s.z - z));
    if (d > score) { score = d; best = { x, y, z }; }
  }
  const ap = photos[photoIndex].aspect;
  let w, h, cw, ch, u, v;
  if (photos[photoIndex].fitted && !isStudy) {
    // 经过编辑器裁剪的照片：纸片按照片比例生成，整图全幅贴入，不再随机裁切。
    //
    // ⚠️ 尺寸区间维持原样（.55~.80 / 宽 .32~.8），**不要为了"更有随机性"而放宽**。
    //   v106 曾把高度放宽到 .40~1.00、宽度上限提到 1.05 → 随机性确实上来了，
    //   但用户实测反馈「有的照片大的吓人了」——因为云里已有 30 张示例照片，
    //   再放大镜般的新照片会直接压住整片云。已按用户要求还原。
    h = .55 + rnd() * .25;
    w = ap * h;
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
  // 相纸信息（镭射强度 + 照片窗口内缩），供着色器把全息流光只画在相纸留白上。
  // stock 照片（未过编辑器）没有相纸边框概念 → holo=0，即普通纸。
  const pp = photos[photoIndex].paper || null;
  return { ...best, yaw, renderYaw: yaw + (backOut ? Math.PI : 0), backOut, flipped: backOut, flipAnim: null, w, h, phase, photo: photoIndex, layer: photoIndex, study: isStudy, crop: [u, v, u + cw, v + ch], paper: pp };
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
window.__instances = instances;   // 自动化测试读回 GPU 真实数据用
const sheetVao = gl.createVertexArray();
gl.bindVertexArray(sheetVao);
buffer(new Float32Array(Array.from({ length: 7 }, (_, i) => [i / 6 - .5, -.5, i / 6 - .5, .5]).flat()));
attrib(0, 2, 0, 0, 0);
gl.bindBuffer(gl.ARRAY_BUFFER, instances);
for (let i = 0; i < 4; i++) attrib(i + 1, 4, FLOATS_PER_SHEET * 4, i * 16, 1);
// 相纸数据（镭射强度/种子/照片窗口）：必须一并绑定，否则着色器读到的是默认 0，
// 表现为「镭射纸完全不显色」——这类漏绑不会报错，只会静默失效。
attrib(5, 4, FLOATS_PER_SHEET * 4, 64, 1);
attrib(6, 4, FLOATS_PER_SHEET * 4, 80, 1);
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
async function loadBackLayer(src, layer, aspect) {
  // 纹理数组固定是 LAYER×LAYER 的正方形，而纸片几何按 backW:backH（长方形）。
  // 直接把长方形背面图拉伸成正方形会让箔面纹理纵向压扁、纹路变形。
  // 正确做法：按该照片自己的宽高比做「等比缩放 + 居中」放进方形纹理，
  // 采样端用同样的映射（见片元着色器 vPaper2.z），两侧比例一致、图案不变形。
  // aspect 来自照片记录自身的 paper.aspect，不用全局 backAspect ——
  // 否则编辑下一张会改变上一张已上传纹理的采样比例。
  const ar = aspect || backAspect || 1;
  let img;
  if (src) {
    const blob = await (await fetch(src)).blob();
    img = await createImageBitmap(blob);
  } else {
    const b = document.createElement('canvas'); b.width = b.height = LAYER;
    b.getContext('2d').fillStyle = '#ece6db'; b.getContext('2d').fillRect(0, 0, LAYER, LAYER);
    img = await createImageBitmap(b);
  }
  // 目标在方形纹理里的居中区域（contain：完整放进去，不裁切、不变形）
  let dw = LAYER, dh = LAYER;
  if (ar >= 1) dh = Math.round(LAYER / ar); else dw = Math.round(LAYER * ar);
  scratch.canvas.width = LAYER; scratch.canvas.height = LAYER;
  scratch.fillStyle = '#e8e2d6'; scratch.fillRect(0, 0, LAYER, LAYER);
  scratch.imageSmoothingQuality = 'high';
  scratch.drawImage(img, (LAYER - dw) / 2, (LAYER - dh) / 2, dw, dh);
  gl.activeTexture(gl.TEXTURE3);
  gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, LAYER, LAYER, 1, gl.RGBA, gl.UNSIGNED_BYTE, scratch.canvas);
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
  try { if (p.back) await loadBackLayer(p.back, i, p.paper && p.paper.aspect); } catch (err) { console.warn('缺少背面', p.back, err); }
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
      const ks = dragging ? 55 : 9, cd = dragging ? 7 : 0.62;
      const tx = dragging ? sheetDrag.tx : 0, ty = dragging ? sheetDrag.ty : 0, tz = dragging ? sheetDrag.tz : 0;
      // 弹簧回位：标准半隐式欧拉的欠阻尼弹簧。
      // 不再做任何「快到终点就强行按住」的修正 —— 旧版那段收尾微调会在最后一小段
      // 额外猛拉一把，视觉上就是"力还没释放完就被按停"，很假；现在让物理自己收尾、
      // 自然回荡、慢慢归于平静。只有真正静止（位置与速度都极小）才干净归零，
      // 避免肉眼可见的"跳到终点"。手机端与主场景共用同一条路径，故两端一起修好。
      const spring = (o, v, t) => {
        v += (-ks * (o - t) - cd * v) * dt;                 // 速度：弹性 + 惯性
        v = Math.max(-4, Math.min(4, v));                   // 仅数值保护，幅度远超出手感范围，不会限制正常摆动
        const no = o + v * dt;                               // 位置按速度推进
        if (Math.abs(t - no) < 3e-3 && Math.abs(v) < 3e-2) return [t, 0]; // 真正静止才归零
        return [no, v];
      };
      [d.ox, d.vx] = spring(d.ox, d.vx, tx);
      [d.oy, d.vy] = spring(d.oy, d.vy, ty);
      [d.oz, d.vz] = spring(d.oz, d.vz, tz);
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
// 底部提示条与说明栏会重叠，用 body 类让 CSS 知道该不该让位（集中一处，别散落各处切 class）
function syncCaption() { document.body.classList.toggle('has-caption', !caption.hidden); }
function select(i) {
  sel = i;
  idleSince = performance.now();
  if (i < 0) {
    Object.assign(goal, { ...HOME, yaw: goal.yaw });
    caption.hidden = true;
    syncCaption();
    canvas.focus({ preventScroll: true });
  } else {
    const s = sheets[i], p = photos[s.photo], t = Math.tan(FOV / 2);
    // 聚焦时统一看正面：若这张原本背面朝外，先翻回正面（符合「点照片看正面，翻转看背面」）
    if (s.flipped) flipSheet(i);
    const turn = Math.atan2(Math.sin(s.yaw - cam.yaw), Math.cos(s.yaw - cam.yaw));
    Object.assign(goal, { x: s.x, y: s.y, z: s.z, yaw: cam.yaw + turn, pitch: .04, dist: Math.max(s.h / (1.1 * t), s.w / (1.2 * t * W / H)) });
    $('title').textContent = p.description;
    $('credit').textContent = p.photographer;
    // v116：自己添加的照片不显示「你添加的照片 / 你」文字说明（没有信息量），
    // 只留符号按钮；同时显示 🗑 删除按钮（仅自己添加的照片可删，示例照片不提供）
    const isUser = p.id.startsWith('u');
    $('capText').style.display = isUser ? 'none' : '';
    $('delBtn').hidden = !isUser;
    $('flipBtn').hidden = !p.back;   // 无背面的照片不显示（触摸设备才可见）
    if (p.back) loadBackFull(i);
    const src = $('source');
    if (p.source_page) { src.href = p.source_page; src.style.display = ''; } else src.style.display = 'none';
    caption.hidden = false;
    syncCaption();
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
// 触摸长按进编辑（兜底手势）
let holdTimer = 0, holdFired = false;
// 触摸双击判定：记录上一次轻点的位置与时间
let lastTap = null;
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  moved = 0;
  if (pointers.size === 2) { spread = pinch(); sheetDrag = null; } // 双指捏合时取消拖照片
  // 按住照片：进入拖拽。t/vx/vy/vz 用来在松手瞬间把手指速度抛给照片（惯性）
  else if (ready) { const i = pick(e.clientX, e.clientY); if (i >= 0) sheetDrag = { i, tx: 0, ty: 0, tz: 0, t: performance.now(), vx: 0, vy: 0, vz: 0 }; }
  // 触摸长按 550ms 进入编辑（双击之外的另一种兜底手势；鼠标不触发）。
  // 无论该照片是否已聚焦都生效——平板上用户很可能没先点一下就直接长按
  if (e.pointerType !== 'mouse' && sheetDrag) {
    clearTimeout(holdTimer);
    const target = sheetDrag.i;
    holdTimer = setTimeout(() => { if (moved < 8) { holdFired = true; lastTap = null; reeditPhoto(target); } }, 550);
  }
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
  if (moved > 8) clearTimeout(holdTimer); // 一旦移动就不是长按了
  if (pointers.size === 1) {
    if (sheetDrag) {
      // 拉动照片：指针位移换算成世界位移目标（限幅 .95m，手感柔和）
      const wpp = 2 * cam.dist * Math.tan(FOV / 2) / innerHeight;
      let tx = sheetDrag.tx + (view.x[0] * dx - view.y[0] * dy) * wpp;
      let ty = sheetDrag.ty + (view.x[1] * dx - view.y[1] * dy) * wpp;
      let tz = sheetDrag.tz + (view.x[2] * dx - view.y[2] * dy) * wpp;
      const m = Math.hypot(tx, ty, tz);
      if (m > .95) { tx *= .95 / m; ty *= .95 / m; tz *= .95 / m; } // 可拉得更远、更松弛
      // 记录最近一次的世界速度（做指数平滑，抹掉手抖与单帧抖动）。
      // 松手时把它作为初速度交给照片 → 顺着甩出去的方向继续飞一段再荡回来。
      // 没有这一步，无论弹簧参数多软，用户都会觉得"松手就被钉住"。
      const now = performance.now();
      const dtw = Math.max(0.008, Math.min(0.1, (now - sheetDrag.t) / 1000));
      sheetDrag.t = now;
      const ivx = (tx - sheetDrag.tx) / dtw, ivy = (ty - sheetDrag.ty) / dtw, ivz = (tz - sheetDrag.tz) / dtw;
      sheetDrag.vx = sheetDrag.vx * 0.6 + ivx * 0.4;
      sheetDrag.vy = sheetDrag.vy * 0.6 + ivy * 0.4;
      sheetDrag.vz = sheetDrag.vz * 0.6 + ivz * 0.4;
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
// 松手瞬间把手指的世界速度注入照片弹簧 —— 惯性的来源。
// 只在"确实拖过"时生效；原地点击不注入（否则点一下照片会被弹走）。
// 系数 0.55：全量抛出去会太野，0.55 保留"顺着甩的方向多飘一小段"的感觉。
function flingSheet() {
  if (!sheetDrag) return;
  const d = dyn[sheetDrag.i];
  if (d) {
    d.vx += (sheetDrag.vx || 0) * 0.55;
    d.vy += (sheetDrag.vy || 0) * 0.55;
    d.vz += (sheetDrag.vz || 0) * 0.55;
  }
}
// 是否已放大聚焦（区别于总览态）。总览 HOME.dist=10.5，聚焦后 goal.dist 远小于此；
// 据此区分「远距离单击=查看」与「居中放大后再单击=翻转」，避免只看隐藏 sel 状态导致的误翻。
const zoomedIn = () => cam.dist < 8.5;
const release = (e) => {
  pointers.delete(e.pointerId);
  // 触摸抬起时可能还残留同源的 pointer 记录（部分浏览器触摸序列的 quirks），
  // 导致 pointers.size 非 0 而跳过整块判定——这里只要抬起的就是「本次交互结束」
  if (e.type === 'pointerup' && (pointers.size === 0 || e.pointerType !== 'mouse') && ready) {
    clearTimeout(holdTimer);
    if (holdFired) { holdFired = false; sheetDrag = null; lastTap = null; return; } // 长按已进编辑，跳过单击逻辑
    if (moved >= 6) { // 拖动过：不算轻点。但必须清掉 sheetDrag，否则它会一直当"还在拖"，
      flingSheet();     // 先把手势的速度交出去，再清状态
      lastTap = null; sheetDrag = null; return;   // 目标不归零 → 照片被永久钉在偏移处（用户看到"拖完就不动了"）
    }
    // —— 触摸设备的双击：dblclick 在触屏上不可靠，用「两次轻点」判定 ——
    // 阈值 900ms / 48px：真人双击间隔常在 200~600ms，但手指抬起与落下的反应慢，
    // 阈值太小会漏判。距离阈值保证不会把"点两张不同照片"误判成双击。
    if (e.pointerType !== 'mouse') {
      const now = performance.now();
      if (lastTap && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 48 && now - lastTap.t < 900) {
        const prev = lastTap;
        lastTap = null;
        // 第二次轻点落在同一张纸上 → 进编辑；否则当作两次独立轻点分别处理
        const j = pick(e.clientX, e.clientY);
        const pi = prev.i;
        if (j >= 0 && j === pi) { select(j); reeditPhoto(j); return; }
        if (j >= 0) { if (j === sel && zoomedIn()) flipSheet(j); else select(j); }
        else if (pi >= 0) { if (pi === sel && zoomedIn()) flipSheet(pi); else select(pi); }
        return;
      }
      const ii = pick(e.clientX, e.clientY);
      lastTap = ii >= 0 ? { x: e.clientX, y: e.clientY, t: now, i: ii } : null;
      // 单击立刻响应（聚焦/翻转）——双击会在第二次轻点时补上编辑，不必等
      if (ii >= 0) { if (ii === sel && zoomedIn()) flipSheet(ii); else select(ii); }
      sheetDrag = null;
      return;
    }
    if (sheetDrag) {
      // 原地点击：已放大居中的那张→翻转看背面；否则飞入聚焦（先聚焦、再单击才翻）
      const i = sheetDrag.i; sheetDrag = null; // 拉动后松手：目标归零，弹簧自然回弹
      if (i === sel && zoomedIn()) flipSheet(i); else select(i);
    } else {
      const i = pick(e.clientX, e.clientY);
      if (i >= 0) { if (i === sel && zoomedIn()) flipSheet(i); else select(i); }
    }
  } else if (e.type !== 'pointerup') lastTap = null;
};
// 重新编辑一张照片：直接打开编辑器，绝不弹文件选择框
// —— 用户的意思是「在这张照片已有的创作基础上继续改」，而不是让他去文件夹里重新找一遍
async function reeditPhoto(si) {
  if (READONLY) { toast('这是只读分享版，不能编辑照片'); return; }
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
function openPicker(mode, sheet) {
  if (READONLY) { toast('这是只读分享版，不能添加或替换照片'); return; }
  pending = { mode, sheet }; fileInput.value = ''; fileInput.click();
}
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
const edit = { ratio: 0, crop: null, frame: 'polaroid', fw: .15, series: 'solid', paperId: '#f4f1ea', custom: '#f4f1ea', lastPaper: { solid: '#f4f1ea' }, tpl: 'wide', pending: null, pendingBack: null, pendingTexts: null, restore: null, origURL: null, drag: null, mode: 'front', backURL: null, tool: 'pencil', color: '#35302a', size: 4, bold: false, italic: false, font: "'XiaXingKai', cursive", _backInit: false };
const MINC = 24;               // 最小裁剪尺寸（图像像素）
// 裁剪框到图片边缘时必须留出的余量（图像像素）：把手 13px 贴框内缘，若框紧贴图片边，
// 把手会有一半落在图片之外、看起来"跑到框外面"。留 7px 让把手始终压在图片上。
// 与 CSS 里 .ed-crop span 的偏移 0 配套（早先是 -7px，负偏移会被 stage 的 overflow:hidden 切掉）。
const CROPPAD = 7;

// ---------------------------------------------------------------------------
// 相纸系统：纯色（预选色 + 调色球）/ 涂鸦（手绘装饰）/ 镭射（全息箔）/ 自制（上传图案）
// 「经典」已下线：那 4 种纸色本质就是纯色，老作品还原时在 applyRestore 里映射到纯色
// ---------------------------------------------------------------------------
const PAPERS = {
  solid: [
    ['#e60012', '大红'], ['#f37021', '橙'], ['#fdb913', '橙黄'], ['#6abf4b', '草绿'], ['#56b9e9', '天蓝'], ['#27447b', '深蓝'],
    ['#7d5fc4', '紫'], ['#d062c4', '洋红'], ['#ea5f8f', '玫红'], ['#f4f1ea', '米白'], ['#1d1c1a', '黑'],
  ].map(([hex, name]) => ({ id: hex, name, fill: hex })),
  doodle: [
    { id: 'kitty', name: '凯蒂线描', fill: '#fbf8f1', doodle: doodleKitty },
    { id: 'stitch', name: '史迪奇线描', fill: '#f7f4ec', doodle: doodleStitch },
    { id: 'confetti', name: '糖果图形', fill: '#fbf9f4', doodle: doodleConfetti },
    { id: 'flowers', name: '小花', fill: '#fbfaf6', doodle: doodleFlowers },
    { id: 'moon', name: '月亮星星', fill: '#f7f4ec', doodle: doodleMoon },
    { id: 'hearts', name: '爱心', fill: '#fbf9f4', doodle: doodleHearts },
  ],
  // 真实镭射箔的底色是**金属灰 / 深色**（参考图里三种都是），虹彩是「叠加在金属底上的光」，
  // 而不是把底色本身染成粉彩。旧色板底色用粉彩（#f3cfd8/#d9f0d2）+ 高饱和色带 → 满屏艳丽、很假。
  // 现按参考图重做：底色全部换成中性金属调，只有玄黑保持深色；色带降到柔和粉彩。
  // 六张必须「一眼能分辨」，靠的是**底色调 + 明度**拉开距离，不是都做成灰银色。
  // 上一版六张 base 全是灰（明度挤在 0.6~0.75）、彩带也都是低饱和灰彩 →
  // 用户反馈「每张都一样、看不出区别、连黑镭射都偏白」。
  // 现按参考图思路重排：银白 / 淡金 / 玄黑 / 青蓝 / 玫粉 / 墨绿，各占一个明显不同的色相与明度档。
  // 底色仍保持「金属/深色」质感（不回到艳丽糖果色），但允许明确的色相倾向。
  laser: [
    // ① 银白：中性偏冷的高银灰（最亮的一档）
    { id: 'rainbow', name: '银虹镭射', grad: laserFoil(9101, [[0, '#cdd3de'], [.3, '#b8c0cf'], [.56, '#dae0e8'], [.8, '#a9b2c2'], [1, '#c0c7d4']], ['#cfd6ee', '#d6cfe4', '#c6dcea', '#e2d4e2', '#ccd6ec', '#d4d0e8', '#c4d4e4', '#ded6dc'], { bands: 9, bandA: .5, angle: 30, grate: .05 }) },
    // ② 香槟金：暖调金属（与银白拉开色相，最暖的一档）
    { id: 'silver', name: '香槟金镭射', grad: laserFoil(9203, [[0, '#d4c8a4'], [.32, '#c0b087'], [.58, '#dfd2b0'], [.8, '#b4a87c'], [1, '#cdc09a']], ['#ddd0a4', '#d2c49c', '#dcd8ac', '#ccbe98', '#d4caa8', '#cfc49a', '#d6d6ae', '#dcd2a4'], { bands: 8, bandA: .52, angle: 24, grate: .045 }) },
    // ③ 玄黑：真正的黑（明度最低档，虹彩在深底上最明显 —— 参考图2/3）
    { id: 'noir', name: '玄黑镭射', grad: laserFoil(9307, [[0, '#141418'], [.5, '#1c1c22'], [1, '#101014']], ['#7a80b4', '#6f92ac', '#8f82ae', '#6f92a0', '#83799f', '#8a9cb4', '#75878f', '#9486a8'], { bands: 9, bandA: .42, angle: 40, grate: .06, grainAmp: 4 }) },
    // ④ 青蓝：明确冷蓝调（与银白/香槟金的色相距离最大）
    { id: 'aurora', name: '青蓝镭射', grad: laserFoil(9409, [[0, '#6f8ca6'], [.34, '#5e7c9c'], [.66, '#74889f'], [1, '#69849f']], ['#8ab4cc', '#78a0c0', '#8c94bc', '#6eacc0', '#82a8c4', '#7494b4', '#88a6c0', '#6aa8c0'], { bands: 8, bandA: .52, angle: 18, grate: .05 }) },
    // ⑤ 玫粉：明确的暖粉调（第二暖，与香槟金在色相上分开：粉 vs 黄）
    { id: 'sakura', name: '玫粉镭射', grad: laserFoil(9511, [[0, '#b5859a'], [.5, '#a3748c'], [1, '#ad8090']], ['#cfa8b8', '#c09fb0', '#b89cbc', '#cba8b4', '#c0a2b2', '#b89eae', '#c4a8b2', '#cba4b8'], { bands: 8, bandA: .52, angle: 50, grate: .045 }) },
    // ⑥ 墨绿：深色冷绿（第三档明度，与玄黑同深但色相完全不同）
    { id: 'ocean', name: '墨绿镭射', grad: laserFoil(9613, [[0, '#66847c'], [.5, '#54746c'], [1, '#627d75']], ['#82b4a2', '#76a496', '#88a0b4', '#7cb0a0', '#84a89c', '#70a094', '#88a4ac', '#7caea0'], { bands: 8, bandA: .5, angle: 12, grate: .05 }) },
  ],
  custom: [
    { id: 'upload', name: '我的相纸' },
  ],
};
// —— 镭射相纸：真实全息箔质感（而非简单渐变仿制）——
// 三层叠加：① 对角金属底色渐变 ② 数条宽「流光」干涉色带（screen 提亮，角度/厚度伪随机）
// ③ 细衍射光栅纹（沿主方向的微细彩虹线条，overlay 混合）+ ④ 高光闪点。
// 全程用固定 seed 的确定性随机：同一张纸在色卡 / 预览 / 最终合成里纹理完全一致；
// 且位置按画布比例取值，不同分辨率下图案等比缩放，不会出现「色卡一套、成品另一套」。
function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
// 衍射光栅的微纹色：必须是**低饱和的柔和色**，不是粉彩糖果色。
// 旧版用 ['#ff9aa2','#ffd28a',...] 这套高饱和亮色，配合「浅底放大 4 倍」的强度公式，
// 叠上去就是满屏艳丽花纹（用户反馈「很假」）。真镭射的微纹只在近看时隐约可见。
const GRATING = ['#c8ccd8', '#d2ccd8', '#c8d4d0', '#d4d0c4', '#ccd0da', '#d0ccd4', '#c4d0cc'];
function laserFoil(seed, base, bandCols, o = {}) {
  const nBands = o.bands ?? 5, ang0 = (o.angle ?? 32) * Math.PI / 180, nGlint = o.glints ?? 3, grate = o.grate ?? .09;
  // 光栅纹理强度按底色亮度自适应。
  // ⚠️ 底色改成金属灰后（亮度 ~0.6~0.75），旧公式会放大 2~2.5 倍把微纹变成艳丽花纹。
  // 现在只做温和补偿：浅底略强、深底略弱，范围收窄到 0.7~1.25 倍。
  // 真正让镭射"看起来像镭射"的是着色器里的实时干涉流光，不是这里烘焙的静态花纹。
  // ⚠️ 这里曾有个一直存在的错误：`parseInt(c.slice(1), 16)` 把 '141418' 当**十六进制**解析成 1315864，
  //    于是 lum 巨大、bright 恒等于 1 —— 意味着「按底色亮度自适应」的所有分支
  //    （深底 special-case、bandMul 收敛、颗粒幅度）**从来没生效过**，玄黑一直被当浅底处理。
  //    现在改成解析 r/g/b 三个分量求平均（并换算到 0~255 的亮度）。
  const lum = base.reduce((a, [, c]) => {
    const n = parseInt(c.slice(1), 16);
    // #rrggbb → 取前两通道近似亮度（.299R + .587G + .114B）
    return a + (((n >> 16) & 255) * .299 + ((n >> 8) & 255) * .587 + (n & 255) * .114);
  }, 0) / base.length;
  const bright = Math.max(0, Math.min(1, lum / 235));  // 0=近黑底, 1=近白底
  const bandMul = o.bandMul ?? (1.15 + bright * .35);  // 深底(加法)1.15、浅底(screen)1.5 但浅底本身已很亮
  const glintMul = o.glintMul ?? (1.2 - bright * .5);
  return (ctx, w, h) => {
    const rnd = rngOf(seed);
    const g = ctx.createLinearGradient(0, 0, w * .72, h);
    for (const [t, c] of base) g.addColorStop(t, c);
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    // ① 宽流光色带：沿斜向的软边亮带。
    //    ⚠️ 混合模式必须按底色深浅选，这是「黑镭射变灰白」的根因：
    //      screen 的公式是 1-(1-a)(1-b)，**底色越暗提升越明显**——
    //      黑底(0.08) 叠一层 alpha .3 的色带直接变成 0.36（灰），黑底被整体冲淡。
    //      真实黑镭射（参考图2/3）就是「纯黑底 + 局部泛出的彩色光带」，
    //      所以深底必须用 **plus-lighter**（纯加法，只提亮不抬黑底），浅底才用 screen。
    const deepBase = bright < .3;
    ctx.globalCompositeOperation = deepBase ? 'plus-lighter' : 'screen';
    const nUse = deepBase ? Math.max(3, Math.round(nBands * .55)) : nBands;
    for (let i = 0; i < nUse; i++) {
      const col = bandCols[i % bandCols.length];
      const px = (i + .15 + rnd() * .7) / nUse * w;
      const ang = ang0 + ((i % 2) ? .6 : -.12) + (rnd() - .5) * .35;
      const th = h * (.28 + rnd() * .34);
      const dx = Math.cos(ang), dy = Math.sin(ang);
      const bg = ctx.createLinearGradient(px - dx * th, -dy * th, px + dx * th, dy * th);
      bg.addColorStop(0, 'rgba(0,0,0,0)');
      // 深底用加法，强度可以更高（加法不会抬黑底，只在色带处增加光）
      // 深底的色带要「窄而稀疏」——黑纸上只该偶尔泛出一道光，不是整片被照亮。
      // plus-lighter 是纯加法，多条宽色带累加足以把 #141418 抬到 100+（实测 117）。
      const ba = (o.bandA ?? .46) * bandMul * (deepBase ? .34 : 1);
      bg.addColorStop(.5, rgba(col, Math.min(deepBase ? .3 : .8, ba)));
      bg.addColorStop(.8, rgba(col, Math.min(.2, ba * .34)));
      bg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    }
    // ② 衍射光栅：细密的微纹。
    //    ⚠️ 早先这里是**等间距直线**（per 固定、lineWidth = 0.9×per），
    //    深底改 plus-lighter 后这些直线被加法照亮 → 屏幕上出现极其明显的规则横条，
    //    用户实测「纹理很不自然、生硬、能看到明显痕迹」。
    //    真实镭射的衍射是**细密且不规则**的，所以改成：
    //      · 间距带随机抖动（不再等距）
    //      · 线宽远小于间距（细纹，不成带）
    //      · 强度大幅压低（只是微光，不是条纹）
    ctx.globalCompositeOperation = deepBase ? 'plus-lighter' : 'soft-light';
    {
      const per = Math.max(2.2, w / 210), dx = Math.cos(ang0), dy = Math.sin(ang0);
      const nx = -dy, ny = dx, span = (w + h) * 1.2;
      ctx.lineWidth = Math.max(.6, per * .3);        // 细纹：线宽只有间距的 30%
      let k = 0, jit = per * 2;
      for (let t = -span; t < span; t += jit, k++) {
        jit = per * (1.3 + rnd() * 1.5);             // 间距随机抖动 → 不规则
        const off = t + (rnd() - .5) * per;          // 每条线再各自偏移
        // 强度压到 .1 以内：微光而非条纹（深底用加法，.1 就已经可见）
        ctx.strokeStyle = rgba(GRATING[k % GRATING.length], Math.min(.1, grate * (deepBase ? .5 : .35 + bright * .2)));
        ctx.beginPath();
        ctx.moveTo(nx * off - dx * span, ny * off - dy * span);
        ctx.lineTo(nx * off + dx * span, ny * off + dy * span);
        ctx.stroke();
      }
    }
    // ③ 高光闪点：几团柔光，模拟箔面上的镜面反光。
    //    深底同样用 plus-lighter —— screen 会把黑底提成灰（见上方①的说明）。
    ctx.globalCompositeOperation = deepBase ? 'plus-lighter' : 'screen';
    for (let i = 0; i < nGlint; i++) {
      const gx = rnd() * w, gy = rnd() * h, gr = Math.max(w, h) * (.12 + rnd() * .18);
      const gg = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
      gg.addColorStop(0, `rgba(255,255,255,${Math.min(.5, .28 * glintMul * (deepBase ? .4 : 1))})`);
      gg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gg; ctx.fillRect(0, 0, w, h);
    }
    // ④ 磨砂颗粒：参考图里最明显的质感特征 —— 金属箔面不是镜面平滑，
    //    而是有极细的磨砂颗粒（近看闪成一片细密的微光）。
    //    纯色渐变看起来就是「塑料」，加上颗粒立刻变金属。
    //
    // ⚠️ 早先这里是 `getImageData` + 逐像素循环 + `putImageData`（几十万次迭代、
    //    两次整图内存往返）。而 renderPreview 每次点击相纸/拖滑杆/换颜色都会走
    //    composite→paintPaper→laserFoil，平板上实测**按钮响应明显延迟**。
    //    改成「稀疏单像素噪点笔触」：视觉上同样是细密微光（颗粒本就是统计现象），
    //    但只需画几千个 fillRect，比逐像素快两个数量级。
    if (o.grain !== false) {
      const amp = o.grainAmp ?? (bright < .3 ? 3.2 : 6.5);
      // 密度：每 ~6px 一个点（上限 3 万）。比逐像素循环少两个数量级的手感，
      // 视觉上仍是连续的磨砂微光；早先试过 w*h/26 太稀，放大看几乎没颗粒。
      const n = Math.min(30000, Math.round(w * h / 6));
      ctx.globalCompositeOperation = 'source-over';
      for (let i = 0; i < n; i++) {
        // 确定性哈希 → 同一张纸每次纹理一致（色卡/预览/成品一致）
        const k = (i * 2654435761) >>> 0;
        const gx = (k % 65536) / 65536 * w;
        const gy = ((k >>> 16) % 65536) / 65536 * h;
        const n2 = (((k * 40503) >>> 0) % 1024) / 1024 - .5;
        const a = Math.abs(n2) * amp * 2;
        ctx.fillStyle = n2 > 0 ? `rgba(255,255,255,${a / 255})`
                               : `rgba(0,0,0,${a / 255})`;
        ctx.fillRect(gx, gy, 1, 1);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    return null;   // 关键：本函数已把整张纸画完（底色+色带+光栅+闪点）。
                    // 返回非渐变对象，paintPaper 据此跳过「再 fillRect 一次」——
                    // 否则那次重刷会用上一次的渐变把上面所有纹理盖掉（黑色镭射看不出来，
                    // 浅色系就会变成一片死板的渐变，背面尤其明显）。
  };
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
  if (edit.series === 'custom') return customPaperImg ? { id: 'upload', name: '我的相纸', image: customPaperImg } : { id: 'upload', name: '我的相纸', fill: '#e8e3d8' };
  return PAPERS[edit.series]?.find((p) => p.id === edit.paperId) || PAPERS.solid[0];
}
// 等比铺满绘制（cover）：上传的相纸图案整张铺满，不留白边
function drawImageCover(ctx, img, w, h) {
  const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
  ctx.drawImage(img, (w - img.naturalWidth * s) / 2, (h - img.naturalHeight * s) / 2, img.naturalWidth * s, img.naturalHeight * s);
}
// 相纸层渲染缓存（见 composite 内的说明）：laserFoil 要画色带 + 光栅 + 上千个颗粒点，
// 实测单张镭射约 30ms（桌面）/ 60~90ms（平板），而用户点色卡就触发一次 → 明显延迟。
// 解决：① 单张缓存（同 key 直接贴图）② **预热**：进编辑器时把镭射六张全部先画好，
// 之后点色卡必然命中缓存，点击耗时降到纯 drawImage 的几毫秒。
let paperLayerCache = null;
const paperLayerWarm = new Map();   // key → canvas（预热池）
function paperLayerKey(w, h, side, bottom) {
  // ⚠️ custom 只在「纯色+调色球」时才有意义，早先把它无条件拼进 key，
  // 导致预热写的是 `custom=''`、实际命中时是 `custom='#f4f1ea'` → key 永远对不上、缓存从不命中
  // （实测预热池里 6 张齐活，点色卡仍是 28ms）。现在只对纯色系列带上 custom。
  // side/bottom 是浮点运算结果，字符串化可能出现 '44.800000000000004' 这类长尾，
  // 导致预热与实际取到的 key 不一致。统一保留 3 位小数。
  return `${edit.series}|${edit.paperId}|${edit.series === 'solid' ? edit.custom : ''}|${w}x${h}|${edit.frame}|${side.toFixed(3)}|${bottom.toFixed(3)}`;
}
function paintPaper(ctx, w, h, paper) {
  if (paper.image) { if (paper.image.complete && paper.image.naturalWidth) drawImageCover(ctx, paper.image, w, h); return; }
  if (paper.fill) { ctx.fillStyle = paper.fill; ctx.fillRect(0, 0, w, h); }
  if (paper.grad) {
    const g = paper.grad(ctx, w, h);
    // 返回 null = 该函数已自行绘制完整纸面（如 laserFoil 叠了多层纹理），不要再重刷。
    // 否则 ctx.fillStyle = null 会被浏览器忽略、保留上一个渐变，再 fillRect 就把纹理全盖了。
    if (g) { ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); }
  }
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
const LEGACY_CLASSIC = { warm: '#f4f1ea', pure: '#fdfcf8', cream: '#f5eeda', kraft: '#c9a878' }; // 已下线的「经典」系列纸色
function applyRestore(r) {
  const W = edImg.naturalWidth, H = edImg.naturalHeight;
  if (r.series) {
    edit.series = r.series === 'classic' ? 'solid' : r.series;   // 「经典」并入纯色
    for (const el of $('edSeries').children) el.classList.toggle('on', el.dataset.s === edit.series);
    buildPapers();
  }
  if (r.paperId) {
    edit.paperId = r.paperId;
    if (LEGACY_CLASSIC[r.paperId]) { edit.paperId = 'custom'; edit.custom = LEGACY_CLASSIC[r.paperId]; } // 老作品的经典纸色 → 自定义色
    edit.lastPaper[edit.series] = edit.paperId;
  }
  if (edit.paperId === 'custom') {
    if (r.customHex) edit.custom = r.customHex;                              // 新版：直接存 hex
    else if (r.hue != null) { const [cr, cg, cb] = hsv2rgb(r.hue, (r.sat ?? 30) / 100, 1); edit.custom = `rgb(${cr},${cg},${cb})`; } // 旧版：由色相/饱和度反推
  }
  if (r.frame) { edit.frame = r.frame; for (const el of $('edFrames').children) el.classList.toggle('on', el.dataset.f === r.frame); }
  if (r.fw != null) {
    // 语义迁移：v44 之前 fw = 三边宽（下边 = fw * 2.2）；现在 fw = 下边宽。
    // 旧存档按 2.2 倍折算成下边，才能保持老照片重新编辑后外观不变。
    const bw = r.fwV2 ? r.fw : (edit.frame === 'polaroid' ? Math.min(BOTTOM_MAX, r.fw * 2.2) : r.fw);
    edit.fw = Math.max(BOTTOM_MIN, Math.min(BOTTOM_MAX, bw));
    $('edWidth').value = Math.round(edit.fw * 100); $('edWidthVal').textContent = Math.round(edit.fw * 100) + '%';
  }
  if (r.tpl) { edit.tpl = r.tpl; for (const el of $('edTpl').children) el.classList.toggle('on', el.dataset.t === r.tpl); }
  // 旧存档迁移：v44 曾把「识别出的照片窗口」存进 cfg.win。
// 现在改为图层套叠、不再识别，把旧窗口折算成照片的缩放（窗口越小=照片要放大）。
function paperWinRestore(w) {
  if (!w || !w.w) return;
  paperFit = Math.max(.2, Math.min(3, 1 / Math.max(.2, w.w)));
  paperOffX = paperOffY = 0;
}
if (r.win) paperWinRestore(r.win);   // 旧存档里的识别窗口：迁移为照片缩放/位移
  if (r.paperFit) { paperFit = +r.paperFit; paperOffX = +(r.paperOffX || 0); paperOffY = +(r.paperOffY || 0); }
  if (r.crop) { // 裁剪框按比例还原（原图尺寸可能与上次不同）
    edit.crop = { x: r.crop[0] * W, y: r.crop[1] * H, w: r.crop[2] * W, h: r.crop[3] * H };
    clampCrop();
    edit.ratio = r.ratio || 0;
    for (const el of $('edRatios').children) el.classList.toggle('on', +el.dataset.r === edit.ratio);
  }
  markPapers(); markSwatch(); syncFrameUI(); syncPaperUI();
  renderCropBox();
}
// 记录当前编辑设置（存进照片，重新编辑时按它还原）
function snapshotRestore() {
  const c = edit.crop, W = edImg.naturalWidth || 1, H = edImg.naturalHeight || 1;
  return {
    series: edit.series, paperId: edit.paperId, frame: edit.frame, fw: edit.fw, fwV2: 1, tpl: edit.tpl, holo: edit.holo || 0, win: edit.win || null,
    paperFit, paperOffX, paperOffY,   // 自制相纸：照片在镂空内的缩放/位移（v45 起生效）
    customHex: edit.paperId === 'custom' ? edit.custom : null, ratio: edit.ratio,
    crop: c ? [c.x / W, c.y / H, (c.x + c.w) / W, (c.y + c.h) / H] : null,
  };
}
// 任意 CSS 颜色 → #rrggbb（调色球 input[type=color] 只认 hex）
function colorToHex(c) {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  const x = document.createElement('canvas'); x.width = x.height = 1;
  const g = x.getContext('2d'); g.fillStyle = c; g.fillRect(0, 0, 1, 1);
  const d = g.getImageData(0, 0, 1, 1).data;
  return '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
}
function syncPaperUI() { // 还原/换纸后：同步调色球的当前色与选中态，并刷新预览
  const ball = document.querySelector('#edPapers .ed-picker input[type=color]');
  if (ball) ball.value = colorToHex(edit.custom);
  markPapers(); renderPreview();
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
  // 贴边时留 CROPPAD 余量，让 13px 的把手有一半压在图片内（见 CROPPAD 注释）。
  // ⚠️ px/py **不能**跟着框宽缩小（如 Math.min(CROPPAD, c.w/3)）：框被压到 8px 时
  //   余量退化成 2.7px，装不下 13px 把手 → 右列把手又跑出舞台（实测 R12.3 < 536）。
  //   正确做法：余量恒为 CROPPAD，同时把框宽一起夹到「2×CROPPAD」以内，
  //   这样任何时候框都至少比余量宽，边距不会被吃掉。
  const px = Math.min(CROPPAD, W / 3), py = Math.min(CROPPAD, H / 3);
  c.w = Math.min(c.w, W - px * 2); c.h = Math.min(c.h, H - py * 2);
  c.x = Math.max(px, Math.min(c.x, W - px - c.w));
  c.y = Math.max(py, Math.min(c.y, H - py - c.h));
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
  // ⚠️ 这里必须与 clampCrop 用同一套边距（CROPPAD），否则框能贴到 0 边距、
  // 把手就会有一半落在图片之外。早先这里写的是 `Math.max(0, ...)`，
  // 而 clampCrop 又有一套自己的钳制，两者不一致 → 缩放时框会"跳"到图片最边上。
  edit.crop = { x: l, y: t, w: nw, h: nh };
  clampCrop();
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

// 相框尺寸：三边（上/左/右）固定不变，只有下边随滑杆延长（拍立得风格）。
// 用户明确要求「只能下面延长，其余三边固定边距保持不变」，所以 side 不再跟滑杆走。
// 滑杆上限从 15% 提到 30%，让下边能留出写字/放日期的空间。
// 涂鸦系列则锁死为三个固定模板（窄边 / 等边 / 宽边），与涂鸦分布一一对应、所见即所得
const SIDE_FIXED = .07;         // 三边固定边距（裁剪短边的 7%）
const BOTTOM_MIN = .03, BOTTOM_MAX = .30;
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
  const side = SIDE_FIXED * b;                       // 三边恒定
  if (edit.frame === 'equal') return { side, bottom: side }; // 等边：下边跟随三边，不可单独调
  return { side, bottom: Math.max(BOTTOM_MIN, Math.min(BOTTOM_MAX, edit.fw)) * b };
}
function composite(scaleCap) {
  const c = edit.crop;
  // 自制相纸 = 图层套叠：照片铺满最底层当作"内容"，相纸底图叠在**上层**。
  // 用户上传的是「已经扣好镂空的相纸底图」（PNG 的透明区域就是照片窗口），
  // 所以完全不需要识别窗口——镂空形状由用户在设计软件里自己扣好，套上去就对了。
  // 这也是用户明确要求的做法：识别窗口总是差几像素，而图层套叠 100% 准确。
  if (edit.series === 'custom' && customPaperImg) {
    const iw = customPaperImg.naturalWidth, ih = customPaperImg.naturalHeight;
    const s = Math.min(1, scaleCap / Math.max(iw, ih));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(iw * s)); cv.height = Math.max(1, Math.round(ih * s));
    const ctx = cv.getContext('2d');
    // ① 底层：照片按 cover 铺满整张（照片比例与相纸不一致时裁掉多余部分）
    ctx.save();
    ctx.imageSmoothingQuality = 'high';
    const sc = Math.max(cv.width / c.w, cv.height / c.h) / paperFit;
    const sw = cv.width / sc, sh = cv.height / sc;
    ctx.drawImage(edImg,
      c.x + c.w / 2 - sw / 2 + paperOffX * cv.width, c.y + c.h / 2 - sh / 2 + paperOffY * cv.height,
      sw, sh, 0, 0, cv.width, cv.height);
    ctx.restore();
    // ② 上层：相纸底图原样叠上。它的透明镂空处自然露出底层照片，不透明处就是相纸花纹。
    ctx.drawImage(customPaperImg, 0, 0, cv.width, cv.height);
    // 流光着色器用的窗口：铺满整张（相纸是整张底图，留白由镂空本身定义）
    cv.windowInsets = { l: 0, r: 0, t: 0, b: 0 };
    return cv;
  }
  const { side, bottom } = frameDims();
  const ow = c.w + side * 2, oh = c.h + side + bottom;
  const s = Math.min(1, scaleCap / Math.max(ow, oh));
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(ow * s)); cv.height = Math.max(1, Math.round(oh * s));
  const ctx = cv.getContext('2d');
  // 相纸层缓存：laserFoil 要画色带 + 光栅 + 上千个颗粒点，是 composite 里最贵的一步。
  // 而用户拖相框滑杆、改裁剪时尺寸常常不变 → 同一张相纸被反复重画。
  // 这里按「相纸 id + 成品尺寸」缓存，命中时直接贴图，省掉整层重绘。
  // 实测平板上这一步是「按钮响应慢」的主因。
  const paper = currentPaper();
  const key = paperLayerKey(cv.width, cv.height, side, bottom);
  let layer = paperLayerWarm.get(key);
  if (!layer) {
    layer = { key, cv: document.createElement('canvas') };
    layer.cv.width = cv.width; layer.cv.height = cv.height;
    paintPaper(layer.cv.getContext('2d'), cv.width, cv.height, paper);
    paperLayerWarm.set(key, layer);
    // 池子只留最近 12 张，防止长时间编辑后无限增长
    if (paperLayerWarm.size > 12) paperLayerWarm.delete(paperLayerWarm.keys().next().value);
  }
  paperLayerCache = layer;
  ctx.drawImage(layer.cv, 0, 0);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(edImg, c.x, c.y, c.w, c.h, side * s, side * s, c.w * s, c.h * s);
  paper.doodle?.(ctx, cv.width, cv.height, side * s, bottom * s);
  // 照片窗口在整张相纸里的归一化内缩（左/右/上/下），镭射着色器据此避开照片区
  cv.windowInsets = { l: side / ow, r: side / ow, t: side / oh, b: bottom / oh };
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
  $('edWidth').disabled = edit.frame !== 'polaroid'; // 只有「拍立得」模式下边可调
  syncFrameUI();                                    // 等边/无相框时收起滑杆
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
  buildPapers(); syncFrameUI(); renderPreview(); refreshBackPaper(); syncPaperFitUI();
});
function buildPapers() {
  const wrap = $('edPapers');
  wrap.innerHTML = '';
  wrap.classList.toggle('solidgrid', edit.series === 'solid');
  wrap.classList.toggle('doodlegrid', edit.series === 'doodle');
  wrap.classList.toggle('diygrid', edit.series === 'custom');
  for (const p of PAPERS[edit.series]) {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.id = p.id;
    if (p.id === 'upload') {
      // DIY：色卡区只展示「已保存的相纸模板」，让用户一眼看出这是自己存过的；
      // 导入入口是下面那块显眼的「＋ 导入相纸」大按钮（用户反馈"看不到加号按钮、
      // 也看不出这是保存的模板"，所以两者必须分开且都带文字说明）。
      b.className = 'paper-chip upload' + (edit.paperId === 'upload' && customPaperImg ? ' on' : '');
      b.title = customPaperImg ? '我的相纸模板（已保存）· 点击选用' : '还没有导入相纸，点下面的「导入相纸」';
      if (customPaperImg) {
        const c = document.createElement('canvas'); c.width = 30; c.height = 38;
        // 缩略图要能看出是"镂空底图"：先垫一层灰底代表照片，再叠相纸，镂空处自然透出灰
        const x = c.getContext('2d');
        x.fillStyle = '#9a958c'; x.fillRect(0, 0, 30, 38);
        drawImageCover(x, customPaperImg, 30, 38);
        b.appendChild(c);
      } else {
        b.textContent = '＋';
        b.className = 'paper-chip upload empty';
      }
      b.onclick = () => {
        if (!customPaperImg) { $('edDiyImport').click(); return; }
        edit.paperId = 'upload'; edit.lastPaper.custom = 'upload'; markPapers(); renderPreview(); refreshBackPaper(); syncPaperFitUI();
      };
    } else if (edit.series === 'solid') {
      b.className = 'paper-chip solid' + (edit.paperId === p.id ? ' on' : ''); b.style.background = p.fill; b.title = p.name;
      b.onclick = () => { edit.paperId = p.id; edit.lastPaper.solid = p.id; markPapers(); renderPreview(); };
    } else {
      b.className = 'paper-chip' + (edit.paperId === p.id ? ' on' : ''); b.title = p.name;
      const c = document.createElement('canvas'); c.width = 30; c.height = 38;
      const x = c.getContext('2d');
      paintPaper(x, 30, 38, p);
      x.fillStyle = '#8b857c'; x.fillRect(5, 5, 20, 18); // 示意照片位置
      p.doodle?.(x, 30, 38, 4, 9);
      b.appendChild(c);
      b.onclick = () => { edit.paperId = p.id; edit.lastPaper[edit.series] = p.id; markPapers(); renderPreview(); refreshBackPaper(); };
    }
    wrap.appendChild(b);
  }
  if (edit.series === 'solid') wrap.appendChild(buildPickerBall()); // 第二行末尾的调色球
  if (edit.series === 'laser') prewarmLaserLayers();
}
// 预热镭射相纸层：laserFoil 单张约 30ms（平板 60~90ms），点色卡才画的话每次都有延迟。
// 这里在切到镭射系列后，用空闲时间把六张全部画好（每张之间让出一帧，避免卡住 UI）。
let prewarmTimer = 0;
function prewarmLaserLayers() {
  clearTimeout(prewarmTimer);
  const c = edit.crop;
  if (!c) return;
  const { side, bottom } = frameDims();
  const ow = c.w + side * 2, oh = c.h + side + bottom;
  const s = Math.min(1, 520 / Math.max(ow, oh));   // 与 renderPreview 的 scaleCap 保持一致
  const w = Math.max(1, Math.round(ow * s)), h = Math.max(1, Math.round(oh * s));
  const keep = edit.paperId;
  let i = 0;
  const list = PAPERS.laser;
  const step = () => {
    if (i >= list.length || edit.series !== 'laser') return;
    const p = list[i++];
    const prevId = edit.paperId;
    edit.paperId = p.id;                       // 让 key 由 paperLayerKey 统一生成，避免两处算法漂移
    const key = paperLayerKey(w, h, side, bottom);
    edit.paperId = prevId;
    if (!paperLayerWarm.has(key)) {
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      paintPaper(cv.getContext('2d'), w, h, p);
      paperLayerWarm.set(key, { key, cv });
    }
    prewarmTimer = setTimeout(step, 16);   // 让出一帧，UI 不卡
  };
  prewarmTimer = setTimeout(step, 16);
}
// 调色球：与背面画笔颜色那里的自定义球一致（conic 彩虹 + 隐藏的原生取色器）
function buildPickerBall() {
  const cu = document.createElement('button');
  cu.className = 'paper-chip solid ed-picker'; cu.dataset.id = 'custom'; cu.title = '自定义颜色';
  const ci = document.createElement('input'); ci.type = 'color'; ci.value = colorToHex(edit.custom);
  ci.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer';
  ci.addEventListener('input', () => { edit.custom = ci.value; edit.paperId = 'custom'; edit.lastPaper.solid = 'custom'; markPapers(); renderPreview(); refreshBackPaper(); });
  cu.appendChild(ci);
  return cu;
}
function markPapers() {
  for (const el of $('edPapers').children) el.classList.toggle('on', el.dataset.id === edit.paperId);
}
function syncFrameUI() {
  // 涂鸦：相框锁死为三个模板按钮，滑杆隐藏
  // 自制：一切按用户上传的参考图来，相框/宽度控件全部隐藏
  // 等边：四边等宽，下边不可单独调 → 隐藏下边滑杆
  const doodle = edit.series === 'doodle', custom = edit.series === 'custom';
  $('edFrames').hidden = doodle || custom;
  $('edWidthRow').hidden = doodle || custom || edit.frame === 'equal' || edit.frame === 'none';
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
function hsv2rgb(h, s, v) {
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [Math.round(f(5) * 255), Math.round(f(3) * 255), Math.round(f(1) * 255)];
}
// —— 自制相纸（图层套叠）——
// 用户上传「已扣好镂空的相纸底图」，照片铺在底层、相纸叠在上层：镂空处自然露出照片。
// 因此**不再需要识别窗口**（旧实现的自动识别总有几十像素误差，用户实测"还是识别不太准"）。
// 仍保留两项微调：① 照片在镂空里的缩放与位移（应对镂空比照片大/小）② 换图。
let paperFit = 1, paperOffX = 0, paperOffY = 0;   // 照片在窗口内的缩放与位移（归一化）
const PAPER_TEX_KEY = 'ozz_paper_tex';
const PAPER_NAME_KEY = 'ozz_paper_name';
let customPaperImg = null;   // 相纸底图（HTMLImageElement）
let customPaperName = '';    // 底图文件名（显示用，让用户认出自己存的是哪张）
const OK_PAPER_MIME = /^image\/(jpeg|png)$/i;

function loadCustomPaper() {
  return new Promise((res) => {
    const d = (() => { try { return localStorage.getItem(PAPER_TEX_KEY); } catch { return null; } })();
    if (!d) return res(null);
    const im = new Image();
    im.onload = () => res(im); im.onerror = () => res(null);
    im.src = d;
  }).then((im) => {
    if (im) { try { customPaperName = JSON.parse(localStorage.getItem(PAPER_NAME_KEY) || '""'); } catch { customPaperName = ''; } }
    return im;
  });
}
loadCustomPaper().then((im) => {
  if (!im) return;
  customPaperImg = im;
  paperLayerCache = null;   // 底图是异步恢复的，缓存必须失效（key 里只有 'upload'）
  if (edit.series === 'custom' || edit.paperId === 'upload') { buildPapers(); renderPreview(); refreshBackPaper(); }
});
$('edPaperFile').addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  // 只接受 JPG / PNG。用户明确要求导入已扣好镂空的底图，PNG 才能带透明通道。
  const extOk = /\.(jpe?g|png)$/i.test(f.name || '');
  if (!OK_PAPER_MIME.test(f.type) || !extOk) { toast('相纸只支持 JPG 或 PNG 格式的图片'); return; }
  const url = URL.createObjectURL(f);
  const im = new Image();
  im.onload = () => {
    URL.revokeObjectURL(url);
    const s = Math.min(1, 1400 / Math.max(im.naturalWidth, im.naturalHeight));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(im.naturalWidth * s)); cv.height = Math.max(1, Math.round(im.naturalHeight * s));
    const g = cv.getContext('2d');
    g.drawImage(im, 0, 0, cv.width, cv.height);
    // PNG 必须原样保存：透明镂空是这套玩法的核心，转 JPEG 会变成黑底
    const data = f.type === 'image/png' ? cv.toDataURL('image/png') : cv.toDataURL('image/jpeg', .92);
    try { localStorage.setItem(PAPER_TEX_KEY, data); } catch { /* 存不下就只在本次会话内有效 */ }
    customPaperImg = new Image();
    customPaperImg.onload = () => {
      edit.paperId = 'upload'; edit.lastPaper.custom = 'upload';
      paperFit = 1; paperOffX = 0; paperOffY = 0;
      customPaperName = f.name || '我的相纸';
      // DIY 换了底图但 paperId 仍是 'upload' → 缓存 key 不变，必须显式失效
      paperLayerCache = null;
      try { localStorage.setItem(PAPER_NAME_KEY, JSON.stringify(customPaperName)); } catch { /* 忽略 */ }
      buildPapers(); syncFrameUI(); renderPreview(); refreshBackPaper(); syncPaperFitUI();
      toast(hasAlpha(customPaperImg) ? '相纸已套上，照片在镂空里显示' : '提示：这张图没有透明镂空，相纸会盖住照片（请用扣好镂空的 PNG）');
    };
    customPaperImg.src = data;
  };
  im.onerror = () => { URL.revokeObjectURL(url); toast('这张图片读不出来，换一张 JPG / PNG 试试'); };
  im.src = url;
});
// 底图是否含透明像素（判断用户有没有真的扣镂空）
function hasAlpha(img) {
  const s = 64;
  const cv = document.createElement('canvas'); cv.width = s; cv.height = s;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, s, s);
  const d = g.getImageData(0, 0, s, s).data;
  let clear = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 200) clear++;
  return clear > s * s * 0.01;   // 透明像素超过 1% 才算「有镂空」
}
// —— 照片在镂空内的缩放/位移：直接在预览上拖动 + 滚轮缩放 ——
// 用户明确要求「在预览界面直接拖动、滚轮缩放，不要滑杆」。这确实比滑杆直观得多：
// 拖动是连续反馈，滚轮还能以光标为中心缩放（滑杆只能等值跳变）。
// 仅在「DIY」且已导入相纸时启用，避免干扰其它系列的预览。
const prevWrap = $('edPrevWrap');
let prevDrag = null;
// DIY 面板：导入按钮 + 已保存模板的说明
$('edDiyImport').onclick = () => $('edPaperFile').click();
function syncDiyPanel() {
  const on = edit.series === 'custom';
  $('edDiySaved').innerHTML = on
    ? (customPaperImg
      ? `<span class="ed-diy-tag">已保存模板：${(customPaperName || '我的相纸').slice(0, 18)}</span>`
      : '<span class="ed-diy-tag ed-diy-none">还没有导入相纸模板</span>')
    : '';
}
function syncPaperFitUI() {
  const on = edit.series === 'custom' && !!customPaperImg;
  $('edPaperFitRow').hidden = !(edit.series === 'custom');   // DIY 面板整体始终显示（含导入按钮）
  $('edPrevHint').hidden = !on;
  prevWrap.classList.toggle('ed-pan', on);        // 光标变抓手，提示可拖
  prevWrap.classList.toggle('ed-panning', !!prevDrag);
  syncDiyPanel();
  if (on) $('edPaperFitVal').textContent = Math.round(paperFit * 100) + '%';
}
prevWrap.addEventListener('pointerdown', (e) => {
  if (!(edit.series === 'custom' && customPaperImg)) return;
  e.preventDefault();
  // 某些合成事件（自动化测试、部分浏览器的边缘情况）没有活跃指针，捕获会抛错；
  // 捕获失败不影响拖动本身（window 上的 move/up 仍能收到），所以静默跳过。
  try { prevWrap.setPointerCapture(e.pointerId); } catch { /* 无活跃指针，忽略 */ }
  prevDrag = { sx: e.clientX, sy: e.clientY, ox: paperOffX, oy: paperOffY };
  syncPaperFitUI();
});
// move/up 同时挂在 wrap 和 window：正常拖动时指针被 wrap 捕获（事件落在 wrap），
// 捕获失败或移出 wrap 时则冒泡到 window。两条路径都要能结束拖动，否则会卡住。
// 照片在成品画布上的位移：把「预览像素差」换算成画布比例。
// 符号靠自动化测试实证（tools/test-v44.js 有方向断言「右移匹配 > 左移匹配」）：
// 源码矩形是 c.x + c.w/2 - sw/2 + paperOffX*W，paperOffX 增大 = 源矩形右移
// = 取景窗往右走 = 画面上的照片内容相对左移，所以要让照片跟着鼠标走必须**取负**。
const applyDrag = (e) => {
  const r = edPrev.getBoundingClientRect();
  paperOffX = prevDrag.ox - (e.clientX - prevDrag.sx) / Math.max(1, r.width);
  paperOffY = prevDrag.oy - (e.clientY - prevDrag.sy) / Math.max(1, r.height);
  renderPreview();
};
prevWrap.addEventListener('pointermove', (e) => {
  if (!prevDrag) return;
  e.preventDefault();
  applyDrag(e);
});
addEventListener('pointermove', (e) => {
  if (!prevDrag) return;
  e.preventDefault();
  applyDrag(e);
});
const endPrevDrag = () => { if (!prevDrag) return; prevDrag = null; syncPaperFitUI(); };
prevWrap.addEventListener('pointerup', endPrevDrag);
prevWrap.addEventListener('pointercancel', endPrevDrag);
addEventListener('pointerup', endPrevDrag);
addEventListener('pointercancel', endPrevDrag);
// 滚轮缩放：以光标位置为锚点。这是图片查看器的标准手感——光标下那一点在缩放前后不动，
// 否则向上滚时画面会朝反方向跑。
//
// 推导（composite 里照片是 drawImage(源矩形 → 整张成品画布)）：
//   成品画布上归一化位置 px 处的源点 = sx + px*sw
//   要求缩放前后同一源点仍落在同一 px：sx + px*sw == sx' + px*sw'
//   代入 sx = c.x + c.w/2 - sw/2 + offX*W（W=成品画布宽）化简得：
//     offX' - offX = (sw - sw') * (px - 0.5) / W
//   又 sw = W*paperFit/base（base = max(W/c.w, H/c.h)），代入即得下式。
//   ⚠️ 这与「拖动」用的是同一个 offX，但两者符号看似相反、实则同源：
//      拖动时 offX 增大 → 源矩形右移 → 画面上照片左移（所以拖动取负）；
//      而锚点公式本身就是从几何约束推出来的，**必须保持正号**，改成负号会让锚点跑偏
//      （自动化测试实测：离中心锚点色差 425，比整图变化还大）。
prevWrap.addEventListener('wheel', (e) => {
  if (!(edit.series === 'custom' && customPaperImg)) return;
  e.preventDefault();
  const k = Math.exp(-e.deltaY * .0016);
  const next = Math.max(.2, Math.min(3, paperFit * k));
  if (next === paperFit) return;
  const c = edit.crop, cv = edPrev, W = cv.width, H = cv.height;
  if (!c || !W || !H) { paperFit = next; syncPaperFitUI(); renderPreview(); return; }
  const r = cv.getBoundingClientRect();
  const px = (e.clientX - r.left) / Math.max(1, r.width);   // 光标在成品画布上的归一化位置 0~1
  const py = (e.clientY - r.top) / Math.max(1, r.height);
  const base = Math.max(W / c.w, H / c.h);
  paperOffX += (paperFit - next) * (px - .5) / base;
  paperOffY += (paperFit - next) * (py - .5) / base;
  paperFit = next;
  syncPaperFitUI(); renderPreview();
}, { passive: false });
$('edPaperCenter').onclick = () => { paperFit = 1; paperOffX = 0; paperOffY = 0; syncPaperFitUI(); renderPreview(); };
// 换相纸/换配色后，若正处在背面创作，要把背面纸面重画一遍。
// 旧代码只在 initBack 里更新纸色，而 initBack 只在「切到背面模式」时调用——
// 于是用户先切背面、再换相纸，背面一直停留在旧纸色（实测六张镭射背面完全一样）。
function refreshBackPaper() {
  if (edit.mode !== 'back' || !edit.crop || !edit._backInit) return;
  if (backInk.width !== backW || backInk.height !== backH) return;
  paintPaper(bpc, backW, backH, currentPaper());
}
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
// 镭射流光的相位种子：由相纸 id 稳定派生，同一张纸每次打开颜色走向一致，不同纸彼此错开
const seedOf = (id) => { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) % 1000; return h / 1000; };
// 当前相纸底色的相对亮度（0=纯黑 1=近白）。laserFoil 的渐变函数拿不到色标，
// 所以用「相纸 id → 预置亮度表」的方式；非镭射/未知一律给 0.85（浅底）。
const PAPER_LUM = { rainbow: .85, silver: .82, noir: .10, aurora: .48, sakura: .62, ocean: .45 };
const paperBaseLum = () => PAPER_LUM[edit.paperId] ?? .85;
$('edOk').onclick = async () => {
  if (!edit.pending || !edit.crop) return;
  // 背面画布可能从未初始化过（用户没进背面模式就点完成），此时 backAspect 还是默认值，
  // 着色器会按错比例采样背面 → 背面图案错位/变形。
  // 注意不能用 backInk.width 判空：canvas 元素在 DOM 里，默认宽度就是 300（非零）。
  // 要用 initBack 设的 _backInit 标志。
  if (!edit._backInit && edit.crop) {
    const bw = 1000, bh = Math.max(360, Math.round(bw * edit.crop.h / edit.crop.w));
    backAspect = bw / bh;
  }
  const out = composite(1400);
  const dataURL = out.toDataURL('image/jpeg', .88);
  const cfg = snapshotRestore();
  // 相纸渲染参数：镭射纸要告诉 3D 渲染器「这张要随角度流光」，并附照片窗口位置（着色器避开照片区）
  const wi = out.windowInsets || { l: 0, r: 0, t: 0, b: 0 };
  const paper = {
    holo: edit.series === 'laser' ? 1 : 0,
    seed: seedOf(edit.paperId),
    winL: wi.l, winR: wi.r, winT: wi.t, winB: wi.b,
    // 背面贴图宽高比：背面画布是长方形而纹理数组是正方形，
    // 着色器要按同一比例居中取样，否则背面图案会错位/变形。
    aspect: backAspect || 1,
    // 该纸底色的相对亮度（0=纯黑 1=近白）：着色器据此调制虹彩强度 ——
    // 深底泛彩本就弱，浅底可以更明显。少了它玄黑背面会被满屏彩虹盖住。
    baseLum: paperBaseLum(),
  };
  const raw = rawOriginal();
  // 背面：通常只有画过东西才生成（backCur>0 表示撤销栈里存在非初始状态）。
  // 但镭射相纸例外：它正反两面都是整张铺满的箔面材质，背面若不生成贴图，
  // 3D 里翻到背面就是一块空白（用户实测「背面不是同样的镭射相纸」）。
  // 所以镭射纸无论画没画过都生成背面，让背面同样是完整箔面。
  // 背面贴图什么时候要生成：
  //  · 画过东西（backCur>0）—— 有手写内容
  //  · 镭射纸 —— 正反两面都是整张铺满的箔面材质，背面不能是空白（用户实测「背面不是镭射相纸」）
  // 用户没进过背面模式时 _backInit 仍为 false、墨层是空的，但相纸本身仍要画出来：
  // compositeBack 只依赖 backInk 叠加以画纹理，空墨层叠上去不改变画面，所以可以安全生成。
  const needBack = paper.holo || (edit._backInit && backCur > 0);
  edit.backURL = needBack ? compositeBack() : null;
  const texts = backTexts.length ? backTexts.map((t) => ({ ...t })) : null;
  const { mode, sheet } = edit.pending;
  closeEditor();
  if (mode === 'replace') await replacePhoto(sheet, dataURL, out.width, out.height, true, edit.backURL || null, { raw, cfg, texts, paper });
  else await addPhoto(dataURL, out.width, out.height, true, edit.backURL || null, { raw, cfg, texts, paper });
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
// 手写字体按需加载：首屏不拉这些文件，只有用户真的选了该字体写文字时才下载。
// 之前在模块顶层就 document.fonts.load 三个字体，导致所有人一进页面就下载全部字体（首屏 4.6MB）。
// 注意：演示夏行楷 4.6MB、鸿雷拙书简体 3.5MB 较大，选中后首次写中文要等下载 —— 这是刻意的取舍：
// 只在用户真的要用时下载，比让所有人一进页面就等 8MB 划算。
const HAND_FONTS = {
  "'XiaXingKai', cursive":      "40px 'XiaXingKai'",
  "'HongLeiZhuoShu2', cursive": "40px 'HongLeiZhuoShu2'",
  "'HongLeiZhuoShu', cursive":  "40px 'HongLeiZhuoShu'",
  "'Caramel', cursive":         "40px 'Caramel'",
  "'Rancho', cursive":          "40px 'Rancho'",
  "'Jandle', cursive":          "40px 'Jandle'",
};
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
  if (back) {
    // 图像尚未 onload 时 edit.crop 还是 null（快速双击照片后立刻点背面就会命中）。
    // 旧代码此时 initBack 直接 return → 背面画布停在 300x150 的空白默认尺寸且无法恢复。
    // 这里改为等图片就绪后再初始化，用户点哪儿都不会白屏。
    if (edit.crop) initBack(); else if (!initBack.pending) { initBack.pending = true; edImg.addEventListener('load', () => { initBack.pending = false; if (edit.mode === 'back') initBack(); }, { once: true }); }
    requestAnimationFrame(fitView); maybeShowPanTip();
  } else closeTextPop();
}
function initBack() {
  const c = edit.crop;
  if (!c) return false;   // 图片还没加载好；调用方（setMode）会挂 load 钩子重试
  backW = 1000; backH = Math.max(360, Math.round(backW * c.h / c.w));
  backAspect = backW / backH;   // 供 loadBackLayer 居中 contain + 着色器采样对齐
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
  // v109：手机上不自动弹 —— 引导条占位式参与文档流，窄屏下会吃掉 ~1/4 的画布高度
  // （实测 390×844 里占 205px）。手机用户需要时点缩放条上的「？平移」随时能唤出。
  if (innerWidth <= 720) return;
  let seen = false;
  try { seen = !!sessionStorage.getItem(PAN_TIP_KEY); } catch (e) {}
  if (!seen) $('edPanTip').hidden = false;
}
backStage.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = backStage.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.25 : 1 / 1.25);
}, { passive: false });

// —— 平板双指手势：捏合缩放 + 双指平移 ——
// 之前平板上只能用「抓手」工具或滚轮缩放，够不到也难用，双指才是平板的通用手势。
// —— 双指捏合缩放 / 平移（touch 事件驱动）——
// 关键设计：手势以「两指中点」为锚 —— 缩放围绕中点、平移跟随中点位移，逐事件增量叠加。
// 为什么用 touch 而不用 Pointer Events：实测 iPadOS Safari 的多指 pointer 事件不可靠，
// 会漏报 up/cancel，Map 里残留「幽灵手指」——捏合距离按一根冻结的鬼影手指计算，
// 缩放只剩半速响应、平移几乎不动（用户实测翻车）。e.touches 由系统直接列出当前
// 所有真实按下的手指，永不残留幽灵，双指状态永远可信。
const bStageRect = () => backStage.getBoundingClientRect();
let pinchPrev = null;   // 上一次双指 touchmove 的 { d, mx, my }
let pinchJustEnded = 0; // 捏合结束时刻：给「触摸双击改字」排除误判用（声明须早于监听器使用）
let activeBackTouchIds = new Set(); // 当前按在画布上的手指 identifier 集合（touchcancel 也会减回去，避免计数卡死）
const touchPair = (ts) => ({
  d: Math.max(1, Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY)),
  mx: (ts[0].clientX + ts[1].clientX) / 2,
  my: (ts[0].clientY + ts[1].clientY) / 2,
});
function abortBackOp() { // 双指介入时，把所有"单指进行中"的状态清干净
  if (backDrawing) {
    if (edit.tool === 'pen') penEnd(); // 钢笔：先把攒着的收锋段画完，别丢笔迹
    backDrawing = false; bic.globalCompositeOperation = 'source-over'; bic.globalAlpha = 1; snapshot();
  }
  if (backDrag) { backDrag = null; syncTextPanel(); }
  if (backPanning) { backPanning = false; backPanFrom = null; backStage.classList.remove('panning'); }
  updateCursor();
}
backStage.addEventListener('touchstart', (e) => {
  if (edit.mode !== 'back' || e.touches.length < 2) return;
  e.preventDefault();     // 抢在 Safari 页面缩放/长按接管之前（必须 passive:false）
  abortBackOp();          // 双指优先：停笔、放弃文本拖拽/抓手平移
  pinchPrev = touchPair(e.touches);
}, { passive: false, capture: true });
backStage.addEventListener('touchmove', (e) => {
  if (e.touches.length < 2) {
    // 单指作画时阻止 Safari 把拖拽当成系统手势（会发 pointercancel 掐断笔画）
    if (edit.mode === 'back' && backDrawing) e.preventDefault();
    return;
  }
  if (!pinchPrev) return;
  e.preventDefault();
  const g = touchPair(e.touches), r = bStageRect();
  // ① 缩放：围绕两指当前中点，增量比例。zoomAt 内部限幅（8%~800%）并 applyView
  zoomAt(g.mx - r.left, g.my - r.top, g.d / pinchPrev.d);
  // ② 平移：中点位移直接叠加到视图平移量（bview.x/y 本就是舞台坐标系）
  bview.x += g.mx - pinchPrev.mx;
  bview.y += g.my - pinchPrev.my;
  applyView();
  pinchPrev = g;
}, { passive: false, capture: true });
// 捏合结束（pinchPrev 复位）已并入下面的 backTouchEnd 统一处理，这里不再单独挂 pinchEnd。
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
  if (t === 'pen') return Math.max(2, edit.size * PEN_MAX); // 钢笔：显示峰值宽度（慢写时的最粗处）
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
  else if (edit.tool === 'pen') { /* 钢笔线宽逐点变化，由 penStep 计算，这里不设 */ }
  else if (edit.tool === 'ball') { bic.lineWidth = Math.max(1, edit.size * .28); }
  else if (edit.tool === 'marker') { bic.lineWidth = edit.size * 1.6; } // 油性笔：实色覆盖
  else if (edit.tool === 'eraser') { bic.lineWidth = Math.max(5, edit.size * 1.5); }
}
function drawSeg(a, b) { bic.beginPath(); bic.moveTo(a.x, a.y); bic.lineTo(b.x, b.y); bic.stroke(); }

// —— 钢笔：靠"笔压 + 笔速"驱动的变宽笔触，笔画边缘才有棱、出锋才有锋 ——
// 为什么不能用 lineTo：Canvas 的 stroke() 只有一条固定线宽路径，做不出粗细变化。
// 正确做法是沿笔画中线取样，为每个采样点算一个笔宽，再把"上缘点 + 下缘点"
// 连成一条闭合多边形填充。这样笔画两侧的斜线段就是你要的"棱"。
//
// 笔宽公式（细尖 / 接近签字笔）：w = wMax * (0.22 + 0.78 * press^1.15) * speedFactor
//   press      —— 真实笔压优先（Apple Pencil / 支持压感的触控笔）；没有则用速度反推
//   speedFactor—— 画得快 → 收细；慢 → 稍加粗。这是真实书写的规律，也叫"飞白收敛"
// 取 0.34 作为下限而非 0：这是被真实测试逼出来的。
// 最初取 0.22，快速笔画宽度掉到 2px，而手指采样点间距约 4~5px ——
// 笔宽小于点间距，四边形带之间就漏出缝隙，笔画直接断成虚线。
// 现在的做法：① 下限抬到 0.34，保证任何速度下笔宽都不会细过采样间距；
//          ② penStep 里再按实际点间距兜一个底（见 minGapW），从根上堵住漏洞。
const PEN_MIN = 0.34, PEN_MAX = 1.0, PEN_GAMMA = 1.15;
// 钢笔笔迹：保存「整笔」的所有采样点，同时记录已光栅化到第几个点。
// 关键设计（踩过一次坑才定下来的）：不要"每 3 个点画一个独立多边形"——
// 那样每段的两端法线朝向不一致，段与段之间会留下缝隙，快速细笔画直接变成虚线。
// 现在改成「四边形带」：第 i 段画 penPts[i-1]→penPts[i] 这一个四边形，
// 而第 i-1 段和第 i 段共用 penPts[i] 这个点，两边算出的法线完全相同 → 严丝合缝。
// 法线一律基于「全局点数组」计算（不是基于当前小段），这是保证接缝连续的前提。
let penPts = [], penDrawn = 0;
const penReset = () => { penPts.length = 0; penDrawn = 0; };
function penWidthAt(press, spd) {
  const p = Math.max(PEN_MIN, Math.min(1, press));
  // 速度因子：用 spd^0.6 让"收细"在低速段就启动——中等速度已能明显看到笔锋，
  // 不必写很快；快笔收到 0.30、慢笔回到 1.0，范围比旧版更宽、更"看得见"。
  const s = 1.0 - 0.72 * Math.pow(Math.max(0, Math.min(1, spd)), 0.6);
  return Math.max(1, edit.size * PEN_MAX * (PEN_MIN + (1 - PEN_MIN) * Math.pow(p, PEN_GAMMA)) * s);
}
// 全局法线：只用整笔点数组里该点的前后邻居，保证相邻段算出同一个偏移
function penNormal(i) {
  const a = penPts[Math.max(0, i - 1)], b = penPts[Math.min(penPts.length - 1, i + 1)];
  let dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { nx: -dy / len, ny: dx / len };
}
const penEdge = (i) => { const n = penNormal(i); const h = Math.max(.5, penPts[i].w / 2); return { n, h }; };
// 把「尚未光栅化」的采样点补画成四边形带
function penRaster() {
  // 首点画个圆点：点一下也要有痕迹，且给后续四边形一个起点
  if (penDrawn === 0) {
    const p0 = penPts[0];
    bic.beginPath(); bic.arc(p0.x, p0.y, Math.max(.5, p0.w / 2), 0, 7); bic.fill();
    penDrawn = 1;
  }
  for (let i = penDrawn; i < penPts.length; i++) {
    const a = penPts[i - 1], b = penPts[i];
    const ea = penEdge(i - 1), eb = penEdge(i);
    bic.beginPath();
    bic.moveTo(a.x + ea.n.x * ea.h, a.y + ea.n.y * ea.h);
    bic.lineTo(b.x + eb.n.x * eb.h, b.y + eb.n.y * eb.h);
    bic.lineTo(b.x - eb.n.x * eb.h, b.y - eb.n.y * eb.h);
    bic.lineTo(a.x - ea.n.x * ea.h, a.y - ea.n.y * ea.h);
    bic.closePath();
    bic.fill();
    // 圆接头：这是笔画"不断线"的真正保障。
    // 半径放大到笔宽的 0.70（> 0.5），让相邻两个接头必然重叠；同时把曲线外侧因
    // 直线段逼近圆弧而产生的楔形缺口也盖住（配合下面的加密采样双保险）。
    // 这样即使手指快速划动、点间距远大于笔宽，四边形之间漏出的楔形缺口也会被盖住，
    // 而笔宽本身可以放心地做得很细 —— 速度因子因此能真正起作用（快笔就是更细）。
    // 笔触全不透明 + source-over，重叠不会累积 alpha，橡皮擦依然擦得干净。
    const r = Math.max(.6, b.w * 0.70);
    bic.beginPath(); bic.arc(b.x, b.y, r, 0, 7); bic.fill();
  }
  penDrawn = penPts.length;
}
// 笔压/速度状态：从指针事件取，供 penStep 用
let penLast = null, penLastT = 0, penPress = 0.6;
// 取"事件时间"：真实指针事件统一用 e.timeStamp（含 coalesced 各自被采样到的真实时刻）。
// 关键修复：iPad 会把同一帧内的多次原始采样合并进一个 pointermove 再发 coalesced 列表，
// 这些点的 performance.now() 几乎相同 → dt≈0 被夹成 1ms → 算出的速度爆表 → 笔宽被压到最细。
// 结果就是慢速书写（本该粗）的笔迹中间被算成"快笔细线"，粗笔画里出现一串细点/断口，
// 且笔越粗对比越刺眼。改用每个合并点自带的 timeStamp，速度才真实。测试桩用 __penClock 注入假时钟。
function penNow(e) {
  if (e && e.timeStamp) return e.timeStamp;
  return (globalThis.__penClock != null) ? globalThis.__penClock : performance.now();
}
function penStep(pt, e) {
  const now = penNow(e);
  // 真实笔压：支持的设备直接用（Apple Pencil / 部分手写笔），没有则为 0
  const raw = e && e.pressure != null ? e.pressure : 0;
  if (raw > 0) penPress = Math.max(PEN_MIN, Math.min(1, raw));
  const prevPt = penPts.length ? penPts[penPts.length - 1] : null;
  const gap = prevPt ? Math.hypot(pt.x - prevPt.x, pt.y - prevPt.y) : 0;
  let spd = 0;
  if (penLast) {
    const d = Math.hypot(pt.x - penLast.x, pt.y - penLast.y);
    const dt = Math.max(1, now - penLastT);
    // 归一化基准 1.1 画布px/ms ≈ 66px/s 即判为"较快"：把门槛降下来，
    // 让中等速度也能触发收细、出现笔锋，不用刻意写很快。
    spd = Math.min(1, d / dt / 1.1);
  }
  // 无压感设备：用"慢=重、快=轻"反推虚拟压感，让钢笔依然有粗细变化
  if (raw <= 0) {
    if (penLast && spd > 0) {
      const target = 1 - spd * 0.8;
      penPress = penPress * 0.7 + target * 0.3; // 平滑，避免笔宽抖成锯齿
    }
    if (!penLast) penPress = 0.6; // 落笔默认中段起笔
  }
  penLast = { x: pt.x, y: pt.y }; penLastT = now;
  // 抖动过滤：位移极小的点丢弃，否则原地微颤会灌进大量重复点、内存与接缝都变差
  if (prevPt && gap < 0.35) return;
  // 笔宽完全由「压力 + 速度」决定，不做任何下限兜底（兜底会抵消速度因子的收细）。
  const w = Math.max(1, penWidthAt(penPress, spd));
  // —— 采样点加密（平板断点 + 曲线缺口的根治手段）——
  // iPad Safari 的 pointermove 很稀：快速书写时相邻事件能差 20~40px，而笔宽只有几 px，
  // 圆接头（半径 0.70w）盖不住这么大的缝 → 笔画断成一颗颗圆点（实测截图）。
  // 同时，慢速粗笔在曲线处，直线段逼近圆弧会留出楔形缺口；缺口深度 ∝ 步长²，
  // 把步长从 0.75w 缩到 0.35w 后，任意合理曲率的缺口都被圆接头兜住。
  // 这里把过大的间隔按 0.35w 的步长插值出中间点，宽度在两点间线性过渡：
  // 相邻四边形/圆接头必然重叠，**任何事件频率、任何书写速度、任何笔宽下都是实线**，
  // 而笔宽本身仍由速度/压力决定，快细慢粗的手感不受影响。
  if (!prevPt || gap <= w * 0.35) {
    penPts.push({ x: pt.x, y: pt.y, w });
  } else {
    const step = w * 0.35, n = Math.ceil(gap / step);
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      penPts.push({
        x: prevPt.x + (pt.x - prevPt.x) * t,
        y: prevPt.y + (pt.y - prevPt.y) * t,
        w: prevPt.w + (w - prevPt.w) * t,
      });
    }
  }
  penRaster();
}
// 收笔：先补画完所有采样点，再补一个"出锋"点 —— 抬笔时把笔宽压到最细，
// 笔画末端才是尖的（锋），而不是齐刷刷切断。
function penEnd() {
  if (!penPts.length) { penLast = null; return; }
  penRaster();
  // 必须先取末点、再清数组——之前顺序反了（penReset 先清空），last 永远是 undefined，
  // 下面读 last.x 直接抛 TypeError：抬笔必炸 → endBackPointer 里 snapshot() 不执行、
  // backDrawing 残留为 true，后续每一笔的状态都被污染（平板实测翻车的根因之一）。
  const last = penPts[penPts.length - 1];
  penReset(); penLast = null;
  // 出锋：直接在墨层上补一个小圆点（半径 = 末点笔宽的 0.34），笔画末端收成尖。
  // 不 push 出锋点走 penRaster —— 那会连带触发圆接头，在末端留圆头小球，把锋毁掉。
  bic.beginPath();
  bic.arc(last.x, last.y, Math.max(.5, last.w * PEN_MIN), 0, 7);
  bic.fill();
}
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
// 互斥守卫：一旦进入双指手势，单指绘制/平移/文本拖动必须全部让位。
// 否则第二根手指落下时，touchstart 里的 abortBackOp 虽已停笔，这里却会立刻又起一笔新笔画。
const backBusyWithPinch = () => edit.mode === 'back' && pinchPrev != null;
backStage.addEventListener('pointerdown', (e) => {
  if (edit.mode !== 'back') return;
  if (backBusyWithPinch()) return; // 双指手势优先，本指只参与捏合
  // 第二根手指的 pointerdown 先于它的 touchstart 到达：此时 pinchPrev 还是 null，
  // 但第一根手指的 touchstart 已把 activeBackTouches 记到 1 —— 用它挡住第二指起笔。
  if (e.pointerType !== 'mouse' && activeBackTouchIds.size > 0) return;
  e.preventDefault();
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
  applyBackBrush(); // 统一设置颜色/合成模式/线宽（钢笔的线宽稍后由 penStep 逐点覆盖）
  if (edit.tool === 'air') stampAir(p.x, p.y);
  else if (edit.tool === 'pen') { penReset(); penPress = 0.6; penLast = null; penStep(p, e); } // 落笔即起锋
  else drawSeg(p, p);
});
// 画笔移动/抬笔监听挂在 window：iPad 上若在 touch/笔 指针调 setPointerCapture 会秒发
// pointercancel 把笔画掐断（"画着画着没墨"的元凶）。去掉捕获后用 window 兜底，
// 手指移出画布或偶发 cancel 都还能收到 move/up，整笔不再丢墨。
window.addEventListener('pointermove', (e) => {
  if (edit.mode !== 'back') return;
  // 双指手势期间不参与单指绘制（abortBackOp 已清空状态，这里只是双保险）
  if (backBusyWithPinch()) return;
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
  if (edit.tool === 'air') stampAir(p.x, p.y);
  else if (edit.tool === 'pen') {
    // 高分屏设备（iPad 120Hz）会把两次事件之间的原始采样点合并进 coalesced 列表，
    // 取出来逐点喂给 penStep，采样密度翻倍、曲线更顺滑（配合插值加密双保险）
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    if (evs && evs.length > 1) for (const ce of evs) penStep(inkPos(ce), ce);
    else penStep(p, e);
  }
  else drawSeg(backLast, p);
  backLast = p;
});
// 用 Set 记录画布上"当前按着的手指 identifier"：touchcancel 也会减回去，避免计数漏减卡死。
// touchend 晚于 pointer 事件到达，用它判断"其实没抬手"；全部抬起且还在画 → 兜底收笔。
backStage.addEventListener('touchstart', (e) => {
  for (const t of e.changedTouches) activeBackTouchIds.add(t.identifier);
}, { passive: true, capture: true });
const backTouchEnd = (e) => {
  for (const t of e.changedTouches) activeBackTouchIds.delete(t.identifier);
  // 双指手势结束：剩余手指不足两根就复位 pinchPrev（余指不再接笔画）
  if (pinchPrev && e.touches.length < 2) { pinchPrev = null; pinchJustEnded = performance.now(); }
  // 正常顺序是 pointerup → touchend；若这里 backDrawing 还开着，说明 pointerup 被系统吞了，
  // 必须手动收笔并落一次快照，否则这一笔永远不结束、撤销栈也会错位。
  if (activeBackTouchIds.size === 0 && backDrawing) {
    if (edit.tool === 'pen') penEnd(); // 钢笔兜底收锋
    backDrawing = false; bic.globalCompositeOperation = 'source-over'; bic.globalAlpha = 1;
    snapshot();
  }
};
backStage.addEventListener('touchend', backTouchEnd, { capture: true, passive: true });
backStage.addEventListener('touchcancel', backTouchEnd, { capture: true, passive: true });
const endBackPointer = (e) => {
  if (backPanning) {
    backPanning = false; backPanFrom = null;
    backStage.classList.remove('panning');
    updateCursor();
    return;
  }
  if (backDrag) { if (backDrag.kind === 'move' && !backDrag.moved) { /* 单击选中，不撤销 */ } else snapshot(); backDrag = null; syncTextPanel(); return; }
  if (!backDrawing) return;
  // 兜底第 4 道防线：某些 iPadOS 版本即使 preventDefault 也会发 pointercancel。
  // 只要手指其实还按在画布上（有活跃 touch 且落在舞台内），就当作"系统抽风"，
  // 不结束这一笔——否则用户正画到一半笔画会被凭空截断，比选区更让人崩溃。
  if (e.type === 'pointercancel' && e.pointerType !== 'mouse' && activeBackTouchIds.size > 0) return;
  // 收笔：把钢笔最后那一小段（含出锋）画完再落快照，否则最后几个采样点会丢
  if (edit.tool === 'pen') penEnd();
  backDrawing = false; bic.globalCompositeOperation = 'source-over'; bic.globalAlpha = 1;
  snapshot();
};
window.addEventListener('pointerup', endBackPointer);
window.addEventListener('pointercancel', endBackPointer);
backStage.addEventListener('dblclick', (e) => { // 双击文字改字（鼠标）
  const i = hitText(inkPos(e));
  if (i >= 0) { selText = i; syncTextPanel(); renderTexts(); addTextAt(backTexts[i], true); }
});
// 触摸双击改字：dblclick 在触屏不可靠，用两次轻点判定；先选中再改（与鼠标双击同效）
let backTap = null;
backStage.addEventListener('pointerup', (e) => {
  if (e.pointerType === 'mouse' || edit.mode !== 'back' || backPanning || backDrag) { backTap = null; return; }
  if (performance.now() - pinchJustEnded < 350) { backTap = null; return; } // 排除捏合误判
  const now = performance.now();
  const p = inkPos(e);
  const near = backTap && Math.hypot(p.x - backTap.x, p.y - backTap.y) < 40 / bview.z;
  if (near && now - backTap.t < 700) {
    backTap = null;
    const i = hitText(p);
    if (i >= 0) { selText = i; syncTextPanel(); renderTexts(); addTextAt(backTexts[i], true); }
  } else backTap = { x: p.x, y: p.y, t: now };
});
backStage.addEventListener('contextmenu', (e) => e.preventDefault()); // 右键用于平移，不弹系统菜单

// —— iPadOS / iOS「长按劫持」三道防线 ——
// 现象：平板上画笔停顿约 0.5 秒，Safari 认为你在长按一个「图片元素」，于是给 canvas
// 盖上蓝色选区 + 弹「拷贝/存储到照片」气泡，并发 pointercancel 把笔画掐断。
// CSS 里的 user-select / touch-callout 只能压掉视觉表现，压不住系统发来的 pointercancel，
// 所以这里必须再用 JS 主动 preventDefault 抢在系统接管之前。
// 注意 touchstart 必须用 { passive: false }，否则 preventDefault 不生效。
const edRoot = $('editor');
const edTextPopEl = $('edTextPop'); // 提前取引用：下面几个监听器要用（比直接摸 const edTextPop 更稳）
edRoot.addEventListener('selectstart', (e) => {
  // 只拦选择行为，不拦输入框（edTextPop 已单独放开 user-select，这里再放行一次更稳）
  if (edTextPopEl.contains(e.target)) return;
  e.preventDefault();
});
// 标题行 / 模式切换行：窄窗口下背面画布会紧贴它们（实测画布 top≈19px），
// 手指落在这两行上时若不接管，浏览器会按「拖动页面」处理 → 橡皮筋回弹甚至整页重载，
// 用户的编辑内容全部丢失（实测 test-touch 稳定复现）。这里直接吞掉，不让它落到画布。
const ED_CHROME = '.ed-head, .ed-mode';
// 任何「会触发 click 的交互控件」：落在它们身上的触摸必须放行——否则下面的
// preventDefault 会掐掉浏览器合成的 click，按钮在手机/平板上「点了没反应」。
const ED_NOCLICK = 'button, a, input, select, textarea, label, [role="button"]';
// ⚠️ v108 触摸修复：早先对 .ed-head / .ed-mode 里的**所有** touchstart/touchmove 都
// preventDefault（本意是窄屏下背面画布紧贴这两行时，别让手指拖动整页）。但代价是
// 这两行里的按钮（完成 / 取消 / 正面 / 背面创作）的 click 被一并掐掉——
// 用户实测「手机端/平板端完成按钮、背面编辑、取消等按钮无反应」正由此而来。
// 修法：只对这两行的**空白区域**（非交互控件）预防默认；落在按钮上的触摸放行，
// 让 click 正常合成。CSS 里 .ed-head/.ed-mode 已有 `touch-action:none` 兜底整页拖动。
edRoot.addEventListener('touchstart', (e) => {
  if (edTextPopEl.contains(e.target)) return; // 文本框里的正常触摸放行
  if (e.touches.length > 1) return;           // 多指留给缩放/平移
  if (backStage.contains(e.target)) { e.preventDefault(); return; } // 禁止系统长按接管
  // 仅空白区域吞掉拖动；按钮放行以保 click
  if (e.target.closest && e.target.closest(ED_CHROME) && !e.target.closest(ED_NOCLICK)) e.preventDefault();
}, { passive: false });
edRoot.addEventListener('touchmove', (e) => {
  if (backStage.contains(e.target)) { e.preventDefault(); return; } // 禁止画布区域滚动/橡皮筋
  // 仅空白区域禁止拖动页面；按钮上即便手指微抖也不取消 click
  if (e.target.closest && e.target.closest(ED_CHROME) && !e.target.closest(ED_NOCLICK)) e.preventDefault();
}, { passive: false });
// 有些 iOS 版本把长按识别为 dragstart（拖拽图片），一并拦掉
edRoot.addEventListener('dragstart', (e) => e.preventDefault());
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
  // 手写字体可能此刻才刚开始下载 → 等它就位后再测量与绘制，否则会用 fallback 字体量错框宽。
  // 夏行楷(4.6MB)/鸿雷拙书(3.5MB) 首次使用要等一会儿，提示一句免得以为卡死。
  const bigFont = /XiaXingKai|HongLeiZhuoShu2/.test(cur.font || '');
  if (bigFont) toast('首次使用该字体，正在下载…（约 4MB，仅此一次）', 4000);
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
  // 背面画布未初始化时 backW/backH 是上一张的残留值，必须按当前裁剪框重算，
  // 否则会合成出尺寸不对的背面图。
  if (edit.crop) {
    backW = 1000; backH = Math.max(360, Math.round(backW * edit.crop.h / edit.crop.w));
  }
  const cv = document.createElement('canvas'); cv.width = backW; cv.height = backH;
  const c = cv.getContext('2d');
  paintPaper(c, backW, backH, currentPaper());
  // 墨层只有初始化过且尺寸匹配时才叠上去：未初始化时它是 300×150 的空白默认画布，
  // 直接 drawImage 会把相纸拉伸变形（叠空白等于没叠，所以判尺寸）。
  if (edit._backInit && backInk.width === backW && backInk.height === backH) c.drawImage(backInk, 0, 0);
  if (edit._backInit && backTextCv.width === backW && backTextCv.height === backH) c.drawImage(backTextCv, 0, 0);
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
  if (extra?.paper) p.paper = extra.paper;         // 镭射流光/照片窗口：换了新设置就更新
  if (fitted && p.paper) {                         // 纸片比例可能变了，重算并把相纸参数带进实例
    const ns = makeSheet(pi, false);
    for (const k of ['w', 'h', 'crop', 'paper']) { target[k] = ns[k]; writeSheet(target.buf, target); }
  }
  await loadLayerImage(dataURL, target.layer);
  gl.activeTexture(gl.TEXTURE0); gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  if (backURL) { await loadBackLayer(backURL, target.layer, target.paper && target.paper.aspect); gl.activeTexture(gl.TEXTURE3); gl.generateMipmap(gl.TEXTURE_2D_ARRAY); gl.activeTexture(gl.TEXTURE0); }
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
  photos.push({ id: 'u' + Date.now(), src: dataURL, full: dataURL, description: '你添加的照片', photographer: '你', source_page: '', width, height, aspect: width / height, fitted: !!fitted, back: backURL || null, raw: extra?.raw || dataURL, cfg: extra?.cfg || null, texts: extra?.texts || null, paper: extra?.paper || null });
  await loadLayerImage(dataURL, pi);
  gl.activeTexture(gl.TEXTURE0); gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
  if (backURL) { await loadBackLayer(backURL, pi, extra?.paper?.aspect); gl.activeTexture(gl.TEXTURE3); gl.generateMipmap(gl.TEXTURE_2D_ARRAY); gl.activeTexture(gl.TEXTURE0); }
  // 用户新添加照片的候选高度区间。房间高RH=5.4，纸片半高约 .4，
  // 上限取 4.0 → 顶边约 4.4，离天花板还有 1.0 的余量，聚焦时不会"死贴天花板"。
  // 下限 1.6 略高于示例照片的 1.55，避免新照片总沉在最底下一排。
  const s = makeSheet(pi, false, [1.6, 4.0]);
  //⚠️ 这里**不要**再写 `s.y = <某个常量>`。
  //   早先硬编码 `s.y = 2.4`，于是每张新照片都挂在同一水平线——
  //   用户实测反馈「每次新加的照片都是在同一高度，距离天花板的高度一致」。
  //   当时的动机是"随机到 4.55 会让照片死贴天花板"，但那是把
  //   「别贴天花板」误当成「钉死一个高度」来解决的，矫枉过正。
  // 高度随机 + 优先空位，现由 makeSheet 的 30 次候选（挑最空的）一起完成。
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
// 用 var 声明：storeGet 可能在模块开头就被调用（早于本行的 let/const 初始化），
// 用 let/const 会触发 TDZ（Cannot access before initialization）；var 提升保证可安全访问
// ⚠️ v113：`var DB_NAME / STORE / dbPromise` 已上移到启动读取之前声明（见上），
// 此处旧声明已移除——若保留，启动时会因TDZ/未赋值而拿到 undefined。
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
// ⚠️ v113 起 **localStorage 兜底被彻底移除**，IndexedDB 是唯一真相来源。
// 旧设计把整份 base64 照片同时镜像一份到 localStorage（仅 5MB），
// 大图时它会**静默失败**并留下一份**旧的/更小的**副本；下次 storeGet 读到这份
// 过期数据，于是「刚加的照片消失了」——用户实测反复丢稿的元凶。
// 现在写入失败会明确抛出，由调用方弹提示，而不是悄悄用旧数据糊弄过去。
async function storeSet(key, val) {
  const db = await openDB();
  await new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
  });
  return 'idb';
}
// 「本机存有作品」的极小标记（几十字节）。仅用于诊断/提示，不参与数据读取。
function markHasWork() { try { localStorage.setItem('papercloud.hasWork', '1'); } catch (e) {} }

async function storeGet(key) {
  const db = await openDB();
  return await new Promise((res, rej) => {
    const rq = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    rq.onsuccess = () => res(rq.result ?? null); rq.onerror = () => rej(rq.error);
  });
}
// 删除一个键。草稿删除用。
async function storeDel(key) {
  const db = await openDB();
  await new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).delete(key);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
}
// 存储自检：真写一条再读回来，判断 IndexedDB 到底能不能用。
// 无痕模式、以 file:// 直接打开、隐私设置都会让它不可用——此时必须让用户知道，
// 否则他会以为作品存好了，刷新后才发现全没了（用户实测踩过）。
async function storageSelfCheck() {
  try {
    const probe = '__probe__' + Date.now();
    await storeSet(probe, { added: [1], replaced: {} });
    const back = await storeGet(probe);
    await storeDel(probe);
    return !!(back && back.added && back.added.length);
  } catch (e) { return false; }
}
let saving = false;
function buildUserData() {
  const user = { replaced: {}, added: [] };
  photos.forEach((p) => {
    if (!p.src.startsWith('data:')) return;
    const rec = { src: p.src, width: p.width, height: p.height, description: p.description, photographer: p.photographer, source_page: p.source_page, fitted: p.fitted, back: p.back || null, raw: p.raw || null, cfg: p.cfg || null, texts: p.texts || null, paper: p.paper || null };
    if (p.id.startsWith('u')) user.added.push({ id: p.id, ...rec });
    else user.replaced[p.id] = rec;
  });
  return user;
}
// ---------------------------------------------------------------------------
// 草稿箱：多个带名字的快照 + 独立编辑会话
// ---------------------------------------------------------------------------
// 草稿快照与「当前作品」同格式（buildUserData 的 {replaced, added}），走同一个 IndexedDB。
// 关键设计（用户选定「每个草稿独立编辑会话」）：
//   · 进入会话时把**真实当前作品**原封不动暂存到 SESSION_KEY.origWork，
//     再把草稿副本放进「实时槽」STORE_KEY —— boot 与 persist 因此完全不用改。
//   · 存档点 draftKey(id) 只在点「保存回草稿」时写入，绝不会被误改。
//   · 退出/刷新后可从 SESSION_KEY 恢复真实当前作品。
const DRAFTS_KEY = 'papercloud.drafts';   // 草稿索引 [{id,name,savedAt,count,thumb}]
const SESSION_KEY = 'papercloud.session'; // { draftId, name, origWork }
function draftKey(id) { return 'papercloud.draft.' + id; }
async function getDraftIndex() { try { return (await storeGet(DRAFTS_KEY)) || []; } catch (e) { return []; } }
async function setDraftIndex(idx) { await storeSet(DRAFTS_KEY, idx); }
async function loadDraftSnapshot(id) { try { return await storeGet(draftKey(id)); } catch (e) { return null; } }
// 小封面缩略图（第一张用户照片压到 120px），草稿列表里一眼认出是哪份
async function makeThumb(src) {
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
    const c = document.createElement('canvas'); c.width = 120; c.height = 120;
    const g = c.getContext('2d');
    const s = Math.min(img.width, img.height);
    g.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 120, 120);
    return c.toDataURL('image/jpeg', 0.7);
  } catch (e) { return null; }
}
// 把当前画布存成一份新草稿
async function saveCurrentAsDraft(name) {
  const userData = buildUserData();
  if (!userData.added.length && !Object.keys(userData.replaced).length) { toast('当前作品还是 6 张示例，先添加/替换照片再存草稿'); return null; }
  const id = 'd' + Date.now() + Math.random().toString(36).slice(2, 6);
  const firstUser = photos.find((p) => p.src && p.src.startsWith('data:'));
  const thumb = firstUser ? await makeThumb(firstUser.src) : null;
  const now = Date.now();
  // ⚠️ 存草稿会把照片整份复制一份，占用与当前作品相当的空间。
  // 手机浏览器 IndexedDB 配额有限，超限时 storeSet 会抛错——必须让失败「响亮」，
  // 否则用户以为存好了，实际草稿是空的（早先版本异常被吞，是用户丢稿的真凶）。
  try {
    await storeSet(draftKey(id), { userData, name, savedAt: now });
  } catch (e) {
    console.warn('草稿写入失败', e);
    toast('存草稿失败：浏览器存储空间已满。请先删除旧草稿或减少照片后重试', 6000);
    return null;
  }
  const idx = await getDraftIndex();
  idx.unshift({ id, name, savedAt: now, count: materializePhotos(userData).length, thumb });
  await setDraftIndex(idx);
  return id;
}
async function deleteDraft(id) {
  await storeDel(draftKey(id));
  const idx = (await getDraftIndex()).filter((x) => x.id !== id);
  await setDraftIndex(idx);
}
// 进入草稿的独立编辑会话：暂存当前作品 → 草稿副本进实时槽 → 重建画布
async function enterDraftSession(id) {
  const snap = await loadDraftSnapshot(id);
  if (!snap || !snap.userData) { toast('草稿已损坏或丢失'); return false; }
  // ⚠️ 覆盖实时槽前的最后一道闸：绝不能用「空快照」把用户当前作品冲掉。
  // 空草稿通常意味着当初存草稿时因配额超限写失败（照片没存进去），
  // 真去换画布就等于当着用户的面删数据——宁可拒绝进入。
  const snapHasPhotos = (snap.userData.added || []).length || Object.keys(snap.userData.replaced || {}).length;
  if (!snapHasPhotos) { toast('这个草稿是空的（当初可能因存储空间不足没存成功），为避免覆盖你现在的作品，不能进入', 6000); return false; }
  let s = await storeGet(SESSION_KEY);
  if (!s) s = { draftId: id, name: snap.name, origWork: await storeGet(STORE_KEY) }; // 首次进入才暂存真实当前作品
  else { s.draftId = id; s.name = snap.name; } // 会话中换草稿：保留最初暂存的当前作品
  await storeSet(SESSION_KEY, s);
  await storeSet(STORE_KEY, snap.userData); // 实时槽 = 草稿副本，persist() 照常写这里
  location.reload();
  return true;
}
// 「保存回草稿」：把当前编辑结果写回该草稿的存档点
async function saveBackToDraft() {
  const s = await storeGet(SESSION_KEY);
  if (!s) return false;
  const userData = buildUserData();
  const now = Date.now();
  await storeSet(draftKey(s.draftId), { userData, name: s.name, savedAt: now });
  const idx = await getDraftIndex();
  const e = idx.find((x) => x.id === s.draftId);
  if (e) { e.savedAt = now; e.count = materializePhotos(userData).length; }
  await setDraftIndex(idx);
  toast(`已保存回草稿「${s.name}」`);
  return true;
}
// 退出草稿会话：把暂存的真实当前作品放回实时槽
async function exitDraftSession() {
  const s = await storeGet(SESSION_KEY);
  if (!s) { location.reload(); return; }
  if (s.origWork) await storeSet(STORE_KEY, s.origWork); else await storeDel(STORE_KEY);
  await storeDel(SESSION_KEY);
  location.reload();
}
// 分享某个草稿：导出该草稿快照为只读 HTML（对方只能看不能改）
async function shareDraft(id, btn) {
  const snap = await loadDraftSnapshot(id);
  if (!snap) { toast('草稿已损坏或丢失'); return; }
  const dPhotos = materializePhotos(snap.userData);
  const label = btn ? btn.textContent : '';
  if (btn) btn.disabled = true;
  try {
    await buildReadOnlyHtml(dPhotos, snap.name, (m) => { if (btn) btn.textContent = m; });
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}
function persist() {
  const user = buildUserData();
  saving = true;
  markHasWork();
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
// v113：localStorage 兜底移除后，这里不再需要 pagehide 同步补写
// （原来补写的是 localStorage，现在IndexedDB 才是唯一真相来源；补写只会浪费空间并可能抛错）
// 但**必须在换页时关闭数据库连接**：不关的话，刷新时旧连接仍开着，
// 新页面的首次事务会读到过期快照（storeGet 里已加重试兜底，这里是第二道保险）。
addEventListener('pagehide', () => {
  const p = dbPromise;
  dbPromise = null;
  if (p) p.then((db) => { try { db.close(); } catch (e) {} }).catch(() => {});
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
// ---------------------------------------------------------------------------
// 删除照片（v116）：只允许删「你自己添加的照片」（id 以 u 开头）。
// 示例照片不提供删除——想把场景清回初始请用顶栏「↺ 重置」。
// 实现：把该照片的所有纸片从 sheets/dyn 里去掉 → 重排 buf 并整体重传实例缓冲
// （与 replacePhoto 删特写纸片同一套既有模式），photos 同步删除后 persist()。
// 纹理层的"空洞"不用担心：用户照片只会追加在 photos 末尾，删的永远靠后，
// 新照片的 pi 会复用释放出来的层号。
async function deletePhoto(si) {
  const sh = sheets[si];
  if (!sh || READONLY) return;
  const pi = sh.photo, p = photos[pi];
  if (!p || !p.id.startsWith('u')) { toast('示例照片不能删除；要清空场景请用顶栏「重置」'); return; }
  if (!confirm(`删除这张照片？此操作不可撤销。`)) return;
  const selObj = sel >= 0 ? sheets[sel] : null; // 选中项若不在删除范围，删完按新索引选回同一张
  for (let idx = sheets.length - 1; idx >= 0; idx--) if (sheets[idx].photo === pi) { sheets.splice(idx, 1); dyn.splice(idx, 1); }
  for (const s2 of sheets) if (s2.photo > pi) s2.photo--;
  photos.splice(pi, 1);
  sheets.forEach((s2, idx) => { s2.buf = idx; writeSheet(idx, s2); });
  gl.bindBuffer(gl.ARRAY_BUFFER, instances);
  gl.bufferData(gl.ARRAY_BUFFER, sheetData, gl.STATIC_DRAW); // 索引重排后整体重传（256×24 float，约 24KB，忽略不计）
  sheetDrag = null;
  sel = selObj ? sheets.indexOf(selObj) : -1;
  select(sel); // sel=-1 → 退回全景；否则重新聚焦原选中的那张
  persist();
  toast('已删除照片');
  wake();
}
$('delBtn').onclick = () => { if (sel >= 0) deletePhoto(sel); };
// 触摸设备兜底入口（按钮仅在 pointer:coarse 时显示）：编辑 / 翻转
$('editBtn').onclick = () => { if (sel >= 0) reeditPhoto(sel); };
$('flipBtn').onclick = () => { if (sel >= 0) flipSheet(sel); };
$('reset').onclick = async () => {
  if (!confirm('重置会清空当前作品的所有改动（添加/替换的照片），恢复到最初的示例照片。确定吗？此操作不可撤销。')) return;
  try {
    const db = await openDB();
    await new Promise((res) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).delete(STORE_KEY); tx.oncomplete = res; tx.onerror = res; });
  } catch (e) { /* 忽略：下面还有 localStorage 兜底 */ }
  localStorage.removeItem(STORE_KEY);
  location.reload();
};

// ---------------------------------------------------------------------------
// 导出「只读分享版」单文件 HTML
// ---------------------------------------------------------------------------
// 思路：把当前云里的照片与背面全部转成 base64 内嵌进 window.__PC_DATA__，
// 再把 index.html / main.js / style.css 的内容拼成一份完整 HTML。
// 关键取舍：**剔除手写字体**（3MB×3）——只读版不能写字，字体用不上；
// 背面里的手写字早已烤进图片，不需要字体。
async function toDataURL(url) {
  const blob = await (await fetch(url)).blob();
  return await new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => res(null);
    fr.readAsDataURL(blob);
  });
}
// 作品名：没起名时统一显示占位名 "My Photos"；起名后标签页标题、按钮、导出文件名全部跟着变
const WORK_NAME_KEY = 'papercloud.name';
const DEFAULT_WORK_NAME = 'My Photos';
function currentWorkName() {
  if (READONLY) return String(EMBEDDED.name || document.title).replace(/（只读分享版）$/, '').trim() || DEFAULT_WORK_NAME;
  try { return (localStorage.getItem(WORK_NAME_KEY) || '').trim() || DEFAULT_WORK_NAME; }
  catch { return DEFAULT_WORK_NAME; }
}
// 作品名只服务于"导出"这一件事：不再占用顶栏位置，改成导出时弹窗问一次。
function paintWorkName() {
  const n = currentWorkName();
  // 没起名时保留站点原标题当品牌标识，起名后才覆盖成用户自己的名字
  const custom = READONLY ? true : (localStorage.getItem(WORK_NAME_KEY) || '').trim();
  if (custom) document.title = n;
  return n;
}
// 底部操作提示：按输入方式给不同文案。平板上没有滚轮，写"滚轮缩放"等于骗人
function refreshHint() {
  const h = $('hint');
  if (!h || READONLY) return;
  const coarse = matchMedia('(pointer: coarse)').matches;
  h.textContent = coarse
    ? '单指拖动环视 · 双指缩放 · 点照片查看'
    : '拖动环视 · 滚轮缩放 · 点照片查看';
}
refreshHint();
function setWorkName(name) {
  try {
    if (name) localStorage.setItem(WORK_NAME_KEY, name);
    else localStorage.removeItem(WORK_NAME_KEY);
  } catch (e) {}
  return paintWorkName();
}
// 命名弹窗：Promise 化，确认返回名字、取消返回 null（导出流程据此中止）
const nameDlg = $('nameDlg'), nameInput = $('nameInput');
function askWorkName(okLabel = '确定') {
  return new Promise((resolve) => {
    nameInput.value = currentWorkName();
    $('nameOk').textContent = okLabel;
    nameDlg.hidden = false;
    nameInput.focus();
    nameInput.select(); // 平板上不 select 的话光标会停在末尾，改名要反复退格
    const done = (v) => {
      nameDlg.hidden = true;
      nameInput.removeEventListener('keydown', onKey);
      $('nameOk').removeEventListener('click', onOk);
      $('nameCancel').removeEventListener('click', onCancel);
      nameDlg.removeEventListener('pointerdown', onBg);
      resolve(v);
    };
    const onOk = () => done(nameInput.value.trim());
    const onCancel = () => done(null);
    const onBg = (e) => { if (e.target === nameDlg) onCancel(); }; // 点遮罩 = 取消
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); onOk(); }
      if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    };
    nameInput.addEventListener('keydown', onKey);
    $('nameOk').addEventListener('click', onOk);
    $('nameCancel').addEventListener('click', onCancel);
    nameDlg.addEventListener('pointerdown', onBg);
  });
}
paintWorkName();

// 把任意照片列表打包成只读分享版 HTML 并触发下载。
// photoList：完整照片数组（当前画布 photos，或草稿 materialize 出来的快照）。
// workName：写进 <title> 与文件名。progress(m)：可选，用于把进度显示在按钮上。
// 抽成独立函数是为了让「分享当前画布」与「分享某个草稿」复用同一套打包逻辑。
async function buildReadOnlyHtml(photoList, workName, progress) {
  const say = progress || (() => {});
  // 1) 把每张照片的正面与背面转成 base64
  const list = [];
  for (let i = 0; i < photoList.length; i++) {
    const p = photoList[i];
    say(`导出中 ${i + 1}/${photoList.length}…`);
    const src = await toDataURL(p.src);
    const back = p.back ? await toDataURL(p.back) : null;
    if (!src) continue;
    list.push({
      id: p.id, description: p.description, photographer: p.photographer,
      source_page: p.source_page || '', width: p.width, height: p.height,
      aspect: p.aspect, fitted: !!p.fitted, src, back: back || undefined,
      // raw/cfg/texts 不带：分享版只读，背面已是成品图、不需要再进编辑器还原
    });
  }
  say('打包资源…');
  // 2) 取三份源码（fetch 读本文件，file:// 下同样可用）
  const [htmlSrc, cssSrc, jsSrc] = await Promise.all([
    fetch('index.html').then((r) => r.text()),
    fetch('style.css').then((r) => r.text()),
    fetch('main.js').then((r) => r.text()),
  ]);
  // 3) 内联 JS 前必须转义 "</script>"，否则 HTML 解析器会在这里提前截断脚本块
  const jsSafe = jsSrc.replace(/<\/script/gi, '<\\/script');
  const cssSafe = cssSrc.replace(/<\/style/gi, '<\\/style');
  const payload = JSON.stringify({ readonly: true, name: workName, photos: list })
    .replace(/</g, '\\u003c'); // 防 JSON 里的 < 破坏 script 块
  // 4) 拼装：直接按 index.html 的固定结构替换。
  //    替换用「函数形式」，避免 $& / $1 等替换模式与内容里的 $ 冲突。
  //    先确认两个标签都存在（不存在说明页面结构变了，别硬拼）
  //    宽松正则容忍缓存版本号（style.css?v=111）：v106 起引用带 ?v= 参数，
  //    精确匹配会漏检 → 导出报「页面结构与预期不符」（2026-10-08 实测事故）
  const CSS_TAG = /<link rel="stylesheet" href="style\.css[^"]*">/;
  const JS_TAG = /<script type="module" src="main\.js[^"]*"><\/script>/;
  if (!CSS_TAG.test(htmlSrc) || !JS_TAG.test(htmlSrc)) throw new Error('页面结构与预期不符（找不到 style.css 或 main.js 的引用标签）');
  // 作品名写进 <title>，分享出去对方一眼看到是什么
  const out = htmlSrc
    .replace(/<title>[\s\S]*?<\/title>/, () => `<title>${workName.replace(/[<>&]/g, '')}</title>`)
    .replace(CSS_TAG, () => `<style>\n${cssSafe}\n</style>`)
    .replace(JS_TAG,
      () => `<script>window.__PC_DATA__=${payload};</script>\n<script type="module">\n${jsSafe}\n</script>`);
  const blob = new Blob([out], { type: 'text/html;charset=utf-8' });
  const mb = (blob.size / 1024 / 1024).toFixed(1);
  window.__lastExport = { html: out, size: blob.size, name: workName }; // 调试/验证出口：便于自动化测试取文件
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  // 文件名用作品名；去掉 Windows/文件系统不允许的字符
  const safe = workName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || DEFAULT_WORK_NAME;
  a.download = safe + '（只读分享版）.html';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast(`已导出「${workName}」${mb} MB · 双击即可离线打开，只能浏览不能编辑`, 6000);
}
// 「导出分享版」独立入口已移除（v116）：分享统一走「📁 我的作品 → 某作品 → 分享」
// （先存草稿再分享，v111 定下的流程）。打包逻辑 buildReadOnlyHtml 供 shareDraft 复用。

function mulberry32(a) {
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------------------------------------------------------------------------
// 只读分享模式：隐藏所有写入入口，提示改为"只读"。浏览、聚焦、翻转看背面全部保留。
// ---------------------------------------------------------------------------
if (READONLY) {
  for (const id of ['add', 'reset', 'saveBtn', 'replace', 'delBtn', 'editBtn', 'editName', 'file', 'nameDlg', 'worksBtn', 'draftsDlg', 'draftSave', 'draftList', 'draftsClose', 'draftStorage', 'storageWarn', 'storageWarnMsg', 'storageWarnClose', 'sessionBar', 'sessionSave', 'sessionExit', 'sessionName']) { const el = $(id); if (el) el.remove(); }
  const hint = $('hint');
  // 分享版标题用作者起的作品名；没起名就退回页面标题
  const name = (EMBEDDED.name || '').trim();
  if (name) { document.title = name; if (hint) hint.textContent = `「${name}」· 只读分享版 · 点照片查看与翻面`; }
  else if (hint) hint.textContent = '只读分享版 · 点照片查看与翻面';
  addEventListener('keydown', (e) => { // 只读模式下彻底禁用快捷键编辑
    if (e.key === 'Delete' || e.key === 'Backspace') e.preventDefault();
  });
}

// ---------------------------------------------------------------------------
// 作品菜单 / 草稿箱 / 草稿会话 —— 全部是写入入口，只读分享版不提供（元素已在上方移除）
// ---------------------------------------------------------------------------
if (!READONLY) {
  // 存储自检：不可用时立刻明确告知，避免"以为存好了、刷新才发现全没了"
  storageSelfCheck().then((ok) => {
    if (ok) return;
    const warn = $('storageWarn');
    const msg = $('storageWarnMsg');
    const isFile = location.protocol === 'file:';
    if (msg) msg.textContent = isFile
      ? '你正在以「本地文件」方式打开页面（file://），浏览器会禁用数据存储，照片刷新即丢。请改用公网 https 链接打开。'
      : '你添加的照片在刷新或关闭页面后会丢失。请确认不是无痕/InPrivate 窗口，并允许本站使用存储。';
    if (warn) warn.hidden = false;
  });
  $('storageWarnClose').onclick = () => { $('storageWarn').hidden = true; };

  // —— 顶栏（v116）：四个符号按钮 ＋ / ↺ / 💾 / 📁，不再有下拉菜单 ——
  // 💾 保存：命名 → 存入「我的作品」（与草稿箱里「＋ 把当前作品存为草稿」同一套逻辑）
  $('saveBtn').onclick = async () => {
    const name = await askWorkName('存入我的作品');
    if (name == null) return;
    let id = null;
    try { id = await saveCurrentAsDraft(name); }
    catch (e) { console.warn(e); toast('保存失败：' + (e.message || e), 6000); }
    if (id) toast(`已保存「${name}」到我的作品`);
  };
  // 📁 我的作品：直接展开草稿箱（继续编辑 / 分享 / 删除）
  $('worksBtn').onclick = async () => { draftsDlg.hidden = false; await renderDrafts(); await renderStorageInfo(); };

  // —— 草稿会话状态条：刷新后若仍在会话中，恢复提示 ——
  const sessionBar = $('sessionBar');
  storeGet(SESSION_KEY).then((s) => {
    if (s && s.draftId) {
      $('sessionName').textContent = `正在编辑草稿「${s.name || ''}」`;
      sessionBar.hidden = false;
    }
  }).catch(() => {});
  $('sessionSave').onclick = async () => { $('sessionSave').disabled = true; try { await saveBackToDraft(); } finally { $('sessionSave').disabled = false; } };
  $('sessionExit').onclick = async () => {
    if (!confirm('退出草稿编辑，回到你原来的作品？\n未「保存回草稿」的改动会丢失。')) return;
    await exitDraftSession();
  };

  // —— 草稿箱面板 ——
  const draftsDlg = $('draftsDlg'), draftList = $('draftList');
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtTime = (ts) => { const d = new Date(ts || 0); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
  async function renderDrafts() {
    const idx = await getDraftIndex();
    draftList.innerHTML = '';
    if (!idx.length) { draftList.innerHTML = '<div class="draft-empty">还没有草稿。<br>编辑好作品后点上面「把当前作品存为草稿」。</div>'; return; }
    for (const d of idx) {
      const item = document.createElement('div'); item.className = 'draft-item';
      if (d.thumb) { const im = document.createElement('img'); im.className = 'draft-thumb'; im.src = d.thumb; im.alt = ''; item.appendChild(im); }
      const meta = document.createElement('div'); meta.className = 'draft-meta';
      const nm = document.createElement('div'); nm.className = 'draft-name'; nm.textContent = d.name || '未命名';
      const sub = document.createElement('div'); sub.className = 'draft-sub'; sub.textContent = `${d.count || 0} 张 · ${fmtTime(d.savedAt)}`;
      meta.append(nm, sub); item.appendChild(meta);
      const acts = document.createElement('div'); acts.className = 'draft-acts';
      const bEdit = document.createElement('button'); bEdit.textContent = '继续编辑'; bEdit.title = '以独立会话打开这个草稿，不影响当前作品';
      bEdit.onclick = async () => { bEdit.disabled = true; await enterDraftSession(d.id); };
      const bShare = document.createElement('button'); bShare.textContent = '分享'; bShare.title = '导出这个草稿为只读 HTML';
      bShare.onclick = () => shareDraft(d.id, bShare);
      const bDel = document.createElement('button'); bDel.className = 'draft-del'; bDel.textContent = '删除'; bDel.title = '删除这个草稿';
      bDel.onclick = async () => {
        if (!confirm(`删除草稿「${d.name || '未命名'}」？此操作不可撤销。`)) return;
        await deleteDraft(d.id); await renderDrafts(); toast('已删除草稿');
      };
      acts.append(bEdit, bShare, bDel); item.appendChild(acts);
      draftList.appendChild(item);
    }
  }
  $('draftsClose').onclick = () => { draftsDlg.hidden = true; };
  $('draftSave').onclick = async () => {
    const name = await askWorkName('存为草稿');
    if (name == null) return;
    let id = null;
    try { id = await saveCurrentAsDraft(name); }
    catch (e) { console.warn(e); toast('存草稿失败：' + (e.message || e), 6000); }
    if (id) { toast(`已存草稿「${name}」`); await renderDrafts(); await renderStorageInfo(); }
  };
  draftsDlg.addEventListener('pointerdown', (e) => { if (e.target === draftsDlg) draftsDlg.hidden = true; });

  // 存储占用：把「存不下」变成看得见的事实，而不是等丢稿才发现
  const fmtMB = (b) => (b / 1048576).toFixed(1) + ' MB';
  async function renderStorageInfo() {
    const el = $('draftStorage');
    if (!el) return;
    try {
      const est = await navigator.storage?.estimate?.();
      if (!est || !est.quota) { el.textContent = ''; return; }
      const used = est.usage || 0, quota = est.quota;
      const pct = Math.min(100, Math.round((used / quota) * 100));
      el.textContent = `本机已用 ${fmtMB(used)} / 可用约 ${fmtMB(quota)}（${pct}%）` + (pct >= 80 ? ' ⚠️ 空间紧张，建议删除旧草稿' : '');
    } catch (e) { el.textContent = ''; }
  }
  renderStorageInfo();
}
// 供自动化测试观察草稿箱状态
window.__drafts = { getDraftIndex, loadDraftSnapshot, enterDraftSession, saveBackToDraft, exitDraftSession, shareDraft, saveCurrentAsDraft, materializePhotos, buildReadOnlyHtml, storeGet, storeSet };
glReady = true; // 实例缓冲已就绪（flipSheet 需要直接回写）
live = true; // 一切就绪：可以跑帧了
// 把某张照片的世界中心投影到屏幕像素坐标（供自动化测试精确点击，尤其远距离时）
const sheetScreen = (i) => {
  const s = sheets[i], D = dyn[i];
  const c = [s.x + (D ? D.ox : 0), s.y + (D ? D.oy : 0), s.z + (D ? D.oz : 0)];
  const r = [c[0] - view.eye[0], c[1] - view.eye[1], c[2] - view.eye[2]];
  const rx = r[0] * view.x[0] + r[1] * view.x[1] + r[2] * view.x[2];
  const ry = r[0] * view.y[0] + r[1] * view.y[1] + r[2] * view.y[2];
  const rz = r[0] * view.z[0] + r[1] * view.z[1] + r[2] * view.z[2];
  if (rz >= -1e-3) return null; // 在相机背后
  const t = Math.tan(FOV / 2), aspect = view.aspect;
  const nx = -rx / rz, ny = -ry / rz;
  return [(nx / (t * aspect) + 1) * innerWidth / 2, (1 - ny / t) * innerHeight / 2];
};
window.__pc = { sheets, photos, flipSheet, select, getSel: () => sel, zoomedIn, sheetScreen, deletePhoto }; // 调试/验证出口
window.__dyn = dyn;
window.__pick = pick;
window.__photos = () => photos;
// 实例缓冲槽位自检：写错槽位顺序不会报错、只会静默错乱（纸片被甩飞/镭射不显色），
// 所以留一个只读出口给自动化测试逐槽核对。
window.__sheetSlots = () => {
  // 取**最后**一张带相纸数据的纸片：自动化测试会把新造的照片放在末尾，
  // 取第一张会命中没有 paper 字段的示例照片（读到的都是默认值，测不出真实问题）。
  let n = -1;
  for (let i = sheets.length - 1; i >= 0; i--) if (sheets[i].paper && sheets[i].paper.holo) { n = i; break; }
  if (n < 0) n = sheets.length - 1;
  if (n < 0) return null;
  const o = n * FLOATS_PER_SHEET, d = sheetData;
  return {
    n,
    center: [d[o], d[o+1], d[o+2], d[o+3]],       // 0-3
    sizePhase: [d[o+4], d[o+5], d[o+6], d[o+7]],  // 4-7
    crop: [d[o+8], d[o+9], d[o+10], d[o+11]],     // 8-11
    dyn: [d[o+12], d[o+13], d[o+14], d[o+15]],    // 12-15 必须是 0
    holo: d[o+16], seed: d[o+17], winL: d[o+18], winR: d[o+19],  // 16-19
    winT: d[o+20], winB: d[o+21], aspect: d[o+22],             // 20-22
    wins: [d[o+18], d[o+19], d[o+20], d[o+21]],
  };
};
window.__sheetPos = () => sheets.map((s) => ({ x: s.x, y: s.y, z: s.z, yaw: s.yaw }));
window.__sheetList = () => sheets.map((s) => ({ w: s.w, h: s.h, photo: s.photo, study: s.study, crop: s.crop, backOut: s.backOut, renderYaw: s.renderYaw }));
window.__sheetDataDump = () => { const o = sheets.length; return Array.from(sheetData.slice((o - 1) * FLOATS_PER_SHEET, o * FLOATS_PER_SHEET)); };
window.__selIdx = () => sel;
window.__camState = () => ({ x: +cam.x.toFixed(3), y: +cam.y.toFixed(3), z: +cam.z.toFixed(3), yaw: +cam.yaw.toFixed(3), dist: +cam.dist.toFixed(3), goalDist: +goal.dist.toFixed(3) });
window.__flipSheet = flipSheet;   // 自动化测试用：把某张纸片翻到背面（验证背面流光）
window.__instances = null;        // 下面回填：GPU 实例缓冲（测试用它 getBufferSubData 读回真实数据）
window.__tap = () => lastTap;
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
// 调试出口：预热池状态（自动化测试用来确认「点色卡是否命中缓存」）
window.__warmStats = () => ({ size: paperLayerWarm.size, keys: [...paperLayerWarm.keys()].slice(0, 8) });
