// v111 回归：草稿箱 —— 存草稿 / 继续编辑(独立会话) / 保存回草稿 / 分享草稿 / 删除
// 关键语义（用户选定「每个草稿独立编辑会话」）：
//   · 进入会话时把**真实当前作品**暂存到 SESSION_KEY.origWork，草稿副本进实时槽 STORE_KEY；
//   · 存档点 draftKey(id) 只在「保存回草稿」时写入，编辑会话中绝不误改存档点；
//   · 退出/刷新可从 SESSION_KEY 恢复真实当前作品。
// enterDraftSession / exitDraftSession 会 location.reload()，测试需在重载后重新观察。
const { spawn } = require('child_process');
const http = require('http');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9297;
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${PORT}`, '--window-size=1200,800', 'about:blank'], { stdio: 'ignore' });
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
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
  await new Promise((r) => ws.addEventListener('open', r));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });

  const nav = async () => { await send('Page.navigate', { url: 'http://127.0.0.1:8944/index.html?_=' + Date.now() }); await wait(2000); };
  await nav();
  await send('Runtime.evaluate', { expression: `(async()=>{const dbs=await indexedDB.databases?.()||[];for(const d of dbs){if(d.name)await new Promise(r=>{const q=indexedDB.deleteDatabase(d.name);q.onsuccess=q.onerror=q.onblocked=()=>r();});}localStorage.clear();})()`, awaitPromise: true });
  await nav();
  // 覆盖 confirm（删除草稿/退出会话会弹），避免无头浏览器里阻塞
  await send('Runtime.evaluate', { expression: `window.confirm = () => true; window.__confirmHits = 0; const _c = window.confirm; window.confirm = (...a) => { window.__confirmHits++; return true; };` });

  const evalJs = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result.value;
  };

  // —— 菜单开合 ——
  await evalJs(`document.getElementById('worksBtn').click()`);
  await wait(200);
  const menuOpen = await evalJs(`!document.getElementById('worksMenu').hidden`);
  check(menuOpen, '「作品」菜单可展开');
  await evalJs(`document.body.click()`);
  await wait(200);
  const menuClosed = await evalJs(`document.getElementById('worksMenu').hidden`);
  check(menuClosed, '点击空白处菜单收起');

  // —— 注入一张照片（当前作品）——
  const baseCount = await evalJs(`window.__photos().length`); // 基础示例照片数（不硬编码）
  await evalJs(`(async () => {
    const cv=document.createElement('canvas'); cv.width=1200; cv.height=900;
    const g=cv.getContext('2d'); g.fillStyle='#3a5a8a'; g.fillRect(0,0,1200,900);
    g.fillStyle='#e8c07a'; g.fillRect(200,200,400,300);
    const blob=await new Promise((res)=>cv.toBlob(res,'image/jpeg',.9));
    const dt=new DataTransfer(); dt.items.add(new File([blob],'p.jpg',{type:'image/jpeg'}));
    const inp=document.getElementById('file'); inp.files=dt.files; inp.dispatchEvent(new Event('change'));
    await new Promise((r)=>setTimeout(r,700));
  })()`);
  await wait(900);
  await evalJs(`document.getElementById('edOk').click()`);   // 完成，提交进当前作品
  await wait(700);
  const curCount = await evalJs(`window.__photos().length`);
  check(curCount === baseCount + 1, `当前作品照片 = 基础 ${baseCount} + 注入 1（实测 ${curCount}）`);

  // —— 存草稿（走 UI：作品菜单→我的草稿→存为草稿→命名）——
  await evalJs(`document.getElementById('worksBtn').click()`); await wait(150);
  await evalJs(`document.getElementById('draftsBtn').click()`); await wait(400);
  const panelOpen = await evalJs(`!document.getElementById('draftsDlg').hidden`);
  check(panelOpen, '草稿箱面板已打开');
  const emptyState = await evalJs(`!!document.querySelector('#draftList .draft-empty')`);
  check(emptyState, '初始为空态提示');
  await evalJs(`document.getElementById('draftSave').click()`); await wait(400);
  await evalJs(`(() => { document.getElementById('nameInput').value='我的草稿A'; document.getElementById('nameOk').click(); })()`);
  await wait(1200);
  const idx = await evalJs(`window.__drafts.getDraftIndex().then(a => a.map(d => ({ id:d.id, name:d.name, count:d.count, hasThumb: !!d.thumb })))`);
  check(Array.isArray(idx) && idx.length === 1, `草稿索引有 1 条（实测 ${idx && idx.length}）`);
  check(idx && idx[0].name === '我的草稿A', `草稿名为「我的草稿A」（实测「${idx && idx[0].name}」）`);
  check(idx && idx[0].count === baseCount + 1, `草稿照片数 = 基础 ${baseCount} + 注入 1（实测 ${idx && idx[0].count}）`);
  const listUI = await evalJs(`(() => { const it = document.querySelector('.draft-item'); return it ? { name: it.querySelector('.draft-name').textContent, sub: it.querySelector('.draft-sub').textContent, acts: [...it.querySelectorAll('.draft-acts button')].map(b=>b.textContent) } : null; })()`);
  check(listUI && listUI.name === '我的草稿A', `列表显示草稿名（实测「${listUI && listUI.name}」）`);
  check(listUI && listUI.acts.join(',') === '继续编辑,分享,删除', `每行三个操作（实测 ${listUI && listUI.acts.join(',')}）`);

  // —— 分享草稿（只读导出，内容=该草稿）——
  const expBefore = await evalJs(`(() => { window.__lastExport = null; document.querySelector('.draft-item .draft-acts button:nth-child(2)').click(); return 'clicked'; })()`);
  void expBefore;
  let shared = null;
  for (let i = 0; i < 30; i++) { await wait(500); shared = await evalJs(`(() => { const e = window.__lastExport; return e ? { name: e.name, size: e.size } : null; })()`); if (shared) break; }
  check(!!shared, `分享草稿生成导出文件（${shared ? (shared.size/1048576).toFixed(1)+' MB' : '超时'}）`);
  check(shared && shared.name === '我的草稿A', `导出文件名为草稿名（实测「${shared && shared.name}」）`);

  // —— 继续编辑（独立会话）：进入后画布=草稿副本，真实当前作品被暂存 ——
  await nav();  // 回到干净页面（草稿已在 IndexedDB）
  await evalJs(`window.confirm = () => true;`);
  await evalJs(`window.__drafts.enterDraftSession(${JSON.stringify(idx[0].id)}).catch(()=>{})`); // fire & forget，会 reload
  await wait(2600); // 等 reload + 画布重建
  const sess = await evalJs(`(async () => {
    const s = await window.__drafts.storeGet('papercloud.session');
    const store = await window.__drafts.storeGet('papercloud.v1');
    return {
      barVisible: !document.getElementById('sessionBar').hidden,
      barName: document.getElementById('sessionName').textContent,
      sessionDraftId: s && s.draftId,
      hasOrigWork: !!(s && s.origWork),
      origAdded: s && s.origWork ? (s.origWork.added || []).length : -1,
      liveAdded: store && store.added ? store.added.length : -1,
      canvasCount: window.__photos().length,
    };
  })()`);
  check(sess.barVisible, '会话状态条出现');
  check(sess.barName.includes('我的草稿A'), `状态条显示草稿名（实测「${sess.barName}」）`);
  check(sess.sessionDraftId === idx[0].id, 'SESSION_KEY 记录了正在编辑的草稿');
  check(sess.hasOrigWork, '真实当前作品已被暂存到 SESSION_KEY.origWork');
  check(sess.origAdded === 1, `暂存的当前作品含 1 张用户照片（实测 ${sess.origAdded}）`);
  check(sess.liveAdded === 1, `实时槽=草稿副本，含 1 张用户照片（实测 ${sess.liveAdded}）`);

  // —— 编辑会话中：存档点不被误改（此照片此刻的 draftKey 应仍是进入时的快照）——
  const draftBeforeEdit = await evalJs(`window.__drafts.loadDraftSnapshot(${JSON.stringify(idx[0].id)}).then(d => d && d.userData.added.length)`);
  check(draftBeforeEdit === 1, `存档点进入会话时快照完整（added=${draftBeforeEdit}）`);

  // 会话中真正编辑：再注入一张照片（走 persist 写实时槽），验证存档点不被污染
  await evalJs(`(async () => {
    const cv=document.createElement('canvas'); cv.width=800; cv.height=600;
    const g=cv.getContext('2d'); g.fillStyle='#8a3a5a'; g.fillRect(0,0,800,600);
    const blob=await new Promise((res)=>cv.toBlob(res,'image/jpeg',.9));
    const dt=new DataTransfer(); dt.items.add(new File([blob],'q.jpg',{type:'image/jpeg'}));
    const inp=document.getElementById('file'); inp.files=dt.files; inp.dispatchEvent(new Event('change'));
    await new Promise((r)=>setTimeout(r,700));
  })()`);
  await wait(900);
  await evalJs(`document.getElementById('edOk').click()`); await wait(800);
  const draftDuring = await evalJs(`window.__drafts.loadDraftSnapshot(${JSON.stringify(idx[0].id)}).then(d => d && d.userData.added.length)`);
  check(draftDuring === 1, `会话中编辑后存档点仍未被污染（added=${draftDuring}，应仍为1）`);

  // —— 保存回草稿：此刻存档点才应更新为 2 ——
  await evalJs(`window.__drafts.saveBackToDraft().catch(()=>{})`);
  await wait(1200);
  const draftAfter = await evalJs(`window.__drafts.loadDraftSnapshot(${JSON.stringify(idx[0].id)}).then(d => d && { n: d.userData.added.length, savedAt: d.savedAt })`);
  check(draftAfter && draftAfter.n === 2, `保存回草稿后快照更新为 2（实测 ${draftAfter && draftAfter.n}）`);

  // —— 退出会话 → 恢复真实当前作品 ——
  await evalJs(`window.__drafts.exitDraftSession().catch(()=>{})`);
  await wait(2600);
  const after = await evalJs(`(async () => {
    const s = await window.__drafts.storeGet('papercloud.session');
    const store = await window.__drafts.storeGet('papercloud.v1');
    return {
      sessionGone: !s,
      liveAdded: store && store.added ? store.added.length : -1,
      barHidden: document.getElementById('sessionBar').hidden,
      canvasCount: window.__photos().length,
    };
  })()`);
  check(after.sessionGone, '退出会话后 SESSION_KEY 已清除');
  check(after.liveAdded === 1, `实时槽恢复为真实当前作品（added=${after.liveAdded}）`);
  check(after.barHidden, '会话状态条已隐藏');

  // —— 删除草稿 ——
  await nav();
  await evalJs(`window.confirm = () => true;`);
  await evalJs(`document.getElementById('worksBtn').click()`); await wait(150);
  await evalJs(`document.getElementById('draftsBtn').click()`); await wait(400);
  await evalJs(`document.querySelector('.draft-item .draft-del').click()`); await wait(900);
  const idx2 = await evalJs(`window.__drafts.getDraftIndex().then(a => a.length)`);
  check(idx2 === 0, `删除后草稿为空（实测 ${idx2}）`);
  const emptyAgain = await evalJs(`!!document.querySelector('#draftList .draft-empty')`);
  check(emptyAgain, '删除后回到空态提示');

  console.log(`\\n结果：${pass} PASS / ${fail} FAIL`);
  ws.close(); chrome.kill();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e); chrome.kill(); process.exit(2); });