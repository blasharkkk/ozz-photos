// v110 回归：导出分享版必须成功（v109 及之前版本号炸掉了导出）
// 根因：exportReadOnly 用**精确字符串** '<link rel="stylesheet" href="style.css">'
// 定位内联替换点。v106 起引用带缓存版本号（style.css?v=110），精确匹配落空 →
// 抛「页面结构与预期不符（找不到 style.css 或 main.js 的引用标签）」。
// 修法：检查与替换都改用宽松正则 /<link rel="stylesheet" href="style\.css[^"]*">/，
// 与 main.js 标签的既有写法对齐。
// 本测试端到端走真实导出流程：注入照片 → 完成 → 点导出 → 命名弹窗确认 →
// 等 window.__lastExport 出现，断言产物已内联 CSS/JS/数据。
// 反向验证：确认线上 index.html 里是带 ?v= 的标签（旧精确匹配必然落空），
// 即本测试在旧代码下必然报错——断言对根因敏感。
const { spawn } = require('child_process');
const http = require('http');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9296;
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--window-size=1200,800', 'about:blank'], { stdio: 'ignore' });
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
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r));
  await send('Page.enable'); await send('Runtime.enable');
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

  // —— 反向验证前置：服务端 index.html 是带版本号的标签，旧精确匹配必然落空 ——
  const served = await evalJs(`fetch('index.html').then(r => r.text())`);
  check(/<link rel="stylesheet" href="style\.css\?v=\d+">/.test(served),
    '服务端 index.html 的 CSS 引用带版本号（?v=）→ 旧精确匹配代码必然失败，断言对根因敏感');
  check(!served.includes('<link rel="stylesheet" href="style.css">'),
    '服务端 index.html 不存在旧精确匹配的裸标签（确认环境确实会触发旧 bug）');

  // —— 注入一张照片（编辑器自动打开）→ 点「完成」提交 ——
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
  const editorOpen = await evalJs(`!document.getElementById('editor').hidden`);
  check(editorOpen, '照片已注入、编辑器已打开');
  await evalJs(`document.getElementById('edOk').click()`);
  await wait(600);
  const editorClosed = await evalJs(`document.getElementById('editor').hidden`);
  check(editorClosed, '「完成」已提交、编辑器已关闭');

  // —— v116 端到端：独立导出按钮已移除，分享统一走「💾 保存 → 📁 我的作品 → 某作品 → 分享」——
  await evalJs(`document.getElementById('saveBtn').click()`);
  await wait(400);
  const dlgShown = await evalJs(`!document.getElementById('nameDlg').hidden`);
  check(dlgShown, '「💾 保存」弹出命名弹窗');
  await evalJs(`(() => { const i = document.getElementById('nameInput'); i.value = '回归测试作品'; document.getElementById('nameOk').click(); })()`);
  await wait(1200);
  await evalJs(`document.getElementById('worksBtn').click()`);
  await wait(400);
  const draftShared = await evalJs(`(() => { const b = document.querySelector('.draft-item .draft-acts button:nth-child(2)'); if (!b) return false; window.__lastExport = null; b.click(); return true; })()`);
  check(draftShared, '草稿箱中该作品的「分享」按钮存在并已点击');
  // 轮询导出结果（照片 base64 转换可能要几秒）
  let exp = null;
  for (let i = 0; i < 30; i++) {
    await wait(500);
    exp = await evalJs(`(() => { const e = window.__lastExport; return e ? { size: e.size, name: e.name, htmlLen: e.html.length } : null; })()`);
    if (exp) break;
  }
  check(!!exp, `分享成功、__lastExport 已生成（${exp ? (exp.size / 1024 / 1024).toFixed(1) + ' MB' : '超时未出现'}）`);
  if (exp) check(exp.name === '回归测试作品', `作品名来自保存时的命名（实际「${exp.name}」）`);

  // —— 产物内容断言：在页面内部检查大字符串，只回传布尔（6.8MB 传回 Node 会丢输出）——
  const prodChecks = await evalJs(`(() => {
    const html = window.__lastExport ? window.__lastExport.html : '';
    return {
      hasData: html.includes('window.__PC_DATA__='),
      hasStyle: html.includes('<style>'),
      // 注意不能查裸的 '<link rel="stylesheet"'：内联的 main.js 源码里就有这个字符串（导出正则本身）
      noCssLink: !html.includes('href="style.css'),
      noJsLink: !/<script type="module" src="main\\.js/.test(html),
      hasInlineJs: html.includes('exportReadOnly') || html.includes('addPhoto'),
      toast: (() => { const t = document.querySelector('.toast'); return t ? t.textContent : ''; })(),
    };
  })()`);
  check(prodChecks.hasData, '产物含 __PC_DATA__ 数据注入');
  check(prodChecks.hasStyle, '产物已把 CSS 内联为 <style> 块');
  check(prodChecks.noCssLink, '产物无残留的 style.css 外链标签');
  check(prodChecks.noJsLink, '产物无残留的 main.js 外链标签');
  check(prodChecks.hasInlineJs, '产物含内联后的 main.js 源码');
  check(!/导出失败/.test(prodChecks.toast || ''), `toast 无「导出失败」（实际「${(prodChecks.toast || '').slice(0, 40)}」）`);

  console.log(`\\n结果：${pass} PASS / ${fail} FAIL`);
  ws.close(); chrome.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); chrome.kill(); process.exit(2); });
