const fs=require('fs/promises');
const {chromium,expect}=require(process.cwd()+'/node_modules/@playwright/test');
const out='/tmp/databaker-audit-20260907';
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1366,height:768}});const errors=[], geometry=[];
 page.on('pageerror',e=>errors.push(e.message));
 const shot=async(name)=>{
  await page.screenshot({path:out+'/'+name+'.png',fullPage:true});
  geometry.push({name,...await page.evaluate(()=>{
   const b=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right}};
   const sels=['.editor-canvas','.script-monitor','.speech-quality-banner','.signal-monitor','.speech-review','.transport-panel','.recording-policy-fields','.document-actions'];
   const regions=sels.flatMap(s=>[...document.querySelectorAll(s)].map(e=>({selector:s,...b(e),scrollHeight:e.scrollHeight,clientHeight:e.clientHeight})));
   const warning=document.querySelector('.speech-quality-banner');let covered=[];
   if(warning){const w=warning.getBoundingClientRect();covered=[...document.querySelectorAll('button,input')].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.height&&r.x<w.right&&r.right>w.x&&r.y<w.bottom&&r.bottom>w.y}).map(e=>({label:e.getAttribute('aria-label')||e.title||e.textContent,...b(e)}));}
   return {viewport:{w:innerWidth,h:innerHeight},document:{scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth},regions,covered};
  })});
 };
 try{
 await page.goto('http://127.0.0.1:5181'); await page.getByTestId('recordings-workspace').waitFor();await shot('home-1366');
 await page.getByRole('button',{name:'打开应用设置',exact:true}).click();await shot('global-settings-1366');await page.keyboard.press('Escape');
 await page.getByTestId('new-recording').click();
 await page.getByTestId('script-file').setInputFiles({name:'audit.csv',mimeType:'text/csv',buffer:Buffer.from('id,text,label\n001,你好小贝,正常\n002,你好小贝,嘈杂环境')});
 await shot('setup-default-1366');
 await page.getByLabel('人声幅值检查',{exact:true}).check(); await page.getByLabel('短句自动结束',{exact:true}).check();await page.getByLabel('人声 RMS 下限（dBFS）',{exact:true}).fill('-10');
 await shot('setup-enabled-1366');await page.setViewportSize({width:1080,height:700});await shot('setup-enabled-1080');
 await page.getByTestId('start-session').click();await page.getByTestId('input-audition-dialog').waitFor();await shot('input-audition-1080');await page.getByRole('button',{name:'跳过试听',exact:true}).click();
 const skip=page.getByTestId('noise-skip-check');if(await skip.isVisible())await skip.click();
 await page.getByTestId('main-transport').click();await expect(page.locator('.speech-quality-banner')).toContainText('声音偏小',{timeout:12000}); await shot('recording-warning-1080');
 await expect(page.getByTestId('main-transport')).toContainText('确认保留',{timeout:12000});await shot('review-warning-1080');
 await page.setViewportSize({width:1366,height:768});await shot('review-warning-1366');
try { await page.getByRole('button',{name:'减小正文字号',exact:true}).click({timeout:1200});console.log('covered font button unexpectedly clickable'); } catch(error) { console.log('covered font button click failed:',error.message.split('\n').filter(x=>x.includes('intercepts')||x.includes('Timeout')).join(' | ')); }

 await page.setViewportSize({width:1920,height:1080});await shot('review-warning-1920');
 await page.setViewportSize({width:1366,height:768});
 await page.getByRole('button',{name:'设置',exact:true}).click(); await shot('task-settings-1366');
 // Change only new policy and inspect whether the visible restore control reflects it.
 await page.getByLabel('人声 RMS 下限（dBFS）',{exact:true}).fill('-20');await page.getByRole('button',{name:'保存录制设置',exact:true}).click();
 geometry.push({name:'restore-new-policy',disabled:await page.getByTestId('restore-task-recording-settings').isDisabled(),value:await page.getByLabel('人声 RMS 下限（dBFS）',{exact:true}).inputValue()});
 await page.getByRole('button',{name:'检测',exact:true}).click();await shot('detection-1366');
 await page.getByRole('button',{name:'问题',exact:true}).click();await shot('issues-1366');
 await page.getByRole('button',{name:'导出',exact:true}).click();await shot('export-1366');
 // Capture whether persistent warning intercepts header controls.
 const covered=geometry.find(x=>x.name==='review-warning-1366').covered;console.log('warning overlaps',JSON.stringify(covered));
 await fs.writeFile(out+'/ui-geometry.json',JSON.stringify({geometry,errors},null,2));
 const prompt=await browser.newPage({viewport:{width:1080,height:700}});await prompt.goto('http://127.0.0.1:5181/?view=prompter');await prompt.getByTestId('prompter-shell').waitFor();
 await prompt.evaluate(()=>window.recorder.sendPrompterState({sessionName:'UI审计',sequence:1,total:2,id:'001',text:'你好小贝',label:'正常',cue:'recording',cueLabel:'录制中',readerCueLabel:'请朗读',silenceProgress:0,qualityWarning:'声音偏小',itemDisposition:'unrecorded',deliveryHealth:'blocked'}));
 await prompt.screenshot({path:out+'/prompter-warning-1080.png'});
 console.log('UI audit completed',JSON.stringify({errors,restore:geometry.find(x=>x.name==='restore-new-policy')}));
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
