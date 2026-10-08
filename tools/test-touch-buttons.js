// v108 回归：手机/平板端编辑器按钮（完成 / 取消 / 正面·背面）触摸点击必须生效
// 根因：edRoot 上的 touchstart/touchmove 监听对 .ed-head/.ed-mode 里的所有触摸都
// preventDefault —— 而 preventDefault 在 touchstart 上会掐掉浏览器合成的 click，
// 导致这三个按钮在触摸设备上「点了没反应」。
// 本测试用页面内合成的 TouchEvent 派发到按钮，同步读取 defaultPrevented：
//   - 修复前：handler 调了 preventDefault → defaultPrevented === true（按钮无反应）
//   - 修复后：handler 对按钮放行 → defaultPrevented === false（click 正常合成）
// 另加一条真实 CDP 触摸点按「取消」按钮、验证编辑器确实关闭的端到端断言。
const { spawn } = require('child_process');
const http = require('http');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9286;
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--window-size=390,844', 'about:blank'], { stdio: 'ignore' });
const get = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(cond, msg) {
  if (cond) { console.log('  PASS ' + msg); pass++; }
  else { console.log('  FAIL ' + msg); fail++; }
}

(async () => {
  let tabs = null;
  for (let i = 0; i < 40; i++) { try { tabs = await get('/json/list'); break; } catch (e) { await wait(250); } }
  const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  const errors = [];
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
  await new Promise((r) => ws.addEventListener('open', r));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: 'http://127.0.0.1:8944/index.html?_=' + Date.now() });
  await wait(2000);
  await send('Runtime.evaluate', { expression: `(async()=>{const dbs=await indexedDB.databases?.()||[];for(const d of dbs){if(d.name)await new Promise(r=>{const q=indexedDB.deleteDatabase(d.name);q.onsuccess=q.onerror=q.onblocked=()=>r();});}localStorage.clear();})()`, awaitPromise: true });
  await send('Page.navigate', { url: 'http://127.0.0.1:8944/index.html?_=' + Date.now() });
  await wait(2200);

  const evalJs = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result.value;
  };

  // 注入一张照片，打开编辑器（不要点完成）
  await evalJs(`(async () => {
    const cv=document.createElement('canvas'); cv.width=1200; cv.height=900;
    const g=cv.getContext('2d'); const grad=g.createLinearGradient(0,0,1200,900);
    grad.addColorStop(0,'#2b3a55'); grad.addColorStop(1,'#d98b62'); g.fillStyle=grad; g.fillRect(0,0,1200,900);
    const blob=await new Promise((res)=>cv.toBlob(res,'image/jpeg',.9));
    const dt=new DataTransfer(); dt.items.add(new File([blob],'p.jpg',{type:'image/jpeg'}));
    const inp=document.getElementById('file'); inp.files=dt.files; inp.dispatchEvent(new Event('change'));
    await new Promise((r)=>setTimeout(r,600));
  })()`);
  await wait(800);

  const opened = await evalJs(`!document.getElementById('editor').hidden`);
  check(opened, '编辑器已随照片注入打开');

  // 机制测试：页面内合成 TouchEvent 派发到按钮，读取 defaultPrevented
  const mech = await evalJs(`(() => {
    function tap(idOrSel) {
      const btn = typeof idOrSel === 'string' && idOrSel.startsWith('#')
        ? document.getElementById(idOrSel.slice(1)) : document.querySelector(idOrSel);
      if (!btn) return { error: 'no ' + idOrSel };
      const r = btn.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const t = new Touch({ identifier: 1, target: btn, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y });
      const ev = new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [t], targetTouches: [t], changedTouches: [t] });
      btn.dispatchEvent(ev);
      return { prevented: ev.defaultPrevented, w: r.width, h: r.height };
    }
    return {
      done: tap('#edOk'),
      cancel: tap('#edCancel'),
      modeBack: tap('[data-mode="back"]'),
    };
  })()`);

  if (mech.error) { check(false, '机制测试执行失败: ' + mech.error); }
  else {
    console.log('  [机制] defaultPrevented →', JSON.stringify({ done: mech.done, cancel: mech.cancel, modeBack: mech.modeBack }));
    check(mech.done && mech.done.w > 0 && mech.done.prevented === false, '「完成」按钮触摸未被 preventDefault（click 可合成）');
    check(mech.cancel && mech.cancel.w > 0 && mech.cancel.prevented === false, '「取消」按钮触摸未被 preventDefault');
    check(mech.modeBack && mech.modeBack.w > 0 && mech.modeBack.prevented === false, '「② 背面创作」按钮触摸未被 preventDefault');
  }

  // 端到端：真实 CDP 触摸点按「取消」，编辑器应关闭
  // 先重新打开编辑器（上面机制测试里点背面不会关，但稳妥起见重注一张）
  if (!mech.error) {
    await evalJs(`(async () => {
      const cv=document.createElement('canvas'); cv.width=800; cv.height=1000;
      const g=cv.getContext('2d'); g.fillStyle='#345'; g.fillRect(0,0,800,1000);
      const blob=await new Promise((res)=>cv.toBlob(res,'image/jpeg',.9));
      const dt=new DataTransfer(); dt.items.add(new File([blob],'p2.jpg',{type:'image/jpeg'}));
      document.getElementById('file').files=dt.files; document.getElementById('file').dispatchEvent(new Event('change'));
      await new Promise((r)=>setTimeout(r,700));
    })()`);
    await wait(700);
    const rect = await evalJs(`(() => { const b=document.getElementById('edCancel'); const r=b.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2}; })()`);
    if (rect && rect.x) {
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: rect.x, y: rect.y }] });
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await wait(400);
      const hidden = await evalJs(`document.getElementById('editor').hidden`);
      check(hidden === true, '真实触摸点按「取消」后编辑器已关闭（click 路径在触摸下生效）');
    } else {
      check(false, '无法取得取消按钮坐标');
    }
  }

  check(errors.length === 0, '页面无 JS 异常' + (errors.length ? ' → ' + errors.join(' | ') : ''));

  console.log(`\nRESULT: ${fail === 0 ? 'PASS' : 'FAIL'}  (${pass} passed, ${fail} failed)`);
  ws.close(); chrome.kill(); process.exit(fail === 0 ? 0 : 1);
})();
