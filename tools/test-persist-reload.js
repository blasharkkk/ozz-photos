// v113 回归：刷新/重开页面后，用户的照片必须还在（这条以前从未被测过，
// 因此潜伏了一个致命 bug：var 声明的 DB_NAME/STORE 在启动读取时尚未赋值 → undefined，
// 启动时IndexedDB 读取必然失败，被localStorage 兜底长期掩盖 → 照片"刷新即消失"）。
// 本测试：注入照片 → 等自动保存 → 连续刷新 3 次，每次都断言照片仍在。
const { spawn } = require('child_process');
const http = require('http');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9303;
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
  let id = 0; const pend = new Map();
  const send = (m, p) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
  const ev = async (e) => { const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description }; return r.result.value; };
  const nav = async () => { await send('Page.navigate', { url: 'http://127.0.0.1:8944/index.html?_=' + Date.now() }); await wait(2600); };

  await nav();
  await ev(`(async()=>{const dbs=await indexedDB.databases?.()||[];for(const d of dbs){if(d.name)await new Promise(r=>{const q=indexedDB.deleteDatabase(d.name);q.onsuccess=q.onerror=q.onblocked=()=>r();});}localStorage.clear();})()`);
  await nav();
  const base = await ev(`window.__photos().length`);
  check(base > 0, `基础示例照片已加载（${base} 张）`);

  await ev(`(async()=>{const cv=document.createElement('canvas');cv.width=1200;cv.height=900;const g=cv.getContext('2d');g.fillStyle='#2b4a7a';g.fillRect(0,0,1200,900);const blob=await new Promise(r=>cv.toBlob(r,'image/jpeg',.9));const dt=new DataTransfer();dt.items.add(new File([blob],'p.jpg',{type:'image/jpeg'}));const i=document.getElementById('file');i.files=dt.files;i.dispatchEvent(new Event('change'));await new Promise(r=>setTimeout(r,700));})()`);
  await wait(900);
  await ev(`document.getElementById('edOk').click()`);
  await wait(2500);
  const after = await ev(`window.__photos().length`);
  check(after === base + 1, `注入后照片 = 基础 ${base} + 1（实测 ${after}）`);

  // 连续刷新 3 次，每次都必须恢复到 base+1
  for (let k = 1; k <= 3; k++) {
    await nav();
    const n = await ev(`window.__photos() ? window.__photos().length : -1`);
    const lastSrc = await ev(`window.__photos ? (window.__photos().slice(-1)[0]?.src || '').slice(0, 15) : ''`);
    check(n === base + 1, `第 ${k} 次刷新后照片仍为 ${base + 1} 张（实测 ${n}）`);
    check(String(lastSrc).startsWith('data:'), `第 ${k} 次刷新后最后一张仍是用户上传的数据图（实测 "${lastSrc}"）`);
  }

  // 当前作品应真实落在 IndexedDB 里（而非 localStorage 兜底）
  const inIdb = await ev(`(async()=>{const v=await window.__drafts.storeGet('papercloud.v1');return v&&v.added?v.added.length:-1;})()`);
  check(inIdb === 1, `IndexedDB 中存有 1 张用户照片（实测 ${inIdb}）`);
  const noMirror = await ev(`(()=>{try{return (localStorage.getItem('papercloud.v1')||'').length;}catch(e){return -1;}})()`);
  check(noMirror === 0, `localStorage 不再镜像照片数据（实测 ${noMirror} 字节）`);

  console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
  ws.close(); chrome.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); chrome.kill(); process.exit(2); });