// 量化「点相纸色卡 → 预览重绘」的耗时（平板上这是按钮响应速度的关键路径）
const { spawn } = require('child_process'); const http = require('http');
const CHROME='C:/Program Files/Google/Chrome/Application/chrome.exe'; const PORT=9261, HTTP=8961;
const get=(p)=>new Promise((res,rej)=>{http.get({host:'127.0.0.1',port:PORT,path:p},(r)=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res(JSON.parse(d)))}).on('error',rej)});
const wait=(ms)=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const chrome=spawn(CHROME,['--headless=new','--disable-gpu','--no-sandbox','--remote-debugging-port='+PORT,'--window-size=1400,940','about:blank'],{stdio:'ignore'});
  let tabs=null; for(let i=0;i<40;i++){try{tabs=await get('/json/list');break}catch{await wait(250)}}
  const page=tabs.find(t=>t.type==='page'); const ws=new WebSocket(page.webSocketDebuggerUrl);
  let id=0; const pending=new Map();
  const send=(m,p)=>new Promise(res=>{const mid=++id;pending.set(mid,res);ws.send(JSON.stringify({id:mid,method:m,params:p||{}}))});
  ws.addEventListener('message',ev=>{const m=JSON.parse(ev.data); if(m.id&&pending.has(m.id)){pending.get(m.id)(m.result);pending.delete(m.id)}});
  await new Promise(r=>ws.addEventListener('open',r));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate',{url:'http://127.0.0.1:'+HTTP+'/index.html'}); await wait(4000);
  const r=await send('Runtime.evaluate',{expression:`(async()=>{
    const cv=document.createElement('canvas');cv.width=1200;cv.height=800;
    const g=cv.getContext('2d');g.fillStyle='#3d7fb8';g.fillRect(0,0,1200,800);
    const b=await new Promise(r=>cv.toBlob(r,'image/jpeg',.9));
    const f=new File([b],'t.jpg',{type:'image/jpeg'});
    const dt=new DataTransfer();dt.items.add(f);
    const i=document.getElementById('file');i.files=dt.files;i.dispatchEvent(new Event('change'));
    await new Promise(r=>setTimeout(r,1300));
    document.querySelector('#edSeries [data-s="laser"]').click();
    await new Promise(r=>setTimeout(r,600));
    await new Promise(r=>setTimeout(r,800));   // 等预热跑完
    const warm = window.__warmStats();
    const chips=[...document.querySelectorAll('#edPapers .paper-chip')];
    chips[0].click(); await new Promise(r=>setTimeout(r,300));
    // 计时：逐张点，记录每次从 click 到重绘完成
    const times=[];
    for(let k=0;k<chips.length;k++){
      const t0=performance.now();
      chips[k].click();
      const t1=performance.now();          // click 处理器同步返回 = 重绘完成
      times.push(+(t1-t0).toFixed(1));
      await new Promise(r=>setTimeout(r,120));
    }
    // 再测纯色系列（无颗粒无光栅）
    document.querySelector('#edSeries [data-s="solid"]').click();
    await new Promise(r=>setTimeout(r,400));
    const sc=[...document.querySelectorAll('#edPapers .paper-chip')];
    const stimes=[];
    for(let k=0;k<Math.min(5,sc.length);k++){
      const t0=performance.now();
      sc[k].click();
      stimes.push(+(performance.now()-t0).toFixed(1));
      await new Promise(r=>setTimeout(r,80));
    }
    return {laser:times, solid:stimes, warm};
  })()`,returnByValue:true,awaitPromise:true});
  const v=r.result.value;
  if(v){
    const avg=a=>a.reduce((x,y)=>x+y,0)/a.length;
    console.log('预热池: '+v.warm.size+' 张  keys='+JSON.stringify(v.warm.keys));
  console.log('镭射系每次点击耗时: '+v.laser.join('ms, ')+'ms  平均 '+avg(v.laser).toFixed(1)+'ms');
    console.log('纯色系每次点击耗时: '+v.solid.join('ms, ')+'ms  平均 '+avg(v.solid).toFixed(1)+'ms');
    const slow=Math.max(...v.laser);
    console.log(slow>120?'✗ 最慢 '+slow+'ms —— 平板上会明显感觉卡':'✓ 最慢 '+slow+'ms，可接受');
  }
  ws.close();chrome.kill();process.exit(0);
})();
