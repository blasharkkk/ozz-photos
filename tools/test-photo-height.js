// 用户新添加照片的**挂高随机性 + 空位优先**回归（v107）
//
// 用户实测反馈（配截图）：「在不同层次，但是每次新加的照片都是在同一高度，
// 也就是距离天花板的高度一致！我想要的是随机高度，优先往比较空的位置放」。
//
// ⚠️ 曾经的 bug：addPhoto 里硬编码 `s.y = 2.4`，把 makeSheet 精心算好的
//   随机高度直接覆盖掉 → 每张新照片都挂在同一水平线。
//   动机是"随机到 4.55 会让照片死贴天花板"，但那是把「别贴天花板」
//   误当成「钉死一个高度」来解决的，矫枉过正。
//
// 修法：把高度区间作为参数传进 makeSheet，让"随机高度"与"空位优先"
// （30 次候选里挑最空的）在**同一次搜索内**完成 —— 不能选完再夹 y，
// 那会把基于候选 y 算出的空位优化破坏掉。
const { spawn } = require('child_process');
const http = require('http');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9284;
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--window-size=1240,1000', 'about:blank'], { stdio: 'ignore' });
const get = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let d = ''; r.on('data', (c) => d += c); r.on('end', () => res(JSON.parse(d)));
  }).on('error', rej);
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = []; const check = (ok, m) => { log.push((ok ? 'PASS ' : 'FAIL ') + m); };

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
  await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
  const url = 'http://127.0.0.1:8944/index.html?_=' + Date.now();
  await send('Page.navigate', { url }); await wait(2000);
  // ⚠️ 必须清空存储从空白云开始：示例照片会占位，影响"空位优先"的判断
  await send('Runtime.evaluate', { expression: `(async()=>{const dbs=await indexedDB.databases?.()||[];for(const d of dbs){if(d.name)await new Promise(r=>{const q=indexedDB.deleteDatabase(d.name);q.onsuccess=q.onerror=q.onblocked=()=>r();});}localStorage.clear();})()`, awaitPromise: true });
  await send('Page.navigate', { url }); await wait(2200);
  const evalJs = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result.value;
  };

  const N = 10;
  for (let i = 0; i < N; i++) {
    await evalJs(`(async()=>{try{
      const cv=document.createElement('canvas');cv.width=1400;cv.height=${i % 2 ? 900 : 1200};
      const g=cv.getContext('2d');const gr=g.createLinearGradient(0,0,1400,900);
      gr.addColorStop(0,'#2b3a55');gr.addColorStop(1,'#d98b62');g.fillStyle=gr;g.fillRect(0,0,1400,900);
      g.fillStyle='#f2f6fb';g.fillRect(200,500,900,220);
      const blob=await new Promise(r=>cv.toBlob(r,'image/jpeg',.9));
      const dt=new DataTransfer();dt.items.add(new File([blob],'p.jpg',{type:'image/jpeg'}));
      const inp=document.getElementById('file');inp.files=dt.files;inp.dispatchEvent(new Event('change'));
      await new Promise(r=>setTimeout(r,380));
      document.getElementById('edOk').click();await new Promise(r=>setTimeout(r,380));
    }catch(e){}})()`);
  }
  await wait(900);

  // ⚠️ __sheetList 不含 x/y/z，坐标要另外从 __sheetPos 取（两者按索引一一对应）
  const dump = await evalJs(`(()=>{
    const list = window.__sheetList(); const pos = window.__sheetPos(); const ph = window.__photos();
    if(!list || !pos) return {error:'调试出口不可用'};
    return { sheets: list.map((s,i)=>({
      x:pos[i].x, y:pos[i].y, z:pos[i].z, w:s.w, h:s.h, study:s.study,
      user: !!ph[s.photo] && String(ph[s.photo].id||'').startsWith('u') })) };
  })()`);
  if (dump.error || !dump.sheets) { console.log('读取失败:', JSON.stringify(dump)); process.exit(1); }
  const added = dump.sheets.filter((s) => !s.study && s.user);
  check(added.length === N, `${N} 张照片全部挂入（实际 ${added.length}）`);

  // 1) 核心：高度必须有差异（旧代码全部等于 2.4，差异 = 0）
  const ys = added.map((s) => s.y);
  const uniqY = new Set(ys.map((y) => y.toFixed(3)));
  console.log(`  高度(y)：${ys.map((y) => y.toFixed(2)).join(' ')}`);
  console.log(`  不同高度取值：${uniqY.size}/${ys.length}`);
  check(uniqY.size >= N - 1, `每张照片高度都不同（${uniqY.size}/${N} 个不同值；旧代码是 1/${N}）`);

  // 2) 高度要有足够跨度（不能只是 2.39/2.40/2.41 的微抖）
  const ySpan = Math.max(...ys) - Math.min(...ys);
  check(ySpan > 1.0, `高度跨度 > 1.0（实际 ${ySpan.toFixed(3)}，区间 ${Math.min(...ys).toFixed(2)}~${Math.max(...ys).toFixed(2)}）`);

  // 3) 不能贴天花板（这是当年钉死 2.4 的原始动机，必须一并守住）
  const RH = 5.4;
  const maxTop = Math.max(...added.map((s) => s.y + s.h / 2));
  check(maxTop < RH - 0.5, `最高纸片顶边离天花板有余量（顶边 ${maxTop.toFixed(2)} < ${(RH - 0.5).toFixed(1)}）`);

  // 4) 不能沉到底部以下
  check(Math.min(...ys) > 1.0, `最低纸片中心高于 1.0（实际 ${Math.min(...ys).toFixed(2)}）`);

  // 5) 空位优先：新照片与已有纸片的最小间距不应小于它"能拿到的最好成绩"太多
  //    这里量化成"两两间距不应全部一样小"——若都挤在一起则说明没做空位优化
  let minGap = Infinity;
  for (let i = 0; i < added.length; i++)
    for (let j = i + 1; j < added.length; j++)
      minGap = Math.min(minGap, Math.hypot(added[i].x - added[j].x, added[i].y - added[j].y, added[i].z - added[j].z));
  console.log(`  用户照片两两最小间距：${minGap.toFixed(3)}`);
  check(minGap > 0.35, `照片之间留有空隙，未挤成一团（最小间距 ${minGap.toFixed(3)}）`);

  // 6) 尺寸已按用户要求还原回原来的区间（v106 放宽后用户反馈"大的吓人"）
  const hs = added.map((s) => s.h), ws_ = added.map((s) => s.w);
  check(Math.max(...hs) <= 0.81, `纸片高度已还原（最大 ${Math.max(...hs).toFixed(3)} ≤ 0.80）`);
  check(Math.max(...ws_) <= 0.81, `纸片宽度已还原（最大 ${Math.max(...ws_).toFixed(3)} ≤ 0.80）`);

  check(errors.length === 0, `页面零异常${errors.length ? '：' + errors[0] : ''}`);

  console.log('\n===== test-photo-height =====');
  log.forEach((l) => console.log(l));
  console.log(log.some((l) => l.includes('FAIL')) ? 'RESULT: FAIL' : 'RESULT: ALL PASS');
  ws.close(); chrome.kill(); process.exit(0);
})();
