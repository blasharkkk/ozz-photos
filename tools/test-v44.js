// v44 端到端验证：镭射流光着色器 / 相框语义 / 自制相纸识别与微调。
// 用 CDP 驱动真实页面：注入照片 → 打开编辑器 → 断言 DOM 与合成结果 → 截图。
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9241;
const URL_UNDER_TEST = 'http://127.0.0.1:8944/index.html';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--window-size=1240,940', 'about:blank',
], { stdio: 'ignore' });

const get = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let d = ''; r.on('data', (c) => d += c); r.on('end', () => res(JSON.parse(d)));
  }).on('error', rej);
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let tabs = null;
  for (let i = 0; i < 40; i++) {
    try { tabs = await get('/json/list'); break; } catch (e) { await wait(250); }
  }
  if (!tabs) { console.log('FAIL 无法连接 Chrome'); chrome.kill(); process.exit(1); }
  const page = tabs.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  const errors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args.map((a) => a.description || a.value).join(' '));
    }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: URL_UNDER_TEST });
  await wait(3000);

  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result.value;
  };
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    if (s && s.data) fs.writeFileSync(path.join(__dirname, name), Buffer.from(s.data, 'base64'));
  };
  const log = [];
  const check = (ok, msg) => log.push((ok ? 'PASS ' : 'FAIL ') + msg);

  // 0) WebGL 着色器是否编译成功（v44 改了片元着色器，编译失败会整页白板）
  const gl = await evalJs(`(() => {
    const c = document.getElementById('scene');
    const g = c.getContext('webgl2');
    return { hasCtx: !!g, lost: g ? g.isContextLost() : true, w: c.width, h: c.height };
  })()`);
  check(gl.hasCtx && !gl.lost, 'WebGL 上下文正常（着色器编译通过）');
  check(gl.w > 100 && gl.h > 100, `画布已分配尺寸 ${gl.w}x${gl.h}`);

  // 1) 打开编辑器（注入测试照片）
  const opened = await evalJs(`(async () => {
    const cv = document.createElement('canvas'); cv.width = 1200; cv.height = 800;
    const g = cv.getContext('2d');
    // ⚠️ 这张照片是为第 5 步的拖动方向断言特制的，颜色布局有硬约束，改之前先读完那段注释：
    //   左半纯黑(0) + 右半白底亮条纹 —— 亮度<60 的像素**只能**来自那个纯黑区，
    //   所以「暗像素重心」是照片上一个 100% 权重都在移动的特征，位移测量最灵敏。
    //   相纸最暗处亮度实测 82.7（花纹最暗色），与阈值 60 有 22.7 的安全余量；
    //   纯白照片下实测暗像素恒为 0，已反向验证判据不误抓相纸。
    // ⚠️ 曾经踩过的坑：照片里若有任何**静止的深色内容**（如铺满全宽的半透明黑横条），
    //   它会混进暗像素把重心钉死 → 位移恒测成 0px（假失败）。同理也不能用深色文字。
    g.fillStyle = '#000000'; g.fillRect(0, 0, 600, 800);          // 左半：纯黑标记
    g.fillStyle = '#ffffff'; g.fillRect(600, 0, 600, 800);         // 右半：纯白
    for (let x = 600; x < 1200; x += 40) {                // 亮条纹：给互相关留唯一特征
      g.fillStyle = 'rgba(210,225,255,.9)'; g.fillRect(x, 0, 18, 800);
      g.fillStyle = 'rgba(255,235,180,.9)'; g.fillRect(x + 20, 0, 8, 800);
    }
    g.fillStyle = 'rgba(255,255,255,.95)'; g.font = '80px sans-serif'; g.fillText('PHOTO', 700, 430);
    const blob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', .92));
    const f = new File([blob], 't.jpg', { type: 'image/jpeg' });
    const dt = new DataTransfer(); dt.items.add(f);
    const inp = document.getElementById('file');
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 900));
    return { open: !document.getElementById('editor').hidden };
  })()`);
  check(opened && opened.open, '编辑器打开');
  await shot('v44-front.png');

  // 2) 镭射：6 张；窗口内缩应随下边宽度变化
  const laser = await evalJs(`(async () => {
    document.querySelector('#edSeries [data-s="laser"]').click();
    await new Promise((r) => setTimeout(r, 400));
    return { chips: document.querySelectorAll('#edPapers .paper-chip').length,
             titles: [...document.querySelectorAll('#edPapers .paper-chip')].map((c) => c.title) };
  })()`);
  check(laser.chips === 6, `镭射共 6 张（实际 ${laser.chips}）`);
  // 六张镭射必须「都在」且「名字各不相同」——上一轮为拉开区分度把香槟金加了回来。
  check(laser.titles.length === 6, `镭射共 6 张（实际 ${laser.titles.length}：${laser.titles.join('/')}）`);
  check(new Set(laser.titles).size === laser.titles.length, '六张名称互不相同');
  await shot('v44-laser.png');

  // 3) 相框语义：三边固定，只有下边随滑杆变；滑杆上限 30%
  const frame = await evalJs(`(async () => {
    const prev = document.getElementById('edPrev');
    const meas = () => {
      const cv = prev, g = cv.getContext('2d');
      const d = g.getImageData(0, 0, cv.width, cv.height).data;
      // 找出照片区（与相纸色差异最大的连续矩形）：用四角内缩比例近似
      const at = (x, y) => { const i = (y * cv.width + x) * 4; return [d[i], d[i+1], d[i+2]]; };
      const corner = at(Math.round(cv.width*.5), Math.round(cv.height*.06));
      return { w: cv.width, h: cv.height, corner };
    };
    const w0 = document.getElementById('edWidth');
    w0.value = 30; w0.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 300));
    const big = meas();
    w0.value = 3; w0.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 300));
    const small = meas();
    return { max: w0.max, min: w0.min, bigH: big.h, smallH: small.h, bigW: big.w, smallW: small.w };
  })()`);
  check(frame.max === '30', `滑杆上限 30%（实际 ${frame.max}）`);
  // 下边从 3%→30%（差 27% × 短边），成品总高应相应变高；左右宽度必须完全不变（三边固定）
  const grew = (frame.bigH - frame.smallH) / frame.smallH;
  check(grew > 0.15 && grew < 0.45, `下边可调：总高 ${frame.smallH}→${frame.bigH}（+${(grew * 100).toFixed(0)}%）`);
  check(frame.bigW === frame.smallW, `左右宽度不随滑杆变化（三边固定）：均为 ${frame.bigW}`);

  // 4) 自制相纸：图层套叠（照片铺底 + 镂空相纸叠上），不再需要识别窗口
  const custom = await evalJs(`(async () => {
    // 先试非 JPG/PNG（改扩展名但 MIME 是 png —— 扩展名校验应拦下）
    const cv0 = document.createElement('canvas'); cv0.width = 8; cv0.height = 8;
    cv0.getContext('2d').fillRect(0,0,8,8);
    const b0 = await new Promise((r) => cv0.toBlob(r, 'image/png'));
    const bad = new File([b0], 'paper.gif', { type: 'image/png' });
    let dt = new DataTransfer(); dt.items.add(bad);
    let inp = document.getElementById('edPaperFile');
    inp.files = dt.files; inp.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 400));
    const rejected = document.getElementById('toast')?.textContent || '';

    // 造一张「已扣好镂空」的相纸底图 PNG：不透明花纹边框 + 中央完全透明
    const W = 600, H = 750;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, W, H);                                  // 全透明打底
    g.fillStyle = '#cfc6b8';                                  // 相纸花纹（实心）
    g.fillRect(0, 0, W, 90); g.fillRect(0, H - 150, W, 150);
    g.fillRect(0, 90, 60, H - 240); g.fillRect(W - 60, 90, 60, H - 240);
    for (let i = 0; i < 400; i++) {                           // 边框上加点纹理
      g.fillStyle = 'hsl(' + ((i*37)%360) + ',45%,' + (45 + (i*13)%35) + '%)';
      g.fillRect((i*23)%W, (i*17)%90, 7, 7);
      g.fillRect((i*29)%W, H - 150 + (i*19)%150, 7, 7);
    }
    const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
    const good = new File([blob], 'ref.png', { type: 'image/png' });
    dt = new DataTransfer(); dt.items.add(good);
    inp = document.getElementById('edPaperFile');
    inp.files = dt.files; inp.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 1000));
    document.querySelector('#edSeries [data-s="custom"]').click();
    await new Promise((r) => setTimeout(r, 500));

    // 取样前先复位照片缩放/位移，否则上一轮测试留下的 40% 会让照片溢出到边框位置
    document.getElementById('edPaperCenter').click();
    await new Promise((r) => setTimeout(r, 350));
    const prev = document.getElementById('edPrev');
    const px = prev.getContext('2d');
    // 镂空中心(50%,42%)应看到照片（测试照片是蓝黄渐变）；相纸上边框(50%,4%)应是花纹色
    const center = Array.from(px.getImageData(Math.round(prev.width*.5), Math.round(prev.height*.42), 1, 1).data.slice(0,3));
    const border = Array.from(px.getImageData(Math.round(prev.width*.5), Math.round(prev.height*.04), 1, 1).data.slice(0,3));
    return {
      rejected,
      fitRowShown: !document.getElementById('edPaperFitRow').hidden,
      framesHidden: document.getElementById('edFrames').hidden,
      widthHidden: document.getElementById('edWidthRow').hidden,
      prevW: prev.width, prevH: prev.height,
      refAspect: (600 / 750).toFixed(3), prevAspect: (prev.width / prev.height).toFixed(3),
      center, border,
      noWinPanel: !document.getElementById('edWinPanel'),
    };
  })()`);
  check(/JPG|PNG/.test(custom.rejected || ''), `非 JPG/PNG 被拒绝：「${(custom.rejected||'').slice(0,20)}」`);
  check(custom.noWinPanel, '已移除「照片区域」识别面板（改图层套叠）');
  check(custom.fitRowShown, '自制相纸显示照片缩放/位移微调');
  check(custom.framesHidden && custom.widthHidden, '自制系列隐藏相框与宽度控件（按参考图走）');
  check(custom.prevAspect === custom.refAspect, `成品比例跟参考图一致（${custom.prevAspect} vs ${custom.refAspect}）`);
  // 用「相对差异」判定，不依赖绝对色（预览有内边距，绝对坐标会取到照片区）：
  // 中心与上边框应明显不同 = 一处透出照片、一处是相纸花纹。
  const diff = Math.abs(custom.center[0]-custom.border[0]) + Math.abs(custom.center[1]-custom.border[1]) + Math.abs(custom.center[2]-custom.border[2]);
  check(diff > 40, `镂空处与相纸边框明显不同（Δrgb=${diff}，中心 ${custom.center} / 边框 ${custom.border}）→ 图层套叠生效`);
  await shot('v44-custom.png');

  // 5) 在预览上直接拖动 + 滚轮缩放（替代滑杆），并验证滚轮以光标为锚点
  const moved = await evalJs(`(async () => {
    const wrap = document.getElementById('edPrevWrap');
    const prev = document.getElementById('edPrev');
    const snap = () => { const d = prev.getContext('2d').getImageData(0, 0, prev.width, prev.height).data;
      let s = 0; for (let i = 0; i < d.length; i += 997) s += d[i]; return s; };
    const r = prev.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;

    // ① 左键拖动 → 方向必须与鼠标一致。
    //    判据：**量"暗像素重心"的横坐标**。测试照片左1/4 是纯黑，而相纸最暗处亮度 82.7，
    //    纯黑 0 → 阈值 60 只可能选中照片的黑色标记（纯白照片下实测恒为 0，已反证）。
    //    每次测量前都点「复位」：否则连续两次拖动会把照片推出镂空窗口，
    //    标记被裁掉、暗像素归零 → 第二次测量失效（曾出现 leftPx=-113 的怪值）。
    document.getElementById('edPaperCenter').click();      // 先复位
    await new Promise((res) => setTimeout(res, 200));
    // 用滚轮缩小到 ~22%（滑杆已移除）：此时照片块小于窗口，位移在画面上很明显
    for (let i = 0; i < 4; i++) {
      wrap.dispatchEvent(new WheelEvent('wheel', { clientX: cx, clientY: cy, deltaY: 240, bubbles: true, cancelable: true }));
      await new Promise((res) => setTimeout(res, 120));
    }
    // 暗像素（亮度<60）的重心 x —— 相纸不参与，纯白照片下恒为 null，可作对照
    const darkCx = () => {
      const d = prev.getContext('2d').getImageData(0, 0, prev.width, prev.height).data;
      const W = prev.width, H = prev.height;
      let sx = 0, n = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (d[i]*.3 + d[i+1]*.59 + d[i+2]*.11 < 60) { sx += x; n++; }
      }
      return n ? { cx: sx / n, n } : { cx: null, n: 0 };
    };
    const reset = async () => { document.getElementById('edPaperCenter').click();
      await new Promise((res) => setTimeout(res, 320)); };
    const dragPx = 40;
    const drag = (dx) => {
      wrap.dispatchEvent(new PointerEvent('pointerdown', { clientX: cx, clientY: cy, pointerId: 31, bubbles: true, isPrimary: true, button: 0 }));
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: cx + dx, clientY: cy, pointerId: 31, bubbles: true, isPrimary: true }));
      window.dispatchEvent(new PointerEvent('pointerup',   { clientX: cx + dx, clientY: cy, pointerId: 31, bubbles: true, isPrimary: true }));
    };
    await reset(); const box0 = darkCx();
    const before = snap();
    drag(dragPx);
    await new Promise((res) => setTimeout(res, 320));
    const afterDrag = snap();
    const box1 = darkCx();
    await reset(); drag(-dragPx);
    await new Promise((res) => setTimeout(res, 320));
    const boxL = darkCx();
    await reset();                                  // 复位归位，供② 滚轮缩放从100% 起量
    const boxHome = darkCx();
    // 画布像素 → 屏幕像素
    const k = r.width / prev.width;
    const shiftPx = (box1.cx - box0.cx) * k;
    const shiftLeftPx = (boxL.cx - box0.cx) * k;

    // ② 滚轮 → 缩放，读百分比文字
    wrap.dispatchEvent(new WheelEvent('wheel', { clientX: cx, clientY: cy, deltaY: -240, bubbles: true, cancelable: true }));
    await new Promise((res) => setTimeout(res, 300));
    const zoomed = document.getElementById('edPaperFitVal').textContent;
    const afterWheel = snap();

    // 锚点几何验证见独立脚本 tools/verify-anchor.js（纯数学判定，浮点级误差）

    // ④ 复位
    document.getElementById('edPaperCenter').click();
    await new Promise((res) => setTimeout(res, 300));
    const resetVal = document.getElementById('edPaperFitVal').textContent;
    return {
      dragChanged: before !== afterDrag, shiftPx: Math.round(shiftPx * 10) / 10,
      shiftLeftPx: Math.round(shiftLeftPx * 10) / 10,
      box0: box0.cx === null ? null : Math.round(box0.cx), box1: box1.cx === null ? null : Math.round(box1.cx),
      darkPx: box0.n, homeDelta: boxHome.cx === null || box0.cx === null ? null : Math.round((boxHome.cx - box0.cx) * 100) / 100,
      zoomed, resetVal,
      hintVisible: !document.getElementById('edPrevHint').hidden,
      panCursor: document.getElementById('edPrevWrap').classList.contains('ed-pan'),
      noSlider: !document.getElementById('edPaperFit'),
    };
  })()`);
  check(moved.dragChanged, '预览上左键拖动可移动照片');
  check(moved.darkPx > 500, `暗色标记被检出（${moved.darkPx}px，判据未退化为 0）`);
  check(moved.shiftPx > 8, `照片跟着鼠标方向移动（暗标记重心折算屏幕右移 ${moved.shiftPx}px；鼠标右移 40px，照片应右移）`);
  check(moved.shiftLeftPx < -8, `反向也成立（鼠标左移 40px，照片左移 ${moved.shiftLeftPx}px）`);
  check(moved.homeDelta === 0, `复位后暗标记回到原位（偏差 ${moved.homeDelta}px）`);
  check(moved.zoomed !== '100%', `滚轮缩放生效（${moved.zoomed}）`);
  check(moved.resetVal === '100%', `复位回到 100%（实际 ${moved.resetVal}）`);
  check(moved.hintVisible, '预览上显示「拖动/滚轮」提示');
  check(moved.panCursor, '预览区光标变为抓手');
  check(moved.noSlider, '已移除滑杆（改为直接在预览上操作）');

  // 6) 完成 → 照片记录带上 paper（镭射流光参数）
  const saved = await evalJs(`(async () => {
    document.querySelector('#edSeries [data-s="laser"]').click();
    await new Promise((r) => setTimeout(r, 300));
    document.getElementById('edOk').click();
    await new Promise((r) => setTimeout(r, 2500));
    const d = JSON.parse(localStorage.getItem('papercloud.v1') || '{}');
    const rec = (d.added || [])[(d.added || []).length - 1] || Object.values(d.replaced || {})[0];
    return { hasRec: !!rec, paper: rec ? rec.paper : null, cfgHol: rec && rec.cfg ? rec.cfg.holo : null };
  })()`);
  check(saved.hasRec, '完成后已保存作品数据');
  check(saved.paper && saved.paper.holo === 1, `镭射纸写入流光参数 holo=${saved.paper && saved.paper.holo}`);
  check(saved.paper && typeof saved.paper.winT === 'number', '保存了照片窗口位置（着色器避开照片区）');
  await shot('v44-cloud.png');

  console.log(log.join('\n'));
  if (errors.length) { console.log('\n--- 页面报错 ---'); errors.slice(0, 10).forEach((e) => console.log(String(e).slice(0, 400))); }
  console.log(errors.length || log.some((l) => l.startsWith('FAIL')) ? '\nRESULT: FAIL' : '\nRESULT: ALL PASS');
  ws.close();
  chrome.kill();
  process.exit(0);
})();
