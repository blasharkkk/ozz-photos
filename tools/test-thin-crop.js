// 复现「拖裁剪手柄 → 界面被撑高」。
// 关键：必须用 CDP 的 Input.dispatchMouseEvent（真实可信事件），
// 因为 edStage 的 pointerdown 里会 setPointerCapture()，
// 合成事件没有真实 pointerId 会直接抛异常、把edit.drag 打断（曾因此测出「框没变窄」的假象）。
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9245, HTTP = 8944;
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--remote-debugging-port=' + PORT, '--window-size=1240,940', 'about:blank'], { stdio: 'ignore' });
const get = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => {
    let d = ''; r.on('data', (c) => d += c); r.on('end', () => res(JSON.parse(d)));
  }).on('error', rej);
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let tabs = null;
  for (let i = 0; i < 40; i++) { try { tabs = await get('/json/list'); break; } catch (e) { await wait(250); } }
  const page = tabs.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  const errs = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await new Promise((r) => ws.addEventListener('open', r));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${HTTP}/index.html` });
  await wait(3000);
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    return r.exceptionDetails ? { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text } : r.result.value;
  };
  const shot = async (n) => { const s = await send('Page.captureScreenshot', { format: 'png' }); if (s && s.data) fs.writeFileSync(path.join(__dirname, n), Buffer.from(s.data, 'base64')); };
  const log = []; const check = (ok, m) => log.push((ok ? 'PASS ' : 'FAIL ') + m);

  // 真实鼠标拖拽：从手柄中心按下→ 分多步移动 → 抬起
  const drag = async (from, to, steps = 14) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
    for (let i = 1; i <= steps; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (to.x - from.x) * i / steps, y: from.y + (to.y - from.y) * i / steps, button: 'left', buttons: 1, pointerType: 'mouse' });
      await wait(16);
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
    await wait(260);
  };
  const handleCenter = async (sel) => ev(`(()=>{const h=document.querySelector('#edCrop ${sel}');if(!h)return null;const b=h.getBoundingClientRect();return {x:Math.round(b.left+b.width/2),y:Math.round(b.top+b.height/2)}})()`);

  await ev(`(async()=>{const cv=document.createElement('canvas');cv.width=1200;cv.height=900;const g=cv.getContext('2d');const gr=g.createLinearGradient(0,0,1200,900);gr.addColorStop(0,'#5b6b8c');gr.addColorStop(1,'#e8b98a');g.fillStyle=gr;g.fillRect(0,0,1200,900);const blob=await new Promise(r=>cv.toBlob(r,'image/jpeg',.92));const f=new File([blob],'t.jpg',{type:'image/jpeg'});const dt=new DataTransfer();dt.items.add(f);const i=document.getElementById('file');i.files=dt.files;i.dispatchEvent(new Event('change'));await new Promise(r=>setTimeout(r,1000));})()`);

  const GEO = `(() => {
    const R = (s) => { const e = document.querySelector(s); if(!e) return null;
      const b = e.getBoundingClientRect(); return { y: Math.round(b.y), h: Math.round(b.height), w: Math.round(b.width) }; };
    const c = document.getElementById('edCrop').getBoundingClientRect();
    return { panel: R('.ed-panel'), body: R('.ed-body'),
      left: R('#edFrontLeft'), stage: R('#edStage'), img: R('#edImg'), ratios: R('#edRatios'),
      right: R('#edFrontRight'), prevWrap: R('#edPrevWrap'), prev: R('#edPrev'),
      crop: { w: Math.round(c.width), h: Math.round(c.height), ar: +(c.width/c.height).toFixed(3) },
      scrollH: document.querySelector('.ed-panel').scrollHeight,
      rightScroll: document.getElementById('edFrontRight').scrollHeight,
      prevAttr: (()=>{const c2=document.getElementById('edPrev');return c2.width+'x'+c2.height})() };
  })()`;

  const g0 = await ev(GEO);
  await shot('thin-0-before.png');

  // 先把 w 手柄往右拖，再把 e 手柄往左拖 → 压成极窄竖条
  const w0 = await handleCenter('[data-h="w"]');
  await drag(w0, { x: w0.x + g0.crop.w * 0.40, y: w0.y });
  const e0 = await handleCenter('[data-h="e"]');
  await drag(e0, { x: e0.x - g0.crop.w * 0.40, y: e0.y });

  const g1 = await ev(GEO);
  await shot('thin-1-after.png');

  // 再压一次，逼近极限
  const w1 = await handleCenter('[data-h="w"]');
  await drag(w1, { x: w1.x + g0.crop.w * 0.28, y: w1.y });
  const e1 = await handleCenter('[data-h="e"]');
  await drag(e1, { x: e1.x - g0.crop.w * 0.28, y: e1.y });

  const g2 = await ev(GEO);
  await shot('thin-2-extreme.png');

  console.log('初始     :', JSON.stringify(g0));
  console.log('拖窄一次 :', JSON.stringify(g1));
  console.log('拖窄两次 :', JSON.stringify(g2));

  check(g1.crop.w < g0.crop.w, `拖拽真的生效了（裁剪框宽 ${g0.crop.w} → ${g1.crop.w}）`);
  check(g2.panel.h === g0.panel.h, `面板高度不变（${g0.panel.h} → ${g1.panel.h} → ${g2.panel.h}）`);
  check(g2.panel.y === g0.panel.y, `面板位置不变（y ${g0.panel.y} → ${g1.panel.y} → ${g2.panel.y}）`);
  check(g2.left.h === g0.left.h, `左列高度不变（${g0.left.h} → ${g1.left.h} → ${g2.left.h}）`);
  check(g2.stage.h === g0.stage.h, `裁剪台高度不变（${g0.stage.h} → ${g1.stage.h} → ${g2.stage.h}）`);
  check(g2.scrollH <= g2.panel.h, `面板无溢出（scrollH ${g2.scrollH} ≤ panelH ${g2.panel.h}）`);

  console.log(log.join('\n'));
  if (errs.length) console.log('页面报错:', errs.slice(0, 4).map((e) => String(e).slice(0, 200)));
  ws.close(); chrome.kill(); process.exit(0);
})();