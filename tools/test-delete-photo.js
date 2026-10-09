// v116 回归：删除照片功能 + 聚焦栏符号化
// 背景：用户新增「删除照片」——聚焦自己添加的照片时，底栏出现 🗑 删除（带确认）；
//       说明文字「你添加的照片 / 你」对用户照片隐藏；示例照片不提供删除（用顶栏 ↺ 重置）。
// 本测试端到端：注入照片 → 聚焦 → 断言删除按钮与文案可见性 → 点删除（确认） →
//       照片数回落、持久层同步（刷新后仍是删除状态）。
const { spawn } = require('child_process');
const http = require('http');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9305;
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
  // confirm 全部放行并计数（删除会弹确认）
  await ev(`window.__confirmHits = 0; window.confirm = (...a) => { window.__confirmHits++; return true; };`);
  const base = await ev(`window.__photos().length`);
  check(base > 0, `基础示例照片已加载（${base} 张）`);

  // —— 注入一张照片 ——
  await ev(`(async()=>{const cv=document.createElement('canvas');cv.width=1200;cv.height=900;const g=cv.getContext('2d');g.fillStyle='#7a3b2b';g.fillRect(0,0,1200,900);const blob=await new Promise(r=>cv.toBlob(r,'image/jpeg',.9));const dt=new DataTransfer();dt.items.add(new File([blob],'p.jpg',{type:'image/jpeg'}));const i=document.getElementById('file');i.files=dt.files;i.dispatchEvent(new Event('change'));await new Promise(r=>setTimeout(r,700));})()`);
  await wait(900);
  await ev(`document.getElementById('edOk').click()`);
  await wait(2500);
  const after = await ev(`window.__photos().length`);
  check(after === base + 1, `注入后照片 = 基础 ${base} + 1（实测 ${after}）`);

  // —— 聚焦自己添加的照片：删除按钮出现、说明文字隐藏 ——
  await ev(`window.__pc.select(window.__pc.sheets.length - 1)`);
  await wait(600);
  const capUser = await ev(`(() => {
    const cap = document.getElementById('caption'), del = document.getElementById('delBtn'), txt = document.getElementById('capText');
    return { capHidden: cap.hidden, delHidden: del.hidden, txtDisplay: getComputedStyle(txt).display, title: document.getElementById('title').textContent };
  })()`);
  check(!capUser.capHidden, '聚焦用户照片时说明栏可见');
  check(!capUser.delHidden, '聚焦用户照片时 🗑 删除按钮可见');
  check(capUser.txtDisplay === 'none', `用户照片不显示「你添加的照片」文字（display=${capUser.txtDisplay}）`);

  // —— 聚焦示例照片：删除按钮隐藏、文字说明显示 ——
  await ev(`window.__pc.select(0)`);
  await wait(400);
  const capEx = await ev(`(() => ({ delHidden: document.getElementById('delBtn').hidden, txtDisplay: getComputedStyle(document.getElementById('capText')).display }))()`);
  check(capEx.delHidden, '示例照片不显示删除按钮（清空场景用顶栏 ↺ 重置）');
  check(capEx.txtDisplay !== 'none', '示例照片保留标题/作者文字说明');
  await ev(`window.__pc.select(window.__pc.sheets.length - 1)`);
  await wait(400);

  // —— 点 🗑 → 确认 → 照片删除、退回全景、持久层同步 ——
  await ev(`document.getElementById('delBtn').click()`);
  await wait(1200);
  const confirms = await ev(`window.__confirmHits`);
  check(confirms >= 1, `删除前弹出了确认（confirm 调用 ${confirms} 次）`);
  const afterDel = await ev(`window.__photos().length`);
  check(afterDel === base, `删除后照片回到基础 ${base} 张（实测 ${afterDel}）`);
  const capGone = await ev(`document.getElementById('caption').hidden`);
  check(!!capGone, '删除聚焦中的照片后自动退回全景（说明栏隐藏）');
  const sheetsOk = await ev(`window.__pc.sheets.length`);
  check(sheetsOk === base || sheetsOk === base + 1, `纸片数与照片数一致（sheets=${sheetsOk}，示例纸片可能含特写）`);

  // —— 持久化：刷新后仍是 base 张（删除已写回 IndexedDB）——
  await nav();
  const afterReload = await ev(`window.__photos() ? window.__photos().length : -1`);
  check(afterReload === base, `刷新后仍是 ${base} 张（删除已持久化，实测 ${afterReload}）`);
  const idbAdded = await ev(`(async()=>{const v=await window.__drafts.storeGet('papercloud.v1');return v&&v.added?v.added.length:-1;})()`);
  check(idbAdded === 0, `IndexedDB 中用户照片已清空（实测 ${idbAdded}）`);

  console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
  ws.close(); chrome.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); chrome.kill(); process.exit(2); });
