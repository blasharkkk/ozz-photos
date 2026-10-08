// 复现两个布局问题：
// ① 完成/取消按钮掉到面板底部，右列顶部留空
// ② 裁成竖屏（3:4 竖）后整个面板高度被撑高、布局整体下移
// 用 CDP 驱动真实页面，量测面板/两列/预览的几何，并截图。
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9231;
const ROOT = path.resolve(__dirname, '..');
const URL_UNDER_TEST = 'http://127.0.0.1:8944/index.html';

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (e, b) => {
    if (e) { res.writeHead(404); res.end('nf'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(b);
  });
});

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
  await new Promise((r) => server.listen(8941, '127.0.0.1', r));
  let tabs = null;
  for (let i = 0; i < 40; i++) {
    try { tabs = await get('/json/list'); break; } catch (e) { await wait(250); }
  }
  if (!tabs) { console.log('FAIL 无法连接 Chrome'); chrome.kill(); server.close(); process.exit(1); }
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
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await new Promise((r) => ws.addEventListener('open', r));
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: URL_UNDER_TEST });
  await wait(3200);

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

  // 注入一张横向照片并打开编辑器
  const opened = await evalJs(`(async () => {
    const cv = document.createElement('canvas'); cv.width = 1400; cv.height = 900;
    const g = cv.getContext('2d');
    const grd = g.createLinearGradient(0,0,1400,900);
    grd.addColorStop(0,'#2b4c7e'); grd.addColorStop(1,'#e0a24a');
    g.fillStyle = grd; g.fillRect(0,0,1400,900);
    for (let x = 0; x < 1400; x += 56) { g.fillStyle = 'rgba(255,255,255,.5)'; g.fillRect(x,0,10,900); }
    const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', .92));
    const f = new File([blob], 't.jpg', { type: 'image/jpeg' });
    const dt = new DataTransfer(); dt.items.add(f);
    const inp = document.getElementById('file');
    inp.files = dt.files; inp.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 1000));
    return { open: !document.getElementById('editor').hidden };
  })()`);
  check(opened && opened.open, '编辑器打开');

  const geo = `(() => {
    const r = (id) => { const e = document.getElementById(id); if (!e) return null;
      const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
    const panel = document.querySelector('.ed-panel');
    return {
      win: { w: innerWidth, h: innerHeight },
      panel: (() => { const b = panel.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; })(),
      panelScrollH: panel.scrollHeight,
      foot: r('edOk'),
      footBox: document.querySelector('.ed-foot') ? (() => { const b = document.querySelector('.ed-foot').getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; })() : null,
      head: (() => { const e = document.querySelector('.ed-head'); const b = e.getBoundingClientRect(); return { y: Math.round(b.y), h: Math.round(b.height) }; })(),
      mode: r('edMode'),
      body: (() => { const b = document.querySelector('.ed-body').getBoundingClientRect(); return { y: Math.round(b.y), h: Math.round(b.height) }; })(),
      okOffsetParent: document.getElementById('edOk').offsetParent ? document.getElementById('edOk').offsetParent.className : null,
      left: r('edFrontLeft'),
      right: r('edFrontRight'),
      prevWrap: r('edPrevWrap'),
      prev: r('edPrev'),
      ratios: r('edRatios'),
    };
  })()`;

  const g0 = await evalJs(geo);
  await shot('layout-free.png');
  console.log('自由裁剪：', JSON.stringify(g0, null, 1));

  // 切到 3:4 竖
  await evalJs(`(async () => {
    document.querySelector('#edRatios [data-r="0.75"]').click();
    await new Promise((r) => setTimeout(r, 700));
  })()`);
  const g1 = await evalJs(geo);
  await shot('layout-portrait.png');
  console.log('3:4 竖：', JSON.stringify(g1, null, 1));

  check(g1.panel.h === g0.panel.h, `切竖屏后面板高度不变（${g0.panel.h} → ${g1.panel.h}）`);
  check(g1.panel.y === g0.panel.y, `切竖屏后面板位置不变（y ${g0.panel.y} → ${g1.panel.y}）`);
  check(g1.foot.y <= g1.head.y + g1.head.h + 2, `完成按钮在标题行内（foot y=${g1.foot.y}, head 底=${g1.head.y + g1.head.h}）`);
  check(g0.footBox === null, 'ed-foot 已从 ed-body 中移除（不再挤成第三列）');

  // 逐个比例都过一遍，确认面板完全不动
  const sweep = await evalJs(`(async () => {
    const panel = document.querySelector('.ed-panel');
    const rows = [...document.querySelectorAll('#edRatios button')];
    const out = [];
    for (const b of rows) {
      b.click();
      await new Promise((r) => setTimeout(r, 450));
      const p = panel.getBoundingClientRect();
      const l = document.getElementById('edFrontLeft').getBoundingClientRect();
      const rr = document.getElementById('edFrontRight').getBoundingClientRect();
      const rat = document.getElementById('edRatios').getBoundingClientRect();
      const st = document.getElementById('edStage').getBoundingClientRect();
      out.push({ label: b.textContent, py: Math.round(p.y), ph: Math.round(p.height), lw: Math.round(l.width), lh: Math.round(l.height), rh: Math.round(rr.height), rath: Math.round(rat.height), stH: Math.round(st.height) });
    }
    return out;
  })()`);
  const uniq = new Set(sweep.map((s) => `${s.py}/${s.ph}/${s.lh}/${s.rh}`));
  check(uniq.size === 1, `8 种比例下面板/两列高度完全一致（实测 ${uniq.size} 种）→ ${sweep.map((s) => `${s.label}:${s.ph}`).join(' ')}`);
  await shot('layout-sweep.png');

  console.log("SWEEP:", JSON.stringify(sweep));console.log(log.join("\n"));
  if (errors.length) { console.log('\n--- 页面报错 ---'); errors.slice(0, 6).forEach((e) => console.log(String(e).slice(0, 300))); }
  ws.close(); chrome.kill(); server.close();
  process.exit(0);
})();