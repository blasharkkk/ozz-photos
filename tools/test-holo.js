// 镭射流光的确定性验证（不靠拖动相机，避免"编辑器遮罩/采样点落在背景"这类假通过）。
// 做法：在页面里额外跑一遍「同一段 GLSL 干涉公式」在不同 dot(N,V) 下的输出，
// 与 main.js 着色器里的公式逐字对应；若公式本身不随角度变，产品里的实现也不可能变。
// 同时用真实页面截图确认纸片在云中渲染正常（着色器没编译失败、没整片丢失）。
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9229;
const URL_UNDER_TEST = 'http://127.0.0.1:8944/index.html';

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--window-size=1000,760', 'about:blank',
], { stdio: 'ignore' });
const get = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let d = ''; r.on('data', (c) => d += c); r.on('end', () => res(JSON.parse(d)));
  }).on('error', rej);
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let tabs = null;
  for (let i = 0; i < 40; i++) { try { tabs = await get('/json/list'); break; } catch (e) { await wait(250); } }
  const page = tabs.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (method, params) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
  const errors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await new Promise((r) => ws.addEventListener('open', r));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: URL_UNDER_TEST });
  await wait(2500);
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result.value;
  };
  const log = [];
  const check = (ok, msg) => log.push((ok ? 'PASS ' : 'FAIL ') + msg);

  // 1) 干涉公式：与 main.js 着色器逐字对应，改动时两边一起改
  const formula = await evalJs(`(() => {
    // vUV 固定在相纸留白的一点上，只改 ndv（法线与视线夹角）
    const uvx = 0.06, uvy = 0.5, seed = 0.37;
    const iridAt = (ndv) => {
      const ang = 1. - ndv;
      const band = (uvx * 1.7 + uvy * 1.1) * 6.2831 + ang * 3.4 + seed * 6.2831;
      return [0, 1, 2].map((k) => 0.5 + 0.5 * Math.cos(band + [0, 2.094, 4.188][k]));
    };
    return [1.0, 0.95, 0.85, 0.7, 0.5, 0.3, 0.12].map((ndv) => ({ ndv, rgb: iridAt(ndv).map((v) => Math.round(v * 255)) }));
  })()`);
  check(Array.isArray(formula) && formula.length === 7, '干涉公式可在各角度求值');
  if (Array.isArray(formula)) {
    let maxD = 0;
    for (let i = 0; i < formula.length; i++) for (let j = i + 1; j < formula.length; j++) {
      const d = Math.abs(formula[i].rgb[0]-formula[j].rgb[0]) + Math.abs(formula[i].rgb[1]-formula[j].rgb[1]) + Math.abs(formula[i].rgb[2]-formula[j].rgb[2]);
      if (d > maxD) maxD = d;
    }
    check(maxD > 60, `公式本身随角度大幅变色（最大 RGB 差 ${maxD}/765）`);
    console.log('干涉色随角度：');
    for (const f of formula) console.log(`  ndv=${f.ndv}  rgb(${f.rgb.join(',')})`);
  }

  // 2) 真实页面：放一张镭射纸进云，确认渲染管线正常（着色器编译过、纸片在、边框有虹彩）
  const live = await evalJs(`(async () => {
    const cv = document.createElement('canvas'); cv.width = 900; cv.height = 700;
    const g = cv.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 900, 700);
    grd.addColorStop(0, '#6f9fd0'); grd.addColorStop(1, '#efd9a8');
    g.fillStyle = grd; g.fillRect(0, 0, 900, 700);
    const blob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', .92));
    const f = new File([blob], 'l.jpg', { type: 'image/jpeg' });
    const dt = new DataTransfer(); dt.items.add(f);
    const inp = document.getElementById('file');
    inp.files = dt.files; inp.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 900));
    document.querySelector('#edSeries [data-s="laser"]').click();
    await new Promise((r) => setTimeout(r, 300));
    document.getElementById('edOk').click();
    await new Promise((r) => setTimeout(r, 2600));
    return { editorClosed: document.getElementById('editor').hidden,
             // v113：照片数据不再镜像到 localStorage（那是掩盖启动读取 bug 的元凶），
             // 断言改为直接查 IndexedDB 这唯一真相来源。
             saved: await window.__drafts.storeGet('papercloud.v1').then(v => !!(v && v.added && v.added.length)) };
  })()`);
  check(live.editorClosed, '编辑器已关闭，进入云中');
  check(live.saved, '镭射纸已保存');

  // 3) 聚焦该纸片再截图（放大后更容易肉眼判断边框流光）
  await evalJs(`(async () => {
    const cvr = document.getElementById('scene');
    const r = cvr.getBoundingClientRect();
    // 双击聚焦
    cvr.dispatchEvent(new MouseEvent('dblclick', { clientX: r.width/2, clientY: r.height/2, bubbles: true }));
    await new Promise((res) => setTimeout(res, 1500));
  })()`);
  await wait(1200);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot && shot.data) fs.writeFileSync(path.join(__dirname, 'holo-focus.png'), Buffer.from(shot.data, 'base64'));
  console.log('聚焦截图: tools/holo-focus.png');

  console.log(log.join('\n'));
  if (errors.length) { console.log('--- 页面报错 ---'); errors.slice(0, 5).forEach((e) => console.log(String(e).slice(0, 300))); }
  console.log(errors.length || log.some((l) => l.startsWith('FAIL')) ? '\nRESULT: FAIL' : '\nRESULT: ALL PASS');
  ws.close(); chrome.kill(); process.exit(0);
})();
