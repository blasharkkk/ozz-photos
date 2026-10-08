// 截「翻到背面」的 3D 画面，肉眼确认背面箔面与那条暗带
const { spawn } = require('child_process'); const http = require('http'); const fs = require('fs'); const path = require('path');
const CHROME='C:/Program Files/Google/Chrome/Application/chrome.exe'; const PORT=9254, HTTP=8954;
const get=(p)=>new Promise((res,rej)=>{http.get({host:'127.0.0.1',port:PORT,path:p},(r)=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)))}).on('error',rej)});
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const chrome=spawn(CHROME,['--headless=new','--disable-gpu','--no-sandbox','--hide-scrollbars','--remote-debugging-port='+PORT,'--window-size=1400,940','about:blank'],{stdio:'ignore'});
  let tabs=null; for(let i=0;i<40;i++){try{tabs=await get('/json/list');break}catch{await wait(250)}}
  const page=tabs.find(t=>t.type==='page'); const ws=new WebSocket(page.webSocketDebuggerUrl);
  let id=0; const pending=new Map();
  const send=(m,p)=>new Promise(res=>{const mid=++id;pending.set(mid,res);ws.send(JSON.stringify({id:mid,method:m,params:p||{}}))});
  ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data); if(m.id&&pending.has(m.id)){pending.get(m.id)(m.result);pending.delete(m.id)}});
  await new Promise(r=>ws.addEventListener('open',r));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate',{url:'http://127.0.0.1:'+HTTP+'/index.html'}); await wait(4000);
  const ev=async(e)=>{const r=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});
    return r.exceptionDetails?{__err:(r.exceptionDetails.exception?.description||'').slice(0,200)}:r.result?.value};
  // 加玄黑镭射照片
  await ev(`(async()=>{
    const cv=document.createElement('canvas');cv.width=1200;cv.height=800;
    const g=cv.getContext('2d');g.fillStyle='#3d7fb8';g.fillRect(0,0,1200,800);
    const b=await new Promise(r=>cv.toBlob(r,'image/jpeg',.9));
    const f=new File([b],'t.jpg',{type:'image/jpeg'});
    const dt=new DataTransfer();dt.items.add(f);
    const i=document.getElementById('file');i.files=dt.files;i.dispatchEvent(new Event('change'));
    await new Promise(r=>setTimeout(r,1200));
    document.querySelector('#edSeries [data-s="laser"]').click();
    await new Promise(r=>setTimeout(r,500));
    const chips=[...document.querySelectorAll('#edPapers .paper-chip')];
    chips[2].click();  // 玄黑
    await new Promise(r=>setTimeout(r,400));
    document.getElementById('edOk').click();
    await new Promise(r=>setTimeout(r,3000));
    return 'ok';
  })()`);
  // 找到新纸片并翻到背面
  const flip=await ev(`(()=>{
    const c=document.getElementById('scene'); const r=c.getBoundingClientRect();
    let best=-1, bestD=1e9;
    for(let gy=0.2;gy<=0.8;gy+=0.05) for(let gx=0.2;gx<=0.8;gx+=0.05){
      const x=r.left+r.width*gx, y=r.top+r.height*gy;
      const i=window.__pick(x,y);
      if(i>=0){ const d=Math.hypot(gx-0.5,gy-0.5); if(d<bestD){bestD=d;best=i;} }
    }
    if(best>=0) window.__flipSheet(best);
    return best;
  })()`);
  await wait(2200);
  const s=await send('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(__dirname,'v81-back.png'),Buffer.from(s.data,'base64'));
  console.log('已翻到背面 index='+flip+'，截图 v81-back.png');
  ws.close();chrome.kill();process.exit(0);
})();
