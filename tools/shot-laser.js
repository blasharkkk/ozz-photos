// 镭射相纸视觉取样：输出 ①六张色卡拼图 ②留白区放大 3 倍的细节图
// 用途：肉眼复核「像不像真镭射」——柔和虹彩 + 金属底 + 磨砂颗粒
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9249, HTTP = 8949;
const get = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`, '--window-size=1400,900', 'about:blank'], { stdio: 'ignore' });
  let tabs = null;
  for (let i = 0; i < 40; i++) { try { tabs = await get('/json/list'); break; } catch { await wait(250); } }
  const page = tabs.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p || {} })); });
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${HTTP}/index.html` });
  await wait(4000);
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception?.description || '').slice(0, 200) };
    return r.result ? r.result.value : undefined;
  };

  // 造测试照片 → 打开编辑器 → 选镭射
  const setupExpr = `(async () => {
    const cv = document.createElement('canvas'); cv.width = 1200; cv.height = 800;
    const g = cv.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 1200, 800);
    gr.addColorStop(0, '#3d7fb8'); gr.addColorStop(1, '#e8c88a');
    g.fillStyle = gr; g.fillRect(0, 0, 1200, 800);
    g.fillStyle = '#fff'; g.font = '80px sans-serif'; g.fillText('PHOTO', 450, 430);
    const b = await new Promise((r) => cv.toBlob(r, 'image/jpeg', .9));
    const f = new File([b], 't.jpg', { type: 'image/jpeg' });
    const dt = new DataTransfer(); dt.items.add(f);
    const i = document.getElementById('file'); i.files = dt.files; i.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 1200));
    document.querySelector('#edSeries [data-s="laser"]').click();
    await new Promise((r) => setTimeout(r, 700));
    return 'ok';
  })()`;
  await ev(setupExpr);

  const grab = async (zoom) => ev(`(async () => {
    const chips = [...document.querySelectorAll('#edPapers .paper-chip')];
    const out = document.createElement('canvas');
    out.width = 3 * 300; out.height = 2 * 200;
    const g = out.getContext('2d');
    g.fillStyle = '#111'; g.fillRect(0, 0, out.width, out.height);
    for (let i = 0; i < chips.length; i++) {
      chips[i].click();
      await new Promise((r) => setTimeout(r, 300));
      const p = document.getElementById('edPrev');
      ${zoom ? `
      g.imageSmoothingEnabled = false;
      // 取最左侧 3%（纯相纸留白，绝不碰照片），放大 3 倍看磨砂颗粒
      const sw = Math.max(2, Math.round(p.width * 0.03)), sh = p.height;
      g.imageSmoothingEnabled = false;
      g.drawImage(p, 0, 0, sw, sh, (i % 3) * 300, Math.floor(i / 3) * 200, 300, 200);
      g.fillStyle = '#fff'; g.font = '13px sans-serif';
      g.fillText(chips[i].title, (i % 3) * 300 + 6, Math.floor(i / 3) * 200 + 15);` : `
      g.drawImage(p, (i % 3) * 300, Math.floor(i / 3) * 200, 296, 196);
      g.fillStyle = '#fff'; g.font = '13px sans-serif';
      g.fillText(chips[i].title, (i % 3) * 300 + 6, Math.floor(i / 3) * 200 + 15);`}
    }
    return out.toDataURL('image/png');
  })()`);

  const save = (name, data) => fs.writeFileSync(path.join(__dirname, name), Buffer.from(String(data).split(',')[1], 'base64'));
  save('laser-grid.png', await grab(false));
  save('laser-zoom.png', await grab(true));
  console.log('已保存 laser-grid.png / laser-zoom.png');
  ws.close(); chrome.kill(); process.exit(0);
})();
