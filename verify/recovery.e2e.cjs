// Isolated Electron acceptance for legacy directory recovery. Does not use personal records.
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict')
const ROOT=path.resolve(__dirname,'..'),DESK=process.env.DITING_DESKTOP||path.resolve(ROOT,'../bluebird-ux-demo/desktop'),OUT=path.join(ROOT,process.env.PLUGIN_LEGACY_NESTED ? '.shots/migration-id':'.shots/migration')
const electron=require(DESK+'/scripts/lib/launch-electron.cjs'),{startStubEngine}=require(DESK+'/scripts/lib/stub-engine.cjs'),{skipOnboarding}=require(DESK+'/scripts/lib/skip-onboarding.cjs')
function priorJournal(vault,source,target,indexPath){
 const files=[],crypto=require('node:crypto')
 const walk=rel=>{for(const entry of fs.readdirSync(path.join(vault,target,rel),{withFileTypes:true})){const p=rel ? rel+'/'+entry.name:entry.name;if(entry.isDirectory())walk(p);else if(p!==indexPath)files.push({path:p,hash:crypto.createHash('sha256').update(fs.readFileSync(path.join(vault,target,p))).digest('hex')})}}
 walk('');return {version:1,complete:process.env.PLUGIN_PRIOR_JOURNAL!=='interrupted',source,target,index:{path:indexPath,before:null,after:fs.readFileSync(path.join(vault,target,indexPath),'utf8')},files}
}
async function main(){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'diting-recovery-')),vault=path.join(home,'Vault'),userData=path.join(home,'userdata'),bundle=path.join(home,'plugins/diting')
 fs.mkdirSync(bundle,{recursive:true});fs.mkdirSync(OUT,{recursive:true})
 for(const name of ['main.js','manifest.json','icon.png','icon.svg','agents','spaces'])fs.cpSync(path.join(ROOT,name),path.join(bundle,name),{recursive:true})
 fs.appendFileSync(path.join(bundle,'main.js'),'\n')
 const source=fs.readFileSync(path.join(bundle,'main.js'),'utf8');fs.writeFileSync(path.join(bundle,'main.js'),'globalThis.__ditingCtx=ctx;\n'+source)
 const legacy=process.env.PLUGIN_LEGACY_NESTED ? 'Plugins/谛听':'谛听'
 const rows=[]
 const wav=Buffer.alloc(32044);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(32000,40)
 for(let i=1;i<=2;i++){
  const folder=legacy+'/Previous '+i,dir=path.join(vault,folder);fs.mkdirSync(dir,{recursive:true})
  const record={v:1,id:'old-'+i,folder,title:'历史记录 '+i,createdAt:'2026-10-11T10:00:00.000Z',duration:1,status:'done',source:'import',target:'',segments:[{id:1,start:0,end:1,text:'Preserved transcript '+i,tr:'',trState:'off'}],notes:[],chapters:[],summary:'Preserved minutes '+i,audio:'recording.wav'}
  fs.writeFileSync(path.join(dir,'.record.json'),JSON.stringify(record));fs.writeFileSync(path.join(dir,'转写.md'),'# Preserved transcript '+i);fs.writeFileSync(path.join(dir,'纪要.md'),'# Preserved minutes '+i);fs.writeFileSync(path.join(dir,'recording.wav'),wav)
  rows.push({id:record.id,folder,title:record.title,createdAt:record.createdAt,duration:1,status:'done'})
 }
 fs.writeFileSync(path.join(vault,legacy,'.diting-index.json'),JSON.stringify(rows))
 if(process.env.PLUGIN_PRIOR_JOURNAL){
  assert.equal(legacy,'Plugins/谛听');fs.cpSync(path.join(vault,legacy),path.join(vault,'谛听'),{recursive:true})
  const backupRows=rows.map(row=>({...row,folder:row.folder.replace('Plugins/谛听/','谛听/')}))
  for(const row of backupRows){const p=path.join(vault,row.folder,'.record.json'),rec=JSON.parse(fs.readFileSync(p,'utf8'));rec.folder=row.folder;fs.writeFileSync(p,JSON.stringify(rec))}
  fs.writeFileSync(path.join(vault,'谛听/.diting-index.json'),JSON.stringify(backupRows));fs.mkdirSync(path.join(vault,'.forsion/plugin-migrations'),{recursive:true});fs.writeFileSync(path.join(vault,'.forsion/plugin-migrations/diting-legacy-root-v1.json'),JSON.stringify(priorJournal(vault,'谛听',legacy,'.diting-index.json')))
 }
 const original=fs.readFileSync(path.join(vault,legacy,'Previous 1/.record.json'),'utf8')
 const stub=await startStubEngine({models:[{id:'fixture',name:'Fixture',provider:'stub'}]});let app,win;const checks=[]
 const ok=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('PASS',name)}
 try{
  for(const dir of [userData,userData+'-dev']){fs.mkdirSync(dir,{recursive:true});for(const f of ['amadeus-config.json','amadeus-config.dev.json'])fs.writeFileSync(path.join(dir,f),JSON.stringify({lastVault:vault,localVault:vault}));fs.writeFileSync(path.join(dir,'tangu-desktop-config.json'),JSON.stringify({mode:'external',backendUrl:stub.url,token:'fixture'}))}
  app=await electron.launch({args:['--user-data-dir='+userData,'--lang=zh-CN',DESK],cwd:DESK,env:{...process.env,TANGU_HOME:home,TANGU_BACKEND_URL:stub.url,TANGU_HARNESS_QUIET:'1',PI_CU_SOCKET_PATH:path.join(home,'bridge.sock')}})
  win=await app.firstWindow();await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,950));await skipOnboarding(win)
  await win.addInitScript(()=>localStorage.setItem('diting.test','1'));await win.reload();await win.waitForFunction(()=>!!globalThis.__ditingCtx&&!!window.__DITING_TEST__)
  await win.evaluate(()=>__ditingCtx.app.openSpace('diting'));await win.waitForFunction(()=>window.__DITING_TEST__.S.index.length===2);await win.waitForSelector('#tangu-splash',{state:'hidden'})
  ok('Previous records migrate automatically',fs.existsSync(path.join(vault,'Plugins/diting/.diting-index.json')))
  ok('Default work-folder preference remains unset',await win.evaluate(()=>!localStorage.getItem('plugin.diting.workFolder')))
  ok('Every row points to its migrated record',await win.evaluate(()=>window.__DITING_TEST__.S.index.every(row=>row.folder.startsWith('Plugins/diting/'))))
  await win.evaluate(()=>__ditingCtx.app.openSpace('diting'));await win.getByText('历史记录 1',{exact:true}).click();await win.waitForFunction(()=>window.__DITING_TEST__.S.open?.id==='old-1')
  await win.getByText('Preserved transcript 1',{exact:true}).waitFor()
  ok('Restored detail contains the actual transcript', await win.getByText('Preserved transcript 1',{exact:true}).isVisible())
  await win.locator('[data-act="play"]').first().click();await win.waitForFunction(()=>window.__DITING_TEST__.player().duration===1)
  ok('Original audio remains playable through native media',await win.evaluate(()=>window.__DITING_TEST__.player().muted===true))
  await win.getByText('纪要',{exact:true}).click();await win.getByText('Preserved minutes 1',{exact:true}).waitFor();ok('Restored minutes open without regeneration',true)
  await win.screenshot({path:path.join(OUT,'detail-light.png')})
  ok('Original records are retained as backup',fs.readFileSync(path.join(vault,legacy,'Previous 1/.record.json'),'utf8')===original)
  ok('Migrated audio preserves every byte',fs.readFileSync(path.join(vault,'Plugins/diting/Previous 1/recording.wav')).equals(wav))
  ok('No model request is needed for recovery',stub.seen.runs.length===0)
  await win.evaluate(()=>localStorage.setItem('tangu_locale','en'));await win.reload();await win.waitForFunction(()=>!!globalThis.__ditingCtx&&!!window.__DITING_TEST__);await win.evaluate(()=>__ditingCtx.app.openSpace('diting'));await win.waitForFunction(()=>window.__DITING_TEST__.S.index.length===2);await win.waitForSelector('#tangu-splash',{state:'hidden'})
  ok('Restart does not duplicate historical records',await win.evaluate(()=>window.__DITING_TEST__.S.index.length===2))
  ok('Completed migration hides the backup recovery banner',await win.locator('[data-recovery] button').count()===0)
  await win.screenshot({path:path.join(OUT,'migrated-english.png')});fs.writeFileSync(path.join(OUT,'report.json'),JSON.stringify({checks,home,vault},null,2))
 }catch(error){if(win)await win.screenshot({path:path.join(OUT,'failure.png')}).catch(()=>{});throw error}finally{if(app)await app.close().catch(()=>{});stub.close?.()}
}
main().catch(error=>{console.error(error);process.exitCode=1})
