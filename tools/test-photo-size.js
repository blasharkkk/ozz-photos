// 用户照片纸片**尺寸**回归
//
// ⚠️ 历史说明（重要，别再走回头路）：
//   v106 曾把高度区间从 .55~.80 放宽到 .40~.00、宽度上限提到 1.05，
//   目的是让"每张照片大小不一样"。用户实测后反馈**「有的照片大的吓人了」**——
//   云里已有 30 张示例照片，再放大镜般的新照片会压住整片云。
//   → v107 已按用户要求**还原**为 .55~.80 / 宽 .32~.8。
//
//   用户真正要的是**挂高随机 + 优先空位**（照片与天花板的距离），
//   那个由 tools/test-photo-height.js 负责测，本文件只守"尺寸别再乱放大"。
//
//   所以本测试断言的是「尺寸落在原有区间内」，**不是**「尺寸差异要大」。
const { spawn } = require('child_process');
const http = require('http');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9283;
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
  // 清空存储，保证从空白云开始（示例照片不参与统计）
  await send('Runtime.evaluate', { expression: `(async()=>{const dbs=await indexedDB.databases?.()||[];for(const d of dbs){if(d.name)await new Promise(r=>{const q=indexedDB.deleteDatabase(d.name);q.onsuccess=q.onerror=q.onblocked=()=>r();});}localStorage.clear();})()`, awaitPromise: true });
  await send('Page.navigate', { url }); await wait(2200);
  const evalJs = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result.value;
  };

  // 12 张**不同宽高比**的照片，覆盖手机竖拍/方图/横拍/全景
  const ratios = [[1600,1000],[900,1200],[1400,1400],[1200,700],[1000,1500],[2000,900],
                  [800,800],[1500,1000],[1100,1300],[1700,1100],[950,1000],[1300,950]];
  let injected = 0;
  for (const [w, h] of ratios) {
    const r = await evalJs(`(async()=>{try{
      const cv=document.createElement('canvas');cv.width=${w};cv.height=${h};
      const g=cv.getContext('2d');const gr=g.createLinearGradient(0,0,${w},${h});
      gr.addColorStop(0,'#2b3a55');gr.addColorStop(1,'#d98b62');g.fillStyle=gr;g.fillRect(0,0,${w},${h});
      g.fillStyle='#f2f6fb';g.fillRect(0,${(h * 0.6) | 0},${w},${(h * 0.25) | 0});
      const blob=await new Promise(r=>cv.toBlob(r,'image/jpeg',.9));
      const dt=new DataTransfer();dt.items.add(new File([blob],'p.jpg',{type:'image/jpeg'}));
      const inp=document.getElementById('file');inp.files=dt.files;inp.dispatchEvent(new Event('change'));
      await new Promise(r=>setTimeout(r,400));
      document.getElementById('edOk').click();await new Promise(r=>setTimeout(r,400));
      return 'ok';}catch(e){return 'err';}})()`);
    if (r === 'ok') injected++;
  }
  check(injected === ratios.length, `12 张照片全部注入成功（实际 ${injected}）`);
  await wait(700);

  const dump = await evalJs(`(()=>{
    const list = window.__sheetList(); const ph = window.__photos();
    if(!list) return {error:'__sheetList 不可用'};
    return { sheets: list.map(s=>({w:s.w, h:s.h, study:s.study,
      user: !!ph[s.photo] && String(ph[s.photo].id||'').startsWith('u'),
      ap: ph[s.photo] ? ph[s.photo].aspect : null, crop: s.crop })) };
  })()`);
  if (dump.error || !dump.sheets) { console.log('读取失败:', JSON.stringify(dump)); process.exit(1); }
  const added = dump.sheets.filter((s) => !s.study && s.user);
  check(added.length === ratios.length, `用户照片纸片数 = ${ratios.length}（实际 ${added.length}）`);

  // 1) 尺寸必须落在**原有区间**内（v106 放宽到 .40~1.00 后用户反馈"大的吓人"，已还原）
  const hs = added.map((s) => s.h), ws_ = added.map((s) => s.w);
  console.log(`  高度区间 ${Math.min(...hs).toFixed(3)} ~ ${Math.max(...hs).toFixed(3)}`);
  console.log(`  宽度区间 ${Math.min(...ws_).toFixed(3)} ~ ${Math.max(...ws_).toFixed(3)}`);
  check(Math.min(...hs) >= 0.30, `纸片高度 ≥ 0.30（实际 ${Math.min(...hs).toFixed(3)}）`);
  check(Math.max(...hs) <= 0.81, `纸片高度 ≤ 0.80，未被放大（实际 ${Math.max(...hs).toFixed(3)}）`);
  check(Math.min(...ws_) >= 0.25, `纸片宽度 ≥ 0.25（实际 ${Math.min(...ws_).toFixed(3)}）`);
  check(Math.max(...ws_) <= 0.81, `纸片宽度 ≤ 0.80，未被放大（实际 ${Math.max(...ws_).toFixed(3)}）`);

  // 3) ⚠️ 零变形：纸片 w/h 必须等于**裁剪后**的 aspect（不是原始图片比例！）
  //    拿原图比例比会误报 10%+ 变形 —— 那是判据错了，不是代码错了。
  let worst = 0;
  for (const s of added) { if (s.ap) worst = Math.max(worst, Math.abs(s.w / s.h - s.ap) / s.ap); }
  check(worst < 1e-3, `照片零变形（最大比例偏差 ${(worst * 100).toFixed(4)}%，阈值 0.1%）`);

  // 3) 仍是全图贴入（crop 未被改动）
  const fullCrop = added.every((s) => s.crop[0] === 0 && s.crop[1] === 0 &&
    Math.abs(s.crop[2] - 1) < 1e-9 && Math.abs(s.crop[3] - 1) < 1e-9);
  check(fullCrop, 'crop 仍为全图 (0,0,1,1)，照片整幅贴满');

  check(errors.length === 0, `页面零异常${errors.length ? '：' + errors[0] : ''}`);

  console.log('\n===== test-photo-size =====');
  log.forEach((l) => console.log(l));
  console.log(log.some((l) => l.includes('FAIL')) ? 'RESULT: FAIL' : 'RESULT: ALL PASS');
  ws.close(); chrome.kill(); process.exit(0);
})();
