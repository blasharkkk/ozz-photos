// 验证把手修复：把裁剪框拖到图片各个极端位置，确认把手永不溢出裁剪台
const { spawn } = require('child_process');
const http = require('http');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9280;
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--window-size=1240,1000', 'about:blank'], { stdio: 'ignore' });
const get = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let d = ''; r.on('data', (c) => d += c); r.on('end', () => res(JSON.parse(d)));
  }).on('error', rej);
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = []; const check = (ok, m) => { log.push((ok?'PASS ':'FAIL ')+m); };

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
  // ⚠️ 必须加随机查询参数：模块脚本一旦被浏览器缓存，改了 main.js 也测不到旧行为
  // （曾因此误以为 clampCrop 没被调用，其实页面加载的是缓存副本）
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: 'http://127.0.0.1:8944/index.html?_=' + Date.now() });
  await wait(2200);
  const evalJs = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result.value;
  };
  const mouse = (t, x, y) => send('Input.dispatchMouseEvent', { type: t, x, y, button: 'left', buttons: t==='mouseReleased'?0:1, clickCount: 1 });
  // 复位手段：重新注入照片（编辑器重开→裁剪框回到 0.1~0.9 默认态）。
  // ⚠️ 点「自由」比例按钮**不能**复位 —— 实测 cropW 始终停在8px，
  //   所以早先用按钮当复位手段是无效的（7 行数据完全相同就是没复位的证据）。
  const inject = () => evalJs(`(async () => {
    const cv=document.createElement('canvas'); cv.width=1600; cv.height=1000;
    const g=cv.getContext('2d');
    const sky=g.createLinearGradient(0,0,0,500); sky.addColorStop(0,'#2a3550'); sky.addColorStop(1,'#c8876a');
    g.fillStyle=sky; g.fillRect(0,0,1600,500);
    g.fillStyle='#8fa4bd'; g.beginPath(); g.moveTo(420,530); g.lineTo(760,260); g.lineTo(1100,530); g.closePath(); g.fill();
    g.fillStyle='#dfe8f2'; g.fillRect(0,540,1600,460);
    const blob=await new Promise((res)=>cv.toBlob(res,'image/jpeg',.92));
    const dt=new DataTransfer(); dt.items.add(new File([blob],'t.jpg',{type:'image/jpeg'}));
    const inp=document.getElementById('file'); inp.files=dt.files; inp.dispatchEvent(new Event('change'));
    await new Promise((r)=>setTimeout(r,1000));
    return !document.getElementById('editor').hidden;
  })()`);
  check(await inject(), '编辑器已打开');

  const probe = () => evalJs(`(()=>{const st=document.querySelector('.ed-stage'), sr=st.getBoundingClientRect();
    const crop=document.querySelector('#edCrop'), cr=crop.getBoundingClientRect();
    const hs=[...crop.querySelectorAll('span')].map(s=>{const r=s.getBoundingClientRect();
      return {h:s.dataset.h, top:r.top-sr.top, bottom:r.bottom-sr.top, left:r.left-sr.left, right:r.right-sr.left};});
    // ⚠️ 把手坐标是相对 stage 左上角的偏移量（0~stageW 范围），不是「距右/下边多远」。
    //   判据必须是 x.right > stageW。早先误写成比较「距右边距离 > 宽度」，
    //   框被推到左半边时就误报溢出。
    return { stageH:sr.height, stageW:sr.width, sh:st.scrollHeight,
      cropTop:+(cr.top-sr.top).toFixed(1), cropBottom:+(cr.bottom-sr.top).toFixed(1),
      cropLeft:+(cr.left-sr.left).toFixed(1), cropRight:+(cr.right-sr.left).toFixed(1),
      overB:hs.filter(x=>x.bottom>sr.height+0.5).map(x=>x.h),
      overT:hs.filter(x=>x.top<-0.5).map(x=>x.h),
      overR:hs.filter(x=>x.right>sr.width+0.5).map(x=>x.h),
      overL:hs.filter(x=>x.left<-0.5).map(x=>x.h),
      tiny:hs.filter(x=>(x.right-x.left)<10||(x.bottom-x.top)<10).map(x=>x.h),
      handles:hs,
      panelH:Math.round(document.querySelector('.ed-panel').getBoundingClientRect().height),
      panelSh:document.querySelector('.ed-panel').scrollHeight };})()`);

  const drag = async (h, dx, dy) => {
    const info = await evalJs(`(()=>{const e=document.querySelector('#edCrop [data-h="${h}"]'); if(!e)return null;
      const r=e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
    if (!info) return;
    await mouse('mousePressed', info.x, info.y);
    for (let i=1;i<=10;i++){ await mouse('mouseMoved', info.x+dx*i/10, info.y+dy*i/10); await wait(20); }
    await mouse('mouseReleased', info.x+dx, info.y+dy);
    await wait(280);
  };

  // ⚠️ 每个用例都必须**先复位到 0.1~0.9 的默认框**，否则前一个用例把框压成 8px 宽后，
  //   下一个用例的把手被挤在极窄处，CDP 按下的坐标落在框外 → pointerdown 根本不命中，
  //   拖拽"没生效"却看起来像通过或失败（曾出现 7 行数据完全相同的假象）。
  const resetCrop = async () => {
    await evalJs(`(()=>{const c=document.getElementById('edCancel'); if(c) c.click();})()`);
    await wait(250);
    await inject();
    await wait(200);
  };

  const cases = [
    ['初始', null],
    ['nw 拖到左上角', ['nw', -900, -700]],
    ['se 拖到右下角', ['se', 900, 700]],
    ['sw 拖到左下角', ['sw', -900, 700]],
    ['拉成极窄高(ne向左上)', ['ne', -700, -600]],
    ['拉成极扁(se向右下)', ['se', 700, 600]],
    ['框贴左上(w 拖到最左)', ['w', -600, 0]],
    ['框贴右上(e 拖到最右)', ['e', 600, 0]],
  ];
  const results = [];
  for (const [name, d] of cases) {
    await resetCrop();
    if (d) await drag(d[0], d[1], d[2]);
    const p = await probe();
    results.push({ name, p });
    const bad = p.overB.length + p.overT.length + p.overR.length + p.overL.length + p.tiny.length;
    console.log(`${bad?'XX':'ok'} ${name.padEnd(22)} stage ${p.stageH}/${p.sh} panel ${p.panelH}/${p.panelSh} ` +
      `crop T${p.cropTop} B${p.cropBottom} L${p.cropLeft} R${p.cropRight} ` +
      `溢出[${[...p.overT,...p.overB,...p.overL,...p.overR].join(',')||'无'}] 小于10px[${p.tiny.join(',')||'无'}]`);
  }
  const anyOver = results.some(r => r.p.overB.length+r.p.overT.length+r.p.overR.length+r.p.overL.length);
  const anyTiny = results.some(r => r.p.tiny.length);
  const panelStable = new Set(results.map(r=>r.p.panelH)).size === 1;
  check(!anyOver, '所有位置把手都不溢出裁剪台（上下左右四边）');
  check(!anyTiny, '所有把手尺寸正常（无小于 10px 的被切把手）');
  check(panelStable, `拖拽全程面板高度不变（${[...new Set(results.map(r=>r.p.panelH))].join('/')}）`);
  check(results.every(r=>r.p.panelSh <= r.p.panelH+1), '面板内容无溢出');

  console.log('');
  log.forEach(l=>console.log(l));
  console.log('\nRESULT: ' + (log.some(l=>l.includes('FAIL')) ? 'FAIL' : 'ALL PASS'));
  if (errors.length) console.log('PAGE ERRORS:\n'+errors.join('\n'));
  ws.close(); chrome.kill(); process.exit(0);
})();