import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const dir=mkdtempSync(join(tmpdir(),'diting-storage-'))
const files=new Map(),settings=new Map();let vault='/fixture-vault',writes=0,onRead=()=>{}
globalThis.document={documentElement:{dataset:{}}}
globalThis.localStorage={getItem:key=>settings.get(key)??null,setItem:(key,value)=>settings.set(key,value)}
globalThis.ctx={app:{vaultRoot:()=>vault,workFolder:()=>settings.get('plugin.diting.workFolder')||'Plugins/谛听',readFile:async path=>{const value=files.get(path)??null;onRead(path);return value},writeFile:async()=>{writes++}},notify(){}}
try{
 await build({stdin:{contents:"export * from './src/store';export { S } from './src/state';export { newRec,rowOf } from './src/model'",resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',outfile:join(dir,'test.mjs'),logLevel:'silent'})
 const M=await import(pathToFileURL(join(dir,'test.mjs')).href)
 const records=[1,2].map(i=>({...M.newRec({id:'old-'+i,folder:'谛听/Record '+i,title:'Previous '+i,now:new Date(0),source:'mic',target:''}),status:'done'}))
 files.set('Plugins/谛听/.diting-index.json',JSON.stringify([{id:'new',folder:'Plugins/谛听/New',title:'New',createdAt:''}]))
 files.set('谛听/.diting-index.json',JSON.stringify(records.map(M.rowOf)))
 for(const rec of records)files.set(rec.folder+'/.record.json',JSON.stringify(rec))
 const original=new Map(files)
 await M.loadIndex();assert.equal(M.S.index.length,1);assert.equal(M.S.recovery[0].count,2);assert.equal(settings.size,0)
 M.S.phase='live';await assert.rejects(M.reconnectLegacy('谛听',vault,M.root()),/当前|current/);M.S.phase='idle'
 const missing=files.get(records[0].folder+'/.record.json');files.delete(records[0].folder+'/.record.json')
 await assert.rejects(M.reconnectLegacy('谛听',vault,M.root()),/验证|verify/);assert.equal(settings.size,0);files.set(records[0].folder+'/.record.json',missing)
 onRead=path=>{if(path.endsWith('/.record.json'))vault='/other-vault'}
 await assert.rejects(M.reconnectLegacy('谛听','/fixture-vault',M.root()),/改变|changed/);assert.equal(settings.size,0)
 onRead=()=>{};vault='/fixture-vault'
 onRead=path=>{if(path.endsWith('/.record.json'))M.S.phase='importing'}
 await assert.rejects(M.reconnectLegacy('谛听',vault,M.root()),/当前|current/);assert.equal(settings.size,0)
 onRead=()=>{};M.S.phase='idle'
 files.set('Diting/.diting-index.json','{bad');await M.loadIndex();assert.ok(M.S.recovery.find(row=>row.folder==='Diting').error)
 await M.reconnectLegacy('谛听',vault,M.root());assert.equal(M.root(),'谛听');assert.equal(M.S.index.length,2)
 assert.equal(writes,0);for(const [name,text] of original)assert.equal(files.get(name),text)
 files.set('谛听/.diting-index.json','{bad');await M.loadIndex();assert.ok(M.S.storageError)
 await assert.rejects(M.saveRec(records[0]),/索引|index/);assert.equal(writes,0)
 console.log('storage checks ok: explicit recovery, both counts, busy state, missing record, vault race, read errors, no migration, corrupt-index write protection')
}finally{rmSync(dir,{recursive:true,force:true})}
