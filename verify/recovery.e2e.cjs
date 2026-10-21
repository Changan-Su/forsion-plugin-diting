// Isolated Electron acceptance for legacy directory recovery. Does not use personal records.
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict')
const ROOT=path.resolve(__dirname,'..'),DESK=process.env.DITING_DESKTOP||path.resolve(ROOT,'../bluebird-ux-demo/desktop'),OUT=path.join(ROOT,'.shots/recovery')
const electron=require(DESK+'/scripts/lib/launch-electron.cjs'),{startStubEngine}=require(DESK+'/scripts/lib/stub-engine.cjs'),{skipOnboarding}=require(DESK+'/scripts/lib/skip-onboarding.cjs')
async function main(){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'diting-recovery-')),vault=path.join(home,'Vault'),userData=path.join(home,'userdata'),bundle=path.join(home,'plugins/diting')
 fs.mkdirSync(bundle,{recursive:true});fs.mkdirSync(OUT,{recursive:true})
 for(const name of ['main.js','manifest.json','icon.png','icon.svg','agents','spaces'])fs.cpSync(path.join(ROOT,name),path.join(bundle,name),{recursive:true})
 fs.appendFileSync(path.join(bundle,'main.js'),'\n')
 const source=fs.readFileSync(path.join(bundle,'main.js'),'utf8');fs.writeFileSync(path.join(bundle,'main.js'),'globalThis.__ditingCtx=ctx;\n'+source)
 const rows=[]
 const wav=Buffer.alloc(32044);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(32000,40)
 for(let i=1;i<=2;i++){
  const folder='谛听/Previous '+i,dir=path.join(vault,folder);fs.mkdirSync(dir,{recursive:true})
  const record={v:1,id:'old-'+i,folder,title:'历史记录 '+i,createdAt:'2026-10-11T10:00:00.000Z',duration:1,status:'done',source:'import',target:'',segments:[{id:1,start:0,end:1,text:'Preserved transcript '+i,tr:'',trState:'off'}],notes:[],chapters:[],summary:'Preserved minutes '+i,audio:'recording.wav'}
  fs.writeFileSync(path.join(dir,'.record.json'),JSON.stringify(record));fs.writeFileSync(path.join(dir,'转写.md'),'# Preserved transcript '+i);fs.writeFileSync(path.join(dir,'纪要.md'),'# Preserved minutes '+i);fs.writeFileSync(path.join(dir,'recording.wav'),wav)
  rows.push({id:record.id,folder,title:record.title,createdAt:record.createdAt,duration:1,status:'done'})
 }
 fs.writeFileSync(path.join(vault,'谛听/.diting-index.json'),JSON.stringify(rows))
 const original=fs.readFileSync(path.join(vault,'谛听/Previous 1/.record.json'),'utf8')
 const stub=await startStubEngine({models:[{id:'fixture',name:'Fixture',provider:'stub'}]});let app,win;const checks=[]
 const ok=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS',name)}
 try{
  for(const dir of [userData,userData+'-dev']){fs.mkdirSync(dir,{recursive:true});for(const f of ['amadeus-config.json','amadeus-config.dev.json'])fs.writeFileSync(path.join(dir,f),JSON.stringify({lastVault:vault,localVault:vault}));fs.writeFileSync(path.join(dir,'tangu-desktop-config.json'),JSON.stringify({mode:'external',backendUrl:stub.url,token:'fixture'}))}
  app=await electron.launch({args:['--user-data-dir='+userData,'--lang=zh-CN',DESK],cwd:DESK,env:{...process.env,TANGU_HOME:home,TANGU_BACKEND_URL:stub.url,TANGU_HARNESS_QUIET:'1',PI_CU_SOCKET_PATH:path.join(home,'bridge.sock')}})
  win=await app.firstWindow();await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,950));await skipOnboarding(win)
  await win.addInitScript(()=>localStorage.setItem('diting.test','1'));await win.reload();await win.waitForFunction(()=>!!globalThis.__ditingCtx&&!!window.__DITING_TEST__)
  await win.evaluate(()=>__ditingCtx.app.openSpace('diting'));await win.waitForSelector('[data-recovery] button');await win.waitForSelector('#tangu-splash',{state:'hidden'})
  ok('Previous records are detected before an empty library', (await win.locator('[data-recovery]').innerText()).includes('2 份'))
  ok('Detection leaves the work folder unchanged',await win.evaluate(()=>!localStorage.getItem('plugin.diting.workFolder')))
  await win.locator('[data-recovery] button').click();await win.waitForFunction(()=>document.querySelector('[data-recovery]')?.innerText.includes('文件保留原位'));ok('Recovery requires explicit confirmation',(await win.locator('[data-recovery]').innerText()).includes('文件保留原位'))
  await win.screenshot({path:path.join(OUT,'confirm-light.png')});await win.locator('[data-recovery] button').click()
  await win.waitForFunction(()=>window.__DITING_TEST__.S.index.length===2)
  ok('Confirmation reconnects the standard work folder',await win.evaluate(()=>localStorage.getItem('plugin.diting.workFolder')==='谛听'))
  await win.evaluate(()=>__ditingCtx.app.openSpace('diting'));await win.getByText('历史记录 1',{exact:true}).click();await win.waitForFunction(()=>window.__DITING_TEST__.S.open?.id==='old-1')
  ok('Restored detail contains the actual transcript', (await win.locator('.dt').first().innerText()).includes('Preserved transcript 1'))
  await win.locator('[data-act="play"]').first().click();await win.waitForFunction(()=>window.__DITING_TEST__.player().duration===1)
  ok('Original audio remains playable through native media',await win.evaluate(()=>window.__DITING_TEST__.player().muted===true))
  await win.screenshot({path:path.join(OUT,'detail-light.png')})
  ok('Recovery does not rewrite records or move files',fs.readFileSync(path.join(vault,'谛听/Previous 1/.record.json'),'utf8')===original&&!fs.existsSync(path.join(vault,'Plugins/谛听')))
  ok('No model request is needed for recovery',stub.seen.runs.length===0)
  await win.evaluate(()=>localStorage.setItem('tangu_locale','en'));await win.reload();await win.waitForFunction(()=>!!globalThis.__ditingCtx&&!!window.__DITING_TEST__);await win.evaluate(()=>{localStorage.removeItem('plugin.diting.workFolder');__ditingCtx.app.openSpace('diting')})
  // Reconnect diagnostics are recomputed on a fresh plugin activation.
  await win.reload();await win.waitForFunction(()=>!!globalThis.__ditingCtx);await win.evaluate(()=>__ditingCtx.app.openSpace('diting'));await win.waitForSelector('[data-recovery] button');await win.waitForSelector('#tangu-splash',{state:'hidden'})
  ok('English recovery copy is translated',(await win.locator('[data-recovery]').innerText()).includes('Found 2 previous records'))
  await win.screenshot({path:path.join(OUT,'confirm-english.png')});fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify({checks,home,vault},null,2))
 }catch(error){if(win)await win.screenshot({path:path.join(OUT,'failure.png')}).catch(()=>{});throw error}finally{if(app)await app.close().catch(()=>{});stub.close?.()}
}
main().catch(error=>{console.error(error);process.exitCode=1})
