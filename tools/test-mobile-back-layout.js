// v109 回归：手机竖屏背面创作 —— 画布要尽量大、底部工具要压缩、按钮文字不许折行堆积
// 用户反馈（390×844 截图）：画布只占屏约 40%，下方工具区很铺张；
// 缩放条按钮被挤成两行（「适应/窗口」「？怎/么平」折行），还和缩放提示文字堆在一起。
// 修法（style.css @media max-width:720px）：
//   1) 面板 padding/gap 收紧、隐藏「工具/颜色」小标题、工具按钮 30→26px、字号 12px
//   2) 缩放条 flex:none + nowrap 禁折行；.ed-w（「 窗口」「怎么」片段）与 .ed-zoomhint 移动端隐藏
// 断言：
//   A 画布(#edBackStage)高度 ≥ 45% 视口
//   B 工具区(#edBackRight)总高 ≤ 30% 视口（压缩生效）
//   C 缩放条按钮单行（offsetHeight ≤ 30px，折行会变 ~40px+）
//   D 「适应窗口」「？怎么平移」在移动端只显示短文案（.ed-w 已隐藏）
//   E .ed-zoomhint 移动端隐藏
// 反向验证：注入旧样式（.ed-w/.ed-zoomhint 显示 + 允许折行 + 小标题显示 + 按钮 30px）
//   → C/B/A 至少画布与折行断言立刻 FAIL，证明断言对本次改动敏感。
const { spawn } = require('child_process');
const http = require('http');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9293;
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--window-size=390,844', 'about:blank'], { stdio: 'ignore' });
const get = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (r) => { let d = ''; r.on('data', (c) => d += c); r.on('end', () => res(JSON.parse(d))); }).on('error', rej);
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(cond, msg) {
  if (cond) { console.log('  PASS ' + msg); pass++; }
  else { console.log('  FAIL ' + msg); fail++; }
}

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
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
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

  // 注入一张照片 → 编辑器打开 → 切到背面创作
  await evalJs(`(async () => {
    const cv=document.createElement('canvas'); cv.width=1200; cv.height=900;
    const g=cv.getContext('2d'); g.fillStyle='#2b3a55'; g.fillRect(0,0,1200,900);
    const blob=await new Promise((res)=>cv.toBlob(res,'image/jpeg',.9));
    const dt=new DataTransfer(); dt.items.add(new File([blob],'p.jpg',{type:'image/jpeg'}));
    const inp=document.getElementById('file'); inp.files=dt.files; inp.dispatchEvent(new Event('change'));
    await new Promise((r)=>setTimeout(r,600));
  })()`);
  await wait(800);
  await evalJs(`document.querySelector('[data-mode="back"]').click()`);
  await wait(500);

  const open = await evalJs(`!document.getElementById('editor').hidden && !document.getElementById('edBackRight').hidden`);
  check(open, '编辑器已打开且处于背面创作模式');

  const m = await evalJs(`(() => {
    const vw = innerWidth, vh = innerHeight;
    const stage = document.getElementById('edBackStage').getBoundingClientRect();
    const tools = document.getElementById('edBackRight').getBoundingClientRect();
    const fit = document.getElementById('edZoomFit').getBoundingClientRect();
    const help = document.getElementById('edPanHelp').getBoundingClientRect();
    const hint = document.querySelector('.ed-zoomhint');
    const labels = [...document.querySelectorAll('#edBackRight > .ed-label')].map(l => getComputedStyle(l).display);
    const fitW = document.getElementById('edZoomFit');
    const helpW = document.getElementById('edPanHelp');
    // 按钮是固定 height，折行时文字溢出 → 用 scrollHeight 检测，不能靠高度变高
    const wrapped = (el) => el.scrollHeight > el.clientHeight + 2;
    return {
      vw, vh,
      stageH: stage.height, stageTop: stage.top, stageBottom: stage.bottom,
      toolsH: tools.height,
      fitH: fit.height, fitText: fitW.textContent.trim(), fitShort: getComputedStyle(fitW.querySelector('.ed-w')).display === 'none', fitWrapped: wrapped(fitW),
      helpH: help.height, helpText: helpW.textContent.trim(), helpShort: getComputedStyle(helpW.querySelector('.ed-w')).display === 'none', helpWrapped: wrapped(helpW),
      hintDisplay: hint ? getComputedStyle(hint).display : 'none',
      labelDisplays: labels,
      toolBtnH: document.querySelector('#edBackTools button').getBoundingClientRect().height,
      tipVisible: !document.getElementById('edPanTip').hidden,
    };
  })()`);
  console.log('  [测量]', JSON.stringify(m, null, 1));

  check(m.stageH >= m.vh * 0.45, `画布高度 ≥ 45% 视口（实测 ${(m.stageH / m.vh * 100).toFixed(1)}%）`);
  check(m.toolsH <= m.vh * 0.30, `工具区总高 ≤ 30% 视口（实测 ${(m.toolsH / m.vh * 100).toFixed(1)}%）`);
  check(!m.fitWrapped && m.fitH <= 30, `「适应」按钮单行不折行（实测高 ${m.fitH.toFixed(0)}px）`);
  check(!m.helpWrapped && m.helpH <= 30, `「？平移」按钮单行不折行（实测高 ${m.helpH.toFixed(0)}px）`);
  check(m.fitShort, `移动端隐藏长文案「 窗口」片段`);
  check(m.helpShort, `移动端隐藏长文案「怎么」片段`);
  check(m.hintDisplay === 'none', '缩放提示「滚轮 / 双指缩放…」移动端已隐藏');
  check(m.labelDisplays.every(d => d === 'none'), '「工具/颜色」小标题移动端已隐藏');
  check(m.toolBtnH <= 27, `工具按钮高度 ≤ 27px（实测 ${m.toolBtnH.toFixed(0)}px）`);
  check(m.tipVisible === false, '手机端首次进背面创作不再自动弹「平移引导条」（吃掉 205px 画布）');

  // —— 反向验证：恢复 v109 之前的旧行为，断言应立刻失败 ——
  // 旧行为 = 引导条自动弹出 + 长文案显示 + 按钮可被挤压折行 + 小标题占行 + 工具按钮 30px
  await evalJs(`(() => {
    const s = document.createElement('style'); s.id = 'revert-v109';
    s.textContent = [
      '.ed-zoombar button { white-space: normal !important; flex: 0 1 auto !important; }',
      '.ed-w { display: inline !important; }',
      '.ed-zoomhint { display: inline !important; }',
      '#edBackRight > .ed-label { display: block !important; }',
      '.ed-toolgrid button { height: 30px !important; }',
      // 用户手机系统字体放大（OPPO 等常见 110%~130%），宽字之下旧版才把按钮挤成两行；此处等比模拟
      '.ed-zoombar, .ed-zoombar button, .ed-zoombar span { font-size: 15px !important; }',
    ].join('');
    document.head.appendChild(s);
    document.getElementById('edPanTip').hidden = false;   // 旧版首次进背面模式自动弹引导条
  })()`);
  // 旧版折行与手机字体宽度相关（390px 下勉强挤得下一行），压窄视口复现旧版的挤压折行
  await send('Emulation.setDeviceMetricsOverride', { width: 340, height: 844, deviceScaleFactor: 2, mobile: true });
  await wait(300);
  await wait(300);
  const r2 = await evalJs(`(() => {
    const vh = innerHeight;
    const stage = document.getElementById('edBackStage').getBoundingClientRect();
    const fit = document.getElementById('edZoomFit');
    const help = document.getElementById('edPanHelp');
    const tools = document.getElementById('edBackRight').getBoundingClientRect();
    // 按钮是固定 height:26px，折行时文字溢出 → 用 scrollHeight > clientHeight 检测，不能靠高度变高
    const wrapped = (el) => el.scrollHeight > el.clientHeight + 2;
    return {
      stageH: stage.height, fitH: fit.getBoundingClientRect().height, helpH: help.getBoundingClientRect().height,
      toolsH: tools.height, vh,
      fitWrapped: wrapped(fit), helpWrapped: wrapped(help),
      fitWS: getComputedStyle(fit).whiteSpace, fitFlex: getComputedStyle(fit).flex,
    };
  })()`);
  console.log('  [反向]', JSON.stringify(r2));
  check(r2.fitWrapped || r2.helpWrapped, `反向：恢复旧样式后按钮文字折行溢出（scrollHeight 检测）→ 断言敏感`);
  check(r2.stageH < m.stageH - 10, `反向：恢复旧样式后画布变小（${r2.stageH.toFixed(0)} < ${m.stageH.toFixed(0)}）→ 画布断言敏感`);

  check(errors.length === 0, '页面无 JS 异常' + (errors.length ? ' → ' + errors.join(' | ') : ''));

  console.log(`\nRESULT: ${fail === 0 ? 'PASS' : 'FAIL'}  (${pass} passed, ${fail} failed)`);
  ws.close(); chrome.kill(); process.exit(fail === 0 ? 0 : 1);
})();
