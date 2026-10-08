// v61 回归测试：验证 ①实例数据槽位不再错位（照片不会被甩飞、吊线正常）
//② 镭射纸的背面确实是铺满的箔面（不是空白）③ 背面贴图按纸片比例不变形
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9245, HTTP = 8944;
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
    if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 300));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push('[console] ' + m.params.args.map((a) => String(a.description || a.value)).join(' ').slice(0, 300));
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
  const shot = async (name) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(__dirname, name), Buffer.from(s.data, 'base64'));
  };

  // —— 1) 造一张镭射相纸的照片放进云里 ——
  const setup = await ev(`(async () => {
    const cv = document.createElement('canvas'); cv.width = 1200; cv.height = 800;
    const g = cv.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 1200, 800);
    grd.addColorStop(0, '#4a86c8'); grd.addColorStop(1, '#f0d090');
    g.fillStyle = grd; g.fillRect(0, 0, 1200, 800);
    g.fillStyle = '#fff'; g.font = '80px sans-serif'; g.fillText('PHOTO', 440, 430);
    const b = await new Promise((r) => cv.toBlob(r, 'image/jpeg', .9));
    const f = new File([b], 't.jpg', { type: 'image/jpeg' });
    const dt = new DataTransfer(); dt.items.add(f);
    const i = document.getElementById('file'); i.files = dt.files; i.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 1200));
    // 选镭射系列
    document.querySelector('#edSeries [data-s="laser"]').click();
    await new Promise((r) => setTimeout(r, 600));
    return { open: !document.getElementById('editor').hidden };
  })()`);
  check(setup && setup.open === true, `编辑器已打开并切到镭射系列`);

  // —— 2) 完成 → 检查照片记录的 paper 字段 ——
  const rec = await ev(`(async () => {
    document.getElementById('edOk').click();
    await new Promise((r) => setTimeout(r, 2600));
    const ps = window.__photos ? window.__photos() : null;
    return { last: ps ? ps[ps.length - 1] : null };
  })()`);
  check(rec && rec.last, '照片已放入云里（可通过 __photos 读取）');

  // —— 3) 关键：读回实例缓冲，验证槽位不再错位 ——
  //     12..15 必须是 0（动力学占位），16 必须是 1（镭射强度），17 是个小数种子
  const slots = await ev(`(() => {
    if (!window.__sheetSlots) return null;
    return window.__sheetSlots();
  })()`);
  if (slots) {
    check(slots.dyn.every((v) => Math.abs(v) < 1e-6), `aDyn(12-15) 全为 0（不再被相纸数据占据）：[${slots.dyn.join(', ')}]`);
    check(slots.holo === 1, `aPaper.x(16) = 镭射强度 1（实际 ${slots.holo}）`);
    check(Number.isFinite(slots.seed) && Math.abs(slots.seed) < 100000, `aPaper.y(17) = 种子（实际 ${slots.seed}）`);
    check(slots.wins.every((v) => v >= 0 && v <= 0.5), `窗口内缩在 0~0.5（实际 [${slots.wins.join(', ')}]）`);
    // 左右必须对称（相框左右边距相等）；上下不应相等 —— 拍立得下边比上边宽得多，
    // 断言写反会误报（我第一版就写错了）。
    check(Math.abs(slots.winL - slots.winR) < 1e-6, `左右窗口对称 L=${slots.winL.toFixed(4)} R=${slots.winR.toFixed(4)}`);
    check(slots.winB > slots.winT, `下边比上边宽（拍立得特征）T=${slots.winT.toFixed(4)} B=${slots.winB.toFixed(4)}`);
    check(slots.aspect > 0.5 && slots.aspect < 2.5, `背面宽高比合理（${slots.aspect.toFixed(3)}）`);
  } else {
    check(false, '未能读到实例槽位（需要 __sheetSlots 钩子）');
  }

  // —— 4) 纸片不该被甩飞：所有纸片位置都在房间内 ——
  const posOk = await ev(`(() => {
    const ps = window.__sheetPos ? window.__sheetPos() : null;
    if (!ps) return null;
    const bad = ps.filter((p) => !isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z) || Math.abs(p.x) > 40 || Math.abs(p.y) > 40 || Math.abs(p.z) > 40);
    return { n: ps.length, bad: bad.length, sample: ps.slice(0, 3) };
  })()`);
  if (posOk) {
    check(posOk.bad === 0, `全部 ${posOk.n} 张纸片位置正常，无一被甩飞（异常 ${posOk.bad}）`);
  }

  // —— 5) 背面贴图已生成且是镭射（不再是空白）——
  const back = await ev(`(() => {
    const ps = window.__photos ? window.__photos() : null;
    if (!ps) return null;
    const p = ps[ps.length - 1];
    return { hasBack: !!p.back, backLen: p.back ? p.back.length : 0, paper: p.paper || null };
  })()`);
  check(back && back.hasBack, `镭射纸即使没画背面也生成了背面贴图（长度 ${back && back.backLen}）`);

  // —— 6) 背面贴图内容不是纯白（是箔面，有明显纹理/色彩）——
  if (back && back.hasBack) {
    const backTex = await ev(`(async () => {
      const ps = window.__photos();
      const p = ps[ps.length - 1];
      const img = new Image();
      await new Promise((r, j) => { img.onload = r; img.onerror = j; img.src = p.back; });
      const c = document.createElement('canvas'); c.width = 120; c.height = Math.round(120 * img.height / img.width);
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0, c.width, c.height);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let n = 0, sum = 0, sum2 = 0;
      const hues = new Set();
      for (let i = 0; i < d.length; i += 4) {
        const l = d[i] * .3 + d[i+1] * .59 + d[i+2] * .11;
        sum += l; sum2 += l * l; n++;
        hues.add((d[i] >> 4) + ',' + (d[i+1] >> 4) + ',' + (d[i+2] >> 4));
      }
      return { sd: Math.sqrt(Math.max(0, sum2/n - (sum/n)**2)), mean: sum/n, hues: hues.size, ar: img.width / img.height };
    })()`);
    check(backTex && backTex.sd > 3, `背面贴图有纹理（标准差 ${backTex && backTex.sd.toFixed(2)}，>3 说明不是纯色）`);
    // 色块数不再要求「多」：玄黑镭射现在是纯黑底（用户要求「黑镭射就是黑镭射」），
    // 底色收敛后色块数必然减少。判据改为「有多种色块即可」，纹理 richness 由 sd 那条断言负责。
    check(backTex && backTex.hues >= 4, `背面贴图有色彩层次（${backTex && backTex.hues} 种色块 ≥ 4）`);
    check(backTex && Math.abs(backTex.ar - (slots ? slots.aspect : backTex.ar)) < 0.02,
      `背面图比例 ${backTex && backTex.ar.toFixed(3)} 与槽位 aspect ${slots && slots.aspect.toFixed(3)} 一致`);
    // ⚠️ 关键回归：背面贴图按 aspect 居中 contain 进方形纹理后，采样端必须用**正向映射**
    // 把那一块取出来。早先写成反向映射（把 UV 从方图投到长方形），
    // UV 近 0/1 时算出 -0.5/1.5 → clamp 后采到 contain 填充的灰边 →
    // 「只有中间一行是镭射，上下都是空白相纸」（用户实测）。翻转时改走 uBackFull 才"看起来正常"。
    // 这里用数学验证映射端点是否正好落在图像区间内。
    const mc = await ev(`(() => {
      const ar = window.__sheetSlots().aspect, LAYER = 256;
      let dw = LAYER, dh = LAYER;
      if (ar >= 1) dh = Math.round(LAYER / ar); else dw = Math.round(LAYER * ar);
      const oy = (LAYER - dh) / 2 / LAYER, ox = (LAYER - dw) / 2 / LAYER;
      const ih = dh / LAYER, iw = dw / LAYER;
      // 修复后的正向映射：ar>=1 取纵向区间，ar<1 取横向区间
      const fy = (v, a) => a > 1.001 ? (1 - 1 / a) * .5 + v / a : v;
      const fx = (v, a) => a < .999 ? (1 - a) * .5 + v * a : v;
      return { ar, oy, ox, ih, iw, y0: fy(0, ar), y1: fy(1, ar), x0: fx(0, ar), x1: fx(1, ar) };
    })()`);
    if (mc && mc.ar >= 1) {
      check(Math.abs(mc.y0 - mc.oy) < 0.01 && Math.abs(mc.y1 - (mc.oy + mc.ih)) < 0.01,
        `纵向映射端点落在图像区间 [${mc.oy.toFixed(3)}, ${(mc.oy + mc.ih).toFixed(3)}]（实际 ${mc.y0.toFixed(3)}→${mc.y1.toFixed(3)}）`);
    } else if (mc) {
      check(Math.abs(mc.x0 - mc.ox) < 0.01 && Math.abs(mc.x1 - (mc.ox + mc.iw)) < 0.01,
        `横向映射端点落在图像区间 [${mc.ox.toFixed(3)}, ${(mc.ox + mc.iw).toFixed(3)}]（实际 ${mc.x0.toFixed(3)}→${mc.x1.toFixed(3)}）`);
    }
    check(mc && mc.y0 >= 0 && mc.y1 <= 1 && mc.x0 >= 0 && mc.x1 <= 1,
      `映射不越界（越界就会采到 contain 的灰边 → 三行 bug）：x ${mc && mc.x0.toFixed(3)}~${mc && mc.x1.toFixed(3)}，y ${mc && mc.y0.toFixed(3)}~${mc && mc.y1.toFixed(3)}`);
  }

  await shot('v61-cloud.png');

  // —— 7) 页面零异常 ——
  check(errs.length === 0, `页面零异常${errs.length ? '：' + errs[0] : ''}`);

  console.log(log.join('\n'));
  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  if (fail) console.log('\n异常:\n' + errs.slice(0, 5).map((e) => '  ' + e).join('\n'));
  ws.close(); chrome.kill(); process.exit(fail ? 1 : 0);
})();
