// 直接量化「背面 canvas 的镭射纹理」：在页面里对 backPaper 逐张统计亮度标准差。
// 这能区分两种可能：
//   A) 背面贴图本身就没纹理（laserFoil 没执行成功）→ 背面全白
//   B) 背面有纹理但着色器没叠流光 → 静态纹理在、动态没有
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9245;
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
  const errors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 300));
  });
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
  const log = [];
  const check = (ok, m) => log.push((ok ? 'PASS ' : 'FAIL ') + m);

  await ev(`(async () => {
    const cv = document.createElement('canvas'); cv.width = 900; cv.height = 700;
    const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 900, 700);
    g.fillStyle = '#4a7fb5'; g.fillRect(180, 120, 540, 400);
    const b = await new Promise((r) => cv.toBlob(r, 'image/jpeg', .95));
    const f = new File([b], 't.jpg', { type: 'image/jpeg' });
    const dt = new DataTransfer(); dt.items.add(f);
    const i = document.getElementById('file'); i.files = dt.files; i.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 1000));
    document.querySelector('#edSeries [data-s="laser"]').click();
    await new Promise((r) => setTimeout(r, 400));
    document.querySelector('#editor [data-mode="back"]').click();
    await new Promise((r) => setTimeout(r, 1000));
  })()`);

  const stats = await ev(`(async () => {
    const chips = [...document.querySelectorAll('#edPapers .paper-chip')];
    const out = [];
    const strip = document.createElement('canvas'); strip.width = 6 * 90; strip.height = 110;
    const sg = strip.getContext('2d');
    for (let i = 0; i < chips.length; i++) {
      chips[i].click();
      await new Promise((r) => setTimeout(r, 320));
      const p = document.getElementById('edBackPaper');
      sg.drawImage(p, i * 90, 0, 90, 110);
      const g = p.getContext('2d');
      // 三条扫描线的亮度标准差均值
      const sds = [];
      for (const fy of [0.1, 0.5, 0.9]) {
        const y = Math.min(p.height - 2, Math.max(1, Math.round(p.height * fy)));
        const d = g.getImageData(0, y, p.width, 1).data;
        let sum = 0, sum2 = 0, n = 0;
        for (let k = 0; k < d.length; k += 4) { const l = (d[k] + d[k+1] + d[k+2]) / 3; sum += l; sum2 += l * l; n++; }
        sds.push(Math.sqrt(Math.max(0, sum2 / n - (sum / n) ** 2)));
      }
      // 平均色（判断是否纯白）
      const avg = g.getImageData(0, 0, p.width, p.height).data;
      let r0 = 0, g0 = 0, b0 = 0, n0 = 0;
      for (let k = 0; k < avg.length; k += 4 * 97) { r0 += avg[k]; g0 += avg[k+1]; b0 += avg[k+2]; n0++; }
      out.push({ title: chips[i].title, sd: +(sds.reduce((a, b) => a + b, 0) / sds.length).toFixed(2),
                 rgb: [Math.round(r0/n0), Math.round(g0/n0), Math.round(b0/n0)] });
    }
    return { out, png: strip.toDataURL('image/png') };
  })()`);
  if (stats.error) console.log('ERR', stats.error);
  else {
    console.log('背面 canvas 的镭射纹理（亮度标准差 / 平均色）：');
    for (const s of stats.out) console.log(`  ${s.title}: sd=${s.sd} 平均色 rgb(${s.rgb})`);
    fs.writeFileSync(path.join(__dirname, 'back-strip.png'), Buffer.from(stats.png.split(',')[1], 'base64'));
    console.log('条带图: tools/back-strip.png');
    const minSd = Math.min(...stats.out.map((s) => s.sd));
    check(minSd > 3, `六张背面都有纹理（最小 sd=${minSd}；接近 0 = 纯白无纹理）`);
    // 浅色系镭射纸的平均色本就接近白（白纸打印的镭射图案本就不醒目），
    // 所以不能用「平均色差大」判定有无纹理——纹理要看标准差 sd。
    // 改为验证六张各不相同（若全一样，说明又回到「换纸不刷新背面」的 bug）。
    check(new Set(stats.out.map((s) => s.sd)).size >= 5,
      `六张背面纹理各不相同（sd: ${stats.out.map((s) => s.sd).join(', ')}）`);
  }
  console.log(log.join('\n'));
  if (errors.length) { console.log('--- 报错 ---'); errors.slice(0, 4).forEach((e) => console.log(e)); }
  console.log(errors.length || log.some((l) => l.startsWith('FAIL')) ? '\nRESULT: FAIL' : '\nRESULT: ALL PASS');
  ws.close(); chrome.kill(); process.exit(0);
})();
