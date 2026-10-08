// 多尺寸验证：桌面 / iPad 横竖 / 手机竖，确认面板高度固定、按钮在标题行、无溢出
const { spawn } = require('child_process');
const http = require('http'); const fs = require('fs'); const path = require('path');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9239, ROOT = path.resolve(__dirname, '..');
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.jpg':'image/jpeg'};
const server=http.createServer((q,s)=>{const u=decodeURIComponent(q.url.split('?')[0]);const p=path.join(ROOT,u==='/'?'index.html':u);fs.readFile(p,(e,b)=>{if(e){s.writeHead(404);s.end();return}s.writeHead(200,{'Content-Type':MIME[path.extname(p)]||'application/octet-stream','Cache-Control':'no-store'});s.end(b)})});
const SIZES=[{n:'桌面 1240x940',w:1240,h:940},{n:'iPad 横 1180x820',w:1180,h:820},{n:'iPad 竖 820x1180',w:820,h:1180},{n:'手机 390x844',w:390,h:844}];
const wait=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
await new Promise(r=>server.listen(8949,'127.0.0.1',r));
const chrome=spawn(CHROME,['--headless=new','--disable-gpu','--no-sandbox','--hide-scrollbars','--remote-debugging-port='+PORT,'about:blank'],{stdio:'ignore'});
const get=p=>new Promise((res,rej)=>{http.get({host:'127.0.0.1',port:PORT,path:p},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)))}).on('error',rej)});
let tabs=null;for(let i=0;i<40;i++){try{tabs=await get('/json/list');break}catch(e){await wait(250)}}
const page=tabs.find(t=>t.type==='page');const ws=new WebSocket(page.webSocketDebuggerUrl);
let id=0;const pending=new Map();const send=(m,p)=>new Promise(res=>{const i=++id;pending.set(i,res);ws.send(JSON.stringify({id:i,method:m,params:p||{}}))});
const errs=[];
ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data);if(m.id&&pending.has(m.id)){pending.get(m.id)(m.result);pending.delete(m.id)}if(m.method==='Runtime.exceptionThrown')errs.push(m.params.exceptionDetails.text)});
await new Promise(r=>ws.addEventListener('open',r));
await send('Page.enable');await send('Runtime.enable');
const ev=async e=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});return r.exceptionDetails?{error:r.exceptionDetails.exception?.description||r.exceptionDetails.text}:r.result.value};
const log=[];
for(const s of SIZES){
  await send('Emulation.setDeviceMetricsOverride',{width:s.w,height:s.h,deviceScaleFactor:1,mobile:false});
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate',{url:'http://127.0.0.1:8944/index.html'});await wait(2600);
  await ev(`(async()=>{const cv=document.createElement('canvas');cv.width=1400;cv.height=900;const g=cv.getContext('2d');const gr=g.createLinearGradient(0,0,1400,900);gr.addColorStop(0,'#2b4c7e');gr.addColorStop(1,'#e0a24a');g.fillStyle=gr;g.fillRect(0,0,1400,900);for(let x=0;x<1400;x+=56){g.fillStyle='rgba(255,255,255,.5)';g.fillRect(x,0,10,900)}const blob=await new Promise(r=>cv.toBlob(r,'image/jpeg',.92));const f=new File([blob],'t.jpg',{type:'image/jpeg'});const dt=new DataTransfer();dt.items.add(f);const i=document.getElementById('file');i.files=dt.files;i.dispatchEvent(new Event('change'));await new Promise(r=>setTimeout(r,900));})()`);
  const g0=await ev(`(()=>{const p=document.querySelector('.ed-panel').getBoundingClientRect();const ok=document.getElementById('edOk').getBoundingClientRect();const hd=document.querySelector('.ed-head').getBoundingClientRect();
    // 关键：右列必须真的在可视区内。桌面/iPad 是左右并排，手机是上下分区 ——
    // 两种布局都要「右列有可见面积」，否则就是被挤没了（截图才看得出来，量坐标也能抓）。
    const R=(q)=>{const e=document.querySelector(q);const b=e.getBoundingClientRect();
      return {x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)};};
    const stage=R('#edStage'), ratio=R('#edRatios'), pw=R('#edPrevWrap'), papers=R('#edPapers');
    const vh=innerHeight, vw=innerWidth;
    const vis=(b)=>Math.max(0,Math.min(b.y+b.h,vh)-Math.max(b.y,0))*Math.max(0,Math.min(b.x+b.w,vw)-Math.max(b.x,0));
    return {ph:Math.round(p.height),py:Math.round(p.y),pw:Math.round(p.width),okInHead:ok.top>=hd.top-1&&ok.bottom<=hd.bottom+1,
      stageVis:vis(stage), ratioVis:vis(ratio), prevVis:vis(pw), papersVis:vis(papers),
      panelBottom:Math.round(p.y+p.height), vh}})()`);
  await ev(`(async()=>{document.querySelector('#edRatios [data-r="0.5625"]').click();await new Promise(r=>setTimeout(r,600));})()`);
  const g1=await ev(`(()=>{const p=document.querySelector('.ed-panel').getBoundingClientRect();return {ph:Math.round(p.height),py:Math.round(p.y)}})()`);
  const shotN='size-'+s.w+'x'+s.h+'.png';
  const sh=await send('Page.captureScreenshot',{format:'png'});
  if(sh&&sh.data) fs.writeFileSync(path.join(__dirname,shotN),Buffer.from(sh.data,'base64'));
  const checks=[
    [g0.ph===g1.ph && g0.py===g1.py, `切竖屏面板不动（${g0.ph}px y=${g0.py}）`],
    [g0.okInHead, '完成按钮在标题行内'],
    [g0.py>=0 && g0.panelBottom<=g0.vh+1, `面板完整在视口内（底 ${g0.panelBottom} ≤ ${g0.vh}）`],
    [g0.stageVis>2000, `裁剪台可见面积足够（${g0.stageVis}px²）`],
    [g0.prevVis>2000, `右侧预览可见（${g0.prevVis}px²）`],
    [g0.papersVis>500, `相纸色卡可见（${g0.papersVis}px²）`],
    [g0.ratioVis>500, `比例按钮可见（${g0.ratioVis}px²）`],
  ];
  log.push(s.n+': '+checks.map(([ok,m])=>(ok?'PASS ':'FAIL ')+m).join(' | '));
}
console.log(log.join('\n'));
if(errs.length)console.log('报错:',errs.slice(0,5));
// 汇总必须用 includes('FAIL')：每行现在以尺寸名开头，startsWith('FAIL') 会永远漏判
console.log(log.some(l=>l.includes('FAIL'))?'\nRESULT: FAIL':'\nRESULT: ALL PASS');
ws.close();chrome.kill();server.close();process.exit(0)})();
