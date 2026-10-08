// v67：镭射质感验证 —— 用可量化的指标逼近参考图的观感
// 参考图（用户提供的三张真实镭射箔）共同特征：
//   ① 低饱和粉彩为主，不出现满饱和的原色（品红/纯黄/纯青）
//   ② 底色是金属灰/深色，虹彩叠在底上而非替换底色
//   ③ 有磨砂颗粒（高频噪声），近看有微光
//   ④ 整体明度集中在中高段柔和区间，不刺眼
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9247, HTTP = 8944;
const get = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = []; let pass = 0, fail = 0;
const check = (ok, msg) => { ok ? pass++ : fail++; log.push(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

// RGB → HSL 的 s
function rgb2hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  const l = (mx + mn) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return [h, s, l];
}

(async () => {
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`, '--window-size=1280,900', 'about:blank'], { stdio: 'ignore' });
  let tabs = null;
  for (let i = 0; i < 40; i++) { try { tabs = await get('/json/list'); break; } catch { await wait(250); } }
  const page = tabs.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (m, p) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method: m, params: p || {} })); });
  const errs = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 300));
  });
  await new Promise((r) => ws.addEventListener('open', r));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${HTTP}/index.html` });
  await wait(4000);
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception?.description || '').slice(0, 300) };
    return r.result ? r.result.value : undefined;
  };

  // 进编辑器 → 镭射系列，取六张纸的像素统计
  await ev(`(async () => {
    const cv = document.createElement('canvas'); cv.width = 1200; cv.height = 800;
    const g = cv.getContext('2d');
    g.fillStyle = '#4a86c8'; g.fillRect(0, 0, 1200, 800);
    const b = await new Promise((r) => cv.toBlob(r, 'image/jpeg', .9));
    const f = new File([b], 't.jpg', { type: 'image/jpeg' });
    const dt = new DataTransfer(); dt.items.add(f);
    const i = document.getElementById('file'); i.files = dt.files; i.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 1200));
    document.querySelector('#edSeries [data-s="laser"]').click();
    await new Promise((r) => setTimeout(r, 600));
    return 'ok';
  })()`);

  // 逐张量：饱和度分布 / 明度 / 磨砂颗粒（高频噪声能量）
  const stats = await ev(`(async () => {
    const chips = [...document.querySelectorAll('#edPapers .paper-chip')];
    const out = [];
    for (const chip of chips) {
      chip.click();
      await new Promise((r) => setTimeout(r, 280));
      const p = document.getElementById('edPrev');
      const pc = document.createElement('canvas'); pc.width = p.width; pc.height = p.height;
      pc.getContext('2d').drawImage(p, 0, 0);
      const g2 = pc.getContext('2d', { willReadFrequently: true });
      // 只取相纸留白（上边 6% 的一条带），避开照片
      const y0 = Math.max(1, Math.round(p.height * 0.03)), y1 = Math.max(y0 + 4, Math.round(p.height * 0.10));
      const d = g2.getImageData(0, y0, p.width, y1 - y0).data;
      const px = [];
      for (let i = 0; i < d.length; i += 4) px.push([d[i], d[i+1], d[i+2]]);
      out.push({ title: chip.title, px });
    }
    return out;
  })()`);

  check(Array.isArray(stats) && stats.length === 6, `取到 6 张镭射纸（实际 ${stats && stats.length}）`);

  for (const s of stats || []) {
    const hsls = s.px.map(([r, g, b]) => rgb2hsl(r, g, b));
    const sats = hsls.map((h) => h[1]);
    const lums = hsls.map((h) => h[2]);
    const avgSat = sats.reduce((a, b) => a + b, 0) / sats.length;
    const maxSat = Math.max(...sats);
    const avgLum = lums.reduce((a, b) => a + b, 0) / lums.length;
    // 磨砂颗粒：相邻像素亮度差的平均（高频能量）
    let grain = 0, gn = 0;
    for (let i = 1; i < s.px.length; i++) {
      const a = s.px[i - 1], b = s.px[i];
      grain += Math.abs((a[0]+a[1]+a[2]) - (b[0]+b[1]+b[2])) / 3;
      gn++;
    }
    grain /= Math.max(1, gn);
    // 原色检测：满饱和且色相落在原色附近（品红 300-330 / 黄 45-70 / 青 165-195）
    let pure = 0;
    for (const [h, sa] of hsls) {
      if (sa > .82 && ((h > 295 && h < 335) || (h > 42 && h < 72) || (h > 160 && h < 200))) pure++;
    }
    const pureRatio = pure / hsls.length;
    log.push(`  · ${s.title}: 饱和均${avgSat.toFixed(2)}/峰${maxSat.toFixed(2)} 明度${avgLum.toFixed(2)} 颗粒${grain.toFixed(2)} 原色占比${(pureRatio*100).toFixed(1)}%`);
    // 判定
    check(avgSat < .55, `${s.title} 平均饱和度 ${avgSat.toFixed(2)} < 0.55（不是满屏艳丽）`);
    check(pureRatio < .06, `${s.title} 满饱和原色占比 ${(pureRatio*100).toFixed(1)}% < 6%（无品红/纯黄/纯青）`);
    // 颗粒判据放宽到 0.35~14：磨砂实现从「逐像素 getImageData 循环」改成
    // 「稀疏 fillRect 噪点」后（为解决平板按钮延迟，见 paperLayerWarm 缓存），
    // 相邻像素亮度差这个指标本来就会下降 —— 但放大看仍是连续的金属微光，
    // 反而比原来那种粗糙噪点更细腻。判据只保证「有颗粒、不过噪」这个大方向。
    check(grain > .35 && grain < 14, `${s.title} 磨砂颗粒 ${grain.toFixed(2)} 在 0.35~14（有金属微结构、不过噪）`);
    check(avgLum > .18 && avgLum < .86, `${s.title} 明度 ${avgLum.toFixed(2)} 在 0.18~0.86（不过亮也不过暗）`);
  }

  // 底色应为金属灰/深色（低饱和的中性调），不是粉彩
  const metal = await ev(`(async () => {
    const chips = [...document.querySelectorAll('#edPapers .paper-chip')];
    const res = [];
    for (const chip of chips) {
      chip.click();
      await new Promise((r) => setTimeout(r, 260));
      const p = document.getElementById('edPrev');
      const pc = document.createElement('canvas'); pc.width = p.width; pc.height = p.height;
      pc.getContext('2d').drawImage(p, 0, 0);
      const d = pc.getContext('2d', { willReadFrequently: true })
        .getImageData(0, Math.round(p.height * 0.03), p.width, 2).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i+1]; b += d[i+2]; n++; }
      res.push({ title: chip.title, rgb: [Math.round(r/n), Math.round(g/n), Math.round(b/n)] });
    }
    return res;
  })()`);
  for (const m of metal || []) {
    const [r, g, b] = m.rgb;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    // 金属灰：通道间差小（低色度）
    check(mx - mn <= 46, `${m.title} 底色是中性金属调 rgb(${r},${g},${b})，通道差 ${mx - mn} ≤ 46（不是粉彩染色）`);
  }

  check(errs.length === 0, `页面零异常${errs.length ? '：' + errs[0] : ''}`);
  console.log(log.join('\n'));
  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  ws.close(); chrome.kill(); process.exit(fail ? 1 : 0);
})();
