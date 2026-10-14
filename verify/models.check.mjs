import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = resolve(fileURLToPath(new URL('..', import.meta.url)))
const out = mkdtempSync(join(tmpdir(), 'diting-models-'))
const files = new Map(), storage = new Map(), requests = [], pending = []
let delayed = true
globalThis.document = { documentElement: { dataset: {} }, hidden: false }
globalThis.window = globalThis
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }
const models = [
  { id: 'a', name: 'Model A', available: true, supportsCorrection: true },
  { id: 'b', name: 'Model B', available: true, supportsCorrection: true },
  { id: 'mt', name: 'Translation model', available: true, supportsCorrection: false },
]
globalThis.ctx = {
  app: { workFolder: () => 'Diting', vaultRoot: () => '/vault', readFile: async key => files.get(key) || null, writeFile: async (key, value) => files.set(key, value) },
  tangu: {
    modelCatalog: async kind => ({ defaultModelId: kind === 'asr' ? 'local' : 'a', models: kind === 'asr' ? [{ id: 'local', name: 'SenseVoice', backend: 'local', available: true }, { id: 'speech', name: 'Speech', available: true }] : models }),
    translate: async req => {
      requests.push({ mode: 'translate', ...req })
      if (!delayed) return { text: `Translated by ${req.modelId}`, model: { id: req.modelId, name: req.modelId } }
      // Intentionally ignore abort: correctness must not depend on a Provider honouring it.
      return new Promise(resolve => pending.push({ req, resolve }))
    },
    complete: async req => { requests.push({ mode: 'complete', ...req }); return { text: '<source>The corrected word is used in this sentence.</source><translation>Corrected translation</translation>' } },
  }, notify() {},
}
let count = 0
const pass = name => { count++; console.log(`✓ ${name}`) }
const settle = async () => { for (let i=0;i<8;i++) await new Promise(r => setTimeout(r,0)) }
try {
  await build({ stdin: { contents: "export * as A from './src/ai'; export * as E from './src/engine'; export * as M from './src/model'; export * as Models from './src/models'; export * as Store from './src/store'; export { S, setPref } from './src/state'", resolveDir: here, loader: 'ts' }, bundle: true, format: 'esm', outfile: join(out,'test.mjs'), logLevel: 'silent' })
  const { A, E, M, Models, Store, S, setPref } = await import(pathToFileURL(join(out,'test.mjs')).href)
  const seed = id => {
    const rec={...M.newRec({id,folder:`Diting/${id}`,title:id,now:new Date('2026-10-14T09:00:00Z'),source:'mic',target:'zh'}),status:'done',asrModel:'local',translationModel:'a',segments:[{id:1,start:1,end:2,text:'First source sentence.'},{id:2,start:2,end:3,text:'Second source sentence.'}]}
    Store.remember(rec);S.open=rec;return rec
  }
  const rec=seed('scope')
  A.translate(rec,rec.segments[0]);await settle();assert.equal(pending.length,1)
  await E.apply({c:'model',rec:rec.id,kind:'translation',value:'b',scope:'future'})
  A.translate(rec,rec.segments[1]);await settle();assert.equal(pending[0].req.modelId,'a');assert.equal(pending[1].req.modelId,'b')
  pending.splice(0).forEach(p=>p.resolve({text:`Result ${p.req.modelId}`,model:{id:p.req.modelId,name:p.req.modelId}}));await settle()
  assert.equal(rec.segments[0].trModel.id,'a');assert.equal(rec.segments[1].trModel.id,'b');pass('Queued sentences pin the model; future-only preserves historical provenance')
  await E.apply({c:'target',rec:rec.id,target:'ja',scope:'future'});assert.equal(rec.segments[0].tr,'Result a');assert.equal(rec.segments[0].trTarget,'zh');pass('Future-only language change retains existing translations and language')
  await E.apply({c:'model',rec:rec.id,kind:'translation',value:'a',scope:'all'});await settle();const old=pending.splice(0);assert.equal(old.length,2)
  await E.apply({c:'model',rec:rec.id,kind:'translation',value:'b',scope:'all'});assert.ok(old.every(p=>p.req.signal.aborted))
  old.forEach(p=>p.resolve({text:'STALE'}));await settle();const newest=pending.splice(0);newest.forEach(p=>p.resolve({text:'NEW',model:{id:'b',name:'Model B'}}));await settle()
  assert.ok(rec.segments.every(s=>s.tr==='NEW'&&s.trModel.id==='b'));pass('Retranslation invalidates late results even when a Provider ignores abort')
  delayed=false;requests.length=0;rec.segments[1].trState='fail';await E.apply({c:'retryAll',rec:rec.id});await settle();assert.equal(requests.length,1);assert.equal(requests[0].selection,undefined);assert.equal(requests[0].text,'Second source sentence.');assert.equal(rec.segments[0].tr,'NEW');pass('Bulk retry changes only failed translations')
  const disk=JSON.parse(files.get(`${rec.folder}/.record.json`));const revived=M.reviveRec(disk,rec.folder);assert.equal(revived.translationModel,'b');assert.equal(revived.segments[0].trModel.id,'b');assert.equal(revived.segments[0].trTarget,'ja');pass('Recording model choice and sentence receipts survive save/reload')
  setPref('fix',true);requests.length=0;await E.apply({c:'model',rec:rec.id,kind:'translation',value:'mt',scope:'all'});await settle();assert.ok(requests.length===2&&requests.every(r=>r.mode==='translate'&&r.modelId==='mt'));pass('Dedicated translation model stays selected when correction is enabled')
  await E.apply({c:'term',from:'cromers',to:'Kramers'});assert.equal(M.applyTerms('cromers relation',JSON.parse(storage.get('plugin.diting.terms'))),'Kramers relation');await E.apply({c:'termRemove',from:'cromers'});assert.deepEqual(JSON.parse(storage.get('plugin.diting.terms')),{});pass('Glossary additions and removals reach the recognition dictionary')
  delayed=true;A.translate(rec,rec.segments[0]);await settle();const off=pending.splice(0);await E.apply({c:'target',rec:rec.id,target:'',scope:'future'});off.forEach(p=>p.resolve({text:'After Off'}));await settle();assert.notEqual(rec.segments[0].tr,'After Off');pass('Translation Off cancels pending results and retains completed content')
  const catalog=ctx.tangu.modelCatalog; delete ctx.tangu.modelCatalog
  globalThis.tangu={getConfig:async()=>({asrBackend:'local',asrModelId:'old-model'})}
  assert.equal((await Models.resolveModel('asr')).id,'');await assert.rejects(Models.resolveModel('asr','local'))
  ctx.tangu.modelCatalog=catalog;pass('Old hosts omit unconfirmed ASR provenance and reject explicit overrides')
  console.log(`${count} model/scope checks passed`)
} finally { rmSync(out,{recursive:true,force:true}) }
