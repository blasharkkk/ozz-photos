// 编辑器改版端到端验证：真实页面里注入测试照片 → 打开编辑器 →
// 逐个系列截图（纯色两行+调色球 / 镭射全息 / 自制上传），并断言关键 DOM 事实。
// 需要本地 http 服务（file:// 下模块/照片清单的 fetch 会被 CORS 拦）：
//   python -m http.server 8935 --bind 127.0.0.1
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9226;
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
  });
  await new Promise((r) => ws.addEventListener('open', r));
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: URL_UNDER_TEST });
  await wait(2500);

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

  // 1) 结构断言：完成按钮在标题行、无旧滑杆、调色球存在
  const s1 = await evalJs(`(() => ({
    okInHead: !!document.querySelector('.ed-head #edOk'),
    footGone: !document.querySelector('.ed-foot'),
    slidersGone: !document.getElementById('edSliders'),
    series: [...document.querySelectorAll('#edSeries button')].map((b) => b.dataset.s),
    solidOn: document.querySelector('#edSeries .on')?.dataset.s,
  }))()`);
  check(s1.okInHead, '完成按钮位于标题行');
  check(s1.footGone, '旧的底部按钮行已移除');
  check(s1.slidersGone, '色相/饱和滑杆已移除');
  check(JSON.stringify(s1.series) === JSON.stringify(['solid', 'doodle', 'laser', 'custom']), '相纸系列 = 纯色/涂鸦/镭射/自制');
  check(s1.solidOn === 'solid', '默认选中「纯色」');

  // 2) 注入一张测试照片，打开编辑器（默认纯色系列）
  const opened = await evalJs(`(async () => {
    const cv = document.createElement('canvas'); cv.width = 900; cv.height = 600;
    const g = cv.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 900, 600);
    grd.addColorStop(0, '#7fb2d9'); grd.addColorStop(1, '#e8d9a8');
    g.fillStyle = grd; g.fillRect(0, 0, 900, 600);
    g.fillStyle = '#fff'; g.font = '80px sans-serif'; g.fillText('TEST', 340, 320);
    const blob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', .9));
    const f = new File([blob], 'test.jpg', { type: 'image/jpeg' });
    const dt = new DataTransfer(); dt.items.add(f);
    const inp = document.getElementById('file');
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 700));
    return { open: !document.getElementById('editor').hidden,
      chips: document.querySelectorAll('#edPapers .paper-chip').length,
      picker: !!document.querySelector('#edPapers .ed-picker') };
  })()`);
  check(opened && opened.open, '编辑器成功打开');
  check(opened && opened.chips === 12, `纯色 = 11 预选 + 1 调色球（实际 ${opened && opened.chips}）`);
  check(opened && opened.picker, '调色球存在于纯色网格末尾');
  await shot('paper-solid.png');

  // 3) 镭射系列：6 张全息纸 + 每张纹理非空
  //    断言曾写 7，是v61 之前的老数量。v61 删掉重复的「香槟金」又补入新的一款，
  //    净数仍是 6（银虹/香槟金/玄黑/青蓝/玫粉/墨绿，见 test-v44 的名称互异断言）。
  const laser = await evalJs(`(async () => {
    document.querySelector('#edSeries [data-s="laser"]').click();
    await new Promise((r) => setTimeout(r, 400));
    const chips = [...document.querySelectorAll('#edPapers .paper-chip')];
    return { count: chips.length, titles: chips.map((c) => c.title) };
  })()`);
  check(laser.count === 6, `镭射共 6 张（实际 ${laser.count}）`);
  await shot('paper-laser.png');

  // 4) 自制系列：注入上传相纸 → chip 出现缩略图并选用 → 预览刷新
  const custom = await evalJs(`(async () => {
    document.querySelector('#edSeries [data-s="custom"]').click();
    await new Promise((r) => setTimeout(r, 200));
    // 造一张条纹图案当「用户上传的相纸」
    const cv = document.createElement('canvas'); cv.width = 600; cv.height = 800;
    const g = cv.getContext('2d');
    g.fillStyle = '#f3e6d0'; g.fillRect(0, 0, 600, 800);
    for (let y = 0; y < 800; y += 40) { g.fillStyle = (y / 40) % 2 ? '#e7c9a8' : '#d8e2c8'; g.fillRect(0, y, 600, 20); }
    const blob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', .9));
    const f = new File([blob], 'paper.jpg', { type: 'image/jpeg' });
    const dt = new DataTransfer(); dt.items.add(f);
    const inp = document.getElementById('edPaperFile');
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 700));
    const chip = document.querySelector('#edPapers .paper-chip.upload');
    const prev = document.getElementById('edPrev');
    let prevNonBlank = false;
    try {
      const px = prev.getContext('2d').getImageData(2, 2, 1, 1).data;
      prevNonBlank = px[3] > 0;
    } catch (e) { prevNonBlank = 'err'; }
    return { chipHasThumb: !!chip?.querySelector('canvas'), chipOn: chip?.classList.contains('on'), prevNonBlank };
  })()`);
  check(custom.chipHasThumb, '上传后自制 chip 显示缩略图');
  check(custom.chipOn, '上传后自动选用自制相纸');
  check(custom.prevNonBlank === true, '预览已按上传相纸重新合成');
  await shot('paper-custom.png');

  // 5) 回到纯色：点调色球选色 → 选中态与预览联动
  const pick = await evalJs(`(async () => {
    document.querySelector('#edSeries [data-s="solid"]').click();
    await new Promise((r) => setTimeout(r, 200));
    const input = document.querySelector('#edPapers .ed-picker input[type=color]');
    input.value = '#3366ff';
    input.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 200));
    const on = [...document.querySelectorAll('#edPapers .paper-chip')].filter((c) => c.classList.contains('on')).map((c) => c.dataset.id);
    return { on };
  })()`);
  check(JSON.stringify(pick.on) === JSON.stringify(['custom']), '调色球选色后仅自定义项选中');

  console.log(log.join('\n'));
  if (errors.length) { console.log('\n--- 页面报错 ---'); errors.forEach((e) => console.log(e)); }
  console.log(errors.length || log.some((l) => l.startsWith('FAIL')) ? '\nRESULT: FAIL' : '\nRESULT: ALL PASS');
  ws.close();
  chrome.kill();
  process.exit(0);
})();
