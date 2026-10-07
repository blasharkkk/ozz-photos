// 用 CDP 直接跑测试页并取回结果（不依赖截图，也避开 Windows 下 stdout 重定向的坑）
// 用 file:// 直读，彻底不依赖本地 http 服务
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9224;
const FILE = path.resolve(__dirname, 'test-pen.html').replace(/\\/g, '/');
const URL_UNDER_TEST = 'file:///' + FILE;

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--window-size=920,620', 'about:blank',
], { stdio: 'ignore' });

const get = (path) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path }, (r) => {
    let d = ''; r.on('data', (c) => d += c); r.on('end', () => res(JSON.parse(d)));
  }).on('error', rej);
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let tabs = null;
  for (let i = 0; i < 40; i++) {
    try { tabs = await get('/json/list'); break; } catch (e) { await wait(250); }
  }
  if (!tabs) { console.log('无法连接 Chrome'); chrome.kill(); process.exit(1); }
  const page = tabs.find((t) => t.type === 'page');

  // 用 Node 内置的 WebSocket 直连 CDP
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  });
  await new Promise((r) => ws.addEventListener('open', r));

  await send('Page.enable');
  await send('Runtime.enable');
  // 收集页面报错，否则脚本挂了只会看到"无输出"，无从判断
  const errors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    }
  });
  await send('Page.navigate', { url: URL_UNDER_TEST });
  await wait(6000); // T6 是异步的（真实 setTimeout 驱动），要等它跑完
  const r = await send('Runtime.evaluate', {
    expression: "document.getElementById('log') ? document.getElementById('log').textContent : 'NO_LOG_ELEMENT'",
    returnByValue: true,
  });
  const val = r.result && r.result.value;
  console.log(val ? val : '(空)');
  if (errors.length) { console.log('\n--- 页面报错 ---'); errors.forEach((e) => console.log(e)); }
  // 顺手截一张，肉眼确认"棱与锋"真的画出来了（数据对 ≠ 视觉对）
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot && shot.data) {
    require('fs').writeFileSync(path.join(__dirname, 'pen-result.png'), Buffer.from(shot.data, 'base64'));
    console.log('\n截图已保存: tools/pen-result.png');
  }
  ws.close();
  chrome.kill();
  process.exit(0);
})();
