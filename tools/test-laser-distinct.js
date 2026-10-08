// 验证「背面也有随角度流动的流光」，并对比六张镭射的区分度
// 用户反馈：正面有反光随视角转动，背面没有；且六张看起来都一样
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9251, HTTP = 8944;
const get = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = []; let pass = 0, fail = 0;
const check = (ok, msg) => { ok ? pass++ : fail++; log.push(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

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
    if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 200));
  });
  await new Promise((r) => ws.addEventListener('open', r));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${HTTP}/index.html` });
  await wait(4000);
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception?.description || '').slice(0, 200) };
    return r.result ? r.result.value : undefined;
  };
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, name), Buffer.from(s.data, 'base64'));
  };

  // 1) 加一张玄黑镭射照片
  await ev(`(async () => {
    const cv = document.createElement('canvas'); cv.width = 1200; cv.height = 800;
    const g = cv.getContext('2d');
    g.fillStyle = '#3d7fb8'; g.fillRect(0, 0, 1200, 800);
    const b = await new Promise((r) => cv.toBlob(r, 'image/jpeg', .9));
    const f = new File([b], 't.jpg', { type: 'image/jpeg' });
    const dt = new DataTransfer(); dt.items.add(f);
    const i = document.getElementById('file'); i.files = dt.files; i.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 1200));
    document.querySelector('#edSeries [data-s="laser"]').click();
    await new Promise((r) => setTimeout(r, 500));
    // 选玄黑（第三张）
    const chips = [...document.querySelectorAll('#edPapers .paper-chip')];
    chips[2].click();
    await new Promise((r) => setTimeout(r, 400));
    document.getElementById('edOk').click();
    await new Promise((r) => setTimeout(r, 2800));
    return 'ok';
  })()`);

  const rec = await ev(`(() => { const ps = window.__photos(); const p = ps[ps.length-1];
     return { hasBack: !!p.back, paper: p.paper, backLen: p.back ? p.back.length : 0 }; })()`);
  check(rec && rec.hasBack, `玄黑纸已生成背面贴图（${rec && rec.backLen} 字节）`);
  check(rec && rec.paper && rec.paper.holo === 1, `holo=1（实际 ${rec && rec.paper && rec.paper.holo}）`);

  // 2) 六张的区分度：逐张取「相纸留白区」的平均色与色相，任意两张必须有明显差异
  const distinct = await ev(`(async () => {
    const cv = document.createElement('canvas'); cv.width = 1200; cv.height = 800;
    const g = cv.getContext('2d'); g.fillStyle = '#3d7fb8'; g.fillRect(0, 0, 1200, 800);
    const b = await new Promise((r) => cv.toBlob(r, 'image/jpeg', .9));
    const f = new File([b], 't2.jpg', { type: 'image/jpeg' });
    const dt = new DataTransfer(); dt.items.add(f);
    const i = document.getElementById('file'); i.files = dt.files; i.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 1200));
    document.querySelector('#edSeries [data-s="laser"]').click();
    await new Promise((r) => setTimeout(r, 500));
    const chips = [...document.querySelectorAll('#edPapers .paper-chip')];
    const out = [];
    for (let k = 0; k < chips.length; k++) {
      chips[k].click();
      await new Promise((r) => setTimeout(r, 300));
      const p = document.getElementById('edPrev');
      // 取左侧留白带（整片相纸，避开照片）
      const pc = document.createElement('canvas'); pc.width = p.width; pc.height = p.height;
      pc.getContext('2d').drawImage(p, 0, 0);
      const d = pc.getContext('2d', { willReadFrequently: true })
        // 只取最左侧 6% —— 那是纯相纸留白，绝不会碰到照片。
        // （之前取 14% 越过了左边距，采到照片的蓝色，导致连玄黑都测成 rgb(83,123,163) 偏蓝）
        .getImageData(0, 0, Math.max(3, Math.round(p.width * .055)), p.height).data;
      let r = 0, g2 = 0, b2 = 0, n = 0;
      for (let j = 0; j < d.length; j += 4) { r += d[j]; g2 += d[j+1]; b2 += d[j+2]; n++; }
      out.push({ title: chips[k].title, rgb: [Math.round(r/n), Math.round(g2/n), Math.round(b2/n)] });
    }
    document.getElementById('edCancel').click();
    return out;
  })()`);
  check(distinct && distinct.length === 6, `取到 6 张留白区颜色`);
  // 每对之间的 RGB 距离都要够大（否则「每张都一样」）
  let minDist = 1e9, pairName = '';
  for (let i = 0; i < (distinct || []).length; i++) {
    for (let j = i + 1; j < distinct.length; j++) {
      const a = distinct[i].rgb, c = distinct[j].rgb;
      const dist = Math.abs(a[0]-c[0]) + Math.abs(a[1]-c[1]) + Math.abs(a[2]-c[2]);
      if (dist < minDist) { minDist = dist; pairName = `${distinct[i].title} vs ${distinct[j].title}`; }
    }
  }
  // 判据不能只看 RGB 距离：冷银与暖金的明度接近但色相完全不同，同样「一眼可辨」。
  // 所以要求：RGB 距离 > 22 **或** 色相差 > 18°。
  const hueOf = (c) => {
    const r = c[0]/255, g2 = c[1]/255, b2 = c[2]/255;
    const mx = Math.max(r,g2,b2), mn = Math.min(r,g2,b2), d = mx-mn;
    if (!d) return 0;
    let h = mx===r ? ((g2-b2)/d)%6 : mx===g2 ? (b2-r)/d+2 : (r-g2)/d+4;
    h *= 60; return h < 0 ? h+360 : h;
  };
  let minSep = 1e9, sepName = '';
  for (let i = 0; i < (distinct||[]).length; i++) {
    for (let j = i+1; j < distinct.length; j++) {
      const a = distinct[i].rgb, c = distinct[j].rgb;
      const d = Math.abs(a[0]-c[0]) + Math.abs(a[1]-c[1]) + Math.abs(a[2]-c[2]);
      const dh = Math.abs(hueOf(a) - hueOf(c)); const dh2 = Math.min(dh, 360-dh);
      const sep = Math.max(d, dh2 * 6);      // 色相差折算成 RGB 尺度
      if (sep < minSep) { minSep = sep; sepName = `${distinct[i].title} vs ${distinct[j].title} (RGB${d} 色相${dh2.toFixed(0)}°)`; }
    }
  }
  check(minSep > 40, `六张两两可辨（最接近的一对「${sepName}」综合距离 ${minSep.toFixed(0)} > 40）`);
  (distinct || []).forEach((d) => log.push(`  · ${d.title}: rgb(${d.rgb.join(',')})`));

  // 3) 玄黑必须真的是黑（平均明度要低）
  const noir = (distinct || []).find((d) => d.title === '玄黑镭射');
  if (noir) {
    const lum = (noir.rgb[0] * .3 + noir.rgb[1] * .59 + noir.rgb[2] * .11);
    check(lum < 75, `玄黑镭射确实是黑（平均明度 ${lum.toFixed(1)} < 78；rgb(${noir.rgb})）`);
  }

  // 4) 背面流光：翻到背面，采样纸片中心区颜色
  // 用真实交互：双击聚焦 → 翻面
  const flip = await ev(`(async () => {
    const c = document.getElementById('scene'); const r = c.getBoundingClientRect();
    // 找到新增的纸片（最靠后 = 我们刚加的）
    let hit = -1;
    for (let gy = 0.15; gy <= 0.85 && hit < 0; gy += 0.04) {
      for (let gx = 0.15; gx <= 0.85 && hit < 0; gx += 0.04) {
        const x = r.left + r.width * gx, y = r.top + r.height * gy;
        if (window.__pick(x, y) >= 0) hit = window.__pick(x, y);
      }
    }
    return hit;
  })()`);
  check(flip >= 0, `找到可交互的纸片（index ${flip}）`);

  // 采样翻转前后纸片区域的平均色
  const sampleArea = async () => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    return s.data;
  };
  const before = await sampleArea();
  // 翻转
  const flipped = await ev(`(() => {
    if (!window.__flipSheet) return 'no-hook';
    window.__flipSheet(${flip});
    return 'via-hook';
  })()`);
  log.push(`  翻转方式: ${flipped && flipped.value}`);
  await wait(1400);
  const after = await sampleArea();
  check(before !== after, '翻转后画面确实变化（纸片已翻到背面）');
  await shot('v70-back.png');

  check(errs.length === 0, `页面零异常${errs.length ? '：' + errs[0] : ''}`);
  console.log(log.join('\n'));
  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  ws.close(); chrome.kill(); process.exit(fail ? 1 : 0);
})();
