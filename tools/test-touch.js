// 端到端触摸验证：用 CDP 的 Input.dispatchTouchEvent 在**真实页面**上合成手指事件
// （Chromium 会把 touch 事件转成 PointerEvent + TouchEvent，两条链路都真跑），
// 验证 ① 钢笔在稀疏 move 下不断点 ② 双指捏合缩放/平移灵敏。file:// 直读，无需 http 服务。
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9226;
// 必须走 http：编辑器打开时要 fetch 照片素材，file:// 下 fetch 被 CORS 拦截
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
  if (!tabs) { console.log('FAIL 无法连接 Chrome'); chrome.kill(); process.exit(1); }
  const page = tabs.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params) => new Promise((res) => {
    const mid = ++id; pending.set(mid, res);
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
  await send('Page.enable'); await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: URL_UNDER_TEST });
  await wait(5000); // 等照片加载

  const ev = async (expression) => {
    // 统一解包：调用方直接拿 result.value
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) {
      console.log('EVAL_ERR:', r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return { value: r && r.result ? r.result.value : undefined };
  };

  // —— 找一张可点的照片：用 __pick 网格扫描屏幕，找到命中照片的坐标 ——
  await ev(`(() => { const c = document.querySelector('canvas'); const r = c.getBoundingClientRect();
     window.__rect = { l: r.left, t: r.top, w: r.width, h: r.height }; return 'ok'; })()`);
  const R = (await ev('window.__rect')).value;
  let hit = null;
  for (let gy = 0.2; gy <= 0.8 && !hit; gy += 0.06) {
    for (let gx = 0.2; gx <= 0.8 && !hit; gx += 0.05) {
      const x = R.l + R.w * gx, y = R.t + R.h * gy;
      // eslint-disable-next-line no-await-in-loop
      const { value } = await ev(`window.__pick(${x}, ${y})`);
      if (value >= 0) hit = { x, y };
    }
  }
  console.log('照片命中点:', hit ? `${hit.x.toFixed(0)},${hit.y.toFixed(0)}` : '未找到');
  if (!hit) { console.log('FAIL 没找到照片'); ws.close(); chrome.kill(); process.exit(1); }

  // —— 触摸双击该照片打开编辑器（应用有自定义的双轻点判定，间隔要 <900ms）——
  const tap = (x, y) => send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 1 }] })
    .then(() => send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }));
  await tap(hit.x, hit.y); await wait(80); await tap(hit.x, hit.y);
  await wait(1500); // 等编辑器打开（含图片加载）

  const { value: editorOpen } = await ev(`document.getElementById('editor') && !document.getElementById('editor').hidden ? 'open' : 'closed'`);
  console.log('编辑器状态:', editorOpen);
  if (editorOpen !== 'open') { console.log('FAIL 编辑器未打开'); ws.close(); chrome.kill(); process.exit(1); }

  // —— 切到背面创作 ——
  await ev(`(() => { const b = document.querySelector('#editor [data-mode="back"]'); b.click(); return 'ok'; })()`);
  await wait(900);
  // 关掉首次进入的平移引导条：真实用户会先点「我知道了」。
  // 它若覆盖画布，触摸会打在它身上 → 墨像素=0（曾误判为"钢笔回归"）。
  await ev(`(() => { const t = document.getElementById('edPanTip'); if (t && !t.hidden) document.getElementById('edPanTipClose').click(); return 'ok'; })()`);
  await wait(400);
  // 轮询等背面画布真正就绪：initBack 要等 edImg 加载完成，
  // 而触摸双击进的是「示例照片重新编辑」路径，图片可能还在解码 → 固定等待会偶发拿不到画布。
  for (let k = 0; k < 30; k++) {
    const ready = await ev(`(() => { const c = document.getElementById('edBackInk');
      return c && c.width > 100 && c.getBoundingClientRect().width > 10 ? 1 : 0; })()`);
    if (ready === 1) break;
    await wait(200);
  }
  await wait(300);

  // —— 取背面画布位置 ——
  await ev(`(() => { const c = document.getElementById('edBackInk'); const r = c.getBoundingClientRect();
     window.__bx = r.left; window.__by = r.top; window.__bw = r.width; window.__bh = r.height; return 'ok'; })()`);
  const bx = (await ev('window.__bx')).value, by = (await ev('window.__by')).value;

  // —— 测试 A：钢笔稀疏事件（每 move 跳 22px，模拟 iPad 快速书写）——
  // 先选钢笔工具
  await ev(`(() => { const b = [...document.querySelectorAll('#editor [data-tool]')].find((x) => x.dataset.tool === 'pen'); if (b) b.click(); return 'ok'; })()`);
  await wait(200);
  const drag = async (pts, idBase) => {
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pts[0][0], y: pts[0][1], id: idBase }] });
    for (let i = 1; i < pts.length; i++) {
      await wait(16); // 60Hz
      await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: pts[i][0], y: pts[i][1], id: idBase }] });
    }
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const pts = Array.from({ length: 20 }, (_, i) => [bx + 60 + i * 22, by + 80]); // 20 个点，间距 22px
  await drag(pts, 10);
  await wait(300);

  // 断言 A：笔迹必须连续无断点。
  // 不用「固定行定点扫描」——画布经 fitView 缩放平移后，屏幕坐标 ≠ 画布坐标，
  // 且画布可能被平移到可视区外（top 为负），定点采样会落到空白处误判"钢笔失效"（曾发生）。
  // 改为整幅扫描：统计所有含墨像素的分布，沿笔迹方向逐格检查有无空缺。
  const a = await ev(`(() => {
    const c = document.getElementById('edBackInk');
    const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let total = 0, minX = 1e9, maxX = -1, minY = 1e9, maxY = -1;
    const colInk = new Int32Array(c.width);
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        if (d[(y * c.width + x) * 4 + 3] > 100) {
          total++; colInk[x]++;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    // 断点检测：在笔迹横跨的列范围内，统计「有墨列」是否连成一片
    let gaps = 0, seen = false;
    for (let x = minX; x <= maxX; x++) {
      if (colInk[x] > 0) { seen = true; }
      else if (seen) gaps++;
    }
    const r = c.getBoundingClientRect();
    return { ink: total, gaps, minX, maxX, minY, maxY, cw: c.width, ch: c.height,
             rw: Math.round(r.width), rh: Math.round(r.height), rt: Math.round(r.top) };
  })()`);
  const v = a.value;
  console.log(`  [诊断] 画布 ${v.cw}x${v.ch} 显示 ${v.rw}x${v.rh} top=${v.rt} 笔迹区 x=${v.minX}~${v.maxX} y=${v.minY}~${v.maxY}`);
  console.log(`A 钢笔稀疏事件: 墨像素=${v.ink} 断段=${v.gaps} 跨度=${v.maxX - v.minX}px → ${v.ink > 200 && v.gaps <= 2 && (v.maxX - v.minX) > 150 ? 'PASS 实线连续' : 'FAIL 仍断点'}`);

  // —— 测试 B：双指捏合缩放 ——
  await ev(`(() => { const c = document.getElementById('edBackInk'); const r = c.getBoundingClientRect();
     window.__z0 = parseFloat(document.getElementById('edZoomVal').textContent); return 'ok'; })()`);
  const z0 = (await ev('window.__z0')).value;
  const mx = bx + 300, my = by + 200;
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: mx - 60, y: my, id: 21 }, { x: mx + 60, y: my, id: 22 }] });
  for (let i = 1; i <= 10; i++) {
    await wait(16);
    await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [
      { x: mx - 60 - i * 9, y: my, id: 21 }, { x: mx + 60 + i * 9, y: my, id: 22 } // 每帧外扩 18px
    ] });
  }
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await wait(300);
  const z1 = parseFloat((await ev(`document.getElementById('edZoomVal').textContent`)).value);
  console.log(`B 双指外扩捏合: ${z0}% → ${z1}% → ${z1 > z0 * 1.25 ? 'PASS 缩放灵敏' : 'FAIL 响应不足'}`);

  // —— 测试 C：双指平移 ——
  const t0 = (await ev(`(() => { const w = document.getElementById('edBackWorld');
     const m = new DOMMatrixReadOnly(getComputedStyle(w).transform); return [m.m41, m.m42].join(','); })()`)).value;
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: mx - 40, y: my - 20, id: 31 }, { x: mx + 40, y: my - 20, id: 32 }] });
  for (let i = 1; i <= 10; i++) {
    await wait(16);
    await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [
      { x: mx - 40 + i * 7, y: my - 20 + i * 4, id: 31 }, { x: mx + 40 + i * 7, y: my - 20 + i * 4, id: 32 } // 整体右移 7px/帧
    ] });
  }
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await wait(300);
  const t1 = (await ev(`(() => { const w = document.getElementById('edBackWorld');
     const m = new DOMMatrixReadOnly(getComputedStyle(w).transform); return [m.m41, m.m42].join(','); })()`)).value;
  const [x0, y0] = t0.split(',').map(Number), [x1, y1] = t1.split(',').map(Number);
  const dx = x1 - x0, dy = y1 - y0;
  console.log(`C 双指平移: (${x0.toFixed(0)},${y0.toFixed(0)}) → (${x1.toFixed(0)},${y1.toFixed(0)}) 位移=${Math.hypot(dx, dy).toFixed(0)}px → ${Math.hypot(dx, dy) > 40 ? 'PASS 平移跟手' : 'FAIL 几乎没反应'}`);

  if (errors.length) { console.log('\n--- 页面报错 ---'); errors.forEach((e) => console.log(e)); }
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot && shot.data) require('fs').writeFileSync(path.join(__dirname, 'touch-result.png'), Buffer.from(shot.data, 'base64'));
  ws.close(); chrome.kill(); process.exit(0);
})().catch((e) => { console.error('RIG_FAIL', e); process.exit(1); });
