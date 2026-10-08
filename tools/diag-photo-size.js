// 探针：量出「用户新添加照片」的纸片真实宽高分布（从 GPU 实例缓冲读回，而非看代码猜）
// 背景：makeSheet 里已裁剪照片走 h = .55 + rnd()*.25 —— 高度只在 0.55~0.80 浮动（±18%），
// 用户实测「高度都是一致的」。本脚本量化真实分布，为调整提供依据。
const { spawn } = require('child_process');
const http = require('http');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9281;
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--window-size=1240,1000', 'about:blank'], { stdio: 'ignore' });
const get = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let d = ''; r.on('data', (c) => d += c); r.on('end', () => res(JSON.parse(d)));
  }).on('error', rej);
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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
  await send('Emulation.setDeviceMetricsOverride', { width: 1067, height: 841, deviceScaleFactor: 1, mobile: false });
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  // 先清空本地存储，保证从空白云开始（示例照片不参与统计）
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

  // 连续注入 12 张**不同宽高比**的照片（模拟用户上传的杂乱照片）
  const ratios = [[1600,1000],[900,1200],[1400,1400],[1200,700],[1000,1500],[2000,900],[800,800],[1500,1000],[1100,1300],[1700,1100],[950,1000],[1300,950]];
  for (let i = 0; i < ratios.length; i++) {
    const [w, h] = ratios[i];
    await evalJs(`(async () => {
      const cv=document.createElement('canvas'); cv.width=${w}; cv.height=${h};
      const g=cv.getContext('2d');
      const grad=g.createLinearGradient(0,0,${w},${h});
      grad.addColorStop(0,'#2b3a55'); grad.addColorStop(1,'#d98b62');
      g.fillStyle=grad; g.fillRect(0,0,${w},${h});
      g.fillStyle='#f2f6fb'; g.fillRect(${w*0.2|0},${h*0.6|0},${w*0.5|0},${h*0.2|0});
      const blob=await new Promise((res)=>cv.toBlob(res,'image/jpeg',.9));
      const dt=new DataTransfer(); dt.items.add(new File([blob],'p${i}.jpg',{type:'image/jpeg'}));
      const inp=document.getElementById('file'); inp.files=dt.files; inp.dispatchEvent(new Event('change'));
      await new Promise((r)=>setTimeout(r,420));
      // 直接走「完成」跳过编辑器交互（等价于用户裁完点完成）
      const ok=document.getElementById('edOk'); if(ok) ok.click();
      await new Promise((r)=>setTimeout(r,420));
    })()`);
  }
  await wait(800);

  // 读回每张纸片的真实宽高。__sheetList 是现成的调试出口（main.js:3620），
  // 它反映的就是写入实例缓冲的 w/h —— 即渲染真正使用的值。
  // ⚠️ 必须把「用户添加的照片」与「示例照片」分开：示例照片走 makeSheet 的 else 分支
  //   （w=.42+rnd()*.16，本来就有变化），用户反馈的是**自己传的那批**走 fitted 分支。
  const dump = await evalJs(`(()=>{
    const list = window.__sheetList();
    if(!list) return {error:'__sheetList 不可用'};
    const ph = window.__photos();
    const isUser = (pi) => !!ph[pi] && String(ph[pi].id||'').startsWith('u');
    return {
      total: list.length,
      userCount: ph.filter((p,i)=>String(p.id||'').startsWith('u')).length,
      sheets: list.map(s=>({w:+s.w.toFixed(4), h:+s.h.toFixed(4), photo:s.photo, study:s.study, user:isUser(s.photo),
        // ap = 裁剪后的真实比例（不是原始图片比例）；crop 用于确认是否全图贴入
        ap: ph[s.photo] ? ph[s.photo].aspect : null, crop: s.crop}))
    };
  })()`);

  if (dump.error || !dump.sheets) { console.log('读取失败:', JSON.stringify(dump)); ws.close(); chrome.kill(); process.exit(1); }
  const added = dump.sheets.filter((s) => !s.study && s.user);
  console.log('总纸片数:', dump.total, ' 用户照片数:', dump.userCount, ' 用户照片纸片数:', added.length);
  console.log('\n用户新增照片的纸片尺寸:');
  added.forEach((s, i) => console.log(`  #${i + 1}  w=${s.w.toFixed(3)}  h=${s.h.toFixed(3)}  比例=${(s.w / s.h).toFixed(2)}`));
  const hs = added.map((s) => s.h), ws_ = added.map((s) => s.w);
  const rng = (a) => `${Math.min(...a).toFixed(3)} ~ ${Math.max(...a).toFixed(3)}`;
  const mean = (a) => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(3);
  console.log(`\n高度 h: min~max = ${rng(hs)}  均值 ${mean(hs)}  极差 ${(Math.max(...hs) - Math.min(...hs)).toFixed(3)}`);
  console.log(`宽度 w: min~max = ${rng(ws_)}  均值 ${mean(ws_)}  极差 ${(Math.max(...ws_) - Math.min(...ws_)).toFixed(3)}`);
  const uniq = new Set(hs.map((h) => h.toFixed(3)));
  console.log(`\n高度不同取值数: ${uniq.size} / ${hs.length}`);
  // 用户抱怨的正是「高度都一致」→量化一下：最高/最低只差多少
  if (hs.length > 1) {
    const spread = (Math.max(...hs) - Math.min(...hs)) / (Math.max(...hs) + Math.min(...hs));
    console.log(`高度相对差异: ${(spread * 100).toFixed(1)}%（<60% 视觉上就偏"整齐"）`);
  }

  // ⚠️ 变形检查的基准必须是**裁剪后**的aspect（photos[i].aspect），
  //   不是原始图片的宽高比 —— 用户在编辑器里裁过，两者不同。
  //   拿原图比例去比会误报 10%+ 的"变形"，那是判据错了，不是代码错了。
  console.log('\n变形检查（纸片 w/h vs 裁剪后真实 aspect）:');
  let worst = 0;
  for (const s of added) {
    if (!s.ap) continue;
    const sheet = s.w / s.h, d = Math.abs(sheet - s.ap) / s.ap * 100;
    worst = Math.max(worst, d);
    console.log(`  w=${s.w.toFixed(3)} h=${s.h.toFixed(3)}  纸片比例=${sheet.toFixed(4)}  真实aspect=${s.ap.toFixed(4)}  偏差=${d.toFixed(4)}%`);
  }
  console.log(`最大变形偏差: ${worst.toFixed(4)}%  → ${worst < 0.01 ? '✓ 零变形（照片比例被精确保留）' : '✗ 有拉伸'}`);
  const fullCrop = added.every((s) => s.crop && s.crop[0] === 0 && s.crop[1] === 0 &&
    Math.abs(s.crop[2] - 1) < 1e-9 && Math.abs(s.crop[3] - 1) < 1e-9);
  console.log(`crop 是否全图(0,0,1,1): ${fullCrop ? '✓ 是（照片整幅贴满，无需裁切补偿）' : '✗ 否'}`);
  console.log('页面异常:', errors.length ? errors.slice(0, 3) : '无');
  ws.close(); chrome.kill(); process.exit(0);
})();
