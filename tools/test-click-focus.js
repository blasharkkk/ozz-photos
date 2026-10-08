// v115 回归：单击语义按「是否放大居中」区分——
//   远距离（总览态）单击照片 → 聚焦（飞入居中、正面朝前）；
//   已放大居中的照片再单击 → 翻转看背面（翻转交给再次单击，按钮仍可用）；
//   缩放守卫：即便之前选中过某张，只要回到总览态单击它就不会误翻，而是重新聚焦；
//   导入新照片后自动聚焦它；远距单击背面朝外的照片→翻回正面并聚焦。
// 铁律：静态站点必须跑在 8944；禁用缓存；每个用例前复位。
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
  const click = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const wheel = async (dy) => { await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 600, y: 400, deltaX: 0, deltaY: dy, button: 'none' }); };
  const nav = async () => { await send('Page.navigate', { url: 'http://127.0.0.1:8944/index.html?_=' + Date.now() }); await wait(2600); };
  const cam = async () => await ev('window.__camState()');
  const waitCam = async (ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const c = await cam(); if (c && Math.abs(c.dist - c.goalDist) < 0.15) return c; await wait(120); } return await cam(); };
  const screenOf = async (i) => await ev(`(window.__pc.sheetScreen(${i})||[]).map(n=>Math.round(n))`);
  const flipped = async (i) => await ev(`window.__pc.sheets[${i}].flipped`);
  const sel = async () => await ev(`window.__pc.getSel()`);

  await nav();
  await ev(`(async()=>{const dbs=await indexedDB.databases?.()||[];for(const d of dbs){if(d.name)await new Promise(r=>{const q=indexedDB.deleteDatabase(d.name);q.onsuccess=q.onerror=q.onblocked=()=>r();});}localStorage.clear();})()`);
  await nav();
  const base = await ev(`window.__photos().length`);
  check(base > 0, `基础示例照片已加载（${base} 张）`);

  // 选一张在总览态下确实在屏幕内、可点的照片作为「远距照片」
  const pickVisible = async (exclude) => {
    for (let i = 0; i < base; i++) {
      if (exclude != null && i === exclude) continue;
      const sc = await screenOf(i);
      if (sc && sc.length === 2 && sc[0] > 30 && sc[0] < 1170 && sc[1] > 30 && sc[1] < 770) return i;
    }
    return -1;
  };

  // —— 用例 A：远距离（总览）单击照片 → 聚焦，不翻面 ——
  const farIdx = await pickVisible(-1);
  check(farIdx >= 0, `找到一张总览态可见的照片（idx=${farIdx}）`);
  const scA = await screenOf(farIdx);
  await click(scA[0], scA[1]);
  await wait(400);
  const selA = await sel(), flipA = await flipped(farIdx);
  check(selA === farIdx, `远距离单击 → 聚焦该照片（sel=${selA}，期望 ${farIdx}）`);
  check(flipA === false, `远距离单击不会翻面（flipped=${flipA}）`);

  // —— 用例 B：已放大居中后再次单击 → 翻转看背面 ——
  const target = Math.min(5, base - 1);
  await ev(`window.__pc.select(${target})`);
  const cB = await waitCam();
  check(cB.dist < 8.5, `聚焦后已放大居中（cam.dist=${cB.dist.toFixed(2)} < 8.5）`);
  const selB0 = await sel();
  check(selB0 === target, `聚焦目标照片（sel=${selB0}，期望 ${target}）`);
  const scB = await screenOf(target);
  await click(scB[0], scB[1]);
  await wait(700);
  const selB1 = await sel(), flipB = await flipped(target);
  check(selB1 === target, `居中后单击仍停留在该照片（sel=${selB1}）`);
  check(flipB === true, `居中后单击 → 翻转看背面（flipped=${flipB}）`);

  // —— 用例 C：再单击一次 → 翻回正面（同一张可反复切换）——
  await click(scB[0], scB[1]);
  await wait(700);
  const flipC = await flipped(target);
  check(flipC === false, `再单击 → 翻回正面（flipped=${flipC}）`);

  // —— 用例 D：缩放守卫——回到总览态后单击之前选中的照片，不应翻面，而是重新聚焦 ——
  for (let k = 0; k < 10; k++) { await wheel(360); await wait(120); }
  const cD = await waitCam();
  check(cD.dist > 8.5, `已缩回总览态（cam.dist=${cD.dist.toFixed(2)} > 8.5）`);
  const scD = await screenOf(target);
  await click(scD[0], scD[1]);
  await wait(700);
  const flipD = await flipped(target), selD = await sel();
  check(flipD === false, `总览态单击选中过的照片不误翻（flipped=${flipD}）`);
  check(selD === target, `总览态单击 → 重新聚焦该照片（sel=${selD}）`);

  // 复位到总览
  await ev(`window.__pc.select(-1)`);
  await waitCam();

  // —— 用例 E：导入新照片后自动聚焦到它（sel=新索引，正面朝外）——
  await ev(`(async()=>{const cv=document.createElement('canvas');cv.width=1200;cv.height=900;const g=cv.getContext('2d');g.fillStyle='#2b4a7a';g.fillRect(0,0,1200,900);const blob=await new Promise(r=>cv.toBlob(r,'image/jpeg',.9));const dt=new DataTransfer();dt.items.add(new File([blob],'p.jpg',{type:'image/jpeg'}));const i=document.getElementById('file');i.files=dt.files;i.dispatchEvent(new Event('change'));await new Promise(r=>setTimeout(r,700));})()`);
  await wait(900);
  await ev(`document.getElementById('edOk').click()`);
  await wait(2500);
  const after = await ev(`window.__photos().length`);
  const selE = await sel(), newIdx = base, flipE = await flipped(newIdx);
  check(after === base + 1, `导入后照片 = ${base} + 1（实测 ${after}）`);
  check(selE === newIdx, `导入后自动聚焦到新照片（sel=${selE}，期望 ${newIdx}）`);
  check(flipE === false, `导入的新照片正面朝外（flipped=${flipE}）`);

  // 复位到总览
  await ev(`window.__pc.select(-1)`);
  await waitCam();

  // —— 用例 F：远距单击「背面朝外」的照片 → 翻回正面并聚焦（而非翻到更背面）——
  const ff = await pickVisible(-1);
  await ev(`window.__pc.flipSheet(${ff})`); // 先把它翻到背面
  await wait(700);
  const flipF0 = await flipped(ff);
  const scF = await screenOf(ff);
  await click(scF[0], scF[1]);
  await wait(700);
  const flipF1 = await flipped(ff), selF = await sel();
  check(flipF0 === true, `已先把该照片翻到背面（flipped=${flipF0}）`);
  check(flipF1 === false, `远距单击背面照片 → 翻回正面聚焦（flipped: ${flipF0} → ${flipF1}）`);
  check(selF === ff, `远距单击背面照片 → 聚焦它（sel=${selF}，期望 ${ff}）`);

  console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
  ws.close(); chrome.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); chrome.kill(); process.exit(2); });
