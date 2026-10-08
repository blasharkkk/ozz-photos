// 真机等价路径验证：像用户那样「添加自己的照片 → 背面创作 → 用钢笔画」，
// 确认清空预置背面后钢笔依然能画（此前 test-touch 走的是"双击示例照片"路径，
// 示例照片已被清空背面，会走到不同分支，不代表真实使用路径）。
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9246;
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--remote-debugging-port=' + PORT, '--window-size=1240,940', 'about:blank'], { stdio: 'ignore' });
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
  const send = (m, p) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p || {} })); });
  const errors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 300));
  });
  await new Promise((r) => ws.addEventListener('open', r));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:8944/index.html' });
  await wait(2500);
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'EVAL_ERR ' + String(r.exceptionDetails.exception?.description || '').slice(0, 200);
    return r.result ? r.result.value : undefined;
  };
  const log = [];
  const check = (ok, m) => log.push((ok ? 'PASS ' : 'FAIL ') + m);

  // 添加自己的照片 → 切背面 → 选钢笔 → 真实触摸画一笔
  const box = await ev(`(async () => {
    const cv = document.createElement('canvas'); cv.width = 1000; cv.height = 750;
    const g = cv.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, 1000, 750);
    g.fillStyle = '#4a7fb5'; g.fillRect(120, 90, 760, 520);
    const b = await new Promise((r) => cv.toBlob(r, 'image/jpeg', .95));
    const f = new File([b], 'mine.jpg', { type: 'image/jpeg' });
    const dt = new DataTransfer(); dt.items.add(f);
    const i = document.getElementById('file'); i.files = dt.files; i.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 1000));
    document.querySelector('#editor [data-mode="back"]').click();
    await new Promise((r) => setTimeout(r, 900));
    // 等画布就绪（在页面内自轮询；注意：页面里不能调用 Node 侧的 send/wait）
    for (let k = 0; k < 40; k++) {
      const c = document.getElementById('edBackInk');
      if (c && c.width > 10 && c.getBoundingClientRect().width > 10) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    // 关掉首次进入的平移引导条（真实用户点「我知道了」）；它若盖住画布会导致画不了
    const tip = document.getElementById('edPanTip');
    if (tip && !tip.hidden) document.getElementById('edPanTipClose').click();
    await new Promise((r) => setTimeout(r, 350));
    const tools = [...document.querySelectorAll('[data-tool]')].map((x) => x.dataset.tool);
    const pen = [...document.querySelectorAll('[data-tool]')].find((x) => x.dataset.tool === 'pen');
    if (pen) pen.click();
    await new Promise((r) => setTimeout(r, 250));
    const c = document.getElementById('edBackInk');
    const r = c.getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height, tool: pen ? pen.className : 'none', tools,
             backVisible: !document.getElementById('edBackRight').hidden };
  })()`);
  if (typeof box === 'string') { console.log('EVAL 返回错误:', box); }
  else console.log('box =', JSON.stringify(box));
  check(box && typeof box === 'object' && String(box.tool).includes('on'), `钢笔工具已选中（class=${box && box.tool}；工具集=${box && box.tools}）`);

  // 真实触摸画（20 个点，每步跳 22px 模拟快速书写）
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: Math.round(box.left + 60), y: Math.round(box.top + 80), id: 10 }] });
  for (let i = 1; i < 20; i++) {
    await wait(16);
    await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: Math.round(box.left + 60 + i * 22), y: Math.round(box.top + 80), id: 10 }] });
  }
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await wait(400);
  // 采样：整幅扫描所有含墨像素的行（笔迹实际落点受 fitView 缩放影响，不能假定固定 y）
  const ink = await ev(`(() => {
    const c = document.getElementById('edBackInk'); const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let total = 0, rows = 0, minX = 1e9, maxX = -1;
    for (let y = 0; y < c.height; y++) {
      let rowInk = 0;
      for (let x = 0; x < c.width; x++) {
        if (d[(y * c.width + x) * 4 + 3] > 100) { rowInk++; if (x < minX) minX = x; if (x > maxX) maxX = x; }
      }
      if (rowInk) { rows++; total += rowInk; }
    }
    return { ink: total, rows, minX, maxX, w: c.width, h: c.height };
  })()`);
  check(ink && ink.ink > 200, `新照片背面钢笔能正常写字（墨像素 ${ink && ink.ink}，分布在 ${ink && ink.rows} 行）`);
  check(ink && ink.rows <= 12, `笔画是一道连续细线而非散点（占 ${ink && ink.rows} 行）`);
  check(ink && ink.maxX > 150, `笔画有足够长度（横向到 x=${ink && ink.maxX}）`);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot && shot.data) fs.writeFileSync(path.join(__dirname, 'pen-on-new-back.png'), Buffer.from(shot.data, 'base64'));
  console.log(log.join('\n'));
  console.log('截图: tools/pen-on-new-back.png');
  if (errors.length) { console.log('--- 报错 ---'); errors.slice(0, 4).forEach((e) => console.log(e)); }
  console.log(errors.length || log.some((l) => l.startsWith('FAIL')) ? '\nRESULT: FAIL' : '\nRESULT: ALL PASS');
  ws.close(); chrome.kill(); process.exit(0);
})();
