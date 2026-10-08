// 像素级对照：把 6 张镭射纸各自渲染成 PNG 条带图，肉眼 + 量化对比。
// 关键修复点：paintPaper 遇到 grad 函数返回 null 时不再二次 fillRect（否则抹掉 screen 纹理）。
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9241;
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
  const send = (m, p) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p || {} })); });
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: 'http://127.0.0.1:8944/index.html' });
  await wait(2500);
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result.value;
  };
  // 进编辑器 → 镭射。照片素材要「中间实、四周留白」，否则整张被照片盖住、量不到相纸纹理。
  await ev(`(async () => {
    const cv = document.createElement('canvas'); cv.width = 900; cv.height = 700;
    const g = cv.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 900, 700);      // 白底 = 模拟大留白
    g.fillStyle = '#4a7fb5'; g.fillRect(180, 120, 540, 400);   // 中间一块照片
    const b = await new Promise((r) => cv.toBlob(r, 'image/jpeg', .95));
    const f = new File([b], 't.jpg', { type: 'image/jpeg' });
    const dt = new DataTransfer(); dt.items.add(f);
    const i = document.getElementById('file'); i.files = dt.files; i.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 1000));
    document.querySelector('#edSeries [data-s="laser"]').click();
    await new Promise((r) => setTimeout(r, 500));
    // 切到背面创作：背面是整张纸（无照片窗口），最能反映「铺满」的成色
    document.querySelector('#editor [data-mode="back"]').click();
    await new Promise((r) => setTimeout(r, 900));
  })()`);
  // 直接量「背面纸面」：backPaper 整张都是相纸，最能反映纹理是否铺满
  const strip = await ev(`(async () => {
    const chips = [...document.querySelectorAll('#edPapers .paper-chip')];
    const out = document.createElement('canvas');
    out.width = 6 * 100; out.height = 130;
    const g = out.getContext('2d');
    const stats = [];
    for (let i = 0; i < chips.length; i++) {
      chips[i].click();
      await new Promise((r) => setTimeout(r, 300));
      const p = document.getElementById('edBackPaper');   // 背面纸面：整张都是相纸
      g.drawImage(p, i * 100, 0, 100, 130);
      const pc = document.createElement('canvas'); pc.width = p.width; pc.height = p.height;
      const pg = pc.getContext('2d'); pg.drawImage(p, 0, 0);
      // 三条扫描线（上/中/下）取亮度标准差，再取均值——覆盖整张纸而不是只测一条
      const sds = [];
      for (const fy of [0.08, 0.5, 0.92]) {
        const y = Math.min(p.height - 2, Math.max(1, Math.round(p.height * fy)));
        const d = pg.getImageData(0, y, p.width, 1).data;
        let sum = 0, sum2 = 0, n = 0;
        for (let k = 0; k < d.length; k += 4) { const l = (d[k] + d[k+1] + d[k+2]) / 3; sum += l; sum2 += l * l; n++; }
        sds.push(Math.sqrt(Math.max(0, sum2 / n - (sum / n) ** 2)));
      }
      stats.push({ title: chips[i].title, sd: +(sds.reduce((a, b2) => a + b2, 0) / sds.length).toFixed(2) });
    }
    return { png: out.toDataURL('image/png'), stats };
  })()`);
  if (strip && strip.error) console.log('ERR', strip.error);
  else {
    console.log('各镭射纸「相纸上沿扫描线」的亮度标准差（越大 = 纹理/流光越丰富）：');
    for (const s of strip.stats) console.log(`  ${s.title}: sd=${s.sd}`);
    fs.writeFileSync(path.join(__dirname, 'laser-strip.png'), Buffer.from(strip.png.split(',')[1], 'base64'));
    console.log('条带图: tools/laser-strip.png');
  }
  ws.close(); chrome.kill(); process.exit(0);
})();
